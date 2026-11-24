/**
 * Internal-only activity (D-64). Work that is for no customer (a demo, an asset, a tool or a skill built in a repo
 * or in Drive docs no account matches; a certification; an enablement session) is not an opportunity's: the SE logs
 * it in Org62 as a Solutions Event with Related To (WhatId) empty and an internal task type. The user's own Org62
 * history (Aug–Oct) is the precedent: Asset Creation (demos, assets, portals, an estimator skill, a headless demo),
 * Personal Development (certifications, peer certs), Sales Enablement, Travel.
 *
 * Classification (the engine's, for a persona with `internalActivity`, the SE's):
 *   - repo or Drive work blocks the matcher could not map to an account or opp (a repo that does map keeps its opp);
 *     Slack and email that name no account are Admin (internal coordination);
 *   - calendar meetings with no external attendee, no account and no opp are logged, not excluded (2026-11-14, Org62
 *     precedent: 27 SEs logged 248 Solutions Events with Related To empty in FY27 Q3): 1:1s, weekly syncs, team
 *     wraps, all hands, office hours and enablement sessions → Admin; training, courses, onboarding and
 *     certifications → Personal Development; V2MOM / initiative work → V2MOM Initiatives; travel → Travel; an asset
 *     or demo build → Asset Creation. A title that names customer work (prep, a QBR, consumption, a workshop) with no
 *     account matched asks for its opp instead (classify.ts);
 *   - flights are always Travel: internal Travel when no customer trip is behind them (propose.ts).
 * Personal blocks (lunch, an appointment, a focus or "BLOCK" hold of my own) are no meeting (`personalBlockOf`).
 * An internal row has what_kind 'none', no WhatId, customer_related / customer_facing false, its internal task type,
 * and is `proposed` (complete): it never sits in Needs you asking for an opp. It waits for the user's Log (or Dismiss).
 *
 * Also here: the source a "Dismiss all from <source>" rule covers (one repo, unmapped Drive docs, one recurring
 * meeting series) and the flags rule dismissals and declined meetings leave on a row. Pure: no I/O.
 */
import { isCF, isCR } from './taxonomy';

/** The task types an internal row logs with (Related To empty). The precedent's first (Admin, the commonest). */
export const INTERNAL_TASK_TYPES = ['Admin', 'Asset Creation', 'Personal Development', 'Sales Enablement', 'Travel', 'V2MOM Initiatives', 'Mentorship', 'Wellness', 'Localization'] as const;
export type InternalTaskType = (typeof INTERNAL_TASK_TYPES)[number];

export const isInternalTaskType = (t: string | null | undefined): t is InternalTaskType => !!t && (INTERNAL_TASK_TYPES as readonly string[]).includes(t);

/** Learning: certifications, training, courses, onboarding → Personal Development. */
const LEARNING = /peer cert|\bcert(s|ification|ifications|ified)?\b|\bexam\b|trailhead|superbadge|\bcourses?\b|training|\blearning\b|\bstudy\b|bootcamp|on-?boarding/;
/** Enablement sessions and programs → Sales Enablement (broadcasts such as all hands or keynotes are not these). */
const ENABLEMENT = /enablement|deal clinic|overview & sell|agentic selling|pricing models|road to dreamforce|claudeforce|customer zero|meshmesh|\bsko\b/;
/** Internal cadence: 1:1s, team meetings, forecasts (Admin: never logged). */
const CADENCE = /forecast|load balancing|team meeting|\b1:1\b|1 on 1|weekly sync|stand-?up|retro|catch up|feedback|mid-year|panel|happy hr|dinner|spiff|pulse|all hands|all org|town hall|keynote|tune in|live ?stream|office hours|\bou call\b|win wire/;
/** V2MOM and initiative work → V2MOM Initiatives. */
const V2MOM = /v2mom|\binitiatives?\b/;
/** Travel on the calendar (not a flight, which the onsite engine reads) → Travel. */
const TRAVEL = /\btravel(ing|ling)?\b|\bairport\b|\btrain to\b|\bdrive to\b/;
/** An asset, demo, tool or skill being built. */
const ASSET = /\bdemo\b|\bassets?\b|prototype|hackathon|headless|life sciences|\blsc\b|lsjdo|j-lsdo|\bace\b|consumption notes|d360 planning|\bskills?\b|estimator|\bportal\b|\btemplate\b|\bbuild\b/;

