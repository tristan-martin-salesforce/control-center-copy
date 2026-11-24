'use client';
/**
 * Activity (D-87): three tabs in plain words, plus Forecast for the AE (./views.ts).
 *
 *   To log   ./ToLogView.tsx: what the app can log for me, by day, with what needs me on top; a List / Week toggle;
 *            "Review N to log" opens the Review page (./ReadyLane.tsx at full width): ticks, then one "Log N · h".
 *   History  ./ActivityLogView.tsx: what was logged (the quarter as a report, then its rows with their Org62 record,
 *            Undo while it can be taken back) and the corrections (./HistoryCorrections.tsx).
 *   VDP      ./VdpView.tsx: the changes staged and applied, what autopilot did; My VDPs is a filter.
 *   Forecast ./ForecastView.tsx, only for a persona with Specialist Forecast (the AE's default).
 *
 * Old `?view=` links land on the nearest of these (views.ts LEGACY_VIEWS): the URL is replaced, and an anchor scrolls
 * To log to the section the old view was. `/activity?draft=<id>` opens that batch or VDP change in the docked panel.
 */
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { usePersona } from '@/client/persona';
import { ContextPage, useDetails } from '@/components/deals/context-frame';
import { useContextPanels } from '@/components/deals/register-panels';
import { DomainClock } from '@/components/domain';
import { FeatureInactive } from '@/components/shell/FeatureInactive';
import { navigate } from '@/components/shell/router';
import { SegmentedToggle, Skeleton, useNow, useTimeZone } from '@/ui';
import { ActivityHead } from './ActivityHead';
import { ActivityLogView } from './ActivityLogView';
import { ActivityTabs } from './ActivityTabs';
import { ForecastView } from './ForecastView';
import { ToLogView } from './ToLogView';
import { VdpView } from './VdpView';
import { hrefForVdpSub, resolveActivityRoute, viewAccess, type ActivityView, type VdpSub } from './views';

export { ACTIVITY_VIEWS } from './views';
export { ActivityTabs } from './ActivityTabs';

/** VDP's filter: every change, or only My VDPs (who is on each, its use cases and assets). */
function VdpFilter({ sub }: { sub: VdpSub }) {
  const persona = usePersona();
  return (
    <SegmentedToggle<VdpSub>
      label="Show"
      className="self-start"
      value={sub}
      onChange={(s) => navigate(hrefForVdpSub(s, persona))}
      options={[
        { value: 'changes', label: 'Changes' },
        { value: 'mine', label: 'My VDPs' },
      ]}
    />
  );
}

/**
 * `/activity?draft=<id>` (the Outbox's pointer, the Assistant's links) opens that batch or VDP change in the docked
 * panel, on a fresh load or an in-app navigation, then drops the param so a reload doesn't reopen it.
 */
function useDraftParam() {
  const params = useSearchParams();
  const pathname = usePathname();
  const { open } = useDetails();
  const draft = params.get('draft');
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || handled.current === draft) return;
    handled.current = draft;
    open({ kind: 'draft', id: draft });
    const url = new URL(window.location.href);
    url.searchParams.delete('draft');
    window.history.replaceState(window.history.state, '', `${pathname}${url.search}${url.hash}`);
  }, [draft, open, pathname]);
}

/** An old link: replace it with where it lands now (Back never returns to the old URL). */
function useLegacyRedirect(redirect: string | null) {
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);
}

export function TimePage() {
  const params = useSearchParams();
  const persona = usePersona();
  const route = resolveActivityRoute(params, persona);
  useContextPanels();
  useDraftParam();
  useLegacyRedirect(route.redirect);
  const tz = useTimeZone();
  const now = useNow().toISOString();
  let body: ReactNode;
  if (route.view === 'history') body = <ActivityLogView now={now} tz={tz} tabs={<ActivityTabs view="history" />} />;
  else if (route.view === 'forecast')
    body = (
      <GatedView view="forecast">
        <ForecastView tabs={<ActivityTabs view="forecast" />} />
      </GatedView>
    );
  else if (route.view === 'vdp')
    body = (
      <GatedView view="vdp">
        <VdpView
          sub={route.sub}
          tabs={
            <div className="flex min-w-0 flex-col gap-3">
              <ActivityTabs view="vdp" />
              <VdpFilter sub={route.sub} />
            </div>
          }
        />
      </GatedView>
    );
  else body = <ToLogView route={route} />;
  return (
    <DomainClock now={now} tz={tz}>
      {body}
    </DomainClock>
  );
}

/**
 * A view that belongs to a persona feature: the view once the persona has it; a neutral frame while the persona loads
 * (no VDP words for someone without VDP); otherwise that the feature is available to turn on.
 */
function GatedView({ view, children }: { view: ActivityView; children: ReactNode }) {
  const access = viewAccess(view, usePersona());
  if (access.state === 'show') return <>{children}</>;
  return (
    <ContextPage label="Activity">
      <ActivityHead tabs={<ActivityTabs view={view} />} sentence={access.state === 'loading' ? 'Loading…' : undefined} />
      {access.state === 'loading' ? <Skeleton variant="block" className="h-96 w-full" /> : <FeatureInactive feature={access.feature} icon="clock" />}
    </ContextPage>
  );
}
