/**
 * Post-2.0 read profile (docs/reviews/2026-11-20-holistic/27-read-profile.md): on the sample database (sample-data/tables,
 * about one month of one SE's work) every page read sends at most a stated number of statements, and none of them
 * repeats an earlier one of the same request exactly (same text, same parameters: what `withReadMemo` or one model
 * read should have shared). The routes are `npm run db:read-profile`'s.
 *
 * A budget is the measured count (2026-11-21) plus a little room. A new read on a page is fine: raise its budget here
 * with the reason, and re-run the profile for 27-read-profile.md. A repeat is not: share it (reads/session.ts).
 *
 * Own database: control_center_sample_budget_<CC_TEST_DB_SUFFIX>, dropped and recreated per run (the sample loader only
 * writes into a database whose name says "sample"). Synthetic sample data only.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { DbClock, DbDataSource } from '../../../src/server/datasource/db';
import { repeats, startQueryLog } from '../../../src/server/datasource/db/reads/query-log';
import { everything } from '../../../src/server/datasource/db/reads/scope';
import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';

const NAME = `control_center_sample_budget_${testDbSuffix}`;
const URL = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_READS_DB !== '0';
const ROOT = path.resolve(__dirname, '../../..');

type Ids = { accountId: string; itemId: string; month: string; closedCursor: string };
interface Budget {
  read: (ds: DbDataSource, ids: Ids) => Promise<unknown>;
  /** Statements per request, at most. */
  max: number;
  /** Where the count comes from (the base read every model sends is 11: kv and sections, the sidecar overlay, user, people, identities, policies). */
  why: string;
}

const WORK = 'the work scope: the tab window, its counts, items, links, chips, accounts, opps, initiatives, meetings by id, connectors';
const BUDGETS: Record<string, Budget> = {
  home: { read: (ds) => ds.getHome({ query: {} } as never), max: 82, why: 'the briefing model (~50) plus Home SQL after it (~28: Q1 ids, since, forecast, VDP, DC needs, waiting count); home-sql.test.ts pins the split' },
  today: { read: (ds) => ds.getToday({} as never), max: 79, why: 'the briefing model plus Today SQL (~25)' },
  needs: { read: (ds) => ds.listNeeds({} as never), max: 96, why: 'ONE whole model for its ten providers (~50) plus their SQL, each shared helper once (read memo)' },
  triage: { read: (ds) => ds.getTriage({} as never), max: 36, why: 'the triage model (the briefing window) plus Q9' },
  outbox: { read: (ds) => ds.getOutbox({} as never), max: 29, why: 'drafts and their children, the items they are about with evidence' },
  'activity:log': { read: (ds) => ds.getTime({ query: {} } as never), max: 41, why: 'activity, meetings, blocks, drafts, runs and the attribution context' },
  'activity:rows': { read: (ds) => ds.getActivityLog({ query: {} } as never), max: 39, why: 'as Log it, without time blocks' },
  'activity:ledger': { read: (ds) => ds.getTimeLedger({ query: {} } as never), max: 18, why: 'the base, activity and its opps, accounts and vocabulary' },
  history: { read: (ds, ids) => ds.getHistoryMonth({ query: { month: ids.month } } as never), max: 46, why: 'the month window ids (4) and the collections the grid composes from' },
  vdp: { read: (ds) => ds.getVdpCoverage({} as never), max: 38, why: 'the vdp model plus the mirror, candidates, runs, budget, server, pushes and the use-case inputs, each once' },
  deals: { read: (ds) => ds.getDeals({} as never), max: 36, why: 'live items, accounts, opps, missed opps, activity (the dismissal memory\'s calls, D-103 (d)) and the Deals SQL' },
  account: { read: (ds, ids) => ds.getAccount({ params: { accountId: ids.accountId } } as never), max: 50, why: 'one account: its items, assets, runs, briefs, meetings, activity (the dismissal memory\'s calls, D-103 (d)) and its needs' },
  item: { read: (ds, ids) => ds.getItem({ params: { id: ids.itemId } } as never), max: 45, why: 'one item and its family: evidence, NBAs, proposals, drafts, meetings, runs' },
  health: { read: (ds) => ds.getHealth({} as never), max: 37, why: 'connectors, stale counts, spend and the ledger counts' },
  briefs: { read: (ds) => ds.getBriefs({} as never), max: 16, why: 'the base plus briefs, highlights, reasons and watches' },
  agents: { read: (ds) => ds.getAgents({} as never), max: 16, why: 'the agents scope (post-caps-ui): the base plus sessions, app runs, tool runs, their outputs and the adapters (15 measured)' },
  'assistant:threads': { read: (ds) => ds.listChatThreads({} as never), max: 14, why: 'the base plus the threads and their messages' },
  settings: { read: (ds) => ds.getSettings({} as never), max: 12, why: 'the base read only' },
  'getting-started': { read: (ds) => ds.getGuide({} as never), max: 22, why: 'connectors, drafts and two counts' },
  'work:open': { read: (ds) => ds.listItems({ query: { tab: 'all_open' } } as never), max: 33, why: WORK },
  'work:said_by_me': { read: (ds) => ds.listItems({ query: { tab: 'said_by_me' } } as never), max: 33, why: WORK },
  'work:asked_of_me': { read: (ds) => ds.listItems({ query: { tab: 'asked_of_me' } } as never), max: 33, why: WORK },
  'work:promises': { read: (ds) => ds.listItems({ query: { tab: 'promises' } } as never), max: 29, why: `${WORK} (no training rows to read)` },
  'work:trainings': { read: (ds) => ds.listItems({ query: { tab: 'trainings' } } as never), max: 33, why: WORK },
  'work:snoozed': { read: (ds) => ds.listItems({ query: { tab: 'snoozed' } } as never), max: 33, why: WORK },
  'work:closed': { read: (ds) => ds.listItems({ query: { tab: 'done' } } as never), max: 33, why: WORK },
  'work:closed:page': { read: (ds) => ds.listItems({ query: { tab: 'done', limit: 20 } } as never), max: 33, why: `${WORK}; one page` },
  'work:closed:page2': { read: (ds, ids) => ds.listItems({ query: { tab: 'done', limit: 20, cursor: ids.closedCursor } } as never), max: 33, why: `${WORK}; the second page` },
  'work:search': { read: (ds) => ds.listItems({ query: { tab: 'all_open', q: 'e' } } as never), max: 32, why: `${WORK} (the superset path: no count query)` },
  'work:account': { read: (ds, ids) => ds.listItems({ query: { tab: 'all_open', account: ids.accountId } } as never), max: 29, why: `${WORK}; one account (fewer joined collections to read)` },
};

