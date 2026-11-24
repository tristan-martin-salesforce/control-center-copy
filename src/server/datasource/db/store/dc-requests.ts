/**
 * Deal Contribution requests and my DCs in Postgres.
 *
 * - `deal_contribution_requests` (audited by the change-set triggers, so Undo of a create removes the row, and Undo
 *   of an edit or a withdraw restores it). Shapes and the rules are shared with the mock (src/server/deals/dc-requests.ts).
 * - `deal_contributions`: my DCs as the Org62 scans read them (written by the projection run, `syncMyDcs`; not
 *   audited, like org62_events). What a request is checked against, and what confirms one.
 */
import { and, eq, sql } from 'drizzle-orm';

import { DcRequestOutcome, type DcRequest, type DcRequestKind, type DcRequestStatus, type Draft, type MyDc, type MyDcRow } from '@/contract';
import type { DbOrTx } from '@/db/client';
import { dealContributionRequests, dealContributions } from '@/db/schema';
import { featureActive } from '@/personas';
import type { Org62Book } from '@/projections/types';
import {
  dcHolds,
  dcRequestOrder,
  dcRequestView,
  myDcsByOpp,
  ORG62_OPP_ID,
  pendingDcAdds,
  reconcileDcRequests,
  spendNotCreated,
  type DcAdd,
  type DcHolds,
  type DcLiveState,
  type DcRead,
  type DcRequestRecord,
} from '@/server/deals/dc-requests';

import { draftStatusFromDb, type DbDraftStatus } from '../enums';
import { readMemo } from '../reads/session';
import type { WriteCtx } from './common';
import { afterBookSync, clearStaleDcFlags, lastDcRead, rememberDcRead, withdrawVdpItemsOutOfScope } from './deals-sync';
import { loadPersona } from './persona';

type Row = {
  id: string;
  opportunity_id: string;
  kind: string;
  role: string;
  split_percent: string | number;
  from_split: string | number | null;
  comment: string | null;
  status: DcRequestStatus;
  approved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  org62_dc_id: string | null;
  opp_name: string | null;
  account_id: string | null;
  account_name: string | null;
  org62_opportunity_id: string | null;
  outcome: string | null;
};

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const numOrNull = (v: string | number | null) => (v === null || v === undefined ? null : Number(v));

/** The canvas items' DC rows (pending ones hold them, sent ones handed them off), from the drafts' stored payloads. */
export function loadDcHolds(db: DbOrTx, userId: string): Promise<DcHolds> {
  // GET /needs reads them twice (the DC requests and the waiting count): once per request inside the read memo
  return readMemo(db, `dcHolds:${userId}`, () => readDcHolds(db, userId));
}

async function readDcHolds(db: DbOrTx, userId: string): Promise<DcHolds> {
  const r = await db.execute<{ id: string; status: DbDraftStatus; payload: Draft['destination'] | null; result_url: string | null }>(sql`
    select id, status::text as status, payload, result_url from drafts
     where owner_user_id = ${userId} and payload ->> 'action' = 'slack_canvas.create'`);
  return dcHolds(r.rows.filter((d) => d.payload).map((d) => ({ id: d.id, status: draftStatusFromDb(d.status), destination: d.payload!, resultUrl: d.result_url })));
}

type DcRowDb = { id: string; org62_dc_id: string; opportunity_id: string | null; role: string | null; split_percent: string | number | null; last_seen_at: Date | string | null; opp_name: string | null; org62_opportunity_id: string | null; account_id: string | null; account_name: string | null; is_closed: boolean | null };

/** When each canvas item reached Slack (its sent time; else when it last changed), for the not-created rule (DC-06). */
export async function loadCanvasDelivered(db: DbOrTx, userId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
  const want = [...new Set(ids)].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!want.length) return new Map();
  const r = await db.execute<{ id: string; at: Date | string | null }>(sql`
    select id::text as id, coalesce(sent_at, staged_at, verified_at, updated_at) as at from drafts
     where owner_user_id = ${userId} and id::text in (${sql.join(want.map((x) => sql`${x}`), sql`, `)})`);
  return new Map(r.rows.map((x) => [x.id, x.at ? iso(x.at) : null] as const));
}