export interface InternalType {
  type: InternalTaskType;
  /** Why, in words (tenet: Legible). */
  reason: string;
}

/** The internal type of repo or Drive work, by what it names: learning, enablement, else an asset build. */
export function internalWorkType(text: string): InternalType {
  const s = text.toLowerCase();
  if (LEARNING.test(s)) return { type: 'Personal Development', reason: 'certification / training / learning' };
  if (ENABLEMENT.test(s)) return { type: 'Sales Enablement', reason: 'enablement' };
  return { type: 'Asset Creation', reason: 'demo / asset / tool / skill build with no customer named' };
}

/**
 * The internal type of a meeting with no customer, no account and no opp (2026-11-14: internal meetings are logged,
 * the Org62 precedent's types): training → Personal Development, V2MOM → V2MOM Initiatives, travel → Travel, an asset
 * build → Asset Creation, and everything else (1:1s, syncs, team meetings, all hands, office hours, enablement
 * sessions) → Admin.
 */
export function internalMeetingType(subject: string): InternalType {
  const s = subject.toLowerCase();
  if (LEARNING.test(s)) return { type: 'Personal Development', reason: 'training / course / certification' };
  if (V2MOM.test(s)) return { type: 'V2MOM Initiatives', reason: 'V2MOM / initiative work' };
  if (TRAVEL.test(s)) return { type: 'Travel', reason: 'travel' };
  // a 1:1 or a sync about an asset is still the cadence (the precedent's Admin)
  if (CADENCE.test(s)) return { type: 'Admin', reason: 'internal cadence (1:1, sync, team meeting, all hands, office hours)' };
  if (ASSET.test(s)) return { type: 'Asset Creation', reason: 'demo / asset build with no customer' };
  if (ENABLEMENT.test(s)) return { type: 'Admin', reason: 'enablement session' };
  return { type: 'Admin', reason: 'internal meeting' };
}

/**
 * The internal type a meeting title names outright (training, V2MOM, travel, an asset build), or null. These win over
 * customer-work words in the same title ("Pricing peer cert", "Headless demos"): classify.ts asks this first.
 */
export function namedInternalType(subject: string): InternalType | null {
  const s = subject.toLowerCase();
  if (LEARNING.test(s)) return { type: 'Personal Development', reason: 'training / course / certification' };
  if (V2MOM.test(s)) return { type: 'V2MOM Initiatives', reason: 'V2MOM / initiative work' };
  if (TRAVEL.test(s)) return { type: 'Travel', reason: 'travel' };
  if (ASSET.test(s)) return { type: 'Asset Creation', reason: 'demo / asset build with no customer' };
  return null;
}

/** Personal time on the calendar: never work (lunch, appointments, the gym, school runs, time off). */
const PERSONAL = /\b(lunch|breakfast|gym|workout|doctor|dentist|appointment|appt|pick ?up|drop ?off|school run|errands?|haircut|vacation|pto|holiday|out of office|ooo|personal (time|appt|appointment|errand))\b/;
/** A hold of my own: focus time, a "BLOCK", heads-down time. Its work counts from my own actions, never the hold. */
const HOLD = /\b(focus( time)?|heads?[ -]?down|deep work|do not (book|schedule)|dnb|no meetings|block(ed)?|hold)\b/;

/**
 * Why a calendar event is a personal block (no meeting, never logged as one), or null. Lunch and other personal time
 * (no customer at the table); a focus or "BLOCK" hold I made for myself (no other attendees named). The work done in
 * one counts from my own actions (engaged time), like any solo time: a hold with no signals logs nothing.
 */
export function personalBlockOf(ev: { summary: string; organizerSelf?: boolean; attendeeDomains: readonly string[] }, m: { internalDomains: readonly string[]; ignoreDomains: readonly string[]; partnerDomains: readonly string[] }): string | null {
  const s = ev.summary.toLowerCase();
  const skip = new Set([...m.internalDomains, ...m.ignoreDomains, ...m.partnerDomains]);
  const external = ev.attendeeDomains.some((d) => !skip.has(d));
  if (external) return null;
  if (PERSONAL.test(s)) return 'personal time (lunch, an appointment, time off): not work';
  if (ev.organizerSelf && HOLD.test(s)) return 'a hold of your own (focus, BLOCK): its work counts from your own actions';
  return null;
}

