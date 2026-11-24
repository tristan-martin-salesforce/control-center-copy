/**
 * The row windows of the page scopes (reads/scope.ts): which work items, meetings, time blocks and activity rows a
 * scope loads, as id lists from one indexed query each. The store loaders then read those ids only
 * (`loadWorkItems(rc, ids)`, …), so a page's model holds what the page renders and nothing older.
 *
 * Windows widen by meaning, never by a cap: the briefing starts at the earlier of now − days and the user's last
 * active time (so "closed since you left" after three weeks away still lists every close), and an item due or
 * starting inside the window is in it however old it is (RD-1). Records a loaded record points at (a merged item's
 * survivor, the meeting an item serves, an initiative's target meeting) are added by id (RD-2).
 */
import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';

import { uuidFor } from '../ids';

const DAY_MS = 86_400_000;

/** The terminal work-item states (everything else is open work). */
const CLOSED = sql`('done', 'dismissed', 'merged')`;
/** The draft states that are finished (nothing waits on them). */
const DRAFT_DONE = sql`('sent', 'verified', 'rejected', 'discarded', 'superseded', 'handed_off')`;

export interface Window {
  from: Date;
  to: Date;
}

/** The briefing window: [min(now − days, lastActiveAt), now + days]. */
export function briefingWindow(now: Date, days: number, lastActiveAt?: string | null): Window {
  const back = now.getTime() - days * DAY_MS;
  const away = lastActiveAt ? Date.parse(lastActiveAt) : NaN;
  return { from: new Date(Number.isFinite(away) ? Math.min(back, away) : back), to: new Date(now.getTime() + days * DAY_MS) };
}

async function ids(db: DbOrTx, q: ReturnType<typeof sql>): Promise<string[]> {
  const r = await db.execute<{ id: string }>(q);
  return r.rows.map((x) => x.id);
}

/**
 * Briefing / Triage work: open work; anything whose status, record or close changed since `from`; anything due inside
 * the window; the items open drafts and pending proposals are about; and the items those point at (merged into,
 * parent, resolution).
 */
export async function briefingItemIds(db: DbOrTx, userId: string, w: Window): Promise<string[]> {
  return ids(
    db,
    sql`
    with base as (
      select id, parent_id, merged_into_id, resolution_work_item_id from work_items
       where owner_user_id = ${userId}
         and (status not in ${CLOSED}
              or status_changed_at >= ${w.from} or updated_at >= ${w.from} or done_at >= ${w.from}
              or (due_at >= ${w.from} and due_at < ${w.to})
              or id in (select work_item_id from drafts where owner_user_id = ${userId} and work_item_id is not null and (status not in ${DRAFT_DONE} or updated_at >= ${w.from}))
              or id in (select entity_id from change_proposals where owner_user_id = ${userId} and entity_type = 'work_item' and status = 'pending'))
    )
    select id from base
    union select parent_id from base where parent_id is not null
    union select merged_into_id from base where merged_into_id is not null
    union select resolution_work_item_id from base where resolution_work_item_id is not null`,
  );
}

/** Deals: live work only (the per-account open-task counts). */
export async function liveItemIds(db: DbOrTx, userId: string): Promise<string[]> {
  return ids(db, sql`select id from work_items where owner_user_id = ${userId} and status in ('open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done')`);
}

/** Outbox: the items the drafts are about. */
export async function draftItemIds(db: DbOrTx, userId: string): Promise<string[]> {
  return ids(db, sql`select distinct work_item_id as id from drafts where owner_user_id = ${userId} and work_item_id is not null`);
}

/** One account: its items (any state; the page filters). */
export async function accountItemIds(db: DbOrTx, userId: string, accountId: string): Promise<string[]> {
  return ids(db, sql`select id from work_items where owner_user_id = ${userId} and account_id = ${uuidFor(accountId)}`);
}

/**
 * One item (RD-2: a targeted read whatever its age): the item, its initiative's other items, the items it points at
 * and the items that point at it (merged into it, its children).
 */
export async function itemFamilyIds(db: DbOrTx, userId: string, itemId: string): Promise<string[]> {
  const id = uuidFor(itemId);
  return ids(
    db,
    sql`
    with me as (select id, initiative_id, parent_id, merged_into_id, resolution_work_item_id from work_items where owner_user_id = ${userId} and id = ${id})
    select w.id from work_items w, me
     where w.owner_user_id = ${userId}
       and (w.id = me.id or (me.initiative_id is not null and w.initiative_id = me.initiative_id)
            or w.id in (me.parent_id, me.merged_into_id, me.resolution_work_item_id)
            or w.parent_id = me.id or w.merged_into_id = me.id)`,
  );
}

/** History: what the month grid shows: closed, created or closed-by-log inside the window, or sent about in it. */
export async function historyItemIds(db: DbOrTx, userId: string, w: Window): Promise<string[]> {
  return ids(
    db,
    sql`
    select id from work_items
     where owner_user_id = ${userId}
       and ((done_at >= ${w.from} and done_at < ${w.to}) or (created_at >= ${w.from} and created_at < ${w.to})
            or id in (select t.work_item_id from work_item_transitions t where t.to_status = 'done' and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to})
            or id in (select d.work_item_id from drafts d join draft_send_attempts a on a.draft_id = d.id
                       where d.owner_user_id = ${userId} and d.work_item_id is not null and coalesce(a.finished_at, a.started_at) >= ${w.from} and a.started_at < ${w.to}))`,
  );
}

/**
 * Meetings overlapping the window (none when `w` is null), plus every meeting a loaded item serves and every
 * initiative's target meeting (RD-2: by id, whatever their date).
 */
export async function eventIdsFor(db: DbOrTx, userId: string, w: Window | null, itemIds: readonly string[] | null): Promise<string[]> {
  const inWindow = w ? sql`(starts_at < ${w.to} and ends_at >= ${w.from})` : sql`false`;
  const served = itemIds === null ? sql`` : sql`or id in (select deadline_event_id from work_items where owner_user_id = ${userId} and deadline_event_id is not null and id = any(${toArray(itemIds)}::uuid[]))`;
  return ids(
    db,
    sql`
    select id from calendar_events
     where owner_user_id = ${userId}
       and (${inWindow}
            ${served}
            or id in (select target_event_id from initiatives where owner_user_id = ${userId} and target_event_id is not null))`,
  );
}

/** Time blocks overlapping the window. */
export async function timeBlockIdsIn(db: DbOrTx, userId: string, w: Window): Promise<string[]> {
  return ids(db, sql`select id from time_blocks where owner_user_id = ${userId} and starts_at < ${w.to} and ends_at > ${w.from}`);
}

/**
 * History's activity rows: worked inside the window (by start, a day either side for the local-day key), or
 * stamped / changed inside it (an Org62 log lands on the day it was logged).
 */
export async function historyActivityIds(db: DbOrTx, userId: string, w: Window): Promise<string[]> {
  const pad = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
  return ids(
    db,
    sql`
    select id from activity_entries
     where owner_user_id = ${userId}
       and ((starts_at >= ${pad(w.from, -2)} and starts_at < ${pad(w.to, 2)})
            or (synced_to_canvas_at >= ${w.from} and synced_to_canvas_at < ${w.to})
            or (logged_at >= ${w.from} and logged_at < ${w.to})
            or (verified_at >= ${w.from} and verified_at < ${w.to})
            or (updated_at >= ${w.from} and updated_at < ${w.to}))`,
  );
}

/** A uuid[] literal parameter (drizzle passes a JS array as a Postgres array). */
function toArray(v: readonly string[]): string {
  return `{${v.join(',')}}`;
}
