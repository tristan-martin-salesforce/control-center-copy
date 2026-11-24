import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDbName, backupCopyDir, backupDue, backupName, backupsToPrune as opsBackupsToPrune, baseBackupName, cloudSyncedReason, configuredDbName, copyBackup, dropDb, listBackups, PG17_BIN, pruneBackups, runBackup, runRestore } from '../../../scripts/ops/lib/backup.mjs';
import { backupsToPrune as policyBackupsToPrune } from '../../../src/db/retention/policy';
import { backupHandler, type BackupLib } from '../../../src/jobs/handlers/backup';

let dir: string;
beforeAll(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-backup-'))));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('retention (pure)', () => {
  it('keeps the newest 7, then the newest of each of the 4 weeks before, for the given db only', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-prune-'));
    // nightly from Oct 1 to Nov 10, plus a base backup (D-98) on Nov 10 itself
    for (let day = 0; day < 41; day++) writeFileSync(join(d, backupName('command_center', new Date(2026, 9, 1 + day, 3, 0, 0))), 'x');
    writeFileSync(join(d, baseBackupName('command_center', new Date(2026, 10, 10, 4, 0, 0))), 'x');
    writeFileSync(join(d, backupName('other_db', new Date(2026, 10, 1))), 'x');
    pruneBackups(d, 'command_center', 7);
    const kept = listBackups(d, 'command_center').map((b) => b.name.replace('command_center-', ''));
    // the newest 7 (Nov 10 base, Nov 10 … Nov 5), then one per Monday week: Nov 4 (week of Nov 2), Nov 1 (Oct 26),
    // Oct 25 (Oct 19), Oct 18 (Oct 12)
    expect(kept).toEqual(['20261018-030000.dump', '20261025-030000.dump', '20261101-030000.dump', '20261104-030000.dump', '20261105-030000.dump', '20261106-030000.dump', '20261107-030000.dump', '20261108-030000.dump', '20261109-030000.dump', '20261110-030000.dump', '20261110-040000.base.tgz']);
    expect(listBackups(d, 'other_db')).toHaveLength(1);
    rmSync(d, { recursive: true, force: true });
  });
  it('agrees with the nightly data.retention rule (src/db/retention/policy.ts backupsToPrune)', () => {
    const names = Array.from({ length: 60 }, (_, i) => backupName('command_center', new Date(2026, 8, 1 + i, 2, 30, 0)));
    expect(opsBackupsToPrune(names)).toEqual(policyBackupsToPrune(names));
  });
  it('knows when a backup is due', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-due-'));
    expect(backupDue(d)).toBe(true);
    const f = join(d, backupName('command_center'));
    writeFileSync(f, 'x');
    expect(backupDue(d)).toBe(false);
    const old = new Date(Date.now() - 30 * 3600_000);
    utimesSync(f, old, old);
    expect(backupDue(d)).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
  it('rejects unsafe database names', () => {
    expect(() => assertDbName('x; drop database postgres')).toThrow();
    expect(assertDbName('control_center_ops')).toBe('control_center_ops');
  });
});

