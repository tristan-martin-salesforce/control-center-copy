/**
 * Page-read profile (p4-page-scoped-reads): run one DataSource read per page with query logging on and print, per
 * route, the tables it touched (rows each), total rows, bytes and the median time of a few warm runs.
 *
 *   npm run db:read-profile -- --route home            # one route
 *   npm run db:read-profile -- --route all [--runs 5]  # every page in docs/reviews/2026-11-20-holistic/15-page-reads.md
 *   npm run db:read-profile -- --route all --markdown  # the table rows for that doc
 *   npm run db:read-profile -- --route work --compare  # the Work list: every tab, Closed (whole, page 1, page 2), a
 *                                                      # search, one account (15-page-reads.md, "Work list scope, post-2.0")
 *   briefs, agents, assistant:threads, settings, getting-started: the rest of the pages (27-read-profile.md)
 *
 * Uses DATABASE_URL (default postgres://localhost:5432/command_center); the clock is the seed's asOf (CC_DB_NOW=seed)
 * unless CC_DB_NOW says otherwise. Reads only: no route here writes, and it prints table names, counts and timings,
 * never ids, titles or the URL (*Local data, privacy-safe logs*).
 */
import { sql } from 'drizzle-orm';

import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { DbDataSource, DbClock } from '../../src/server/datasource/db';
import { DbCtx } from '../../src/server/datasource/db/ctx';
import { ReadModel } from '../../src/server/datasource/db/model';
import { everything, scopeLabel, type ReadScope } from '../../src/server/datasource/db/reads/scope';
import { repeats, startQueryLog, summarize, type QuerySummary } from '../../src/server/datasource/db/reads/query-log';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const route = opt('--route') ?? 'all';
const runs = Math.max(1, Number(opt('--runs') ?? 5));
const markdown = args.includes('--markdown');
/** `--collections`: also list the read-model collections each route read (how its scope was chosen). */
const showCollections = args.includes('--collections');
/** `--slow`: also print each route's five slowest statements (the tables they name, rows, ms). */
const showSlow = args.includes('--slow');
/**
 * `--compare`: run each route with the scopes off (CC_READ_SCOPES=off: the 1.x reads) and on, interleaved run by run
 * so machine load hits both alike, and print both medians (the before/after table of 15-page-reads.md).
 */
const compare = args.includes('--compare');
/**
 * `--post-model`: split each route at the moment its read model resolved, and print (medians of the runs) the
 * statements sent after it, their summed ms, and the wall ms from the model to the response (15-page-reads.md, "Home
 * SQL, post-2.0"). Summed ms counts a statement's wait for a pool connection, so it can exceed the wall time.
 */
const postModel = args.includes('--post-model');
let modelAt: number | null = null;
if (postModel) {
  const proto = DbCtx.prototype as unknown as { model: (...a: unknown[]) => Promise<unknown> };
  const load = proto.model;
  proto.model = async function (this: unknown, ...a: unknown[]) {
    const m = await load.apply(this, a);
    modelAt ??= performance.now();
    return m;
  };
}
/** `--dupes`: also print each route's exact repeats (same text and parameters inside one request) and the scopes it loaded. */
const showDupes = args.includes('--dupes');
/** `--statements`: also print every statement of a route's first run, in order (the tables it names, rows, ms). */
const showStatements = args.includes('--statements');
/** The scopes each run's models were loaded for (every model load, shared or not: `scopeLabel`, never an id). */
const scopes: string[] = [];
{
  const proto = DbCtx.prototype as unknown as { loadScoped: (s: ReadScope, ...a: unknown[]) => Promise<unknown> };
  const load = proto.loadScoped;
  proto.loadScoped = function (this: unknown, sc: ReadScope, ...a: unknown[]) {
    scopes.push(scopeLabel(sc));
    return load.call(this, sc, ...a);
  };
}
const read = new Set<string>();
if (showCollections) {
  const proto = ReadModel.prototype as unknown as { col: (c: string) => unknown };
  const col = proto.col;
  proto.col = function (this: unknown, c: string) {
    read.add(c);
    return col.call(this, c);
  };
}

