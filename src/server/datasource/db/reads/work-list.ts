/**
 * The Work list's row window and tab counts (post-2.0 "Work list scope", 15-page-reads.md). GET /items loads the
 * `work` scope (reads/scope.ts): the items its query can show, never a year of closed work to show the open tab.
 *
 * One SQL rule, built from the view's own (`tabMatch` in views/work.ts) so the two cannot drift: every (state, kind,
 * background) a row can have maps to the tabs it is in. A row's state and kind are the loader's (store/work.ts
 * `loadWorkItems`): the db enum mapped back (`stateFromDb`, `kindFromDb`), or the kv override when it names that enum
 * value (`applyOverride`).
 *
 * Two paths, by what SQL can decide exactly:
 *   exact     (no text, no source filter): account, opp, initiative and kind are exact in SQL, so the window is the
 *             tab's rows only (the Closed tab one page with `limit`, in the view's order) and every tab's count is
 *             one SQL query (`workListCounts`);
 *   superset  (text or source): the title / purpose / why text and the source chips are what the loader derives (the
 *             why from the score or the kv, the chips from the kv or the evidence), so SQL narrows to a superset over
 *             every tab's states and the view filters and counts exactly. An ASCII search narrows by lower-cased
 *             containment; any other search is not narrowed (case folding differs between SQL and JS).
 * A failed window query reads every item (null: WL-3, a failed narrowing never changes the answer).
 */
import { sql, type SQL } from 'drizzle-orm';

import { WorkKind, WorkState, type WorkTab } from '@/contract';
import type { DbOrTx } from '@/db/client';
import { sourceSystem, workItemKind, workItemStatus } from '@/db/schema';
import { logger } from '@/lib/log';
import { tabMatch, WORK_TABS } from '@/server/views/work';

import { kindFromDb, sourceFromDb, stateFromDb, stateToDb } from '../enums';
import { uuidFor } from '../ids';
import { parseClosedCursor, type ClosedKey } from './page';
import type { WorkListScope } from './scope';

const log = logger('reads');

/** Whether every tab's count is exact in SQL (no text or source filter): then the window is the tab's rows only. */
export function countsInSql(q: WorkListScope): boolean {
  return !q.q && !q.source;
}

/** Whether the window is one page of the tab (the Closed tab with `limit`, on the exact path). */
export function pagedInSql(q: WorkListScope): boolean {
  return countsInSql(q) && q.tab === 'done' && !!q.limit;
}

/** Every (state, kind, background) a row can have, with the tabs the view puts such a row in (none left out). */
const COMBOS = WorkState.options.flatMap((state) =>
  WorkKind.options.flatMap((kind) =>
    [false, true].map((bg) => ({ state, kind, bg, tabs: WORK_TABS.filter((t) => tabMatch(t, { state, kind, isBackground: bg } as Parameters<typeof tabMatch>[1])) })),
  ),
).filter((c) => c.tabs.length);

/** The tab rule as SQL rows: (state, kind, background) → the tabs such a row is in. */
const RULE: SQL = sql.raw(`(values ${COMBOS.map((c) => `('${c.state}', '${c.kind}', ${c.bg}, array[${c.tabs.map((t) => `'${t}'`).join(', ')}]::text[])`).join(', ')}) as r(st, kd, bg, tabs)`);

/**
 * The stored statuses a row in `tab` (every tab: null) can have: the ones that map back to one of its states, and the
 * one a state's kv override is stored under (`overrideIfLossy` keys it by `stateToDb`: 'reopened' rides on 'open').
 * An index prefilter (work_items_owner_status_idx), so the kv and the tab rule look only at those rows.
 */
function statusesOf(tab: WorkTab | null): string[] {
  const states = new Set(COMBOS.filter((c) => !tab || c.tabs.includes(tab)).map((c) => c.state));
  return workItemStatus.enumValues.filter((s) => states.has(stateFromDb(s, false)) || [...states].some((c) => stateToDb(c) === s));
}

/** `case <col> when <db> then <contract> … else <col> end` for the enum values the reverse map changes. */
function mapped(col: string, values: readonly string[], map: (v: string) => string): string {
  const arms = values.filter((v) => map(v) !== v).map((v) => `when '${v}' then '${map(v)}'`);
  return arms.length ? `(case ${col} ${arms.join(' ')} else ${col} end)` : col;
}

const STATE = sql.raw(
  `(case when kv.value -> 'stateOverride' ->> 'when' = w.status::text then kv.value -> 'stateOverride' ->> 'value' else ${mapped('w.status::text', workItemStatus.enumValues, (s) => stateFromDb(s as never, false))} end)`,
);
const KIND = sql.raw(`(case when kv.value -> 'kindOverride' ->> 'when' = w.kind::text then kv.value -> 'kindOverride' ->> 'value' else ${mapped('w.kind::text', workItemKind.enumValues, (k) => kindFromDb(k as never))} end)`);

/** The stored source systems a source chip kind comes from. */
const systemsOf = (kind: string) => sourceSystem.enumValues.filter((s) => sourceFromDb(s as never) === kind);

