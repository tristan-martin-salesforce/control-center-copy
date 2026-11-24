/**
 * The one "needs you" count (01 R5, D-86): the queue's `total`. The sidebar badge, Home's Needs-you block and the
 * Activity needs area all read it, so they cannot disagree; `tests/needs/count-parity.test.ts` pins sidebar == queue.
 * Closed rows are never in the queue, so they are never counted.
 */
import type { NeedKind, NeedsPayload } from '@/contract';

/** The queue's total (0 while it has not loaded). */
export function needsCount(q: Pick<NeedsPayload, 'total'> | null | undefined): number {
  return Math.max(0, Math.trunc(q?.total ?? 0) || 0);
}

/** The count of the kinds a page shows (Activity's slice): the sum of `byKind`. */
export function needsCountOf(q: Pick<NeedsPayload, 'byKind'> | null | undefined, kinds: readonly NeedKind[]): number {
  return kinds.reduce((s, k) => s + (q?.byKind[k] ?? 0), 0);
}

/** "12 need you" · "1 needs you" · null when nothing waits. */
export function needsPhrase(n: number): string | null {
  return n > 0 ? `${n} ${n === 1 ? 'needs' : 'need'} you` : null;
}
