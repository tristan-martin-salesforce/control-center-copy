/**
 * Job-queue primitives over `jobs` (DATA-MODEL §1.5, §4.5): enqueue with exactly-once and
 * coalescing keys, the SKIP LOCKED claim, and W2 "new info: save first, bump generation, cancel
 * the running re-eval, coalesce the next one". The worker runtime (leases, heartbeats, retries,
 * the reaper, schedules) builds on these.
 *
 * `jobs` is not an audited table, so these run with or without a change set. recordNewInfo()
 * also updates work_items, so it must run inside withChangeSet().
 */
import { sql } from 'drizzle-orm';

import { getDb, type Db, type DbOrTx } from './client';
import { mapPgError, NotFoundError } from './errors';

export interface EnqueueJobInput {
  ownerUserId: string;
  /** e.g. 'scan.slack.dm', 'reevaluate', 'outbox.send'. */
  kind: string;
  queue?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  /** Visible-at time; default now. */
  runAt?: Date;
  /** Alternative to runAt: now() + delay (used as the debounce for coalesced jobs). */
  delaySeconds?: number;
  /** At most one *queued* job per key; a second enqueue merges into it (generation, run_at, payload). */
  dedupeKey?: string;
  /** Exactly-once: a second enqueue with the same key is a no-op that returns the first job. */
  idempotencyKey?: string;
  generation?: number;
  supersedesRunning?: boolean;
  maxAttempts?: number;
  timeoutSeconds?: number;
  scheduleId?: string;
  parentJobId?: number;
  correlationId?: string;
}

export interface EnqueueResult {
  id: number;
  /** false when the enqueue merged into (dedupe) or matched (idempotency) an existing job. */
  inserted: boolean;
}

export async function enqueueJob(db: DbOrTx, job: EnqueueJobInput): Promise<EnqueueResult> {
  const runAt = job.runAt
    ? sql`${job.runAt.toISOString()}::timestamptz`
    : sql`now() + make_interval(secs => ${job.delaySeconds ?? 0})`;
  const values = sql`(${job.ownerUserId}, ${job.queue ?? 'default'}, ${job.kind}, ${JSON.stringify(job.payload ?? {})}::jsonb,
    ${job.priority ?? 0}, ${runAt}, ${job.maxAttempts ?? 5}, ${job.timeoutSeconds ?? 600}, ${job.dedupeKey ?? null},
    ${job.generation ?? null}, ${job.supersedesRunning ?? false}, ${job.idempotencyKey ?? null}, ${job.scheduleId ?? null},
    ${job.parentJobId ?? null}, ${job.correlationId ?? null})`;
  const cols = sql`(owner_user_id, queue, kind, payload, priority, run_at, max_attempts, timeout_seconds, dedupe_key,
    generation, supersedes_running, idempotency_key, schedule_id, parent_job_id, correlation_id)`;
  try {
    if (job.idempotencyKey) {
      const res = await db.execute<{ id: string }>(
        sql`insert into jobs ${cols} values ${values} on conflict do nothing returning id`,
      );
      if (res.rows[0]) return { id: Number(res.rows[0].id), inserted: true };
      const existing = await db.execute<{ id: string }>(sql`
        select id from jobs where idempotency_key = ${job.idempotencyKey}
        union all
        select id from jobs where dedupe_key = ${job.dedupeKey ?? null} and status = 'queued'
        limit 1`);
      if (!existing.rows[0]) throw new NotFoundError('jobs', `idempotency_key=${job.idempotencyKey}`);
      return { id: Number(existing.rows[0].id), inserted: false };
    }
    if (job.dedupeKey) {
      const res = await db.execute<{ id: string; inserted: boolean }>(sql`
        insert into jobs ${cols} values ${values}
        on conflict (dedupe_key) where status = 'queued'
        do update set generation = coalesce(excluded.generation, jobs.generation),
                      run_at     = excluded.run_at,
                      payload    = excluded.payload,
                      updated_at = now()
        returning id, (xmax = 0) as inserted`);
      return { id: Number(res.rows[0]!.id), inserted: res.rows[0]!.inserted };
    }
    const res = await db.execute<{ id: string }>(sql`insert into jobs ${cols} values ${values} returning id`);
    return { id: Number(res.rows[0]!.id), inserted: true };
  } catch (e) {
    throw mapPgError(e);
  }
}

export interface ClaimOptions {
  /** Recorded in jobs.locked_by, e.g. `${hostname}:${pid}:${bootId}`. */
  workerId: string;
  /**
   * Claim only this user's jobs (the worker runs each job as its own userId, so it must never take another
   * user's). Required: no caller can claim another user's jobs by leaving it out.
   */
  ownerUserId: string;
  queues?: string[];
  limit?: number;
  db?: Db;
}

/** Raw jobs row as returned by the claim (snake_case, bigint ids as strings). */
export interface ClaimedJob {
  id: string;
  owner_user_id: string;
  queue: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  generation: string | null;
  dedupe_key: string | null;
  lease_expires_at: string;
  [k: string]: unknown;
}

