'use client';
/**
 * Time ▸ Log hours, step 1 "Suggested" (docs/archive/2026-build/time-redesign.md): what the app proposed for the selected week and
 * how much, then where those rows are now as one line of counts (each a jump to its section), the CF/CR split, the
 * onsite days (Confirm, Not onsite, Mark trip) and "Week at a glance": the calendar grid, a disclosure closed by
 * default and remembered, since it is the evidence behind the suggestions, not a task.
 */
import { useEffect, useState } from 'react';
import type { TimeWeek } from '@/contract';
import { AppLink } from '@/components/shell/AppLink';
import { cn, Icon } from '@/ui';
import { fmtH, type WorkSpan } from './derive';
import { OnsiteStrip } from './OnsiteChips';
import { rowsWord, type WeekSuggested } from './path-derive';
import { WeekTimeline } from './WeekTimeline';

const GLANCE_KEY = 'cc:time:week-at-a-glance';

function useGlance(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(GLANCE_KEY) === '1');
    } catch {
      /* closed */
    }
  }, []);
  return [
    open,
    (v) => {
      setOpen(v);
      try {
        localStorage.setItem(GLANCE_KEY, v ? '1' : '0');
      } catch {
        /* memory only */
      }
    },
  ];
}

export interface SuggestedWeekProps {
  week: TimeWeek;
  s: WeekSuggested;
  isThisWeek: boolean;
  now: string;
  tz?: string;
  work: WorkSpan & { days?: number[] };
  onOpenActivity: (id: string) => void;
  /** Jump to the section a count lives in. */
  onJump: (to: 'needs' | 'ready' | 'internal' | 'way' | 'rows') => void;
}

export function SuggestedWeek({ week, s, isThisWeek, now, tz, work, onOpenActivity, onJump }: SuggestedWeekProps) {
  const [glance, setGlance] = useGlance();
  const meetings = week.timeline.find((l) => l.id === 'meetings')?.blocks.length ?? 0;
  const when = isThisWeek ? 'this week' : 'that week';
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 tabular-nums" data-testid="suggested-total">
        <span className="text-title font-bold text-fg-heading">{fmtH(s.hours)}</span>
        <span className="text-body text-muted">{`${rowsWord(s.rows)} suggested ${when}${s.upcoming ? ` · ${s.upcoming} later ${when}` : ''}`}</span>
      </div>
      {s.parts.length ? (
        <ul className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-body tabular-nums" aria-label="Where they are now" data-testid="suggested-parts">
          {s.parts.map((p) => {
            const to = p.id === 'needs' ? 'needs' : p.id === 'ready' ? 'ready' : p.id === 'internal' ? 'internal' : p.id === 'way' ? 'way' : 'rows';
            return (
              <li key={p.id} data-part={p.id}>
                <button type="button" onClick={() => onJump(to)} className={cn('rounded-sm hover:underline focus-visible:outline-none focus-visible:shadow-focus', p.id === 'needs' ? 'font-bold text-warning-700' : 'text-fg')}>
                  {`${p.rows} ${p.label}`}
                </button>
                <span className="text-caption text-muted">{` · ${fmtH(p.hours)}`}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-caption text-muted tabular-nums">
        {`CF ${fmtH(s.cf)} · CR ${fmtH(s.cr)}${s.unassigned ? ` · ${fmtH(s.unassigned)} not marked` : ''}${s.overlap ? ` · ${s.overlap}` : ''}`}
        {s.excluded ? (
          <>
            {' · '}
            <AppLink href="/activity?view=log&status=excluded" className="text-link hover:underline">
              {`${s.excluded} not logged (see why)`}
            </AppLink>
          </>
        ) : null}
      </p>
      <OnsiteStrip days={week.onsite ?? []} weekStart={week.weekStart} weekEnd={week.weekEnd} />
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={glance}
          aria-controls="time-glance"
          onClick={() => setGlance(!glance)}
          data-testid="week-glance-toggle"
          className="inline-flex items-center gap-1.5 rounded-sm text-body font-bold text-fg-heading hover:underline focus-visible:outline-none focus-visible:shadow-focus"
        >
          <Icon name={glance ? 'chevrondown' : 'chevronright'} size="xs" className="text-muted" />
          Week at a glance
          <span className="font-normal text-caption text-muted">{`${meetings} ${meetings === 1 ? 'meeting' : 'meetings'}, your focus, Claude, Drive and Slack · agent time shown, never counted`}</span>
        </button>
        {glance ? (
          <div id="time-glance" className="mt-2 h-80 min-w-0 overflow-hidden rounded-lg border border-line bg-surface" aria-label="Week timeline">
            <WeekTimeline week={week} now={now} tz={tz} work={work} onOpenActivity={onOpenActivity} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
