'use client';
/**
 * One History entry (HistoryTab): who changed what, the field-level before → after (four fields, then "+N more
 * fields", caps audit F-13), and its Undo / Redo. Its own file so a test of it doesn't pull the tab's data hooks.
 */
import { useState } from 'react';
import type { AuditEntry } from '@/contract';
import { Button, cn, Icon, StatePill } from '@/ui';
import { actorLabel, actorTone, canUndo, fmtMin } from '../lib/derive';
import { fmtWhen } from '../lib/tz';

const HIDDEN_FIELDS = new Set(['version', 'updatedAt', 'rank', 'score', 'rankReasons', 'priority', 'reevaluating', 'seenAt', 'newEvidenceCount', 'userLockedFields', 'refs']);

export function fmtChangeValue(v: unknown, now: string, tz?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return fmtWhen(v, now, tz, { today: true });
    return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? `${v.length} item${v.length === 1 ? '' : 's'}` : '—';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('youMin' in o && 'agentMin' in o) return `you ${fmtMin(Number(o.youMin))} · agent ${fmtMin(Number(o.agentMin))}`;
    if ('name' in o && typeof o.name === 'string') return o.name;
    if ('reason' in o && typeof o.reason === 'string') return o.reason;
    if (o.type === 'doc') return 'draft body';
    return '…';
  }
  return String(v);
}

/** Changed fields shown per entry before "+N more fields" (caps audit F-13: the rest are one click away). */
const FIELDS_FIRST = 4;

export function HistoryRow({ e, now, tz, onUndo, busy }: { e: AuditEntry; now: string; tz?: string; onUndo: (e: AuditEntry) => void; busy: boolean }) {
  const [allFields, setAllFields] = useState(false);
  const shown = e.changes.filter((c) => !HIDDEN_FIELDS.has(c.field));
  const changes = allFields ? shown : shown.slice(0, FIELDS_FIRST);
  const moreFields = shown.length - changes.length;
  const isUndo = !!e.undoOf;
  return (
    <li className={cn('flex gap-3 border-b border-line py-3 last:border-b-0', e.undoneAt && 'opacity-70')} data-audit-id={e.id}>
      {/* AI actors keep violet (an indicator); you and the scanners are neutral. */}
      <StatePill tone={actorTone(e.actor) === 'ai' ? 'ai' : 'neutral'} label={actorLabel(e.actor)} size="md" className="mt-0.5 w-20 justify-center" />
      <div className="min-w-0 flex-1">
        <p className={cn('text-body text-fg', e.undoneAt && 'line-through decoration-line-strong')}>{e.summary}</p>
        {changes.length ? (
          <dl className="mt-0.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 text-caption">
            {changes.map((c) => (
              <div key={c.field} className="contents">
                <dt className="text-muted">{c.label ?? c.field}</dt>
                <dd className="min-w-0 truncate tabular-nums">
                  <span className="text-muted line-through decoration-line-strong">{fmtChangeValue(c.before, now, tz)}</span>
                  <Icon name="forward" size="xs" className="mx-1 align-[-1px] text-faint" />
                  <span className="text-fg">{fmtChangeValue(c.after, now, tz)}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {moreFields > 0 ? (
          <button type="button" className="mt-0.5 rounded-sm text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus" onClick={() => setAllFields(true)} data-more-fields>
            +{moreFields} more field{moreFields === 1 ? '' : 's'}
          </button>
        ) : null}
        <p className="mt-0.5 text-caption text-faint tabular-nums">
          {fmtWhen(e.at, now, tz, { today: true })}
          {e.undoneAt ? ` · undone ${fmtWhen(e.undoneAt, now, tz)}` : ''}
        </p>
      </div>
      <div className="shrink-0 pt-0.5">
        {canUndo(e) ? (
          <Button size="xs" variant="ghost" icon={isUndo ? 'redo' : 'undo'} loading={busy} onClick={() => onUndo(e)} data-undo={e.id}>
            {isUndo ? 'Redo' : 'Undo'}
          </Button>
        ) : e.undoneAt ? (
          <span className="text-caption text-muted">Undone</span>
        ) : null}
      </div>
    </li>
  );
}
