/**
 * People, accounts, opportunities, assets, calendar events (+ attendees).
 *
 * people: name → display_name · email → primary_email · title · isExternal → affiliation (customer) ·
 *   accountId → account_id · slackHandle → person_identities(slack) · isManager ⇔ users.manager_person_id.
 *   Ext: role.
 * accounts: name, industry, notes. Ext: dcStatus, vdpStatus, hoursQtd, team, org62Url (DATA-MODEL derives
 *   these from deal_contributions / vdp_records / org62_events, which BE-5 fills).
 * opportunities: account_id, name, stage, amount, close_date, forecast_category, is_closed (!isOpen), is_won, on_my_team (isMine),
 *   org62_opportunity_id (from org62Url, else a seed key). Ext: dcAssigned, vdpLinked, hoursQtd, nextStep,
 *   products, owner, org62Url, findingOnly (rows created only to anchor a missed-opp finding).
 * assets: system/kind (+ overrides), title, url, last_modified_at (updatedAt), account_id. Ext: updatedBy,
 *   initiativeId, workItemIds.
 * calendar_events: title, starts/ends, local_day, status/my_response/attendance (attendance), has_external
 *   (isCustomerFacing), conference_url (meetingUrl), account/opp; attendees → calendar_event_attendees (each
 *   guest's response, optional, organizer).
 *   Ext: location, prep, takeaways, source chip, attendee order; seeded rows also keep agenda, organizer, attachments.
 *   Scanned rows read those from the event's source item (`source_item_id`): the agenda from its body (purged
 *   after 90 days), the attachments and the organizer's address from its meta.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Account, Asset, CalendarEvent, EventAttachment, EventAttendee, EventOrganizer, Opportunity, Person, PersonRef } from '@/contract';
import { accounts, assets, calendarEventAttendees, calendarEvents, dealContributions, opportunities, people, personIdentities, sourceItems, users } from '@/db/schema';
import { agendaFromBody, attachmentsFromMeta, conferenceLinkIn } from '@/server/calendar/detail';
import { isMarkerEvent } from '@/engines/activity/event-kinds';
import { driveFileLink, org62RecordUrl as org62RecordLink } from '@/projections/links';
import { myDcsByOpp } from '@/server/deals/dc-requests';

import {
  applyOverride,
  assetKindFromDb,
  assetKindToDb,
  assetSystemFromDb,
  assetSystemToDb,
  attendanceFromDb,
  attendanceToDb,
  overrideIfLossy,
  type DbAssetKind,
  type DbAssetSystem,
  type Override,
} from '../enums';
import { hashKey, uuidFor, uuidOrNull } from '../ids';
import { ext, isoReq, localDay, orderedAt, personRef, same, toDate, updateRow, writeExt, type ReadCtx, type WriteCtx } from './common';
import { onsiteDaysIn } from './onsite';

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** All people of the user, as Person records (includes the me row only if it is in `people`). */
export type PeopleRow = typeof people.$inferSelect;

/**
 * `user`: the caller's own read of the users row (the read model reads it once for its base, so this does not read it
 * again). `rows` in the result: the people rows read, for `loadPersonRefs` (one read of `people` per model).
 */
export async function loadPeople(
  rc: Pick<ReadCtx, 'db' | 'userId' | 'kv'>,
  user?: () => Promise<{ managerPersonId: string | null; personId: string | null } | undefined>,
): Promise<{ people: Person[]; meId: string | null; managerId: string | null; rows: PeopleRow[] }> {
  const rows = await rc.db.select().from(people).where(eq(people.ownerUserId, rc.userId)).orderBy(asc(people.createdAt), asc(people.id));
  const ids = await rc.db.select().from(personIdentities).where(eq(personIdentities.ownerUserId, rc.userId)).orderBy(asc(personIdentities.createdAt), asc(personIdentities.id));
  const u = user ? await user() : (await rc.db.select({ managerPersonId: users.managerPersonId, personId: users.personId }).from(users).where(eq(users.id, rc.userId)))[0];
  const slack = new Map(ids.filter((i) => i.system === 'slack').map((i) => [i.personId, i.handle ?? i.externalId]));
  const out: Person[] = [];
  for (const r of rows) {
    if (r.isMe) continue;
    const x = ext<{ role: string; synthetic: boolean }>(rc, 'people', r.id);
    if (x.synthetic) continue;
    out.push(personFromRow(r, x.role, slack.get(r.id), u?.managerPersonId === r.id));
  }
  // synthetic rows (refs to people not in the directory) are still resolvable for PersonRefs
  return { people: out, meId: u?.personId ?? null, managerId: u?.managerPersonId ?? null, rows };
}

