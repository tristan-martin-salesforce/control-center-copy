/**
 * Table retention (audit 2026-11-13, lane E: E4), part of the nightly `retention.scrub` job (03:15 local). The DB was
 * 255 MB after one week, mostly the scan ledger, the scan trace, jobs and the audit log. Horizons (RETENTION_HORIZONS,
 * docs/reference/WORKER.md "Retention"):
 *
 *   jobs                      succeeded / cancelled after 30 days, dead after 90; with an idempotency key (Outbox
 *                             deliveries, VDP pushes: the outbound record) after 400. The newest of each kind and
 *                             status always stays (Health and forecast read "last run").
 *   scan_ledger_entries       compacted after 30 days (when the runs' trace, scan_run_events, goes): the same
 *                             coverage in far fewer rows, never lost; see below. Rows of other outcomes go then.
 *   scan_runs                 after 90 days, once nothing points at them (their ledger rows have moved).
 *   connector_health_checks   after 30 days; the newest per connector stays.
 *   llm_calls, llm_decisions  the audit trail: kept 400 days, then rolled up per day into llm_call_days /
 *                             llm_decision_days and deleted in the same transaction. Never deleted unrolled.
 *
 * A row anything still points at is never deleted (every foreign key into the table is checked, read from the
 * catalog, so a key added later is honoured too): a draft keeps its model call, a source item the run that first saw
 * it, a schedule its last job, an Outbox attempt its job, a model call its scan run. Two kinds of pointer are allowed to
 * go null because they are logs that describe themselves: a model call's and a scan run's `job_id`, and one job's
 * parent / superseded-by link.
 *
 * The ledger (scan_ledger_entries) is what the scanner reads coverage from: gaps, the low watermark, the cursor's
 * reach and which objects were read up to where (store-db.ts coverageGaps / mergedRanges / uncoveredObjects). Deleting
 * a run cascades to its ledger rows, so before any run goes, the `complete` rows past the horizon are compacted per
 * scope and object, with the same answers: overlapping and touching ranges merge (range_agg's union, unchanged),
 * each object keeps its furthest position, and the scope keeps its earliest start. They move to the scope's newest
 * old run (the anchor, which then has ledger rows and stays). Rows of other outcomes never count for coverage and go.
 * Ids, counts and codes only in results.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { Db, DbOrTx } from '@/db/client';
import { cmpPos } from '@/scanner/store-memory';

export const RETENTION_HORIZONS = {
  jobsDoneDays: 30,
  jobsDeadDays: 90,
  jobsOutboundDays: 400,
  /** Compacting changes no coverage answer, only which run a row names: done once the runs' trace is gone too. */
  ledgerCompactDays: 30,
  scanRunsDays: 90,
  healthChecksDays: 30,
  llmAuditDays: 400,
} as const;
/** The audit trail is kept at least this long, whatever the options say. */
export const MIN_LLM_AUDIT_DAYS = 400;

export interface TableRetentionResult {
  jobsDeleted: number;
  healthChecksDeleted: number;
  ledgerRowsDropped: number;
  ledgerRowsCompacted: number;
  ledgerRowsWritten: number;
  scanRunsDeleted: number;
  llmCallsRolledUp: number;
  llmDecisionsRolledUp: number;
  llmDaysRolledUp: number;
  errors: string[];
}

export interface TableRetentionOptions {
  now?: Date;
  horizons?: Partial<Record<keyof typeof RETENTION_HORIZONS, number>>;
  batch?: number;
  maxBatches?: number;
  /** Days rolled up per run (oldest first); a backlog catches up over a few nights. */
  maxRollupDays?: number;
  signal?: AbortSignal;
}

const DAY = 86_400_000;

interface FkRef {
  table: string;
  column: string;
}

/** Every single-column foreign key into `table` (public schema), from the catalog. */
export async function referencesTo(db: DbOrTx, table: string): Promise<FkRef[]> {
  const r = await db.execute<{ t: string; c: string }>(sql`
    select cl.relname as t, a.attname as c
      from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f' and k.confrelid = ${`public.${table}`}::regclass and n.nspname = 'public'
       and array_length(k.conkey, 1) = 1
     order by 1, 2`);
  return r.rows.map((x) => ({ table: x.t, column: x.c }));
}

