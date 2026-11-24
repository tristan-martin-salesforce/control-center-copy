/**
 * The ranking's own "why", in two short parts (lane 07 R7, PRIO-11/13):
 *
 * - **Why it matters**: the top value terms of the formula (who, deal, kind), never a rule every item shares.
 * - **Why now**: the time terms (late, deadline, start-by, free time before it), in plain words.
 *
 * And the overdue semantics (R1, PRIO-1): a hard deadline keeps full urgency for one working day after it passes,
 * then decays to 0.6 with "Late: do now or re-date"; a soft or inferred one drops to 0.4 at once with "Re-date or
 * drop". Overdue text reads "2 d late", never "start by Mon". Working days come from the persona's working hours and
 * timezone (`WorkingHours`), so a Friday-evening deadline is still in its grace on Monday morning.
 *
 * Pure: the engine calls it with its computed terms, and the views (Home cards, Today rows) call `whyOfItem` with
 * an item's stored rank reasons and dates, so both say the same thing in the same words.
 */
import type { WorkingHours } from '@/engines/types';
import { DAY_MS, formatDuration, formatLocalWhen, localDayStart, MINUTE_MS, workdayMinutes, workingMinutesBetween } from './time';

export interface WhyParts {
  /** Who, deal, kind: "Brendan (customer) · opp $780k". Null when nothing stands out. */
  matters: string | null;
  /** Late, deadline, start-by, free time: "due Thu 09:30 · start by 13:00". Null when nothing is dated. */
  now: string | null;
}

export type LateKind = 'grace' | 'late' | 'redate';

export interface LateState {
  kind: LateKind;
  minutesLate: number;
  /** "2 d late", "3h late". */
  label: string;
  /** The verb the row offers: null in the grace day, "Late: do now or re-date", "Re-date or drop". */
  verb: string | null;
  /** The urgency the deadline and pressure terms take (1 → 0.6, or 0.4). */
  urgency: number;
}

export const LATE_URGENCY: Record<LateKind, number> = { grace: 1, late: 0.6, redate: 0.4 };
export const LATE_VERB: Record<LateKind, string | null> = { grace: null, late: 'Late: do now or re-date', redate: 'Re-date or drop' };

/** "2 d late" across local days; "3h late" the same day. */
export function lateLabel(deadlineMs: number, nowMs: number, utcOffsetMinutes: number): string {
  const days = Math.round((localDayStart(nowMs, utcOffsetMinutes) - localDayStart(deadlineMs, utcOffsetMinutes)) / DAY_MS);
  if (days >= 1) return `${days} d late`;
  return `${formatDuration(Math.max(1, (nowMs - deadlineMs) / MINUTE_MS))} late`;
}

/** Null while the deadline is ahead. `dueKind` null or 'hard' is a hard deadline (an SLA counts as hard). */
export function lateState(deadlineMs: number, nowMs: number, dueKind: 'hard' | 'soft' | 'inferred' | null | undefined, hours: WorkingHours): LateState | null {
  if (deadlineMs > nowMs) return null;
  const minutesLate = Math.round((nowMs - deadlineMs) / MINUTE_MS);
  const label = lateLabel(deadlineMs, nowMs, hours.utcOffsetMinutes);
  let kind: LateKind;
  if (dueKind === 'soft' || dueKind === 'inferred') kind = 'redate';
  else {
    const grace = workdayMinutes(hours);
    kind = workingMinutesBetween(deadlineMs, nowMs, hours, grace) < grace ? 'grace' : 'late';
  }
  return { kind, minutesLate, label, verb: LATE_VERB[kind], urgency: LATE_URGENCY[kind] };
}

/** The "now" part for a late item: "2 d late · re-date or drop". */
export function latePhrase(l: LateState): string {
  return l.verb ? `${l.label} · ${lowerFirst(l.verb)}` : `${l.label} · do it now`;
}

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Matters: the value terms
// ---------------------------------------------------------------------------

/** Rank-reason keys that say why the item matters (engine component keys and the mock scorer's weight keys). */
const MATTER_KEYS: Record<string, number> = {
  stakeholderImportance: 0,
  dealValue: 1,
  commitmentWeight: 2,
  obligationBoost: 3,
  userAdjustment: 4,
  // priority@2 value terms (v2/rank.ts)
  'value.who': 0,
  'value.deal': 1,
  'value.kind': 2,
  'value.importance': 3,
  'value.goal': 3,
  // mock scorer (interim ranker) keys
  manager_ask: 0,
  deal_value: 1,
  customer_facing: 2,
  boost: 4,
};

export interface ReasonLike {
  key: string;
  label: string;
  contribution: number;
}

/**
 * What an item is worth from its stored rank reasons: the sum of the value terms' points (priority@2's V; for
 * priority@1.1 rows, its who / deal / kind points). Make room sorts by it.
 */
export function valueFromReasons(reasons: readonly ReasonLike[]): number {
  return Math.round(reasons.filter((r) => r.key in MATTER_KEYS && r.contribution > 0).reduce((s, r) => s + r.contribution, 0) * 1000) / 1000;
}