function personFromRow(r: typeof people.$inferSelect, role: string | undefined, slackHandle: string | undefined, isManager: boolean): Person {
  return {
    id: r.id,
    name: r.displayName,
    ...(role ? { role } : {}),
    ...(isManager ? { isManager: true } : {}),
    ...(r.affiliation === 'customer' || r.affiliation === 'partner' ? { isExternal: true } : {}),
    ...(r.primaryEmail ? { email: r.primaryEmail } : {}),
    ...(slackHandle ? { slackHandle } : {}),
    accountId: r.accountId,
    ...(r.title ? { title: r.title } : {}),
    // lane 07 R2: the stakeholder tier reaches the priority engine (absent = the default, normal)
    ...(r.tier !== 'normal' ? { tier: r.tier } : {}),
  };
}

/** Every people row (directory + synthetic refs) as PersonRefs, for resolving embedded refs (`read`: `loadPeople`'s rows). */
export async function loadPersonRefs(rc: Pick<ReadCtx, 'db' | 'userId' | 'kv'>, managerId: string | null, read?: readonly PeopleRow[]): Promise<Map<string, PersonRef & { accountId: string | null }>> {
  const rows = read ?? (await rc.db.select().from(people).where(eq(people.ownerUserId, rc.userId)).orderBy(asc(people.createdAt), asc(people.id)));
  const m = new Map<string, PersonRef & { accountId: string | null }>();
  for (const r of rows) {
    const x = ext<{ role: string }>(rc, 'people', r.id);
    m.set(r.id, {
      id: r.id,
      name: r.displayName,
      ...(x.role ? { role: x.role } : {}),
      ...(managerId === r.id ? { isManager: true } : {}),
      ...(r.affiliation === 'customer' || r.affiliation === 'partner' ? { isExternal: true } : {}),
      accountId: r.accountId,
    });
  }
  return m;
}

export async function insertPerson(w: WriteCtx, p: Person | (PersonRef & { synthetic: true }), opts: { isMe?: boolean } = {}): Promise<string> {
  const id = uuidFor(p.id);
  const full = p as Partial<Person>;
  await w.tx
    .insert(people)
    .values({
      id,
      ownerUserId: w.userId,
      displayName: p.name,
      primaryEmail: full.email ?? null,
      title: full.title ?? null,
      affiliation: opts.isMe ? 'internal' : p.isExternal ? 'customer' : 'synthetic' in p ? 'unknown' : 'internal',
      accountId: uuidOrNull(full.accountId ?? null),
      isMe: !!opts.isMe,
    })
    .onConflictDoNothing();
  if (full.slackHandle) {
    await w.tx
      .insert(personIdentities)
      .values({ ownerUserId: w.userId, personId: id, system: 'slack', externalId: full.slackHandle, handle: full.slackHandle, method: 'connector', isPrimary: true })
      .onConflictDoNothing();
  }
  await writeExt(w, 'people', id, { role: p.role, synthetic: 'synthetic' in p ? true : undefined });
  return id;
}

/** Make sure every referenced person has a row (refs to people outside the directory become synthetic rows). */
export async function ensurePeople(w: WriteCtx, refs: (PersonRef | null | undefined)[], known: Set<string>): Promise<void> {
  for (const r of refs) {
    if (!r) continue;
    const id = uuidFor(r.id);
    if (known.has(id) || id === uuidFor(w.me.id)) continue;
    await insertPerson(w, { ...r, synthetic: true });
    known.add(id);
  }
}

// ---------------------------------------------------------------------------
// Accounts and opportunities
// ---------------------------------------------------------------------------

interface AccountExt {
  dcStatus: Account['dcStatus'];
  vdpStatus: Account['vdpStatus'];
  hoursQtd: number;
  teamIds: string[];
  org62Url: string;
}

