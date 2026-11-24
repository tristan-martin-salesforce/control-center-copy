// ScannerRuntime job execution. Split from scanner-runtime.ts (max-lines); the class is still exported from scanner-runtime.ts.
import { classifyError, type ErrorClass } from '../../llm/errors';
import type { ScanSkillRunInput } from '../../llm/skill-runner';
import { loadSkill } from '../../llm/skill-loader';
import { type Cursor, type ScanContext, scopeId } from '../types';
import { isKnownScope, validScopes } from '../scope-catalog';
import { localParts } from './cadence';
import type { ScanSkillRunResult } from './contract-ext';
import {
  isTraversal, org62AccountIds, type ConnectorSpec, type DeterministicConnectorSpec, type PrecheckResult,
  type TraversalConnectorSpec,
} from './connectors';
import { scanJob, type JobOutcome, type RuntimeJob, type ScanJob } from './jobs';
import { annotateTraceContext, flushTrace, trace, withTraceContext } from '../trace';
import { ledgerHash } from '../../db/ledger';
import { runSpend } from './spend';
import { holdGate, PAUSED_FOR_SPEND, type Hold, type SpendGate } from '../../llm/spend';
import {
  AUTH_PROBE_MS, HOLD_RETRY_MS, usesTraversalLlm, skillKeyOf, MIN, SPEND_ASK_RECHECK_MS, HOLD_MAX_MS,
  HOLD_ACCOUNTS_MS, type ScopeState, type ReevaluateReason, HEADER_CURSOR_MAX,
} from './scanner-runtime.shared';
import { ScannerRuntimeOutcome } from './scanner-runtime.outcome';
import { DISK_FULL_MESSAGE, isDiskFull, stateWriteFailed } from './state-write';
import { toInterpret } from './reread';

/** ScannerRuntime's job execution: gates, spend holds, scan jobs, precheck, deterministic runs. */
export abstract class ScannerRuntimeJobs extends ScannerRuntimeOutcome {

  // ===================================================================== execution

