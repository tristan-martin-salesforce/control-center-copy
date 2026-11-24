/**
 * DEEP-1 "Still needed?": an ask whose source was already older than the base lookback (30 days) when it was
 * first seen (the 90-day inbox reading months-old messages) does not land as open work. It waits in Triage,
 * out of Today and the overdue counts, until one click keeps it (open) or closes it (not needed).
 *
 * - The age is the newest origin message against the item's first sighting, so an ask that was fresh when
 *   first seen never moves there later, however old it gets.
 * - Work due after it was first seen stays open: an old message about a future date is a live commitment.
 * - The status reason carries the mark (`still needed?`), so Triage groups these by what the writer decided
 *   (TRAIN-1's and MIN-9's old training notices carry it too).
 *
 * Pure.
 */

/** The base lookback: older origins than this, when first seen, wait in Triage. */
export const STILL_NEEDED_DAYS = 30;
/** Lower-case mark in `status_reason` (`WorkItem.closedReason`) of a suggestion that waits as "Still needed?". */
export const STILL_NEEDED_MARK = 'still needed?';

const DAY_MS = 86_400_000;

export interface ArrivalAge {
  /** Newest origin message of the item (ms or ISO). */
  originAt: number | string | null;
  /** When the item was first seen (created). */
  firstSeenAt: number | string;
  /** Its due date, if any. */
  dueAt?: number | string | null;
  /** Settings ▸ Closing ▸ Old asks (`oldAskDays`, R15); default STILL_NEEDED_DAYS. */
  days?: number;
}

const ms = (v: number | string | null | undefined): number => (typeof v === 'number' ? v : v ? Date.parse(v) : NaN);

/** True when the ask was over STILL_NEEDED_DAYS old when first seen and is not due after that. */
export function staleOnArrival(a: ArrivalAge): boolean {
  const origin = ms(a.originAt);
  const seen = ms(a.firstSeenAt);
  if (!Number.isFinite(origin) || !Number.isFinite(seen)) return false;
  const due = ms(a.dueAt);
  if (Number.isFinite(due) && due > seen) return false;
  const days = a.days && a.days > 0 ? a.days : STILL_NEEDED_DAYS;
  return origin < seen - days * DAY_MS;
}

/** "Asked 2026-08-11, 87 days before it was first seen: still needed?" (+ " (scanner:slack)" for the scanner). */
export function stillNeededReason(originAt: number | string, firstSeenAt: number | string, by?: string): string {
  const origin = ms(originAt);
  const days = Math.floor((ms(firstSeenAt) - origin) / DAY_MS);
  return `Asked ${new Date(origin).toISOString().slice(0, 10)}, ${days} days before it was first seen: ${STILL_NEEDED_MARK}${by ? ` (${by})` : ''}`;
}

/**
 * PAST-1: a due date already past when the item is first seen (a first scan reading a month of history) lands like
 * DEEP-1, in Triage as "Still needed?". A grace of PAST_DUE_GRACE_MS keeps a live ask that is a few minutes late open.
 */
export const PAST_DUE_GRACE_MS = 2 * 3_600_000;

export function pastDueOnArrival(a: { dueAt: number | string | null | undefined; firstSeenAt: number | string }): boolean {
  const due = ms(a.dueAt ?? null);
  const seen = ms(a.firstSeenAt);
  return Number.isFinite(due) && Number.isFinite(seen) && due < seen - PAST_DUE_GRACE_MS;
}

/** "Due 2026-10-20, already past when it was found: still needed?" (+ " (scanner:slack)"). The day is local to `tz`. */
export function pastDueReason(dueAt: number | string, by?: string, tz?: string): string {
  const at = new Date(ms(dueAt));
  let day = at.toISOString().slice(0, 10);
  if (tz) {
    try {
      day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    } catch {
      /* unknown zone: the UTC day */
    }
  }
  return `Due ${day}, already past when it was found: ${STILL_NEEDED_MARK}${by ? ` (${by})` : ''}`;
}

/** A suggestion that waits in Triage's "Still needed?" group. */
export function isStillNeeded(w: { state: string; closedReason?: string | null }): boolean {
  return w.state === 'suggested' && !!w.closedReason && w.closedReason.toLowerCase().includes(STILL_NEEDED_MARK);
}

/** The reason as a Triage row's why: the writer's tag (" (scanner:slack)") dropped. */
export function stillNeededWhy(reason: string): string {
  return reason.replace(/\s*\((?:scanner|backfill):[^)]*\)\s*$/, '');
}
