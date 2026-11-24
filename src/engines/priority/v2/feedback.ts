/**
 * Learning from what you do (lane 07 R8, PRIO-14; tenet *Suggest, then learn*). Every manual reorder, snooze,
 * "not today", pin and "do first" is a `priority_feedback` row: the item, its rank before and after, the engine
 * version and the terms at the time (the item's and its neighbours'). The nightly job turns the rows into pairs
 * (what you preferred, what the model had above it) and, per term, counts how often the term pointed the model the
 * wrong way. A term that keeps disagreeing becomes one Health line with a one-click rule: a bounded nudge of the
 * persona's weight (config.ts `applyNudges`), recorded as a `priority_rules` row. Nothing changes until you click.
 * Pure.
 */
import { PRIORITY_TERMS, type NudgeTarget, type PriorityTerm } from './config';

export const FEEDBACK_ACTIONS = ['reorder', 'snooze', 'not_today', 'pin', 'do_first'] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

export type TermVector = Partial<Record<PriorityTerm, number>>;

/** What the feedback row keeps about the ranking at the time (local data only; ids and numbers, no text). */
export interface FeedbackSnapshot {
  item: { id: string; rank: number | null; terms: TermVector };
  /** Up to five items ranked just above and just below it. */
  neighbours: Array<{ id: string; rank: number; terms: TermVector }>;
}

export interface FeedbackRowLike {
  action: FeedbackAction;
  fromRank: number | null;
  toRank: number | null;
  snapshot: FeedbackSnapshot;
}

/** Promotions say "this one before those above it"; demotions say "those below it before this one". */
export function isPromotion(r: Pick<FeedbackRowLike, 'action' | 'fromRank' | 'toRank'>): boolean {
  if (r.action === 'do_first' || r.action === 'pin') return true;
  if (r.action === 'reorder') return r.fromRank !== null && r.toRank !== null && r.toRank < r.fromRank;
  return false;
}

export interface Pair {
  preferred: TermVector;
  over: TermVector;
}

export function pairsOf(r: FeedbackRowLike): Pair[] {
  const from = r.snapshot.item.rank ?? r.fromRank;
  if (from === null) return [];
  const me = r.snapshot.item.terms;
  if (isPromotion(r)) return r.snapshot.neighbours.filter((n) => n.rank < from && (r.toRank === null || n.rank >= r.toRank)).map((n) => ({ preferred: me, over: n.terms }));
  return r.snapshot.neighbours.filter((n) => n.rank > from).map((n) => ({ preferred: n.terms, over: me }));
}

export interface TermAgreement {
  term: PriorityTerm;
  /** The term favoured what you did first. */
  agree: number;
  /** The term favoured what the model had above it. */
  disagree: number;
  /** agree / (agree + disagree); null with no decisive pairs. */
  rate: number | null;
}

const EPS = 1e-6;

/** Per term: how often it agreed with what you did, over all pairs. */
export function termAgreement(rows: readonly FeedbackRowLike[]): TermAgreement[] {
  const acc = new Map<PriorityTerm, { agree: number; disagree: number }>(PRIORITY_TERMS.map((t) => [t, { agree: 0, disagree: 0 }]));
  for (const r of rows)
    for (const p of pairsOf(r))
      for (const t of PRIORITY_TERMS) {
        const a = p.preferred[t];
        const b = p.over[t];
        if (a === undefined || b === undefined) continue;
        if (a > b + EPS) acc.get(t)!.agree++;
        else if (b > a + EPS) acc.get(t)!.disagree++;
      }
  return PRIORITY_TERMS.map((t) => {
    const c = acc.get(t)!;
    const n = c.agree + c.disagree;
    return { term: t, agree: c.agree, disagree: c.disagree, rate: n ? Math.round((c.agree / n) * 100) / 100 : null };
  });
}

const TERM_PHRASE: Record<PriorityTerm, string> = {
  who: 'work for senior people',
  deal: 'bigger deals',
  kind: 'customer-facing work',
  importance: 'items marked important',
  goal: 'pay-linked admin',
  urgency: 'the most urgent work',
};

export interface RuleSuggestion {
  /** Stable for the same finding (so the nightly job doesn't stack duplicates). */
  key: string;
  term: PriorityTerm;
  /** The term your choices kept agreeing with (for the sentence), when one stands out. */
  counterTerm: PriorityTerm | null;
  text: string;
  nudge: { target: NudgeTarget; direction: 1 | -1 };
  /** Decisive pairs behind it. */
  pairs: number;
  disagree: number;
}

/**
 * The one suggestion worth a Health line: the term that disagreed most often (at least `minPairs` decisive pairs and
 * an agreement rate at or below `maxRate`). A value term is nudged down one step; urgency raises the urgency floor
 * one step (value counts more against urgency). Null when nothing stands out.
 */
export function suggestRule(agreement: readonly TermAgreement[], o: { minPairs?: number; maxRate?: number } = {}): RuleSuggestion | null {
  const minPairs = o.minPairs ?? 6;
  const maxRate = o.maxRate ?? 0.35;
  const decisive = agreement.filter((a) => a.rate !== null && a.agree + a.disagree >= minPairs);
  const worst = [...decisive].sort((a, b) => a.rate! - b.rate! || b.disagree - a.disagree || a.term.localeCompare(b.term))[0];
  if (!worst || worst.rate! > maxRate) return null;
  const counter = [...decisive].filter((a) => a.term !== worst.term && a.rate! >= 1 - maxRate).sort((a, b) => b.rate! - a.rate! || b.agree - a.agree)[0] ?? null;
  const n = worst.agree + worst.disagree;
  const them = counter ? TERM_PHRASE[counter.term] : 'other work';
  const text = `The model keeps ranking ${TERM_PHRASE[worst.term]} above ${them}; you keep doing ${them} first (${worst.disagree} of ${n} times).`;
  const nudge = worst.term === 'urgency' ? ({ target: 'urgencyFloor', direction: 1 } as const) : ({ target: worst.term, direction: -1 } as const);
  return { key: `${worst.term}:${nudge.direction}`, term: worst.term, counterTerm: counter?.term ?? null, text, nudge, pairs: n, disagree: worst.disagree };
}
