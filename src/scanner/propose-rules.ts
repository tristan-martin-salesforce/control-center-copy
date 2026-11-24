/**
 * Pure rules the stores apply when the scanner proposes an item (store-db and store-memory share them).
 *
 *  - DUE-1 `parseDue`: a bare date (`2026-11-04`) means 17:00 in the user's timezone, and a date-time without a zone is
 *    read in that timezone. Before, `Date.parse` made a bare date UTC midnight: the evening before in the Americas, so
 *    13 items of the first 30-day scan were due before they were asked.
 *  - DUP-1 `sameDeliverable`: two proposals from the same conversation and the same person are one item when their
 *    titles share enough words (the people's names aside), name the same deliverable noun and lead with the same kind
 *    of verb (SCN-14). Before, only an identical origin message deduped.
 */
import { atLocal } from '@/engines/home/time';

import { tokenize } from './store-memory';

/** The hour a bare due date means (R7: "EOD" and day-only deadlines are 17:00 local). */
export const BARE_DATE_HOUR = 17;

/** A due value as an instant (ms), read in `tz` when it carries no zone. NaN when unparseable. */
export function parseDue(v: string | undefined | null, tz: string): number {
  const t = (v ?? '').trim();
  if (!t) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
    const hh = m[4] !== undefined ? Number(m[4]) : BARE_DATE_HOUR;
    const mm = m[5] !== undefined ? Number(m[5]) : 0;
    try {
      return atLocal(y, mo, d, hh, mm, tz) + (m[6] ? Number(m[6]) * 1000 : 0);
    } catch {
      return Date.UTC(y, mo - 1, d, hh, mm);
    }
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? NaN : ms;
}

/** Title words that name a person (their name parts), so a shared name alone never makes two items one. */
export function nameWords(...names: Array<string | null | undefined>): Set<string> {
  return new Set(names.flatMap((n) => tokenize(n ?? '')));
}

/** SCN-14: the names of the others in a conversation (`meta.participants`, me left out): a commitment's counterpart. */
export function counterpartNames(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  return participants.flatMap((p) => (p && typeof p === 'object' && !(p as { isMe?: boolean }).isMe && typeof (p as { name?: unknown }).name === 'string' ? [(p as { name: string }).name] : []));
}

/** SCN-14: what a deliverable is (singular). Two titles naming different ones are two items, whatever else they share. */
const DELIVERABLE_NOUNS = new Set(
  'deck slide presentation doc document proposal quote sow contract demo poc diagram architecture recording video invite agenda note summary recap report spreadsheet sheet template rfp questionnaire license trial sandbox screenshot onepager brief plan estimate roadmap email link case ticket'.split(' '),
);
/** SCN-14: the leading verb's kind. "Share the deck" and "Review the deck" are two deliverables of one deck. */
const VERB_CLASS: Record<string, string> = Object.fromEntries(
  Object.entries({
    deliver: 'send share forward deliver provide give pass upload attach',
    review: 'review check look read approve proofread validate verify',
    make: 'draft write build create prepare prep make design update fix revise edit',
    schedule: 'schedule book set setup organize organise arrange',
    answer: 'answer reply respond confirm',
  }).flatMap(([cls, ws]) => ws.split(' ').map((w) => [w, cls] as const)),
);

const wordsOf = (t: string) => t.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
const singular = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const nounsOf = (t: string) => new Set(wordsOf(t).map(singular).filter((w) => DELIVERABLE_NOUNS.has(w)));
const verbClassOf = (t: string): string | undefined => VERB_CLASS[wordsOf(t)[0] ?? ''];

/**
 * Do two titles name the same deliverable? At least two shared words, covering at least half of the shorter title
 * (stop words and the people's names left out). SCN-14: and when both name a deliverable noun (deck, doc, quote…) they
 * share one, and when both lead with a known verb (share vs review) it is of the same kind.
 */
export function sameDeliverable(a: string, b: string, exclude: Set<string> = new Set()): boolean {
  const x = new Set(tokenize(a).filter((w) => !exclude.has(w)));
  const y = new Set(tokenize(b).filter((w) => !exclude.has(w)));
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  if (!(shared >= 2 && shared / Math.min(x.size, y.size) >= 0.5)) return false;
  const na = nounsOf(a);
  const nb = nounsOf(b);
  if (na.size && nb.size && ![...na].some((n) => nb.has(n))) return false;
  const va = verbClassOf(a);
  const vb = verbClassOf(b);
  return !(va && vb && va !== vb);
}
