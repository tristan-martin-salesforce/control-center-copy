'use client';
/**
 * Work (UI-SPEC §2, §12; design v2): everything I owe, as calm verb sections of two-line rows.
 *
 *   one sentence ("3 due today of 34 open") ·························· 3 of 34 · j k move · ↵ details
 *   ┌ tabs · search · filters · By when / By initiative ─────────────────────────────────────────────┐
 *   │ Due today 3 · Do this week 9 · Chase 2 · Think ahead 6 · Fit in 14   (3 rows each, See all N →)  │
 *   └ That's everything. ────────────────────────────────────────────────────────────────────────────┘
 *
 * Detail lives in the docked right panel: click or Enter calls openDetails({kind: 'work_item'}); an open
 * Details tab follows j/k; Esc closes it. ⇧Enter opens the full page. Row keys: d done · s snooze · e edit
 * (Details) · o source · ⇧D resolve · x batch · Space expand. A batch is explicit: the bar's Apply (⌘↵)
 * plus one Undo. Live updates never reorder rows under the cursor: new rows append with "n new below".
 */
import { keepPreviousData } from '@tanstack/react-query';
import { AppLink } from '@/components/shell/AppLink';
import { FillingIn } from '@/components/shell/FillingIn';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SourceRef, WorkItem, WorkTab } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands, useFocusedCommands, useKeyBinding, useListKeys } from '@/client/keyboard';
import { useResumeExtra, useResumeScroll, useResumeSelection } from '@/client/resume';
import { useChatContext } from '@/components/chat';
import { DomainClock, originSource, StatusBadge, WorkRow, type WorkRowActionKey } from '@/components/domain';
import { openDeepLink } from '@/components/detail/nba/ClaudeLaunchPanel';
import { FilterChip, SearchField } from '@/components/lists/controls';
import { useArrivalHold, useSelectionSurvives } from '@/components/lists/live-list';
import { ResolveDialog, SnoozeDialog } from '@/components/lists/dialogs';
import { FOCUS_SUB, groupByFocus, groupByInitiative, shownCount, type Group } from '@/components/lists/grouping';
import { focusItemSoon, neighbourOf, useOpenKeys, usePageClock, useStableList, useUrlFilters } from '@/components/lists/hooks';
import { ListEnd, ListFrame, SelectionPosition, StaleRefresh } from '@/components/lists/ListFrame';
import { ListSection, SectionAction } from '@/components/lists/ListSection';
import { PAGE_SIZE } from '@/components/lists/paging';
import { useFollowWhenGone, useListPanel, useWide } from '@/components/lists/panel';
import {
  activeFilterCount,
  clearFilters,
  DEFAULT_FILTERS,
  parseWorkFilters,
  serializeWorkFilters,
  type WorkFilters,
  type WorkGrouping,
} from '@/components/lists/url-filters';
import { useBulkApply } from '@/components/lists/useBulkApply';
import { useItemActions } from '@/components/lists/useItemActions';
import { SourceKind, WorkKind } from '@/contract';
import { Banner, Button, EmptyState, LivePill, PanelBoundary, PanelError, SegmentedToggle, Tabs, usePanelState } from '@/ui';
import { BulkBar } from './BulkBar';
import { MoreRow, usePageCount, useShowMore, windowQuery } from './MoreRow';
import { InitiativeLink, InitiativeSub, resolutionWhy, RowExpansion, snoozeWhy } from './RowExtras';
import { WORK_TAB_LABEL, WORK_TABS, WorkListSkeletonBody } from './WorkSkeleton';
import { navigate } from '@/components/shell/router';
import { looksDoneEvidence } from '@/engines/home/looks-done';

const TAB_LABEL = WORK_TAB_LABEL;
const TABS = WORK_TABS;