/**
 * queued -> running (§4.5). Candidates: visible (run_at <= now), on the given queues, owned by `ownerUserId`
 * (required, so no caller claims another user's jobs by omission; the worker's user: jobs_dequeue_idx still drives the scan, the owner is a filter on it), ordered by priority DESC, run_at, id,
 * locked FOR UPDATE SKIP LOCKED, so concurrent claimers never take the same job.
 *
 * "A dedupe key never runs twice at once": candidates whose key already has a running job are
 * skipped. To close the race where another claimer is mid-commit with the same key, each keyed
 * candidate also takes a transaction-scoped advisory lock (held until commit, when 'running'
 * becomes visible), and the UPDATE re-checks running keys with a fresh READ COMMITTED snapshot.
 *
 * Exception (re-eval, supersedes_running = true): a running job whose cancel was requested (W2)
 * doesn't block its successor, so the restart with the latest state starts at once; the old job's
 * writes are fenced on the generation anyway (W3).
 */
export async function claimJobs(opts: ClaimOptions): Promise<ClaimedJob[]> {
  const db = opts.db ?? getDb();
  const limit = opts.limit ?? 1;
  const queues = opts.queues ?? ['default'];
  const queueList = sql.join(
    queues.map((q) => sql`${q}`),
    sql`, `,
  );
  try {
    return await db.transaction(async (tx) => {
      const picked = await tx.execute<{ id: string }>(sql`
        with candidates as materialized (
          select j.id, j.dedupe_key
            from jobs j
           where j.status = 'queued' and j.run_at <= now() and j.queue in (${queueList}) and j.owner_user_id = ${opts.ownerUserId}
             and (j.dedupe_key is null or not exists (
                   select 1 from jobs r where r.dedupe_key = j.dedupe_key and r.status = 'running'
                    and not (j.supersedes_running and r.cancel_requested_at is not null)))
           order by j.priority desc, j.run_at, j.id
           limit ${limit}
           for update skip locked
        )
        select id from candidates
         where dedupe_key is null or pg_try_advisory_xact_lock(hashtextextended('cc.job:' || dedupe_key, 0))`);
      if (!picked.rows.length) return [];
      const ids = sql.join(
        picked.rows.map((r) => sql`${r.id}::bigint`),
        sql`, `,
      );
      const claimed = await tx.execute<ClaimedJob>(sql`
        update jobs j
           set status           = 'running',
               attempts         = j.attempts + 1,
               locked_by        = ${opts.workerId},
               locked_at        = now(),
               heartbeat_at     = now(),
               started_at       = now(),
               lease_expires_at = now() + make_interval(secs => j.timeout_seconds),
               updated_at       = now()
         where j.id in (${ids})
           and (j.dedupe_key is null or not exists (
                 select 1 from jobs r where r.dedupe_key = j.dedupe_key and r.status = 'running'
                    and not (j.supersedes_running and r.cancel_requested_at is not null)))
        returning j.*`);
      return claimed.rows;
    });
  } catch (e) {
    throw mapPgError(e);
  }
}

export interface NewInfoResult {
  workItemId: string;
  /** The generation the re-eval must fence its writes on (W3). */
  generation: number;
  jobId: number;
  /** Running re-evals asked to cancel (pg_notify('cc_job_cancel') fires for each). */
  cancelledRunning: number;
}

/**
 * W2. New info is saved first (by the caller, in this same transaction); this bumps the item's
 * reeval_generation / last_new_info_at / unseen_evidence_count, requests cancellation of a running
 * re-eval for the item, and enqueues (or coalesces into) the queued one with a debounce.
 * Must run inside withChangeSet(): it updates work_items.
 */
export async function recordNewInfo(
  tx: DbOrTx,
  workItemId: string,
  opts: { debounceSeconds?: number; queue?: string } = {},
): Promise<NewInfoResult> {
  try {
    const res = await tx.execute<{ id: string; generation: string; cancelled_running: string }>(sql`
      with bumped as (
        update work_items
           set reeval_generation     = reeval_generation + 1,
               last_new_info_at      = now(),
               unseen_evidence_count = unseen_evidence_count + 1
         where id = ${workItemId}
        returning id, owner_user_id, reeval_generation
      ),
      cancelled as (
        update jobs j
           set cancel_requested_at = now(),
               cancel_reason       = 'superseded by generation ' || b.reeval_generation
          from bumped b
         where j.dedupe_key = 'reeval:work_item:' || b.id
           and j.status = 'running' and j.cancel_requested_at is null
        returning j.id
      )
      insert into jobs (owner_user_id, queue, kind, payload, dedupe_key, generation, supersedes_running, run_at)
      select b.owner_user_id, ${opts.queue ?? 'engine'}, 'reevaluate', jsonb_build_object('work_item_id', b.id),
             'reeval:work_item:' || b.id, b.reeval_generation, true, now() + make_interval(secs => ${opts.debounceSeconds ?? 2})
        from bumped b
      on conflict (dedupe_key) where status = 'queued'
      do update set generation = excluded.generation,
                    run_at     = excluded.run_at,
                    updated_at = now()
      returning id, generation, (select count(*) from cancelled) as cancelled_running`);
    const row = res.rows[0];
    if (!row) throw new NotFoundError('work_items', workItemId);
    return {
      workItemId,
      generation: Number(row.generation),
      jobId: Number(row.id),
      cancelledRunning: Number(row.cancelled_running),
    };
  } catch (e) {
    throw mapPgError(e);
  }
}

