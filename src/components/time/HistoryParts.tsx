'use client';
/**
 * History's rows, its finished batches and its corrections (./history-derive.ts is the model).
 *
 *   HistoryRow          one compact line per row (Activity-at-scale C8, §3.4): when, title, hours, then where it went
 *                       and its state: its Org62 record ("Org62 00U…", a link when the app has one), why it was left
 *                       out, "Waiting on you in To log", or, for a row on a batch still in To log ▸ Sending, a quiet
 *                       "in batch 21 Nov" linking to that lane (in-flight progress is told once, there). Undo: Take it
 *                       out of the batch while the batch waits for Apply; once a done row can't be taken back, Undo
 *                       opens why and the correction to make instead.
 *   HistoryBatches      finished batches (every row checked in Org62 or settled), newest first, 8 then Show more, each
 *                       with the quarters its hours landed in (F4: moved off the quarter card); the chevron opens
 *                       the batch in the details panel (its rows and its writes as sent, D-70).
 *   HistoryCorrections  changes to Events already in Org62 (the app noticed a row differs from what was logged):
 *                       suggested, approved or dismissed, each with Dismiss, or Undo to bring a dismissed one back.
 */
import { useState } from 'react';
import type { ActivityEntry } from '@/contract';
import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { toast } from '@/client/toast';
import { useDetails } from '@/components/deals/context-frame';
import { ActionRow } from '@/components/kit';
import { AppLink } from '@/components/shell/AppLink';
import { errorText } from '@/lib/error-text';
import { Button, Icon } from '@/ui';
import { compactHours, compactWhen } from './compact-derive';
import { READBACK_BADGE, readbackState } from './derive';
import { CORRECTION_STATE, correctionOf, historyStateOf, org62RecordOf, undoWindowOf, type FinishedBatch, type InBatch } from './history-derive';
import { EXCLUDED_REASON_LABEL, EXCLUDED_REASON_SHORT, EXCLUDED_WORD } from './log-derive';
import { hrefForAnchor, LOG_ANCHORS } from './views';

/** Take one row out of the batch it waits in (the batch's review: remove, undoable). */
async function takeOut(e: ActivityEntry, draftId: string): Promise<void> {
  try {
    const review = await api('getCanvasReview', { params: { id: draftId } });
    const ev = review.events.find((x) => x.entryId === e.id);
    if (!ev) {
      toast({ key: `undo:${e.id}`, tone: 'info', title: 'It is not in that batch any more', body: 'Nothing to take out.' });
      return;
    }
    const r = await api('removeCanvasRows', { params: { id: draftId }, body: { ifVersion: review.version, keys: [ev.key] } });
    toast({ key: `undo:${e.id}`, tone: 'success', title: `Taken out of the batch: ${e.description || 'the row'}`, body: 'It is back in Ready to log. Nothing was sent.', undo: r.auditId ? { auditId: r.auditId } : undefined });
  } catch (err) {
    toast({ key: `undo:${e.id}`, tone: 'error', title: 'Couldn’t take it out of the batch', body: `${errorText(err)} Nothing was sent.` });
  }
}

const NO_BATCHES: ReadonlyMap<string, InBatch> = new Map();
const LINK = 'shrink-0 font-bold text-link hover:underline';

export interface HistoryRowProps {
  entry: ActivityEntry;
  now: string;
  tz?: string;
  selected: boolean;
  onSelect: (e: ActivityEntry) => void;
  /** Row id → the in-flight batch it rides on (history-derive `inBatchOf`). */
  inBatch?: ReadonlyMap<string, InBatch>;
}

