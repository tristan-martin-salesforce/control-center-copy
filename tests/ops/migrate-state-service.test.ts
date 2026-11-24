/**
 * D-101, the path `npm run update` from a 1.x checkout takes: the old updater restarts the 1.x LaunchAgents on the NEW
 * code, and run-service.mjs (started under the old plist) hands the folder move to a detached process. Here the real
 * run-service.mjs and the real CLI run on a temp HOME against a fake launchctl (CC_LAUNCHCTL); the DATABASE_URL is a
 * custom one, so no database is touched. No real LaunchAgent is loaded or unloaded.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let home: string;
let fakeBin: string;
let loadedFile: string;
let logFile: string;
const OLD = () => join(home, 'Library', 'Application Support', 'control-center');
const NEW = () => join(home, 'Library', 'Application Support', 'command-center');
const AGENTS = () => join(home, 'Library', 'LaunchAgents');
const sh = (p: string) => join(process.cwd(), 'scripts', 'ops', p);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-mig-svc-'));
  fakeBin = join(home, 'fake-launchctl.sh');
  loadedFile = join(home, 'loaded.txt');
  logFile = join(home, 'launchctl.log');
  // print gui/<uid>/<label> -> 0 when the label is in loaded.txt; bootout removes it; bootstrap adds <plist basename>
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$@" >> "${logFile}"
touch "${loadedFile}"
case "$1" in
  print) grep -qx "\${2##*/}" "${loadedFile}" ;;
  bootout) l="\${2##*/}"; grep -vx "$l" "${loadedFile}" > "${loadedFile}.tmp"; mv "${loadedFile}.tmp" "${loadedFile}"; exit 0 ;;
  bootstrap) f="\${3##*/}"; echo "\${f%.plist}" >> "${loadedFile}"; exit 0 ;;
esac
`,
  );
  chmodSync(fakeBin, 0o755);
  mkdirSync(join(OLD(), 'backups'), { recursive: true });
  writeFileSync(join(OLD(), 'env'), 'DATABASE_URL=postgres://me:pw@db.example.com:6543/mine\nPORT=4327\n', { mode: 0o600 });
  mkdirSync(join(home, 'Library', 'Logs', 'control-center'), { recursive: true });
  mkdirSync(AGENTS(), { recursive: true });
  const plist = (label: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/true</string><string>${OLD()}/env</string></array></dict></plist>\n`;
  for (const k of ['web', 'worker']) writeFileSync(join(AGENTS(), `com.controlcenter.${k}.plist`), plist(`com.controlcenter.${k}`));
  writeFileSync(loadedFile, 'com.controlcenter.web\ncom.controlcenter.worker\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function envFor(): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, CC_LAUNCHCTL: fakeBin };
  for (const k of ['CC_STATE_DIR', 'CC_LOG_DIR', 'CC_LAUNCH_AGENTS_DIR', 'DATABASE_URL', 'CC_PG_DIR', 'CC_PG_SOCKET_DIR']) delete e[k];
  return e as NodeJS.ProcessEnv;
}

