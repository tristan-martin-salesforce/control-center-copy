/**
 * D-101: the 1.x -> 2.0 folder migration (scripts/ops/lib/migrate-state.mjs). A temp HOME holds a 1.x install (the
 * state folder, three LaunchAgent plists, the logs); launchctl, plutil, the cluster and the database rename are fakes.
 * Nothing here touches a real LaunchAgent, the real state folder or a database.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePlan, realMigrateDeps } from '../../scripts/ops/lib/migrate-state-real.mjs';
import {
  LEGACY,
  MARKER_FILE,
  migrateState,
  migrationNeeded,
  migrationPaths,
  keepLastLegacyBackup,
  migrationState,
  NEW_DB,
  readServicePlist,
  NEW_LABELS,
  renameDbInUrl,
  replacePath,
  rewriteEnvText,
  rewritePlist,
  takeLock,
} from '../../scripts/ops/lib/migrate-state.mjs';
import { keepBeforeMajor, listKeptBackups, pruneBackups } from '../../scripts/ops/lib/backup.mjs';
import { renderAgent, renderDbAgent } from '../../scripts/ops/lib/plist.mjs';
import { STATE_FOLDER_NAME as MJS_FOLDER } from '../../scripts/ops/lib/paths.mjs';
import { stateDir as mjsStateDir } from '../../scripts/ops/lib/paths.mjs';
import { bundledDatabaseUrl } from '../../scripts/ops/lib/pg.mjs';
import { DB_NAME as TS_DB, STATE_FOLDER_NAME as TS_FOLDER, stateDir as tsStateDir, WEB_LABEL, WORKER_LABEL } from '../../src/ops/paths';
import { DB_LABEL } from '../../src/ops/pg-cluster';

let home: string;
let env: Record<string, string>;
const support = () => join(home, 'Library', 'Application Support');
const OLD = () => join(support(), LEGACY.stateFolder);
const NEW = () => join(support(), 'command-center');
const AGENTS = () => join(home, 'Library', 'LaunchAgents');
const user = userInfo().username;

/** The 1.x socket URL: the old state folder's pg/run, percent-encoded (the folder has a space in its path). */
const oldSocketUrl = (db = LEGACY.db) => `postgresql:///${db}?host=${encodeURIComponent(join(OLD(), 'pg', 'run'))}&user=${encodeURIComponent(user)}`;
const TCP = 'postgresql://localhost:5432/control_center';

function plistFor(kind: 'web' | 'worker' | 'db'): string {
  // the 2.0 renderers, then the 1.x names and folders put back: what an install of 1.x wrote
  const xml =
    kind === 'db'
      ? renderDbAgent({ bin: join(OLD(), 'pg', 'engine', '17.5-arm64', 'bin'), dataDir: join(OLD(), 'pg', 'data'), logDir: join(home, 'Library', 'Logs', LEGACY.logFolder), home })
      : renderAgent({ kind, repo: '/Users/me/checkout', home, node: '/opt/homebrew/bin/node', npm: '/opt/homebrew/bin/npm', logDir: join(home, 'Library', 'Logs', LEGACY.logFolder), stateDir: OLD(), envFile: join(OLD(), 'env'), templateDir: join(process.cwd(), 'ops', 'launchd') });
  return xml.split('com.commandcenter').join('com.controlcenter');
}

