'use client';
/**
 * Jobs (dead-letter first, with Retry) and Errors (the event log with filters and Acknowledge). Both are
 * optimistic with rollback and an inline error; Retry and Acknowledge toast with Undo (auditId).
 * Columns join as the pane widens (`pane` container queries). Status words carry colour only when something
 * needs you (dead, retrying, error, warn); everything else stays neutral.
 */
import { useMemo, useState } from 'react';
import type { EventLogEntry, Job } from '@/contract';
import { ago, clock, dayLabel } from '@/components/domain/lib/time';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { Button, cn, EmptyState, InlineStatus, PanelError, Skeleton, usePanelState, useNow, useTimeZone } from '@/ui';
import { filterEvents, groupJobs, JOB_LABEL, type EventFilter } from './derive';

const fmtNum = (n: number) => n.toLocaleString('en-US');

const JOB_TEXT: Record<Job['status'], string> = { dead: 'font-bold text-danger-700', running: 'text-ai-700', retrying: 'font-bold text-warning-700', queued: 'text-muted', succeeded: 'text-fg', cancelled: 'text-muted' };
const JOB_COLS = 'grid items-center gap-x-3 gap-y-0.5 grid-cols-[minmax(0,1fr)_auto] @min-[44rem]/pane:grid-cols-[minmax(9rem,1.1fr)_7rem_5.5rem_minmax(10rem,2fr)_6.5rem]';

