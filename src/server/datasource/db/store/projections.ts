/**
 * Upserts for the projections (src/projections): source items → the domain rows the pages read.
 *
 * Every writer is keyed by the source's natural key (Org62 id, calendar + event id, Drive file id, Claude session
 * id, Org62 Event id, activity / time-block dedupe key) and is idempotent: a re-run with the same input writes
 * nothing (no audit rows). They run inside the caller's change set (`w`), like every store writer.
 *
 * User-owned fields are never overwritten:
 *  - `mapping_locked` keeps account / opportunity / mapping columns (calendar events, assets, Claude sessions);
 *  - activity entries the user approved, or whose fields they edited (`user_locked_fields`), are only moved by
 *    the Org62 read-back (status + stamps), never rewritten or removed;
 *  - ext side-car objects are merged, so fields other writers keep there survive.
 * The read side is the existing loaders (entities.ts, agents.ts, time.ts): rows are written in the shape they read.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Account, CalendarEvent } from '@/contract';
import {
  accounts, assets, calendarEventAttendees, calendarEvents, claudeSessions, meetingNotes, opportunities,
  opportunityTeamMembers,
} from '@/db/schema';
import { extKey } from '../ext';
import { toDate, type WriteCtx } from './common';
import { type Upserted, patchOf, mergeExt, type Mapping, MAPPING_PROPS } from './projections.ext';
export {
  driftedLoggedRowStarts, hiddenOrg62RowStarts, upsertOrg62Event, loadActivityWindow, applyActivityWindow,
  loadBlockWindow, applyBlockWindow,
} from './projections.activity';
export type {
  Org62EventProjection, ActivityRow, ActivityProjection, BlockProjection, BlockRow,
} from './projections.activity';
export { mergeExt } from './projections.ext';
export type { Mapping, Upserted } from './projections.ext';

// ---------------------------------------------------------------------------
// Accounts, opportunities, my opp-team rows (Org62 is canonical)
// ---------------------------------------------------------------------------

export interface AccountProjection {
  org62AccountId: string;
  name: string;
  ext: { org62Url: string; dcStatus: Account['dcStatus']; hoursQtd: number };
}

export async function upsertAccountFromOrg62(w: WriteCtx, a: AccountProjection, newId: string): Promise<Upserted> {
  const [cur] = await w.tx.select().from(accounts).where(and(eq(accounts.ownerUserId, w.userId), eq(accounts.org62AccountId, a.org62AccountId)));
  let id = cur?.id ?? newId;
  let written = false;
  if (!cur) {
    await w.tx.insert(accounts).values({ id, ownerUserId: w.userId, org62AccountId: a.org62AccountId, name: a.name, isMyBook: true });
    written = true;
  } else {
    id = cur.id;
    const patch = patchOf(cur, { name: a.name, isMyBook: true });
    if (Object.keys(patch).length) {
      await w.tx.update(accounts).set(patch).where(eq(accounts.id, id));
      written = true;
    }
  }
  const ext = await mergeExt(w, 'accounts', id, { org62Url: a.ext.org62Url, dcStatus: a.ext.dcStatus === 'none' ? null : a.ext.dcStatus, hoursQtd: a.ext.hoursQtd || null });
  return { id, written: written || ext };
}

export interface OppProjection {
  org62OpportunityId: string;
  accountId: string | null;
  name: string;
  stage: string | null;
  amount: number | null;
  closeDate: string | null;
  forecastCategory: string | null;
  type: string | null;
  isClosed: boolean;
  isWon: boolean;
  onMyTeam: boolean;
  myTeamRole: string | null;
  org62ModifiedAt: string | null;
  /** nextStepRead: a read that selects NextStep saw the opp (a null nextStep then means none; src/projections/org62.ts). */
  ext: { dcAssigned: boolean; nextStep: string | null; nextStepRead?: boolean; org62Url: string; hoursQtd: number };
  /**
   * The daily book read no longer lists it (I left its team): membership turns off and the row is marked
   * (`ext.leftBookAt`), never deleted. Absent / null = still in my book (the mark is cleared).
   */
  leftBookAt?: string | null;
  /** The complete book read says this open opp is not mine: membership turns off (marked left if it was on). */
  notInBookAt?: string | null;
  /**
   * The complete book read decides membership (an open opp): `onMyTeam` is taken as given, so a stored "on my team"
   * it doesn't support turns off without a left mark (an opp I only hold a DC on). Absent: membership only turns on.
   */
  teamKnown?: boolean;
}

