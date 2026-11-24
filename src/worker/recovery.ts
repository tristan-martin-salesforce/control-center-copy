/**
 * What a worker that stopped without draining (SIGKILL, a crash, the Mac losing power) left behind, put right when the
 * next worker starts (holistic review 2026-11-20 ask #14; docs/EDGE-CASES.md "Worker"). The single-instance lock is
 * held when this runs, so nothing it touches belongs to a live process.
 *
 *   jobs      `running` rows locked by a worker on this Mac whose process is gone: their lease ends now, so the
 *             reaper puts them back at once (an Outbox delivery is never re-sent: the reaper resolves it), instead of
 *             after the 90 s lease. Their worker_instances row is closed (`killed`).
 *   runs      `running` scan runs: what their model calls cost (the `pass` rows that reached the database and no
 *             llm_calls row books yet, and the `turn` rows of an Agent SDK query that never reached its end `pass`
 *             row, each made a `pass` row first) is booked once on the run; the run is closed `cancelled`. Its staged coverage
 *             was in the dead process only, so the cursor never covered it: the window is read again.
 *   holds     open spend holds of the dead runs and jobs stop holding today's money (`abandoned`, with what they
 *             spent: a scan run's from its `pass` rows, which name the hold), instead of holding it for 6 h until the sweep.
 *   Health    one row per interrupted scope ("Inbox: a scan stopped when the app closed; it picks up where it left
 *             off"), closed with "picked up" when that scope's next run succeeds (`closeInterruptedEvent`).
 *
 * Never throws for one bad row: each step is its own try, and a failure is logged with its code.
 */
import { hostname } from 'node:os';

import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { ledgerHash } from '@/lib/ledger-hash';
import { LLM_JOB_KINDS } from '@/llm/spend/day-gate';
import { pidAlive } from '@/ops/lifecycle';
import { scopeLabel } from '@/scanner/runtime/status-reason';
import type { DbScannerStore } from '@/scanner/store-db';
import { dbSpendGovernor } from '@/server/datasource/db/spend';
import type { ConnectorId } from '@/scanner/types';

/** app_events code of an interrupted scan (component `worker`, one open row per scope). */
export const SCAN_INTERRUPTED = 'WORKER.SCAN_INTERRUPTED';
/** app_events code of other background jobs a stop interrupted (one open row, counted). */
export const JOBS_INTERRUPTED = 'WORKER.JOBS_INTERRUPTED';
/** scan_runs.error_message of a run its worker never finished (unchanged since W-3). */
export const INTERRUPTED_RUN_MESSAGE = 'worker stopped before the run finished';

export const interruptedFingerprint = (scopeId: string) => `worker|${SCAN_INTERRUPTED}|${scopeId}`;

export interface RecoveryOptions {
  db: Db;
  userId: string;
  /** This worker's id (`host:pid:uuid`): its own rows are never touched. */
  workerId: string;
  store: DbScannerStore;
  clock?: () => Date;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
  /** Tests: this Mac's name and the pid check. */
  host?: string;
  alive?: (pid: number) => boolean;
}

export interface RecoveryReport {
  /** Scan runs closed. */
  runs: number;
  /** Their scopes (`gmail:inbox`). */
  scopes: string[];
  /** Jobs whose dead worker's lease was ended (the reaper re-queues them). */
  jobs: number;
  /** Spend holds released. */
  holds: number;
  /** Model spend of the dead runs booked now (USD). */
  bookedUsd: number;
}

/** `host:pid:uuid` → the pid when the worker ran on this Mac. */
export function pidOfWorker(workerId: string | null | undefined, host: string): number | null {
  const m = /^(.+):(\d+):[0-9a-f-]{8,}$/i.exec(workerId ?? '');
  if (!m || m[1] !== host) return null;
  const pid = Number(m[2]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The Health row's words for an interrupted scope. */
export function interruptedMessage(connector: ConnectorId, scope: string, done = false): string {
  return `${scopeLabel(connector, scope)}: a scan stopped when the app closed; it ${done ? 'picked' : 'picks'} up where it left off.`;
}

export async function recoverInterruptedWork(o: RecoveryOptions): Promise<RecoveryReport> {
  const now = o.clock?.() ?? new Date();
  const log = o.log ?? (() => undefined);
  const report: RecoveryReport = { runs: 0, scopes: [], jobs: 0, holds: 0, bookedUsd: 0 };
  await step(log, 'jobs', async () => {
    report.jobs = await endDeadLeases(o);
  });
  await step(log, 'runs', async () => {
    const r = await closeInterruptedRuns(o, now);
    report.runs = r.runs;
    report.scopes = r.scopes;
    report.bookedUsd = r.bookedUsd;
  });
  await step(log, 'holds', async () => {
    report.holds = await releaseDeadHolds(o, now);
  });
  if (report.runs || report.jobs || report.holds) log('recovered what a stopped worker left', { ...report, scopes: report.scopes.length });
  return report;
}

async function step(log: NonNullable<RecoveryOptions['log']>, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`recovery step ${name} failed`, { code: (err as { code?: string }).code ?? (err as Error)?.name ?? 'error' });
  }
}

