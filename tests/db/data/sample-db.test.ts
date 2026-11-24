/**
 * The sample database (sample-data/tables loaded by scripts/sample-data/load.ts) yields a read model: every table loads,
 * every tool adapter maps, and a row that fails its contract is dropped, not fatal.
 *
 * Own database: control_center_sample_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Synthetic data only.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { loadModel } from '../../../src/server/datasource/db/model';
import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';

const PG = pgAvailable;
const NAME = `control_center_sample_${testDbSuffix}`;
const URL = `postgres://localhost:5432/${NAME}`;
const NOW = new Date('2026-11-18T16:00:00Z');
let handle: DbHandle;

const owner = async () => (await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`)).rows[0]!.id;
const adapterCount = async () => Number((await handle.db.execute<{ n: string }>(sql`select count(*) as n from tool_adapters`)).rows[0]!.n);

beforeAll(async () => {
  if (!PG) return;
  await freshDb(NAME);
  await runMigrations({ url: URL, log: () => {} });
  await promisify(execFile)('npx', ['tsx', 'scripts/sample-data/load.ts', '--db', NAME], { env: { ...process.env, DATABASE_URL: URL }, maxBuffer: 1 << 26 });
  handle = createDb({ url: URL, max: 3, applicationName: 'sample-db-test' });
}, 300_000);

afterAll(async () => {
  if (!PG) return;
  await handle?.close();
  await dropDb(NAME);
});

describe.runIf(PG)('sample database', () => {
  it('loads a full read model with every tool adapter', async () => {
    const m = await loadModel(handle.db, await owner(), NOW);
    expect(m.all('workItems').length).toBeGreaterThan(0);
    expect(m.all('toolAdapters')).toHaveLength(await adapterCount());
  }, 120_000);

  it('drops an adapter row that fails the contract instead of failing the model', async () => {
    // the audit trigger refuses a write outside a change set; this fixture corrupts a row on purpose, so bypass it
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update tool_adapters set version = '1.4.0' where key = 'repo-status'`);
    });
    const m = await loadModel(handle.db, await owner(), NOW);
    expect(m.all('toolAdapters')).toHaveLength((await adapterCount()) - 1);
  }, 120_000);
});
