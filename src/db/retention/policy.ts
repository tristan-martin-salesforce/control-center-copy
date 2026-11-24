/**
 * Data retention policy: the rules in one file, the knobs in settings (tenet: Config over code; DATA-MODEL "Retention").
 * A daily-use database stays small and legible, and nothing the app still needs for provenance is deleted.
 *
 *   table              what ages out                                          knob (settings.retention.*)
 *   llm_calls          raw prompt/output text nulled; the row, usage, cost    llmTextDays (30)
 *                      and hashes stay (the 400-day audit trail is separate:
 *                      src/jobs/handlers/retention-tables.ts)
 *   scan_run_events    the full trace; its summary kinds stay longer           traceDays (14) / TRACE_SUMMARY_DAYS (90)
 *   scan_runs          after 90 days once nothing points at them               (delegated: retention-tables.ts)
 *   app_events         resolved events                                         eventsDays (30)
 *   source_items       not referenced by anything (work items, evidence,       orphanSourceDays (90)
 *                      canvases, the ledger, drafts ...: see sourceItemReferences)
 *   jobs               succeeded / cancelled / dead                            JOBS_DAYS (7; delegated, outbound kept)
 *   priority_runs      runs whose scores are all superseded                    PRIORITY_RUNS_DAYS (30)
 *   backups            keep the last 7 daily + 4 weekly                        (backupsToPrune)
 *
 * The `source_items` reference check is built from the catalog (every foreign key into the table) plus the soft
 * references listed here, so a foreign key added later is honoured without touching this file. tests/retention
 * asserts the union covers every FK and every `*source_item*` column is accounted for.
 */
import { sql, type SQL } from 'drizzle-orm';
import { RetentionSettings } from '../../contract/settings';
import type { DbOrTx } from '../client';

export { RetentionSettings };
export const RETENTION_DEFAULTS: RetentionSettings = RetentionSettings.parse({});
/** `user_settings` key the knobs live under. */
export const RETENTION_SETTINGS_KEY = 'retention';

/** Fixed horizons (rules, not knobs). */
export const TRACE_SUMMARY_DAYS = 90;
export const JOBS_DAYS = 7;
export const JOBS_OUTBOUND_DAYS = 400;
export const SCAN_RUNS_DAYS = 90;
export const PRIORITY_RUNS_DAYS = 30;
export const BACKUPS_DAILY = 7;
export const BACKUPS_WEEKLY = 4;
export const BATCH = 1000;
export const STATEMENT_TIMEOUT_MS = 60_000;
/** Doctor warns over this. */
export const DB_WARN_BYTES = 2 * 1024 ** 3;

/** Trace kinds that answer "why was this picked up or not" in one line; kept to TRACE_SUMMARY_DAYS. */
export const TRACE_SUMMARY_KINDS = ['plan', 'triage_select', 'verdict', 'recorded', 'proposal', 'link', 'unlinked', 'spend', 'cost_cap', 'tripwire', 'commit', 'outcome'] as const;
/** Column names that hold raw model text, if the table has them. The table stores hashes only today. */
export const LLM_TEXT_COLUMNS = ['prompt', 'prompt_text', 'output', 'output_text', 'response', 'response_text', 'request_body', 'response_body', 'system_prompt'] as const;

const DAY = 86_400_000;
/**
 * The earliest cutoff: 0001-01-01T00:00:00Z. Postgres `timestamptz` itself goes back to 4713 BC, but an instant before
 * AD 1 serialises through toISOString() as an expanded year (`-003449-…`, `0000-…`) that Postgres rejects, so AD 1 is
 * the earliest instant both sides spell the same way. (`Date.UTC(1, …)` means 1901, hence setUTCFullYear.)
 */
export const CUTOFF_MIN_MS = (() => {
  const d = new Date(0);
  d.setUTCFullYear(1, 0, 1);
  return d.getTime();
})();
/** `now − days`, clamped at AD 1: a horizon that long means "keep everything", and the rule deletes nothing. */
export const cutoff = (now: Date, days: number) => new Date(Math.max(now.getTime() - days * DAY, CUTOFF_MIN_MS)).toISOString();

export function resolveRetention(raw: unknown): RetentionSettings {
  const r = RetentionSettings.safeParse(raw ?? {});
  return r.success ? r.data : RETENTION_DEFAULTS;
}