/** "No row of any referencing table points at `id`", skipping the `allowed` ones (`table.column`). */
function unreferenced(refs: FkRef[], id: SQL, allowed: ReadonlySet<string> = new Set()): SQL {
  const parts = refs
    .filter((r) => !allowed.has(`${r.table}.${r.column}`))
    .map((r) => sql`not exists (select 1 from ${sql.identifier(r.table)} ref where ref.${sql.identifier(r.column)} = ${id})`);
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

const isoAt = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString();

// ----------------------------------------------------------------------------------------------------------- jobs

/** Logs that describe themselves: their pointer to a job may go null. */
const JOB_LINKS_THAT_MAY_GO = new Set(['jobs.superseded_by_id', 'jobs.parent_job_id', 'scan_runs.job_id', 'llm_calls.job_id']);

/** The newest finished job of each kind and status (by when it ended): "last run" readers (Health, forecast) need it. */
const newestJobs = (userId: string) => sql`
  select distinct on (kind, status) id from jobs where owner_user_id = ${userId} and status in ('succeeded', 'cancelled', 'dead')
   order by kind, status, coalesce(finished_at, dead_at, updated_at) desc, id desc`;

export async function purgeJobs(db: Db, userId: string, o: { now: Date; doneDays: number; deadDays: number; outboundDays: number; batch: number; maxBatches: number; signal?: AbortSignal }): Promise<number> {
  const refs = await referencesTo(db, 'jobs');
  const keep = unreferenced(refs, sql`j.id`, JOB_LINKS_THAT_MAY_GO);
  let n = 0;
  for (let i = 0; i < o.maxBatches && !o.signal?.aborted; i++) {
    const del = await db.execute(sql`
      with newest as (${newestJobs(userId)})
      delete from jobs where id in (
        select j.id from jobs j
         where j.owner_user_id = ${userId}
           and j.status in ('succeeded', 'cancelled', 'dead')
           and case when j.idempotency_key is not null then coalesce(j.finished_at, j.dead_at, j.updated_at) < ${isoAt(o.now, o.outboundDays)}::timestamptz
                    when j.status = 'dead' then j.dead_at < ${isoAt(o.now, o.deadDays)}::timestamptz
                    else coalesce(j.finished_at, j.updated_at) < ${isoAt(o.now, o.doneDays)}::timestamptz end
           and j.id not in (select id from newest)
           and ${keep}
         order by j.id limit ${o.batch})`);
    n += del.rowCount ?? 0;
    if ((del.rowCount ?? 0) < o.batch) break;
  }
  return n;
}

// ------------------------------------------------------------------------------------------------- health checks

export async function purgeHealthChecks(db: Db, userId: string, o: { now: Date; days: number; batch: number; maxBatches: number; signal?: AbortSignal }): Promise<number> {
  let n = 0;
  for (let i = 0; i < o.maxBatches && !o.signal?.aborted; i++) {
    const del = await db.execute(sql`
      with newest as (select max(x.id) as id from connector_health_checks x join connectors c on c.id = x.connector_id where c.owner_user_id = ${userId} group by x.connector_id)
      delete from connector_health_checks where id in (
        select h.id from connector_health_checks h join connectors c on c.id = h.connector_id
         where c.owner_user_id = ${userId} and h.checked_at < ${isoAt(o.now, o.days)}::timestamptz
           and h.id not in (select id from newest)
         order by h.id limit ${o.batch * 10})`);
    n += del.rowCount ?? 0;
    if ((del.rowCount ?? 0) < o.batch * 10) break;
  }
  return n;
}

// ------------------------------------------------------------------------------------------- scan ledger + runs

export interface LedgerRow {
  id: string;
  scanRunId: string;
  kind: string;
  ref: string | null;
  from: number | null;
  to: number | null;
  startToken: string | null;
  endToken: string | null;
  items: number;
  newItems: number;
  createdAt: number;
}

export interface CompactedRow {
  kind: string;
  ref: string | null;
  from: number | null;
  to: number | null;
  startToken: string | null;
  endToken: string | null;
  items: number;
  newItems: number;
  createdAt: number;
  /** Set when the row is an original kept as it is (only its run moves to the anchor). */
  keepId?: string;
}

/** The position the scanner compares an object's coverage by (store-db uncoveredObjects: end token, else covered_to). */
const posOf = (r: { endToken: string | null; to: number | null }): string | null => r.endToken ?? (r.to !== null ? new Date(r.to).toISOString() : null);
const cmpNullable = (a: string | null, b: string | null) => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : cmpPos(a, b));

