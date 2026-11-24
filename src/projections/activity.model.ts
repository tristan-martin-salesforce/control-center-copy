// The week's input and plan types (events, sessions, entries, moves) and small shared helpers. Split from activity.ts (max-lines); activity.ts re-exports every public name.
import {
  type ActivityConfig, type ActivityEntry as EngineEntry, type ActivityMappings, type CalendarEvidence,
  type ClaudeEvidence, type OnsiteDay, type OnsiteOverrides, type Org62EventRow, type TimeBlock as EngineBlock,
  type Trip, isCF, isCR, type UseCaseOption,
} from '@/engines/activity';
import type { SlackMessage } from './types';

export const ENGINE_VERSION = 'projections@1';
/** Activity dedupe-key prefixes the projections own (the engine's `cal|` / `wb|` / `onsite|`, and Org62 read-back rows). */
export const OWNED_ACTIVITY_PREFIXES = ['cal|', 'wb|', 'onsite|', 'org62|'];
/** Statuses an owned row may be rewritten or removed in. Anything else (approved and later, dismissed) is the user's. */
export const ENGINE_STATUSES = new Set(['upcoming', 'needs_input', 'proposed', 'excluded', 'dropped', 'logged']);
export interface WeekEvent {
  rowId: string;
  calendarId: string;
  externalEventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  eventType: string;
  cancelled: boolean;
  myResponse: string;
  iAmOrganizer: boolean;
  attendance: string;
  attendeeDomains: string[];
  recurring: boolean;
  /** The calendar series (recurring_event_id): a learned series rule maps every instance (src/engines/attribution). */
  seriesId?: string | null;
  hasNotes: boolean;
  url: string | null;
  accountId: string | null;
  /** The opp the resolver (or the user's mapping) picked for this meeting. */
  oppOrg62Id: string | null;
  /** Where it is (street address, room, airport): onsite days read it. */
  location?: string | null;
  /** All-day events: their first local date and the day after the last (exclusive). */
  allDayFrom?: string | null;
  allDayTo?: string | null;
}
export interface WeekSession {
  rowId: string;
  title: string;
  /** Deep link to the session (Desktop continue link). */
  url?: string | null;
  repoKey: string;
  startedAt: string | null;
  lastActivityAt: string;
  lastHumanPromptAt: string | null;
  /** The account the session is mapped to (claude_sessions.account_id: the resolver over repo, cwd, title; the user's). */
  accountId?: string | null;
  /**
   * Every human prompt with the end of Claude's turn after it (the scanner's `humanTurns`, 2026-11-14). Absent (a
   * session not re-read since): only its first prompt and its latest are known.
   */
  turns?: { at: string; runEndsAt: string }[] | null;
}
/**
 * A session's evidence inside [from, to): its human prompts in the window (each an own action, with Claude's run after
 * it, engaged.ts), else the first and latest prompt we saw; agent time is the last ≤ 4 h before its latest activity,
 * shown as leverage only. Clipped to the window.
 */