// ------------------------------------------------------------------------------------------------ references

export interface RefColumn {
  table: string;
  column: string;
  /** The column is an array of ids (`unnest`). */
  array?: boolean;
  fk: boolean;
}

/** References with no foreign key that still mean "this source item is used" (an id array). */
export const SOFT_SOURCE_REFS: readonly RefColumn[] = [{ table: 'vdp_asset_candidates', column: 'source_item_ids', array: true, fk: false }];
/** Columns named like a source item id that are not provenance: the trace log itself. */
export const SOURCE_REF_IGNORED = new Set(['scan_run_events.source_item_id']);

/** Every single-column foreign key into `table` (public schema), from the catalog, with its delete rule. */
export async function foreignKeysTo(db: DbOrTx, table: string): Promise<Array<RefColumn & { onDelete: string }>> {
  const r = await db.execute<{ t: string; c: string; d: string }>(sql`
    select cl.relname as t, a.attname as c, k.confdeltype::text as d
      from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f' and k.confrelid = ${`public.${table}`}::regclass and n.nspname = 'public' and array_length(k.conkey, 1) = 1
     order by 1, 2`);
  return r.rows.map((x) => ({ table: x.t, column: x.c, fk: true, onDelete: x.d }));
}

/** One SQL: the ids (as text: a soft reference may be a text array) any referencing table still points at (a union over every FK and soft reference). */
export function referencedIdsUnion(refs: readonly RefColumn[]): SQL {
  const parts = refs.map((r) =>
    r.array
      ? sql`select unnest(${sql.identifier(r.column)})::text as id from ${sql.identifier(r.table)}`
      : sql`select ${sql.identifier(r.column)}::text as id from ${sql.identifier(r.table)} where ${sql.identifier(r.column)} is not null`,
  );
  return sql.join(parts, sql` union `);
}

export async function sourceItemReferences(db: DbOrTx): Promise<RefColumn[]> {
  const fks = await foreignKeysTo(db, 'source_items');
  return [...fks.map(({ table, column, fk }) => ({ table, column, fk })), ...SOFT_SOURCE_REFS];
}

// ------------------------------------------------------------------------------------------------ rules

export interface RuleContext {
  now: Date;
  userId: string;
  cfg: RetentionSettings;
  /** source_items references, resolved once per run. */
  sourceRefs: RefColumn[];
  /** Resolved raw-text columns of llm_calls (empty: none stored). */
  llmTextColumns: string[];
  /** Resolved FKs into priority_runs other than the cascading scores. */
  priorityBlockers: RefColumn[];
}

export interface SqlRule {
  id: string;
  table: string;
  describe: string;
  /** What one pass does to the selected rows. */
  action: 'delete' | 'null_text';
  /** `select id` of the rows that are eligible now (no limit). Null when the rule has nothing to do. */
  candidates: (c: RuleContext) => SQL | null;
  /** The columns nulled (for `null_text`). */
  columns?: (c: RuleContext) => string[];
}

