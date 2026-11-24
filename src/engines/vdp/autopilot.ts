/**
 * VDP autopilot (D-60, pure): which open items the app applies by itself, which it only suggests, and which are
 * yours; the queue it works through; and the ledger that makes it idempotent. The worker job (src/server/vdp/autopilot.ts
 * `runVdpAutopilot`) stages and applies the queue through the Outbox; this file decides, it never writes.
 *
 *   auto      every value the call sends is a known fact: create the company (list_companies found nothing), create
 *             the VDP (VDP's own company match), add an engaged opp, the account id and fiscal period from Org62, me as
 *             TA, the AE from the opp's Specialist Forecast (D-63), a strong asset (the strongest grade, an https
 *             link on a trusted site: SEC-6, src/engines/vdp/asset-hosts.ts), Generate once the use case's five inputs
 *             are in
 *   suggest   a person approves it: use-case inputs (judgment), a new use case, the entitlement leveraged, a sales
 *             segment, a value that looks wrong (the fiscal-period fix, a closed-lost opp to remove: it would change
 *             what a person entered), anything carrying a default or a guess, an asset link on a site not in
 *             Settings ▸ Sending's trusted list ("Held for you: link is on <host>, not a trusted site")
 *   you       nothing the app can send (D-63: such items show disabled until VDP's MCP lists what they need)
 *
 * D-63: autopilot applies each item on its own. An item under a parent that does not exist yet (a VDP under a new
 * company, the people under a new VDP) waits for the VDP read that shows the parent; only your push chains them.
 *
 * Never: a delete, a change to a value already in VDP, a write while dry run is on or VDP's sign-in is stale, past the
 * daily cap, or guessed text. Idempotent: an item's call (its key and the values it would send) is applied at most
 * once; a failure returns the item to you with the error and is never retried by autopilot.
 */
import type { VdpAssetItem, VdpAutopilotEntry, VdpAutopilotState, VdpCoveragePayload, VdpCoverageRow, VdpNotInVdpRow, VdpStep, VdpStepAutopilot, VdpStepPolicy, VdpWriteOp } from '@/contract';
import { isHttpUrl } from '@/lib/vdp/payload';

import { trustedAssetHost } from './asset-hosts';

/** Where each DataSource keeps the ledger (a per-user key-value row). */
export const VDP_AUTOPILOT_KV = 'cc.vdp.autopilot';

/** The strongest candidate grade (the research run's "sure", the matcher's mapped item): the only one autopilot adds. */
export const STRONG_ASSET_AT = 0.9;

/** The order autopilot applies in (one run never depends on another's result: VDP's next read links them). */
const OP_ORDER: Record<VdpWriteOp, number> = { create_company: 0, create_vdp: 1, update_vdp_header: 2, set_vdp_owners: 3, add_vdp_asset: 4, generate_use_case: 5, update_use_case: 9, create_use_case: 9 };

/** One run's record of one item (kept 30 days): what was applied, when, and how it ended. */
export interface AutopilotLedgerEntry {
  key: string;
  /** The call's identity: the item key and the values it sent. */
  hash: string;
  at: string;
  state: 'applied' | 'failed';
  title: string;
  vdpKey: string;
  companyName: string;
  op: VdpWriteOp;
  detail: string | null;
  draftId: string | null;
  url: string | null;
}

export interface AutopilotLedger {
  entries: AutopilotLedgerEntry[];
  lastRunAt: string | null;
  /** Why the last run did not write, and since when (told once: Health and the VDP view show it until it clears). */
  paused: VdpAutopilotState['paused'];
  pausedSince: string | null;
}

export const EMPTY_LEDGER: AutopilotLedger = { entries: [], lastRunAt: null, paused: null, pausedSince: null };
export const LEDGER_KEEP_MS = 30 * 86_400_000;

