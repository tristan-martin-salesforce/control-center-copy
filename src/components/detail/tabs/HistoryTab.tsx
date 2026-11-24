'use client';
/**
 * History (UI-SPEC §12, R-UI-18): the item's audit log with an Undo per change set, who made it
 * (you · chat · engine · scanner), the field-level before → after, and the NBA versions.
 * Undoing an undo is redo.
 */
import { useState } from 'react';
import type { NbaVersionEntry } from '@/contract';
import { useApi } from '@/client/hooks';
import { EmptyState, PanelError, Skeleton, usePanelState } from '@/ui';
import { useUndoAudit } from '../lib/mutations';
import { fmtWhen } from '../lib/tz';
import { GroupLabel } from '../panel/bits';
import { HistoryRow } from './HistoryRow';

export { fmtChangeValue, HistoryRow } from './HistoryRow';

function Versions({ versions, now, tz }: { versions: NbaVersionEntry[]; now: string; tz?: string }) {
  if (!versions.length) return null;
  return (
    <section aria-label="NBA versions" className="mt-4">
      <GroupLabel count={versions.length}>Next-step versions</GroupLabel>
      <ol className="mt-1.5 space-y-1.5">
        {[...versions]
          .sort((a, b) => b.version - a.version)
          .map((v) => (
            <li key={v.version} className="flex gap-2 text-caption">
              <span className="w-8 shrink-0 font-bold text-fg tabular-nums">v{v.version}</span>
              <span className="w-24 shrink-0 text-muted tabular-nums">{fmtWhen(v.at, now, tz, { today: true })}</span>
              <span className="min-w-0 text-body text-fg">
                {v.reason}
                {v.diffSummary ? <span className="block text-caption text-muted">{v.diffSummary}</span> : null}
              </span>
            </li>
          ))}
      </ol>
    </section>
  );
}

export function HistoryTab({ itemId, now, tz }: { itemId: string; now: string; tz?: string }) {
  const q = useApi('getItemHistory', { params: { id: itemId } });
  const undo = useUndoAudit();
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const state = usePanelState('item.history', { loading: q.isLoading, error: q.data ? null : q.error, empty: !!q.data && !q.data.entries.length && !q.data.nbaVersions.length });
  if (state === 'loading') return <Skeleton variant="row" count={5} />;
  if (state === 'error') return <PanelError title="History failed to load" error={q.error} onRetry={() => void q.refetch()} compact />;
  if (state === 'empty' || !q.data) return <EmptyState size="panel" icon="undo" title="No changes yet" body="Every change from you, chat, engines or scanners lands here with Undo." />;
  return (
    <div data-history>
      {undo.error ? (
        <p role="alert" className="mb-2 rounded-md bg-danger-50 px-2.5 py-1.5 text-caption text-danger-700">
          Couldn&apos;t undo: {undo.error.message}{' '}
          <button type="button" className="font-bold hover:underline" onClick={undo.retry}>
            Retry
          </button>
        </p>
      ) : null}
      <ul aria-label="Change history">
        {q.data.entries.map((e) => (
          <HistoryRow key={e.id} e={e} now={now} tz={tz} busy={undoingId === e.id}
            onUndo={(x) => {
              setUndoingId(x.id);
              void undo
                .mutateAsync({ params: { id: x.id }, body: {} })
                .catch(() => undefined)
                .finally(() => setUndoingId(null));
            }}
          />
        ))}
      </ul>
      <Versions versions={q.data.nbaVersions} now={now} tz={tz} />
    </div>
  );
}
