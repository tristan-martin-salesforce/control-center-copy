'use client';
/**
 * The rundown of opps when unsure (the attribution engine, GET /attribution/rundown): a Time row's likely opps, ranked,
 * each with stage, close, whether it is mine or a covered AE's, and what I did on it in the last 4 weeks. One click logs
 * the row to it (a correction the engine learns from); nothing is typed.
 */
import type { ActivityEntry } from '@/contract';
import { useApi } from '@/client/hooks';
import { Button, Skeleton } from '@/ui';
import { useFeature } from '@/client/persona';
import { oppOwnerWord, recentWork } from './dc-derive';
import { pct } from './rows-derive';

export function OppRundown({ e, onPick }: { e: ActivityEntry; onPick: (oppId: string) => void }) {
  const q = useApi('getOppRundown', { query: { entryId: e.id } });
  const dc = useFeature('dealContributions');
  if (q.isLoading) return <Skeleton variant="block" className="h-16 w-full" />;
  const opps = q.data?.opps ?? [];
  if (!opps.length) return <p className="text-caption text-muted">No likely opportunity in the app yet: pick one, or search Org62 in the picker.</p>;
  return (
    <ul className="grid min-w-0 gap-1 rounded-md border border-line bg-surface p-2" data-testid="opp-rundown" data-no-open>
      {opps.map((o) => (
        <li key={o.oppId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 py-1">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-fg">{o.name}</span>
            <span className="block text-caption text-muted">
              {[o.accountName, o.stage, o.closeDate ? `closes ${o.closeDate}` : null, oppOwnerWord(o, dc), recentWork(o)].filter(Boolean).join(' · ')}
            </span>
            {o.why ? <span className="block text-caption text-ai-700">{`${o.why}${o.confidence ? ` · ${pct(o.confidence)}` : ''}`}</span> : null}
          </span>
          <Button size="xs" variant="secondary" onClick={() => onPick(o.oppId)} data-testid="rundown-pick">
            Log it here
          </Button>
        </li>
      ))}
    </ul>
  );
}