/** A stored ledger, checked (a missing or odd one reads as empty). */
export function ledgerOf(raw: unknown): AutopilotLedger {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<AutopilotLedger>;
  const entries = Array.isArray(o.entries) ? o.entries.filter((e): e is AutopilotLedgerEntry => !!e && typeof e.key === 'string' && typeof e.hash === 'string' && typeof e.at === 'string') : [];
  const paused = o.paused === 'reauth' || o.paused === 'dry_run' || o.paused === 'cap' ? o.paused : null;
  return { entries, lastRunAt: typeof o.lastRunAt === 'string' ? o.lastRunAt : null, paused, pausedSince: paused && typeof o.pausedSince === 'string' ? o.pausedSince : null };
}

/** djb2 over a canonical string: stable, pure (no crypto in engines). */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The identity of the call an item would make: its key and every known value it sends. */
export function opHash(key: string, apply: NonNullable<VdpStep['apply']>): string {
  const vals = apply.fields.filter((f) => f.suggested !== null && f.suggested !== undefined && !(Array.isArray(f.suggested) && !f.suggested.length)).map((f) => [f.field, Array.isArray(f.suggested) ? [...f.suggested] : f.suggested]);
  return hash(JSON.stringify([key, apply.op, vals.sort((a, b) => String(a[0]).localeCompare(String(b[0])))]));
}

type AppFix = Extract<VdpStep['gaps'][number]['fix'], { kind: 'app' }>;
const appFixes = (s: Pick<VdpStep, 'gaps'>): AppFix[] => s.gaps.map((g) => g.fix).filter((f): f is AppFix => f.kind === 'app');
const hasValue = (v: unknown) => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && !v.length);

export interface PolicyContext {
  /** A use case's five inputs are all filled (its detail was read): Generate may run. */
  inputsComplete: (useCaseId: string) => boolean;
}

/** Who applies one open item, and why not autopilot (when it is not). */
export function stepPolicy(s: Pick<VdpStep, 'who' | 'apply' | 'gaps' | 'check' | 'kind'>, ctx: PolicyContext): { policy: VdpStepPolicy; reason: string | null } {
  if (s.who !== 'app' || !s.apply) return { policy: 'you', reason: null };
  if (s.check === 'wrong') return { policy: 'suggest', reason: 'It changes a value already in VDP: you approve it' };
  const fixes = appFixes(s);
  switch (s.apply.op) {
    case 'update_use_case':
    case 'create_use_case':
      return { policy: 'suggest', reason: 'Use-case inputs are judgment: you approve them' };
    case 'generate_use_case': {
      const uc = s.gaps[0]?.useCaseId;
      return uc && ctx.inputsComplete(uc) ? { policy: 'auto', reason: null } : { policy: 'suggest', reason: 'Generate waits until the use case’s five inputs are in' };
    }
    case 'set_vdp_owners':
      // the TA is me; the AE is the specialist on the opp's Specialist Forecast (D-63), never the core opp owner
      return fixes.some((f) => f.known && hasValue(f.suggested)) ? { policy: 'auto', reason: null } : { policy: 'suggest', reason: 'No Specialist Forecast names the AE: you type it' };
    case 'add_vdp_asset':
      return { policy: 'suggest', reason: null };
    default: {
      const allKnown = fixes.length > 0 && fixes.every((f) => f.known && hasValue(f.suggested));
      const required = s.apply.fields.filter((f) => f.required);
      const filled = required.every((f) => hasValue(f.suggested));
      return allKnown && filled ? { policy: 'auto', reason: null } : { policy: 'suggest', reason: 'A value is a default, not a known fact: you approve it' };
    }
  }
}

/**
 * Whether autopilot may add an asset candidate, and why not. SEC-6: the link came from a search over untrusted text,
 * so even the strongest match is held for your Apply unless it is an https link on one of `hosts` (the trusted sites).
 */
