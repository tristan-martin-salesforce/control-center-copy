/**
 * Pure time helpers for the planning horizon. No timezone database: the caller passes a fixed
 * UTC offset for the horizon (today + 3 days), which the data layer computes from the IANA zone.
 */
import { localDay, zonedToMs } from '@/engines/activity/time';
import type { Meeting, TimeWindow, WorkingHours } from '@/engines/types';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function toMs(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid instant: ${iso}`);
  return t;
}

export const toIso = (ms: number): string => new Date(ms).toISOString();

export const minutesBetween = (fromMs: number, toMsValue: number): number => (toMsValue - fromMs) / MINUTE_MS;

/** "09:30" → 570. */
export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`invalid HH:MM: ${s}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new Error(`invalid HH:MM: ${s}`);
  return h * 60 + min;
}

/** Local wall-clock "HH:MM" for an instant. */
export function formatLocalHHMM(ms: number, utcOffsetMinutes: number): string {
  return new Date(ms + utcOffsetMinutes * MINUTE_MS).toISOString().slice(11, 16);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Local start of the day (as a UTC instant) that contains `ms`. */
export function localDayStart(ms: number, utcOffsetMinutes: number): number {
  const off = utcOffsetMinutes * MINUTE_MS;
  return Math.floor((ms + off) / DAY_MS) * DAY_MS - off;
}

/** "14:00" today, "Thu 14:00" on another day (relative to `nowMs`). */
export function formatLocalWhen(ms: number, nowMs: number, utcOffsetMinutes: number): string {
  const hhmm = formatLocalHHMM(ms, utcOffsetMinutes);
  if (localDayStart(ms, utcOffsetMinutes) === localDayStart(nowMs, utcOffsetMinutes)) return hhmm;
  const wd = new Date(ms + utcOffsetMinutes * MINUTE_MS).getUTCDay();
  return `${WEEKDAYS[wd]} ${hhmm}`;
}

/** "45m", "1h40m", "3h". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h${String(r).padStart(2, '0')}m`;
}

const validZone = (tz: string | undefined): tz is string => {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Working windows for `days` local days starting with the day that contains `nowMs`. With `hours.timeZone`, each
 * day's start and end are wall-clock times in that zone (DST-safe, W0-11); otherwise the fixed `utcOffsetMinutes`.
 */
export function workingWindows(hours: WorkingHours, nowMs: number, days: number): TimeWindow[] {
  const startMin = parseHHMM(hours.start);
  const endMin = parseHHMM(hours.end);
  if (endMin <= startMin) return [];
  if (validZone(hours.timeZone)) return zonedWorkingWindows(hours, hours.timeZone, nowMs, days);
  const first = localDayStart(nowMs, hours.utcOffsetMinutes);
  const out: TimeWindow[] = [];
  for (let d = 0; d < days; d++) {
    const dayStart = first + d * DAY_MS;
    const weekday = new Date(dayStart + hours.utcOffsetMinutes * MINUTE_MS).getUTCDay();
    if (!hours.days.includes(weekday)) continue;
    out.push({ start: toIso(dayStart + startMin * MINUTE_MS), end: toIso(dayStart + endMin * MINUTE_MS) });
  }
  return out;
}

function zonedWorkingWindows(hours: WorkingHours, tz: string, nowMs: number, days: number): TimeWindow[] {
  // local noon of today, then +24 h a day: noon never leaves its own calendar day across a one-hour DST change
  const noon = zonedToMs(localDay(nowMs, tz), '12:00', tz);
  const out: TimeWindow[] = [];
  for (let d = 0; d < days; d++) {
    const day = localDay(noon + d * DAY_MS, tz);
    const [y, m, dd] = day.split('-').map(Number) as [number, number, number];
    if (!hours.days.includes(new Date(Date.UTC(y, m - 1, dd)).getUTCDay())) continue;
    out.push({ start: toIso(zonedToMs(day, hours.start, tz)), end: toIso(zonedToMs(day, hours.end, tz)) });
  }
  return out;
}

/**
 * Free time comes from accepted meetings only (DESIGN-V2 capacity): a meeting blocks hands-on time when
 * you accepted it (or own it: no response recorded). Cancelled, declined, tentative and unanswered
 * invites, focus time, OOO and all-day events don't block.
 */
export function isBusy(m: Meeting): boolean {
  if (m.status === 'cancelled') return false;
  if (m.myResponse === 'declined' || m.myResponse === 'tentative' || m.myResponse === 'needs_action') return false;
  if (m.isAllDay) return false;
  if (m.eventType && m.eventType !== 'default') return false;
  return true;
}

export interface Interval {
  startMs: number;
  endMs: number;
}

/** Windows minus busy intervals, clipped to [fromMs, ∞), dropping slivers shorter than minMinutes. */
export function freeIntervals(windows: TimeWindow[], busy: Interval[], fromMs: number, minMinutes = 5): Interval[] {
  const sortedBusy = [...busy].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: Interval[] = [];
  for (const w of windows) {
    let cursor = Math.max(toMs(w.start), fromMs);
    const end = toMs(w.end);
    if (cursor >= end) continue;
    for (const b of sortedBusy) {
      if (b.endMs <= cursor || b.startMs >= end) continue;
      if (b.startMs > cursor) out.push({ startMs: cursor, endMs: Math.min(b.startMs, end) });
      cursor = Math.max(cursor, b.endMs);
      if (cursor >= end) break;
    }
    if (cursor < end) out.push({ startMs: cursor, endMs: end });
  }
  return out.filter((i) => minutesBetween(i.startMs, i.endMs) >= minMinutes);
}

/**
 * Latest instant ≤ `latestMs` at which `handsOnMin` of hands-on work fits inside a working window.
 * Agent time may run outside working hours; your part may not. Returns `latestMs` when no window
 * precedes it (it is late anyway).
 */
export function clampToWorking(latestMs: number, handsOnMin: number, windows: TimeWindow[]): number {
  const need = handsOnMin * MINUTE_MS;
  let best: number | null = null;
  for (const w of windows) {
    const ws = toMs(w.start);
    const we = toMs(w.end);
    if (ws > latestMs) continue;
    const candidate = Math.min(latestMs, we - need);
    if (candidate >= ws && (best === null || candidate > best)) best = candidate;
  }
  return best ?? latestMs;
}

/** Minutes in one working day of `hours` (end − start); 8 h when the hours are degenerate. */
export function workdayMinutes(hours: WorkingHours): number {
  const m = parseHHMM(hours.end) - parseHHMM(hours.start);
  return m > 0 ? m : 8 * 60;
}

/**
 * Working minutes (inside `hours`, in its UTC offset and working days) between two instants. Stops counting
 * at `capMin` when given (callers only need to know whether a threshold was crossed).
 */
export function workingMinutesBetween(fromMs: number, toMsValue: number, hours: WorkingHours, capMin = Infinity): number {
  if (toMsValue <= fromMs) return 0;
  const days = Math.min(60, Math.ceil((toMsValue - fromMs) / DAY_MS) + 1);
  let total = 0;
  for (const w of workingWindows(hours, fromMs, days)) {
    const s = Math.max(toMs(w.start), fromMs);
    const e = Math.min(toMs(w.end), toMsValue);
    if (e > s) total += (e - s) / MINUTE_MS;
    if (total >= capMin) return total;
  }
  return total;
}