export async function upsertOpportunityFromOrg62(w: WriteCtx, o: OppProjection, newId: string): Promise<Upserted> {
  const [cur] = await w.tx.select().from(opportunities).where(and(eq(opportunities.ownerUserId, w.userId), eq(opportunities.org62OpportunityId, o.org62OpportunityId)));
  const cols = {
    accountId: o.accountId ?? cur?.accountId ?? null,
    name: o.name,
    stage: o.stage ?? cur?.stage ?? null,
    // numeric(14,2): round here, or a fractional amount reads back different and is rewritten every pass
    amount: o.amount !== null ? Math.round(o.amount * 100) / 100 : (cur?.amount ?? null),
    closeDate: o.closeDate ?? cur?.closeDate ?? null,
    forecastCategory: o.forecastCategory ?? cur?.forecastCategory ?? null,
    type: o.type ?? cur?.type ?? null,
    isClosed: o.isClosed,
    isWon: o.isWon,
    // membership only turns on here (Org62 lists current members, and not being listed by a windowed scan is not a
    // removal), except when the complete daily book read says I left the team or decides it (`teamKnown`)
    onMyTeam: o.leftBookAt || o.notInBookAt ? false : o.teamKnown ? o.onMyTeam : o.onMyTeam || !!cur?.onMyTeam,
    myTeamRole: o.myTeamRole ?? cur?.myTeamRole ?? null,
    org62ModifiedAt: toDate(o.org62ModifiedAt) ?? cur?.org62ModifiedAt ?? null,
  };
  let id = cur?.id ?? newId;
  let written = false;
  if (!cur) {
    await w.tx.insert(opportunities).values({ id, ownerUserId: w.userId, org62OpportunityId: o.org62OpportunityId, ...cols, updatedAt: w.now });
    written = true;
  } else {
    id = cur.id;
    const patch = patchOf(cur, cols);
    if (Object.keys(patch).length) {
      await w.tx.update(opportunities).set({ ...patch, updatedAt: w.now }).where(eq(opportunities.id, id));
      written = true;
    }
  }
  // the mark: the first read that left it out; kept while reads still leave it out; cleared once it is back
  const left = !!o.leftBookAt || (!!o.notInBookAt && !!cur?.onMyTeam);
  const prevLeft = (w.kv.get(extKey('opportunities', id)) as { leftBookAt?: string } | undefined)?.leftBookAt;
  const leftMark = left ? (prevLeft ?? o.leftBookAt ?? o.notInBookAt) : o.notInBookAt ? undefined : null;
  const ext = await mergeExt(w, 'opportunities', id, { dcAssigned: o.ext.dcAssigned || null, nextStep: o.ext.nextStep, nextStepRead: o.ext.nextStepRead ? true : o.ext.nextStepRead === false ? null : undefined, org62Url: o.ext.org62Url, hoursQtd: o.ext.hoursQtd || null, findingOnly: null, leftBookAt: leftMark });
  if (left) await removeMyTeamMembership(w, id);
  return { id, written: written || ext };
}

/** I left the opp's team (the book read says): my membership rows get `removed_at` (kept, never deleted). */
export async function removeMyTeamMembership(w: WriteCtx, opportunityId: string): Promise<void> {
  await w.tx.execute(sql`update opportunity_team_members set removed_at = ${w.now.toISOString()}::timestamptz where opportunity_id = ${opportunityId} and is_me and removed_at is null`);
}

/** My opp-team row (opportunity_team_members is not audited). */
export async function upsertMyTeamMembership(w: WriteCtx, opportunityId: string, org62UserId: string, role: string): Promise<void> {
  await w.tx
    .insert(opportunityTeamMembers)
    .values({ opportunityId, personId: w.me.id, org62UserId, teamRole: role, isMe: true })
    .onConflictDoUpdate({
      target: [opportunityTeamMembers.opportunityId, opportunityTeamMembers.org62UserId, opportunityTeamMembers.teamRole],
      set: { removedAt: null },
      setWhere: sql`${opportunityTeamMembers.removedAt} is not null`,
    });
}

// ---------------------------------------------------------------------------
// Calendar events (+ attendees, meeting notes)
// ---------------------------------------------------------------------------

