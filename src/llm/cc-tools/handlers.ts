/**
 * cc tool handlers: the only way a scanner agent writes to the database (SCANNER.md §3).
 *
 * - Inputs are zod-validated (`callCcTool`), then delegated to a `ScannerStore` in the run's context.
 * - Idempotency never depends on the model: dedupeKey = `<connector>:<externalId>` and contentHash =
 *   sha1(normalized title + excerpt) are computed here.
 * - Credential redaction runs again on titles, excerpts and payloads (defense in depth).
 * - Results are compact JSON (ids + flags) to save tokens.
 * - The same handlers back the real MCP server and the scripted fake runner used in tests.
 */
import crypto from 'node:crypto';
import type { z } from 'zod';
import { broadcastOf } from '../../scanner/triage/slack-triage';
import { DEFAULT_SCANNING_PREFS, type ConnectorId, type CoverageObject, type Cursor, type NormalizedSourceItem, type ScanContext, type ScannerStore, type TimeWindow } from '../../scanner/types';
import { LOOP_BACK_PREFIX, isContextOnly, type BriefHighlightsInput, type ResolutionFields, type ScannerStoreWithBriefs } from '../../scanner/runtime/contract-ext';
import { redact, redactPayload } from '../redact';
import { EXCERPT_MAX_CHARS } from '../tool-digest';
import { schemas, type CcInput, type CcToolName, sourceItemInput } from './schemas';

export interface CcRunState {
  runId: string;
  connector: ConnectorId;
  window: TimeWindow;
  context: ScanContext;
  /** dedupeKey → sourceItemId for everything recorded (or prefetched) in this run. */
  recorded: Map<string, string>;
  counts: { recorded: number; new: number; changed: number; linked: number; proposed: number; unlinked: number; coverage: number };
  touched: Set<string>;
  /** Own coverage reported in this run (normalized). */
  coverage: CoverageObject[];
  /** ORG-7: what the runner knows about a coverage object that the agent does not say (Q2's account count). */
  coverageMeta?: (o: CoverageObject) => Record<string, unknown> | undefined;
  /** R-UI-22 info per work item, from the context pack and candidate lookups. */
  resolution: Map<string, ResolutionFields>;
  finished?: { cursor: Cursor; complete: boolean; summary?: string; agentStats?: Record<string, number | undefined> };
  /** Defaults for brief highlights (watch runs): subscription from the scope, period from the plan or window. */
  briefDefaults: { subscription?: BriefHighlightsInput['subscription']; period: TimeWindow };
  brief?: { briefId: string; highlights: number };
  /** Tool-call log: names + ok flag only (no bodies). */
  calls: Array<{ tool: string; ok: boolean; error?: string }>;
  /** Every item recorded in this run (agent, prefetched or REC-1), by dedupeKey: the triage pass reads them. */
  items: Map<string, NormalizedSourceItem>;
  /** REC-1: dedupeKeys the runner recorded itself from tool results; an agent re-record returns the same id. */
  auto: Set<string>;
  /** What this run did with each source item: `proposed:<wi>:<kind>`, `<role>:<wi>`, `flagged`. */
  outcomes: Map<string, string[]>;
  /** Post-traversal passes: `triage` / `escalate` (writes are tagged with the pass in their reason). */
  pass?: 'triage' | 'escalate';
  /** Triage verdicts by sourceItemId (cc_triage_verdicts). */
  verdicts: Map<string, { v: 'act' | 'noise' | 'unsure'; why?: string }>;
}

/** `slack:channel:C1` / `channel:C1` → channel; `opp:<id>`, `account:<id>`, `person:<id>`, `search:<q>`. */
export function subscriptionFromScope(scope: string): BriefHighlightsInput['subscription'] | undefined {
  const m = /^(?:slack:)?channel:(.+)$/.exec(scope);
  if (m) return { kind: 'channel', ref: m[1]! };
  const k = /^(opp|account|person|search):(.+)$/.exec(scope);
  if (k) return { kind: k[1] as 'opp' | 'account' | 'person' | 'search', ref: k[2]! };
  return undefined;
}

