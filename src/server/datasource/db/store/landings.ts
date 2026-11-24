/**
 * D-70 landings in Postgres: record_landings, landing_writes and use_cases (src/db/schema/landings.ts), read into the
 * shared shape (src/lib/landings/model.ts) and written back from one sync's changes. The sync itself is pure
 * (src/lib/landings/sync.ts) and the mock runs the same one over its memory.
 *
 * Not audited: these rows are the history the syncs keep, written inside a change set (a batch staged, a row taken off
 * a canvas) or outside one (a read, the worker after a read-back). Every sync takes a per-user advisory lock, so two
 * at once never insert the same landing twice.
 *
 * D-98 (09 R5): an Applied Slack or Gmail item is a landing too (record kind `message`, the draft's id, destination
 * `slack` / `gmail`), with one write per delivered attempt, recorded by `recordMessageLanding` in the delivery's own
 * change set (no new write path: the Outbox adapter already wrote). The D-70 sync (Org62, VDP) never sees them:
 * `loadLandingStore` reads only its own destinations.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Draft } from '@/contract';
import type { DeliveryRecord } from '@/outbox';
import { gmailLanding } from '@/outbox/adapters/gmail';
import { slackLanding, type MessageLanding } from '@/outbox/adapters/slack';
import type { Db, DbOrTx } from '@/db/client';
import { landingWrites, recordLandings, useCases as useCasesTable } from '@/db/schema';
import { planUseCases } from '@/engines/activity/use-cases';
import { applyChanges, noChanges, type LandingRow, type LandingStore, type StoreChanges, type UseCaseRow, type Values, type WriteRow } from '@/lib/landings/model';
import { syncLandings, type LandingWorld } from '@/lib/landings/sync';
import { featureActive, personaOf } from '@/personas';

import type { ReadModel } from '../model';
import { loadDcRequests, loadMyDcs } from './dc-requests';
import { loadUseCaseInput } from './use-cases';
import { loadCandidates } from './vdp-candidates';

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** The destinations the D-70 sync owns. */
const SYNC_DESTINATIONS = ['org62', 'vdp'];
const at = (s: string | null) => (s ? new Date(s) : null);

export async function loadLandingStore(db: DbOrTx, userId: string): Promise<LandingStore> {
  // one after another: inside a transaction (a batch's) one client runs one query at a time
  // D-70's destinations only: a message landing (slack / gmail, D-98) is the Outbox's history, not the sync's
  const ls = await db.select().from(recordLandings).where(and(eq(recordLandings.ownerUserId, userId), inArray(recordLandings.destination, SYNC_DESTINATIONS))).orderBy(recordLandings.createdAt, recordLandings.id);
  const mine = new Set(ls.map((l) => l.id));
  const ws = (await db.select().from(landingWrites).where(eq(landingWrites.ownerUserId, userId)).orderBy(landingWrites.createdAt, landingWrites.id)).filter((w) => mine.has(w.landingId));
  const us = await db.select().from(useCasesTable).where(eq(useCasesTable.ownerUserId, userId)).orderBy(useCasesTable.createdAt, useCasesTable.id);
  return {
    landings: ls.map(
      (l): LandingRow => ({
        id: l.id,
        recordKind: l.recordKind as LandingRow['recordKind'],
        recordId: l.recordId,
        destination: l.destination as LandingRow['destination'],
        externalId: l.externalId,
        state: l.state as LandingRow['state'],
        remoteValues: (l.remoteValues as Values | null) ?? null,
        verifiedAt: iso(l.verifiedAt),
        lastReadAt: iso(l.lastReadAt),
        createdAt: iso(l.createdAt)!,
        updatedAt: iso(l.updatedAt)!,
      }),
    ),
    writes: ws.map(
      (w): WriteRow => ({
        id: w.id,
        landingId: w.landingId,
        draftId: w.draftId,
        rowKey: w.rowKey,
        op: w.op as WriteRow['op'],
        before: (w.before as Values | null) ?? null,
        after: (w.after as Values) ?? {},
        state: w.state as WriteRow['state'],
        origin: w.origin as WriteRow['origin'],
        reason: w.reason,
        sentAt: iso(w.sentAt),
        verifiedAt: iso(w.verifiedAt),
        createdAt: iso(w.createdAt)!,
        updatedAt: iso(w.updatedAt)!,
      }),
    ),
    useCases: us.map(
      (u): UseCaseRow => ({
        id: u.id,
        vdpUseCaseId: u.vdpUseCaseId,
        org62UseCaseId: u.org62UseCaseId,
        vdpSlug: u.vdpSlug,
        title: u.title,
        accountId: u.accountId,
        opportunityId: u.opportunityId,
        org62OpportunityId: u.org62OpportunityId,
        createdAt: iso(u.createdAt)!,
        updatedAt: iso(u.updatedAt)!,
      }),
    ),
  };
}