/** My DCs the scans have read (not removed upstream), newest first; and by app opportunity id, summed (DC-14). */
export async function loadMyDcs(db: DbOrTx, userId: string): Promise<{ rows: MyDcRow[]; byOpp: Map<string, MyDc> }> {
  const r = await db.execute<DcRowDb>(sql`
    select dc.id, dc.org62_dc_id, dc.opportunity_id, dc.role, dc.split_percent, dc.last_seen_at,
           o.name as opp_name, o.org62_opportunity_id, o.account_id, a.name as account_name, o.is_closed
      from deal_contributions dc
      left join opportunities o on o.id = dc.opportunity_id
      left join accounts a on a.id = o.account_id
     where dc.owner_user_id = ${userId} and dc.is_mine and dc.deleted_upstream_at is null
     order by dc.last_seen_at desc nulls last, dc.org62_dc_id`);
  const rows: MyDcRow[] = [];
  for (const x of r.rows) {
    const dc: MyDc = { split: numOrNull(x.split_percent), role: x.role, org62DcId: x.org62_dc_id, lastSeenAt: x.last_seen_at ? iso(x.last_seen_at) : null };
    if (!x.opportunity_id) continue;
    rows.push({ ...dc, oppId: x.opportunity_id, oppName: x.opp_name ?? x.opportunity_id, org62OpportunityId: x.org62_opportunity_id && ORG62_OPP_ID.test(x.org62_opportunity_id) ? x.org62_opportunity_id : null, accountId: x.account_id, accountName: x.account_name, isOpen: !x.is_closed });
  }
  return { rows, byOpp: myDcsByOpp(rows) };
}

/** What the canvas Apply preflight checks a DC row against (DC-05 `dcRowStillNeeded`): my DCs and the requests now. */
export async function loadDcLiveState(db: DbOrTx, userId: string): Promise<DcLiveState> {
  const mine = await loadMyDcs(db, userId);
  return { myDcs: mine.rows, requests: await loadDcRequests(db, userId, undefined, mine.byOpp) };
}

const recordOf = (x: Row): DcRequestRecord => ({
  id: x.id,
  oppId: x.opportunity_id,
  kind: (x.kind === 'change' ? 'change' : 'add') as DcRequestKind,
  role: x.role,
  splitPercent: Number(x.split_percent),
  fromSplit: numOrNull(x.from_split),
  comment: x.comment,
  status: x.status,
  approvedAt: x.approved_at ? iso(x.approved_at) : null,
  createdAt: iso(x.created_at),
  updatedAt: iso(x.updated_at),
  org62DcId: x.org62_dc_id,
  outcome: DcRequestOutcome.safeParse(x.outcome).success ? (x.outcome as DcRequestRecord['outcome']) : null,
});

export function loadDcRequests(db: DbOrTx, userId: string, holds?: DcHolds, mine?: Map<string, MyDc>): Promise<DcRequest[]> {
  // Home reads them twice (the Deals needs and the waiting-for-a-canvas count): once per request (reads/session.ts)
  if (!holds && !mine) return readMemo(db, `dcRequests:${userId}`, () => readDcRequests(db, userId));
  return readDcRequests(db, userId, holds, mine);
}

async function readDcRequests(db: DbOrTx, userId: string, holds?: DcHolds, mine?: Map<string, MyDc>): Promise<DcRequest[]> {
  const rows = (
    await db.execute<Row>(sql`
      select r.id, r.opportunity_id, r.kind, r.role, r.split_percent, r.from_split, r.comment, r.status::text as status, r.approved_at, r.created_at, r.updated_at,
             dc.org62_dc_id, o.name as opp_name, o.account_id, a.name as account_name, o.org62_opportunity_id, r.outcome
        from deal_contribution_requests r
        join opportunities o on o.id = r.opportunity_id
        left join accounts a on a.id = o.account_id
        left join deal_contributions dc on dc.id = r.deal_contribution_id
       where r.owner_user_id = ${userId}
       order by r.created_at desc, r.id`)
  ).rows;
  const recs = rows.map((x) => ({ x, r: recordOf(x), org62: x.org62_opportunity_id && ORG62_OPP_ID.test(x.org62_opportunity_id) ? x.org62_opportunity_id : null }));
  const h = spendNotCreated(holds ?? (await loadDcHolds(db, userId)), recs.map((v) => ({ r: v.r, org62OppId: v.org62 })));
  const dcs = mine ?? (await loadMyDcs(db, userId)).byOpp;
  return recs.map(({ x, r }) => dcRequestView(r, { name: x.opp_name ?? x.opportunity_id, accountId: x.account_id, accountName: x.account_name, org62OpportunityId: x.org62_opportunity_id }, h, undefined, dcs.get(x.opportunity_id) ?? null)).sort(dcRequestOrder);
}

