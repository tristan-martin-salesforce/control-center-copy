/**
 * D-67: VDP use cases → Org62 Use_Case__c in Postgres.
 *
 * - `org62_use_cases`: the records on my opps the Org62 read-back reads (src/jobs/handlers/org62-readback.ts) and the
 *   VDP use case each one is; `org62_use_case_reads`: when that read last ran. Not audited (read-only state of an
 *   external system plus the link, like org62_events and vdp_records): a read replaces what it saw.
 * - The plan (src/engines/activity/use-cases.ts planUseCases) runs over the live VDP mirror (vdp_records), my opps and
 *   accounts, those records and the logging canvases in drafts; `pendingUseCasesFor` is the one call log-batch.ts
 *   makes, and `loadUseCaseSync` is getUseCaseSync.
 * Logs and errors carry counts and codes only.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Draft, UseCaseSyncPayload } from '@/contract';
import type { Db, DbOrTx } from '@/db/client';
import { org62UseCaseReads, org62UseCases } from '@/db/schema';
import { planUseCases, reconcileUseCaseLinks, ucInScope, ucNormalizeVdp, type Org62UseCase, type UcOpp, type UcVdp, type UseCaseLink, type UseCasePlan, type UseCasePlanInput } from '@/engines/activity/use-cases';
import type { RowOverrides } from '@/lib/canvas/overrides';
import { featureActive } from '@/personas';
import { ucDecisionsOf, ucHolds, ucSyncView } from '@/server/deals/use-cases';

import { draftStatusFromDb, type DbDraftStatus } from '../enums';
import { loadRowOverridesTable } from '../canvas-overrides';
import { loadNeedDecisions } from '../needs-decisions';
import { readMemo } from '../reads/session';
import { loadPersona } from './persona';
import { loadGapEntities, loadVdpRecords } from './vdp';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const id15 = (s: string) => s.slice(0, 15);

/** My Org62 user id (the OwnerId of the records the app creates), or null before onboarding found it. */
export async function myOrg62UserId(db: DbOrTx, userId: string): Promise<string | null> {
  const r = await db.execute<{ external_id: string | null }>(sql`
    select pi.external_id from users u join person_identities pi on pi.person_id = u.person_id and pi.system = 'org62_user'
     where u.id = ${userId} limit 1`);
  return r.rows[0]?.external_id ?? null;
}

/** My opps (with their Org62 and account ids, and my DC split: D-63's scope) as the plan reads them. */
export async function loadUcOpps(db: Db, userId: string): Promise<UcOpp[]> {
  const ents = await loadGapEntities(db, userId);
  const acc = new Map(ents.accounts.map((a) => [a.id, a.org62AccountId] as const));
  return ents.opps
    .filter((o): o is typeof o & { org62OpportunityId: string } => !!o.org62OpportunityId)
    .map((o) => ({ id: o.id, org62Id: o.org62OpportunityId, name: o.name, accountId: o.accountId, accountOrg62Id: o.accountId ? (acc.get(o.accountId) ?? null) : null, isOpen: o.isOpen, dcSplit: o.dcSplit, closeDate: o.closeDate }));
}

/** My VDPs from the mirror, with the account each links to: live ones, and the ones gone from my list. */
export async function loadUcVdps(db: DbOrTx, userId: string): Promise<{ live: UcVdp[]; gone: UcVdp[] }> {
  const rows = (await loadVdpRecords(db, userId)).filter((r) => r.snapshot);
  // the row's own slug fills a snapshot that lacks one (a partial or older mirror row is read safely, never thrown on)
  const of = (r: (typeof rows)[number]): UcVdp => ucNormalizeVdp({ snapshot: r.snapshot!, accountId: r.accountId }, r.vdpSlug);
  return { live: rows.filter((r) => !r.goneAt).map(of), gone: rows.filter((r) => r.goneAt).map(of) };
}

/** The use-case decisions (D-61 `use_case` / `use_case_readd`), from need_decisions (D-98; kv fallback until backfilled). */
export async function loadUcDecisions(db: DbOrTx, userId: string) {
  return ucDecisionsOf((await loadNeedDecisions(db, userId)).filter((d) => d.rule.startsWith('use_case')));
}

