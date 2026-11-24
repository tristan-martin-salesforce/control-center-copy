/**
 * Time page: week timeline lanes + activity-log table (R-UI-6).
 */
import { z } from 'zod';
import { ActivityStatus, Confidence, Id, IsoDate, IsoDateTime, SourceRef, Version } from './common';
import { Groundwork } from './attribution';

/** The attribution engine's API (learned rules, DC suggestions, the rundown, AEs I cover): src/contract/attribution.ts. */
export * from './attribution';
// use-case candidates (src/engines/use-cases; lane 06 R6): their API types ride with Time's
export * from './use-cases';

export const ActivityLockableField = z.enum(['date', 'start', 'end', 'durationH', 'taskType', 'oppId', 'meetingType', 'description', 'status', 'logNote']);
export type ActivityLockableField = z.infer<typeof ActivityLockableField>;

/**
 * The fields an edit locks: every edited field except `status`, the row's place in the logging pipeline (approved →
 * synced_to_canvas → logged → verified). A created canvas and the Org62 check move it; a lock must never hold a
 * handed-off row at approved, where the next batch would log it again. (`status` stays in the enum: older rows carry it.)
 */
export const lockableActivityFields = (fields: readonly ActivityLockableField[]): ActivityLockableField[] => fields.filter((f) => f !== 'status');

/**
 * Why a `dismissed` row is not logged. The engine's exclusion reasons (db `excluded`: neither CF nor CR, overlaps
 * another row, out of office, a placeholder event, trimmed by the daily cap, a duplicate), `dropped` (a newer
 * proposal replaced it), `dismissed` (you dismissed it) and `dismiss_rule` (your "Dismiss all from …" rule covers its
 * source, D-64). Null on every other status.
 */
export const ActivityExcludedReason = z.enum(['neither_type', 'overlap', 'ooo', 'placeholder', 'cap_trimmed', 'duplicate', 'dropped', 'dismissed', 'dismiss_rule']);
export type ActivityExcludedReason = z.infer<typeof ActivityExcludedReason>;

/**
 * D-64: the source a "Dismiss all from …" rule covers: one repo's work blocks (`repo:<name>`), unmapped Drive docs
 * (`docs:unmapped`), one recurring meeting series (`series:<calendar>|<series id>`).
 */
export const TimeDismissSourceKind = z.enum(['repo', 'docs', 'series']);
export type TimeDismissSourceKind = z.infer<typeof TimeDismissSourceKind>;
export const TimeDismissSource = z.object({
  key: z.string().min(3).max(300),
  kind: TimeDismissSourceKind,
  /** "command-center" (a repo), "unmapped Drive docs", "'Weekly asset sync'" (a series). */
  label: z.string(),
});
export type TimeDismissSource = z.infer<typeof TimeDismissSource>;

/**
 * What the app suggests for a row that needs an opportunity (src/lib/time-suggest.ts): internal work, or which opp,
 * with a short reason and how sure it is (0–1). `rules`: the app's own ranking (the meeting's opp, the account's only
 * open opp, an attendee's domain, a Slack channel's name); `ai`: the cheap model's answer for what the rules can't
 * settle. Never applied for you: Accept (one row, or many) sets it like any pick.
 */
export const ActivitySuggestion = z.object({
  kind: z.enum(['opp', 'internal']),
  oppId: Id.nullable(),
  oppName: z.string().nullable(),
  accountName: z.string().nullable(),
  /** Internal: the internal task type it would take (Asset Creation, Personal Development…); null: the row's own, else the default. */
  taskType: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  basis: z.enum(['rules', 'ai']),
  /** When the model answered (ai); null for rules. */
  at: IsoDateTime.nullable().default(null),
});
export type ActivitySuggestion = z.infer<typeof ActivitySuggestion>;