export function HistoryRow({ entry: e, now, tz, selected, onSelect, inBatch = NO_BATCHES }: HistoryRowProps) {
  const persona = usePersona();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = historyStateOf(e, inBatch);
  const rb = st.kind === 'done' ? readbackState(e, now) : null;
  const rec = org62RecordOf(e);
  const undo = st.kind === 'in_batch' ? (st.pending ? undoWindowOf({ ...e, canvasDraftId: st.draftId }) : { state: 'none' as const }) : st.kind === 'done' ? undoWindowOf(e) : { state: 'none' as const };
  const where = e.oppName ?? e.accountName ?? (e.internal ? 'Internal' : 'No opportunity');
  const stamp = e.verifiedAt ? 'In Org62' : e.fromOrg62 ? 'Logged in Org62 (read from there)' : e.loggedAt ? 'Logged' : '';
  const state =
    st.kind === 'excluded' ? (
      <span className="shrink-0 truncate text-muted" title={EXCLUDED_REASON_LABEL[e.excludedReason ?? 'dismissed']}>
        <span className="font-bold">{EXCLUDED_WORD[e.excludedReason ?? 'dismissed']}</span> · <span data-testid="excluded-reason">{EXCLUDED_REASON_SHORT[e.excludedReason ?? 'dismissed']}</span>
      </span>
    ) : st.kind === 'in_batch' ? (
      <AppLink href={hrefForAnchor(LOG_ANCHORS.runs, persona)} className={LINK} title="Where it is: To log ▸ Sending" data-testid="history-in-batch" onClick={(ev) => ev.stopPropagation()}>
        {st.text}
      </AppLink>
    ) : st.kind === 'waiting' ? (
      <AppLink href={hrefForAnchor(LOG_ANCHORS.needs, persona)} className={LINK} data-testid="history-waiting" onClick={(ev) => ev.stopPropagation()}>
        {st.text}
      </AppLink>
    ) : rb === 'unconfirmed' ? (
      // in-flight progress is To log ▸ Sending's to tell (C8): a quiet pointer, never "Unconfirmed" here
      <AppLink href={hrefForAnchor(LOG_ANCHORS.runs, persona)} className={LINK} data-testid="history-in-batch" onClick={(ev) => ev.stopPropagation()}>
        on its way · Sending
      </AppLink>
    ) : rb ? (
      <span className="shrink-0 font-bold text-danger-700">{`▲ ${READBACK_BADGE[rb]}`}</span>
    ) : (
      <span className="shrink-0 text-muted">{stamp}</span>
    );
  return (
    <>
      <ActionRow
        id={e.id}
        data-activity-id={e.id}
        data-row-id={e.id}
        data-compact=""
        data-status={e.status}
        data-state={st.kind}
        density="compact"
        title={e.description || 'Activity row'}
        done={st.kind === 'excluded'}
        lead={compactWhen(e, tz)}
        amount={compactHours(e.durationH)}
        whereLabel={`${where}${e.taskType ? ` · ${e.taskType}` : ''}`}
        where={
          <span className="flex min-w-0 items-center gap-2 text-caption">
            <span className="min-w-0 truncate text-fg" title={[e.oppName, e.accountName].filter(Boolean).join(' · ') || undefined} data-testid={e.internal && !e.oppName ? 'ledger-internal' : undefined}>
              {where}
            </span>
            {state}
            {rec && st.kind === 'done' ? (
              rec.url ? (
                <a href={rec.url} target="_blank" rel="noopener noreferrer" className={`${LINK} tabular-nums`} data-testid="org62-record" onClick={(ev) => ev.stopPropagation()}>
                  {`Org62 ${rec.id}`}
                </a>
              ) : (
                <span className="shrink-0 text-fg tabular-nums" data-testid="org62-record">{`Org62 ${rec.id}`}</span>
              )
            ) : null}
          </span>
        }
        verb={
          undo.state === 'open'
            ? {
                label: 'Undo',
                title: `${undo.label}: ${undo.why}`,
                loading: busy,
                testId: 'history-undo',
                onClick: () => {
                  setBusy(true);
                  void takeOut(e, undo.draftId).finally(() => setBusy(false));
                },
              }
            : undo.state === 'closed'
              ? { label: 'Undo', title: 'Why it can’t be taken back, and what to do instead', testId: 'history-undo', onClick: () => setOpen((v) => !v) }
              : null
        }
        selected={selected}
        onOpen={() => onSelect(e)}
      />
      {open && undo.state === 'closed' ? (
        <div role="row" className="min-w-0 px-10 pb-2">
          <div role="gridcell" className="flex min-w-0 flex-col gap-1.5 text-body" data-testid="history-undo-closed">
            <p className="text-fg">{undo.why}</p>
            <p className="text-muted">{undo.fix}</p>
            {rec?.url ? (
              <a href={rec.url} target="_blank" rel="noopener noreferrer" className="self-start text-caption font-bold text-link hover:underline">
                Open it in Org62 ↗
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

const BATCH_STEP = 8;

/** History ▸ Batches: finished batches, one line each, newest first; 8 then Show more. */
export function HistoryBatches({ batches, onFilter }: { batches: readonly FinishedBatch[]; onFilter: (draftId: string) => void }) {
  const { open: openPanel } = useDetails();
  const [n, setN] = useState(BATCH_STEP);
  if (!batches.length) return null;
  const shown = batches.slice(0, n);
  return (
    <section aria-labelledby="history-batches-h" className="flex min-w-0 flex-col gap-2" data-testid="history-batches">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="history-batches-h" className="text-lead font-bold text-fg-heading">
          Batches
        </h2>
        <span className="text-body text-muted tabular-nums">{batches.length}</span>
        <span className="min-w-0 text-caption text-muted">Finished: every row checked in Org62, logged again or left out. Batches still on their way are in To log ▸ Sending.</span>
      </div>
      <ul className="min-w-0 rounded-lg bg-surface" aria-label="Finished batches">
        {shown.map((b) => (
          <li key={b.canvas.draftId} className="flex min-h-11 min-w-0 items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0" data-testid="history-batch" data-canvas-id={b.canvas.draftId}>
            <span aria-hidden className="shrink-0 font-bold text-success-700">
              ✓
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="min-w-0 truncate text-body text-fg tabular-nums">{b.line}</span>
              {b.landed ? (
                <span className="min-w-0 truncate text-caption text-muted tabular-nums" data-testid="history-batch-landed">
                  {b.landed}
                </span>
              ) : null}
            </span>
            <Button size="sm" variant="quiet" onClick={() => onFilter(b.canvas.draftId)} title="Show its rows below" data-testid="history-batch-rows">
              Its rows
            </Button>
            <button type="button" onClick={() => openPanel({ kind: 'draft', id: b.canvas.draftId, label: 'Logging batch' })} aria-label={`Open ${b.label}`} title="Open it: its rows and its writes as sent" className="inline-grid size-7 shrink-0 place-items-center rounded-sm text-muted hover:bg-surface-muted hover:text-fg focus-visible:shadow-focus focus-visible:outline-none" data-testid="history-batch-open">
              <Icon name="chevronright" size="xs" />
            </button>
          </li>
        ))}
      </ul>
      {batches.length > n ? (
        <Button size="sm" variant="quiet" className="self-start" onClick={() => setN((x) => x + BATCH_STEP)} data-testid="history-batches-more">
          {`Show ${Math.min(BATCH_STEP, batches.length - n)} more`}
        </Button>
      ) : null}
    </section>
  );
}

/** Changes to Events already in Org62: Dismiss, or Undo a dismissal. */
export function HistoryCorrections() {
  const q = useApi('getEventUpdates', undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = (q.data?.updates ?? []).map(correctionOf);
  if (!rows.length) return null;
  const act = async (id: string, action: 'restore' | 'dismiss', title: string) => {
    setBusy(id);
    try {
      await api('patchEventUpdate', { params: { id }, body: { action } });
      toast({ key: `corr:${id}`, tone: 'success', title: action === 'restore' ? `Back: ${title}` : `Dismissed: ${title}`, body: action === 'restore' ? 'It goes in your next batch when you log it.' : 'Org62 keeps its value.', undo: { label: 'Undo', run: async () => void (await api('patchEventUpdate', { params: { id }, body: { action: action === 'restore' ? 'dismiss' : 'restore' } })) } });
    } catch (err) {
      toast({ key: `corr:${id}`, tone: 'error', title: 'Couldn’t change that correction', body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="history-corrections-h" className="flex min-w-0 flex-col gap-2" data-testid="history-corrections">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="history-corrections-h" className="text-lead font-bold text-fg-heading">
          Corrections
        </h2>
        <span className="text-body text-muted tabular-nums">{rows.length}</span>
        <span className="min-w-0 text-caption text-muted">Rows already in Org62 that now say something else here. Each goes to Org62 as a change in your next batch; nothing is sent until you apply it.</span>
      </div>
      <div role="grid" aria-label="Corrections" className="min-w-0 rounded-lg bg-surface px-1">
        {rows.map((c) => (
          <ActionRow
            key={c.id}
            id={c.id}
            data-correction={c.id}
            data-state={c.state}
            title={c.title}
            done={c.state === 'dismissed'}
            dashed={c.state === 'waiting'}
            tint={c.state === 'waiting' ? 'ai' : null}
            why={`${c.what} · ${CORRECTION_STATE[c.state]}`}
            verb={{ label: c.verb.label, loading: busy === c.id, testId: 'correction-verb', onClick: () => void act(c.id, c.verb.action, c.title) }}
          />
        ))}
      </div>
    </section>
  );
}