let handle: DbHandle;
let ds: DbDataSource;
let ids: Ids;

beforeAll(async () => {
  if (!PG) return;
  await freshDb(NAME);
  await runMigrations({ url: URL, log: () => {} });
  await promisify(execFile)(path.join(ROOT, 'node_modules/.bin/tsx'), ['scripts/sample-data/load.ts', '--db', NAME], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  handle = createDb({ url: URL, max: 5, applicationName: 'profile-budget-test' });
  const u = await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`);
  ds = new DbDataSource({ handle, url: URL, userId: u.rows[0]!.id, clock: new DbClock('seed') });
  const m = await ds.model(everything('test: pick an account and an item'));
  const acct = m.all('accounts').find((a) => m.all('opps').some((o) => o.accountId === a.id))!;
  const item = m.all('workItems').find((w) => w.state !== 'done' && w.state !== 'dismissed')!;
  const first = (await ds.listItems({ query: { tab: 'done', limit: 20 } } as never)) as { nextCursor?: string | null };
  ids = { accountId: acct.id, itemId: item.id, month: ds.now().toISOString().slice(0, 7), closedCursor: first.nextCursor! };
}, 600_000);

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
}, 120_000);

describe.runIf(PG)('page read budgets on the sample database', { timeout: 300_000 }, () => {
  it('the second page of Closed exists (the sample has more than 20 closed items)', () => {
    expect(ids.closedCursor).toBeTruthy();
  });

  for (const [route, b] of Object.entries(BUDGETS)) {
    it(`${route}: at most ${b.max} statements, none repeated (${b.why})`, async () => {
      await b.read(ds, ids); // warm: the user, the attribution cache
      const log = startQueryLog(handle.pool as never);
      try {
        await b.read(ds, ids);
      } finally {
        log.stop();
      }
      expect(log.queries.length, `${route} statements`).toBeLessThanOrEqual(b.max);
      expect(log.queries.length).toBeGreaterThan(5);
      expect(repeats(log.queries), `${route} exact repeats`).toEqual({ count: 0, tables: {} });
    });
  }
});
