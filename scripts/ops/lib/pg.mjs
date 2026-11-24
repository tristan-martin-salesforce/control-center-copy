// The bundled Postgres 17 cluster (D-98; 12-pglite-spike.md §4, §5 item 5): a teammate never installs Homebrew
// Postgres. The server binaries come from the pinned optional dependency @embedded-postgres/darwin-<arch> (initdb,
// pg_ctl, postgres and their libraries: the package ships no client tools, so readiness, createdb and every check
// here speak to the server over its socket instead of pg_isready / createdb / psql).
//
//   <state>/pg/engine/<version>-<arch>/   a copy of the package's native/ folder (APFS clone; identical ICU dylibs
//                                         become symlinks), so `npm ci` or pruning an old release never pulls the
//                                         binaries out from under a running server
//   <state>/pg/data/                      initdb --locale=C --encoding=UTF8; peer auth on the socket only
//   <state>/pg/run/.s.PGSQL.5432          the only way in: listen_addresses = '' (no TCP port, nothing on the network)
//   <state>/pg/cluster.lock               one init / start / stop / move at a time (pid inside)
//
// The LaunchAgent com.commandcenter.db runs <engine>/bin/postgres -D <data> directly (no Node parent: killing one
// would leave postgres running). Tests start the same cluster with pg_ctl on a scratch state folder.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync, chmodSync, lstatSync, readlinkSync } from 'node:fs';
import net from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEnvFile } from './envfile.mjs';
import { envFilePath, logDir, pgDataDir, pgEngineRoot, pgLockFile, pgRoot, pgRunDir } from './paths.mjs';

export const PG_MAJOR = 17;
export const PG_PORT = 5432;
export const DB_NAME = 'command_center';
/** The 1.x database name (D-101): a 1.x install keeps it until scripts/ops/lib/migrate-state.mjs renames it. */
export const LEGACY_DB_NAME = 'control_center';
/** macOS limits a unix socket path to 103 bytes (sun_path is 104 with the NUL). */
export const SOCKET_PATH_MAX = 103;
export const CONF_FILE = 'command-center.conf';
export const ENGINE_PACKAGE = (arch = process.arch) => `@embedded-postgres/darwin-${arch}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const SAFE_DB = /^[a-z_][a-z0-9_]{0,62}$/;

// ---------------------------------------------------------------------------------------------------------------
// the engine (server binaries)
// ---------------------------------------------------------------------------------------------------------------

/** The installed @embedded-postgres/darwin-<arch> package folder (walking up node_modules from here), or null. */
export function enginePackageDir({ env = /** @type {Record<string, string | undefined>} */ (process.env), arch = process.arch, from = HERE } = {}) {
  if (env.CC_PG_PACKAGE_DIR) return existsSync(join(env.CC_PG_PACKAGE_DIR, 'native', 'bin', 'postgres')) ? env.CC_PG_PACKAGE_DIR : null;
  for (let d = from; ; d = dirname(d)) {
    const cand = join(d, 'node_modules', ENGINE_PACKAGE(arch));
    if (existsSync(join(cand, 'native', 'bin', 'postgres'))) return cand;
    if (dirname(d) === d) return null;
  }
}

export function enginePackageVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** "17.12.0-beta.19" → 17. */
export const majorOfVersion = (v) => Number(String(v ?? '').replace(/^v/, '').split('.')[0]) || null;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Copy `from` into `to`: APFS clones where it can (no extra space), and in each folder a file identical to one
 * copied before it (npm materialises the ICU symlinks as three 55 MB copies) becomes a relative symlink to it.
 * Returns the bytes the symlinks saved.
 */
export function copyEngineTree(from, to) {
  let saved = 0;
  mkdirSync(to, { recursive: true, mode: 0o755 });
  const seen = new Map(); // `${size}:${sha}` → name, per folder
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name);
    const dst = join(to, name);
    const st = lstatSync(src);
    if (st.isSymbolicLink()) {
      symlinkSync(readlinkSync(src), dst);
      continue;
    }
    if (st.isDirectory()) {
      saved += copyEngineTree(src, dst);
      continue;
    }
    if (st.size >= 64 * 1024 && /\.dylib$/.test(name)) {
      const key = `${st.size}:${sha256(src)}`;
      const first = seen.get(key);
      if (first) {
        symlinkSync(first, dst);
        saved += st.size;
        continue;
      }
      seen.set(key, name);
    }
    copyFileSync(src, dst, constants.COPYFILE_FICLONE);
    chmodSync(dst, st.mode & 0o777);
  }
  return saved;
}

/**
 * The engine copy for this package version under <state>/pg/engine/ (made once; `.complete` marks a finished copy).
 * Returns { ok, dir, bin, version, major, installed, savedBytes } or { ok: false, state, message }.
 */
/** @param {{ env?: Record<string, string | undefined>, pkgDir?: string | null, arch?: string }} [o] */
export function installEngine({ env = /** @type {Record<string, string | undefined>} */ (process.env), pkgDir = enginePackageDir({ env }), arch = process.arch } = {}) {
  if (!pkgDir) return { ok: false, state: 'engine_missing', message: `Command Center's database server (${ENGINE_PACKAGE(arch)}) is not in this build, so this build cannot run here. Keep the version you have and tell whoever posted the build (it has to be built again with the server in it). From a source checkout: npm ci` };
  const version = enginePackageVersion(pkgDir);
  if (!version) return { ok: false, state: 'engine_missing', message: `${pkgDir} has no package.json version` };
  const root = pgEngineRoot(env);
  const dir = join(root, `${version}-${arch}`);
  const done = join(dir, '.complete');
  const result = (installed, savedBytes = 0) => ({ ok: true, dir, bin: join(dir, 'bin'), version, major: majorOfVersion(version), installed, savedBytes });
  if (existsSync(done)) return result(false);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.incoming-${version}-${arch}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  const savedBytes = copyEngineTree(join(pkgDir, 'native'), tmp);
  writeFileSync(join(tmp, '.complete'), `${JSON.stringify({ version, arch, from: ENGINE_PACKAGE(arch), savedBytes, at: new Date().toISOString() })}\n`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return result(true, savedBytes);
}

