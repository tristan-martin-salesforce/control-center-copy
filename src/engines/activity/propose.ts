/**
 * Blocks -> proposed Solutions Event entries (create operations), plus the hands-off policy:
 * rules, go-live guard, approval. Port of pipeline.desired_drafts + blocks.build + autoplan.
 * No hour caps (2026-11-14, the owner's direction: "grounded in truth"): the only bound is what the signals show, and
 * overlapping time is never counted twice (a meeting and solo work at the same moment count once).
 * Pure: the caller supplies `now`, evidence, mappings and the Org62 read-back mirror.
 */
import { buildTimeBlocks, humanHours, isAttendedMeeting, leverageHours } from './blocks';
import { heldNotOnTeam } from './classify';
import { stripWhatIfNeither } from './entry';
import { type BuildEstimate, buildEstimateEntries } from './estimates';
import { DEFAULT_ONSITE_CONFIG, detectOnsite, type OnsiteDay, type OnsiteOverrides, type Trip } from './onsite';
import { isOverlapInfo } from './overlap-flags';
import { defaultMeetingType, isNeither, roundQuarter } from './taxonomy';
import { HOUR, type Interval, MIN, addDays, localDay, subtractIntervals, toMs, toIsoSec, unionIntervals } from './time';
import {
  overlapModeOf, type ActivityConfig, type ActivityEntry, type ActivityMappings, type CalendarEvidence,
  type EvidenceBundle, type Org62EventRow, type RejectedProposal, type TimeBlock,
} from './types';
import {
  whatKindOf, NEEDS_INPUT_MARKERS, eventKind, travelPlan, classifyMeetings, notLoggingKeys, meetingEntries,
  travelEntries,
} from './propose.meetings';
import { type FrameInput, frameEntries, framePieces, evidenceEntries } from './propose.evidence';
export { eventKind, splitAtMidnight } from './propose.meetings';

export interface AutoplanRule {
  match: string; // regex on subject (case-insensitive)
  date?: string; // local date prefix
  whatId?: string;
  whatName?: string;
  type?: string;
  hours?: number;
  action?: 'dismiss';
  why?: string;
}

export interface ProposeInput {
  /** ISO "now": decides upcoming vs past. */
  now: string;
  cfg: ActivityConfig;
  mappings: ActivityMappings;
  evidence: EvidenceBundle;
  builds?: readonly BuildEstimate[];
  org62Events?: readonly Org62EventRow[];
  rules?: readonly AutoplanRule[];
  /** Raw evidence entries on/before this local day are superseded by curated builds. */
  evidenceSupersededUntil?: string;
  /** Hands-off mode (memory): approve everything proposable with approval_method = autonomy_policy. */
  handsOff?: boolean;
  /** Calendar context around the window (hotels, flights, markers of neighbouring days) for onsite detection only. */
  calendarContext?: readonly CalendarEvidence[];
  /** The local days to decide onsite for (default: the days the window's calendar covers). */
  onsiteDays?: string[];
  /** The user's onsite corrections (Settings-free: the Time and History day chips). */
  onsiteOverrides?: OnsiteOverrides;
  /**
   * Counted time the caller owns (the user's rows): travel never overlaps it, nor do onsite frames, except (overlaps
   * `log_all_accepted`) where the row is a meeting (`meeting: true`): the onsite day keeps its span around a meeting.
   */
  reserved?: readonly { startsAt: string; endsAt: string; meeting?: boolean }[];
  /**
   * Dedupe keys of rows that will not log whatever the engine proposes (the user dismissed or excluded them): they
   * never make another row lose an overlap (D-18 amended).
   */
  notLogging?: readonly string[];
  /**
   * Counted time solo work must not count again, though the engine makes no row of it: the user's own rows and Org62
   * Events, except the user's own solo-work rows (and their Events), which the new estimate of the same work replaces.
   */
  yieldTo?: readonly { startsAt: string; endsAt: string }[];
}

export interface ActivityPlan {
  blocks: TimeBlock[];
  entries: ActivityEntry[];
  rejected: RejectedProposal[];
  /** Counted human hours across all blocks vs agent time shown separately (D-17). */
  humanHours: number;
  leverageHours: number;
  /** Onsite days decided for the window (detected, confirmed or marked not onsite), with the signals they used. */
  onsite: OnsiteDay[];
  trips: Trip[];
}

// ------------------------------------------------------------------ rules, status, approval

