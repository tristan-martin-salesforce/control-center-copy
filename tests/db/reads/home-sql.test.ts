/**
 * Post-2.0 Home SQL (docs/reviews/2026-11-20-holistic/15-page-reads.md, "Home SQL, post-2.0"): on the sample database
 * (sample-data/tables, about one month of one SE's work), GET /home and GET /today send at most a pinned number of
 * statements, and the helpers Home shares read once per request (reads/session.ts readMemo): the VDP mirror, my opps
 * and accounts, the use-case plan's inputs and the DC requests used to be read up to four times.
 *
 * Also the memo's own rules (no database): one load per key inside a session, none outside, per handle, and a failed
 * load is forgotten.
 *
 * Own database: control_center_sample_homesql_<CC_TEST_DB_SUFFIX>, dropped and recreated per run (the sample loader
 * only writes into a database whose name says "sample"). Synthetic sample data only.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { DbClock, DbDataSource } from '../../../src/server/datasource/db';
import { DbCtx } from '../../../src/server/datasource/db/ctx';
import { startQueryLog, type LoggedQuery } from '../../../src/server/datasource/db/reads/query-log';
import { readMemo, withReadMemo } from '../../../src/server/datasource/db/reads/session';
import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';

const NAME = `control_center_sample_homesql_${testDbSuffix}`;
const URL = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_READS_DB !== '0';
const ROOT = path.resolve(__dirname, '../../..');

/**
 * Upper bounds on the sample (measured 2026-11-21: Home 84 statements, 28 after the model; Today 81 and 25). Before
 * this work Home sent 104 (48 after the model) and Today 95 (39). A new read on Home is fine: raise the bound here
 * and say why in 15-page-reads.md; a duplicate read is not.
 */
const HOME_MAX = 88;
const HOME_AFTER_MODEL_MAX = 30;
const TODAY_MAX = 85;
const TODAY_AFTER_MODEL_MAX = 27;

let handle: DbHandle;
let ds: DbDataSource;
let modelAt: number | null = null;

beforeAll(async () => {
  if (!PG) return;
  await freshDb(NAME);
  await runMigrations({ url: URL, log: () => {} });
  await promisify(execFile)(path.join(ROOT, 'node_modules/.bin/tsx'), ['scripts/sample-data/load.ts', '--db', NAME], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  handle = createDb({ url: URL, max: 5, applicationName: 'home-sql-test' });
  const u = await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`);
  ds = new DbDataSource({ handle, url: URL, userId: u.rows[0]!.id, clock: new DbClock('seed') });
  // when the page's read model resolved: the statements after it are the page's own SQL
  const proto = DbCtx.prototype as unknown as { model: (...a: unknown[]) => Promise<unknown> };
  const load = proto.model;
  proto.model = async function (this: unknown, ...a: unknown[]) {
    const m = await load.apply(this, a);
    modelAt ??= performance.now();
    return m;
  };
}, 600_000);

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
}, 120_000);

async function logged(fn: () => Promise<unknown>): Promise<{ all: LoggedQuery[]; after: LoggedQuery[] }> {
  await fn(); // warm: the user, the attribution cache
  const log = startQueryLog(handle.pool as never);
  modelAt = null;
  try {
    await fn();
  } finally {
    log.stop();
  }
  const at = modelAt;
  return { all: log.queries, after: at === null ? [] : log.queries.filter((q) => q.startedAt >= at) };
}

const naming = (qs: readonly LoggedQuery[], table: string) => qs.filter((q) => q.tables.includes(table)).length;

describe.runIf(PG)('Home and Today SQL on the sample database', { timeout: 300_000 }, () => {
  it('GET /home: at most the pinned statements, and its shared helpers read once', async () => {
    const { all, after } = await logged(() => ds.getHome({ query: {} } as never));
    expect(all.length).toBeLessThanOrEqual(HOME_MAX);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThanOrEqual(HOME_AFTER_MODEL_MAX);
    // once per request: the VDP mirror, the use-case read-back, the DC requests (each read up to four times before)
    expect(naming(all, 'vdp_records')).toBe(1);
    expect(naming(all, 'org62_use_cases')).toBe(1);
    expect(naming(after, 'deal_contribution_requests')).toBe(1); // the model reads its own
    expect(naming(after, 'canvas_row_overrides')).toBe(1);
  });

  it('GET /today: at most the pinned statements, and its shared helpers read once', async () => {
    const { all, after } = await logged(() => ds.getToday({} as never));
    expect(all.length).toBeLessThanOrEqual(TODAY_MAX);
    expect(after.length).toBeLessThanOrEqual(TODAY_AFTER_MODEL_MAX);
    expect(naming(all, 'vdp_records')).toBe(1);
    expect(naming(all, 'org62_use_cases')).toBe(1);
  });

  it('the memo ends with the request: two GET /home read the mirror twice', async () => {
    const log = startQueryLog(handle.pool as never);
    try {
      await ds.getHome({ query: {} } as never);
      await ds.getHome({ query: {} } as never);
    } finally {
      log.stop();
    }
    expect(naming(log.queries, 'vdp_records')).toBe(2);
  });
});

describe('readMemo (request-scoped)', () => {
  it('loads once per key inside a session, per handle, and never outside one', async () => {
    let n = 0;
    const load = () => Promise.resolve(++n);
    const a = {};
    const b = {};
    expect(await readMemo(a, 'k', load)).toBe(1);
    expect(await readMemo(a, 'k', load)).toBe(2); // no session: no memo
    await withReadMemo(async () => {
      expect(await Promise.all([readMemo(a, 'k', load), readMemo(a, 'k', load)])).toEqual([3, 3]);
      expect(await readMemo(b, 'k', load)).toBe(4); // another handle (a transaction) is never served from the pool's
      expect(await readMemo(a, 'other', load)).toBe(5);
      await withReadMemo(async () => expect(await readMemo(a, 'k', load)).toBe(3)); // nested: the same request
    });
    await withReadMemo(async () => expect(await readMemo(a, 'k', load)).toBe(6)); // a new request reads again
  });

  it('forgets a failed load', async () => {
    let n = 0;
    await withReadMemo(async () => {
      await expect(readMemo({}, 'k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      const h = {};
      await expect(readMemo(h, 'k', () => (++n === 1 ? Promise.reject(new Error('once')) : Promise.resolve(n)))).rejects.toThrow('once');
      expect(await readMemo(h, 'k', () => Promise.resolve(++n))).toBe(2);
    });
  });
});
