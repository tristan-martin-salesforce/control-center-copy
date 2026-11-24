// Backups with retention (D-7; 7 daily + 4 weekly) and restore, for whichever database this install runs on:
//
//   the bundled cluster (D-98)   an online base backup, `<db>-<stamp>.base.tgz`: pg_backup_start → a copy of the
//                                data folder → pg_backup_stop → the WAL in between → backup_label → tar.gz. It needs
//                                only the bundled server (the bundle ships no pg_dump), restores with the same
//                                binaries, and holds the whole cluster. Restoring it starts a copy on its own socket
//                                to look at, or (--replace, the database stopped) swaps the data folder.
//   Homebrew or your own URL     `pg_dump -Fc` with the PG17 binaries (the psql on PATH may be v16, and a v16
//                                pg_dump refuses a v17 server), `<db>-<stamp>.dump`; pg_restore into a new database.
//
// Retention (the p4-retention leftover): keep the newest 7, and beyond them the newest of each of the 4 weeks before
// (the same rule as src/db/retention/policy.ts backupsToPrune, which the nightly data.retention job applies).
//
// Copy folder (audit 2026-11-13, lane E: E2): set CC_BACKUP_COPY_DIR in the env file (or the environment) and every
// backup is also written there, keeping the newest 7 too: an external disk or another local folder, so a lost or
// wiped Mac isn't the end of your data. A cloud-synced folder (iCloud Drive, OneDrive, Google Drive, Dropbox) is
// refused: it would take customer data off this Mac (tenet: Local data, privacy-safe logs).
import { execFile, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, constants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { pg17Bin } from './brew.mjs';
import { readEnvFile } from './envfile.mjs';
import { pgDataDir, pgRoot, STATE_FOLDER_NAME } from './paths.mjs';
import { clusterPaths, installedEngine, isBundledUrl, LEGACY_DB_NAME, readPostmasterPid, socketTooLong, startCluster, urlForDb, withClient, writeClusterConf } from './pg.mjs';

const exec = promisify(execFile);
export const PG17_BIN = pg17Bin();
export const DEFAULT_DB = 'command_center';
export const DEFAULT_KEEP = 7;
export const DEFAULT_WEEKLY = 4;

/** @param {Record<string, string | undefined>} [env] */
const stateDirOf = (env = /** @type {Record<string, string | undefined>} */ (process.env)) => env.CC_STATE_DIR ?? join(homedir(), 'Library', 'Application Support', STATE_FOLDER_NAME);
/** @param {Record<string, string | undefined>} [env] */
export const defaultBackupDir = (env = /** @type {Record<string, string | undefined>} */ (process.env)) => join(stateDirOf(env), 'backups');

/**
 * A setting from the environment, else from the state folder's env file (scripts run from a shell don't load it).
 * @param {string} key
 * @param {Record<string, string | undefined>} [env]
 */
export function envSetting(key, env = /** @type {Record<string, string | undefined>} */ (process.env)) {
  if (env[key] !== undefined) return env[key] || null;
  return readEnvFile(join(stateDirOf(env), 'env'))?.[key] || null;
}

/**
 * The database the services use: DATABASE_URL (environment, else env file), else CC_DB_NAME, else command_center.
 * @param {Record<string, string | undefined>} [env]
 */
export function configuredDbName(env = /** @type {Record<string, string | undefined>} */ (process.env)) {
  const url = envSetting('DATABASE_URL', env);
  if (url) {
    try {
      const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
      if (name) return assertDbName(name);
    } catch {
      /* fall through */
    }
  }
  return env.CC_DB_NAME ?? DEFAULT_DB;
}

/** Folders a sync client uploads (iCloud Drive, File Provider clients such as OneDrive and Google Drive, Dropbox). */
export function cloudSyncedReason(dir, home = homedir()) {
  const p = resolve(dir);
  const under = (rel) => {
    const base = join(home, rel);
    return p === base || p.startsWith(`${base}/`);
  };
  if (under('Library/Mobile Documents')) return 'iCloud Drive';
  if (under('Library/CloudStorage')) return 'a cloud-synced folder (OneDrive, Google Drive, Dropbox, Box)';
  const top = p.startsWith(`${home}/`) ? p.slice(home.length + 1).split('/')[0] : '';
  if (/^OneDrive\b/.test(top)) return 'OneDrive';
  if (/^(Dropbox|Google Drive|Box|Box Sync|iCloud Drive)$/.test(top)) return top;
  return null;
}

/**
 * The copy folder (CC_BACKUP_COPY_DIR, `~/` expanded) or null when none is set. `refused` names why a set folder is
 * not used (a cloud-synced folder).
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 * @returns {{ dir: string | null, refused: string | null }}
 */
export function backupCopyDir(env = /** @type {Record<string, string | undefined>} */ (process.env), home = env.HOME ?? homedir()) {
  const raw = envSetting('CC_BACKUP_COPY_DIR', env);
  if (!raw) return { dir: null, refused: null };
  const dir = resolve(raw.replace(/^~(?=\/|$)/, home));
  const cloud = cloudSyncedReason(dir, home);
  return cloud ? { dir, refused: `${cloud} would take your data off this Mac` } : { dir, refused: null };
}

const SAFE_DB = /^[a-z_][a-z0-9_]{0,62}$/;
export function assertDbName(db) {
  if (!SAFE_DB.test(db)) throw new Error(`unsafe database name: ${JSON.stringify(db)}`);
  return db;
}

const pad = (n) => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export const backupName = (db, d = new Date()) => `${assertDbName(db)}-${stamp(d)}.dump`;
/** A base backup of the bundled cluster (D-98). */
export const baseBackupName = (db, d = new Date()) => `${assertDbName(db)}-${stamp(d)}.base.tgz`;
export const isBaseBackup = (file) => /\.base\.tgz$/.test(file);

/**
 * This database's backups, oldest first. Under the default name the 1.x ones (control_center-<stamp>.dump, made before
 * the rename, D-101) count too: restore and rollback find them, and retention treats them like any other.
 */
const stampOfName = (n) => /-(\d{8}-\d{6})\./.exec(n)?.[1] ?? '';
export function listBackups(dir, db = DEFAULT_DB) {
  if (!existsSync(dir)) return [];
  const names = db === DEFAULT_DB ? [db, LEGACY_DB_NAME] : [db];
  const re = new RegExp(`^(?:${names.map(assertDbName).join('|')})-\\d{8}-\\d{6}\\.(dump|base\\.tgz)$`);
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .sort((a, b) => (stampOfName(a) < stampOfName(b) ? -1 : stampOfName(a) > stampOfName(b) ? 1 : 0)) // by timestamp, whichever name
    .map((f) => ({ file: join(dir, f), name: f, bytes: statSync(join(dir, f)).size }));
}

const DAY = 86_400_000;

/**
 * The names to delete: keep the newest `daily`, and beyond those the newest file of each of the `weekly` weeks
 * before (Monday weeks). Twin of src/db/retention/policy.ts backupsToPrune (tests/ops/backup-retention.test.ts).
 */
export function backupsToPrune(names, daily = DEFAULT_KEEP, weekly = DEFAULT_WEEKLY) {
  const parsed = names
    .map((n) => {
      const m = /-(\d{4})(\d{2})(\d{2})-(\d{6})\.(?:dump|base\.tgz)$/.exec(n);
      return m ? { name: n, at: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), key: `${m[1]}${m[2]}${m[3]}${m[4]}` } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // newest first
  const keep = new Set(parsed.slice(0, daily).map((x) => x.name));
  const weekOf = (t) => Math.floor((t - ((new Date(t).getUTCDay() + 6) % 7) * DAY) / (7 * DAY));
  const weeks = new Set();
  for (const b of parsed.slice(daily)) {
    const w = weekOf(b.at);
    if (!weeks.has(w) && weeks.size < weekly) {
      weeks.add(w);
      keep.add(b.name);
    }
  }
  return parsed.filter((b) => !keep.has(b.name)).map((b) => b.name);
}

/** Apply the retention rule (7 daily + 4 weekly) to this database's backups. Returns the removed names. */
export function pruneBackups(dir, db = DEFAULT_DB, keep = DEFAULT_KEEP, weekly = DEFAULT_WEEKLY) {
  const all = listBackups(dir, db);
  const doomed = new Set(backupsToPrune(all.map((b) => b.name), keep, weekly));
  for (const b of all) if (doomed.has(b.name)) unlinkSync(b.file);
  return all.filter((b) => doomed.has(b.name)).map((b) => b.name);
}

/**
 * UPG-4: the last backup made before a major update, kept out of retention in `<backups>/pre-<major>.0/` (retention and
 * the nightly job list the top folder only). A hard link when it can (no second copy on disk), else a copy; an existing
 * one is left as it is. Returns the kept file.
 */
export const keptDirName = (major) => `pre-${Number(major)}.0`;
export function keepBeforeMajor(file, dir, major) {
  const to = join(dir, keptDirName(major));
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const dest = join(to, basename(file));
  if (!existsSync(dest)) {
    try {
      linkSync(file, dest);
    } catch {
      copyFileSync(file, dest);
    }
  }
  return dest;
}

/** The backups kept before a major update (every `pre-<n>.0/` folder), oldest major first. */
export function listKeptBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^pre-\d+\.0$/.test(d) && statSync(join(dir, d)).isDirectory())
    .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10))
    .flatMap((d) =>
      readdirSync(join(dir, d))
        .filter((f) => /-\d{8}-\d{6}\.(dump|base\.tgz)$/.test(f))
        .sort()
        .map((f) => ({ file: join(dir, d, f), name: `${d}/${f}`, bytes: statSync(join(dir, d, f)).size })),
    );
}