/** The newest finished engine copy (by version folder name), or null: the one the db agent runs. */
export function installedEngine(env = /** @type {Record<string, string | undefined>} */ (process.env)) {
  const root = pgEngineRoot(env);
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .filter((n) => !n.startsWith('.') && existsSync(join(root, n, '.complete')))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const name = dirs.at(-1);
  if (!name) return null;
  const version = name.replace(/-(arm64|x64)$/, '');
  return { dir: join(root, name), bin: join(root, name, 'bin'), version, major: majorOfVersion(version) };
}

// ---------------------------------------------------------------------------------------------------------------
// where it listens, and the URL the app uses
// ---------------------------------------------------------------------------------------------------------------

export const socketFile = (runDir, port = PG_PORT) => join(runDir, `.s.PGSQL.${port}`);
export const socketTooLong = (runDir) => Buffer.byteLength(socketFile(runDir)) > SOCKET_PATH_MAX;

export function osUser() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? '';
  }
}

/**
 * The bundled database's URL: the socket folder as the libpq `host` (percent-encoded: "Application Support" has a
 * space) and this Mac's user (peer auth; launchd may not set USER). Twin of src/db/client.ts bundledDatabaseUrl.
 */
export function bundledDatabaseUrl(env = /** @type {Record<string, string | undefined>} */ (process.env), db = DB_NAME) {
  return `postgresql:///${db}?host=${encodeURIComponent(pgRunDir(env))}&user=${encodeURIComponent(osUser())}`;
}

/** The socket folder a URL points at (`?host=/dir` or `postgres://%2Fdir/db`), or null for TCP. */
export function socketDirOf(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('host');
    if (q?.startsWith('/')) return q;
    const h = decodeURIComponent(u.hostname);
    return h.startsWith('/') ? h : null;
  } catch {
    return null;
  }
}

export const isBundledUrl = (url, env = /** @type {Record<string, string | undefined>} */ (process.env)) => {
  const d = url ? socketDirOf(url) : null;
  return !!d && resolve(d) === resolve(pgRunDir(env));
};

