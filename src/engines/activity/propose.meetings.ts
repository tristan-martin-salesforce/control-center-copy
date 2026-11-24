// Meeting and travel entries for the activity plan. Split from propose.ts (max-lines); propose.ts re-exports the public names.
import { accountByKey, classifyMeeting, NOT_ON_TEAM_MARKER, type MeetingDraft } from './classify';
import { newEntry, stripWhatIfNeither } from './entry';
import { personalBlockOf } from './internal';
import { isDinnerTitle, isFlightTitle, isHotelTitle, isMarkerEvent } from './event-kinds';
import { airportBuffers, DEFAULT_ONSITE_CONFIG, type FlightGroup, type OnsiteDay, type Trip } from './onsite';
import { overlapInfo } from './overlap-flags';
import { isPhysicalLocation } from './places';
import { roundQuarter } from './taxonomy';
import {
  HOUR, type Interval, MIN, addDays, localDay, localHm, subtractIntervals, toMs, toIsoSec, zonedToMs,
} from './time';
import type {
  ActivityConfig, ActivityEntry, ActivityMappings, CalendarEvidence, EvidenceBundle, OverlapMode, RejectedProposal,
  TimeBlock,
} from './types';
import type { AutoplanRule } from './propose';

// An opp I'm not on (NOT_ON_TEAM_MARKER) holds the row too: the user checks and approves it on Time (Needs you).
export const NEEDS_INPUT_MARKERS = ['NEEDS WhatId', 'OOO', 'placeholder', 'optional:', 'calendar hold', NOT_ON_TEAM_MARKER];
export const whatKindOf = (id: string): ActivityEntry['whatKind'] => (!id ? 'none' : id.startsWith('006') ? 'opportunity' : id.startsWith('001') ? 'account' : 'none');
// ------------------------------------------------------------------ meetings

function meetingEntry(ev: CalendarEvidence, d: MeetingDraft): ActivityEntry {
  const flags = [...d.flags];
  const exactMin = (toMs(ev.endsAt) - toMs(ev.startsAt)) / MIN;
  const diff = Math.abs(d.hours * 60 - exactMin);
  if (diff > 5) flags.push(`Duration__c ${d.hours} h differs from End-Start by ${Math.round(diff)} min`); // D-40
  return newEntry({
    dedupeKey: `cal|${ev.id}|${ev.startsAt}`,
    origin: 'calendar',
    subject: d.subject,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    durationHours: d.hours,
    seTaskType: d.seTaskType,
    meetingType: d.meetingType,
    whatKind: whatKindOf(d.whatId),
    whatOrg62Id: d.whatId || null,
    whatName: d.whatName || null,
    accountKey: d.accountKey,
    customerFacing: d.cf,
    customerRelated: d.cf,
    extDomains: d.extDomains,
    confidence: d.confidence,
    reason: d.reason,
    flags,
    evidence: d.evidence,
    evidenceIds: [ev.id],
    ...(d.internal ? { internal: true } : {}),
  });
}
/** Flights with no trip account, next to a multi-hour customer meeting, become Travel on that account (flagged). */
function linkTravel(flight: CalendarEvidence, items: { ev: CalendarEvidence; d: MeetingDraft }[], mappings: ActivityMappings): { accountKey: string; whatId: string; whatName: string; subject: string } | null {
  const meets = items.filter((x) => x.d.accountKey && x.d.cf && x.d.hours >= 2);
  const fs = toMs(flight.startsAt);
  for (const m of meets) {
    const ms = toMs(m.ev.startsAt);
    const me = toMs(m.ev.endsAt);
    const near = (ms - fs >= 0 && ms - fs <= 48 * HOUR) || (fs - me >= 0 && fs - me <= 48 * HOUR);
    if (!near) continue;
    const acct = accountByKey(mappings, m.d.accountKey);
    return { accountKey: m.d.accountKey!, whatId: acct?.whatId ?? m.d.whatId, whatName: m.d.whatName, subject: m.d.subject };
  }
  return null;
}
/** What the engine itself says an event is (flight, hotel, marker), whatever the caller guessed. */
export function eventKind(ev: CalendarEvidence, tz: string): CalendarEvidence['kind'] {
  if (ev.kind === 'ooo' || ev.kind === 'focus' || ev.kind === 'working_location') return ev.kind;
  if (!ev.allDay && isFlightTitle(ev.summary)) return 'flight';
  if (isHotelTitle(ev.summary) && (ev.allDay || (toMs(ev.endsAt) - toMs(ev.startsAt)) / HOUR >= 12)) return 'hotel';
  if (!ev.allDay && isMarkerEvent(ev, tz)) return 'marker';
  return 'default';
}
interface MeetingCtx {
  onsiteByDay: Map<string, OnsiteDay>;
  /** Meetings that will not log: they never win (or lose) an overlap. */
  notLogging: ReadonlySet<string>;
  mode: OverlapMode;
}
type MeetingItem = { ev: CalendarEvidence; d: MeetingDraft };
const meetingKey = (ev: Pick<CalendarEvidence, 'id' | 'startsAt'>): string => `cal|${ev.id}|${ev.startsAt}`;
/**
 * The accepted, attended meetings of the window, classified (markers, unanswered and unattended invites are rejected).
 * A personal block (lunch, an appointment, a focus or "BLOCK" hold of my own) is no meeting: rejected, its key added to
 * `personal` so it never claims time; the work I did in it counts from my own actions, like any solo time.
 */