export const ActivityEntry = z.object({
  id: Id,
  version: Version,
  date: IsoDate,
  start: IsoDateTime,
  end: IsoDateTime,
  /** Hours in 0.25 steps. Human hours only: agent time is never totalled here. */
  durationH: z.number().multipleOf(0.25).min(0),
  /** SE task type (team-pack vocabulary), e.g. "Demo", "Discovery", "Solution Design". */
  taskType: z.string().nullable(),
  /** Opportunity (WhatId) — nullable until mapped. */
  oppId: Id.nullable(),
  oppName: z.string().nullable().default(null),
  accountName: z.string().nullable().default(null),
  /** CF = customer-facing, CR = customer-related (internal prep). */
  meetingType: z.enum(['CF', 'CR']).nullable(),
  description: z.string(),
  status: ActivityStatus,
  confidence: Confidence.default('likely'),
  sources: z.array(SourceRef).default([]),
  userLockedFields: z.array(ActivityLockableField).default([]),
  /** Validation notes ("needs opp", "overlaps 10:00 block"). */
  issues: z.array(z.string()).default([]),
  updatedAt: IsoDateTime,
  /** Read from an Org62 Event (not proposed here): logged by definition, so there is nothing to confirm. */
  fromOrg62: z.boolean().default(false),
  /** Set on `dismissed` rows only: why the row is not logged. */
  excludedReason: ActivityExcludedReason.nullable().default(null),
  /** When the row was logged in Org62 (logged / verified rows). */
  loggedAt: IsoDateTime.nullable().default(null),
  /** When Org62 read-back verified it (verified rows). */
  verifiedAt: IsoDateTime.nullable().default(null),
  /**
   * Derived on read: the Outbox canvas item this row waits in (staged, not Applied yet). A new logging batch skips
   * it; the row stays `approved` until the canvas exists.
   */
  canvasDraftId: Id.optional(),
  /**
   * D-64: internal-only work (no opp, no account, no customer; an internal task type such as Asset Creation): it logs
   * as a Solutions Event with Related To empty, never asks for an opportunity, and waits for your Log (or Dismiss).
   */
  internal: z.boolean().default(false),
  /** D-64: the source "Dismiss all from …" covers for this row; null: only the row itself can be dismissed. */
  dismissSource: TimeDismissSource.nullable().default(null),
  /**
   * D-66: the note logged as the Org62 Event's Description (the `CC#<id>` key follows it there): what was done and
   * with whom, the use case, the next step. Drafted by the app until you edit it (`logNote` in userLockedFields: yours,
   * never rewritten). Null: none drafted yet (a row read from Org62, one not projected since D-66).
   */
  logNote: z.string().nullable().default(null),
  /** How the app drafted `logNote`: from the row's evidence (`template`) or the cheap model over the meeting notes (`summary`). */
  logNoteBasis: z.enum(['template', 'summary']).nullable().default(null),
  /**
   * Why the app proposed the row as it did (the engine's reason: "external meeting, no keyword", "estimated from
   * evidence (guess)"); null for rows made here or read from Org62.
   */
  why: z.string().nullable().default(null),
  /** Derived on read: what the app suggests while the row needs an opportunity (null otherwise). */
  suggestion: ActivitySuggestion.nullable().default(null),
  /**
   * Derived on read: the attribution engine's ranked top 3 (src/engines/attribution/row.ts), `suggestion` first when
   * there is one; Accept takes any of them in one click. Absent or empty on rows that don’t need an opportunity.
   */
  suggestions: z.array(ActivitySuggestion).optional(),
  /**
   * D-103 (c): the account the row logs to when it has no opportunity (a Solutions Event on the Account); null or
   * absent: none (an opportunity row, internal work, or a row still to settle).
   */
  accountId: Id.nullable().optional(),
  /** Derived on read (D-103 (c)): why the row logs where it does, one factual sentence. */
  groundwork: Groundwork.nullable().optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/**
 * D-64: a remembered "Dismiss all from <source>": every row of that source is set aside (Dismissed by your rule) now
 * and on every re-projection, until you Remove it (Settings ▸ Time ▸ Dismissed sources) or Undo it.
 */
export const TimeDismissRule = TimeDismissSource.extend({
  createdAt: IsoDateTime,
  /** Rows it sets aside right now. */
  rows: z.number().int().min(0).default(0),
});
export type TimeDismissRule = z.infer<typeof TimeDismissRule>;

export const TimeDismissRules = z.object({ rules: z.array(TimeDismissRule) });
export type TimeDismissRules = z.infer<typeof TimeDismissRules>;

/** POST /time/dismiss-rules: "Dismiss all from <source>" on this row's source. */
export const DismissSourceRequest = z.object({ entryId: Id });
export type DismissSourceRequest = z.infer<typeof DismissSourceRequest>;

export const DismissSourceResult = z.object({
  rule: TimeDismissRule,
  /** The rows set aside now (live rows of the source: upcoming, needs input, proposed). */
  dismissedIds: z.array(Id),
});
export type DismissSourceResult = z.infer<typeof DismissSourceResult>;

/** POST /time/dismiss-rules/remove: Remove a rule; its rows come back (re-proposed). */
export const RemoveDismissRuleRequest = z.object({ key: z.string().min(3).max(300) });
export type RemoveDismissRuleRequest = z.infer<typeof RemoveDismissRuleRequest>;

// ---------------------------------------------------------------------------
// The whole activity log (GET /time/log): every row, history included
// ---------------------------------------------------------------------------

/**
 * The Log view's status buckets. `handed_off` = on the work-order canvas or written but missing in Org62
 * (synced_to_canvas, verify_failed); `excluded` = every dismissed row (see `excludedReason`).
 */
export const ActivityLogStatus = z.enum(['upcoming', 'needs_input', 'proposed', 'approved', 'handed_off', 'logged', 'verified', 'excluded']);
export type ActivityLogStatus = z.infer<typeof ActivityLogStatus>;

export function activityLogStatus(s: ActivityStatus): ActivityLogStatus {
  if (s === 'synced_to_canvas' || s === 'verify_failed') return 'handed_off';
  if (s === 'dismissed') return 'excluded';
  return s;
}

/** Human hours of a group: `hours` counts live rows (not excluded, not upcoming); `loggedH` the logged and verified ones. */
export const ActivityLogTotal = z.object({
  rows: z.number().int(),
  hours: z.number(),
  loggedH: z.number(),
});
export type ActivityLogTotal = z.infer<typeof ActivityLogTotal>;

export const ActivityLogQuarter = z.object({
  label: z.string(), // "Q3 FY27"
  start: IsoDate,
  end: IsoDate,
  /** Logged + verified hours whose day falls in the quarter (the current quarter adds the seeded base hours). */
  loggedH: z.number(),
  verifiedH: z.number(),
  targetH: z.number(),
  /** The current quarter's deadline; null for the others. */
  due: IsoDateTime.nullable(),
  current: z.boolean(),
  /** Rows in the quarter, every status. */
  rows: z.number().int(),
});
export type ActivityLogQuarter = z.infer<typeof ActivityLogQuarter>;

export const ActivityLog = z.object({
  /** The range asked for (inclusive local days); null = open-ended. */
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  /** The rows in range that pass every filter, newest first. The key is `entries` like TimeWeek's (Details and optimistic patches find rows by it). */
  entries: z.array(ActivityEntry),
  /** All filtered rows together. */
  total: ActivityLogTotal,
  /** Rows per status in range (search and account / opp filters applied, the status filter not): the chip counts. */
  counts: z.object(Object.fromEntries(ActivityLogStatus.options.map((s) => [s, z.number().int()])) as Record<ActivityLogStatus, z.ZodNumber>),
  /** Totals of the filtered rows per week (Monday first) and per calendar month, newest first. */
  weeks: z.array(ActivityLogTotal.extend({ weekStart: IsoDate, weekEnd: IsoDate })),
  months: z.array(ActivityLogTotal.extend({ month: z.string().regex(/^\d{4}-\d{2}$/) })),
  /** Every fiscal quarter that has rows, plus the current one, newest first. Ignores the range and filters. */
  quarters: z.array(ActivityLogQuarter),
  /** Accounts and opportunities in range (search and status applied, account / opp not): the filter menus. */
  facets: z.object({
    accounts: z.array(z.object({ name: z.string(), rows: z.number().int() })),
    opps: z.array(z.object({ id: Id, name: z.string(), accountName: z.string().nullable(), rows: z.number().int() })),
    /** Task types in range (search, status, account and opp applied, type not); `name` null = rows with no type. */
    types: z.array(z.object({ name: z.string().nullable(), rows: z.number().int() })).default([]),
  }),
});
export type ActivityLog = z.infer<typeof ActivityLog>;

// ---------------------------------------------------------------------------
// The Ledger (GET /time/ledger): one fiscal quarter, or every one, as a report
// ---------------------------------------------------------------------------

/** `quarter`: a fiscal quarter label ("Q3 FY27"), or `all`; absent = the current quarter. */
export const TimeLedgerQuarter = z.union([z.literal('all'), z.string().regex(/^Q[1-4] FY\d{2}$/)]);

/**
 * Human hours of one slice of the ledger (tenet: Hours are human hours): live rows only (never excluded or upcoming
 * ones), `loggedH` the part in Org62 (TL-45: the one count map), `share` of the ledger's hours (0–1).
 */
export const TimeLedgerSlice = z.object({
  rows: z.number().int(),
  hours: z.number(),
  loggedH: z.number(),
  share: z.number(),
});
export type TimeLedgerSlice = z.infer<typeof TimeLedgerSlice>;

export const TimeLedgerOpp = TimeLedgerSlice.extend({
  /** null: the account's rows with no opportunity. */
  oppId: Id.nullable(),
  name: z.string(),
});
export type TimeLedgerOpp = z.infer<typeof TimeLedgerOpp>;

export const TimeLedgerAccount = TimeLedgerSlice.extend({
  /** The rows' account name; null: rows with an opportunity and no account name. */
  name: z.string().nullable(),
  /** Its opportunities (and its rows with none), most hours first. */
  opps: z.array(TimeLedgerOpp),
});
export type TimeLedgerAccount = z.infer<typeof TimeLedgerAccount>;

export const TimeLedgerType = TimeLedgerSlice.extend({ type: z.string().nullable() });
export type TimeLedgerType = z.infer<typeof TimeLedgerType>;

/** One column of the ledger's chart: a week of the quarter (Monday first, clipped to the quarter), or a quarter. */
export const TimeLedgerPeriod = z.object({
  /** The week's Monday, or the quarter's label. */
  key: z.string(),
  label: z.string(),
  start: IsoDate,
  end: IsoDate,
  rows: z.number().int(),
  hours: z.number(),
  loggedH: z.number(),
});
export type TimeLedgerPeriod = z.infer<typeof TimeLedgerPeriod>;

export const TimeLedger = z.object({
  /** The quarter shown ("Q4 FY27", the current one when none was asked for) or `all`. */
  quarter: TimeLedgerQuarter,
  /** Its days (inclusive); null for `all`. */
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  /** Every fiscal quarter that has rows, plus the current one, newest first (GET /time/log's `quarters`). */
  quarters: z.array(ActivityLogQuarter),
  /**
   * The ledger's live rows by the one count map: in Org62 (`loggedH`, read-back verified `verifiedH`), on its way
   * (approved or handed to a canvas, not in Org62 yet), suggested (proposed), needs input, and not in Org62 after all
   * (deleted there, its canvas ran without it, a legacy record type). They add up to `hours`. `earlierH`: the current
   * quarter's hours logged before the app's rows (no rows, so in no breakdown). Excluded rows count apart.
   */
  totals: z.object({
    rows: z.number().int(),
    hours: z.number(),
    loggedH: z.number(),
    verifiedH: z.number(),
    approvedH: z.number(),
    approvedRows: z.number().int(),
    proposedH: z.number(),
    proposedRows: z.number().int(),
    needsInputH: z.number(),
    needsInputRows: z.number().int(),
    missingH: z.number(),
    missingRows: z.number().int(),
    earlierH: z.number(),
    excludedRows: z.number().int(),
    excludedH: z.number(),
  }),
  /** By account, most hours first; each with its opportunities. */
  accounts: z.array(TimeLedgerAccount),
  /** D-64: internal-only work (no opportunity by design). */
  internal: TimeLedgerSlice,
  /** Rows with no account, no opportunity, and not internal: they need an opportunity. */
  unassigned: TimeLedgerSlice,
  /** By task type, most hours first; `type` null = rows with no type. */
  types: z.array(TimeLedgerType),
  /** The chart: the quarter's weeks, or every quarter (oldest first). */
  periods: z.object({ kind: z.enum(['week', 'quarter']), items: z.array(TimeLedgerPeriod) }),
});
export type TimeLedger = z.infer<typeof TimeLedger>;

export const TimelineBlock = z.object({
  id: Id,
  start: IsoDateTime,
  end: IsoDateTime,
  label: z.string(),
  activityId: Id.nullable().default(null),
  /** Agent time is hatched and never totalled (brief 08 §2.9). */
  hatched: z.boolean().default(false),
});
export type TimelineBlock = z.infer<typeof TimelineBlock>;

export const TimelineLane = z.object({
  id: z.enum(['meetings', 'focus', 'claude', 'drive', 'slack']),
  label: z.string(),
  blocks: z.array(TimelineBlock),
});
export type TimelineLane = z.infer<typeof TimelineLane>;

// ---------------------------------------------------------------------------
// Onsite days (onsite lane): one chip per day, its signals, and the corrections
// ---------------------------------------------------------------------------

export const OnsiteSignalKind = z.enum(['correction', 'org62', 'onsite_event', 'customer_meeting', 'hotel_flight', 'working_location', 'flight']);
export type OnsiteSignalKind = z.infer<typeof OnsiteSignalKind>;

export const OnsiteSignal = z.object({
  kind: OnsiteSignalKind,
  /** "All-day event "ACCOUNT onsite"", "Trip to CITY: hotel stay + 2 flights" */
  label: z.string(),
  /** false: seen but it did not decide the day (a stale working location, a weaker signal). */
  used: z.boolean(),
});
export type OnsiteSignal = z.infer<typeof OnsiteSignal>;

/** A local day you were onsite (detected or confirmed), or one you marked not onsite. */
export const OnsiteDay = z.object({
  day: IsoDate,
  status: z.enum(['detected', 'confirmed', 'not_onsite']),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  /** The opp (or account) Org62 id the onsite rows log to, one for the whole trip. */
  whatOrg62Id: z.string().nullable(),
  whatName: z.string().nullable(),
  city: z.string().nullable(),
  /** The clock the onsite hours follow (the trip's, else the profile's). */
  timezone: z.string(),
  /** The onsite frame: never overnight; real sessions inside keep their own rows, the frame fills the gaps. */
  frame: z.object({ start: IsoDateTime, end: IsoDateTime }).nullable(),
  /** "08:00–17:00 EDT · default onsite hours" */
  hoursLabel: z.string(),
  signals: z.array(OnsiteSignal),
  trip: z.object({ from: IsoDate, to: IsoDate }).nullable(),
  /** Your correction holds it: recomputes never change it (tenet: Suggest, then learn). */
  locked: z.boolean(),
});
export type OnsiteDay = z.infer<typeof OnsiteDay>;

const Hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

/** POST /time/onsite/days/:day — Confirm, Not onsite, Change account, Adjust hours, or Clear (back to detection). */
export const OnsiteCorrection = z.object({
  action: z.enum(['confirm', 'not_onsite', 'change_account', 'adjust_hours', 'clear']),
  /** change_account: the account (and optionally its opp) the trip logs to. */
  accountId: Id.nullable().optional(),
  oppId: Id.nullable().optional(),
  /** adjust_hours: "HH:MM" in the trip's time zone. */
  start: Hm.optional(),
  end: Hm.optional(),
});
export type OnsiteCorrection = z.infer<typeof OnsiteCorrection>;

export const OnsiteDayParams = z.object({ day: IsoDate });
export type OnsiteDayParams = z.infer<typeof OnsiteDayParams>;

/** POST /time/onsite/trips — "Mark trip": these days [from, to] were onsite at this account. */
export const MarkTripRequest = z.object({
  from: IsoDate,
  to: IsoDate,
  accountId: Id,
  oppId: Id.nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  /** IANA zone of the trip; absent: the hotel / airports say, else the profile's. */
  timezone: z.string().max(64).nullable().optional(),
});
export type MarkTripRequest = z.infer<typeof MarkTripRequest>;

/**
 * A logging canvas (D-47) as Time shows it: one Outbox `slack_canvas.create` item, waiting for your Apply or applied.
 * Applied ones are Time's receipts (Applied canvases) and the Confirm step's canvases; the Slackbot prompt is built from
 * these fields and the persona's record type (src/lib/canvas/prompt.ts).
 */
/** 2026-11-13 audit C4: one part of a handed-off canvas as Org62 has it (Events, DCs or use cases). */
export const CanvasProgressPart = z.object({
  total: z.number().int().min(0),
  /** In Org62 (an Event read back, a DC the scan read, a use case linked). */
  inOrg62: z.number().int().min(0),
  /** Not in Org62 after the canvas ran (an Event missing or deleted there, a DC not created). */
  missing: z.number().int().min(0),
});
export type CanvasProgressPart = z.infer<typeof CanvasProgressPart>;

/**
 * 2026-11-13 audit C4: each handed-off canvas's own progress on Time ▸ Log it ("4 of 4 Events · 55 of 55 DCs · 3 of 3
 * use cases in Org62 · checked 17:49"), so two canvases in flight are told apart and the last step never looks stuck.
 */
export const CanvasProgress = z.object({
  events: CanvasProgressPart,
  dcs: CanvasProgressPart,
  useCases: CanvasProgressPart,
  /**
   * waiting: created, Slackbot not told yet · checking: you told Slackbot (copied its prompt), the app re-reads Org62 ·
   * in_org62: everything on it is in Org62 · missing: Org62 lacks some after it ran (Needs you offers Log again).
   */
  state: z.enum(['waiting', 'checking', 'in_org62', 'missing']),
  /** When you last copied its Slackbot prompt (the app then re-checks Org62 about 5, 15, 30 and 60 minutes later). */
  toldAt: IsoDateTime.nullable(),
  /** The oldest of the latest Org62 reads its parts need (Events, DCs, use cases) since it was applied: null = not all read yet. */
  checkedAt: IsoDateTime.nullable(),
  /** The next re-check queued for it; null: the normal scan cadence. */
  nextCheckAt: IsoDateTime.nullable(),
});
export type CanvasProgress = z.infer<typeof CanvasProgress>;

export const LogCanvas = z.object({
  draftId: Id,
  title: z.string(),
  /**
   * pending: waiting for your Apply · retry: the Apply failed (Apply again) · applying: applied, on its way to Slack ·
   * applied: the canvas exists · verified: read back in Slack · unverified: the read-back didn't find the work order.
   */
  state: z.enum(['pending', 'retry', 'applying', 'applied', 'verified', 'unverified']),
  /** The canvas in Slack, once it exists. */
  url: z.string().nullable(),
  createdAt: IsoDateTime,
  /** The live Apply (its delivery attempt); null while pending. */
  appliedAt: IsoDateTime.nullable(),
  /** Activity rows (Org62 Events to create) and their human hours. */
  rows: z.number().int().min(0),
  hours: z.number().min(0),
  /** Deal Contribution ADD rows and Duration fixes riding on it. */
  dcs: z.number().int().min(0),
  updates: z.number().int().min(0),
  /** D-67: Use_Case__c rows riding on it (creates in its USE CASES table, Stage / Go-Live fixes in UPDATE). */
  useCases: z.number().int().min(0).default(0),
  rowIds: z.array(Id),
  /**
   * The Org62 check over its rows once applied: in Org62 (logged or verified), still waiting, missing after the write.
   * Null while it is not applied or carries no rows.
   */
  org62: z.object({ logged: z.number().int().min(0), waiting: z.number().int().min(0), missing: z.number().int().min(0) }).nullable(),
  /**
   * Where its hours land: its rows per Salesforce fiscal quarter of their day ("Q3 FY27"), newest quarter first. A
   * canvas staged early in a quarter often carries rows dated in the one before; Time's header says so.
   */
  quarters: z.array(z.object({ label: z.string(), rows: z.number().int().min(0), hours: z.number().min(0) })).default([]),
  /**
   * 2026-11-13 audit B3: the last Apply got no answer (or the app stopped mid-way), so the canvas may exist already:
   * check Slack before you Apply again (a second canvas would be a second work order). Only on `retry`.
   */
  maybeCreated: z.boolean().default(false),
  /** 2026-11-13 audit C4: what of it Org62 has, part by part, and when it was checked (created canvases only). */
  progress: CanvasProgress.nullable().default(null),
});
export type LogCanvas = z.infer<typeof LogCanvas>;

/** POST /time/canvases/:id/org62-check: `copied` = you just copied its Slackbot prompt; `now` = "Slackbot's done: check now". */
/** copied: its Slackbot prompt was copied · applied: the canvas was just Applied (re-checks, not "told") · now: check now. */
export const CheckCanvasOrg62Request = z.object({ reason: z.enum(['copied', 'applied', 'now']) });
export type CheckCanvasOrg62Request = z.infer<typeof CheckCanvasOrg62Request>;

export const CheckCanvasOrg62Result = z.object({
  draftId: Id,
  /** The Org62 reads queued for it (read only), each when it runs. */
  queued: z.array(z.object({ read: z.enum(['events', 'dcs', 'use_cases']), at: IsoDateTime })),
  nextCheckAt: IsoDateTime.nullable(),
  /** Why nothing was queued (Org62 needs re-auth, the mock): null when the reads are queued. */
  note: z.string().nullable().default(null),
});
export type CheckCanvasOrg62Result = z.infer<typeof CheckCanvasOrg62Result>;

export const TimeWeek = z.object({
  weekStart: IsoDate, // Monday
  weekEnd: IsoDate,
  timeline: z.array(TimelineLane),
  entries: z.array(ActivityEntry),
  /** Onsite days of the week (onsite lane, additive): the day chips. */
  onsite: z.array(OnsiteDay).default([]),
  totals: z.object({
    proposedH: z.number(),
    approvedH: z.number(),
    loggedH: z.number(),
    needsReview: z.number().int(),
  }),
  quarter: z.object({
    label: z.string(), // "Q4 FY27"
    loggedH: z.number(),
    targetH: z.number(),
    due: IsoDateTime.nullable(),
  }),
  canvas: z.object({
    lastSyncedAt: IsoDateTime.nullable(),
    rowsChangedSince: z.number().int(),
    /** First sync of the day needs a confirm (UI-SPEC §8). */
    confirmRequired: z.boolean(),
    label: z.string(), // "Work-order canvas"
  }),
  org62: z.object({
    lastReadbackAt: IsoDateTime.nullable(),
    verified: z.number().int(),
    pending: z.number().int(),
  }),
  /**
   * Logging canvases, newest first: every one waiting for your Apply (or a retry), and the applied ones of the last
   * 14 days plus any older one whose rows are not all in Org62 yet (src/server/datasource/log-canvases.ts).
   */
  logCanvases: z.array(LogCanvas).default([]),
});
export type TimeWeek = z.infer<typeof TimeWeek>;

export const CanvasSyncResult = z.object({
  dryRun: z.boolean(),
  syncedAt: IsoDateTime,
  rowsSynced: z.number().int(),
  /** The canvas markdown that was (dry-run: would have been) written. */
  payload: z.string(),
  entries: z.array(ActivityEntry),
  auditId: Id,
});
export type CanvasSyncResult = z.infer<typeof CanvasSyncResult>;

// ---------------------------------------------------------------------------
// Logging batches (D-47): approved rows → Slackbot work orders → one Outbox canvas item each
// ---------------------------------------------------------------------------

export const StageLogBatchRequest = z.object({
  /** YYYY-MM-DD bounds on the rows' local dates (inclusive); default everything that has ended. */
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  /** Also take complete proposed rows (task type + WhatId) and approve them; default: Settings ▸ Time ▸ Logging. */
  includeProposed: z.boolean().optional(),
  /**
   * Log DCs now: a canvas of the pending Deal Contribution requests only, on purpose (no activity rows). Without it,
   * DC requests ride on the next canvas that has rows and never make a canvas of their own.
   */
  dcOnly: z.boolean().optional(),
  /**
   * Only these rows (Time ▸ Log it: the rows you ticked). Each still has to be ready (ended, approved or complete,
   * with its opp and type); the others wait. Absent: every ready row.
   */
  ids: z.array(Id).min(1).max(2000).optional(),
  /**
   * D-70: only these use cases (their round-trip keys, `uc:<VDP id>`): Log it's ticked use-case rows. With `ids` or
   * `updates` and no `useCases`, none go; with none of the three, every use case ready to log goes.
   */
  useCases: z.array(z.string().min(3).max(200)).max(2000).optional(),
  /** D-70: only these Event updates (their write ids); the same rule as `useCases`. */
  updates: z.array(Id).max(2000).optional(),
});
export type StageLogBatchRequest = z.infer<typeof StageLogBatchRequest>;

export const LogBatchSkip = z.object({ id: Id, date: IsoDate, description: z.string(), why: z.string() });
export type LogBatchSkip = z.infer<typeof LogBatchSkip>;

export const StageLogBatchResult = z.object({
  /** One Outbox item per canvas (ready; each is sent only on its own Apply). */
  draftIds: z.array(Id),
  canvases: z.array(z.object({ draftId: Id, title: z.string(), rows: z.number().int(), hours: z.number(), updates: z.number().int() })),
  events: z.number().int(),
  hours: z.number(),
  /** Proposed rows approved by this batch. */
  approved: z.number().int(),
  skipped: z.array(LogBatchSkip),
  /** Rows left out because an earlier batch's canvas item still waits in the Outbox (Apply or reject it first). */
  waiting: z.object({ rows: z.number().int(), hours: z.number(), draftIds: z.array(Id) }).default({ rows: 0, hours: 0, draftIds: [] }),
  /** D-67: VDP use cases on these canvases (Use_Case__c creates and Stage / Go-Live fixes), and creates left for the next batch. */
  useCases: z.object({ rows: z.number().int().min(0), later: z.number().int().min(0) }).default({ rows: 0, later: 0 }),
  /** D-70: updates to Events already in Org62 on these canvases (each "update · Duration 2 h → 3 h"). */
  eventUpdates: z.number().int().min(0).default(0),
});
export type StageLogBatchResult = z.infer<typeof StageLogBatchResult>;

// ---------------------------------------------------------------------------
// The opportunity picker of a Time row (Week log, Log view)
// ---------------------------------------------------------------------------

export const OppOptionsQuery = z.object({
  /** Rank for this row (its account, evidence and attendees); absent: account-free order (recent, then A–Z). */
  entryId: Id.optional(),
});
export type OppOptionsQuery = z.infer<typeof OppOptionsQuery>;

/** Why an opp ranks where it does for a row (tenet: Legible). */
export const OppOptionWhy = z.enum(['account', 'evidence', 'related', 'recent']);
export type OppOptionWhy = z.infer<typeof OppOptionWhy>;

export const OppOption = z.object({
  id: Id,
  name: z.string(),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  stage: z.string(),
  closeDate: IsoDate.nullable(),
  isOpen: z.boolean(),
  isMine: z.boolean(),
  /**
   * account: on the row's account · evidence: the row's meeting (or its session's task) is on this opp · related: on an
   * account its evidence names (the meeting's, its attendees', its Drive file's) · recent: you logged to it lately.
   */
  why: z.array(OppOptionWhy).default([]),
  /** The last day you logged time to it (a row approved or later, or one you set the opp on), within 30 days. */
  lastUsed: IsoDate.nullable().default(null),
  /** Its Org62 Opportunity id (006…), when known. */
  org62Id: z.string().nullable().optional(),
});
export type OppOption = z.infer<typeof OppOption>;

export const OppOptions = z.object({
  entryId: Id.nullable(),
  /** Every opp a row can log to, ranked for the row: its account, its evidence / attendees, used recently, then the rest. */
  opps: z.array(OppOption),
});
export type OppOptions = z.infer<typeof OppOptions>;

export const Org62OppSearchRequest = z.object({
  /** Words in the opportunity or its account name. */
  q: z.string().trim().min(2).max(80),
});
export type Org62OppSearchRequest = z.infer<typeof Org62OppSearchRequest>;

/** An Org62 / Salesforce record id (15 or 18 characters). */
export const Org62RecordId = z.string().regex(/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/);

export const Org62OppHit = z.object({
  /** D-103 (c): an Opportunity (absent: opp) or an Account (logs to the account itself). */
  kind: z.enum(['opp', 'account']).optional(),
  org62Id: Org62RecordId,
  name: z.string(),
  accountName: z.string().nullable(),
  accountOrg62Id: z.string().nullable(),
  stage: z.string().nullable(),
  closeDate: IsoDate.nullable(),
  amount: z.number().nullable(),
  owner: z.string().nullable(),
  isOpen: z.boolean(),
  /** The app's own opp for this record: picking it just sets the row. */
  oppId: Id.nullable(),
  /** The app's account, when it has the account (with or without the opp). */
  accountId: Id.nullable(),
});
export type Org62OppHit = z.infer<typeof Org62OppHit>;

export const Org62OppSearch = z.object({
  q: z.string(),
  hits: z.array(Org62OppHit),
  /** What to know: nothing matched, the lookup did not finish, mock placeholders, not available here. */
  notes: z.array(z.string()),
  /** Nothing was looked up live (mock placeholders, or live lookups are off). */
  simulated: z.boolean(),
  /** What the live lookup cost (2026-11-13 audit C8: an Assistant read through chat_app_read counts it against the message's cap). */
  costUsd: z.number().min(0).default(0),
});
export type Org62OppSearch = z.infer<typeof Org62OppSearch>;

export const PickOrg62OppRequest = z.object({
  ifVersion: Version.optional(),
  /** The Opportunity's Org62 id, from a search hit. */
  org62Id: Org62RecordId.refine((v) => v.startsWith('006'), 'an Opportunity id starts with 006'),
});
export type PickOrg62OppRequest = z.infer<typeof PickOrg62OppRequest>;

/**
 * POST /activity/:id/org62-resolve (D-65, TL-14 / TL-20): a row that is not in Org62 after all (its Event was deleted
 * there, or its canvas ran without it). `log_again`: back to approved, so the next batch puts it on a canvas.
 * `leave_out`: dismissed by you, never logged again.
 */
export const ResolveActivityRequest = z.object({ ifVersion: Version, action: z.enum(['log_again', 'leave_out']) });
export type ResolveActivityRequest = z.infer<typeof ResolveActivityRequest>;
