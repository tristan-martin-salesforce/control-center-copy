// ScannerRuntime run outcomes. Split from scanner-runtime.ts (max-lines); the class is still exported from scanner-runtime.ts.
import { statusReason } from './status-reason';
import { classifyError, probeFromClassification, retryable, type ErrorClass } from '../../llm/errors';
import { classify, failureDecision } from '../../errors/classify';
import { type ConnectorId, type ScanRunStats, scopeId } from '../types';
import { failureDelayMs, intervalMs, nextQuietLevel } from './cadence';
import type { ScanSkillRunResult } from './contract-ext';
import { isTraversal, type ConnectorSpec } from './connectors';
import { scanJob, type JobOutcome, type ReconcileJob, type RuntimeJob, type ScanJob } from './jobs';
import { type ScopeState, MIN, stuckDelayMs, SMALL_PAGES_STEP } from './scanner-runtime.shared';
import { DISK_FULL_MESSAGE } from './state-write';
import { ScannerRuntimePlan } from './scanner-runtime.plan';

/** ScannerRuntime run outcomes: success, failure, catch-up release, follow-ups. */
export abstract class ScannerRuntimeOutcome extends ScannerRuntimePlan {

  protected statsOf(r: ScanSkillRunResult): ScanRunStats {
    const c = r.counts;
    return {
      fetched: c?.recorded ?? 0,
      new: c?.new ?? 0,
      changed: c?.changed ?? 0,
      linked: c?.linked ?? 0,
      proposed: c?.proposed ?? 0,
      unlinked: c?.unlinked ?? 0,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      turns: r.turns,
    };
  }

  protected outcome(e: { connector: ConnectorId; ok: boolean; code?: string }): void {
    try {
      void Promise.resolve(this.deps.onScanOutcome?.(e)).catch(() => undefined);
    } catch {
      /* an observer never fails a run */
    }
  }

  protected async onSuccess(spec: ConnectorSpec, st: ScopeState, now: Date, stats: ScanRunStats) {
    const t = now.getTime();
    this.outcome({ connector: spec.connector, ok: true });
    st.failures = 0;
    st.transientStreak = 0;
    st.promptCap = undefined;
    if (st.paused === 'prompt_cap') {
      st.paused = undefined;
      this.log({ event: 'resumed', connector: spec.connector, scope: st.key.scope, code: 'prompt_cap_ok' });
    }
    // A success proves the connector works: lift any auth pause on its other scopes (an auth probe ran unpaused).
    const authPaused = [...this.scopes.values()].filter((o) => o.key.connector === spec.connector && o.paused === 'auth');
    if (st.paused === 'auth' || st.paused === 'config' || st.paused === 'stopped' || authPaused.length) {
      for (const other of authPaused) {
        other.paused = undefined;
        other.authPausedAt = undefined;
        other.nextDueAt = Math.min(other.nextDueAt, t);
      }
      st.paused = undefined;
      st.authPausedAt = undefined;
      this.log({ event: 'resumed', connector: spec.connector, scope: st.key.scope, code: 'auth_ok' });
    }
    st.quietLevel = nextQuietLevel(this.cadence, st.quietLevel, stats.new + stats.changed > 0);
    st.lastOkAt = t;
    const next = intervalMs(this.cadence, spec.connector, st.key.scope, now, st.quietLevel);
    if (t + next > st.nextDueAt) {
      st.nextDueAt = t + next;
      st.lastIntervalMs = next;
    }
    await this.maybeReleaseCatchUp(spec, st, now);
    // HEALTH-1: a success makes the connector healthy again (and clears its reason) once none of its other scopes is
    // failing. The in-memory flag starts empty after a restart, so the first success writes ok too. Before, only a
    // connector this process had seen fail was ever reset: a worker restarted after failures left seven connectors
    // Degraded for good, with a fresh last success and 0 failures. A scope that keeps failing keeps it Degraded, with
    // that scope's reason.
    // Only recent failures hold it: a one-off scope (a thread re-read) that failed and is never retried stops counting.
    const failing = [...this.scopes.values()].some((o) => o.key.connector === spec.connector && o !== st && o.failures > 0 && t - (o.lastFailAt ?? 0) < 2 * 60 * MIN);
    if (!failing) {
      if (this.healthState.get(spec.connector) !== 'ok') await this.store.recordHealth(spec.connector, { state: 'ok', checkedAt: now.toISOString() });
      this.healthState.set(spec.connector, 'ok');
    }
  }