/** A 1.x install on disk. */
function install1x({ url, agents = true, pg = false }: { url?: string; agents?: boolean; pg?: boolean } = {}) {
  mkdirSync(join(OLD(), 'backups'), { recursive: true });
  writeFileSync(join(OLD(), 'backups', 'control_center-20261101-030000.dump'), 'dump');
  writeFileSync(join(OLD(), 'env'), `# Command Center environment\n${url ? `DATABASE_URL=${url}\n` : ''}PORT=4327\nCC_DATA=db\n`, { mode: 0o600 });
  writeFileSync(join(OLD(), 'profile.json'), '{"name":"A"}');
  if (pg) {
    mkdirSync(join(OLD(), 'pg', 'data'), { recursive: true });
    writeFileSync(join(OLD(), 'pg', 'data', 'PG_VERSION'), '17\n');
    writeFileSync(join(OLD(), 'pg', 'data', 'command-center.conf'), `unix_socket_directories = '${join(OLD(), 'pg', 'run')}'\n`);
    writeFileSync(join(OLD(), 'pg', 'data', 'postgresql.conf'), "include_if_exists = 'command-center.conf'\n");
  }
  mkdirSync(join(home, 'Library', 'Logs', LEGACY.logFolder), { recursive: true });
  writeFileSync(join(home, 'Library', 'Logs', LEGACY.logFolder, 'web.log'), 'log');
  if (agents) {
    mkdirSync(AGENTS(), { recursive: true });
    for (const k of ['web', 'worker', 'db'] as const) writeFileSync(join(AGENTS(), `${LEGACY.labels[k]}.plist`), plistFor(k));
  }
}

interface Fake {
  lines: string[];
  calls: string[];
  loaded: Set<string>;
  deps: Parameters<typeof migrateState>[0];
  opts: { failBootout?: string; failRename?: boolean; renameDb?: () => Promise<string>; breakAfterRename?: boolean; pgAlive?: boolean };
}

/** Fakes for launchctl, plutil, the cluster and the rename; the env-file and cluster-config helpers are the real ones. */
function fake(loaded: string[] = [], opts: Fake['opts'] = {}): Fake {
  const f: Fake = { lines: [], calls: [], loaded: new Set(loaded), deps: undefined as never, opts };
  const real = realMigrateDeps({ env, say: () => undefined });
  f.deps = {
    ...real,
    say: (m: string) => f.lines.push(m),
    launchctl: {
      loaded: (l: string) => f.loaded.has(l),
      bootout: (l: string) => {
        f.calls.push(`bootout ${l}`);
        if (opts.failBootout === l) return false;
        f.loaded.delete(l);
        return true;
      },
      bootstrap: (l: string, file: string) => {
        f.calls.push(`bootstrap ${l}`);
        if (!existsSync(file)) return false;
        f.loaded.add(l);
        return true;
      },
    },
    lintPlist: (file: string) => {
      f.calls.push(`lint ${file.split('/').pop()}`);
    },
    pgAlive: () => !!opts.pgAlive,
    waitReady: async () => true,
    sleep: async () => undefined,
    rename: (a: string, b: string) => {
      if (opts.failRename) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      renameSync(a, b);
    },
    renameDb: opts.renameDb ?? (async () => (f.calls.push('renameDb'), 'renamed')),
  } as never;
  if (opts.breakAfterRename) {
    const rewrite = real.rewriteClusterConf;
    (f.deps as { rewriteClusterConf: () => void }).rewriteClusterConf = () => {
      if (opts.breakAfterRename) throw new Error('disk went away');
      rewrite();
    };
  }
  return f;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-mig-'));
  env = { HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the path helper (one place for the name)', () => {
  it('the .mjs and the TS twin agree on the folder, the labels and the database', () => {
    expect(MJS_FOLDER).toBe('command-center');
    expect(TS_FOLDER).toBe('command-center');
    expect(mjsStateDir({ HOME: '/Users/a b' })).toBe('/Users/a b/Library/Application Support/command-center');
    expect(tsStateDir({ CC_STATE_DIR: undefined })).toContain('Application Support/command-center');
    expect(NEW_LABELS).toEqual({ web: WEB_LABEL, worker: WORKER_LABEL, db: DB_LABEL });
    expect(NEW_LABELS.web).toBe('com.commandcenter.web');
    expect(TS_DB).toBe(NEW_DB);
    expect(bundledDatabaseUrl({ CC_STATE_DIR: '/s' })).toContain('/command_center?');
  });

  it('CC_STATE_DIR skips the migration (a scratch or test state folder has no old folder)', () => {
    install1x();
    expect(migrationPaths({ HOME: home, CC_STATE_DIR: '/x' }).skipped).toBe(true);
    expect(migrationState({ HOME: home, CC_STATE_DIR: '/x' }).kind).toBe('skipped');
  });
});

