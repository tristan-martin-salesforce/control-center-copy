/**
 * Runs the retention policy (./policy.ts): in batches of 1,000 under a statement timeout, never while a scan or
 * settle job is running, a dry run that touches nothing, and an `app_events` row (DATA.RETENTION_RUN) with counts per
 * table and the size before and after. Ids, counts and byte sizes only; never row content.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { purgeJobs, purgeScanRuns } from '@/jobs/handlers/retention-tables';

import {
  BATCH,
  DELEGATED_RULES,
  foreignKeysTo,
  JOBS_DAYS,
  JOBS_OUTBOUND_DAYS,
  LLM_TEXT_COLUMNS,
  resolveRetention,
  RETENTION_SETTINGS_KEY,
  SCAN_RUNS_DAYS,
  sourceItemReferences,
  SQL_RULES,
  STATEMENT_TIMEOUT_MS,
  type RetentionSettings,
  type RuleContext,
} from './policy';

export interface RetentionTableResult {
  rule: string;
  table: string;
  action: string;
  /** Rows touched (or, in a dry run, that would be). Null: a delegated rule that does not count ahead. */
  rows: number | null;
  note?: string;
}

export interface RetentionRunResult {
  dry: boolean;
  skipped?: 'disabled' | 'scan_active';
  tables: RetentionTableResult[];
  bytesBefore: number;
  bytesAfter: number;
  /** Rows touched x average row size of their table before the run (a delete frees space only after a vacuum). */
  estimatedReclaimBytes: number;
  settings: RetentionSettings;
  /** Rules that threw (each also has a `failed (<code>)` note in `tables` and an open Health event). */
  failed?: string[];
}

export interface RetentionRunOptions {
  now?: Date;
  /** Default: CC_RETENTION_DRY=1. */
  dry?: boolean;
  batch?: number;
  maxBatches?: number;
  /** Run even when settings.retention.enabled is false (an explicit "Run retention now"). */
  force?: boolean;
  /** Write the DATA.RETENTION_RUN event (default true; never in a dry run). */
  recordEvent?: boolean;
  signal?: AbortSignal;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
}

export const isDryEnv = (env: NodeJS.ProcessEnv = process.env) => env.CC_RETENTION_DRY === '1';

export async function loadRetentionSettings(db: Db, userId: string): Promise<RetentionSettings> {
  const r = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${RETENTION_SETTINGS_KEY}`);
  return resolveRetention(r.rows[0]?.value);
}

/** A scan or settle job is running (retention waits: it must not delete under a scan's feet). */
export async function scanOrSettleActive(db: Db): Promise<boolean> {
  const r = await db.execute<{ n: string }>(sql`
    select count(*) as n from jobs where status = 'running' and (kind like 'scan.%' or kind like 'settle%' or kind = 'reevaluate')`);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/** pg_total_relation_size for the tables, and bytes per row from the planner's estimate. */
export async function tableSizes(db: Db, tables: readonly string[]): Promise<Record<string, { bytes: number; perRow: number }>> {
  if (!tables.length) return {};
  const r = await db.execute<{ t: string; b: string; rows: string }>(sql`
    select c.relname as t, pg_total_relation_size(c.oid)::text as b, greatest(c.reltuples, 0)::bigint::text as rows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(${`{${tables.join(',')}}`}::text[])`);
  return Object.fromEntries(r.rows.map((x) => [x.t, { bytes: Number(x.b), perRow: Number(x.b) / Math.max(Number(x.rows), 1) }]));
}

async function resolveContext(db: Db, userId: string, now: Date, cfg: RetentionSettings): Promise<RuleContext> {
  const cols = await db.execute<{ c: string }>(sql`
    select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'llm_calls' and column_name = any(${`{${LLM_TEXT_COLUMNS.join(',')}}`}::text[])`);
  const prio = (await foreignKeysTo(db, 'priority_runs')).filter((r) => r.table !== 'priority_scores' && r.onDelete !== 'c');
  return {
    now,
    userId,
    cfg,
    sourceRefs: await sourceItemReferences(db),
    llmTextColumns: cols.rows.map((x) => x.c),
    priorityBlockers: prio,
  };
}

async function inTx<T>(db: Db, fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`);
    return fn(tx);
  });
}

