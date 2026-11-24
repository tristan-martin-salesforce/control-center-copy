/**
 * Time ▸ Log on Postgres: the placeholder seed plus a quarter of history (tests/fixtures/activity-history.ts)
 * loaded into the db, then GET /time/log and GET /time on both datasources.
 *
 * Parity: the range route (everything, a past quarter, a status filter, search, account, opp) and the week
 * reads agree after the standard normalizations. db only: the new contract fields come from real columns (an
 * Org62 read-back row keeps its `org62|` key and reads fromOrg62; an excluded row is stored as `excluded` with its
 * reason; logged / verified stamps are the columns'), the quarter totals cover a past quarter, and Org62-native
 * rows are never pending read-back. Run with `npm run test:be1b`.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ActivityLog, TimeWeek, type RouteKey } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { createMockDataSource, type MockDataSource } from '../../../src/server/datasource/mock';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { rebuildEngagement } from '../../../src/server/datasource/db/attribution';
import { buildIdMap } from '../../../src/server/datasource/db/translate';
import { withActivityHistory, type ActivityHistory } from '../../fixtures/activity-history';
import { BE1B, openTestDb, type Loaded } from './helpers';
import { both } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;
let H: ActivityHistory;
let mock: MockDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  const base = createMockDataSource({ autoplay: false });
  H = withActivityHistory(base.loaded.seed);
  base.dispose();
  mock = createMockDataSource({ seed: H.seed, autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(H.seed.meta.asOf));
  mock.resetStore();
  const { seed, rankedAt } = seedFromMock(mock);
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt, reset: true });
  // the opp_engagement rollup the nightly job writes (the mock derives it on every read), as loadBoth does
  await rebuildEngagement(handle.db, res.userId, mock.now());
  L = { mock, seed, idMap: buildIdMap(seed), userId: res.userId, now: mock.now() };
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});
afterAll(async () => {
  if (!BE1B) return;
  mock?.dispose();
  await db?.dispose();
  await handle?.close();
});

const T = (id: string) => L.idMap.get(id) ?? id;
const dbLog = async (query: Record<string, string> = {}) => ActivityLog.parse(await db.getActivityLog({ query }));

describe.runIf(BE1B)('activity log parity: mock ↔ db on the same seed with history', () => {
  const reads: [string, RouteKey, () => Record<string, unknown>][] = [
    ['everything', 'getActivityLog', () => ({ query: {} })],
    ['the previous quarter', 'getActivityLog', () => ({ query: { from: H.prev.start, to: H.prev.end } })],
    ['logged + excluded', 'getActivityLog', () => ({ query: { status: 'logged,excluded' } })],
    ['search', 'getActivityLog', () => ({ query: { q: 'history' } })],
    ['an account', 'getActivityLog', () => ({ query: { account: H.account } })],
    // the Ledger's drill-down filters: a task type, no type, no opportunity, internal work, no account
    ['a task type', 'getActivityLog', () => ({ query: { type: 'demo' } })],
    ['no type', 'getActivityLog', () => ({ query: { type: 'none' } })],
    ["an account's rows with no opportunity", 'getActivityLog', () => ({ query: { account: 'ACCOUNT_HISTORY', opp: 'none' } })],
    ['internal work', 'getActivityLog', () => ({ query: { opp: 'internal' } })],
    ['no account, no opportunity', 'getActivityLog', () => ({ query: { account: 'none', opp: 'none' } })],
    // the Ledger: the current quarter (the default), a past one, every quarter
    ['the current quarter', 'getTimeLedger', () => ({ query: {} })],
    ['the previous quarter', 'getTimeLedger', () => ({ query: { quarter: H.prev.label } })],
    ['every quarter', 'getTimeLedger', () => ({ query: { quarter: 'all' } })],
    ['this week', 'getTime', () => ({ query: {} })],
    ['the first week of the quarter', 'getTime', () => ({ query: { week: H.cur.start } })],
    ['a week of the previous quarter', 'getTime', () => ({ query: { week: L.seed.activity.find((e) => e.id === H.ids.org62B)!.date } })],
  ];
  for (const [label, key, input] of reads) {
    it(`${key} · ${label}`, async () => {
      const r = await both(L, db, key, input());
      expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    });
  }
});

describe.runIf(BE1B)('activity log on db', () => {
  it('filters by opp like the mock (the harness translates *Id keys only, so ids are compared here)', async () => {
    const m = ActivityLog.parse(await mock.getActivityLog({ query: { opp: H.oppId } }));
    const d = await dbLog({ opp: T(H.oppId) });
    expect(m.entries.length).toBeGreaterThan(2);
    expect(d.entries.map((e) => e.id)).toEqual(m.entries.map((e) => T(e.id)));
    expect(d.total).toEqual(m.total);
  });

  it('reads the new fields from real columns: Org62 key, excluded status + reason, logged / verified stamps', async () => {
    const rows = await handle.db.execute<{ id: string; status: string; excluded_reason: string | null; origin: string; dedupe_key: string; logged_at: Date | null; verified_at: Date | null }>(
      sql`select id, status, excluded_reason, origin, dedupe_key, logged_at, verified_at from activity_entries where id in (${sql.join(
        Object.values(H.ids).map((x) => sql`${T(x)}::uuid`),
        sql`, `,
      )})`,
    );
    const col = new Map(rows.rows.map((r) => [r.id, r]));
    expect(col.get(T(H.ids.org62A))).toMatchObject({ status: 'logged', origin: 'manual', excluded_reason: null });
    expect(col.get(T(H.ids.org62A))!.dedupe_key).toMatch(/^org62\|00U/);
    expect(col.get(T(H.ids.excluded))).toMatchObject({ status: 'excluded', excluded_reason: 'overlap' });
    expect(col.get(T(H.ids.verified))!.verified_at).not.toBeNull();

    const byId = new Map((await dbLog()).entries.map((e) => [e.id, e]));
    expect(byId.get(T(H.ids.org62A))).toMatchObject({ fromOrg62: true, status: 'logged' });
    expect(byId.get(T(H.ids.org62A))!.loggedAt).toMatch(/T21:00:00/);
    expect(byId.get(T(H.ids.excluded))).toMatchObject({ status: 'dismissed', excludedReason: 'overlap' });
    expect(byId.get(T(H.ids.verified))!.verifiedAt).toMatch(/T22:00:00/);
  });

  it('totals a past quarter: logged vs target, newest first, the current quarter matching GET /time', async () => {
    const r = await dbLog();
    const prevQ = r.quarters.find((q) => q.label === H.prev.label)!;
    expect(prevQ).toMatchObject({ start: H.prev.start, end: H.prev.end, loggedH: H.prevLoggedH, verifiedH: 1, current: false, rows: 4 });
    const curQ = r.quarters.find((q) => q.current)!;
    expect(r.quarters.indexOf(curQ)).toBeLessThan(r.quarters.indexOf(prevQ));
    const week = TimeWeek.parse(await db.getTime({ query: {} }));
    expect(week.quarter.loggedH).toBe(curQ.loggedH);

    const past = await dbLog({ from: H.prev.start, to: H.prev.end, status: 'logged' });
    expect(past.entries.map((e) => e.id).sort()).toEqual([T(H.ids.org62A), T(H.ids.org62B)].sort());
    expect(past.total).toEqual({ rows: 2, hours: 3.5, loggedH: 3.5 });
    expect(past.counts.excluded).toBe(1); // the chips keep their counts under a status filter
  });

  it('Org62-native rows are never pending read-back; a user edit keeps an excluded row excluded', async () => {
    const w = TimeWeek.parse(await db.getTime({ query: { week: H.cur.start } }));
    const native = w.entries.find((e) => e.id === T(H.ids.curOrg62))!;
    expect(native.fromOrg62).toBe(true);
    expect(w.org62.pending).toBe(w.entries.filter((e) => ['approved', 'synced_to_canvas', 'logged'].includes(e.status) && !e.fromOrg62).length);

    const ex = (await dbLog()).entries.find((e) => e.id === T(H.ids.excluded))!;
    await db.patchActivity({ params: { id: ex.id }, body: { ifVersion: ex.version, patch: { description: 'HISTORY_OVERLAP_EDITED' } } });
    const after = (await dbLog({ q: 'edited' })).entries;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'dismissed', excludedReason: 'overlap' });
  });
});
