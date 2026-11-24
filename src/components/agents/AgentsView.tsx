'use client';
/**
 * Agents ▸ Runs (UI-SPEC §12, DESIGN-V2): Claude Code sessions, app runs and tool runs in three verb sections,
 * side by side as panes once there is room:
 *
 *   Running now (waiting on you first) · Review what's done (failed first) · Nudge or stop
 *   … and at 2,240 px of main width a fourth pane: Run a tool (the launcher).
 *   "That's everything running." + finished and scheduled runs, one click away.
 *
 * Each row says what the run is doing, the hands-on minutes it needs from you, and ONE verb (quiet; filled on
 * the selected row, or on the focal row while nothing is selected). Click or Enter opens the run in the
 * docked panel (`openDetails({kind:'agent_run'})`); j/k move the selection, Esc closes the panel.
 * Live: a row repaints in place (it never moves under the cursor; "n changed · Re-group" applies it), a run
 * that starts waiting on you is announced. Open in Claude / Start in Claude open only on an explicit click.
 */
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AgentRun, RunState } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands, useKeyBinding, useListKeys } from '@/client/keyboard';
import { useResumeSelection } from '@/client/resume/hooks';
import { useChatContext } from '@/components/chat';
import { DomainClock } from '@/components/domain';
import { useRightPanel } from '@/components/shell/panel';
import { Button, cn, EmptyState, mergeRefs, PanelBoundary, PanelError, useNow, usePanelState, useTimeZone } from '@/ui';
import { useArrivalHold, useNewIds } from '@/components/lists/live-list';
import { useRunActions } from './actions';
import { AgentsHeader } from './AgentsHeader';
import { RunsBodySkeleton } from './AgentsSkeleton';
import { NEEDS_INPUT_URL, openClaudeUrl, openInClaudeUrl } from './claude';
import { layoutOf, newlyWaiting, pendingMoves, type GroupKey } from './groups';
import { agentsLayout, focalRunId, runVerb, summaryParts, type RunSection } from './needs';
import { RunRow } from './RunRow';
import { capFor, Section, useWideScreen } from './Section';
import { StartInClaude } from './StartInClaude';
import { ToolLauncher } from './ToolsView';
import './agents.css';
import { AppLink } from '@/components/shell/AppLink';
import { navigate } from '@/components/shell/router';

const SCOPE = 'list:agents';
const FINISHED_CAP = 8;