type RecRow = typeof org62UseCases.$inferSelect;

const recordOf = (r: RecRow): Org62UseCase => ({
  id: r.org62UseCaseId,
  opportunityId: r.org62OpportunityId,
  accountId: r.org62AccountId,
  name: r.name,
  ownerId: r.ownerOrg62Id,
  createdById: r.createdByOrg62Id,
  stage: r.stage,
  goLive: r.goLiveDate,
  product: r.product,
  createdAt: iso(r.org62CreatedAt),
  goneAt: iso(r.goneAt),
});

/** The read-back's records on my opps, their links, and when it last read them. */
export async function loadOrg62UseCases(db: DbOrTx, userId: string): Promise<{ readAt: string | null; records: Org62UseCase[]; links: UseCaseLink[] }> {
  const rows = await db.select().from(org62UseCases).where(eq(org62UseCases.ownerUserId, userId));
  const [read] = await db.select({ readAt: org62UseCaseReads.readAt }).from(org62UseCaseReads).where(eq(org62UseCaseReads.ownerUserId, userId));
  return {
    readAt: iso(read?.readAt),
    records: rows.map(recordOf),
    links: rows
      .filter((r) => r.vdpUseCaseId && (r.linkOrigin === 'app' || r.linkOrigin === 'adopted'))
      .map((r) => ({ vdpUseCaseId: r.vdpUseCaseId!, org62UseCaseId: r.org62UseCaseId, origin: r.linkOrigin as UseCaseLink['origin'], syncedStage: r.syncedStage, syncedGoLive: r.syncedGoLive, syncedName: r.syncedName })),
  };
}

/** What the logging canvases hold (pending) or handed off (sent), from the drafts' stored payloads. */
export function loadUseCaseHolds(db: DbOrTx, userId: string): Promise<ReturnType<typeof ucHolds>> {
  // GET /needs reads them twice (the plan's inputs and the use-case candidates): once per request inside the read memo
  return readMemo(db, `useCaseHolds:${userId}`, () => readUseCaseHolds(db, userId));
}

async function readUseCaseHolds(db: DbOrTx, userId: string) {
  // a legacy canvas names the object in a cell (|Use_Case__c|); a WO-1 canvas has its own USE CASES TO CREATE / UPDATE tables
  const r = await db.execute<{ id: string; status: DbDraftStatus; payload: Draft['destination'] | null; updated_at: Date | string; sent_at: Date | string | null }>(sql`
    select id, status::text as status, payload, updated_at, coalesce(sent_at, approved_at) as sent_at from drafts
     where owner_user_id = ${userId} and payload ->> 'action' = 'slack_canvas.create' and (payload::text like '%|Use_Case__c|%' or payload::text like '%## USE CASES TO %')`);
  return ucHolds(r.rows.filter((d) => d.payload).map((d) => ({ id: d.id, status: draftStatusFromDb(d.status), destination: d.payload!, updatedAt: iso(d.updated_at)!, sentAt: iso(d.sent_at) })));
}

/** Everything the plan reads, from Postgres. */
/** Your edits on canvas rows before Apply (the canvas review), from canvas_row_overrides (D-98; kv fallback until backfilled). */
export async function loadRowOverrides(db: DbOrTx, userId: string): Promise<RowOverrides> {
  return loadRowOverridesTable(db, userId);
}

export function loadUseCaseInput(db: Db, userId: string): Promise<UseCasePlanInput> {
  // Home reads it twice (the VDP coverage and the waiting-for-a-canvas count): once per request (reads/session.ts)
  return readMemo(db, `useCaseInput:${userId}`, () => readUseCaseInput(db, userId));
}

