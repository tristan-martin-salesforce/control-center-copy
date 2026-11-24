/**
 * WorkerRuntime: the Postgres job engine behind `npm run worker` (R-UI-7, R-BE-4; DATA-MODEL §1.5, §4.5).
 *
 * - Pools: one per queue (one per connector for scans, plus engine / nba / brief / maintenance), each with its
 *   own concurrency. A pool claims with BE-0's `claimJobs` (FOR UPDATE SKIP LOCKED + dedupe-key advisory lock).
 * - Leases: a claim is immediately narrowed to a short lease (default 90 s) that a heartbeat extends; the job's
 *   own `timeout_seconds` aborts it in-process. A dead or sleeping worker's lease expires and the reaper
 *   re-queues the job.
 * - Retries: exponential backoff with jitter for retryable classes, dead-letter (notification + app_event)
 *   when not retryable or out of attempts.
 * - Cancel: LISTEN `cc_job_cancel` (and the heartbeat's poll as the fallback) aborts the job's AbortController.
 *   Re-evaluations are also fenced on `work_items.reeval_generation` before they start (W3).
 * - Shutdown: stop claiming, abort every run, give it `drainMs` to settle, then release what is left
 *   (back to `queued`, attempt given back).
 */
import { Client } from 'pg';
import { sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { resolveDatabaseUrl } from '@/db/client';
import { claimJobs, enqueueJob, type ClaimedJob } from '@/db/queue';
import { deferJob } from '@/server/datasource/db/spend';
import {
  cancelJob,
  classifyJobError,
  completeJob,
  DEFAULT_LEASE_SECONDS,
  failJob,
  heartbeatLeases,
  jobRowOf,
  reapExpiredLeases,
  type ReapedOutboxJob,
  releaseJob,
  type FailOutcome,
} from '@/jobs/queue-ops';
import type { JobRegistry } from '@/jobs/registry';
import { abortReasonOf, JobAbort, type JobContext, type JobRow } from '@/jobs/types';
import { withTraceContext } from '@/scanner/trace';
import { logger } from '@/lib/log';
import type { Logger } from 'pino';

/** Lines from a runtime built without a `log` option (pino JSON, like the worker's own). */
let fallbackLog: Logger | null = null;

export interface PoolSpec {
  name: string;
  queues: string[];
  concurrency: number;
}

export interface TickHook {
  name: string;
  everyMs: number;
  run: (now: Date) => Promise<void>;
  /** Runs while claims are held (the heartbeat, the schema check). Every other hook waits with the claims. */
  whileHeld?: boolean;
}

export interface WorkerRuntimeOptions<S> {
  db: Db;
  userId: string;
  workerId: string;
  registry: JobRegistry<S>;
  services: S;
  clock?: () => Date;
  /** Default: one pool per registered queue (scans 1, engine 2, others 1; maintenance also drains 'default'). */
  pools?: PoolSpec[];
  pollMs?: number;
  leaseSeconds?: number;
  heartbeatMs?: number;
  reaperMs?: number;
  drainMs?: number;
  /** LISTEN cc_job_cancel on this URL. null = no LISTEN (the heartbeat poll still catches cancels). */
  listenUrl?: string | null;
  hooks?: TickHook[];
  /** Called on every poll tick (heartbeat file, …). */
  onTick?: (s: WorkerStatus) => void;
  /** A job went dead (notifications for failed Top-3 work). */
  onDead?: (job: JobRow, outcome: Extract<FailOutcome, { status: 'dead' }>) => Promise<void>;
  /**
   * Spend governor (H-5): before a job that calls a model starts, hold its estimate; declined when today's spend plus
   * every live hold would pass the daily hard cap (the job waits until `retryAt`, attempt not consumed). `settle`
   * runs after the handler, however it ends.
   */
  startGate?: (job: JobRow) => Promise<{ start: true; settle?: () => Promise<void> } | { start: false; retryAt: Date }>;
  /** Put a declined job back for later (default: the queue's own deferral in src/server/datasource/db/spend.ts). */
  deferJob?: (db: Db, id: number, workerId: string, runAt: Date) => Promise<unknown>;
  /** B3: Outbox jobs the reaper stopped (never requeued): resolve their items without writing again. */
  onReapedOutbox?: (jobs: ReapedOutboxJob[]) => Promise<void>;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

export interface WorkerStatus {
  state: 'starting' | 'idle' | 'running' | 'draining' | 'stopped';
  activeJobs: number;
  byPool: Record<string, number>;
  lastTickAt: string;
}

interface Active {
  job: JobRow;
  pool: string;
  ac: AbortController;
  done: Promise<void>;
}

export function defaultPools(queues: string[]): PoolSpec[] {
  return queues.map((q) => ({
    name: q,
    queues: q === 'maintenance' ? ['maintenance', 'default'] : [q],
    concurrency: q === 'engine' ? 2 : 1,
  }));
}

export class WorkerRuntime<S = unknown> {
  private readonly o: WorkerRuntimeOptions<S>;
  private readonly pools: PoolSpec[];
  private readonly active = new Map<number, Active>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly hookBusy = new Set<string>();
  private readonly inflight = new Set<Promise<unknown>>();
  private stopping = false;
  private started = false;
  private listener: Client | null = null;
  private state: WorkerStatus['state'] = 'starting';
  private lastTickAt = new Date(0);
  private heldFor: string | null = null;

  constructor(opts: WorkerRuntimeOptions<S>) {
    this.o = opts;
    this.pools = opts.pools ?? defaultPools(opts.registry.queues());
  }

  private now(): Date {
    return this.o.clock?.() ?? new Date();
  }
  private log(msg: string, detail?: Record<string, unknown>) {
    if (this.o.log) this.o.log(msg, detail);
    else (fallbackLog ??= logger('worker')).info(detail ?? {}, msg);
  }

  get activeCount(): number {
    return this.active.size;
  }
  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Stop claiming (and planning) without stopping: running jobs finish, nothing new starts, only `whileHeld` hooks
   * run (lane E: the database schema no longer matches this build). `release()` resumes. Idempotent.
   */
  hold(reason: string): void {
    if (this.heldFor === reason) return;
    this.heldFor = reason;
    this.log('claims held', { reason });
  }

  release(): void {
    if (this.heldFor === null) return;
    this.log('claims resumed', { reason: this.heldFor });
    this.heldFor = null;
  }

  get held(): string | null {
    return this.heldFor;
  }

  status(): WorkerStatus {
    const byPool: Record<string, number> = {};
    for (const a of this.active.values()) byPool[a.pool] = (byPool[a.pool] ?? 0) + 1;
    return { state: this.state, activeJobs: this.active.size, byPool, lastTickAt: this.lastTickAt.toISOString() };
  }

  activeJobs(): JobRow[] {
    return [...this.active.values()].map((a) => a.job);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reap();
    if (this.o.listenUrl !== null) await this.listenCancels().catch((e) => this.log('cancel listener unavailable', { code: (e as { code?: string }).code ?? 'error' }));
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => {
        if (this.stopping) return;
        const p: Promise<unknown> = fn()
          .catch((e) => this.log('timer failed', { code: classifyJobError(e).code }))
          .finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.o.pollMs ?? 1000, () => this.pollOnce());
    every(this.o.heartbeatMs ?? 15_000, () => this.heartbeatOnce());
    every(this.o.reaperMs ?? 30_000, () => this.reap());
    for (const h of this.o.hooks ?? []) every(h.everyMs, () => this.runHook(h));
    this.state = 'idle';
    // First pass right away: plan, then claim.
    await this.runHooks();
    await this.pollOnce();
  }

  /** Run every tick hook now (startup, wake from sleep). */
  async runHooks(): Promise<void> {
    for (const h of this.o.hooks ?? []) await this.runHook(h);
  }

  private async runHook(h: TickHook): Promise<void> {
    if (this.stopping || this.hookBusy.has(h.name)) return;
    if (this.heldFor !== null && !h.whileHeld) return;
    this.hookBusy.add(h.name);
    try {
      await h.run(this.now());
    } catch (e) {
      this.log(`hook ${h.name} failed`, { code: classifyJobError(e).code });
    } finally {
      this.hookBusy.delete(h.name);
    }
  }

  /** Wake from sleep / a clock jump: extend our leases first, then reap others, then re-plan immediately. */
  async onWake(gapMs: number): Promise<void> {
    this.log('wake detected', { gapSeconds: Math.round(gapMs / 1000) });
    await this.heartbeatOnce();
    await this.reap();
    await this.runHooks();
    await this.pollOnce();
  }

  /** Graceful stop: no new claims, abort runs, wait up to drainMs, release the rest. Idempotent. */
  async stop(reason = 'shutdown'): Promise<{ released: number; settled: number }> {
    if (this.stopping) return { released: 0, settled: 0 };
    this.stopping = true;
    this.state = 'draining';
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    const running = [...this.active.values()];
    for (const a of running) a.ac.abort(new JobAbort('shutdown', reason));
    // Timer tasks already in flight (a plan, a heartbeat) finish before the pool closes.
    const all = Promise.allSettled([...running.map((a) => a.done), ...this.inflight]);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, this.o.drainMs ?? 10_000)))]);
    if (timer) clearTimeout(timer);
    let released = 0;
    for (const a of this.active.values()) {
      // Still running after the drain window: give the lease back now; its late completion is fenced out.
      const r = await releaseJob(this.o.db, a.job.id, this.o.workerId).catch(() => 'lost' as const);
      if (r !== 'lost') released++;
    }
    const settled = running.length - this.active.size;
    await this.listener?.end().catch(() => undefined);
    this.listener = null;
    this.state = 'stopped';
    return { released, settled };
  }

  /** Resolves when no job is active (tests, scripts). */
  async idle(timeoutMs = 30_000): Promise<void> {
    const t0 = Date.now();
    while (this.active.size) {
      if (Date.now() - t0 > timeoutMs) throw new Error('worker idle(): timed out');
      await Promise.race([...this.active.values()].map((a) => a.done));
    }
  }

  // ------------------------------------------------------------------ claiming

  /** One claim pass across all pools (passes are serialized). Returns how many jobs started. */
  pollOnce(): Promise<number> {
    const next = this.pollChain.then(() => this.doPoll());
    this.pollChain = next.catch(() => 0);
    return next;
  }

  private pollChain: Promise<number> = Promise.resolve(0);

  private async doPoll(): Promise<number> {
    if (this.stopping) return 0;
    if (this.heldFor !== null) {
      this.lastTickAt = this.now();
      this.o.onTick?.(this.status());
      return 0;
    }
    let started = 0;
    try {
      for (const pool of this.pools) {
        const busy = [...this.active.values()].filter((a) => a.pool === pool.name).length;
        const free = pool.concurrency - busy;
        if (free <= 0) continue;
        const claimed = await claimJobs({
          db: this.o.db,
          workerId: this.o.workerId,
          ownerUserId: this.o.userId, // jobs run as this.o.userId: never claim another user's
          queues: pool.queues,
          limit: free,
        });
        for (const c of claimed) {
          this.launch(c, pool.name);
          started++;
        }
      }
    } finally {
      this.lastTickAt = this.now();
      if (!this.stopping) this.state = this.active.size ? 'running' : 'idle';
      this.o.onTick?.(this.status());
    }
    return started;
  }

  private launch(c: ClaimedJob, pool: string) {
    const job = jobRowOf(c);
    const ac = new AbortController();
    const entry: Active = { job, pool, ac, done: Promise.resolve() };
    this.active.set(job.id, entry);
    entry.done = this.execute(job, ac)
      .catch((e) => this.log('job crashed', { jobId: job.id, code: classifyJobError(e).code }))
      .finally(() => {
        this.active.delete(job.id);
        // A slot freed up: claim again soon (not inside this stack).
        if (!this.stopping) setImmediate(() => void this.pollOnce().catch(() => undefined));
      });
  }

  /** AUDIT: everything a job does (its log lines, its LLM spend) carries the job id, and its connector / scope when it has one. */
  private execute(job: JobRow, ac: AbortController): Promise<void> {
    const p = job.payload as { connector?: unknown; scope?: unknown };
    return withTraceContext({ jobId: job.id, jobKind: job.kind, connector: typeof p.connector === 'string' ? p.connector : undefined, scope: typeof p.scope === 'string' ? p.scope : undefined }, () => this.executeInner(job, ac));
  }

  private async executeInner(job: JobRow, ac: AbortController): Promise<void> {
    const { db, workerId } = this.o;
    const timeout = setTimeout(() => ac.abort(new JobAbort('timeout', `${job.timeoutSeconds}s`)), job.timeoutSeconds * 1000);
    timeout.unref?.();
    try {
      await heartbeatLeases(db, workerId, [job.id], this.o.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
      const def = this.o.registry.get(job.kind);
      if (!def) {
        await failJob(db, job.id, workerId, { errorClass: 'bug', code: 'unknown_kind', message: `no handler for ${job.kind}` });
        return;
      }
      if (job.cancelRequestedAt) {
        await cancelJob(db, job.id, workerId, 'cancel requested before start');
        return;
      }
      const fence = await this.generationFence(job);
      if (fence.stale) {
        await cancelJob(db, job.id, workerId, `superseded by generation ${fence.current}`);
        return;
      }
      const gate = this.o.startGate ? await this.o.startGate(job).catch((): { start: true; settle?: () => Promise<void> } => ({ start: true })) : null;
      if (gate && !gate.start) {
        await (this.o.deferJob ?? deferJob)(db, job.id, workerId, gate.retryAt);
        this.log(`${job.kind}#${job.id} waits for the day's budget`, { code: 'spend_day_budget', retryAt: gate.retryAt.toISOString() });
        return;
      }
      const settleSpend = gate && gate.start ? gate.settle : undefined;
      const ctx: JobContext<S> = {
        job,
        signal: ac.signal,
        db,
        userId: this.o.userId,
        clock: () => this.now(),
        log: (msg, detail) => this.log(`${job.kind}#${job.id} ${msg}`, detail),
        heartbeat: async () => {
          await heartbeatLeases(db, workerId, [job.id], this.o.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
        },
        enqueue: (input) => enqueueJob(db, { ownerUserId: this.o.userId, ...input }),
        services: this.o.services,
      };
      let result: Record<string, unknown> | void;
      try {
        result = await def.handler(ctx);
      } catch (e) {
        await settleSpend?.().catch(() => undefined);
        if (ac.signal.aborted) return await this.settleAborted(job, ac.signal);
        const c = classifyJobError(e);
        const out = await failJob(db, job.id, workerId, c);
        this.log(`${job.kind}#${job.id} failed`, { errorClass: c.errorClass, code: c.code, outcome: out.status });
        if (out.status === 'dead') await this.o.onDead?.(job, out).catch(() => undefined);
        return;
      }
      await settleSpend?.().catch(() => undefined);
      if (ac.signal.aborted) return await this.settleAborted(job, ac.signal);
      await completeJob(db, job.id, workerId, result ?? {});
    } finally {
      clearTimeout(timeout);
    }
  }

  private async settleAborted(job: JobRow, signal: AbortSignal): Promise<void> {
    const { db, workerId } = this.o;
    switch (abortReasonOf(signal)) {
      case 'cancel':
        await cancelJob(db, job.id, workerId, 'cancelled while running');
        return;
      case 'timeout':
        await failJob(db, job.id, workerId, { errorClass: 'transient', code: 'timeout', message: `ran longer than ${job.timeoutSeconds}s` });
        return;
      case 'lease_lost':
        return; // someone else owns it now
      default:
        await releaseJob(db, job.id, workerId);
    }
  }

  /** W3 for re-evaluations: a job enqueued for an older generation of its work item never starts. */
  private async generationFence(job: JobRow): Promise<{ stale: boolean; current?: number }> {
    const wid = job.payload.work_item_id;
    if (job.generation === null || typeof wid !== 'string') return { stale: false };
    const r = await this.o.db.execute<{ g: string }>(sql`select reeval_generation as g from work_items where id = ${wid}`);
    const current = r.rows[0] ? Number(r.rows[0].g) : undefined;
    return { stale: current !== undefined && current > job.generation, current };
  }

  // ------------------------------------------------------------------ leases, cancel, reaper

  async heartbeatOnce(): Promise<void> {
    const ids = [...this.active.keys()];
    if (!ids.length) return;
    const held = await heartbeatLeases(this.o.db, this.o.workerId, ids, this.o.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
    for (const id of ids) {
      const a = this.active.get(id);
      if (!a || a.ac.signal.aborted) continue;
      const h = held.get(id);
      if (!h) a.ac.abort(new JobAbort('lease_lost'));
      else if (h.cancelRequested) a.ac.abort(new JobAbort('cancel', 'requested'));
    }
  }

  async reap(): Promise<{ requeued: number; dead: number; cancelled: number; outbox: ReapedOutboxJob[] }> {
    const r = await reapExpiredLeases(this.o.db, { exceptIds: [...this.active.keys()] });
    if (r.requeued || r.dead || r.cancelled) this.log('reaped expired leases', { requeued: r.requeued, dead: r.dead, cancelled: r.cancelled, outbox: r.outbox.length });
    if (r.outbox.length && this.o.onReapedOutbox) await this.o.onReapedOutbox(r.outbox).catch((e: unknown) => this.log('outbox recovery failed', { error: e instanceof Error ? e.name : 'error' }));
    return r;
  }

  private async listenCancels(): Promise<void> {
    const c = new Client({ connectionString: resolveDatabaseUrl(this.o.listenUrl ?? undefined), application_name: 'command-center-worker-cancel' });
    c.on('notification', (m) => {
      const id = Number(m.payload);
      const a = this.active.get(id);
      if (a && !a.ac.signal.aborted) a.ac.abort(new JobAbort('cancel', 'cc_job_cancel'));
    });
    c.on('error', () => {
      if (this.listener === c) this.listener = null;
      // The heartbeat poll keeps catching cancels; try to re-LISTEN later.
      if (!this.stopping) setTimeout(() => void this.listenCancels().catch(() => undefined), 5000).unref?.();
    });
    await c.connect();
    await c.query('LISTEN cc_job_cancel');
    this.listener = c;
  }
}
