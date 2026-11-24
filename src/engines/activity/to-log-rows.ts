/**
 * Activity ▸ To log's one row set (2026-11-23 activity lanes review, R2-1, chunk F1): the rows the To log lanes, the
 * tab badge, the sidebar's `navCounts.toLog` and Home's queue row (time_ready_to_log) all count, so no row that needs
 * you is on no page. Pure and a leaf beside the one rule (./to-log-count.ts); no component imports.
 *
 *   base   the current fiscal quarter so far, and at least the last 3 weeks (from this week's Monday), through this
 *          week's Sunday: what the page showed before F1 (src/components/time/derive.ts `q4Range`)
 *   range  from the first day of the quarter of the oldest live row that still needs you (a fix, or not found in
 *          Org62) when that is earlier than `base.from`, else `base`: a seller behind on logging sees last quarter's
 *          rows in lane 1, due first
 *
 * The header sentence stays about the current quarter; only the lanes widen.
 */
import type { ActivityEntry } from '@/contract';
import { appliedRowIds, openNeedOf, type CanvasLike } from './to-log-count';

export interface DayRange {
  from: string;
  to: string;
}

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The Salesforce fiscal quarter a local day is in (FY from 1 February): 2026-10-20 → "Q3 FY27", 2027-01-05 → "Q4 FY27". */
export function fiscalQuarterOfDay(day: string): string {
  const [y, mo] = day.split('-').map(Number) as [number, number];
  const fy = mo >= 2 ? y + 1 : y;
  const q = Math.floor(((mo + 10) % 12) / 3) + 1; // Feb → Q1 … Jan → Q4
  return `Q${q} FY${String(fy % 100).padStart(2, '0')}`;
}

/** The first day of the fiscal quarter a local day is in (quarters start Feb, May, Aug and Nov). */
export function fiscalQuarterStartOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1; // 0-based
  const into = (m - 1 + 12) % 3;
  return ymd(Date.UTC(y, m - into, 1));
}

/** The page's base range for a local day: the quarter so far (or 3 weeks back from Monday, when earlier) to Sunday. */
export function toLogBase(today: string, quarterStart = fiscalQuarterStartOf(today), lookbackWeeks = 3): DayRange {
  const t = dayMs(today);
  const monday = t - ((new Date(t).getUTCDay() + 6) % 7) * DAY;
  const lookback = ymd(monday - lookbackWeeks * 7 * DAY);
  return { from: quarterStart < lookback ? quarterStart : lookback, to: ymd(monday + 6 * DAY) };
}

/** A row To log counts as needing you: not found in Org62 after its batch ran, or a fix that is not an Internal row. */
export function needsYouOnToLog(e: ActivityEntry, applied: ReadonlySet<string>, taskTypeRequired = true): boolean {
  const k = openNeedOf(e, applied, taskTypeRequired);
  return k === 'org62' || (k === 'fix' && !e.internal);
}

export interface ToLogRangeInput {
  /** Any superset of the rows that need you (the whole log, or the live and handed-off ones). */
  rows: readonly ActivityEntry[];
  canvases?: readonly CanvasLike[] | null;
  taskTypeRequired?: boolean;
  base: DayRange;
}

/** The one row set's range: `base`, widened back to the quarter start of the oldest row that needs you. */
export function toLogRange({ rows, canvases, taskTypeRequired = true, base }: ToLogRangeInput): DayRange {
  const applied = appliedRowIds(canvases);
  let oldest: string | null = null;
  for (const e of rows) if (e.date <= base.to && (!oldest || e.date < oldest) && needsYouOnToLog(e, applied, taskTypeRequired)) oldest = e.date;
  const start = oldest ? fiscalQuarterStartOf(oldest) : null;
  return start && start < base.from ? { from: start, to: base.to } : base;
}

/** The rows of a range (inclusive local days). */
export const rowsIn = <T extends { date: string }>(rows: readonly T[], r: DayRange): T[] => rows.filter((e) => e.date >= r.from && e.date <= r.to);

/**
 * The status buckets (GET /time/log `status=`) that hold every row that can need you: the live ones and the ones
 * handed off (a row Org62 lacks after its batch ran is synced_to_canvas or verify_failed). The client reads these
 * first, unbounded, to find the range's start.
 */
export const TO_LOG_NEED_STATUSES = 'needs_input,proposed,approved,handed_off';
