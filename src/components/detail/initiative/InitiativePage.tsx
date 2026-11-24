'use client';
/**
 * /initiatives/[id] (UI-SPEC §2, §12, R-UI-20): what the workstream is for, its living summary, the child
 * tasks grouped by state (Enter opens the task's details, ⇧Enter the page), and around it the people,
 * account and opportunity, assets, Claude sessions and the timeline.
 *
 * v2 (DESIGN-V2): calm, 16 px base, sentence-case headings, no object tiles, color only as an indicator
 * (status words carry their own glyph; accounts, people and sources are neutral). Width becomes panes:
 * two columns from ~1,000 px of content, three at ≥ 140rem (2,560 px). Tasks open in the docked panel once
 * V2-SHELL registers the work-item renderer, in the item sheet until then.
 *
 * The summary is engine-written and refreshes over live events; "Ask the assistant" is the way to request
 * a rewrite (there's no regenerate route for initiatives yet).
 */
import { AppLink } from '@/components/shell/AppLink';
import { useCallback, useMemo, useRef } from 'react';
import type { InitiativeDetail, WorkItem } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands } from '@/client/keyboard';
import { useResumeExtra, useResumeSheet } from '@/client/resume';
import { focusChat, useChatContext } from '@/components/chat';
import { AgentRunRow, DomainClock, WorkGroup, WorkList, WorkRow, type WorkRowActionKey } from '@/components/domain';
import { useRightPanel } from '@/components/shell/panel';
import { Button, EmptyState, Icon, PanelBoundary, PanelError, Skeleton, SourceChip, StatePill, useNow, usePanelState, useTimeZone } from '@/ui';
import { CLOSED_STATES, fmtAmount, groupByState, stableOrder } from '../lib/derive';
import { useItemAction } from '../lib/mutations';
import { fmtWhen, whenPresets } from '../lib/tz';
import { ItemSheet } from '../ItemSheet';
import { openDeepLink } from '../nba/ClaudeLaunchPanel';
import { GroupLabel, Initials, NeutralTag, OpenButton } from '../panel/bits';
import { panelAvailable } from '../lib/panel-host';
import { navigate } from '@/components/shell/router';

/** Status as a word with a glyph; only "completed" (ready) and "proposed" (AI) carry a color. */
const STATUS_PILL = {
  proposed: { tone: 'ai', label: '✦ Proposed' },
  active: { tone: 'neutral', label: '● Active' },
  paused: { tone: 'neutral', label: '‖ Paused' },
  completed: { tone: 'ok', label: '✓ Completed' },
  abandoned: { tone: 'neutral', label: '– Abandoned' },
} as const;

