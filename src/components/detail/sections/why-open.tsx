'use client';
/**
 * "Why is this still open?" (H-7, lane 03 §4.2, *north star: Legible*): the resolution check's last decision on this
 * item in plain words (what decided, what it said, what kept it from closing, the line it cited) and what would run the
 * next check, and Undo reopen when you reopened it. In shadow mode it says what the check *would* have done.
 */
import type { ResolutionCheckView } from '@/contract';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic';
import { toast } from '@/client/toast';
import { EmptyState, PanelError, Skeleton, usePanelState } from '@/ui';
import { fmtWhen } from '../lib/tz';

function Check({ c, now, tz, first }: { c: ResolutionCheckView; now: string; tz?: string; first: boolean }) {
  return (
    <li className={first ? 'text-caption text-fg' : 'text-caption text-muted'} data-why-open-check={c.outcome} data-decided-by={c.decidedBy}>
      <time dateTime={c.at} className="text-muted tabular-nums">
        {fmtWhen(c.at, now, tz, { today: true })}
      </time>{' '}
      · {c.why}
      {c.citeUrl ? (
        <>
          {' '}
          <a href={c.citeUrl} target="_blank" rel="noreferrer" className="text-link">
            the line it cited
          </a>
        </>
      ) : null}
    </li>
  );
}

/** "You reopened it" (W0-3): Undo reopen is an undo of your own Undo (POST /audit/:id/undo), so the close stands again. */
function UndoReopen({ undoId }: { undoId: string }) {
  const undo = useOptimisticMutation({
    route: 'undoAudit',
    topics: ['triage', 'today', 'items', 'item'],
    writeBack: false,
    entityId: () => undefined,
    toast: () => ({ title: 'Undid the reopen: it is closed again', key: `why-open:undo:${undoId}` }),
    onError: (err) => toast({ key: `why-open:undo:${undoId}:err`, title: "Couldn't undo the reopen", body: err.code === 'conflict' ? 'It changed since you reopened it.' : err.message, tone: 'error', durationMs: null }),
  });
  return (
    <p className="text-caption text-muted" data-why-open-reopened>
      You reopened it, so the check never closes it for you again.{' '}
      <button type="button" className="text-link" disabled={undo.isPending} onClick={() => undo.mutate({ params: { id: undoId }, body: {} })}>
        Undo reopen
      </button>
    </p>
  );
}

export function WhyOpen({ itemId, now, tz }: { itemId: string; now: string; tz?: string }) {
  const q = useApi('getResolutionCheck', { params: { id: itemId } });
  const state = usePanelState('item.resolution', { loading: q.isLoading, error: q.data ? null : q.error, empty: !!q.data && !q.data.last });
  if (state === 'loading') return <Skeleton count={2} className="py-2" />;
  if (state === 'error') return <PanelError title="The last check failed to load" error={q.error} onRetry={() => void q.refetch()} compact />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <div className="space-y-2" data-why-open={d.mode}>
      {state === 'empty' || !d.last ? (
        <EmptyState size="panel" icon="search" title="Not checked yet" body={d.nextCheck} />
      ) : (
        <>
          {d.mode === 'shadow' ? <p className="text-micro text-faint">Shadow: the check only records; the current closers still act.</p> : null}
          <ul className="space-y-1.5">
            {[d.last, ...d.history].map((c, i) => (
              <Check key={`${c.at}-${i}`} c={c} now={now} tz={tz} first={i === 0} />
            ))}
          </ul>
          {d.reopenUndoId ? <UndoReopen undoId={d.reopenUndoId} /> : null}
          <p className="text-caption text-muted" data-why-open-next>
            Next check: {d.nextCheck}
          </p>
        </>
      )}
    </div>
  );
}
