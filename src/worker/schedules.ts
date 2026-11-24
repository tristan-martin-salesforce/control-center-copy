/**
 * Maintenance schedules over `job_schedules` (DATA-MODEL §4.5 "Schedules"). Scan cadence is NOT here: the BE-2a
 * ScannerRuntime plans scans itself (SCANNER.md §5: cadence, ×6 off-hours, adaptive backoff, budget pause,
 * resume = head first then backfill). These are the nightly jobs:
 *
 *   retention.scrub    03:15 local   run_once catch-up (a laptop asleep at 03:15 scrubs on wake)
 *   backup.nightly     02:30 local   run_once; the handler still checks backupDue()
 *   missed_opps.sweep  06:00 local   stub until BE-5 wires it (schedule disabled: paused_reason 'not_wired')
 *   brief.generate     07:30 local   run_once: watched-channel briefs (the Watches form's "Daily 7:30"); the handler
 *                                    briefs only the watches that are due, so a catch-up run never repeats a brief
 *   activity.sync      17:30 local   Settings > Time > Logging > `autoAt` (default 17:30): the worker moves the slot when it changes
 *   hygiene.sweep      04:10 local   run_once: the dead-data sweep (HYG-1; the worker also queues one at start)
 *   org62.readback     06:40 local   run_once: re-read my logged Events and my DCs by Id (edits, deletions; HYG-1)
 *   vdp.specialist_aes 06:50 local   run_once: who each VDP's AE is, from my 100%-DC opps' Specialist Forecasts (D-63)
 *   accounts.hierarchy 06:55 local   run_once: the Org62 account hierarchy up to five levels, a full refresh (D-69)
 *   doctor.checks      every 15 min  the setup checks (11 R6), and once right after every worker start; an interval
 *                                    row (`everyMinutes`), the one schedule that is not a daily slot
 *   attribution.opp_engagement 02:50 local   run_once: the opp_engagement rollup, then the DC suggestion batch
 *   org62.discover     06:35 local   run_once: open opps of my teams, my covered AEs and engaged accounts (cadence: Settings ▸ Time)
 *   attribution.dc_suggest 06:45 local   run_once: the DC suggestion batch, after the book read
 *   resolution.sweep   03:40 local   run_once: the resolution check's nightly sweep (H-7)
 *   priority.feedback  03:50 local   run_once: priority@2's learning pass (per-term agreement → at most one suggested rule),
 *                                    after the resolution sweep (W12-6)
 *   priority.rerank    06:55 local   run_once: the morning re-rank (start-bys roll to the new day), after the 02:50 rollup
 *                                    and the 06:45 DC suggestions it reads (W12-6); the rest of the day re-ranks when
 *                                    inputs change (src/jobs/handlers/rerank.ts, debounced 60 s)
 *   update.check       09:05 local   run_once: D-90, one read of the release feed in the shared Drive folder
 *   use_cases.extract  03:05 local   run_once: the nightly sweep for use cases to add (also queued after scans land)
 *
 * Catch-up policies: `run_once` enqueues one job however many runs were missed; `skip_missed` enqueues nothing
 * when the slot is more than one interval old; both then move next_run_at to the next local slot.
 */
import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import type { JobRegistry } from '@/jobs/registry';
import { nextLocalTime } from '@/lib/local-time';

/** The slot math lives in the shared layer so the brief engine can use it (CONTRIBUTING "Where code goes"). */
export { nextLocalTime };

export interface MaintenanceSchedule {
  key: string;
  kind: string;
  /** "HH:MM" in the user's time zone. */
  atLocal: string;
  catchUp: 'run_once' | 'skip_missed';
  payload?: Record<string, unknown>;
  priority?: number;
  /** An interval schedule instead of a daily slot (`atLocal` is then unused): due again this many minutes after it ran. */
  everyMinutes?: number;
}