const SOURCE_LABEL: Record<string, string> = { slack: 'Slack', gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', gemini: 'Gemini notes', org62: 'Org62', vdp: 'VDP', claude: 'Claude', manual: 'Manual' };
const KIND_LABEL: Record<string, string> = { task: 'Task', commitment: 'Said by me', ask: 'Asked of me', training: 'Training', follow_up: 'Follow-up', travel: 'Travel', deliverable: 'Deliverable' };

const EMPTY_COPY: Record<WorkTab, { title: string; body: string }> = {
  all_open: { title: 'Nothing open', body: 'Everything you owe is done or snoozed. New asks and promises land in Triage first.' },
  said_by_me: { title: 'No commitments open', body: 'Things you said you would do show up here once you accept them from Triage.' },
  asked_of_me: { title: 'No open asks', body: 'When someone asks you for something, it appears here after you accept it.' },
  promises: { title: 'No old promises', body: 'Background commitments that have aged out of the Top 3 collect here.' },
  trainings: { title: 'No trainings due', body: 'Trailhead and field-readiness courses appear here when they are assigned.' },
  snoozed: { title: 'Nothing snoozed', body: 'Snoozed items come back on their own at the time you chose.' },
  done: { title: 'Nothing closed yet', body: 'Items you finish, hand off or close appear here with the reason.' },
};

/** The flat tabs are one list: what you asked for by picking the tab, shown in full. */
const FLAT_TITLE: Partial<Record<WorkTab, string>> = { done: 'Closed', snoozed: 'Snoozed' };

export function WorkPage() {
  const clock = usePageClock();
  return (
    <DomainClock now={clock.now} tz={clock.tz}>
      <PanelBoundary name="work">
        <WorkInner now={clock.now} tz={clock.tz} />
      </PanelBoundary>
    </DomainClock>
  );
}

interface Section extends Group<WorkItem> {
  title: string;
  sub?: ReactNode;
  shown: number;
  rows: WorkItem[];
}

function WorkInner({ now, tz }: { now: string; tz?: string }) {
  const { value: f, committed, update } = useUrlFilters<WorkFilters>({ parse: parseWorkFilters, serialize: serializeWorkFilters });
  const resetKey = serializeWorkFilters({ ...committed, group: DEFAULT_FILTERS.group });
  // Closed pages (GET /items limit + cursor): a window of `pages` × 50 rows; a new tab or filter starts at one page.
  const paged = committed.tab === 'done';
  const { pages, setPages } = usePageCount(resetKey, paged);
  const query = useMemo(() => windowQuery(committed, paged, pages), [committed, paged, pages]);
  const list = useApi('listItems', { query }, { placeholderData: keepPreviousData });
  // The unfiltered list for the same tab: "n of m" and the account / initiative options (Closed: its first page).
  const base = useApi('listItems', { query: paged ? { tab: committed.tab, limit: PAGE_SIZE } : { tab: committed.tab } }, { placeholderData: keepPreviousData });
  const [sel, setSel] = useResumeSelection('work');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hold = useArrivalHold(bodyRef);
  const panelEarly = useListPanel();
  // Live (docs/UX.md "Live updates"): arrivals at their place, rows done elsewhere fade, the open one stays.
  // A page of Closed loaded by "Show more" is not an arrival: the window re-takes the server's order then (UX.md: a
  // re-sort waits until you change tab, filter or page); live refetches between keep the merge rules.
  const stable = useStableList(list.data?.items, paged ? `${resetKey}|p${pages}` : resetKey, list.isPlaceholderData, { hold, keep: panelEarly.openId ?? sel });
  const wide = useWide();
  const panel = panelEarly;
  const filtering = activeFilterCount(f) > 0;

  const flat = f.tab === 'done' || f.tab === 'snoozed';
  const groups: Group<WorkItem>[] = useMemo(
    () =>
      flat
        ? [{ key: `flat:${f.tab}`, label: FLAT_TITLE[f.tab] ?? TAB_LABEL[f.tab], entityId: null, items: stable.items }]
        : f.group === 'due'
          ? groupByFocus(stable.items, now, tz)
          : groupByInitiative(stable.items),
    [flat, f.tab, f.group, stable.items, now, tz],
  );
  const [open, setOpen] = useResumeExtra('open-sections', {} as Record<string, boolean>);
  const sections: Section[] = useMemo(
    () =>
      groups.map((g) => {
        // A search or filter shows every match; a flat tab shows everything; otherwise 3 (5 when wide).
        // the row you are on stays in view when arrivals land above it
        const pinId = panel.openId ?? sel;
        const pin = pinId ? g.items.findIndex((i) => i.id === pinId) : -1;
        const shown = Math.max(shownCount(g.items.length, { expanded: flat || filtering || !!open[g.key], wide }), pin + 1);
        const focusKey = g.key.startsWith('focus:') ? (g.key.slice(6) as keyof typeof FOCUS_SUB) : null;
        return {
          ...g,
          title: g.label,
          sub: focusKey ? FOCUS_SUB[focusKey] : g.entityId ? <InitiativeSub id={g.entityId} /> : undefined,
          shown,
          rows: g.items.slice(0, shown),
        };
      }),
    [groups, open, wide, flat, filtering, panel.openId, sel],
  );
  const leaving = stable.isLeaving;
  const ids = useMemo(() => sections.flatMap((s) => s.rows.map((i) => i.id)).filter((id) => !leaving(id)), [sections, leaving]);
  const allIds = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)).filter((id) => !leaving(id)), [groups, leaving]);
  const byId = useMemo(() => new Map(stable.items.map((i) => [i.id, i] as const)), [stable.items]);

  const explicit = !!sel && ids.includes(sel);
  const activeId = explicit ? sel : (ids[0] ?? null);
  const active = activeId ? (byId.get(activeId) ?? null) : null;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<WorkItem | null>(null);
  const [resolveFor, setResolveFor] = useState<WorkItem | null>(null);
  const actions = useItemActions();
  const bulk = useBulkApply();

  const more = useShowMore({ data: list.data, placeholder: list.isPlaceholderData, paged, filters: committed, pages, setPages });

  const searchRef = useRef<HTMLInputElement | null>(null);
  useResumeScroll(bodyRef, 'work-list');
  useChatContext(active && { kind: 'work_item', id: active.id, label: active.title });

  // A new tab or filter is a new list: the batch and the expansion don't carry over.
  useEffect(() => {
    setChecked(new Set());
    setExpandedRow(null);
  }, [resetKey]);

  const state = usePanelState('work.list', { loading: list.isLoading, error: list.isError && !list.data, empty: !list.isLoading && stable.items.length === 0 });

  // ---- selection and the docked panel -------------------------------------------------------
  const entity = useCallback((it: WorkItem) => ({ kind: 'work_item' as const, id: it.id, label: it.title }), []);
  const select = useCallback(
    (id: string) => {
      setSel(id);
      const it = byId.get(id);
      if (it) panel.follow(entity(it));
    },
    [byId, entity, panel, setSel],
  );
  const openDetails = useCallback(
    (id: string) => {
      setSel(id);
      const it = byId.get(id);
      if (it) panel.open(entity(it));
    },
    [byId, entity, panel, setSel],
  );
  const openPage = useCallback((id: string) => navigate(`/work/${id}`), []);
  // Done or snoozed from the panel's own footer: the item leaves the list and Details moves on to its neighbour.
  useFollowWhenGone(ids, panel.openId, select, resetKey, { goneTitle: 'Changed elsewhere', goneBody: 'This item left the list while you had it open (done, snoozed or moved somewhere else).', nextLabel: 'Next item' });
  useSelectionSurvives(allIds, explicit ? sel : null, setSel);
  const land = useCallback(
    (fromId: string) => {
      const next = neighbourOf(ids, fromId);
      if (next) {
        select(next);
        focusItemSoon(bodyRef.current, next);
      }
    },
    [ids, select],
  );
  const openSource = useCallback((item: WorkItem, source?: SourceRef) => {
    const url = (source ?? originSource(item.sources))?.url;
    if (url) openDeepLink(url);
  }, []);
  const canAct = f.tab !== 'done';
  const toggleCheck = useCallback((id: string) => setChecked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id]))), []);

  const run = useCallback(
    (key: WorkRowActionKey, item: WorkItem) => {
      if (key === 'select') return toggleCheck(item.id);
      if (key === 'edit') return openDetails(item.id);
      if (key === 'open_source') return openSource(item);
      if (!canAct) return;
      if (key === 'done') {
        land(item.id);
        actions.done(item);
      } else if (key === 'snooze') setSnoozeFor(item);
      else if (key === 'resolve') setResolveFor(item);
    },
    [actions, canAct, land, openDetails, openSource, toggleCheck],
  );
  // LD-1: a likely-done row's two answers. Confirm closes it (it leaves); Not done moves it back among the open work.
  const confirmDone = useCallback(
    (item: WorkItem) => {
      land(item.id);
      actions.confirmDone(item);
    },
    [actions, land],
  );
  const notDone = useCallback((item: WorkItem) => actions.notDone(item), [actions]);
  const runOn = useCallback(
    (key: WorkRowActionKey) => (id: string) => {
      const item = byId.get(id);
      if (item) run(key, item);
    },
    [byId, run],
  );

  const lk = useListKeys({
    scope: 'list:work',
    ids,
    // The explicit selection only: the first j selects the first row (as on Home).
    activeId: explicit ? activeId : null,
    primary: true,
    moveFocus: false,
    onActiveChange: (id) => {
      select(id);
      focusItemSoon(bodyRef.current, id);
    },
    actions: {
      d: runOn('done'),
      s: runOn('snooze'),
      e: runOn('edit'),
      o: runOn('open_source'),
      'shift+d': runOn('resolve'),
      x: (id) => toggleCheck(id),
      n: (id) => {
        const it = byId.get(id);
        if (it?.state === 'likely_done' && canAct) notDone(it);
      },
    },
  });

  useOpenKeys({ scope: 'list:work', enabled: lk.active, activeId, onOpen: openDetails, onOpenPage: openPage, onExpand: (id) => setExpandedRow((e) => (e === id ? null : id)) });
  useKeyBinding(
    'escape',
    () => {
      if (panel.close()) {
        focusItemSoon(bodyRef.current, activeId);
        return;
      }
      if (checked.size) return setChecked(new Set());
      return false;
    },
    { scope: 'list:work', enabled: lk.active },
  );
  useKeyBinding('/', () => searchRef.current?.focus(), { description: 'Search the list', group: 'Work' });

  // ---- ⌘K -------------------------------------------------------------------------------------
  useCommands([
    ...TABS.map((t) => ({ id: `work.tab.${t}`, title: `Work: ${TAB_LABEL[t]}`, group: 'View', keywords: ['tab', 'filter'], run: () => update({ tab: t }, { immediate: true }) })),
    { id: 'work.group.due', title: 'Work: group by when (Due today, this week, Chase…)', group: 'View', keywords: ['due', 'focus'], run: () => update({ group: 'due' }, { immediate: true }) },
    { id: 'work.group.initiative', title: 'Work: group by initiative', group: 'View', run: () => update({ group: 'initiative' }, { immediate: true }) },
    { id: 'work.filters.clear', title: 'Work: clear filters', group: 'View', disabled: !activeFilterCount(f), run: () => update((x) => clearFilters(x), { immediate: true }) },
    { id: 'work.search', title: 'Work: search', group: 'View', shortcut: '/', run: () => searchRef.current?.focus() },
  ]);
  useFocusedCommands(
    { label: active?.title ?? 'Work item', kind: 'work_item' },
    active
      ? [
          { id: 'work.open', title: 'Open details', shortcut: 'enter', run: () => openDetails(active.id) },
          { id: 'work.page', title: 'Open full page', shortcut: 'shift+enter', run: () => openPage(active.id) },
          ...(panel.detailsOpen ? [{ id: 'work.close', title: 'Close details', shortcut: 'escape', run: () => void panel.close() }] : []),
          ...(canAct
            ? [
                { id: 'work.done', title: 'Mark done', shortcut: 'd', keywords: ['complete', 'archive'], run: () => run('done', active) },
                { id: 'work.snooze', title: 'Snooze…', shortcut: 's', run: () => run('snooze', active) },
                { id: 'work.resolve', title: 'Resolve…', shortcut: 'shift+d', keywords: ['hand off', 'duplicate', 'not needed'], run: () => run('resolve', active) },
              ]
            : []),
          { id: 'work.select', title: checked.has(active.id) ? 'Take out of the batch' : 'Add to the batch', shortcut: 'x', keywords: ['select', 'bulk'], run: () => toggleCheck(active.id) },
          { id: 'work.expand', title: expandedRow === active.id ? 'Collapse the row' : 'Expand the row', shortcut: 'space', run: () => setExpandedRow((e) => (e === active.id ? null : active.id)) },
          ...(active.sources.some((s) => s.url) ? [{ id: 'work.source', title: 'Open source', shortcut: 'o', run: () => openSource(active) }] : []),
        ]
      : [],
  );

  // ---- derived UI --------------------------------------------------------------------------------
  const counts = list.data?.counts ?? base.data?.counts;
  // Closed reads a page at a time: its options come from every row loaded so far
  const optionRows = useMemo(() => (paged ? [...(base.data?.items ?? []), ...(list.data?.items ?? [])] : base.data?.items), [paged, base.data?.items, list.data?.items]);
  const accounts = useMemo(() => uniqueRefs(optionRows, 'account'), [optionRows]);
  const initiatives = useMemo(() => uniqueRefs(optionRows, 'initiative'), [optionRows]);
  const nFiltered = list.data?.total ?? 0;
  const nAll = base.data?.total ?? 0;
  const stale = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of stable.items) if (i.stale) m.set(i.stale.connectorId, i.stale.reason);
    return [...m.values()];
  }, [stable.items]);
  const checkedItems = useMemo(() => [...checked].map((id) => byId.get(id)).filter((i): i is WorkItem => !!i), [checked, byId]);


  const why = (item: WorkItem) => (f.tab === 'done' ? resolutionWhy(item, now) : f.tab === 'snoozed' ? snoozeWhy(item, tz) : item.state === 'likely_done' ? looksDoneEvidence(item) : undefined);
  const rowsOf = (s: Section) =>
    s.rows.map((item) => (
      <Fragment key={item.id}>
        <WorkRow
          item={item}
          // "Open" is the same on every row, so only the selected (or #1) row shows it, filled; the row open
          // in the panel shows none (the panel footer holds its action).
          nbaVerb={item.state === 'likely_done' && canAct ? 'review' : panel.openId !== item.id && (explicit ? activeId === item.id : ids[0] === item.id) ? 'review' : null}
          verbLabel={item.state === 'likely_done' && canAct ? 'Confirm' : 'Open'}
          altVerb={item.state === 'likely_done' && canAct ? { label: 'Not done', title: 'Not finished: back among the open work (n)', onClick: (it) => notDone(it) } : undefined}
          selected={explicit && activeId === item.id}
          emphasis={!explicit && ids[0] === item.id}
          inPanel={panel.openId === item.id}
          live={stable.liveOf(item.id)}
          badge={
            checked.has(item.id) ? (
              <StatusBadge tone="now" icon="check">
                In batch
              </StatusBadge>
            ) : undefined
          }
          why={why(item) ?? undefined}
          onOpen={(it, mode) => (mode === 'page' ? openPage(it.id) : openDetails(it.id))}
          onVerb={(_, it) => (it.state === 'likely_done' && canAct ? confirmDone(it) : openDetails(it.id))}
          onAction={(k, it) => run(k, it)}
          onOpenSource={(src, it) => openSource(it, src)}
          onOpenEntity={(ref) => ref.href && navigate(ref.href)}
        />
        {expandedRow === item.id ? <RowExpansion item={item} /> : null}
      </Fragment>
    ));

  const sectionAction = (s: Section) => {
    if (flat || !canAct) return s.entityId && f.group === 'initiative' ? <InitiativeLink id={s.entityId} /> : null;
    const all = s.items.every((i) => checked.has(i.id));
    const batch = (
      <SectionAction
        onClick={() =>
          setChecked((c) => {
            const next = new Set(c);
            for (const i of s.items) {
              if (all) next.delete(i.id);
              else next.add(i.id);
            }
            return next;
          })
        }
        title={all ? 'Take these out of the batch' : 'Add every row in this section to the batch, then pick what to do with them'}
        testId={`select-${s.key}`}
      >
        {all ? 'Unselect' : 'Select'} {s.items.length}
      </SectionAction>
    );
    return s.entityId && f.group === 'initiative' ? (
      <>
        <InitiativeLink id={s.entityId} />
        {batch}
      </>
    ) : (
      batch
    );
  };

  const doNow = groups.find((g) => g.key === 'focus:do_now')?.items.length ?? 0;
  const chase = groups.find((g) => g.key === 'focus:chase')?.items.length ?? 0;
  const lead = leadFor({ tab: f.tab, n: paged ? nFiltered : stable.items.length, doNow: f.group === 'due' ? doNow : null, chase: f.group === 'due' ? chase : null, filtering, nFiltered, nAll, done: counts?.done ?? 0, overdueTrainings: stable.items.filter((i) => i.training?.overdue).length });
  const cols = sections.length >= 3 ? '3' : sections.length === 2 ? '2' : '1';

  return (
    <>
      <ListFrame
        label="Work"
        data-state={state}
        lead={list.isLoading ? 'Loading everything you owe…' : lead}
        aside={
          <>
            {list.isError && list.data ? <StaleRefresh onRetry={() => void list.refetch()} /> : null}
            <SelectionPosition index={explicit && activeId ? allIds.indexOf(activeId) : -1} total={allIds.length} />
          </>
        }
        bodyRef={bodyRef}
        banner={
          stale.length ? (
            <Banner
              scope="page"
              tone="warn"
              title={/[.!?]$/.test(stale[0]!) ? stale[0]! : `${stale[0]}.`}
              body={stale.length > 1 ? `and ${stale.length - 1} more: items below may be stale.` : 'Items marked ☾ may be stale.'}
              action={
                <AppLink href="/health" className="text-link hover:underline">
                  Open Health
                </AppLink>
              }
            />
          ) : null
        }
        tools={
          <>
            <Tabs
              variant="line"
              tabs={TABS.map((t) => ({ value: t, label: TAB_LABEL[t], count: counts?.[t] }))}
              value={f.tab}
              onChange={(t) => update({ tab: t }, { immediate: true })}
              label="Work tabs"
              idBase="work"
              className="border-b-0 px-4"
            />
            <div role="search" aria-label="Filter work" className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              <SearchField
                ref={searchRef}
                value={f.q}
                placeholder="Search title, purpose, why"
                aria-label="Search work"
                onChange={(e) => update({ q: e.target.value })}
                onClear={() => update({ q: '' })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') (e.target as HTMLElement).blur();
                }}
              />
              <FilterChip label="Account" value={f.account} options={accounts} onChange={(v) => update({ account: v })} />
              <FilterChip label="Initiative" value={f.initiative} options={initiatives} onChange={(v) => update({ initiative: v })} width={340} />
              <FilterChip label="Source" value={f.source} options={SourceKind.options.map((s) => ({ value: s, label: SOURCE_LABEL[s] ?? s }))} onChange={(v) => update({ source: v as WorkFilters['source'] })} width={200} />
              <FilterChip label="Kind" value={f.kind} options={WorkKind.options.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }))} onChange={(v) => update({ kind: v as WorkFilters['kind'] })} width={200} />
              {filtering ? (
                <Button variant="quiet" size="sm" onClick={() => update((x) => clearFilters(x), { immediate: true })} data-testid="clear-filters">
                  Clear filters
                </Button>
              ) : null}
              <span className="ml-auto flex items-center gap-3">
                <span className="text-caption text-muted tabular-nums" data-testid="n-of-m" aria-live="polite">
                  {nFiltered} of {nAll}
                </span>
                {/* a flat tab (Closed, Snoozed) has no grouping: no toggle, rather than both options struck through */}
                {flat ? null : (
                  <SegmentedToggle
                    label="Group by"
                    size="sm"
                    value={f.group}
                    onChange={(g: WorkGrouping) => update({ group: g }, { immediate: true })}
                    options={[
                      { value: 'due', label: 'By when' },
                      { value: 'initiative', label: 'By initiative' },
                    ]}
                  />
                )}
              </span>
            </div>
            {checked.size > 0 ? (
              <BulkBar
                count={checked.size}
                total={ids.length}
                initiatives={initiatives.map((i) => ({ id: i.value, label: i.label }))}
                now={now}
                tz={tz}
                busy={bulk.busy}
                onApply={async (op) => {
                  const items = checkedItems;
                  setChecked(new Set());
                  await bulk.apply(op, items);
                }}
                onClear={() => setChecked(new Set())}
                onSelectAll={() => setChecked(new Set(ids))}
              />
            ) : null}
          </>
        }
      >
        <PanelBoundary name="work.list" onRetry={() => void list.refetch()}>
          {state === 'loading' ? (
            <WorkListSkeletonBody />
          ) : state === 'error' || (list.isError && !list.data) ? (
            <PanelError title="The work list failed to load" error={list.error} onRetry={() => void list.refetch()} />
          ) : state === 'empty' ? (
            filtering ? (
              <EmptyState
                icon="filter"
                title="No items match these filters"
                body={`${nAll} ${TAB_LABEL[f.tab].toLowerCase()} ${nAll === 1 ? 'item is' : 'items are'} hidden by them.`}
                action={
                  <Button variant="secondary" size="sm" onClick={() => update((x) => clearFilters(x), { immediate: true })}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <FillingIn variant="panel">
                <EmptyState icon="task" title={EMPTY_COPY[f.tab].title} body={EMPTY_COPY[f.tab].body} />
              </FillingIn>
            )
          ) : (
            <div
              {...lk.containerProps}
              data-testid="work-list"
              onFocusCapture={(e) => {
                const id = (e.target as HTMLElement).closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
                if (id && id !== sel && ids.includes(id)) select(id);
              }}
              className={list.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
            >
              <LivePill count={stable.held.length} noun={stable.held.length === 1 ? 'new item' : 'new items'} onShow={stable.showHeld} />
              <div className="cc-list-sections" data-cols={cols}>
                {sections.map((s) => (
                  <ListSection
                    key={s.key}
                    data-section={s.key}
                    title={s.title}
                    count={flat ? undefined : s.items.length}
                    sub={s.sub}
                    action={sectionAction(s)}
                    total={s.items.length}
                    shown={s.shown}
                    expanded={!!open[s.key]}
                    onExpand={flat || filtering ? undefined : (v) => setOpen({ ...open, [s.key]: v })}
                    noun={s.items.length === 1 ? 'item' : 'items'}
                  >
                    {rowsOf(s)}
                  </ListSection>
                ))}
              </div>
              {paged && list.data?.nextCursor ? (
                <MoreRow loaded={list.data.items.length} total={list.data.total} busy={more.busy} failed={more.failed} onMore={() => void more.showMore()} />
              ) : (
                <ListEnd>
                  {counts ? (
                    <span className="tabular-nums">
                      {counts.all_open} open · {counts.snoozed} snoozed · {counts.done} done
                    </span>
                  ) : null}
                </ListEnd>
              )}
            </div>
          )}
        </PanelBoundary>
      </ListFrame>

      <SnoozeDialog
        open={!!snoozeFor}
        title={snoozeFor?.title ?? ''}
        now={now}
        tz={tz}
        onClose={() => setSnoozeFor(null)}
        onPick={(until) => {
          if (snoozeFor) {
            land(snoozeFor.id);
            actions.snooze(snoozeFor, until);
          }
          setSnoozeFor(null);
        }}
      />
      <ResolveDialog
        item={resolveFor}
        related={stable.items.map((i) => ({ id: i.id, title: i.title }))}
        onClose={() => setResolveFor(null)}
        onResolve={(v) => {
          if (resolveFor) {
            land(resolveFor.id);
            actions.resolve(resolveFor, v);
          }
          setResolveFor(null);
        }}
      />
    </>
  );
}

