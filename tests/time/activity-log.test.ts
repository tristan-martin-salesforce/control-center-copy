/**
 * Time ▸ Log on the mock DataSource (placeholder seed + tests/fixtures/activity-history.ts): GET /time/log returns
 * every row, history included, filtered by range, status bucket, search, account and opp, with week / month /
 * fiscal-quarter totals; the quarter totals cover a past quarter; Org62-native rows are never "pending"; and
 * GET /time counts only the current quarter's logged rows (the mock used to add every logged row).
 * The same seed on Postgres: tests/db/datasource/activity-log.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog, routes, TimeWeek } from '@/contract';
import { buildActivityLog, fiscalQuarterOfDay, mondayOfDay, parseLogStatuses } from '@/server/datasource/activity-log';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { withActivityHistory, type ActivityHistory } from '../fixtures/activity-history';

let mock: MockDataSource;
let H: ActivityHistory;

beforeAll(() => {
  const base = createMockDataSource({ autoplay: false });
  H = withActivityHistory(base.loaded.seed);
  base.dispose();
  mock = createMockDataSource({ seed: H.seed, autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(H.seed.meta.asOf));
  mock.resetStore();
});
afterAll(() => mock?.dispose());

const log = async (query: Record<string, string> = {}) => ActivityLog.parse(await mock.getActivityLog({ query: routes.getActivityLog.query!.parse(query) }));

describe('GET /time/log on the mock', () => {
  it('returns every row, the previous quarter included, newest day first and a day in clock order', async () => {
    const r = await log();
    expect(r.entries.length).toBe(H.seed.activity.length);
    expect(r.entries.map((e) => e.id)).toEqual(expect.arrayContaining(Object.values(H.ids)));
    for (let i = 1; i < r.entries.length; i++) {
      const a = r.entries[i - 1]!;
      const b = r.entries[i]!;
      expect(a.date > b.date || (a.date === b.date && a.start <= b.start)).toBe(true);
    }
    expect(r.from).toBeNull();
    expect(r.to).toBeNull();
  });

  it('carries the new fields: from Org62, why excluded, logged and verified times', async () => {
    const byId = new Map((await log()).entries.map((e) => [e.id, e]));
    expect(byId.get(H.ids.org62A)).toMatchObject({ fromOrg62: true, status: 'logged', excludedReason: null });
    expect(byId.get(H.ids.org62A)!.loggedAt).toMatch(/T21:00:00/);
    expect(byId.get(H.ids.verified)).toMatchObject({ fromOrg62: false, status: 'verified' });
    expect(byId.get(H.ids.verified)!.verifiedAt).toMatch(/T22:00:00/);
    expect(byId.get(H.ids.excluded)).toMatchObject({ status: 'dismissed', excludedReason: 'overlap', loggedAt: null });
    // a seed row dismissed with no reason is yours
    const seedDismissed = H.seed.activity.find((e) => e.status === 'dismissed' && !Object.values(H.ids).includes(e.id));
    if (seedDismissed) expect(byId.get(seedDismissed.id)!.excludedReason).toBe('dismissed');
  });

  it('filters by range (a past quarter), status bucket, search, account and opp', async () => {
    const prev = await log({ from: H.prev.start, to: H.prev.end });
    expect(prev.entries.map((e) => e.id).sort()).toEqual([H.ids.org62A, H.ids.org62B, H.ids.verified, H.ids.excluded].sort());
    expect(prev.from).toBe(H.prev.start);

    const logged = await log({ status: 'logged' });
    expect(logged.entries.every((e) => e.status === 'logged')).toBe(true);
    expect(logged.entries.map((e) => e.id)).toEqual(expect.arrayContaining([H.ids.org62A, H.ids.org62B, H.ids.curOrg62]));
    // the chip counts ignore the status filter (so every chip keeps its count)
    expect(logged.counts).toEqual((await log()).counts);

    const two = await log({ status: 'verified,excluded,nonsense' });
    expect(two.entries.map((e) => e.id).sort()).toEqual(expect.arrayContaining([H.ids.verified, H.ids.excluded]));
    expect(two.entries.every((e) => e.status === 'verified' || e.status === 'dismissed')).toBe(true);

    const q = await log({ q: 'history prep' });
    expect(q.entries.map((e) => e.id)).toEqual([H.ids.org62B]);

    const acct = await log({ account: 'account_history' });
    expect(acct.entries.map((e) => e.id)).toEqual([H.ids.org62B]);
    expect(acct.facets.accounts.map((a) => a.name)).toContain(H.account); // the menu keeps every account

    const opp = await log({ opp: H.oppId, from: H.prev.start, to: H.prev.end });
    expect(opp.entries.map((e) => e.id).sort()).toEqual([H.ids.org62A, H.ids.verified, H.ids.excluded].sort());
  });

  it('totals weeks, months and fiscal quarters: logged vs target for a past quarter too', async () => {
    const r = await log({ from: H.prev.start, to: H.prev.end });
    expect(r.total).toEqual({ rows: 4, hours: H.prevLoggedH, loggedH: H.prevLoggedH }); // the excluded hour counts nowhere
    expect(r.weeks.reduce((s, w) => s + w.rows, 0)).toBe(4);
    expect(r.weeks.map((w) => w.weekStart)).toEqual([...new Set(r.entries.map((e) => mondayOfDay(e.date)))]);
    expect(r.months.map((m) => m.month)).toEqual([...new Set(r.entries.map((e) => e.date.slice(0, 7)))]);
    expect(r.months.reduce((s, m) => s + m.loggedH, 0)).toBeCloseTo(H.prevLoggedH);

    const quarters = (await log()).quarters;
    const prevQ = quarters.find((x) => x.label === H.prev.label)!;
    expect(prevQ).toMatchObject({ start: H.prev.start, end: H.prev.end, loggedH: H.prevLoggedH, verifiedH: 1, current: false, due: null, rows: 4 });
    const curQ = quarters.find((x) => x.current)!;
    expect(curQ.label).toBe(H.cur.label);
    expect(quarters.indexOf(curQ)).toBeLessThan(quarters.indexOf(prevQ)); // newest first
    expect(prevQ.targetH).toBe(curQ.targetH);
  });

  it('GET /time: the quarter total is the current quarter only, and Org62 rows are not pending', async () => {
    const week = TimeWeek.parse(await mock.getTime({ query: {} }));
    const curQ = (await log()).quarters.find((x) => x.current)!;
    expect(week.quarter.loggedH).toBe(curQ.loggedH);
    const all = H.seed.activity.filter((e) => e.status === 'logged' || e.status === 'verified').reduce((s, e) => s + e.durationH, 0);
    expect(week.quarter.loggedH).toBeLessThan(H.seed.meta.quarter.loggedH + all); // the previous quarter is left out
    const org62Week = TimeWeek.parse(await mock.getTime({ query: { week: H.cur.start } }));
    const native = org62Week.entries.filter((e) => e.fromOrg62 && e.status === 'logged').length;
    expect(native).toBeGreaterThan(0);
    expect(org62Week.org62.pending).toBe(org62Week.entries.filter((e) => ['approved', 'synced_to_canvas', 'logged'].includes(e.status) && !e.fromOrg62).length);
  });
});

describe('activity-log helpers', () => {
  it('fiscal quarters start on 1 February', () => {
    expect(fiscalQuarterOfDay('2026-08-01')).toBe('Q3 FY27');
    expect(fiscalQuarterOfDay('2026-10-31')).toBe('Q3 FY27');
    expect(fiscalQuarterOfDay('2026-11-01')).toBe('Q4 FY27');
    expect(fiscalQuarterOfDay('2027-01-31')).toBe('Q4 FY27');
    expect(fiscalQuarterOfDay('2027-02-01')).toBe('Q1 FY28');
    expect(fiscalQuarterOfDay('2026-02-01')).toBe('Q1 FY27');
  });

  it('weeks start on Monday; status lists drop unknown words', () => {
    expect(mondayOfDay('2026-11-10')).toBe('2026-11-09');
    expect(mondayOfDay('2026-11-09')).toBe('2026-11-09');
    expect(mondayOfDay('2026-11-15')).toBe('2026-11-09');
    expect([...(parseLogStatuses('logged, verified,bogus') ?? [])]).toEqual(['logged', 'verified']);
    expect(parseLogStatuses('bogus')).toBeNull();
    expect(parseLogStatuses(undefined)).toBeNull();
  });

  it('a seeded base counts in the current quarter only; an unreadable stored label keeps its wording', () => {
    const rows = H.seed.activity;
    const now = new Date(H.seed.meta.asOf);
    const tz = H.seed.settings.profile.timezone;
    const r = buildActivityLog(rows, {}, { meta: { quarter: { label: 'This quarter', targetH: 40, due: H.seed.meta.quarter.due, loggedH: 3 } }, now, tz });
    const cur = r.quarters.find((q) => q.current)!;
    expect(cur.label).toBe('This quarter');
    expect(r.quarters.filter((q) => q.start === cur.start)).toHaveLength(1); // not listed twice under its computed label
    expect(r.quarters.find((q) => q.label === H.prev.label)!.loggedH).toBe(H.prevLoggedH); // no base on a past quarter
  });
});