type Ds = DbDataSource;
type Ids = { accountId: string | null; itemId: string | null; month: string; closedCursor: string | null };
const ROUTES: Record<string, (ds: Ds, ids: Ids) => Promise<unknown>> = {
  home: (ds) => ds.getHome({ query: {} } as never),
  today: (ds) => ds.getToday({} as never),
  needs: (ds) => ds.listNeeds({} as never),
  triage: (ds) => ds.getTriage({} as never),
  outbox: (ds) => ds.getOutbox({} as never),
  'activity:log': (ds) => ds.getTime({ query: {} } as never),
  'activity:rows': (ds) => ds.getActivityLog({ query: {} } as never),
  'activity:ledger': (ds) => ds.getTimeLedger({ query: {} } as never),
  history: (ds, ids) => ds.getHistoryMonth({ query: { month: ids.month } } as never),
  vdp: (ds) => ds.getVdpCoverage({} as never),
  deals: (ds) => ds.getDeals({} as never),
  account: (ds, ids) => (ids.accountId ? ds.getAccount({ params: { accountId: ids.accountId } } as never) : Promise.resolve(null)),
  item: (ds, ids) => (ids.itemId ? ds.getItem({ params: { id: ids.itemId } } as never) : Promise.resolve(null)),
  health: (ds) => ds.getHealth({} as never),
  briefs: (ds) => ds.getBriefs({} as never),
  agents: (ds) => ds.getAgents({} as never),
  'assistant:threads': (ds) => ds.listChatThreads({} as never),
  settings: (ds) => ds.getSettings({} as never),
  'getting-started': (ds) => ds.getGuide({} as never),
  // the Work list (GET /items): the default tab, the Closed tab whole and one page, a text search, one account
  'work:open': (ds) => ds.listItems({ query: { tab: 'all_open' } } as never),
  'work:said_by_me': (ds) => ds.listItems({ query: { tab: 'said_by_me' } } as never),
  'work:asked_of_me': (ds) => ds.listItems({ query: { tab: 'asked_of_me' } } as never),
  'work:promises': (ds) => ds.listItems({ query: { tab: 'promises' } } as never),
  'work:trainings': (ds) => ds.listItems({ query: { tab: 'trainings' } } as never),
  'work:snoozed': (ds) => ds.listItems({ query: { tab: 'snoozed' } } as never),
  'work:closed': (ds) => ds.listItems({ query: { tab: 'done' } } as never),
  'work:closed:page': (ds) => ds.listItems({ query: { tab: 'done', limit: 50 } } as never),
  // the second page: the cursor the first page of `limit: 20` returns (the sample holds 48 closed items)
  'work:closed:page2': (ds, ids) => ds.listItems({ query: { tab: 'done', limit: 20, ...(ids.closedCursor ? { cursor: ids.closedCursor } : {}) } } as never),
  'work:search': (ds) => ds.listItems({ query: { tab: 'all_open', q: 'e' } } as never),
  'work:account': (ds, ids) => ds.listItems({ query: { tab: 'all_open', ...(ids.accountId ? { account: ids.accountId } : {}) } } as never),
};
/** `--route work`: every Work list query above. */
const WORK_ROUTES = Object.keys(ROUTES).filter((k) => k.startsWith('work:'));

const keys = route === 'all' ? Object.keys(ROUTES) : route.split(',').flatMap((k) => (k === 'work' ? WORK_ROUTES : [k]));
for (const k of keys) if (!ROUTES[k]) throw new Error(`unknown route "${k}" (one of: ${Object.keys(ROUTES).join(', ')}, work, all)`);

