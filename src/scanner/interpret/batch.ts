/**
 * Batching by token budget, not by a fixed count (review 04 §4.1 #3). A batch fills until the next item's rendered
 * entry would pass the input budget, or its verdict would pass the output budget. A conversation's items stay in one
 * batch when they fit, so the model reads them together; a conversation larger than a batch is cut between items.
 * Tokens are estimated conservatively (2.5 characters a token, the runner's prompt-guard rate), so a batch errs small.
 */
import { estimateTokens } from '@/llm/usage';

import { renderItem } from './render';
import type { InterpretItem } from './types';

export interface BatchBudget {
  /** Rendered item entries per call (the cached system prefix is not counted: it is the same for every call). */
  inputTokens: number;
  /** The reply: verdict JSON for every item. */
  outputTokens: number;
}

/** About what one verdict object costs to write (title, cite and why included). */
export const OUTPUT_TOKENS_PER_VERDICT = 90;
/** The reply's fixed part (`{"verdicts":[…]}` and slack). */
export const OUTPUT_OVERHEAD_TOKENS = 60;

/** Live polls: small, quick calls. First scan and catch-ups: large batches (fewer calls, one cached prefix). */
export const LIVE_BUDGET: BatchBudget = { inputTokens: 6_000, outputTokens: 2_500 };
export const BACKFILL_BUDGET: BatchBudget = { inputTokens: 16_000, outputTokens: 6_000 };

export const itemTokens = (x: InterpretItem, wide = false) => estimateTokens(renderItem(x, { wide }).length + 2);

/** The max_tokens a call over `n` items asks for. */
export const replyTokensFor = (n: number) => OUTPUT_OVERHEAD_TOKENS + n * OUTPUT_TOKENS_PER_VERDICT;

export function packBatches(items: InterpretItem[], budget: BatchBudget, o: { wide?: boolean } = {}): InterpretItem[][] {
  const maxPerBatch = Math.max(1, Math.floor((budget.outputTokens - OUTPUT_OVERHEAD_TOKENS) / OUTPUT_TOKENS_PER_VERDICT));
  // conversations in first-appearance order, items in their own order
  const groups = new Map<string, InterpretItem[]>();
  for (const x of items) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);
  const out: InterpretItem[][] = [];
  let cur: InterpretItem[] = [];
  let curTok = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    curTok = 0;
  };
  for (const g of groups.values()) {
    const sizes = g.map((x) => itemTokens(x, o.wide));
    const total = sizes.reduce((a, b) => a + b, 0);
    // a conversation that fits a fresh batch but not this one starts a new batch rather than being cut
    if (cur.length && (curTok + total > budget.inputTokens || cur.length + g.length > maxPerBatch) && total <= budget.inputTokens && g.length <= maxPerBatch) flush();
    g.forEach((x, i) => {
      if (cur.length && (curTok + sizes[i]! > budget.inputTokens || cur.length + 1 > maxPerBatch)) flush();
      cur.push(x);
      curTok += sizes[i]!;
    });
  }
  flush();
  return out;
}