function planWindow(prefetched: NormalizedSourceItem[] | undefined): TimeWindow | undefined {
  for (const it of prefetched ?? []) {
    const w = (it.payload as { plan?: { window?: { from?: unknown; to?: unknown } } } | undefined)?.plan?.window;
    if (w && typeof w.from === 'string' && typeof w.to === 'string') return { from: w.from, to: w.to };
  }
  return undefined;
}

export function createRunState(input: { runId: string; connector: ConnectorId; window: TimeWindow; context: ScanContext; prefetched?: NormalizedSourceItem[] }): CcRunState {
  const resolution = new Map<string, ResolutionFields>();
  for (const o of input.context.openItems) {
    const ext = o as typeof o & ResolutionFields;
    if (ext.resolution || ext.involvement) resolution.set(o.workItemId, { resolution: ext.resolution, involvement: ext.involvement });
  }
  const { prefetched, ...rest } = input;
  return {
    ...rest,
    briefDefaults: { subscription: subscriptionFromScope(input.context.scope.scope), period: planWindow(prefetched) ?? input.window },
    recorded: new Map(),
    counts: { recorded: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, coverage: 0 },
    touched: new Set(),
    coverage: [],
    resolution,
    calls: [],
    items: new Map(),
    auto: new Set(),
    outcomes: new Map(),
    verdicts: new Map(),
  };
}

/**
 * A sourceItemId as the agent wrote it → the recorded id. Besides the id itself, a Slack message can be cited by
 * `<channelId>:<ts>` or `slack:<channelId>:<ts>` (REC-1 records them without handing ids to the agent).
 */
export function resolveSourceItemId(state: CcRunState, ref: string): string {
  const r = ref.trim();
  const hit = state.recorded.get(r) ?? state.recorded.get(`${state.connector}:${r}`) ?? (state.connector === 'watch' ? state.recorded.get(`slack:${r}`) : undefined);
  if (hit) return hit;
  const m = /^(?:slack:)?([CDG][A-Z0-9]+):(\d+\.\d+)$/.exec(r);
  if (m) {
    const k = state.recorded.get(`slack:${m[1]}:${m[2]}`);
    if (k) return k;
    throw new CcToolError(`no recorded message ${m[1]}:${m[2]} in this run; cite a message the tools returned (or record it first)`);
  }
  return r;
}

function noteOutcome(state: CcRunState, sourceItemId: string, what: string) {
  const xs = state.outcomes.get(sourceItemId) ?? [];
  if (!xs.includes(what)) xs.push(what);
  state.outcomes.set(sourceItemId, xs);
}

/** The recorded item behind a sourceItemId, when this run recorded (or prefetched) it. */
function itemOf(state: CcRunState, sourceItemId: string): NormalizedSourceItem | undefined {
  for (const [k, id] of state.recorded) if (id === sourceItemId) return state.items.get(k);
  return undefined;
}

/**
 * SCAN-SET gates on a proposal, deterministic, before the store sees it. Returns why it is skipped, or the confidence
 * it lands with (a channel-wide ask under "Ask me" lands suggested at most).
 *  - NOT-MINE: an `ask` whose origin is my own message is my ask of someone else: theirs, not my item.
 *  - TRI-3: an ask to a whole channel (@channel, @here) or a list of people (me among three or more): per
 *    Settings ▸ Scanning, Ask me (default: `guess`, so it lands in Triage), Treat as mine (as proposed) or Ignore.
 *  - GEM-CATCHUP / ORG-SPEED: "Catch up: <meeting>" (Gemini notes, Calendar) and "Get up to speed on <opp>" (Org62) items only
 *    when switched on.
 */
