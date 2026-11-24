/**
 * Reconcile (SCANNER.md §6). Runs nightly, on resume and on demand. Four passes:
 *
 *  1. coverage_gaps  — deterministic sources list the last 7 days cheaply (`listForReconcile`) and diff
 *                      against the ledger (`uncoveredObjects`); every uncovered object gets a targeted
 *                      scan. Any time hole behind a cursor becomes a backfill job.
 *  2. unlinked       — items flagged unlinked are re-linked with fresh open-item context:
 *                      attempts ≤ 1 → Haiku retry; attempts = 2 → one Sonnet escalation;
 *                      attempts ≥ 3 → a Triage mapping question (a `guess` proposal, lands suggested).
 *                      A relink run that leaves an item unlinked counts one attempt (store rule S6).
 *                      Spend (caps audit 26 F-4): with the governor each relink run holds its estimate and asks past
 *                      it (the $0.05 / $0.25 become the runaway guard's floor); while a connector's relink ask is
 *                      open its relinks wait; once allowed, the next pass resumes on the approved hold.
 *  3. stale_active   — open items with no new evidence while their source thread/file changed get a
 *                      targeted rescan (deterministic listing, or Slack thread reads, ≤ 10 per pass).
 *  4. skill_upgrade  — when a skill version bumps, re-link the last N days in a DRY RUN against an
 *                      overlay store; the would-be actions become a finding for the Health page.
 */
import { randomUUID } from 'node:crypto';

import { ESCALATION_MODEL, SCANNER_MODEL } from '../../llm/models';
import { holdGate, PAUSED_FOR_SPEND, type Hold, type SpendGate, type SpendGovernor } from '../../llm/spend';
import type { ScanSkillRunInput } from '../../llm/skill-runner';
import { DEFAULT_SCANNING_PREFS, type ConnectorId, type CoverageObject, type ReevaluateEnqueuer, type ScanContext, type ScannerStore, type ScanningPrefs, type ScopeKey, type SkillRunner, type TimeWindow } from '../types';
import type { Clock } from '../runtime/clock';
import { isTraversal, type ConnectorSpec } from '../runtime/connectors';
import type { ScanSkillRunResult, UnlinkedSourceItemDetail } from '../runtime/contract-ext';
import { scanJob, type ReconcileJob, type RuntimeJob } from '../runtime/jobs';
import { runSpend } from '../runtime/spend';
import { DryRunStore, type DryAction } from './dry-run-store';

const DAY = 86_400_000;
const H = 3_600_000;

export interface ReconcileFinding {
  /** Maps to `reconcile_findings.kind`: coverage_gap | unlinked_item | missed_item; skill_upgrade → app_events. */
  kind: 'coverage_gap' | 'unlinked_item' | 'missed_item' | 'skill_upgrade';
  connector: ConnectorId;
  scope?: string;
  gap?: TimeWindow;
  sourceItemId?: string;
  workItemId?: string;
  detail: string;
  /** skill_upgrade: the dry-run diff. */
  actions?: DryAction[];
  runId?: string;
}

export interface ReconcileReport {
  findings: ReconcileFinding[];
  jobs: RuntimeJob[];
  relinked: number;
  escalated: number;
  triaged: number;
  costUsd: number;
  errors: string[];
  summary: string;
}

export interface ReconcilerDeps {
  store: ScannerStore;
  runner: SkillRunner;
  clock: Clock;
  specs: ConnectorSpec[];
  reevaluate?: ReevaluateEnqueuer;
  onFinding?: (f: ReconcileFinding) => Promise<void>;
  repoRoot?: string;
  withLlmSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Skill-upgrade re-link window. Default 3 days. */
  relinkMs?: number;
  /** Max items per relink run. Default 12. */
  relinkBatch?: number;
  /** Max targeted thread rescans per stale pass. Default 10. */
  maxStaleRescans?: number;
  /** False when the connector's LLM spend reached the daily hard cap: LLM passes are skipped (stress finding BUD-1). */
  llmAllowed?: (connector: ConnectorId) => Promise<boolean>;
  /**
   * True while the connector's first scan (B-080) still has work: the stale-but-active pass skips it. The backfill reads
   * those threads and files anyway, and the re-reads outranked it in the queue: on the first live day about 100 queued
   * thread re-reads held Slack's single slot ahead of 345 inbox chunks (RCN-1).
   */
  firstScanActive?: (connector: ConnectorId) => boolean;
  /** D-55: false for a source the persona doesn't scan (no coverage-gap, relink or stale work). Default: every source. */
  connectorActive?: (connector: ConnectorId) => boolean;
  /** F-4: the spend governor (relink runs hold their estimate and ask past it). Absent: the fixed per-run caps. */
  spend?: SpendGovernor | null;
}