describe('rewriting', () => {
  it('replacePath handles the raw, the percent-encoded and the XML-escaped spelling of a path', () => {
    const from = '/Users/a & b/Library/Application Support/control-center';
    const to = '/Users/a & b/Library/Application Support/command-center';
    const text = `${from}/x ${encodeURIComponent(from)}%2Fpg ${from.replace('&', '&amp;')}/y`;
    expect(replacePath(text, from, to)).toBe(`${to}/x ${encodeURIComponent(to)}%2Fpg ${to.replace('&', '&amp;')}/y`);
  });

  it('the env file: a bundled socket URL follows the folder; a TCP URL, a custom URL and other lines stay as they are', () => {
    const p = { oldState: OLD(), newState: NEW() };
    const socket = `# c\nDATABASE_URL=${oldSocketUrl()}\nPORT=4327\n`;
    const moved = rewriteEnvText(socket, p);
    expect(moved).toContain(encodeURIComponent(join(NEW(), 'pg', 'run')));
    expect(moved).not.toContain(encodeURIComponent(OLD()));
    expect(moved).toContain('PORT=4327');
    expect(rewriteEnvText(`DATABASE_URL=${TCP}\n`, p)).toBe(`DATABASE_URL=${TCP}\n`);
    const custom = 'DATABASE_URL=postgres://me:pw@db.example.com:6543/mine\n';
    expect(rewriteEnvText(custom, p)).toBe(custom);
  });

  it('renameDbInUrl changes only the database name', () => {
    expect(renameDbInUrl(TCP)).toBe('postgresql://localhost:5432/command_center');
    expect(renameDbInUrl(oldSocketUrl())).toBe(oldSocketUrl(NEW_DB));
    expect(renameDbInUrl('postgres://localhost/other')).toBe('postgres://localhost/other');
    expect(renameDbInUrl('postgres://u:control_center@h/control_center_x')).toBe('postgres://u:control_center@h/control_center_x');
  });

  it('a plist becomes the new one: labels, folders and the log folder, the checkout it runs unchanged', () => {
    install1x();
    const old = readFileSync(join(AGENTS(), `${LEGACY.labels.worker}.plist`), 'utf8');
    expect(old).toContain('com.controlcenter.worker');
    const p = { oldState: OLD(), newState: NEW(), oldLogs: join(home, 'Library', 'Logs', LEGACY.logFolder), newLogs: join(home, 'Library', 'Logs', 'command-center') };
    const next = rewritePlist(old, p);
    expect(next).toBe(old.split('com.controlcenter').join('com.commandcenter').split(OLD()).join(NEW()).split(p.oldLogs).join(p.newLogs));
    expect(next).toContain('<string>com.commandcenter.worker</string>');
    expect(next).toContain(`<string>${join(NEW(), 'env')}</string>`);
    expect(next).toContain('/Users/me/checkout');
    expect(next).not.toMatch(/control-center|controlcenter|control_center/);
    const db = rewritePlist(readFileSync(join(AGENTS(), `${LEGACY.labels.db}.plist`), 'utf8'), p);
    expect(db).toContain(join(NEW(), 'pg', 'engine', '17.5-arm64', 'bin', 'postgres'));
    expect(db).toContain(join(NEW(), 'pg', 'data'));
    expect(db).not.toMatch(/control-center|controlcenter/);
  });
});

