'use client';
/**
 * One run in an Agents section (DESIGN-V2; the Home mockup's section `.row`):
 *
 *   ▌ ◐ Title of the run (18 px, one line)
 *   ▌   why: the question it asks / its error / its latest step (14 px muted, one line)
 *   ▌   Running · 12m · you ~3m to answer · [task]                          Verb
 *
 * One colour signal: the state (glyph + word; a 3 px edge only for waiting, failed and the selection). The verb
 * is quiet text; it is the one filled button only on the selected row, or on the focal row while nothing is
 * selected, and never while the row is open in the panel (the panel footer has it then).
 */
import { forwardRef, type HTMLAttributes } from 'react';
import type { AgentRun } from '@/contract';
import { AccountTag, EDGE_BG, RunGlyph, type Indicator } from '@/components/domain';
import { age, dur, minutesBetween } from '@/components/domain/lib/time';
import { cn, RowVerb } from '@/ui';
import { STATE_LABEL } from './log';
import { needLine, runVerb } from './needs';

export interface RunRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  run: AgentRun;
  now: string;
  taskTitle?: string | null;
  selected?: boolean;
  /** Focal row while nothing is selected: its verb is filled. */
  emphasized?: boolean;
  /** Open in the docked panel: the verb stays quiet. */
  inPanel?: boolean;
  flash?: 'state' | 'waiting';
  busy?: boolean;
  onVerb?: (run: AgentRun) => void;
  onOpenTask?: (workItemId: string) => void;
}

function indicator(run: AgentRun, selected: boolean): Indicator {
  if (run.state === 'failed') return 'danger';
  if (selected) return 'now';
  if (run.state === 'waiting_on_you') return 'warning';
  return 'none';
}

/** The row's state word: "Finished" (not "Done, review"), since the need line already says "to review". */
const ROW_STATE: Record<AgentRun['state'], string> = { ...STATE_LABEL, done_review: 'Finished' };

const STATE_TEXT: Partial<Record<AgentRun['state'], string>> = {
  waiting_on_you: 'font-bold text-warning-700',
  failed: 'font-bold text-danger-700',
  running: 'text-ai-700',
};

export const RunRow = forwardRef<HTMLDivElement, RunRowProps>(function RunRow({ run, now, taskTitle, selected = false, emphasized, inPanel, flash, busy, onVerb, onOpenTask, className, ...rest }, ref) {
  const verb = runVerb(run);
  const live = run.state === 'running' || run.state === 'waiting_on_you';
  const from = run.state === 'waiting_on_you' ? run.waiting?.since : run.state === 'running' ? run.startedAt : (run.finishedAt ?? run.updatedAt);
  const elapsed = from ? (live ? dur(Math.max(0, minutesBetween(from, now))) : `${age(from, now)} ago`) : null;
  const why = run.state === 'waiting_on_you' ? (run.waiting?.question ?? run.waiting?.reason ?? run.lastEvent) : run.state === 'failed' ? (run.error ?? run.lastEvent) : run.lastEvent;
  const need = needLine(run);
  const pct = run.progress ? Math.round((run.progress.done / Math.max(1, run.progress.total)) * 100) : null;
  const ind = indicator(run, selected);
  const filled = (selected || !!emphasized) && !inPanel;
  return (
    <div
      ref={ref}
      role="listitem"
      data-run-row={run.id}
      data-state={run.state}
      data-selected={selected || undefined}
      data-in-panel={inPanel || undefined}
      aria-label={`${run.title}, ${STATE_LABEL[run.state]}`}
      className={cn(
        'group/run relative grid cursor-pointer grid-cols-[3px_minmax(0,1fr)] gap-x-3 rounded-md px-3 py-2.5 outline-none',
        'focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]',
        selected ? 'bg-selected' : 'hover:bg-surface-muted',
        flash === 'waiting' ? 'cc-run-waiting' : flash ? 'cc-run-flash' : null,
        className,
      )}
      {...rest}
    >
      <span aria-hidden className={cn('row-span-3 my-0.5 w-[3px] rounded-full', EDGE_BG[ind])} data-edge={ind} />
      <div className="flex min-w-0 items-center gap-2">
        <RunGlyph state={run.state} size={14} />
        <span className="min-w-0 truncate text-body-lg font-bold text-fg-heading" title={run.title}>
          {run.title}
        </span>
      </div>
      <p className={cn('col-start-2 min-w-0 truncate text-caption', run.state === 'failed' ? 'text-danger-700' : 'text-muted')} title={why}>
        {why || 'No activity recorded yet'}
      </p>
      <div className="col-start-2 mt-1 flex min-w-0 items-center gap-x-2 text-caption text-muted">
        {/* In a narrow column the glyph + section name carry the state, so the word goes and the need stays. */}
        <span className={cn('hidden shrink-0 whitespace-nowrap @[25rem]/sec:inline', STATE_TEXT[run.state])}>{ROW_STATE[run.state]} ·</span>
        {elapsed ? <span className="shrink-0 tabular-nums whitespace-nowrap">{elapsed}</span> : null}
        {need.text ? (
          <span className={cn('min-w-0 truncate', need.ai ? 'text-ai-700' : 'font-bold text-fg')} title={need.text} data-need>
            · {need.text}
          </span>
        ) : null}
        {pct !== null ? (
          <span className="hidden h-1.5 w-14 shrink-0 rounded-full bg-surface-sunken @[24rem]/sec:inline-block" title={`${run.progress!.done}/${run.progress!.total} ${run.progress!.label ?? ''}`}>
            <span className="block h-full rounded-full bg-ai-500" style={{ width: `${pct}%` }} />
          </span>
        ) : null}
        {taskTitle && run.workItemId ? (
          <span className="hidden min-w-0 shrink @[30rem]/sec:inline-flex">
            <AccountTag label={taskTitle} onOpen={() => onOpenTask?.(run.workItemId!)} title={`For: ${taskTitle}`} />
          </span>
        ) : null}
        {verb ? (
          <span className="ml-auto shrink-0 pl-1">
            <RowVerb action={{ label: verb.label, onClick: () => onVerb?.(run), kbd: 'mod+enter', loading: busy }} filled={filled} />
          </span>
        ) : null}
      </div>
    </div>
  );
});
