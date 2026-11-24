'use client';
/**
 * Health (UI-SPEC §12, DESIGN-V2 principle 10): calm when everything is fine, loud only when something is broken.
 *
 *   Health   7/8 sources live · dry run                       worker running · $0.64 of $5 today
 *   [loud, only when broken: VDP needs re-auth · what's affected · the command + Copy · Re-auth VDP (the reauth's own label)]
 *   Sources | Scan ledger · Jobs · Errors · Spend              (≥ 56 rem of main)
 *   Sources | Scan ledger · Jobs · Errors | Spend               (≥ 100 rem)
 *   Sources | Scan ledger | Jobs · Errors | Spend               (≥ 140 rem)
 *
 * Width becomes panes; each pane scrolls on its own, the page doesn't. The panes condense by #cc-main's width
 * (`@container main`), so opening the docked panel reflows them the same way. Click or Enter on a source opens it
 * in the panel (`openDetails({kind:'connector'})`); j/k move the selection; Esc closes the panel.
 * Uses the same GET /health as the header dot, so the dot, this page and the panel agree.
 */
import { PriorityLine } from './PriorityLine';
import { AppLink } from '@/components/shell/AppLink';
import { RESOLUTION_SETTINGS_HREF } from './settings-links';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Connector } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands, useKeyBinding, useListKeys } from '@/client/keyboard';
import { useResumeSelection } from '@/client/resume/hooks';
import { clearChatContext, setChatContext } from '@/components/chat';
import { DomainClock } from '@/components/domain';
import { notifyDetailsSpy } from '@/components/agents/actions';
import { useRightPanel } from '@/components/shell/panel';
import { PanelBoundary, PanelError, Skeleton, Tabs, tabPanelProps, useNow, usePanelState, useTimeZone } from '@/ui';
import { useConnectorActions } from './actions';
import { ConnectorList, sortConnectors } from './ConnectorList';
import { useLiveList } from '@/components/lists/live-list';
import { calmLine, healthTier, needsYou, usd, type HealthTier } from './derive';
import { HEALTH_GRID, HealthCalmSkeleton, HealthPane } from './HealthSkeleton';
import { ErrorsTab, JobsTab } from './JobsErrorsTabs';
import { LedgerTab } from './LedgerTab';
import { NeedsYou } from './NeedsYou';
import { FirstScanCard } from './FirstScan';
import { SpendTab } from './SpendTab';
import { SetupTab } from './SetupTab';
import { HealthDown } from './HealthDown';
import { UpdateBanner } from './UpdateBanner';
import { healthPlain } from './plain';
import { setupBadgeCount } from '@/client/health-setup';
import { navigate } from '@/components/shell/router';

type TabId = 'setup' | 'ledger' | 'jobs' | 'errors' | 'spend';
const TAB_IDS: TabId[] = ['setup', 'ledger', 'jobs', 'errors', 'spend'];
const TAB_LABEL: Record<TabId, string> = { setup: 'Setup', ledger: 'Scan ledger', jobs: 'Jobs', errors: 'Errors', spend: 'Spend' };
const SCOPE = 'list:health';

/** Which tabs share the tabbed pane at each width (the rest are panes of their own). Setup is always the first tab. */
const TABBED: Record<HealthTier, TabId[]> = { stack: TAB_IDS, two: TAB_IDS, three: ['setup', 'ledger', 'jobs', 'errors'], four: ['setup', 'jobs', 'errors'] };