/** The page's one sentence: what matters on this tab, bold where it matters. */
function leadFor(x: { tab: WorkTab; n: number; doNow: number | null; chase: number | null; filtering: boolean; nFiltered: number; nAll: number; done: number; overdueTrainings: number }): ReactNode {
  if (x.filtering)
    return (
      <>
        <b>
          {x.nFiltered} of {x.nAll}
        </b>{' '}
        {TAB_LABEL[x.tab].toLowerCase()} {x.nAll === 1 ? 'item matches' : 'items match'} these filters.
      </>
    );
  const n = x.n;
  switch (x.tab) {
    case 'all_open':
      if (!n) return <b>Nothing open.</b>;
      if (x.doNow === null) return <><b>{n} open</b>, by initiative.</>;
      return (
        <>
          {x.doNow ? <b>{x.doNow} due today</b> : <b>Nothing is due today</b>}
          {`, ${n} open in all`}
          {x.chase ? `, ${x.chase} waiting on someone else` : ''}. {x.done ? `${x.done} done.` : ''}
        </>
      );
    case 'said_by_me':
      return <><b>{n} {n === 1 ? 'thing' : 'things'} you said you would do.</b></>;
    case 'asked_of_me':
      return <><b>{n} {n === 1 ? 'ask' : 'asks'}</b> waiting on you.</>;
    case 'promises':
      return <><b>{n} old {n === 1 ? 'promise' : 'promises'}</b>, out of the Top 3 but not forgotten.</>;
    case 'trainings':
      return (
        <>
          <b>
            {n} {n === 1 ? 'training' : 'trainings'}
          </b>{' '}
          assigned{x.overdueTrainings ? `, ${x.overdueTrainings} overdue` : ''}.
        </>
      );
    case 'snoozed':
      return <><b>{n} snoozed.</b> They come back on their own.</>;
    case 'done':
      return <><b>{n} closed</b>, each with the reason it closed.</>;
  }
}

function uniqueRefs(items: WorkItem[] | undefined, key: 'account' | 'initiative'): Array<{ value: string; label: string }> {
  const m = new Map<string, string>();
  for (const i of items ?? []) {
    const r = i.refs[key];
    if (r) m.set(r.id, r.label);
  }
  return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}