export function proposalGate(state: CcRunState, args: { kind: string; title: string; confidence: 'sure' | 'likely' | 'guess'; evidence: Array<{ sourceItemId: string; role: string }> }): { skip: string } | { confidence: 'sure' | 'likely' | 'guess' } {
  const prefs = state.context.scanning ?? DEFAULT_SCANNING_PREFS;
  const title = args.title.trim();
  if ((state.connector === 'gemini_notes' || state.connector === 'calendar') && /^catch(?:[ -])?up\b/i.test(title) && !prefs.meetingCatchUps) return { skip: 'missed-meeting catch-ups are off in Settings ▸ Scanning' };
  if (state.connector === 'org62' && /^get up to speed\b/i.test(title) && !prefs.oppTeamCatchUps) return { skip: '"Get up to speed" items are off in Settings ▸ Scanning' };
  const origins = args.evidence.filter((e) => e.role === 'origin').map((e) => itemOf(state, e.sourceItemId));
  const known = origins.filter((x): x is NormalizedSourceItem => !!x);
  if (args.kind === 'ask' && known.length && known.length === origins.length && known.every((x) => x.author?.isMe === true)) {
    return { skip: 'my own ask of someone else is theirs to do, not my item' };
  }
  const me = { slackId: state.context.me.slackId };
  const wide = args.kind !== 'commitment' && known.some((x) => x.connector === 'slack' && !x.author?.isMe && !!broadcastOf(x.excerpt, me));
  if (wide) {
    if (prefs.channelAsks === 'ignore') return { skip: 'asks to a whole channel or a list are ignored (Settings ▸ Scanning)' };
    if (prefs.channelAsks === 'ask') return { confidence: 'guess' };
  }
  return { confidence: args.confidence };
}

/**
 * DUE-1: a bare date (`2026-11-04`) or a date-time without a zone (`2026-11-04T17:00`) stays as written, so the store
 * reads it in the user's timezone (a bare date = 17:00 local). Before, `Date.parse` made a bare date UTC midnight: the
 * evening before, in the Americas, so items were due before they were asked.
 */
export function dueArg(v: string): string {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(t)) return t;
  return toIso(t) ?? t;
}

/** Tag a pass's writes so scoring and Health can tell traversal, triage and escalation apart. */
const tagged = (state: CcRunState, reason: string) => (state.pass && !reason.startsWith(`${state.pass}:`) ? `${state.pass}: ${reason}` : reason);

export class CcToolError extends Error {
  override name = 'CcToolError';
}

const normalize = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Content hash of an agent-transcribed item. The model re-transcribes overlapping messages on every
 * run, so the hash ignores what transcription varies (case, whitespace, punctuation, emoji, markup,
 * truncation point): lowercase letters and digits of the first 400 characters. A real edit still
 * changes it.
 */