/**
 * One scope's old `complete` rows → the rows that give the scanner the same answers (pure, exported for tests):
 *  - per object (kind + ref): overlapping or touching non-empty ranges merge into one row each (the union is the same,
 *    so every gap, merged range and span is too); item counts add up;
 *  - per object: its furthest position (end token, else covered_to) is kept, as its own original row when no merged
 *    row reaches it; an object with no range at all keeps one row, so "read before" stays true;
 *  - per scope: the earliest start among rows with a range (empty ones count: the low watermark) is kept.
 */
export function compactLedger(rows: readonly LedgerRow[]): CompactedRow[] {
  const byObject = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const k = `${r.kind}\u0000${r.ref ?? '\u0001'}`;
    const list = byObject.get(k) ?? [];
    list.push(r);
    byObject.set(k, list);
  }
  const out: CompactedRow[] = [];
  const kept = new Set<string>();
  const keepRow = (r: LedgerRow) => {
    if (kept.has(r.id)) return;
    kept.add(r.id);
    out.push({ kind: r.kind, ref: r.ref, from: r.from, to: r.to, startToken: r.startToken, endToken: r.endToken, items: r.items, newItems: r.newItems, createdAt: r.createdAt, keepId: r.id });
  };
  for (const list of byObject.values()) {
    const ranged = list.filter((r) => r.from !== null && r.to !== null && r.to > r.from).sort((a, b) => a.from! - b.from! || a.to! - b.to!);
    const segs: Array<CompactedRow & { endRow: LedgerRow; members: LedgerRow[] }> = [];
    for (const r of ranged) {
      const cur = segs.at(-1);
      // '[)' ranges that overlap or touch union into one (range_agg does the same)
      if (cur && r.from! <= cur.to!) {
        if (r.to! > cur.to! || (r.to === cur.to && cmpNullable(r.endToken, cur.endRow.endToken) > 0)) {
          cur.to = Math.max(cur.to!, r.to!);
          cur.endRow = r;
          cur.endToken = r.endToken;
        }
        cur.items += r.items;
        cur.newItems += r.newItems;
        cur.createdAt = Math.max(cur.createdAt, r.createdAt);
        cur.members.push(r);
      } else {
        segs.push({ kind: r.kind, ref: r.ref, from: r.from, to: r.to, startToken: r.startToken, endToken: r.endToken, items: r.items, newItems: r.newItems, createdAt: r.createdAt, endRow: r, members: [r] });
      }
    }
    // a range nothing merged into stays the row it is (so a second pass over compacted rows changes nothing)
    for (const { endRow: _e, members, ...seg } of segs) {
      if (members.length === 1) keepRow(members[0]!);
      else out.push(seg);
    }
    // the object's furthest position, if no merged row has it
    const furthest = [...list].sort((a, b) => cmpNullable(posOf(b), posOf(a)) || Number(b.id) - Number(a.id))[0]!;
    const segMax = segs.reduce<string | null>((m, s) => (cmpNullable(posOf(s), m) > 0 ? posOf(s) : m), null);
    if (!segs.length || cmpNullable(posOf(furthest), segMax) > 0) keepRow(furthest);
  }
  // the scope's earliest start among rows with a range, empty ones included (store-db's low watermark)
  const withRange = rows.filter((r) => r.from !== null && r.to !== null);
  if (withRange.length) {
    const earliest = withRange.reduce((m, r) => (r.from! < m.from! ? r : m));
    const keptMin = out.filter((r) => r.from !== null && r.to !== null).reduce<number | null>((m, r) => (m === null || r.from! < m ? r.from! : m), null);
    if (keptMin === null || earliest.from! < keptMin) keepRow(earliest);
  }
  return out;
}

type LedgerDbRow = {
  id: string;
  scan_run_id: string;
  kind: string;
  ref: string | null;
  f: Date | string | null;
  t: Date | string | null;
  st: string | null;
  et: string | null;
  items: number;
  news: number;
  created_at: Date | string;
  run_at: Date | string;
};

const ms = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());

