/**
 * Closing a to-do withdraws its pending reply drafts, on Postgres (OUTBOX-W; the rule: src/outbox/withdraw.ts).
 *
 * `withdrawDraftsOfClosedItems(tx, userId)` is idempotent: every message draft in `drafting` / `ready` / `failed`
 * whose work item is `done`, `dismissed` or `merged` becomes `discarded` (version + 1, updated_at, reject_reason
 * "Withdrawn: the to-do closed — <why>"). Approved drafts (and everything after: scheduled, sending, sent, staged),
 * and Outbox action drafts (canvas, VDP, feedback: `payload` set, no work item) are never touched. It runs inside the
 * caller's change set, so the audit trigger records each draft's status change in the same change set as the close
 * (History, the live events and Undo all see it: undoing the close restores the drafts).
 *
 * Callers: `updateWorkItem` (every writer that moves an item into a closed status: user verbs, chat, triage, settle,
 * the closure machine and re-eval), `applyProposal` (an engine status proposal the user applies), and
 * `withdrawClosedItemDrafts` below (its own system change set) at worker start and after each Settle pass, which
 * clears drafts left over from before this rule or from a race.
 */
import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db, Tx } from '@/db/client';
import { WITHDRAWN_DRAFT_PREFIX, withdrawnReason } from '@/outbox/withdraw';

import { extKey } from '../ext';

export interface WithdrawnDraft {
  id: string;
  workItemId: string;
  reason: string;
}

/** db statuses that are still pending (the db's `approved` reads as contract `ready` but is already approved). */
const PENDING_SQL = sql`('drafting', 'ready', 'failed')`;
const CLOSED_SQL = sql`('done', 'dismissed', 'merged')`;

function scopeSql(itemIds: readonly string[] | undefined) {
  return itemIds ? sql`and d.work_item_id::text = any(array[${sql.join(itemIds.map((i) => sql`${i}`), sql`, `)}]::text[])` : sql``;
}

interface Candidate {
  id: string;
  work_item_id: string;
  status: string;
  status_reason: string | null;
  dismissed: { reason?: string | null; note?: string | null } | null;
}

/**
 * Withdraw the pending drafts of closed items (all of the user's, or only `itemIds`). Inside a change set; returns
 * what it withdrew. `at` stamps updated_at (the DataSource's logical clock; default the transaction time).
 */
export async function withdrawDraftsOfClosedItems(tx: Tx, userId: string, o: { itemIds?: readonly string[]; at?: Date } = {}): Promise<WithdrawnDraft[]> {
  if (o.itemIds && !o.itemIds.length) return [];
  const found = await tx.execute<Candidate & Record<string, unknown>>(sql`
    select d.id::text as id, d.work_item_id::text as work_item_id, wi.status::text as status, wi.status_reason,
           coalesce(wi.dismissed, us.value -> 'dismissed') as dismissed
      from drafts d
      join work_items wi on wi.id = d.work_item_id and wi.owner_user_id = d.owner_user_id
      left join user_settings us on us.owner_user_id = d.owner_user_id and us.key = ${extKey('work_items', '')} || wi.id::text
     where d.owner_user_id = ${userId}
       and d.status in ${PENDING_SQL}
       and d.payload is null
       and wi.status in ${CLOSED_SQL}
       ${scopeSql(o.itemIds)}
     order by d.created_at, d.id
       for update of d`);
  if (!found.rows.length) return [];
  const out: WithdrawnDraft[] = found.rows.map((r) => ({
    id: r.id,
    workItemId: r.work_item_id,
    reason: withdrawnReason({ state: r.status === 'done' ? 'done' : 'dismissed', closedReason: r.status_reason, dismissed: r.dismissed }),
  }));
  const at = o.at ? sql`${o.at.toISOString()}::timestamptz` : sql`now()`;
  const res = await tx.execute<{ id: string }>(sql`
    update drafts d
       set status = 'discarded', reject_reason = v.reason, version = d.version + 1, updated_at = ${at}
      from (values ${sql.join(out.map((x) => sql`(${x.id}::uuid, ${x.reason})`), sql`, `)}) as v(id, reason)
     where d.id = v.id and d.owner_user_id = ${userId} and d.status in ${PENDING_SQL}
    returning d.id::text as id`);
  const done = new Set(res.rows.map((r) => r.id));
  return out.filter((x) => done.has(x.id));
}

/** Is anything waiting to be withdrawn? (no change set opened for nothing) */
async function anyToWithdraw(db: Db, userId: string): Promise<boolean> {
  const r = await db.execute(sql`
    select 1 from drafts d join work_items wi on wi.id = d.work_item_id and wi.owner_user_id = d.owner_user_id
     where d.owner_user_id = ${userId} and d.status in ${PENDING_SQL} and d.payload is null and wi.status in ${CLOSED_SQL}
     limit 1`);
  return r.rows.length > 0;
}

/**
 * The sweep in its own system change set (actor `system:<ref>`): worker start (drafts left from before the rule) and
 * the end of each Settle pass. Not undoable from the ⌘Z stack (reopen the to-do and draft again); audited.
 */
export async function withdrawClosedItemDrafts(db: Db, userId: string, o: { ref?: string; at?: Date } = {}): Promise<WithdrawnDraft[]> {
  if (!(await anyToWithdraw(db, userId))) return [];
  const { result } = await withChangeSet({ db, userId, actor: actors.system(o.ref ?? 'outbox.withdraw'), reason: WITHDRAWN_DRAFT_PREFIX, undoable: false }, async (tx, cs) => {
    const out = await withdrawDraftsOfClosedItems(tx, userId, { at: o.at });
    const summary = out.length === 1 ? out[0]!.reason : `${WITHDRAWN_DRAFT_PREFIX}: ${out.length} pending drafts withdrawn`;
    await tx.execute(sql`update change_sets set summary = ${summary.slice(0, 200)}, entity_type = ${out.length === 1 ? 'draft' : null}, entity_id = ${out.length === 1 ? out[0]!.id : null} where id = ${cs.id}`);
    return out;
  });
  return result;
}
