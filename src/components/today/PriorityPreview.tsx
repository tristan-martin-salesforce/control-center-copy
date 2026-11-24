'use client';
/**
 * "Preview new ranking" (lane 07 R8, `previewPolicy`-style): a small toggle under Today's date. On, the session shows
 * priority@2's Top 3 next to the list (with each row's place in the list you have now, its two-part why, the capacity
 * in the one wording, the admin block and what Make room would move). Nothing is persisted: the switch lives in this
 * tab's sessionStorage and the read is GET /priority/preview, which writes nothing.
 */
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '@/client/hooks';
import type { PriorityPreview } from '@/contract';
import { Button, cn } from '@/ui';

const KEY = 'cc.today.priorityPreview';

/** Session-only: on for this tab until it closes or the user turns it off (never saved to settings). */
export function usePriorityPreview(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(window.sessionStorage.getItem(KEY) === '1');
    } catch {
      /* storage unavailable: off */
    }
  }, []);
  const toggle = useCallback(() => {
    setOn((v) => {
      const next = !v;
      try {
        if (next) window.sessionStorage.setItem(KEY, '1');
        else window.sessionStorage.removeItem(KEY);
      } catch {
        /* storage unavailable: this render only */
      }
      return next;
    });
  }, []);
  return [on, toggle];
}

export function PreviewToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Button variant="quiet" size="xs" aria-pressed={on} onClick={onToggle} data-priority-preview-toggle className={cn('justify-self-start', on && 'text-ai-700')}>
      {on ? '✦ Previewing new ranking' : 'Preview new ranking'}
    </Button>
  );
}

const moved = (r: PriorityPreview['rows'][number]) => (r.v1Rank === null ? 'new to your list' : r.v1Rank === r.rank ? `same place (#${r.v1Rank})` : `#${r.v1Rank} in your list`);

/** The preview itself; renders nothing while the toggle is off. */
export function PriorityPreviewPanel({ on, onClose }: { on: boolean; onClose: () => void }) {
  const q = useApi('getPriorityPreview', undefined, { enabled: on, staleTime: 30_000 });
  if (!on) return null;
  const p = q.data;
  const same = p ? Math.round(p.agreement3 * 3) : 0;
  return (
    <section aria-label="Preview of the new ranking" data-priority-preview className="grid gap-2 rounded-md border border-ai-200 bg-ai-50 px-3 py-2.5 text-body">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <b className="text-fg-heading">New ranking (preview)</b>
        <span className="text-caption text-muted">{p ? `${p.engineVersion} · ${same} of 3 the same as your list · nothing is saved` : 'Ranking…'}</span>
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onClose}>
          Back to my list
        </Button>
      </div>
      {q.isError ? <p className="text-caption text-muted">The preview didn’t load. Your list is unchanged.</p> : null}
      {p ? (
        <>
          <ol className="grid gap-1.5" data-preview-top>
            {p.rows.slice(0, 3).map((r) => (
              <li key={r.workItemId} className="grid min-w-0 grid-cols-[1.5rem_1fr] gap-x-2" data-preview-row={r.workItemId}>
                <span className="text-body-lg font-bold tabular-nums text-fg-heading">{r.rank}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-fg-heading">{r.title}</span>
                  <span className="block text-caption text-muted">
                    {[r.why.now, r.why.matters].filter(Boolean).join(' · ')}
                    <span className="text-faint"> · {moved(r)}</span>
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-caption text-muted" data-preview-capacity>
            {p.capacity.label ? <b className="text-danger-700">{p.capacity.label}</b> : 'Fits today'}
            {p.makeRoom?.rows.length ? ` · make room: ${p.makeRoom.rows.slice(0, 2).map((x) => x.title).join(', ')}` : ''}
            {p.adminBlock ? ` · ${p.adminBlock.label}` : ''}
          </p>
        </>
      ) : null}
    </section>
  );
}