async function until(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe('the move, started the way the 1.x updater starts it', () => {
  it('--check says what it would do and changes nothing', () => {
    const r = spawnSync(process.execPath, [sh('migrate-state.mjs'), '--check'], { env: envFor(), encoding: 'utf8' });
    expect(r.stdout).toMatch(/migrate: .*control-center would move to .*command-center/);
    expect(r.stdout).toContain('[migrate] database: left alone (DATABASE_URL set by hand)'); // UPG-8 (a custom URL here)
    expect(existsSync(OLD())).toBe(true);
    expect(existsSync(NEW())).toBe(false);
  });

  it('an old agent starting on the new code ends at once, and a detached process finishes the move and starts the new agents', async () => {
    const r = spawnSync(process.execPath, [sh('run-service.mjs'), '--name', 'web', '--env-file', join(OLD(), 'env'), '--log-dir', join(home, 'Library', 'Logs', 'control-center'), '--', '/usr/bin/true'], { env: envFor(), encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    const done = await until(() => existsSync(join(NEW(), 'migration.json')) && !!JSON.parse(readFileSync(join(NEW(), 'migration.json'), 'utf8')).completedAt);
    expect(done).toBe(true);
    expect(existsSync(OLD())).toBe(false);
    expect(readdirSync(AGENTS()).sort()).toEqual(['com.commandcenter.web.plist', 'com.commandcenter.worker.plist']);
    expect(readFileSync(join(AGENTS(), 'com.commandcenter.web.plist'), 'utf8')).toContain(join(NEW(), 'env'));
    expect(readFileSync(join(NEW(), 'env'), 'utf8')).toContain('DATABASE_URL=postgres://me:pw@db.example.com:6543/mine'); // custom: untouched
    expect(readFileSync(loadedFile, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['com.commandcenter.web', 'com.commandcenter.worker']);
    // the log of the handoff is in the (moved) logs folder
    expect(existsSync(join(home, 'Library', 'Logs', 'command-center', 'migrate.log'))).toBe(true);
    // started again afterwards, the same agent finds nothing to do and runs its command
    const again = spawnSync(process.execPath, [sh('run-service.mjs'), '--name', 'web', '--no-wait-pg', '--env-file', join(NEW(), 'env'), '--log-dir', join(home, 'Library', 'Logs', 'command-center'), '--', '/usr/bin/true'], { env: envFor(), encoding: 'utf8', timeout: 30_000 });
    expect(again.status).toBe(0);
    expect(readFileSync(join(home, 'Library', 'Logs', 'command-center', 'web.log'), 'utf8')).toMatch(/exited code=0/);
  });

  it('W34-1: the worker not yet loaded when the move starts is still started under the new label, and the old labels are gone', async () => {
    writeFileSync(loadedFile, 'com.controlcenter.web\n'); // the old updater has bootstrapped web only; the worker comes next
    const r = spawnSync(process.execPath, [sh('run-service.mjs'), '--name', 'web', '--env-file', join(OLD(), 'env'), '--log-dir', join(home, 'Library', 'Logs', 'control-center'), '--', '/usr/bin/true'], { env: envFor(), encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    const done = await until(() => existsSync(join(NEW(), 'migration.json')) && !!JSON.parse(readFileSync(join(NEW(), 'migration.json'), 'utf8')).completedAt);
    expect(done).toBe(true);
    expect(JSON.parse(readFileSync(join(NEW(), 'migration.json'), 'utf8')).wasLoaded).toEqual(['web']);
    expect(readFileSync(loadedFile, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['com.commandcenter.web', 'com.commandcenter.worker']);
    expect(readdirSync(AGENTS()).sort()).toEqual(['com.commandcenter.web.plist', 'com.commandcenter.worker.plist']);
  });

  it('W34-1: an orphan old-label service whose env file vanished with the old folder exits 0 at once', () => {
    mkdirSync(NEW(), { recursive: true }); // moved and finished: nothing to migrate, the old folder is gone
    writeFileSync(join(NEW(), 'migration.json'), JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    rmSync(OLD(), { recursive: true, force: true });
    const r = spawnSync(process.execPath, [sh('run-service.mjs'), '--name', 'worker', '--env-file', join(OLD(), 'env'), '--log-dir', join(home, 'Library', 'Logs', 'control-center'), '--', '/usr/bin/true'], { env: envFor(), encoding: 'utf8', timeout: 10_000 });
    // Node 24+ reads a --env-file anywhere in argv and refuses a missing one itself (exit 9, "not found") before
    // run-service runs; older Node reaches run-service's own check (exit 0, one line). Either way no database wait.
    if (r.status === 9) expect(r.stderr).toMatch(/env.*not found/);
    else {
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/old folder no longer exists.*old-label service stops/);
    }
  });
});