/** A relink hold's job key: `relink:<connector>:<uuid>` (one ask per connector stands at a time). */
const relinkKey = (connector: ConnectorId) => `relink:${connector}:${randomUUID()}`;

/** Optional store extension: the scope's committed coverage span (both stores implement it). */
interface CoverageSpanStore {
  coverageSpan?(scope: ScopeKey): Promise<{ from: string; to: string } | null>;
}

/** Reason prefix a relink writes for an unlinked item that is not actionable for me (skills/_scanner-common.md R9). */
export const NOT_ACTIONABLE = 'not actionable:';
export const isNotActionable = (reason: string | null | undefined) => (reason ?? '').trim().toLowerCase().startsWith(NOT_ACTIONABLE);

/**
 * MAP-1: does an unlinked item get a "Where does this belong?" question? `mine` (the default): only a message or email
 * that is mine (a commitment) or addressed to me (an ask), from Slack or Gmail; `all`: any; `never`: none.
 */
export function mappingQuestionFor(it: Pick<UnlinkedSourceItemDetail, 'connector' | 'fromMe' | 'toMe' | 'reason'>, mode: ScanningPrefs['mappingQuestions']): boolean {
  if (mode === 'never') return false;
  // The relink judged it not actionable for me (R9 step 3): recorded only, never a question.
  if (isNotActionable(it.reason)) return false;
  if (mode === 'all') return true;
  if (it.connector !== 'slack' && it.connector !== 'gmail') return false;
  return it.fromMe === true || it.toMe === true;
}

export class Reconciler {
  constructor(private readonly d: ReconcilerDeps) {}

  private slot<T>(fn: () => Promise<T>): Promise<T> {
    return this.d.withLlmSlot ? this.d.withLlmSlot(fn) : fn();
  }