  /** Catch-up ends when every job of its plan finished (ok, or failed for good) and the cursor reached now. */
  protected async maybeReleaseCatchUp(spec: ConnectorSpec, st: ScopeState, now: Date) {
    if (!st.catchUp) return;
    const outstanding = [...st.catchUp.jobs.keys()].filter((id) => !st.catchUp!.done.has(id));
    // Safety valve: a plan job lost outside the runtime (cancelled or dead-lettered as a job) must not hold the
    // catch-up flag forever; after 6 h only the cursor decides.
    if (outstanding.length && now.getTime() - st.catchUp.at < 6 * 60 * MIN) return;
    const cursor = await this.store.getCursor(st.key);
    const remaining = cursor ? await this.store.coverageGaps(st.key, { from: cursor.at, to: now.toISOString() }) : [];
    const left = remaining.reduce((a, w) => a + Date.parse(w.to) - Date.parse(w.from), 0);
    if (left <= this.cadence.baseMs[spec.connector]! * 2 || left <= MIN) st.catchUp = undefined;
  }

  protected async onFailure(job: ScanJob, spec: ConnectorSpec, st: ScopeState, runId: string, now: Date, message: string, errorClass: ErrorClass, result: ScanSkillRunResult): Promise<JobOutcome> {
    const out = await this.onFailureInner(job, spec, st, runId, now, message, errorClass, result);
    // A plan job is done when it will not run again (no retry); splits replace it with tracked follow-ups.
    if (!out.retryAt) {
      this.markCatchUpDone(st, job.id);
      await this.maybeReleaseCatchUp(spec, st, now);
    }
    return out;
  }

