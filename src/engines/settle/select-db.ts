/**
 * The Settle pass's selection and policy facts on Postgres (read-only):
 *  - which items to judge: every live or suggested item on the first pass; afterwards only items that changed since
 *    the last pass (new evidence, new messages in their conversation, a due date or linked meeting that passed);
 *  - the facts the policy needs (did the user reopen, keep or reframe it, is it an external commitment, who and where);
 *  - the user's Closing settings.
 * With `settings.closing.resolutionEngine` = `live`, nothing is selected: the resolution check decides instead.
 */
import { sql } from 'drizzle-orm';

import { ClosingSettings, DEFAULT_CLOSING_SETTINGS } from '@/contract';
import type { Db, DbOrTx } from '@/db/client';

import { loadCorrectionFacts } from '@/engines/closure/correction-db';

import type { PolicyItem } from './policy';

const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];

export const SETTLE_STATUSES = ['suggested', 'open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done'] as const;
const STATUS_LIST = sql.raw(`(${SETTLE_STATUSES.map((s) => `'${s}'`).join(', ')})`);

export async function loadClosingSettings(db: DbOrTx, userId: string): Promise<ClosingSettings> {
  const r = rows<{ value: unknown }>(await db.execute(sql`select value from user_settings where owner_user_id = ${userId} and key = 'settings.closing'`))[0];
  if (!r) return { ...DEFAULT_CLOSING_SETTINGS };
  const p = ClosingSettings.safeParse(r.value);
  return p.success ? p.data : { ...DEFAULT_CLOSING_SETTINGS };
}

/** R2: engine-closed items a new line in their conversation brings back to the check (still yours → reopen). */
export interface SettleSelectOptions {
  /** Closing ▸ Reopen on follow-up (default on). Off: done items are never selected. */
  reopenOnFollowUp?: boolean;
  /** How far back a close for you can be brought back (days, default 14). */
  reopenWindowDays?: number;
}

/**
 * Wave-0 review W0-2: for a closed item, a new line counts only when it is the asker writing to me, or it names the
 * deliverable (a title word of 4+ letters that is not filler). DM chatter never re-judges (or reopens) a close for you;
 * the scanner's DUP-1 `follow_up:` contradiction stays the other way back. The same rule as the resolution check's
 * triggers (src/scanner/resolution/triggers.ts closedItemLineCounts).
 */
const RELEVANT_TO_CLOSED = sql`(
           ((n.addressed_to_me or n.meta->>'channelType' in ('im', 'mpim'))
             and lower(coalesce(n.meta->'author'->>'externalId', n.meta->'author'->>'email', n.meta->'author'->>'name', ''))
               = lower(coalesce(o.meta->'author'->>'externalId', o.meta->'author'->>'email', o.meta->'author'->>'name', '-')))
           or exists (select 1 from regexp_split_to_table(lower(wi.title), '[^a-z0-9-]+') w
                       where length(w) >= 4 and w not in ('send', 'share', 'with', 'from', 'that', 'this', 'have', 'your', 'about', 'review', 'reply', 'answer', 'update', 'follow', 'check', 'confirm', 'please', 'could', 'would', 'link')
                         and position(w in lower(coalesce(n.body, ''))) > 0))`;

/** A new line from someone else, after `afterSql`, in the conversation (Slack DM/thread, Gmail thread) of `wi`'s origin. */
const newLineIn = (since: string, afterSql: ReturnType<typeof sql.raw>, notMine: boolean) => sql`(
           exists (
             select 1 from work_item_evidence e join source_items o on o.id = e.source_item_id
               join source_items n on n.owner_user_id = wi.owner_user_id and n.source = 'slack' and n.meta->>'channelId' = o.meta->>'channelId'
                and coalesce(n.meta->>'threadTs', '') = coalesce(o.meta->>'threadTs', '') and n.first_seen_at > ${since}::timestamptz
                and n.occurred_at > ${afterSql} ${notMine ? sql`and not n.from_me and ${RELEVANT_TO_CLOSED}` : sql``}
              where e.work_item_id = wi.id and e.role = 'origin' and o.source = 'slack')
           or exists (
             select 1 from work_item_evidence e join source_items o on o.id = e.source_item_id
               join source_items n on n.owner_user_id = wi.owner_user_id and n.source = 'gmail' and n.external_parent_id = o.external_parent_id and n.first_seen_at > ${since}::timestamptz
                and n.occurred_at > ${afterSql} ${notMine ? sql`and not n.from_me and ${RELEVANT_TO_CLOSED}` : sql``}
              where e.work_item_id = wi.id and e.role = 'origin' and o.source = 'gmail'))`;

/**
 * Items to judge. `since` null: every live or suggested item; else only those with something new since then, plus (R2)
 * items closed for you in the reopen window whose conversation got a new line from someone else since then.
 */
export async function selectSettleItems(db: Db, userId: string, since: string | null, now: Date, limit = 600, o: SettleSelectOptions = {}): Promise<Array<{ id: string; status: string }>> {
  // H-7 / R8: with the resolution check live, Settle's decision is retired (its code stays until the next major).
  if ((await loadClosingSettings(db, userId)).resolutionEngine === 'live') return [];
  if (!since) {
    return rows<{ id: string; status: string }>(
      await db.execute(sql`
        select id::text as id, status::text as status from work_items
         where owner_user_id = ${userId} and status::text in ${STATUS_LIST} and merged_into_id is null
         order by created_at limit ${limit}`),
    );
  }
  const nowIso = now.toISOString();
  const live = rows<{ id: string; status: string }>(
    await db.execute(sql`
      select wi.id::text as id, wi.status::text as status from work_items wi
       where wi.owner_user_id = ${userId} and wi.status::text in ${STATUS_LIST} and wi.merged_into_id is null
         and (
           wi.created_at > ${since}::timestamptz
           or (wi.due_at is not null and wi.due_at > ${since}::timestamptz and wi.due_at <= ${nowIso}::timestamptz)
           or exists (select 1 from work_item_evidence e where e.work_item_id = wi.id and e.created_at > ${since}::timestamptz and e.created_by <> 'engine')
           or ${newLineIn(since, sql.raw(`'-infinity'::timestamptz`), false)}
         )
       order by wi.created_at limit ${limit}`),
  );
  if (o.reopenOnFollowUp === false || live.length >= limit) return live;
  const days = Math.max(1, Math.min(365, o.reopenWindowDays ?? 14));
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const done = rows<{ id: string; status: string }>(
    await db.execute(sql`
      select wi.id::text as id, wi.status::text as status from work_items wi
       where wi.owner_user_id = ${userId} and wi.status = 'done' and wi.done_by = 'engine' and wi.merged_into_id is null
         and wi.done_at >= ${from}::timestamptz
         and ${newLineIn(since, sql.raw('wi.done_at'), true)}
       order by wi.done_at desc limit ${limit - live.length}`),
  );
  return [...live, ...done];
}

/** Policy facts for the selected items (R1: the correction facts both closers share, src/engines/closure/correction-db.ts). */
export async function policyFacts(db: Db, userId: string, ids: string[]): Promise<Map<string, PolicyItem>> {
  const out = new Map<string, PolicyItem>();
  for (const [id, f] of await loadCorrectionFacts(db, userId, ids)) {
    out.set(id, {
      id,
      kind: f.kind,
      status: f.status,
      userTouched: f.reframed,
      userReopened: f.userReopened,
      userKept: f.userKept,
      doneByEngine: f.doneByEngine,
      externalCommitment: f.externalCommitment,
      people: f.people,
      channels: f.channels,
      originSource: f.originSource,
    });
  }
  return out;
}
