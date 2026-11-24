/**
 * Capacity (DESIGN-V2 "Capacity and estimates", binding):
 *
 * - **Load is today-scoped, hands-on work only.** An item is today's load when it is explicitly pinned or
 *   planned for today, when its deadline falls today (user's timezone; a deadline earlier today that has
 *   just passed still counts), or when its start-by is at or before the end of today, whenever it is due
 *   (PRIO-3: the 150-minute demo build due tomorrow 09:30 has to start today, so it is today's load; the old
 *   "tomorrow's work is tomorrow's" rule said "fits, 35 min open" on the day it had to be built). Work overdue
 *   from an earlier day is no longer scheduled load: it shows first in "pull forward" (or is re-dated, R1).
 *   Likely-done items need no more hands-on time.
 * - Small hands-on chores that wait on you today (approving Outbox drafts, re-authenticating a connector)
 *   count too, unless the draft belongs to an item that is already today's load.
 * - **Agent and Claude-session minutes never count.** They are reported as a parallel background lane
 *   (`agentMinBackground`, `agentRunsBackground`).
 * - Free time = working hours minus busy meetings, from now on (the plan's gaps).
 * - "Overbooked" when today's hands-on minutes exceed the free minutes, and then never "fits".
 * - **After hours, the next working day (MIN-22).** Once today's working hours are over (or today has none), the
 *   same rules count the next working day instead: its load (due that day, start-by that day, pinned) and the
 *   chores still waiting, against that day's free time. Today's unfinished due-today work is then overdue from an
 *   earlier day, so it shows in pull forward, never as "over".
 *
 * Pure and deterministic.
 */
import type { Meeting, TimeWindow } from '@/engines/types';
import { approveBatchMin, kindYouMin, type Estimator } from './estimate';
import type { Prepared } from './score';
import { DAY_MS, freeIntervals, isBusy, localDayStart, MINUTE_MS, minutesBetween, toMs } from './time';
import type { Capacity, CapacityChore, PlannedChore, PullForwardEntry, RunningAgent } from './types';

/** How many pull-forward suggestions the capacity carries. */
export const PULL_FORWARD_MAX = 5;
/** A bigger item is worth pulling in when at least this much open time is left to start it. */
export const PULL_FORWARD_MIN_START = 30;

const PULLABLE = new Set(['open', 'in_progress', 'waiting_on_me']);

export interface DayBounds {
  /** Local midnight today, as a UTC instant. */
  startMs: number;
  /** Local midnight tomorrow. */
  endMs: number;
}

/** Why an item is (or is not) today's load. */
export type TodayScope = 'pinned' | 'due_today' | 'start_by_today' | null;

export function todayScope(p: Prepared, day: DayBounds, pinned: ReadonlySet<string>): TodayScope {
  if (p.item.status === 'likely_done') return null;
  if (pinned.has(p.item.id)) return 'pinned';
  const d = p.deadlineMs;
  if (d !== null && d >= day.startMs && d < day.endMs) return 'due_today';
  // PRIO-3: a start-by at or before the end of today makes it today's work, even when it is due tomorrow.
  if (d !== null && d >= day.endMs && p.startByMs !== null && p.startByMs < day.endMs) return 'start_by_today';
  return null;
}

/** Chores in plan order: one "Approve N drafts" batch, then everything else. */
export function planChores(chores: readonly CapacityChore[], todayIds: ReadonlySet<string>, est: Estimator): PlannedChore[] {
  const live = chores.filter((c) => !(c.workItemId && todayIds.has(c.workItemId)));
  const approvals = live.filter((c) => c.kind === 'approve');
  const out: PlannedChore[] = [];
  if (approvals.length) {
    const explicit = approvals.filter((c) => typeof c.youMin === 'number' && c.youMin > 0);
    const batched = approvals.filter((c) => !explicit.includes(c));
    const youMin = explicit.reduce((s, c) => s + Math.round(c.youMin!), 0) + approveBatchMin(batched.length, est);
    const n = approvals.length;
    out.push({
      id: n === 1 ? approvals[0]!.id : 'chore:approve',
      kind: 'approve',
      title: n === 1 ? approvals[0]!.title : `Approve ${n} drafts`,
      youMin,
      count: n,
      choreIds: approvals.map((c) => c.id).sort(),
    });
  }
  for (const c of live) {
    if (c.kind === 'approve') continue;
    const youMin = typeof c.youMin === 'number' && c.youMin > 0 ? Math.round(c.youMin) : kindYouMin(c.kind, est);
    out.push({ id: c.id, kind: c.kind, title: c.title, youMin, count: 1, choreIds: [c.id] });
  }
  return out;
}

export interface CapacityInput {
  /** Free gaps today from now on, in minutes (the plan's gaps). */
  freeMin: number;
  /** Ranked items in final order (Top 3 first). Background and hidden items are not here. */
  ordered: Prepared[];
  /** Today-scoped items, in rank order. */
  today: Prepared[];
  chores: PlannedChore[];
  runningAgents: readonly RunningAgent[];
}