async function readUseCaseInput(db: Db, userId: string): Promise<UseCasePlanInput> {
  // one after another: D-70's landing sync reads this inside a batch's transaction (one client, one query at a time)
  const vdps = await loadUcVdps(db, userId);
  const opps = await loadUcOpps(db, userId);
  const org62 = await loadOrg62UseCases(db, userId);
  const holds = await loadUseCaseHolds(db, userId);
  const me = await myOrg62UserId(db, userId);
  const decisions = await loadUcDecisions(db, userId);
  const overrides = await loadRowOverrides(db, userId);
  return { vdps: vdps.live, goneVdps: vdps.gone, opps, org62: { readAt: org62.readAt, records: org62.records }, links: org62.links, holds, me, decisions, overrides };
}

export async function loadUseCasePlan(db: Db, userId: string): Promise<{ plan: UseCasePlan; readAt: string | null }> {
  const input = await loadUseCaseInput(db, userId);
  return { plan: planUseCases(input), readAt: input.org62.readAt };
}

/** getUseCaseSync. */
export async function loadUseCaseSync(db: Db, userId: string): Promise<UseCaseSyncPayload> {
  const { plan, readAt } = await loadUseCasePlan(db, userId);
  return ucSyncView(plan, readAt);
}

/**
 * The VDP use-case rows waiting for a canvas (creates and Stage / Go-Live fixes), when the persona's `vdp` feature is
 * active: all of them ride on the next batch's canvas (src/server/time/batch-canvases.ts). The one call log-batch.ts makes.
 */
export async function pendingUseCasesFor(db: Db, userId: string): Promise<Pick<UseCasePlan, 'creates' | 'updates'>> {
  if (!featureActive(await loadPersona(db, userId), 'vdp')) return { creates: [], updates: [] };
  const { plan } = await loadUseCasePlan(db, userId);
  return { creates: plan.creates, updates: plan.updates };
}

// ---------------------------------------------------------------------------
// The read-back: store what it read, then tie records to VDP use cases
// ---------------------------------------------------------------------------

/** One Use_Case__c row as SOQL returns it (the fields of `ucReadbackSoql`). */
export interface Org62UseCaseRow {
  Id: string;
  Name?: string | null;
  OwnerId?: string | null;
  CreatedById?: string | null;
  CreatedDate?: string | null;
  Opportunity__c?: string | null;
  Account__c?: string | null;
  Use_Case_Name__c?: string | null;
  Product__c?: string | null;
  Stage__c?: string | null;
  Go_Live_Date__c?: string | null;
  SystemModstamp?: string | null;
}

export interface UseCaseReadResult {
  written: number;
  gone: number;
  linked: number;
  synced: number;
}

/**
 * Store one read of my opps' use cases: upsert every record returned, mark `gone_at` on a record a COMPLETE read of
 * its opp no longer returns (`completeOpps`), bring back one that returns, record the read, then tie records to VDP
 * use cases (reconcileUseCaseLinks). A partial read infers nothing about what it did not return.
 */
export async function saveOrg62UseCaseRead(db: Db, userId: string, o: { rows: readonly Org62UseCaseRow[]; completeOpps: readonly string[]; opps: number; complete: boolean; at: Date }): Promise<UseCaseReadResult> {
  const res: UseCaseReadResult = { written: 0, gone: 0, linked: 0, synced: 0 };
  await db.transaction(async (tx) => {
    const seen = new Set<string>();
    for (const r of o.rows) {
      if (!r.Id || seen.has(id15(r.Id))) continue;
      seen.add(id15(r.Id));
      const cols = {
        org62OpportunityId: r.Opportunity__c ?? null,
        org62AccountId: r.Account__c ?? null,
        name: r.Use_Case_Name__c ?? r.Name ?? null,
        product: r.Product__c ?? null,
        stage: r.Stage__c ?? null,
        goLiveDate: r.Go_Live_Date__c ? r.Go_Live_Date__c.slice(0, 10) : null,
        ownerOrg62Id: r.OwnerId ?? null,
        createdByOrg62Id: r.CreatedById ?? null,
        org62CreatedAt: r.CreatedDate ? new Date(r.CreatedDate) : null,
        org62ModifiedAt: r.SystemModstamp ? new Date(r.SystemModstamp) : null,
        lastSeenAt: o.at,
        goneAt: null,
      };
      await tx
        .insert(org62UseCases)
        .values({ ownerUserId: userId, org62UseCaseId: r.Id, firstSeenAt: o.at, ...cols })
        .onConflictDoUpdate({ target: [org62UseCases.ownerUserId, org62UseCases.org62UseCaseId], set: cols });
      res.written += 1;
    }
    const complete15 = [...new Set(o.completeOpps.map(id15))];
    if (complete15.length) {
      const g = await tx.execute(sql`
        update org62_use_cases set gone_at = ${o.at.toISOString()}::timestamptz, updated_at = now()
         where owner_user_id = ${userId} and gone_at is null
           and org62_opportunity_id15 = any(array[${sql.join(complete15.map((x) => sql`${x}::text`), sql`, `)}])
           and org62_use_case_id15 <> all(array[${sql.join([...seen, '-'].map((x) => sql`${x}::text`), sql`, `)}])`);
      res.gone = g.rowCount ?? 0;
    }
    await tx
      .insert(org62UseCaseReads)
      .values({ ownerUserId: userId, readAt: o.at, opps: o.opps, complete: o.complete })
      .onConflictDoUpdate({ target: [org62UseCaseReads.ownerUserId], set: { readAt: o.at, opps: o.opps, complete: o.complete } });
  });
  const r = await reconcileUseCases(db, userId, o.at);
  return { ...res, linked: r.linked, synced: r.synced };
}

