'use client';
/**
 * D-70: the landing marks Activity reuses: a record's place in each system ("Org62 ✓ · VDP —") and a list of writes
 * exactly as sent ("update · Duration 2 h → 3 h"), each with its state, its canvas and why it was staged.
 */
import type { Landing, LandingDestination, LandingWrite } from '@/contract';
import { dayLabel } from '@/components/domain/lib/time';
import { cn, StatePill } from '@/ui';

import { landingPill, writeState } from './landing-derive';

export function LandingPill({ dest, landing, size = 'xs' }: { dest: LandingDestination; landing: Pick<Landing, 'state' | 'url'> | null | undefined; size?: 'xs' | 'sm' }) {
  const p = landingPill(dest, landing);
  const pill = <StatePill tone={p.tone} label={p.label} size={size} dashed={p.dashed} icon={false} title={p.title} />;
  return landing?.url ? (
    <a href={landing.url} target="_blank" rel="noreferrer" className="rounded-sm focus-visible:outline-none focus-visible:shadow-focus" data-testid={`landing-${dest}`}>
      {pill}
    </a>
  ) : (
    <span data-testid={`landing-${dest}`}>{pill}</span>
  );
}

/** Both systems of a use case (or one, for a record that lands in one). */
export function LandingPills({ org62, vdp, only }: { org62?: Pick<Landing, 'state' | 'url'> | null; vdp?: Pick<Landing, 'state' | 'url'> | null; only?: LandingDestination }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid="landing-pills">
      {only !== 'vdp' ? <LandingPill dest="org62" landing={org62} /> : null}
      {only !== 'org62' ? <LandingPill dest="vdp" landing={vdp} /> : null}
    </span>
  );
}

export interface WriteListProps {
  writes: readonly LandingWrite[];
  tz?: string;
  /** Show each write's record (a run lists many records); a record's own list leaves it out. */
  showLabel?: boolean;
  /** Show each write's canvas (a record's history spans canvases); a run's own list leaves it out. */
  showCanvas?: boolean;
  /** Open a canvas item (a run) from a write. */
  onCanvas?: (draftId: string) => void;
  empty?: string;
}

/** Writes exactly as sent: what, the fields (before → after for an update), state, canvas, why. */
export function WriteList({ writes, tz, showLabel = true, showCanvas = false, onCanvas, empty = 'No writes yet.' }: WriteListProps) {
  if (!writes.length) return <p className="text-caption text-muted">{empty}</p>;
  return (
    <ul className="min-w-0 divide-y divide-line" data-testid="write-list">
      {writes.map((w) => {
        const st = writeState(w);
        const off = w.state === 'removed' || w.state === 'rejected' || w.state === 'dismissed';
        return (
          <li key={w.id} className={cn('flex min-w-0 flex-col gap-1 py-2', off && 'text-muted')} data-write-op={w.op} data-write-state={w.state}>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              {showLabel ? <span className={cn('min-w-0 font-bold break-words', off ? 'text-muted line-through decoration-1' : 'text-fg')}>{w.label}</span> : null}
              <span className="min-w-0 text-body break-words tabular-nums" data-testid="write-summary">
                {w.summary}
              </span>
              <StatePill tone={st.tone} label={st.label} size="xs" icon={false} dashed={w.state === 'staged' || w.state === 'proposed'} />
            </div>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-caption text-muted">
              <span>{w.destination === 'vdp' ? 'VDP' : 'Org62'}</span>
              {showCanvas && w.draftId ? (
                onCanvas ? (
                  <button type="button" onClick={() => onCanvas(w.draftId!)} className="font-bold text-link hover:underline">
                    {w.draftTitle ?? 'its batch'}
                  </button>
                ) : (
                  <span>{w.draftTitle ?? 'its batch'}</span>
                )
              ) : null}
              <span>{`${w.sentAt ? `sent ${dayLabel(w.sentAt, tz)}` : `staged ${dayLabel(w.createdAt, tz)}`}`}</span>
              {w.reason ? <span className="min-w-0 break-words">{w.reason === 'backfill' ? 'from before landings were kept: its values are the best known' : w.reason}</span> : null}
            </div>
            {w.op === 'create' && w.fields.length > 2 ? (
              <details className="text-caption">
                <summary className="cursor-pointer text-link">Every field it sends</summary>
                <dl className="mt-1 grid grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  {w.fields.map((f) => (
                    <div key={f.field} className="contents">
                      <dt className="text-muted">{f.label}</dt>
                      <dd className="min-w-0 break-words whitespace-pre-wrap text-fg">{f.after ?? '(empty)'}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
