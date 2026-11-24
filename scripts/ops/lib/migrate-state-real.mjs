// The real side of migrate-state.mjs (D-101): launchctl, plutil, the bundled cluster and the database rename. Tests of
// the state machine inject their own; nothing imports this file but the entry points (scripts/ops/migrate-state.mjs
// and the installer, updater, setup, doctor and run-service hooks).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readEnvFile, updateEnvFile } from './envfile.mjs';
import { launchctlBin } from './launchctl.mjs';
import { LEGACY, MARKER_FILE, migrateState, migrationState, NEW_DB, renameDbInUrl, rewriteEnvText } from './migrate-state.mjs';
import { logDir } from './paths.mjs';
import { bundledDatabaseUrl, clusterPaths, dbEngine, dbNameOf, isBundledUrl, isV1DefaultUrl, readPostmasterPid, SAFE_DB, urlForDb, waitReady, withClient, writeClusterConf } from './pg.mjs';

const uid = () => process.getuid?.() ?? 0;
// CC_LAUNCHCTL: a test's fake launchctl (nothing in a lane may load or unload a real LaunchAgent)
const lc = (env, args) => spawnSync(launchctlBin(env), args, { stdio: 'ignore' }).status === 0;

/**
 * ALTER DATABASE … RENAME through the `postgres` database, after ending the old one's sessions. 'renamed'; 'already'
 * (the new name is there, the old is not); 'both' (neither is touched); 'absent' (neither exists). Throws when the
 * server cannot be reached or refuses. `from` and `to` default to the 1.x and the 2.0 name; a test passes its own.
 */
export function renameDatabase(url, from = LEGACY.db, to = NEW_DB) {
  if (!SAFE_DB.test(from) || !SAFE_DB.test(to)) throw new Error('unsafe database name');
  return withClient(
    urlForDb(url, 'postgres'),
    async (q) => {
      const has = async (n) => (await q('SELECT 1 FROM pg_database WHERE datname = $1', [n])).length > 0;
      if (!(await has(from))) return (await has(to)) ? 'already' : 'absent';
      if (await has(to)) return 'both';
      await q('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [from]);
      await q(`ALTER DATABASE "${from}" RENAME TO "${to}"`);
      return 'renamed';
    },
    { stable: false, applicationName: 'command-center-migrate' },
  );
}

/** @param {{ env?: Record<string, string | undefined>, say?: (m: string) => void }} [o] */
export function realMigrateDeps({ env = process.env, say = (m) => console.log(`[migrate] ${m}`) } = {}) {
  return {
    say,
    launchctl: {
      loaded: (label) => lc(env, ['print', `gui/${uid()}/${label}`]),
      bootout: (label) => lc(env, ['bootout', `gui/${uid()}/${label}`]),
      bootstrap: (label, file) => lc(env, ['bootstrap', `gui/${uid()}`, file]),
    },
    lintPlist: (file) => execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'pipe' }),
    pgAlive: (state) => !!readPostmasterPid(join(state, 'pg', 'data'))?.alive,
    // the cluster's own config names its socket folder: rewrite it for the new path before anything starts it
    rewriteClusterConf: () => {
      const c = clusterPaths(env);
      if (existsSync(join(c.data, 'PG_VERSION'))) writeClusterConf(c.data, c.runDir);
    },
    waitReady: () => waitReady(clusterPaths(env).socket, { timeoutMs: 90_000 }),
    databaseUrl: (state) => {
      if (env.DATABASE_URL) return { value: env.DATABASE_URL, name: dbNameOf(env.DATABASE_URL), ours: false };
      const value = readEnvFile(join(state, 'env'))?.DATABASE_URL || bundledDatabaseUrl(env, LEGACY.db);
      return { value, name: dbNameOf(value), ours: isBundledUrl(value, env) || isV1DefaultUrl(value) };
    },
    setDatabaseName: (state, name) => {
      const file = join(state, 'env');
      const url = readEnvFile(file)?.DATABASE_URL;
      if (url) updateEnvFile(file, { set: { DATABASE_URL: renameDbInUrl(url, LEGACY.db, name) } });
    },
    renameDb: (url) => renameDatabase(url),
  };
}

/**
 * The hook every entry point calls first: moves a 1.x state folder (and what hangs on it) when there is one. Never
 * throws and never blocks the start: a failure is one plain line, and the next run finishes from where this stopped.
 * @param {{ env?: Record<string, string | undefined>, say?: (m: string) => void, quick?: boolean, deps?: object }} [o]
 */
export async function ensureStateMigrated({ env = process.env, say: sayOut = (m) => console.log(`[migrate] ${m}`), quick = false, deps } = {}) {
  // every line also goes to <logs>/migrate.log once the run is over (written after, never before: an early write would
  // create the new logs folder and stop the old one from moving). A --quick run is run-service's handoff, whose
  // stdout is that file already.
  const lines = [];
  const say = (m) => {
    lines.push(`${new Date().toISOString()} ${m}`);
    sayOut(m);
  };
  try {
    const r = await migrateState(deps ?? realMigrateDeps({ env, say }), { env, quick });
    for (const n of r.notes) say(n);
    return r;
  } catch (e) {
    say(`the folder move did not finish (${String(e?.code ?? e?.message ?? e).split('\n')[0]}); it is safe to run again: node scripts/ops/migrate-state.mjs`);
    return { status: 'failed', notes: [] };
  } finally {
    if (!quick && !deps && lines.length) {
      try {
        mkdirSync(logDir(env), { recursive: true, mode: 0o700 });
        appendFileSync(join(logDir(env), 'migrate.log'), `${lines.join('\n')}\n`);
      } catch {
        /* the log is a convenience */
      }
    }
  }
}

/**
 * UPG-8, --check's database line, from the detection the real run uses (realMigrateDeps.databaseUrl, dbEngine): the
 * env file of whichever folder exists, its old paths read as the new ones (as finish rewrites them). Reads only.
 * @param {Record<string, string | undefined>} [env]
 */
export function databasePlan(env = process.env) {
  const { p, marker } = migrationState(env);
  if (env.DATABASE_URL) return 'left alone (DATABASE_URL set by hand)';
  const folder = existsSync(p.newState) ? p.newState : p.oldState;
  const fileEnv = { ...(readEnvFile(join(folder, 'env')) ?? {}) };
  if (fileEnv.DATABASE_URL) fileEnv.DATABASE_URL = rewriteEnvText(fileEnv.DATABASE_URL, p);
  const url = fileEnv.DATABASE_URL || bundledDatabaseUrl(env, marker?.database?.status === 'renamed' ? NEW_DB : LEGACY.db);
  if (!(isBundledUrl(url, env) || isV1DefaultUrl(url))) return 'left alone (DATABASE_URL set by hand)';
  const name = dbNameOf(url);
  const naming = name === LEGACY.db ? `will be renamed ${LEGACY.db} → ${NEW_DB}` : name === NEW_DB ? `already ${NEW_DB}` : `left alone (database ${name || 'unnamed'})`;
  const e = dbEngine(env, fileEnv);
  if (e.engine === 'homebrew' && !e.keep) return `${naming}; will move from Homebrew to the bundled cluster on the next update`;
  return naming;
}

/** What the marker says, for doctor: null when this install was never migrated. */
export function readMigrationMarker(env = process.env) {
  const { p } = migrationState(env);
  try {
    return JSON.parse(readFileSync(join(p.newState, MARKER_FILE), 'utf8'));
  } catch {
    return null;
  }
}
