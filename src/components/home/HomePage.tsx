'use client';
/**
 * Home (design v2, "Morning paper"): the most important things across every tab and every day, on one
 * screen with no page scroll. Visual target: public/mockups/home-1-briefing.html.
 *
 *   masthead (Home | Plan · date · sentence · "Overbooked: move X" · ahead) → day ribbon → Do now (capacity + 3
 *   cards; the third is "Approve N drafts" when drafts are ready) → Respond chips (./Briefing.tsx)
 *   → Needs you: the one queue grouped (GET /needs, ./HomeNeeds.tsx) → Coming builds · the Admin row
 *   → verb columns (Think ahead + 14-day strip · Log & fix · Chase · Initiatives ≥ wide)
 *   → "That's everything for today." + one status line
 *
 * Home ▸ Plan (`/?view=plan`, `p`): the Today page's own tree inside Home (./HomePlan.tsx).
 *
 * Planning ahead: `/?day=next` shows the next working day (the toggle on the masthead's date line; late in the day a
 * quiet "Plan tomorrow →" suggests it, Home never switches by itself). "Move to …" (s) sends an item to the working
 * day after the one shown.
 *
 * Data: GET /home (?wide=1 at ≥ 2,400 px: 5 rows per column; ?day=next). It refreshes when items, outbox, health,
 * today or briefs change (useLiveFollow over HOME_LIVE_TOPICS), and right after a time it shows comes due (a meeting
 * starts). Fresh data goes through the live layer (./live.ts, docs/UX.md "Live updates"): what is on screen keeps its
 * place, arrivals are marked, rows done elsewhere fade out. Click or Enter opens Details in the right
 * panel; j/k move the selection and the filled button follows it; ⌘K lists every Home action.
 */
import { keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { HomeAheadDay, HomeCard, HomeDay, HomePayload, HomeSection, LiveTopic } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands, useFocusedCommands, useKeyBinding, useKeyScope, type Command } from '@/client/keyboard';
import { queryKey } from '@/client/api';
import { SAFETY_NET_MS, useLiveFollow, useRefetchAtBoundaries } from '@/client/live';
import { useArrivalHold, useSelectionSurvives } from '@/components/lists/live-list';
import { useRightPanel, type PanelEntity } from '@/components/shell';
import { navigate } from '@/components/shell/router';
import { DomainClock } from '@/components/domain';
import { useDraftQueueSource } from '@/components/detail/lib/draft-queue';
import { LivePill, PanelBoundary, PanelError, syncServerNow, useNow, usePanelState } from '@/ui';
import { HomeViewProvider, type HomeView } from './ctx';
import { DayRibbon } from './DayRibbon';
import { DoNow } from './DoNow';
import { HomeEnd } from './HomeEnd';
import { AdminRow, ComingBuilds, MoveItLine, RespondStrip } from './Briefing';
import { HomeNeeds } from './HomeNeeds';
import { HomePlan, homeModeOf, useSetHomeMode, ViewToggle, type HomeMode } from './HomePlan';
import { DoNowSkeleton, HomeSkeleton, SectionSkeleton } from './HomeSkeleton';
import { dayInSentence, Masthead } from './Masthead';
import { cardKey, closedInPlace, holdsOpen, homeTargets, openKeyFor, type ClosedInPlace, type HomeTarget } from './model';
import { SectionColumn } from './Sections';
import { useHomeActions } from './useHomeActions';
import { useLiveHome } from './live';
import './home.css';

export { HomeSkeleton } from './HomeSkeleton';

export const HOME_SCOPE = 'page:home';

/** Topics whose changes can move anything on Home (client-side fan-out onto the `home` topic). */
export const HOME_LIVE_TOPICS: ReadonlySet<LiveTopic> = new Set<LiveTopic>([
  'items',
  'item',
  'today',
  'outbox',
  'draft',
  'nba',
  'health',
  'briefs',
  'calendar',
  'agents',
  'time',
  'deals',
  'triage',
  'initiative',
  'settings',
  'since',
]);

