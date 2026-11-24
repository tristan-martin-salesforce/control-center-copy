// Moving a 1.x install from Homebrew Postgres 17 into the bundled cluster (D-98; 12-pglite-spike.md §6), run by
// `npm run update` and the installer right after their own backup, with the agents stopped:
//
//   1. the bundled cluster: engine copy, initdb once, com.commandcenter.db running (prepare)
//   2. precheck the SOURCE for what a restore would reject: every exclusion constraint (activity_entries and
//      time_blocks today) and every foreign key, checked with the constraint's own expressions and operators. A hit
//      stops here with the constraint and the count; nothing switches
//   3. pg_dump -Fc of the source (Homebrew's 17 client tools: the bundle ships the server only, and the source is
//      Homebrew's, so its tools are there by definition)
//   4. CREATE DATABASE command_center on the bundled cluster (a leftover from a failed move is dropped first: it was
//      never live, the env file still points at Homebrew), then pg_restore --no-owner --no-privileges
//      --single-transaction --exit-on-error over the socket
//   5. verify, both sides with TimeZone=UTC: per table count(*) and an md5 over each row's to_jsonb minus the
//      generated columns (search_tsv ×2, scan_ledger_entries.covered: recomputed, never compared), every sequence's
//      last_value, drizzle.__drizzle_migrations identical, and the migrator reports `match` on the restored copy
//   6. switch: the env file says CC_DB_ENGINE=bundled and its old DATABASE_URL becomes a comment; the marker
//      <state>/pg/moved-from-homebrew.json records when (doctor's 14-day reminder)
// Any failure before 6 leaves the env file on Homebrew (the update contract) and the Homebrew database untouched.
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pgMovedMarker, pgRoot } from './paths.mjs';
import { dbNameOf, PG_MAJOR, SAFE_DB, urlForDb } from './pg.mjs';

export const KEEP_HOMEBREW_DAYS = 14;

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const qualified = (schema, table) => `${ident(schema)}.${ident(table)}`;

// ---------------------------------------------------------------------------------------------------------------
// 2. the precheck
// ---------------------------------------------------------------------------------------------------------------

const EXCLUSIONS_SQL = `
SELECT c.conname, n.nspname AS schema, t.relname AS table, c.conindid::int AS index_oid,
       (SELECT array_agg(format('%s.%s', quote_ident(opn.nspname), o.oprname) ORDER BY u.ord)
          FROM unnest(c.conexclop) WITH ORDINALITY u(op, ord)
          JOIN pg_operator o ON o.oid = u.op JOIN pg_namespace opn ON opn.oid = o.oprnamespace) AS ops,
       pg_get_expr(i.indpred, i.indrelid) AS pred
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_index i ON i.indexrelid = c.conindid
 WHERE c.contype = 'x' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 2, 3, 1`;

const FKS_SQL = `
SELECT c.conname, cn.nspname AS schema, ct.relname AS table, pn.nspname AS ref_schema, pt.relname AS ref_table, c.confmatchtype AS match,
       (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
       (SELECT array_agg(quote_ident(a.attname) ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_cols
  FROM pg_constraint c
  JOIN pg_class ct ON ct.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = ct.relnamespace
  JOIN pg_class pt ON pt.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = pt.relnamespace
 WHERE c.contype = 'f' AND cn.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 2, 3, 1`;

const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean));

/** The self-join that finds row pairs an exclusion constraint would reject, built from the index's own expressions. */
export function exclusionPairsSql({ schema, table, exprs, ops, pred }) {
  const keys = exprs.map((e, i) => `${e} AS k${i + 1}`).join(', ');
  const on = ops.map((op, i) => `a.k${i + 1} OPERATOR(${op}) b.k${i + 1}`).join(' AND ');
  return `WITH r AS (SELECT ctid AS rid, ${keys} FROM ONLY ${qualified(schema, table)} WHERE ${pred ? `(${pred})` : 'true'}) SELECT count(*)::int AS pairs FROM r a JOIN r b ON a.rid < b.rid AND ${on}`;
}

