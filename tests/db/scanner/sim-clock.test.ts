/**
 * The stress harness's simulated clock: process time and the database's `now()` stay in lock step, so the job
 * queue (run_at, leases, backoff, reaper) and the scanner never mix real and simulated time.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SimClock } from '../../../scripts/stress/lib/sim-clock';
import { addDays, dayBounds, localDay, localToUtc } from '../../../scripts/stress/lib/time';

import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

describe('stress time helpers', () => {
  it('local days are DST-safe (America/Denver, fall back on 2026-11-01)', () => {
    expect(dayBounds('2026-10-31')).toEqual({ from: '2026-10-31T06:00:00.000Z', to: '2026-11-01T06:00:00.000Z' });
    // The DST day is 25 hours long.
    const d = dayBounds('2026-11-01');
    expect(d).toEqual({ from: '2026-11-01T06:00:00.000Z', to: '2026-11-02T07:00:00.000Z' });
    expect(localToUtc('2026-11-02', '09:00').toISOString()).toBe('2026-11-02T16:00:00.000Z');
    expect(localDay('2026-11-02T06:30:00Z')).toBe('2026-11-01');
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02');
  });

  it('SimClock flows at real speed and only jumps forward', async () => {
    let real = 1_000_000;
    const c = new SimClock('2026-10-15T15:00:00Z', () => real);
    expect(c.now().toISOString()).toBe('2026-10-15T15:00:00.000Z');
    real += 5000;
    expect(c.now().toISOString()).toBe('2026-10-15T15:00:05.000Z');
    await c.jump(3600_000);
    expect(c.now().toISOString()).toBe('2026-10-15T16:00:05.000Z');
    await expect(c.jump(-1)).rejects.toThrow(/backward/);
  });
});

describe.skipIf(!pgAvailable())('SimClock ↔ database now()', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await provisionTestDb('clock');
  });
  afterAll(async () => t?.drop());

  it('now() in SQL follows the simulated clock, including jumps', async () => {
    const c = new SimClock('2026-10-15T15:00:00Z');
    await c.bindDb(t.handle.db);
    const r = await t.handle.db.execute<{ n: string }>(sql`select now() as n`);
    expect(Math.abs(Date.parse(r.rows[0]!.n) - c.nowMs())).toBeLessThan(2000);
    await c.jump(26 * 3600_000);
    const r2 = await t.handle.db.execute<{ n: string; d: string }>(sql`select now() as n, (now() + interval '90 seconds') as d`);
    expect(Math.abs(Date.parse(r2.rows[0]!.n) - c.nowMs())).toBeLessThan(2000);
    expect(Date.parse(r2.rows[0]!.d) - Date.parse(r2.rows[0]!.n)).toBe(90_000);
    const child = await SimClock.fromDb(t.handle.db);
    expect(Math.abs(child.nowMs() - c.nowMs())).toBeLessThan(50);
  });

  it('column defaults (created_at, first_seen_at, …) follow the simulated clock too (HARN-1)', async () => {
    // Migrations bind now() defaults to pg_catalog.now() at CREATE time, beyond the search path's reach. Before the
    // fix every created_at / first_seen_at in a scenario DB was real time while queries ran in simulated time.
    const c = new SimClock('2026-10-15T15:00:00Z');
    await c.bindDb(t.handle.db);
    // Printed without `stress` on the search path, so stress.now() and pg_catalog.now() read differently.
    const defaults = await t.handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('search_path', 'public, pg_catalog', true)`);
      return tx.execute<{ e: string }>(sql`
        select distinct pg_get_expr(d.adbin, d.adrelid) as e from pg_attrdef d
          join pg_class k on k.oid = d.adrelid join pg_namespace n on n.oid = k.relnamespace
         where n.nspname = 'public' and pg_get_expr(d.adbin, d.adrelid) ~ 'now\\(\\)'`);
    });
    expect(defaults.rows.map((r) => r.e)).toEqual(['stress.now()']);
    const u = await t.handle.db.execute<{ created_at: string }>(sql`
      insert into users (email, display_name, timezone) values ('clock-check@example.com', 'PLACEHOLDER', 'UTC') returning created_at`);
    expect(Math.abs(Date.parse(u.rows[0]!.created_at) - c.nowMs())).toBeLessThan(2000);
  });
});