const landingCols = (l: LandingRow) => ({ recordKind: l.recordKind, recordId: l.recordId, destination: l.destination, externalId: l.externalId, state: l.state, remoteValues: l.remoteValues, verifiedAt: at(l.verifiedAt), lastReadAt: at(l.lastReadAt), updatedAt: new Date(l.updatedAt) });
const writeCols = (w: WriteRow) => ({ landingId: w.landingId, draftId: w.draftId, rowKey: w.rowKey, op: w.op, before: w.before, after: w.after, state: w.state, origin: w.origin, reason: w.reason, sentAt: at(w.sentAt), verifiedAt: at(w.verifiedAt), updatedAt: new Date(w.updatedAt) });
const ucCols = (u: UseCaseRow) => ({ vdpUseCaseId: u.vdpUseCaseId, org62UseCaseId: u.org62UseCaseId, vdpSlug: u.vdpSlug, title: u.title, accountId: u.accountId, opportunityId: u.opportunityId, org62OpportunityId: u.org62OpportunityId, updatedAt: new Date(u.updatedAt) });

/** Write one sync's changes, in an order every constraint holds through (identities first, removals last). */
export async function applyLandingChanges(db: DbOrTx, userId: string, c: StoreChanges): Promise<void> {
  if (noChanges(c)) return;
  // a merged identity gives up its ids before the row it merged into takes them
  if (c.useCases.remove.length) await db.update(useCasesTable).set({ vdpUseCaseId: null, org62UseCaseId: null }).where(and(eq(useCasesTable.ownerUserId, userId), inArray(useCasesTable.id, c.useCases.remove)));
  for (const u of c.useCases.update) await db.update(useCasesTable).set({ vdpUseCaseId: null, org62UseCaseId: null }).where(and(eq(useCasesTable.ownerUserId, userId), eq(useCasesTable.id, u.id)));
  for (const u of c.useCases.update) await db.update(useCasesTable).set(ucCols(u)).where(and(eq(useCasesTable.ownerUserId, userId), eq(useCasesTable.id, u.id)));
  if (c.useCases.insert.length) await db.insert(useCasesTable).values(c.useCases.insert.map((u) => ({ id: u.id, ownerUserId: userId, createdAt: new Date(u.createdAt), ...ucCols(u) })));
  // landings: updates first (a merged one moves its record id onto a free key), then the new ones
  for (const l of c.landings.update) await db.update(recordLandings).set(landingCols(l)).where(and(eq(recordLandings.ownerUserId, userId), eq(recordLandings.id, l.id)));
  if (c.landings.insert.length) await db.insert(recordLandings).values(c.landings.insert.map((l) => ({ id: l.id, ownerUserId: userId, createdAt: new Date(l.createdAt), ...landingCols(l) })));
  for (const w of c.writes.update) await db.update(landingWrites).set(writeCols(w)).where(and(eq(landingWrites.ownerUserId, userId), eq(landingWrites.id, w.id)));
  if (c.writes.insert.length) await db.insert(landingWrites).values(c.writes.insert.map((w) => ({ id: w.id, ownerUserId: userId, createdAt: new Date(w.createdAt), ...writeCols(w) })));
  if (c.landings.remove.length) await db.delete(recordLandings).where(and(eq(recordLandings.ownerUserId, userId), inArray(recordLandings.id, c.landings.remove)));
  if (c.useCases.remove.length) await db.delete(useCasesTable).where(and(eq(useCasesTable.ownerUserId, userId), inArray(useCasesTable.id, c.useCases.remove)));
}

