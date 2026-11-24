'use client';
/**
 * The Briefs list pane (UI-SPEC §12): Watched (channels, searches, people) and My opportunities (one brief per open
 * opp), then the Watches entry that opens the watch manager in the reading pane. Each brief shows unread (the small
 * accent dot and a bold title) and its "worth a look" count as one muted line. Neutral: sources carry no hue.
 */
import type { BriefSummary as BriefSummaryVm } from '@/contract';
import { useClock } from '@/components/domain';
import { dayLabel, sameDay, clock } from '@/components/domain/lib/time';
import { cn, Icon } from '@/ui';

export interface BriefListProps {
  watched: BriefSummaryVm[];
  opportunities: BriefSummaryVm[];
  /** The brief open in the reading pane. */
  openId: string | null;
  /** The keyboard cursor (j/k). */
  cursorId: string | null;
  watchCount: number;
  watchesOpen: boolean;
  onOpen: (b: BriefSummaryVm) => void;
  onManage: () => void;
}

const KIND_ICON: Record<BriefSummaryVm['kind'], string> = { opp: 'opportunity', channel: 'slack', person: 'user', search: 'search', account: 'account' };

function Row({ b, open, cursor, onOpen }: { b: BriefSummaryVm; open: boolean; cursor: boolean; onOpen: (b: BriefSummaryVm) => void }) {
  const { now, tz } = useClock();
  const through = sameDay(b.through, now, tz) ? clock(b.through, tz) : `${dayLabel(b.through, tz)} ${clock(b.through, tz)}`;
  return (
    <div
      role="listitem"
      data-row-id={b.id}
      data-brief-id={b.id}
      aria-current={open || undefined}
      tabIndex={cursor ? 0 : -1}
      onClick={() => onOpen(b)}
      className={cn(
        'relative mx-2 flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]',
        open ? 'bg-selected' : 'hover:bg-surface-muted',
      )}
    >
      <span className={cn('mt-2 size-2 shrink-0 rounded-full', b.unread ? 'bg-accent' : 'bg-transparent')} role={b.unread ? 'img' : undefined} aria-label={b.unread ? 'Unread' : undefined} aria-hidden={b.unread ? undefined : true} />
      <Icon name={KIND_ICON[b.kind] ?? 'search'} size="sm" className="mt-1.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-body', b.unread ? 'font-bold text-fg-heading' : 'text-fg')}>{b.title}</span>
        <span className="block truncate text-caption text-muted tabular-nums">
          {b.status === 'generating' ? <span className="text-ai-700">✦ writing…</span> : b.status === 'failed' ? <span className="text-danger-700">Failed to generate</span> : b.worthALook ? <span className="font-bold text-fg">{b.worthALook} worth a look</span> : 'Nothing stands out'}
          {` · through ${through}`}
        </span>
      </span>
    </div>
  );
}

function Group({ label, items, empty, ...p }: { label: string; items: BriefSummaryVm[]; empty: string } & Pick<BriefListProps, 'openId' | 'cursorId' | 'onOpen'>) {
  const unread = items.filter((b) => b.unread).length;
  return (
    <section aria-label={label} className="pb-2">
      <div className="flex items-baseline gap-2 px-5 pt-3 pb-1">
        <h2 className="text-body-lg font-bold text-fg-heading">{label}</h2>
        <span className="text-body text-muted tabular-nums">{items.length}</span>
        {unread ? <span className="ml-auto text-caption text-muted tabular-nums">{unread} unread</span> : null}
      </div>
      {items.length ? (
        <div role="list" aria-label={label}>
          {items.map((b) => (
            <Row key={b.id} b={b} open={p.openId === b.id} cursor={p.cursorId === b.id} onOpen={p.onOpen} />
          ))}
        </div>
      ) : (
        <p className="px-5 py-1 text-body text-muted">{empty}</p>
      )}
    </section>
  );
}

export function BriefList({ watched, opportunities, openId, cursorId, watchCount, watchesOpen, onOpen, onManage }: BriefListProps) {
  return (
    <div data-testid="brief-list" className="pt-1 pb-3">
      <Group label="Watched" items={watched} empty="No watches yet." openId={watchesOpen ? null : openId} cursorId={cursorId} onOpen={onOpen} />
      <Group label="My opportunities" items={opportunities} empty="No open opportunities." openId={watchesOpen ? null : openId} cursorId={cursorId} onOpen={onOpen} />
      <div className="mx-5 mt-1 border-t border-line pt-2" />
      <button
        type="button"
        onClick={onManage}
        aria-current={watchesOpen || undefined}
        data-testid="watches-entry"
        className={cn(
          'mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-md px-3 py-2.5 text-left focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]',
          watchesOpen ? 'bg-selected' : 'hover:bg-surface-muted',
        )}
      >
        <Icon name="settings" size="sm" className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block text-body font-bold text-fg">Watches</span>
          <span className="block truncate text-caption text-muted">
            {watchCount} {watchCount === 1 ? 'watch' : 'watches'} · what gets briefed, and how often
          </span>
        </span>
      </button>
    </div>
  );
}