  protected async onFailureInner(job: ScanJob, spec: ConnectorSpec, st: ScopeState, runId: string, now: Date, message: string, errorClass: ErrorClass, result: ScanSkillRunResult): Promise<JobOutcome> {
    const t = now.getTime();
    // Too much in one window: split it (max_turns / cost cap / COST-2 prompt cap) instead of retrying the same thing. A prefix tripwire is
    // about the fixed prompt (skill, context pack, tool schemas), not the window: a traversal run's first call holds no
    // fetched data, so splitting time cascaded down to 10-minute windows, one failed first call each (TRIP-3). It backs
    // off and retries the same window instead. A deterministic run still halves its prefetched items.
    const tripwire = /prefix tripwire/i.test(message);
    const splittable = /max_turns|cost cap|prompt cap/i.test(message) || (tripwire && !isTraversal(spec));
    const span = Date.parse(job.window.to) - Date.parse(job.window.from);
    // A deterministic run whose agent stopped before cc_finish usually had too many items to work through (seen with
    // 25 emails in the stress runs): retry with fewer items like a cost-cap failure (stress finding F-1).
    const fewerItems = (splittable || /without cc_finish/i.test(message)) && !isTraversal(spec);
    const limit = isTraversal(spec) ? 0 : Number(job.vars?.['maxItems'] ?? spec.maxItemsPerRun);
    // MIN-26: a planned split or fewer-items retry is the runtime's normal oversize handling (the same window again, in
    // smaller runs; nothing is lost), so it neither degrades the connector nor counts as a failure. Before, Health
    // flipped a connector to Degraded and back on each one (Gemini notes and Gmail on the full first scan). A real
    // failure, and a single item over the budget, still do.
    const planned = errorClass !== 'auth' && (fewerItems ? limit > 1 : splittable && span >= 10 * MIN);
    if (!planned) {
      st.failures += 1;
      st.lastFailAt = t;
    }
    st.transientStreak = errorClass === 'transient' || errorClass === 'rate_limited' ? st.transientStreak + 1 : 0;
    // W0-7: a prompt cap on a window with no split left (an inbox poll under 10 min, one oversized tool page).
    const capStuck = /prompt cap/i.test(message) && isTraversal(spec) && !(splittable && span >= 10 * MIN);
    const c = classifyError(message);
    // 11 R5: the error catalog's code for this failure (the source's own classifier first); Health's words come from it
    // ask #14 (W5): a full disk is DEP.DISK.LOW (retried with backoff), never an unknown failure that stops the scope
    const catalog = result.error?.disallowedTool ? 'BUG.TOOL_BLOCKED' : message === DISK_FULL_MESSAGE ? 'DEP.DISK.LOW' : classify(spec.connector, message).code;
    this.outcome({ connector: spec.connector, ok: false, code: catalog });
    const probe = probeFromClassification(spec.connector, { errorClass, code: result.error?.disallowedTool ? 'disallowed_tool' : c.code, gateway: c.gateway }, now.toISOString(), st.transientStreak, result.error?.disallowedTool ?? undefined);
    const code = probe.detail?.split(':')[0];
    // STAT-1: the status reason names the scope and the cause in plain words, not the classifier's code ("unknown").
    probe.detail = statusReason(spec.connector, st.key.scope, capStuck ? `${message} (no split left)` : message, errorClass, result.error?.disallowedTool ?? undefined, catalog);
    if (planned) {
      if (this.healthState.get(spec.connector) !== 'bad') this.healthState.set(spec.connector, 'retry');
    } else {
      await this.store.recordHealth(spec.connector, probe);
      this.healthState.set(spec.connector, 'bad');
    }
    this.log({ event: 'run_fail', connector: spec.connector, scope: st.key.scope, runId, mode: job.mode, code, costUsd: result.costUsd, ...(planned ? { planned: true } : {}) });

    const followUps: RuntimeJob[] = [];
    if (errorClass === 'auth') {
      for (const other of this.scopes.values()) {
        if (other.key.connector !== spec.connector) continue;
        other.paused = 'auth';
        other.authPausedAt = t;
      }
      return { status: 'failed', runId, errorClass, followUps, detail: probe.detail, costUsd: result.costUsd };
    }
    if (fewerItems) {
      // Deterministic: halve the number of items handed to the agent (snapshot fetchers ignore the window, so a time
      // split repeated the same oversized run down to 10-minute windows; stress finding CAL-1). Bounded: log2(limit).
      if (limit > 1) {
        const half = Math.max(1, Math.floor(limit / 2));
        followUps.push(scanJob({ connector: spec.connector, scope: st.key.scope, window: job.window, mode: 'retry', trigger: job.trigger, runAt: now.toISOString(), model: job.model, vars: { ...(job.vars ?? {}), maxItems: String(half) }, priority: job.priority, ...(job.budget ? { budget: job.budget } : {}) }));
        this.trackFollowUps(st, followUps);
        return { status: 'failed', runId, errorClass, followUps, detail: `${probe.detail}; retrying with ${half} item(s)`, costUsd: result.costUsd };
      }
      st.nextDueAt = t + stuckDelayMs(st.failures);
      return { status: 'failed', runId, errorClass, followUps, detail: `${probe.detail}; a single item exceeds the run budget`, costUsd: result.costUsd };
    }
    if (splittable && span >= 10 * MIN) {
      const mid = new Date(Date.parse(job.window.from) + Math.floor(span / 2)).toISOString();
      for (const w of [{ from: job.window.from, to: mid }, { from: mid, to: job.window.to }]) {
        followUps.push(scanJob({ connector: spec.connector, scope: st.key.scope, window: w, mode: 'retry', trigger: job.trigger, runAt: now.toISOString(), model: job.model, vars: job.vars, priority: job.priority, ...(job.budget ? { budget: job.budget } : {}) }));
      }
      this.trackFollowUps(st, followUps);
      return { status: 'failed', runId, errorClass, followUps, detail: `${probe.detail}; window split`, costUsd: result.costUsd };
    }
    if (capStuck) {
      const pc = st.promptCap?.from === job.window.from ? st.promptCap : { from: job.window.from, count: 0 };
      pc.count += 1;
      st.promptCap = pc;
      if (pc.count === 2) {
        // Second identical failure: the same window once more, in half-size pages (the digest is the runner's default).
        const vars = { ...(job.vars ?? {}), 'scan.pageScale': '0.5' };
        followUps.push(scanJob({ connector: spec.connector, scope: st.key.scope, window: job.window, mode: 'retry', trigger: job.trigger, runAt: now.toISOString(), model: job.model, vars, instruction: SMALL_PAGES_STEP, priority: job.priority, dedupeKey: `scan:${spec.connector}:${st.key.scope}:pages:${job.window.from}`, ...(job.budget ? { budget: job.budget } : {}) }));
        this.trackFollowUps(st, followUps);
        return { status: 'failed', runId, errorClass, followUps, detail: `${probe.detail}; retrying with half-size pages`, costUsd: result.costUsd };
      }
      if (pc.count >= 3) {
        st.paused = 'prompt_cap';
        const detail = statusReason(spec.connector, st.key.scope, 'DATA.PROMPT_CAP', errorClass);
        await this.store.recordHealth(spec.connector, { ...probe, state: 'degraded', detail });
        this.log({ event: 'paused', connector: spec.connector, scope: st.key.scope, runId, code: 'DATA.PROMPT_CAP', detail });
        return { status: 'failed', runId, errorClass, followUps, detail, costUsd: result.costUsd };
      }
    }
    if (result.error?.disallowedTool) {
      st.paused = 'config';
      st.nextDueAt = t + 30 * MIN;
      return { status: 'failed', runId, errorClass: 'config', followUps, detail: probe.detail, costUsd: result.costUsd };
    }
    // 11 R5: parse drift and other pause_source codes stop here; an unknown failure stops after N in a row
    // (CC_UNKNOWN_MAX_RETRIES, default 5) and becomes a Health row with "Report this", instead of retrying forever
    const decision = failureDecision(catalog, st.failures);
    if (decision.kind === 'pause') {
      st.paused = 'stopped';
      if (decision.code !== catalog) {
        probe.detail = statusReason(spec.connector, st.key.scope, message, errorClass, undefined, decision.code);
        await this.store.recordHealth(spec.connector, probe);
      }
      this.log({ event: 'paused', connector: spec.connector, scope: st.key.scope, runId, code: decision.code });
      return { status: 'failed', runId, errorClass: 'config', followUps, detail: `${probe.detail}; no automatic retry`, costUsd: result.costUsd };
    }
    const delay = failureDelayMs(errorClass, st.failures);
    const attempt = (job.attempt ?? 0) + 1;
    if (delay == null || attempt > 5) {
      st.nextDueAt = t + stuckDelayMs(st.failures);
      return { status: 'failed', runId, errorClass, followUps, detail: `${probe.detail}; no automatic retry`, costUsd: result.costUsd };
    }
    st.nextDueAt = t + delay;
    // An incremental poll is subsumed by the next poll from the unmoved cursor; other windows retry as-is.
    const retryAt = job.mode === 'incremental' ? undefined : new Date(t + delay).toISOString();
    return { status: 'failed', runId, errorClass, retryAt: retryable(errorClass) || errorClass === 'config' ? retryAt : undefined, followUps, detail: probe.detail, costUsd: result.costUsd };
  }

  protected trackFollowUps(st: ScopeState, jobs: RuntimeJob[]) {
    const t = this.clock.now().getTime();
    for (const j of jobs) {
      if (j.kind !== 'scan' || scopeId({ connector: j.connector, scope: j.scope }) !== scopeId(st.key)) continue;
      st.pending.set(j.id, t);
      if (st.catchUp) st.catchUp.jobs.set(j.id, j.window);
    }
  }

  protected async executeReconcile(job: ReconcileJob, signal: AbortSignal): Promise<JobOutcome> {
    this.log({ event: 'reconcile', detail: job.passes.join(',') });
    const report = await this.reconciler.run(job, signal);
    return { status: report.errors.length ? 'failed' : 'succeeded', followUps: report.jobs, costUsd: report.costUsd, detail: report.summary };
  }
}
