/**
 * D-98: moving a 1.x Homebrew database into the bundled cluster, over fakes: the order of §6, and that every failure
 * before the switch leaves the env file on Homebrew. The real thing runs in tests/db/ops/pg-cluster.e2e.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareSnapshots, describeProblems, exclusionPairsSql, formatVerification, moveToBundled, orphanRowsSql, precheckSource, snapshot, tableDigestSql } from '../../scripts/ops/lib/migrate-cluster.mjs';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-move-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SRC = 'postgresql://localhost:5432/command_center';
const DST = 'postgresql:///command_center?host=%2Fx%2Frun&user=me';
const snap = (o: { n?: number; digest?: string; seq?: string; mig?: string[] } = {}) => ({
  tables: { 'public.activity_entries': { n: o.n ?? 3, digest: o.digest ?? 'abc', generated: [] }, 'public.source_items': { n: 2, digest: 'def', generated: ['search_tsv'] } },
  sequences: { 'public.x_seq': o.seq ?? '7' },
  migrations: o.mig ?? ['1:h1:100', '2:h2:200'],
});

function fakes(o: { tools?: string; prepare?: boolean; problems?: unknown[]; dump?: number; restore?: number; target?: ReturnType<typeof snap>; migrate?: string; switchThrows?: boolean } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  let switched = false;
  const deps = {
    say: (m: string) => void lines.push(m),
    sourceUrl: SRC,
    targetUrl: DST,
    tools: { bin: '/brew/bin' },
    workDir: dir,
    markerFile: join(dir, 'moved.json'),
    now: () => new Date('2026-11-20T10:00:00Z'),
    run: (cmd: string, args: string[]) => {
      const tool = cmd.split('/').pop()!;
      calls.push(tool === 'pg_restore' && args[0] === '--version' ? 'version' : tool);
      if (args[0] === '--version') return { code: 0, stdout: o.tools ?? 'pg_restore (PostgreSQL) 17.12', stderr: '' };
      if (tool === 'pg_dump') {
        writeFileSync(args[args.indexOf('-f') + 1]!, 'dump'); // the real pg_dump writes the file it names
        return { code: o.dump ?? 0, stdout: '', stderr: o.dump ? 'pg_dump: error: connection refused' : '' };
      }
      return { code: o.restore ?? 0, stdout: '', stderr: o.restore ? 'pg_restore: error: could not create constraint "activity_entries_no_overlap_excl"' : '' };
    },
    query: async (url: string, fn: unknown) => {
      const side = url === SRC ? 'src' : 'dst';
      // the orchestration hands precheckSource / snapshot themselves: answer for them; run anything else on a fake q
      if (fn === precheckSource) return (calls.push('precheck'), { ok: !(o.problems ?? []).length, problems: o.problems ?? [], checked: { exclusions: 2, fks: 404 } });
      if (fn === snapshot) return (calls.push(`snapshot:${side}`), side === 'src' ? snap() : (o.target ?? snap()));
      return (fn as (q: (sql: string) => Promise<unknown[]>) => Promise<unknown>)(async (sql: string) => {
        if (/^(CREATE|DROP) DATABASE/.test(sql)) calls.push(sql.split(' ')[0]!.toLowerCase());
        return [];
      });
    },
    prepare: async () => (calls.push('prepare'), o.prepare === false ? { ok: false, message: 'initdb failed' } : { ok: true, message: 'created the database folder' }),
    migrateCheck: async () => (calls.push('migrate'), { ok: o.migrate !== 'failed', state: o.migrate ?? 'match' }),
    switchEnv: () => {
      calls.push('switch');
      if (o.switchThrows) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      switched = true;
    },
    abandon: async () => void calls.push('abandon'),
  };
  return { deps, calls, lines, switched: () => switched };
}

describe('moveToBundled', () => {
  it('cluster → precheck → dump → createdb → restore → verify → migrator → switch, then the marker', async () => {
    const f = fakes();
    const r = await moveToBundled(f.deps);
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual(['version', 'prepare', 'precheck', 'pg_dump', 'drop', 'create', 'pg_restore', 'snapshot:src', 'snapshot:dst', 'migrate', 'switch']);
    expect(f.switched()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'moved.json'), 'utf8'))).toMatchObject({ movedAt: '2026-11-20T10:00:00.000Z', database: 'command_center', keepDays: 14, tables: 2, rows: 5 });
    expect(f.lines.join('\n')).toMatch(/public\.activity_entries\s+3\s+3\s+match/);
    expect(f.lines.join('\n')).toMatch(/2 tables, 5 rows · 1\/1 sequences match · drizzle migrations identical \(2\)/);
  });

  it('a precheck hit stops before anything is dumped: the constraint and the count, nothing switched', async () => {
    const f = fakes({ problems: [{ kind: 'exclusion', constraint: 'activity_entries_no_overlap_excl', table: 'activity_entries', count: 14 }, { kind: 'fk', constraint: 'x_fk', table: 'x', count: 2 }] });
    const r = await moveToBundled(f.deps);
    expect(r).toMatchObject({ ok: false, failedAt: 'precheck' });
    expect(f.calls).toEqual(['version', 'prepare', 'precheck', 'abandon']);
    expect(f.lines.join('\n')).toMatch(/activity_entries: 14 overlapping row pair\(s\) that activity_entries_no_overlap_excl forbids/);
    expect(f.lines.join('\n')).toMatch(/Nothing switched: your data stays in Homebrew Postgres, untouched/);
    expect(existsSync(join(dir, 'moved.json'))).toBe(false);
  });

  for (const [name, o, step] of [
    ['no PG17 client tools', { tools: 'pg_restore (PostgreSQL) 16.4' }, 'tools'],
    ['the cluster cannot start', { prepare: false }, 'cluster'],
    ['pg_dump fails', { dump: 1 }, 'dump'],
    ['pg_restore fails', { restore: 1 }, 'restore'],
    ['a table differs', { target: snap({ digest: 'zzz' }) }, 'verify'],
    ['a sequence differs', { target: snap({ seq: '6' }) }, 'verify'],
    ['the migrations differ', { target: snap({ mig: ['1:h1:100'] }) }, 'verify'],
    ['the migrator does not report match', { migrate: 'ahead' }, 'migrations'],
    ['the env file cannot be written', { switchThrows: true }, 'switch'],
  ] as const) {
    it(`${name}: stops at ${step}, nothing switched, the restored copy dropped`, async () => {
      const f = fakes(o as never);
      const r = await moveToBundled(f.deps);
      expect(r).toMatchObject({ ok: false, failedAt: step });
      expect(f.switched()).toBe(false);
      expect(existsSync(join(dir, 'moved.json'))).toBe(false);
      expect(f.calls.at(-1)).toBe('abandon');
      if (['restore', 'verify', 'migrations', 'switch'].includes(step)) expect(f.calls.filter((c) => c === 'drop').length).toBeGreaterThanOrEqual(2); // before the restore, and after the failure
    });
  }
});

describe('the precheck and verify SQL (built from the catalog, nothing hard-coded)', () => {
  it('an exclusion constraint becomes a self-join with its own expressions, operators and predicate', () => {
    const sql = exclusionPairsSql({ schema: 'public', table: 'activity_entries', exprs: ['owner_user_id', "tstzrange(starts_at, ends_at, '[)'::text)"], ops: ['pg_catalog.=', 'pg_catalog.&&'], pred: "operation = 'create'" });
    expect(sql).toBe(`WITH r AS (SELECT ctid AS rid, owner_user_id AS k1, tstzrange(starts_at, ends_at, '[)'::text) AS k2 FROM ONLY "public"."activity_entries" WHERE (operation = 'create')) SELECT count(*)::int AS pairs FROM r a JOIN r b ON a.rid < b.rid AND a.k1 OPERATOR(pg_catalog.=) b.k1 AND a.k2 OPERATOR(pg_catalog.&&) b.k2`);
  });

  it('a foreign key: MATCH SIMPLE skips rows with a NULL column, MATCH FULL refuses half-set keys', () => {
    expect(orphanRowsSql({ schema: 'public', table: 'c', ref_schema: 'public', ref_table: 'p', cols: ['a', 'b'], ref_cols: ['x', 'y'], match: 's' })).toBe('SELECT count(*)::int AS n FROM ONLY "public"."c" c WHERE c.a IS NOT NULL AND c.b IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ONLY "public"."p" p WHERE p.x = c.a AND p.y = c.b)');
    expect(orphanRowsSql({ schema: 'public', table: 'c', ref_schema: 'public', ref_table: 'p', cols: '{a}', ref_cols: '{x}', match: 'f' })).toContain('(c.a IS NOT NULL) AND (NOT (c.a IS NOT NULL) OR NOT EXISTS');
  });

  it('a table digest leaves the generated columns out and sorts by row hash (collation-proof)', () => {
    const sql = tableDigestSql({ schema: 'public', table: 'source_items', generated: ['search_tsv'] });
    expect(sql).toContain("to_jsonb(t) - ARRAY['search_tsv']::text[]");
    expect(sql).toContain('ORDER BY h COLLATE "C"');
    expect(tableDigestSql({ schema: 'public', table: 't', generated: [] })).not.toContain('ARRAY');
  });

  it('compareSnapshots names every difference; formatVerification prints one line per table', () => {
    const a = snap();
    const b = { ...snap({ n: 2 }), tables: { ...snap({ n: 2 }).tables, 'public.extra': { n: 1, digest: 'q', generated: [] } } };
    const c = compareSnapshots(a, b);
    expect(c.ok).toBe(false);
    expect(c.mismatches).toEqual(['table public.activity_entries: count differs', 'table public.extra: only in target']);
    expect(formatVerification(compareSnapshots(a, a))).toMatch(/public\.source_items\s+2\s+2\s+match\s+\(without search_tsv\)/);
    expect(describeProblems([{ kind: 'fk', constraint: 'k', table: 't', count: 1 }])).toEqual(["t: 1 row(s) whose k parent is missing"]);
  });
});
