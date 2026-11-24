'use client';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { navigate } from '@/components/shell/router';
import { Tabs } from '@/ui';
import { timeBadges } from './badges';
import { activityTabsFor, hrefForView, type ActivityView } from './views';

/**
 * The one row of tabs: To log (what needs me there) · History · VDP (its changes waiting) · Forecast (the AE's). A
 * gated tab stays hidden while the persona loads and when it is not active; its link says it can be turned on.
 */
export function ActivityTabs({ view, toLog }: { view: ActivityView; toLog?: number }) {
  const persona = usePersona();
  const today = useApi('getToday'); // live: the today topic
  const b = timeBadges(today.data?.navCounts);
  const n = (x: number | undefined) => (x && x > 0 ? x : undefined);
  const count: Partial<Record<ActivityView, number | undefined>> = { log: n(toLog), vdp: n(b.vdp), forecast: n(b.forecast) };
  const tabs = activityTabsFor(persona).map((t) => ({ ...t, count: count[t.value] }));
  return <Tabs<ActivityView> label="Activity views" idBase="activity-view" variant="line" value={view} onChange={(v) => navigate(hrefForView(v, persona))} tabs={tabs} />;
}