export interface EventProjection extends Mapping {
  calendarId: string;
  externalEventId: string;
  recurringEventId: string | null;
  sourceItemId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  localDay: string;
  isAllDay: boolean;
  eventType: 'default' | 'out_of_office' | 'focus_time' | 'working_location';
  status: 'confirmed' | 'tentative' | 'cancelled';
  myResponse: 'accepted' | 'declined' | 'tentative' | 'needs_action' | 'none';
  iAmOrganizer: boolean;
  attendance: 'unknown' | 'attended' | 'missed' | 'partial' | 'not_applicable';
  hasExternalAttendees: boolean;
  externalDomains: string[];
  conferenceUrl: string | null;
  htmlLink: string | null;
  location: string | null;
  attendees: {
    email: string;
    personId: string | null;
    displayName: string | null;
    responseStatus: EventProjection['myResponse'];
    isOrganizer: boolean;
    isOptional: boolean;
    isSelf: boolean;
    isExternal: boolean;
    domain: string | null;
  }[];
}

export async function upsertCalendarEventFromSource(w: WriteCtx, e: EventProjection, newId: string): Promise<Upserted> {
  const [cur] = await w.tx
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.ownerUserId, w.userId), eq(calendarEvents.calendarId, e.calendarId), eq(calendarEvents.externalEventId, e.externalEventId)));
  const cols = {
    recurringEventId: e.recurringEventId,
    sourceItemId: e.sourceItemId,
    title: e.title,
    startsAt: new Date(e.startsAt),
    endsAt: new Date(e.endsAt),
    localDay: e.localDay,
    isAllDay: e.isAllDay,
    eventType: e.eventType,
    status: e.status,
    iAmOrganizer: e.iAmOrganizer,
    myResponse: e.myResponse,
    attendance: e.attendance,
    attendanceSource: 'calendar_inference' as const,
    hasExternalAttendees: e.hasExternalAttendees,
    externalDomains: e.externalDomains,
    conferenceUrl: e.conferenceUrl,
    htmlLink: e.htmlLink,
    location: e.location,
    accountId: e.accountId,
    opportunityId: e.opportunityId,
    mappingMethod: e.mappingMethod,
    mappingConfidence: e.mappingConfidence,
    deletedUpstreamAt: null,
  };
  let id = cur?.id ?? newId;
  let written = false;
  if (!cur) {
    await w.tx.insert(calendarEvents).values({ id, ownerUserId: w.userId, calendarId: e.calendarId, externalEventId: e.externalEventId, ...cols });
    written = true;
  } else {
    id = cur.id;
    const patch = patchOf(cur, cols, cur.mappingLocked ? MAPPING_PROPS : []);
    if (Object.keys(patch).length) {
      await w.tx.update(calendarEvents).set(patch).where(eq(calendarEvents.id, id));
      written = true;
    }
  }
  // attendees (not audited): exactly the projected set, keyed by email
  const att = await w.tx.select().from(calendarEventAttendees).where(eq(calendarEventAttendees.calendarEventId, id));
  const want = new Set(e.attendees.map((a) => a.email));
  const gone = att.filter((a) => !want.has(a.email)).map((a) => a.id);
  if (gone.length) await w.tx.delete(calendarEventAttendees).where(inArray(calendarEventAttendees.id, gone));
  for (const a of e.attendees) {
    const prev = att.find((x) => x.email === a.email);
    const row = { personId: a.personId, displayName: a.displayName, responseStatus: a.responseStatus, isOrganizer: a.isOrganizer, isOptional: a.isOptional, isSelf: a.isSelf, isExternal: a.isExternal, domain: a.domain };
    if (!prev) await w.tx.insert(calendarEventAttendees).values({ calendarEventId: id, email: a.email, ...row }).onConflictDoNothing();
    else if (Object.keys(patchOf(prev, row)).length) await w.tx.update(calendarEventAttendees).set(row).where(eq(calendarEventAttendees.id, prev.id));
  }
  const ext = await mergeExt(w, 'calendar_events', id, {
    location: e.location,
    source: e.htmlLink ? { kind: 'calendar', label: 'Google Calendar', externalId: e.externalEventId, url: e.htmlLink } : null,
  });
  return { id, written: written || ext };
}

