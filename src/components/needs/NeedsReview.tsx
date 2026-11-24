'use client';
/**
 * Needs you in drain mode: the kit's ReviewQueue over the same rows, one card at a time. `a` runs the row's primary
 * verb, `s` its Later, `x` its dismiss (Not mine, Reject, Not done, Close, Stop), each through POST /needs/:id/decide,
 * so a card decided here is the page's own decision. Rows whose primary verb is a page of its own (Review in the
 * Outbox, a choice to pick) stay in the list. The open batch's Undo reverts exactly its audit ids.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import type { NeedRow, NeedVerb } from '@/contract';
import { api } from '@/client/api';
import { ReviewQueue, TintChip, type ReviewAdapter } from '@/components/kit';
import { ConfidenceWord, Icon } from '@/ui';
import { estimateText, isAiKind, KIND_LABEL, reviewableNeeds, reviewVerbs } from './model';

export interface NeedsAdapterDeps {
  decide: (row: NeedRow, v: NeedVerb) => Promise<{ auditId: string | null }>;
  undoAudit: (auditId: string) => Promise<unknown>;
  refetch: () => void;
  edit?: (row: NeedRow) => void;
}

/** The queue's verbs as a ReviewQueue adapter (pure wiring, unit-tested). */
export function needsAdapter(deps: NeedsAdapterDeps, audits: Map<string, string>): ReviewAdapter<NeedRow> {
  const via = (pick: 'approve' | 'snooze' | 'dismiss') => async (row: NeedRow) => {
    const v = reviewVerbs(row)[pick];
    if (!v) throw new Error(`${row.title} has no ${pick} here`);
    const r = await deps.decide(row, v);
    if (r.auditId) audits.set(row.id, r.auditId);
    deps.refetch();
  };
  return {
    approve: via('approve'),
    snooze: via('snooze'),
    dismiss: via('dismiss'),
    edit: deps.edit,
    undo: async ({ items }) => {
      const ids = items.map((i) => audits.get(i.id)).filter((x): x is string => !!x);
      await Promise.all(ids.map((id) => deps.undoAudit(id)));
      for (const i of items) audits.delete(i.id);
      deps.refetch();
    },
    labels: { approve: 'Do it', snooze: 'Later', dismiss: 'Not this' },
    past: { approve: 'Done', snooze: 'Put off', dismiss: 'Set aside' },
  };
}

export function NeedsReview({ rows, onExit, onEdit }: { rows: readonly NeedRow[]; onExit: () => void; onEdit?: (row: NeedRow) => void }) {
  const qc = useQueryClient();
  const items = useMemo(() => reviewableNeeds(rows), [rows]);
  const audits = useRef(new Map<string, string>()).current;
  const adapter = useMemo(
    () =>
      needsAdapter(
        {
          decide: (row, v) => api('decideNeedRow', { params: { id: row.id }, body: { verb: v.id } }),
          undoAudit: (id) => api('undoAudit', { params: { id }, body: {} }),
          refetch: () => void qc.invalidateQueries({ queryKey: ['home'] }),
          edit: onEdit,
        },
        audits,
      ),
    [qc, audits, onEdit],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="needs-review">
      <ReviewQueue title="Review what needs you" items={items} adapter={adapter} onExit={onExit} renderCard={(row) => <NeedCard row={row} />} />
    </div>
  );
}

function NeedCard({ row }: { row: NeedRow }) {
  const v = reviewVerbs(row);
  const est = estimateText(row.estimateMin);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="review-need" data-item-id={row.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="inline-flex h-5 items-center rounded-sm border border-line bg-surface px-1.5 text-micro font-bold text-fg">{KIND_LABEL[row.kind]}</span>
        {row.confidence ? <ConfidenceWord value={row.confidence} /> : null}
        {isAiKind(row.kind) ? <TintChip tint="ai" /> : null}
        {row.account ? <span className="text-caption text-muted">{row.account.label}</span> : null}
      </div>
      <h2 className="text-title font-bold text-fg-heading">{row.title}</h2>
      {row.why ? <p className="max-w-[68ch] text-body text-fg">{row.why}</p> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-body text-muted">
        {v.approve ? <span>a {v.approve.label}</span> : null}
        {v.dismiss ? <span>x {v.dismiss.label}</span> : null}
        {est ? <span className="tabular-nums">{est}</span> : null}
        {row.source ? (
          <a href={row.source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-sm font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
            <Icon name="new_window" size="xs" />
            {row.source.label}
          </a>
        ) : null}
      </div>
    </div>
  );
}