describe('the state machine', () => {
  it('a 1.x bundled install: stops the agents, moves the folder, repoints everything, renames the database', async () => {
    install1x({ url: oldSocketUrl(), pg: true });
    const f = fake([LEGACY.labels.web, LEGACY.labels.worker, LEGACY.labels.db]);
    const r = await migrateState(f.deps, { env });
    expect(r.status).toBe('migrated');
    expect(existsSync(OLD())).toBe(false);
    expect(readFileSync(join(NEW(), 'profile.json'), 'utf8')).toContain('"A"');
    expect(existsSync(join(NEW(), 'backups', 'control_center-20261101-030000.dump'))).toBe(true);
    // the env file: the socket path is the new one and the database is command_center
    const envText = readFileSync(join(NEW(), 'env'), 'utf8');
    expect(envText).toContain(`DATABASE_URL=postgresql:///command_center?host=${encodeURIComponent(join(NEW(), 'pg', 'run'))}`);
    expect(envText).toContain('# Command Center environment');
    // the cluster's own config names the new socket folder
    expect(readFileSync(join(NEW(), 'pg', 'data', 'command-center.conf'), 'utf8')).toContain(join(NEW(), 'pg', 'run'));
    // plists: new labels, old ones gone
    expect(readdirSync(AGENTS()).sort()).toEqual(['com.commandcenter.db.plist', 'com.commandcenter.web.plist', 'com.commandcenter.worker.plist']);
    expect(readFileSync(join(AGENTS(), 'com.commandcenter.web.plist'), 'utf8')).toContain(join(NEW(), 'env'));
    // logs followed
    expect(existsSync(join(home, 'Library', 'Logs', 'command-center', 'web.log'))).toBe(true);
    expect(existsSync(join(home, 'Library', 'Logs', LEGACY.logFolder))).toBe(false);
    // order: old agents stopped web, worker, db; the new database first, then the rename, then web and worker
    expect(f.calls.filter((c) => c.startsWith('boot') || c === 'renameDb')).toEqual([
      'bootout com.controlcenter.web',
      'bootout com.controlcenter.worker',
      'bootout com.controlcenter.db',
      'bootstrap com.commandcenter.db',
      'renameDb',
      'bootstrap com.commandcenter.web',
      'bootstrap com.commandcenter.worker',
    ]);
    expect([...f.loaded].sort()).toEqual(['com.commandcenter.db', 'com.commandcenter.web', 'com.commandcenter.worker']);
    const marker = JSON.parse(readFileSync(join(NEW(), MARKER_FILE), 'utf8'));
    expect(marker).toMatchObject({ migratedFrom: 'control-center', database: { status: 'renamed', name: 'command_center' } });
    expect(Date.parse(marker.completedAt)).not.toBeNaN();
    expect(f.lines.length).toBeGreaterThan(4); // one plain line per step
  });

  it('a 1.x Homebrew (TCP) install: same move, the URL keeps its host and only the database name changes', async () => {
    install1x({ url: TCP });
    const f = fake([LEGACY.labels.web, LEGACY.labels.worker]);
    expect((await migrateState(f.deps, { env })).status).toBe('migrated');
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain('DATABASE_URL=postgresql://localhost:5432/command_center\n');
    expect(f.calls).toContain('renameDb');
    expect(f.calls).not.toContain('bootstrap com.commandcenter.db'); // no database agent in a Homebrew install
    expect([...f.loaded].sort()).toEqual(['com.commandcenter.web', 'com.commandcenter.worker']);
  });

  it('a custom DATABASE_URL is left alone, and its database is never renamed', async () => {
    const url = 'postgres://me:pw@db.example.com:6543/mine_control_center';
    install1x({ url });
    const f = fake([LEGACY.labels.web]);
    const r = await migrateState(f.deps, { env });
    expect(r.status).toBe('migrated');
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain(`DATABASE_URL=${url}\n`);
    expect(f.calls).not.toContain('renameDb');
    expect(r.notes.join(' ')).toMatch(/left alone/);
  });

  it('agents that were installed but not running when the move began are rewritten and started (W34-1)', async () => {
    install1x({ url: TCP });
    const f = fake([]);
    await migrateState(f.deps, { env });
    expect(existsSync(join(AGENTS(), 'com.commandcenter.web.plist'))).toBe(true);
    expect(f.calls.filter((c) => c.startsWith('bootstrap'))).toEqual(['bootstrap com.commandcenter.web', 'bootstrap com.commandcenter.worker']);
  });

  it('both folders: the new one is used, the old one is untouched, nothing is merged', async () => {
    install1x({ url: TCP });
    mkdirSync(NEW(), { recursive: true });
    writeFileSync(join(NEW(), 'marker.txt'), 'new');
    const f = fake([LEGACY.labels.web]);
    const r = await migrateState(f.deps, { env });
    expect(r.status).toBe('both');
    expect(f.lines.join('\n')).toMatch(/using .*command-center/);
    expect(existsSync(join(OLD(), 'profile.json'))).toBe(true);
    expect(existsSync(join(NEW(), 'profile.json'))).toBe(false);
    expect(f.calls).toEqual([]);
    expect(migrationNeeded(env)).toBe(false);
  });

  it('only the new folder, or neither: nothing happens', async () => {
    const none = fake();
    expect((await migrateState(none.deps, { env })).status).toBe('none');
    mkdirSync(NEW(), { recursive: true });
    const only = fake();
    expect((await migrateState(only.deps, { env })).status).toBe('none');
    expect(only.calls).toEqual([]);
    expect(readdirSync(NEW())).toEqual([]);
  });

  it('is idempotent: a second run after a finished one does nothing', async () => {
    install1x({ url: TCP });
    await migrateState(fake([LEGACY.labels.web]).deps, { env });
    const again = fake();
    expect((await migrateState(again.deps, { env })).status).toBe('none');
    expect(again.calls).toEqual([]);
  });

  it('a failure right after the folder rename leaves a state the next run finishes from', async () => {
    install1x({ url: oldSocketUrl(), pg: true });
    const broken = fake([LEGACY.labels.web, LEGACY.labels.worker, LEGACY.labels.db], { breakAfterRename: true });
    await expect(migrateState(broken.deps, { env })).rejects.toThrow(/disk went away/);
    // half way: the folder moved, the old plists are still there, the marker is open and says what was running
    expect(existsSync(OLD())).toBe(false);
    expect(existsSync(join(AGENTS(), 'com.controlcenter.web.plist'))).toBe(true);
    const open = JSON.parse(readFileSync(join(NEW(), MARKER_FILE), 'utf8'));
    expect(open.completedAt).toBeNull();
    expect(open.wasLoaded).toEqual(['web', 'worker', 'db']);
    expect(migrationState(env).kind).toBe('finish');
    expect(migrationNeeded(env)).toBe(true);

    const healthy = fake([]); // nothing is loaded after the crash
    const r = await migrateState(healthy.deps, { env });
    expect(r.status).toBe('migrated');
    expect(readdirSync(AGENTS()).sort()).toEqual(['com.commandcenter.db.plist', 'com.commandcenter.web.plist', 'com.commandcenter.worker.plist']);
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain('/command_center?host=');
    // it started what the first run had stopped, from the marker
    expect([...healthy.loaded].sort()).toEqual(['com.commandcenter.db', 'com.commandcenter.web', 'com.commandcenter.worker']);
    expect(JSON.parse(readFileSync(join(NEW(), MARKER_FILE), 'utf8')).completedAt).not.toBeNull();
    expect(migrationNeeded(env)).toBe(false);
  });

  it('an interrupted run after the env rewrite and half the plists finishes without redoing or duplicating', async () => {
    install1x({ url: oldSocketUrl() });
    await expect(migrateState({ ...fake([LEGACY.labels.web]).deps, lintPlist: () => { throw new Error('plutil said no'); } } as never, { env })).rejects.toThrow(/plutil/);
    const r = await migrateState(fake([]).deps, { env });
    expect(r.status).toBe('migrated');
    expect(readFileSync(join(NEW(), 'env'), 'utf8').match(/DATABASE_URL=/g)).toHaveLength(1);
  });

  it('a database rename that fails keeps the old name and URL, says one line, never blocks; a later full run retries it', async () => {
    install1x({ url: TCP });
    let up = false;
    const f = fake([LEGACY.labels.web], { renameDb: async () => { if (!up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); return 'renamed'; } });
    const r = await migrateState(f.deps, { env });
    expect(r.status).toBe('migrated');
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain(`DATABASE_URL=${TCP}\n`);
    expect(f.lines.filter((l) => /keeps its old name/.test(l))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(NEW(), MARKER_FILE), 'utf8')).database).toMatchObject({ status: 'kept', name: 'control_center' });
    expect([...f.loaded]).toContain('com.commandcenter.web'); // the app still starts

    up = true;
    // a service start (quick) does not retry
    expect(await migrateState(f.deps, { env, quick: true })).toMatchObject({ status: 'none' });
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain(`DATABASE_URL=${TCP}\n`);
    // setup / install / update / doctor do
    await migrateState(f.deps, { env });
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain('DATABASE_URL=postgresql://localhost:5432/command_center\n');
    expect(JSON.parse(readFileSync(join(NEW(), MARKER_FILE), 'utf8')).database).toMatchObject({ status: 'renamed' });
  });

  it('both database names present: keeps the old one and says so', async () => {
    install1x({ url: TCP });
    const f = fake([], { renameDb: async () => 'both' });
    const r = await migrateState(f.deps, { env });
    expect(r.notes.join(' ')).toMatch(/both control_center and command_center exist/);
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain(`DATABASE_URL=${TCP}\n`);
  });

  it('an agent that will not stop blocks the move before anything changes, and the stopped ones start again', async () => {
    install1x({ url: TCP });
    const f = fake([LEGACY.labels.web, LEGACY.labels.worker], { failBootout: LEGACY.labels.worker });
    const r = await migrateState(f.deps, { env });
    expect(r.status).toBe('blocked');
    expect(existsSync(OLD())).toBe(true);
    expect(existsSync(NEW())).toBe(false);
    expect(f.loaded.has(LEGACY.labels.web)).toBe(true); // started again
  });

  it('a database server still running in the old folder blocks the move', async () => {
    install1x({ url: oldSocketUrl(), pg: true });
    const f = fake([], { pgAlive: true });
    expect((await migrateState(f.deps, { env })).status).toBe('blocked');
    expect(existsSync(OLD())).toBe(true);
  });

  it('a folder rename that fails puts the old agents back and moves nothing', async () => {
    install1x({ url: TCP });
    const f = fake([LEGACY.labels.web, LEGACY.labels.worker], { failRename: true });
    expect((await migrateState(f.deps, { env })).status).toBe('failed');
    expect(existsSync(OLD())).toBe(true);
    expect([...f.loaded].sort()).toEqual([LEGACY.labels.web, LEGACY.labels.worker]);
  });

  it('another migration holding the lock: this run stops (a stale lock from a dead process is taken over)', async () => {
    install1x({ url: TCP });
    const lock = migrationPaths(env).lock;
    writeFileSync(lock, `${process.pid + 0}\n`); // this very process: alive, and not "other" only by pid; use a fake holder
    rmSync(lock);
    const held = takeLock(lock, { pid: 111, alive: () => true });
    expect(held).not.toBeNull();
    expect(takeLock(lock, { pid: 222, alive: () => true })).toBeNull();
    expect((await migrateState({ ...fake().deps, takeLock: () => null } as never, { env })).status).toBe('busy');
    expect(existsSync(OLD())).toBe(true);
    held!.release();
    writeFileSync(lock, '999999\n');
    const taken = takeLock(lock, { pid: 333, alive: () => false });
    expect(taken).not.toBeNull();
    taken!.release();
  });
});