/** Cancelled upstream (the event vanished while still ahead) or deleted at the source. The row stays (history). */
export async function markCalendarEventGone(w: WriteCtx, calendarId: string, externalEventId: string, how: 'cancelled' | 'deleted'): Promise<boolean> {
  const [cur] = await w.tx
    .select({ id: calendarEvents.id, status: calendarEvents.status, deletedUpstreamAt: calendarEvents.deletedUpstreamAt })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.ownerUserId, w.userId), eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.externalEventId, externalEventId)));
  if (!cur) return false;
  if (how === 'cancelled' ? cur.status === 'cancelled' : !!cur.deletedUpstreamAt) return false;
  await w.tx
    .update(calendarEvents)
    .set(how === 'cancelled' ? { status: 'cancelled' } : { deletedUpstreamAt: w.now })
    .where(eq(calendarEvents.id, cur.id));
  return true;
}

/** The takeaways chip of a meeting: the work items the scanner opened from its notes, and the notes link. */
export async function setEventTakeaways(w: WriteCtx, eventId: string, t: CalendarEvent['takeaways']): Promise<boolean> {
  return mergeExt(w, 'calendar_events', eventId, { takeaways: t });
}

export interface NoteProjection {
  sourceItemId: string;
  calendarEventId: string | null;
  docExternalId: string;
  url: string | null;
  arrivedAt: string;
  nextStepCount: number;
  myNextStepCount: number;
}

export async function upsertMeetingNote(w: WriteCtx, n: NoteProjection): Promise<Upserted> {
  const [cur] = await w.tx.select().from(meetingNotes).where(eq(meetingNotes.sourceItemId, n.sourceItemId));
  const cols = {
    calendarEventId: n.calendarEventId,
    kind: 'gemini_notes' as const,
    docExternalId: n.docExternalId,
    url: n.url,
    arrivedAt: new Date(n.arrivedAt),
    matchMethod: n.calendarEventId ? ('calendar_attachment' as const) : null,
    matchConfidence: n.calendarEventId ? 0.95 : null,
    nextStepCount: n.nextStepCount,
    myNextStepCount: n.myNextStepCount,
  };
  if (!cur) {
    const [row] = await w.tx.insert(meetingNotes).values({ ownerUserId: w.userId, sourceItemId: n.sourceItemId, ...cols }).returning({ id: meetingNotes.id });
    return { id: row!.id, written: true };
  }
  const patch = patchOf(cur, cols);
  if (Object.keys(patch).length) await w.tx.update(meetingNotes).set(patch).where(eq(meetingNotes.id, cur.id));
  return { id: cur.id, written: Object.keys(patch).length > 0 };
}

// ---------------------------------------------------------------------------
// Assets (Drive files)
// ---------------------------------------------------------------------------

export interface AssetProjection extends Mapping {
  externalId: string;
  kind: 'deck' | 'doc' | 'sheet' | 'pdf' | 'other';
  title: string;
  url: string | null;
  mimeType: string | null;
  lastModifiedAt: string | null;
  lastModifiedByMe: boolean;
  lastModifierName: string | null;
  workItemIds: string[];
}

export async function upsertDriveAsset(w: WriteCtx, a: AssetProjection, newId: string): Promise<Upserted> {
  const [cur] = await w.tx.select().from(assets).where(and(eq(assets.ownerUserId, w.userId), eq(assets.system, 'drive'), eq(assets.externalId, a.externalId)));
  const modified = toDate(a.lastModifiedAt);
  const cols = {
    kind: a.kind,
    title: a.title,
    url: a.url,
    mimeType: a.mimeType ?? cur?.mimeType ?? null,
    lastModifiedAt: modified ?? cur?.lastModifiedAt ?? null,
    lastModifyingPersonId: modified ? (a.lastModifiedByMe ? w.me.id : null) : (cur?.lastModifyingPersonId ?? null),
    lastModifiedByMeAt: a.lastModifiedByMe && modified ? modified : (cur?.lastModifiedByMeAt ?? null),
    accountId: a.accountId,
    opportunityId: a.opportunityId,
    mappingMethod: a.mappingMethod,
    mappingConfidence: a.mappingConfidence,
  };
  let id = cur?.id ?? newId;
  let written = false;
  if (!cur) {
    await w.tx.insert(assets).values({ id, ownerUserId: w.userId, system: 'drive', externalId: a.externalId, ...cols });
    written = true;
  } else {
    id = cur.id;
    const patch = patchOf(cur, cols, cur.mappingLocked ? MAPPING_PROPS : []);
    if (Object.keys(patch).length) {
      await w.tx.update(assets).set(patch).where(eq(assets.id, id));
      written = true;
    }
  }
  const ext = await mergeExt(w, 'assets', id, {
    updatedBy: a.lastModifiedByMe ? null : (a.lastModifierName ?? undefined),
    workItemIds: a.workItemIds.length ? a.workItemIds : undefined,
  });
  return { id, written: written || ext };
}

