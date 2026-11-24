/**
 * Go-live findings, db mode, placeholder data (mock seed):
 *  SET-1: the scanner reads the app's Settings keys (`settings.budgets`, `settings.profile`; legacy keys still
 *         work), and a hard-stop llm_budgets row can lower the hard cap; a non-stop row (bootstrap writes one at the
 *         soft budget) is the soft budget only.
 *  RS-2:  Health Rescan of Trainings and Watch targets those connectors, not the Gmail / Slack inbox.
 *  B-084: the scanner writes the contract's error classes and saves the probe's re-auth affordance.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { loadWorkHours } from '../../../src/worker/scanning';

import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

describe.skipIf(!pgAvailable())('scanner settings and Rescan targets (db mode)', () => {
  let t: TestDb;
  let ds: DbDataSource;
  let userId: string;

  beforeAll(async () => {
    t = await provisionTestDb('setkeys');
    const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
    mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
    mock.resetStore();
    const { seed, rankedAt } = seedFromMock(mock);
    mock.dispose();
    ({ userId } = await loadSeedIntoDb(seed, { db: t.handle.db, rankedAt, reset: true }));
    ds = new DbDataSource({ handle: t.handle, userId, clock: { now: () => new Date() } });
  });

  afterAll(async () => {
    await ds?.dispose?.();
    await t?.drop();
  });

  /** Audited tables need a change set (cc_audit_*). */
  const exec = (q: ReturnType<typeof sql>) => withChangeSet({ db: t.handle.db, userId, actor: actors.system('test'), reason: 'test' }, async (tx) => tx.execute(q));
  const setKv = async (key: string, value: unknown) =>
    exec(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, ${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (owner_user_id, key) do update set value = excluded.value`);

  it('SET-1: a Settings edit (settings.budgets) reaches the scanner; a hard-stop llm_budgets row lowers the cap', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId });
    // The app's Settings save path writes `settings.budgets`.
    const s = (await ds.getSettings({} as never)) as unknown as { budgets: { version: number } };
    await ds.patchSettings({ params: { section: 'budgets' }, body: { ifVersion: s.budgets.version, value: { softUsd: 2, hardUsd: 7 } } } as never);
    await exec(sql`delete from llm_budgets where owner_user_id = ${userId}`);
    let b = await store.budgetStatus();
    expect(b).toMatchObject({ softCapUsd: 2, hardCapUsd: 7 });
    // A legacy `budgets` row does not win over the app's key.
    await setKv('budgets', { version: 1, softUsd: 9, hardUsd: 99, alertPct: 80 });
    expect(await store.budgetStatus()).toMatchObject({ softCapUsd: 2, hardCapUsd: 7 });
    // An alert-only llm_budgets row (bootstrap) does not change the hard cap.
    await exec(sql`insert into llm_budgets (owner_user_id, scope, daily_limit_usd, alert_at_pct, hard_stop, effective_from) values (${userId}, 'total', 1, 80, false, current_date)`);
    expect(await store.budgetStatus()).toMatchObject({ hardCapUsd: 7 });
    // A hard-stop row below the setting lowers it (before: max(limit, 15) could never lower it).
    await exec(sql`update llm_budgets set hard_stop = true, daily_limit_usd = 3 where owner_user_id = ${userId} and scope = 'total'`);
    b = await store.budgetStatus();
    expect(b.hardCapUsd).toBe(3);
  });

  it('SET-1: work hours and the time zone come from settings.profile', async () => {
    const s = (await ds.getSettings({} as never)) as unknown as { profile: { version: number } };
    await ds.patchSettings({ params: { section: 'profile' }, body: { ifVersion: s.profile.version, value: { timezone: 'America/New_York', workingHours: { start: '06:00', end: '15:00', days: [1, 2, 3, 4] } } } } as never);
    await setKv('profile', { version: 1, timezone: 'Pacific/Auckland', workingHours: { start: '10:00', end: '11:00', days: [6] } });
    expect(await loadWorkHours(t.handle.db, userId)).toMatchObject({ startHour: 6, endHour: 15, days: [1, 2, 3, 4], timeZone: 'America/New_York' });
  });

  it('B-084: connector rows carry contract error classes and the probe re-auth affordance', async () => {
    const store = new DbScannerStore({ db: t.handle.db, userId });
    await store.recordHealth('slack', { state: 'auth_required', errorClass: 'auth', checkedAt: new Date().toISOString(), detail: 'token expired', reauth: { kind: 'terminal_command', command: 'claude mcp login slack', instructions: 'PLACEHOLDER instructions' } });
    await store.recordHealth('gmail', { state: 'degraded', errorClass: 'config', checkedAt: new Date().toISOString(), detail: 'bad config' });
    await store.recordHealth('calendar', { state: 'degraded', errorClass: 'unknown', checkedAt: new Date().toISOString(), detail: 'odd' });
    const rows = (await t.handle.db.execute<{ name: string; code: string | null; reauth: Record<string, unknown> | null }>(sql`
      select name, last_error_code as code, config->'reauth' as reauth from connectors where owner_user_id = ${userId}`)).rows;
    const by = (n: string) => rows.find((r) => r.name.toLowerCase() === n)!;
    expect(by('slack')).toMatchObject({ code: 'auth', reauth: { kind: 'terminal_command', label: 'Re-auth Slack', command: 'claude mcp login slack' } });
    expect(by('gmail').code).toBe('bug');
    expect(by('calendar').code).toBe('transient');
    const allowed = ['auth', 'transient', 'rate_limited', 'bug', 'offline'];
    const checks = (await t.handle.db.execute<{ c: string }>(sql`select distinct error_code as c from connector_health_checks where error_code is not null`)).rows.map((r) => r.c);
    expect(checks.every((c) => allowed.includes(c))).toBe(true);
  });

  it('RS-2: Rescan of Trainings enqueues trainings jobs (gmail + calendar scopes); Watch has no scanner yet', async () => {
    // The scanner registers its rows by connector id on first use.
    const store = new DbScannerStore({ db: t.handle.db, userId });
    await store.getCursor({ connector: 'trainings', scope: 'gmail' });
    await store.getCursor({ connector: 'watch', scope: 'channel:C0TEAMUPD' });
    const health = (await ds.getHealth({} as never)) as unknown as { connectors: Array<{ id: string; label: string; source: string; state: string }> };
    const rowOf = async (name: string) => (await t.handle.db.execute<{ id: string }>(sql`select id::text from connectors where owner_user_id = ${userId} and name = ${name}`)).rows[0]!.id;
    const trainingsId = await rowOf('trainings');
    const watchId = await rowOf('watch');
    expect(health.connectors.map((c) => c.id)).toEqual(expect.arrayContaining([trainingsId, watchId]));

    // Seeded job ids are hashes; match the new jobs by their payload (manual mode, this test's connectors).
    const manualJobs = async () => (await t.handle.db.execute<{ payload: { connector: string; scope: string; mode: string } }>(sql`select payload from jobs where payload->>'mode' = 'manual' and payload->>'connector' in ('trainings', 'watch', 'gmail', 'slack', 'calendar') order by id`)).rows.map((r) => r.payload);
    const before = (await manualJobs()).length;
    const r1 = (await ds.scanConnector({ params: { id: trainingsId }, body: { scope: 'manual' } } as never)) as { entity: { id: string; status: string } };
    expect(r1.entity.status).toBe('queued');
    const jobsNow = (await manualJobs()).slice(before);
    expect(jobsNow.map((p) => `${p.connector}:${p.scope}`).sort()).toEqual(['trainings:calendar', 'trainings:gmail']);
    expect(jobsNow.every((p) => p.mode === 'manual')).toBe(true);

    const mid = (await manualJobs()).length;
    const r2 = (await ds.scanConnector({ params: { id: watchId }, body: { scope: 'manual' } } as never)) as { entity: { id: string } };
    const run = (await t.handle.db.execute<{ status: string; error_message: string | null; job_id: string | null }>(sql`select status::text, error_message, job_id::text from scan_runs where id = ${r2.entity.id}`)).rows[0]!;
    expect(run).toMatchObject({ status: 'cancelled', job_id: null });
    expect(run.error_message).toMatch(/no scanner/);
    expect((await manualJobs()).length).toBe(mid); // before: a Slack inbox rescan
  });
});
