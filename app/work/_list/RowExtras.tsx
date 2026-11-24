'use client';
/**
 * Things that hang off a Work row without changing it: the why line for Done and Snoozed rows (the
 * resolution reason, involvement, new owner; when it wakes), the inline expansion (Space), and an
 * initiative's purpose beside its section title.
 */
import { AppLink } from '@/components/shell/AppLink';
import type { ReactNode } from 'react';
import type { WorkItem } from '@/contract';
import { resolutionLabel } from '@/components/domain/vocab';
import { useApi } from '@/client/hooks';
import { fmtAgo, fmtClock, fmtDay, SourceChip } from '@/ui';

const INVOLVEMENT: Record<WorkItem['involvement'], string> = {
  owner: 'you own it',
  contributor: 'you contribute',
  watcher: 'you are watching',
  not_involved: 'you are not involved',
};

/** Done tab why line: how it was resolved, who owns it now, and my involvement (R-UI-22). */
export function resolutionWhy(item: WorkItem, now: string): ReactNode {
  const who = item.resolutionDetail?.personName;
  const by = item.resolutionDetail?.inferred ? 'inferred from evidence' : item.doneBy === 'engine' ? 'closed for you' : item.doneBy === 'chat' ? 'closed in chat' : 'closed by you';
  const parts = [
    item.resolution === 'handed_off' && who ? `new owner ${who}` : item.resolution === 'done_by_other' && who ? `by ${who}` : null,
    INVOLVEMENT[item.involvement],
    item.closedReason,
    by,
    item.doneAt ? fmtAgo(item.doneAt, new Date(now)) : null,
  ].filter(Boolean);
  return (
    <span data-testid="resolution-line">
      {/* a done row's badge already says how it ended ("Done by Raj"); a dismissed row's says only "Dismissed" */}
      {item.state === 'done' ? null : (
        <>
          <b className="font-bold text-fg">{resolutionLabel(item.resolution, who)}</b> ·{' '}
        </>
      )}
      {parts.join(' · ')}
      {item.loopedBackIn ? <b className="font-bold text-fg"> · Looped back in: {item.loopedBackIn.byPersonName} asked you directly</b> : null}
    </span>
  );
}

/** Snoozed tab why line: when it wakes. */
export function snoozeWhy(item: WorkItem, tz?: string): ReactNode {
  if (!item.snoozedUntil) return null;
  return (
    <span>
      Wakes{' '}
      <b className="font-bold text-fg tabular-nums">
        {fmtDay(item.snoozedUntil, tz)} {fmtClock(item.snoozedUntil, tz)}
      </b>
      , or sooner if someone asks you directly.
    </span>
  );
}

/** Space: what it's for, the full why and the sources, right under the row (Enter opens Details). */
export function RowExpansion({ item }: { item: WorkItem }) {
  return (
    <div data-testid="row-expansion" className="cc-row-more space-y-2">
      {item.purpose ? (
        <p className="max-w-[68ch]">
          <b className="font-bold text-fg-heading">For:</b> {item.purpose.replace(/^For:\s*/i, '')}
        </p>
      ) : null}
      <p className="max-w-[68ch] text-muted">{item.whyDetail ?? item.why}</p>
      <div className="flex flex-wrap items-center gap-2">
        {item.sources.map((s) => (
          <SourceChip key={`${s.kind}${s.label}`} source={s.kind} href={s.url} label={s.label} />
        ))}
        {item.newEvidenceCount > 0 ? <span className="text-caption font-bold text-fg">{item.newEvidenceCount} new</span> : null}
        <span className="ml-auto text-caption text-muted">Enter opens Details · ⇧Enter the full page</span>
      </div>
    </div>
  );
}

/** An initiative section's purpose (one fetch per visible initiative, cached) and a link to its page. */
export function InitiativeSub({ id }: { id: string }) {
  const q = useApi('getInitiative', { params: { id } }, { staleTime: 5 * 60_000 });
  const purpose = q.data?.initiative.purpose;
  return purpose ? <span title={purpose}>{purpose}</span> : null;
}

export function InitiativeLink({ id }: { id: string }) {
  return (
    <AppLink href={`/initiatives/${id}`} className="inline-flex h-8 items-center rounded-md px-2 text-caption font-bold text-link hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus">
      Open initiative
    </AppLink>
  );
}
