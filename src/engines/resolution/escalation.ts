/**
 * The narrow escalation (lane 03 §4.1 "Escalation to Sonnet", decision H-7 "data-gated escalation"). The stronger model
 * re-judges one item only when ALL of these hold:
 *   1. the cheap verdict would change the item's state (done, not mine, not needed, duplicate, done by another, quiet),
 *      or it contradicts what code computed (a chase after my line but "done"; the asker's ack after my link but
 *      "not done");
 *   2. it is unsure: confidence in [0.5, 0.8), or its citation broke the rules, or that contradiction;
 *   3. the item is worth it: a deal of at least DEAL_USD_WORTH, or an asker of a tier that matters;
 *   4. the data says escalating this reason pays: over the last 14 days at least 20 % of the stronger model's verdicts
 *      on it differed from the cheap one (`escalation_changed_items` on llm_calls). Fewer than MIN_SAMPLES escalations
 *      of a reason: keep escalating, to learn.
 * `still_yours` at good confidence never escalates (before, Settle escalated every one: the cost driver, SCN-7).
 * Pure.
 */
import type { RuleHints } from '@/scanner/resolution/rules';

import { STATE_CHANGING, type EscalationReason, type EscalationStat, type ItemWorth, type ModelVerdict } from './types';

export const ESCALATION_WINDOW_DAYS = 14;
export const ESCALATION_MIN_CHANGED_RATE = 0.2;
export const ESCALATION_MIN_SAMPLES = 10;
export const DEAL_USD_WORTH = 50_000;
export const WORTHY_TIERS: ReadonlySet<string> = new Set(['leader', 'manager', 'customer_exec', 'customer', 'ae']);

/** Why this cheap verdict would go to the stronger model (null: it never would). */
export function escalationReasonFor(v: ModelVerdict, hints: RuleHints): EscalationReason | null {
  if (v.verdict === 'done' && hints.askerChasedAfterMine) return 'hint_conflict';
  if (v.verdict === 'not_done' && hints.askerAckAfterMine && hints.replyHasLinkOrFile) return 'hint_conflict';
  if (!STATE_CHANGING.has(v.verdict)) return null;
  if (!v.valid) return 'invalid_cite';
  if (v.confidence >= 0.5 && v.confidence < 0.8) return 'uncertain';
  return null;
}

export function worthEscalating(w: ItemWorth | undefined): boolean {
  if (!w) return false;
  if ((w.dealUsd ?? 0) >= DEAL_USD_WORTH) return true;
  return !!w.personTier && WORTHY_TIERS.has(w.personTier);
}

/** The data gate: does escalating this reason still change verdicts often enough? */
export function escalationGate(reason: EscalationReason, stats: EscalationStat[] | undefined): { allowed: boolean; rate: number | null; samples: number } {
  const s = stats?.find((x) => x.reason === reason);
  if (!s || s.escalations < ESCALATION_MIN_SAMPLES) return { allowed: true, rate: s && s.escalations ? s.changed / s.escalations : null, samples: s?.escalations ?? 0 };
  const rate = s.changed / s.escalations;
  return { allowed: rate >= ESCALATION_MIN_CHANGED_RATE, rate, samples: s.escalations };
}

/** The whole decision: escalate (with the reason) or not (with why not, for the check's row). */
export function shouldEscalate(v: ModelVerdict, hints: RuleHints, worth: ItemWorth | undefined, stats: EscalationStat[] | undefined, enabled = true): { escalate: boolean; reason: EscalationReason | null; why: string | null } {
  const reason = escalationReasonFor(v, hints);
  if (!reason) return { escalate: false, reason: null, why: null };
  if (!enabled) return { escalate: false, reason, why: 'gated:off' };
  if (!worthEscalating(worth)) return { escalate: false, reason, why: 'gated:not_worth' };
  const g = escalationGate(reason, stats);
  if (!g.allowed) return { escalate: false, reason, why: `gated:rate_${Math.round((g.rate ?? 0) * 100)}pct` };
  return { escalate: true, reason, why: reason };
}