export function assetPolicy(c: { status: string; confidence: number; url: string; kind?: string | null }, hasApply: boolean, hosts: readonly string[]): { policy: VdpStepPolicy; reason: string | null } {
  if (!hasApply) return { policy: 'you', reason: null };
  if (!isHttpUrl(c.url)) return { policy: 'you', reason: 'Not an http(s) link: VDP takes http(s) links only' };
  if (c.kind === 'demo') return { policy: 'suggest', reason: 'A demo-org link: you confirm it' };
  if (c.status !== 'suggested' || c.confidence < STRONG_ASSET_AT) return { policy: 'suggest', reason: 'Not the strongest match: you confirm it' };
  const site = trustedAssetHost(c.url, hosts);
  if (!site.trusted) return { policy: 'suggest', reason: site.why };
  return { policy: 'auto', reason: null };
}

/** One item autopilot applies (its key, so the Apply is rebuilt from the mirror exactly as yours would be). */
export interface AutopilotItem {
  key: string;
  hash: string;
  title: string;
  vdpKey: string;
  companyName: string;
  op: VdpWriteOp;
}

export interface AutopilotSettings {
  on: boolean;
  dryRun: boolean;
  cap: number;
  /** SEC-6: the sites autopilot adds asset links from (Settings ▸ Sending `autopilotAssetHosts`). */
  assetHosts: readonly string[];
}

/** The latest ledger entry per key. */
function latestByKey(l: AutopilotLedger): Map<string, AutopilotLedgerEntry> {
  const m = new Map<string, AutopilotLedgerEntry>();
  for (const e of l.entries) {
    const cur = m.get(e.key);
    if (!cur || e.at >= cur.at) m.set(e.key, e);
  }
  return m;
}

/** Done already: the same call was made (any outcome), or the item's last call failed (it is yours now). */
export function alreadyTried(l: AutopilotLedger, key: string, h: string): boolean {
  return l.entries.some((e) => e.key === key && (e.hash === h || e.state === 'failed'));
}

/** Entries made on `day` (the user's local day): what counts against the daily cap. */
export const entriesOn = (l: AutopilotLedger, day: string, dayOf: (iso: string) => string) => l.entries.filter((e) => dayOf(e.at) === day);

/** What autopilot did, or will do, with an item. */
function stepAutopilot(o: { key: string | null; hash: string | null; policy: VdpStepPolicy; state: VdpStep['state']; draftId: string | null }, latest: Map<string, AutopilotLedgerEntry>, s: AutopilotSettings, paused: VdpAutopilotState['paused']): VdpStepAutopilot | null {
  const e = o.key ? latest.get(o.key) : undefined;
  if (e) {
    if (e.state === 'failed') return { state: 'failed', at: e.at, detail: e.detail, draftId: e.draftId, url: e.url };
    if (o.state === 'waiting') return { state: 'applied', at: e.at, detail: e.detail, draftId: e.draftId, url: e.url };
    // applied, but the next read still shows it open: it did not take, and autopilot never repeats a call
    if (e.hash === o.hash && o.state === 'todo') return { state: 'failed', at: e.at, detail: 'Applied automatically, but VDP still shows it open: check it in VDP', draftId: e.draftId, url: e.url };
  }
  if (!s.on || o.policy !== 'auto' || o.state !== 'todo') return null;
  const why = paused === 'reauth' ? 'Paused: re-auth VDP' : paused === 'dry_run' ? 'Paused: dry run is on' : paused === 'cap' ? "Paused: today's cap is reached" : null;
  return { state: why ? 'paused' : 'queued', at: null, detail: why ?? 'Autopilot applies it on its next run', draftId: null, url: null };
}

export interface DecorateInput {
  settings: AutopilotSettings;
  ledger: AutopilotLedger;
  /** VDP's sign-in: stale pauses autopilot (re-auth). Null = unknown (treated as fine). */
  auth: 'ok' | 'stale' | null;
  policy: PolicyContext;
  /** Today (the user's local day) and how to get one from an instant, for the cap. */
  today: string;
  dayOf: (iso: string) => string;
}