const fingerprint = (s: string | undefined) =>
  normalize(s)
    .toLowerCase()
    .replace(/\[redacted[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 400);

export function contentHashOf(item: { title?: string; excerpt?: string }): string {
  return crypto.createHash('sha1').update(`${fingerprint(item.title)}\n${fingerprint(item.excerpt)}`).digest('hex');
}

export const dedupeKeyOf = (connector: ConnectorId, externalId: string) => `${connector}:${externalId}`;

/** ISO, Slack ts, epoch seconds/millis or "YYYY-MM-DD HH:MM:SS TZ" → ISO. */
export function toIso(v: string): string | undefined {
  if (/^\d{9,11}(\.\d+)?$/.test(v)) return new Date(Math.round(Number(v) * 1000)).toISOString();
  if (/^\d{12,14}$/.test(v)) return new Date(Number(v)).toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const isSlackTs = (v: string) => /^\d{9,11}\.\d+$/.test(v);

/** Normalize one agent-supplied item into the contract shape (forced connector, computed keys, redaction). */
/**
 * Which source an agent-recorded item belongs to. A `watch` run reads Slack/Org62 on behalf of a
 * subscription; its messages and records keep their source's key so one message is one row (store S16).
 */
export function itemConnector(runConnector: ConnectorId, kind: NormalizedSourceItem['kind']): ConnectorId {
  if (runConnector !== 'watch') return runConnector;
  if (kind === 'message' || kind === 'thread') return 'slack';
  if (kind === 'record_snapshot') return 'org62';
  return 'watch';
}

export function normalizeItem(runConnector: ConnectorId, raw: z.infer<typeof sourceItemInput>): NormalizedSourceItem {
  const connector = itemConnector(runConnector, raw.kind);
  const occurredAt = toIso(raw.occurredAt) ?? (isSlackTs(raw.externalId.split(':').pop() ?? '') ? toIso(raw.externalId.split(':').pop()!) : undefined);
  if (!occurredAt) throw new CcToolError(`occurredAt is not a timestamp for ${raw.externalId}`);
  const title = raw.title != null ? redact(raw.title) : undefined;
  // R6: up to 4,000 chars (an ask past character 1,000 was lost, SCN-9); each prompt clips what it shows.
  const ex = raw.excerpt != null ? redact(raw.excerpt.slice(0, EXCERPT_MAX_CHARS)) : undefined;
  const payload = raw.payload ? redactPayload(raw.payload) : undefined;
  const item: NormalizedSourceItem = {
    connector,
    kind: raw.kind,
    externalId: raw.externalId,
    dedupeKey: dedupeKeyOf(connector, raw.externalId),
    contentHash: '',
    occurredAt,
    author: raw.author,
    participants: raw.participants,
    permalink: raw.permalink,
    title: title?.text,
    excerpt: ex?.text,
    redacted: !!(title?.redacted || ex?.redacted || payload?.redacted),
    threadRef: raw.threadRef,
    // RED-1: a ref that is a credential (a password-manager share link) never leaves the tool call.
    fileRefs: raw.fileRefs?.filter((r) => !redact(r).redacted),
    accountHints: raw.accountHints,
    oppHints: raw.oppHints,
    payload: payload?.value as Record<string, unknown> | undefined,
  };
  item.contentHash = contentHashOf(item);
  return item;
}

function normalizeCoverage(o: { kind?: CoverageObject['kind']; ref: string; from?: string; to?: string; meta?: Record<string, unknown> }, fallbackKind: CoverageObject['kind'], window: TimeWindow): CoverageObject {
  const meta: Record<string, unknown> = { ...(o.meta ? (redactPayload(o.meta).value as Record<string, unknown>) : {}) };
  let from = o.from != null ? toIso(o.from) : undefined;
  let to = o.to != null ? toIso(o.to) : undefined;
  const isPos = (v: string) => /^\d{9,11}(\.\d+)?$/.test(v);
  if (o.from && isPos(o.from)) meta.startToken = o.from;
  if (o.to && isPos(o.to)) meta.endToken = o.to;
  // Never let an agent claim coverage outside its window (10 min slack below for the search overlap).
  const lo = Date.parse(window.from) - 10 * 60_000;
  const hi = Date.parse(window.to);
  if (from && Date.parse(from) < lo) from = new Date(lo).toISOString();
  if (to && Date.parse(to) > hi) to = window.to;
  if (from && to && Date.parse(to) < Date.parse(from)) to = from;
  const out: CoverageObject = { kind: o.kind ?? fallbackKind, ref: o.ref };
  if (from) out.from = from;
  if (to) out.to = to;
  if (Object.keys(meta).length) out.meta = meta;
  return out;
}

/** Holes in [from, to) not covered by the run's own ranged coverage (tolerance 1 s). */
export function ownCoverageHole(coverage: CoverageObject[], from: string, to: string): TimeWindow | undefined {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (t <= f + 1000) return undefined;
  const ranges = coverage
    .filter((c) => c.from && c.to)
    .map((c) => ({ a: Date.parse(c.from!), b: Date.parse(c.to!) }))
    .filter((r) => r.b > r.a)
    .sort((x, y) => x.a - y.a);
  let at = f;
  for (const r of ranges) {
    if (r.b <= at) continue;
    if (r.a > at + 1000) return { from: new Date(at).toISOString(), to: new Date(Math.min(r.a, t)).toISOString() };
    at = Math.max(at, r.b);
    if (at >= t - 1000) return undefined;
  }
  return at >= t - 1000 ? undefined : { from: new Date(at).toISOString(), to };
}

export type CcHandlers = { [K in CcToolName]: (args: CcInput<K>) => Promise<unknown> };

export function createCcHandlers(store: ScannerStore, state: CcRunState): CcHandlers {
  const assertOpen = () => {
    if (state.finished) throw new CcToolError('run already finished (cc_finish was called); no further writes');
  };
  const noteResolution = (workItemId: string | undefined, r: ResolutionFields) => {
    if (workItemId && (r.resolution || r.involvement)) state.resolution.set(workItemId, { resolution: r.resolution, involvement: r.involvement });
  };

  return {
    async cc_get_context() {
      return { context: state.context, window: state.window, runId: state.runId };
    },

    async cc_record_source_items({ items }) {
      assertOpen();
      const normalized = items.map((it) => normalizeItem(state.connector, it));
      // REC-1: a message the runner already recorded from the tool result keeps that (verbatim) version.
      const fresh = normalized.filter((n) => !state.auto.has(n.dedupeKey));
      const res = fresh.length ? await store.recordSourceItems(state.runId, fresh) : [];
      res.forEach((r, i) => {
        state.recorded.set(r.dedupeKey, r.sourceItemId);
        state.items.set(r.dedupeKey, fresh[i]!);
        state.counts.recorded += 1;
        if (r.isNew) state.counts.new += 1;
        if (r.changed) state.counts.changed += 1;
      });
      const byKey = new Map(res.map((r) => [r.dedupeKey, r]));
      return {
        items: normalized.map((n) => {
          const r = byKey.get(n.dedupeKey);
          if (!r) return { id: state.recorded.get(n.dedupeKey)!, ext: n.externalId, new: false, chg: false, auto: true };
          return { id: r.sourceItemId, ext: n.externalId, new: r.isNew, chg: r.changed, ...(n.redacted ? { red: true } : {}) };
        }),
      };
    },

    async cc_find_candidates(args) {
      const c = await store.findCandidates({
        text: args.text ? redact(args.text).text : undefined,
        people: args.people,
        accounts: args.accounts,
        threadRefs: args.threadRefs,
        fileRefs: args.files,
        limit: args.limit ?? 5,
      });
      return {
        candidates: c.map((x) => {
          const ext = x as typeof x & ResolutionFields & { state?: string };
          noteResolution(x.workItemId, ext);
          return {
            ...(x.workItemId ? { w: x.workItemId } : {}),
            ...(x.initiativeId ? { i: x.initiativeId } : {}),
            t: x.title.length > 90 ? `${x.title.slice(0, 89)}…` : x.title,
            s: Math.round(x.score * 100) / 100,
            why: x.why,
            ...(ext.state ? { st: ext.state } : {}),
            ...(ext.resolution ? { res: ext.resolution } : {}),
            ...(ext.involvement ? { inv: ext.involvement } : {}),
          };
        }),
      };
    },

    async cc_link_evidence(args) {
      assertOpen();
      let { role, reason } = args;
      let coerced: string | undefined;
      // R-UI-22 guard: handed-off / watcher / not-involved items take context only, except a loop-back.
      if (isContextOnly(state.resolution.get(args.workItemId)) && role !== 'context') {
        const loopBack = role === 'origin' && reason.startsWith(LOOP_BACK_PREFIX);
        if (!loopBack) {
          coerced = role;
          role = 'context';
          reason = `coerced_context(R-UI-22, was ${coerced}): ${reason}`;
        }
      }
      const sourceItemId = resolveSourceItemId(state, args.sourceItemId);
      const r = await store.linkEvidence(state.runId, { workItemId: args.workItemId, sourceItemId, role, confidence: args.confidence, reason: redact(tagged(state, reason)).text });
      state.counts.linked += 1;
      state.touched.add(r.touchedWorkItemId);
      noteOutcome(state, sourceItemId, `${role}:${args.workItemId}`);
      return { ok: true, ev: r.evidenceId, role, ...(coerced ? { coerced: `${coerced}→context (item is handed off / watcher; use loop_back: only for a direct ask of me)` } : {}) };
    },

    async cc_propose_item(args) {
      assertOpen();
      const evidence = args.evidence.map((e) => ({ ...e, sourceItemId: resolveSourceItemId(state, e.sourceItemId) }));
      const gate = proposalGate(state, { ...args, evidence });
      if ('skip' in gate) return { w: null, skipped: gate.skip };
      const r = await store.proposeItem(state.runId, {
        kind: args.kind,
        title: redact(args.title).text,
        purpose: args.purpose ? redact(args.purpose).text : undefined,
        due: args.due ? dueArg(args.due) : undefined,
        effort: args.effort,
        initiativeId: args.initiativeId,
        accountId: args.accountId,
        oppId: args.oppId,
        expected: args.expected,
        evidence: evidence.map((e) => ({ ...e, reason: redact(tagged(state, e.reason)).text })),
        confidence: gate.confidence,
      });
      state.counts.proposed += 1;
      state.touched.add(r.workItemId);
      for (const e of args.evidence) noteOutcome(state, resolveSourceItemId(state, e.sourceItemId), e.role === 'origin' ? `proposed:${r.workItemId}:${args.kind}` : `${e.role}:${r.workItemId}`);
      return { w: r.workItemId, as: r.landedAs };
    },

    async cc_propose_initiative(args) {
      assertOpen();
      const r = await store.proposeInitiative(state.runId, { ...args, title: redact(args.title).text, purpose: redact(args.purpose).text });
      return { i: r.initiativeId };
    },

    async cc_flag_unlinked(args) {
      assertOpen();
      const sourceItemId = resolveSourceItemId(state, args.sourceItemId);
      await store.flagUnlinked(state.runId, { sourceItemId, reason: redact(tagged(state, args.reason)).text, hints: args.hints?.map((h) => redact(h).text) });
      state.counts.unlinked += 1;
      noteOutcome(state, sourceItemId, 'flagged');
      return { ok: true };
    },

    async cc_report_coverage(args) {
      assertOpen();
      const objs: CoverageObject[] = [
        ...(args.windows ?? []).map((w) => normalizeCoverage(w, 'query_window', state.window)),
        ...(args.objects ?? []).map((o) => normalizeCoverage(o, o.kind, state.window)),
      ].map((o) => {
        const extra = state.coverageMeta?.(o);
        return extra ? { ...o, meta: { ...(o.meta ?? {}), ...extra } } : o;
      });
      if (!objs.length) throw new CcToolError('report at least one window or object');
      await store.reportCoverage(state.runId, objs);
      state.coverage.push(...objs);
      state.counts.coverage += objs.length;
      return { ok: true, n: objs.length };
    },

    async cc_record_brief_highlights(args) {
      assertOpen();
      const subscription = args.subscription ?? state.briefDefaults.subscription;
      if (!subscription) throw new CcToolError('subscription is required for this scope (kind + ref)');
      const s = store as ScannerStoreWithBriefs;
      if (!s.recordBriefHighlights) throw new CcToolError('this store does not record briefs');
      const input: BriefHighlightsInput = {
        subscription,
        period: args.period ? { from: toIso(args.period.from) ?? args.period.from, to: toIso(args.period.to) ?? args.period.to } : state.briefDefaults.period,
        summary: redact(args.summary).text,
        highlights: args.highlights.map((h) => ({
          title: redact(h.title).text,
          relevance: h.relevance,
          reasons: h.reasons.map((r) => redact(r).text),
          sourceItemIds: h.sourceItemIds.map((x) => {
            try {
              return resolveSourceItemId(state, x);
            } catch {
              return x;
            }
          }),
          suggestedAction: h.suggestedAction ?? (h.relevance === 'low' ? 'ignore' : 'promote'),
        })),
      };
      const r = await s.recordBriefHighlights(state.runId, input);
      state.brief = { briefId: r.briefId, highlights: input.highlights.length };
      return { ok: true, brief: r.briefId, n: input.highlights.length };
    },

    async cc_triage_verdicts(args) {
      assertOpen();
      if (!state.pass) throw new CcToolError('cc_triage_verdicts is for triage passes only');
      const unknown: string[] = [];
      for (const v of args.verdicts) {
        let id: string;
        try {
          id = resolveSourceItemId(state, v.id);
        } catch {
          unknown.push(v.id);
          continue;
        }
        // Escalation is final: an unsure verdict there counts as noise.
        const verdict = state.pass === 'escalate' && v.v === 'unsure' ? 'noise' : v.v;
        state.verdicts.set(id, { v: verdict, ...(v.why ? { why: redact(v.why).text } : {}) });
      }
      return { ok: true, n: args.verdicts.length - unknown.length, ...(unknown.length ? { unknown } : {}) };
    },

    async cc_finish(args) {
      assertOpen();
      const at = toIso(args.cursor.at);
      if (!at) throw new CcToolError('cursor.at must be an ISO timestamp');
      const wFrom = Date.parse(state.window.from);
      const wTo = Date.parse(state.window.to);
      let atMs = Date.parse(at);
      if (atMs > wTo) atMs = wTo; // never beyond the window
      if (atMs < wFrom - 1000) throw new CcToolError(`cursor.at ${at} is before the window start ${state.window.from}`);
      const cursorAt = new Date(atMs).toISOString();
      const hole = ownCoverageHole(state.coverage, state.window.from, cursorAt);
      if (hole) {
        throw new CcToolError(
          `coverage has a hole ${hole.from} → ${hole.to}. Call cc_report_coverage for every query window you ran (starting at ${state.window.from}, 0-result queries included), or set cursor.at to the end of what you covered with complete=false.`,
        );
      }
      const complete = args.complete ?? atMs >= wTo - 1000;
      state.finished = { cursor: { value: args.cursor.value, at: cursorAt }, complete, summary: args.summary ? redact(args.summary).text : undefined, agentStats: args.stats };
      return { ok: true, cursor: state.finished.cursor, complete };
    },
  };
}

/** Validate then dispatch. Returns the MCP-style result the agent sees. Never throws. */
export async function callCcTool(handlers: CcHandlers, state: CcRunState, name: string, rawArgs: unknown): Promise<{ isError: boolean; text: string }> {
  const schema = (schemas as Record<string, z.ZodTypeAny>)[name];
  if (!schema) {
    state.calls.push({ tool: name, ok: false, error: 'unknown_tool' });
    return { isError: true, text: JSON.stringify({ error: `unknown cc tool ${name}` }) };
  }
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    state.calls.push({ tool: name, ok: false, error: 'validation' });
    return { isError: true, text: JSON.stringify({ error: `invalid input: ${msg}` }) };
  }
  try {
    const out = await (handlers as Record<string, (a: unknown) => Promise<unknown>>)[name]!(parsed.data);
    state.calls.push({ tool: name, ok: true });
    return { isError: false, text: JSON.stringify(out) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.calls.push({ tool: name, ok: false, error: err instanceof Error ? err.name : 'error' });
    return { isError: true, text: JSON.stringify({ error: redact(msg).text.slice(0, 400) }) };
  }
}

/**
 * Fallback for skills that write the brief into `cc_finish.summary` (scan-watch §4.3):
 *   HIGHLIGHTS v1
 *   <ts>|<permalink>|<sentence>|matched=<…>|why=<…>
 * Lines are ranked best first: the first two are high, the next three medium, the rest low.
 * `sourceItemIds` are resolved from recorded items whose externalId ends with `:<ts>`.
 */
export function parseHighlightsBlock(summary: string | undefined, recorded: Map<string, string>): { summary: string; highlights: BriefHighlightsInput['highlights'] } | undefined {
  if (!summary) return undefined;
  const at = summary.indexOf('HIGHLIGHTS v1');
  if (at < 0) return undefined;
  const head = summary.slice(0, at).trim();
  const lines = summary
    .slice(at + 'HIGHLIGHTS v1'.length)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('|'));
  // every highlight line the run wrote (caps audit 2026-11-21: was the first 12); relevance still falls with the order
  const highlights = lines.map((line, i) => {
    const [ts = '', , sentence = '', ...rest] = line.split('|');
    const kv = Object.fromEntries(rest.map((p) => p.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k!.trim(), v.join('=').trim()]));
    const ids = [...recorded.entries()].filter(([key]) => ts && key.endsWith(`:${ts.trim()}`)).map(([, id]) => id);
    const relevance: 'high' | 'medium' | 'low' = i < 2 ? 'high' : i < 5 ? 'medium' : 'low';
    return {
      title: redact(sentence.trim() || line.slice(0, 200)).text,
      relevance,
      reasons: [kv.why, kv.matched ? `matched: ${kv.matched}` : undefined].filter((x): x is string => !!x).map((r) => redact(r).text),
      sourceItemIds: ids,
      suggestedAction: relevance === 'low' ? ('ignore' as const) : ('promote' as const),
    };
  });
  return { summary: head || 'brief', highlights: highlights.map((h) => ({ ...h, reasons: h.reasons.length ? h.reasons : ['ranked by scan-watch'] })) };
}