/** Rows whose foreign key has no parent (MATCH SIMPLE: any NULL column skips the row; MATCH FULL: all or none). */
export function orphanRowsSql({ schema, table, ref_schema, ref_table, cols, ref_cols, match }) {
  const c = arr(cols);
  const r = arr(ref_cols);
  const join = c.map((col, i) => `p.${r[i]} = c.${col}`).join(' AND ');
  const allSet = c.map((col) => `c.${col} IS NOT NULL`).join(' AND ');
  const anySet = c.map((col) => `c.${col} IS NOT NULL`).join(' OR ');
  const missing = `NOT EXISTS (SELECT 1 FROM ONLY ${qualified(ref_schema, ref_table)} p WHERE ${join})`;
  const where = match === 'f' ? `(${anySet}) AND (NOT (${allSet}) OR ${missing})` : `${allSet} AND ${missing}`;
  return `SELECT count(*)::int AS n FROM ONLY ${qualified(schema, table)} c WHERE ${where}`;
}

/**
 * Everything in the source a restore would refuse. q(sql, params) → rows on the source database.
 * Returns { ok, problems: [{ kind: 'exclusion' | 'fk', constraint, table, count }], checked: { exclusions, fks } }.
 */
export async function precheckSource(q) {
  const problems = [];
  const excl = await q(EXCLUSIONS_SQL);
  for (const x of excl) {
    const ops = arr(x.ops);
    const exprs = [];
    for (let k = 1; k <= ops.length; k++) exprs.push((await q('SELECT pg_get_indexdef($1::oid, $2::int, true) AS e', [x.index_oid, k]))[0].e);
    const pairs = Number((await q(exclusionPairsSql({ schema: x.schema, table: x.table, exprs, ops, pred: x.pred })))[0].pairs);
    if (pairs) problems.push({ kind: 'exclusion', constraint: x.conname, table: x.table, count: pairs });
  }
  const fks = await q(FKS_SQL);
  for (const f of fks) {
    const n = Number((await q(orphanRowsSql(f)))[0].n);
    if (n) problems.push({ kind: 'fk', constraint: f.conname, table: f.table, count: n });
  }
  return { ok: problems.length === 0, problems, checked: { exclusions: excl.length, fks: fks.length } };
}

/** The words for a refused precheck (constraint names and counts only; never row contents). */
export function describeProblems(problems) {
  return problems.map((p) => (p.kind === 'exclusion' ? `${p.table}: ${p.count} overlapping row pair(s) that ${p.constraint} forbids` : `${p.table}: ${p.count} row(s) whose ${p.constraint} parent is missing`));
}

// ---------------------------------------------------------------------------------------------------------------
// 5. the verifier
// ---------------------------------------------------------------------------------------------------------------

const TABLES_SQL = `
SELECT n.nspname AS schema, c.relname AS table,
       coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attgenerated <> ''), '{}') AS generated
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
 GROUP BY 1, 2 ORDER BY 1, 2`;

/** One table's count and digest: md5 over the sorted md5s of each row's to_jsonb, generated columns removed. */
export function tableDigestSql({ schema, table, generated }) {
  const gen = arr(generated);
  const minus = gen.length ? ` - ARRAY[${gen.map((g) => `'${g.replace(/'/g, "''")}'`).join(', ')}]::text[]` : '';
  return `SELECT count(*)::bigint::text AS n, md5(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), '')) AS digest FROM (SELECT md5((to_jsonb(t)${minus})::text) AS h FROM ONLY ${qualified(schema, table)} t) x`;
}

/**
 * Everything the verify compares, from one side. q must run with TimeZone=UTC (pg.mjs withClient does:
 * STABLE_SESSION). Returns { tables: { "schema.table": { n, digest, generated } }, sequences, migrations }.
 */
