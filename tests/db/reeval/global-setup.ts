/**
 * Drops and recreates control_center_bereeval_* with the Postgres 17 binaries (the psql on PATH is v16),
 * then applies every migration from empty. Refuses to touch any other database.
 */
import { execFileSync } from 'node:child_process';

import { runMigrations } from '../../../src/db/migrate';
import { pgTool } from '../../support/pg';

import { BEREEVAL_DATABASE_URL } from './db-url';

// The Postgres client tools: PATH, then PG17_BIN, then Homebrew's postgresql@17 (tests/support/pg.ts).

export default async function setup(): Promise<void> {
  const url = BEREEVAL_DATABASE_URL;
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^control_center_bereeval(_[a-z0-9]+)?$/.test(name)) throw new Error(`BE-REEVAL tests only run against control_center_bereeval*, not "${name}"`);
  const conn = ['--host', u.hostname || 'localhost', '--port', u.port || '5432'];
  if (u.username) conn.push('--username', decodeURIComponent(u.username));
  // BEREEVAL_REUSE_DB=1 (local iteration only): keep the database and the loaded seed from the last run
  if (process.env.BEREEVAL_REUSE_DB !== '1') {
    execFileSync(pgTool('dropdb'), [...conn, '--if-exists', '--force', name], { stdio: 'ignore' });
    execFileSync(pgTool('createdb'), [...conn, name], { stdio: 'inherit' });
  }
  await runMigrations({ url, log: () => {} });
}
