/**
 * Drops and recreates control_center_be1a with the Postgres 17 binaries (the psql on PATH is v16),
 * then applies every migration from empty. Refuses to touch any other database.
 */
import { execFileSync } from 'node:child_process';

import { runMigrations } from '../../../src/db/migrate';
import { pgTool } from '../../support/pg';

// The Postgres client tools: PATH, then PG17_BIN, then Homebrew's postgresql@17 (tests/support/pg.ts).

export default async function setup(): Promise<void> {
  const url = process.env.BE1A_DATABASE_URL ?? 'postgres://localhost:5432/control_center_be1a';
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^control_center_be1a(_|$)/.test(name)) {
    throw new Error(`BE-1a tests only run against control_center_be1a*, not "${name}"`);
  }
  const conn = ['--host', u.hostname || 'localhost', '--port', u.port || '5432'];
  if (u.username) conn.push('--username', decodeURIComponent(u.username));
  execFileSync(pgTool('dropdb'), [...conn, '--if-exists', '--force', name], { stdio: 'ignore' });
  execFileSync(pgTool('createdb'), [...conn, name], { stdio: 'inherit' });
  await runMigrations({ url, log: () => {} });
}
