/**
 * What a sidebar count says to a screen reader and on hover. A quiet count names what it counts (2026-11-13 audit C2),
 * in the singular for one ("1 card not applied yet", never "1 cards").
 */
import type { NavCountKey } from './nav';

export function quietCountWhat(kind: NavCountKey | undefined, count: number): string {
  if (kind === 'needs') return count === 1 ? ' thing needs you' : ' things need you';
  if (kind === 'adminWaiting') return ' waiting on you: to log, or VDPs that need you';
  if (kind === 'assistantPending') return count === 1 ? ' card not applied yet' : ' cards not applied yet';
  return '';
}
