/**
 * D-98 against real servers, never the real state folder or LaunchAgents:
 *
 *   precheck + verify   on Homebrew's Postgres 17 (this Mac: /opt/homebrew/opt/postgresql@17/bin), a throwaway source
 *                       database control_center_move_<CC_TEST_DB_SUFFIX>: what a restore would refuse is found, a
 *                       pg_dump/pg_restore copy verifies, a changed row does not. Runs in `npm test` when Postgres is up.
 *   the whole move      CC_PG_E2E=1 (heavy: ~1-2 min): a bundled cluster under a scratch CC_STATE_DIR (CC_PG_E2E_DIR,
 *                       default a temp folder), pg_ctl instead of launchd (CC_PG_NO_AGENT=1), a socket folder with a
 *                       space; the sample database (sample-data/) loaded into Homebrew as the 1.x source, the refused
 *                       precheck, then the move: dump → restore → verify (the printed table) → migrator `match` →
 *                       switch; a base backup of the bundled cluster restored into a copy that starts; stop.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBackup, restoreBaseBackup } from '../../../scripts/ops/lib/backup.mjs';
import { compareSnapshots, exclusionPairsSql, formatVerification, moveToBundled, orphanRowsSql, precheckSource, realMoveDeps, snapshot } from '../../../scripts/ops/lib/migrate-cluster.mjs';
import { bundledDatabaseUrl, clusterPaths, installedEngine, pgPing, readPostmasterPid, startCluster, stopCluster, withClient } from '../../../scripts/ops/lib/pg.mjs';
import { runMigrations } from '../../../src/db/migrate';
import { pingSocket } from '../../../src/ops/pg-cluster';

type Q = (sql: string, params?: unknown[]) => Promise<any[]>;
const PG17 = '/opt/homebrew/opt/postgresql@17/bin';
const SUFFIX = process.env.CC_TEST_DB_SUFFIX ?? 'main';
const pgUp = (() => {
  try {
    execFileSync(`${PG17}/pg_isready`, ['-h', 'localhost'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const brew = (db: string) => `postgresql://localhost:5432/${db}`;
const psql = (db: string, sql: string) => execFileSync(`${PG17}/psql`, ['-h', 'localhost', '-d', db, '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
const recreate = (db: string) => {
  psql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  psql('postgres', `CREATE DATABASE ${db}`);
};

describe.skipIf(!pgUp)('precheck and verify on a real Postgres 17 (Homebrew, throwaway databases)', () => {
  const SRC = `control_center_move_${SUFFIX}`;
  const COPY = `control_center_move_${SUFFIX}_copy`;
  afterAll(() => {
    psql('postgres', `DROP DATABASE IF EXISTS ${SRC} WITH (FORCE)`);
    psql('postgres', `DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)`);
  }, 120_000);

  it('finds overlapping rows an exclusion constraint forbids and orphaned foreign keys; a clean source passes', async () => {
    recreate(SRC);
    psql(SRC, `CREATE EXTENSION btree_gist;
      CREATE TABLE owners(id int PRIMARY KEY);
      CREATE TABLE blocks(id serial PRIMARY KEY, owner_id int REFERENCES owners(id), starts_at timestamptz, ends_at timestamptz, counts boolean DEFAULT true,
        search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', 'x')) STORED,
        CONSTRAINT blocks_no_overlap EXCLUDE USING gist (owner_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (counts) DEFERRABLE INITIALLY IMMEDIATE);
      INSERT INTO owners VALUES (1), (2);
      INSERT INTO blocks(owner_id, starts_at, ends_at) VALUES (1, '2026-11-20 09:00Z', '2026-11-20 10:00Z'), (1, '2026-11-20 10:00Z', '2026-11-20 11:00Z'), (2, '2026-11-20 09:30Z', '2026-11-20 10:30Z');
      INSERT INTO blocks(owner_id, starts_at, ends_at, counts) VALUES (1, '2026-11-20 09:15Z', '2026-11-20 09:45Z', false);`);
    const clean = await withClient(brew(SRC), precheckSource);
    expect(clean).toMatchObject({ ok: true, problems: [], checked: { exclusions: 1, fks: 1 } });
    // what a replica-role load (the sample-data loader) lets in: a counted overlap, and a block whose owner is gone
    psql(SRC, `BEGIN; SET LOCAL session_replication_role = replica; SET CONSTRAINTS ALL DEFERRED;
      INSERT INTO blocks(owner_id, starts_at, ends_at) VALUES (1, '2026-11-20 09:30Z', '2026-11-20 09:40Z'), (9, '2026-11-21 09:00Z', '2026-11-21 10:00Z'); COMMIT;`);
    const dirty = await withClient(brew(SRC), precheckSource);
    expect(dirty.ok).toBe(false);
    expect(dirty.problems).toEqual([
      { kind: 'exclusion', constraint: 'blocks_no_overlap', table: 'blocks', count: 1 },
      { kind: 'fk', constraint: 'blocks_owner_id_fkey', table: 'blocks', count: 1 },
    ]);
  }, 120_000);

  it('a pg_dump → pg_restore copy verifies (counts, row digests without generated columns, sequences); one changed row does not', async () => {
    psql(SRC, 'BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM blocks WHERE owner_id = 9 OR (owner_id = 1 AND starts_at = \'2026-11-20 09:30Z\'); COMMIT;');
    recreate(COPY);
    const dump = join(mkdtempSync(join(tmpdir(), 'cc-move-dump-')), 'x.dump');
    execFileSync(`${PG17}/pg_dump`, ['-Fc', '--no-owner', '-f', dump, '-d', brew(SRC)]);
    execFileSync(`${PG17}/pg_restore`, ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '-d', brew(COPY), dump]);
    const [a, b] = [await withClient(brew(SRC), snapshot), await withClient(brew(COPY), snapshot)];
    const cmp = compareSnapshots(a, b);
    expect(cmp.ok).toBe(true);
    expect(a.tables['public.blocks']).toMatchObject({ n: 4, generated: ['search_tsv'] });
    expect(cmp.totals).toMatchObject({ tables: 2, rows: 6, sequences: 1, sequencesMatched: 1 });
    psql(COPY, "UPDATE blocks SET ends_at = ends_at + interval '1 minute' WHERE owner_id = 2");
    psql(COPY, "SELECT setval('blocks_id_seq', 99)");
    const bad = compareSnapshots(a, await withClient(brew(COPY), snapshot));
    expect(bad.ok).toBe(false);
    expect(bad.mismatches).toEqual(['table public.blocks: differs', 'sequence public.blocks_id_seq: 6 → 99']);
  }, 120_000);

  it('the SQL builders run as written (an exclusion self-join, an orphan count)', async () => {
    const rows = await withClient(brew(SRC), async (q: Q) => [
      await q(exclusionPairsSql({ schema: 'public', table: 'blocks', exprs: ['owner_id', "tstzrange(starts_at, ends_at, '[)')"], ops: ['pg_catalog.=', 'pg_catalog.&&'], pred: 'counts' })),
      await q(orphanRowsSql({ schema: 'public', table: 'blocks', ref_schema: 'public', ref_table: 'owners', cols: ['owner_id'], ref_cols: ['id'], match: 's' })),
    ]);
    expect(rows).toEqual([[{ pairs: 0 }], [{ n: 0 }]]);
  }, 60_000);
});

const E2E = pgUp && process.env.CC_PG_E2E === '1';

describe.skipIf(!E2E)('the bundled cluster end to end (CC_PG_E2E=1)', () => {
  const SAMPLE = `control_center_sample_${SUFFIX}`;
  const base = process.env.CC_PG_E2E_DIR ? resolve(process.env.CC_PG_E2E_DIR) : mkdtempSync(join(tmpdir(), 'cc-pg-e2e-'));
  const sock = mkdtempSync(join(tmpdir(), 'cc pg ')); // a space, like "Application Support"
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CC_STATE_DIR: join(base, 'state'),
    CC_LOG_DIR: join(base, 'logs'),
    CC_LAUNCH_AGENTS_DIR: join(base, 'agents'),
    CC_PG_SOCKET_DIR: sock,
    CC_PG_NO_AGENT: '1',
  };
  delete env.DATABASE_URL;
  const say = (m: string) => console.log(`[e2e] ${m}`);
  const t0 = Date.now();

  beforeAll(() => {
    rmSync(join(base, 'state'), { recursive: true, force: true });
    mkdirSync(join(base, 'state'), { recursive: true });
    // the 1.x env file: Homebrew, the sample database
    writeFileSync(join(base, 'state', 'env'), `DATABASE_URL=${brew(SAMPLE)}\nPORT=4327\nCC_DATA=db\n`, { mode: 0o600 });
  });
  afterAll(() => {
    const e = installedEngine(env);
    if (e) stopCluster({ env, bin: e.bin });
    psql('postgres', `DROP DATABASE IF EXISTS ${SAMPLE} WITH (FORCE)`);
    rmSync(sock, { recursive: true, force: true });
    if (!process.env.CC_PG_E2E_DIR) rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('the sample database as the 1.x source (Homebrew), migrated and loaded', async () => {
    recreate(SAMPLE);
    const s = await runMigrations({ url: brew(SAMPLE), log: () => {} });
    expect(s.state).toBe('match');
    const r = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['scripts/sample-data/load.ts', '--db', SAMPLE], { encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(Number(psql(SAMPLE, 'SELECT count(*) FROM source_items'))).toBeGreaterThan(100);
    say(`source loaded in ${Math.round((Date.now() - t0) / 1000)} s`);
  }, 300_000);

  it('a source a restore would refuse is refused: nothing switched, the env file still on Homebrew', async () => {
    const pre = await withClient(brew(SAMPLE), precheckSource);
    if (pre.ok) return say('the sample database passes the precheck (the sample-data overlap fix has landed)');
    say(`precheck found ${pre.problems.length} constraint(s): ${pre.problems.map((p: { constraint: string; count: number }) => `${p.constraint} ×${p.count}`).join(', ')}`);
    const before = readFileSync(join(base, 'state', 'env'), 'utf8');
    const r = await moveToBundled(await realMoveDeps({ env, say, migrator: { cmd: 'false', args: [], cwd: process.cwd() } }));
    expect(r).toMatchObject({ ok: false, failedAt: 'precheck' });
    expect(readFileSync(join(base, 'state', 'env'), 'utf8')).toBe(before);
    // fix the throwaway source the way an owner would: drop the later row of each overlap, then the rows left orphaned
    for (let round = 0; round < 6; round++) {
      const p = await withClient(brew(SAMPLE), precheckSource);
      if (p.ok) break;
      await withClient(brew(SAMPLE), async (q: Q) => {
        await q('BEGIN');
        await q('SET LOCAL session_replication_role = replica');
        for (const x of await q(`SELECT c.conname, n.nspname AS schema, t.relname AS table, c.conindid::int AS index_oid, (SELECT array_agg(format('%s.%s', quote_ident(opn.nspname), o.oprname) ORDER BY u.ord) FROM unnest(c.conexclop) WITH ORDINALITY u(op, ord) JOIN pg_operator o ON o.oid = u.op JOIN pg_namespace opn ON opn.oid = o.oprnamespace) AS ops, pg_get_expr(i.indpred, i.indrelid) AS pred FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_index i ON i.indexrelid = c.conindid WHERE c.contype = 'x'`)) {
          const exprs: string[] = [];
          for (let k = 1; k <= x.ops.length; k++) exprs.push((await q('SELECT pg_get_indexdef($1::oid, $2::int, true) AS e', [x.index_oid, k]))[0].e);
          const pairs = exclusionPairsSql({ ...x, exprs }).replace('SELECT count(*)::int AS pairs FROM r a JOIN r b ON a.rid < b.rid', 'SELECT b.rid FROM r a JOIN r b ON a.rid < b.rid');
          await q(`DELETE FROM ONLY "${x.schema}"."${x.table}" WHERE ctid IN (${pairs})`);
        }
        for (const f of await q(`SELECT c.conname, cn.nspname AS schema, ct.relname AS table, pn.nspname AS ref_schema, pt.relname AS ref_table, c.confmatchtype AS match, (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols, (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_cols FROM pg_constraint c JOIN pg_class ct ON ct.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = ct.relnamespace JOIN pg_class pt ON pt.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = pt.relnamespace WHERE c.contype = 'f'`)) {
          await q(orphanRowsSql(f).replace('SELECT count(*)::int AS n FROM', 'DELETE FROM'));
        }
        await q('COMMIT');
      });
    }
    expect((await withClient(brew(SAMPLE), precheckSource)).ok).toBe(true);
  }, 300_000);

  it('moves it: dump → restore into the bundled cluster → verify every table → migrator match → switch', async () => {
    const t = Date.now();
    const deps = await realMoveDeps({ env, say, migrator: { cmd: 'unused', args: [], cwd: process.cwd() } });
    deps.migrateCheck = async (url: string) => {
      const s = await runMigrations({ url, log: (l) => say(l) });
      return { ok: true, state: s.state };
    };
    const r = (await moveToBundled(deps)) as any;
    expect(r.ok, r.message).toBe(true);
    console.log(`\n${formatVerification(r.verification)}\n`);
    say(`move timings (ms): ${JSON.stringify(r.timingsMs)} · total ${Date.now() - t} ms`);
    expect(r.verification.totals.migrationsMatch).toBe(true);
    expect(r.verification.rows.filter((x: { digest: string }) => x.digest !== 'match')).toEqual([]);
    const excluded = r.verification.rows.filter((x: { excluded: string[] }) => x.excluded.length).map((x: { table: string; excluded: string[] }) => `${x.table}:${x.excluded.join(',')}`);
    expect(excluded.sort()).toEqual(['public.scan_ledger_entries:covered', 'public.source_items:search_tsv', 'public.work_items:search_tsv']);
    // the switch: the socket URL, CC_DB_ENGINE=bundled, the old line kept as a comment, the 14-day marker
    const text = readFileSync(join(base, 'state', 'env'), 'utf8');
    expect(text).toContain(`DATABASE_URL=${bundledDatabaseUrl(env)}`);
    expect(text).toContain('CC_DB_ENGINE=bundled');
    expect(existsSync(join(base, 'state', 'pg', 'moved-from-homebrew.json'))).toBe(true);
    // the Homebrew source is untouched
    expect(Number(psql(SAMPLE, 'SELECT count(*) FROM source_items'))).toBe(r.verification.rows.find((x: { table: string }) => x.table === 'public.source_items').source);
  }, 600_000);

  it('the cluster: a socket only, both pings agree, a second postmaster on the same folder is refused', async () => {
    const p = clusterPaths(env);
    expect(await pgPing(p.socket)).toBe('ready');
    expect(await pingSocket(p.socket)).toBe('ready');
    const pm = readPostmasterPid(p.data);
    expect(pm).toMatchObject({ alive: true, status: 'ready', socketDir: sock });
    const conf = await withClient(bundledDatabaseUrl(env), (q: Q) => q("SELECT current_setting('listen_addresses') AS l, current_setting('max_connections') AS m, datcollate AS c, pg_encoding_to_char(encoding) AS e FROM pg_database WHERE datname = current_database()"));
    expect(conf).toEqual([{ l: '', m: '30', c: 'C', e: 'UTF8' }]);
    expect(await startCluster({ env, bin: installedEngine(env)!.bin })).toMatchObject({ ok: true, already: true });
    const second = spawnSync(join(installedEngine(env)!.bin, 'postgres'), ['-D', p.data], { encoding: 'utf8', timeout: 20_000 });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/lock file "postmaster\.pid" already exists/);
  }, 120_000);

  it('a base backup of the bundled cluster restores into a copy that starts and holds the same rows', async () => {
    const url = bundledDatabaseUrl(env);
    const dir = join(base, 'state', 'backups');
    const b = await runBackup({ db: 'command_center', url, dir, copyDir: null, env });
    expect(b.file).toMatch(/command_center-\d{8}-\d{6}\.base\.tgz$/);
    say(`base backup: ${Math.round(b.bytes / 1024)} KB`);
    const want = await withClient(url, (q: Q) => q('SELECT count(*)::int AS n FROM source_items'));
    const r = (await restoreBaseBackup({ file: b.file, env })) as { url: string; stop: string };
    try {
      expect(await withClient(r.url, (q: Q) => q('SELECT count(*)::int AS n FROM source_items'))).toEqual(want);
    } finally {
      execFileSync('/bin/sh', ['-c', r.stop]);
    }
  }, 300_000);

  it('stops cleanly', () => {
    const e = installedEngine(env)!;
    expect(stopCluster({ env, bin: e.bin })).toMatchObject({ ok: true, state: 'stopped' });
    expect(readPostmasterPid(clusterPaths(env).data)).toBeNull();
    say(`end to end: ${Math.round((Date.now() - t0) / 1000)} s`);
  }, 120_000);
});
