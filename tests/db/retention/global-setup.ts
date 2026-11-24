/** Drops and recreates control_center_retention_<suffix> with the Postgres 17 binaries and applies every migration. */
import { execFileSync } from 'node:child_process';

import { runMigrations } from '../../../src/db/migrate';

const PG_BIN = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';

export default async function setup(): Promise<void> {
  const url = process.env.RETENTION_DATABASE_URL ?? `postgres://localhost:5432/control_center_retention_${process.env.CC_TEST_DB_SUFFIX ?? 'main'}`;
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^control_center_retention_[a-z0-9]+$/.test(name)) throw new Error(`retention tests only run against control_center_retention_*, not "${name}"`);
  const conn = ['--host', u.hostname || 'localhost', '--port', u.port || '5432'];
  if (u.username) conn.push('--username', decodeURIComponent(u.username));
  execFileSync(`${PG_BIN}/dropdb`, [...conn, '--if-exists', '--force', name], { stdio: 'ignore' });
  execFileSync(`${PG_BIN}/createdb`, [...conn, name], { stdio: 'inherit' });
  await runMigrations({ url, log: () => {} });
}