  /** `meta.dbJobId`: the queue row running this job; it lands on the run (`scan_runs.job_id`), so a UI placeholder run is adopted. */
  async executeJob(job: RuntimeJob, signal: AbortSignal = new AbortController().signal, meta: { dbJobId?: number | string } = {}): Promise<JobOutcome> {
    if (job.kind === 'reconcile') return this.executeReconcile(job, signal);
    const spec = this.specs.get(job.connector);
    // HYG-1: a scope neither the connector's scope list nor the catalog knows (a Health scope sent prefixed,
    // `org62:org62:events`) never runs, never says succeeded, and is never registered as a polled scope. Before, it ran
    // the skill with no query, "succeeded" having read nothing, and then re-ran on its own as a catch-up.
    if (!this.scopes.has(scopeId({ connector: job.connector, scope: job.scope })) && !isKnownScope(job.connector, job.scope)) {
      this.log({ event: 'skip', connector: job.connector, scope: job.scope, code: 'unknown_scope' });
      return { status: 'failed', errorClass: 'config', followUps: [], detail: `unknown scope ${scopeId({ connector: job.connector, scope: job.scope })} (valid: ${validScopes(job.connector).join(', ')})` };
    }
    const st = this.scopeState({ connector: job.connector, scope: job.scope });
    st.pending.delete(job.id);
    if (!spec) return { status: 'skipped', followUps: [], detail: `no spec for ${job.connector}` };
    // A paused window that is not a plain poll (backfill, continuation, split, targeted) is retried later instead of
    // dropped: on a cold start it lies behind the cursor, so no later poll would re-plan it (stress finding B-2).
    const keep = job.mode !== 'incremental';
    // D-55: a job queued before the persona dropped this scope or source (a manual Rescan still runs).
    if ((st.paused === 'persona' || !this.connectorActive(job.connector)) && job.trigger !== 'manual' && job.trigger !== 'chat') {
      return { status: 'skipped', followUps: [], detail: 'not scanned for this persona' };
    }
    if (st.paused === 'stopped' && job.trigger !== 'manual' && job.trigger !== 'chat') {
      return { status: 'skipped', followUps: [], detail: 'scope stopped after a failure that retrying cannot fix (Rescan resumes it)' };
    }
    if (st.paused === 'auth' && job.trigger !== 'manual' && job.trigger !== 'chat') {
      return { status: 'paused', followUps: [], errorClass: 'auth', detail: 'connector needs re-auth', retryAt: keep ? new Date(this.clock.now().getTime() + AUTH_PROBE_MS).toISOString() : undefined };
    }
    if (st.paused === 'prompt_cap' && job.trigger !== 'manual' && job.trigger !== 'chat') {
      return { status: 'paused', followUps: [], errorClass: 'config', detail: 'paused: one message set is too large to read' };
    }
    const hold = await this.firstScanHold(job, this.clock.now());
    if (hold) {
      this.log({ event: 'skip', connector: spec.connector, scope: job.scope, code: 'first_scan_hold', detail: hold });
      return { status: 'skipped', followUps: [], held: true, detail: hold, retryAt: new Date(this.clock.now().getTime() + HOLD_RETRY_MS).toISOString() };
    }
    const budget = await this.store.recordSpend({ connector: spec.connector, model: 'none', costUsd: 0 });
    // B-080: a first-scan job spends the one-time budget while it lasts; regular jobs ignore first-scan spend.
    const firstScanBudget = job.budget === 'first_scan' && !!this.firstScan?.hasBudget();
    let overBudget = !firstScanBudget && budget.todayUsd >= budget.hardCapUsd && !(await this.scansAllowedToday());
    const subject = scopeId({ connector: spec.connector, scope: job.scope });
    if (overBudget && usesTraversalLlm(spec)) {
      this.log({ event: 'paused', connector: spec.connector, scope: job.scope, code: 'budget_hard_cap' });
      await this.store.recordDecision?.({ skill: skillKeyOf(spec), kind: 'block', reason: 'hard_cap', trigger: job.trigger, subject, detail: { spentUsd: budget.todayUsd, capUsd: budget.hardCapUsd, mode: job.mode } });
      return { status: 'paused', followUps: [], detail: 'budget_hard_cap', retryAt: keep ? new Date(this.nextBudgetDay(this.clock.now())).toISOString() : undefined };
    }
    if (!firstScanBudget && budget.todayUsd >= budget.softCapUsd) this.log({ event: 'budget', connector: spec.connector, code: 'soft_cap', costUsd: budget.todayUsd });

    // H-5: the spend governor holds the run's estimate (not its cap) and asks past it.
    let gate: SpendGate | null = null;
    if (this.deps.spend && !overBudget) {
      // The governor never breaks a scan: if it can't answer (its table, a bad row), the run goes on without a hold.
      const g = await this.spendHold(job, spec, firstScanBudget, keep, subject).catch((err: unknown) => {
        this.log({ event: 'skip', connector: spec.connector, scope: job.scope, code: 'spend_hold_error', detail: String(err instanceof Error ? err.message : err).slice(0, 160) });
        return { gate: null, overBudget: false };
      });
      if ('outcome' in g) return g.outcome;
      if (g.overBudget) overBudget = true;
      gate = g.gate;
    }
    const release = await this.connectorLock.acquire(spec.connector, signal);
    // D6: the run's own cost cap is held against today's hard cap while it runs, so parallel scans (and settle, read-ins)
    // can't all pass a check with the last dollar. A refused hold pauses a traversal; a deterministic run records only.
    let reservation: { ok: boolean; release(): Promise<void> } | null = null;
    if (!this.deps.spend && !overBudget && !firstScanBudget && this.store.reserveSpend) {
      const cap = spec.costCapUsd(job.scope, job.mode);
      reservation = await this.store.reserveSpend(cap, { budget: 'daily' }).catch(() => null);
      if (reservation && !reservation.ok) {
        await this.store.recordDecision?.({ skill: skillKeyOf(spec), kind: 'block', reason: 'hard_cap_reserve', trigger: job.trigger, subject, detail: { wantUsd: cap, capUsd: budget.hardCapUsd, mode: job.mode } });
        reservation = null;
        if (usesTraversalLlm(spec)) {
          release();
          this.log({ event: 'paused', connector: spec.connector, scope: job.scope, code: 'budget_hard_cap' });
          return { status: 'paused', followUps: [], detail: 'budget_hard_cap', retryAt: keep ? new Date(this.clock.now().getTime() + 10 * MIN).toISOString() : undefined };
        }
        overBudget = true;
      }
    }
    if (gate) this.gates.set(job.id, gate);
    let out: JobOutcome | undefined;
    try {
      // AUDIT: everything this scan does (log lines, spend) carries its connector, scope and budget; the run id once it exists.
      out = await withTraceContext({ connector: spec.connector, scope: job.scope, budget: firstScanBudget ? 'first_scan' : 'daily' }, () => this.runScanJob(job, spec, st, signal, overBudget, meta.dbJobId, firstScanBudget));
      await this.settleFirstScan(st, job, out.followUps, this.clock.now(), !out.retryAt);
      return out;
    } catch (err) {
      // ask #14: an error that escapes the run after it started (the database went away while booking its spend, a
      // full disk) closes the run as failed; before, it stayed `running` until the worker restarted. Idempotent.
      const runId = this.liveRuns.get(job.id);
      if (runId) {
        const c = classifyError(err);
        await this.store.failRun(runId, { error: `run stopped on an error (${c.code})`, errorClass: c.errorClass }).catch(() => undefined);
      }
      throw err;
    } finally {
      this.liveRuns.delete(job.id);
      this.gates.delete(job.id);
      // An asked hold waits for its answer (the deferred job carries it); every other one settles with what the run cost.
      if (gate && gate.hold.state !== 'asked') await this.deps.spend!.settle(gate.hold, out?.costUsd ?? gate.hold.spentUsd).catch(() => undefined);
      await reservation?.release();
      release();
    }
  }