export function applyRules(entries: ActivityEntry[], rules: readonly AutoplanRule[], tz: string): ActivityEntry[] {
  return entries.map((e) => {
    if (e.status !== 'proposed' && e.status !== 'needs_input') return e;
    const day = localDay(toMs(e.startsAt), tz);
    for (const r of rules) {
      if (!new RegExp(r.match, 'i').test(e.subject)) continue;
      if (r.date && !day.startsWith(r.date)) continue;
      if (r.action === 'dismiss') return { ...e, status: 'dismissed', flags: [...e.flags, r.why ?? 'auto-dismissed'] };
      const n = { ...e, flags: [...e.flags, r.why ?? 'auto-resolved'] };
      if (r.whatId) Object.assign(n, { whatOrg62Id: r.whatId, whatKind: whatKindOf(r.whatId), whatName: r.whatName ?? n.whatName });
      if (r.type) Object.assign(n, { seTaskType: r.type, meetingType: defaultMeetingType(r.type, n.meetingType) });
      if (r.hours) {
        n.durationHours = roundQuarter(r.hours);
        n.endsAt = toIsoSec(toMs(n.startsAt) + n.durationHours * HOUR);
      }
      return stripWhatIfNeither(n);
    }
    return e;
  });
}

/** upcoming / needs_input / proposed for entries the engine still owns. */
export function finalizeStatus(e: ActivityEntry, now: number): ActivityEntry {
  if (e.status !== 'proposed' && e.status !== 'needs_input' && e.status !== 'upcoming') return e;
  let status: ActivityEntry['status'];
  const type = e.seTaskType ?? '';
  const flagged = e.flags.some((f) => !isOverlapInfo(f) && NEEDS_INPUT_MARKERS.some((m) => f.includes(m)));
  if (toMs(e.endsAt) > now) status = 'upcoming';
  else if ((!e.whatOrg62Id && type !== 'Travel' && !isNeither(type)) || flagged) status = 'needs_input';
  else status = 'proposed';
  return status === e.status ? e : { ...e, status };
}

/**
 * Hands-off approval (autoplan.approve_all). Neither-type rows approve only when they are builds. A row on an opp I'm
 * not on the team of is never approved here: only the user approves it (Time ▸ Needs you, "Check and approve").
 */
export function autoApprove(entries: readonly ActivityEntry[], nowIso: string): ActivityEntry[] {
  const now = toMs(nowIso);
  return entries.map((e) => {
    if ((e.status !== 'proposed' && e.status !== 'needs_input') || e.operation !== 'create' || toMs(e.endsAt) > now) return e;
    if (heldNotOnTeam(e.flags)) return e;
    // D-64: an internal row waits for the user's own Log (or Dismiss)
    if (e.internal) return e;
    const type = e.seTaskType ?? '';
    const neither = isNeither(type);
    if (neither && e.origin !== 'build_estimate') return e;
    if (!e.whatOrg62Id && type !== 'Travel' && !neither) return e;
    return { ...e, status: 'approved', approvedAt: nowIso, approvalMethod: 'autonomy_policy' };
  });
}

// ------------------------------------------------------------------ orchestrator