const pgUp = (() => {
  try {
    execFileSync(`${PG17_BIN}/pg_isready`, ['-h', 'localhost'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!pgUp)('backup / restore round trip on a scratch database (control_center_ops)', () => {
  // Unique per run so a leftover or concurrent run can't collide.
  const SCRATCH = `control_center_ops_${process.pid}`;
  const RESTORED = `control_center_ops_${process.pid}_restore`;
  const q = (db: string, sql: string) => execFileSync(`${PG17_BIN}/psql`, ['-h', 'localhost', '-d', db, '-X', '-Atc', sql]).toString().trim();

  afterAll(async () => {
    await dropDb(SCRATCH);
    await dropDb(RESTORED);
  });

  it('dumps, prunes (7 daily + 4 weekly), restores into a fresh db with identical data, and refuses to clobber', async () => {
    await dropDb(SCRATCH);
    await dropDb(RESTORED);
    execFileSync(`${PG17_BIN}/createdb`, ['-h', 'localhost', SCRATCH]);
    q(SCRATCH, "CREATE TABLE t(id int primary key, v text); INSERT INTO t SELECT g, 'row-' || g FROM generate_series(1, 25) g");

    // Pre-seed 8 old backups (Oct 1-8) so pruning has work to do: the newest 7 stay (today's, Oct 8-3), then Oct 2
    // as its week's newest; Oct 1 (the same week) goes.
    for (let day = 1; day <= 8; day++) writeFileSync(join(dir, backupName(SCRATCH, new Date(2026, 9, day, 3, 0, 0))), 'old');
    const r = await runBackup({ db: SCRATCH, dir, keep: 7, copyDir: null }); // never the real copy folder
    expect(existsSync(r.file)).toBe(true);
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
    expect(listBackups(dir, SCRATCH)).toHaveLength(8);
    expect(r.pruned).toEqual([backupName(SCRATCH, new Date(2026, 9, 1, 3, 0, 0))]);

    q(SCRATCH, 'DELETE FROM t'); // simulate data loss after the backup
    await runRestore({ file: r.file, into: RESTORED });
    expect(q(RESTORED, 'SELECT count(*) || \':\' || sum(id) FROM t')).toBe('25:325');
    expect(q(SCRATCH, 'SELECT count(*) FROM t')).toBe('0');

    await expect(runRestore({ file: r.file, into: RESTORED })).rejects.toThrow(/already exists/);
    await runRestore({ file: r.file, into: RESTORED, replace: true });
    expect(q(RESTORED, 'SELECT count(*) FROM t')).toBe('25');
  });

  it('a corrupt dump fails cleanly and leaves no half-restored database', async () => {
    const bad = join(dir, 'bad.dump');
    writeFileSync(bad, 'not a dump');
    await expect(runRestore({ file: bad, into: RESTORED, replace: true })).rejects.toThrow(/pg_restore failed/);
    expect(q('postgres', `SELECT count(*) FROM pg_database WHERE datname='${RESTORED}'`)).toBe('0');
  });
});

describe('copy folder (lane E, E2)', () => {
  it('copies a finished backup (mode 600), keeps the newest 7 there, and never throws', () => {
    const src = mkdtempSync(join(tmpdir(), 'cc-copy-src-'));
    const dst = join(mkdtempSync(join(tmpdir(), 'cc-copy-dst-')), 'nested');
    for (let day = 1; day <= 8; day++) {
      const f = join(src, backupName('command_center', new Date(2026, 10, day, 2, 30, 0)));
      writeFileSync(f, `dump ${day}`);
      const r = copyBackup(f, dst, { db: 'command_center', keep: 7 });
      expect(r.file && existsSync(r.file)).toBe(true);
      expect(statSync(r.file!).mode & 0o777).toBe(0o600);
    }
    expect(listBackups(dst, 'command_center')).toHaveLength(7);
    // a disk that isn't there: an error code, no throw
    expect(copyBackup(join(src, backupName('command_center', new Date(2026, 10, 1, 2, 30, 0))), '/dev/null/not-a-dir')).toMatchObject({ error: expect.any(String) });
    rmSync(src, { recursive: true, force: true });
  });

  it('refuses a cloud-synced folder: it would take the data off this Mac', () => {
    const home = '/Users/someone';
    expect(cloudSyncedReason(`${home}/Library/Mobile Documents/com~apple~CloudDocs/backups`, home)).toBe('iCloud Drive');
    expect(cloudSyncedReason(`${home}/Library/CloudStorage/OneDrive-Example/cc`, home)).toMatch(/cloud-synced/);
    expect(cloudSyncedReason(`${home}/OneDrive - Example/cc`, home)).toBe('OneDrive');
    expect(cloudSyncedReason(`${home}/Dropbox/cc`, home)).toBe('Dropbox');
    expect(cloudSyncedReason('/Volumes/Backup/command-center', home)).toBeNull();
    expect(cloudSyncedReason(`${home}/Backups/command-center`, home)).toBeNull();
  });

  it('reads CC_BACKUP_COPY_DIR from the environment, else the env file, and the database from DATABASE_URL', () => {
    const state = mkdtempSync(join(tmpdir(), 'cc-copy-env-'));
    expect(backupCopyDir({ CC_STATE_DIR: state, HOME: '/Users/someone' })).toEqual({ dir: null, refused: null });
    writeFileSync(join(state, 'env'), 'CC_BACKUP_COPY_DIR=~/Backups/cc\nDATABASE_URL=postgres://localhost:5432/control_center_example\n');
    expect(backupCopyDir({ CC_STATE_DIR: state, HOME: '/Users/someone' })).toEqual({ dir: '/Users/someone/Backups/cc', refused: null });
    expect(backupCopyDir({ CC_STATE_DIR: state, HOME: '/Users/someone', CC_BACKUP_COPY_DIR: '/Users/someone/Library/Mobile Documents/x' }).refused).toMatch(/iCloud Drive/);
    expect(configuredDbName({ CC_STATE_DIR: state })).toBe('control_center_example');
    expect(configuredDbName({ CC_STATE_DIR: state, DATABASE_URL: 'postgres://localhost:5432/command_center' })).toBe('command_center');
    rmSync(state, { recursive: true, force: true });
  });
});

describe('the nightly backup job (lane E)', () => {
  const lib = (lastAgeH: number | null, calls: string[]): BackupLib => ({
    defaultBackupDir: () => '/tmp/none',
    backupDue: (_d, _db, maxAgeMs = 24 * 3600_000) => lastAgeH === null || lastAgeH * 3600_000 > maxAgeMs,
    runBackup: async () => {
      calls.push('backup');
      return { file: '/x/command_center-20261114-023000.dump', bytes: 10, pruned: [], copy: { error: 'ENOENT' } };
    },
  });
  const ctx = { clock: () => new Date('2026-11-14T09:30:00Z'), log: () => {} } as never;

  it('runs when last night\'s backup is 23 h 54 min old (it used to skip, so backups ran every other night)', async () => {
    const calls: string[] = [];
    const r = await backupHandler({ lib: async () => lib(23.9, calls), dbName: 'command_center' })(ctx);
    expect(calls).toEqual(['backup']);
    expect(r).toMatchObject({ file: 'command_center-20261114-023000.dump', copy: { error: 'ENOENT' } });
  });

  it('skips when a backup is a few hours old (npm run update made one)', async () => {
    const calls: string[] = [];
    expect(await backupHandler({ lib: async () => lib(3, calls), dbName: 'command_center' })(ctx)).toMatchObject({ skipped: 'not_due' });
    expect(calls).toEqual([]);
  });
});