/**
 * Every request as the Deals needs read it (DC-12: only a live one makes an opp handled; DC-06: Chase from the ones
 * handed off): the views, with stage.
 */
export async function loadDcRequestStatuses(db: DbOrTx, userId: string): Promise<DcRequest[]> {
  return loadDcRequests(db, userId);
}

/** The DC rows the next logging batch takes (lane F's one call in log-batch.ts). */
export async function dbPendingDcAdds(db: DbOrTx, userId: string): Promise<DcAdd[]> {
  return pendingDcAdds(await loadDcRequests(db, userId));
}

/** The deal_contributions row id for my DC with this Org62 id (a change's target, a confirmation's link). */
async function dcRowId(w: WriteCtx, org62DcId: string | null): Promise<string | null> {
  if (!org62DcId) return null;
  const [r] = await w.tx.select({ id: dealContributions.id }).from(dealContributions).where(and(eq(dealContributions.ownerUserId, w.userId), eq(dealContributions.org62DcId, org62DcId))).limit(1);
  return r?.id ?? null;
}

export async function insertDcRequest(w: WriteCtx, rec: DcRequestRecord, o: { missedOppFindingId?: string | null } = {}): Promise<void> {
  await w.tx.insert(dealContributionRequests).values({
    id: rec.id,
    ownerUserId: w.userId,
    opportunityId: rec.oppId,
    kind: rec.kind,
    role: rec.role,
    splitPercent: rec.splitPercent,
    fromSplit: rec.fromSplit,
    comment: rec.comment,
    status: rec.status,
    approvedAt: rec.approvedAt ? new Date(rec.approvedAt) : null,
    approvalMethod: rec.approvedAt ? 'click' : null,
    dealContributionId: await dcRowId(w, rec.org62DcId),
    missedOppFindingId: o.missedOppFindingId ?? null,
    createdAt: new Date(rec.createdAt),
    updatedAt: new Date(rec.updatedAt),
  });
}

/** An edit (split, role, comment and what it now is) or a withdraw (status dismissed) of one request. */
export async function updateDcRequest(w: WriteCtx, id: string, patch: Partial<Pick<DcRequestRecord, 'kind' | 'role' | 'splitPercent' | 'fromSplit' | 'comment' | 'status' | 'org62DcId' | 'outcome'>>): Promise<void> {
  const set: Partial<typeof dealContributionRequests.$inferInsert> = { updatedAt: w.now };
  if (patch.outcome !== undefined) set.outcome = patch.outcome;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.splitPercent !== undefined) set.splitPercent = patch.splitPercent;
  if (patch.fromSplit !== undefined) set.fromSplit = patch.fromSplit;
  if (patch.comment !== undefined) set.comment = patch.comment;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.org62DcId !== undefined) set.dealContributionId = await dcRowId(w, patch.org62DcId);
  await w.tx.update(dealContributionRequests).set(set).where(and(eq(dealContributionRequests.id, id), eq(dealContributionRequests.ownerUserId, w.userId)));
}

/**
 * The pending DC rows (adds and changes) when the persona's `dealContributions` feature is active: they ride on the
 * next batch's canvas, or on a canvas of their own when asked (Log DCs now). The one call log-batch.ts makes.
 */
