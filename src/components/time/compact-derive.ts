/**
 * The cells of a compact activity row (Activity-at-scale C3, §3.4 "Rows"): when, hours, and where it goes, in plain
 * words. Where it goes is the row's own opp (account · opp), Internal, the app's suggestion with how likely it is ("87%
 * likely", with a ✓ at or over the settle line), or "Pick an opp" when there is nothing to go on.
 */
import type { ActivityEntry, ActivitySuggestion } from '@/contract';
import { clock, dayLabel, weekday } from '@/components/domain/lib/time';
import { DEFAULT_WEIGHTS } from '@/engines/attribution/weights';

/** The top suggestion is settled: at or over the line, and the second is not within the margin. */
export function settled(e: ActivityEntry, settle: number, margin = DEFAULT_WEIGHTS.margin): boolean {
  const s = e.suggestion;
  if (!s || s.confidence < settle) return false;
  const second = (e.suggestions ?? []).find((x) => x !== s && !(x.kind === s.kind && x.oppId === s.oppId));
  return !second || s.confidence - second.confidence >= margin;
}

export type WhereKind = 'set' | 'internal' | 'suggested' | 'pick';

export interface WhereCell {
  kind: WhereKind;
  /** Account · opp, "Internal", or "Pick an opp". */
  target: string;
  /** "87%" on a suggestion; null otherwise. */
  percent: string | null;
  /** The suggestion is at or over the settle line (and no close second). */
  sure: boolean;
  /** The accessible name: "87 percent likely Globex · Data 360 Expansion". */
  label: string;
}

/** "Globex · Data 360 Expansion" (the account first; the opp alone when the account is unknown). */
export function accountOpp(accountName: string | null | undefined, oppName: string | null | undefined): string {
  // an opp named after its account ("Hooli · Nimbus Context Engine") is not prefixed twice
  if (accountName && oppName && oppName.toLowerCase().startsWith(accountName.toLowerCase())) return oppName;
  return [accountName, oppName].filter((x): x is string => !!x && !!x.trim()).join(' · ') || 'An opportunity';
}

function suggestionTarget(s: ActivitySuggestion): string {
  return s.kind === 'internal' ? 'Internal' : accountOpp(s.accountName, s.oppName);
}

/** Where the row goes, as the compact row's where cell shows and reads it. */
export function whereOf(e: ActivityEntry, settle: number): WhereCell {
  if (e.internal) return { kind: 'internal', target: 'Internal', percent: null, sure: false, label: 'Internal (no opportunity)' };
  if (e.oppId) {
    const target = accountOpp(e.accountName, e.oppName);
    return { kind: 'set', target, percent: null, sure: false, label: target };
  }
  // D-103 (c): the account itself (no open opportunity, or picked)
  if (e.accountId) {
    const target = `${e.accountName ?? 'The account'} (the account)`;
    return { kind: 'set', target, percent: null, sure: false, label: target };
  }
  const s = e.suggestion;
  if (s) {
    const n = Math.round(s.confidence * 100);
    const target = suggestionTarget(s);
    return { kind: 'suggested', target, percent: `${n}%`, sure: settled(e, settle), label: `${n} percent likely ${target}` };
  }
  return { kind: 'pick', target: 'Pick an opp', percent: null, sure: false, label: 'Pick an opp' };
}

/** "Thu 19 10:00": the day (weekday and date) and the start time, short enough for the row's when column. */
export function compactWhen(e: Pick<ActivityEntry, 'date' | 'start'>, tz?: string): string {
  const day = dayLabel(`${e.date}T12:00:00Z`, 'UTC').split(' ').slice(0, 2).join(' ');
  return `${day} ${clock(e.start, tz)}`;
}

/** "Thu 08:00": the weekday and the start time, for a narrow lane (two columns at 1440). */
export function compactWhenShort(e: Pick<ActivityEntry, 'date' | 'start'>, tz?: string): string {
  return `${weekday(`${e.date}T12:00:00Z`, 'UTC')} ${clock(e.start, tz)}`;
}

/** "Thu 19": the day alone, the narrow lead of a failure row (its reason needs the room, R2-10). */
export const compactDay = (e: Pick<ActivityEntry, 'date'>): string => dayLabel(`${e.date}T12:00:00Z`, 'UTC').split(' ').slice(0, 2).join(' ');

/** A failure's two forms: `short` in the row's where cell, `long` as its title and in the details panel. */
export interface FailureReason {
  short: string;
  long: string;
}

const SHORT_FAILURE: Record<string, string> = {
  'Not found in Org62 after the batch ran': 'Not found in Org62',
  'Not found in Slack after Apply': 'Not found in Slack',
};

/** The short form of a failure sentence: the known ones by name; any other cut at its first clause. */
export function shortFailure(long: string): string {
  return SHORT_FAILURE[long] ?? (long.split(/ after | because |[.;:(]/)[0] ?? long).trim();
}

/** A not-found row's reason, short and long: the short one in Sending's row, the long one as its title and in the details panel (R2-10). */
export function failureReason(e: Pick<ActivityEntry, 'status'>): FailureReason {
  return e.status === 'verify_failed'
    ? { short: 'Deleted in Org62', long: 'Deleted in Org62 after it was logged' }
    : { short: 'Not found in Org62', long: 'Not found in Org62 after the batch ran' };
}

/** "1.5 h" */
export const compactHours = (h: number): string => `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} h`;
