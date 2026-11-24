'use client';
/**
 * Home's "Needs you" block: the one queue (GET /needs, D-86) grouped by its group key, Today first.
 *
 *   Needs you 12 · Today 3 · This week 5 · Deals 2 · Admin 2                            [Review 7]
 *   Today 3: the first three rows, expanded (kit QueueSection of NeedActionRows; See all grows it in place)
 *   ▸ This week 5   ▸ Deals 2   ▸ Admin 2           (collapsed; a click opens that group in place)
 *
 * The header's number is the queue's total, the same one the sidebar shows (needsCount). "Review N" opens drain mode
 * (NeedsReview) over the rows decided here. A decided row leaves at once and the toast offers Undo (useNeedActions).
 */
import { useCallback, useMemo, useState } from 'react';
import type { NeedGroupKey, NeedRow } from '@/contract';
import { QueueSection } from '@/components/kit';
import { GROUP_LABEL, GROUP_ORDER, hrefOf, panelEntityOf, reviewableNeeds } from '@/components/needs/model';
import { NeedActionRow } from '@/components/needs/NeedActionRow';
import { NeedsReview } from '@/components/needs/NeedsReview';
import { useNeedActions, useNeeds } from '@/components/needs/useNeeds';
import { useRightPanel } from '@/components/shell/panel';
import { navigate } from '@/components/shell/router';
import { Button, cn, PanelError } from '@/ui';

/** Rows of the first group shown expanded. */
export const HOME_NEEDS_OPEN = 3;

export interface NeedGroup {
  key: NeedGroupKey;
  label: string;
  rows: NeedRow[];
}

/** Pure: the queue in its groups (Today · This week · Deals · Admin), empty groups left out, the queue's order kept. */
export function groupNeeds(rows: readonly NeedRow[]): NeedGroup[] {
  return GROUP_ORDER.map((key) => ({ key, label: GROUP_LABEL[key], rows: rows.filter((r) => r.groupKey === key) })).filter((g) => g.rows.length > 0);
}

/** "Today 3 · This week 5 · Admin 4": the header's group counts. */
export function groupCountsLine(groups: readonly NeedGroup[]): string {
  return groups.map((g) => `${g.label} ${g.rows.length}`).join(' · ');
}

export function HomeNeeds({ className }: { className?: string }) {
  const q = useNeeds();
  const { run } = useNeedActions();
  const panel = useRightPanel();
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  // the first group is open; a click on a collapsed group opens it too (and keeps the others as they are)
  const [opened, setOpened] = useState<ReadonlySet<NeedGroupKey>>(new Set());
  const rows = q.data?.rows;
  const groups = useMemo(() => groupNeeds(rows ?? []), [rows]);
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
      <div className="fixed inset-0 z-40 bg-bg p-6" data-testid="needs-review-home">
        <NeedsReview rows={rows} onExit={() => setReviewing(false)} onEdit={(row) => open(row, 'details')} />
      </div>
    );

  const total = q.data?.total ?? rows.length;
  const first = groups[0]?.key ?? null;
  const isOpen = (g: NeedGroupKey) => g === first || opened.has(g);
  const toggle = (g: NeedGroupKey) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  return (
    <section className={cn('flex min-w-0 flex-col gap-1', className)} aria-labelledby="hm-needs" data-testid="needs-home" data-needs-total={total}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="hm-needs" className="text-body font-bold text-fg-heading">
          Needs you <span className="font-normal text-muted tabular-nums" data-testid="home-needs-count">{total}</span>
        </h2>
        {groups.length ? <span className="min-w-0 truncate text-caption text-muted" data-testid="home-needs-groups">{groupCountsLine(groups)}</span> : null}
        {reviewable.length ? (
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setReviewing(true)} data-testid="needs-review-open" title="One at a time: a do it · s later · x set aside · z undo">
            Review {reviewable.length}
          </Button>
        ) : null}
      </div>
      {!total ? <p className="text-caption text-muted">Nothing waits on you: no guesses to confirm, drafts to review or time to log.</p> : null}
      {groups
        .filter((g) => isOpen(g.key))
        .map((g) => (
          <QueueSection<NeedRow>
            key={g.key}
            id={`needs-home-${g.key}`}
            title={g.label}
            items={g.rows}
            resetKey={`needs:home:${g.key}`}
            cap={HOME_NEEDS_OPEN}
            selectedId={selected}
            onSelectedChange={setSelected}
            action={
              g.key !== first ? (
                <button type="button" className="text-caption text-muted hover:underline" onClick={() => toggle(g.key)}>
                  Fold
                </button>
              ) : undefined
            }
            renderRow={(r, ctx) => <NeedActionRow key={r.id} row={r} ctx={ctx} onRun={run} onOpen={open} onSelect={setSelected} showGroup={null} />}
          />
        ))}
      {groups.some((g) => !isOpen(g.key)) ? (
        <div className="flex flex-wrap gap-2" data-testid="home-needs-collapsed">
          {groups
            .filter((g) => !isOpen(g.key))
            .map((g) => (
              <button key={g.key} type="button" className="rounded-md border border-line bg-surface px-2 py-0.5 text-caption text-fg hover:bg-surface-muted" aria-expanded={false} onClick={() => toggle(g.key)} data-group={g.key}>
                <span aria-hidden className="text-faint">
                  ▸{' '}
                </span>
                {g.label} <span className="text-muted tabular-nums">{g.rows.length}</span>
              </button>
            ))}
        </div>
      ) : null}
      {q.data?.partial.length ? <span className="text-caption text-muted">Some sources could not be read; their rows are missing for now.</span> : null}
    </section>
  );
}
