/**
 * R1 on Postgres (read-only): the facts the one correction rule needs (correction.ts), computed in ONE query for both
 * closers. Settle's policyFacts and the re-evaluation pass (src/server/datasource/db/closure.ts) both read them here.
 *
 *  - reopened: a user transition out of done/dismissed, or out of likely_done back to live work (Not done); or an Undo of
 *    an engine change set that closed it, asked about it (Looks done) or moved it to Still needed? (an Undo of a
 *    close reverts it instead of writing a user transition). Only those: an Undo of an engine due-date patch, account
 *    fill or evidence attach is not a correction (W0-3). `reopenUndoId` names the Undo, for "you reopened it".
 *  - kept: a user transition from suggested back to live work after the item had been live and was moved to Still
 *    needed? (Keep), or an accept of an item that still carries the Still needed? mark. A plain accept from Triage is
 *    not a correction.
 *  - reframed: the user edited its title or kind (Settle asks rather than closes; it never blocks the machine).
 */
import { type SQL, sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { STILL_NEEDED_MARK } from '@/engines/still-needed';

import type { CorrectionFacts } from './correction';

export interface CorrectionRow extends CorrectionFacts {
  id: string;
  kind: string;
  status: string;
  /** The user's Undo of an engine close / ask / Still needed? move that makes `userReopened` true (latest), if any. */
  reopenUndoId: string | null;
  /** The user edited the title or kind. */
  reframed: boolean;
  originSource: string | null;
  /** Done by the engine (a close for you), and when. */
  doneByEngine: boolean;
  doneAt: string | null;
}

const LIVE = sql.raw(`('open', 'in_progress', 'waiting_on_me', 'waiting_on_others')`);
/** Statuses an engine change set moves an item to when it closes it, asks Looks done? or moves it to Still needed?. */
const CLOSING = sql.raw(`('done', 'dismissed', 'likely_done', 'suggested')`);

/**
 * W0-3: a user Undo of an engine change set that closed this item, asked about it (Looks done) or moved it to Still
 * needed?: the change set wrote a transition to one of those statuses, or (a close that wrote no transition row) its
 * audit image moved the item's `status` to one. An Undo of any other engine change (a due-date patch, an account fill,
 * an evidence attach) is not a correction and never blocks a close. An Undo that was itself undone (Undo reopen, a redo)
 * is not a correction either: the item is closed again as the engine left it.
 */
const undoOfEngineClose = (pick: SQL) => sql`
  select ${pick} from change_sets c join change_sets u on u.id = c.undo_of_change_set_id
   where c.owner_user_id = wi.owner_user_id and c.actor_kind = 'user' and c.kind = 'undo' and c.undone_at is null and u.actor_kind = 'engine'
     and c.entity_type in ('work_item', 'work_items') and c.entity_id = wi.id::text
     and (exists (select 1 from work_item_transitions t2 where t2.change_set_id = u.id and t2.work_item_id = wi.id
                    and t2.to_status::text in ${CLOSING})
          or exists (select 1 from audit_events a where a.change_set_id = u.id and a.table_name = 'work_items' and a.row_id = wi.id::text
                       and 'status' = any(a.changed_fields) and a.after->>'status' in ${CLOSING}))`;

/** The correction facts of these items (the user's own items only). */
export async function loadCorrectionFacts(db: DbOrTx, userId: string, ids: string[]): Promise<Map<string, CorrectionRow>> {
  const out = new Map<string, CorrectionRow>();
  if (!ids.length) return out;
  const arr = sql`array[${sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  )}]`;
  const mark = `%${STILL_NEEDED_MARK}%`;
  const r = await db.execute<Record<string, unknown>>(sql`
    select wi.id::text as id, wi.kind::text as kind, wi.status::text as status,
           (wi.done_by::text = 'engine') as done_by_engine, wi.done_at,
           ('title' = any(coalesce(wi.user_locked_fields, '{}')) or 'kind' = any(coalesce(wi.user_locked_fields, '{}'))) as reframed,
           exists (select 1 from work_item_transitions t where t.work_item_id = wi.id and t.actor_kind = 'user'
                     and ((t.from_status::text in ('done', 'dismissed') and t.to_status::text not in ('done', 'dismissed'))
                          or (t.from_status::text = 'likely_done' and t.to_status::text not in ('done', 'dismissed', 'likely_done'))))
           or exists (${undoOfEngineClose(sql`c.id`)}) as reopened,
           (${undoOfEngineClose(sql`c.id::text`)} order by c.created_at desc limit 1) as reopen_undo_id,
           exists (select 1 from work_item_transitions k where k.work_item_id = wi.id and k.actor_kind = 'user'
                     and k.from_status::text = 'suggested' and k.to_status::text in ${LIVE}
                     and (exists (select 1 from work_item_transitions d where d.work_item_id = wi.id and d.id < k.id
                                    and d.to_status::text = 'suggested' and d.from_status::text in ${LIVE})
                          or lower(coalesce(wi.status_reason, '')) like ${mark})) as kept,
           coalesce(cp.affiliation::text, '') as cp_affiliation,
           (select s.source::text from work_item_evidence e join source_items s on s.id = e.source_item_id where e.work_item_id = wi.id and e.role = 'origin' order by s.occurred_at limit 1) as origin_source,
           (select array_remove(array_agg(distinct coalesce(s.meta->'author'->>'name', '')), '') from work_item_evidence e join source_items s on s.id = e.source_item_id where e.work_item_id = wi.id) as people,
           (select array_remove(array_agg(distinct coalesce(s.meta->>'channelName', '')), '') from work_item_evidence e join source_items s on s.id = e.source_item_id where e.work_item_id = wi.id) as channels
      from work_items wi left join people cp on cp.id = wi.counterparty_person_id
     where wi.owner_user_id = ${userId} and wi.id = any(${arr})`);
  for (const x of r.rows) {
    const kind = String(x.kind);
    out.set(String(x.id), {
      id: String(x.id),
      kind,
      status: String(x.status),
      reframed: !!x.reframed,
      userReopened: !!x.reopened,
      reopenUndoId: (x.reopen_undo_id as string | null) ?? null,
      userKept: !!x.kept,
      externalCommitment: kind === 'commitment' && /external|customer|partner/i.test(String(x.cp_affiliation ?? '')),
      people: (x.people as string[] | null) ?? [],
      channels: (x.channels as string[] | null) ?? [],
      originSource: (x.origin_source as string | null) ?? null,
      doneByEngine: !!x.done_by_engine,
      doneAt: x.done_at ? new Date(x.done_at as string).toISOString() : null,
    });
  }
  return out;
}
