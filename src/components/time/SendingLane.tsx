'use client';
/**
 * Lane 3, Sending (D-102; 2026-11-23 activity-at-scale AX-5, AX-6, §3.1 lane 3, chunk C6). Replaces "On its way to
 * Org62" and the quarter card's not-in-Org62 strip: a batch's life and its failures in one place.
 *
 *   header      SENDING · 2 batches · 14.5 h   ▲ 2 not found
 *   a batch     ● Batch 21 Nov · 14 rows · 14.5 h   Staged · Applied · Sent · Checked 4 of 6   [its next action]  ›
 *               its not-found rows under it, one line each: red ▲ + the plain reason, Log again ▾ Leave out (D-65)
 *   failed      a red batch line with its one fix (Apply again, Review it, Re-check Org62)
 *   finished    not here: "Finished this week: 3 batches ▸ History"
 *
 * No new write path. Review & apply / Apply again / Review it open the batch's review in the details panel (D-52, the
 * same panel as the Outbox: preview, confirm, dry run); "Send to Org62 via Slackbot" copies its Slackbot prompt (the
 * user pastes it; nothing is sent from here) and queues the Org62 re-checks; "Re-check Org62" reads Org62 now (read
 * only). The chevron (and a click on the batch's name) opens the batch in the details panel: its rows and its writes
 * exactly as sent (D-70). Log again / Leave out are RelogActions' `useRelog`.
 *
 * C7 mounts it in LanePage: pass `header={false}` and use `sendingLaneHeader(model.header)` for the lane's header.
 */
import { useMemo } from 'react';
import type { ActivityEntry, LogCanvas } from '@/contract';
import type { LaneHeader } from '@/components/kit';
import { RowGrid } from '@/components/kit';
import { usePersona } from '@/client/persona';
import { useDetails } from '@/components/deals/context-frame';
import { copySlackbotPrompt, usePromptWording } from '@/components/domain/ResultLinks';
import { AppLink } from '@/components/shell/AppLink';
import { Button, cn, Icon } from '@/ui';
import { CompactActivityRow } from './CompactActivityRow';
import { failureReason } from './compact-derive';
import { canvasPrompt, fmtH, type LoggingGap } from './derive';
import { useCanvasCheck } from './Q4Log';
import { useRelog } from './RelogActions';
import { NEXT_LABEL, sendingCount, sendingFailure, sendingOf, type SendingBatch, type SendingModel } from './sending-derive';
import { hrefForView } from './views';

/** The lane's header for LanePage (C7): "Sending", its count and the red ▲ failure mark. */
export function sendingLaneHeader(h: SendingModel['header']): LaneHeader {
  return { title: 'Sending', count: sendingCount(h), failure: sendingFailure(h) ?? undefined };
}

export interface SendingLaneProps {
  /** GET /time's `logCanvases` (every batch, in flight and finished). */
  canvases?: readonly LogCanvas[] | null;
  /** The rows Org62 lacks after their batch ran (path.needs' `org62` group). */
  notFound: readonly ActivityEntry[];
  /** Monday of this week (YYYY-MM-DD), for "Finished this week". */
  weekStart?: string | null;
  tz?: string;
  /** Rows still on their way or not found (`unsettledIds`): a batch with all its rows checked or settled is History's. */
  unsettled?: ReadonlySet<string>;
  /** Open a row in the details panel (useRowNav's openRow). */
  onOpenRow: (id: string) => void;
  /** Draw the lane's own header (default); false when LanePage draws it. */
  header?: boolean;
  /** The lane's anchor (old links and counts land here). */
  id?: string;
  /** Approved hours Org62 has not confirmed 12 h after they ended (derive.ts loggingGap): one quiet line. */
  gap?: Pick<LoggingGap, 'unconfirmedH' | 'unconfirmedRows'> | null;
}

