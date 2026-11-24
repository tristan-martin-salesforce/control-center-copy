/**
 * The completion pass (CMP-1): "model check per item".
 *
 *   1. items      open work items that are mine (store.completionItems)
 *   2. sources    what arrived since the oldest item's last check (store.completionSources), up to `through`
 *                 (now minus a settle margin, so a scan transaction still committing is never skipped)
 *   3. candidates deterministic rules per item (candidates.ts); items with none are checked at no cost
 *   4. model      one cheap, tool-less call per batch of items (skills/check-completion.md)
 *   5. gate       done → `completion` (Sure only when the cited message is mine and strongly tied to the item,
 *                 at high confidence, and the item may auto-close (R1); otherwise Likely), partial → `progress`,
 *                 not done → nothing
 *   6. write      through the scanner's writer (`linkEvidence`, `cc_link_evidence` semantics) inside a
 *                 zero-length run on `<connector>:completion:check` (like reconcile's relink runs), reason
 *                 prefix `done_check:`. The W2 bump enqueues `reevaluate`; the closure machine decides.
 *
 * The pass never sets item state. Budget: before every call the global hard cap (budgetStatus) is checked; at the
 * cap nothing is called and the items stay pending for the next budget day. Spend is recorded like the scanner's
 * (store.recordSpend against the completion run). Logs carry ids, counts and codes, never message text.
 */
import { redact } from '@/connectors/redact';
import { SCANNER_MODEL } from '@/llm/models';
import type { SpendGate } from '@/llm/spend';
import { loadSkill } from '@/llm/skill-loader';
import { ledgerHash } from '@/db/ledger';

import { toMs } from '../store-memory';
import type { ConnectorId, ReevaluateEnqueuer } from '../types';
import { collectCandidates, itemFacts } from './candidates';
import { parseVerdicts, renderBatch, type BatchEntry } from './prompt';
import {
  DONE_CHECK_PREFIX,
  type Candidate,
  type CompletionModel,
  type CompletionSignal,
  type CompletionStore,
  type CompletionWatermark,
  type ItemVerdict,
} from './types';

export const COMPLETION_SKILL_PATH = 'skills/check-completion.md';
export const COMPLETION_SCOPE = 'completion:check';
/** The ledger skill key of the completion check's calls (D0: before, they were booked as the connector's scanner). */
export const COMPLETION_SKILL_KEY = 'check-completion';

const DAY = 86_400_000;

export interface CompletionLimits {
  /** Items sent to the model per pass; the rest stay pending and a follow-up pass runs. */
  maxItemsPerPass: number;
  /** Items per model call (skill frontmatter `max_items_per_call`). */
  itemsPerCall: number;
  /** Candidates per item (skill frontmatter `max_candidates_per_item`). */
  maxCandidatesPerItem: number;
  /** Characters of user prompt per call; a batch is split before it grows past this. */
  maxPromptChars: number;
  /** Hard stop per call (skill frontmatter `budget_usd_per_call`). */
  maxCallUsd: number;
  /** Stop calling once a pass has spent this much (the rest stays pending). */
  maxPassUsd: number;
  /** Never look further back than this for an item's candidates. */
  lookbackDays: number;
  /** `through` = now − this, so a scan transaction that started before now but commits later is not skipped. */
  settleMs: number;
  sourceLimit: number;
  /** done + a strong tie + the message is mine + at least this confidence → Sure (auto-closes). */
  sureMinConfidence: number;
  /** When the skill declares them (frontmatter `sure_basis`), Sure also needs one of these bases. */
  sureBasis: readonly string[];
  /** RES-1: bases for which the asker's own message settles an item (frontmatter `sure_resolved_basis`). */
  sureResolvedBasis: readonly string[];
  /** done at or above this → Likely ("Likely done · Confirm"); below → nothing. */
  likelyMinConfidence: number;
  /** partial at or above this → progress. */
  partialMinConfidence: number;
}

