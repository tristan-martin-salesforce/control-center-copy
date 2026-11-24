import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import { createDefaultRegistry } from '@/jobs';
import { WorkerRuntime } from '@/worker/runtime';
import { ensureSchedules, nextLocalTime, tickSchedules } from '@/worker/schedules';

import { createUser, openTestDb, setUserSetting, uid } from './helpers';

const h = openTestDb(4);
const db = h.db;
let userId: string;
beforeAll(async () => {
  userId = await createUser(db, 'sched');
});
afterAll(() => h.close());

describe('maintenance schedules', () => {
  it('nextLocalTime handles the user time zone and DST', () => {
    // America/Denver: MDT (UTC-6) until 2026-11-01 02:00 local, MST (UTC-7) after.
    expect(nextLocalTime(new Date('2026-10-30T12:00:00Z'), '03:15', 'America/Denver').toISOString()).toBe('2026-10-31T09:15:00.000Z');
    expect(nextLocalTime(new Date('2026-10-31T12:00:00Z'), '03:15', 'America/Denver').toISOString()).toBe('2026-11-01T10:15:00.000Z');
    expect(nextLocalTime(new Date('2026-11-01T12:00:00Z'), '03:15', 'America/Denver').toISOString()).toBe('2026-11-02T10:15:00.000Z');
    expect(nextLocalTime(new Date('2026-11-02T10:15:00Z'), '03:15', 'America/Denver').toISOString()).toBe('2026-11-03T10:15:00.000Z');
  });

  it('wired kinds are enabled, stubs stay disabled; a slept-through slot runs once on wake (run_once)', async () => {
    const registry = createDefaultRegistry();
    const now = new Date();
    await ensureSchedules(db, userId, registry, 'America/Denver', now);
    const rows = await db.execute<{ key: string; enabled: boolean; paused_reason: string | null; cron_expr: string }>(sql`
      select key, enabled, paused_reason, cron_expr from job_schedules where owner_user_id = ${userId} order by key`);
    const by = Object.fromEntries(rows.rows.map((r) => [r.key, r]));
    expect(by['retention.scrub']).toMatchObject({ enabled: true, paused_reason: null, cron_expr: '15 3 * * *' });
    expect(by['backup.nightly']).toMatchObject({ enabled: true, paused_reason: null });
    expect(by['missed_opps.sweep']).toMatchObject({ enabled: false, paused_reason: 'not_wired' });
    // the laptop slept through three nights
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'simulate a missed slot' }, (tx) =>
      tx.execute(sql`update job_schedules set next_run_at = now() - interval '3 days' where owner_user_id = ${userId} and key = 'retention.scrub'`),
    );
    const enq = await tickSchedules(db, userId, now);
    // 11 R6: the doctor's interval row is due right after the worker starts (ensureSchedules), every 15 min after
    expect(enq).toEqual(['retention.scrub', 'doctor.checks']);
    const doc = await db.execute<{ next_run_at: string; cron_expr: string }>(sql`select next_run_at, cron_expr from job_schedules where owner_user_id = ${userId} and key = 'doctor.checks'`);
    expect(doc.rows[0]!.cron_expr).toBe('*/15 * * * *');
    expect(new Date(doc.rows[0]!.next_run_at).getTime()).toBe(now.getTime() + 15 * 60_000);
    const jobs = await db.execute<{ n: string }>(sql`select count(*) as n from jobs where owner_user_id = ${userId} and kind = 'retention.scrub' and status = 'queued'`);
    expect(jobs.rows[0]!.n).toBe('1');
    const next = await db.execute<{ next_run_at: string; last_job_id: string }>(sql`select next_run_at, last_job_id from job_schedules where owner_user_id = ${userId} and key = 'retention.scrub'`);
    expect(new Date(next.rows[0]!.next_run_at).getTime()).toBeGreaterThan(now.getTime());
    expect(next.rows[0]!.last_job_id).not.toBeNull();
    expect(await tickSchedules(db, userId, now)).toEqual([]); // nothing else due
    // idempotent re-ensure (no rewrite of an unchanged schedule)
    await ensureSchedules(db, userId, registry, 'America/Denver', now);
  });

  it('the scheduled retention job runs through the worker; stubs log "not yet wired" and succeed', async () => {
    await db.execute(sql`update jobs set status = 'cancelled', finished_at = now(), lease_expires_at = null where status in ('queued', 'running')`);
    const registry = createDefaultRegistry();
    const logs: string[] = [];
    const w = new WorkerRuntime({ db, userId, workerId: `test:${uid()}`, registry, services: {}, listenUrl: null, log: (m) => logs.push(m) });
    await db.execute(sql`insert into jobs (owner_user_id, queue, kind) values (${userId}, 'maintenance', 'retention.scrub'), (${userId}, 'nba', 'nba.generate')`);
    await w.pollOnce();
    await w.idle();
    const r = await db.execute<{ kind: string; status: string; result: Record<string, unknown> }>(sql`
      select kind, status, result from jobs where owner_user_id = ${userId} and kind in ('retention.scrub', 'nba.generate') and status <> 'cancelled' order by kind`);
    expect(r.rows.map((x) => [x.kind, x.status])).toEqual([
      ['nba.generate', 'succeeded'],
      ['retention.scrub', 'succeeded'],
    ]);
    expect(r.rows[0]!.result).toMatchObject({ notWired: true });
    expect(r.rows[1]!.result).toHaveProperty('bodiesPurged');
    expect(logs.some((l) => /nba\.generate: not yet wired/.test(l))).toBe(true);
  });
});

describe('Settings > Time > Logging > autoAt drives activity.sync (06 TA-9)', () => {
  it('the slot follows the setting at ensure time, and moves at the next tick when the setting changes', async () => {
    const id = await createUser(db, 'autoat');
    const registry = createDefaultRegistry();
    const now = new Date('2026-11-20T15:00:00Z');
    const put = (at: string) => setUserSetting(db, id, 'settings.time', { logging: { mode: 'automatic', autoAt: at } });
    const cronOf = async () => (await db.execute<{ cron_expr: string; next_run_at: string }>(sql`select cron_expr, next_run_at from job_schedules where owner_user_id = ${id} and key = 'activity.sync'`)).rows[0]!;

    await ensureSchedules(db, id, registry, 'America/Denver', now); // no setting: the default slot
    expect((await cronOf()).cron_expr).toBe('30 17 * * *');

    await put('16:45');
    await tickSchedules(db, id, now);
    const moved = await cronOf();
    expect(moved.cron_expr).toBe('45 16 * * *');
    expect(new Date(moved.next_run_at).toISOString()).toBe(nextLocalTime(now, '16:45', 'America/Denver').toISOString());

    await put('nonsense'); // a malformed value keeps the row as it is
    await tickSchedules(db, id, now);
    expect((await cronOf()).cron_expr).toBe('45 16 * * *');

    const id2 = await createUser(db, 'autoat2'); // set before the worker starts: ensure uses it
    await setUserSetting(db, id2, 'settings.time', { logging: { autoAt: '18:15' } });
    await ensureSchedules(db, id2, registry, 'America/Denver', now);
    expect((await db.execute<{ cron_expr: string }>(sql`select cron_expr from job_schedules where owner_user_id = ${id2} and key = 'activity.sync'`)).rows[0]!.cron_expr).toBe('15 18 * * *');
  });
});