function Steps({ b }: { b: SendingBatch }) {
  return (
    <ol className="flex min-w-0 flex-wrap items-center gap-x-1 text-caption tabular-nums" aria-label="Where it is" data-testid="sending-steps">
      {b.steps.map((s, i) => (
        <li key={s.id} className="inline-flex items-center gap-1" data-step={s.id} data-state={s.state}>
          {i > 0 ? (
            <span aria-hidden className="text-muted">
              ·
            </span>
          ) : null}
          <span className={cn(s.state === 'current' ? 'rounded-sm bg-accent px-1.5 font-bold text-on-accent' : s.state === 'problem' ? 'font-bold text-danger-700' : s.state === 'done' ? 'text-fg' : 'text-muted')}>{s.label}</span>
          <span className="sr-only">{s.state === 'done' ? ': done' : s.state === 'current' ? ': now' : s.state === 'problem' ? ': needs you' : ': not yet'}</span>
        </li>
      ))}
    </ol>
  );
}

interface BatchActions {
  open: (c: LogCanvas) => void;
  send: (c: LogCanvas) => void;
  recheck: (c: LogCanvas) => void;
  checkingId: string | null;
}

function BatchLine({ b, a, onOpenRow, tz }: { b: SendingBatch; a: BatchActions; onOpenRow: (id: string) => void; tz?: string }) {
  const relog = useRelog();
  const c = b.canvas;
  const bad = !!b.failure;
  const run = () => (b.next === 'send' ? a.send(c) : b.next === 'recheck' ? a.recheck(c) : a.open(c));
  return (
    <li className={cn('min-w-0 border-b border-line last:border-b-0', bad && 'bg-surface-muted')} data-testid="sending-batch" data-canvas-id={c.draftId} data-canvas-state={c.state} data-failed={bad ? 'true' : undefined} data-checked={b.checked ? `${b.checked.n}/${b.checked.of}` : undefined}>
      <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <span aria-hidden className={cn('shrink-0 font-bold', bad ? 'text-danger-700' : 'text-accent')}>
          {bad ? '▲' : '●'}
        </span>
        <button type="button" onClick={() => a.open(c)} className={cn('min-w-0 text-left text-body font-bold hover:underline focus-visible:shadow-focus focus-visible:outline-none', bad ? 'text-danger-700' : 'text-fg-heading')} title="Open it: its rows and its writes as sent" data-testid="sending-batch-title">
          {b.label}
        </button>
        <span className="text-caption text-muted tabular-nums">{b.counts}</span>
        {b.notFound.length ? (
          <span className="text-caption font-bold text-danger-700 tabular-nums" data-testid="sending-batch-notfound">{`▲ ${b.notFound.length} not found`}</span>
        ) : null}
        <Steps b={b} />
        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
          {b.next ? (
            <Button size="sm" variant={b.next === 'recheck' && !bad ? 'quiet' : 'secondary'} onClick={run} loading={b.next === 'recheck' && a.checkingId === c.draftId} title={b.next === 'send' ? 'Copies this batch’s Slackbot prompt; paste it to Slackbot yourself (nothing is sent from here)' : b.next === 'recheck' ? 'Read Org62 for this batch now (read only)' : undefined} data-testid="sending-next" data-next={b.next}>
              {NEXT_LABEL[b.next]}
            </Button>
          ) : (
            <span className="text-caption text-muted">Applying…</span>
          )}
          <button type="button" onClick={() => a.open(c)} aria-label={`Open ${b.label}`} title="Open it in the details panel" className="inline-grid size-7 place-items-center rounded-sm text-muted hover:bg-surface hover:text-fg focus-visible:shadow-focus focus-visible:outline-none" data-testid="sending-batch-open">
            <Icon name="chevronright" size="xs" />
          </button>
        </span>
        {b.failure ? (
          <p className="basis-full pl-6 text-caption font-bold text-danger-700" data-testid="sending-batch-failure">
            {b.failure}
          </p>
        ) : null}
      </div>
      {b.notFound.length ? (
        <RowGrid label={`${b.label}: not found in Org62`} className="pl-6">
          {b.notFound.map((e) => (
            <NotFoundRow key={e.id} e={e} tz={tz} onOpenRow={onOpenRow} relog={relog} />
          ))}
        </RowGrid>
      ) : null}
    </li>
  );
}

