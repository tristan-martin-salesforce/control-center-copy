'use client';
/**
 * Triage in drain mode (02-ui-research P1, P3, P10, P11): "Review" on the page opens the kit's ReviewQueue over the
 * guesses to confirm (asks and promises, meeting takeaways, old asks), one card at a time, with Triage's own verbs:
 *
 *   a  Accept     POST /triage/:id/accept (it becomes a task; on an old ask: Keep)
 *   s  Later      POST /triage/:id/dismiss { reason: 'later' } (the dismiss dialog's own "Later")
 *   x  Not mine   POST /triage/:id/dismiss { reason: 'not_mine' }
 *   e  Edit       the item in the docked Details panel
 *   "Accept all sure (N)" is one batch after one confirm that lists them.
 *
 * Every verb answers with an audit id; the open batch's Undo reverts exactly those (POST /audit/:id/undo). Looks done,
 * mapping questions and missed opps stay in the list: each needs its own kind of answer (confirm, a choice, a claim).
 * Nothing leaves the machine from here: these are local decisions (*Nothing leaves without approval*).
 */
import { useMemo, useRef } from 'react';
import type { TriageItem } from '@/contract';
import { api } from '@/client/api';
import { hm, openInLabel, originSource } from '@/components/domain';
import { ReviewQueue, TintChip, type ReviewAdapter } from '@/components/kit';
import { ConfidenceWord, Icon, type ConfidenceValue } from '@/ui';

const DRAIN_GROUPS = new Set(['asks_promises', 'meeting_takeaways', 'still_needed']);

/** The guesses the drain walks, in the page's order: suggestions only (see the header). */
export function reviewableGuesses(items: readonly TriageItem[]): TriageItem[] {
  return items.filter((i) => i.kind === 'work_item' && !!i.workItem && DRAIN_GROUPS.has(i.group));
}

export interface TriageAdapterDeps {
  accept: (id: string) => Promise<{ auditId: string | null }>;
  dismiss: (id: string, reason: 'later' | 'not_mine') => Promise<{ auditId: string | null }>;
  undoAudit: (auditId: string) => Promise<unknown>;
  edit: (id: string) => void;
  refetch: () => void;
}

/** Triage's verbs as a ReviewQueue adapter (pure wiring, unit-tested). */
export function triageAdapter(deps: TriageAdapterDeps, audits: Map<string, string>): ReviewAdapter<TriageItem> {
  const keep = (id: string) => (r: { auditId: string | null }) => {
    if (r.auditId) audits.set(id, r.auditId);
    deps.refetch();
  };
  return {
    approve: (it) => deps.accept(it.id).then(keep(it.id)),
    snooze: (it) => deps.dismiss(it.id, 'later').then(keep(it.id)),
    dismiss: (it) => deps.dismiss(it.id, 'not_mine').then(keep(it.id)),
    edit: (it) => deps.edit(it.id),
    undo: async ({ items }) => {
      const ids = items.map((i) => audits.get(i.id)).filter((x): x is string => !!x);
      await Promise.all(ids.map((id) => deps.undoAudit(id)));
      for (const i of items) audits.delete(i.id);
      deps.refetch();
    },
    labels: { approve: 'Accept', snooze: 'Later', dismiss: 'Not mine' },
    past: { approve: 'Accepted', snooze: 'Put off', dismiss: 'Not mine' },
  };
}

const confidenceOf = (v: string | null | undefined): ConfidenceValue | undefined => (v === 'sure' || v === 'likely' || v === 'guess' ? v : undefined);

export function TriageReview({ items, onEdit, onExit, refetch }: { items: readonly TriageItem[]; onEdit: (id: string) => void; onExit: () => void; refetch: () => void }) {
  const guesses = useMemo(() => reviewableGuesses(items), [items]);
  const audits = useRef(new Map<string, string>()).current;
  const adapter = useMemo(
    () =>
      triageAdapter(
        {
          accept: (id) => api('acceptTriage', { params: { id }, body: {} }),
          dismiss: (id, reason) => api('dismissTriage', { params: { id }, body: { reason } }),
          undoAudit: (id) => api('undoAudit', { params: { id }, body: {} }),
          edit: onEdit,
          refetch,
        },
        audits,
      ),
    [onEdit, refetch, audits],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="triage-review">
      <ReviewQueue
        title="Review guesses"
        items={guesses}
        adapter={adapter}
        onExit={onExit}
        bulk={{ label: 'Accept all sure', filter: (it) => it.workItem?.confidence === 'sure', describe: (it) => it.title }}
        renderCard={(it) => <GuessCard item={it} />}
      />
    </div>
  );
}

function GuessCard({ item }: { item: TriageItem }) {
  const w = item.workItem!;
  const src = originSource(w.sources);
  const conf = confidenceOf(w.confidence);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="review-guess" data-item-id={item.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {conf ? <ConfidenceWord value={conf} /> : null}
        <TintChip tint="ai" />
        <span className="text-caption text-muted">{item.group === 'still_needed' ? 'An ask over 30 days old when it was found' : item.group === 'meeting_takeaways' ? 'From meeting notes' : 'Someone may be waiting on you'}</span>
      </div>
      <h2 className="text-title font-bold text-fg-heading">{w.title}</h2>
      {w.why ? <p className="max-w-[68ch] text-body text-fg">{w.why}</p> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-body text-muted">
        {w.sources[0] ? <span className="min-w-0 truncate">{w.sources[0].label}</span> : null}
        <span className="tabular-nums">you ~{hm(w.effort.youMin)}</span>
        {src ? (
          <a href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-sm font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
            <Icon name="new_window" size="xs" />
            {openInLabel(src.kind)}
          </a>
        ) : null}
      </div>
    </div>
  );
}
