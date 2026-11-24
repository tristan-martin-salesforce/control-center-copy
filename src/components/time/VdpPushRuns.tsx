'use client';
/**
 * VDP ▸ Changes ▸ Push runs (2026-11-16): every "Push N to VDP" is its own item, like Activity's Logging runs. The push
 * runs in the background (the click returns at once), so this is where you follow it: when it started, where it
 * stands ("Pushing · 23 of 133 done"), and once it ends, how each item ended. What needs you (failed, not pushed) is
 * listed under the run with why; "Show the N items" opens every item in push order, by company, each with its Outbox
 * item. VDP takes one push at a time: while one runs, Push waits for it (the server refuses a second one).
 * Live: the coverage follows the push's items as they land (src/components/time/VdpView.tsx).
 */
import { useState } from 'react';
import type { VdpPushNode, VdpPushRun } from '@/contract';
import { Pane, SectionHead } from '@/components/deals/context-frame';
import { StatusBadge } from '@/components/domain';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { ActionRow } from '@/components/kit';
import { Icon } from '@/ui';
import { byCompany, pushNodeState, pushOpLabel, pushRunView } from './vdp-push-derive';

export function VdpPushRuns({ runs, tz, onDraft }: { runs: readonly VdpPushRun[]; tz?: string; onDraft: (id: string) => void }) {
  if (!runs.length) return null;
  return (
    <Pane aria-label="Push runs" scroll={false} data-testid="vdp-push-runs" head={<SectionHead title="Push runs" count={runs.length} sub="each push runs in the background: where it stands, then how each item ended" />}>
      <ul className="divide-y divide-line border-t border-line">
        {runs.map((r, i) => (
          <PushRunItem key={r.id} run={r} tz={tz} onDraft={onDraft} first={i === 0} />
        ))}
      </ul>
    </Pane>
  );
}

function PushRunItem({ run, tz, onDraft, first }: { run: VdpPushRun; tz?: string; onDraft: (id: string) => void; first: boolean }) {
  const v = pushRunView(run);
  const [open, setOpen] = useState(false);
  const when = (iso: string) => `${dayLabel(iso, tz)} ${clock(iso, tz)}`;
  const pct = v.total ? Math.round((v.done / v.total) * 100) : 0;
  return (
    <li className="flex min-w-0 flex-col gap-2 px-5 py-3" data-push-run={run.id} data-state={run.state}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 text-body">
          <span className="font-bold text-fg-heading">{run.dryRun ? 'Dry run' : 'Push'}</span>
          <span className="text-muted">
            {' '}
            · {when(run.at)} · {v.total} {v.total === 1 ? 'item' : 'items'}
            {run.finishedAt ? ` · ended ${clock(run.finishedAt, tz)}` : v.lastAt ? ` · last item ${clock(v.lastAt, tz)}` : ''}
          </span>
        </span>
        <StatusBadge tone={v.tone} icon={v.active ? 'sync' : v.tone === 'success' ? 'check' : v.tone === 'danger' ? 'error' : v.tone === 'warning' ? 'warning' : 'info'}>
          {v.status}
        </StatusBadge>
      </div>
      {v.active ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={v.total} aria-valuenow={v.done} aria-label={`${v.done} of ${v.total} done`}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {v.active && first ? <p className="text-caption text-muted">You can leave this page: it keeps going. New pushes wait until it ends (VDP takes one at a time, so each new id reaches the items that need it).</p> : null}
      {run.state === 'stopped' ? <p className="text-caption text-fg">The worker stopped before this push ended (a restart or its time limit). What landed stays; tick the rest and push again: nothing is made twice.</p> : null}
      {v.problems.length ? <Problems nodes={v.problems} onDraft={onDraft} /> : null}
      <div>
        <button type="button" aria-expanded={open} onClick={() => setOpen((x) => !x)} className="inline-flex items-center gap-1.5 text-caption font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none" data-testid="push-run-items-toggle">
          <Icon name={open ? 'chevrondown' : 'chevronright'} size="xs" />
          {open ? 'Hide the items' : `Show the ${v.total} ${v.total === 1 ? 'item' : 'items'}`}
        </button>
        {open ? <Items nodes={run.nodes} onDraft={onDraft} /> : null}
      </div>
    </li>
  );
}

const SHOWN_PROBLEMS = 5;

/** What needs you: failed and not-pushed items, with why. */
function Problems({ nodes, onDraft }: { nodes: VdpPushNode[]; onDraft: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? nodes : nodes.slice(0, SHOWN_PROBLEMS);
  return (
    <div className="min-w-0 rounded-md border border-line bg-surface-muted" data-testid="push-run-problems">
      <div role="grid" aria-label="Items that need you" className="px-1">
        {shown.map((n) => (
          <NodeRow key={n.key} n={n} onDraft={onDraft} />
        ))}
      </div>
      {nodes.length > SHOWN_PROBLEMS ? (
        <button type="button" onClick={() => setAll((x) => !x)} className="px-3 py-2 text-caption font-bold text-link hover:underline">
          {all ? 'Show fewer' : `Show all ${nodes.length} that need you`}
        </button>
      ) : null}
    </div>
  );
}

/** Every item in push order, by company. */
function Items({ nodes, onDraft }: { nodes: readonly VdpPushNode[]; onDraft: (id: string) => void }) {
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2" data-testid="push-run-items">
      {byCompany(nodes).map((g) => (
        <div key={g.company} className="min-w-0 rounded-md border border-line">
          <p className="border-b border-line px-3 py-1.5 text-caption font-bold text-fg-heading">{g.company}</p>
          <div role="grid" aria-label={`Items at ${g.company}`} className="px-1">
            {g.nodes.map((n) => (
              <NodeRow key={n.key} n={n} onDraft={onDraft} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One pushed item, an ActionRow: what it did, how it ended (the badge), why (failed in the danger colour), its Outbox item. */
function NodeRow({ n, onDraft }: { n: VdpPushNode; onDraft: (id: string) => void }) {
  const s = pushNodeState(n);
  return (
    <ActionRow
      id={n.key}
      data-push-node={n.key}
      data-state={n.state}
      title={n.title}
      titleNode={
        <span className="font-normal text-fg">
          <span className="text-muted">{pushOpLabel(n.op)} · </span>
          {n.title}
        </span>
      }
      edge={n.state === 'failed' ? 'danger' : 'none'}
      badge={<StatusBadge tone={s.tone}>{s.text}</StatusBadge>}
      why={n.detail ? <span className={n.state === 'failed' ? 'text-danger-700' : undefined}>{n.detail}</span> : undefined}
      whyTitle={n.detail ?? undefined}
      verb={n.draftId ? { label: 'Details', onClick: () => onDraft(n.draftId!) } : null}
      onOpen={n.draftId ? () => onDraft(n.draftId!) : undefined}
    />
  );
}
