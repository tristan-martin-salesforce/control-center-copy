'use client';
/**
 * QueueSection: one verb-named section of rows that wait on you (01-ui-audit R10), wired to the one live-list pattern
 * (docs/UX.md "Live updates", D-73; src/components/lists/live-list.ts over the pure live-merge.ts):
 *
 *   Approve  4   sub line ································ [☐ Select all 4]  [action]
 *   ── N new · Show ──   (arrivals held while you scroll, point or type in the list, or more than 3 at once)
 *   rows (renderRow → usually an ActionRow), capped; the cap grows to keep the selected row in view
 *   See all 12 →  /  Show fewer
 *
 * Stable order: rows on screen never move on a refetch; arrivals enter at their natural place, tinted; rows that left
 * elsewhere fade where they are; yours go at once; the selection moves to its neighbour when its row leaves. j/k move
 * focus between rows. An empty section renders nothing (or `empty`).
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useArrivalHold, useLiveList, useSelectionSurvives, type LiveListOptions, type LiveRowProps, type LiveRowState } from '@/components/lists/live-list';
import { cn, LiveCount, LivePill } from '@/ui';

export interface QueueRowContext {
  selected: boolean;
  /** The live state to pass to ActionRow's `live` (new · leaving · gone). */
  live: LiveRowState | undefined;
  liveTone: 'ai' | undefined;
  /** For rows that are not ActionRows: spread on the row root. */
  rowProps: LiveRowProps;
  /** Ticked for a bulk action (with `select`). */
  checked: boolean;
  toggle: () => void;
}

export interface QueueSectionProps<T extends { id: string }> {
  /** A verb: "Approve", "Confirm", "Log". */
  title: string;
  sub?: ReactNode;
  /** The server's rows in its order; undefined while loading (renders nothing). */
  items: T[] | undefined;
  /** A new list (tab, filter, page): take the server's order as is. */
  resetKey: string;
  renderRow: (item: T, ctx: QueueRowContext) => ReactNode;
  /** Rows shown before "See all". Default 3. */
  cap?: number;
  /** "See all N": navigate (onClick) instead of expanding in place. */
  seeAll?: { onClick: () => void; noun?: string };
  /** Bulk selection: draws "Select all N" and a tick per row. */
  select?: { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void };
  selectedId?: string | null;
  onSelectedChange?: (id: string) => void;
  /** Live-list options (tone 'ai' for AI-made rows, keep = the row open in the panel, burst, place). */
  live?: Omit<LiveListOptions, 'hold'> & { hold?: boolean };
  /** Quiet batch action in the header ("Approve all sure 3"). */
  action?: ReactNode;
  empty?: ReactNode;
  id?: string;
  className?: string;
}

export function QueueSection<T extends { id: string }>(p: QueueSectionProps<T>) {
  const { title, sub, items, resetKey, renderRow, cap = 3, seeAll, select, selectedId = null, onSelectedChange, action, empty, className } = p;
  const auto = useId();
  const sid = p.id ?? auto;
  const listRef = useRef<HTMLDivElement>(null);
  const interacting = useArrivalHold(listRef);
  const { hold: holdOpt, keep, ...liveOpts } = p.live ?? {};
  const live = useLiveList(items, resetKey, { ...liveOpts, keep: keep ?? selectedId, hold: holdOpt ?? interacting });
  const [expanded, setExpanded] = useState(false);

  const idsKey = live.items.filter((r) => !live.isLeaving(r.id)).map((r) => r.id).join('\u0000');
  const ids = useMemo(() => (idsKey ? idsKey.split('\u0000') : []), [idsKey]);
  useSelectionSurvives(ids, selectedId, (id) => onSelectedChange?.(id));

  const total = items?.length ?? 0;
  const at = selectedId ? live.items.findIndex((r) => r.id === selectedId) : -1;
  const limit = expanded ? Infinity : Math.max(cap, at + 1);
  const shown = live.items.slice(0, limit);
  const hidden = live.items.length - shown.length;

  if (!items) return null;
  if (!live.items.length && !live.held.length) return empty ? <section className={className}>{empty}</section> : null;

  const allTicked = !!select && ids.length > 0 && ids.every((id) => select.selected.has(id));
  const someTicked = !!select && ids.some((id) => select.selected.has(id));
  const toggle = (id: string) => {
    if (!select) return;
    const next = new Set(select.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    select.onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = ({ j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!dir || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (!target.matches('[data-row]')) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-row]:not([aria-hidden="true"])'));
    const next = rows[rows.indexOf(target) + dir];
    if (!next) return;
    e.preventDefault();
    next.focus();
    const nid = next.getAttribute('data-item-id');
    if (nid) onSelectedChange?.(nid);
  };

  return (
    <section aria-labelledby={`${sid}-h`} data-queue-section={sid} className={cn('min-w-0 py-4', className)}>
      <div className="flex min-w-0 items-baseline gap-2 pb-1">
        <h2 id={`${sid}-h`} className="flex-none truncate text-lead font-bold text-fg-heading" title={title}>
          {title}
        </h2>
        <span className="flex-none text-body text-muted tabular-nums" data-testid="queue-count">
          <LiveCount value={total} />
        </span>
        {sub ? <span className="min-w-0 truncate text-caption text-muted">{sub}</span> : null}
        <span className="ml-auto flex flex-none items-center gap-2">
          {select ? (
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-caption font-bold text-link hover:bg-surface-muted">
              <input
                type="checkbox"
                checked={allTicked}
                ref={(el) => {
                  if (el) el.indeterminate = someTicked && !allTicked;
                }}
                onChange={() => select.onChange(allTicked ? new Set() : new Set(ids))}
                data-testid="select-all"
                className="size-4 accent-[var(--color-accent)]"
              />
              Select all {ids.length}
            </label>
          ) : null}
          {action}
        </span>
      </div>
      <div className="relative">
        <LivePill count={live.held.length} onShow={live.showHeld} />
        <div ref={listRef} role="grid" aria-label={title} aria-rowcount={total} onKeyDown={onKeyDown} className="-mx-3 flex flex-col">
          {shown.map((item) =>
            renderRow(item, {
              selected: item.id === selectedId,
              live: live.liveOf(item.id),
              liveTone: p.live?.tone === 'ai' ? 'ai' : undefined,
              rowProps: live.rowProps(item.id),
              checked: !!select?.selected.has(item.id),
              toggle: () => toggle(item.id),
            }),
          )}
        </div>
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => (seeAll ? seeAll.onClick() : setExpanded(true))}
          data-testid="see-all"
          className="mt-1 inline-flex rounded-sm py-1 text-caption font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none"
        >
          See all {total}
          {seeAll?.noun ? ` ${seeAll.noun}` : ''} →
        </button>
      ) : expanded && live.items.length > cap ? (
        <button type="button" onClick={() => setExpanded(false)} data-testid="show-fewer" className="mt-1 inline-flex rounded-sm py-1 text-caption font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
          Show fewer
        </button>
      ) : null}
    </section>
  );
}
