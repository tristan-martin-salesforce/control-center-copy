/**
 * Start-by planned backwards (lane 07 §4.1, PRIO-2): walk back from each item's need-by through the persona's working
 * hours minus busy meetings minus work already committed to that time, until the item's hands-on minutes fit. So a
 * Friday deliverable with a Thursday onsite starts Wednesday, and tomorrow-morning's demo build, with no room
 * tomorrow morning, starts today.
 *
 * Committed work goes first: items are placed in need-by order (earliest first), each as late as it can go before its
 * own need-by in what the earlier ones left. A later deadline therefore plans around the nearer ones (they hold the
 * hours closest to them), which is what "minus already-committed work" means. An item that cannot fit any more starts
 * now (`fits: false`), and an overbooked week never pushes tomorrow's ten-minute reply into "start now".
 *
 * Pure. Monotone: less free time (a meeting added inside the window, more committed work) never moves a start-by later.
 */
import { MINUTE_MS, type Interval } from '../time';

export interface PlanJob {
  id: string;
  /** When your part must be finished (need-by minus buffer and agent time). */
  needByMs: number;
  /** Your hands-on minutes. */
  effortMin: number;
}

/** A shortfall up to max(10 min, 15 % of the effort) keeps the plan's start-by (estimates are coarse). */
export const SHORT_TOLERANCE_MIN = 10;
export const SHORT_TOLERANCE_PCT = 0.15;

export interface PlannedStart {
  /** The latest start that meets the need-by; `nowMs` when it cannot fit any more. */
  startByMs: number;
  fits: boolean;
  /** Minutes that found no free time before the need-by. */
  shortMin: number;
  /** Where the plan put the work (latest first). */
  placed: Interval[];
}

export interface PlanOptions {
  nowMs: number;
  /** Percent of free time kept for interrupts (0–50): each placed minute needs 1 / (1 − reserve) free minutes. */
  reservePct?: number;
}

/** Free intervals from `nowMs` on (sorted, non-overlapping), copied so the caller's list is never mutated. */
function clipFree(free: readonly Interval[], nowMs: number): Interval[] {
  return free
    .map((i) => ({ startMs: Math.max(i.startMs, nowMs), endMs: i.endMs }))
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** Small work is never split across gaps (plan.ts's rule); bigger work is, but never into slivers. */
export const SPLIT_ABOVE_MIN = 30;
export const MIN_PIECE_MIN = 15;

/** Take `needMin` minutes from `avail` going backwards from `beforeMs`; mutates `avail`. */
function takeBackwards(avail: Interval[], beforeMs: number, needMin: number): { placed: Interval[]; shortMin: number } {
  const placed: Interval[] = [];
  let need = needMin * MINUTE_MS;
  const whole = needMin <= SPLIT_ABOVE_MIN;
  const usable = (i: number) => {
    const a = avail[i]!;
    return Math.min(a.endMs, beforeMs) - a.startMs;
  };
  // small work: the latest single gap it fits in whole (else it splits like the rest)
  if (whole) {
    for (let i = avail.length - 1; i >= 0; i--) {
      if (avail[i]!.startMs >= beforeMs || usable(i) < need) continue;
      const a = avail[i]!;
      const end = Math.min(a.endMs, beforeMs);
      placed.push({ startMs: end - need, endMs: end });
      const pieces: Interval[] = [];
      if (end - need > a.startMs) pieces.push({ startMs: a.startMs, endMs: end - need });
      if (a.endMs > end) pieces.push({ startMs: end, endMs: a.endMs });
      avail.splice(i, 1, ...pieces);
      return { placed, shortMin: 0 };
    }
  }
  for (let i = avail.length - 1; i >= 0 && need > 0; i--) {
    const a = avail[i]!;
    if (a.startMs >= beforeMs) continue;
    const end = Math.min(a.endMs, beforeMs);
    const len = end - a.startMs;
    if (len <= 0 || len < Math.min(need, MIN_PIECE_MIN * MINUTE_MS)) continue;
    const take = Math.min(len, need);
    const start = end - take;
    placed.push({ startMs: start, endMs: end });
    need -= take;
    // split the interval around the taken piece
    const pieces: Interval[] = [];
    if (start > a.startMs) pieces.push({ startMs: a.startMs, endMs: start });
    if (a.endMs > end) pieces.push({ startMs: end, endMs: a.endMs });
    avail.splice(i, 1, ...pieces);
  }
  return { placed, shortMin: need / MINUTE_MS };
}

/** Plan every job backwards through the free time; returns each job's latest start. */
export function planBackwards(jobs: readonly PlanJob[], free: readonly Interval[], opts: PlanOptions): Map<string, PlannedStart> {
  const reserve = Math.min(50, Math.max(0, opts.reservePct ?? 0)) / 100;
  const avail = clipFree(free, opts.nowMs);
  const out = new Map<string, PlannedStart>();
  const order = [...jobs].sort((a, b) => a.needByMs - b.needByMs || a.id.localeCompare(b.id));
  for (const j of order) {
    if (j.needByMs <= opts.nowMs) {
      out.set(j.id, { startByMs: opts.nowMs, fits: false, placed: [], shortMin: Math.round(j.effortMin) });
      continue;
    }
    const needMin = j.effortMin > 0 ? j.effortMin / (1 - reserve) : 0;
    if (needMin <= 0) {
      out.set(j.id, { startByMs: j.needByMs, fits: true, placed: [], shortMin: 0 });
      continue;
    }
    const { placed, shortMin } = takeBackwards(avail, j.needByMs, needMin);
    const earliest = placed.reduce((m, p) => Math.min(m, p.startMs), j.needByMs);
    // estimates are coarse: a shortfall within the tolerance keeps the plan's start (the day reads overbooked anyway);
    // beyond it, the work can no longer fit and it starts now
    const tol = Math.max(SHORT_TOLERANCE_MIN, SHORT_TOLERANCE_PCT * j.effortMin);
    const fits = shortMin <= 0.5;
    out.set(j.id, { startByMs: fits || (shortMin <= tol && placed.length) ? earliest : opts.nowMs, fits, placed, shortMin: Math.round(shortMin) });
  }
  return out;
}

/** Free working minutes in [fromMs, toMs) over `free`. */
export function freeMinutesBetween(free: readonly Interval[], fromMs: number, toMs: number): number {
  let total = 0;
  for (const i of free) {
    const s = Math.max(i.startMs, fromMs);
    const e = Math.min(i.endMs, toMs);
    if (e > s) total += (e - s) / MINUTE_MS;
  }
  return Math.round(total);
}