export function classifyMeetings(evidence: EvidenceBundle, mappings: ActivityMappings, cfg: ActivityConfig, rejected: RejectedProposal[], dinnersCustomerFacing: boolean, personal: Set<string>): MeetingItem[] {
  const internalActivity = cfg.internalActivity === true;
  const items: MeetingItem[] = [];
  for (const ev of evidence.calendar) {
    if (ev.deleted || ev.allDay || ev.kind === 'ooo' || ev.kind === 'focus' || ev.kind === 'flight' || ev.kind === 'hotel' || ev.kind === 'working_location') continue;
    const key = `cal|${ev.id}|${ev.startsAt}`;
    if (ev.kind === 'marker') {
      const h = Math.round((toMs(ev.endsAt) - toMs(ev.startsAt)) / HOUR);
      rejected.push({ dedupeKey: key, subject: ev.summary, startsAt: ev.startsAt, hours: 0, reason: 'placeholder', note: `a ${h} h block marks the day(s), it is not a meeting` });
      continue;
    }
    // a meeting I declined never logs, also one I organize (an instance of my own series I declined, D-64)
    if ((ev.selfResponse !== 'accepted' && !ev.organizerSelf) || ev.selfResponse === 'declined') {
      rejected.push({ dedupeKey: key, subject: ev.summary, startsAt: ev.startsAt, hours: 0, reason: 'not_accepted', note: `invite is ${ev.selfResponse}` });
      continue;
    }
    if (ev.attended === false) {
      rejected.push({ dedupeKey: key, subject: ev.summary, startsAt: ev.startsAt, hours: 0, reason: 'not_attended', note: 'accepted but not attended' });
      continue;
    }
    const block = personalBlockOf(ev, mappings);
    if (block) {
      personal.add(key);
      rejected.push({ dedupeKey: key, subject: ev.summary, startsAt: ev.startsAt, hours: 0, reason: 'personal', note: block });
      continue;
    }
    items.push({ ev, d: classifyMeeting(ev, mappings, localDay(toMs(ev.startsAt), cfg.timezone), { dinnersCustomerFacing, internalActivity }) });
  }
  return items;
}
/** The first rule that matches a subject on a day dismisses it (applyRules, decided before the overlaps are). */
function ruleDismisses(subject: string, day: string, rules: readonly AutoplanRule[]): boolean {
  for (const r of rules) {
    if (!new RegExp(r.match, 'i').test(subject)) continue;
    if (r.date && !day.startsWith(r.date)) continue;
    return r.action === 'dismiss';
  }
  return false;
}
/**
 * Meetings that will not log, whatever they overlap: rounds to 0 h, Neither CF nor CR (Admin), a `skip` mapping, a
 * dismiss rule, or a row the user dismissed. They never make another row lose an overlap (D-18 amended).
 */