const url = resolveDatabaseUrl();
const handle = createDb({ url, max: 5, applicationName: 'command-center-read-profile' });
let code = 0;
try {
  const u = await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`);
  if (!u.rows[0]) throw new Error(`no user in ${databaseName(url)}`);
  const userId = u.rows[0].id;
  const ds = new DbDataSource({ handle, userId, clock: new DbClock(process.env.CC_DB_NOW ?? 'seed') });
  try {
    // an account with opps and an open item, by the ids the contract uses (one full model, before any measuring)
    const m0 = await ds.model(everything('read profile: pick an account and an item'));
    const open = m0.all('workItems').filter((w) => w.state !== 'done' && w.state !== 'dismissed');
    const acct = m0.all('accounts').find((a) => m0.all('opps').some((o) => o.accountId === a.id)) ?? m0.all('accounts')[0];
    const first = (await ds.listItems({ query: { tab: 'done', limit: 20 } } as never)) as { nextCursor?: string | null };
    const ids: Ids = { accountId: acct?.id ?? null, itemId: open[0]?.id ?? null, month: ds.now().toISOString().slice(0, 7), closedCursor: first.nextCursor ?? null };
    const out: Array<{ route: string; ms: number; summary: QuerySummary }> = [];
    const measure = async (k: string, off: boolean) => {
      const fn = ROUTES[k]!;
      if (off) process.env.CC_READ_SCOPES = 'off';
      else delete process.env.CC_READ_SCOPES;
      read.clear();
      scopes.length = 0;
      const log = startQueryLog(handle.pool as never);
      modelAt = null;
      const t0 = performance.now();
      await fn(ds, ids);
      const end = performance.now();
      const ms = end - t0;
      log.stop();
      const post = modelAt === null ? [] : log.queries.filter((q) => q.startedAt >= modelAt!);
      return { ms, queries: log.queries, scopes: [...scopes], collections: [...read].sort(), post: { queries: post.length, sqlMs: post.reduce((a, q) => a + q.ms, 0), wallMs: modelAt === null ? 0 : end - modelAt } };
    };
    const median = (xs: number[]) => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!);
    const cmp: Array<{ route: string; off: { ms: number; summary: QuerySummary }; on: { ms: number; summary: QuerySummary } }> = [];
    const posts: Array<{ route: string; queries: number; sqlMs: number; wallMs: number }> = [];
    for (const k of keys) {
      await ROUTES[k]!(ds, ids); // warm: connections, the attribution cache, prepared plans
      const t = { off: [] as number[], on: [] as number[] };
      const p = { queries: [] as number[], sqlMs: [] as number[], wallMs: [] as number[] };
      let off: QuerySummary | null = null;
      let on: QuerySummary | null = null;
      for (let i = 0; i < runs; i++) {
        if (compare) {
          const a = await measure(k, true);
          t.off.push(a.ms);
          off ??= summarize(a.queries);
        }
        const b = await measure(k, false);
        t.on.push(b.ms);
        p.queries.push(b.post.queries);
        p.sqlMs.push(b.post.sqlMs);
        p.wallMs.push(b.post.wallMs);
        if (!on) {
          on = summarize(b.queries);
          if (showCollections) console.log(JSON.stringify({ route: k, collections: b.collections }));
          if (showStatements) for (const q of b.queries) console.log(JSON.stringify({ route: k, tables: q.tables.join(','), rows: q.rows, kb: Math.round(q.bytes / 1024), ms: Math.round(q.ms * 10) / 10 }));
          if (showDupes) console.log(JSON.stringify({ route: k, scopes: b.scopes, repeats: repeats(b.queries) }));
          if (showSlow) console.log(JSON.stringify({ route: k, slow: [...b.queries].sort((x, y) => y.ms - x.ms).slice(0, 5).map((q) => ({ tables: q.tables.join(','), rows: q.rows, ms: Math.round(q.ms) })) }));
        }
      }
      out.push({ route: k, ms: median(t.on), summary: on! });
      if (postModel) posts.push({ route: k, queries: median(p.queries), sqlMs: median(p.sqlMs), wallMs: median(p.wallMs) });
      if (compare) cmp.push({ route: k, off: { ms: median(t.off), summary: off! }, on: { ms: median(t.on), summary: on! } });
    }
    delete process.env.CC_READ_SCOPES;
    if (postModel) {
      console.log('| Route | ms (median) | After the model: statements | summed statement ms | wall ms |');
      console.log('|---|---|---|---|---|');
      for (const r of posts) console.log(`| ${r.route} | ${out.find((o) => o.route === r.route)!.ms} | ${r.queries} | ${r.sqlMs} | ${r.wallMs} |`);
    }
    if (compare) {
      const n = (x: QuerySummary) => Object.keys(x.tables).length;
      console.log('| Route | Tables before → after | Rows before → after | KB before → after | Queries before → after | ms before → after |');
      console.log('|---|---|---|---|---|---|');
      for (const r of cmp) console.log(`| ${r.route} | ${n(r.off.summary)} → ${n(r.on.summary)} | ${r.off.summary.rows} → ${r.on.summary.rows} | ${Math.round(r.off.summary.bytes / 1024)} → ${Math.round(r.on.summary.bytes / 1024)} | ${r.off.summary.queries} → ${r.on.summary.queries} | ${r.off.ms} → ${r.on.ms} |`);
    } else if (markdown) {
      console.log('| Route | Tables | Rows | KB | Queries | ms (median) |');
      console.log('|---|---|---|---|---|---|');
      for (const r of out) console.log(`| ${r.route} | ${Object.keys(r.summary.tables).length} | ${r.summary.rows} | ${Math.round(r.summary.bytes / 1024)} | ${r.summary.queries} | ${r.ms} |`);
    } else {
      for (const r of out) console.log(JSON.stringify({ route: r.route, ms: r.ms, queries: r.summary.queries, rows: r.summary.rows, kb: Math.round(r.summary.bytes / 1024), tables: r.summary.tables }));
    }
  } finally {
    await ds.dispose();
  }
} catch (err) {
  console.error(`read-profile: ${(err as Error).message}`);
  code = 1;
} finally {
  await handle.close();
}
process.exit(code);