/** An activity row's Org62 Event id (the Event it was read back as, else the one it updates). */
export async function loadEventIds(db: DbOrTx, userId: string): Promise<Map<string, string>> {
  const r = await db.execute<{ id: string; event_id: string | null }>(sql`
    select a.id, coalesce(e.org62_event_id, a.target_org62_event_id) as event_id
      from activity_entries a left join org62_events e on e.id = a.org62_event_row_id
     where a.owner_user_id = ${userId} and (a.org62_event_row_id is not null or a.target_org62_event_id is not null)`);
  return new Map(r.rows.filter((x) => x.event_id).map((x) => [x.id, x.event_id!] as const));
}

/** Everything a sync reads, from the read model (drafts, rows) and Postgres (DC requests, use cases, candidates). */
export async function loadLandingWorld(db: DbOrTx, userId: string, model: ReadModel, now: Date, extra: { drafts?: readonly Draft[] } = {}): Promise<LandingWorld> {
  const persona = personaOf(model.settings());
  const vdp = featureActive(persona, 'vdp');
  const mine = await loadMyDcs(db, userId);
  // one after another: inside a transaction (a batch's) one client runs one query at a time
  const dcRequests = featureActive(persona, 'dealContributions') ? await loadDcRequests(db, userId, undefined, mine.byOpp) : [];
  const eventIds = await loadEventIds(db, userId);
  const ucInput = vdp ? await loadUseCaseInput(db as Db, userId) : null;
  const candidates = vdp ? await loadCandidates(db, userId) : [];
  const drafts = [...model.all('drafts'), ...(extra.drafts ?? [])];
  return {
    now: now.toISOString(),
    drafts,
    activity: model.all('activity'),
    eventIds,
    dcRequests,
    useCases: ucInput ? { plan: planUseCases(ucInput), input: ucInput } : null,
    candidates,
  };
}

/**
 * One sync: lock, read the stored rows, run the pure pass, write its changes. Returns the store as it is now and the
 * use case ids by plan key (the views read both).
 */
export async function syncLandingsDb(db: DbOrTx, userId: string, world: LandingWorld): Promise<{ store: LandingStore; useCaseByKey: ReadonlyMap<string, string> }> {
  const run = async (tx: DbOrTx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cc.landings:${userId}`}))`);
    const store = await loadLandingStore(tx, userId);
    const r = syncLandings(store, world, { newId: randomUUID });
    await applyLandingChanges(tx, userId, r.changes);
    return { store: applyChanges(store, r.changes), useCaseByKey: r.useCaseByKey };
  };
  // inside a caller's transaction (a mutation's change set) the lock is that transaction's; else a short one of its own
  if (isTx(db)) return run(db);
  return (db as Db).transaction((tx) => run(tx));
}

const isTx = (db: DbOrTx) => 'rollback' in (db as object);

/** Store changes outside a sync (a proposed update, an approve): lock, then write. */
export async function writeLandingChanges(db: DbOrTx, userId: string, c: StoreChanges): Promise<void> {
  const run = async (tx: DbOrTx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cc.landings:${userId}`}))`);
    await applyLandingChanges(tx, userId, c);
  };
  if (isTx(db)) return run(db);
  await (db as Db).transaction((tx) => run(tx));
}

// ---------------------------------------------------------------------------
// D-98 (09 R5): Slack and Gmail items as landings
// ---------------------------------------------------------------------------

export const MESSAGE_RECORD_KIND = 'message';

/** What the delivery left as (the channel's adapter says), or null for a record that left nothing (dry run, failed). */
export function messageLandingOf(rec: DeliveryRecord): MessageLanding | null {
  if (rec.dryRun || rec.state !== 'delivered' || !rec.result) return null;
  if (rec.channel === 'slack') return slackLanding(rec.payload, rec.mode, rec.result);
  if (rec.channel === 'gmail') return gmailLanding(rec.payload, rec.mode, rec.result);
  return null;
}

/**
 * Record (or update) the landing of one delivered Slack / Gmail attempt, inside the delivery's change set: the
 * landing (record = the draft, its state from the mode and the read-back) and the attempt's write. A dry run, a
 * failure and every other channel record nothing. Idempotent: the job saves each state change; the rows follow.
 */