export async function loadAccounts(rc: ReadCtx): Promise<Account[]> {
  const rows = await rc.db.select().from(accounts).where(eq(accounts.ownerUserId, rc.userId)).orderBy(asc(accounts.createdAt), asc(accounts.id));
  return rows
    .filter((r) => !r.archivedAt)
    .map((r) => {
      const x = ext<AccountExt>(rc, 'accounts', r.id);
      return {
        id: r.id,
        name: r.name,
        industry: r.industry,
        // D-98: the columns first (dc_status, org62_url), the ext object as the kv fallback
        dcStatus: (r.dcStatus as Account['dcStatus'] | null) ?? x.dcStatus ?? 'none',
        vdpStatus: x.vdpStatus ?? 'none',
        hoursQtd: x.hoursQtd ?? 0,
        team: (x.teamIds ?? []).map((id) => personRef(rc, id)!),
        org62Url: r.org62Url ?? x.org62Url ?? (r.org62AccountId ? org62RecordLink('Account', r.org62AccountId) : null),
        notes: r.notes ?? '',
      };
    });
}

export async function insertAccount(w: WriteCtx, a: Account, opts: { ordinal?: number } = {}): Promise<string> {
  const id = uuidFor(a.id);
  await w.tx.insert(accounts).values({ id, ownerUserId: w.userId, name: a.name, industry: a.industry, notes: a.notes || null, isMyBook: true, org62AccountId: org62Id(a.org62Url, '001'), createdAt: orderedAt(opts.ordinal) });
  await writeExt(w, 'accounts', id, { dcStatus: a.dcStatus === 'none' ? undefined : a.dcStatus, vdpStatus: a.vdpStatus === 'none' ? undefined : a.vdpStatus, hoursQtd: a.hoursQtd || undefined, teamIds: a.team.map((p) => uuidFor(p.id)), org62Url: a.org62Url ?? undefined });
  return id;
}

function org62Id(url: string | null | undefined, prefix: string): string | null {
  const m = url ? new RegExp(`/(${prefix}[A-Za-z0-9]{12,15})`).exec(url) : null;
  return m ? m[1]! : null;
}

interface OppExt {
  dcAssigned: boolean;
  vdpLinked: boolean;
  hoursQtd: number;
  nextStep: string;
  nextStepRead: boolean;
  products: string[];
  ownerId: string;
  org62Url: string;
  findingOnly: boolean;
  /** A seeded opp team (DC1: a covered AE matches as a member); a read opp's team is opportunity_team_members. */
  team: Array<{ id: string; org62UserId: string | null }>;
}

