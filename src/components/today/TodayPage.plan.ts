/**
 * Today ▸ the agent's plan rail: Accept all and Undo / Redo per change (split out of TodayPage.tsx; behaviour as before).
 * Slots are the local plan; proposals and re-ranks go through useTodayActions and come back with an audit id for Undo.
 */
import { useCallback, useState } from 'react';
import type { WorkItem } from '@/contract';
import { toast } from '@/client/toast';
import type { AgentPlanState, PlanChange } from './plan';
import type { TodayActions } from './useTodayActions';

export interface AgentPlanActionsIn {
  changes: PlanChange[];
  excluded: ReadonlySet<string>;
  agentPlan: AgentPlanState;
  setAgentPlan: (next: AgentPlanState) => void;
  /** Writes the saved plan as is (the async audit ids land after setAgentPlan already ran). */
  setAgentSaved: (next: AgentPlanState) => void;
  dayKey: string;
  items: ReadonlyMap<string, WorkItem>;
  pullIn: (item: WorkItem) => Promise<string | null>;
  actions: TodayActions;
  now: string;
}

export function useAgentPlanActions({ changes, excluded, agentPlan, setAgentPlan, setAgentSaved, dayKey, items, pullIn, actions, now }: AgentPlanActionsIn) {
  const [accepting, setAccepting] = useState(false);
  const acceptAll = useCallback(async () => {
    const live = changes.filter((c) => !excluded.has(c.id));
    if (!live.length || agentPlan.acceptedAt || accepting) return;
    setAccepting(true);
    const before = agentPlan;
    const audits: Record<string, string> = { ...agentPlan.audits };
    for (const c of live) {
      if (c.proposal) {
        const id = await actions.applyProposalAsync(c.proposal);
        if (id) audits[c.id] = id;
      } else if (c.kind === 'rerank') {
        const id = await actions.rerankAsync();
        if (id) audits[c.id] = id;
      }
    }
    setAgentPlan({ ...agentPlan, acceptedAt: now, audits });
    setAccepting(false);
    toast({
      key: 'today:plan',
      title: `Accepted the plan · ${live.length} change${live.length === 1 ? '' : 's'}`,
      body: 'Slots are your local plan; your calendar is unchanged.',
      undo: {
        run: () => {
          for (const [cid, aid] of Object.entries(audits)) if (!before.audits[cid]) actions.undoAudit(aid, changes.find((c) => c.id === cid)?.title ?? 'plan change');
          setAgentPlan(before);
        },
      },
    });
  }, [changes, excluded, agentPlan, accepting, actions, setAgentPlan, now]);

  const toggleChange = useCallback(
    (c: PlanChange) => {
      const off = excluded.has(c.id);
      const nextExcluded = off ? agentPlan.excluded.filter((x) => x !== c.id) : [...agentPlan.excluded, c.id];
      const audits = { ...agentPlan.audits };
      if (c.kind === 'deferred' && c.itemId) {
        const it = items.get(c.itemId);
        // Undo a deferral = keep it today (start-by today); Redo = undo that change through its audit.
        if (!off && it) {
          void pullIn(it).then((id) => id && setAgentSaved({ ...agentPlan, excluded: nextExcluded, audits: { ...agentPlan.audits, [c.id]: id }, day: dayKey }));
          setAgentPlan({ ...agentPlan, excluded: nextExcluded });
          return;
        }
        if (off && audits[c.id]) {
          actions.undoAudit(audits[c.id]!, c.title);
          delete audits[c.id];
        }
        setAgentPlan({ ...agentPlan, excluded: nextExcluded, audits });
        return;
      }
      if (agentPlan.acceptedAt) {
        if (!off && audits[c.id]) {
          actions.undoAudit(audits[c.id]!, c.title);
          delete audits[c.id];
        } else if (off && c.proposal) {
          void actions.applyProposalAsync(c.proposal).then((id) => id && setAgentSaved({ ...agentPlan, excluded: nextExcluded, audits: { ...audits, [c.id]: id }, day: dayKey }));
        } else if (off && c.kind === 'rerank') {
          void actions.rerankAsync().then((id) => id && setAgentSaved({ ...agentPlan, excluded: nextExcluded, audits: { ...audits, [c.id]: id }, day: dayKey }));
        }
      }
      setAgentPlan({ ...agentPlan, excluded: nextExcluded, audits });
    },
    [excluded, agentPlan, items, pullIn, actions, setAgentPlan, setAgentSaved, dayKey],
  );

  return { accepting, acceptAll, toggleChange };
}
