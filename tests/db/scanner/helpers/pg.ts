/**
 * Self-provisioned Postgres for stress regression tests that run inside the root `npm test`: each file gets
 * its own `control_center_stress_t_<tag>_<pid>` cloned from a freshly migrated template, with the
 * simulated-clock schema. Skips (returns null) when Postgres 17 is not reachable, so CI without a DB stays green.
 */
import { execFileSync } from 'node:child_process';

import { sql } from 'drizzle-orm';

import { createDb, type DbHandle } from '../../../../src/db/client';
import { runMigrations } from '../../../../src/db/migrate';
import { CLOCK_SCHEMA_SQL } from '../../../../scripts/stress/lib/sim-clock';
import { PG_CONN, pgAvailable as pgUp, pgTool } from '../../../support/pg';

const conn = PG_CONN;

/** Postgres answers on localhost:5432 (tests/support/pg.ts). */
export function pgAvailable(): boolean {
  return pgUp;
}

export interface TestDb {
  name: string;
  url: string;
  handle: DbHandle;
  drop(): Promise<void>;
}

export async function provisionTestDb(tag: string): Promise<TestDb> {
  const name = `control_center_stress_t_${tag}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63);
  execFileSync(pgTool('dropdb'), [...conn, '--if-exists', '--force', name], { stdio: 'ignore' });
  execFileSync(pgTool('createdb'), [...conn, name], { stdio: 'ignore' });
  const url = `postgres://localhost:5432/${name}`;
  await runMigrations({ url, log: () => {} });
  execFileSync(pgTool('psql'), [...conn, '-d', 'postgres', '-c', `alter database ${name} set search_path = stress, pg_catalog, public`], { stdio: 'ignore' });
  const handle = createDb({ url, max: 4, applicationName: `stress-test-${tag}`, pool: { options: '-c TimeZone=UTC -c search_path=stress,pg_catalog,public' } });
  await handle.db.execute(sql.raw(CLOCK_SCHEMA_SQL));
  return {
    name,
    url,
    handle,
    async drop() {
      await handle.close().catch(() => undefined);
      execFileSync(pgTool('dropdb'), [...conn, '--if-exists', '--force', name], { stdio: 'ignore' });
    },
  };
}