export async function recordMessageLanding(tx: DbOrTx, userId: string, draftId: string, attemptId: string, rec: DeliveryRecord): Promise<boolean> {
  const m = messageLandingOf(rec);
  if (!m) return false;
  const verified = rec.readback === 'confirmed';
  const state = rec.readback === 'missing' ? 'missing' : verified ? 'verified' : rec.mode === 'draft' ? 'staged' : 'sent';
  const at = rec.finishedAt ? new Date(rec.finishedAt) : new Date();
  const readAt = rec.readbackAt ? new Date(rec.readbackAt) : null;
  const verifiedAt = verified ? (readAt ?? at) : null;
  const remote = verified || rec.readback === 'missing' ? { ...m.values, readback: rec.readback } : null;
  const [l] = await tx
    .insert(recordLandings)
    .values({ ownerUserId: userId, recordKind: MESSAGE_RECORD_KIND, recordId: draftId, destination: m.destination, externalId: m.externalId, state, remoteValues: remote, verifiedAt, lastReadAt: readAt })
    .onConflictDoUpdate({
      target: [recordLandings.ownerUserId, recordLandings.recordKind, recordLandings.recordId, recordLandings.destination],
      set: {
        externalId: sql`coalesce(excluded.external_id, ${recordLandings.externalId})`,
        state,
        remoteValues: sql`coalesce(excluded.remote_values, ${recordLandings.remoteValues})`,
        verifiedAt: sql`coalesce(excluded.verified_at, ${recordLandings.verifiedAt})`,
        lastReadAt: sql`coalesce(excluded.last_read_at, ${recordLandings.lastReadAt})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: recordLandings.id });
  const wState = verified ? 'verified' : 'sent';
  await tx
    .insert(landingWrites)
    .values({ ownerUserId: userId, landingId: l!.id, draftId, rowKey: `attempt:${attemptId}`, op: 'create', after: m.values, state: wState, origin: 'outbox', reason: `Applied in the Outbox (${rec.mode})`, sentAt: at, verifiedAt })
    .onConflictDoUpdate({
      target: [landingWrites.ownerUserId, landingWrites.draftId, landingWrites.rowKey],
      targetWhere: sql`${landingWrites.draftId} is not null`,
      set: { after: m.values, state: wState, verifiedAt: sql`coalesce(excluded.verified_at, ${landingWrites.verifiedAt})`, updatedAt: new Date() },
    });
  return true;
}

export interface MessageLandingRow {
  draftId: string;
  destination: 'slack' | 'gmail';
  externalId: string | null;
  state: string;
  verifiedAt: string | null;
  writes: { rowKey: string; state: string; values: Record<string, string | null>; sentAt: string | null; verifiedAt: string | null }[];
}

/** Where the user's Applied Slack and Gmail items landed (newest first), or one draft's. */
export async function loadMessageLandings(db: DbOrTx, userId: string, draftId?: string): Promise<MessageLandingRow[]> {
  const ls = await db
    .select()
    .from(recordLandings)
    .where(and(eq(recordLandings.ownerUserId, userId), eq(recordLandings.recordKind, MESSAGE_RECORD_KIND), ...(draftId ? [eq(recordLandings.recordId, draftId)] : [])))
    .orderBy(sql`${recordLandings.createdAt} desc`, recordLandings.id);
  if (!ls.length) return [];
  const ws = await db
    .select()
    .from(landingWrites)
    .where(and(eq(landingWrites.ownerUserId, userId), inArray(landingWrites.landingId, ls.map((l) => l.id))))
    .orderBy(landingWrites.createdAt, landingWrites.id);
  return ls.map((l) => ({
    draftId: l.recordId,
    destination: l.destination as MessageLandingRow['destination'],
    externalId: l.externalId,
    state: l.state,
    verifiedAt: iso(l.verifiedAt),
    writes: ws.filter((w) => w.landingId === l.id).map((w) => ({ rowKey: w.rowKey, state: w.state, values: (w.after as Record<string, string | null>) ?? {}, sentAt: iso(w.sentAt), verifiedAt: iso(w.verifiedAt) })),
  }));
}
