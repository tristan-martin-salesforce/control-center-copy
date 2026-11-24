// ensureDatabase(): the installer's database step (PKG-2, D-90; bundled Postgres 17, D-98).
//
// Which database this install runs on (scripts/ops/lib/pg.mjs dbEngine):
//   bundled   Command Center's own Postgres 17 under <state>/pg (a fresh install, and every install after a move):
//             copy the engine, initdb once, start com.commandcenter.db, create command_center, record
//             CC_DB_ENGINE=bundled in the env file. No Homebrew step for a teammate.
//   homebrew  the 1.x default in the env file (localhost:5432/command_center): when Homebrew Postgres runs and holds
//             the database, the answer is `move: true` and the caller moves it after its backup
//             (scripts/ops/lib/migrate-cluster.mjs: precheck → dump → restore → verify → switch). CC_DB_ENGINE=homebrew
//             in the env file keeps Homebrew (the old probes below, unchanged).
//   user      a DATABASE_URL you set (the environment, or any other value in the env file): left alone.
// The return shape stays { ok, state, engine, message, command?, created?, move? }; install-release.mjs depends on it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { pg17Bin } from './brew.mjs';
import { readEnvFile, updateEnvFile } from './envfile.mjs';
import { envFilePath, pgRoot } from './paths.mjs';
import { bundledDatabaseUrl, DB_NAME, dbEngine, dbNameOf, ensureAppDatabase, isV1DefaultUrl } from './pg.mjs';

export const BREW_INSTALL_PG = 'brew install postgresql@17 && brew services start postgresql@17';
export const BREW_START_PG = 'brew services start postgresql@17';

/** A tiny exec: {code, stdout} (spawn errors read as code null). Injectable for tests. */
export const runTool = (cmd, args, timeoutMs = 10_000) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.error ? null : r.status, stdout: (r.stdout ?? '').trim(), missing: r.error?.code === 'ENOENT' };
};

const DB_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * Homebrew Postgres 17 (1.x, and CC_DB_ENGINE=homebrew): the same probes as doctor's `postgres` and `database`
 * checks. It never installs or starts Postgres itself: it prints the exact command.
 * deps: { bin (PG17 bin dir), exists(path), run(cmd, args) → {code, stdout, missing} }
 * opts: { db = 'command_center', create = true, dry = false }
 */
