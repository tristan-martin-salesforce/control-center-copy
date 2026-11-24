'use client';
/**
 * Briefs (R-UI-21, UI-SPEC §12). Briefs are reading material: no filled primary, so they never compete
 * with the Top 3. DESIGN-V2: calm and neutral; only "new" gets the small accent dot.
 * - BriefHighlightCard: relevance word, reasons tied to YOUR accounts/opps/policy, source chips,
 *   Promote → Triage · Make task · Not relevant (tunes relevance).
 * - BriefSummary: one row in the Briefs list (unread, "3 worth a look", through 10:41).
 */
import type { BriefHighlight, BriefRelevance, BriefSummary as BriefSummaryVm, SourceRef } from '@/contract';
import { Button, cn, Icon } from '@/ui';
import { SourceChip, StatusBadge, useClock } from './lib';
import { clock, sameDay, dayLabel } from './lib/time';
import './domain.css';

const RELEVANCE: Record<BriefRelevance, { label: string; cls: string; bars: number }> = {
  high: { label: 'High', cls: 'text-fg-heading', bars: 3 },
  medium: { label: 'Medium', cls: 'text-fg', bars: 2 },
  low: { label: 'Low', cls: 'text-muted', bars: 1 },
};

export function RelevanceWord({ value }: { value: BriefRelevance }) {
  const r = RELEVANCE[value];
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-caption font-bold', r.cls)} title={`${r.label} relevance for you`}>
      <span className="inline-flex items-end gap-px" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className={cn('w-[3px] rounded-[1px]', i <= r.bars ? 'bg-fg' : 'bg-surface-sunken')} style={{ height: 4 + i * 2 }} />
        ))}
      </span>
      {r.label}
    </span>
  );
}

export interface BriefHighlightCardProps {
  highlight: BriefHighlight;
  className?: string;
  onPromote?: (h: BriefHighlight) => void;
  onMakeTask?: (h: BriefHighlight) => void;
  onDismiss?: (h: BriefHighlight) => void;
  onOpenSource?: (s: SourceRef, h: BriefHighlight) => void;
  onOpenTask?: (workItemId: string) => void;
  onUndo?: (h: BriefHighlight) => void;
}

export function BriefHighlightCard({ highlight: h, className, onPromote, onMakeTask, onDismiss, onOpenSource, onOpenTask, onUndo }: BriefHighlightCardProps) {
  const { tz } = useClock();
  const dismissed = h.status === 'dismissed';
  const promoted = h.status === 'promoted';
  return (
    <article className={cn('rounded-lg border border-line bg-surface p-5', dismissed && 'bg-surface-muted', className)} aria-label={h.title}>
      <div className="flex items-start gap-3">
        <h3 className={cn('min-w-0 flex-1 text-body-lg font-bold', dismissed ? 'text-muted line-through decoration-line-strong' : 'text-fg-heading')}>{h.title}</h3>
        {h.status === 'new' ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 pt-1 text-caption text-muted">
            <span className="size-2 rounded-full bg-accent" />
            New
          </span>
        ) : null}
        <span className="pt-0.5">
          <RelevanceWord value={h.relevance} />
        </span>
      </div>
      <p className={cn('mt-1 max-w-[68ch] text-body', dismissed ? 'text-muted' : 'text-fg')}>{h.summary}</p>
      <ul className="mt-2 space-y-1">
        {h.reasons.map((r) => (
          <li key={r} className="flex items-start gap-2 text-caption text-muted">
            <Icon name="target" size="xs" className="mt-1 shrink-0 text-faint" />
            <span>{r}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {h.sources.map((s) => (
          <SourceChip key={`${s.kind}${s.label}`} source={s} onOpen={onOpenSource ? (src) => onOpenSource(src, h) : undefined} />
        ))}
        <span className="text-caption text-muted tabular-nums">{clock(h.at, tz)}</span>
        <span className="ml-auto flex items-center gap-1">
          {promoted ? (
            <>
              <StatusBadge tone="success" icon="check">
                {h.promotedAs === 'triage' ? 'In Triage' : h.promotedAs === 'task' ? 'Task made' : 'Promoted'}
              </StatusBadge>
              {h.promotedWorkItemId ? (
                <Button size="sm" variant="ghost" onClick={() => onOpenTask?.(h.promotedWorkItemId!)}>
                  Open task
                </Button>
              ) : null}
            </>
          ) : dismissed ? (
            <>
              <span className="text-caption text-muted">Not relevant: tuned</span>
              <Button size="sm" variant="ghost" icon="undo" onClick={() => onUndo?.(h)}>
                Undo
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={() => onPromote?.(h)}>
                Promote → Triage
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onMakeTask?.(h)}>
                Make task
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDismiss?.(h)}>
                Not relevant
              </Button>
            </>
          )}
        </span>
      </div>
    </article>
  );
}

export interface BriefSummaryProps {
  brief: BriefSummaryVm;
  selected?: boolean;
  now?: string;
  className?: string;
  onOpen?: (brief: BriefSummaryVm) => void;
}

export function BriefSummary({ brief: b, selected, className, onOpen, ...rest }: BriefSummaryProps) {
  const { now, tz } = useClock({ now: rest.now });
  const through = sameDay(b.through, now, tz) ? clock(b.through, tz) : `${dayLabel(b.through, tz)} ${clock(b.through, tz)}`;
  return (
    <button
      type="button"
      data-row
      onClick={() => onOpen?.(b)}
      aria-current={selected || undefined}
      className={cn(
        'flex h-12 w-full items-center gap-3 border-b border-line px-4 text-left last:border-b-0 focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)] focus-visible:outline-none',
        selected ? 'bg-selected' : 'hover:bg-surface-muted',
        className,
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', b.unread ? 'bg-accent' : 'bg-transparent')} role={b.unread ? 'img' : undefined} aria-label={b.unread ? 'Unread' : undefined} aria-hidden={b.unread ? undefined : true} />
      <Icon name={b.kind === 'opp' ? 'opportunity' : b.kind === 'channel' ? 'slack' : b.kind === 'person' ? 'user' : 'search'} size="sm" className="shrink-0 text-faint" />
      <span className={cn('min-w-0 flex-1 truncate text-body', b.unread ? 'font-bold text-fg-heading' : 'text-fg')}>{b.title}</span>
      {b.status === 'generating' ? (
        <span className="cc-reeval shrink-0 px-1 text-caption text-ai-700">✦ writing…</span>
      ) : b.status === 'failed' ? (
        <StatusBadge tone="danger" icon="close">
          Failed
        </StatusBadge>
      ) : b.worthALook ? (
        <span className="shrink-0 whitespace-nowrap text-caption font-bold text-fg tabular-nums">{b.worthALook} worth a look</span>
      ) : null}
      <span className="shrink-0 whitespace-nowrap text-right text-caption text-muted tabular-nums">through {through}</span>
    </button>
  );
}
