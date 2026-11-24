'use client';
/**
 * Activity (/activity): its slice of the one Needs-you queue (01 R1, D-86: time to log, DCs to claim, VDP changes,
 * use cases to add; src/components/needs) on To log (list or week), the tabs that are about what waits on you. The
 * slice sits under the page's sentence and tabs, as the first section inside the page's scroll (ActivityNeedsSlot in
 * src/components/time/ActivityHead.tsx), never fixed above the header. It reads GET /needs, so its count is the
 * sidebar's and Home's; the sections below keep their own fixing tools (pickers, bulk set, the push tree).
 */
import { useSearchParams } from 'next/navigation';
import { usePersona } from '@/client/persona';
import { ACTIVITY_KINDS } from '@/components/needs/model';
import { NeedsQueue } from '@/components/needs/NeedsQueue';
import { ActivityNeedsSlot } from '@/components/time/ActivityHead';
import { TimePage } from '@/components/time/TimePage';
import { resolveActivityRoute } from '@/components/time/views';

export function ActivityPage() {
  const params = useSearchParams();
  // p3-activity-review: the queue sits on To log (list or week), never on the Review page, History or VDP
  const route = resolveActivityRoute(params, usePersona());
  const showNeeds = route.view === 'log' && !route.review;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="activity-page">
      <ActivityNeedsSlot value={showNeeds ? <NeedsQueue surface="activity" kinds={ACTIVITY_KINDS} title="Needs you here" cap={3} /> : null}>
        <div className="min-h-0 flex-1">
          <TimePage />
        </div>
      </ActivityNeedsSlot>
    </div>
  );
}
