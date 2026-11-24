/**
 * ScannerRuntime (SCANNER.md §2, §5, §7). Runs inside the worker; no DB code.
 *
 *   planJobs(now)        → jobs to enqueue: resume plan on first call (head first, then backfill oldest
 *                          → newest), then due polls per scope (cadence × off-hours × adaptive backoff),
 *                          nightly reconcile, skill-upgrade dry runs. Budget-aware: traversal scopes
 *                          pause at the hard cap.
 *   executeJob(job, sig) → one scan run (or reconcile pass). `store.finishRun` only on success, then
 *                          the ReevaluateEnqueuer; `failRun` + health probe on failure; continuation when
 *                          the agent stopped early; window split on max_turns / cost cap.
 *   runScope(scope, …)   → chat `/rescan` and Health "Rescan": runs now, ahead of the queue.
 *   start() / stop()     → optional standalone loop over an InMemoryJobQueue (dev, tests). BE-1's worker
 *                          instead maps jobs onto Postgres and calls executeJob itself.
 */
import { classifyError } from '../../llm/errors';
import type { ConnectorId, ScopeKey, TimeWindow } from '../types';
import {
  InMemoryJobQueue, retryJobOf, scanJob, type JobOutcome, type ReconcileJob, type ScanJob, type ScanJobMode,
} from './jobs';
import { catchUpFraction } from './resume-planner';
import type { ScopeStatus } from './scanner-runtime.shared';
import { ScannerRuntimeJobs } from './scanner-runtime.jobs';
export { stuckDelayMs, SPEND_ASK_RECHECK_MS, skillKeyOf } from './scanner-runtime.shared';
export type { RuntimeLogEvent, ScannerRuntimeDeps, ScopeStatus, ReevaluateReason } from './scanner-runtime.shared';

export { runOutcome } from './spend';

export class ScannerRuntime extends ScannerRuntimeJobs {

  // ===================================================================== on-demand API

  /**
   * Chat `/rescan` and Health "Rescan". Runs now (waits for the connector lock), oldest → newest in
   * chunks when the window is large. Default window: from the cursor (or the initial lookback) to now.
   * A successful manual run also clears an auth pause.
   */
  async runScope(scope: ScopeKey, trigger: 'manual' | 'chat' | 'reconcile' = 'manual', window?: TimeWindow, signal?: AbortSignal): Promise<JobOutcome[]> {
    const spec = this.specs.get(scope.connector);
    if (!spec) return [{ status: 'skipped', followUps: [], detail: `no spec for ${scope.connector}` }];
    const now = this.clock.now();
    const cursor = await this.store.getCursor(scope);
    const w = window ?? { from: cursor?.at ?? new Date(now.getTime() - spec.initialLookbackMs).toISOString(), to: now.toISOString() };
    const chunks: TimeWindow[] = [];
    for (let a = Date.parse(w.from), end = Date.parse(w.to); a < end; a += spec.chunkMs) {
      chunks.push({ from: new Date(a).toISOString(), to: new Date(Math.min(a + spec.chunkMs, end)).toISOString() });
    }
    if (!chunks.length) chunks.push(w);
    const outcomes: JobOutcome[] = [];
    const queue: ScanJob[] = chunks.map((c) => scanJob({ connector: scope.connector, scope: scope.scope, window: c, mode: 'manual', trigger, runAt: now.toISOString(), model: spec.model, vars: this.varsFor(spec, scope.scope) }));
    while (queue.length) {
      const job = queue.shift()!;
      const out = await this.executeJob(job, signal);
      outcomes.push(out);
      for (const f of out.followUps) if (f.kind === 'scan') queue.push({ ...f, trigger });
    }
    return outcomes;
  }

  /** Run reconcile passes now (Health / chat). */
  async runReconcile(passes: ReconcileJob['passes'] = ['coverage_gaps', 'unlinked', 'stale_active'], connector?: ConnectorId, signal?: AbortSignal) {
    const job = this.reconcileJob(passes, 'manual', this.clock.now(), `manual:${Date.now()}`);
    job.connector = connector;
    return this.reconciler.run(job, signal ?? new AbortController().signal);
  }

  /**
   * Re-auth done (Health "Re-auth" → `connector.reauth` job, or a successful manual Rescan): clear the auth/config
   * pause of every scope of the connector and make them due now. Returns the scopes resumed.
   */
  resumeConnector(connector: ConnectorId, now: Date = this.clock.now()): string[] {
    const out: string[] = [];
    for (const st of this.scopes.values()) {
      if (st.key.connector !== connector) continue;
      if (st.paused === 'auth' || st.paused === 'config' || st.paused === 'stopped') {
        st.paused = undefined;
        out.push(st.key.scope);
      }
      st.failures = 0;
      st.nextDueAt = Math.min(st.nextDueAt, now.getTime());
    }
    if (out.length) this.log({ event: 'resumed', connector, code: 'reauth', detail: out.join(',') });
    return out;
  }