/** Why autopilot would not write right now (before the cap), in order: off, dry run, sign-in. */
export function pauseOf(s: AutopilotSettings, auth: DecorateInput['auth']): VdpAutopilotState['paused'] {
  if (!s.on) return null;
  if (s.dryRun) return 'dry_run';
  if (auth === 'stale') return 'reauth';
  return null;
}

const PAUSE_TEXT: Record<NonNullable<VdpAutopilotState['paused']>, string> = { reauth: 'paused: re-auth VDP', dry_run: 'paused: dry run is on', cap: "paused: today's cap is reached" };

/** "Autopilot: on · 12 applied today · paused: re-auth VDP" / "Autopilot: off". */
export function autopilotLine(a: Pick<VdpAutopilotState, 'on' | 'appliedToday' | 'failedToday' | 'queued' | 'paused'>): string {
  if (!a.on) return 'Autopilot: off';
  const parts = ['Autopilot: on', `${a.appliedToday} applied today`, a.failedToday ? `${a.failedToday} failed` : null, a.paused ? PAUSE_TEXT[a.paused] : a.queued ? `${a.queued} queued` : null];
  return parts.filter(Boolean).join(' · ');
}

/** Every item of the coverage (VDP rows and Not-in-VDP rows, with what comes under them) with where it lives. */
function* items(cov: { vdps: readonly Pick<VdpCoverageRow, 'steps' | 'vdpSlug' | 'companyName'>[]; notInVdp: readonly (Pick<VdpNotInVdpRow, 'step' | 'key' | 'title'> & Partial<Pick<VdpNotInVdpRow, 'children'>>)[] }): Generator<{ step: VdpStep; vdpKey: string; companyName: string }> {
  for (const r of cov.vdps) for (const s of r.steps) yield { step: s, vdpKey: r.vdpSlug, companyName: r.companyName };
  for (const r of cov.notInVdp) for (const s of [r.step, ...(r.children ?? [])]) yield { step: s, vdpKey: r.key, companyName: r.title.replace(/ (has no VDP|is not in VDP)$/, '') };
}

/**
 * Who applies each item (`policy`), its suggestion is set by the caller, what autopilot did or will do (`autopilot`),
 * and the payload's autopilot state with the queue. Pure: returns new rows.
 */