export function sessionInWindow(s: WeekSession, from: number, to: number): ClaudeEvidence | null {
  const last = Math.min(Date.parse(s.lastActivityAt), to - 1000);
  const start = s.startedAt ? Date.parse(s.startedAt) : last;
  if (Number.isNaN(last) || last < from || start >= to) return null;
  const inWin = (x: string | null | undefined): x is string => !!x && Date.parse(x) >= from && Date.parse(x) < to;
  const turns = s.turns?.length ? s.turns.filter((t) => inWin(t.at)) : null;
  const prompts = turns ? [] : [s.startedAt, s.lastHumanPromptAt].filter(inWin);
  const bgStart = Math.max(start, last - 4 * 60 * MIN, from);
  return {
    sessionId: s.rowId,
    repoKey: s.repoKey,
    title: s.title,
    accountKey: s.accountId ?? null,
    ...(turns ? { turns } : {}),
    promptTimes: [...new Set(prompts)],
    backgroundSegments: last - bgStart >= MIN ? [{ startsAt: new Date(bgStart).toISOString(), endsAt: new Date(last).toISOString() }] : [],
  };
}
/** An email I sent (Gmail): the recipients' domains only, never addresses. */
export interface WeekEmail {
  id: string;
  subject: string | null;
  domains: string[];
  at: string;
}
export interface WeekDriveEdit {
  fileId: string;
  title: string;
  at: string;
  url?: string | null;
}
export interface WeekOrg62Event extends Org62EventRow {
  rowId: string;
  whatName: string | null;
}
/** A row the user owns (approved and later, or with locked fields): fixed in place, only read-back moves it. */
export interface FixedEntry {
  rowId: string;
  dedupeKey: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  durationHours: number;
  seTaskType: string | null;
  whatOrg62Id: string | null;
  meetingType: string | null;
  status: string;
  operation: 'create' | 'update' | 'delete';
  targetOrg62EventId: string | null;
  /** Why an `excluded` row is excluded; an `overlap` the engine decided is not the user's dismissal (it can come back). */
  excludedReason?: string | null;
  /** Its flags (a declined meeting's flag is added once). */
  flags?: string[];
  /** D-65: the Org62 Event row it is tied to (logged, verified): the read-back pairs on it first (TL-12). */
  org62EventRowId?: string | null;
  /** The columns the user edited (`user_locked_fields`): a rescheduled meeting's row keeps an edited length (TL-32). */
  lockedFields?: readonly string[];
}
export interface DesiredEntry {
  dedupeKey: string;
  origin: 'calendar' | 'evidence' | 'manual';
  subject: string;
  description: string;
  startsAt: string;
  endsAt: string;
  durationHours: number;
  seTaskType: string | null;
  /** Contract CF / CR (customer facing / related). */
  meetingType: 'CF' | 'CR' | null;
  customerFacing: boolean;
  customerRelated: boolean;
  whatKind: 'opportunity' | 'account' | 'none';
  whatOrg62Id: string | null;
  whatName: string | null;
  confidence: 'sure' | 'likely' | 'guess';
  reason: string;
  flags: string[];
  /** `dismissed`: a "Dismiss all from …" rule covers its source (D-64; the user's status from then on). */
  status: 'upcoming' | 'needs_input' | 'proposed' | 'excluded' | 'logged' | 'dismissed';
  excludedReason: 'neither_type' | 'overlap' | 'ooo' | 'placeholder' | 'cap_trimmed' | 'duplicate' | null;
  org62EventRowId: string | null;
  sources: { kind: 'calendar' | 'org62' | 'claude' | 'drive' | 'slack'; label: string; url?: string; externalId?: string; at?: string }[];
  /** false when you were there in person (onsite days, customer dinners, travel). */
  remote: boolean;
  /** D-64: internal-only work: no WhatId, CF / CR off, an internal task type. */
  internal?: boolean;
  /**
   * D-66: the note the Org62 Description carries (before its CC# key): the cheap model's over the meeting notes when
   * the `activity.notes` job made one, else the template over the row's evidence. Null on Org62's own rows.
   */
  logNote: string | null;
  logNoteBasis: 'template' | 'summary' | null;
}
/**
 * D-64: a row I own whose meeting I declined. `remove`: it never reached a canvas or Org62, so it goes (a declined
 * meeting never shows on Time). `flag`: it is handed off (or waits in a canvas item): it stays, flagged; the app never
 * deletes an Org62 Event.
 */