/** The database name of a URL ('' when it has none), never the URL itself (it may carry a password). */
export function dbNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/**
 * The 1.x default (`npm run setup` wrote it): Homebrew Postgres on this Mac (localhost:5432, or its /tmp socket),
 * database control_center (command_center once D-101 renamed it), no password. Anything else in DATABASE_URL was set on purpose and is left alone.
 */
export function isV1DefaultUrl(url) {
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol) || u.password) return false;
    const sock = socketDirOf(url);
    const local = sock ? resolve(sock) === '/tmp' : ['localhost', '127.0.0.1', '[::1]', ''].includes(u.hostname);
    return local && (u.port === '' || u.port === '5432') && [DB_NAME, LEGACY_DB_NAME].includes(dbNameOf(url));
  } catch {
    return false;
  }
}

/**
 * The URL the app uses, in order: the environment's DATABASE_URL → the env file's → the bundled socket URL.
 * Twin of src/db/client.ts resolveDatabaseUrl (tests/ops/pg-url.test.ts keeps the two in step).
 */
export function resolveDatabaseUrl(env = /** @type {Record<string, string | undefined>} */ (process.env), fileEnv = readEnvFile(envFilePath(env)) ?? {}) {
  return env.DATABASE_URL || fileEnv.DATABASE_URL || bundledDatabaseUrl(env);
}

/**
 * Which database this install runs on:
 *   bundled   no DATABASE_URL anywhere, or one that points at the bundled socket
 *   homebrew  the env file holds the 1.x default (moved on update unless CC_DB_ENGINE=homebrew keeps it)
 *   user      DATABASE_URL set by you (environment, or a non-default value in the env file): left alone
 */
export function dbEngine(env = /** @type {Record<string, string | undefined>} */ (process.env), fileEnv = readEnvFile(envFilePath(env)) ?? {}) {
  if (env.DATABASE_URL) return { engine: isBundledUrl(env.DATABASE_URL, env) ? 'bundled' : 'user', source: 'env', url: env.DATABASE_URL };
  const f = fileEnv.DATABASE_URL;
  if (f) {
    if (isBundledUrl(f, env)) return { engine: 'bundled', source: 'file', url: f };
    if (isV1DefaultUrl(f)) return { engine: 'homebrew', source: 'file', url: f, keep: fileEnv.CC_DB_ENGINE === 'homebrew' };
    return { engine: 'user', source: 'file', url: f };
  }
  return { engine: 'bundled', source: 'default', url: bundledDatabaseUrl(env) };
}

// ---------------------------------------------------------------------------------------------------------------
// configuration files
// ---------------------------------------------------------------------------------------------------------------

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** command-center.conf (included from postgresql.conf): a socket only, 30 connections (web 5 + worker 5 + tools). */
export function clusterConf({ runDir }) {
  return [
    '# Command Center (D-98): rewritten by scripts/ops/lib/pg.mjs at every init and start; edit postgresql.auto.conf instead.',
    "listen_addresses = ''",
    `port = ${PG_PORT}`,
    `unix_socket_directories = ${quote(runDir)}`,
    'unix_socket_permissions = 0700',
    'max_connections = 30',
    // WAL a base backup needs between pg_backup_start and _stop is never recycled under it (backup.mjs)
    "wal_keep_size = '64MB'",
    'log_checkpoints = off',
    '',
  ].join('\n');
}

export const HBA = ['# Command Center (D-98): the unix socket only, and only this Mac user (peer: the OS user name is the role).', 'local   all   all   peer', ''].join('\n');

/** Write command-center.conf and pg_hba.conf, and include the former from postgresql.conf (once). */
export function writeClusterConf(dataDir, runDir) {
  writeFileSync(join(dataDir, CONF_FILE), clusterConf({ runDir }), { mode: 0o600 });
  writeFileSync(join(dataDir, 'pg_hba.conf'), HBA, { mode: 0o600 });
  const main = join(dataDir, 'postgresql.conf');
  const text = existsSync(main) ? readFileSync(main, 'utf8') : '';
  if (!text.includes(`include_if_exists = '${CONF_FILE}'`)) writeFileSync(main, `${text}\n# Command Center (D-98)\ninclude_if_exists = '${CONF_FILE}'\n`, { mode: 0o600 });
}