export function decorateCoverage<C extends Pick<VdpCoveragePayload, 'vdps' | 'notInVdp'>>(cov: C, i: DecorateInput): { cov: C; queue: AutopilotItem[]; state: VdpAutopilotState } {
  const latest = latestByKey(i.ledger);
  const pre = pauseOf(i.settings, i.auth);
  const today = entriesOn(i.ledger, i.today, i.dayOf);
  const ident = (apply: VdpStep['apply']) => (apply ? { key: apply.key, hash: opHash(apply.key, apply) } : { key: null, hash: null });
  const ready = (policy: VdpStepPolicy, state: string, id: { key: string | null; hash: string | null }): id is { key: string; hash: string } => policy === 'auto' && state === 'todo' && !!id.key && !!id.hash && !alreadyTried(i.ledger, id.key, id.hash);
  // D-63: autopilot applies each item on its own; one under a parent that does not exist yet waits for the read that
  // shows the parent (only a push chains them), and a disabled one waits for VDP's MCP to list what it needs
  const alone = (x: { requires?: readonly string[]; disabled?: string | null }) => !x.requires?.length && !x.disabled;

  // 1. the queue: every auto item that is open and was never tried, in op order
  const queue: AutopilotItem[] = [];
  for (const it of items(cov)) {
    const id = ident(it.step.apply);
    if (alone(it.step) && ready(stepPolicy(it.step, i.policy).policy, it.step.state, id)) queue.push({ ...id, title: it.step.title, vdpKey: it.vdpKey, companyName: it.companyName, op: it.step.apply!.op });
  }
  for (const r of cov.vdps)
    for (const a of r.assetItems ?? []) {
      const id = ident(a.apply);
      if (alone(a) && ready(a.policy, a.state, id)) queue.push({ ...id, title: `Add ${a.title}`, vdpKey: r.vdpSlug, companyName: r.companyName, op: 'add_vdp_asset' });
    }
  queue.sort((a, b) => OP_ORDER[a.op] - OP_ORDER[b.op]);
  const left = Math.max(0, i.settings.cap - today.length);
  const paused = pre ?? (i.settings.on && queue.length && left === 0 ? 'cap' : null);

  // 2. each item says who applies it and what autopilot did or will do
  const decorate = (s: VdpStep): VdpStep => {
    const p = stepPolicy(s, i.policy);
    const id = ident(s.apply);
    return { ...s, policy: p.policy, autopilot: stepAutopilot({ ...id, policy: p.policy, state: s.state, draftId: s.draftId }, latest, i.settings, paused) };
  };
  const decorateAsset = (a: VdpAssetItem): VdpAssetItem => ({ ...a, autopilot: stepAutopilot({ ...ident(a.apply), policy: a.policy, state: a.state, draftId: a.draftId }, latest, i.settings, paused) });
  const vdps = cov.vdps.map((r) => ({ ...r, steps: r.steps.map(decorate), assetItems: (r.assetItems ?? []).map(decorateAsset) }));
  const notInVdp = cov.notInVdp.map((r) => ({ ...r, step: decorate(r.step), children: (r.children ?? []).map(decorate), assetItems: (r.assetItems ?? []).map(decorateAsset) }));
  const recent: VdpAutopilotEntry[] = [...i.ledger.entries]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20)
    .map((e) => ({ key: e.key, title: e.title, vdpKey: e.vdpKey, companyName: e.companyName, op: e.op, at: e.at, state: e.state, detail: e.detail, draftId: e.draftId, url: e.url }));
  const st: VdpAutopilotState = {
    on: i.settings.on,
    paused: i.settings.on ? paused : null,
    pausedSince: i.settings.on && paused && i.ledger.paused === paused ? i.ledger.pausedSince : null,
    appliedToday: today.filter((e) => e.state === 'applied').length,
    failedToday: today.filter((e) => e.state === 'failed').length,
    cap: i.settings.cap,
    queued: i.settings.on ? queue.length : 0,
    lastRunAt: i.ledger.lastRunAt,
    recent,
    line: '',
  };
  st.line = autopilotLine(st);
  // what a run may apply now: nothing while off or paused, else up to what is left of today's cap
  return { cov: { ...cov, vdps, notInVdp }, queue: queue.slice(0, i.settings.on && !pre ? left : 0), state: st };
}

/**
 * Health's line for VDP autopilot (null when off), without the coverage: paused why (dry run, sign-in, or the cap the
 * last run hit today) and what it applied today.
 */
export function autopilotHealth(i: Omit<DecorateInput, 'policy'>): { paused: VdpAutopilotState['paused']; line: string } | null {
  if (!i.settings.on) return null;
  const today = entriesOn(i.ledger, i.today, i.dayOf);
  const capHit = i.ledger.paused === 'cap' && !!i.ledger.lastRunAt && i.dayOf(i.ledger.lastRunAt) === i.today;
  const paused = pauseOf(i.settings, i.auth) ?? (capHit ? 'cap' : null);
  return { paused, line: autopilotLine({ on: true, appliedToday: today.filter((e) => e.state === 'applied').length, failedToday: today.filter((e) => e.state === 'failed').length, queued: 0, paused }) };
}

/** The ledger after a run: today's new entries added, entries older than 30 days dropped. */
export function nextLedger(l: AutopilotLedger, added: AutopilotLedgerEntry[], o: { now: string; paused: VdpAutopilotState['paused'] }): AutopilotLedger {
  const keepFrom = Date.parse(o.now) - LEDGER_KEEP_MS;
  const entries = [...l.entries, ...added].filter((e) => Date.parse(e.at) >= keepFrom);
  return { entries, lastRunAt: o.now, paused: o.paused, pausedSince: o.paused ? (l.paused === o.paused && l.pausedSince ? l.pausedSince : o.now) : null };
}