export function AgentsView() {
  const params = useSearchParams();
  const tz = useTimeZone();
  const now = useNow(5_000);
  const nowIso = now.toISOString();
  const agents = useApi('getAgents');
  const open = useApi('listItems', { query: { tab: 'all_open' } });
  const panel = useRightPanel();
  const a = useRunActions();
  const wide = useWideScreen();
  const cap = capFor(wide);
  const [selected, setSelected] = useResumeSelection('agents');
  const [startOpen, setStartOpen] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [held, setHeld] = useState<Record<string, GroupKey> | null>(null);
  const [flash, setFlash] = useState<Record<string, 'state' | 'waiting'>>({});
  const [announce, setAnnounce] = useState('');
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showFinished, setShowFinished] = useState<'none' | 'done' | 'scheduled'>('none');
  const prev = useRef<Map<string, AgentRun>>(new Map());

  const runs = useMemo(() => agents.data?.runs ?? [], [agents.data]);
  const taskTitles = useMemo(() => new Map((open.data?.items ?? []).map((i) => [i.id, i.title] as const)), [open.data]);
  // Only open tasks have a title here; a closed task's run shows no tag (its panel still links it).
  const titleOf = useCallback((r: AgentRun) => (r.workItemId ? (taskTitles.get(r.workItemId) ?? null) : null), [taskTitles]);
  const state = usePanelState('agents.runs', { loading: agents.isLoading, error: agents.data ? null : agents.error, empty: !!agents.data && !runs.length });

  // ── Live diff: repaint flash, waiting announcements ──
  useEffect(() => {
    if (!agents.data) return;
    const before = prev.current;
    if (before.size) {
      const changed: Record<string, 'state' | 'waiting'> = {};
      for (const r of runs) {
        const p = before.get(r.id);
        if (p && p.state !== r.state) changed[r.id] = r.state === 'waiting_on_you' ? 'waiting' : 'state';
      }
      if (Object.keys(changed).length) {
        setFlash((f) => ({ ...f, ...changed }));
        const ids = Object.keys(changed);
        setTimeout(() => setFlash((f) => Object.fromEntries(Object.entries(f).filter(([id]) => !ids.includes(id)))), 2600);
      }
      const states = new Map([...before].map(([id, r]) => [id, r.state as RunState] as const));
      const nw = newlyWaiting(states, runs);
      if (nw.length) setAnnounce(`${nw.map((r) => r.title).join(', ')} ${nw.length === 1 ? 'is' : 'are'} now waiting on you`);
    }
    prev.current = new Map(runs.map((r) => [r.id, r]));
    setSeen((s) => s ?? new Set(runs.map((r) => r.id)));
  }, [agents.data, runs]);

  // ── Hold the layout while the user works in the list, has a run open in the panel, or the pointer is moving over
  // it (docs/UX.md "Live updates": a row never moves under a click). "N changed · Re-group" applies the new layout.
  const panelRun = panel.open && panel.tab === 'details' && panel.entity?.kind === 'agent_run' ? panel.entity.id : null;
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const pointerHold = useArrivalHold(listWrapRef);
  const hold = focusIn || !!panelRun || pointerHold;
  useEffect(() => {
    setHeld(hold ? (h) => h ?? layoutOf(runs) : null);
    // `runs` is read only at the moment the hold starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold]);
  const layout = useMemo(() => agentsLayout(runs, held ?? undefined), [runs, held]);
  const pending = held ? pendingMoves(runs, held) : 0;
  const focal = focalRunId(layout);

  const shownIn = useCallback((s: RunSection) => (expanded[s.key] ? s.runs : s.runs.slice(0, cap)), [expanded, cap]);
  const finished = showFinished === 'done' ? layout.done : showFinished === 'scheduled' ? layout.scheduled : [];
  const [allFinished, setAllFinished] = useState(false);
  const finishedShown = allFinished ? finished : finished.slice(0, FINISHED_CAP);
  const ordered = useMemo(() => [...layout.sections.flatMap(shownIn), ...finishedShown], [layout.sections, shownIn, finishedShown]);
  const ids = useMemo(() => ordered.map((r) => r.id), [ordered]);
  const byId = useMemo(() => new Map(runs.map((r) => [r.id, r] as const)), [runs]);
  const newIds = useMemo(() => (seen ? runs.filter((r) => !seen.has(r.id)).map((r) => r.id) : []), [runs, seen]);
  // a run that just started is marked where it lands (docs/UX.md "Live updates")
  const arrivedRuns = useNewIds(runs.map((r) => r.id));

  // A run opened from the URL (?panel=details&item=…) counts as the selection until another row is picked.
  const active = selected && byId.has(selected) ? selected : panelRun && byId.has(panelRun) ? panelRun : null;
  const activeRun = active ? byId.get(active) : undefined;
  useChatContext(activeRun ? { kind: 'agent_run', id: activeRun.id, label: activeRun.title } : null);

  // ?state=done_review (Home's "3 agent runs to review →") selects the first such run once.
  const stateParam = params.get('state');
  const appliedParam = useRef(false);
  useEffect(() => {
    if (appliedParam.current || !stateParam || !runs.length) return;
    appliedParam.current = true;
    const hit = ordered.find((r) => r.state === stateParam);
    if (hit) setSelected(hit.id);
  }, [stateParam, runs.length, ordered, setSelected]);

  const openRun = useCallback(
    (r: AgentRun) => {
      setSelected(r.id);
      a.openRun(r);
    },
    [a, setSelected],
  );
  const doVerb = useCallback(
    (r: AgentRun) => {
      const v = runVerb(r);
      setSelected(r.id);
      if (v) a.perform(v.key, r, titleOf(r));
    },
    [a, setSelected, titleOf],
  );

  const list = useListKeys({
    scope: SCOPE,
    ids,
    activeId: active,
    onActiveChange: (id) => {
      setSelected(id);
      // An open Details tab follows the selection.
      const r = byId.get(id);
      if (r && panel.open && panel.tab === 'details') a.openRun(r);
    },
    primary: true,
    enabled: state === 'ready',
    onOpen: (id) => {
      const r = byId.get(id);
      if (r) openRun(r);
    },
    onOpenPage: (id) => {
      const r = byId.get(id);
      if (r?.workItemId) navigate(`/work/${r.workItemId}`);
    },
    onPrimary: (id) => {
      const r = byId.get(id);
      const v = r && runVerb(r);
      // Cancel is never the ⌘↵ default.
      if (r && v && v.key !== 'cancel') a.perform(v.key, r, titleOf(r));
    },
    actions: {
      o: (id) => {
        const r = byId.get(id);
        if (!r) return;
        if (r.kind === 'claude_session') a.openInClaude(r);
        else a.openRun(r);
      },
      r: (id) => {
        const r = byId.get(id);
        if (r?.state === 'failed') a.perform('retry', r);
      },
    },
  });
  useKeyBinding(
    'escape',
    () => {
      // An open panel: let the shell close it (it restores focus to the row).
      if (panel.open) return false;
      if (active) {
        setSelected(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      return false;
    },
    { scope: SCOPE, enabled: list.active },
  );
  useKeyBinding('shift+s', () => setStartOpen(true), { description: 'Start in Claude', group: 'Agents' });

  const waitingCount = agents.data?.counts.waiting_on_you ?? 0;
  const needsInput = agents.data?.needsInputLink ?? NEEDS_INPUT_URL;
  useCommands([
    { id: 'agents.start', title: 'Start in Claude…', subtitle: 'Prepare a session, review the context pack, then open', group: 'Agents', shortcut: 'shift+s', run: () => setStartOpen(true) },
    { id: 'agents.all-waiting', title: 'All waiting in Claude', subtitle: 'Opens Claude’s needs-input list', group: 'Agents', disabled: !waitingCount, run: () => openClaudeUrl(needsInput) },
    { id: 'agents.tools', title: 'Open Tools', group: 'Agents', keywords: ['talk track', 'pulse', 'estimator'], run: () => navigate('/agents/tools') },
    { id: 'agents.finished', title: `Show finished runs (${layout.done.length})`, group: 'Agents', disabled: !layout.done.length, run: () => setShowFinished('done') },
    ...(activeRun
      ? [
          { id: 'agents.row.open', title: `Open details: ${activeRun.title}`, group: 'Agents', shortcut: 'enter', run: () => openRun(activeRun) },
          ...(runVerb(activeRun) ? [{ id: 'agents.row.verb', title: `${runVerb(activeRun)!.label}: ${activeRun.title}`, group: 'Agents', shortcut: 'mod+enter', run: () => doVerb(activeRun) }] : []),
          ...(openInClaudeUrl(activeRun) ? [{ id: 'agents.row.claude', title: `Open in Claude: ${activeRun.title}`, group: 'Agents', shortcut: 'o', run: () => a.openInClaude(activeRun) }] : []),
          ...(activeRun.state === 'failed' ? [{ id: 'agents.row.retry', title: `Retry: ${activeRun.title}`, group: 'Agents', shortcut: 'r', run: () => a.perform('retry', activeRun) }] : []),
          ...(activeRun.kind !== 'claude_session' && ['queued', 'running', 'waiting_on_you', 'stale'].includes(activeRun.state)
            ? [{ id: 'agents.row.cancel', title: `Cancel run: ${activeRun.title}`, group: 'Agents', run: () => a.perform('stop', activeRun) }]
            : []),
        ]
      : []),
  ]);

  const sum = summaryParts(layout);
  const sentence = agents.data ? (
    <>
      {sum.you ? (
        <>
          About <b className="font-bold text-fg-heading">{sum.you} of your time</b>: {sum.parts.join(', ')}.
        </>
      ) : (
        <>Nothing needs you right now.</>
      )}{' '}
      {sum.background ? (
        <span className="text-muted">
          <span className="text-ai-700">✦</span> {sum.background}; {layout.background === 1 ? 'it doesn’t' : 'they don’t'} count against your day.
        </span>
      ) : null}
    </>
  ) : null;

  const rowFor = (r: AgentRun) => (
    <RunRow
      key={r.id}
      {...list.rowProps(r.id)}
      data-live={arrivedRuns.has(r.id) ? 'new' : undefined}
      run={r}
      now={nowIso}
      taskTitle={titleOf(r)}
      selected={r.id === active}
      emphasized={!active && r.id === focal}
      inPanel={r.id === panelRun}
      flash={flash[r.id]}
      busy={a.retrying === r.id}
      onClick={() => openRun(r)}
      onVerb={doVerb}
      onOpenTask={(id) => a.openTask(id, titleOf(r) ?? undefined)}
    />
  );

  const n = layout.sections.length;
  const gridVars = { '--agents-cols': `repeat(${Math.max(1, n)}, minmax(0, 1fr))`, '--agents-cols-wide': `repeat(${Math.max(1, n) + 1}, minmax(0, 1fr))` } as CSSProperties;

  return (
    <DomainClock now={nowIso} tz={tz}>
      <div className="flex min-h-full flex-col gap-5 px-6 pt-5 pb-6" data-agents-root>
        <AgentsHeader
          tab="runs"
          sentence={sentence}
          actions={
            <>
              {waitingCount ? (
                <Button variant="secondary" size="sm" icon="notification" title="Opens claude://code/needs-input in Claude" data-testid="all-waiting" onClick={() => openClaudeUrl(needsInput)}>
                  All waiting · {waitingCount}
                </Button>
              ) : null}
              <StartInClaude variant="secondary" open={startOpen} onOpenChange={setStartOpen} />
            </>
          }
        />

        <p className="sr-only" role="status" aria-live="polite" data-testid="agents-announce">
          {announce}
        </p>
        {pending > 0 || newIds.length > 0 ? (
          <div className="flex items-center gap-2">
            {pending > 0 ? (
              <Button variant="secondary" size="xs" icon="refresh" onClick={() => setHeld(layoutOf(runs))} data-testid="regroup">
                {pending} changed · Re-group
              </Button>
            ) : null}
            {newIds.length > 0 ? (
              <Button
                variant="secondary"
                size="xs"
                iconRight="arrowdown"
                onClick={() => {
                  document.querySelector(`[data-run-row="${CSS.escape(newIds[0]!)}"]`)?.scrollIntoView({ block: 'center' });
                  setSeen(new Set(runs.map((r) => r.id)));
                }}
              >
                {newIds.length} new
              </Button>
            ) : null}
          </div>
        ) : null}

        <PanelBoundary name="agents.runs">
          {state === 'error' ? (
            <PanelError title="Couldn’t load your runs" error={agents.error ?? new Error('Forced error state (dev toolbar)')} onRetry={() => void agents.refetch()} />
          ) : state === 'loading' ? (
            <RunsBodySkeleton />
          ) : state === 'empty' ? (
            <EmptyState size="page" icon="agent_session" title="No sessions or runs" body="Claude sessions linked to your tasks, app runs and tool runs show up here. Start one from a task, or use Start in Claude." />
          ) : (
            <div
              {...list.containerProps}
              ref={mergeRefs(list.containerProps.ref, listWrapRef)}
              onFocusCapture={() => setFocusIn(true)}
              onBlurCapture={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocusIn(false)}
              className="flex flex-col gap-4"
            >
              {n ? (
                <div
                  style={gridVars}
                  className="grid grid-cols-1 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface @min-[70rem]/main:grid-cols-(--agents-cols) @min-[70rem]/main:divide-x @min-[70rem]/main:divide-y-0 @min-[140rem]/main:grid-cols-(--agents-cols-wide)"
                  data-agents-sections={n}
                >
                  {layout.sections.map((s) => (
                    <Section
                      key={s.key}
                      data-section={s.key}
                      title={s.title}
                      count={s.runs.length}
                      sub={s.youMin ? `you ~${s.youMin}m` : s.key === 'running' ? 'in the background' : s.sub}
                      total={s.runs.length}
                      cap={cap}
                      expanded={!!expanded[s.key]}
                      onToggle={() => setExpanded((e) => ({ ...e, [s.key]: !e[s.key] }))}
                    >
                      {shownIn(s).map(rowFor)}
                    </Section>
                  ))}
                  <ToolLauncher className="hidden @min-[140rem]/main:flex" cap={cap} />
                </div>
              ) : (
                <EmptyState size="panel" icon="agent_session" title="Nothing running or waiting" body="Finished runs are below. Start a session from a task, or with Start in Claude." />
              )}

              <footer className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-1" data-agents-end>
                <span className="text-body-lg font-bold text-fg-heading">That’s everything running.</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
                  {layout.done.length ? (
                    <button type="button" aria-expanded={showFinished === 'done'} onClick={() => setShowFinished((v) => (v === 'done' ? 'none' : 'done'))} className="font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none" data-testid="show-finished">
                      {showFinished === 'done' ? 'Hide' : 'Show'} {layout.done.length} finished
                    </button>
                  ) : null}
                  {layout.scheduled.length ? (
                    <button type="button" aria-expanded={showFinished === 'scheduled'} onClick={() => setShowFinished((v) => (v === 'scheduled' ? 'none' : 'scheduled'))} className="font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
                      {showFinished === 'scheduled' ? 'Hide' : 'Show'} {layout.scheduled.length} scheduled
                    </button>
                  ) : null}
                  <AppLink href="/agents/tools" className="font-bold text-link hover:underline @min-[140rem]/main:hidden">
                    Run a tool →
                  </AppLink>
                </span>
              </footer>

              {finished.length ? (
                <section className="@container/sec rounded-lg border border-line bg-surface px-4 pt-4 pb-3" aria-label={showFinished === 'done' ? 'Finished runs' : 'Scheduled runs'} data-section={showFinished}>
                  <div className="flex items-baseline gap-2 pb-1">
                    <h2 className="text-lead font-bold text-fg-heading">{showFinished === 'done' ? 'Finished' : 'Scheduled'}</h2>
                    <span className="text-body text-muted tabular-nums">{finished.length}</span>
                    <span className="ml-auto text-caption text-faint">{showFinished === 'done' ? 'nothing needs you' : 'autopilot; flagged only when really waiting'}</span>
                  </div>
                  <div role="list" aria-label="Finished runs" className={cn('-mx-3 grid grid-cols-1', '@min-[60rem]/sec:grid-cols-2 @min-[100rem]/sec:grid-cols-3')}>
                    {finishedShown.map(rowFor)}
                  </div>
                  {finished.length > FINISHED_CAP ? (
                    <button type="button" onClick={() => setAllFinished((v) => !v)} className="mt-2 text-caption font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
                      {allFinished ? 'Show fewer' : `Show all ${finished.length}`}
                    </button>
                  ) : null}
                </section>
              ) : null}
            </div>
          )}
        </PanelBoundary>
        {a.dialog}
      </div>
    </DomainClock>
  );
}