/** An error's code or class name, never its message (it can quote a value). */
function errorCode(e: unknown): string {
  const x = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const c = x?.code ?? x?.cause?.code; // drizzle wraps the driver error in `cause`
  if (typeof c === 'string' && /^[A-Z0-9_.]{1,40}$/i.test(c)) return c;
  return e instanceof Error ? e.name : 'unknown';
}

const ruleFingerprint = (rule: string) => `data.retention|DATA.RETENTION_RULE_FAILED|${rule}`;

/** An open Health event naming the rule that failed (repeats bump it; the next clean run of the rule resolves it). */
async function flagRule(db: Db, userId: string, rule: string, code: string): Promise<void> {
  await db.execute(sql`
    insert into app_events (owner_user_id, severity, component, code, message, entity_type, entity_id, detail, fingerprint)
    values (${userId}, 'warn', 'data.retention', 'DATA.RETENTION_RULE_FAILED', ${`Retention rule ${rule} failed (${code}); the other rules ran`},
            'retention_rule', ${rule}, ${JSON.stringify({ rule, code })}::jsonb, ${ruleFingerprint(rule)})
    on conflict (fingerprint) where resolved_at is null
    do update set message = excluded.message, detail = excluded.detail, last_occurred_at = now(), occurrence_count = app_events.occurrence_count + 1`);
}

async function clearRuleFlag(db: Db, userId: string, rule: string): Promise<void> {
  await db.execute(sql`update app_events set resolved_at = now() where owner_user_id = ${userId} and fingerprint = ${ruleFingerprint(rule)} and resolved_at is null`);
}

async function runSqlRule(
  db: Db,
  rule: (typeof SQL_RULES)[number],
  ctx: RuleContext,
  o: { dry: boolean; batch: number; maxBatches: number; signal?: AbortSignal },
): Promise<RetentionTableResult> {
  const cand = rule.candidates(ctx);
  if (!cand) return { rule: rule.id, table: rule.table, action: rule.action, rows: 0, note: 'no raw text stored (hashes only)' };
  if (o.dry) {
    const r = await inTx(db, (tx) => tx.execute<{ n: string }>(sql`select count(*) as n from (${cand}) c`));
    return { rule: rule.id, table: rule.table, action: rule.action, rows: Number(r.rows[0]?.n ?? 0) };
  }
  const pick: SQL = sql`select id from (${cand}) c limit ${o.batch}`;
  const stmt: SQL =
    rule.action === 'delete'
      ? sql`delete from ${sql.identifier(rule.table)} where id in (${pick})`
      : sql`update ${sql.identifier(rule.table)} set ${sql.join((rule.columns?.(ctx) ?? []).map((c) => sql`${sql.identifier(c)} = null`), sql`, `)} where id in (${pick})`;
  let n = 0;
  for (let i = 0; i < o.maxBatches && !o.signal?.aborted; i++) {
    const r = await inTx(db, (tx) => tx.execute(stmt));
    n += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < o.batch) break;
  }
  return { rule: rule.id, table: rule.table, action: rule.action, rows: n };
}