/** Compact every scope's old `complete` rows and drop old rows of other outcomes. */
export async function compactScanLedger(db: Db, userId: string, o: { now: Date; days: number; signal?: AbortSignal }): Promise<{ dropped: number; compacted: number; written: number }> {
  const cut = isoAt(o.now, o.days);
  // rows of other outcomes never count for gaps, cursors or objects (store rule S7): after the horizon they go
  const drop = await db.execute(sql`
    delete from scan_ledger_entries l using scan_runs r
     where r.id = l.scan_run_id and r.owner_user_id = ${userId} and l.outcome <> 'complete' and l.created_at < ${cut}::timestamptz`);
  const scopes = await db.execute<{ connector_id: string; scope: string; n: number }>(sql`
    select l.connector_id, l.scope, count(*)::int as n from scan_ledger_entries l join scan_runs r on r.id = l.scan_run_id
     where r.owner_user_id = ${userId} and l.outcome = 'complete' and l.created_at < ${cut}::timestamptz
     group by 1, 2 order by 1, 2`);
  let compacted = 0;
  let written = 0;
  for (const sc of scopes.rows) {
    if (o.signal?.aborted) break;
    const r = await db.transaction(async (tx) => {
      const rows = (
        await tx.execute<LedgerDbRow>(sql`
          select l.id::text as id, l.scan_run_id, l.object_kind::text as kind, l.object_external_id as ref, l.covered_from as f, l.covered_to as t,
                 l.start_token as st, l.end_token as et, l.item_count as items, l.new_item_count as news, l.created_at, r.created_at as run_at
            from scan_ledger_entries l join scan_runs r on r.id = l.scan_run_id
           where l.connector_id = ${sc.connector_id} and l.scope = ${sc.scope} and l.outcome = 'complete'
             and l.created_at < ${cut}::timestamptz and r.owner_user_id = ${userId}
           for update of l`)
      ).rows;
      if (!rows.length) return { compacted: 0, written: 0 };
      // the anchor: the newest run among them, which keeps them (a run with ledger rows is never deleted)
      const anchor = [...rows].sort((a, b) => ms(b.run_at)! - ms(a.run_at)! || (b.scan_run_id < a.scan_run_id ? -1 : 1))[0]!.scan_run_id;
      const kept = compactLedger(
        rows.map((x) => ({ id: x.id, scanRunId: x.scan_run_id, kind: x.kind, ref: x.ref, from: ms(x.f), to: ms(x.t), startToken: x.st, endToken: x.et, items: Number(x.items), newItems: Number(x.news), createdAt: ms(x.created_at)! })),
      );
      const keepIds = new Set(kept.flatMap((k) => (k.keepId ? [k.keepId] : [])));
      const fresh = kept.filter((k) => !k.keepId);
      const gone = rows.filter((x) => !keepIds.has(x.id)).map((x) => x.id);
      // already compact (nothing merges): only make sure the kept rows sit on the anchor
      if (!fresh.length && !gone.length) {
        await tx.execute(sql`update scan_ledger_entries set scan_run_id = ${anchor}::uuid where id = any(${`{${rows.map((x) => x.id).join(',')}}`}::bigint[]) and scan_run_id <> ${anchor}::uuid`);
        return { compacted: 0, written: 0 };
      }
      if (gone.length) await tx.execute(sql`delete from scan_ledger_entries where id = any(${`{${gone.join(',')}}`}::bigint[])`);
      if (keepIds.size) await tx.execute(sql`update scan_ledger_entries set scan_run_id = ${anchor}::uuid where id = any(${`{${[...keepIds].join(',')}}`}::bigint[]) and scan_run_id <> ${anchor}::uuid`);
      for (const k of fresh) {
        await tx.execute(sql`
          insert into scan_ledger_entries (scan_run_id, connector_id, scope, object_kind, object_external_id, covered_from, covered_to,
                                           start_token, end_token, item_count, new_item_count, result_hash, outcome, created_at)
          values (${anchor}::uuid, ${sc.connector_id}::uuid, ${sc.scope}, ${k.kind}::ledger_object_kind, ${k.ref},
                  ${k.from !== null ? new Date(k.from).toISOString() : null}::timestamptz, ${k.to !== null ? new Date(k.to).toISOString() : null}::timestamptz,
                  ${k.startToken}, ${k.endToken}, ${k.items}, ${k.newItems}, null, 'complete', ${new Date(k.createdAt).toISOString()}::timestamptz)`);
      }
      return { compacted: gone.length, written: fresh.length };
    });
    compacted += r.compacted;
    written += r.written;
  }
  return { dropped: drop.rowCount ?? 0, compacted, written };
}