/** The data folder's major (PG_VERSION), or null when it was never initialised. */
export function dataMajor(dataDir) {
  try {
    return Number(readFileSync(join(dataDir, 'PG_VERSION'), 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// is it running: postmaster.pid, and a startup packet on the socket (what pg_isready does)
// ---------------------------------------------------------------------------------------------------------------

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** postmaster.pid: { pid, alive, status ('starting' | 'ready' | 'stopping' | …), dataDir } or null. */
export function readPostmasterPid(dataDir, alive = pidAlive) {
  let lines;
  try {
    lines = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
  } catch {
    return null;
  }
  const pid = Number(lines[0]);
  return { pid, alive: alive(pid), dataDir: lines[1] ?? null, port: Number(lines[3]) || null, socketDir: lines[4] || null, status: (lines[7] ?? '').trim() || null };
}

/**
 * pg_isready over the socket, without pg_isready (the bundle has no client tools): send a startup packet and read the
 * first answer. 'ready' (an authentication request, or any error but "starting up"), 'starting' (57P03), 'down'.
 */
export function pgPing(sock, { user = osUser(), timeoutMs = 3000 } = {}) {
  return new Promise((done) => {
    let settled = false;
    const s = net.createConnection({ path: sock });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // a polite goodbye (Terminate) so the backend doesn't log a broken pipe, then wait for it to hang up
      if (r === 'ready' && !s.destroyed) {
        s.end(Buffer.from([0x58, 0, 0, 0, 4]));
        setTimeout(() => s.destroy(), 200).unref();
      } else s.destroy();
      done(r);
    };
    const timer = setTimeout(() => finish('down'), timeoutMs);
    s.on('error', () => finish('down'));
    s.on('connect', () => {
      const params = Buffer.from(`user\0${user}\0database\0postgres\0\0`);
      const head = Buffer.alloc(8);
      head.writeInt32BE(8 + params.length, 0);
      head.writeInt32BE(196608, 4); // protocol 3.0
      s.write(Buffer.concat([head, params]));
    });
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      if (settled) return;
      buf = Buffer.concat([buf, d]);
      if (buf[0] === 0x52) return finish('ready'); // 'R': the server wants to authenticate us: it accepts connections
      if (buf[0] !== 0x45) return finish('ready'); // any other first message (NegotiateProtocolVersion): it answers
      if (buf.length < 5) return;
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) return; // the rest of the ErrorResponse is on its way
      const fields = buf.subarray(5, len + 1).toString('utf8').split('\0');
      const code = fields.find((f) => f.startsWith('C'))?.slice(1);
      finish(code === '57P03' ? 'starting' : 'ready');
    });
  });
}

/** Poll pgPing until 'ready' (true) or `timeoutMs` passes (false). */
export async function waitReady(sock, { timeoutMs = 60_000, everyMs = 250, ping = pgPing } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await ping(sock)) === 'ready') return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the lifecycle lock
// ---------------------------------------------------------------------------------------------------------------

/**
 * Take <state>/pg/cluster.lock (O_EXCL, our pid inside). A lock whose pid is gone is stale and taken over; a live
 * one refuses: { ok: false, holder }. Returns { ok: true, release() }.
 */
export function acquireLock(file, { pid = process.pid, alive = pidAlive } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return {
        ok: true,
        release: () => {
          try {
            if (Number(readFileSync(file, 'utf8').trim()) === pid) unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(file, 'utf8').trim());
      } catch {
        /* vanished between open and read: try again */
      }
      if (holder === pid) return { ok: true, release: () => {} };
      if (alive(holder)) return { ok: false, holder };
      rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  return { ok: false, holder: null };
}

/** Run `fn` holding the lock; a held lock fails fast with a message naming the holder. */
export async function withClusterLock(env, fn) {
  const lock = acquireLock(pgLockFile(env));
  if (!lock.ok) return { ok: false, state: 'locked', message: `another Command Center step holds the database lock (pid ${lock.holder ?? '?'}); wait for it to finish, then run this again` };
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// init / start / stop / status
// ---------------------------------------------------------------------------------------------------------------

/** {code, stdout, stderr} of a program (never through a shell); spawn errors read as code null. */
export const runTool = (cmd, args, { timeoutMs = 120_000, env, cwd } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env, cwd, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.error ? null : r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), missing: r.error?.code === 'ENOENT' };
};