export function homebrewPostgres(deps = {}, opts = {}) {
  const bin = deps.bin ?? pg17Bin();
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? runTool;
  const db = opts.db ?? 'command_center';
  if (!DB_NAME_RE.test(db)) return { ok: false, state: 'bad_name', engine: 'homebrew-pg17', message: `the database name "${db}" is not one the installer can create (letters, digits and _)` };
  if (!exists(join(bin, 'pg_isready'))) {
    return { ok: false, state: 'missing', engine: 'homebrew-pg17', message: 'Postgres 17 is not installed. Command Center keeps your data in it, on this Mac.', command: BREW_INSTALL_PG };
  }
  const ready = run(join(bin, 'pg_isready'), ['-h', 'localhost', '-p', '5432']);
  if (ready.code !== 0) {
    return { ok: false, state: 'stopped', engine: 'homebrew-pg17', message: 'Postgres 17 is installed but not running.', command: BREW_START_PG };
  }
  const q = run(join(bin, 'psql'), ['-h', 'localhost', '-p', '5432', '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${db}'`]);
  if (q.code !== 0) return { ok: false, state: 'unknown', engine: 'homebrew-pg17', message: 'Postgres answers, but listing its databases failed (is it your user that runs it?).', command: `${join(bin, 'psql')} -d postgres -c 'select 1'` };
  if (q.stdout === '1') return { ok: true, state: 'ok', engine: 'homebrew-pg17', message: `Postgres 17 is running; database ${db} exists.`, created: false };
  if (opts.create === false || opts.dry) return { ok: !!opts.dry, state: 'no_database', engine: 'homebrew-pg17', message: `Postgres 17 is running; database ${db} ${opts.dry ? 'would be created' : 'does not exist'}.`, command: `${join(bin, 'createdb')} ${db}` };
  const c = run(join(bin, 'createdb'), ['-h', 'localhost', '-p', '5432', db]);
  if (c.code !== 0) return { ok: false, state: 'no_database', engine: 'homebrew-pg17', message: `creating database ${db} failed`, command: `${join(bin, 'createdb')} ${db}` };
  return { ok: true, state: 'ok', engine: 'homebrew-pg17', message: `Postgres 17 is running; created database ${db}.`, created: true };
}

/**
 * The env file says "bundled" from now on: DATABASE_URL = the socket URL and CC_DB_ENGINE=bundled; a 1.x default
 * DATABASE_URL stays above it as a comment, so what it was is readable. The URL is written out (not left to the
 * fallback) so a 1.x build started after a rollback reads it too instead of its old localhost:5432 default.
 * Only ever called when DATABASE_URL is absent, the 1.x default or already the bundled one: one you set is never
 * touched (ensureDatabase answers `user` first).
 */
export function switchEnvToBundled(envFile, { env = /** @type {Record<string, string | undefined>} */ (process.env), note = '' } = {}) {
  const url = readEnvFile(envFile)?.DATABASE_URL;
  updateEnvFile(envFile, { set: { DATABASE_URL: bundledDatabaseUrl(env), CC_DB_ENGINE: 'bundled' }, comment: url && isV1DefaultUrl(url) ? ['DATABASE_URL'] : [], note });
}

/**
 * Command Center's own cluster. deps: { prepare() → {ok, created, message, state?, command?},
 * ensureDb() → {created}, switchEnv() } (db-agent.mjs realPrepare + pg.mjs ensureAppDatabase in real use).
 */
export async function bundledPostgres(deps, opts = {}) {
  const db = opts.db ?? DB_NAME;
  if (opts.dry) return { ok: true, state: 'planned', engine: 'bundled-pg17', message: `would set up Command Center's own database (Postgres 17 in ${opts.where ?? '<state>/pg'}): copy the engine, initdb once, start com.commandcenter.db, create ${db}` };
  const p = await deps.prepare();
  if (!p.ok) return { ok: false, state: p.state ?? 'cluster', engine: 'bundled-pg17', message: `Command Center's database could not start: ${p.message}`, ...(p.command ? { command: p.command } : {}) };
  let created = false;
  try {
    created = (await deps.ensureDb()).created;
  } catch (e) {
    return { ok: false, state: 'no_database', engine: 'bundled-pg17', message: `creating database ${db} failed (${e?.code ?? e?.message?.split('\n')[0] ?? 'error'})` };
  }
  deps.switchEnv();
  return { ok: true, state: 'ok', engine: 'bundled-pg17', created, message: `Command Center's database (Postgres 17) is running; ${created ? 'created' : 'database'} ${db}${created ? '' : ' exists'}.` };
}

/** The real bundled deps for this Mac (lazy: db-agent.mjs talks to launchctl). */
async function realBundled(env) {
  const [{ realPrepare }, { dirs, ensureState, envTemplate, templatePort }] = await Promise.all([import('./db-agent.mjs'), import('../setup.mjs')]);
  return {
    prepare: realPrepare({ env }),
    ensureDb: () => ensureAppDatabase(bundledDatabaseUrl(env)),
    switchEnv: () => {
      // a first install: the state folders and the env file (600, no credentials), already pointing here
      ensureState(dirs(env, env.HOME || undefined), envTemplate(bundledDatabaseUrl(env), 'CC_DB_ENGINE=bundled\n', templatePort(env)));
      switchEnvToBundled(envFilePath(env), { env, note: '(1.x Homebrew default; Command Center runs its own database now)' });
    },
  };
}

/**
 * The installer's one database entry point.
 * deps: { env, fileEnv, homebrew (homebrewPostgres deps), bundled (bundledPostgres deps) } — all optional.
 * opts: { db, create, dry }
 */
export async function ensureDatabase(deps = {}, opts = {}) {
  const env = deps.env ?? process.env;
  const fileEnv = deps.fileEnv ?? readEnvFile(envFilePath(env)) ?? {};
  const e = dbEngine(env, fileEnv);
  if (e.engine === 'user') {
    return { ok: true, state: 'user_url', engine: 'user', message: `DATABASE_URL is set by you (database ${dbNameOf(e.url) || '?'}, ${e.source === 'env' ? 'in the environment' : 'in the env file'}): Command Center uses it as it is and leaves it alone.` };
  }
  if (e.engine === 'homebrew') {
    if (e.keep) return homebrewPostgres(deps.homebrew, opts); // CC_DB_ENGINE=homebrew: as 1.x
    const h = homebrewPostgres(deps.homebrew, { ...opts, create: false, dry: false });
    if (h.ok) {
      return { ok: true, state: 'move', engine: 'homebrew-pg17', move: true, message: "Your data is in Homebrew Postgres 17. After the backup it moves into Command Center's own database, checked table by table before anything switches; the Homebrew copy stays as it is." };
    }
    if (h.state === 'stopped' || h.state === 'unknown') return { ...h, message: `${h.message} Your data is there: start it, so it can be moved into Command Center's own database.` };
    // no Homebrew Postgres, or no command_center in it: nothing to move; the bundled one takes over
  }
  return bundledPostgres(deps.bundled ?? (opts.dry ? {} : await realBundled(env)), { ...opts, where: pgRoot(env) });
}

/** The lines a person reads when the database step can't go on. */
export function ensureDatabaseMessage(r) {
  if (r.ok) return r.message;
  return r.command ? `${r.message}\n  Run this in Terminal, then run the install again:\n    ${r.command}` : r.message;
}