export async function purgeScanRuns(db: Db, userId: string, o: { now: Date; days: number; batch: number; maxBatches: number; signal?: AbortSignal }): Promise<number> {
  const refs = await referencesTo(db, 'scan_runs');
  const keep = unreferenced(refs, sql`r.id`);
  let n = 0;
  for (let i = 0; i < o.maxBatches && !o.signal?.aborted; i++) {
    // the newest run of a scope always stays (its skill version, "ran before" and first-scan progress read it)
    const del = await db.execute(sql`
      with newest as (
        select distinct on (connector_id, coalesce(scope, '')) id from scan_runs where owner_user_id = ${userId}
         order by connector_id, coalesce(scope, ''), created_at desc, id desc)
      delete from scan_runs where id in (
        select r.id from scan_runs r
         where r.owner_user_id = ${userId} and r.status not in ('queued', 'running')
           and coalesce(r.finished_at, r.started_at, r.created_at) < ${isoAt(o.now, o.days)}::timestamptz
           and r.id not in (select id from newest)
           and ${keep}
         order by r.created_at limit ${o.batch})`);
    n += del.rowCount ?? 0;
    if ((del.rowCount ?? 0) < o.batch) break;
  }
  return n;
}

// ----------------------------------------------------------------------------------------------- LLM audit trail

/**
 * Past the horizon, one local day at a time (oldest first): the day's calls nothing points at are summed into
 * llm_call_days and deleted, and its decisions into llm_decision_days, in one transaction. A re-run adds to the day.
 */
export async function rollUpLlmAudit(db: Db, userId: string, o: { now: Date; days: number; maxDays: number; signal?: AbortSignal }): Promise<{ calls: number; decisions: number; days: number }> {
  const horizon = Math.max(MIN_LLM_AUDIT_DAYS, o.days);
  // budget_day is the owner's local day; 400 days back from today in UTC, a day early at worst (never late)
  const cutDay = new Date(o.now.getTime() - (horizon + 1) * DAY).toISOString().slice(0, 10);
  const callRefs = await referencesTo(db, 'llm_calls');
  const keepCall = unreferenced(callRefs, sql`c.id`);
  // days with something to roll up: a call nothing points at, or any decision (a day whose calls are all pinned by a
  // draft or a message is not picked again, so it never holds the next days back). Decisions point at calls, so a
  // day with decisions is also a day whose calls may come free once they are rolled up.
  const days = await db.execute<{ day: string }>(sql`
    select day from (
      select distinct c.budget_day::text as day from llm_calls c
       where c.owner_user_id = ${userId} and c.budget_day <= ${cutDay}::date
         and ${unreferenced(callRefs, sql`c.id`, new Set(['llm_decisions.llm_call_id']))}
      union select day::text from llm_decisions where owner_user_id = ${userId} and day <= ${cutDay}::date) d
     order by day limit ${o.maxDays}`);
  let calls = 0;
  let decisions = 0;
  for (const { day } of days.rows) {
    if (o.signal?.aborted) break;
    const r = await db.transaction(async (tx) => {
      // decisions first: a decision points at its escalated call, which then may roll up too
      const d = await tx.execute<{ n: number }>(sql`
        with gone as (
          delete from llm_decisions where owner_user_id = ${userId} and day = ${day}::date returning *),
        up as (
          insert into llm_decision_days (owner_user_id, day, skill_key, kind, reason, trigger, decisions, count, usd, first_at, last_at)
          select owner_user_id, day, skill_key, kind, reason, trigger, count(*)::int, sum(count)::int, sum(usd), min(first_at), max(last_at)
            from gone group by owner_user_id, day, skill_key, kind, reason, trigger
          on conflict (owner_user_id, day, skill_key, kind, reason, trigger) do update set
            decisions = llm_decision_days.decisions + excluded.decisions, count = llm_decision_days.count + excluded.count,
            usd = llm_decision_days.usd + excluded.usd, first_at = least(llm_decision_days.first_at, excluded.first_at),
            last_at = greatest(llm_decision_days.last_at, excluded.last_at), rolled_up_at = now()
          returning 1)
        select (select count(*) from gone)::int as n`);
      const ids = (
        await tx.execute<{ id: string }>(sql`
          select c.id::text as id from llm_calls c where c.owner_user_id = ${userId} and c.budget_day = ${day}::date and ${keepCall}
           for update of c`)
      ).rows.map((x) => x.id);
      if (!ids.length) return { calls: 0, decisions: d.rows[0]?.n ?? 0 };
      const idArr = `{${ids.join(',')}}`;
      await tx.execute(sql`
        insert into llm_call_days (owner_user_id, day, purpose, model, model_tier, skill_key, budget, trigger, model_reason, status,
                                   calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, estimated_calls,
                                   latency_ms_total, first_at, last_at)
        select owner_user_id, budget_day, purpose, model, model_tier, coalesce(skill_key, ''), budget, coalesce(trigger, ''), coalesce(model_reason, ''), status,
               count(*)::int, sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens), sum(cost_usd),
               (count(*) filter (where cost_estimated))::int, coalesce(sum(latency_ms), 0), min(started_at), max(coalesce(finished_at, started_at))
          from llm_calls where id = any(${idArr}::bigint[])
         group by owner_user_id, budget_day, purpose, model, model_tier, coalesce(skill_key, ''), budget, coalesce(trigger, ''), coalesce(model_reason, ''), status
        on conflict (owner_user_id, day, purpose, model, model_tier, skill_key, budget, trigger, model_reason, status) do update set
          calls = llm_call_days.calls + excluded.calls, input_tokens = llm_call_days.input_tokens + excluded.input_tokens,
          output_tokens = llm_call_days.output_tokens + excluded.output_tokens, cache_read_tokens = llm_call_days.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = llm_call_days.cache_write_tokens + excluded.cache_write_tokens, cost_usd = llm_call_days.cost_usd + excluded.cost_usd,
          estimated_calls = llm_call_days.estimated_calls + excluded.estimated_calls, latency_ms_total = llm_call_days.latency_ms_total + excluded.latency_ms_total,
          first_at = least(llm_call_days.first_at, excluded.first_at), last_at = greatest(llm_call_days.last_at, excluded.last_at), rolled_up_at = now()`);
      const del = await tx.execute(sql`delete from llm_calls where id = any(${idArr}::bigint[])`);
      return { calls: del.rowCount ?? 0, decisions: d.rows[0]?.n ?? 0 };
    });
    calls += r.calls;
    decisions += r.decisions;
  }
  return { calls, decisions, days: days.rows.length };
}