export async function pendingDcsFor(db: DbOrTx, userId: string): Promise<DcAdd[]> {
  if (!featureActive(await loadPersona(db, userId), 'dealContributions')) return [];
  return dbPendingDcAdds(db, userId);
}

// ---------------------------------------------------------------------------
// The projection run: my DCs from the Org62 scans, and the requests they confirm
// ---------------------------------------------------------------------------

export interface MyDcProjection {
  org62DcId: string;
  /** The app opportunity it is on (null when the app has no row for it). */
  opportunityId: string | null;
  role: string | null;
  splitPercent: number | null;
  /** When the scans last read it. */
  seenAt: string | null;
  sourceItemId: string | null;
}

/** What the projection pass knows beyond my DCs (absent: a caller with only the DCs, such as a test). */
export interface DcSyncContext {
  /** The Org62 book this full pass projected: its complete read (DC-06), the accounts in my book (DC-21, DC-24). */
  book?: Pick<Org62Book, 'accounts' | 'opps' | 'bookRead' | 'accountMoves'>;
}

/**
 * Mirror my DCs into `deal_contributions` (insert, update what changed, mark one the scans no longer read as removed
 * upstream, bring a removed one back), then what follows from them (D-68): `dcAssigned` off where my DC is gone
 * (DC-11), the requests reconciled (confirmed, withdrawn, not created: `confirmDcRequests`), VDP items for accounts
 * that left the 100% scope withdrawn (DC-10), and, given the book, the accounts that left it or were merged (DC-21,
 * DC-24). Returns how many rows it wrote (0 on a pass that changed nothing).
 */
export async function syncMyDcs(w: WriteCtx, dcs: readonly MyDcProjection[], meOrg62UserId: string | null, o: DcSyncContext = {}): Promise<number> {
  let n = 0;
  const cur = await w.tx.select().from(dealContributions).where(and(eq(dealContributions.ownerUserId, w.userId), eq(dealContributions.isMine, true)));
  const by = new Map(cur.map((r) => [r.org62DcId.slice(0, 15), r] as const));
  const seen = new Set<string>();
  for (const d of dcs) {
    const k = d.org62DcId.slice(0, 15);
    if (seen.has(k)) continue;
    seen.add(k);
    const split = d.splitPercent === null ? null : Math.round(d.splitPercent * 100) / 100; // numeric(5,2)
    const lastSeen = d.seenAt ? new Date(d.seenAt) : w.now;
    const row = by.get(k);
    if (!row) {
      await w.tx.insert(dealContributions).values({ ownerUserId: w.userId, org62DcId: d.org62DcId, opportunityId: d.opportunityId, contributorPersonId: w.me.id, contributorOrg62UserId: meOrg62UserId, isMine: true, role: d.role, splitPercent: split, sourceItemId: d.sourceItemId, firstSeenAt: lastSeen, lastSeenAt: lastSeen });
      n++;
      continue;
    }
    const changed = row.opportunityId !== (d.opportunityId ?? row.opportunityId) || row.role !== (d.role ?? row.role) || numOrNull(row.splitPercent) !== (split ?? numOrNull(row.splitPercent)) || row.deletedUpstreamAt !== null || (d.seenAt !== null && row.lastSeenAt.getTime() < lastSeen.getTime());
    if (!changed) continue;
    await w.tx
      .update(dealContributions)
      .set({ opportunityId: d.opportunityId ?? row.opportunityId, role: d.role ?? row.role, splitPercent: split ?? row.splitPercent, sourceItemId: d.sourceItemId ?? row.sourceItemId, deletedUpstreamAt: null, lastSeenAt: row.lastSeenAt.getTime() < lastSeen.getTime() ? lastSeen : row.lastSeenAt })
      .where(eq(dealContributions.id, row.id));
    n++;
  }
  // a DC the full recompute no longer projects was removed in Org62 (the book read no longer returns it, the read-back
  // found it deleted, or it is another SE's now: DC-13): kept, marked
  const removedOn: string[] = [];
  for (const row of cur) {
    if (seen.has(row.org62DcId.slice(0, 15)) || row.deletedUpstreamAt) continue;
    await w.tx.update(dealContributions).set({ deletedUpstreamAt: w.now }).where(eq(dealContributions.id, row.id));
    if (row.opportunityId) removedOn.push(row.opportunityId);
    n++;
  }
  n += await clearStaleDcFlags(w, removedOn);
  const read = o.book?.bookRead?.authoritative ? { at: o.book.bookRead.at, complete: true } : null;
  n += await rememberDcRead(w, read);
  n += await confirmDcRequests(w, read ? { read } : {});
  n += await withdrawVdpItemsOutOfScope(w);
  if (o.book) n += await afterBookSync(w, o.book);
  return n;
}

