/**
 * The Work list scope on Postgres 17 (post-2.0, 15-page-reads.md "Work list scope"): GET /items loads what it shows.
 *   - every list shape the ui sends (each tab alone and with each filter the Work page sends, the combinations, the
 *     Assistant's and panels' tab reads) renders the same payload scoped as with the scopes off, in strict mode (a
 *     read outside the `work` scope throws: BUG.READ_SCOPE_MISS never fires);
 *   - the window: the open tab loads no closed work; a Closed page loads that page; text and source load a superset
 *     the view filters;
 *   - the counts stay exact on every path, also after a reopen (a kv state override) and a deliverable (a kv kind
 *     override);
 *   - the Closed tab pages through every row with the additive cursor/limit on both DataSources alike.
 *
 * Own database: control_center_worklist_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder data only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ItemsPayload, ItemsQuery, Seed, WorkTab } from '../../../src/contract';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { parseClosedCursor } from '../../../src/server/datasource/db/reads/page';
import { startQueryLog } from '../../../src/server/datasource/db/reads/query-log';
import { everything, workScope } from '../../../src/server/datasource/db/reads/scope';
import { resetScopeMisses, scopeMissSnapshot } from '../../../src/server/datasource/db/reads/session';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { createMockDataSource, type MockDataSource } from '../../../src/server/datasource/mock';
import { WORK_TABS } from '../../../src/server/views/work';
import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';

const NAME = `control_center_worklist_${testDbSuffix}`;
const PG = pgAvailable && process.env.CC_READS_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let mock: MockDataSource;
let now: Date;

type Q = Partial<ItemsQuery>;
const list = (q: Q) => ds.listItems({ query: { tab: 'all_open', ...q } } as never) as Promise<ItemsPayload>;

async function off<T>(fn: () => Promise<T>): Promise<T> {
  process.env.CC_READ_SCOPES = 'off';
  try {
    return await fn();
  } finally {
    delete process.env.CC_READ_SCOPES;
  }
}

/** Every list shape the ui sends (url-filters.ts itemsQueryOf, the panels' tab reads), from the loaded items. */
async function shapes(): Promise<Q[]> {
  const m = await ds.model(everything('test: shapes'));
  const items = m.all('workItems');
  const withAll = items.find((w) => w.accountId && w.initiativeId && w.sources.length) ?? items[0]!;
  const acc = withAll.accountId!;
  const ini = withAll.initiativeId!;
  const opp = items.find((w) => w.oppId)!.oppId!;
  const src = withAll.sources[0]!.kind;
  const filters: Q[] = [
    {},
    { account: acc },
    { opp },
    { initiative: ini },
    { source: src },
    { source: 'gmail' },
    ...(['task', 'commitment', 'ask', 'training', 'follow_up', 'travel', 'deliverable'] as const).map((kind) => ({ kind })),
    { q: withAll.title.slice(0, 4) },
    { q: withAll.title.slice(0, 4).toUpperCase() },
    { q: 'e' },
    { q: '' },
    { q: 'no item says this' },
    { q: 'Ünïcode' },
    { account: acc, initiative: ini },
    { account: acc, kind: withAll.kind },
    { account: acc, initiative: ini, source: src, kind: withAll.kind, q: withAll.title.slice(0, 5) },
  ];
  return WORK_TABS.flatMap((tab) => filters.map((f) => ({ tab, ...f })));
}

beforeAll(async () => {
  if (!PG) return;
  await freshDb(NAME);
  await runMigrations({ url: `postgres://localhost:5432/${NAME}`, log: () => {} });
  handle = createDb({ url: `postgres://localhost:5432/${NAME}`, max: 5, applicationName: 'work-list-test' });
  mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  ds = new DbDataSource({ handle, url: `postgres://localhost:5432/${NAME}`, userId: res.userId, clock: { now: () => now }, ranker: interimRanker });
}, 1_200_000);

afterAll(async () => {
  if (!PG) return;
  mock?.dispose();
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
}, 120_000);