/** The page's width (it fills #cc-main), measured so the panes and the tabs agree. */
function useWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [w, setW] = useState(1280);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function HealthPage() {
  const params = useSearchParams();
  const pathname = usePathname();
  const tz = useTimeZone();
  const now = useNow().toISOString();
  const panel = useRightPanel();
  const q = useApi('getHealth'); // live: the health topic (the sidebar's query keeps the 5-minute safety net)
  const scans = useApi('getScans', { query: {} });
  const jobs = useApi('getJobs');
  const events = useApi('getEventLog');
  const actions = useConnectorActions();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tier = healthTier(useWidth(rootRef));
  const tabbed = TABBED[tier];
  const tabParam = params.get('tab') as TabId | null;
  const tab: TabId = tabParam && tabbed.includes(tabParam) ? tabParam : tabbed[0]!;
  const ledgerFilter = params.get('connector') ?? 'all';
  const h = q.data;
  const state = usePanelState('health.connectors', { loading: q.isLoading, error: q.data ? null : q.error, empty: !!h && h.connectors.length === 0 });
  // Sorted (broken first) when the page opens; after that a state change repaints the row in place, never moves it
  // (docs/UX.md "Live updates"). A new source joins at its place.
  const sorted = useMemo(() => (h ? sortConnectors(h.connectors) : undefined), [h]);
  // a short list that is all there is: a new source joins at its place at once, never held behind a pill
  const connectors = useLiveList(sorted, 'health:connectors', { linger: false, burst: Infinity }).items;
  const [selected, setSelected] = useResumeSelection('health');

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) sp.delete(k);
        else sp.set(k, v);
      }
      const qs = sp.toString();
      navigate(`${pathname}${qs ? `?${qs}` : ''}`, { replace: true });
    },
    [params, pathname],
  );
  const setTab = useCallback((t: TabId) => setParams({ tab: t }), [setParams]);

  const openConnector = useCallback(
    (c: Pick<Connector, 'id' | 'label'>) => {
      setSelected(c.id);
      const e = { kind: 'connector' as const, id: c.id, label: `${c.label} connector` };
      notifyDetailsSpy(e);
      panel.openDetails(e);
    },
    [panel, setSelected],
  );
  const openById = useCallback(
    (id: string) => {
      const c = connectors.find((x) => x.id === id);
      if (c) openConnector(c);
    },
    [connectors, openConnector],
  );

  const ids = useMemo(() => connectors.map((c) => c.id), [connectors]);
  const panelId = panel.open && panel.tab === 'details' && panel.entity?.kind === 'connector' ? panel.entity.id : null;
  // A source opened from the URL (?panel=details&item=…&kind=connector) counts as the selection.
  const active = selected && ids.includes(selected) ? selected : panelId && ids.includes(panelId) ? panelId : null;
  const list = useListKeys({
    scope: SCOPE,
    ids,
    activeId: active,
    onActiveChange: (id) => {
      setSelected(id);
      if (panel.open && panel.tab === 'details') openById(id);
    },
    primary: true,
    enabled: state === 'ready',
    onOpen: openById,
    onPrimary: (id) => {
      const c = connectors.find((x) => x.id === id);
      if (!c) return;
      if ((c.state === 'auth_needed' || c.state === 'error') && c.reauth && c.reauth.kind !== 'instructions') actions.reauth.mutate(c);
      else actions.scan.mutate(c);
    },
  });
  useKeyBinding(
    'escape',
    () => {
      // An open panel: let the shell close it (it restores focus to the row).
      if (panel.open) return false;
      if (active) return void setSelected(null);
      return false;
    },
    { scope: SCOPE, enabled: list.active },
  );

  useCommands([
    ...TAB_IDS.map((t, i) => ({ id: `health.tab.${t}`, title: `Health: ${TAB_LABEL[t]}`, group: 'Health', order: i, run: () => (tabbed.includes(t) ? setTab(t) : document.querySelector(`[data-pane="${t}"]`)?.scrollIntoView({ block: 'nearest' })) })),
    ...connectors.map((c) => ({ id: `health.open.${c.id}`, title: `Open connector: ${c.label}`, group: 'Health', keywords: ['connector', 'source', c.id], run: () => openConnector(c) })),
    ...connectors.map((c) => ({ id: `health.scan.${c.id}`, title: `Rescan ${c.label}`, group: 'Health', keywords: ['scan', 'rescan', c.id], run: () => actions.scan.mutate(c) })),
    ...needsYou(connectors)
      .filter((c) => c.reauth && c.reauth.kind !== 'instructions')
      .map((c) => ({ id: `health.reauth.${c.id}`, title: `Re-auth ${c.label}`, group: 'Health', keywords: ['reauth', 'login', c.id], run: () => actions.reauth.mutate(c) })),
  ]);

  const broken = h?.summary.broken[0];
  useEffect(() => {
    if (broken) setChatContext({ kind: 'connector', id: broken.id, label: `${broken.label} connector` });
    return () => clearChatContext({ kind: 'connector', id: broken?.id ?? '' });
  }, [broken]);

  const calm = h ? calmLine(h) : null;
  const dead = jobs.data?.counts.dead ?? 0;
  const unack = events.data?.unacknowledged ?? 0;
  const setupNeeds = setupBadgeCount(h);
  const tabCount = (t: TabId) => (t === 'setup' ? setupNeeds || undefined : t === 'jobs' ? dead || undefined : t === 'errors' ? unack || undefined : undefined);

  const tabPanel = (t: TabId) =>
    t === 'setup' ? (
      <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3 [scrollbar-gutter:stable]">
        <SetupTab h={h} connectors={connectors} actions={actions} />
      </div>
    ) : t === 'ledger' ? (
      <LedgerTab connectors={connectors} filterId={ledgerFilter} onFilter={(id) => setParams({ connector: id === 'all' ? null : id })} onOpenConnector={openById} />
    ) : t === 'jobs' ? (
      <JobsTab />
    ) : t === 'errors' ? (
      <ErrorsTab />
    ) : (
      <SpendTab />
    );

  const tabsPane = (
    <HealthPane className="min-h-[24rem]" data-pane="tabs">
      <div className="shrink-0 px-4 pt-3 pb-2">
        <Tabs label="Health detail" idBase="health" variant="line" value={tab} onChange={setTab} tabs={tabbed.map((t) => ({ value: t, label: TAB_LABEL[t], count: tabCount(t) }))} />
      </div>
      <div {...tabPanelProps('health', tab)} className="flex min-h-0 flex-1 flex-col focus-visible:outline-none">
        {tabPanel(tab)}
      </div>
    </HealthPane>
  );

  return (
    <DomainClock now={now} tz={tz}>
      <div ref={rootRef} className="flex min-h-full flex-col gap-5 px-6 pt-5 pb-6 @min-[56rem]/main:h-full" data-health-root data-tier={tier}>
        {/* The topbar holds the page title (h1); the masthead is the one calm line. */}
        <header className="flex min-w-0 shrink-0 flex-wrap items-baseline gap-x-8 gap-y-1" data-health-head>
          {calm && h ? (
            <p className="min-w-0 text-lead font-bold text-fg-heading" data-health-calm={calm.allLive ? 'all-live' : 'some-broken'}>
              {calm.text}
            </p>
          ) : (
            <HealthCalmSkeleton />
          )}
          {h ? (
            <p className="ml-auto text-caption text-muted tabular-nums">
              worker {h.worker.alive ? (h.worker.blocked ? 'waiting' : 'running') : 'stopped'} · queue {h.worker.queueDepth} · {usd(h.spend.today.usd)} of {usd(h.spend.today.softBudgetUsd)} today
            </p>
          ) : null}
        </header>

        <UpdateBanner />
        {!h && q.error ? <HealthDown fallback={null} onRetry={() => void q.refetch()} /> : null}
        {h ? <NeedsYou h={h} now={now} tz={tz} actions={actions} onOpen={openConnector} panelId={panelId} /> : null}
        {h ? <FirstScanCard fs={h.firstScan} now={now} /> : null}
        {h?.resolutionShadow ? (
          <p className="text-caption text-muted" data-health-resolution-shadow>
            {healthPlain(h.resolutionShadow.line)}{' '}
            <AppLink href={RESOLUTION_SETTINGS_HREF} className="font-bold text-link hover:underline" data-settings-link="closing-engine">
              Change in Settings
            </AppLink>
          </p>
        ) : null}
        {h?.priority ? <PriorityLine p={h.priority} /> : null}

        <PanelBoundary name="health">
          <div
            className={HEALTH_GRID}
            data-health-panes={tier}
          >
            <HealthPane title="Sources" count={connectors.length || undefined} sub={calm?.allLive ? 'all live' : undefined} data-pane="sources">
              {state === 'error' ? (
                <PanelError title="Couldn’t load connectors" error={q.error ?? new Error('Forced error state (dev toolbar)')} onRetry={() => void q.refetch()} />
              ) : state === 'loading' || !h ? (
                <Skeleton variant="row" count={8} />
              ) : (
                <div {...list.containerProps} className="cc-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-2 [scrollbar-gutter:stable]">
                  <ConnectorList connectors={connectors} scans={scans.data?.runs ?? []} now={now} tz={tz} actions={actions} activeId={active} panelId={panelId} rowProps={list.rowProps} onOpen={openConnector} />
                </div>
              )}
            </HealthPane>
            {tier === 'four' ? (
              <HealthPane title="Scan ledger" data-pane="ledger">
                {tabPanel('ledger')}
              </HealthPane>
            ) : null}
            {tabsPane}
            {tier === 'three' || tier === 'four' ? (
              <HealthPane title="Spend" sub="today and 7 days" data-pane="spend">
                <SpendTab />
              </HealthPane>
            ) : null}
          </div>
        </PanelBoundary>
      </div>
    </DomainClock>
  );
}