export async function runDataRetention(db: Db, userId: string, opts: RetentionRunOptions = {}): Promise<RetentionRunResult> {
  const now = opts.now ?? new Date();
  const dry = opts.dry ?? isDryEnv();
  const batch = opts.batch ?? BATCH;
  const maxBatches = opts.maxBatches ?? 500;
  const log = opts.log ?? (() => {});
  const cfg = await loadRetentionSettings(db, userId);
  const tableNames = [...SQL_RULES.map((r) => r.table), ...DELEGATED_RULES.map((r) => r.table)];
  const empty = (skipped: RetentionRunResult['skipped']): RetentionRunResult => ({ dry, skipped, tables: [], bytesBefore: 0, bytesAfter: 0, estimatedReclaimBytes: 0, settings: cfg });
  if (!cfg.enabled && !opts.force) return empty('disabled');
  if (!dry && (await scanOrSettleActive(db))) return empty('scan_active');

  const before = await tableSizes(db, tableNames);
  const ctx = await resolveContext(db, userId, now, cfg);
  const tables: RetentionTableResult[] = [];

  const failed: string[] = [];
  const ruleFailed = async (rule: { id: string; table: string; action: string }, e: unknown) => {
    const code = errorCode(e);
    failed.push(rule.id);
    tables.push({ rule: rule.id, table: rule.table, action: rule.action, rows: null, note: `failed (${code})` });
    log('retention rule failed', { rule: rule.id, code });
    if (!dry && opts.recordEvent !== false) await flagRule(db, userId, rule.id, code);
  };

  for (const rule of SQL_RULES) {
    if (opts.signal?.aborted) break;
    try {
      const t = await runSqlRule(db, rule, ctx, { dry, batch, maxBatches, signal: opts.signal });
      tables.push(t);
      if (!dry) log('retention rule done', { rule: rule.id, rows: t.rows });
      if (!dry && opts.recordEvent !== false) await clearRuleFlag(db, userId, rule.id);
    } catch (e) {
      // one bad rule never fails the run: the others still age out, and Health names the one that failed
      await ruleFailed(rule, e);
    }
  }

  for (const d of DELEGATED_RULES) {
    if (opts.signal?.aborted) break;
    if (dry) {
      tables.push({ rule: d.id, table: d.table, action: 'delete', rows: null, note: 'delegated: counted when it runs' });
      continue;
    }
    try {
      const n =
        d.id === 'scan_runs'
          ? await purgeScanRuns(db, userId, { now, days: SCAN_RUNS_DAYS, batch, maxBatches, signal: opts.signal })
          : await purgeJobs(db, userId, { now, doneDays: JOBS_DAYS, deadDays: JOBS_DAYS, outboundDays: JOBS_OUTBOUND_DAYS, batch, maxBatches, signal: opts.signal });
      tables.push({ rule: d.id, table: d.table, action: 'delete', rows: n });
      log('retention rule done', { rule: d.id, rows: n });
      if (opts.recordEvent !== false) await clearRuleFlag(db, userId, d.id);
    } catch (e) {
      await ruleFailed({ ...d, action: 'delete' }, e);
    }
  }

  const after = dry ? before : await tableSizes(db, tableNames);
  const sum = (m: Record<string, { bytes: number }>) => Object.values(m).reduce((a, x) => a + x.bytes, 0);
  const estimatedReclaimBytes = dry ? 0 : Math.round(tables.reduce((a, t) => a + (t.rows ?? 0) * (before[t.table]?.perRow ?? 0), 0));
  const result: RetentionRunResult = { dry, tables, bytesBefore: sum(before), bytesAfter: sum(after), estimatedReclaimBytes, settings: cfg, ...(failed.length ? { failed } : {}) };

  if (!dry && opts.recordEvent !== false) {
    const counts = Object.fromEntries(tables.map((t) => [t.table, t.rows]));
    const detail = { counts, bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter, estimatedReclaimBytes };
    // resolved at once: an informational record, not an open problem (and it ages out under eventsDays like the rest)
    await db.execute(sql`
      insert into app_events (owner_user_id, severity, component, code, message, detail, fingerprint, resolved_at)
      values (${userId}, 'info', 'data.retention', 'DATA.RETENTION_RUN', ${`Retention run: ${tables.reduce((a, t) => a + (t.rows ?? 0), 0)} rows`},
              ${JSON.stringify(detail)}::jsonb, ${`data.retention|DATA.RETENTION_RUN|${now.toISOString()}`}, ${now.toISOString()}::timestamptz)`);
  }
  return result;
}

/** A readable plan for the CLI and the dry-run log. */
export function formatRetentionPlan(r: RetentionRunResult): string[] {
  if (r.skipped) return [`retention skipped: ${r.skipped}`];
  const lines = r.tables.map((t) => `  ${t.table.padEnd(18)} ${t.action.padEnd(9)} ${t.rows === null ? 'n/a' : String(t.rows).padStart(8)}${t.note ? `  (${t.note})` : ''}`);
  const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)} MB`;
  return [
    `retention ${r.dry ? 'plan (dry run, nothing changed)' : 'run'}`,
    ...lines,
    r.dry ? `  tables now ${mb(r.bytesBefore)}` : `  tables ${mb(r.bytesBefore)} -> ${mb(r.bytesAfter)} (estimated reclaim ${mb(r.estimatedReclaimBytes)}; vacuum returns the rest)`,
  ];
}