  /** Known (planned) scope names of a connector. */
  scopesOf(connector: ConnectorId): string[] {
    return [...this.scopes.values()].filter((s) => s.key.connector === connector).map((s) => s.key.scope);
  }

  status(): ScopeStatus[] {
    return [...this.scopes.values()].map((st) => ({
      connector: st.key.connector,
      scope: st.key.scope,
      nextDueAt: new Date(st.nextDueAt).toISOString(),
      quietLevel: st.quietLevel,
      failures: st.failures,
      paused: st.paused,
      catchingUp: !!st.catchUp,
      ...(st.lastIntervalMs ? { intervalMs: st.lastIntervalMs } : {}),
    }));
  }

  /** "Catching up: Slack 60%" (UI-SPEC §10): covered fraction of each connector's catch-up plan. */
  async catchUpProgress(): Promise<Partial<Record<ConnectorId, number>>> {
    const out: Partial<Record<ConnectorId, number>> = {};
    const agg = new Map<ConnectorId, { planned: TimeWindow[]; remaining: TimeWindow[] }>();
    for (const st of this.scopes.values()) {
      if (!st.catchUp) continue;
      const a = agg.get(st.key.connector) ?? { planned: [], remaining: [] };
      a.planned.push(...st.catchUp.planned);
      // Outstanding plan windows (continuations count as what is left of their chunk).
      for (const [id, w] of st.catchUp.jobs) if (!st.catchUp.done.has(id)) a.remaining.push(w);
      agg.set(st.key.connector, a);
    }
    for (const [c, a] of agg) out[c] = Math.round(catchUpFraction(a.planned, a.remaining) * 100);
    return out;
  }

  isCatchingUp(connector?: ConnectorId): boolean {
    return [...this.scopes.values()].some((s) => !!s.catchUp && (!connector || s.key.connector === connector));
  }

  // ===================================================================== standalone loop

  /**
   * Standalone scheduler loop (dev, tests). Requires the default InMemoryJobQueue. BE-1's worker
   * does NOT call this; it calls planJobs() on its tick and executeJob() per dequeued row.
   */
  start(opts: { tickMs?: number; concurrency?: number } = {}): void {
    if (this.loop) return;
    if (!(this.queue instanceof InMemoryJobQueue)) throw new Error('start() needs the in-memory queue; with an external queue call planJobs/executeJob');
    const q = this.queue;
    const ac = new AbortController();
    const tick = opts.tickMs ?? 15_000;
    const running = new Map<string, Promise<void>>();
    const done = (async () => {
      while (!ac.signal.aborted) {
        await q.enqueue(await this.planJobs());
        const busy = new Set<string>([...running.keys()]);
        while (running.size < (opts.concurrency ?? 3)) {
          const job = q.dequeue(this.clock.now(), busy);
          if (!job) break;
          const key = job.kind === 'scan' ? job.connector : `reconcile`;
          busy.add(key);
          const p = this.executeJob(job, ac.signal)
            .then(async (out) => {
              await q.enqueue(out.followUps);
              if (out.retryAt && job.kind === 'scan') await q.enqueue([retryJobOf(job, out)]);
            })
            .catch((err) => this.log({ event: 'run_fail', code: 'execute_threw', detail: classifyError(err).code }))
            .finally(() => running.delete(key));
          running.set(key, p);
        }
        await this.clock.sleep(tick, ac.signal);
      }
      await Promise.allSettled(running.values());
    })();
    this.loop = { stop: () => ac.abort(), done };
  }

  async stop(): Promise<void> {
    if (!this.loop) return;
    this.loop.stop();
    await this.loop.done;
    this.loop = undefined;
  }

  /** Drain the in-memory queue synchronously (tests / scripts): plan, then execute due jobs until empty. */
  async drain(opts: { maxJobs?: number; signal?: AbortSignal } = {}): Promise<JobOutcome[]> {
    if (!(this.queue instanceof InMemoryJobQueue)) throw new Error('drain() needs the in-memory queue');
    const q = this.queue;
    const outcomes: JobOutcome[] = [];
    await q.enqueue(await this.planJobs());
    for (let i = 0; i < (opts.maxJobs ?? 500); i++) {
      const job = q.dequeue(new Date(8.64e15));
      if (!job) break;
      const out = await this.executeJob(job, opts.signal);
      outcomes.push(out);
      await q.enqueue(out.followUps);
    }
    return outcomes;
  }
}

export type { ScanJobMode };