export const DEFAULT_MAINTENANCE: MaintenanceSchedule[] = [
  { key: 'backup.nightly', kind: 'backup.nightly', atLocal: '02:30', catchUp: 'run_once' },
  { key: 'retention.scrub', kind: 'retention.scrub', atLocal: '03:15', catchUp: 'run_once' },
  { key: 'data.retention', kind: 'data.retention', atLocal: '03:45', catchUp: 'run_once' }, // the retention policy (src/db/retention); skips while a scan or settle job runs
  { key: 'missed_opps.sweep', kind: 'missed_opps.sweep', atLocal: '06:00', catchUp: 'run_once' },
  { key: 'brief.generate', kind: 'brief.generate', atLocal: '07:30', catchUp: 'run_once' },
  { key: 'activity.sync', kind: 'activity.sync', atLocal: '17:30', catchUp: 'run_once' },
  { key: 'forecast.sync', kind: 'forecast.sync', atLocal: '07:15', catchUp: 'run_once' }, // lane A: Specialist Forecasts (skips unless the persona feature is on)
  { key: 'hygiene.sweep', kind: 'hygiene.sweep', atLocal: '04:10', catchUp: 'run_once' }, // HYG-1: dead-data sweep (also at every worker start)
  { key: 'org62.readback', kind: 'org62.readback', atLocal: '06:40', catchUp: 'run_once' }, // HYG-1: re-read my logged Events and DCs by Id
  { key: 'vdp.specialist_aes', kind: 'vdp.specialist_aes', atLocal: '06:50', catchUp: 'run_once', payload: { trigger: 'daily' } }, // D-63: who each VDP's AE is (a full refresh)
  { key: 'accounts.hierarchy', kind: 'accounts.hierarchy', atLocal: '06:55', catchUp: 'run_once', payload: { trigger: 'daily' } }, // D-69: the Org62 account hierarchy (a full refresh)
  { key: 'doctor.checks', kind: 'doctor.checks', atLocal: '00:00', catchUp: 'run_once', everyMinutes: 15 }, // 11 R6: setup checks every 15 min and after start
  { key: 'resolution.sweep', kind: 'resolution.check', atLocal: '03:40', catchUp: 'run_once', payload: { trigger: 'sweep' } }, // H-7: the resolution check's nightly sweep (no check in 7 days, gone quiet)
  { key: 'attribution.opp_engagement', kind: 'attribution.opp_engagement', atLocal: '02:50', catchUp: 'run_once', payload: { trigger: 'nightly' } }, // attribution engine: the engagement rollup + the DC batch
  { key: 'org62.discover', kind: 'org62.discover', atLocal: '06:35', catchUp: 'run_once', payload: { trigger: 'daily' } }, // attribution engine: live Org62 discovery (the handler honours Settings ▸ Time ▸ discovery: daily, weekly, off)
  { key: 'attribution.dc_suggest', kind: 'attribution.dc_suggest', atLocal: '06:45', catchUp: 'run_once', payload: { trigger: 'daily' } }, // attribution engine: the daily DC suggestion batch
  { key: 'priority.feedback', kind: 'priority.feedback', atLocal: '03:50', catchUp: 'run_once' }, // priority@2 R8: the nightly learning pass (no model call)
  { key: 'priority.rerank', kind: 'priority.rerank', atLocal: '06:55', catchUp: 'run_once', payload: { trigger: 'schedule' } }, // priority@2 R4: the morning re-rank
  { key: 'update.check', kind: 'update.check', atLocal: '09:05', catchUp: 'run_once', payload: { trigger: 'daily' } }, // D-90: read the release feed in the Drive folder (read-only)
  { key: 'use_cases.extract', kind: 'use_cases.extract', atLocal: '03:05', catchUp: 'run_once', payload: { trigger: 'nightly' } }, // use cases to add: the nightly sweep (the spend governor holds its model calls)
];