  async run(job: ReconcileJob, signal: AbortSignal): Promise<ReconcileReport> {
    const report: ReconcileReport = { findings: [], jobs: [], relinked: 0, escalated: 0, triaged: 0, costUsd: 0, errors: [], summary: '' };
    const specs = this.d.specs.filter((s) => (!job.connector || s.connector === job.connector) && (this.d.connectorActive?.(s.connector) ?? true));
    for (const pass of job.passes) {
      if (signal.aborted) break;
      try {
        if (pass === 'coverage_gaps') await this.coverageGaps(specs, report, signal);
        else if (pass === 'unlinked') await this.unlinked(specs, report, signal);
        else if (pass === 'stale_active') await this.staleActive(specs, report, signal);
        else if (pass === 'skill_upgrade') await this.skillUpgrades(job, report, signal);
      } catch (err) {
        report.errors.push(`${pass}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
      }
    }
    for (const f of report.findings) await this.d.onFinding?.(f);
    report.summary = `findings=${report.findings.length} jobs=${report.jobs.length} relinked=${report.relinked} escalated=${report.escalated} triaged=${report.triaged} cost=$${report.costUsd.toFixed(4)}${report.errors.length ? ` errors=${report.errors.length}` : ''}`;
    return report;
  }

  private async scopesOf(spec: ConnectorSpec): Promise<{ names: string[]; ctx: ScanContext }> {
    const ctx = await this.d.store.getContext({ connector: spec.connector, scope: isTraversal(spec) ? 'inbox' : '_' });
    const names = isTraversal(spec) ? spec.scopes(ctx) : await spec.fetcher.scopes({ userId: ctx.me.userId });
    return { names, ctx };
  }

  // ------------------------------------------------------------------ 1. coverage gaps

  private async coverageGaps(specs: ConnectorSpec[], report: ReconcileReport, signal: AbortSignal) {
    const now = this.d.clock.now();
    const week = { from: new Date(now.getTime() - 7 * DAY).toISOString(), to: now.toISOString() };
    for (const spec of specs) {
      const { names } = await this.scopesOf(spec);
      for (const name of names) {
        const key: ScopeKey = { connector: spec.connector, scope: name };
        const cursor = await this.d.store.getCursor(key);
        if (!cursor) continue;
        // Holes behind the cursor (should not exist under store rule S9; detect drift anyway). 30 days back, not 7:
        // a cold start's cursor is at now after its head run, so a backfill window dropped behind it (a stalled
        // continuation) can be older than a week (stress finding THR-1 follow-up).
        const behind = await this.d.store.coverageGaps(key, { from: new Date(now.getTime() - 30 * DAY).toISOString(), to: cursor.at });
        for (const g of behind) {
          report.findings.push({ kind: 'coverage_gap', connector: spec.connector, scope: name, gap: g, detail: 'uncovered window behind the cursor' });
          report.jobs.push(scanJob({ connector: spec.connector, scope: name, window: g, mode: 'backfill', trigger: 'reconcile', runAt: now.toISOString(), model: spec.model }));
        }
        if (!isTraversal(spec) && spec.fetcher.listForReconcile) {
          // Only objects the scope has already scanned past can be "missed": not those before its first scan (the
          // initial lookback never reached them) nor after its cursor (the next poll covers them). Stress finding R-2.
          const span = await (this.d.store as ScannerStore & CoverageSpanStore).coverageSpan?.(key);
          const lw = {
            from: new Date(Math.max(Date.parse(week.from), span ? Date.parse(span.from) : Date.parse(week.from))).toISOString(),
            to: new Date(Math.min(Date.parse(week.to), Date.parse(cursor.at))).toISOString(),
          };
          if (Date.parse(lw.to) - Date.parse(lw.from) < 60_000) continue;
          const listed = (await spec.fetcher.listForReconcile(name, lw, { signal })).filter((o) => {
            const at = Date.parse(o.from ?? o.to ?? '');
            return Number.isNaN(at) || (at >= Date.parse(lw.from) - 60_000 && at <= Date.parse(lw.to));
          });
          const missing = await this.d.store.uncoveredObjects(key, listed);
          if (!missing.length) continue;
          // ONE targeted re-scan per scope (fetchers scan windows, not objects), spanning the missed objects; objects
          // without a time widen it to the listing window. Before: one week-long job per object (stress finding R-3).
          const times = missing.flatMap((o) => [o.from, o.to].filter((x): x is string => !!x && !Number.isNaN(Date.parse(x))).map((x) => Date.parse(x)));
          const untimed = missing.some((o) => !o.from && !o.to);
          const w = untimed || !times.length ? lw : { from: new Date(Math.max(Date.parse(lw.from), Math.min(...times) - 60_000)).toISOString(), to: new Date(Math.min(Date.parse(lw.to), Math.max(...times) + 60_000)).toISOString() };
          for (const obj of missing.slice(0, 50)) report.findings.push({ kind: 'coverage_gap', connector: spec.connector, scope: name, gap: objectWindow(obj, w), detail: `uncovered ${obj.kind} ${obj.ref}` });
          report.jobs.push(scanJob({ connector: spec.connector, scope: name, window: w, mode: 'targeted', trigger: 'reconcile', runAt: now.toISOString(), model: spec.model, vars: { 'object.ref': missing.slice(0, 20).map((o) => o.ref).join(',') } }));
        }
      }
    }
  }

  // ------------------------------------------------------------------ 2. unlinked

  private async unlinked(specs: ConnectorSpec[], report: ReconcileReport, signal: AbortSignal) {
    for (const spec of specs) {
      // a page per reconcile pass (oldest flag first); the next pass takes the next page, so nothing waits forever
      const items = (await this.d.store.unlinkedSourceItems({ connector: spec.connector, limit: 60 })) as UnlinkedSourceItemDetail[];
      if (!items.length) continue;
      if (this.d.llmAllowed && !(await this.d.llmAllowed(spec.connector))) {
        report.findings.push({ kind: 'unlinked_item', connector: spec.connector, detail: `deferred: daily LLM hard cap; ${items.length} item(s) wait for the next budget day` });
        continue;
      }
      // A relink already judged these not actionable for me (R9 step 3): stop retrying, record only.
      const settled = items.filter((i) => isNotActionable(i.reason));
      for (const it of settled) {
        await this.d.store.ignoreUnlinked?.(it.sourceItemId, 'not actionable for me (relink)');
        report.findings.push({ kind: 'unlinked_item', connector: spec.connector, sourceItemId: it.sourceItemId, detail: 'recorded only: not actionable for me' });
      }
      const open = items.filter((i) => !settled.includes(i));
      const retry = open.filter((i) => i.attempts <= 1);
      const escalate = open.filter((i) => i.attempts === 2);
      const triage = open.filter((i) => i.attempts >= 3);
      const batch = this.d.relinkBatch ?? 12;
      // F-4: a relink that asked about spend holds the connector's relinks until the answer (no second ask)
      const waiting = this.d.spend && retry.length + escalate.length ? await this.d.spend.store.listHolds({ states: ['asked'], jobKeyPrefix: `relink:${spec.connector}:`, limit: 1 }).catch(() => [] as Hold[]) : [];
      if (waiting.length) report.findings.push({ kind: 'unlinked_item', connector: spec.connector, detail: `deferred: a relink asked to allow more spend (Health ▸ Spend); ${retry.length + escalate.length} item(s) wait for the answer` });
      const paused = () => waiting.length > 0 || this.relinkPaused.has(spec.connector);
      for (let i = 0; i < retry.length && !signal.aborted && !paused(); i += batch) report.relinked += await this.relink(spec, retry.slice(i, i + batch), SCANNER_MODEL, 'relink', report, signal);
      for (let i = 0; i < escalate.length && !signal.aborted && !paused(); i += batch) report.escalated += await this.relink(spec, escalate.slice(i, i + batch), ESCALATION_MODEL, 'relink_escalated', report, signal);
      this.relinkPaused.delete(spec.connector);
      if (triage.length) report.triaged += await this.triage(spec, triage, report);
    }
  }

  /** Connectors whose relink asked about spend in this pass (their remaining batches wait for the answer). */
  private readonly relinkPaused = new Set<ConnectorId>();

  /**
   * F-4: the relink run's hold: an allowed one the connector's last ask left (resumed), else a new one on the estimate
   * (whose default is the old cap). Null without a governor, or when today's hard cap has no room (BUD-1: skipped).
   */
  private async relinkGate(connector: ConnectorId, escalated: boolean, capUsd: number): Promise<SpendGate | null | 'day_budget'> {
    const gov = this.d.spend;
    if (!gov) return null;
    try {
      const [allowed] = await gov.store.listHolds({ states: ['approved'], jobKeyPrefix: `relink:${connector}:`, limit: 1 });
      if (allowed) return holdGate(gov, allowed, { minCeilingUsd: capUsd });
      const job = { scope: 'scan_run' as const, jobKey: relinkKey(connector), skill: escalated ? 'relink-escalated' : 'relink' };
      const r = await gov.hold(job, await gov.estimate(job));
      return r.ok ? holdGate(gov, r.hold, { minCeilingUsd: capUsd }) : 'day_budget';
    } catch {
      return null;
    }
  }

  /** One relink run. Returns how many items got linked. Items still unlinked afterwards count one attempt. */
  private async relink(spec: ConnectorSpec, items: UnlinkedSourceItemDetail[], model: string, mode: 'relink' | 'relink_escalated', report: ReconcileReport, signal: AbortSignal): Promise<number> {
    const now = this.d.clock.now().toISOString();
    const key: ScopeKey = { connector: spec.connector, scope: 'reconcile:unlinked' };
    const ctx = await this.d.store.getContext(key);
    const escalated = model === ESCALATION_MODEL;
    const capUsd = escalated ? 0.25 : 0.05;
    const gate = await this.relinkGate(spec.connector, escalated, capUsd);
    if (gate === 'day_budget') {
      // BUD-1: as with the hard cap, the items wait for the next budget day (no run, no attempt counted)
      report.findings.push({ kind: 'unlinked_item', connector: spec.connector, detail: `deferred: daily LLM hard cap; ${items.length} item(s) wait for the next budget day` });
      this.relinkPaused.add(spec.connector);
      return 0;
    }
    const { runId } = await this.d.store.startRun({ scope: key, trigger: 'reconcile', window: { from: now, to: now }, model, skillVersion: undefined });
    const input: ScanSkillRunInput = {
      skillPath: spec.skillPath,
      model,
      mcpServers: {},
      allowedTools: [],
      runId,
      context: ctx,
      maxTurns: spec.maxTurns('reconcile:unlinked', 'relink') + (escalated ? 4 : 0),
      costCapUsd: capUsd,
      ...(gate ? { spend: gate } : {}),
      signal,
      window: { from: now, to: now },
      mode,
      vars: { 'relink.count': items.length },
      instruction: [
        `Relink mode (${escalated ? 'escalated: this is the last automatic attempt' : 'retry'}). Do not call any source tool. For each item below:`,
        '1. cc_find_candidates with its people, accounts, refs and key words (the open items in the context pack are fresh).',
        '2. If a candidate fits per the linking rules, cc_link_evidence with the right role and confidence.',
        '3. If no candidate is the same deliverable and it is an ask of me or a commitment of mine that still needs doing, cc_propose_item (one origin row with this sourceItemId, a purpose): a new item is its home.',
        `4. If it is not actionable for me (FYI, cc, status, someone else's ask, a question I already answered, an invite with nothing to prepare), cc_flag_unlinked with a reason starting "${NOT_ACTIONABLE}".`,
        '5. Otherwise (still unsure which item it belongs to) cc_flag_unlinked again with the SAME self-contained reason and better hints.',
        `Then cc_finish with cursor {"value":"relink","at":"${now}"}.`,
        '',
        '## Unlinked items',
        JSON.stringify(items.map((i) => ({ sourceItemId: i.sourceItemId, attempts: i.attempts, reason: i.reason, hints: i.hints, title: i.title, excerpt: i.excerpt?.slice(0, 400), threadRef: i.threadRef, occurredAt: i.occurredAt }))),
      ].join('\n'),
    };
    let result: ScanSkillRunResult;
    try {
      result = (await this.slot(() => this.d.runner.run(input, this.d.store))) as ScanSkillRunResult;
    } catch (err) {
      result = { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: err instanceof Error ? err.message : String(err), errorClass: 'unknown' } };
    }
    report.costUsd += result.costUsd;
    // D0: booked with its tokens, why it ran (reconcile) and why its model (the escalated pass is the second try).
    if (result.costUsd > 0) await this.d.store.recordSpend(runSpend(result, { connector: spec.connector, model, runId, trigger: 'reconcile', modelReason: escalated ? 'escalation:still_unlinked' : 'default', hashOf: [spec.skillPath, mode, ...items.map((i) => i.sourceItemId)] }));
    if (gate) {
      // asked: the hold waits for the answer (the connector's relinks with it); otherwise it settles with what it cost
      if (gate.hold.state === 'asked') this.relinkPaused.add(spec.connector);
      else await this.d.spend!.settle(gate.hold, gate.hold.spentUsd).catch(() => undefined);
    }
    if (!result.ok && gate && gate.hold.state === 'asked' && new RegExp(`^${PAUSED_FOR_SPEND.replace(/_/g, ' ')}`).test(result.error?.message ?? '')) {
      await this.d.store.failRun(runId, { error: `cancelled: ${result.error?.message ?? 'paused for spend'}; waiting for your answer`, errorClass: 'config' });
      report.findings.push({ kind: 'unlinked_item', connector: spec.connector, runId, detail: `paused: a relink passed its spend estimate and asked to allow more (Health ▸ Spend); ${items.length} item(s) wait` });
      return 0;
    }
    if (!result.ok) {
      // A failed run (budget, transient, auth) is not a linking failure: attempts stay as they are.
      await this.d.store.failRun(runId, { error: result.error?.message ?? 'relink failed', errorClass: result.error?.errorClass });
      report.errors.push(`relink ${spec.connector}: ${result.error?.message ?? 'failed'}`.slice(0, 200));
      return 0;
    }
    const ids = new Set(items.map((i) => i.sourceItemId));
    // every unlinked row (caps audit 2026-11-21: the newest-flagged 500 could miss this batch's re-flagged items)
    const still = ((await this.d.store.unlinkedSourceItems({ connector: spec.connector, limit: Number.POSITIVE_INFINITY })) as UnlinkedSourceItemDetail[]).filter((u) => ids.has(u.sourceItemId));
    for (const u of still) await this.d.store.flagUnlinked(runId, { sourceItemId: u.sourceItemId, reason: u.reason, hints: u.hints });
    const { touchedWorkItemIds } = await this.d.store.finishRun(runId, {
      cursor: { value: 'relink', at: now },
      summary: result.summary,
      stats: { fetched: 0, new: 0, changed: 0, linked: result.counts?.linked ?? 0, proposed: result.counts?.proposed ?? 0, unlinked: still.length, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens, turns: result.turns },
    });
    if (touchedWorkItemIds.length) await this.d.reevaluate?.(touchedWorkItemIds, { runId, connector: spec.connector });
    for (const u of still) report.findings.push({ kind: 'unlinked_item', connector: spec.connector, sourceItemId: u.sourceItemId, runId, detail: `${mode}: still unlinked (attempt ${u.attempts + 1})` });
    return items.length - still.length;
  }

  /**
   * Third failure → a Triage mapping question (deterministic, no LLM), MAP-1: only for an ask of me or a commitment of
   * mine (a Slack message or an email to me or from me), per Settings ▸ Scanning ("Where does this belong?": mine | all |
   * never). Everything else stops being retried: it is recorded, and the question would be noise (before, 34 questions
   * from one first scan held about 4 real items).
   */
  private async triage(spec: ConnectorSpec, items: UnlinkedSourceItemDetail[], report: ReconcileReport): Promise<number> {
    const now = this.d.clock.now().toISOString();
    const key: ScopeKey = { connector: spec.connector, scope: 'reconcile:triage' };
    const prefs = (await this.d.store.getContext(key, { maxOpenItems: 0 }).catch(() => undefined))?.scanning ?? DEFAULT_SCANNING_PREFS;
    const asked = items.filter((it) => mappingQuestionFor(it, prefs.mappingQuestions));
    for (const it of items.filter((x) => !asked.includes(x))) {
      await this.d.store.ignoreUnlinked?.(it.sourceItemId, `no mapping question (${prefs.mappingQuestions === 'never' ? 'off in Settings' : 'not an ask or commitment of mine'})`);
      report.findings.push({ kind: 'unlinked_item', connector: spec.connector, sourceItemId: it.sourceItemId, detail: 'no mapping question: not an ask or commitment of mine' });
    }
    if (!asked.length) return 0;
    const { runId } = await this.d.store.startRun({ scope: key, trigger: 'reconcile', window: { from: now, to: now } });
    let n = 0;
    for (const it of asked) {
      const gist = (it.title || it.reason || it.excerpt || 'source item').replace(/\s+/g, ' ').slice(0, 100);
      const r = await this.d.store.proposeItem(runId, {
        kind: 'task',
        title: `Where does this belong? ${gist}`,
        purpose: 'Mapping question from reconcile: Haiku retry and one Sonnet escalation found no confident home. Pick the work item, initiative or account (or dismiss).',
        evidence: [{ sourceItemId: it.sourceItemId, role: 'context', reason: `unlinked after ${it.attempts} attempts: ${it.reason}`.slice(0, 380) }],
        confidence: 'guess',
      });
      report.findings.push({ kind: 'unlinked_item', connector: spec.connector, sourceItemId: it.sourceItemId, workItemId: r.workItemId, runId, detail: `triage question (${r.landedAs})` });
      n += 1;
    }
    const { touchedWorkItemIds } = await this.d.store.finishRun(runId, { cursor: { value: 'triage', at: now }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: n, unlinked: 0, costUsd: 0 } });
    if (touchedWorkItemIds.length) await this.d.reevaluate?.(touchedWorkItemIds, { runId, connector: spec.connector });
    return n;
  }