const WIDE_QUERY = '(min-width: 2400px)';
const subscribeWide = (fn: () => void) => {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
};
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/** Spy seam for smoke tests: `window.__ccOpenDetails` sees every Details request Home makes. */
function notifySpy(e: PanelEntity) {
  const spy = (window as { __ccOpenDetails?: (e: PanelEntity) => void }).__ccOpenDetails;
  if (spy) spy(e);
}

const REGION = '[data-home-root]';
function focusState(): 'body' | 'inside' | 'outside' {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el || el === document.body || el === document.documentElement) return 'body';
  return el.closest(REGION) || el.closest('#cc-sheet-host,#cc-detail-dock') ? 'inside' : 'outside';
}
function useHomeFocus() {
  const [s, setS] = useState<'body' | 'inside' | 'outside'>('body');
  useEffect(() => {
    const up = () => setS(focusState());
    const later = () => setTimeout(up, 0);
    up();
    document.addEventListener('focusin', up);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', up);
      document.removeEventListener('focusout', later);
    };
  }, []);
  return s;
}

const itemRefOf = (t: HomeTarget | null | undefined) => t?.row?.item ?? (t?.card?.now ? { id: t.card.now.item.id, version: t.card.now.item.version } : null);
const entityOf = (t: HomeTarget): PanelEntity => ({ kind: t.entity.kind, id: t.entity.id, label: t.entity.label ?? t.title });

// ---- regions (each honors its own forced dev state: empty / loading / error) ------------------------------

function DoNowRegion({ h, kept, onRetry }: { h: HomePayload; kept: readonly ClosedInPlace[]; onRetry: () => void }) {
  const st = usePanelState('home.donow', { empty: !h.doNow.cards.length && !kept.length });
  if (st === 'loading') return <DoNowSkeleton />;
  if (st === 'error') return <PanelError title="Do now failed to load" onRetry={onRetry} compact />;
  if (st === 'empty') return <DoNow h={{ ...h, doNow: { ...h.doNow, cards: [], total: 0, elsewhere: [], elsewhereNote: '' } }} />;
  return <DoNow h={h} kept={kept} />;
}

/**
 * HM-05: cards closed for you while Home is open stay in their slot (tag, reason, Undo). Detected between two server
 * payloads (before the live layer's fade), forgotten when Home unmounts.
 */
function useClosedInPlace(server: HomePayload | undefined): ClosedInPlace[] {
  const prev = useRef<HomeCard[]>([]);
  const [kept, setKept] = useState<ClosedInPlace[]>([]);
  useEffect(() => {
    if (!server) return;
    setKept((k) => {
      const next = closedInPlace(prev.current, server, k);
      return next.length === k.length && next.every((x, i) => x.card.id === k[i]?.card.id) ? k : next;
    });
    prev.current = server.doNow.cards;
  }, [server]);
  return kept;
}

/** Home: the briefing (default) or Home ▸ Plan (`/?view=plan`, the folded Today). */
export function HomePage() {
  const params = useSearchParams();
  const mode = homeModeOf(params);
  const setMode = useSetHomeMode();
  if (mode === 'plan') return <HomePlan onMode={setMode} />;
  return <HomeBriefing onMode={setMode} />;
}

function SectionRegion({ section, strip, onRetry }: { section: HomeSection; strip?: HomeAheadDay[]; onRetry: () => void }) {
  const st = usePanelState(`home.${section.id}`, { empty: !section.rows.length });
  if (st === 'loading') return <SectionSkeleton id={section.id} title={section.title} strip={section.id === 'ahead'} />;
  if (st === 'error')
    return (
      <div className={`hm-sec is-${section.id}`}>
        <PanelError title={`${section.title} failed to load`} onRetry={onRetry} compact />
      </div>
    );
  return <SectionColumn section={st === 'empty' ? { ...section, rows: [], count: 0 } : section} strip={strip} />;
}

/** `/?day=next`: the next working day, planned ahead. Anything else is today. */
export function homeDayHref(d: HomeDay): string {
  return d === 'next' ? '/?day=next' : '/';
}