/** The cluster's folders for `env`. */
export function clusterPaths(env = /** @type {Record<string, string | undefined>} */ (process.env)) {
  const runDir = pgRunDir(env);
  return { root: pgRoot(env), data: pgDataDir(env), runDir, socket: socketFile(runDir), lock: pgLockFile(env), logFile: join(logDir(env), 'db.log') };
}

/**
 * initdb once (a data folder with PG_VERSION is kept as it is), then the config files. Socket-only peer auth for
 * this Mac user, --locale=C (sorting never depends on the Mac's language), UTF8.
 */
/** @param {{ env?: Record<string, string | undefined>, bin?: string, user?: string, run?: typeof runTool }} [o] */
export function initCluster({ env = /** @type {Record<string, string | undefined>} */ (process.env), bin, user = osUser(), run = runTool } = {}) {
  const p = clusterPaths(env);
  if (socketTooLong(p.runDir)) {
    return { ok: false, state: 'socket_too_long', message: `the database socket path would be ${Buffer.byteLength(p.socket)} bytes; macOS allows ${SOCKET_PATH_MAX}. Set CC_PG_SOCKET_DIR in the env file to a shorter folder you own (for example ~/.cc-pg), then run this again` };
  }
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
  chmodSync(p.runDir, 0o700);
  const major = dataMajor(p.data);
  if (major) {
    writeClusterConf(p.data, p.runDir);
    return { ok: true, state: 'ok', created: false, major, message: `the database folder is there (Postgres ${major})` };
  }
  if (existsSync(p.data) && readdirSync(p.data).length) return { ok: false, state: 'data_dir_not_empty', message: `${p.data} holds files but no database: move it aside, then run this again` };
  if (!bin || !existsSync(join(bin, 'initdb'))) return { ok: false, state: 'engine_missing', message: 'the bundled initdb is missing' };
  const r = run(join(bin, 'initdb'), ['-D', p.data, '-U', user, '--locale=C', '--encoding=UTF8', '--auth-local=peer', '--auth-host=reject', '--no-instructions'], { timeoutMs: 180_000 });
  if (r.code !== 0) return { ok: false, state: 'init_failed', message: `initdb failed: ${(r.stderr || r.stdout).split('\n').at(-1) ?? ''}` };
  chmodSync(p.data, 0o700);
  writeClusterConf(p.data, p.runDir);
  return { ok: true, state: 'ok', created: true, major: dataMajor(p.data), message: 'created the database folder' };
}

/**
 * Start with pg_ctl (tests, the first install before the agent exists, `pg-cluster.mjs start`). A postmaster that
 * already runs on this data folder is left as it is; a second one is never started on it.
 */
/** @param {{ env?: Record<string, string | undefined>, bin?: string, run?: typeof runTool, timeoutMs?: number }} [o] */
export async function startCluster({ env = /** @type {Record<string, string | undefined>} */ (process.env), bin, run = runTool, timeoutMs = 60_000 } = {}) {
  const p = clusterPaths(env);
  const pm = readPostmasterPid(p.data);
  if (pm?.alive) {
    const ok = await waitReady(p.socket, { timeoutMs });
    return ok ? { ok: true, state: 'ok', already: true, message: `already running (pid ${pm.pid})` } : { ok: false, state: 'not_ready', message: `a postgres (pid ${pm.pid}) holds the data folder but does not answer on the socket` };
  }
  if (!dataMajor(p.data)) return { ok: false, state: 'not_initialised', message: 'no database folder yet (pg-cluster.mjs init)' };
  writeClusterConf(p.data, p.runDir);
  mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(p.logFile), { recursive: true, mode: 0o700 });
  const r = run(join(bin, 'pg_ctl'), ['-D', p.data, '-l', p.logFile, '-w', '-t', String(Math.ceil(timeoutMs / 1000)), 'start'], { timeoutMs: timeoutMs + 10_000 });
  if (r.code !== 0) return { ok: false, state: 'start_failed', message: `pg_ctl start failed (see ${p.logFile})` };
  return (await waitReady(p.socket, { timeoutMs })) ? { ok: true, state: 'ok', already: false, message: 'started' } : { ok: false, state: 'not_ready', message: 'started, but the socket does not answer' };
}