/** The user's items with the loader's state and kind, narrowed by the exact filters (account, opp, initiative). */
function rowsOf(userId: string, q: WorkListScope, tab: WorkTab | null): SQL {
  const where: SQL[] = [sql`w.owner_user_id = ${userId}`, sql`w.status::text = any(${`{${statusesOf(tab).join(',')}}`}::text[])`];
  if (q.account) where.push(sql`w.account_id = ${uuidFor(q.account)}`);
  if (q.opp) where.push(sql`w.opportunity_id = ${uuidFor(q.opp)}`);
  if (q.initiative) where.push(sql`w.initiative_id = ${uuidFor(q.initiative)}`);
  return sql`
    select w.id, w.done_at, w.created_at, w.title, w.purpose, w.priority_score_id, kv.value as ext,
           ${STATE} as st, ${KIND} as kd, coalesce(w.priority_lane::text = 'background', false) as bg
      from work_items w
      left join user_settings kv on kv.owner_user_id = w.owner_user_id and kv.key = 'cc.ext/work_items/' || w.id::text
     where ${sql.join(where, sql` and `)}`;
}

/** The superset predicates (text, source) over `x`; the view applies the exact ones. */
function superset(q: WorkListScope): SQL[] {
  const out: SQL[] = [];
  if (q.q && /^[\x20-\x7e]*$/.test(q.q)) {
    out.push(sql`strpos(lower(x.title || ' ' || coalesce(x.purpose, '') || ' ' || coalesce((select ps.explanation from priority_scores ps where ps.id = x.priority_score_id), x.ext ->> 'why', '')), ${q.q.toLowerCase()}) > 0`);
  }
  if (q.source) {
    const systems = `{${systemsOf(q.source).join(',')}}`;
    out.push(sql`(coalesce(x.ext -> 'sources' @> ${JSON.stringify([{ kind: q.source }])}::jsonb, false)
      or exists (select 1 from work_item_evidence e join source_items si on si.id = e.source_item_id
                  where e.work_item_id = x.id and si.dedupe_key not like 'cc.evidence:%' and si.source::text = any(${systems}::text[])))`);
  }
  return out;
}

/**
 * The window: the ids the list query can show. Exact path: the tab's rows (the Closed tab's page with `limit`, in the
 * view's order: closed newest first, then created, then id). Superset path: every tab's rows the text and source
 * filters may match. Null when the query fails (the model then reads every item).
 */
export async function workListIds(db: DbOrTx, userId: string, q: WorkListScope): Promise<string[] | null> {
  const where: SQL[] = [];
  if (q.kind) where.push(sql`x.kd = ${q.kind}`);
  let tail = sql``;
  if (countsInSql(q)) {
    where.push(sql`${q.tab} = any(r.tabs)`);
    if (pagedInSql(q)) {
      // the view's order (WL-4) at its precision (ISO milliseconds), then the loader's (created, id); the rows after
      // the keyset cursor (P25-6), one more than the page so the domain knows whether a next page exists
      const k = parseClosedCursor(q.cursor);
      if (k) where.push(afterClosedKey(k));
      tail = sql` order by date_trunc('milliseconds', x.done_at) desc nulls last, date_trunc('milliseconds', x.created_at), x.created_at, x.id limit ${q.limit! + 1}`;
    }
  } else where.push(...superset(q));
  try {
    // materialized: the rows are mapped once (inlined, the planner looped the tab rule over them: 7 ms → 2 ms)
    const r = await db.execute<{ id: string }>(sql`
      with work_list as materialized (${rowsOf(userId, q, countsInSql(q) ? q.tab : null)})
      select x.id from work_list x join ${RULE} on r.st = x.st and r.kd = x.kd and r.bg = x.bg
      ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}${tail}`);
    return r.rows.map((x) => x.id);
  } catch (e) {
    log.warn({ code: 'READS.WORK_WINDOW_FAILED', err: (e as Error).name }, 'work list: the window query failed; reading every item');
    return null;
  }
}

/**
 * The Closed rows after a keyset cursor, in the SQL order above: an earlier closed instant (or none), the same one
 * with a later created instant, or the same both and after the cursor's row by (created_at, id). When that row is
 * gone the tie compares to nothing and the ties are kept (a repeat the client dedupes, never a skip).
 */
function afterClosedKey(k: ClosedKey): SQL {
  const dm = sql`date_trunc('milliseconds', x.done_at)`;
  const cm = sql`date_trunc('milliseconds', x.created_at)`;
  const created = new Date(k.createdMs).toISOString();
  const anchor = sql`coalesce((x.created_at, x.id) > (select a.created_at, a.id from work_items a where a.id = ${uuidFor(k.id)}), true)`;
  const sameCreated = sql`(${cm} > ${created}::timestamptz or (${cm} = ${created}::timestamptz and ${anchor}))`;
  if (k.doneMs === null) return sql`(x.done_at is null and ${sameCreated})`;
  const done = new Date(k.doneMs).toISOString();
  return sql`(x.done_at is null or ${dm} < ${done}::timestamptz or (${dm} = ${done}::timestamptz and ${sameCreated}))`;
}

/** Every tab's count over the exact filters (`countsInSql`), one query. */
export async function workListCounts(db: DbOrTx, userId: string, q: WorkListScope): Promise<Record<WorkTab, number>> {
  const r = await db.execute<{ tab: WorkTab; n: number }>(sql`
    with work_list as (${rowsOf(userId, q, null)})
    select t.tab, count(*)::int as n from work_list x join ${RULE} on r.st = x.st and r.kd = x.kd and r.bg = x.bg, unnest(r.tabs) as t(tab)
    ${q.kind ? sql`where x.kd = ${q.kind}` : sql``}
    group by t.tab`);
  const counts = Object.fromEntries(WORK_TABS.map((t) => [t, 0])) as Record<WorkTab, number>;
  for (const row of r.rows) counts[row.tab] = Number(row.n);
  return counts;
}