function HomeBriefing({ onMode }: { onMode: (m: HomeMode) => void }) {
  const wide = useWide();
  const params = useSearchParams();
  const requestedDay: HomeDay = params.get('day') === 'next' ? 'next' : 'today';
  const setDay = useCallback((d: HomeDay) => navigate(homeDayHref(d), { replace: true }), []);
  const input = { query: { wide: wide ? ('1' as const) : ('0' as const), ...(requestedDay === 'next' ? { day: 'next' as const } : {}) } };
  // Push, not polling (docs/UX.md "Live updates"): the topics below, the next time Home shows (a meeting starting),
  // and a 5-minute safety net for what only the clock changes.
  const home = useApi('getHome', input, { placeholderData: keepPreviousData, refetchInterval: SAFETY_NET_MS });
  const homeKey = queryKey('getHome', input);
  useLiveFollow(homeKey, [...HOME_LIVE_TOPICS]);
  useRefetchAtBoundaries(homeKey, home.data);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hold = useArrivalHold(rootRef);
  const [keepKey, setKeepKey] = useState<string | null>(null);
  const { data, live: liveHome } = useLiveHome(home.data, `${requestedDay}:${wide ? 'wide' : ''}`, { hold, keep: keepKey, frozen: home.isPlaceholderData });
  const kept = useClosedInPlace(home.isPlaceholderData ? undefined : home.data);
  const refetch = home.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);
  useEffect(() => syncServerNow(data?.now), [data?.now]);
  const nowMs = useNow(30_000).getTime();
  const panel = useRightPanel();
  const actions = useHomeActions(data?.moveTo ?? null);
  const plan = data?.day === 'next';
  const moveLabel = data?.moveTo?.short ?? 'tomorrow';
  const dayWord = plan && data?.nextDay ? dayInSentence(data.nextDay.label) : 'today';
  const tz = data?.masthead.timezone;

  // ---- selection ----------------------------------------------------------------------------------
  const targets = useMemo(() => homeTargets(data), [data]);
  const byKey = useMemo(() => new Map(targets.map((t) => [t.key, t])), [targets]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = selectedKey && byKey.has(selectedKey) ? selectedKey : null;
  const firstCard = data?.doNow.cards[0] ? cardKey(data.doNow.cards[0]) : null;
  // Any draft of the Outbox card's queue open in Details counts as that card being open.
  const openEntityId = panel.open && panel.tab === 'details' ? (panel.entity?.id ?? null) : null;
  const openKey = useMemo(() => openKeyFor(targets, openEntityId, selected), [targets, openEntityId, selected]);
  const primaryKey = selected ?? firstCard;
  // The row open in the panel stays on screen if it leaves elsewhere (dimmed, the panel says why).
  useEffect(() => setKeepKey(openKey), [openKey]);
  const isLeaving = liveHome.isLeaving;
  const targetKeys = useMemo(() => targets.filter((t) => !isLeaving(t.key)).map((t) => t.key), [targets, isLeaving]);
  useSelectionSurvives(targetKeys, selectedKey, setSelectedKey);
  // The docked DraftPanel pages through the card's whole approval queue ("‹ 3 of 29 ›").
  useDraftQueueSource('home', data?.doNow.cards.find((c) => c.kind === 'outbox')?.draftIds);

  const visibleKeys = useCallback(() => {
    const els = rootRef.current ? [...rootRef.current.querySelectorAll<HTMLElement>('[data-home-key]')] : [];
    return els.filter((el) => el.offsetParent !== null).map((el) => el.dataset.homeKey!);
  }, []);
  const focusKey = useCallback((key: string) => {
    const slot = rootRef.current?.querySelector<HTMLElement>(`[data-home-key="${CSS.escape(key)}"]`);
    const el = slot?.querySelector<HTMLElement>('article[data-item-id]') ?? slot;
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  const openTarget = useCallback(
    (t: HomeTarget, entity?: HomeTarget['entity']) => {
      setSelectedKey(t.key);
      // The Outbox card already showing one of its drafts stays on it (a click on the card, Enter).
      if (!entity && holdsOpen(t, openEntityId)) return;
      const e = entity ? { ...entity, label: entity.label ?? t.title } : entityOf(t);
      notifySpy(e);
      panel.openDetails(e);
    },
    [panel, openEntityId],
  );
  const move = useCallback(
    (delta: number) => {
      const keys = visibleKeys();
      if (!keys.length) return false;
      const active = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-home-key]')?.dataset.homeKey ?? selected;
      const i = active ? keys.indexOf(active) : -1;
      const next = keys[i < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, i + delta))]!;
      setSelectedKey(next);
      requestAnimationFrame(() => focusKey(next));
      // An open Details tab follows the selection (the Outbox card keeps the draft it is on: no snap back to #1).
      const t = byKey.get(next);
      if (panel.open && panel.tab === 'details' && t && !holdsOpen(t, openEntityId)) {
        const e = entityOf(t);
        notifySpy(e);
        panel.openDetails(e);
      }
    },
    [visibleKeys, selected, focusKey, byKey, panel, openEntityId],
  );
  const current = useCallback((): HomeTarget | null => {
    const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-home-key]');
    const k = el?.dataset.homeKey ?? selected ?? firstCard;
    return k ? (byKey.get(k) ?? null) : null;
  }, [selected, firstCard, byKey]);
  const runPrimary = useCallback(
    (t: HomeTarget | null) => {
      const v = t?.card?.verb ?? t?.row?.verb;
      if (!t || !v) return false;
      actions.run(v, { title: t.title, card: t.card, fallbackHref: t.row?.href });
    },
    [actions],
  );
  const doneT = useCallback(
    (t: HomeTarget | null) => {
      const ref = itemRefOf(t);
      if (!t || !ref) return false;
      actions.done(ref, t.title);
    },
    [actions],
  );
  const snoozeT = useCallback(
    (t: HomeTarget | null) => {
      const ref = itemRefOf(t);
      if (!t || !ref) return false;
      actions.snooze(ref, t.title);
    },
    [actions],
  );

  // ---- keys (j/k only move the selection; Enter opens Details; Esc closes) ----------------------------
  const focus = useHomeFocus();
  const live = !!data && focus !== 'outside';
  useKeyScope(HOME_SCOPE, { active: live });
  const kopts = { scope: HOME_SCOPE, enabled: live };
  const onTargetItself = () => {
    const el = document.activeElement as HTMLElement | null;
    return !el || el === document.body || !el.matches('button,a,input,textarea,select');
  };
  useKeyBinding(['j', 'down'], () => move(1), kopts);
  useKeyBinding(['k', 'up'], () => move(-1), kopts);
  useKeyBinding(
    ['1', '2', '3'],
    (e) => {
      const c = data?.doNow.cards[Number(e.key) - 1];
      if (!c) return false;
      setSelectedKey(cardKey(c));
      requestAnimationFrame(() => focusKey(cardKey(c)));
    },
    kopts,
  );
  useKeyBinding(
    'enter',
    () => {
      if (!onTargetItself()) return false;
      const t = current();
      if (!t) return false;
      openTarget(t);
    },
    kopts,
  );
  useKeyBinding('mod+enter', () => runPrimary(current()), kopts);
  useKeyBinding('d', () => doneT(current()), kopts);
  useKeyBinding('s', () => snoozeT(current()), kopts);
  // Home ▸ Plan: the folded Today (the same `p` takes you back from there)
  useKeyBinding('p', () => onMode('plan'), kopts);
  useKeyBinding(
    'escape',
    () => {
      if (panel.open) {
        panel.close();
        return;
      }
      if (selected) {
        setSelectedKey(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      return false;
    },
    kopts,
  );

  // ---- ⌘K --------------------------------------------------------------------------------------------
  const commands: Command[] = useMemo(() => {
    if (!data) return [];
    const list: Command[] = [
      { id: 'home.next', title: 'Home: next item', group: 'Home', shortcut: 'j', run: () => move(1) },
      { id: 'home.prev', title: 'Home: previous item', group: 'Home', shortcut: 'k', run: () => move(-1) },
      {
        id: 'home.details',
        title: 'Home: open details for the selection',
        group: 'Home',
        shortcut: 'enter',
        run: () => {
          const t = current();
          if (t) openTarget(t);
        },
      },
      { id: 'home.primary', title: 'Home: do the selected action', group: 'Home', shortcut: 'mod+enter', run: () => runPrimary(current()) },
      { id: 'home.done', title: 'Home: mark the selection done', group: 'Home', shortcut: 'd', run: () => doneT(current()) },
      { id: 'home.snooze', title: `Home: move the selection to ${moveLabel}`, group: 'Home', shortcut: 's', keywords: ['snooze', 'tomorrow', 'later'], run: () => snoozeT(current()) },
      { id: 'home.refresh', title: 'Home: refresh', group: 'Home', run: retry },
      { id: 'home.plan', title: 'Home: show the plan (day column and run of the day)', group: 'Home', shortcut: 'p', keywords: ['today', 'plan', 'timeline', 'run of day'], run: () => onMode('plan') },
    ];
    if (data.nextDay)
      list.push(
        data.day === 'next'
          ? { id: 'home.day', title: 'Home: back to today', group: 'Home', keywords: ['today', 'plan'], run: () => setDay('today') }
          : { id: 'home.day', title: `Home: plan ${dayInSentence(data.nextDay.label)} (${data.nextDay.short})`, group: 'Home', keywords: ['tomorrow', 'next day', 'plan ahead'], run: () => setDay('next') },
      );
    data.doNow.cards.forEach((c, i) =>
      list.push({
        id: `home.card.${i + 1}`,
        title: `Do now #${i + 1}: ${c.verb.label} · ${c.title}`,
        group: 'Home',
        shortcut: String(i + 1),
        keywords: [c.tag ?? '', 'do now'],
        run: () => actions.run(c.verb, { title: c.title, card: c }),
      }),
    );
    for (const s of data.sections)
      for (const r of s.rows)
        if (r.kind === 'gap') list.push({ id: `home.row.${r.id}`, title: `${s.title}: ${r.verb.label} · ${r.title}`, group: 'Home', run: () => actions.run(r.verb, { title: r.title, fallbackHref: r.href }) });
    list.push({
      id: 'home.outbox',
      title: 'Home: review drafts in the Outbox',
      group: 'Home',
      keywords: ['approve', 'drafts'],
      run: () => actions.run({ label: 'Review', action: 'review', href: '/outbox', targetId: null }, { title: 'Outbox' }),
    });
    return list;
  }, [data, move, current, openTarget, runPrimary, doneT, snoozeT, retry, actions, moveLabel, setDay, onMode]);
  useCommands(commands, { enabled: !!data });
  const sel = selected ? byKey.get(selected) : undefined;
  const selVerb = sel?.card?.verb ?? sel?.row?.verb;
  useFocusedCommands(
    sel ? { label: sel.title, kind: sel.entity.kind } : null,
    sel
      ? [
          ...(selVerb ? [{ id: 'home.sel.verb', title: selVerb.label, shortcut: 'mod+enter', run: () => runPrimary(sel) }] : []),
          { id: 'home.sel.details', title: 'Open details', shortcut: 'enter', run: () => openTarget(sel) },
          ...(itemRefOf(sel)
            ? [
                { id: 'home.sel.done', title: 'Mark done', shortcut: 'd', run: () => doneT(sel) },
                { id: 'home.sel.snooze', title: `Move to ${moveLabel}`, shortcut: 's', run: () => snoozeT(sel) },
              ]
            : []),
        ]
      : [],
  );

  // ---- render -----------------------------------------------------------------------------------------
  const pageState = usePanelState('home', { loading: home.isLoading, error: !data ? home.error : null });
  const view: HomeView = useMemo(
    () => ({ tz, nowMs, primaryKey: openKey && openKey === primaryKey ? null : primaryKey, selectedKey: selected, openKey, openEntityId, panelOpen: panel.open, select: setSelectedKey, openTarget, target: (k: string) => byKey.get(k), actions, moveLabel, moveAt: data?.moveTo?.startsAt ?? null, liveOf: liveHome.liveOf }),
    [tz, nowMs, openKey, openEntityId, primaryKey, selected, panel.open, openTarget, byKey, actions, moveLabel, data?.moveTo?.startsAt, liveHome.liveOf],
  );

  if (pageState === 'error' || (!data && home.isError)) {
    return (
      <div className="cc-home" data-home-root data-state="error">
        <PanelError title="Home couldn’t load" error={home.error ?? new Error('Forced error state (dev toolbar)')} onRetry={retry} />
      </div>
    );
  }
  if (pageState === 'loading' || !data) return <HomeSkeleton />;

  const stale = home.isError ? { onRetry: retry } : null;
  return (
    <HomeViewProvider value={view}>
      <DomainClock now={new Date(nowMs).toISOString()} tz={tz}>
      <div ref={rootRef} className="cc-home" data-home-root data-state={pageState} data-wide={data.wide ? '1' : '0'} data-day={data.day} aria-busy={data.day !== requestedDay || undefined}>
        <LivePill count={liveHome.held.length} onShow={liveHome.showHeld} placement="overlay" />
        {actions.launchDialog}
        <PanelBoundary name="home.masthead" onRetry={retry}>
          <Masthead m={data.masthead} nowMs={nowMs} stale={stale} day={data.day} next={data.nextDay} requested={requestedDay} onDay={setDay} viewToggle={<ViewToggle mode="home" onMode={onMode} />}>
            {data.moveIt ? <MoveItLine m={data.moveIt} actions={actions} /> : null}
          </Masthead>
        </PanelBoundary>
        <PanelBoundary name="home.ribbon" onRetry={retry}>
          <DayRibbon r={data.ribbon} tz={tz} nowMs={nowMs} plan={plan ? (data.nextDay?.label ?? 'The next day') : null} />
        </PanelBoundary>
        <PanelBoundary name="home.donow" onRetry={retry}>
          <DoNowRegion h={data} kept={kept} onRetry={retry} />
        </PanelBoundary>
        {/* phase 3: drafts and replies as chips (the Outbox row is where they are approved); it replaces Reply & approve */}
        <PanelBoundary name="home.respond" onRetry={retry}>
          <RespondStrip r={data.respond} />
        </PanelBoundary>
        {/* 01 R1 / D-86: the one Needs-you queue (GET /needs), grouped: Today open, the other groups folded */}
        <PanelBoundary name="home.needs" onRetry={retry}>
          <section className="hm-panel" aria-label="Needs you" data-home-panel="needs">
            <HomeNeeds className="px-4 py-3" />
          </section>
        </PanelBoundary>
        {data.builds.length || data.admin ? (
          <PanelBoundary name="home.builds" onRetry={retry}>
            <div className="flex min-w-0 flex-col gap-2">
              <ComingBuilds builds={data.builds} actions={actions} />
              {data.admin ? <AdminRow a={data.admin} /> : null}
            </div>
          </PanelBoundary>
        ) : null}
        <section className="hm-panel hm-sections" aria-label="Everything else, by verb">
          {data.sections.filter((s) => s.id !== 'reply').map((s) => (
            <PanelBoundary key={s.id} name={`home.${s.id}`} onRetry={retry} fallbackClassName={`hm-sec is-${s.id}`}>
              <SectionRegion section={s} strip={s.id === 'ahead' ? data.aheadStrip : undefined} onRetry={retry} />
            </PanelBoundary>
          ))}
        </section>
        <PanelBoundary name="home.footer" onRetry={retry}>
          <HomeEnd f={data.footer} day={dayWord} />
        </PanelBoundary>
      </div>
      </DomainClock>
    </HomeViewProvider>
  );
}
