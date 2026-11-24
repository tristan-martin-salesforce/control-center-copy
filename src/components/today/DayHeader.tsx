'use client';
/**
 * Today's page header, a kit PageHeader (01-ui-audit R10; the title "Today" is the topbar's, from the route table):
 * the date, one sentence, the background-agent note, and one neutral meter. "✓ Fits" says it in a word; red appears only when today-scoped hands-on work truly exceeds the
 * free time outside meetings, and then the day reads "overbooked", never "fits" (lane 07 PRIO-3).
 */
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/kit/PageHeader';
import { overbookedLabel } from '@/engines/priority/v2/capacity';
import type { DayCapacity } from './capacity';
import { approx, dateLabel, hm, roundEstimate } from './time';

export function Badge({ tone, children, className }: { tone: 'success' | 'warning' | 'danger' | 'ai' | 'neutral'; children: React.ReactNode; className?: string }) {
  return (
    <span className={`td-badge${className ? ` ${className}` : ''}`} data-tone={tone}>
      {children}
    </span>
  );
}

export interface DayHeaderProps {
  nowIso: string;
  tz?: string;
  cap: DayCapacity;
  /** Short names of the background runs ("smoke-test checks"). */
  agentLabels: string[];
  /** The working day is over (nothing left to plan). */
  dayOver: boolean;
  catchUp: string | null;
  /** priority@2: the "Preview new ranking" toggle (session only) under the sentence. */
  preview?: ReactNode;
}

export function DayHeader({ nowIso, tz, cap, agentLabels, dayOver, catchUp, preview }: DayHeaderProps) {
  const overbooked = overbookedLabel(cap.overByMin);
  const you = `About ${hm(roundEstimate(cap.youMin))}`;
  const free = approx(cap.freeMin);
  // MIN-22: after hours the engine counts the next working day; the meter says so and never warns about today
  const day = cap.dayLabel.charAt(0).toUpperCase() + cap.dayLabel.slice(1);
  const verdict = cap.next ? (
    <>
      {/* cap.next: outside working hours, after hours or a day off ("the working day is over" at 09:00 on a Saturday was wrong) */}
      Outside your working hours. {day}: about {hm(roundEstimate(cap.youMin))} of your work, {free} free outside meetings:{' '}
      <b>{cap.fits ? `${approx(cap.openMin)} open.` : `${overbooked}.`}</b>
    </>
  ) : dayOver ? (
    <>
      The working day is over. <b>Anything left rolls to tomorrow.</b>
    </>
  ) : cap.youMin <= 0 ? (
    <>
      Nothing hands-on planned, {free} free outside meetings: <b>{approx(cap.openMin)} open to pull work forward.</b>
    </>
  ) : cap.fits ? (
    <>
      {you} of your work, {free} free outside meetings: <b>{approx(cap.openMin)} open to pull work forward.</b>
    </>
  ) : (
    <>
      {you} of your work, {free} free outside meetings: <b>{overbooked}.</b> Move or defer something.
    </>
  );
  const pct = cap.freeMin > 0 ? Math.min(100, (cap.youMin / cap.freeMin) * 100) : cap.youMin > 0 ? 100 : 0;
  const runs = cap.agentRuns;
  const label = `Capacity${cap.next ? ` for ${cap.dayLabel}` : ''}: about ${hm(roundEstimate(cap.youMin))} of your work, about ${hm(roundEstimate(cap.freeMin))} free, ${cap.fits ? `about ${hm(roundEstimate(cap.openMin))} open` : `overbooked by ${hm(cap.overByMin)}`}`;
  return (
    <PageHeader
      route="today"
      titleIn="topbar"
      inset={false}
      rule={false}
      className="td-head-kit"
      crumb={dateLabel(nowIso, tz)}
      sentence={
        <>
          <span className="td-verdict block" data-verdict>
            {verdict}
          </span>
          {runs > 0 ? (
            <span className="td-bgrun block text-caption text-muted">
              <span className="text-ai-700">✦</span> {runs} agent run{runs === 1 ? '' : 's'} in the background
              {` (${agentLabels.length ? `${agentLabels.slice(0, 2).join(', ')}, ` : ''}${approx(cap.agentMin)})`}. {runs === 1 ? 'It doesn’t' : 'They don’t'} count against your time.
            </span>
          ) : null}
          {catchUp ? <span className="block text-caption text-muted">Catching up: {catchUp}. The order may shift; nothing moves until you re-rank.</span> : null}
          {preview}
        </>
      }
      actions={
        <div className="td-cap" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={Math.max(cap.freeMin, cap.youMin)} aria-valuenow={cap.youMin} data-capacity={cap.fits ? 'fits' : 'over'} data-capacity-day={cap.next ? 'next' : 'today'}>
          <div className="flex items-center gap-2.5">
            {cap.fits ? <Badge tone="success">✓ Fits</Badge> : <Badge tone="danger">✕ {overbooked}</Badge>}
            <span className="ml-auto text-body-lg font-bold text-fg-heading tabular-nums">{cap.fits ? `${approx(cap.openMin)} open` : `${approx(cap.youMin)} of ${approx(cap.freeMin)}`}</span>
          </div>
          <div className="td-capbar" aria-hidden>
            <i style={{ width: `${pct}%` }} data-over={cap.fits ? undefined : ''} />
          </div>
          <div className="flex justify-between text-caption text-muted tabular-nums">
            <span>
              {approx(cap.youMin)} your work{cap.next ? ` ${cap.dayLabel}` : ''}
            </span>
            <span>{approx(cap.freeMin)} free</span>
          </div>
        </div>
      }
    />
  );
}