describe('UPG-3: the web and worker plists are written again from the 2.0 template', () => {
  /** What 1.x's template wrote: `next start -p 4327`, no -H (D-76 came with 2.0). */
  const strip1x = (xml: string) => xml.replace(/\s*<string>-H<\/string>\s*<string>127\.0\.0\.1<\/string>/, '');

  it('a 1.x web plist without the loopback bind comes out binding 127.0.0.1, under the 2.0 labels, for the same checkout', async () => {
    install1x({ url: TCP });
    const webOld = join(AGENTS(), `${LEGACY.labels.web}.plist`);
    writeFileSync(webOld, strip1x(readFileSync(webOld, 'utf8')));
    expect(readFileSync(webOld, 'utf8')).not.toContain('127.0.0.1');
    const f = fake([LEGACY.labels.web, LEGACY.labels.worker]);
    expect((await migrateState(f.deps, { env })).status).toBe('migrated');
    const web = readFileSync(join(AGENTS(), `${NEW_LABELS.web}.plist`), 'utf8');
    expect(web).toMatch(/<string>start<\/string>\s*<string>-H<\/string>\s*<string>127\.0\.0\.1<\/string>\s*<string>-p<\/string>\s*<string>4327<\/string>/);
    expect(web).toContain(`<string>${NEW_LABELS.web}</string>`);
    expect(web).toContain('<string>/Users/me/checkout</string>');
    expect(web).toContain(join(NEW(), 'env'));
    expect(web).not.toContain('control-center');
    expect(web).not.toContain('controlcenter');
    const worker = readFileSync(join(AGENTS(), `${NEW_LABELS.worker}.plist`), 'utf8');
    expect(worker).toContain(`<string>${NEW_LABELS.worker}</string>`);
    expect(worker).toContain('<string>worker:start</string>');
    expect(f.lines).toContain('services rewritten for 2.0: web binds 127.0.0.1');
    expect(f.calls).toEqual(expect.arrayContaining(['bootout com.controlcenter.web', 'bootstrap com.commandcenter.web', 'bootstrap com.commandcenter.worker']));
    // a second run changes nothing
    const before = readFileSync(join(AGENTS(), `${NEW_LABELS.web}.plist`), 'utf8');
    const again = fake([NEW_LABELS.web, NEW_LABELS.worker]);
    expect((await migrateState(again.deps, { env })).status).toBe('none');
    expect(again.calls).toEqual([]);
    expect(readFileSync(join(AGENTS(), `${NEW_LABELS.web}.plist`), 'utf8')).toBe(before);
  });

  it('readServicePlist reads the checkout, node, npm and port; a compiled release stays a release', () => {
    install1x({ url: TCP });
    const w = readServicePlist(strip1x(readFileSync(join(AGENTS(), `${LEGACY.labels.web}.plist`), 'utf8')));
    expect(w).toEqual({ repo: '/Users/me/checkout', node: '/opt/homebrew/bin/node', npm: '/opt/homebrew/bin/npm', port: 4327, release: false });
    const k = readServicePlist(readFileSync(join(AGENTS(), `${LEGACY.labels.worker}.plist`), 'utf8'));
    expect(k).toMatchObject({ npm: '/opt/homebrew/bin/npm', release: false });
    const rel = renderAgent({ kind: 'web', repo: '/x/releases/current', home, node: '/n/node', npm: '/n/npm', logDir: '/l', stateDir: '/s', envFile: '/s/env', templateDir: join(process.cwd(), 'ops', 'launchd'), release: true });
    expect(readServicePlist(rel)).toMatchObject({ repo: '/x/releases/current', release: true });
    expect(readServicePlist('<plist/>')).toBeNull();
  });

  it('an old plist it cannot read is copied with the names changed, and says to run ops:install', async () => {
    install1x({ url: TCP });
    writeFileSync(join(AGENTS(), `${LEGACY.labels.web}.plist`), `<plist><dict><key>Label</key><string>${LEGACY.labels.web}</string><string>${join(OLD(), 'env')}</string></dict></plist>`);
    const f = fake([LEGACY.labels.web]);
    const r = await migrateState(f.deps, { env });
    expect(readFileSync(join(AGENTS(), `${NEW_LABELS.web}.plist`), 'utf8')).toContain(join(NEW(), 'env'));
    expect(r.notes.join('\n')).toMatch(/com\.commandcenter\.web\.plist was copied from the 1\.x one: run npm run ops:install -- --yes/);
    expect(f.lines).not.toContain('services rewritten for 2.0: web binds 127.0.0.1');
  });
});