/** The newest `keep` only (the copy folder: an external disk has less room). */
function pruneNewest(dir, db, keep) {
  const all = listBackups(dir, db);
  const doomed = all.slice(0, Math.max(0, all.length - keep));
  for (const b of doomed) unlinkSync(b.file);
  return doomed.map((b) => b.name);
}

/** True when there is no backup newer than `maxAgeMs` (the worker can call this to catch up after downtime). */
export function backupDue(dir, db = DEFAULT_DB, maxAgeMs = 24 * 3600_000, now = Date.now()) {
  const last = listBackups(dir, db).at(-1);
  return !last || now - statSync(last.file).mtimeMs > maxAgeMs;
}

/**
 * Copy one finished backup into `dir` (tmp + rename, mode 600) and keep the newest `keep` there. Never throws: a copy
 * folder on a disk that isn't plugged in must not fail the backup itself. Returns the copy, or why there is none.
 */
export function copyBackup(file, dir, { db = DEFAULT_DB, keep = DEFAULT_KEEP } = {}) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const to = join(dir, file.split('/').pop());
    const tmp = `${to}.partial`;
    copyFileSync(file, tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, to);
    return { file: to, pruned: pruneNewest(dir, db, keep) };
  } catch (e) {
    return { error: e?.code ?? e?.name ?? 'copy_failed' };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the bundled cluster: online base backups (D-98)
// ---------------------------------------------------------------------------------------------------------------

/** What a base backup leaves out of the data folder (as pg_basebackup does): runtime files, and these folders' contents. */
const SKIP_FILES = new Set(['postmaster.pid', 'postmaster.opts', 'backup_label.old', 'tablespace_map.old', 'standby.signal', 'recovery.signal']);
const EMPTY_DIRS = new Set(['pg_wal', 'pg_dynshmem', 'pg_notify', 'pg_replslot', 'pg_serial', 'pg_snapshots', 'pg_stat_tmp', 'pg_subtrans']);

/** Copy the data folder for a base backup: clones where it can; a file that vanishes mid-copy is skipped (it is in the WAL). */
export function copyDataDir(from, to, top = true) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  let names;
  try {
    names = readdirSync(from);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const name of names) {
    if (top && SKIP_FILES.has(name)) continue;
    if (name === 'pg_internal.init' || name.startsWith('pgsql_tmp')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    let st;
    try {
      st = lstatSync(src);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (st.isDirectory()) {
      if (top && EMPTY_DIRS.has(name)) mkdirSync(dst, { mode: 0o700 });
      else copyDataDir(src, dst, false);
      continue;
    }
    try {
      copyFileSync(src, dst, constants.COPYFILE_FICLONE);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

/**
 * pg_backup_start → copy → pg_backup_stop on ONE session (non-exclusive backup), then the WAL segments from the
 * start to the stop LSN and the backup_label, tarred and gzipped. `url` is the bundled cluster's (any database).
 */
export async function runBaseBackup({ url, db = DEFAULT_DB, dir = defaultBackupDir(), keep = DEFAULT_KEEP, now = new Date() }) {
  assertDbName(db);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, baseBackupName(db, now));
  const stage = join(dir, `.stage-${process.pid}-${now.getTime()}`);
  rmSync(stage, { recursive: true, force: true });
  try {
    await withClient(
      urlForDb(url, 'postgres'),
      async (q) => {
        const data = (await q('SHOW data_directory'))[0].data_directory;
        const start = (await q("SELECT pg_backup_start('command-center', true) AS lsn"))[0].lsn;
        let stop;
        try {
          copyDataDir(data, stage);
        } finally {
          stop = (await q('SELECT lsn::text, labelfile, spcmapfile FROM pg_backup_stop(false)'))[0];
        }
        const seg = (await q('SELECT pg_walfile_name($1::pg_lsn) AS a, pg_walfile_name($2::pg_lsn) AS b', [start, stop.lsn]))[0];
        mkdirSync(join(stage, 'pg_wal', 'archive_status'), { recursive: true, mode: 0o700 });
        const wal = join(data, 'pg_wal');
        for (const n of readdirSync(wal)) {
          if ((/^[0-9A-F]{24}$/.test(n) && n >= seg.a && n <= seg.b) || /^[0-9A-F]{8}\.history$/.test(n)) copyFileSync(join(wal, n), join(stage, 'pg_wal', n));
        }
        writeFileSync(join(stage, 'backup_label'), stop.labelfile, { mode: 0o600 });
        if (stop.spcmapfile) writeFileSync(join(stage, 'tablespace_map'), stop.spcmapfile, { mode: 0o600 });
      },
      { applicationName: 'command-center-backup', stable: false },
    );
    const tmp = `${file}.partial`;
    const t = spawnSync('/usr/bin/tar', ['-czf', tmp, '-C', stage, '.'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    if (t.status !== 0) throw new Error(`tar failed: ${String(t.stderr ?? '').split('\n')[0]}`);
    renameSync(tmp, file); // a half-written archive never looks like a backup
    chmodSync(file, 0o600);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return { file, bytes: statSync(file).size, pruned: pruneBackups(dir, db, keep) };
}

/**
 * Restore a base backup. Without `replace`: unpack it next to the live cluster and start it there on its own socket,
 * to look at (returns its URL and the stop command). With `replace` (the database stopped first): the live data
 * folder is kept as data.before-restore-<stamp> and the backup takes its place.
 */
export async function restoreBaseBackup({ file, replace = false, env = /** @type {Record<string, string | undefined>} */ (process.env), now = new Date() }) {
  if (!existsSync(file)) throw new Error(`backup file not found: ${file}`);
  const engine = installedEngine(env);
  if (!engine) throw new Error('the bundled Postgres is not installed here (npm run ops:install)');
  const p = clusterPaths(env);
  const untar = (into) => {
    mkdirSync(into, { recursive: true, mode: 0o700 });
    const t = spawnSync('/usr/bin/tar', ['-xzf', file, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (t.status !== 0) {
      rmSync(into, { recursive: true, force: true });
      throw new Error(`the backup could not be unpacked: ${String(t.stderr ?? '').split('\n')[0]}`);
    }
    chmodSync(into, 0o700);
    if (!existsSync(join(into, 'backup_label'))) {
      rmSync(into, { recursive: true, force: true });
      throw new Error('this archive is not a Command Center base backup (no backup_label)');
    }
  };
  const tag = stamp(now);
  if (replace) {
    const pm = readPostmasterPid(p.data);
    if (pm?.alive) throw new Error('the database is running: stop Command Center first (npm run ops:uninstall stops all three services), then run this again');
    const incoming = join(pgRoot(env), `data.restoring-${tag}`);
    untar(incoming);
    writeClusterConf(incoming, p.runDir);
    const previous = existsSync(p.data) ? join(pgRoot(env), `data.before-restore-${tag}`) : null;
    if (previous) renameSync(p.data, previous);
    renameSync(incoming, pgDataDir(env));
    return { into: p.data, previous, engine: engine.version };
  }
  // a copy to look at, on its own socket
  const root = join(pgRoot(env), `restore-${tag}`);
  const data = join(root, 'data');
  let runDir = join(root, 'run');
  if (socketTooLong(runDir)) runDir = mkdtempSync(join(tmpdir(), 'cc-restore-'));
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  untar(data);
  appendFileSync(join(data, 'postgresql.auto.conf'), `\n# the restored copy to look at (npm run restore)\nunix_socket_directories = '${runDir.replace(/'/g, "''")}'\n`);
  const s = await startCluster({ env: { ...env, CC_PG_DIR: root, CC_PG_SOCKET_DIR: runDir, CC_LOG_DIR: root }, bin: engine.bin });
  if (!s.ok) throw new Error(`the restored copy did not start: ${s.message}`);
  // a backup made before the rename holds the database as control_center (D-101): hand back the URL of the one that is there
  const server = `postgresql:///postgres?host=${encodeURIComponent(runDir)}`;
  const present = await withClient(server, async (q) => (await q('SELECT datname FROM pg_database')).map((r) => r.datname), { stable: false }).catch(() => []);
  const appDb = present.includes(DEFAULT_DB) || !present.includes(LEGACY_DB_NAME) ? DEFAULT_DB : LEGACY_DB_NAME;
  const url = `postgresql:///${appDb}?host=${encodeURIComponent(runDir)}`;
  return { into: data, url, stop: `"${join(engine.bin, 'pg_ctl')}" -D "${data}" stop`, engine: engine.version };
}

// ---------------------------------------------------------------------------------------------------------------
// backup / restore, whichever database
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{ db?: string, url?: string, dir?: string, keep?: number, pgBin?: string, host?: string, now?: Date, copyDir?: string | null, env?: Record<string, string | undefined> }} [opts]
 *   `url`: the database the services use (resolveDatabaseUrl); the bundled socket → a base backup, any other →
 *   pg_dump -d. Without it: pg_dump -h `host` `db` (as 1.x).
 *   `copyDir`: undefined = CC_BACKUP_COPY_DIR, null = no copy, a path = that folder
 */
export async function runBackup({ db = DEFAULT_DB, url, dir = defaultBackupDir(), keep = DEFAULT_KEEP, pgBin = PG17_BIN, host = 'localhost', now = new Date(), copyDir, env = /** @type {Record<string, string | undefined>} */ (process.env) } = {}) {
  assertDbName(db);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let r;
  if (url && isBundledUrl(url, env)) r = await runBaseBackup({ url, db, dir, keep, now });
  else {
    const file = join(dir, backupName(db, now));
    const tmp = `${file}.partial`;
    // Custom format (-Fc): compressed, and pg_restore can restore selectively.
    const target = url ? ['-d', urlForDb(url, db)] : ['-h', host, db];
    await exec(join(pgBin, 'pg_dump'), ['-Fc', '--no-owner', '-f', tmp, ...target], { timeout: 10 * 60_000 });
    const { rename } = await import('node:fs/promises');
    await rename(tmp, file); // a half-written dump never looks like a backup
    chmodSync(file, 0o600);
    r = { file, bytes: statSync(file).size, pruned: pruneBackups(dir, db, keep) };
  }
  // the copy folder: an explicit `copyDir` (null = none), else CC_BACKUP_COPY_DIR; a cloud-synced one is refused
  const c = copyDir === undefined ? backupCopyDir() : { dir: copyDir, refused: copyDir ? (cloudSyncedReason(copyDir) ? 'cloud-synced' : null) : null };
  const copy = !c.dir ? null : c.refused ? { error: 'refused_cloud_synced', dir: c.dir } : { ...copyBackup(r.file, c.dir, { db, keep }), dir: c.dir };
  return { ...r, copy };
}

const psql = (pgBin, host, db, sql) => exec(join(pgBin, 'psql'), ['-h', host, '-d', db, '-X', '-Atc', sql]);

export async function dbExists(db, { pgBin = PG17_BIN, host = 'localhost' } = {}) {
  const { stdout } = await psql(pgBin, host, 'postgres', `SELECT 1 FROM pg_database WHERE datname='${assertDbName(db)}'`);
  return stdout.trim() === '1';
}

/**
 * Restore `file` into `into`. Creates the target; if it exists, `replace` must be true (drops it first).
 * Never defaults to the live database: callers choose the target explicitly. A base backup (.base.tgz) goes to
 * restoreBaseBackup instead (`into` does not apply: it holds the whole cluster).
 */
export async function runRestore({ file, into, replace = false, pgBin = PG17_BIN, host = 'localhost', env = /** @type {Record<string, string | undefined>} */ (process.env) }) {
  if (isBaseBackup(file)) return restoreBaseBackup({ file, replace, env });
  assertDbName(into);
  if (!existsSync(file)) throw new Error(`backup file not found: ${file}`);
  if (await dbExists(into, { pgBin, host })) {
    if (!replace) throw new Error(`database ${into} already exists; pass replace to drop and recreate it`);
    await psql(pgBin, host, 'postgres', `DROP DATABASE IF EXISTS ${into} WITH (FORCE)`); // IF EXISTS: it can vanish between the check and the drop
  }
  await exec(join(pgBin, 'createdb'), ['-h', host, into]);
  try {
    await exec(join(pgBin, 'pg_restore'), ['-h', host, '--no-owner', '--exit-on-error', '-d', into, file], { timeout: 10 * 60_000 });
  } catch (e) {
    await psql(pgBin, host, 'postgres', `DROP DATABASE IF EXISTS ${into} WITH (FORCE)`).catch(() => undefined);
    throw new Error(`pg_restore failed: ${String(e.stderr ?? e.message).split('\n')[0]}`);
  }
  return { into };
}

export async function dropDb(db, { pgBin = PG17_BIN, host = 'localhost' } = {}) {
  await psql(pgBin, host, 'postgres', `DROP DATABASE IF EXISTS ${assertDbName(db)} WITH (FORCE)`);
}