export interface DeclinedMove {
  rowId: string;
  action: 'remove' | 'flag';
  flag?: string;
}
/** A row the user touched (locked fields) that the engine had excluded only for an overlap and now logs again. */
export interface ReviveMove {
  rowId: string;
  status: 'upcoming' | 'needs_input' | 'proposed';
  flags: string[];
  /** `rule`: a row a "Dismiss all from …" rule had set aside, whose rule is gone (D-64: Undo, Remove). */
  kind?: 'overlap' | 'rule';
}
export interface ReadbackMove {
  rowId: string;
  status: 'logged' | 'verified' | 'verify_failed';
  org62EventRowId: string;
  issues: string[];
  /**
   * The user edited an already-verified Event in Org62 (opp, task type, meeting type): Org62 is the record, so the row
   * takes its values and stays verified, instead of a stale opp in the app or a verify_failed that re-issues the old one.
   */
  adopt?: {
    whatOrg62Id: string | null;
    seTaskType: string | null;
    meetingType: string | null;
    note: string;
    /** D-65 (TL-11, TL-12): Org62's hours, start, end and subject, only where they differ from the row. */
    durationHours?: number;
    startsAt?: string;
    endsAt?: string;
    subject?: string;
  };
}
/** D-65 (TL-32): a row whose meeting moved in Calendar follows it: its key (the event id, the new start) and times. */
export interface RekeyMove {
  rowId: string;
  dedupeKey: string;
  startsAt: string;
  endsAt: string;
  durationHours: number;
}
/** D-65 (TL-03): an approved row one Org62 Event already covers (with another meeting): closed, never logged twice. */
export interface CoverMove {
  rowId: string;
  org62EventRowId: string;
  flag: string;
}
/** D-65: the round-trip flags of a user's row (Not in Org62, the start Slackbot moved, a reschedule after hand-off). */
export interface FlagMove {
  rowId: string;
  remove: string[];
  add: string[];
}
export interface DesiredBlock {
  dedupeKey: string;
  source: EngineBlock['source'];
  startsAt: string;
  endsAt: string;
  localDay: string;
  attention: EngineBlock['attention'];
  countsAsHumanHours: boolean;
  precedence: number;
  isOverlay: boolean;
  accountId: string | null;
  calendarEventId: string | null;
  label: string;
}
export interface WeekInput {
  now: string;
  /** Org62 Events that start before this (the fiscal quarter's start) get no logged row of their own. */
  loggedFrom?: string;
  /** The window [from, to) the plan is for (a local week). Evidence outside it belongs to another pass. */
  from: string;
  to: string;
  cfg: ActivityConfig;
  mappings: ActivityMappings;
  events: WeekEvent[];
  sessions: WeekSession[];
  drive: WeekDriveEdit[];
  slack: SlackMessage[];
  /** Emails I sent (each an own action for solo work). */
  emails?: WeekEmail[];
  org62: WeekOrg62Event[];
  fixed: FixedEntry[];
  /** Counted time blocks the projections do not own (manual blocks): projected blocks never double-count them. */
  fixedBlocks: { startsAt: string; endsAt: string }[];
  /**
   * Org62 opp / account id → display names. `mine` (opps): I'm on its team or hold a DC on it; false holds a row the
   * resolver put on it for the user (NOT_ON_TEAM_FLAG). Absent: unknown, nothing is held.
   */
  names: (org62Id: string) => { name: string; mine?: boolean } | null;
  /** Events of the days around the week (hotels, flights, onsite markers): onsite detection only. */
  context?: WeekEvent[];
  /** The user's onsite corrections (day chips, Mark trip). */
  onsiteOverrides?: OnsiteOverrides;
  /** D-64: the sources the user dismissed all rows of (`repo:<name>`, `docs:unmapped`, `series:<calendar>|<id>`). */
  dismissRules?: readonly { key: string; label: string }[];
  /** Rows of mine that wait in a canvas item not applied yet (a declined meeting's row there is flagged, not removed). */
  held?: ReadonlySet<string>;
  /** D-65 (TL-02): an Org62 opp id → its Org62 account id (the slot rule's "same account"). */
  accountOf?: (org62Id: string) => string | null;
  /** D-65 (TL-12): Org62 Events an app row outside this pass is tied to: that row's, never mirrored or matched here. */
  linkedElsewhere?: ReadonlySet<string>;
  /**
   * D-66: a meeting's notes, by calendar event row id: the cheap model's note when the `activity.notes` job made one,
   * and the next step they give (the first to-do the scanner took from them). Absent: no notes.
   */
  meetingNotes?: (eventRowId: string) => { summary: string | null; nextStep: string | null } | null;
  /** D-66: an opp's VDP use cases (the VDP mirror), by Org62 opp id. */
  useCases?: (oppOrg62Id: string) => readonly UseCaseOption[];
}
export interface WeekPlan {
  entries: DesiredEntry[];
  /**
   * The engine's proposals for rows the user already owns (approved and later, or edited) and their continuations
   * (`#2` …): never written, the user's row stands. The re-derive (rederive.ts) compares their hours with the row's:
   * a row in Org62 whose hours would change is an update candidate, never edited in place.
   */
  shadowed: { dedupeKey: string; baseKey: string; durationHours: number; reason: string; evidence: string }[];
  moves: ReadbackMove[];
  /** Overlap-excluded rows the user owns (edited) that log again: status and flags only, their fields stay theirs. */
  revives: ReviveMove[];
  blocks: DesiredBlock[];
  humanHours: number;
  leverageHours: number;
  /** The week's onsite days (detected, confirmed, not onsite) and the trips around them. */
  onsite: OnsiteDay[];
  trips: Trip[];
  /** D-64: rows I own whose meeting I declined (removed, or flagged when handed off); D-65: cancelled ones too. */
  declined: DeclinedMove[];
  /** D-65 (TL-32): rows whose meeting was rescheduled, re-keyed to the meeting's new time. */
  rekeys: RekeyMove[];
  /** D-65 (TL-03): approved rows an Org62 Event already covers. */
  covers: CoverMove[];
  /** D-65: round-trip flags on the user's rows. */
  flagMoves: FlagMove[];
}
export const MIN = 60_000;
/** The stored event type; flights, hotel stays and markers are the engine's call (event-kinds.ts, eventKind). */
export const kindOf = (e: WeekEvent): CalendarEvidence['kind'] =>
  e.eventType === 'out_of_office' ? 'ooo' : e.eventType === 'focus_time' ? 'focus' : e.eventType === 'working_location' ? 'working_location' : 'default';
export function selfResponse(e: WeekEvent): CalendarEvidence['selfResponse'] {
  if (e.myResponse === 'accepted' || e.myResponse === 'declined' || e.myResponse === 'tentative') return e.myResponse;
  return e.iAmOrganizer ? 'accepted' : 'needsAction';
}
export const confOf = (c: EngineEntry['confidence']): DesiredEntry['confidence'] => (c === 'High' ? 'sure' : c === 'Medium' ? 'likely' : 'guess');
export const cfcr = (type: string | null): { meetingType: DesiredEntry['meetingType']; cf: boolean; cr: boolean } => {
  const t = type ?? '';
  const cf = isCF(t);
  const cr = isCR(t);
  return { meetingType: cf ? 'CF' : cr ? 'CR' : null, cf, cr };
};