/** The local days a calendar covers (the onsite window when the caller names none). */
function daysOf(cal: readonly CalendarEvidence[], tz: string): string[] {
  const timed = cal.filter((e) => !e.allDay).map((e) => toMs(e.startsAt));
  if (!timed.length) return [];
  const out: string[] = [];
  for (let d = localDay(Math.min(...timed), tz); d <= localDay(Math.max(...timed), tz) && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

export function proposeActivity(input: ProposeInput): ActivityPlan {
  const { cfg, mappings } = input;
  const tz = cfg.timezone;
  const now = toMs(input.now);
  const mode = overlapModeOf(cfg);
  const rejected: RejectedProposal[] = [];
  const onsiteCfg = cfg.onsite ?? DEFAULT_ONSITE_CONFIG;
  const norm = (e: CalendarEvidence): CalendarEvidence => ({ ...e, kind: eventKind(e, tz) });
  const evidence: EvidenceBundle = { ...input.evidence, calendar: input.evidence.calendar.map(norm) };
  const ids = new Set(evidence.calendar.map((e) => e.id));
  const context = [...evidence.calendar, ...(input.calendarContext ?? []).filter((e) => !ids.has(e.id)).map(norm)];

  // Onsite days and trips (onsite.ts), then travel and frames: both fill only time nobody else owns.
  const onsite = detectOnsite({ days: input.onsiteDays ?? daysOf(evidence.calendar, tz), tz, cfg: onsiteCfg, events: context, mappings, org62Events: input.org62Events, overrides: input.onsiteOverrides });
  const onsiteByDay = new Map(onsite.days.map((d) => [d.day, d]));
  const iv = (r: { startsAt: string; endsAt: string }): Interval => ({ start: toMs(r.startsAt), end: toMs(r.endsAt) });
  const reserved = unionIntervals([...(input.reserved ?? []), ...(input.org62Events ?? [])].map(iv));
  // The onsite day yields to travel and to the user's own rows; with overlaps `log_all_accepted` not to a meeting row
  // (the user's approved meeting, or an Org62 Event that is an accepted meeting's twin: same slot, within 5 min).
  const accepted = evidence.calendar.filter(isAttendedMeeting).map(iv);
  const meetingTwin = (r: Org62EventRow) => accepted.some((m) => Math.abs(m.start - toMs(r.startsAt)) <= 5 * MIN && m.start < toMs(r.endsAt) && toMs(r.startsAt) < m.end);
  const frameReserved =
    mode === 'count_once' ? reserved : unionIntervals([...(input.reserved ?? []).filter((r) => !r.meeting), ...(input.org62Events ?? []).filter((r) => !meetingTwin(r))].map(iv));
  const inWindow = new Set(evidence.calendar.map((e) => e.id));
  const travel = travelPlan(onsite.flights.filter((f) => inWindow.has(f.keepId)), onsite.trips, evidence.calendar, cfg, reserved);
  const frames: FrameInput[] = onsite.days
    .filter((d) => d.frame && d.status !== 'not_onsite' && !d.signals.some((s) => s.kind === 'org62'))
    .flatMap((d) => subtractIntervals([{ start: toMs(d.frame!.startsAt), end: toMs(d.frame!.endsAt) }], frameReserved).map((x, i) => ({ key: i === 0 ? `onsite|${d.day}` : `onsite|${d.day}#p${i + 1}`, iv: x, accountKey: d.accountKey, evidenceIds: d.signals.flatMap((s) => s.evidenceIds) })));

  // Meetings are classified first: the ones that will not log never claim time from a row that does (D-18 amended).
  const personal = new Set<string>();
  const items = classifyMeetings(evidence, mappings, cfg, rejected, onsiteCfg.dinnersCustomerFacing, personal);
  const notLogging = notLoggingKeys(items, input.rules ?? [], [...(input.notLogging ?? []), ...personal], tz);
  const blocks = buildTimeBlocks(evidence, mappings, cfg, {
    travel: travel.flatMap((t) => t.pieces.map((p) => ({ key: p.key, iv: p.iv, accountKey: t.trip?.accountKey ?? null, evidenceIds: t.flight.ids }))),
    frames,
    nonLogging: notLogging,
    notMeetings: personal,
    yieldTo: unionIntervals((input.yieldTo ?? []).map(iv)),
  });

  const meetings = [...meetingEntries(items, evidence, blocks, mappings, cfg, rejected, { onsiteByDay, notLogging, mode }), ...travelEntries(travel, blocks, items, mappings, rejected)];
  const travelIv = travel.flatMap((t) => t.pieces.map((p) => p.iv));
  meetings.push(...frameEntries(onsite.days, framePieces(mode, frames, blocks, travelIv), meetings, mappings, cfg));

  // Busy time that estimated work must not double-book.
  const busyByDay = new Map<string, Interval[]>();
  const addBusy = (startsAt: string, endsAt: string) => {
    const s = toMs(startsAt);
    const d = localDay(s, tz);
    busyByDay.set(d, [...(busyByDay.get(d) ?? []), { start: s, end: toMs(endsAt) }]);
  };
  for (const r of input.org62Events ?? []) addBusy(r.startsAt, r.endsAt);
  // the user's own rows (approved and later, edited): a solo-work row is never placed over one
  for (const r of input.reserved ?? []) addBusy(r.startsAt, r.endsAt);
  const userDead = new Set(input.notLogging ?? []);
  for (const m of meetings) if (m.status !== 'excluded' && !userDead.has(m.dedupeKey)) addBusy(m.startsAt, m.endsAt);
  for (const o of evidence.calendar) if (o.kind === 'ooo' && !o.deleted && (toMs(o.endsAt) - toMs(o.startsAt)) / MIN < 720) addBusy(o.startsAt, o.endsAt);

  let evid = evidenceEntries(blocks, mappings, cfg, evidence, rejected, busyByDay);
  // Go-live guard (memory): estimates before mid-September are never proposed.
  evid = evid.filter((e) => {
    const day = localDay(toMs(e.startsAt), tz);
    if (day < cfg.liveFrom) {
      rejected.push({ dedupeKey: e.dedupeKey, subject: e.subject, startsAt: e.startsAt, hours: e.durationHours, reason: 'before_go_live', note: `before go-live ${cfg.liveFrom}` });
      return false;
    }
    if (input.evidenceSupersededUntil && day <= input.evidenceSupersededUntil) {
      rejected.push({ dedupeKey: e.dedupeKey, subject: e.subject, startsAt: e.startsAt, hours: e.durationHours, reason: 'duplicate', note: 'superseded by curated build estimates' });
      return false;
    }
    return true;
  });

  const built = buildEstimateEntries(input.builds ?? [], { cfg, mappings, busyByDay });
  rejected.push(...built.rejected);

  let entries = [...meetings, ...evid, ...built.entries];
  entries = applyRules(entries, input.rules ?? [], tz);
  entries = entries.map((e) => finalizeStatus(e, now));
  if (input.handsOff) entries = autoApprove(entries, input.now);
  entries.sort((a, b) => toMs(a.startsAt) - toMs(b.startsAt) || a.dedupeKey.localeCompare(b.dedupeKey));
  return {
    blocks,
    entries,
    rejected,
    humanHours: humanHours(blocks),
    leverageHours: leverageHours(blocks),
    onsite: onsite.days,
    trips: onsite.trips,
  };
}

export { isAttendedMeeting };
