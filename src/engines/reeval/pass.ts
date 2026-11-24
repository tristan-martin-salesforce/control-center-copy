/**
 * One re-evaluation pass over an item (R-UI-20 "save first, then re-evaluate"): the new signals since the
 * last evaluation go through the closure machine in order, each against the item as the previous one left
 * it, and the planner says which downstream steps re-run. Pure; the data layer writes `steps` in one
 * `engine:reeval` change set and enqueues `followUps`.
 *
 *   progress, then "done" (Sure)      → open → in_progress → done (two transitions, one change set)
 *   "done" twice                       → done, then "Already done" (attached only)
 *   user-locked status + "done"        → a proposal; the item doesn't move, so the next signal sees it unchanged
 *   requirement on a done item         → reopen (≤ window) or a sibling; the original stays as it was
 */
import { applyDecision } from '@/engines/closure/apply';
import { applySignal } from '@/engines/closure/machine';
import { changeKindOf } from '@/engines/closure/signals';
import type { ClosureDecision } from '@/engines/closure/types';
import type { ChangeKind, ClosureItem, ClosureSettings, Signal, WorkItemStatus } from '@/engines/types';
import { LIVE_STATUSES } from '@/engines/types';

import { planReeval, pruneAfterStatus, type PlannerItem, type ReevalPlan } from './planner';

export interface ReevalPassInput {
  item: ClosureItem;
  /** In the order they happened. */
  signals: Signal[];
  settings: ClosureSettings;
  /** The item's NBA draft state (planner input). */
  draft: { hasDraft: boolean; draftUserLocked: boolean };
}

export interface PassStep {
  signal: Signal;
  decision: ClosureDecision;
  /** The item the decision was made against, and after it was applied (unchanged for proposal, sibling, none). */
  before: ClosureItem;
  after: ClosureItem;
}

export interface FollowUp {
  kind: 'nba.generate';
  /** `sibling:<n>` = the sibling created by step n (the data layer substitutes the new id). */
  target: { workItemId: string } | { siblingOfStep: number };
  /** `regenerate` for a live item; `retire` when the item is no longer live (its NBA is completed or superseded). */
  mode: 'regenerate' | 'retire';
  reason: string;
}

export interface ReevalPass {
  steps: PassStep[];
  final: ClosureItem;
  changes: ChangeKind[];
  plan: ReevalPlan;
  /** Some step writes rows (transition, update, proposal or sibling). */
  writes: boolean;
  /** The item's own status moved. */
  transitioned: boolean;
  followUps: FollowUp[];
  /** One line for the change set summary: the last decision that wrote something. */
  summary: string;
}

const isLive = (s: WorkItemStatus) => LIVE_STATUSES.includes(s);

const plannerItem = (i: ClosureItem, draft: ReevalPassInput['draft']): PlannerItem => ({
  status: i.status,
  ...(i.resolution !== undefined ? { resolution: i.resolution } : {}),
  ...(i.involvement !== undefined ? { involvement: i.involvement } : {}),
  hasDraft: draft.hasDraft,
  draftUserLocked: draft.draftUserLocked,
});

export function runReevalPass(input: ReevalPassInput): ReevalPass {
  const steps: PassStep[] = [];
  let cur = input.item;
  for (const signal of input.signals) {
    const decision = applySignal(cur, signal, input.settings);
    const after = decision.kind === 'transition' || decision.kind === 'update' ? applyDecision(cur, decision).item : cur;
    steps.push({ signal, decision, before: cur, after });
    cur = after;
  }
  const changes = [...new Set(input.signals.map(changeKindOf))];
  const planned = planReeval(changes, plannerItem(input.item, input.draft));
  const plan = pruneAfterStatus(planned, input.item.status, cur.status, plannerItem(cur, input.draft));

  const writing = steps.filter((s) => s.decision.kind !== 'none');
  const itemMoved = steps.some((s) => s.decision.kind === 'transition' || s.decision.kind === 'update');
  const followUps: FollowUp[] = [];
  if (itemMoved) {
    const live = isLive(cur.status);
    followUps.push({
      kind: 'nba.generate',
      target: { workItemId: input.item.id },
      mode: live ? 'regenerate' : 'retire',
      reason: writing[writing.length - 1]!.decision.reason,
    });
  }
  steps.forEach((s, i) => {
    if (s.decision.kind === 'sibling') followUps.push({ kind: 'nba.generate', target: { siblingOfStep: i }, mode: 'regenerate', reason: s.decision.reason });
  });
  return {
    steps,
    final: cur,
    changes,
    plan,
    writes: writing.length > 0,
    transitioned: steps.some((s) => s.decision.kind === 'transition'),
    followUps,
    summary: writing.length ? writing[writing.length - 1]!.decision.reason : steps.length ? steps[steps.length - 1]!.decision.reason : 'Nothing new',
  };
}
