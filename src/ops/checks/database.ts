/** Postgres reachable, the app database present, and the migrations as the worker sees them (DEP.DB.*, DATA.SCHEMA_*). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { compareSchema, describeSchema, readJournal, type JournalEntry } from '../../db/migration-state';
import { readEnvFile } from '../envfile';
import { DB_NAME, envFilePath, PG17_BIN } from '../paths';
import { dataMajor, dbEngine, pgDataDir, pgRunDir, pingSocket, socketFile, type DbEngine } from '../pg-cluster';
import { bad, isCompiledRelease, npmRun, ok, type Check, type DoctorContext } from './types';

export const appDb = (c: Pick<DoctorContext, 'appDb'>) => c.appDb ?? DB_NAME;

/** Which database this install runs on (D-98): the environment and the env file, as resolveDatabaseUrl reads them. */
export const engineOf = (c: Pick<DoctorContext, 'env'>): DbEngine => dbEngine(c.env, readEnvFile(envFilePath(c.env)) ?? {});

export const KICKSTART_DB = 'launchctl kickstart -k gui/$UID/com.commandcenter.db';

/** Command Center's own cluster: set up, then answering on its socket. */
async function checkBundled(c: DoctorContext) {
  const label = "Command Center's database (Postgres 17)";
  const sock = socketFile(pgRunDir(c.env));
  if (!dataMajor(pgDataDir(c.env))) return bad('fail', 'postgres', label, 'not set up yet', npmRun(c, 'ops:install'), { engine: 'bundled' }, { code: 'DEP.DB.NOT_SET_UP', state: 'missing' });
  const r = await (c.pingSocket ?? pingSocket)(sock);
  if (r === 'ready') return ok('postgres', label, 'accepting connections on its socket (no TCP port)', { engine: 'bundled' });
  return bad('fail', 'postgres', label, r === 'starting' ? 'starting up' : 'not accepting connections', isCompiledRelease(c) ? `${KICKSTART_DB}  (if that says it can't find the service: ${npmRun(c, 'ops:install')})` : KICKSTART_DB, { engine: 'bundled' }, { code: 'DEP.DB.DOWN', state: 'installed' });
}

export const checkPostgres: Check = async (c) => {
  const e = engineOf(c);
  if (e.engine === 'bundled') return checkBundled(c);
  if (e.engine === 'user') {
    // a DATABASE_URL you set: the database check below tells whether it answers
    return ok('postgres', 'Postgres', 'DATABASE_URL is set by you (db-url says more)', { engine: 'user' });
  }
  const r = await c.exec(join(PG17_BIN, 'pg_isready'), ['-h', 'localhost', '-p', '5432'], { timeoutMs: 5000 });
  if (r.spawnError) return bad('fail', 'postgres', 'Postgres 17', 'PG17 binaries not found', 'brew install postgresql@17 && brew services start postgresql@17', { engine: 'homebrew' }, { code: 'DEP.DB.DOWN', state: 'missing' });
  return r.code === 0
    ? ok('postgres', 'Postgres 17', 'accepting connections on :5432 (Homebrew)', { engine: 'homebrew' })
    : bad('fail', 'postgres', 'Postgres 17', 'not accepting connections on :5432', 'brew services start postgresql@17', { engine: 'homebrew' }, { code: 'DEP.DB.DOWN', state: 'installed' });
};

export const checkDatabase: Check = async (c) => {
  const DB = appDb(c);
  const rows = await c.withDb('postgres', (q) => q('SELECT 1 AS x FROM pg_database WHERE datname = $1', [DB]));
  if (rows === null) return bad('skip', 'database', `Database ${DB}`, 'could not connect to Postgres', 'start Postgres first', undefined, { state: 'unknown' });
  const fix = engineOf(c).engine === 'homebrew' ? `${PG17_BIN}/createdb ${DB}  (or: npm run setup)` : npmRun(c, 'ops:install');
  return rows.length ? ok('database', `Database ${DB}`, 'exists') : bad('fail', 'database', `Database ${DB}`, 'missing', fix, undefined, { code: 'DEP.DB.MISSING', state: 'installed' });
};

/**
 * The checkout's journal against what the database applied (src/db/migration-state.ts): behind, a migration drizzle
 * skipped, or nothing applied fails; a database newer than this checkout warns. The worker waits on any of them.
 */
export const checkMigrations: Check = async (c) => {
  const folder = join(c.repoRoot, 'src', 'db', 'migrations');
  if (!existsSync(join(folder, 'meta', '_journal.json'))) return bad('skip', 'migrations', 'Migrations', 'no migrations journal in this checkout (src/db/migrations/meta/_journal.json)');
  let journal: JournalEntry[];
  try {
    journal = readJournal(folder);
  } catch {
    return bad('warn', 'migrations', 'Migrations', 'could not read drizzle journal', 'git status; re-run npm run db:migrate', undefined, { code: 'BUG.CHECK_CRASHED' });
  }
  const exists = await c.withDb(appDb(c), (q) => q(`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok`));
  if (exists === null) return bad('skip', 'migrations', 'Migrations', 'database not reachable');
  const rows = exists[0]?.ok ? await c.withDb(appDb(c), (q) => q('SELECT created_at::text AS at FROM drizzle.__drizzle_migrations')) : [];
  if (rows === null) return bad('skip', 'migrations', 'Migrations', 'database not reachable');
  const s = compareSchema(journal, rows.map((r) => Number(r.at)));
  const applied = journal.length - s.pending.length;
  const data = { state: s.state, applied, expected: journal.length, bundled: s.bundled, db: s.applied, ...(s.skipped.length ? { skipped: s.skipped } : {}), ...(s.unknown ? { unknown: s.unknown } : {}) };
  const d = describeSchema(s);
  if (s.state === 'match') return ok('migrations', 'Migrations', `${applied}/${journal.length} applied (${s.applied ?? 'none'})`, data);
  return bad(s.state === 'ahead' ? 'warn' : 'fail', 'migrations', 'Migrations', d.text, d.fix ?? undefined, data, { code: s.state === 'ahead' ? 'DATA.SCHEMA_AHEAD' : 'DATA.SCHEMA_BEHIND' });
};
