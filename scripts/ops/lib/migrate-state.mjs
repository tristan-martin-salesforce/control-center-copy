// The 1.x -> 2.0 rename's folder migration (D-101): ~/Library/Application Support/control-center becomes
// .../command-center, with the database, the LaunchAgents and the logs following it. The ONE place the old names
// are spelled out (tests/ops/rename-grep.test.ts exempts this file, migrate-state-real.mjs and the ADR).
//
// A state machine over injected deps (tests/ops/migrate-state.test.ts runs it on a temp HOME with fakes for
// launchctl, the database and plutil). It decides from what is on disk, so a run that died half-way is finished by
// the next one:
//
//   old folder only            migrate: marker -> stop the old agents -> rename the folder -> finish
//   both folders               use the new one, say so; never merge, never delete the old
//   new folder, marker open    finish (the folder moved, the rest did not)
//   new folder only / neither  nothing
//
// finish (each step is safe to run again): logs folder -> old paths in the env file -> the cluster's own config ->
// new plists (web and worker rendered fresh from the 2.0 template, D-76 loopback included, UPG-3; the db one
// rewritten) -> database agent up -> database rename (control_center -> command_center,
// only when DATABASE_URL is ours; a failure keeps the old name and the URL, never blocks) -> web and worker up (every kind with a new plist, whatever was loaded
// before) -> old plists gone, old labels booted out -> marker "completedAt".
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchAgentsDir, logDir, stateDir } from './paths.mjs';
import { renderAgent } from './plist.mjs';

export const LEGACY = {
  stateFolder: 'control-center',
  logFolder: 'control-center',
  db: 'control_center',
  labels: { web: 'com.controlcenter.web', worker: 'com.controlcenter.worker', db: 'com.controlcenter.db' },
};
export const NEW_DB = 'command_center';
export const NEW_LABELS = { web: 'com.commandcenter.web', worker: 'com.commandcenter.worker', db: 'com.commandcenter.db' };
export const MARKER_FILE = 'migration.json';
const KINDS = ['web', 'worker', 'db']; // stop order: the database last, its smart shutdown waits for their sessions