export async function snapshot(q) {
  const tables = {};
  for (const t of await q(TABLES_SQL)) {
    const r = (await q(tableDigestSql(t)))[0];
    tables[`${t.schema}.${t.table}`] = { n: Number(r.n), digest: r.digest, generated: arr(t.generated) };
  }
  const sequences = Object.fromEntries((await q('SELECT schemaname, sequencename, last_value::text AS v FROM pg_sequences ORDER BY 1, 2')).map((s) => [`${s.schemaname}.${s.sequencename}`, s.v]));
  const hasDrizzle = (await q("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok"))[0].ok;
  const migrations = hasDrizzle ? (await q('SELECT id::text, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).map((m) => `${m.id}:${m.hash}:${m.created_at}`) : [];
  return { tables, sequences, migrations };
}

/** Source against target: the printed table and every difference. */
export function compareSnapshots(src, dst) {
  const mismatches = [];
  const rows = [];
  const names = [...new Set([...Object.keys(src.tables), ...Object.keys(dst.tables)])].sort();
  for (const name of names) {
    const a = src.tables[name];
    const b = dst.tables[name];
    const same = !!a && !!b && a.n === b.n && a.digest === b.digest;
    rows.push({ table: name, source: a?.n ?? null, target: b?.n ?? null, digest: same ? 'match' : !a ? 'only in target' : !b ? 'missing' : a.n !== b.n ? 'count differs' : 'differs', excluded: a?.generated ?? b?.generated ?? [] });
    if (!same) mismatches.push(`table ${name}: ${rows.at(-1).digest}`);
  }
  const seqNames = [...new Set([...Object.keys(src.sequences), ...Object.keys(dst.sequences)])].sort();
  const seqDiff = seqNames.filter((s) => src.sequences[s] !== dst.sequences[s]);
  for (const s of seqDiff) mismatches.push(`sequence ${s}: ${src.sequences[s] ?? 'missing'} → ${dst.sequences[s] ?? 'missing'}`);
  const migSame = src.migrations.length === dst.migrations.length && src.migrations.every((m, i) => m === dst.migrations[i]);
  if (!migSame) mismatches.push(`drizzle.__drizzle_migrations: ${src.migrations.length} rows → ${dst.migrations.length} rows, not identical`);
  return {
    ok: mismatches.length === 0,
    mismatches,
    rows,
    totals: { tables: names.length, rows: rows.reduce((s, r) => s + (r.source ?? 0), 0), sequences: seqNames.length, sequencesMatched: seqNames.length - seqDiff.length, migrations: src.migrations.length, migrationsMatch: migSame },
  };
}

/** The verification table, one line per table (counts and the digest verdict). */
export function formatVerification(cmp) {
  const w = Math.max(5, ...cmp.rows.map((r) => r.table.length));
  const lines = [`${'table'.padEnd(w)}  ${'source'.padStart(7)}  ${'target'.padStart(7)}  digest`];
  for (const r of cmp.rows) lines.push(`${r.table.padEnd(w)}  ${String(r.source ?? '-').padStart(7)}  ${String(r.target ?? '-').padStart(7)}  ${r.digest}${r.excluded.length ? `  (without ${r.excluded.join(', ')})` : ''}`);
  const t = cmp.totals;
  lines.push(`${t.tables} tables, ${t.rows} rows · ${t.sequencesMatched}/${t.sequences} sequences match · drizzle migrations ${t.migrationsMatch ? `identical (${t.migrations})` : 'DIFFER'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// the move
// ---------------------------------------------------------------------------------------------------------------

const WHY = {
  tools: 'Nothing switched: no Postgres 17 pg_dump / pg_restore to move the data with.',
  cluster: "Nothing switched: Command Center's own database could not start.",
  precheck: 'Nothing switched: your data stays in Homebrew Postgres, untouched.',
  dump: 'Nothing switched: your data stays in Homebrew Postgres, untouched.',
  restore: 'Nothing switched: your data stays in Homebrew Postgres, untouched.',
  verify: 'Nothing switched: the copy did not match, so your data stays in Homebrew Postgres, untouched.',
  migrations: 'Nothing switched: the copy is not at the same migration, so your data stays in Homebrew Postgres.',
  switch: 'Nothing switched: the env file could not be written; your data stays in Homebrew Postgres.',
};

/**
 * deps:
 *   say(msg)
 *   sourceUrl                          the Homebrew database (the env file's 1.x DATABASE_URL)
 *   targetUrl                          the bundled database's socket URL (pg.mjs bundledDatabaseUrl)
 *   tools: { bin }                     a Postgres 17 bin folder with pg_dump and pg_restore (Homebrew's)
 *   run(cmd, args, opts) → { code, stdout, stderr }      (pg.mjs runTool)
 *   query(url, fn)                     fn(q) on one connection, TimeZone=UTC (pg.mjs withClient)
 *   prepare() → { ok, message }        the bundled cluster running (db-agent.mjs realPrepare)
 *   migrateCheck(url) → { ok, state }  the migrator on the restored copy; must report `match`
 *   switchEnv()                        ensure-db.mjs switchEnvToBundled
 *   abandon()                          stop the bundled cluster after a failed move (no agent left behind)
 *   workDir                            where the move's dump goes (default <state>/pg/move)
 *   now() → Date
 * Returns { ok, failedAt?, message, problems?, verification?, timingsMs }.
 */
export async function moveToBundled(deps) {
  const say = deps.say;
  const t0 = Date.now();
  const timingsMs = {};
  const db = dbNameOf(deps.targetUrl);
  const lap = (k, t) => (timingsMs[k] = Date.now() - t);
  const fail = async (step, message, extra = {}) => {
    say(`move: ${message}`);
    say(WHY[step]);
    if (step !== 'tools' && step !== 'precheck') await dropTarget().catch(() => undefined);
    await deps.abandon?.();
    return { ok: false, failedAt: step, message, timingsMs, ...extra };
  };
  const dropTarget = () => deps.query(urlForDb(deps.targetUrl, 'postgres'), (q) => q(`DROP DATABASE IF EXISTS ${ident(db)} WITH (FORCE)`));
  if (!SAFE_DB.test(db)) return fail('tools', `unsafe database name ${JSON.stringify(db)}`);

  // 0. the client tools: same major as both servers
  const pgDump = join(deps.tools.bin, 'pg_dump');
  const pgRestore = join(deps.tools.bin, 'pg_restore');
  const v = deps.run(pgRestore, ['--version']);
  const major = Number(/(\d+)\.\d+/.exec(v.stdout)?.[1]);
  if (v.code !== 0 || major !== PG_MAJOR) return fail('tools', `pg_restore ${PG_MAJOR} not found in ${deps.tools.bin} (got ${v.stdout || 'nothing'})`);

  // 1. the bundled cluster
  let t = Date.now();
  const p = await deps.prepare();
  lap('cluster', t);
  if (!p.ok) return fail('cluster', p.message);
  say(`Command Center's database is running (${p.message ?? 'ok'})`);

  // 2. precheck the source
  t = Date.now();
  let pre;
  try {
    pre = await deps.query(deps.sourceUrl, precheckSource);
  } catch (e) {
    return fail('precheck', `could not read the Homebrew database (${e?.code ?? e?.message?.split('\n')[0]})`);
  }
  lap('precheck', t);
  if (!pre.ok) {
    for (const line of describeProblems(pre.problems)) say(`  ${line}`);
    return fail('precheck', `the Homebrew database holds rows a verified copy would refuse (${pre.problems.length} constraint(s)); report this, the data needs a fix first`, { problems: pre.problems });
  }
  say(`precheck: ${pre.checked.exclusions} exclusion constraints and ${pre.checked.fks} foreign keys hold`);

  // 3. dump
  t = Date.now();
  const work = deps.workDir ?? join(pgRoot(deps.env ?? process.env), 'move');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const file = join(work, `${db}-${stamp}.dump`);
  const d = deps.run(pgDump, ['-Fc', '--no-owner', '-f', file, '-d', deps.sourceUrl], { timeoutMs: 30 * 60_000 });
  lap('dump', t);
  if (d.code !== 0) return fail('dump', `pg_dump failed: ${(d.stderr || '').split('\n')[0]}`);
  say(`dumped the Homebrew database (${Math.round(statSync(file).size / 1024)} KB)`);

  // 4. restore into a fresh database
  t = Date.now();
  try {
    await dropTarget();
    await deps.query(urlForDb(deps.targetUrl, 'postgres'), (q) => q(`CREATE DATABASE ${ident(db)}`));
  } catch (e) {
    return fail('restore', `creating ${db} failed (${e?.code ?? e?.message?.split('\n')[0]})`);
  }
  const r = deps.run(pgRestore, ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '-d', deps.targetUrl, file], { timeoutMs: 30 * 60_000 });
  lap('restore', t);
  if (r.code !== 0) return fail('restore', `pg_restore failed: ${(r.stderr || '').split('\n').find((l) => /error/i.test(l)) ?? (r.stderr || '').split('\n')[0]}`);
  say('restored it into the bundled cluster (one transaction)');

  // 5. verify
  t = Date.now();
  let cmp;
  try {
    const [a, b] = [await deps.query(deps.sourceUrl, snapshot), await deps.query(deps.targetUrl, snapshot)];
    cmp = compareSnapshots(a, b);
  } catch (e) {
    return fail('verify', `the verify could not read both sides (${e?.code ?? e?.message?.split('\n')[0]})`);
  }
  lap('verify', t);
  say(`verify:\n${formatVerification(cmp)}`);
  if (!cmp.ok) return fail('verify', `${cmp.mismatches.length} difference(s): ${cmp.mismatches.slice(0, 5).join('; ')}`, { verification: cmp });
  t = Date.now();
  const m = await deps.migrateCheck(deps.targetUrl);
  lap('migrations', t);
  if (!m.ok || m.state !== 'match') return fail('migrations', `the migrator says ${m.state ?? 'it failed'} on the copy`, { verification: cmp });

  // 6. switch
  // the marker first: if the env file can't be written, the marker goes again and nothing switched
  const markerFile = deps.markerFile ?? pgMovedMarker(deps.env ?? process.env);
  try {
    const marker = { movedAt: (deps.now?.() ?? new Date()).toISOString(), from: 'homebrew-pg17', database: db, keepDays: KEEP_HOMEBREW_DAYS, tables: cmp.totals.tables, rows: cmp.totals.rows };
    writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    deps.switchEnv();
  } catch (e) {
    rmSync(markerFile, { force: true });
    return fail('switch', `${e?.code ?? e?.message}`);
  }
  rmSync(file, { force: true }); // the backup taken before the move is the copy to keep
  timingsMs.total = Date.now() - t0;
  say(`switched: Command Center now runs on its own database. Homebrew's ${db} is kept, untouched, for ${KEEP_HOMEBREW_DAYS} days (npm run doctor reminds you how to remove it).`);
  return { ok: true, message: 'moved', verification: cmp, timingsMs };
}

// ---------------------------------------------------------------------------------------------------------------
// the real wiring (update.mjs, release-wiring.mjs)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The migrator as a program on `url` (a release's dist/db/migrate.mjs, or tsx src/db/migrate.ts in a checkout):
 * exit 0 and "is up to date" is `match`; its warning is `ahead`; anything else failed. The output stays on screen.
 */
export function migratorCheck({ cmd, args, cwd, env = /** @type {Record<string, string | undefined>} */ (process.env), run }) {
  return async (url) => {
    const r = run(cmd, args, { timeoutMs: 10 * 60_000, env: { ...env, DATABASE_URL: url }, cwd });
    const out = `${r.stdout}\n${r.stderr}`;
    for (const line of out.split('\n').filter((l) => l.startsWith('[db:migrate]'))) console.log(line);
    if (r.code !== 0) return { ok: false, state: 'failed' };
    return { ok: true, state: /is up to date/.test(out) ? 'match' : /warning/.test(out) ? 'ahead' : 'unknown' };
  };
}

/** Everything moveToBundled needs on this Mac. `migrator`: { cmd, args, cwd } of the build that will run next. */
export async function realMoveDeps({ env = /** @type {Record<string, string | undefined>} */ (process.env), say = console.log, migrator }) {
  const [{ realPrepare, stopRunning }, { switchEnvToBundled }, pg, { pg17Bin }, { readEnvFile }, paths] = await Promise.all([
    import('./db-agent.mjs'),
    import('./ensure-db.mjs'),
    import('./pg.mjs'),
    import('./brew.mjs'),
    import('./envfile.mjs'),
    import('./paths.mjs'),
  ]);
  const fileEnv = readEnvFile(paths.envFilePath(env)) ?? {};
  return {
    env,
    say,
    sourceUrl: fileEnv.DATABASE_URL,
    targetUrl: pg.bundledDatabaseUrl(env),
    tools: { bin: env.CC_PG_CLIENT_BIN ?? pg17Bin() },
    run: pg.runTool,
    query: (url, fn) => pg.withClient(url, fn, { applicationName: 'command-center-move' }),
    prepare: realPrepare({ env }),
    migrateCheck: migratorCheck({ ...migrator, env: { ...env, ...(migrator.env ?? {}) }, run: pg.runTool }),
    switchEnv: () => switchEnvToBundled(paths.envFilePath(env), { env, note: `(moved to Command Center's own database ${new Date().toISOString().slice(0, 10)}; Homebrew's copy kept ${KEEP_HOMEBREW_DAYS} days)` }),
    abandon: async () => stopRunning(pg.installedEngine(env), { env, unload: true }),
  };
}