export const DEFAULT_LIMITS: CompletionLimits = {
  maxItemsPerPass: 48,
  itemsPerCall: 6,
  maxCandidatesPerItem: 6,
  maxPromptChars: 14_000,
  maxCallUsd: 0.05,
  maxPassUsd: 0.4,
  lookbackDays: 14,
  settleMs: 60_000,
  sourceLimit: 4000,
  sureMinConfidence: 0.9,
  sureBasis: [],
  sureResolvedBasis: [],
  likelyMinConfidence: 0.7,
  partialMinConfidence: 0.6,
};

export interface CompletionPassInput {
  store: CompletionStore;
  model: CompletionModel;
  now: Date;
  /** The previous pass's watermark (null on the first pass). */
  watermark: CompletionWatermark | null;
  meName?: string;
  repoRoot?: string;
  skillPath?: string;
  signal?: AbortSignal;
  limits?: Partial<CompletionLimits>;
  /** Return the signals without writing evidence, runs or spend (evaluation). */
  dryRun?: boolean;
  /** Fan-out after the runs finish (the W2 bump already enqueued re-evaluation; this coalesces with it). */
  reevaluate?: ReevaluateEnqueuer;
  /** D0: what started this pass (`scan`, `catch_up`, `interval`), booked on each call. */
  trigger?: string;
  /**
   * H-7 / R8 (settings.closing.resolutionEngine): `live` retires this pass's own model call: the items with candidates
   * are handed to the resolution check (`delegate`, one `resolution.check` per item) and the pass writes nothing.
   * `shadow` and `legacy` (and absent): the pass runs as before.
   */
  resolutionEngine?: 'legacy' | 'shadow' | 'live';
  delegate?: (workItemIds: string[]) => Promise<void>;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
  /**
   * F-4 (caps audit 26): the job's spend hold (src/llm/spend/job-spend.ts). Each call reports the pass's spend; past
   * the hold, with items still to judge, the pass raises a hand and stops (they stay pending for the continuation).
   * The per-call budget is then the runaway guard (`ceilingUsd`), not `maxCallUsd`.
   */
  spend?: SpendGate | null;
}

export interface CompletionPassResult {
  status: 'ok' | 'nothing_new' | 'deferred_budget' | 'partial' | 'delegated';
  watermark: CompletionWatermark;
  /** Items are still pending because of the per-pass caps: run another pass soon. */
  more: boolean;
  /** The pass passed its spend hold and asked to allow more; the rest waits for the answer (not `more`). */
  pausedForSpend?: boolean;
  items: number;
  withCandidates: number;
  checked: number;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  verdicts: { done: number; partial: number; not_done: number; invalid: number; missing: number };
  /** What was (or, in a dry run, would be) written. Carries model reasons: never put it in logs or jobs.result. */
  signals: CompletionSignal[];
  evidenceIds: string[];
  runIds: string[];
  /** Error codes only. */
  errors: string[];
  skill: string;
  /** Per call: items, candidates, cost (evaluation). */
  callLog: Array<{ items: number; candidates: number; costUsd: number; ok: boolean }>;
}