/** Stop a pg_ctl-started cluster (fast: open sessions are rolled back). An agent-run one is stopped with launchctl. */
/** @param {{ env?: Record<string, string | undefined>, bin?: string, run?: typeof runTool }} [o] */
export function stopCluster({ env = /** @type {Record<string, string | undefined>} */ (process.env), bin, run = runTool } = {}) {
  const p = clusterPaths(env);
  const pm = readPostmasterPid(p.data);
  if (!pm?.alive) return { ok: true, state: 'stopped', message: 'not running' };
  const r = run(join(bin, 'pg_ctl'), ['-D', p.data, '-m', 'fast', '-w', '-t', '60', 'stop'], { timeoutMs: 70_000 });
  return r.code === 0 ? { ok: true, state: 'stopped', message: 'stopped' } : { ok: false, state: 'stop_failed', message: 'pg_ctl stop failed' };
}

/** What doctor and `pg-cluster.mjs status` print: initialised, its major, the postmaster, the socket. */
export async function clusterStatus({ env = /** @type {Record<string, string | undefined>} */ (process.env), ping = pgPing } = {}) {
  const p = clusterPaths(env);
  const pm = readPostmasterPid(p.data);
  const answer = await ping(p.socket);
  return { data: p.data, socket: p.socket, initialised: !!dataMajor(p.data), major: dataMajor(p.data), pid: pm?.alive ? pm.pid : null, status: pm?.alive ? pm.status : null, ping: answer, engine: installedEngine(env) };
}

// ---------------------------------------------------------------------------------------------------------------
// SQL over the socket (node-postgres; the app's own dependency)
// ---------------------------------------------------------------------------------------------------------------

export async function loadPg() {
  const m = await import('pg');
  return m.default ?? m;
}

/** Session settings that make text renderings identical on both sides of a verify (timestamps, floats, intervals). */
export const STABLE_SESSION = "SET TimeZone = 'UTC'; SET extra_float_digits = 1; SET IntervalStyle = 'postgres'; SET bytea_output = 'hex'; SET DateStyle = 'ISO, MDY'";

/** Run `fn(q)` on one connection to `url`; q(sql, params) → rows. */
export async function withClient(url, fn, { applicationName = 'command-center-ops', stable = true } = {}) {
  const pg = await loadPg();
  const c = new pg.Client({ connectionString: url, application_name: applicationName, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try {
    if (stable) await c.query(STABLE_SESSION);
    return await fn(async (sql, params) => (await c.query(sql, params)).rows);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** The same URL on another database of the same server. */
export function urlForDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** CREATE DATABASE when it isn't there. Returns { created }. */
export async function ensureAppDatabase(url, { db = dbNameOf(url) || DB_NAME } = {}) {
  if (!SAFE_DB.test(db)) throw new Error(`unsafe database name: ${JSON.stringify(db)}`);
  return withClient(urlForDb(url, 'postgres'), async (q) => {
    const has = async (n) => (await q('SELECT 1 FROM pg_database WHERE datname = $1', [n])).length > 0;
    if (await has(db)) return { created: false };
    // a restored 1.x backup (or a rename that did not run yet) holds the database under its old name: rename, never an empty twin
    if (db === DB_NAME && (await has(LEGACY_DB_NAME))) {
      await q('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [LEGACY_DB_NAME]);
      await q(`ALTER DATABASE "${LEGACY_DB_NAME}" RENAME TO "${DB_NAME}"`);
      return { created: false, renamedFrom: LEGACY_DB_NAME };
    }
    await q(`CREATE DATABASE "${db}"`);
    return { created: true };
  });
}

/** The server's major (server_version_num / 10000). */
export async function serverMajor(url) {
  return withClient(url, async (q) => Math.floor(Number((await q('SHOW server_version_num'))[0].server_version_num) / 10_000), { stable: false });
}

export { SAFE_DB };
