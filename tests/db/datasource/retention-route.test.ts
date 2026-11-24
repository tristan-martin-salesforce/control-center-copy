/**
 * Settings ▸ Data: GET/PATCH /retention answer alike on the mock and on Postgres (the horizons in user_settings
 * `retention`), and POST /retention/run on Postgres runs p4-retention's runDataRetention forced (a dry run counts,
 * nothing changes; the nightly switch off does not stop an explicit run). Local app data only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';
import { both } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

describe.skipIf(!BE1B)('Settings ▸ Data: retention routes (mock ≡ db)', () => {
  it('GET /retention: the defaults on both', async () => {
    const r = await both(L, db, 'getRetention', {});
    expect(r.diffs).toEqual([]);
    expect(r.raw.db).toMatchObject({ enabled: true, eventsDays: 30, traceDays: 14 });
  });

  it('PATCH /retention: saved in user_settings `retention`, merged with what was there', async () => {
    const r = await both(L, db, 'patchRetention', { body: { enabled: false, eventsDays: 45 } });
    expect(r.diffs).toEqual([]);
    expect(r.raw.db).toMatchObject({ enabled: false, eventsDays: 45, traceDays: 14 });
    const row = await handle.db.execute<{ value: { eventsDays: number } }>(sql`select value from user_settings where owner_user_id = ${L.userId} and key = 'retention'`);
    expect(row.rows[0]?.value.eventsDays).toBe(45);
    expect((await both(L, db, 'getRetention', {})).raw.db).toMatchObject({ enabled: false, eventsDays: 45 });
  });

  it('POST /retention/run: a dry run counts per rule even with the nightly job off, and changes nothing', async () => {
    const before = Number((await handle.db.execute<{ n: string }>(sql`select count(*) as n from app_events`)).rows[0]!.n);
    const r = await db.runRetention({ body: { dry: true } } as never);
    expect(r.dry).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(r.tables.map((t) => t.rule)).toEqual(expect.arrayContaining(['llm_text', 'trace_full', 'events_resolved', 'orphan_sources']));
    expect(r.settings.eventsDays).toBe(45);
    expect(Number((await handle.db.execute<{ n: string }>(sql`select count(*) as n from app_events`)).rows[0]!.n)).toBe(before);
    const m = await L.mock.runRetention({ body: { dry: true } } as never);
    expect(m.tables.map((t) => t.rule)).toEqual(r.tables.map((t) => t.rule));
  });
});