/** Verdict → the signal to emit (or null). Exposed for tests: this is the precision gate. */
export function gateVerdict(
  v: ItemVerdict & { candidate?: Candidate },
  L: Pick<CompletionLimits, 'sureMinConfidence' | 'likelyMinConfidence' | 'partialMinConfidence'> & Partial<Pick<CompletionLimits, 'sureBasis' | 'sureResolvedBasis'>> = DEFAULT_LIMITS,
): CompletionSignal | null {
  const c = v.candidate;
  if (v.verdict === 'not_done' || !c || !v.sourceItemId) return null;
  // A "done" whose own basis says nothing finishes it is self-contradictory: drop it.
  if (v.verdict === 'done' && (v.basis === 'none' || v.basis === 'partial')) return null;
  const why = redact(v.reason.trim() || (v.verdict === 'done' ? 'the check judged it done' : 'some of it is done')).text.slice(0, 160);
  const base = { workItemId: v.workItemId, sourceItemId: v.sourceItemId, connector: c.source.connector as ConnectorId, modelConfidence: v.confidence, ...(v.basis ? { basis: v.basis } : {}), relations: [...c.relations] };
  if (v.verdict === 'done') {
    const basisOk = !L.sureBasis?.length || (!!v.basis && L.sureBasis.includes(v.basis));
    if (basisOk && v.confidence >= L.sureMinConfidence && c.strong && c.source.fromMe) {
      return { ...base, role: 'completion', confidence: 'sure', reason: `${DONE_CHECK_PREFIX} ${why}`, gate: 'strong_mine' };
    }
    // RES-1: the asker settles it ("I'll cancel the prep", "no need", "invite sent"), in the item's own conversation or a
    // small one with them (from_asker). Sure, with the asker named; Undo stays available like any engine close.
    const resolvedBasis = !!v.basis && !!L.sureResolvedBasis?.includes(v.basis);
    if (resolvedBasis && v.confidence >= L.sureMinConfidence && !c.source.fromMe && c.relations.includes('from_asker')) {
      const who = c.source.author?.name?.trim() || 'the asker';
      return { ...base, role: 'completion', confidence: 'sure', reason: `${DONE_CHECK_PREFIX} Resolved by ${who}: ${why}`.slice(0, 240), gate: 'asker_resolved' };
    }
    if (v.confidence >= L.likelyMinConfidence) return { ...base, role: 'completion', confidence: 'likely', reason: `${DONE_CHECK_PREFIX} ${why}`, gate: 'likely' };
    return null;
  }
  if (v.confidence >= L.partialMinConfidence) return { ...base, role: 'progress', confidence: 'likely', reason: `${DONE_CHECK_PREFIX} partial: ${why}`, gate: 'partial' };
  return null;
}

function limitsFrom(fm: Record<string, unknown>, over: Partial<CompletionLimits> | undefined): CompletionLimits {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    ...DEFAULT_LIMITS,
    ...(num(fm.max_items_per_call) ? { itemsPerCall: num(fm.max_items_per_call)! } : {}),
    ...(num(fm.max_candidates_per_item) ? { maxCandidatesPerItem: num(fm.max_candidates_per_item)! } : {}),
    ...(num(fm.budget_usd_per_call) ? { maxCallUsd: num(fm.budget_usd_per_call)! } : {}),
    // A skill version carries its own calibration (a smaller model compresses its confidence).
    ...(num(fm.sure_min_confidence) ? { sureMinConfidence: num(fm.sure_min_confidence)! } : {}),
    ...(num(fm.likely_min_confidence) ? { likelyMinConfidence: num(fm.likely_min_confidence)! } : {}),
    ...(num(fm.partial_min_confidence) ? { partialMinConfidence: num(fm.partial_min_confidence)! } : {}),
    ...(Array.isArray(fm.sure_basis) ? { sureBasis: fm.sure_basis.filter((x): x is string => typeof x === 'string') } : {}),
    ...(Array.isArray(fm.sure_resolved_basis) ? { sureResolvedBasis: fm.sure_resolved_basis.filter((x): x is string => typeof x === 'string') } : {}),
    ...over,
  };
}

/** Split entries into calls: at most `itemsPerCall` items and about `maxPromptChars` of prompt each. */
function batches(entries: BatchEntry[], L: CompletionLimits, now: string): BatchEntry[][] {
  const out: BatchEntry[][] = [];
  let cur: BatchEntry[] = [];
  for (const e of entries) {
    const next = [...cur, e];
    if (cur.length && (next.length > L.itemsPerCall || renderBatch(next, { now, meName: 'me' }).user.length > L.maxPromptChars)) {
      out.push(cur);
      cur = [e];
    } else cur = next;
  }
  if (cur.length) out.push(cur);
  return out;
}

