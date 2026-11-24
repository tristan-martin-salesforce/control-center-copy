/**
 * One Postgres helper for the DB-touching tests in the root suite (ENG-1, R3). Before it, 22 files each carried their
 * own copy of "the Homebrew path, createdb, dropdb", and the ones that only checked that the binary existed errored
 * (instead of skipping) on a Mac where Postgres was installed but not running, or not installed at all.
 *
 *   import { freshDb, pgAvailable } from '../support/pg';
 *   describe.skipIf(!pgAvailable)('… on Postgres', () => { beforeAll(async () => { url = await freshDb(NAME); … }); });
 *
 * The binaries: `psql` on PATH → PG17_BIN → Homebrew's postgresql@17 (Apple Silicon, then Intel). `pgAvailable` is
 * true only when the server answers `select 1` on localhost:5432. Test databases only: every name must start with
 * `control_center_` and must not be the app's own database.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

export const PG_HOST = 'localhost';
export const PG_PORT = '5432';
export const PG_CONN = ['--host', PG_HOST, '--port', PG_PORT];

const HOMEBREW_PG17 = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin'];

/** The directory holding psql / createdb / dropdb, or null when none is found. */
export function resolvePgBin(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).find((d) => exists(join(d, 'psql')) && exists(join(d, 'createdb')));
  const candidates = [onPath, env.PG17_BIN, ...HOMEBREW_PG17].filter((d): d is string => !!d);
  return candidates.find((d) => exists(join(d, 'psql'))) ?? null;
}

export const pgBinDir = resolvePgBin();

/** The full path of one Postgres client tool (throws when no Postgres is installed: guard with `pgAvailable`). */
export function pgTool(name: 'psql' | 'createdb' | 'dropdb' | 'pg_dump' | 'pg_restore'): string {
  if (!pgBinDir) throw new Error('Postgres client tools not found (PATH, PG17_BIN, Homebrew postgresql@17)');
  return join(pgBinDir, name);
}

function probe(): boolean {
  if (!pgBinDir) return false;
  try {
    execFileSync(pgTool('psql'), [...PG_CONN, '-d', 'postgres', '-Atc', 'select 1'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Postgres is installed and answering on localhost:5432. */
export const pgAvailable: boolean = probe();

/** CC_TEST_DB_SUFFIX, lower-cased to [a-z0-9] ("main" when unset), so parallel builders never share a database. */
export const testDbSuffix = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';

export const dbUrl = (name: string) => `postgres://${PG_HOST}:${PG_PORT}/${name}`;

function assertTestDb(name: string): void {
  if (!/^control_center_[a-z0-9_]+$/.test(name) || name === 'command_center' || name === 'control_center') throw new Error(`refusing database "${name}": test databases are control_center_<something>`);
}

const run = promisify(execFile);

/**
 * A test database, empty, and its URL. Dropped and created again by default; `reuse: true` creates it only when
 * missing (CREATE DATABASE serializes on template1 while other lanes create theirs; the caller empties it).
 * Async, so a slow createdb never blocks vitest's worker RPC.
 */
export async function freshDb(name: string, opts: { reuse?: boolean } = {}): Promise<string> {
  assertTestDb(name);
  const exists = opts.reuse ? await run(pgTool('psql'), [...PG_CONN, '-d', 'postgres', '-Atc', `select 1 from pg_database where datname = '${name}'`]).then((r) => r.stdout.trim() === '1') : false;
  if (!exists) {
    if (!opts.reuse) await run(pgTool('dropdb'), [...PG_CONN, '--if-exists', '--force', name]);
    await run(pgTool('createdb'), [...PG_CONN, name]);
  }
  return dbUrl(name);
}

/** Drop a test database (no error when it is already gone). */
export async function dropDb(name: string): Promise<void> {
  assertTestDb(name);
  await run(pgTool('dropdb'), [...PG_CONN, '--if-exists', '--force', name]);
}