export function notLoggingKeys(items: readonly MeetingItem[], rules: readonly AutoplanRule[], userKeys: readonly string[], tz: string): Set<string> {
  const out = new Set(userKeys);
  for (const { ev, d } of items) if (d.hours <= 0 || d.skipReason || ruleDismisses(d.subject, localDay(toMs(ev.startsAt), tz), rules)) out.add(meetingKey(ev));
  return out;
}
export function meetingEntries(
  items: readonly MeetingItem[],
  evidence: EvidenceBundle,
  blocks: readonly TimeBlock[],
  mappings: ActivityMappings,
  cfg: ActivityConfig,
  rejected: RejectedProposal[],
  ctx: MeetingCtx,
): ActivityEntry[] {
  const lostKeys = new Set(blocks.filter((b) => b.isOverlay && b.attention === 'meeting' && b.source === 'calendar').map((b) => b.dedupeKey.split('~overlay')[0]!));
  const counted = blocks.filter((b) => !b.isOverlay && b.attention === 'meeting' && b.source === 'calendar');
  const oooList = evidence.calendar.filter((e) => e.kind === 'ooo' && !e.deleted && (toMs(e.endsAt) - toMs(e.startsAt)) / MIN < 1440);
  // log_all_accepted: every accepted meeting that logs keeps its row; the ones it overlaps are named on it
  const logging = items.filter(({ ev }) => !ctx.notLogging.has(meetingKey(ev)));

  const out: ActivityEntry[] = [];
  for (const { ev, d } of items) {
    const key = meetingKey(ev);
    if (d.hours <= 0) {
      rejected.push({ dedupeKey: key, subject: ev.summary, startsAt: ev.startsAt, hours: d.hours, reason: 'below_minimum', note: 'rounds to 0 h' });
      continue;
    }
    // On an onsite day, the trip's meetings log to the trip's account and opp (one for the whole trip), in person.
    const od = ctx.onsiteByDay.get(localDay(toMs(ev.startsAt), cfg.timezone));
    let tripKey: string | null = null;
    let remote = true;
    if (od && od.status !== 'not_onsite' && od.accountKey) {
      const external = d.extDomains.length > 0;
      const unnamed = !d.accountKey && external && isPhysicalLocation(ev.location);
      if (d.accountKey === od.accountKey || unnamed) {
        if (unnamed) d.flags.push('account from your onsite trip; confirm');
        const acct = accountByKey(mappings, od.accountKey);
        Object.assign(d, { accountKey: od.accountKey, whatId: od.whatId ?? acct?.whatId ?? '', whatName: od.whatName ?? acct?.whatName ?? '' });
        d.flags = d.flags.filter((f) => !/^NEEDS WhatId|^WhatId = account fallback/.test(f) || !od.whatId);
        tripKey = od.tripKey ?? `day|${od.day}`;
        remote = false;
      } else if (isPhysicalLocation(ev.location) && external) {
        remote = false;
      }
    } else if (isPhysicalLocation(ev.location) && d.extDomains.length > 0) {
      remote = false;
    }
    if (isDinnerTitle(ev.summary) && d.extDomains.length > 0) remote = false;
    let e = meetingEntry(ev, d);
    e.remote = remote;
    e.tripKey = tripKey;
    e = stripWhatIfNeither(e);
    const s = toMs(ev.startsAt);
    const en = toMs(ev.endsAt);
    for (const o of oooList)
      if (toMs(o.startsAt) < en && s < toMs(o.endsAt)) {
        e.flags.push(`overlaps OOO '${o.summary}' (${localHm(toMs(o.startsAt), cfg.timezone)}); trim or drop`);
        break;
      }
    if (d.skipReason) {
      e.status = 'excluded';
      e.excludedReason = 'neither_type';
      e.flags.push(d.skipReason);
    } else if (ctx.notLogging.has(key)) {
      // a dismiss rule or the user's dismissal decides this row; it neither wins nor loses an overlap
    } else if (ctx.mode === 'log_all_accepted') {
      for (const o of logging) {
        if (o.ev === ev) continue;
        const from = Math.max(s, toMs(o.ev.startsAt));
        const to = Math.min(en, toMs(o.ev.endsAt));
        if (to - from >= MIN) e.flags.push(overlapInfo(o.ev.summary, from, to, cfg.timezone));
      }
    } else if (lostKeys.has(key)) {
      const winner = counted.find((b) => b.dedupeKey !== key && toMs(b.startsAt) < en && s < toMs(b.endsAt));
      e.status = 'excluded';
      e.excludedReason = 'overlap';
      e.flags.push(`double-booked${winner ? ` with ${winner.evidenceIds[0]}` : ''}: hours are human hours, counted once`);
    }
    out.push(e);
  }
  return out;
}
// ------------------------------------------------------------------ travel and onsite frames