/** Apply reconcileUseCaseLinks: new links (a record found for a VDP use case) and synced values that moved. */
export async function reconcileUseCases(db: Db, userId: string, at: Date): Promise<{ linked: number; synced: number }> {
  const input = await loadUseCaseInput(db, userId);
  const ch = reconcileUseCaseLinks(input);
  if (!ch.add.length && !ch.synced.length) return { linked: 0, synced: 0 };
  await db.transaction(async (tx) => {
    for (const l of ch.add) {
      // a use case added again after its record was deleted in Org62: the old (gone) record lets go of it
      await tx.execute(sql`update org62_use_cases set vdp_use_case_id = null, updated_at = now()
                            where owner_user_id = ${userId} and vdp_use_case_id = ${l.vdpUseCaseId} and org62_use_case_id <> ${l.org62UseCaseId}`);
      await tx
        .update(org62UseCases)
        .set({ vdpUseCaseId: l.vdpUseCaseId, linkOrigin: l.origin, syncedStage: l.syncedStage, syncedGoLive: l.syncedGoLive, syncedName: l.syncedName, linkedAt: at })
        .where(and(eq(org62UseCases.ownerUserId, userId), eq(org62UseCases.org62UseCaseId, l.org62UseCaseId), sql`${org62UseCases.vdpUseCaseId} is null`));
    }
    for (const s of ch.synced) {
      const set: Partial<typeof org62UseCases.$inferInsert> = {};
      if (s.syncedStage !== undefined) set.syncedStage = s.syncedStage;
      if (s.syncedGoLive !== undefined) set.syncedGoLive = s.syncedGoLive;
      if (s.syncedName !== undefined) set.syncedName = s.syncedName;
      await tx.update(org62UseCases).set(set).where(and(eq(org62UseCases.ownerUserId, userId), eq(org62UseCases.vdpUseCaseId, s.vdpUseCaseId)));
    }
  });
  return { linked: ch.add.length, synced: ch.synced.length };
}

/**
 * The Org62 opp ids whose use cases the read-back reads: my open opps with my 100% DC (D-63), plus the opps of records
 * the app linked (a use case goes live after its opp closed: its Stage still follows VDP).
 */
export async function ucReadOppIds(db: Db, userId: string): Promise<string[]> {
  const open = (await loadUcOpps(db, userId)).filter(ucInScope).map((o) => o.org62Id);
  const linked = await db.execute<{ id: string }>(sql`
    select distinct org62_opportunity_id as id from org62_use_cases
     where owner_user_id = ${userId} and vdp_use_case_id is not null and gone_at is null and org62_opportunity_id is not null`);
  const by15 = new Map<string, string>();
  for (const id of [...open, ...linked.rows.map((r) => r.id)]) if (!by15.has(id15(id))) by15.set(id15(id), id);
  return [...by15.values()].sort();
}