/** Jobs a dead worker on this Mac held: their leases end now (the reaper re-queues them on its next pass). */
async function endDeadLeases(o: RecoveryOptions): Promise<number> {
  const host = o.host ?? hostname();
  const alive = o.alive ?? pidAlive;
  const isDead = (id: string | null) => {
    const pid = pidOfWorker(id, host);
    return pid !== null && !alive(pid);
  };
  // the worker rows of this Mac's dead workers stop reading as running (their last beat stays as it was)
  const inst = await o.db.execute<{ id: string }>(sql`select id from worker_instances where role = 'worker' and stopped_at is null and id <> ${o.workerId}`);
  const deadWorkers = inst.rows.map((x) => x.id).filter(isDead);
  if (deadWorkers.length) {
    await o.db.execute(sql`update worker_instances set stopped_at = now(), stop_reason = 'killed: stopped without draining'
                            where stopped_at is null and id in (${sql.join(deadWorkers.map((w) => sql`${w}`), sql`, `)})`);
  }
  const r = await o.db.execute<{ id: string; locked_by: string; kind: string }>(sql`
    select id::text, locked_by, kind from jobs where owner_user_id = ${o.userId} and status = 'running' and locked_by is not null and locked_by <> ${o.workerId}`);
  const dead = r.rows.filter((j) => isDead(j.locked_by));
  if (!dead.length) return 0;
  await o.db.execute(sql`update jobs set lease_expires_at = now() - interval '1 second', updated_at = now()
                          where id in (${sql.join(dead.map((j) => sql`${Number(j.id)}::bigint`), sql`, `)}) and status = 'running'`);
  const other = dead.filter((j) => !j.kind.startsWith('scan.')).length;
  if (other) await jobsEvent(o.db, o.userId, other);
  return dead.length;
}

/**
 * Scan runs a stopped worker left `running`: book what their model calls cost (once), close them, one Health row per
 * scope. Also what `dropStalePlans` runs at every start (W-3), so a start without this module still closes them.
 */
export async function closeInterruptedRuns(o: Pick<RecoveryOptions, 'db' | 'userId' | 'store' | 'log'>, now: Date): Promise<{ runs: number; scopes: string[]; bookedUsd: number }> {
  const runs = await o.db.execute<{ id: string; scope: string; connector: string; budget: string | null }>(sql`
    select r.id, r.scope, c.name as connector,
           (select e.payload->>'budget' from scan_run_events e where e.run_id = r.id and e.kind = 'plan' order by e.seq limit 1) as budget
      from scan_runs r join connectors c on c.id = r.connector_id
     where r.owner_user_id = ${o.userId} and r.status = 'running'`);
  if (!runs.rows.length) return { runs: 0, scopes: [], bookedUsd: 0 };
  let bookedUsd = 0;
  for (const run of runs.rows) {
    try {
      bookedUsd += await bookUnbookedPasses(o, run);
    } catch (err) {
      o.log?.('booking an interrupted run\'s spend failed', { runId: run.id, code: (err as { code?: string }).code ?? (err as Error)?.name ?? 'error' });
    }
  }
  await withChangeSet({ db: o.db, userId: o.userId, actor: actors.system('worker-start'), reason: 'close scan runs of a stopped worker' }, async (tx) => {
    await tx.execute(sql`
      update scan_runs set status = 'cancelled', finished_at = ${now.toISOString()}::timestamptz, error_code = 'aborted',
             error_message = ${INTERRUPTED_RUN_MESSAGE}, error_count = error_count + 1
       where owner_user_id = ${o.userId} and status = 'running' and id in (${sql.join(runs.rows.map((r) => sql`${r.id}::uuid`), sql`, `)})`);
  });
  const scopes = [...new Set(runs.rows.map((r) => r.scope))];
  for (const sid of scopes) {
    const run = runs.rows.find((r) => r.scope === sid)!;
    const scope = sid.startsWith(`${run.connector}:`) ? sid.slice(run.connector.length + 1) : sid;
    await interruptedEvent(o.db, o.userId, run.connector as ConnectorId, scope, sid, runs.rows.filter((r) => r.scope === sid).length).catch((err: unknown) =>
      o.log?.('writing the interrupted-scan event failed', { code: (err as { code?: string }).code ?? (err as Error)?.name ?? 'error' }),
    );
  }
  return { runs: runs.rows.length, scopes, bookedUsd: Math.round(bookedUsd * 1e6) / 1e6 };
}