  /** Spend gates of the jobs running now (the runner reports each request's spend to it). */
  protected readonly gates = new Map<string, SpendGate>();
  /** The run each running job started (job id → run id), so an error that escapes the job still closes its run. */
  protected readonly liveRuns = new Map<string, string>();
  /** Work items whose re-evaluation enqueue failed after their run committed, by scope; retried with the next success. */
  protected readonly reevalBacklog = new Map<string, string[]>();

  /**
   * H-5: the run's hold. A job re-queued from an ask resumes its hold (`vars.spendHoldId`): still unanswered → it waits
   * again; Stop → skipped; allowed → it runs with the larger hold. While a scope has an open ask, its new runs record
   * deterministically (no model), so one question stands per scope. A hold the day can't fit pauses like the hard cap.
   */
  protected async spendHold(job: ScanJob, spec: ConnectorSpec, firstScanBudget: boolean, keep: boolean, subject: string): Promise<{ outcome: JobOutcome } | { gate: SpendGate | null; overBudget: boolean }> {
    const gov = this.deps.spend!;
    const now = this.clock.now();
    const resumeId = job.vars?.['spendHoldId'];
    if (resumeId) {
      const h = await gov.store.getHold(resumeId).catch(() => null);
      if (h?.state === 'asked') return { outcome: this.spendWait(job, h, now, 'skipped') };
      if (h?.state === 'denied') return { outcome: { status: 'skipped', followUps: [], detail: 'stopped from a spend ask' } };
      if (h && (h.state === 'approved' || h.state === 'open')) return { gate: holdGate(gov, h, { minCeilingUsd: spec.costCapUsd(job.scope, job.mode) }), overBudget: false };
    }
    const prefix = `scan:${job.connector}:${job.scope}:`;
    const open = await gov.store.listHolds({ states: ['asked'], jobKeyPrefix: prefix, limit: 1 }).catch(() => [] as Hold[]);
    if (open.length) {
      this.log({ event: 'skip', connector: spec.connector, scope: job.scope, code: 'spend_ask_open', detail: open[0]!.id });
      // a traversal is all model: it waits with the ask; a deterministic fetch still records, linking deferred
      if (usesTraversalLlm(spec)) return { outcome: { status: 'paused', followUps: [], detail: 'spend_ask_open', retryAt: keep ? new Date(now.getTime() + 30 * MIN).toISOString() : undefined } };
      return { gate: null, overBudget: true };
    }
    const spendJob = { scope: 'scan_run' as const, jobKey: job.id, skill: skillKeyOf(spec), model: job.model ?? spec.model, budget: firstScanBudget ? ('first_scan' as const) : ('daily' as const) };
    const est = await gov.estimate(spendJob);
    let r = await gov.hold(spendJob, est);
    // W12-1: Allow for today on the scans' day-cap ask lets runs hold past the cap until midnight
    if (!r.ok && spendJob.budget === 'daily' && (await this.scansAllowedToday())) r = await gov.hold(spendJob, est, { skipDayCheck: true });
    if (!r.ok) {
      await this.store.recordDecision?.({ skill: skillKeyOf(spec), kind: 'block', reason: 'hard_cap_reserve', trigger: job.trigger, subject, detail: { wantUsd: r.wantUsd, capUsd: r.day.hardUsd, heldUsd: r.day.heldUsd, mode: job.mode } });
      if (usesTraversalLlm(spec)) {
        this.log({ event: 'paused', connector: spec.connector, scope: job.scope, code: 'budget_hard_cap' });
        return { outcome: { status: 'paused', followUps: [], detail: 'budget_hard_cap', retryAt: keep ? new Date(now.getTime() + 10 * MIN).toISOString() : undefined } };
      }
      return { gate: null, overBudget: true };
    }
    return { gate: holdGate(gov, r.hold, { minCeilingUsd: spec.costCapUsd(job.scope, job.mode) }), overBudget: false };
  }

  /**
   * A job waiting on a spend ask: the same window comes back as a held retry (not an attempt), its hold id riding in its
   * vars (`job.vars` is set on the job itself, which the queue re-enqueues), looked at again later; the answer runs it
   * at once (Allow) or cancels it (Stop). A manual runScope does not follow retries, so it never spins on an ask.
   */
  protected spendWait(job: ScanJob, hold: Hold, now: Date, status: 'paused' | 'skipped', runId?: string, costUsd?: number): JobOutcome {
    job.vars = { ...(job.vars ?? {}), spendHoldId: hold.id };
    return { status, ...(runId ? { runId } : {}), held: true, retryAt: new Date(now.getTime() + SPEND_ASK_RECHECK_MS).toISOString(), followUps: [], detail: `${PAUSED_FOR_SPEND}: waiting for your answer`, ...(costUsd != null ? { costUsd } : {}) };
  }