/**
 * Reconcile the requests in flight with my DCs now (`reconcileDcRequests`, D-68): confirmed (`verified`, linked to my
 * DC: an add whatever its split, a change at the requested split or, handed off, once it moved), withdrawn by the app
 * (`dismissed` + outcome: a waiting change whose DC was changed in Org62 or removed), or `not_created` (handed off, and
 * a complete read at least 12 h after the canvas shows no such DC: the opp is a gap again, its claimed finding new
 * again). `read`: the complete read to judge by (default: the newest one remembered). Returns the rows it wrote.
 */
export async function confirmDcRequests(w: WriteCtx, o: { read?: DcRead | null } = {}): Promise<number> {
  const live = await w.tx.execute<{ n: number }>(sql`
    select count(*)::int as n from deal_contribution_requests where owner_user_id = ${w.userId} and status not in ('dismissed', 'verified')`);
  if (!live.rows[0]?.n) return 0;
  const holds = await loadDcHolds(w.tx, w.userId);
  const { byOpp } = await loadMyDcs(w.tx, w.userId);
  const requests = await loadDcRequests(w.tx, w.userId, holds, byOpp);
  const read = o.read ?? (await lastDcRead(w.tx, w.userId));
  const deliveredAt = await loadCanvasDelivered(w.tx, w.userId, requests.map((r) => r.canvasDraftId).filter((x): x is string => !!x));
  const open = new Set(
    (await w.tx.execute<{ id: string }>(sql`select id::text as id from opportunities where owner_user_id = ${w.userId} and not is_closed and archived_at is null`)).rows.map((x) => x.id),
  );
  const plan = reconcileDcRequests({ requests, read, deliveredAt, openOppIds: open });
  let n = 0;
  for (const r of plan.confirm) {
    const rowId = await dcRowId(w, r.dc?.org62DcId ?? null);
    await w.tx
      .update(dealContributionRequests)
      .set({ status: 'verified', ...(rowId ? { dealContributionId: rowId } : {}), updatedAt: w.now })
      .where(and(eq(dealContributionRequests.id, r.id), eq(dealContributionRequests.ownerUserId, w.userId)));
    n++;
  }
  for (const { request: r, outcome } of plan.close) {
    await w.tx
      .update(dealContributionRequests)
      .set({ status: 'dismissed', outcome, updatedAt: w.now })
      .where(and(eq(dealContributionRequests.id, r.id), eq(dealContributionRequests.ownerUserId, w.userId)));
    n++;
    // not created: the finding it claimed is open again (the sweep's Claim is evidence for the gap once more)
    if (outcome === 'not_created') {
      const f = await w.tx.execute(sql`
        update missed_opp_findings f set status = 'new', updated_at = ${w.now.toISOString()}::timestamptz
          from deal_contribution_requests q
         where q.id = ${r.id}::uuid and f.id = q.missed_opp_finding_id and f.owner_user_id = ${w.userId} and f.status = 'actioned'`);
      n += f.rowCount ?? 0;
    }
  }
  return n;
}

/**
 * HYG-1 (the daily hygiene sweep's entry): the same reconcile. A request handed to Slackbot whose opp now has my DC
 * is confirmed whatever the split Org62 shows (Org62 is the record); a change once my DC's split moved off what it was
 * when asked; and a hand-off a complete read shows was never created is `not_created` (DC-25: never stranded).
 */
export async function confirmHandedOffDcRequests(w: WriteCtx): Promise<number> {
  return confirmDcRequests(w);
}

