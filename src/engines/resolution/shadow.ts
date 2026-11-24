/**
 * Shadow mode (lane 03 R8, decision H-7 "shadow first"): while `settings.closing.resolutionEngine` is `shadow`, the
 * legacy closers (the completion pass and Settle) act and the resolution check only records. This compares the two
 * over a week, for Health:
 *
 *   "Resolution check agreed on 94% of 212 closes this week; would have closed 7 more, reopened 2"
 *
 *   closes      items the legacy closers closed for me in the window
 *   agreed      of those the check judged, the ones whose latest check also closed it
 *   more        items the check closed (its latest check) that the legacy closers did not
 *   reopened    items whose latest check reopened them
 * Pure.
 */
import type { ResolutionOutcome } from './types';

export interface ShadowCheck {
  workItemId: string;
  at: string;
  outcome: ResolutionOutcome;
}

export interface ShadowComparison {
  legacyCloses: number;
  /** Legacy closes the check judged at least once. */
  checked: number;
  agreed: number;
  agreeRate: number | null;
  wouldCloseMore: number;
  wouldReopen: number;
  checks: number;
  line: string;
}

export function compareShadow(legacyClosedIds: Iterable<string>, checks: ShadowCheck[]): ShadowComparison {
  const legacy = new Set(legacyClosedIds);
  const latest = new Map<string, ShadowCheck>();
  for (const c of checks) {
    const prev = latest.get(c.workItemId);
    if (!prev || Date.parse(c.at) >= Date.parse(prev.at)) latest.set(c.workItemId, c);
  }
  let checked = 0;
  let agreed = 0;
  let more = 0;
  let reopened = 0;
  for (const [id, c] of latest) {
    if (legacy.has(id)) {
      checked += 1;
      if (c.outcome === 'closed') agreed += 1;
    } else if (c.outcome === 'closed') more += 1;
    if (c.outcome === 'reopened') reopened += 1;
  }
  const agreeRate = checked ? agreed / checked : null;
  return { legacyCloses: legacy.size, checked, agreed, agreeRate, wouldCloseMore: more, wouldReopen: reopened, checks: checks.length, line: shadowLine({ legacyCloses: legacy.size, checked, agreeRate, wouldCloseMore: more, wouldReopen: reopened, checks: checks.length }) };
}

export function shadowLine(s: Pick<ShadowComparison, 'legacyCloses' | 'checked' | 'agreeRate' | 'wouldCloseMore' | 'wouldReopen' | 'checks'>): string {
  if (!s.checks) return 'Resolution check (shadow): no checks this week yet';
  const tail = `would have closed ${s.wouldCloseMore} more, reopened ${s.wouldReopen}`;
  if (s.agreeRate == null) return `Resolution check (shadow): ${s.checks} checks this week, none on a close; ${tail}`;
  const unchecked = s.legacyCloses - s.checked;
  return `Resolution check agreed on ${Math.round(s.agreeRate * 100)}% of ${s.checked} closes this week${unchecked > 0 ? ` (${unchecked} not checked)` : ''}; ${tail}`;
}
