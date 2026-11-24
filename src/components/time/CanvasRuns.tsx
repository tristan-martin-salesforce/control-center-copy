'use client';
/**
 * A logging batch's status for the draft panel (src/components/detail/DraftPanel.tsx): `CanvasRunStatus`, read from
 * GET /time's `logCanvases` (./rows-derive.ts canvasRun): Staged → Applied → Slackbot told → In Org62, its counts, its
 * Org62 progress, why its rows are read only, and (D-70) its writes exactly as sent. On To log the batches themselves
 * are lane 3, Sending (./SendingLane.tsx, C6/C7); the old run list that lived here is gone.
 */
import { useState } from 'react';
import type { LogCanvas } from '@/contract';
import { useApi } from '@/client/hooks';
import { StatusBadge } from '@/components/domain';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { progressLine } from '@/lib/canvas/checks';
import { cn, Icon } from '@/ui';
import { WriteList } from './LandingParts';
import { runWritesLine } from './landing-derive';
import { canvasRun, type CanvasRun, type RunStep } from './rows-derive';

const TONE: Record<CanvasRun['tone'], 'now' | 'neutral' | 'danger' | 'warning' | 'success'> = { act: 'now', waiting: 'neutral', danger: 'danger', warning: 'warning', done: 'success' };

/** Staged ✓ — Applied ✓ — Slackbot told ● — In Org62 ○ */
export function RunTrack({ steps }: { steps: RunStep[] }) {
  return (
    <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-caption" aria-label="Where it is">
      {steps.map((s, i) => (
        <li key={s.id} className="inline-flex items-center gap-1.5" data-run-step={s.id} data-state={s.state}>
          {i > 0 ? <span aria-hidden className={cn('h-px w-4', s.state === 'todo' ? 'bg-line' : 'bg-line-strong')} /> : null}
          <span
            aria-hidden
            className={cn(
              'grid size-4 shrink-0 place-items-center rounded-full',
              s.state === 'done' ? 'bg-surface-sunken text-success-700' : s.state === 'current' ? 'bg-accent text-on-accent' : s.state === 'problem' ? 'bg-surface-sunken text-danger-700' : 'border border-line-strong',
            )}
          >
            {s.state === 'done' ? <Icon name="check" size="xs" /> : s.state === 'problem' ? <Icon name="warning" size="xs" /> : null}
          </span>
          <span className={cn(s.state === 'todo' ? 'text-muted' : s.state === 'problem' ? 'font-bold text-danger-700' : s.state === 'current' ? 'font-bold text-fg-heading' : 'text-fg')}>{s.label}</span>
          <span className="sr-only">{s.state === 'done' ? ': done' : s.state === 'current' ? ': now' : s.state === 'problem' ? ': needs you' : ': not yet'}</span>
        </li>
      ))}
    </ol>
  );
}

/** "4 of 4 Events · 55 of 55 DCs in Org62 · checked Wed 17:49 · next check 18:20" */
export function RunProgress({ c, tz }: { c: LogCanvas; tz?: string }) {
  const p = c.progress;
  const at = (iso: string) => `${dayLabel(iso, tz)} ${clock(iso, tz)}`;
  if (!p) {
    if (!c.org62 || !c.rows) return null;
    return <span className={cn('tabular-nums', c.org62.missing ? 'font-bold text-danger-700' : 'text-fg')}>{c.org62.logged === c.rows ? 'All rows in Org62' : `${c.org62.logged} of ${c.rows} rows in Org62${c.org62.missing ? ` · ${c.org62.missing} missing` : ''}`}</span>;
  }
  const line = progressLine(p);
  const checked = p.checkedAt ? `checked ${at(p.checkedAt)}` : 'not checked since it was applied';
  const next = p.nextCheckAt && p.state !== 'in_org62' ? `next check ${at(p.nextCheckAt)}` : null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 tabular-nums" data-testid="canvas-progress" data-progress-state={p.state}>
      {line ? <span className={p.state === 'missing' ? 'font-bold text-danger-700' : 'text-fg'}>{line}</span> : null}
      <span className="text-muted">{[p.toldAt ? `Slackbot told ${at(p.toldAt)}` : null, checked, next].filter(Boolean).join(' · ')}</span>
    </span>
  );
}

/** D-70: a run's writes exactly as sent, loaded when opened. */
export function RunWrites({ draftId, tz, defaultOpen = false }: { draftId: string; tz?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const q = useApi('getCanvasWrites', { params: { id: draftId } }, { enabled: open });
  return (
    <div className="min-w-0" data-testid="run-writes">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus" data-testid="run-writes-toggle">
        <Icon name={open ? 'chevrondown' : 'chevronright'} size="xs" />
        {open && q.data ? `Its writes: ${runWritesLine(q.data.counts)}` : 'Its writes'}
      </button>
      {open ? <div className="mt-1 rounded-md bg-surface-muted px-3 py-1">{q.isLoading ? <p className="py-2 text-caption text-muted">Loading…</p> : q.data ? <WriteList writes={q.data.writes} tz={tz} empty="No writes recorded for this batch." /> : <p className="py-2 text-caption text-muted">Couldn’t read its writes.</p>}</div> : null}
    </div>
  );
}

/**
 * The status of the logging canvas a draft panel shows: the same run as Log it lists (its track, status, progress, why
 * its rows are read only). Null when it is not a logging canvas Time knows (a forecast canvas, an old one).
 */
export function CanvasRunStatus({ draftId, tz }: { draftId: string; tz?: string }) {
  const week = useApi('getTime', { query: { week: undefined } }, { staleTime: 30_000 });
  const c = week.data?.logCanvases.find((x) => x.draftId === draftId);
  if (!c) return null;
  const run = canvasRun(c, tz);
  return (
    <section className="mb-4 space-y-1.5 rounded-md border border-line px-3 py-2.5" data-testid="canvas-run-status" aria-label="Where this batch is">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge tone={TONE[run.tone]} icon={run.tone === 'danger' || run.tone === 'warning' ? 'warning' : run.tone === 'done' ? 'check' : undefined}>
          {run.status}
        </StatusBadge>
        <span className="text-caption text-fg tabular-nums">{run.counts}</span>
      </div>
      <RunTrack steps={run.steps} />
      <div className="text-caption">
        <RunProgress c={c} tz={tz} />
      </div>
      <p className="flex min-w-0 items-start gap-1.5 text-caption text-muted">
        <Icon name={c.state === 'pending' ? 'edit' : 'lock'} size="xs" className="mt-0.5 shrink-0" />
        <span className="min-w-0">{run.rowsNote}</span>
      </p>
      <RunWrites draftId={draftId} tz={tz} defaultOpen={c.state !== 'pending' && c.state !== 'retry'} />
    </section>
  );
}