export const SQL_RULES: SqlRule[] = [
  {
    id: 'llm_text',
    table: 'llm_calls',
    describe: 'raw prompt/output text nulled after llmTextDays; the row, usage, cost and hashes stay',
    action: 'null_text',
    columns: (c) => c.llmTextColumns,
    candidates: (c) => {
      if (!c.llmTextColumns.length) return null;
      const any = sql.join(c.llmTextColumns.map((col) => sql`${sql.identifier(col)} is not null`), sql` or `);
      return sql`select id from llm_calls where owner_user_id = ${c.userId} and started_at < ${cutoff(c.now, c.cfg.llmTextDays)}::timestamptz and (${any})`;
    },
  },
  {
    id: 'trace_full',
    table: 'scan_run_events',
    describe: 'the full scan trace after traceDays; summary kinds stay until 90 days, then everything goes',
    action: 'delete',
    candidates: (c) => {
      const kinds = sql.join(TRACE_SUMMARY_KINDS.map((k) => sql`${k}`), sql`, `);
      return sql`
        select e.id from scan_run_events e join scan_runs r on r.id = e.run_id
         where r.owner_user_id = ${c.userId}
           and (e.ts < ${cutoff(c.now, TRACE_SUMMARY_DAYS)}::timestamptz
                or (e.ts < ${cutoff(c.now, c.cfg.traceDays)}::timestamptz and e.kind not in (${kinds})))`;
    },
  },
  {
    id: 'events_resolved',
    table: 'app_events',
    describe: 'resolved events after eventsDays (open and unresolved ones stay)',
    action: 'delete',
    candidates: (c) => sql`select id from app_events where owner_user_id = ${c.userId} and resolved_at is not null and resolved_at < ${cutoff(c.now, c.cfg.eventsDays)}::timestamptz`,
  },
  {
    id: 'orphan_sources',
    table: 'source_items',
    describe: 'source items nothing references (work items, evidence, canvases, ledger, drafts ...) not seen for orphanSourceDays',
    action: 'delete',
    candidates: (c) => {
      const at = cutoff(c.now, c.cfg.orphanSourceDays);
      return sql`
        select s.id from source_items s
         where s.owner_user_id = ${c.userId} and s.last_seen_at < ${at}::timestamptz and s.occurred_at < ${at}::timestamptz
           and not exists (select 1 from (${referencedIdsUnion(c.sourceRefs)}) r where r.id = s.id::text)`;
    },
  },
  {
    id: 'priority_runs',
    table: 'priority_runs',
    describe: `priority runs older than ${PRIORITY_RUNS_DAYS} days whose scores are all superseded (the newest run per user stays)`,
    action: 'delete',
    candidates: (c) => {
      const blockers = c.priorityBlockers.map((r) => sql`not exists (select 1 from ${sql.identifier(r.table)} b where b.${sql.identifier(r.column)} = r.id)`);
      return sql`
        select r.id from priority_runs r
         where r.owner_user_id = ${c.userId} and r.started_at < ${cutoff(c.now, PRIORITY_RUNS_DAYS)}::timestamptz
           and r.id <> (select n.id from priority_runs n where n.owner_user_id = r.owner_user_id order by n.started_at desc, n.id desc limit 1)
           and not exists (
             select 1 from priority_scores s
              where s.run_id = r.id
                and not exists (select 1 from priority_scores n where n.work_item_id = s.work_item_id and (n.computed_at, n.id) > (s.computed_at, s.id)))
           ${blockers.length ? sql`and ${sql.join(blockers, sql` and `)}` : sql``}`;
    },
  },
];

/** Rules that reuse the table-retention functions (their foreign-key and coverage logic is not duplicated here). */
export const DELEGATED_RULES = [
  { id: 'scan_runs', table: 'scan_runs', describe: `scan runs after ${SCAN_RUNS_DAYS} days once nothing points at them (ledger compacted first)` },
  { id: 'jobs', table: 'jobs', describe: `succeeded / cancelled / dead jobs after ${JOBS_DAYS} days; the newest of each kind and anything an Outbox delivery points at stay` },
] as const;

// ------------------------------------------------------------------------------------------------ backups

/**
 * Which backup files to delete: keep the newest `daily` and, beyond those, the newest file of each of the last `weekly`
 * weeks. Names are `<db>-YYYYMMDD-HHMMSS.dump` (scripts/ops/lib/backup.mjs). Unparseable names are never touched.
 */
export function backupsToPrune(names: readonly string[], daily = BACKUPS_DAILY, weekly = BACKUPS_WEEKLY): string[] {
  const parsed = names
    .map((n) => {
      const m = /-(\d{4})(\d{2})(\d{2})-(\d{6})\.dump$/.exec(n);
      return m ? { name: n, at: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), key: `${m[1]}${m[2]}${m[3]}${m[4]}` } : null;
    })
    .filter((x): x is { name: string; at: number; key: string } => !!x)
    .sort((a, b) => (a.key < b.key ? 1 : -1)); // newest first
  const keep = new Set(parsed.slice(0, daily).map((x) => x.name));
  const weekOf = (t: number) => {
    const day = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
    return Math.floor((t - day * DAY) / (7 * DAY));
  };
  const weeks = new Set<number>();
  for (const b of parsed.slice(daily)) {
    const w = weekOf(b.at);
    if (!weeks.has(w) && weeks.size < weekly) {
      weeks.add(w);
      keep.add(b.name); // the newest file of that week (the list is newest first)
    }
  }
  return parsed.filter((b) => !keep.has(b.name)).map((b) => b.name);
}