/** Split an interval at local midnight: nothing is ever overnight. */
export function splitAtMidnight(x: Interval, tz: string): Interval[] {
  const out: Interval[] = [];
  let s = x.start;
  for (let i = 0; i < 8 && s < x.end; i++) {
    const next = zonedToMs(addDays(localDay(s, tz), 1), '00:00', tz);
    const e = Math.min(x.end, next);
    out.push({ start: s, end: e });
    s = e;
  }
  return out;
}
interface TravelItem {
  flight: FlightGroup;
  ev: CalendarEvidence;
  trip: Trip | null;
  pieces: { key: string; iv: Interval }[];
}
/**
 * Each flight (duplicates merged) plus the airport buffers (Settings ▸ Time: 120 min before it, 60 min after it by
 * default), split at midnight, minus reserved time.
 */
export function travelPlan(flights: FlightGroup[], trips: Trip[], cal: readonly CalendarEvidence[], cfg: ActivityConfig, reserved: Interval[]): TravelItem[] {
  const buf = airportBuffers(cfg.onsite ?? DEFAULT_ONSITE_CONFIG);
  const byId = new Map(cal.map((e) => [e.id, e]));
  const out: TravelItem[] = [];
  for (const f of flights) {
    const ev = byId.get(f.keepId);
    if (!ev) continue;
    const trip = trips.find((t) => t.flightIds.includes(f.keepId)) ?? trips.find((t) => f.arr >= t.presence.start - 12 * HOUR && f.dep <= t.presence.end + 12 * HOUR) ?? null;
    const base = `cal|${ev.id}|${ev.startsAt}`;
    const free = subtractIntervals(splitAtMidnight({ start: f.dep - buf.beforeMin * MIN, end: f.arr + buf.afterMin * MIN }, cfg.timezone), reserved).filter((x) => x.end - x.start >= MIN);
    out.push({ flight: f, ev, trip, pieces: free.map((iv, i) => ({ key: i === 0 ? base : `${base}@${toIsoSec(iv.start)}`, iv })) });
  }
  return out;
}
export function travelEntries(items: TravelItem[], blocks: readonly TimeBlock[], meetings: { ev: CalendarEvidence; d: MeetingDraft }[], mappings: ActivityMappings, rejected: RejectedProposal[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const t of items) {
    for (const id of t.flight.ids.filter((x) => x !== t.flight.keepId))
      rejected.push({ dedupeKey: `cal|${id}|${t.ev.startsAt}`, subject: t.flight.title, startsAt: t.ev.startsAt, hours: 0, reason: 'duplicate', note: `same flight as ${t.flight.keepId}: counted once` });
    const trip = t.trip?.accountKey ? t.trip : null;
    const linked = trip ? null : linkTravel(t.ev, meetings, mappings);
    const pieces = blocks.filter((b) => b.source === 'travel' && b.countsAsHumanHours && t.pieces.some((p) => b.dedupeKey === p.key || b.dedupeKey.startsWith(`${p.key}#`)));
    for (const b of pieces) {
      const hours = roundQuarter((toMs(b.endsAt) - toMs(b.startsAt)) / HOUR);
      if (hours <= 0) continue;
      const whatId = trip?.whatId ?? linked?.whatId ?? '';
      const customer = !!(trip || linked);
      const flags: string[] = [];
      if (t.flight.ids.length > 1) flags.push(`in your calendar ${t.flight.ids.length} times: counted once`);
      if (linked) flags.push('travel linked to a customer meeting; confirm');
      // A flight is always Travel (2026-11-14; Org62 precedent: Travel with Related To empty is common): on the trip's
      // opp when the trip is a customer's, else internal Travel with no opp (D-64).
      const e = newEntry({
        dedupeKey: b.dedupeKey,
        origin: 'calendar',
        subject: t.flight.title,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        durationHours: hours,
        seTaskType: 'Travel',
        whatKind: whatKindOf(whatId),
        whatOrg62Id: whatId || null,
        whatName: trip?.whatName ?? linked?.whatName ?? null,
        accountKey: trip?.accountKey ?? linked?.accountKey ?? null,
        customerFacing: false,
        customerRelated: customer,
        confidence: trip ? (trip.marked ? 'High' : 'Medium') : linked ? 'Low' : 'Medium',
        reason: trip
          ? `travel for your trip${t.trip?.city ? ` to ${t.trip.city}` : ''} (flight plus the airport buffers)`
          : linked
            ? `travel for '${linked.subject}'`
            : 'internal: a flight with no customer trip (Travel, no opp; flight plus the airport buffers)',
        evidence: '',
        evidenceIds: t.flight.ids,
        flags,
        ...(customer ? {} : { internal: true }),
      });
      e.remote = false;
      e.tripKey = trip?.key ?? null;
      out.push(e);
    }
  }
  return out;
}