  /**
   * ORG-7 (MIN-17): in the first scan, `org62:opps` waits for `org62:book`. Its Q2 reads "opps on my accounts" with the
   * account list of the moment, and the accounts come from the book read's projection. Stage 2 ran the newest week
   * before that and read 2 account ids of 37, yet the window counted as covered for every account (a silent gap
   * for each new user). Held until the book scope is done and its accounts are projected (5 more minutes at most for
   * a user with none), and never past 30 minutes from the first scan's start.
   */
  protected async firstScanHold(job: ScanJob, now: Date): Promise<string | null> {
    if (job.connector !== 'org62' || job.scope !== 'opps') return null;
    const fs = this.firstScan?.state();
    if (!fs || fs.status !== 'active' || fs.scopes['org62:opps'] === 'done') return null;
    if (now.getTime() - Date.parse(fs.startedAt) > HOLD_MAX_MS) return null;
    if (fs.scopes['org62:book'] !== 'done') return 'waiting for org62:book (the accounts Q2 reads)';
    if (org62AccountIds(await this.store.getContext({ connector: 'org62', scope: 'opps' }))) return null;
    this.bookDoneSeenAt ??= now.getTime();
    return now.getTime() - this.bookDoneSeenAt < HOLD_ACCOUNTS_MS ? 'waiting for the book read\'s accounts to be projected' : null;
  }
  protected bookDoneSeenAt?: number;