/** @param {Record<string, string | undefined>} env */
export function migrationPaths(env = process.env) {
  const home = env.HOME || homedir();
  const support = join(home, 'Library', 'Application Support');
  return {
    home,
    // a CC_STATE_DIR (tests, a scratch install) has no old folder to move
    skipped: !!env.CC_STATE_DIR,
    oldState: join(support, LEGACY.stateFolder),
    newState: stateDir(env),
    oldLogs: env.CC_LOG_DIR ? null : join(home, 'Library', 'Logs', LEGACY.logFolder),
    newLogs: logDir(env),
    agentsDir: launchAgentsDir(env),
    lock: join(support, '.command-center-migrate.lock'),
  };
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (p, o) => {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(o, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
};
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Replace every `from` with `to` (and the percent-encoded and XML-escaped spellings of a path). */
export function replacePath(text, from, to) {
  let out = text.split(from).join(to);
  const enc = [encodeURIComponent(from), encodeURIComponent(to)];
  out = out.split(enc[0]).join(enc[1]);
  const esc = [escXml(from), escXml(to)];
  return esc[0] === from ? out : out.split(esc[0]).join(esc[1]);
}

/** An old plist's text as the new one: the folders and the labels renamed (the checkout path it runs stays). */
export function rewritePlist(text, { oldState, newState, oldLogs, newLogs }) {
  let out = replacePath(text, oldState, newState);
  if (oldLogs) out = replacePath(out, oldLogs, newLogs);
  for (const k of KINDS) out = out.split(LEGACY.labels[k]).join(NEW_LABELS[k]);
  return out;
}

const unXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const OWN_TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ops', 'launchd');

/** What a 1.x web or worker plist runs: the checkout, node, npm, the port, and whether it is a compiled release. */
export function readServicePlist(text) {
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text ?? '');
  const repo = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(text ?? '')?.[1];
  if (!arr || !repo) return null;
  const args = [...arr[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unXml(m[1]));
  const sep = args.indexOf('--');
  if (!args[0] || sep < 0) return null;
  const cmd = args.slice(sep + 1);
  const pIdx = cmd.indexOf('-p');
  const envPort = /<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(text)?.[1];
  const port = Number(pIdx >= 0 ? cmd[pIdx + 1] : envPort) || 4327;
  const release = cmd.some((a) => /\/scripts\/ops\/start-web\.mjs$|\/dist\/worker\/index\.mjs$/.test(a));
  const node = args[0];
  const npm = !release && cmd[1] === 'run' ? cmd[0] : join(dirname(node), 'npm');
  return { repo: unXml(repo), node, npm, port, release };
}

/**
 * UPG-3: a 1.x web or worker plist written again from 2.0's template (plist.mjs renderAgent) for the same checkout,
 * node and port, under the new folders: the web binds 127.0.0.1 (D-76) and the labels are 2.0's. The checkout's own
 * templates when it has 2.0's, else this code's. null when the old plist cannot be read (the caller rewrites it).
 */
export function renderServicePlist(kind, oldText, p) {
  const s = readServicePlist(oldText);
  if (!s) return null;
  const own = join(s.repo, 'ops', 'launchd');
  const templateDir = existsSync(join(own, `${NEW_LABELS[kind]}.plist.tmpl`)) ? own : OWN_TEMPLATES;
  return renderAgent({ kind, templateDir, repo: s.repo, home: p.home, node: s.node, npm: s.npm, port: s.port, release: s.release, logDir: p.newLogs, stateDir: p.newState, envFile: join(p.newState, 'env') });
}

/**
 * UPG-4: the newest 1.x backup (control_center-<stamp>.dump or .base.tgz, made by the 1.x updater just before this
 * move) linked into backups/pre-2.0/, where retention does not look (backup.mjs keepBeforeMajor, inlined: this file
 * stays free of the backup module's Homebrew probe). Once only; a later run finds it there.
 */
export function keepLastLegacyBackup(state, say = () => undefined) {
  const dir = join(state, 'backups');
  const kept = join(dir, 'pre-2.0');
  if (!isDir(dir) || isDir(kept)) return null;
  const re = new RegExp(`^${LEGACY.db}-(\\d{8}-\\d{6})\\.(dump|base\\.tgz)$`);
  const newest = readdirSync(dir).filter((f) => re.test(f)).sort((a, b) => (re.exec(a)[1] < re.exec(b)[1] ? -1 : 1)).at(-1);
  if (!newest) return null;
  mkdirSync(kept, { recursive: true, mode: 0o700 });
  try {
    linkSync(join(dir, newest), join(kept, newest));
  } catch {
    copyFileSync(join(dir, newest), join(kept, newest));
  }
  say(`kept the last 1.x backup out of retention: ${join(kept, newest)} (npm run restore -- --list)`);
  return join(kept, newest);
}

/** The env file's text with the old state folder's path replaced (DATABASE_URL's socket host, any other value). */
export const rewriteEnvText = (text, { oldState, newState }) => replacePath(text, oldState, newState);

/** `…/control_center?…` -> `…/command_center?…` without re-serialising the rest of the URL. */
export function renameDbInUrl(url, from = LEGACY.db, to = NEW_DB) {
  return String(url).replace(/^(postgres(?:ql)?:\/\/[^/?#]*\/)([^?#]*)/, (m, head, name) => (decodeURIComponent(name) === from ? `${head}${to}` : m));
}

/**
 * What a run would do, without doing anything (run-service's cheap check, doctor).
 * @param {Record<string, string | undefined>} [env]
 */
export function migrationState(env = process.env) {
  const p = migrationPaths(env);
  if (p.skipped) return { kind: 'skipped', p };
  const oldE = isDir(p.oldState);
  const newE = isDir(p.newState);
  const marker = readJson(join(newE ? p.newState : p.oldState, MARKER_FILE));
  if (oldE && newE) return { kind: 'both', p, marker };
  if (oldE) return { kind: 'migrate', p, marker };
  if (newE && marker && !marker.completedAt) return { kind: 'finish', p, marker };
  return { kind: 'none', p, marker };
}
/** @param {Record<string, string | undefined>} [env] */
export const migrationNeeded = (env = process.env) => ['migrate', 'finish'].includes(migrationState(env).kind);

/** An exclusive lock file (pid inside); stale when that pid is gone. null when another run holds it. */
export function takeLock(file, { pid = process.pid, alive = defaultAlive } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return { release: () => rmSync(file, { force: true }) };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      const holder = Number(readFileSync(file, 'utf8').trim());
      if (holder && holder !== pid && alive(holder)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}
function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * deps:
 *   say(line)                              one plain line per step
 *   launchctl: { loaded(label), bootout(label), bootstrap(label, file) }   → boolean
 *   lintPlist(file)                        throws when plutil rejects it
 *   pgAlive(stateDir)                      a postmaster of that state folder's cluster still runs?
 *   rewriteClusterConf(newState)           rewrite <state>/pg/data/command-center.conf for the new path (no-op without a cluster)
 *   waitReady(newState)                    Promise<boolean>: the bundled cluster answers on its socket
 *   renameDb(url)                          Promise<'renamed' | 'already' | 'both' | 'absent'>; throws when it cannot
 *   sleep(ms), now(), rename(from, to)     optional (fs.renameSync, a short sleep, the clock)
 * opts: { env, quick = false }   quick: from a LaunchAgent start, no database retry
 * Returns { status: 'none' | 'skipped' | 'both' | 'migrated' | 'finished' | 'blocked' | 'failed' | 'busy', notes: [] }.
 */
export async function migrateState(deps, opts = {}) {
  const env = opts.env ?? process.env;
  const st = migrationState(env);
  const { p } = st;
  const say = deps.say;
  if (st.kind === 'skipped') return { status: 'skipped', notes: [] };
  if (st.kind === 'both') {
    say(`Both the old and the new Command Center folders exist: using ${p.newState}. The old one (${p.oldState}) is left exactly as it is; nothing was merged or deleted.`);
    return { status: 'both', notes: [] };
  }
  if (st.kind === 'none') {
    // the database rename may have been kept (failed) last time: a full run tries it again
    if (!opts.quick && st.marker?.completedAt && st.marker.database?.status === 'kept') return retryDb(deps, st);
    return { status: 'none', notes: [] };
  }

  const lock = (deps.takeLock ?? takeLock)(p.lock);
  if (!lock) {
    say('another Command Center migration is running; waiting for it is not needed, this run stops here');
    return { status: 'busy', notes: [] };
  }
  try {
    // re-read under the lock: the run that held it may have finished
    const now = migrationState(env);
    if (now.kind === 'none' || now.kind === 'both') return migrateState(deps, opts);
    if (now.kind === 'migrate') {
      const r = await moveFolder(deps, p);
      if (r) return r;
    } else say(`finishing the move to ${p.newState} that an earlier run started`);
    return await finish(deps, p);
  } finally {
    lock.release();
  }
}

async function moveFolder(deps, p) {
  const say = deps.say;
  const rename = deps.rename ?? renameSync;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  say(`Command Center was renamed: moving ${p.oldState} to ${p.newState}`);
  const wasLoaded = KINDS.filter((k) => deps.launchctl.loaded(LEGACY.labels[k]));
  // the marker travels with the folder, so an interrupted run knows what was running
  writeJson(join(p.oldState, MARKER_FILE), { migratedFrom: LEGACY.stateFolder, startedAt: (deps.now?.() ?? new Date()).toISOString(), wasLoaded, completedAt: null });
  const stopped = [];
  for (const k of wasLoaded.filter((x) => KINDS.includes(x))) {
    say(`stopping ${LEGACY.labels[k]}`);
    if (!deps.launchctl.bootout(LEGACY.labels[k])) {
      say(`could not stop ${LEGACY.labels[k]}; nothing was moved. Stop it (launchctl bootout gui/$UID/${LEGACY.labels[k]}) and run the update again.`);
      for (const s of stopped) deps.launchctl.bootstrap(LEGACY.labels[s], join(p.agentsDir, `${LEGACY.labels[s]}.plist`));
      return { status: 'blocked', notes: [] };
    }
    stopped.push(k);
  }
  for (let i = 0; i < 60 && deps.pgAlive(p.oldState); i++) await sleep(500);
  if (deps.pgAlive(p.oldState)) {
    say('the database server of the old folder is still running; nothing was moved. Stop it (npm run ops:uninstall) and run the update again.');
    return { status: 'blocked', notes: [] };
  }
  try {
    rename(p.oldState, p.newState);
  } catch (e) {
    say(`could not rename the folder (${e.code ?? e.message}); nothing was moved. Starting the old agents again.`);
    for (const k of stopped.reverse()) deps.launchctl.bootstrap(LEGACY.labels[k], join(p.agentsDir, `${LEGACY.labels[k]}.plist`));
    return { status: 'failed', notes: [] };
  }
  say('folder moved');
  return null;
}

async function finish(deps, p) {
  const say = deps.say;
  const notes = [];
  const marker = readJson(join(p.newState, MARKER_FILE)) ?? { migratedFrom: LEGACY.stateFolder, startedAt: (deps.now?.() ?? new Date()).toISOString(), wasLoaded: [], completedAt: null };
  const wasLoaded = marker.wasLoaded ?? [];
  const save = (patch) => {
    Object.assign(marker, patch);
    writeJson(join(p.newState, MARKER_FILE), marker);
  };

  // the logs folder follows (best effort: the agents log into it)
  if (p.oldLogs && isDir(p.oldLogs) && !isDir(p.newLogs)) {
    try {
      mkdirSync(join(p.newLogs, '..'), { recursive: true });
      (deps.rename ?? renameSync)(p.oldLogs, p.newLogs);
      say(`logs moved to ${p.newLogs}`);
    } catch (e) {
      say(`the logs folder stays where it is (${e.code ?? e.message})`);
    }
  }

  // the env file: old paths -> new
  const envFile = join(p.newState, 'env');
  if (existsSync(envFile)) {
    const text = readFileSync(envFile, 'utf8');
    const next = rewriteEnvText(text, p);
    if (next !== text) {
      const tmp = `${envFile}.${process.pid}.tmp`;
      writeFileSync(tmp, next, { mode: 0o600 });
      renameSync(tmp, envFile);
      say('env file: the database socket path now points into the new folder');
    }
  }
  deps.rewriteClusterConf(p.newState);
  keepLastLegacyBackup(p.newState, say);

  // plists under the new labels: web and worker rendered fresh from 2.0's template (UPG-3: the 1.x web had no
  // -H 127.0.0.1), the database one rewritten (its engine path is only in the old plist)
  const fresh = new Set();
  for (const k of KINDS) {
    const from = join(p.agentsDir, `${LEGACY.labels[k]}.plist`);
    const to = join(p.agentsDir, `${NEW_LABELS[k]}.plist`);
    if (!existsSync(from) || existsSync(to)) continue;
    const old = readFileSync(from, 'utf8');
    let xml = null;
    if (k !== 'db') {
      try {
        xml = (deps.renderService ?? renderServicePlist)(k, old, p);
      } catch (e) {
        say(`could not render ${NEW_LABELS[k]}.plist from the 2.0 template (${e?.code ?? e?.message ?? e})`);
      }
      if (!xml) notes.push(`${NEW_LABELS[k]}.plist was copied from the 1.x one: run npm run ops:install -- --yes to write it from the 2.0 template`);
    }
    writeFileSync(to, xml ?? rewritePlist(old, p), { mode: 0o644 });
    deps.lintPlist(to);
    if (xml) fresh.add(k);
    say(`wrote ${NEW_LABELS[k]}.plist`);
  }
  if (fresh.size) say(`services rewritten for 2.0: ${fresh.has('web') ? 'web binds 127.0.0.1' : [...fresh].join(', ')}`);

  // the database agent first: the rename needs the cluster
  // (W34-1) every kind whose new plist exists is started, not only the ones loaded when the move began: in the 1.x
  // flow the move is spawned by the web agent's first restart, before the worker was bootstrapped, so wasLoaded misses it
  const hasPlist = (k) => existsSync(join(p.agentsDir, `${NEW_LABELS[k]}.plist`));
  if (wasLoaded.includes('db') || (hasPlist('db') && existsSync(join(p.newState, 'pg', 'data', 'PG_VERSION')))) {
    if (!deps.launchctl.loaded(NEW_LABELS.db)) deps.launchctl.bootstrap(NEW_LABELS.db, join(p.agentsDir, `${NEW_LABELS.db}.plist`));
    if (!(await deps.waitReady(p.newState))) notes.push('the database did not answer after the move; the services start once it does (npm run doctor)');
  }
  const db = await renameDatabase(deps, p);
  save({ database: db });
  if (db.note) notes.push(db.note);
  for (const k of ['web', 'worker']) {
    // a freshly written plist reaches a label that is somehow loaded already only through bootout + bootstrap
    if (fresh.has(k) && deps.launchctl.loaded(NEW_LABELS[k])) deps.launchctl.bootout(NEW_LABELS[k]);
    if (hasPlist(k) && !deps.launchctl.loaded(NEW_LABELS[k])) {
      say(`starting ${NEW_LABELS[k]}`);
      if (!deps.launchctl.bootstrap(NEW_LABELS[k], join(p.agentsDir, `${NEW_LABELS[k]}.plist`))) notes.push(`could not start ${NEW_LABELS[k]}: run npm run ops:install`);
    }
  }

  // the old plists go last (unloading the old label may end the process that runs this, so nothing follows it)
  for (const k of KINDS) rmSync(join(p.agentsDir, `${LEGACY.labels[k]}.plist`), { force: true });
  save({ completedAt: (deps.now?.() ?? new Date()).toISOString() });
  say(`done: Command Center now lives in ${p.newState}${marker.database?.status === 'renamed' ? ' (database command_center)' : ''}`);
  for (const k of KINDS) if (deps.launchctl.loaded(LEGACY.labels[k])) deps.launchctl.bootout(LEGACY.labels[k]);
  return { status: 'migrated', notes };
}

/** The database step. Only a DATABASE_URL that is ours (the bundled socket, the 1.x Homebrew default) is renamed. */
async function renameDatabase(deps, p) {
  const say = deps.say;
  const url = deps.databaseUrl(p.newState);
  if (!url.ours) return { status: 'left', name: url.name, note: url.name ? `DATABASE_URL is set by you (database ${url.name}): left alone` : undefined };
  if (url.name !== LEGACY.db) return { status: 'none', name: url.name };
  try {
    const r = await deps.renameDb(url.value);
    if (r === 'both') {
      say(`both databases ${LEGACY.db} and ${NEW_DB} exist: keeping ${LEGACY.db} (rename it yourself once you know which one holds your data)`);
      return { status: 'kept', name: LEGACY.db, reason: 'both', note: `both ${LEGACY.db} and ${NEW_DB} exist; ${LEGACY.db} is still used` };
    }
    deps.setDatabaseName(p.newState, NEW_DB);
    say(r === 'renamed' ? `database renamed: ${LEGACY.db} -> ${NEW_DB}` : `database ${NEW_DB} is in place`);
    return { status: 'renamed', name: NEW_DB };
  } catch (e) {
    const why = String(e?.code ?? e?.message ?? e).split('\n')[0];
    say(`the database keeps its old name ${LEGACY.db} for now (${why}); everything works as before, the next update tries again`);
    return { status: 'kept', name: LEGACY.db, reason: why, note: `database rename postponed (${why})` };
  }
}

async function retryDb(deps, st) {
  const { p } = st;
  const db = await renameDatabase(deps, p);
  if (db.status === 'renamed') {
    const m = readJson(join(p.newState, MARKER_FILE)) ?? {};
    writeJson(join(p.newState, MARKER_FILE), { ...m, database: db });
  }
  return { status: 'none', notes: db.note ? [db.note] : [] };
}