/**
 * The model calls a dead run made: its `pass` rows that no llm_calls row books yet, booked through the store (the
 * same split the end of a run does, one row per pass with its own tokens and hash). A second recovery finds none.
 *
 * P34-3: the read and the store's insert are separate statements, so two workers of one user starting together would
 * both see the passes unbooked. A per-run advisory lock, held in a transaction that stays open until the booking has
 * committed, makes the second wait and then find them booked. Not a unique index on `llm_calls.request_hash`: the
 * hash is not unique by design across purposes, an install may already hold this race's duplicates (the index would
 * fail its migration), and the insert lives in the store's shared spend path.
 */
async function bookUnbookedPasses(o: Pick<RecoveryOptions, 'db' | 'store'>, run: { id: string; connector: string; budget: string | null }): Promise<number> {
  return o.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cc.recovery.book:${run.id}`}))`);
    return bookUnbookedPassesLocked(o, run);
  });
}

async function bookUnbookedPassesLocked(o: Pick<RecoveryOptions, 'db' | 'store'>, run: { id: string; connector: string; budget: string | null }): Promise<number> {
  await passRowsOfInterruptedQueries(o.db, run.id);
  const r = await o.db.execute<{ usd: string | null; model: string | null; input: string | null; output: string | null; cread: string | null; cwrite: string | null }>(sql`
    select sum((e.payload->>'costUsd')::numeric)::text as usd, min(e.payload->>'model') as model,
           sum(coalesce((e.payload->>'inputTokens')::numeric, 0))::text as input, sum(coalesce((e.payload->>'outputTokens')::numeric, 0))::text as output,
           sum(coalesce((e.payload->>'cacheReadTokens')::numeric, 0))::text as cread, sum(coalesce((e.payload->>'cacheWriteTokens')::numeric, 0))::text as cwrite
      from scan_run_events e
     where e.run_id = ${run.id}::uuid and e.kind = 'pass' and coalesce((e.payload->>'costUsd')::numeric, 0) > 0
       and not exists (select 1 from llm_calls c where c.request_hash = concat('pass:', e.run_id::text, ':', e.seq))`);
  const usd = Number(r.rows[0]?.usd ?? 0);
  if (!(usd > 0)) return 0;
  const row = r.rows[0]!;
  await o.store.recordSpend({
    connector: run.connector as ConnectorId,
    model: row.model ?? 'unknown',
    costUsd: usd,
    runId: run.id,
    budget: run.budget === 'first_scan' ? 'first_scan' : 'daily',
    inputTokens: Number(row.input ?? 0),
    outputTokens: Number(row.output ?? 0),
    cacheReadTokens: Number(row.cread ?? 0),
    cacheWriteTokens: Number(row.cwrite ?? 0),
    trigger: 'recovery',
    modelReason: 'default',
    outcome: 'interrupted',
    contentHash: ledgerHash('interrupted-run', run.id),
  });
  return usd;
}

/**
 * Ask #14 (WK-15): an Agent SDK query killed mid-way traced each paid request as a `turn` row (src/llm/skill-runner.turns.ts)
 * and never its end `pass` row. Each such turn becomes a `pass` row (same payload, `interrupted`), in one statement,
 * so the booking below books it once like any other pass; a query with a `pass` row of its key (`q`) is left alone,
 * which is also what makes a second recovery add nothing.
 */
async function passRowsOfInterruptedQueries(db: Db, runId: string): Promise<void> {
  await db.execute(sql`
    insert into scan_run_events (run_id, seq, ts, kind, payload)
    select t.run_id, m.top + row_number() over (order by t.seq), now(), 'pass', t.payload || jsonb_build_object('interrupted', true, 'turnSeq', t.seq)
      from scan_run_events t
     cross join (select coalesce(max(seq), 0) as top from scan_run_events where run_id = ${runId}::uuid) m
     where t.run_id = ${runId}::uuid and t.kind = 'turn' and coalesce((t.payload->>'costUsd')::numeric, 0) > 0
       and not exists (select 1 from scan_run_events p where p.run_id = t.run_id and p.kind = 'pass' and p.payload->>'q' = t.payload->>'q')
    on conflict (run_id, seq) do nothing`);
}

/**
 * Open holds of what died: a scan run's (only the worker runs scans, and this one has started none yet) and a model
 * job's whose job is no longer running under a live lease. Settled `abandoned` with what they had spent; asked and approved holds wait for the user and the
 * 6 h sweep, and the first scan's own envelope is never touched.
 */
