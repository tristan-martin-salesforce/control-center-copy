/**
 * D-101 against a real Postgres: the database rename (control_center -> command_center, here two throwaway databases
 * named with CC_TEST_DB_SUFFIX) and a backup made under the old name restoring under the new one.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listBackups, runBackup, runRestore, stamp } from '../../../scripts/ops/lib/backup.mjs';
import { renameDatabase } from '../../../scripts/ops/lib/migrate-state-real.mjs';
import { dropDb, freshDb, pgAvailable, pgTool, PG_CONN, testDbSuffix } from '../../support/pg';
import { execFileSync } from 'node:child_process';

const OLD = `control_center_ren_${testDbSuffix}_old`;
const NEW = `control_center_ren_${testDbSuffix}_new`;
const RESTORED = `control_center_ren_${testDbSuffix}_back`;
const psql = (db: string, sql: string) => execFileSync(pgTool('psql'), [...PG_CONN, '-d', db, '-X', '-Atc', sql]).toString().trim();
const exists = (db: string) => psql('postgres', `select count(*) from pg_database where datname='${db}'`) === '1';

describe.skipIf(!pgAvailable)('the database rename', () => {
  let url: string;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ren-'));
    await Promise.all([dropDb(NEW), dropDb(RESTORED)]);
    url = await freshDb(OLD);
  });
  afterAll(async () => {
    await Promise.all([dropDb(OLD), dropDb(NEW), dropDb(RESTORED)]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('renames through the postgres database, with the data and while a session is still connected', async () => {
    psql(OLD, "create table t(id int primary key, v text); insert into t select g, 'row-' || g from generate_series(1, 25) g");
    // a lingering session on the old database (the app's pool) must not stop the rename
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    c.on('error', () => undefined);
    expect(await renameDatabase(url, OLD, NEW)).toBe('renamed');
    expect(exists(OLD)).toBe(false);
    expect(psql(NEW, "select count(*) || ':' || sum(id) from t")).toBe('25:325');
    // again: the new name is there and the old is not
    expect(await renameDatabase(url, OLD, NEW)).toBe('already');
    await c.end().catch(() => undefined);
  });

  it('refuses to touch either name when both exist, and says nothing is there when neither does', async () => {
    await freshDb(OLD);
    expect(await renameDatabase(url, OLD, NEW)).toBe('both');
    expect(exists(OLD) && exists(NEW)).toBe(true);
    await dropDb(OLD);
    await dropDb(NEW);
    expect(await renameDatabase(url, OLD, NEW)).toBe('absent');
  });

  it('a backup made under the old name is found by the default name and restores into a new database', async () => {
    await freshDb(OLD);
    psql(OLD, "create table t(id int primary key, v text); insert into t select g, 'row-' || g from generate_series(1, 10) g");
    mkdirSync(dir, { recursive: true });
    const made = await runBackup({ db: OLD, url, dir, copyDir: null, keep: 7 });
    // what a 1.x install left: the same dump, named control_center-<stamp>.dump
    const legacy = join(dir, `control_center-${stamp(new Date(2026, 10, 1, 3, 0, 0))}.dump`);
    renameSync(made.file, legacy);
    expect(listBackups(dir).map((b: { file: string }) => b.file)).toEqual([legacy]);
    psql(OLD, 'delete from t');
    await runRestore({ file: legacy, into: RESTORED });
    expect(psql(RESTORED, "select count(*) || ':' || sum(id) from t")).toBe('10:55');
  });
});