function dominantConnector(entries: BatchEntry[]): ConnectorId {
  const n = new Map<ConnectorId, number>();
  for (const e of entries) for (const c of e.candidates) n.set(c.source.connector, (n.get(c.source.connector) ?? 0) + 1);
  return ([...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'slack') as ConnectorId;
}

export async function runCompletionPass(input: CompletionPassInput): Promise<CompletionPassResult> {
  const { store } = input;
  const log = input.log ?? (() => undefined);
  const skill = loadSkill(input.skillPath ?? COMPLETION_SKILL_PATH, input.repoRoot);
  const L = limitsFrom(skill.frontmatter as Record<string, unknown>, input.limits);
  const model = typeof skill.frontmatter.model === 'string' ? skill.frontmatter.model : SCANNER_MODEL;
  const effort = skill.frontmatter.effort === 'medium' || skill.frontmatter.effort === 'high' ? skill.frontmatter.effort : 'low';
  const nowMs = input.now.getTime();
  const nowIso = input.now.toISOString();
  const through = nowMs - L.settleMs;
  const floor = nowMs - L.lookbackDays * DAY;
  // First pass ever: every item counts as never checked (its window starts at its own ask, at most lookbackDays back).
  const prevThrough = Math.max(floor, toMs(input.watermark?.through) ?? floor);
  const oldPending = input.watermark?.pending ?? {};

  const res: CompletionPassResult = {
    status: 'ok',
    watermark: { through: new Date(Math.max(through, prevThrough)).toISOString(), pending: {}, skill: skill.versionTag },
    more: false,
    items: 0,
    withCandidates: 0,
    checked: 0,
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    verdicts: { done: 0, partial: 0, not_done: 0, invalid: 0, missing: 0 },
    signals: [],
    evidenceIds: [],
    runIds: [],
    errors: [],
    skill: skill.versionTag,
    callLog: [],
  };
  if (through <= prevThrough && !Object.keys(oldPending).length) {
    res.status = 'nothing_new';
    res.watermark.through = new Date(prevThrough).toISOString();
    return res;
  }

  // ---- 1–3: items, their windows, sources, candidates (deterministic, no model)
  // every live item (the model work is paged by maxItemsPerPass below; this read is deterministic)
  const items = await store.completionItems({ asOf: new Date(through).toISOString() });
  res.items = items.length;
  const since = new Map<string, number>();
  const factsOf = new Map(items.map((it) => [it.workItemId, itemFacts(it)]));
  for (const it of items) {
    const p = toMs(oldPending[it.workItemId]);
    const created = toMs(it.createdAt) ?? 0;
    // Never checked (created since the last pass): look back to the ask itself. Whatever happened after the ask
    // arrived after it, so the window can start there (5 min of slack for source clocks).
    const s = p ?? (created > prevThrough ? factsOf.get(it.workItemId)!.askAt - 5 * 60_000 : prevThrough);
    since.set(it.workItemId, Math.max(floor, s));
  }
  const minSince = Math.min(prevThrough, ...since.values());
  const sources = items.length ? await store.completionSources({ seenAfter: new Date(minSince).toISOString(), seenUntil: new Date(through).toISOString(), limit: L.sourceLimit }) : [];
  const entries: BatchEntry[] = [];
  for (const item of items) {
    const facts = factsOf.get(item.workItemId)!;
    const candidates = collectCandidates(item, sources, { seenAfter: since.get(item.workItemId)!, seenUntil: through, maxPerItem: L.maxCandidatesPerItem }, facts);
    if (candidates.length) entries.push({ item, facts, candidates });
    else res.checked += 1;
  }
  res.withCandidates = entries.length;
  const keepPending = (es: BatchEntry[]) => {
    for (const e of es) res.watermark.pending[e.item.workItemId] = new Date(since.get(e.item.workItemId)!).toISOString();
  };
  if (!entries.length) {
    res.status = 'nothing_new';
    log('completion: no candidates', { items: items.length, sources: sources.length });
    return res;
  }

  if (input.resolutionEngine === 'live') {
    // the resolution check judges them (its own triggers usually queued them already; the per-item dedupe absorbs repeats)
    if (!input.dryRun) await input.delegate?.(entries.map((e) => e.item.workItemId));
    res.status = 'delegated';
    res.checked += entries.length;
    log('completion: delegated to the resolution check', { items: entries.length });
    return res;
  }

  // Most recently active first; the per-pass cap leaves the rest pending.
  const latest = (e: BatchEntry) => Math.max(...e.candidates.map((c) => toMs(c.source.occurredAt) ?? 0));
  entries.sort((a, b) => latest(b) - latest(a));
  const todo = entries.slice(0, L.maxItemsPerPass);
  if (entries.length > todo.length) {
    keepPending(entries.slice(todo.length));
    res.more = true;
  }

  // ---- runs (lazy, one per connector that gets evidence or spend)
  const runs = new Map<ConnectorId, { runId: string; costUsd: number; linked: number; inputTokens: number; outputTokens: number; calls: number }>();
  const runFor = async (connector: ConnectorId) => {
    let r = runs.get(connector);
    if (!r) {
      const { runId } = await store.startRun({ scope: { connector, scope: COMPLETION_SCOPE }, trigger: 'reconcile', window: { from: nowIso, to: nowIso }, model, skillVersion: skill.versionTag });
      r = { runId, costUsd: 0, linked: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
      runs.set(connector, r);
      res.runIds.push(runId);
    }
    return r;
  };

  const touched = new Map<ConnectorId, Set<string>>();
  const collected: Array<ItemVerdict & { candidate?: Candidate }> = [];
  let askNext = false;
  try {
    const groups = batches(todo, L, nowIso);
    for (let gi = 0; gi < groups.length; gi++) {
      const batch = groups[gi]!;
      const rest = () => groups.slice(gi).flat();
      if (askNext && input.spend) {
        // H-5: past the hold with items still to judge: raise a hand at this safe point; they wait for the answer
        await input.spend.ask({ pctDone: Math.round((gi / groups.length) * 100) }).catch(() => undefined);
        keepPending(rest());
        res.pausedForSpend = true;
        res.status = 'partial';
        log('completion: paused at the spend estimate; asked to allow more', { pending: rest().length, spentUsd: Number(res.costUsd.toFixed(5)) });
        break;
      }
      if (input.signal?.aborted) {
        keepPending(rest());
        res.status = 'partial';
        res.errors.push('aborted');
        break;
      }
      if (res.costUsd >= L.maxPassUsd) {
        keepPending(rest());
        res.more = true;
        res.status = 'partial';
        break;
      }
      const budget = await store.budgetStatus();
      if (budget.state === 'capped') {
        keepPending(rest());
        res.status = 'deferred_budget';
        log('completion: daily hard cap reached; items stay pending', { pending: rest().length });
        break;
      }
      const { user, ids } = renderBatch(batch, { now: nowIso, meName: input.meName ?? 'me' });
      // with a hold, one call's budget is the runaway guard only (F-4): the hold asks before a second call passes it
      const maxBudgetUsd = input.spend ? Math.max(L.maxCallUsd, input.spend.ceilingUsd()) : L.maxCallUsd;
      const out = await input.model({ system: skill.body, user, model, effort, maxBudgetUsd, signal: input.signal });
      res.calls += 1;
      res.costUsd += out.costUsd;
      if (input.spend?.observe(res.costUsd) === 'ask') askNext = true;
      res.inputTokens += out.inputTokens;
      res.outputTokens += out.outputTokens;
      const candidates = batch.reduce((a, e) => a + e.candidates.length, 0);
      res.callLog.push({ items: batch.length, candidates, costUsd: out.costUsd, ok: out.ok });
      const conn = dominantConnector(batch);
      if (!input.dryRun && out.costUsd > 0) {
        const r = await runFor(conn);
        r.costUsd += out.costUsd;
        r.inputTokens += out.inputTokens;
        r.outputTokens += out.outputTokens;
        r.calls += 1;
        // D0: booked as the completion check (not the connector's scanner), with its tokens and content hash.
        await store.recordSpend({
          connector: conn,
          model,
          costUsd: out.costUsd,
          runId: r.runId,
          skill: COMPLETION_SKILL_KEY,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          cacheReadTokens: out.cacheReadTokens ?? 0,
          cacheWriteTokens: out.cacheWriteTokens ?? 0,
          usage: [{ model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, cacheReadTokens: out.cacheReadTokens ?? 0, cacheWriteTokens: out.cacheWriteTokens ?? 0, costUsd: out.costUsd }],
          trigger: input.trigger ?? 'reconcile',
          modelReason: 'default',
          contentHash: ledgerHash(model, skill.versionTag ?? null, skill.body, user),
          outcome: out.ok ? 'ok' : `error:${out.error?.errorClass ?? 'unknown'}`,
        });
      }
      if (!out.ok) {
        keepPending(batch);
        res.status = 'partial';
        res.errors.push(`call_failed:${out.error?.errorClass ?? 'unknown'}`);
        log('completion: model call failed', { code: out.error?.errorClass ?? 'unknown', items: batch.length });
        // Auth or config problems will not fix themselves within this pass.
        if (out.error?.errorClass === 'auth' || out.error?.errorClass === 'config') {
          keepPending(groups.slice(gi + 1).flat());
          break;
        }
        continue;
      }
      const parsed = parseVerdicts(out.text, ids);
      if (parsed.error) {
        // A malformed reply is a miss, not a retry loop: the items count as checked.
        res.errors.push('bad_reply');
        log('completion: unparseable reply', { items: batch.length });
      }
      res.verdicts.invalid += parsed.invalid;
      const answered = new Set(parsed.verdicts.map((v) => v.workItemId));
      res.verdicts.missing += batch.filter((e) => !answered.has(e.item.workItemId)).length;
      res.checked += batch.length;
      for (const v of parsed.verdicts) {
        res.verdicts[v.verdict] += 1;
        collected.push(v);
      }
    }

    // ---- gate, then write. One message cited as "done" for two items (the same person often has several asks in
    // one DM) is ambiguous: none of those can auto-close, each at most asks to confirm.
    const doneCites = new Map<string, number>();
    for (const v of collected) if (v.verdict === 'done' && v.sourceItemId) doneCites.set(v.sourceItemId, (doneCites.get(v.sourceItemId) ?? 0) + 1);
    const itemById = new Map(items.map((it) => [it.workItemId, it]));
    for (const v of collected) {
      const sig = gateVerdict(v, L);
      if (!sig) continue;
      if (sig.confidence === 'sure' && (doneCites.get(sig.sourceItemId) ?? 0) > 1) {
        sig.confidence = 'likely';
        sig.gate = 'shared_citation';
      }
      // R1: the user reopened, kept or marked it Not done (or it is on an ask-first list): never closed for them, asked.
      if (sig.confidence === 'sure' && itemById.get(sig.workItemId)?.mayAutoClose === false) {
        sig.confidence = 'likely';
        sig.gate = 'user_corrected';
      }
      res.signals.push(sig);
      if (input.dryRun) continue;
      try {
        const r = await runFor(sig.connector);
        const linked = await store.linkEvidence(r.runId, { workItemId: sig.workItemId, sourceItemId: sig.sourceItemId, role: sig.role, confidence: sig.confidence, reason: sig.reason });
        r.linked += 1;
        sig.evidenceId = linked.evidenceId;
        res.evidenceIds.push(linked.evidenceId);
        const set = touched.get(sig.connector) ?? new Set<string>();
        set.add(linked.touchedWorkItemId);
        touched.set(sig.connector, set);
      } catch (err) {
        // The item or source vanished meanwhile (an Undo, a merge): skip that signal only.
        res.errors.push(`link_failed:${(err as Error).name}`);
      }
    }
  } finally {
    for (const [connector, r] of runs) {
      try {
        const fin = await store.finishRun(r.runId, {
          cursor: { value: 'completion', at: nowIso },
          stats: { fetched: 0, new: 0, changed: 0, linked: r.linked, proposed: 0, unlinked: 0, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, turns: r.calls },
        });
        const ids = [...new Set([...fin.touchedWorkItemIds, ...(touched.get(connector) ?? [])])];
        if (ids.length) await input.reevaluate?.(ids, { runId: r.runId, connector, trigger: 'reconcile' });
      } catch (err) {
        res.errors.push(`finish_failed:${(err as Error).name}`);
      }
    }
  }
  if (res.status === 'ok' && (res.more || res.errors.length)) res.status = 'partial';
  log('completion: pass done', { items: res.items, withCandidates: res.withCandidates, calls: res.calls, signals: res.signals.length, costUsd: Number(res.costUsd.toFixed(5)), status: res.status });
  return res;
}