async function releaseDeadHolds(o: RecoveryOptions, now: Date): Promise<number> {
  const gov = dbSpendGovernor({ db: o.db, userId: o.userId, clock: () => now });
  const open = await gov.store.listHolds({ states: ['open'], limit: 500 });
  const gateKey = /^([a-z0-9_.]+):(\d+)$/i;
  const jobIds = open.flatMap((h) => {
    const m = gateKey.exec(h.jobKey);
    return m && LLM_JOB_KINDS[m[1]!] ? [Number(m[2])] : [];
  });
  const live = new Set<number>();
  if (jobIds.length) {
    const r = await o.db.execute<{ id: string }>(sql`select id::text from jobs where id in (${sql.join(jobIds.map((i) => sql`${i}::bigint`), sql`, `)}) and status = 'running' and lease_expires_at > now()`);
    for (const x of r.rows) live.add(Number(x.id));
  }
  // a scan run's hold saw its spend in memory only: what it spent is what its pass rows (booked above) say
  const scanHolds = open.filter((h) => h.scope === 'scan_run');
  const spentOf = new Map<string, number>();
  if (scanHolds.length) {
    // the runs this start closed as interrupted (the step before): only they can have spent against an open hold
    const since = new Date(now.getTime() - 3_600_000).toISOString();
    const r = await o.db.execute<{ hold: string; usd: string }>(sql`
      select e.payload->>'hold' as hold, sum((e.payload->>'costUsd')::numeric)::text as usd
        from scan_run_events e join scan_runs r on r.id = e.run_id
       where r.owner_user_id = ${o.userId} and r.status = 'cancelled' and r.error_message = ${INTERRUPTED_RUN_MESSAGE}
         and r.finished_at >= ${since}::timestamptz and e.kind = 'pass'
         and e.payload->>'hold' in (${sql.join(scanHolds.map((h) => sql`${h.id}`), sql`, `)})
       group by 1`);
    for (const x of r.rows) spentOf.set(x.hold, Number(x.usd));
  }
  let n = 0;
  for (const h of open) {
    if (h.jobKey === 'first_scan') continue;
    const m = gateKey.exec(h.jobKey);
    const dead = h.scope === 'scan_run' || (m && LLM_JOB_KINDS[m[1]!] && !live.has(Number(m[2])));
    if (!dead) continue;
    await gov.settle(h, Math.max(h.spentUsd, spentOf.get(h.id) ?? 0), 'abandoned');
    n += 1;
  }
  return n;
}

/** One open Health row per interrupted scope; a second interruption before it closes counts on the same row. */
async function interruptedEvent(db: Db, userId: string, connector: ConnectorId, scope: string, sid: string, runs: number): Promise<void> {
  await db.execute(sql`
    insert into app_events (owner_user_id, severity, component, code, message, entity_type, entity_id, detail, fingerprint)
    values (${userId}, 'info', 'worker', ${SCAN_INTERRUPTED}, ${interruptedMessage(connector, scope)}, 'scope', ${sid},
            ${JSON.stringify({ runs, suggestedAction: 'Nothing to do: the window is read again on the next pass.' })}::jsonb, ${interruptedFingerprint(sid)})
    on conflict (fingerprint) where resolved_at is null
    do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now()`);
}

async function jobsEvent(db: Db, userId: string, jobs: number): Promise<void> {
  await db.execute(sql`
    insert into app_events (owner_user_id, severity, component, code, message, detail, fingerprint)
    values (${userId}, 'info', 'worker', ${JOBS_INTERRUPTED}, ${`${jobs === 1 ? 'A background job' : `${jobs} background jobs`} stopped when the app closed; ${jobs === 1 ? 'it runs' : 'they run'} again now.`},
            ${JSON.stringify({ jobs, suggestedAction: 'Nothing to do.' })}::jsonb, ${`worker|${JOBS_INTERRUPTED}`})
    on conflict (fingerprint) where resolved_at is null
    do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), message = excluded.message`);
}

/** The scope's next run succeeded: its interrupted-scan row says so and closes. Never throws. */
export async function closeInterruptedEvent(db: Db, userId: string, connector: ConnectorId, scope: string): Promise<boolean> {
  const sid = `${connector}:${scope}`;
  const r = await db
    .execute(sql`
      update app_events set resolved_at = now(), message = ${interruptedMessage(connector, scope, true)}, last_occurred_at = now()
       where owner_user_id = ${userId} and fingerprint = ${interruptedFingerprint(sid)} and resolved_at is null`)
    .catch(() => null);
  return (r?.rowCount ?? 0) > 0;
}