// -------------------------------------------------------------------------------------------------------- runner

export async function runTableRetention(db: Db, userId: string, opts: TableRetentionOptions = {}): Promise<TableRetentionResult> {
  const now = opts.now ?? new Date();
  const h = { ...RETENTION_HORIZONS, ...opts.horizons };
  const batch = opts.batch ?? 500;
  const maxBatches = opts.maxBatches ?? 50;
  const out: TableRetentionResult = { jobsDeleted: 0, healthChecksDeleted: 0, ledgerRowsDropped: 0, ledgerRowsCompacted: 0, ledgerRowsWritten: 0, scanRunsDeleted: 0, llmCallsRolledUp: 0, llmDecisionsRolledUp: 0, llmDaysRolledUp: 0, errors: [] };
  // each step on its own: one failing never stops the others (its code is in the result; the next night retries)
  const step = async (name: string, fn: () => Promise<void>) => {
    if (opts.signal?.aborted) return;
    try {
      await fn();
    } catch (err) {
      out.errors.push(`${name}:${(err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name}`);
    }
  };
  // the audit trail first: a rolled-up call frees its scan run and job
  await step('llm', async () => {
    const r = await rollUpLlmAudit(db, userId, { now, days: h.llmAuditDays, maxDays: opts.maxRollupDays ?? 31, signal: opts.signal });
    out.llmCallsRolledUp = r.calls;
    out.llmDecisionsRolledUp = r.decisions;
    out.llmDaysRolledUp = r.days;
  });
  await step('ledger', async () => {
    const r = await compactScanLedger(db, userId, { now, days: Math.min(h.ledgerCompactDays, h.scanRunsDays), signal: opts.signal });
    out.ledgerRowsDropped = r.dropped;
    out.ledgerRowsCompacted = r.compacted;
    out.ledgerRowsWritten = r.written;
  });
  await step('scan_runs', async () => void (out.scanRunsDeleted = await purgeScanRuns(db, userId, { now, days: h.scanRunsDays, batch, maxBatches, signal: opts.signal })));
  await step('jobs', async () => void (out.jobsDeleted = await purgeJobs(db, userId, { now, doneDays: h.jobsDoneDays, deadDays: h.jobsDeadDays, outboundDays: h.jobsOutboundDays, batch, maxBatches, signal: opts.signal })));
  await step('health_checks', async () => void (out.healthChecksDeleted = await purgeHealthChecks(db, userId, { now, days: h.healthChecksDays, batch, maxBatches, signal: opts.signal })));
  return out;
}