/** The internal type for a row the user marks internal: its own internal type, else what its words say. */
export function internalTypeFor(current: string | null | undefined, text: string): InternalTaskType {
  return isInternalTaskType(current) ? current : internalWorkType(text).type;
}

/** A row moved from internal to an opportunity: the customer-related type of the same work (null: the user picks). */
export function customerTypeFor(internalType: string | null | undefined): string | null {
  if (internalType === 'Asset Creation') return 'Solution Creation';
  if (internalType === 'Travel') return 'Travel';
  if (internalType && !isInternalTaskType(internalType)) return internalType;
  return null;
}

/** CF / CR of a task type (null: Neither). */
export const meetingTypeOf = (t: string | null | undefined): 'CF' | 'CR' | null => (t && isCF(t) ? 'CF' : t && isCR(t) ? 'CR' : null);

// ------------------------------------------------------------------ "Dismiss all from <source>"

export type DismissSourceKind = 'repo' | 'docs' | 'series';

export interface DismissSource {
  /** `repo:<name>` · `docs:unmapped` · `series:<calendar>|<series id>` */
  key: string;
  kind: DismissSourceKind;
  /** "command-center" (repo), "unmapped Drive docs", "'Weekly asset sync'" (series). */
  label: string;
}

/** Recurring instance ids end with _YYYYMMDDTHHMMSSZ (or _YYYYMMDD): the series id is what comes before (calendar.ts). */
const INSTANCE_SUFFIX = /^(.+)_(\d{8}(T\d{6}Z?)?)$/;

/** The series a calendar event belongs to, or null (a one-off meeting). */
export function seriesKeyOf(calendarId: string, externalEventId: string): string | null {
  const m = INSTANCE_SUFFIX.exec(externalEventId);
  return m ? `series:${calendarId}|${m[1]}` : null;
}

/**
 * The source a row's dedupe key comes from, when a "Dismiss all from …" rule can cover it: a repo's work blocks
 * (`wb|<day>|repo:<name>`), unmapped Drive docs (`wb|<day>|docs:unmapped`), a recurring meeting's instances
 * (`cal|<calendar>|<series>_<instant>|<start>`). Null for everything else (one-off meetings, account work, Org62 rows).
 */
export function dismissSourceOf(dedupeKey: string, subject: string): DismissSource | null {
  // a day's row and its parts (`#2` …: the same work around meetings, 2026-11-14)
  const wb = /^wb\|\d{4}-\d{2}-\d{2}\|(repo:([^#]+)|docs:unmapped)(#\d+)?$/.exec(dedupeKey);
  if (wb) return wb[2] ? { key: wb[1]!, kind: 'repo', label: wb[2] } : { key: 'docs:unmapped', kind: 'docs', label: 'unmapped Drive docs' };
  const cal = /^cal\|([^|]+)\|([^|@#]+)\|/.exec(dedupeKey);
  if (cal) {
    const key = seriesKeyOf(cal[1]!, cal[2]!);
    if (key) return { key, kind: 'series', label: `'${subject.split(' · ')[0]!.slice(0, 80)}'` };
  }
  return null;
}

/** The stable part of the flag a "Dismiss all from …" rule leaves on the rows it sets aside. */
export const DISMISS_RULE_MARKER = 'Dismissed by your rule';
export const dismissRuleFlag = (label: string): string => `${DISMISS_RULE_MARKER}: all from ${label} (Settings ▸ Time ▸ Dismissed sources)`;
export const isRuleDismissal = (flags: readonly string[] | null | undefined): boolean => (flags ?? []).some((f) => f.startsWith(DISMISS_RULE_MARKER));

// ------------------------------------------------------------------ declined meetings

/** The flag on a row whose meeting you declined after it was handed off (on a canvas, or in Org62): never deleted. */
export const DECLINED_MARKER = 'You declined this meeting';
export const DECLINED_LOGGED_FLAG = `${DECLINED_MARKER} after it was handed off: its Org62 Event stays (the app never deletes one); delete it in Org62 if it should not count`;
export const DECLINED_HELD_FLAG = `${DECLINED_MARKER}: it waits on a canvas you have not applied; reject that canvas item, then log again`;
