/**
 * Prep rules and onsite days (lane 07 §4.4, H-8 decision 5).
 *
 * - A meeting's prep item inherits the meeting: its need-by is the meeting's start (minus the rule's ready-before
 *   minutes) and its importance is at least the rule's (a customer demo's prep is high; an exec readout's critical).
 * - Onsite days pull prep forward: a day held by a long busy block (a workshop day) or a working location named
 *   "onsite" is an onsite day. Prep for a meeting on an onsite day is ready by the end of the last working day before
 *   it (you travel, or you are at the customer, the morning of).
 *
 * Pure: meetings and working windows in, adjusted need-by and importance out. The rules are the persona's.
 */
import type { ImportanceLevel, Meeting, TimeWindow } from '@/engines/types';
import { localDayStart, MINUTE_MS, toMs } from '../time';
import type { PrepRule, PriorityConfig } from './config';
import { maxImportance } from './terms';

const re = (p: string | undefined): RegExp | null => (p ? new RegExp(p, 'i') : null);

export function isCustomerMeeting(m: Meeting): boolean {
  return !!(m.hasExternalAttendees || m.isCustomerFacing);
}

/** The persona's prep rules that apply to a meeting, in order. */
export function prepRulesFor(m: Meeting, rules: readonly PrepRule[]): PrepRule[] {
  return rules.filter((r) => {
    if (r.customerFacing && !isCustomerMeeting(m)) return false;
    const rx = re(r.meetingTitlePattern);
    return rx ? rx.test(m.title) : true;
  });
}

export interface PrepAdjust {
  needByMs: number;
  importance: ImportanceLevel;
  /** The rule ids that applied (for the why). */
  rules: string[];
  /** "ready the day before the onsite" when the onsite rule moved it. */
  onsite: boolean;
}

/**
 * A prep item's need-by and importance from the meeting it serves. `onsiteDayStarts` holds the local-midnight instants
 * of onsite days; `windows` the working windows (to find the last working day before one).
 */
export function prepAdjust(
  base: { importance: ImportanceLevel },
  m: Meeting,
  cfg: Pick<PriorityConfig, 'prepRules' | 'onsite'>,
  ctx: { onsiteDayStarts: ReadonlySet<number>; windows: readonly TimeWindow[]; utcOffsetMinutes: number },
): PrepAdjust {
  const start = toMs(m.start);
  const rules = prepRulesFor(m, cfg.prepRules);
  let importance = base.importance;
  let readyBefore = 0;
  for (const r of rules) {
    importance = maxImportance(importance, r.importance);
    readyBefore = Math.max(readyBefore, r.readyBeforeMin);
  }
  let needByMs = start - readyBefore * MINUTE_MS;
  let onsite = false;
  const day = localDayStart(start, ctx.utcOffsetMinutes);
  if (cfg.onsite.prepReadyDayBefore && ctx.onsiteDayStarts.has(day)) {
    const before = lastWorkEndBefore(day, ctx.windows);
    if (before !== null && before < needByMs) {
      needByMs = before;
      onsite = true;
    }
  }
  return { needByMs, importance, rules: rules.map((r) => r.id), onsite };
}

/** The end of the last working window that ends at or before `ms` (null when there is none in the horizon). */
export function lastWorkEndBefore(ms: number, windows: readonly TimeWindow[]): number | null {
  let best: number | null = null;
  for (const w of windows) {
    const e = toMs(w.end);
    if (e <= ms && (best === null || e > best)) best = e;
  }
  return best;
}

/** Local-day starts of onsite days: a busy block of at least `minBlockMin`, or a working location named onsite. */
export function onsiteDays(meetings: readonly Meeting[], cfg: Pick<PriorityConfig, 'onsite'>, utcOffsetMinutes: number, isBusy: (m: Meeting) => boolean): Set<number> {
  const out = new Set<number>();
  for (const m of meetings) {
    const s = toMs(m.start);
    const e = toMs(m.end);
    if (m.eventType === 'working_location' && /onsite|on-site|on site/i.test(m.title)) out.add(localDayStart(s, utcOffsetMinutes));
    else if (isBusy(m) && (e - s) / MINUTE_MS >= cfg.onsite.minBlockMin) out.add(localDayStart(s, utcOffsetMinutes));
  }
  return out;
}
