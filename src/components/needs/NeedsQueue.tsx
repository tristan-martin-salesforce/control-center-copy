'use client';
/**
 * The Needs-you block: the one queue (GET /needs) as kit QueueSections of ActionRows, the surface Home and Activity
 * mount (01 R1, D-86). `kinds` filters it to a page's slice (Activity: time, DCs, VDP, use cases); `grouped` draws one
 * section per group key (Today · This week · Deals · Admin), else one "Needs you" section with the group as a chip.
 *
 *   Needs you  12   Today 3 · This week 5 · Admin 4                       [Review 7]
 *   ▌ Accept · Send Hooli the pricing calculator ······················ Acme · ~15 min
 *   ▌ [To confirm] ✦ AI ↗ Slack · Possible promise at the onsite ··············  Accept
 *   See all 12 →
 *
 * A decided row leaves at once (optimistic) and Undo on the toast brings it back. Enter opens the row's Details (a work
 * item, a draft, a VDP) or its page; `a` / ⌘↵ the primary verb; `n` / `x` its dismiss; `s` Later; j / k move.
 * "Review N" opens drain mode (ReviewQueue) over the same rows. The count in the header is the queue's: the sidebar's.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { NeedKind, NeedRow } from '@/contract';
import { QueueSection } from '@/components/kit';
import { useRightPanel } from '@/components/shell/panel';
import { navigate } from '@/components/shell/router';
import { Button, PanelError } from '@/ui';
import { GROUP_LABEL, GROUP_ORDER, hrefOf, panelEntityOf, reviewableNeeds, rowsOfKinds } from './model';
import { NeedActionRow } from './NeedActionRow';
import { NeedsReview } from './NeedsReview';
import { useNeedActions, useNeeds } from './useNeeds';

export interface NeedsQueueProps {
  /** Section title when not grouped ("Needs you"). */
  title?: string;
  /** A page's slice; null: every kind. */
  kinds?: readonly NeedKind[] | null;
  /** One section per group key. */
  grouped?: boolean;
  /** Rows shown per section before "See all". */
  cap?: number;
  /** Rendered when nothing waits (null: the block disappears). */
  empty?: ReactNode;
  /** Where the block sits ("home", "activity"): test ids and the reset key. */
  surface: string;
  className?: string;
}

export function NeedsQueue({ title = 'Needs you', kinds = null, grouped = false, cap = 3, empty = null, surface, className }: NeedsQueueProps) {
  const q = useNeeds();
  const { run } = useNeedActions();
  const panel = useRightPanel();
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const rows = useMemo(() => rowsOfKinds(q.data?.rows, kinds), [q.data?.rows, kinds]);
  const reviewable = useMemo(() => reviewableNeeds(rows ?? []), [rows]);

  const open = useCallback(
    (row: NeedRow, mode: 'details' | 'page') => {
      setSelected(row.id);
      const e = panelEntityOf(row);
      if (e && mode === 'details') return panel.openDetails(e);
      const href = hrefOf(row);
      if (href) navigate(href);
    },
    [panel],
  );

  if (q.isError && !q.data) return <PanelError title="Needs you couldn’t load" error={q.error} onRetry={() => void q.refetch()} compact />;
  if (!rows) return null;
  if (reviewing)
    return (
      <div className="fixed inset-0 z-40 bg-bg p-6" data-testid={`needs-review-${surface}`}>
        <NeedsReview rows={rows} onExit={() => setReviewing(false)} onEdit={(row) => open(row, 'details')} />
      </div>
    );

  const reviewBtn = reviewable.length ? (
    <Button variant="secondary" size="sm" onClick={() => setReviewing(true)} data-testid="needs-review-open" title="One at a time: a do it · s later · x set aside · z undo">
      Review {reviewable.length}
    </Button>
  ) : null;
  const row = (r: NeedRow, ctx: Parameters<Parameters<typeof QueueSection<NeedRow>>[0]['renderRow']>[1], showGroup: boolean) => (
    <NeedActionRow key={r.id} row={r} ctx={ctx} onRun={run} onOpen={open} onSelect={setSelected} showGroup={showGroup ? GROUP_LABEL[r.groupKey] : null} />
  );
  const partial = q.data?.partial.length ? <span className="text-caption text-muted">Some sources could not be read; their rows are missing for now.</span> : null;

  if (!grouped) {
    const by = GROUP_ORDER.map((g) => [g, rows.filter((r) => r.groupKey === g).length] as const).filter(([, n]) => n > 0);
    return (
      <div className={className} data-testid={`needs-${surface}`} data-needs-total={rows.length}>
        <QueueSection<NeedRow>
          id={`needs-${surface}`}
          title={title}
          sub={by.map(([g, n]) => `${GROUP_LABEL[g]} ${n}`).join(' · ')}
          items={rows}
          resetKey={`needs:${surface}`}
          cap={cap}
          selectedId={selected}
          onSelectedChange={setSelected}
          action={reviewBtn}
          empty={empty}
          renderRow={(r, ctx) => row(r, ctx, true)}
        />
        {partial}
      </div>
    );
  }
  const groups = GROUP_ORDER.map((g) => ({ g, items: rows.filter((r) => r.groupKey === g) })).filter((x) => x.items.length);
  if (!groups.length) return empty ? <div className={className}>{empty}</div> : null;
  return (
    <div className={className} data-testid={`needs-${surface}`} data-needs-total={rows.length}>
      {groups.map(({ g, items }, i) => (
        <QueueSection<NeedRow>
          key={g}
          id={`needs-${surface}-${g}`}
          title={GROUP_LABEL[g]}
          items={items}
          resetKey={`needs:${surface}:${g}`}
          cap={cap}
          selectedId={selected}
          onSelectedChange={setSelected}
          action={i === 0 ? reviewBtn : undefined}
          renderRow={(r, ctx) => row(r, ctx, false)}
        />
      ))}
      {partial}
    </div>
  );
}