describe('UPG-4: the last backup before a major update is kept out of retention', () => {
  it('the move keeps the newest 1.x backup in backups/pre-2.0/, once, and says where', async () => {
    install1x({ url: TCP });
    writeFileSync(join(OLD(), 'backups', 'control_center-20261102-030000.dump'), 'newest');
    const f = fake([LEGACY.labels.web]);
    await migrateState(f.deps, { env });
    expect(readdirSync(join(NEW(), 'backups', 'pre-2.0'))).toEqual(['control_center-20261102-030000.dump']);
    expect(f.lines.some((l) => l.startsWith('kept the last 1.x backup out of retention:'))).toBe(true);
    expect(keepLastLegacyBackup(NEW())).toBeNull(); // already there: nothing again
  });

  it('keepBeforeMajor files it under pre-<major>.0; pruning never reaches it; restore --list names it', () => {
    const dir = join(home, 'backups');
    mkdirSync(dir, { recursive: true });
    for (let day = 1; day <= 30; day++) writeFileSync(join(dir, `command_center-202610${String(day).padStart(2, '0')}-030000.dump`), 'x');
    const kept = keepBeforeMajor(join(dir, 'command_center-20261001-030000.dump'), dir, 3);
    expect(kept).toBe(join(dir, 'pre-3.0', 'command_center-20261001-030000.dump'));
    expect(pruneBackups(dir, 'command_center')).toContain('command_center-20261001-030000.dump');
    expect(existsSync(kept)).toBe(true);
    expect(listKeptBackups(dir).map((b) => b.name)).toEqual(['pre-3.0/command_center-20261001-030000.dump']);
    expect(keepBeforeMajor(join(dir, 'command_center-20261030-030000.dump'), dir, 3)).toContain('pre-3.0');
    expect(listKeptBackups(dir)).toHaveLength(2);
  });
});

describe('UPG-8: --check names what happens to the database', () => {
  it('ours under the old name: renamed; Homebrew also moves on the next update; by hand: left alone; afterwards: already', async () => {
    install1x({ url: oldSocketUrl(), pg: true });
    expect(databasePlan(env)).toBe('will be renamed control_center → command_center');
    expect(databasePlan({ ...env, DATABASE_URL: 'postgres://me:pw@db.example.com/mine' })).toBe('left alone (DATABASE_URL set by hand)');
    writeFileSync(join(OLD(), 'env'), `DATABASE_URL=${TCP}\n`);
    expect(databasePlan(env)).toBe('will be renamed control_center → command_center; will move from Homebrew to the bundled cluster on the next update');
    writeFileSync(join(OLD(), 'env'), 'DATABASE_URL=postgres://me:pw@db.example.com:6543/mine\n');
    expect(databasePlan(env)).toBe('left alone (DATABASE_URL set by hand)');
    writeFileSync(join(OLD(), 'env'), `DATABASE_URL=${oldSocketUrl()}\n`);
    await migrateState(fake([]).deps, { env });
    expect(databasePlan(env)).toBe('already command_center');
  });
});