function Panel({ title, count, children, action }: { title: string; count?: number; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-body-lg font-bold text-fg-heading">
          {title}
          {count !== undefined ? <span className="ml-2 text-body font-normal text-muted tabular-nums">{count}</span> : null}
        </h2>
        {action ? <span className="ml-auto text-caption">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function InitiativePage({ id }: { id: string }) {
  const q = useApi('getInitiative', { params: { id } });
  const tz = useTimeZone();
  const now = useNow(30_000).toISOString();
  const state = usePanelState('initiative.page', { loading: q.isLoading, error: q.data ? null : q.error, empty: !q.isLoading && !q.error && !q.data });
  if (state === 'loading')
    return (
      <div className="flex h-full flex-col" aria-busy aria-label="Loading initiative">
        <div className="border-b border-line px-6 py-5">
          <Skeleton variant="line" className="w-96" />
          <Skeleton variant="line" count={2} className="mt-3 w-2/3" />
        </div>
        <div className="grid flex-1 content-start items-start gap-6 p-6 @5xl/main:grid-cols-2">
          <Skeleton variant="row" count={8} />
          <Skeleton variant="block" className="h-64" />
        </div>
      </div>
    );
  if (state === 'error')
    return q.error?.code === 'not_found' ? (
      <EmptyState size="page" icon="search" title="This initiative no longer exists" body="Its tasks are still in Work." action={<AppLink href="/work" className="text-link">Go to Work</AppLink>} />
    ) : (
      <PanelError title="This initiative failed to load" error={q.error} onRetry={() => void q.refetch()} />
    );
  if (state === 'empty' || !q.data) return <EmptyState size="page" icon="task" title="Nothing here" body="Initiatives group the tasks behind one deal, demo or deliverable." />;
  return (
    <DomainClock now={now} tz={tz}>
      <Loaded detail={q.data} now={now} tz={tz} />
    </DomainClock>
  );
}

function Loaded({ detail, now, tz }: { detail: InitiativeDetail; now: string; tz?: string }) {
  const { initiative: ini, account, opp, people, assets, runs } = detail;
  const panel = useRightPanel();
  const action = useItemAction();
  const [sheet, setSheet] = useResumeSheet();
  const [collapsed, setCollapsed] = useResumeExtra<Record<string, boolean>>(`ini-groups:${ini.id}`, { done: true });
  const opener = useRef<HTMLElement | null>(null);
  const order = useRef<string[]>([]);
  useChatContext({ kind: 'initiative', id: ini.id, label: ini.title, href: `/initiatives/${ini.id}` });

  const stable = stableOrder(order.current, detail.items);
  order.current = stable.order;
  const groups = useMemo(() => groupByState(stable.list), [stable.list]);
  const flat = groups.flatMap((g) => (collapsed[g.id] ? [] : g.items));
  const openCount = detail.items.filter((i) => !CLOSED_STATES.has(i.state)).length;
  const sheetId = sheet?.kind === 'work_item' && detail.items.some((i) => i.id === sheet.id) ? sheet.id : null;
  const selectedId = sheetId ?? (panel.open && panel.tab === 'details' && panel.entity?.kind === 'work_item' ? panel.entity.id : null);
  const sheetIndex = sheetId ? flat.findIndex((i) => i.id === sheetId) : -1;

  const openItem = useCallback(
    (itemId: string, mode: 'sheet' | 'page') => {
      if (mode === 'page') return navigate(`/work/${itemId}`);
      // v2: the one docked panel holds details (BUILD-V2 seam); the item sheet only until V2-SHELL lands.
      if (panelAvailable()) return panel.openDetails({ kind: 'work_item', id: itemId, label: detail.items.find((i) => i.id === itemId)?.title });
      if (!sheet) opener.current = document.activeElement as HTMLElement | null;
      setSheet({ id: itemId, kind: 'work_item' });
    },
    [setSheet, sheet, panel, detail.items],
  );
  const rowAction = (key: WorkRowActionKey, item: WorkItem) => {
    const v = action.versionOf(item.id) ?? item.version;
    if (key === 'done') action.mutate({ params: { id: item.id, verb: 'done' }, body: { ifVersion: v } });
    else if (key === 'snooze') {
      const t = whenPresets(now, tz).find((p) => p.id === 'tomorrow');
      if (t) action.mutate({ params: { id: item.id, verb: 'snooze' }, body: { ifVersion: v, until: t.at } });
    } else if (key === 'edit' || key === 'resolve') openItem(item.id, 'sheet');
  };
  const step = (dir: 1 | -1) => {
    const next = flat[sheetIndex + dir];
    if (next) setSheet({ id: next.id, kind: 'work_item' });
  };
  const askAssistant = () => (panelAvailable() ? panel.openAssistant({ kind: 'initiative', id: ini.id, label: ini.title }) : focusChat());

  useCommands([
    { id: 'initiative.ask', title: `Ask the assistant about ${ini.title}`, group: 'Initiative', shortcut: 'mod+j', run: askAssistant },
    ...(flat[0] ? [{ id: 'initiative.first', title: `Open task: ${flat[0].title}`, group: 'Initiative', run: () => openItem(flat[0]!.id, 'sheet') }] : []),
    ...(account ? [{ id: 'initiative.account', title: `Open account: ${account.name}`, group: 'Initiative', run: () => navigate(`/deals/${account.id}`) }] : []),
  ]);

  const target = detail.items.find((i) => i.refs.meeting && i.servesEventId === ini.targetEventId)?.refs.meeting ?? null;
  const status = STATUS_PILL[ini.status];
  const highlights: Array<{ label: string; node: React.ReactNode }> = [
    { label: 'Account', node: account ? <NeutralTag href={`/deals/${account.id}`}>{account.name}</NeutralTag> : <span className="text-faint">—</span> },
    { label: 'Opportunity', node: opp ? <span className="tabular-nums">{opp.stage}{opp.amount !== null ? ` · ${fmtAmount(opp.amount)}` : ''}</span> : <span className="text-faint">—</span> },
    { label: 'Target', node: target ? <span className="tabular-nums">{target.label} · {fmtWhen(target.start, now, tz, { today: true })}</span> : <span className="text-faint">—</span> },
    { label: 'Open tasks', node: <span className="font-bold tabular-nums">{openCount} of {detail.items.length}</span> },
    { label: 'Updated', node: <span className="tabular-nums">{fmtWhen(ini.updatedAt, now, tz, { today: true })}</span> },
  ];
  const timeline = [...ini.timeline].sort((a, b) => b.at.localeCompare(a.at));
  const recent = Date.parse(now) - Date.parse(ini.updatedAt) < 30 * 60_000;

  const tasks = (
    <PanelBoundary name="initiative.tasks">
      <Panel title="Tasks" count={detail.items.length} action={stable.added.length ? <span className="font-bold text-link">{stable.added.length} new ↓</span> : null}>
        {detail.items.length ? (
          // While the sheet is open it follows the focused row, so j/k drive it (UI-SPEC §2).
          <div
            onFocusCapture={(e) => {
              const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row][data-item-id]');
              const rowId = row?.dataset.itemId;
              if (sheetId && rowId && rowId !== sheetId) setSheet({ id: rowId, kind: 'work_item' });
            }}
          >
            <WorkList label="Initiative tasks">
              {groups.map((g) => (
                <WorkGroup key={g.id} label={g.label} count={g.items.length} collapsed={!!collapsed[g.id]} onToggle={(c) => setCollapsed({ ...collapsed, [g.id]: c })}>
                  {g.items.map((i) => (
                    <WorkRow key={i.id} item={i} now={now} selected={i.id === selectedId} onOpen={(it, mode) => openItem(it.id, mode)} onAction={rowAction} onOpenSource={(s) => s.url && openDeepLink(s.url)} />
                  ))}
                </WorkGroup>
              ))}
            </WorkList>
          </div>
        ) : (
          <EmptyState size="panel" icon="task" title="No tasks yet" body="Tasks linked to this initiative land here, grouped by state." />
        )}
      </Panel>
    </PanelBoundary>
  );

  const contextPanels = (
    <>
      <Panel title="People" count={people.length}>
        {people.length ? (
          <ul className="grid gap-x-6 gap-y-3 @md:grid-cols-2">
            {people.map((p) => (
              <li key={p.id} className="flex min-w-0 items-center gap-3">
                <Initials name={p.name} />
                <span className="min-w-0">
                  <span className="block truncate text-body text-fg">{p.name}</span>
                  <span className="block truncate text-caption text-muted">{[p.role ?? p.title, p.isExternal ? 'external' : null].filter(Boolean).join(' · ') || '—'}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-muted">No people linked.</p>
        )}
      </Panel>

      {account || opp ? (
        <Panel title="Account and opportunity">
          <div className="space-y-2 rounded-lg border border-line px-4 py-3">
            {account ? (
              <p className="flex flex-wrap items-center gap-2 text-body">
                <AppLink href={`/deals/${account.id}`} className="font-bold text-fg hover:underline">
                  {account.name}
                </AppLink>
                <span className="text-caption text-muted tabular-nums">{account.hoursQtd} h QTD</span>
              </p>
            ) : null}
            {opp ? (
              <div className="text-body">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-fg">{opp.name}</span>
                  {opp.org62Url ? <SourceChip source="org62" label="Org62" href={opp.org62Url} /> : null}
                </p>
                <p className="text-caption text-muted tabular-nums">{[opp.stage, opp.amount !== null ? fmtAmount(opp.amount) : null, opp.closeDate ? `close ${opp.closeDate}` : null].filter(Boolean).join(' · ')}</p>
                {opp.nextStep ? <p className="max-w-[68ch] text-caption text-fg">Next step: {opp.nextStep}</p> : null}
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel title="Assets" count={assets.length}>
        {assets.length ? (
          <ul className="overflow-hidden rounded-lg border border-line">
            {assets.map((a) => (
              <li key={a.id} className="flex min-h-11 items-center gap-2.5 border-b border-line px-4 last:border-b-0 hover:bg-surface-muted">
                <Icon name={a.kind === 'demo_org' ? 'salesforce1' : a.kind === 'claude_session' ? 'agent_session' : a.kind === 'link' ? 'link' : 'file'} size="sm" className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-body text-fg" title={a.title}>
                  {a.title}
                </span>
                {a.updatedAt ? <span className="hidden shrink-0 text-caption text-muted tabular-nums @sm:inline">{fmtWhen(a.updatedAt, now, tz, { today: true })}</span> : null}
                {a.url ? <OpenButton url={a.url} label={a.title} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-muted">No decks, docs or demo orgs linked yet.</p>
        )}
      </Panel>
    </>
  );

  const activityPanels = (
    <>
      <Panel title="Sessions and runs" count={runs.length}>
        {runs.length ? (
          <div className="overflow-hidden rounded-lg border border-line">
            {runs.map((r) => (
              <AgentRunRow key={r.id} run={r} now={now} taskTitle={detail.items.find((i) => i.id === r.workItemId)?.title ?? null} onOpenDeepLink={(url) => openDeepLink(url)} onOpenTask={(wid) => openItem(wid, 'sheet')} />
            ))}
          </div>
        ) : (
          <p className="text-body text-muted">No Claude sessions or tool runs yet.</p>
        )}
      </Panel>

      <Panel title="Timeline" count={timeline.length}>
        {timeline.length ? (
          <ol>
            {timeline.map((t, i) => (
              <li key={`${t.at}${i}`} className="relative ml-1 border-l border-line pb-4 pl-5 last:pb-0">
                <span aria-hidden className="absolute top-2 -left-[4px] size-[7px] rounded-full bg-faint ring-2 ring-surface" />
                <p className="text-caption text-muted tabular-nums">{fmtWhen(t.at, now, tz, { today: true })}</p>
                <p className="text-body text-fg">
                  {t.ref?.type === 'work_item' ? (
                    <button type="button" onClick={() => openItem(t.ref!.id, 'sheet')} className="text-left hover:underline">
                      {t.label}
                    </button>
                  ) : (
                    t.label
                  )}
                </p>
                {t.source ? <SourceChip source={t.source.kind} label={t.source.label} href={t.source.url} className="mt-1" /> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-body text-muted">No timeline yet.</p>
        )}
      </Panel>
    </>
  );

  return (
    <div className="@container/ini flex h-full min-h-0 flex-col" data-initiative-page={ini.id}>
      <header className="shrink-0 border-b border-line px-6 pt-5 pb-4">
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-caption text-muted">
              <span>Initiative</span>
              <StatePill tone={status.tone} icon={false} label={status.label} size="md" />
            </p>
            {/* h2: the topbar holds the page's one h1 */}
            <h2 className="mt-1 text-heading font-bold text-balance text-fg-heading">{ini.title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-1">
            <Button size="sm" variant="ghost" icon="sparkles" onClick={askAssistant} title="The assistant has this initiative in context (⌘J)">
              Ask the assistant
            </Button>
          </div>
        </div>
        <dl className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-caption">
          {highlights.map((h) => (
            <div key={h.label} className="flex min-w-0 items-center gap-2">
              <dt className="shrink-0 text-muted">{h.label}</dt>
              <dd className="flex min-h-7 min-w-0 items-center text-body text-fg">{h.node}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="cc-scroll relative min-h-0 flex-1 overflow-y-auto @5xl/ini:grid @5xl/ini:grid-cols-[minmax(0,1.35fr)_minmax(24rem,1fr)] @5xl/ini:overflow-hidden @min-[140rem]/ini:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="@container cc-scroll relative space-y-8 p-6 @5xl/ini:min-h-0 @5xl/ini:overflow-y-auto">
          <PanelBoundary name="initiative.summary">
            <section aria-label="Purpose and summary" className="space-y-3 rounded-lg border border-line bg-surface px-5 py-4">
              <p className="max-w-[68ch] text-body-lg text-fg">
                <span className="font-bold">For:</span> {ini.purpose || <span className="text-faint">No purpose yet.</span>}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <GroupLabel tone="ai">✦ Summary</GroupLabel>
                <span className="text-caption text-muted">
                  {recent ? <span className="font-bold text-ai-700">updated {fmtWhen(ini.updatedAt, now, tz)}</span> : `updated ${fmtWhen(ini.updatedAt, now, tz, { today: true })}`} · refreshes when new info arrives
                </span>
              </div>
              {ini.summary ? (
                <p className="max-w-[68ch] text-body whitespace-pre-line text-fg" data-initiative-summary>
                  {ini.summary}
                </p>
              ) : (
                <p className="text-body text-muted">No summary yet. It fills in after the next scan.</p>
              )}
            </section>
          </PanelBoundary>
          {tasks}
        </div>

        {/* One context column below 140rem; context and activity split into two panes at 2,560 px. */}
        <aside className="@container cc-scroll relative space-y-8 border-t border-line p-6 @5xl/ini:min-h-0 @5xl/ini:overflow-y-auto @5xl/ini:border-t-0 @5xl/ini:border-l" aria-label="Initiative context">
          {contextPanels}
          <div className="space-y-8 @min-[140rem]/ini:hidden">{activityPanels}</div>
        </aside>
        <aside className="@container cc-scroll relative hidden space-y-8 border-l border-line p-6 @min-[140rem]/ini:block @min-[140rem]/ini:min-h-0 @min-[140rem]/ini:overflow-y-auto" aria-label="Initiative activity">
          {activityPanels}
        </aside>
      </div>

      <ItemSheet
        itemId={sheetId}
        onClose={() => setSheet(null)}
        index={sheetIndex >= 0 ? sheetIndex : undefined}
        total={sheetIndex >= 0 ? flat.length : undefined}
        onPrev={sheetIndex > 0 ? () => step(-1) : undefined}
        onNext={sheetIndex >= 0 && sheetIndex < flat.length - 1 ? () => step(1) : undefined}
        returnFocus={() => (sheetId ? document.querySelector<HTMLElement>(`[data-row][data-item-id="${sheetId}"]`) : null) ?? opener.current}
        onOpenItem={openItem}
      />
    </div>
  );
}
