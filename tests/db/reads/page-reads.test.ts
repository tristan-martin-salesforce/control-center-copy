/**
 * p4-page-scoped-reads on Postgres 17: pages read what they show, and show what they showed.
 *   - every page in the table renders the same payload scoped as with the scopes off (CC_READ_SCOPES=off, the 1.x
 *     reads), in strict mode: a page that reads outside its scope fails here;
 *   - the tables a page touches: the ledger reads no work, Outbox no calendar, the briefing no chat or scan ledger;
 *   - GET /needs loads ONE read model (it loaded eleven);
 *   - RD-1: open work outside the 14 days is on Home (due today), a close 60 days old is not in the briefing, and
 *     "closed since you left" after a long absence is; RD-2: that old item opens by id (one targeted read);
 *   - cache honesty: decide → an immediate re-read shows the decision;
 *   - RD-3: Deals pages through every account with the additive cursor/limit, on both DataSources.
 *
 * Own database: control_center_reads_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder data only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Seed } from '../../../src/contract';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { modelLoads } from '../../../src/server/datasource/db/model';
import { startQueryLog, summarize } from '../../../src/server/datasource/db/reads/query-log';
import { BRIEFING, everything, itemScope } from '../../../src/server/datasource/db/reads/scope';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { createMockDataSource, type MockDataSource } from '../../../src/server/datasource/mock';
import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';

const NAME = `control_center_reads_${testDbSuffix}`;
const PG = pgAvailable && process.env.CC_READS_DB !== '0';
const DAY = 86_400_000;

let handle: DbHandle;
let ds: DbDataSource;
let mock: MockDataSource;
let userId: string;
let now: Date;

/** Run `fn` with the scopes off (the 1.x reads: every collection, one model per read). */
async function off<T>(fn: () => Promise<T>): Promise<T> {
  process.env.CC_READ_SCOPES = 'off';
  try {
    return await fn();
  } finally {
    delete process.env.CC_READ_SCOPES;
  }
}

/** The same read scoped and unscoped, as JSON (key order kept: both come from the same builders). */
async function both(fn: () => Promise<unknown>): Promise<{ scoped: unknown; whole: unknown }> {
  const whole = JSON.parse(JSON.stringify(await off(fn)));
  const scoped = JSON.parse(JSON.stringify(await fn()));
  return { scoped, whole };
}

async function tablesOf(fn: () => Promise<unknown>): Promise<Set<string>> {
  const log = startQueryLog(handle.pool as never);
  try {
    await fn();
  } finally {
    log.stop();
  }
  return new Set(Object.keys(summarize(log.queries).tables));
}

/** Rewrite a row's timestamps as if it were old (fixture only: outside any change set, triggers off for this tx). */
async function age(table: 'work_items', id: string, set: ReturnType<typeof sql>) {
  await handle.db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(sql`update ${sql.identifier(table)} set ${set} where id = ${id}::uuid`);
  });
}

beforeAll(async () => {
  if (!PG) return;
  await freshDb(NAME);
  await runMigrations({ url: `postgres://localhost:5432/${NAME}`, log: () => {} });
  handle = createDb({ url: `postgres://localhost:5432/${NAME}`, max: 5, applicationName: 'reads-test' });
  mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  userId = res.userId;
  ds = new DbDataSource({ handle, url: `postgres://localhost:5432/${NAME}`, userId, clock: { now: () => now }, ranker: interimRanker });
}, 1_200_000);

afterAll(async () => {
  if (!PG) return;
  mock?.dispose();
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
}, 120_000);