export async function loadOpportunities(rc: ReadCtx): Promise<{ opps: Opportunity[]; findingOnly: Map<string, typeof opportunities.$inferSelect> }> {
  const [rows, dcs] = await Promise.all([
    rc.db.select().from(opportunities).where(eq(opportunities.ownerUserId, rc.userId)).orderBy(asc(opportunities.createdAt), asc(opportunities.id)),
    // my DCs as the Org62 scans read them (deal_contributions): Opportunity.myDc
    rc.db
      .select({ opportunityId: dealContributions.opportunityId, org62DcId: dealContributions.org62DcId, role: dealContributions.role, split: dealContributions.splitPercent, lastSeenAt: dealContributions.lastSeenAt, oppOrg62: opportunities.org62OpportunityId })
      .from(dealContributions)
      .leftJoin(opportunities, eq(opportunities.id, dealContributions.opportunityId))
      .where(and(eq(dealContributions.ownerUserId, rc.userId), eq(dealContributions.isMine, true), sql`${dealContributions.deletedUpstreamAt} is null`))
      .orderBy(sql`${dealContributions.lastSeenAt} desc`),
  ]);
  // my DC per opp row, and per Org62 opp id (15): a DC linked to another row for the same Org62 opp (a duplicate or a
  // finding-only row) still shows its split on the opp the app lists, never "assigned, split not read"
  // DC-14: two DCs of mine on one opp are summed (newest first in, so the newest one's role and id lead)
  const rowsOf = dcs.map((d) => ({ split: d.split, role: d.role, org62DcId: d.org62DcId, lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null, oppId: d.opportunityId, org62: d.oppOrg62 ? d.oppOrg62.slice(0, 15) : null }));
  const myDc = myDcsByOpp(rowsOf);
  const myDcByOrg62 = myDcsByOpp(rowsOf.map((d) => ({ ...d, oppId: d.org62 })));
  const dcOf = (r: { id: string; org62OpportunityId: string }) => myDc.get(r.id) ?? myDcByOrg62.get(r.org62OpportunityId.slice(0, 15)) ?? null;
  const opps: Opportunity[] = [];
  const findingOnly = new Map<string, typeof opportunities.$inferSelect>();
  for (const r of rows) {
    const x = ext<OppExt>(rc, 'opportunities', r.id);
    if (x.findingOnly || r.archivedAt) {
      findingOnly.set(r.id, r);
      continue;
    }
    opps.push({
      id: r.id,
      accountId: r.accountId ?? '',
      name: r.name,
      stage: r.stage ?? '',
      amount: r.amount,
      closeDate: r.closeDate,
      isOpen: !r.isClosed,
      isMine: r.onMyTeam,
      // D-98: the columns first (dc_assigned, next_step, products, owner_person_id), the ext object as the kv fallback
      dcAssigned: r.dcAssigned || !!x.dcAssigned || !!dcOf(r),
      vdpLinked: !!x.vdpLinked,
      hoursQtd: x.hoursQtd ?? 0,
      nextStep: r.nextStep ?? x.nextStep ?? null,
      // seeded rows say so (insertOpportunity); a projected row once a read that selects NextStep saw it
      nextStepRead: x.nextStepRead === true || !!(r.nextStep ?? x.nextStep),
      products: r.products ?? x.products ?? [],
      owner: (r.ownerPersonId ?? x.ownerId) ? personRef(rc, r.ownerPersonId ?? x.ownerId) : null,
      org62Url: x.org62Url ?? (r.org62OpportunityId ? org62RecordLink('Opportunity', r.org62OpportunityId) : null),
      myDc: dcOf(r),
      forecastCategory: r.forecastCategory,
      isWon: r.isWon,
      updatedAt: isoReq(r.updatedAt),
      ...(x.team ? { team: x.team.map((m) => ({ ...personRef(rc, m.id)!, org62UserId: m.org62UserId })) } : {}),
    });
  }
  return { opps, findingOnly };
}