// ---------------------------------------------------------------------------
// Claude sessions
// ---------------------------------------------------------------------------

export interface SessionProjection extends Mapping {
  sessionExternalId: string;
  hostSessionId: string | null;
  sourceItemId: string;
  title: string;
  status: 'launching' | 'launch_failed' | 'running' | 'idle' | 'waiting_on_me' | 'completed' | 'errored' | 'abandoned';
  stateOverride: 'done' | null;
  waitingReason: 'permission_prompt' | 'question' | 'plan_approval' | 'error' | 'review_output' | 'input_needed' | null;
  waitingText: string | null;
  waitingSince: string | null;
  entrypoint: 'cli' | 'desktop' | 'vscode' | 'cowork' | 'agent_sdk' | 'scheduled_task' | 'unknown';
  cwd: string | null;
  gitBranch: string | null;
  summary: string | null;
  startedAt: string | null;
  lastActivityAt: string;
  endedAt: string | null;
  promptCount: number;
  filesChangedCount: number;
  costUsd: number | null;
  bgAgents: number;
  error: string | null;
  deepLink: string;
  /** `[cc:<work item id>]`: the app launched it; the launch row (no session id yet) is the one to fill in. */
  ccTag: string | null;
}

export async function upsertSessionFromSource(w: WriteCtx, s: SessionProjection, newId: string): Promise<Upserted> {
  let [cur] = await w.tx.select().from(claudeSessions).where(and(eq(claudeSessions.ownerUserId, w.userId), eq(claudeSessions.sessionExternalId, s.sessionExternalId)));
  if (!cur && s.ccTag) {
    const launched = await w.tx
      .select()
      .from(claudeSessions)
      .where(and(eq(claudeSessions.ownerUserId, w.userId), eq(claudeSessions.launchedByApp, true), eq(claudeSessions.launchWorkItemId, s.ccTag), sql`${claudeSessions.sessionExternalId} is null`))
      .orderBy(sql`${claudeSessions.launchRequestedAt} desc nulls last`)
      .limit(1);
    cur = launched[0];
  }
  const cols = {
    sessionExternalId: s.sessionExternalId,
    desktopSessionId: s.hostSessionId,
    entrypoint: s.entrypoint,
    status: s.status,
    waitingReason: s.waitingReason,
    waitingDetail: null,
    waitingSince: toDate(s.waitingSince),
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    title: s.title,
    summary: s.summary ?? cur?.summary ?? null,
    summaryUpdatedAt: s.summary ? new Date(s.lastActivityAt) : (cur?.summaryUpdatedAt ?? null),
    startedAt: toDate(s.startedAt),
    lastActivityAt: new Date(s.lastActivityAt),
    endedAt: toDate(s.endedAt),
    promptCount: s.promptCount,
    filesChangedCount: s.filesChangedCount,
    costUsd: s.costUsd === null ? null : Math.round(s.costUsd * 1e6) / 1e6, // numeric(12,6)
    accountId: s.accountId,
    opportunityId: s.opportunityId,
    mappingMethod: s.mappingMethod,
    mappingConfidence: s.mappingConfidence,
    sourceItemId: s.sourceItemId,
  };
  let id = cur?.id ?? newId;
  let written = false;
  if (!cur) {
    await w.tx.insert(claudeSessions).values({ id, ownerUserId: w.userId, ...cols, createdAt: toDate(s.startedAt) ?? new Date(s.lastActivityAt) });
    written = true;
  } else {
    id = cur.id;
    const patch = patchOf(cur, cols, cur.mappingLocked ? MAPPING_PROPS : []);
    if (Object.keys(patch).length) {
      await w.tx.update(claudeSessions).set(patch).where(eq(claudeSessions.id, id));
      written = true;
    }
  }
  const launched = !!cur?.launchedByApp || !!s.ccTag;
  const ext = await mergeExt(w, 'claude_sessions', id, {
    // app-launched runs end in done_review (the default map); sessions I started end in done
    stateOverride: s.stateOverride && !(launched && s.status === 'completed') ? { value: s.stateOverride, when: s.status } : null,
    deepLink: s.deepLink,
    bgAgents: s.bgAgents || null,
    error: s.error,
    waitingReason: s.waitingText,
  });
  return { id, written: written || ext };
}