function JobRow({ job, now }: { job: Job; now: string }) {
  const retry = useOptimisticMutation({
    route: 'retryJob',
    topics: ['jobs'],
    rebase: false,
    optimistic: (_i, cache) => cache.patchEntity(job.id, (j) => ({ ...j, status: 'queued', attempts: 0, error: null })),
    toast: () => ({ title: `Requeued ${job.type}`, key: `job-${job.id}` }),
  });
  const canRetry = job.status === 'dead' || job.status === 'retrying' || job.status === 'cancelled';
  return (
    <div role="row" data-job={job.id} data-status={job.status} className={cn(JOB_COLS, 'min-h-11 border-b border-line px-2 py-2 text-body last:border-b-0')}>
      <span role="cell" className="min-w-0">
        <span className="block truncate font-mono text-caption font-bold text-fg">{job.type}</span>
        <span className="block truncate text-caption text-muted @min-[44rem]/pane:hidden">
          <span className={JOB_TEXT[job.status]}>{JOB_LABEL[job.status]}</span> · {job.attempts}/{job.maxAttempts} tries · {ago(job.finishedAt ?? job.startedAt ?? job.runAt, now)}
        </span>
      </span>
      <span role="cell" className={cn('hidden text-caption @min-[44rem]/pane:block', JOB_TEXT[job.status])}>
        {JOB_LABEL[job.status]}
      </span>
      <span role="cell" className="hidden text-caption text-muted tabular-nums @min-[44rem]/pane:block">
        {job.attempts}/{job.maxAttempts} tries
      </span>
      <span role="cell" className="col-span-2 row-start-2 min-w-0 text-caption @min-[44rem]/pane:col-span-1 @min-[44rem]/pane:row-start-auto">
        <span className="block truncate text-muted" title={job.entity?.label}>
          {job.entity?.label ?? 'Global'} · {ago(job.finishedAt ?? job.startedAt ?? job.runAt, now)}
        </span>
        {job.error ? (
          <span className="block truncate text-danger-700" title={job.error}>
            {job.error}
          </span>
        ) : null}
      </span>
      <span role="cell" className="col-start-2 row-start-1 flex items-center justify-end gap-2 @min-[44rem]/pane:col-start-auto @min-[44rem]/pane:row-start-auto">
        {retry.status === 'error' ? <InlineStatus {...retry.inlineStatus} /> : null}
        {canRetry ? (
          <Button size="xs" variant={job.status === 'dead' ? 'secondary' : 'quiet'} icon="refresh" loading={retry.isPending} onClick={() => retry.mutate({ params: { id: job.id }, body: {} })}>
            Retry
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export function JobsTab() {
  const q = useApi('getJobs');
  const now = useNow().toISOString();
  const groups = useMemo(() => groupJobs(q.data?.jobs ?? []), [q.data]);
  const state = usePanelState('health.jobs', { loading: q.isLoading, error: q.data ? null : q.error, empty: !groups.length });
  if (state === 'error') return <PanelError title="Couldn’t load jobs" error={q.error ?? new Error('Forced error state (dev toolbar)')} onRetry={() => void q.refetch()} />;
  if (state === 'loading') return <Skeleton variant="row" count={5} />;
  if (state === 'empty') return <EmptyState title="No jobs" body="Queued, running and dead-lettered work shows here." />;
  return (
    <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]" data-health-jobs>
      <div role="table" aria-label="Jobs">
        {groups.map((g) => (
          <div key={g.status} role="rowgroup" className="mb-2">
            {/* the group's heading is a header row of the table (a rowgroup holds rows only) */}
            <div role="row">
              <div role="rowheader">
                <h3 className="flex items-baseline gap-2 px-2 pt-2 pb-1 text-body font-bold text-fg-heading">
                  {JOB_LABEL[g.status]}
                  <span className="font-normal text-muted tabular-nums">{fmtNum(Math.max(g.jobs.length, q.data?.counts[g.status] ?? 0))}</span>
                </h3>
              </div>
            </div>
            {g.jobs.map((j) => (
              <JobRow key={j.id} job={j} now={now} />
            ))}
            {/* MIN-28: finished jobs come as the latest few; the header keeps the full count */}
            {(q.data?.counts[g.status] ?? 0) > g.jobs.length ? (
              <p className="px-2 pt-1 text-caption text-muted tabular-nums" data-jobs-trimmed={g.status}>
                Showing the latest {fmtNum(g.jobs.length)} of {fmtNum(q.data!.counts[g.status]!)}.
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const LEVEL_TEXT: Record<EventLogEntry['level'], string> = { error: 'font-bold text-danger-700', warn: 'font-bold text-warning-700', info: 'text-muted' };
const LEVEL_WORD: Record<EventLogEntry['level'], string> = { error: '✕ Error', warn: '▲ Warning', info: 'Info' };
const EV_COLS = 'grid items-start gap-x-3 grid-cols-[minmax(0,1fr)_auto] @min-[52rem]/pane:grid-cols-[6.5rem_6rem_minmax(14rem,3fr)_7.5rem_8rem]';

function EventRow({ e, tz }: { e: EventLogEntry; tz?: string }) {
  const ack = useOptimisticMutation({
    route: 'ackEvent',
    topics: ['event_log'],
    rebase: false,
    optimistic: (_i, cache) => cache.patchEntity(e.id, (x) => ({ ...x, acknowledged: true, acknowledgedAt: new Date().toISOString() })),
    toast: (r) => ({ title: `Acknowledged ${r.entity.code}`, key: `ack-${e.id}` }),
  });
  const when = `${dayLabel(e.lastSeenAt, tz)} ${clock(e.lastSeenAt, tz)}`;
  return (
    <div role="row" data-event={e.id} data-level={e.level} data-ack={e.acknowledged || undefined} className={cn(EV_COLS, 'min-h-12 border-b border-line px-2 py-2 text-body last:border-b-0')}>
      <span role="cell" className={cn('hidden pt-0.5 text-caption @min-[52rem]/pane:block', e.acknowledged ? 'text-muted' : LEVEL_TEXT[e.level])}>
        {LEVEL_WORD[e.level]}
      </span>
      <span role="cell" className="hidden truncate pt-0.5 text-caption text-muted @min-[52rem]/pane:block">
        {e.source}
      </span>
      <span role="cell" className="min-w-0">
        <span className="block truncate text-caption text-muted @min-[52rem]/pane:hidden">
          <span className={e.acknowledged ? 'text-muted' : LEVEL_TEXT[e.level]}>{LEVEL_WORD[e.level]}</span> · {e.source} · {when}
        </span>
        <span className={cn('block font-mono text-caption font-bold', e.acknowledged ? 'text-muted' : 'text-fg')}>
          {e.code}
          {e.count > 1 ? ` ×${e.count}` : ''}
        </span>
        <span className={cn('line-clamp-2 text-caption', e.acknowledged ? 'text-muted' : 'text-fg')} title={e.message}>
          {e.message}
        </span>
        {e.suggestedAction && !e.acknowledged ? <span className="block text-caption text-link">{e.suggestedAction}</span> : null}
        {ack.status === 'error' ? <InlineStatus {...ack.inlineStatus} /> : null}
      </span>
      <span role="cell" className="hidden pt-0.5 text-caption text-muted tabular-nums @min-[52rem]/pane:block">
        {when}
      </span>
      <span role="cell" className="flex justify-end">
        {e.acknowledged ? (
          <span className="pt-1 text-caption text-muted">Acknowledged</span>
        ) : (
          <Button size="xs" variant="secondary" icon="check" loading={ack.isPending} onClick={() => ack.mutate({ params: { id: e.id }, body: {} })} data-ack-button>
            Acknowledge
          </Button>
        )}
      </span>
    </div>
  );
}

export function ErrorsTab() {
  const q = useApi('getEventLog');
  const tz = useTimeZone();
  const [f, setF] = useState<EventFilter>({ level: 'all', source: 'all', showAcknowledged: false });
  const entries = useMemo(() => q.data?.entries ?? [], [q.data]);
  const sources = useMemo(() => [...new Set(entries.map((e) => e.source))].sort(), [entries]);
  const rows = useMemo(() => filterEvents(entries, f), [entries, f]);
  const state = usePanelState('health.errors', { loading: q.isLoading, error: q.data ? null : q.error, empty: !rows.length });
  const sel = 'h-8 rounded-md border border-line-input bg-surface-input px-2 text-body text-fg';
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-health-errors>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2 text-caption">
        <label className="text-muted" htmlFor="ev-level">
          Level
        </label>
        <select id="ev-level" className={sel} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as EventFilter['level'] })}>
          <option value="all">All</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
        </select>
        <label className="text-muted" htmlFor="ev-source">
          Source
        </label>
        <select id="ev-source" className={sel} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          <option value="all">All</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1.5 text-muted">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={f.showAcknowledged} onChange={(e) => setF({ ...f, showAcknowledged: e.target.checked })} /> Show acknowledged
        </label>
        <span className="ml-auto text-muted tabular-nums">{q.data?.unacknowledged ?? 0} to review</span>
      </div>
      {state === 'error' ? (
        <PanelError title="Couldn’t load the event log" error={q.error ?? new Error('Forced error state (dev toolbar)')} onRetry={() => void q.refetch()} />
      ) : state === 'loading' ? (
        <Skeleton variant="row" count={5} />
      ) : state === 'empty' ? (
        <EmptyState title="Nothing to review" body={entries.length ? 'Everything matching these filters is acknowledged.' : 'Errors and warnings from connectors and the worker land here.'} />
      ) : (
        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]">
          <div role="table" aria-label="Event log">
            {rows.map((e) => (
              <EventRow key={e.id} e={e} tz={tz} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