describe.runIf(PG)('the Work list scope on Postgres', { timeout: 300_000 }, () => {
  async function samePayloads() {
    resetScopeMisses();
    const all = await shapes();
    expect(all.length).toBeGreaterThan(150);
    let nonEmpty = 0;
    for (const q of all) {
      const whole = await off(() => list(q));
      const scoped = await list(q);
      expect(scoped, JSON.stringify(q)).toEqual(whole);
      if (scoped.items.length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(20);
    expect(scopeMissSnapshot().total).toBe(0);
  }

  it('every list shape renders the same payload scoped as with the scopes off (strict, no scope miss)', samePayloads);

  it('the window: the open tab loads no closed work, a Closed page loads that page, text loads a superset', async () => {
    const whole = await ds.model(everything('test: whole'));
    const total = whole.all('workItems').length;
    const open = await ds.model(workScope({ tab: 'all_open' }));
    expect(open.windowed.has('workItems')).toBe(true);
    expect(open.all('workItems').length).toBeGreaterThan(0);
    expect(open.all('workItems').every((w) => !['done', 'snoozed', 'dismissed', 'suggested'].includes(w.state))).toBe(true);
    expect(open.all('workItems').length).toBeLessThan(total);
    const page = await ds.model(workScope({ tab: 'done', limit: 2 }));
    expect(page.all('workItems').length).toBe(3); // the page and one more: is there a next page (P25-6)
    expect(page.all('workItems').every((w) => w.state === 'done')).toBe(true);
    const text = await ds.model(workScope({ tab: 'all_open', q: 'no item says this' }));
    expect(text.all('workItems')).toEqual([]);
    // the open tab's statements: one window, one count; the rows read from work_items are the open tab's
    const log = startQueryLog(handle.pool as never);
    try {
      await list({});
    } finally {
      log.stop();
    }
    const counts = await list({});
    const itemRows = Math.max(...log.queries.filter((q) => q.tables.includes('work_items') && q.tables.includes('priority_scores') && !q.tables.includes('user_settings')).map((q) => q.rows));
    expect(itemRows).toBe(counts.items.length);
  });

  it('the counts stay exact after a reopen (state override) and with a deliverable (kind override)', async () => {
    const m = await ds.model(everything('test: pick'));
    const done = m.all('workItems').find((w) => w.state === 'done')!;
    await ds.itemAction({ params: { id: done.id, verb: 'reopen' }, body: { ifVersion: done.version } } as never);
    const reopened = await list({});
    expect(reopened.items.some((i) => i.id === done.id && i.state === 'reopened')).toBe(true);
    const task = m.all('workItems').find((w) => w.state === 'open' && w.kind === 'task');
    if (task) {
      const cur = (await ds.model(everything('test: cur'))).get('workItems', task.id)!;
      await ds.patchItem({ params: { id: task.id }, body: { ifVersion: cur.version, patch: { kind: 'deliverable' } } } as never);
      const d = await list({ kind: 'deliverable' });
      expect(d.items.some((i) => i.id === task.id)).toBe(true);
      expect((await list({ kind: 'task' })).items.some((i) => i.id === task.id)).toBe(false);
    }
    await samePayloads();
  });

  it('the Closed tab pages through every row (cursor/limit, additive) on both DataSources alike', async () => {
    for (const source of [ds, mock] as const) {
      for (const base of [{ tab: 'done' as WorkTab }, { tab: 'done' as WorkTab, q: 'e' }, { tab: 'all_open' as WorkTab }]) {
        const all = (await source.listItems({ query: base } as never)) as ItemsPayload;
        expect('nextCursor' in all).toBe(false);
        expect(all.total).toBe(all.items.length);
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 200; guard++) {
          const p = (await source.listItems({ query: { ...base, limit: 2, ...(cursor ? { cursor } : {}) } } as never)) as ItemsPayload;
          expect(p.items.length).toBeLessThanOrEqual(2);
          // every page counts every row
          expect(p.counts).toEqual(all.counts);
          expect(p.total).toBe(all.total);
          seen.push(...p.items.map((i) => i.id));
          if (!p.nextCursor) break;
          cursor = p.nextCursor;
        }
        expect(seen, `${source === ds ? 'db' : 'mock'} ${JSON.stringify(base)}`).toEqual(all.items.map((i) => i.id));
      }
    }
    // the db's Closed page is the same rows as the mock's (the order is the view's: closed newest first)
    const a = (await ds.listItems({ query: { tab: 'done', limit: 3 } } as never)) as ItemsPayload;
    const b = (await mock.listItems({ query: { tab: 'done', limit: 3 } } as never)) as ItemsPayload;
    expect(a.items.map((i) => i.title)).toEqual(b.items.map((i) => i.title));
    // P25-6: the keyset cursor is the last row's (closed, created, id): the same instants on both, each side's own id
    const key = (p: ItemsPayload) => parseClosedCursor(p.nextCursor ?? undefined);
    expect({ ...key(a)!, id: null }).toEqual({ ...key(b)!, id: null });
    expect([key(a)!.id, key(b)!.id]).toEqual([a.items.at(-1)!.id, b.items.at(-1)!.id]);
  });
});