describe.runIf(PG)('page-scoped reads on Postgres', { timeout: 300_000 }, () => {
  it('every page renders the same payload scoped as with the scopes off (strict: no read outside its scope)', async () => {
    const m = await ds.model(everything('test: ids'));
    const month = now.toISOString().slice(0, 7);
    const last = new Date(now.getTime() - 32 * DAY).toISOString().slice(0, 7);
    const day = now.toISOString().slice(0, 10);
    const reads: Array<[string, () => Promise<unknown>]> = [
      ['home', () => ds.getHome({ query: {} } as never)],
      ['home next day', () => ds.getHome({ query: { day: 'next' } } as never)],
      ['today', () => ds.getToday({} as never)],
      ['triage', () => ds.getTriage({} as never)],
      ['outbox', () => ds.getOutbox({} as never)],
      ['activity log', () => ds.getTime({ query: {} } as never)],
      ['activity rows', () => ds.getActivityLog({ query: {} } as never)],
      ['ledger', () => ds.getTimeLedger({ query: {} } as never)],
      ['history month', () => ds.getHistoryMonth({ query: { month } } as never)],
      ['history last month', () => ds.getHistoryMonth({ query: { month: last } } as never)],
      ['history day', () => ds.getHistoryDay({ params: { day } } as never)],
      ['vdp', () => ds.getVdpCoverage({} as never)],
      ['deals', () => ds.getDeals({ query: {} } as never)],
      ['health', () => ds.getHealth({} as never)],
      ['needs', () => ds.listNeeds({} as never)],
      // post-2.0 read profile (27-read-profile.md): the pages that loaded every collection
      ['briefs', () => ds.getBriefs({} as never)],
      ['assistant threads', () => ds.listChatThreads({} as never)],
      ['settings', () => ds.getSettings({} as never)],
      ['getting started', () => ds.getGuide({} as never)],
      // post-caps-ui: Agents and its tool panel (the agents scope)
      ['agents', () => ds.getAgents({} as never)],
      ['tools', () => ds.getTools({} as never)],
      ...m.all('accounts').map((a): [string, () => Promise<unknown>] => [`account ${a.id}`, () => ds.getAccount({ params: { accountId: a.id } } as never)]),
      ...m.all('workItems').map((w): [string, () => Promise<unknown>] => [`item ${w.id} (${w.state})`, () => ds.getItem({ params: { id: w.id } } as never)]),
    ];
    expect(reads.length).toBeGreaterThan(30);
    for (const [label, fn] of reads) {
      const r = await both(fn);
      expect(r.scoped, label).toEqual(r.whole);
    }
  });

  it('pages touch only the tables they render', async () => {
    const ledger = await tablesOf(() => ds.getTimeLedger({ query: {} } as never));
    // (work_items, activity_entries, opportunities and accounts are read by the kv side-car overlay every model carries:
    // a few promoted columns, D-98; the assertions name the tables the overlay never reads)
    for (const t of ['calendar_events', 'drafts', 'work_item_evidence', 'work_item_links', 'next_best_actions', 'chat_messages', 'scan_runs', 'time_blocks']) expect(ledger.has(t), `ledger reads ${t}`).toBe(false);
    expect(ledger.has('activity_entries')).toBe(true);

    const outbox = await tablesOf(() => ds.getOutbox({} as never));
    for (const t of ['calendar_events', 'calendar_event_attendees', 'time_blocks', 'activity_entry_time_blocks', 'chat_messages', 'missed_opp_findings', 'briefs']) expect(outbox.has(t), `outbox reads ${t}`).toBe(false);

    const home = await tablesOf(() => ds.getHome({ query: {} } as never));
    for (const t of ['chat_messages', 'chat_threads', 'scan_runs', 'scan_ledger_entries']) expect(home.has(t), `home reads ${t}`).toBe(false);

    const deals = await tablesOf(() => ds.getDeals({ query: {} } as never));
    for (const t of ['calendar_events', 'draft_renditions', 'time_blocks', 'next_best_actions', 'work_item_evidence']) expect(deals.has(t), `deals reads ${t}`).toBe(false);

    const agents = await tablesOf(() => ds.getAgents({} as never));
    for (const t of ['calendar_events', 'drafts', 'work_item_evidence', 'next_best_actions', 'chat_messages', 'briefs', 'time_blocks']) expect(agents.has(t), `agents reads ${t}`).toBe(false);

    // the whole read (scopes off) does read them: the assertions above are not vacuous
    const whole = await off(() => tablesOf(() => ds.getTimeLedger({ query: {} } as never)));
    expect(whole.has('work_item_evidence') && whole.has('calendar_events')).toBe(true);
  });

  it('GET /needs loads one read model (its ten page reads share it)', async () => {
    const loads = async () => {
      const before = modelLoads();
      await ds.listNeeds({} as never);
      return modelLoads() - before;
    };
    const scoped = await loads();
    const whole = await off(loads);
    expect(scoped).toBe(1);
    expect(whole).toBeGreaterThan(5);
  });

  it('RD-1 / RD-2: open work outside the window is in, an old close is out but opens by id, a long absence widens the window', async () => {
    const m = await ds.model(everything('test: pick'));
    const open = m.all('workItems').find((w) => w.state === 'open' && !w.isBackground)!;
    const done = m.all('workItems').find((w) => w.state === 'done')!;
    expect(open && done).toBeTruthy();
    const old = new Date(now.getTime() - 60 * DAY);
    // open work made 60 days ago, never touched since, due today: in the briefing (status, not age, decides)
    await age('work_items', open.id, sql`created_at = ${old}, updated_at = ${old}, status_changed_at = ${old}, due_at = ${new Date(now.getTime() + 3_600_000)}`);
    // a close 60 days old: outside the briefing
    await age('work_items', done.id, sql`created_at = ${old}, updated_at = ${old}, status_changed_at = ${old}, done_at = ${old}`);
    const b = await ds.model(BRIEFING);
    expect(b.get('workItems', open.id)?.id).toBe(open.id);
    expect(b.get('workItems', done.id)).toBeUndefined();
    expect(b.windowed.has('workItems')).toBe(true);
    // its page opens it all the same (item scope: one targeted read by id, not a widened window)
    const page = await ds.getItem({ params: { id: done.id } } as never);
    expect(page.item.id).toBe(done.id);
    expect((await ds.model(itemScope(done.id))).all('workItems').some((w) => w.id === done.id)).toBe(true);

    // away 70 days: "closed since you left" needs that close, so the briefing starts at the last-active time
    const meta = await handle.db.execute<{ value: Record<string, unknown> }>(sql`select value from user_settings where owner_user_id = ${userId} and key = 'cc.meta'`);
    const before = meta.rows[0]!.value;
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update user_settings set value = jsonb_set(value, '{lastActiveAt}', to_jsonb(${new Date(now.getTime() - 70 * DAY).toISOString()}::text)) where owner_user_id = ${userId} and key = 'cc.meta'`);
    });
    try {
      expect((await ds.model(BRIEFING)).get('workItems', done.id)?.id).toBe(done.id);
      const r = await both(() => ds.getHome({ query: {} } as never));
      expect(r.scoped).toEqual(r.whole);
    } finally {
      await handle.db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.execute(sql`update user_settings set value = ${JSON.stringify(before)}::jsonb where owner_user_id = ${userId} and key = 'cc.meta'`);
      });
    }
  });

  it('cache honesty: a decision shows on the very next read (Today, Home, Needs)', async () => {
    const t = await ds.getToday({} as never);
    const card = t.nowStack.cards[0]!;
    expect(card).toBeTruthy();
    await ds.itemAction({ params: { id: card.item.id, verb: 'done' }, body: { ifVersion: card.item.version } } as never);
    const after = await ds.getToday({} as never);
    expect(after.nowStack.cards.map((c) => c.item.id)).not.toContain(card.item.id);
    const home = JSON.stringify(await ds.getHome({ query: {} } as never));
    const needs = await ds.listNeeds({} as never);
    expect(needs.rows.some((r) => JSON.stringify(r).includes(card.item.id) && r.kind === 'reopen_review')).toBe(false);
    // and the whole read agrees
    const r = await both(() => ds.getHome({ query: {} } as never));
    expect(r.scoped).toEqual(r.whole);
    expect(JSON.stringify(r.scoped)).toBe(home);
  });

  it('RD-3: Deals pages through every account (cursor/limit, additive), on both DataSources alike', async () => {
    for (const source of [ds, mock] as const) {
      const all = await source.getDeals({ query: {} } as never);
      expect('nextCursor' in all).toBe(false);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard++) {
        const p = await source.getDeals({ query: { limit: 2, ...(cursor ? { cursor } : {}) } } as never);
        seen.push(...p.accounts.map((a) => a.id));
        // every page carries the whole summary: needs and pipeline count every account
        expect(p.needs).toEqual(all.needs);
        expect(p.pipeline).toEqual(all.pipeline);
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      expect(seen).toEqual(all.accounts.map((a) => a.id));
    }
  });
});