/** The cron text of a spec: "M H * * *" for a daily slot, "*\/N * * * *" for an interval row. */
const cronOf = (s: MaintenanceSchedule) => (s.everyMinutes ? `*/${s.everyMinutes} * * * *` : cron(s.atLocal));
/** The first run of a spec after `now`: an interval row is due now (the worker just started), a slot at its next time. */
const firstRunOf = (s: MaintenanceSchedule, now: Date, timeZone: string) => (s.everyMinutes ? now : nextLocalTime(now, s.atLocal, timeZone));

const cron = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${m} ${h} * * *`;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const AUTO_AT_KEY = 'activity.sync';

/** Settings > Time > Logging > `autoAt` as stored for the user ("HH:MM"), or null when unset or malformed (the default slot stays). */
export async function loggingAutoAt(db: Db, userId: string): Promise<string | null> {
  const r = await db.execute<{ at: string | null }>(sql`select value->'logging'->>'autoAt' as at from user_settings where owner_user_id = ${userId} and key = 'settings.time'`);
  const at = r.rows[0]?.at ?? null;
  return at && HHMM.test(at) ? at : null;
}

/** The specs with `activity.sync` moved to the user's `autoAt` (the setting is the one source of that slot). */
export function withAutoAt(specs: readonly MaintenanceSchedule[], autoAt: string | null): MaintenanceSchedule[] {
  return autoAt ? specs.map((s) => (s.key === AUTO_AT_KEY ? { ...s, atLocal: autoAt } : s)) : [...specs];
}

/** "M H * * *" back to "HH:MM" (the rows only ever hold daily slots written by `cron`). */
const atOfCron = (expr: string): string | null => {
  const m = /^(\d+) (\d+) \* \* \*$/.exec(expr.trim());
  return m ? `${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}` : null;
};

/** Upsert the schedule rows. Unwired (stub) kinds stay disabled with paused_reason 'not_wired'. */
export async function ensureSchedules(db: Db, userId: string, registry: JobRegistry, timeZone: string, now: Date, specs0 = DEFAULT_MAINTENANCE): Promise<void> {
  const specs = withAutoAt(specs0, await loggingAutoAt(db, userId));
  await withChangeSet({ db, userId, actor: actors.system('scheduler'), reason: 'ensure maintenance schedules', undoable: false }, async (tx) => {
    for (const s of specs) {
      const def = registry.get(s.kind);
      if (!def) continue;
      const wired = def.wired;
      await tx.execute(sql`
        insert into job_schedules (owner_user_id, key, kind, queue, payload, cron_expr, timezone, catch_up, priority, enabled, paused_reason, next_run_at)
        values (${userId}, ${s.key}, ${s.kind}, ${def.queue}, ${JSON.stringify(s.payload ?? {})}::jsonb, ${cronOf(s)}, ${timeZone},
                ${s.catchUp}, ${s.priority ?? 0}, ${wired}, ${wired ? null : 'not_wired'}, ${firstRunOf(s, now, timeZone).toISOString()}::timestamptz)
        on conflict (owner_user_id, key) do update set
          kind = excluded.kind, queue = excluded.queue, cron_expr = excluded.cron_expr, catch_up = excluded.catch_up,
          enabled = excluded.enabled,
          paused_reason = case when excluded.enabled then (case when job_schedules.paused_reason = 'not_wired' then null else job_schedules.paused_reason end)
                               else 'not_wired' end,
          timezone = excluded.timezone,
          next_run_at = case when job_schedules.timezone is distinct from excluded.timezone or job_schedules.cron_expr is distinct from excluded.cron_expr
                             then excluded.next_run_at else job_schedules.next_run_at end
        where job_schedules.kind is distinct from excluded.kind or job_schedules.queue is distinct from excluded.queue
           or job_schedules.cron_expr is distinct from excluded.cron_expr or job_schedules.catch_up is distinct from excluded.catch_up
           or job_schedules.enabled is distinct from excluded.enabled or job_schedules.timezone is distinct from excluded.timezone
           or (excluded.enabled and job_schedules.paused_reason = 'not_wired')`);
      // an interval row runs right after every worker start ("after start"), not only 15 minutes later
      if (s.everyMinutes && wired) {
        await tx.execute(sql`update job_schedules set next_run_at = ${now.toISOString()}::timestamptz
                              where owner_user_id = ${userId} and key = ${s.key} and next_run_at > ${now.toISOString()}::timestamptz`);
      }
    }
  });
}

/**
 * The user changed `autoAt` while the worker runs: move the `activity.sync` row to the new slot (cron and next run) at the
 * next tick. A row that already holds the slot is left alone (one cheap read, no write).
 */
export async function syncAutoAtSlot(db: Db, userId: string, now: Date): Promise<boolean> {
  const at = await loggingAutoAt(db, userId);
  if (!at) return false;
  const row = await db.execute<{ cron_expr: string; timezone: string }>(sql`select cron_expr, timezone from job_schedules where owner_user_id = ${userId} and key = ${AUTO_AT_KEY}`);
  const cur = row.rows[0];
  if (!cur || cur.cron_expr === cron(at)) return false;
  await withChangeSet({ db, userId, actor: actors.system('scheduler'), reason: 'logging time (autoAt) changed', undoable: false }, async (tx) => {
    await tx.execute(sql`update job_schedules set cron_expr = ${cron(at)}, next_run_at = ${nextLocalTime(now, at, cur.timezone).toISOString()}::timestamptz
                          where owner_user_id = ${userId} and key = ${AUTO_AT_KEY}`);
  });
  return true;
}

/** Enqueue due schedules (one job each, coalesced on `sched:<key>`) and move them to their next local slot. */
export async function tickSchedules(db: Db, userId: string, now: Date, specs = DEFAULT_MAINTENANCE): Promise<string[]> {
  await syncAutoAtSlot(db, userId, now);
  const due = await db.execute<{ id: string; key: string; kind: string; queue: string; payload: Record<string, unknown>; timezone: string; catch_up: string; next_run_at: string; priority: number; cron_expr: string }>(sql`
    select id, key, kind, queue, payload, timezone, catch_up, next_run_at, priority, cron_expr from job_schedules
     where owner_user_id = ${userId} and enabled and paused_reason is null and next_run_at <= ${now.toISOString()}::timestamptz
     order by next_run_at limit 50`);
  if (!due.rows.length) return [];
  const enqueued: string[] = [];
  await withChangeSet({ db, userId, actor: actors.system('scheduler'), reason: `schedules due: ${due.rows.length}`, undoable: false }, async (tx) => {
    for (const s of due.rows) {
      const spec = specs.find((x) => x.key === s.key);
      const at = atOfCron(s.cron_expr) ?? spec?.atLocal ?? '03:00';
      const every = spec?.everyMinutes ?? Number(/^\*\/(\d+) \* \* \* \*$/.exec(s.cron_expr)?.[1] ?? NaN);
      const overdueMs = now.getTime() - new Date(s.next_run_at).getTime();
      const skip = s.catch_up === 'skip_missed' && overdueMs > 86_400_000;
      let jobId: number | null = null;
      if (!skip) {
        const r = await enqueueJob(tx, {
          ownerUserId: userId,
          kind: s.kind,
          queue: s.queue,
          payload: { ...s.payload, scheduleKey: s.key, slot: new Date(s.next_run_at).toISOString() },
          dedupeKey: `sched:${s.key}`,
          scheduleId: s.id,
          priority: s.priority,
        });
        jobId = r.id;
        enqueued.push(s.key);
      }
      await tx.execute(sql`
        update job_schedules set next_run_at = ${(Number.isFinite(every) && every > 0 ? new Date(now.getTime() + every * 60_000) : nextLocalTime(now, at, s.timezone)).toISOString()}::timestamptz,
               last_enqueued_at = case when ${jobId}::bigint is null then last_enqueued_at else ${now.toISOString()}::timestamptz end,
               last_job_id = coalesce(${jobId}::bigint, last_job_id)
         where id = ${s.id}`);
    }
  });
  return enqueued;
}
