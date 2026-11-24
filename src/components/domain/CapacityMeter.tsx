'use client';
/**
 * CapacityMeter: "~1h 30m of your work · ~5h open · ✓ Fits" (DESIGN-V2 "Capacity and estimates", binding).
 *
 * - Only today-scoped, hands-on minutes count (`youMin`): due today, start-by today, or pinned to today.
 * - Agent time runs in the background, in parallel: shown as a quiet violet note, never against the day.
 * - "Over" only when it is true: today's hands-on time is greater than the free time outside meetings.
 *   Only then does the bar get a hatched amber overflow and the one wording everywhere: "Overbooked by N min"
 *   (priority@2 capacity honesty, `overbookedLabel`).
 *
 * `inline` is Home's lead-head line; `bar` is Today's header block (badge, open time, bar, legend).
 */
import type { ReactNode } from 'react';
import { cn } from '@/ui';
import { AiMark, StatusBadge } from './lib';
import { hm } from './lib/v2';
import { overbookedLabel } from '@/engines/priority/v2/capacity';

export interface CapacityMeterProps {
  /** Today-scoped hands-on minutes. */
  youMin: number;
  /** Free minutes outside meetings, from now to the end of the working day. */
  freeMin: number;
  /** Background agent minutes queued today (never counted). */
  agentMin?: number;
  /** Background runs today ("1 agent running in the background"). */
  agentRuns?: number;
  /** MIN-22: the working day counted ("today", or "tomorrow" / "Monday" once today's working hours are over). */
  dayLabel?: string;
  variant?: 'inline' | 'bar';
  /** Clicking opens the capacity detail (Today, or the planner). */
  onOpen?: () => void;
  className?: string;
}

/** Estimates are shown as rough numbers: 5-minute steps under an hour, 15-minute steps above. */
export function approxMin(min: number): number {
  const m = Math.max(0, min);
  return m < 60 ? Math.round(m / 5) * 5 : Math.round(m / 15) * 15;
}
const approx = (min: number) => `~${hm(approxMin(min))}`;

export function CapacityMeter({ youMin, freeMin, agentMin = 0, agentRuns, dayLabel = 'today', variant = 'inline', onOpen, className }: CapacityMeterProps) {
  const later = dayLabel !== 'today';
  const over = youMin > freeMin;
  const open = Math.max(0, freeMin - youMin);
  const overBy = Math.max(0, youMin - freeMin);
  const verdict = over ? (
    <StatusBadge tone="warning" icon="warning">
      {overbookedLabel(overBy)}
    </StatusBadge>
  ) : (
    <StatusBadge tone="success" icon="check">
      Fits
    </StatusBadge>
  );
  const bg =
    agentRuns || agentMin ? (
      <AiMark>
        {agentRuns ? `${agentRuns} agent run${agentRuns === 1 ? '' : 's'}` : `Agent ${approx(agentMin)}`} in the background
      </AiMark>
    ) : null;
  const aria = `Capacity${later ? ` for ${dayLabel}` : ''}: about ${hm(approxMin(youMin))} of your work, about ${hm(approxMin(freeMin))} free outside meetings, ${over ? overbookedLabel(overBy).toLowerCase() : `about ${hm(approxMin(open))} open`}`;
  const wrap = (cls: string, children: ReactNode) =>
    onOpen ? (
      <button type="button" onClick={onOpen} className={cn(cls, 'rounded-md text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus', className)}>
        {children}
      </button>
    ) : (
      <div className={cn(cls, className)}>{children}</div>
    );

  if (variant === 'inline') {
    return wrap(
      'inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted',
      <>
        <span role="meter" aria-label={aria} aria-valuemin={0} aria-valuemax={Math.max(freeMin, youMin)} aria-valuenow={youMin} className="whitespace-nowrap">
          <b className="text-body-lg font-bold text-fg-heading tabular-nums">{approx(youMin)}</b> of your work {dayLabel} ·{' '}
          <span className="tabular-nums">{over ? `${approx(freeMin)} free` : `${approx(open)} open`}</span>
        </span>
        {verdict}
        {bg}
      </>,
    );
  }

  const scale = Math.max(freeMin, youMin, 1);
  const fit = Math.min(youMin, freeMin) / scale;
  const spill = overBy / scale;
  return wrap(
    'grid w-80 max-w-full gap-2',
    <>
      <span className="flex items-center gap-2.5">
        {verdict}
        <span className="ml-auto text-body-lg font-bold text-fg-heading tabular-nums">{over ? `${approx(overBy)} over` : `${approx(open)} open`}</span>
      </span>
      <span role="meter" aria-label={aria} aria-valuemin={0} aria-valuemax={Math.max(freeMin, youMin)} aria-valuenow={youMin} className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-sunken">
        <i className="block h-full bg-fg" style={{ width: `${fit * 100}%` }} />
        {over ? (
          <i
            className="block h-full"
            data-overflow
            style={{ width: `${spill * 100}%`, backgroundImage: 'repeating-linear-gradient(135deg, var(--color-warning-500) 0 3px, transparent 3px 6px)' }}
          />
        ) : null}
      </span>
      <span className="flex justify-between gap-3 text-caption text-muted tabular-nums">
        <span>
          {approx(youMin)} your work{later ? ` ${dayLabel}` : ''}
        </span>
        <span>{approx(freeMin)} free</span>
      </span>
      {bg ? <span className="text-caption">{bg}</span> : null}
    </>,
  );
}