function NotFoundRow({ e, tz, onOpenRow, relog }: { e: ActivityEntry; tz?: string; onOpenRow: (id: string) => void; relog: ReturnType<typeof useRelog> }) {
  return (
    <CompactActivityRow
      e={e}
      settle={1}
      tz={tz}
      failure={failureReason(e)}
      verb={{ label: 'Log again', onClick: () => relog.run(e, 'log_again'), disabled: relog.busy, title: 'Back on the list to log: the next batch takes it', testId: 'sending-log-again' }}
      menu={[{ id: 'leave_out', label: 'Leave out', icon: 'close', onClick: () => relog.run(e, 'leave_out'), disabled: relog.busy, title: 'Dismiss it: it is never logged', testId: 'sending-leave-out' }]}
      onOpen={onOpenRow}
    />
  );
}

export function SendingLane({ canvases, notFound, weekStart, tz, unsettled, onOpenRow, header = true, id = 'time-runs', gap }: SendingLaneProps) {
  const persona = usePersona();
  const wording = usePromptWording();
  const { open: openPanel } = useDetails();
  const { check, busy } = useCanvasCheck();
  const model = useMemo(() => sendingOf({ canvases, notFound: [...notFound], weekStart, tz, unsettled }), [canvases, notFound, weekStart, tz, unsettled]);
  const a: BatchActions = {
    open: (c) => openPanel({ kind: 'draft', id: c.draftId, label: 'Logging batch' }),
    send: (c) => void copySlackbotPrompt(canvasPrompt(c, wording), c.title).then((ok) => {
      if (ok) void check(c, 'copied');
    }),
    recheck: (c) => void check(c, 'now'),
    checkingId: busy,
  };
  const h = model.header;
  const failure = sendingFailure(h);
  const relog = useRelog();
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="min-w-0 scroll-mt-4 rounded-lg bg-surface" data-testid="sending-lane">
      {header ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-3 pt-3 pb-2">
          <h2 id={`${id}-h`} className="text-caption font-bold tracking-wide text-fg-heading uppercase">
            Sending
          </h2>
          <span className="text-caption text-muted tabular-nums" data-testid="sending-count">
            {sendingCount(h)}
          </span>
          {failure ? (
            <span className="text-caption font-bold text-danger-700 tabular-nums" data-testid="sending-failed">{`▲ ${failure}`}</span>
          ) : null}
        </div>
      ) : (
        <h2 id={`${id}-h`} className="sr-only">
          Sending
        </h2>
      )}
      {model.batches.length ? (
        <ul className="min-w-0 border-t border-line" aria-label="Batches on their way to Org62">
          {model.batches.map((b) => (
            <BatchLine key={b.canvas.draftId} b={b} a={a} onOpenRow={onOpenRow} tz={tz} />
          ))}
        </ul>
      ) : (
        <p className="border-t border-line px-3 py-3 text-caption text-muted">Nothing on its way. Logging the ready rows starts a batch here.</p>
      )}
      {model.orphans.length ? (
        <div className="min-w-0 border-t border-line" data-testid="sending-earlier">
          <p className="px-3 pt-2 text-caption font-bold text-danger-700">{`▲ Earlier batches · ${model.orphans.length} not found`}</p>
          <RowGrid label="Earlier batches: not found in Org62" className="pl-6">
            {model.orphans.map((e) => (
              <NotFoundRow key={e.id} e={e} tz={tz} onOpenRow={onOpenRow} relog={relog} />
            ))}
          </RowGrid>
        </div>
      ) : null}
      {gap?.unconfirmedRows ? (
        <p className="border-t border-line px-3 py-2 text-caption text-muted tabular-nums" data-testid="sending-unconfirmed">
          {`${fmtH(gap.unconfirmedH)} not checked in Org62 yet (${gap.unconfirmedRows} ${gap.unconfirmedRows === 1 ? 'row' : 'rows'} ended over 12 h ago)`}
        </p>
      ) : null}
      {model.finishedThisWeek ? (
        <p className="border-t border-line px-3 py-2 text-caption text-muted" data-testid="sending-finished">
          {`Finished this week: ${model.finishedThisWeek} ${model.finishedThisWeek === 1 ? 'batch' : 'batches'} `}
          <AppLink href={hrefForView('history', persona)} className="font-bold text-link hover:underline" data-testid="sending-history">
            ▸ History
          </AppLink>
        </p>
      ) : null}
    </section>
  );
}
