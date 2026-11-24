/**
 * D-98: the bundled cluster's lifecycle pieces without a server: the db LaunchAgent rendered into a temp folder and
 * linted (never launchctl), the config it writes, the lock, postmaster.pid, the engine copy with the ICU dedupe and
 * the env-file edit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { updateEnvFile } from '../../scripts/ops/lib/envfile.mjs';
import { acquireLock, clusterConf, copyEngineTree, HBA, installedEngine, installEngine, readPostmasterPid, writeClusterConf } from '../../scripts/ops/lib/pg.mjs';
import { DB_LABEL, dbAgentBin, renderDbAgent } from '../../scripts/ops/lib/plist.mjs';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-pg-cluster-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('com.commandcenter.db (rendered, never loaded)', () => {
  it('runs postgres itself on the data folder, KeepAlive, logs to db.log, and lints', () => {
    const bin = '/Users/a & b/Library/Application Support/command-center/pg/engine/17.12.0-beta.19-arm64/bin';
    const xml = renderDbAgent({ bin, dataDir: '/Users/a & b/Library/Application Support/command-center/pg/data', logDir: '/Users/a & b/Library/Logs/command-center', home: '/Users/a & b' });
    const f = join(dir, `${DB_LABEL}.plist`);
    writeFileSync(f, xml);
    execFileSync('/usr/bin/plutil', ['-lint', f], { stdio: 'pipe' });
    const json = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' }));
    expect(json).toMatchObject({
      Label: 'com.commandcenter.db',
      ProgramArguments: [`${bin}/postgres`, '-D', '/Users/a & b/Library/Application Support/command-center/pg/data'],
      RunAtLoad: true,
      KeepAlive: true,
      ExitTimeOut: 60,
      StandardErrorPath: '/Users/a & b/Library/Logs/command-center/db.log',
      EnvironmentVariables: { HOME: '/Users/a & b', LC_ALL: 'C' },
    });
    // no Node parent: the program is postgres, so stopping the agent stops the server
    expect(json.ProgramArguments[0]).toMatch(/\/postgres$/);
    expect(dbAgentBin(xml)).toBe(bin);
  });
});

describe('the cluster config', () => {
  it('a socket only (no TCP), 30 connections, the socket folder quoted; peer auth on the socket only', () => {
    const conf = clusterConf({ runDir: "/Users/o'neil/Library/Application Support/command-center/pg/run" });
    expect(conf).toContain("listen_addresses = ''");
    expect(conf).toContain("unix_socket_directories = '/Users/o''neil/Library/Application Support/command-center/pg/run'");
    expect(conf).toContain('unix_socket_permissions = 0700');
    expect(conf).toContain('max_connections = 30');
    expect(HBA.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['local   all   all   peer']);
  });

  it('writes command-center.conf, pg_hba.conf, and includes the former from postgresql.conf once', () => {
    writeFileSync(join(dir, 'postgresql.conf'), "# initdb's\nshared_buffers = 128MB\n");
    writeClusterConf(dir, '/r');
    writeClusterConf(dir, '/r2');
    const main = readFileSync(join(dir, 'postgresql.conf'), 'utf8');
    expect(main.match(/include_if_exists = 'command-center.conf'/g)).toHaveLength(1);
    expect(readFileSync(join(dir, 'command-center.conf'), 'utf8')).toContain("unix_socket_directories = '/r2'");
    expect(statSync(join(dir, 'pg_hba.conf')).mode & 0o777).toBe(0o600);
  });
});

describe('the lifecycle lock and postmaster.pid', () => {
  it('one holder at a time; a dead holder is stale and taken over; release removes only our own', () => {
    const f = join(dir, 'pg', 'cluster.lock');
    const a = acquireLock(f, { pid: 111, alive: () => true });
    expect(a.ok).toBe(true);
    expect(acquireLock(f, { pid: 222, alive: (p) => p === 111 })).toMatchObject({ ok: false, holder: 111 });
    const b = acquireLock(f, { pid: 222, alive: () => false }); // 111 died
    expect(b.ok).toBe(true);
    expect(readFileSync(f, 'utf8').trim()).toBe('222');
    a.release?.(); // not ours any more: kept
    expect(existsSync(f)).toBe(true);
    b.release?.();
    expect(existsSync(f)).toBe(false);
  });

  it('reads the pid, the socket folder and the status line Postgres writes', () => {
    writeFileSync(join(dir, 'postmaster.pid'), `4242\n${dir}\n1795232680\n5432\n/tmp/cc pg\n\n 43479139    786433\nready   \n`);
    expect(readPostmasterPid(dir, (p) => p === 4242)).toEqual({ pid: 4242, alive: true, dataDir: dir, port: 5432, socketDir: '/tmp/cc pg', status: 'ready' });
    expect(readPostmasterPid(join(dir, 'nope'))).toBeNull();
  });
});

describe('the engine copy', () => {
  it('copies the package once per version; identical dylibs (the ICU triplets) become relative symlinks', () => {
    const pkg = join(dir, 'pkg');
    mkdirSync(join(pkg, 'native', 'bin'), { recursive: true });
    mkdirSync(join(pkg, 'native', 'lib', 'postgresql'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '17.12.0-beta.19' }));
    writeFileSync(join(pkg, 'native', 'bin', 'postgres'), '#!/bin/sh\n', { mode: 0o755 });
    const big = Buffer.alloc(200 * 1024, 7);
    for (const n of ['libicudata.68.2.dylib', 'libicudata.68.dylib', 'libicudata.dylib']) writeFileSync(join(pkg, 'native', 'lib', n), big);
    writeFileSync(join(pkg, 'native', 'lib', 'libz.dylib'), Buffer.alloc(200 * 1024, 9));
    const env = { CC_STATE_DIR: join(dir, 'state') };
    const e = installEngine({ env, pkgDir: pkg, arch: 'arm64' }) as { dir: string; bin: string };
    expect(e).toMatchObject({ ok: true, version: '17.12.0-beta.19', major: 17, installed: true, savedBytes: 2 * 200 * 1024 });
    const lib = join(e.dir, 'lib');
    expect(lstatSync(join(lib, 'libicudata.68.2.dylib')).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(lib, 'libicudata.68.dylib'))).toBe('libicudata.68.2.dylib');
    expect(readlinkSync(join(lib, 'libicudata.dylib'))).toBe('libicudata.68.2.dylib');
    expect(lstatSync(join(lib, 'libz.dylib')).isSymbolicLink()).toBe(false);
    expect(statSync(join(e.bin, 'postgres')).mode & 0o111).toBeTruthy();
    expect(installEngine({ env, pkgDir: pkg, arch: 'arm64' })).toMatchObject({ ok: true, installed: false });
    expect(installedEngine(env)).toMatchObject({ version: '17.12.0-beta.19', major: 17 });
    expect(copyEngineTree(join(pkg, 'native'), join(dir, 'again'))).toBe(2 * 200 * 1024);
    expect(installEngine({ env, pkgDir: null })).toMatchObject({ ok: false, state: 'engine_missing' });
  });
});

describe('the env file edit', () => {
  it('replaces or appends keys, comments others out with a note, keeps the rest, mode 600, creates a missing file', () => {
    const f = join(dir, 'env');
    writeFileSync(f, '# top\nA=1\nexport B=2\nC=3\n', { mode: 0o644 });
    updateEnvFile(f, { set: { A: '9', D: '4' }, comment: ['B'], note: '(why)' });
    expect(readFileSync(f, 'utf8')).toBe('# top\nA=9\n# export B=2  (why)\nC=3\nD=4\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const g = join(dir, 'new-env');
    updateEnvFile(g, { set: { X: 'y' } });
    expect(readFileSync(g, 'utf8')).toBe('X=y\n');
  });
});
