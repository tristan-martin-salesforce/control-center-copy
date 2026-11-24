/** D-98: doctor on the bundled cluster: the data folder, the majors, the Homebrew copy after a move, a URL you set. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDoctor, type DoctorContext } from '../../src/ops/doctor';
import type { ExecFn, ExecResult } from '../../src/ops/exec';

let dir: string;
const NOW = Date.parse('2026-12-10T12:00:00Z');
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });
const state = () => join(dir, 'state');
const only = ['postgres', 'db-cluster', 'db-major', 'db-homebrew', 'db-url'];

function ctx(over: Partial<DoctorContext> = {}, exec: ExecFn = async () => res({ code: 1 })): DoctorContext {
  return {
    env: { HOME: dir, CC_STATE_DIR: state() },
    repoRoot: dir,
    exec,
    now: () => NOW,
    portOpen: async () => false,
    withDb: async (_db, fn) => fn(async (sql) => (sql.includes('server_version_num') ? [{ server_version_num: '170012' }] : [])),
    fetchStatus: async () => 405,
    freeBytes: () => 40 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
    pingSocket: async () => 'ready',
    statPath: () => ({ uid: 501, mode: 0o700 }),
    ...over,
  };
}

function setUp({ major = '17', engine = '17.12.0-beta.19-arm64', env = 'CC_DATA=db\nCC_DB_ENGINE=bundled\n' } = {}) {
  mkdirSync(join(state(), 'pg', 'data'), { recursive: true });
  writeFileSync(join(state(), 'pg', 'data', 'PG_VERSION'), `${major}\n`);
  mkdirSync(join(state(), 'pg', 'engine', engine), { recursive: true });
  writeFileSync(join(state(), 'pg', 'engine', engine, '.complete'), '{}');
  writeFileSync(join(state(), 'env'), env, { mode: 0o600 });
}

const byId = async (c: DoctorContext) => Object.fromEntries((await runDoctor(c, { only })).checks.map((x) => [x.id, x]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-doctor-db-'));
  mkdirSync(state(), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('doctor: Command Center\'s own database', () => {
  it('all well: running, yours, mode 700, room, 17 everywhere, no URL override', async () => {
    setUp();
    const c = await byId(ctx());
    expect(c.postgres).toMatchObject({ status: 'ok', data: { engine: 'bundled' } });
    expect(c['db-cluster']).toMatchObject({ status: 'ok', detail: expect.stringContaining('mode 700, 40.0 GB free') });
    expect(c['db-cluster'].detail).not.toContain(dir); // never the user's home path
    expect(c['db-major']).toMatchObject({ status: 'ok', data: { files: 17, server: 17, engine: '17.12.0-beta.19' } });
    expect(c['db-homebrew'].status).toBe('skip');
    expect(c['db-url']).toMatchObject({ status: 'ok', data: { overridden: false, engine: 'bundled' } });
  });

  it('the data folder owned by someone else, or readable by others: DEP.DB.CLUSTER_PERMS with the fix', async () => {
    setUp();
    expect((await byId(ctx({ statPath: () => ({ uid: 0, mode: 0o700 }) })))['db-cluster']).toMatchObject({ status: 'fail', code: 'DEP.DB.CLUSTER_PERMS', fix: expect.stringContaining('chown -R') });
    expect((await byId(ctx({ statPath: () => ({ uid: 501, mode: 0o755 }) })))['db-cluster']).toMatchObject({ status: 'fail', code: 'DEP.DB.CLUSTER_PERMS', fix: expect.stringContaining('chmod 700') });
    expect((await byId(ctx({ freeBytes: () => 0.5 * 1024 ** 3 })))['db-cluster']).toMatchObject({ status: 'fail', code: 'DEP.DISK.LOW' });
  });

  it('a major mismatch (files from 16, or a server that answers 18): DEP.DB.MAJOR_MISMATCH', async () => {
    setUp({ major: '16' });
    expect((await byId(ctx()))['db-major']).toMatchObject({ status: 'fail', code: 'DEP.DB.MAJOR_MISMATCH' });
    rmSync(state(), { recursive: true, force: true });
    mkdirSync(state(), { recursive: true });
    setUp();
    const c = ctx({ withDb: async (_db, fn) => fn(async () => [{ server_version_num: '180001' }]) });
    expect((await byId(c))['db-major']).toMatchObject({ status: 'fail', code: 'DEP.DB.MAJOR_MISMATCH', data: { server: 18 } });
  });

  it('the Homebrew copy: kept 14 days in silence, then the removal commands while it is still there', async () => {
    setUp();
    writeFileSync(join(state(), 'pg', 'moved-from-homebrew.json'), JSON.stringify({ movedAt: '2026-12-01T10:00:00Z', database: 'command_center', keepDays: 14 }));
    expect((await byId(ctx()))['db-homebrew']).toMatchObject({ status: 'ok', detail: expect.stringContaining('kept, untouched, until 2026-12-15') });
    writeFileSync(join(state(), 'pg', 'moved-from-homebrew.json'), JSON.stringify({ movedAt: '2026-11-20T10:00:00Z', database: 'command_center', keepDays: 14 }));
    const still: ExecFn = async (cmd) => (cmd.endsWith('/psql') ? res({ stdout: '1\n' }) : res({ code: 1 }));
    expect((await byId(ctx({}, still)))['db-homebrew']).toMatchObject({ status: 'warn', code: 'DEP.DB.HOMEBREW_LEFTOVER', fix: expect.stringMatching(/dropdb -h localhost command_center && brew services stop postgresql@17$/) });
    const gone: ExecFn = async () => res({ code: null, spawnError: 'ENOENT' });
    expect((await byId(ctx({}, gone)))['db-homebrew']).toMatchObject({ status: 'ok', detail: expect.stringContaining('gone') });
  });

  it('a 1.x install still on Homebrew is told that npm run update moves it; CC_DB_ENGINE=homebrew keeps it quiet', async () => {
    writeFileSync(join(state(), 'env'), 'DATABASE_URL=postgresql://localhost:5432/command_center\n', { mode: 0o600 });
    const pg: ExecFn = async (cmd) => (cmd.endsWith('pg_isready') ? res() : res({ code: 1 }));
    const c = await byId(ctx({}, pg));
    expect(c.postgres).toMatchObject({ status: 'ok', data: { engine: 'homebrew' } });
    expect(c['db-homebrew']).toMatchObject({ status: 'warn', code: 'DEP.DB.MOVE_PENDING', fix: expect.stringContaining('npm run update') });
    expect(c['db-cluster'].status).toBe('skip');
    writeFileSync(join(state(), 'env'), 'DATABASE_URL=postgresql://localhost:5432/command_center\nCC_DB_ENGINE=homebrew\n', { mode: 0o600 });
    expect((await byId(ctx({}, pg)))['db-homebrew'].status).toBe('ok');
  });

  it('a DATABASE_URL you set is reported (never changed): the environment, or another value in the env file', async () => {
    const env = { HOME: dir, CC_STATE_DIR: state(), DATABASE_URL: 'postgres://db.example:5432/cc_mine' };
    const c = await byId(ctx({ env }));
    expect(c['db-url']).toMatchObject({ status: 'ok', data: { overridden: true, source: 'env', code: 'DEP.DB.URL_OVERRIDDEN' }, detail: expect.stringContaining('cc_mine') });
    expect(c.postgres.status).toBe('ok');
    expect(c['db-cluster'].status).toBe('skip');
  });

  it('the backups check counts a base backup of the bundled cluster (found by the release smoke: it only knew .dump)', async () => {
    setUp();
    mkdirSync(join(state(), 'backups'), { recursive: true });
    writeFileSync(join(state(), 'backups', 'command_center-20261210-023000.base.tgz'), 'x');
    utimesSync(join(state(), 'backups', 'command_center-20261210-023000.base.tgz'), new Date(NOW - 3600_000), new Date(NOW - 3600_000));
    const r = await runDoctor(ctx(), { only: ['backups'] });
    expect(r.checks[0]).toMatchObject({ status: 'ok', data: { last: 'command_center-20261210-023000.base.tgz' } });
  });

  it('not set up (a fresh state folder): DEP.DB.NOT_SET_UP on postgres and db-cluster', async () => {
    writeFileSync(join(state(), 'env'), 'CC_DATA=db\n', { mode: 0o600 });
    const c = await byId(ctx({ statPath: () => null }));
    expect(c.postgres).toMatchObject({ status: 'fail', code: 'DEP.DB.NOT_SET_UP' });
    expect(c['db-cluster']).toMatchObject({ status: 'fail', code: 'DEP.DB.NOT_SET_UP' });
  });
});
