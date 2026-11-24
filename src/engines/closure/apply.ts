/**
 * Pure apply/undo for closure decisions. The data layer does the same inside one change set and
 * undoes it with an `undo` change set (DATA-MODEL §1.3); these mirror it for the mock store and tests.
 */
import type { ClosureItem } from '@/engines/types';
import type { ClosureDecision, SiblingSpec } from './types';

export interface Applied {
  item: ClosureItem;
  /** The sibling to insert, when the decision created one. */
  created: SiblingSpec | null;
}

export function applyDecision(item: ClosureItem, d: ClosureDecision): Applied {
  const next: Record<string, unknown> = { ...item };
  if (d.transition) next.status = d.transition.to;
  for (const c of d.fieldChanges) next[c.field] = c.after;
  return { item: next as unknown as ClosureItem, created: d.sibling };
}

/** Restores the item exactly as it was before `applyDecision` (and drops the sibling). */
export function undoDecision(applied: ClosureItem, d: ClosureDecision): ClosureItem {
  const prev: Record<string, unknown> = { ...applied };
  for (const c of [...d.fieldChanges].reverse()) {
    if (c.before === undefined) delete prev[c.field];
    else prev[c.field] = c.before;
  }
  if (d.transition) prev.status = d.transition.from;
  return prev as unknown as ClosureItem;
}

const STATE_CODE: Record<string, string> = {
  suggested: 'sug',
  open: 'open',
  in_progress: 'ip',
  waiting_on_others: 'woo',
  waiting_on_me: 'wom',
  likely_done: 'ld',
  done: 'done',
  snoozed: 'snz',
  dismissed: 'dis',
  merged: 'mrg',
};

/**
 * A compact code for the transition table (docs/reference/ENGINES.md §3):
 * `·` nothing · `ctx` context only · `upd` fields only · `prop` proposal · `sib` sibling ·
 * `reopen` done/dismissed → open · `wake` snoozed → previous · otherwise the target state.
 */
export function describeDecision(d: ClosureDecision): string {
  switch (d.kind) {
    case 'none':
      return d.recordAs === 'context' ? 'ctx' : '·';
    case 'update':
      return 'upd';
    case 'proposal':
      return 'prop';
    case 'sibling':
      return 'sib';
    case 'transition': {
      const t = d.transition!;
      if ((t.from === 'done' || t.from === 'dismissed') && t.to === 'open') return 'reopen';
      if (t.from === 'snoozed') return 'wake';
      return STATE_CODE[t.to] ?? t.to;
    }
  }
}
