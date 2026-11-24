/**
 * What Activity ▸ Needs you ▸ DCs to claim shows (DcSuggestions.tsx), pure: the suggestions grouped by engagement (one
 * account's opps in the quarter), which are ticked by default, what "Claim N" takes, and each row's words.
 */
import type { DcSuggestion } from '@/contract';
import { fmtAmount } from '@/lib/deals-format';

export interface DcGroup {
  key: string;
  accountName: string | null;
  rows: DcSuggestion[];
}

/** One group per engagement, in the payload's order (pre-ticked and the bigger share first inside). */
export function dcGroups(list: readonly DcSuggestion[]): DcGroup[] {
  const out = new Map<string, DcGroup>();
  for (const s of list) {
    const g = out.get(s.groupKey) ?? { key: s.groupKey, accountName: s.accountName, rows: [] };
    g.rows.push(s);
    out.set(s.groupKey, g);
  }
  return [...out.values()];
}

/** Ticked by default: the pre-ticked ones (strong evidence, no split question). Pre-ticked is never claimed: Claim is your click. */
export const defaultTicked = (list: readonly DcSuggestion[]): Set<string> => new Set(list.filter((s) => s.preTicked && s.splitPercent !== null).map((s) => s.id));

/** What "Claim N" takes: ticked rows with a split (a split question waits for Edit). */
export const claimable = (list: readonly DcSuggestion[], ticked: ReadonlySet<string>): DcSuggestion[] => list.filter((s) => ticked.has(s.id) && s.splitPercent !== null);

/** "$250K · Validation · closes Dec 15" */
export function dcFacts(s: Pick<DcSuggestion, 'amount' | 'stage' | 'closeDate'>): string {
  const close = s.closeDate ? `closes ${new Date(`${s.closeDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : null;
  return [s.amount !== null ? fmtAmount(s.amount) : null, s.stage, close].filter(Boolean).join(' · ');
}

/** "Claim a 100% DC" / "Split? agree it first" */
export const dcSplitWords = (s: Pick<DcSuggestion, 'splitPercent'>): string => (s.splitPercent === null ? 'Split? agree it first' : `Claim a ${s.splitPercent}% DC`);

/**
 * Whose opp a rundown or candidate line names: "your DC", "your team", "Kim's deal". D-55: without deal contributions
 * (an AE's preset) a DC of mine never shows; the opp reads "yours" when it is in my book (owned or on its team).
 */
export function oppOwnerWord(o: { myDc?: boolean; isMine?: boolean; coveredAe?: string | null }, dc: boolean): string | null {
  if (!dc) return o.isMine || o.myDc ? 'yours' : o.coveredAe ? `${o.coveredAe}’s deal` : null;
  return o.myDc ? 'your DC' : o.isMine ? 'your team' : o.coveredAe ? `${o.coveredAe}’s deal` : null;
}

/** The rundown's line of recent work: "3 meetings · 12 Slack lines · 2 h in 4 weeks" (or "no work in 4 weeks"). */
export function recentWork(o: { meetings4w: number; slack4w: number; hours4w: number }): string {
  const parts = [o.meetings4w ? `${Math.round(o.meetings4w * 10) / 10} meeting${o.meetings4w === 1 ? '' : 's'}` : null, o.slack4w ? `${o.slack4w} Slack line${o.slack4w === 1 ? '' : 's'}` : null, o.hours4w ? `${o.hours4w} h logged` : null].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} in 4 weeks` : 'no work in 4 weeks';
}