type OppInsert = Omit<Opportunity, 'myDc' | 'forecastCategory' | 'isWon' | 'nextStepRead'> & Partial<Pick<Opportunity, 'myDc' | 'forecastCategory' | 'isWon' | 'nextStepRead'>>;
export async function insertOpportunity(w: WriteCtx, o: OppInsert | (Omit<OppInsert, 'updatedAt'> & { updatedAt?: string; findingOnly: true }), opts: { ordinal?: number } = {}): Promise<string> {
  const id = uuidFor(o.id);
  await w.tx
    .insert(opportunities)
    .values({
      id,
      ownerUserId: w.userId,
      accountId: o.accountId ? uuidFor(o.accountId) : null,
      org62OpportunityId: org62Id(o.org62Url, '006') ?? `cc:${hashKey(o.id)}`,
      name: o.name,
      stage: o.stage || null,
      amount: o.amount,
      closeDate: o.closeDate,
      isClosed: !o.isOpen,
      forecastCategory: o.forecastCategory ?? null,
      isWon: o.isWon ?? false,
      onMyTeam: o.isMine,
      updatedAt: toDate(o.updatedAt ?? null) ?? w.now,
      createdAt: orderedAt(opts.ordinal),
    })
    .onConflictDoNothing();
  await writeExt(w, 'opportunities', id, {
    dcAssigned: o.dcAssigned || undefined,
    vdpLinked: o.vdpLinked || undefined,
    hoursQtd: o.hoursQtd || undefined,
    nextStep: o.nextStep ?? undefined,
    // a seeded opp's next step is what the seed says (null = none), unless it says it was never read
    nextStepRead: o.nextStepRead === false ? undefined : true,
    products: o.products,
    ownerId: o.owner ? uuidFor(o.owner.id) : undefined,
    org62Url: o.org62Url ?? undefined,
    findingOnly: 'findingOnly' in o ? true : undefined,
    team: o.team ? o.team.map((m) => ({ id: uuidFor(m.id), org62UserId: m.org62UserId ?? null })) : undefined,
  });
  // a seeded DC of mine (the Org62 scans write the rest: projections → syncMyDcs)
  const dc = o.myDc;
  if (dc?.org62DcId)
    await w.tx
      .insert(dealContributions)
      .values({ ownerUserId: w.userId, org62DcId: dc.org62DcId, opportunityId: id, contributorPersonId: w.me.id, isMine: true, role: dc.role, splitPercent: dc.split, lastSeenAt: toDate(dc.lastSeenAt ?? null) ?? w.now, firstSeenAt: toDate(dc.lastSeenAt ?? null) ?? w.now })
      .onConflictDoNothing();
  return id;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

interface AssetExt {
  kindOverride: Override<Asset['kind'], DbAssetKind>;
  sourceOverride: Override<Asset['source'], DbAssetSystem>;
  updatedBy: string;
  initiativeId: string;
  workItemIds: string[];
}

export async function loadAssets(rc: ReadCtx): Promise<Asset[]> {
  const rows = await rc.db.select().from(assets).where(eq(assets.ownerUserId, rc.userId)).orderBy(asc(assets.createdAt), asc(assets.id));
  return rows
    .filter((r) => !r.archivedAt)
    .map((r) => {
      const x = ext<AssetExt>(rc, 'assets', r.id);
      const by = r.lastModifyingPersonId ? personRef(rc, r.lastModifyingPersonId)?.name : x.updatedBy;
      return {
        id: r.id,
        kind: applyOverride(r.kind, assetKindFromDb(r.kind), x.kindOverride),
        title: r.title ?? '',
        ...(r.url ? { url: r.url } : r.system === 'drive' && /^[A-Za-z0-9_-]{15,}$/.test(r.externalId) ? { url: driveFileLink(r.externalId, r.kind) } : {}),
        source: applyOverride(r.system, assetSystemFromDb(r.system), x.sourceOverride),
        ...(r.lastModifiedAt ? { updatedAt: isoReq(r.lastModifiedAt) } : {}),
        ...(by ? { updatedBy: by } : {}),
        initiativeId: x.initiativeId ?? null,
        accountId: r.accountId,
        workItemIds: x.workItemIds ?? [],
      };
    });
}

export async function insertAsset(w: WriteCtx, a: Asset, personByName: (name: string) => string | null, opts: { ordinal?: number } = {}): Promise<string> {
  const id = uuidFor(a.id);
  const kind = assetKindToDb(a.kind);
  const system = assetSystemToDb(a.source);
  const modifier = a.updatedBy ? personByName(a.updatedBy) : null;
  await w.tx.insert(assets).values({
    id,
    ownerUserId: w.userId,
    system,
    externalId: a.url ?? `cc:${a.id}`,
    kind,
    title: a.title,
    url: a.url ?? null,
    lastModifiedAt: toDate(a.updatedAt ?? null),
    lastModifyingPersonId: modifier,
    iOwn: a.updatedBy === w.me.name,
    accountId: uuidOrNull(a.accountId),
    createdAt: orderedAt(opts.ordinal),
  });
  await writeExt(w, 'assets', id, {
    kindOverride: overrideIfLossy(a.kind, kind, assetKindFromDb) ?? undefined,
    sourceOverride: overrideIfLossy(a.source, system, assetSystemFromDb) ?? undefined,
    updatedBy: a.updatedBy && !modifier ? a.updatedBy : undefined,
    initiativeId: a.initiativeId ?? undefined,
    workItemIds: a.workItemIds,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------

interface EventExt {
  location: string;
  prep: CalendarEvent['prep'];
  takeaways: CalendarEvent['takeaways'];
  source: CalendarEvent['source'];
  attendeeOrder: string[];
  /** Seeded rows only (scanned rows read these from their source item). */
  agenda: string;
  organizer: EventOrganizer;
  attachments: EventAttachment[];
}

/** What a scanned event's source item adds: the agenda (body), attachments and organizer address (meta). */
interface EventSource {
  title: string | null;
  body: string | null;
  attachments: unknown;
  organizerEmail: string | null;
  organizerName: string | null;
}

/** The source items behind these events, read in one query (bodies clipped: an agenda is ≤ 2,000 characters). */
export async function loadEventSources(rc: Pick<ReadCtx, 'db' | 'userId'>, ids: string[]): Promise<Map<string, EventSource>> {
  if (!ids.length) return new Map();
  const rows = await rc.db
    .select({
      id: sourceItems.id,
      title: sourceItems.title,
      body: sql<string | null>`left(${sourceItems.body}, 4000)`,
      attachments: sql<unknown>`${sourceItems.meta}->'attachments'`,
      organizerEmail: sql<string | null>`${sourceItems.meta}->>'organizerEmail'`,
      organizerName: sql<string | null>`${sourceItems.meta}->'author'->>'name'`,
    })
    .from(sourceItems)
    .where(and(eq(sourceItems.ownerUserId, rc.userId), inArray(sourceItems.id, ids)));
  return new Map(rows.map((r) => [r.id, { title: r.title, body: r.body, attachments: r.attachments, organizerEmail: r.organizerEmail, organizerName: r.organizerName }]));
}

type AttendeeRow = typeof calendarEventAttendees.$inferSelect;

/** A guest row → the contract's attendee: the person (or the address), plus the invite facts it records. */
function attendeeOf(rc: ReadCtx, a: AttendeeRow): EventAttendee {
  const ref: PersonRef = a.personId ? personRef(rc, a.personId)! : { id: a.email, name: a.displayName ?? a.email };
  return {
    ...ref,
    ...(a.isExternal && !ref.isExternal ? { isExternal: true } : {}),
    ...(a.responseStatus !== 'none' ? { response: a.responseStatus } : {}),
    ...(a.isOptional ? { optional: true } : {}),
    ...(a.isOrganizer ? { organizer: true } : {}),
  };
}

/** Who sent the invite: me, the guest marked organizer, the organizer column, else the source's address. */
function organizerOf(rc: ReadCtx, r: typeof calendarEvents.$inferSelect, guests: AttendeeRow[], src: EventSource | undefined): EventOrganizer | null {
  if (r.iAmOrganizer) return { name: rc.me.name, personId: null, isMe: true, isExternal: false };
  const g = guests.find((a) => a.isOrganizer);
  const pid = g?.personId ?? r.organizerPersonId;
  if (pid) {
    const p = personRef(rc, pid)!;
    return { name: p.name, personId: pid, isMe: false, isExternal: !!(p.isExternal || g?.isExternal) };
  }
  // no person record: the invite's own display name for the organizer, when it is the same address
  const named = src?.organizerName?.trim() && src.organizerEmail?.trim().toLowerCase() === g?.email.toLowerCase() ? src.organizerName.trim() : null;
  if (g) return { name: g.displayName ?? named ?? g.email, personId: null, isMe: false, isExternal: g.isExternal };
  const email = src?.organizerEmail?.trim();
  if (!email) return null;
  return { name: src?.organizerName?.trim() || email, personId: null, isMe: false, isExternal: false };
}

/**
 * The events the pages show (Today, free time, the Time grid): meetings with other people that I accepted,
 * organize, answered tentatively or have not answered yet, plus declined and cancelled ones (labelled). The
 * event carries `myResponse` / `isAllDay` / `eventType`, so the priority engine (`isBusy`) and Today know that only
 * accepted meetings block time (DESIGN-V2 capacity): tentative and unanswered invites show as not blocking.
 * Still off the pages (the table keeps them, projections write them faithfully): all-day, out-of-office, focus
 * and working-location events, solo blocks, and events I am not on. They are not meetings, and an all-day row
 * would paint the whole day. Seeded rows always pass.
 */
export function isAttendedMeeting(
  r: Pick<typeof calendarEvents.$inferSelect, 'status' | 'myResponse' | 'attendance' | 'isAllDay' | 'eventType' | 'iAmOrganizer'> & Partial<Pick<typeof calendarEvents.$inferSelect, 'title' | 'startsAt' | 'endsAt'>>,
  tz?: string,
): boolean {
  if (r.isAllDay || r.eventType !== 'default') return false;
  // a timed block of 12 h+ or across midnight marks the day(s) (an onsite, a trip): never a meeting (onsite lane)
  if (tz && r.startsAt && r.endsAt && isMarkerEvent({ summary: r.title ?? '', startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString() }, tz)) return false;
  if (r.status === 'cancelled' || r.myResponse === 'declined') return true;
  if (r.attendance === 'not_applicable') return false;
  return r.myResponse !== 'none' || r.iAmOrganizer;
}

/** The invite facts the contract's attendance cannot say, only when they say something (seeded rows emit none). */
function responseFields(r: Pick<typeof calendarEvents.$inferSelect, 'myResponse' | 'isAllDay' | 'eventType'>): Pick<CalendarEvent, 'myResponse' | 'isAllDay' | 'eventType'> {
  return {
    ...(r.myResponse === 'tentative' || r.myResponse === 'needs_action' ? { myResponse: r.myResponse } : {}),
    ...(r.isAllDay ? { isAllDay: true } : {}),
    ...(r.eventType !== 'default' ? { eventType: r.eventType } : {}),
  };
}

/** `ids`: only those events (a page scope's window, reads/rows.ts); omitted = every event. */
export async function loadCalendarEvents(rc: ReadCtx, ids?: readonly string[]): Promise<CalendarEvent[]> {
  if (ids && !ids.length) return [];
  const rows = await rc.db.select().from(calendarEvents).where(ids ? and(eq(calendarEvents.ownerUserId, rc.userId), inArray(calendarEvents.id, [...ids])) : eq(calendarEvents.ownerUserId, rc.userId)).orderBy(asc(calendarEvents.createdAt), asc(calendarEvents.id));
  if (!rows.length) return [];
  const att = await rc.db.select().from(calendarEventAttendees).where(inArray(calendarEventAttendees.calendarEventId, rows.map((r) => r.id))).orderBy(asc(calendarEventAttendees.id));
  const sources = await loadEventSources(rc, [...new Set(rows.map((r) => r.sourceItemId).filter((x): x is string => !!x))]);
  // Inside a trip, a meeting whose attendance was uncertain (overlapping onsite sessions) counts as attended unless
  // declined (onsite lane): the projections' week records say which days were onsite.
  const onsiteDays = new Set(onsiteDaysIn(rc.kv, '0000-01-01', '9999-12-31').filter((d) => d.status !== 'not_onsite').map((d) => d.day));
  const ended = (r: (typeof rows)[number]) => r.endsAt.getTime() <= rc.now.getTime();
  return rows
    .filter((r) => !r.deletedUpstreamAt && isAttendedMeeting(r, rc.timezone))
    .map((r) => {
      const x = ext<EventExt>(rc, 'calendar_events', r.id);
      const attendance = r.attendance === 'unknown' && r.myResponse !== 'declined' && (r.myResponse === 'accepted' || r.myResponse === 'tentative' || r.iAmOrganizer) && ended(r) && onsiteDays.has(r.localDay) ? 'attended' : r.attendance;
      const mine = att.filter((a) => a.calendarEventId === r.id && !a.isSelf);
      const order = x.attendeeOrder ?? [];
      // seeded rows keep their stored order; scanned rows (no order) read organizer first, then by address
      mine.sort((a, b) => order.indexOf(a.personId ?? '') - order.indexOf(b.personId ?? '') || Number(b.isOrganizer) - Number(a.isOrganizer) || a.email.localeCompare(b.email));
      const src = r.sourceItemId ? sources.get(r.sourceItemId) : undefined;
      const location = r.location ?? x.location ?? null;
      const agenda = x.agenda ?? (src ? agendaFromBody(src.body, src.title ?? r.title) : null);
      return {
        id: r.id,
        title: r.title ?? '',
        start: isoReq(r.startsAt),
        end: isoReq(r.endsAt),
        attendance: attendanceFromDb(r.status, r.myResponse, attendance),
        isCustomerFacing: r.hasExternalAttendees,
        accountId: r.accountId,
        oppId: r.opportunityId,
        attendees: mine.map((a) => attendeeOf(rc, a)),
        location,
        // a scanned invite with no conference data may still carry a Zoom / Teams link in its location or agenda
        meetingUrl: r.conferenceUrl ?? (src ? conferenceLinkIn(location, agenda) : null),
        agenda,
        organizer: x.organizer ?? organizerOf(rc, r, mine, src),
        attachments: x.attachments ?? (src ? attachmentsFromMeta(src.attachments) : []),
        prep: x.prep ?? null,
        takeaways: x.takeaways ?? null,
        source: x.source ? (x.source.url || !r.htmlLink ? x.source : { ...x.source, url: r.htmlLink }) : { kind: 'calendar', label: 'Google Calendar', externalId: r.externalEventId, ...(r.htmlLink ? { url: r.htmlLink } : {}) },
        ...responseFields(r),
      };
    });
}

export function eventColumns(e: CalendarEvent, w: Pick<WriteCtx, 'userId' | 'timezone'>) {
  const a = attendanceToDb(e.attendance);
  return {
    id: uuidFor(e.id),
    ownerUserId: w.userId,
    calendarId: 'primary',
    externalEventId: e.source.externalId ?? e.id,
    title: e.title,
    startsAt: new Date(e.start),
    endsAt: new Date(e.end),
    localDay: localDay(e.start, w.timezone),
    status: a.status,
    // a tentative / unanswered answer survives an attendance edit (attendance alone cannot say it)
    myResponse: a.myResponse === 'accepted' && (e.myResponse === 'tentative' || e.myResponse === 'needs_action') ? e.myResponse : a.myResponse,
    attendance: a.attendance,
    hasExternalAttendees: e.isCustomerFacing,
    conferenceUrl: e.meetingUrl,
    accountId: uuidOrNull(e.accountId),
    opportunityId: uuidOrNull(e.oppId),
  };
}

/**
 * `details`: keep the invite details (agenda, organizer, attachments) in ext. Only for rows with no source item
 * (seeded): a scanned row reads them from its source, and the agenda is message text that must stay in the
 * source body (90-day retention), never copied into ext.
 */
function eventExt(e: CalendarEvent, details: boolean): Record<string, unknown> {
  const fallback = { kind: 'calendar', label: 'Google Calendar', externalId: e.source.externalId ?? e.id };
  return {
    location: e.location ?? undefined,
    prep: e.prep,
    takeaways: e.takeaways,
    source: same(e.source, fallback) ? undefined : e.source,
    attendeeOrder: e.attendees.map((p) => uuidFor(p.id)),
    ...(details
      ? {
          agenda: e.agenda ?? undefined,
          organizer: e.organizer ? { ...e.organizer, personId: e.organizer.personId ? uuidFor(e.organizer.personId) : null } : undefined,
          attachments: e.attachments.length ? e.attachments : undefined,
        }
      : {}),
  };
}

export async function insertCalendarEvent(w: WriteCtx, e: CalendarEvent, emailOf: (personId: string) => string | null): Promise<string> {
  const cols = eventColumns(e, w);
  await w.tx.insert(calendarEvents).values(cols);
  if (e.attendees.length) {
    await w.tx
      .insert(calendarEventAttendees)
      .values(
        e.attendees.map((p) => ({
          calendarEventId: cols.id,
          personId: uuidFor(p.id),
          email: emailOf(uuidFor(p.id)) ?? `${uuidFor(p.id)}@people.invalid`,
          displayName: p.name,
          isExternal: !!p.isExternal,
          responseStatus: p.response ?? 'none',
          isOptional: !!p.optional,
          isOrganizer: !!p.organizer,
        })),
      )
      .onConflictDoNothing();
  }
  await writeExt(w, 'calendar_events', cols.id, eventExt(e, true));
  return cols.id;
}

export async function updateCalendarEvent(w: WriteCtx, cur: CalendarEvent, next: CalendarEvent): Promise<void> {
  const a = eventColumns(cur, w);
  const b = eventColumns(next, w);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof typeof b)[]) if (!same(a[k], b[k])) patch[k] = b[k];
  await updateRow(w, calendarEvents, b.id, patch, { bump: false });
  // keep invite details in ext only where they already were (a seeded row); a scanned row reads its source
  const prev = ext<EventExt>(w, 'calendar_events', b.id);
  await writeExt(w, 'calendar_events', b.id, eventExt(next, 'agenda' in prev || 'organizer' in prev || 'attachments' in prev));
}

/** Person id (uuid) → name lookup over the people table, for asset modifiers and attendee emails. */
export async function personDirectory(w: WriteCtx): Promise<{ byName: Map<string, string>; email: Map<string, string> }> {
  const rows = await w.tx.select({ id: people.id, name: people.displayName, email: people.primaryEmail }).from(people).where(eq(people.ownerUserId, w.userId));
  return { byName: new Map(rows.map((r) => [r.name, r.id])), email: new Map(rows.filter((r) => r.email).map((r) => [r.id, r.email!])) };
}