  // ------------------------------------------------------------------ 3. stale but active

  private async staleActive(specs: ConnectorSpec[], report: ReconcileReport, signal: AbortSignal) {
    const now = this.d.clock.now();
    const t = now.getTime();
    const week = { from: new Date(t - 7 * DAY).toISOString(), to: now.toISOString() };
    const max = this.d.maxStaleRescans ?? 10;
    for (const spec of specs) {
      if (this.d.firstScanActive?.(spec.connector)) continue;
      const { names, ctx } = await this.scopesOf(spec);
      const open = ctx.openItems.filter((o) => o.state !== 'done' && o.state !== 'dismissed');
      if (isTraversal(spec)) {
        if (spec.connector !== 'slack') continue;
        let n = 0;
        for (const o of open) {
          const last = o.lastEvidenceAt ? Date.parse(o.lastEvidenceAt) : undefined;
          if (last != null && (t - last < 6 * H || t - last > 30 * DAY)) continue;
          for (const ref of o.threadRefs) {
            const m = /^slack:([A-Z0-9]+):(\d+\.\d+)$/.exec(ref);
            if (!m || n >= max) continue;
            n += 1;
            const from = new Date(last ?? t - 7 * DAY).toISOString();
            report.findings.push({ kind: 'missed_item', connector: 'slack', scope: `thread:${m[1]}:${m[2]}`, workItemId: o.workItemId, detail: 'stale_active: open item, thread may have moved' });
            report.jobs.push(scanJob({ connector: 'slack', scope: `thread:${m[1]}:${m[2]}`, window: { from, to: now.toISOString() }, mode: 'targeted', trigger: 'reconcile', runAt: now.toISOString(), model: spec.model, vars: { 'thread.channelId': m[1]!, 'thread.ts': m[2]! } }));
          }
        }
        continue;
      }
      if (!spec.fetcher.listForReconcile) continue;
      for (const name of names) {
        if (signal.aborted) return;
        const listed = await spec.fetcher.listForReconcile(name, week, { signal });
        const byRef = new Map<string, CoverageObject>();
        for (const l of listed) byRef.set(l.ref, l);
        for (const o of open) {
          for (const ref of [...o.fileRefs, ...o.threadRefs]) {
            const obj = byRef.get(ref);
            if (!obj?.to) continue;
            if (o.lastEvidenceAt && Date.parse(obj.to) <= Date.parse(o.lastEvidenceAt)) continue;
            const from = o.lastEvidenceAt ?? week.from;
            report.findings.push({ kind: 'missed_item', connector: spec.connector, scope: name, workItemId: o.workItemId, detail: `stale_active: ${obj.kind} ${ref} changed after the last evidence` });
            report.jobs.push(scanJob({ connector: spec.connector, scope: name, window: { from, to: now.toISOString() }, mode: 'targeted', trigger: 'reconcile', runAt: now.toISOString(), model: spec.model, vars: { 'object.ref': ref } }));
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ 4. skill upgrades (dry run)

  private async skillUpgrades(job: ReconcileJob, report: ReconcileReport, signal: AbortSignal) {
    const now = this.d.clock.now();
    const window = { from: new Date(now.getTime() - (this.d.relinkMs ?? 3 * DAY)).toISOString(), to: now.toISOString() };
    for (const up of job.upgrades ?? []) {
      if (signal.aborted) return;
      const spec = this.d.specs.find((s) => s.connector === up.connector);
      if (!spec || !(this.d.connectorActive?.(up.connector) ?? true)) continue;
      if (this.d.llmAllowed && !(await this.d.llmAllowed(up.connector))) {
        report.errors.push(`skill_upgrade ${up.connector}: deferred (daily LLM hard cap)`);
        continue;
      }
      // One dry run per connector, on its primary scope only (cost bound).
      if (isTraversal(spec) && up.scope !== spec.scopes(await this.d.store.getContext({ connector: spec.connector, scope: 'inbox' }, { maxOpenItems: 0 }))[0]) continue;
      const dry = new DryRunStore(this.d.store);
      const key: ScopeKey = { connector: up.connector, scope: up.scope };
      const ctx = await this.d.store.getContext(key);
      const { runId } = await dry.startRun({ scope: key, trigger: 'reconcile', window });
      let input: ScanSkillRunInput;
      if (isTraversal(spec)) {
        input = {
          skillPath: spec.skillPath,
          model: spec.model,
          mcpServers: spec.mcpServers(),
          allowedTools: spec.allowedTools,
          runId,
          context: ctx,
          maxTurns: spec.maxTurns(up.scope, 'backfill'),
          costCapUsd: spec.costCapUsd(up.scope, 'backfill'),
          signal,
          window,
          mode: 'backfill',
          vars: spec.scopeVars(up.scope, ctx),
          instruction: `Skill upgrade dry run (${up.fromVersion} → ${up.toVersion}): re-read the window and link as usual. Nothing is committed.`,
        };
      } else {
        const fetch = await spec.fetcher.fetch(up.scope, null, window, { signal, limit: 50 });
        input = {
          skillPath: spec.skillPath,
          model: spec.model,
          mcpServers: {},
          allowedTools: [],
          runId,
          context: ctx,
          prefetched: fetch.items,
          preReportedCoverage: fetch.coverage,
          maxTurns: spec.maxTurns(up.scope, 'backfill'),
          costCapUsd: spec.costCapUsd(up.scope, 'backfill'),
          signal,
          window,
          mode: 'backfill',
          instruction: `Skill upgrade dry run (${up.fromVersion} → ${up.toVersion}). Link the prefetched items, then cc_finish with cursor {"value":"${fetch.nextCursor.value}","at":"${fetch.nextCursor.at}"}.`,
        };
      }
      let result: ScanSkillRunResult;
      try {
        result = (await this.slot(() => this.d.runner.run(input, dry))) as ScanSkillRunResult;
      } catch (err) {
        report.errors.push(`skill_upgrade ${up.connector}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
        continue;
      }
      report.costUsd += result.costUsd;
      if (result.costUsd > 0) await this.d.store.recordSpend(runSpend(result, { connector: up.connector, model: spec.model, trigger: 'skill_upgrade', modelReason: 'default', hashOf: [spec.skillPath, up.scope, up.toVersion, window.from, window.to] }));
      const s = dry.summary();
      report.findings.push({
        kind: 'skill_upgrade',
        connector: up.connector,
        scope: up.scope,
        gap: window,
        actions: dry.actions,
        detail: `dry run ${up.fromVersion} → ${up.toVersion}: ${s.link} links, ${s.propose} proposals, ${s.unlinked} unlinked over ${s.record} items${result.ok ? '' : ` (run error: ${result.error?.message ?? 'failed'})`}. Apply from Health to re-link for real.`,
      });
    }
  }
}

function objectWindow(obj: CoverageObject, fallback: TimeWindow): TimeWindow {
  const at = obj.from ?? obj.to;
  if (!at || Number.isNaN(Date.parse(at))) return fallback;
  const t = Date.parse(at);
  const end = obj.to && !Number.isNaN(Date.parse(obj.to)) ? Math.max(Date.parse(obj.to), t) : t;
  return { from: new Date(t - 60_000).toISOString(), to: new Date(Math.min(end + 60_000, Date.parse(fallback.to))).toISOString() };
}