  protected async runScanJob(job: ScanJob, spec: ConnectorSpec, st: ScopeState, signal: AbortSignal, overBudget: boolean, dbJobId?: number | string, firstScanBudget = false): Promise<JobOutcome> {
    const now = this.clock.now();
    const scope = st.key;
    const ctx = await this.store.getContext(scope);
    let versionTag: string | undefined;
    try {
      versionTag = loadSkill(spec.skillPath, this.deps.repoRoot).versionTag;
    } catch {
      versionTag = undefined;
    }
    const { runId } = await this.store.startRun({ scope, trigger: job.trigger, window: job.window, model: job.model ?? spec.model, skillVersion: versionTag, ...(dbJobId != null ? { jobId: dbJobId } : {}) });
    this.liveRuns.set(job.id, runId);
    this.log({ event: 'run_start', connector: spec.connector, scope: scope.scope, runId, mode: job.mode });
    annotateTraceContext({ runId });
    const t0 = Date.now();
    trace(runId, 'plan', () => ({
      connector: spec.connector,
      scope: scope.scope,
      mode: job.mode,
      trigger: job.trigger,
      window: job.window,
      windowMin: Math.round((Date.parse(job.window.to) - Date.parse(job.window.from)) / 60_000),
      chunkMin: Math.round((spec.chunkMsFor?.(scope.scope) ?? spec.chunkMs) / 60_000),
      budget: firstScanBudget ? 'first_scan' : 'daily',
      jobBudget: job.budget ?? null,
      overBudget,
      model: job.model ?? spec.model,
      skillVersion: versionTag ?? null,
      kind: isTraversal(spec) ? 'traversal' : 'deterministic',
      maxTurns: spec.maxTurns(job.scope, job.mode),
      costCapUsd: spec.costCapUsd(job.scope, job.mode),
      attempt: job.attempt ?? 0,
      jobId: dbJobId != null ? Number(dbJobId) : null,
      cursorAt: ctx.cursor?.at ?? null,
      vars: job.vars ?? null,
    }));
    // FS-LATE: why this channel got the first scan's lookback (it joined after the first scan had finished).
    const joined = job.budget === 'first_scan' ? this.firstScan?.state()?.late?.[scopeId(scope)] : undefined;
    if (joined) trace(runId, 'first_scan_reopened', () => ({ scope: scopeId(scope), joinedAt: joined, floorAt: this.firstScan?.floorFor(scopeId(scope)) ?? null, lookbackDays: this.firstScan?.state()?.lookbackDays ?? null }));

    let result: ScanSkillRunResult;
    let cursor: Cursor | undefined;
    let complete = true;
    try {
      // D5: a scheduled poll of a quiet scope asks a cheap question first; positively nothing new = no traversal.
      const pre = isTraversal(spec) && spec.precheck && job.trigger === 'schedule' && job.mode === 'incremental' ? await this.precheck(job, spec, ctx, runId, signal, dbJobId) : null;
      if (pre?.empty) {
        await this.store.reportCoverage(runId, pre.coverage);
        result = { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, complete: true, proposedCursor: pre.cursor, summary: 'pre-check: nothing new in the window', counts: { recorded: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, coverage: pre.coverage.length } };
        cursor = pre.cursor;
        complete = true;
      } else if (isTraversal(spec)) {
        result = await this.withLlmSlot(async () => this.runner.run({ ...this.traversalInput(job, spec, ctx, runId, signal), ...(await this.triageAllowance(job, spec)) }, this.store) as Promise<ScanSkillRunResult>);
        cursor = result.proposedCursor;
        complete = result.complete ?? true;
      } else {
        const r = await this.runDeterministic(job, spec, ctx, runId, signal, overBudget);
        result = r.result;
        cursor = r.cursor;
        complete = r.complete;
      }
    } catch (err) {
      // ask #14 (W5): a full disk (state folder or the database's) is transient: it retries with backoff and never
      // stops the scope as an unknown error; the worker puts one Health row up.
      if (isDiskFull(err)) {
        stateWriteFailed(`${scopeId(scope)} scan`, err);
        this.log({ event: 'run_fail', connector: spec.connector, scope: scope.scope, runId, code: 'disk_full' });
        result = { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: DISK_FULL_MESSAGE, errorClass: 'transient' } };
      } else {
        const c = classifyError(err);
        result = { ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: String(err instanceof Error ? err.message : err).slice(0, 300), errorClass: c.errorClass } };
      }
    }

    // D0: the run's own tokens (per model) for what no pass row covers, and why it ran. A run that never built its
    // prompt (it failed first) is hashed by what it was asked to read.
    if (result.costUsd > 0)
      await this.store.recordSpend(
        runSpend(result, {
          connector: spec.connector,
          model: job.model ?? spec.model,
          runId,
          budget: firstScanBudget ? 'first_scan' : 'daily',
          ...(dbJobId != null && Number.isFinite(Number(dbJobId)) ? { jobId: Number(dbJobId) } : {}),
          trigger: job.trigger,
          modelReason: job.model && job.model !== spec.model ? 'override' : 'default',
          hashOf: [skillKeyOf(spec), scope.connector, scope.scope, job.mode, job.window.from, job.window.to],
        }),
      );
    // SHUT-1: the worker stopped the run (shutdown drain, a cancel, a lost lease): a cancellation, not a connector
    // failure. The job runtime requeues the job, so the window runs again. Before, a kickstart recorded every in-flight
    // run as a transient error and degraded its connector. A job timeout is still a failure.
    const abortReason = signal.aborted ? ((signal.reason as { reason?: string } | undefined)?.reason ?? 'shutdown') : undefined;
    if (abortReason && abortReason !== 'timeout') {
      await this.store.failRun(runId, { error: `cancelled: worker ${abortReason}`, errorClass: 'transient', stats: this.statsOf(result) });
      this.log({ event: 'skip', connector: spec.connector, scope: scope.scope, runId, code: 'cancelled', detail: abortReason });
      trace(runId, 'outcome', { status: 'cancelled', reason: abortReason, costUsd: result.costUsd, ms: Date.now() - t0 });
      void flushTrace();
      return { status: 'skipped', runId, followUps: [], detail: `cancelled: worker ${abortReason}`, costUsd: result.costUsd };
    }
    if (firstScanBudget && result.costUsd > 0) this.firstScan?.charge(result.costUsd, localParts(now, this.cadence.workHours.timeZone).date, now);
    const stats = this.statsOf(result);
    // FTI first-scan rewrite: "Slack: 1,240 messages read, 31 asks found, $0.42 so far", per source, on the run's outcome event.
    // TODO(spend-governor): hold the first scan's p90 estimate and raise a hand at its soft line (ask, never kill).
    const firstScanProgress = job.budget === 'first_scan' ? this.firstScan?.noteProgress(spec.connector, { read: stats.fetched, found: stats.proposed, linked: stats.linked, usd: result.costUsd }) : undefined;

    let committed: { touchedWorkItemIds: string[] } | undefined;
    if (result.ok && cursor) {
      try {
        committed = await this.store.finishRun(runId, { cursor, summary: result.summary, stats });
      } catch (err) {
        // CoverageError or a store failure: the run must not count as done.
        result = { ...result, ok: false, error: { message: err instanceof Error ? err.message : String(err), errorClass: 'config' } };
      }
    }
    if (committed && cursor) {
      const { touchedWorkItemIds } = committed;
      // A continuation that made no progress (cursor not past its own window start) must not spawn another one:
      // an agent that kept answering complete=false at the window start re-read one Slack thread 360 times in a
      // row (~$1.25, and it held the connector lock, starving every other Slack scan; stress finding THR-1). The
      // scope's next poll (or reconcile) re-plans the rest from the cursor.
      // A run that made no progress (cursor not past its window start) gets ONE delayed retry of the rest; a retry
      // that stalls again ends the chain. Behind a cold-start cursor a dropped tail is a hole only the reconcile's
      // coverage-gap pass finds (30-day lookback).
      const stalled = !complete && Date.parse(cursor.at) <= Date.parse(job.window.from) + 1000;
      const continues = !complete && !stalled && Date.parse(cursor.at) < Date.parse(job.window.to) - 1000;
      const retryStalled = stalled && job.mode !== 'retry' && Date.parse(cursor.at) < Date.parse(job.window.to) - 1000;
      if (stalled) this.log({ event: 'skip', connector: spec.connector, scope: scope.scope, runId, code: 'continuation_stalled', detail: `cursor ${cursor.at} did not pass ${job.window.from}${retryStalled ? '; one retry in 30 min' : '; chain ended'}` });
      this.markCatchUpDone(st, job.id);
      if (continues && st.catchUp) st.catchUp.jobs.set(`pending-continuation:${job.id}`, { from: cursor.at, to: job.window.to });
      await this.onSuccess(spec, st, now, stats);
      // ask #14: the run is committed; a failed enqueue is not a failed run. Its ids wait in this process's backlog and
      // go with the scope's next successful run (a worker that dies first: the store's handoff hands them back).
      const sid = scopeId(scope);
      const toReevaluate = [...new Set([...(this.reevalBacklog.get(sid) ?? []), ...touchedWorkItemIds])].sort();
      if (toReevaluate.length) {
        const reason: ReevaluateReason = { runId, connector: spec.connector, catchingUp: !!st.catchUp, trigger: job.trigger };
        try {
          await this.deps.reevaluate(toReevaluate, reason);
          this.reevalBacklog.delete(sid);
        } catch (err) {
          this.reevalBacklog.set(sid, toReevaluate);
          this.log({ event: 'skip', connector: spec.connector, scope: scope.scope, runId, code: 'reevaluate_failed', detail: classifyError(err).code });
        }
      }
      const followUps: RuntimeJob[] = [];
      if (continues) {
        followUps.push(
          scanJob({ connector: spec.connector, scope: scope.scope, window: { from: cursor.at, to: job.window.to }, mode: 'continuation', trigger: job.trigger, runAt: now.toISOString(), model: job.model, vars: job.vars, ...(job.budget ? { budget: job.budget } : {}) }),
        );
      } else if (retryStalled) {
        followUps.push(
          scanJob({ connector: spec.connector, scope: scope.scope, window: { from: cursor.at, to: job.window.to }, mode: 'retry', trigger: job.trigger, runAt: new Date(now.getTime() + 30 * MIN).toISOString(), model: job.model, vars: job.vars, ...(job.budget ? { budget: job.budget } : {}) }),
        );
      }
      if (st.catchUp) st.catchUp.jobs.delete(`pending-continuation:${job.id}`);
      this.trackFollowUps(st, followUps);
      this.log({ event: 'run_ok', connector: spec.connector, scope: scope.scope, runId, mode: job.mode, costUsd: result.costUsd, detail: `new=${stats.new} linked=${stats.linked} proposed=${stats.proposed}` });
      trace(runId, 'outcome', () => ({ status: 'succeeded', complete, cursorAt: cursor.at, stalled, continues, followUps: followUps.map((f) => (f.kind === 'scan' ? `${f.mode}:${f.window.from}→${f.window.to}` : f.id)), touched: touchedWorkItemIds.length, stats, ...(firstScanProgress ? { firstScan: firstScanProgress } : {}), ms: Date.now() - t0 }));
      void flushTrace();
      return { status: 'succeeded', runId, followUps, touchedWorkItemIds, costUsd: result.costUsd };
    }

    // H-5: the run stopped to ask about spend. Not a failure: no health change, no split; the same window waits as a
    // queued job carrying the hold, which the answer runs at once (Allow) or cancels (Stop).
    const gate = this.gates.get(job.id);
    if (!result.ok && gate && gate.hold.state === 'asked' && new RegExp(`^${PAUSED_FOR_SPEND.replace(/_/g, ' ')}`).test(result.error?.message ?? '')) {
      await this.store.failRun(runId, { error: `cancelled: ${result.error?.message ?? 'paused for spend'}; waiting for your answer`, errorClass: 'config', stats });
      this.log({ event: 'paused', connector: spec.connector, scope: scope.scope, runId, code: PAUSED_FOR_SPEND, costUsd: result.costUsd });
      trace(runId, 'outcome', { status: 'paused', reason: PAUSED_FOR_SPEND, holdId: gate.hold.id, spentUsd: gate.hold.spentUsd, heldUsd: gate.hold.heldUsd, costUsd: result.costUsd, ms: Date.now() - t0 });
      void flushTrace();
      return this.spendWait(job, gate.hold, now, 'paused', runId, result.costUsd);
    }

    const message = result.error?.message ?? (cursor ? 'run failed' : 'run ended without a cursor (cc_finish)');
    const errorClass: ErrorClass = result.error?.errorClass ?? 'unknown';
    await this.store.failRun(runId, { error: message, errorClass, stats });
    const out = await this.onFailure(job, spec, st, runId, now, message, errorClass, result);
    // AUDIT: what the runtime decided after the failure (split, fewer items, retry later, or give up), then the outcome.
    const action = () => out.followUps.length ? (/window split/.test(out.detail ?? '') ? 'split' : /retrying with/.test(out.detail ?? '') ? 'fewer_items' : 'follow_up') : out.retryAt ? 'retry' : errorClass === 'auth' ? 'auth_pause' : result.error?.disallowedTool ? 'config_pause' : 'next_poll';
    trace(runId, 'retry', () => ({ action: action(), retryAt: out.retryAt ?? null, followUps: out.followUps.map((f) => (f.kind === 'scan' ? `${f.mode}:${f.window.from}→${f.window.to}${f.vars?.maxItems ? ` items=${f.vars.maxItems}` : ''}` : f.id)), failures: st.failures, nextDueAt: new Date(st.nextDueAt).toISOString() }));
    trace(runId, 'outcome', { status: 'failed', errorClass, error: message, disallowedTool: result.error?.disallowedTool ?? null, detail: out.detail ?? null, costUsd: result.costUsd, stats, ...(firstScanProgress ? { firstScan: firstScanProgress } : {}), ms: Date.now() - t0 });
    void flushTrace();
    return out;
  }

  /**
   * D5: run the spec's pre-check, book its spend (skill `<connector>-precheck`) and record what it decided. Fails open:
   * an error or an unclear answer returns null or not-empty, and the traversal runs as before.
   */
  protected async precheck(job: ScanJob, spec: TraversalConnectorSpec, ctx: ScanContext, runId: string, signal: AbortSignal, dbJobId?: number | string): Promise<PrecheckResult | null> {
    let pre: PrecheckResult | null;
    try {
      pre = await spec.precheck!({ scope: job.scope, window: job.window, vars: { ...spec.scopeVars(job.scope, ctx), ...(job.vars ?? {}) }, ctx, signal });
    } catch {
      pre = null;
    }
    if (!pre) return null;
    const skill = `${spec.connector}-precheck`;
    if (pre.costUsd > 0)
      await this.store.recordSpend({
        connector: spec.connector,
        model: pre.model,
        costUsd: pre.costUsd,
        runId,
        budget: 'daily',
        ...(dbJobId != null && Number.isFinite(Number(dbJobId)) ? { jobId: Number(dbJobId) } : {}),
        skill,
        inputTokens: pre.inputTokens,
        outputTokens: pre.outputTokens,
        cacheReadTokens: pre.cacheReadTokens,
        cacheWriteTokens: pre.cacheWriteTokens,
        usage: [{ model: pre.model, inputTokens: pre.inputTokens, outputTokens: pre.outputTokens, cacheReadTokens: pre.cacheReadTokens, cacheWriteTokens: pre.cacheWriteTokens, costUsd: pre.costUsd }],
        trigger: job.trigger,
        modelReason: 'default',
        contentHash: pre.contentHash ?? ledgerHash('precheck', spec.connector, job.scope, job.window.from, job.window.to),
        outcome: pre.empty ? 'empty' : pre.why,
      });
    const subject = scopeId({ connector: spec.connector, scope: job.scope });
    trace(runId, 'precheck', () => ({ empty: pre!.empty, why: pre!.why, calls: pre!.calls, costUsd: pre!.costUsd }));
    if (pre.empty) await this.store.recordDecision?.({ skill: skillKeyOf(spec), kind: 'skip', reason: 'precheck_empty', trigger: job.trigger, subject, detail: { calls: pre.calls, precheckUsd: pre.costUsd, window: job.window } });
    return pre;
  }

  /**
   * D6: Slack triage's escalation has a per-day allowance (Settings ▸ Budgets). What is left of it today rides on the
   * triage config; at 0 the runner flags unsure lines for Triage instead of escalating them.
   */
  protected async triageAllowance(job: ScanJob, spec: TraversalConnectorSpec): Promise<Partial<ScanSkillRunInput>> {
    const t = spec.triage?.(job.scope, job.mode);
    if (!t?.escalateModel || !this.store.escalationAllowance) return {};
    const a = await this.store.escalationAllowance().catch(() => null);
    if (!a) return {};
    return { triage: { ...t, escalateLeftUsd: Math.max(0, a.capUsd - a.spentUsd) } };
  }

  protected traversalInput(job: ScanJob, spec: TraversalConnectorSpec, ctx: ScanContext, runId: string, signal: AbortSignal): ScanSkillRunInput {
    const mode = job.mode === 'manual' || job.mode === 'retry' ? 'incremental' : job.mode;
    return {
      skillPath: spec.skillPath,
      model: job.model ?? spec.model,
      mcpServers: spec.mcpServers(),
      allowedTools: spec.allowedTools,
      runId,
      context: ctx,
      maxTurns: spec.maxTurns(job.scope, job.mode),
      costCapUsd: spec.costCapUsd(job.scope, job.mode),
      ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs(job.scope, job.mode) } : {}),
      signal,
      window: job.window,
      mode,
      vars: { ...spec.scopeVars(job.scope, ctx), ...(job.vars ?? {}) },
      instruction: job.instruction,
      ...(spec.autoRecord ? { autoRecord: spec.autoRecord } : {}),
      ...(spec.triage?.(job.scope, job.mode) ? { triage: spec.triage(job.scope, job.mode) } : {}),
      ...(this.gates.get(job.id) ? { spend: this.gates.get(job.id)! } : {}),
    };
  }

  protected async runDeterministic(
    job: ScanJob,
    spec: DeterministicConnectorSpec,
    ctx: ScanContext,
    runId: string,
    signal: AbortSignal,
    overBudget: boolean,
  ): Promise<{ result: ScanSkillRunResult; cursor?: Cursor; complete: boolean }> {
    const maxItems = Number(job.vars?.['maxItems']);
    const limit = Number.isFinite(maxItems) && maxItems > 0 ? Math.min(maxItems, spec.maxItemsPerRun) : spec.maxItemsPerRun;
    const f0 = Date.now();
    const fetch = await spec.fetcher.fetch(job.scope, ctx.cursor, job.window, { signal, limit });
    const base: ScanSkillRunResult = { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    // D3: what the fetcher keeps from the model is recorded deterministically (live state shows now), with its reason.
    const quiet = { recorded: 0, new: 0, changed: 0 };
    if (fetch.quietItems?.length) {
      for (const r of await this.store.recordSourceItems(runId, fetch.quietItems)) {
        quiet.recorded += 1;
        if (r.isNew) quiet.new += 1;
        if (r.changed) quiet.changed += 1;
      }
    }
    for (const d of fetch.decisions ?? []) await this.store.recordDecision?.({ skill: skillKeyOf(spec), kind: 'skip', reason: d.reason, trigger: job.trigger, subject: d.subject, ...(d.detail ? { detail: d.detail } : {}) });
    if (fetch.quietItems?.length || fetch.decisions?.length) trace(runId, 'quiet', () => ({ items: fetch.quietItems?.length ?? 0, reasons: [...new Set((fetch.decisions ?? []).map((d) => d.reason))] }));
    const withQuiet = <T extends ScanSkillRunResult>(r: T): T => (quiet.recorded && r.counts ? { ...r, counts: { ...r.counts, recorded: r.counts.recorded + quiet.recorded, new: r.counts.new + quiet.new, changed: r.counts.changed + quiet.changed } } : r);
    trace(runId, 'prefetch', { items: fetch.items.length, limit, coverage: fetch.coverage.length, complete: fetch.complete, recordOnly: !!fetch.recordOnly, nextCursorAt: fetch.nextCursor.at, ms: Date.now() - f0, agent: !((!fetch.items.length && !spec.alwaysRunAgent) || overBudget || fetch.recordOnly), deferred: overBudget && fetch.items.length > 0 });
    if ((!fetch.items.length && !spec.alwaysRunAgent) || overBudget || fetch.recordOnly) {
      // Cheap path: nothing to interpret (an empty fetch, or record-only history), or linking deferred at the hard cap
      // (SCANNER.md §7).
      const counts = { recorded: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, coverage: fetch.coverage.length };
      if (fetch.items.length) {
        const res = await this.store.recordSourceItems(runId, fetch.items);
        // W2: a message an interrupted run stored but nobody judged is deferred too (not only new or changed ones)
        const defer = fetch.recordOnly ? new Set<string>() : new Set((await toInterpret(this.store, res)).map((r) => r.sourceItemId));
        for (const r of res) {
          counts.recorded += 1;
          if (r.isNew) counts.new += 1;
          if (r.changed) counts.changed += 1;
          if (defer.has(r.sourceItemId)) {
            await this.store.flagUnlinked(runId, { sourceItemId: r.sourceItemId, reason: 'deferred: daily LLM hard cap; linking deferred to reconcile' });
            counts.unlinked += 1;
          }
        }
      }
      if (fetch.coverage.length) await this.store.reportCoverage(runId, fetch.coverage);
      return { result: withQuiet({ ...base, counts, complete: fetch.complete }), cursor: fetch.nextCursor, complete: fetch.complete };
    }
    // The worker commits fetch.nextCursor itself (below); the agent's cc_finish echo is never used. Fetcher cursor state
    // grows (per-file offsets, seen ids) past cc_finish's 200-char cursor.value limit, and the agent then refused to
    // alter it and stopped without cc_finish on every run of the scope, forever (stress finding CUR-1). A long cursor
    // is handed to the agent as a short stand-in token instead.
    const agentCursor = fetch.nextCursor.value.length <= HEADER_CURSOR_MAX ? fetch.nextCursor.value : `header:${runId.slice(0, 8)}`;
    const input: ScanSkillRunInput = {
      skillPath: spec.skillPath,
      model: job.model ?? spec.model,
      mcpServers: spec.mcpServers?.() ?? {},
      allowedTools: spec.allowedTools ?? [],
      runId,
      context: ctx,
      prefetched: fetch.items,
      preReportedCoverage: fetch.coverage,
      maxTurns: spec.maxTurns(job.scope, job.mode),
      costCapUsd: spec.costCapUsd(job.scope, job.mode),
      signal,
      window: job.window,
      mode: job.mode === 'manual' || job.mode === 'retry' ? 'incremental' : job.mode,
      vars: { 'header.cursor.value': agentCursor, 'header.cursor.at': fetch.nextCursor.at, 'header.complete': String(fetch.complete), 'header.items': fetch.items.length },
      ...(this.gates.get(job.id) ? { spend: this.gates.get(job.id)! } : {}),
      instruction: `Header: the worker fetched and recorded ${fetch.items.length} item(s) (each has its sourceItemId) and already reported the fetcher coverage. Interpret and link them per the skill, then call cc_finish with the header cursor unchanged: {"value":"${agentCursor}","at":"${fetch.nextCursor.at}"}, complete=${fetch.complete}.`,
    };
    const result = withQuiet((await this.withLlmSlot(() => this.runner.run(input, this.store))) as ScanSkillRunResult);
    return { result, cursor: result.ok ? fetch.nextCursor : undefined, complete: fetch.complete };
  }
}
