/**
 * D-68 (dc-roundtrip): what an Org62 read does to my book beyond the DCs themselves, on Postgres. Each step is
 * idempotent, runs inside the caller's change set (the projection pass after `syncMyDcs`, or the hygiene sweep) and
 * returns how many rows it wrote (0 on a pass that changed nothing). The rules are the shared ones
 * (src/server/deals/scope.ts, src/server/deals/dc-requests.ts); this file is their SQL.
 *
 *  - DC-11 `clearStaleDcFlags`: an opp whose DC of mine was removed in Org62 loses the `dcAssigned` flag, so it can be
 *    a gap, a claim and out of the pipeline again (the flag was only ever ORed in).
 *  - DC-06 `rememberDcRead` / `lastDcRead`: the newest complete read of my DCs on open opps (the daily book read), so
 *    the not-created rule and the hygiene sweep know when "no DC" is a fact.
 *  - DC-10 `withdrawVdpItemsOutOfScope`: pending VDP items for an account that left the 100%-DC scope (D-63) are
 *    withdrawn with why, instead of waiting 14 days for the stale sweep.
 *  - DC-21 / DC-24 `afterBookSync`: an account that left my book loses its DC status and hours; one merged in Org62
 *    (every opp it had moved to one surviving account) is archived, and the survivor takes over its links.
 *  - DC-22 `markOppsDeleted`: an opp the read-back asked for by Id and Org62 no longer has is tombstoned: archived,
 *    its snapshots marked, its requests withdrawn (`opp_deleted`), its findings resolved. Never a gap.
 *  - DC-25 `sweepStaleAccountDcStatus`: an account DC status no open opp of mine supports goes.
 *
 * Logs and change-set summaries carry counts only.
 */
import { sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '@/db/client';
import { linkVdp, onVdp } from '@/engines/vdp/gaps';
import type { Org62Book } from '@/projections/types';
import type { DcRead } from '@/server/deals/dc-requests';
import { vdpOppIdsOf } from '@/server/deals/needs';
import { accountMerges, VDP_SCOPE_WITHDRAWN_REASON } from '@/server/deals/scope';

import { id15, isOrg62Id } from '@/connectors/org62/ids';

import { extKey } from '../ext';
import { readHash, recordMirrorRead } from '../vdp-mirror';
import { writeKv, type WriteCtx } from './common';
import { mergeExt } from './projections';
import { loadGapEntities, loadVdpRecords } from './vdp';

/** The kv singleton holding the newest complete read of my DCs (`DcRead`). */
export const DC_READ_KEY = 'cc.deals/dc-read';


// ---------------------------------------------------------------------------
// DC-06: the newest complete read
// ---------------------------------------------------------------------------

/**
 * Keep the newest complete read of my DCs (1 when it moved on). D-98 (mirror convention): the read is a `mirror_reads`
 * row (source org62, scope my_dcs); the kv singleton is still written for the read model's callers.
 * TODO(2.1): drop the kv singleton once every caller reads lastDcRead.
 */
export async function rememberDcRead(w: WriteCtx, read: DcRead | null | undefined): Promise<number> {
  if (!read?.complete) return 0;
  const prev = w.kv.get(DC_READ_KEY) as DcRead | undefined;
  if (prev?.at && Date.parse(prev.at) >= Date.parse(read.at)) return 0;
  await writeKv(w, DC_READ_KEY, { at: read.at, complete: true });
  await recordMirrorRead(w.tx, w.userId, { source: 'org62', scope: 'my_dcs', readAt: new Date(read.at), rows: 0, complete: true, hash: readHash([read.at]) });
  return 1;
}

/** The newest complete read of my DCs the app has seen, or null: mirror_reads first, the kv singleton as the fallback. */
export async function lastDcRead(db: DbOrTx, userId: string): Promise<DcRead | null> {
  const m = await db.execute<{ at: Date | string }>(sql`select read_at as at from mirror_reads where owner_user_id = ${userId}::uuid and source = 'org62' and scope = 'my_dcs' and complete order by read_at desc limit 1`);
  const r = await db.execute<{ value: DcRead | null }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${DC_READ_KEY}`);
  const v = r.rows[0]?.value;
  const kv = v?.at && v.complete ? v.at : null;
  const row = m.rows[0] ? new Date(m.rows[0].at).toISOString() : null;
  // the newer of the two (a read the old build recorded only in the kv still counts)
  const at = row && kv ? (Date.parse(kv) >= Date.parse(row) ? kv : row) : (row ?? kv);
  return at ? { at, complete: true } : null;
}

// ---------------------------------------------------------------------------
// DC-11 / DC-25: the dcAssigned flag follows my DCs
// ---------------------------------------------------------------------------

/**
 * Clear `dcAssigned` on opps with no live DC of mine (by row, or by the Org62 opp id's first 15 characters) where the
 * flag is the projection's: the opp has a real Org62 id, or a DC of mine on it was removed upstream. A seeded flag on
 * a row Org62 never projected ("Org62 shows one, split not read") stays. `oppIds`: only these (the sync's removals).
 */
export async function clearStaleDcFlags(w: WriteCtx, oppIds?: readonly string[]): Promise<number> {
  if (oppIds && !oppIds.length) return 0;
  const scope = oppIds ? sql`and o.id::text in (${sql.join(oppIds.map((x) => sql`${x}`), sql`, `)})` : sql``;
  const r = await w.tx.execute<{ id: string }>(sql`
    select o.id::text as id from opportunities o
      -- D-98: the column first; the kv copy only for a row the backfill has not reached
      left join user_settings s on s.owner_user_id = o.owner_user_id and s.key = 'cc.ext/opportunities/' || o.id::text
     where o.owner_user_id = ${w.userId} ${scope}
       and (o.dc_assigned or coalesce((s.value->>'dcAssigned')::boolean, false))
       and not exists (
         select 1 from deal_contributions dc left join opportunities o2 on o2.id = dc.opportunity_id
          where dc.owner_user_id = o.owner_user_id and dc.is_mine and dc.deleted_upstream_at is null
            and (dc.opportunity_id = o.id or o2.org62_opportunity_id15 = o.org62_opportunity_id15))
       and (o.org62_opportunity_id ~ '^006[A-Za-z0-9]{12}'
            or exists (select 1 from deal_contributions d3 where d3.owner_user_id = o.owner_user_id and d3.opportunity_id = o.id and d3.is_mine and d3.deleted_upstream_at is not null))`);
  let n = 0;
  for (const x of r.rows) if (await mergeExt(w, 'opportunities', x.id, { dcAssigned: null })) n++;
  return n;
}

// ---------------------------------------------------------------------------
// DC-10: VDP items for an account that left the 100% scope
// ---------------------------------------------------------------------------

/** Accounts with an open opp where my DCs sum to 100% (D-63 "engaged"; DC-14 sums two of mine). */
export async function engagedAccountIds(db: DbOrTx, userId: string): Promise<Set<string>> {
  const r = await db.execute<{ id: string }>(sql`
    select distinct o.account_id::text as id from opportunities o
     where o.owner_user_id = ${userId} and not o.is_closed and o.archived_at is null and o.account_id is not null
       and (select sum(dc.split_percent) from deal_contributions dc left join opportunities o2 on o2.id = dc.opportunity_id
             where dc.owner_user_id = o.owner_user_id and dc.is_mine and dc.deleted_upstream_at is null
               and (dc.opportunity_id = o.id or o2.org62_opportunity_id15 = o.org62_opportunity_id15)) = 100`);
  return new Set(r.rows.map((x) => x.id));
}

/**
 * Pending VDP items (Outbox `vdp_update` drafts not yet approved: ready, failed) whose account is no longer engaged:
 * withdrawn (`discarded`, with why). The account is the item's own (`account:<id>` slug of a create) or its VDP's link
 * in the mirror. An item you edited stays (what you wrote is never withdrawn: the stale sweep flags it on Health).
 */
export async function withdrawVdpItemsOutOfScope(w: WriteCtx): Promise<number> {
  const pending = await w.tx.execute<{ id: string; slug: string | null; edited: boolean; account: string | null }>(sql`
    select d.id::text as id, d.payload->>'vdp_slug' as slug, coalesce(d.edited_by_user, false) as edited,
           case when d.payload->>'vdp_slug' like 'account:%' then substr(d.payload->>'vdp_slug', 9)
                else (select v.account_id::text from vdp_records v where v.owner_user_id = d.owner_user_id and v.vdp_slug = d.payload->>'vdp_slug' and v.gone_at is null limit 1) end as account
      from drafts d
     where d.owner_user_id = ${w.userId} and d.action_type = 'vdp_update' and d.status in ('ready', 'failed') and d.payload is not null`);
  if (!pending.rows.length) return 0;
  const engaged = await engagedAccountIds(w.tx, w.userId);
  let n = 0;
  for (const d of pending.rows) {
    if (d.edited || !d.account || engaged.has(d.account)) continue;
    const res = await w.tx.execute(sql`
      update drafts set status = 'discarded', reject_reason = ${VDP_SCOPE_WITHDRAWN_REASON}, version = version + 1, updated_at = ${w.now.toISOString()}::timestamptz
       where id = ${d.id}::uuid and owner_user_id = ${w.userId} and status in ('ready', 'failed')`);
    n += res.rowCount ?? 0;
  }
  return n;
}

// ---------------------------------------------------------------------------
// DC-21 / DC-24: accounts that left my book, and merged ones
// ---------------------------------------------------------------------------

/** Tables whose account link a merged-away account hands to the survivor (DC-24). */
const RELINK_TABLES = ['work_items', 'calendar_events', 'assets', 'claude_sessions', 'activity_entries', 'vdp_records', 'opportunities'] as const;

/**
 * After a full Org62 pass (the book is the full recompute):
 *  - DC-24: an account every one of whose opps moved to one other account in Org62 (`accountMerges`) and that left my
 *    book is archived, `mergedInto` the survivor; the survivor takes its name as an alias (matching) and every row
 *    linked to it (to-dos, meetings, files, sessions, activity, the VDP mirror). An archived one that is in the book
 *    again comes back.
 *  - DC-21: an account with a real Org62 id that left my book (an opp moved away) loses its DC status and hours.
 */
export async function afterBookSync(w: WriteCtx, book: Pick<Org62Book, 'accounts' | 'opps' | 'accountMoves'>): Promise<number> {
  let n = 0;
  const inBook = new Set(book.accounts.map((a) => id15(a.org62AccountId)));
  const rows = (
    await w.tx.execute<{ id: string; org62: string | null; name: string; archived: boolean }>(sql`
      select id::text as id, org62_account_id as org62, name, archived_at is not null as archived from accounts where owner_user_id = ${w.userId}`)
  ).rows;
  const byOrg62 = new Map(rows.filter((r) => isOrg62Id(r.org62, '001')).map((r) => [id15(r.org62!), r] as const));

  // an account merged away earlier that is in my book again: back
  for (const r of rows) {
    if (!r.archived || !r.org62 || !inBook.has(id15(r.org62))) continue;
    const x = w.kv.get(extKey('accounts', r.id)) as { mergedInto?: string } | undefined;
    if (!x?.mergedInto) continue;
    await w.tx.execute(sql`update accounts set archived_at = null, updated_at = now() where id = ${r.id}::uuid`);
    await mergeExt(w, 'accounts', r.id, { mergedInto: null });
    n++;
  }

  for (const m of accountMerges(book)) {
    const from = byOrg62.get(id15(m.from));
    const to = byOrg62.get(id15(m.to));
    if (!from || !to || from.id === to.id || from.archived || inBook.has(id15(m.from))) continue;
    await w.tx.execute(sql`update accounts set archived_at = ${w.now.toISOString()}::timestamptz, updated_at = now() where id = ${from.id}::uuid and archived_at is null`);
    await mergeExt(w, 'accounts', from.id, { mergedInto: to.id, dcStatus: null, hoursQtd: null });
    await w.tx.execute(sql`
      insert into account_aliases (account_id, kind, value, normalized_value, source)
      values (${to.id}::uuid, 'name', ${from.name}, ${from.name.trim().toLowerCase()}, 'seed')
      on conflict (account_id, kind, normalized_value) do nothing`);
    for (const t of RELINK_TABLES) await w.tx.execute(sql`update ${sql.identifier(t)} set account_id = ${to.id}::uuid where owner_user_id = ${w.userId} and account_id = ${from.id}::uuid`);
    from.archived = true;
    n++;
  }

  // DC-21: the state of an account that left my book (an opp moved to another account) is cleared
  for (const r of rows) {
    if (r.archived || !isOrg62Id(r.org62, '001') || inBook.has(id15(r.org62!))) continue;
    const x = w.kv.get(extKey('accounts', r.id)) as { dcStatus?: string; hoursQtd?: number } | undefined;
    if (!x?.dcStatus && !x?.hoursQtd) continue;
    if (await mergeExt(w, 'accounts', r.id, { dcStatus: null, hoursQtd: null })) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// DC-25: account DC status no open opp of mine supports
// ---------------------------------------------------------------------------

/**
 * An account whose stored DC status says assigned / partial / requested with no open opp of mine (team or a live
 * DC) behind it: the status goes ("requested" is never stored any more: Chase reads the requests). The projection
 * rewrites the status of every account in my book on each full pass; this is the net for the rest.
 */
export async function sweepStaleAccountDcStatus(w: WriteCtx): Promise<number> {
  const r = await w.tx.execute<{ id: string; status: string | null }>(sql`
    select a.id::text as id, coalesce(a.dc_status, s.value->>'dcStatus') as status from accounts a
      -- D-98: the column first; the kv copy only for a row the backfill has not reached
      left join user_settings s on s.owner_user_id = a.owner_user_id and s.key = 'cc.ext/accounts/' || a.id::text
     where a.owner_user_id = ${w.userId} and coalesce(a.dc_status, s.value->>'dcStatus') is not null
       and (coalesce(a.dc_status, s.value->>'dcStatus') = 'requested' or not exists (
         select 1 from opportunities o where o.owner_user_id = a.owner_user_id and o.account_id = a.id and not o.is_closed and o.archived_at is null
            and (o.on_my_team or exists (select 1 from deal_contributions dc where dc.owner_user_id = o.owner_user_id and dc.opportunity_id = o.id and dc.is_mine and dc.deleted_upstream_at is null))))`);
  let n = 0;
  for (const x of r.rows) if (await mergeExt(w, 'accounts', x.id, { dcStatus: null })) n++;
  return n;
}

// ---------------------------------------------------------------------------
// DC-32: opps a VDP I'm on links (the mirror)
// ---------------------------------------------------------------------------

/** My emails (the user row and my email identities): who "I" am on a VDP. */
async function myEmails(db: DbOrTx, userId: string): Promise<string[]> {
  const r = await db.execute<{ e: string | null }>(sql`
    select lower(email) as e from users where id = ${userId}
    union select lower(i.external_id) from person_identities i join users u on u.person_id = i.person_id where u.id = ${userId} and i.system = 'email'`);
  return r.rows.map((x) => x.e).filter((x): x is string => !!x);
}

/**
 * The open opps a live VDP I'm on links (DC-32: strong evidence for a DC gap, reason `vdp`), from the VDP mirror
 * (`vdp_records`, not gone, not archived) and its links (`linkVdp`, every opp id the VDP names). Read only.
 */
export async function loadVdpOppIds(db: Db, userId: string): Promise<Set<string>> {
  const records = (await loadVdpRecords(db, userId)).filter((r) => r.snapshot && !r.goneAt && !r.archived);
  if (!records.length) return new Set();
  const ents = await loadGapEntities(db, userId);
  const emails = await myEmails(db, userId);
  const open = new Set(ents.opps.filter((o) => o.isOpen).map((o) => o.id));
  return vdpOppIdsOf(
    records.map((r) => ({ linkedOppIds: linkVdp(r.snapshot!, ents.accounts, ents.opps).opportunityIds, onIt: !emails.length || onVdp(r.snapshot!, emails), live: !r.snapshot!.archivedAt })),
    open,
  );
}

// ---------------------------------------------------------------------------
// DC-22: opps deleted in Org62
// ---------------------------------------------------------------------------

/** Ids per `IN (…)` for the opp read-back (the same batch size as the Events' and DCs'). */
export const OPP_READBACK_FIELDS = 'Id, Name, AccountId, Account.Name, StageName, CloseDate, Amount, ForecastCategoryName, IsClosed, IsWon, SystemModstamp';

/** The fixed read-only SOQL of one opp batch (validated Salesforce ids only). */
export function oppReadbackSoql(ids: readonly string[], limit: number): string {
  const safe = ids.filter((i) => isOrg62Id(i, '006'));
  if (!safe.length) throw new RangeError('oppReadbackSoql: no valid ids');
  return `SELECT ${OPP_READBACK_FIELDS} FROM Opportunity WHERE Id IN (${safe.map((i) => `'${i}'`).join(', ')}) ORDER BY Id LIMIT ${limit}`;
}

/**
 * The opps the read-back re-reads by Id (DC-22): open, not archived, with a real Org62 id, that could become or are
 * a DC question: on my team, my hours this quarter, a finding (new or claimed), or a DC request in flight.
 */
export async function readbackOppIds(db: DbOrTx, userId: string): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`
    select distinct o.org62_opportunity_id as id from opportunities o
      left join user_settings s on s.owner_user_id = o.owner_user_id and s.key = 'cc.ext/opportunities/' || o.id::text
     where o.owner_user_id = ${userId} and not o.is_closed and o.archived_at is null and o.org62_opportunity_id ~ '^006[A-Za-z0-9]{12}'
       and (o.on_my_team or coalesce((s.value->>'hoursQtd')::numeric, 0) > 0
            or exists (select 1 from missed_opp_findings f where f.owner_user_id = o.owner_user_id and f.opportunity_id = o.id and f.status in ('new', 'reviewing', 'actioned'))
            or exists (select 1 from deal_contribution_requests q where q.owner_user_id = o.owner_user_id and q.opportunity_id = o.id and q.status not in ('dismissed', 'verified')))
     order by 1`);
  return r.rows.map((x) => x.id).filter((i) => isOrg62Id(i, '006'));
}

/**
 * Tombstone opps Org62 no longer has (asked for by Id, missing from a complete answer): the row is archived with
 * `deletedInOrg62At` (kept, never deleted; never a gap, never listed), its Org62 snapshots marked deleted so no pass
 * brings it back, its requests in flight withdrawn (`opp_deleted`) and its open findings resolved. Inside the
 * caller's change set.
 */
export async function markOppsDeleted(w: WriteCtx, org62OppIds: readonly string[]): Promise<number> {
  const ids = [...new Set(org62OppIds.map(id15))];
  if (!ids.length) return 0;
  const list = sql.join(ids.map((x) => sql`${x}`), sql`, `);
  const opps = await w.tx.execute<{ id: string }>(sql`
    update opportunities set archived_at = ${w.now.toISOString()}::timestamptz, updated_at = now()
     where owner_user_id = ${w.userId} and archived_at is null and org62_opportunity_id15 in (${list})
    returning id::text as id`);
  await w.tx.execute(sql`
    update source_items si set deleted_upstream_at = ${w.now.toISOString()}::timestamptz, updated_at = now()
     where si.owner_user_id = ${w.userId} and si.source = 'org62' and si.deleted_upstream_at is null
       and si.external_id ~ '^(Opportunity|OpportunityTeamMember|Book|MissedOpp):'
       and left(split_part(split_part(si.external_id, ':', 2), '@', 1), 15) in (${list})`);
  let n = 0;
  for (const o of opps.rows) {
    await mergeExt(w, 'opportunities', o.id, { deletedInOrg62At: w.now.toISOString() });
    const q = await w.tx.execute(sql`
      update deal_contribution_requests set status = 'dismissed', outcome = 'opp_deleted', updated_at = ${w.now.toISOString()}::timestamptz
       where owner_user_id = ${w.userId} and opportunity_id = ${o.id}::uuid and status not in ('dismissed', 'verified')`);
    const f = await w.tx.execute(sql`
      update missed_opp_findings set status = 'resolved', updated_at = ${w.now.toISOString()}::timestamptz
       where owner_user_id = ${w.userId} and opportunity_id = ${o.id}::uuid and status in ('new', 'reviewing', 'actioned')`);
    n += 1 + (q.rowCount ?? 0) + (f.rowCount ?? 0);
  }
  return n;
}