/** The top two value terms, by contribution ("Brendan (customer) · opp $780k"). Rules never count here. */
export function mattersFrom(reasons: readonly ReasonLike[], max = 2): string | null {
  const picked = reasons
    .filter((r) => r.key in MATTER_KEYS && r.contribution > 0 && r.label)
    .sort((a, b) => b.contribution - a.contribution || MATTER_KEYS[a.key]! - MATTER_KEYS[b.key]!)
    .slice(0, max)
    .map((r) => r.label);
  return picked.length ? picked.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Now: the time terms
// ---------------------------------------------------------------------------

export interface NowInput {
  nowMs: number;
  utcOffsetMinutes: number;
  late: LateState | null;
  /** The deadline ahead in words ("due Thu 09:30", "Elderglen demo Thu 10:00"), when there is one. */
  deadlineLabel: string | null;
  deadlineMs: number | null;
  startByMs: number | null;
  /** Your minutes on it (to say whether the free time before it is enough). */
  youMin?: number;
  /** Free working minutes between now and the deadline, when known. */
  freeBeforeMin?: number | null;
  /** Agent minutes still to run that must finish first ("agent ~2h: kick off first"). */
  agentMin?: number;
  /** Age in days, for undated work ("12 d old"). */
  ageDays?: number;
}

/** "due Thu 09:30 · start by 13:00 · 2h free before it", "2 d late · re-date or drop", "start now · due 17:00". */
export function nowPhrase(n: NowInput): string | null {
  if (n.late) return latePhrase(n.late);
  if (n.deadlineMs === null || !n.deadlineLabel) return n.ageDays !== undefined && n.ageDays >= 7 ? `${n.ageDays} d old` : null;
  const parts: string[] = [];
  if (n.startByMs !== null && n.startByMs <= n.nowMs) parts.push('start now', n.deadlineLabel);
  else {
    parts.push(n.deadlineLabel);
    if (n.startByMs !== null && n.startByMs < n.deadlineMs) parts.push(`start by ${formatLocalWhen(n.startByMs, n.nowMs, n.utcOffsetMinutes)}`);
  }
  if (n.agentMin && n.agentMin >= 30) parts.push(`agent ~${formatDuration(n.agentMin)} first`);
  else if (typeof n.freeBeforeMin === 'number' && (n.youMin ?? 0) >= 30 && n.deadlineMs - n.nowMs <= 3 * DAY_MS) {
    parts.push(n.freeBeforeMin < (n.youMin ?? 0) ? `only ${formatDuration(n.freeBeforeMin)} free before it` : `${formatDuration(n.freeBeforeMin)} free before it`);
  }
  return parts.join(' · ');
}

/** "Due Thu 09:30 · start by 13:00. Brendan (customer) · opp $780k." One line for a card that shows one string. */
export function whyLine(p: WhyParts): string | null {
  const s = [p.now, p.matters].filter((x): x is string => !!x).map((x) => x[0]!.toUpperCase() + x.slice(1));
  return s.length ? s.join('. ') : null;
}

// ---------------------------------------------------------------------------
// The view's why: from a stored item (Home cards, Today rows)
// ---------------------------------------------------------------------------

export interface WhyItem {
  due: string | null;
  dueKind?: 'hard' | 'soft' | 'inferred' | null;
  startBy: string | null;
  rankReasons: readonly ReasonLike[];
  effort?: { youMin: number; agentMin: number };
  ageDays?: number;
  kind?: string;
  counterparty?: { name: string } | null;
  /** The meeting it serves, when it starts before the due date. */
  meeting?: { label: string; start: string } | null;
}

const KIND_FALLBACK: Record<string, (who: string | null) => string> = {
  ask: (who) => (who ? `asked by ${who}` : 'asked of you'),
  commitment: (who) => (who ? `you promised ${who}` : 'you promised'),
  follow_up: () => 'meeting follow-up',
  deliverable: () => 'deliverable',
};

/**
 * The two parts for a stored item at `nowMs`: matters from its rank reasons (the ranking's own terms), now from its
 * dates, recomputed so "2 d late" is true when the page renders. `hours` carries the persona's working hours and
 * UTC offset (the grace day is one working day of them).
 */
export function whyOfItem(item: WhyItem, nowMs: number, hours: WorkingHours): WhyParts {
  const off = hours.utcOffsetMinutes;
  const dueMs = item.due ? Date.parse(item.due) : null;
  const meetingMs = item.meeting ? Date.parse(item.meeting.start) : null;
  const useMeeting = meetingMs !== null && meetingMs > nowMs && (dueMs === null || meetingMs <= dueMs);
  const deadlineMs = useMeeting ? meetingMs : dueMs;
  const late = !useMeeting && dueMs !== null && dueMs <= nowMs ? lateState(dueMs, nowMs, item.dueKind ?? null, hours) : null;
  const deadlineLabel =
    deadlineMs === null ? null : useMeeting ? `${item.meeting!.label} ${formatLocalWhen(deadlineMs, nowMs, off)}` : `due ${formatLocalWhen(deadlineMs, nowMs, off)}`;
  const startByMs = item.startBy ? Date.parse(item.startBy) : null;
  const who = item.counterparty?.name?.split(' ')[0] ?? null;
  const matters = mattersFrom(item.rankReasons) ?? (item.kind && KIND_FALLBACK[item.kind] ? KIND_FALLBACK[item.kind]!(who) : null);
  const now = nowPhrase({
    nowMs,
    utcOffsetMinutes: off,
    late,
    deadlineLabel,
    deadlineMs,
    startByMs: late ? null : startByMs,
    youMin: item.effort?.youMin,
    ...(item.ageDays !== undefined ? { ageDays: item.ageDays } : {}),
  });
  return { matters, now };
}