export function computeCapacity(input: CapacityInput): Capacity {
  const todayIds = new Set(input.today.map((p) => p.item.id));
  const itemMin = input.today.reduce((s, p) => s + p.youMin, 0);
  const choreMin = input.chores.reduce((s, c) => s + c.youMin, 0);
  const youMinToday = itemMin + choreMin;
  const freeMin = Math.max(0, Math.round(input.freeMin));
  const openMin = freeMin - youMinToday;
  const fits = youMinToday <= freeMin;

  // Background lane: today's kick-offs that still have agent time to run, plus agent runs in flight.
  const kickoffs = input.today.filter((p) => p.agentRemainingMin > 0 && PULLABLE.has(p.item.status));
  const agentMinQueued = kickoffs.reduce((s, p) => s + p.agentRemainingMin, 0);
  const kickoffIds = new Set(kickoffs.map((p) => p.item.id));
  const running = input.runningAgents.filter((r) => !(r.workItemId && kickoffIds.has(r.workItemId)));
  const runningMin = running.reduce((s, r) => s + Math.max(0, Math.round(r.agentMinLeft ?? 0)), 0);

  const pullForward: PullForwardEntry[] = [];
  if (openMin > 0) {
    for (const p of input.ordered) {
      if (pullForward.length >= PULL_FORWARD_MAX) break;
      if (todayIds.has(p.item.id) || !PULLABLE.has(p.item.status)) continue;
      if (p.youMin > openMin && openMin < PULL_FORWARD_MIN_START) continue;
      pullForward.push({ itemId: p.item.id, title: p.item.title, youMin: p.youMin, due: p.deadline?.at ?? p.item.due ?? null });
    }
  }

  return {
    day: 'today',
    dayLabel: 'today',
    youMinToday,
    freeMin,
    openMin,
    fits,
    agentMinBackground: agentMinQueued + runningMin,
    agentRunsBackground: kickoffs.length + running.length,
    pullForward,
    todayItemIds: input.today.map((p) => p.item.id),
    chores: input.chores,
    focusMinLeft: freeMin,
    plannedMin: youMinToday,
    overByMin: youMinToday - freeMin,
    agentMinQueued,
  };
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface NextDayInput {
  nowMs: number;
  utcOffsetMinutes: number;
  /** Working windows over the horizon (today first). */
  windows: readonly TimeWindow[];
  meetings: readonly Meeting[];
  /** Everything that may be a day's load (ranked, then background), in rank order. */
  candidates: Prepared[];
  /** Ranked items in final order (pull-forward candidates). */
  ordered: Prepared[];
  pinned: ReadonlySet<string>;
  chores: readonly CapacityChore[];
  estimator: Estimator;
  runningAgents: readonly RunningAgent[];
}

/**
 * MIN-22: the next working day's capacity, or null while today still has working time ahead. "Next" is the first
 * day after today with a working window: tomorrow, or Monday on a Friday evening.
 */
export function nextWorkdayCapacity(input: NextDayInput): Capacity | null {
  const off = input.utcOffsetMinutes;
  const todayStart = localDayStart(input.nowMs, off);
  const todayEnd = todayStart + DAY_MS;
  const endOfWork = input.windows.filter((w) => toMs(w.start) < todayEnd && toMs(w.end) > todayStart).reduce((mx, w) => Math.max(mx, toMs(w.end)), -Infinity);
  if (input.nowMs < endOfWork) return null;
  const next = input.windows.filter((w) => toMs(w.start) >= todayEnd).sort((a, b) => toMs(a.start) - toMs(b.start))[0];
  if (!next) return null;
  const startMs = localDayStart(toMs(next.start), off);
  const day: DayBounds = { startMs, endMs: startMs + DAY_MS };
  const load = input.candidates.filter((p) => todayScope(p, day, input.pinned) !== null);
  const chores = planChores(input.chores, new Set(load.map((p) => p.item.id)), input.estimator);
  const busy = input.meetings.filter(isBusy).map((m) => ({ startMs: toMs(m.start), endMs: toMs(m.end) }));
  const dayWindows = input.windows.filter((w) => toMs(w.start) < day.endMs && toMs(w.end) > day.startMs);
  const freeMin = freeIntervals(dayWindows, busy, day.startMs, 5).reduce((sum, i) => sum + Math.round(minutesBetween(i.startMs, i.endMs)), 0);
  const cap = computeCapacity({ freeMin, ordered: input.ordered, today: load, chores, runningAgents: input.runningAgents });
  const label = startMs === todayEnd ? 'tomorrow' : WEEKDAY_NAMES[new Date(startMs + off * MINUTE_MS).getUTCDay()]!;
  return { ...cap, day: 'next', dayLabel: label };
}
