/**
 * The hook a running Agent SDK query reports to (src/llm/skill-runner.ts): after every model request it reports the
 * query's spend so far; at 'ask' the runner stops at the next turn boundary (before the next tool runs), raises the
 * hand through `ask`, and ends the run `paused_for_spend` so the scanner runtime re-queues it instead of failing it.
 * The gate rides on the run's traversal (or interpret) query; a resumed run continues from the hold's spend so far.
 * Triage and escalation passes keep their own day lines (D6) and are booked on the run.
 */
import type { SpendGovernor } from './governor';
import type { Hold } from './types';

/** The error code of a run that stopped to ask about spend (the runtime re-queues it; never a failure). */
export const PAUSED_FOR_SPEND = 'paused_for_spend';

export interface SpendGate {
  /** Called with one query's cumulative spend after each request: what to do at the next safe point. */
  observe(querySpentUsd: number): 'continue' | 'ask';
  /** A query ended having spent `usd` (its result's total): it joins the run's base. */
  endQuery(usd: number): void;
  /** Raise the hand once; the run then ends paused. */
  ask(o: { pctDone: number | null }): Promise<void>;
  /** The SDK `maxBudgetUsd` of a query: the runaway guard only, never the soft line. */
  ceilingUsd(): number;
  readonly hold: Hold;
}

/** The runaway guard: 4× the hold, at least the caller's own per-run ceiling. */
export const CEILING_FACTOR = 4;

export function holdGate(gov: SpendGovernor, hold: Hold, o: { minCeilingUsd?: number } = {}): SpendGate {
  let base = hold.spentUsd;
  let asked = false;
  return {
    hold,
    observe(q) {
      return asked ? 'ask' : gov.observe(hold, base + Math.max(0, q));
    },
    endQuery(usd) {
      base = Math.round((base + Math.max(0, Number.isFinite(usd) ? usd : 0)) * 1e6) / 1e6;
      if (base > hold.spentUsd) hold.spentUsd = base;
    },
    async ask(a) {
      if (asked) return;
      asked = true;
      await gov.ask(hold, { pctDone: a.pctDone });
    },
    ceilingUsd() {
      return Math.max(o.minCeilingUsd ?? 0, hold.heldUsd * CEILING_FACTOR - base, 0.01);
    },
  };
}
