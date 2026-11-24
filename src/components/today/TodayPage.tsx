'use client';
/**
 * Today v2: day planning (DESIGN-V2; visual target public/mockups/today.html).
 *
 *   Thu 5 Nov · one sentence · ✦ background runs · neutral capacity meter ("✓ Fits")
 *   ┌ Day timeline (520–640) ┬ Run of day · Fit-ins · Pull forward · Promises ┬ Agent's plan (diff) ┐
 *   (below a 1,600 px main container the plan collapses to a vertical tab; `p` or click opens it)
 *
 * Click or Enter on any row or block opens it in the docked right panel (useRightPanel().openDetails).
 * The status rail is gone: approvals, waiting sessions and broken connectors are Fit-ins; background runs
 * are the header note and the violet lane; Since-you-left sits under the plan.
 *
 * Data: GET /today (+ /settings for working hours, /items?tab=all_open for reopened items outside the
 * payload's window). Live topics invalidate; useTodayModel keeps the order stable under the selection.
 */
import { TodaySkeleton } from './TodaySkeleton';
import './today.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpineSlot, WorkItem } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands, useFocusedCommands, useKeyBinding, type Command } from '@/client/keyboard';
import { useResumeExtra, useResumeScroll, useResumeSelection } from '@/client/resume';
import { toast, toastStore } from '@/client/toast';
import { useChatContext } from '@/components/chat';
import { DomainClock } from '@/components/domain';
import { navigate } from '@/components/shell/router';
import { useRightPanel, type PanelEntity } from '@/components/shell/panel';
import { PanelBoundary, PanelError, useNow, usePanelState, useTimeZone } from '@/ui';
import { AgentPlan, PlanTab } from './AgentPlan';
import { normalizePullForward, freeMinutesLeft, resolveCapacity, type CapacityIn } from './capacity';
import { TodayProvider, type PopoverState, type TodayCtx } from './ctx';
import { DayHeader } from './DayHeader';
import { PreviewToggle, PriorityPreviewPanel, usePriorityPreview } from './PriorityPreview';
import { DayTimeline } from './DayTimeline';
import { openExternal } from './external';
import { applyPlan, EMPTY_PLAN, isActionable, zonedInstant, type LocalPlan } from './model';
import { EMPTY_AGENT_PLAN, planChanges, summarize, type AgentPlanState, type PlanChange } from './plan';
import { useMeetingState } from './TodayPage.meetings';
import { useAgentPlanActions } from './TodayPage.plan';
import { useRowActions } from './TodayPage.rows';
import { buildSections, isBlocked, isTodayScoped, stripLabel, type DayRow } from './rows';
import { RunOfDay, type RowHandlers } from './RunOfDay';
import { approx, hhmm, minuteOfDay, msOf, parseHHMM, zoned } from './time';
import { layoutDay, type LayoutInput } from './timeline';
import { TODAY_SCOPE, useTodayKeys } from './useTodayKeys';
import { useTodayActions } from './useTodayActions';
import { useTodayModel } from './useTodayModel';

const cssEscape = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/"/g, '\\"'));

/** Test seam (Playwright): `window.__ccOpenDetails` sees every openDetails call before the panel does. */
function notifyOpenDetails(entity: PanelEntity) {
  if (typeof window === 'undefined') return;
  const spy = (window as { __ccOpenDetails?: (e: PanelEntity) => void }).__ccOpenDetails;
  spy?.(entity);
}

function rowElement(key: string | null): HTMLElement | null {
  if (!key || typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-today-root] [data-row-key="${cssEscape(key)}"]`);
}

export interface TodayViewProps {
  /**
   * Home ▸ Plan (01 R3, the folded Today): the same tree inside Home. `p` is Home's (back to the briefing) instead of
   * the agent's plan rail, which stays one click away on its tab.
   */
  embedded?: boolean;
  /** Embedded: what `p` does (Home switches back to the briefing). */
  onPlanKey?: () => void;
}

/** `/today` and Home ▸ Plan render this one component (no second copy of the day's logic). */
export function TodayPage() {
  return <TodayView />;
}

export function TodayView({ embedded = false, onPlanKey }: TodayViewProps = {}) {
  const panel = useRightPanel();
  const tz = useTimeZone();
  const now = useNow(15_000).toISOString();
  const today = useApi('getToday');
  const settings = useApi('getSettings');
  const open = useApi('listItems', { query: { tab: 'all_open' } });
  const data = today.data;

  // ---- resume (selection, local plan, agent plan, promises) ------------------------------------------
  const [selectedSaved, setSelectedSaved] = useResumeSelection('today');
  const [plan, setPlan] = useResumeExtra<LocalPlan>('plan', EMPTY_PLAN);
  const [agentSaved, setAgentSaved] = useResumeExtra<AgentPlanState>('agentPlan', EMPTY_AGENT_PLAN);
  const [promisesOpen, setPromisesOpen] = useResumeExtra<boolean>('promisesOpen', false);
  const [planOpen, setPlanOpen] = useState(false);
  const [hl, setHl] = useState<string | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [reauthFor, setReauthFor] = useState<string | null>(null);
  // priority@2: "Preview new ranking" for this session (nothing is persisted)
  const [previewOn, togglePreview] = usePriorityPreview();

  const dayKey = zoned(now, tz).ymd;
  const agentPlan = useMemo(() => (agentSaved.day === dayKey ? agentSaved : { ...EMPTY_AGENT_PLAN, day: dayKey }), [agentSaved, dayKey]);
  const setAgentPlan = useCallback((next: AgentPlanState) => setAgentSaved({ ...next, day: dayKey }), [setAgentSaved, dayKey]);
  const excluded = useMemo(() => new Set(agentPlan.excluded), [agentPlan.excluded]);

  const wh = settings.data?.profile.workingHours;
  const workStart = parseHHMM(wh?.start, 8 * 60);
  const workEnd = parseHHMM(wh?.end, 17 * 60 + 30);

  // ---- stable model -------------------------------------------------------------------------------
  const listed = useMemo(() => new Set([...(data?.nowStack.cards.map((c) => c.item.id) ?? []), ...(data?.moreToday.items.map((i) => i.id) ?? [])]), [data]);
  const extras = useMemo(() => (open.data?.items ?? []).filter((i) => i.state === 'reopened' && !listed.has(i.id) && isActionable(i)), [open.data, listed]);
  const selectedItemSaved = selectedSaved && selectedSaved.includes(':') ? selectedSaved.slice(selectedSaved.lastIndexOf(':') + 1) : null;
  const model = useTodayModel(data, extras, { card: selectedItemSaved, row: selectedItemSaved });
  const { cards, rows } = model;

  const items = useMemo(() => {
    const m = new Map<string, WorkItem>();
    for (const c of cards) m.set(c.item.id, c.item);
    for (const r of rows) m.set(r.id, r);
    for (const r of extras) m.set(r.id, r);
    for (const s of [...(data?.shelves.fitIns ?? []), ...(data?.shelves.promises ?? [])]) if (!m.has(s.item.id)) m.set(s.item.id, s.item);
    return m;
  }, [cards, rows, extras, data?.shelves]);
  const catalog = useMemo(() => {
    const m = new Map<string, WorkItem>();
    for (const i of open.data?.items ?? []) m.set(i.id, i);
    for (const [k, v] of items) m.set(k, v);
    return m;
  }, [open.data, items]);
  const cardFor = useCallback((id: string) => cards.find((c) => c.item.id === id) ?? null, [cards]);

  // ---- the agent's plan (diff) and the effective slots ---------------------------------------------
  const capIn = data?.header.capacity as CapacityIn | undefined;
  const serverSlots = useMemo(() => data?.spine.slots ?? [], [data?.spine.slots]);
  const changes: PlanChange[] = useMemo(() => {
    if (!data) return [];
    const plannedIds = new Set<string>([...serverSlots.filter((s) => s.kind !== 'gap' && s.workItemId).map((s) => s.workItemId!), ...Object.keys(plan.fits)]);
    const agentAlongside = new Set(cards.filter((c) => (c.nba?.verb === 'start_in_claude' || c.nba?.verb === 'run_tool' || !!c.nba?.claudeLaunch) && c.item.effort.agentMin > 0).map((c) => c.item.id));
    // A deferral you undid stays listed (struck through) even though the item now counts toward today.
    const deferred = data.shelves.fitIns.filter((s) => isActionable(s.item) && (excluded.has(`defer:${s.item.id}`) || !isTodayScoped(s.item, now, tz, plannedIds)) && (s.item.training?.minutes ?? s.item.effort.youMin) > 15);
    const pullIds = new Set((capIn?.pullForward ?? []).map((p) => p.itemId));
    return planChanges({ nowIso: now, tz, slots: serverSlots, cards, items, agentAlongside, deferred, rerankReady: model.rerankCount, todayIds: plannedIds, pullIds });
  }, [data, serverSlots, plan.fits, cards, items, now, tz, model.rerankCount, excluded, capIn?.pullForward]);
  const summary = useMemo(() => summarize(changes, excluded), [changes, excluded]);

  const slots: SpineSlot[] = useMemo(() => {
    const dropped = new Set(changes.filter((c) => c.kind === 'added' && excluded.has(c.id)).flatMap((c) => c.slotIds));
    return applyPlan(
      serverSlots.filter((s) => !dropped.has(s.id)),
      plan,
    );
  }, [serverSlots, changes, excluded, plan]);
  const pinned = useMemo(() => new Set(Object.keys(plan.fits)), [plan.fits]);

  // ---- sections -----------------------------------------------------------------------------------
  const pullForward = useMemo(() => normalizePullForward(capIn?.pullForward), [capIn?.pullForward]);
  const sections = useMemo(
    () => (data ? buildSections({ data, cards, rows, extras, nowIso: now, tz, slots, pinned, pullForward, catalog, ...(wh ? { workingHours: { start: wh.start, end: wh.end, days: [...wh.days] } } : {}) }) : { run: [], fit: [], pull: [], promises: [], planned: new Set<string>() }),
    [data, cards, rows, extras, now, tz, slots, pinned, pullForward, catalog, wh],
  );

  // ---- selection ----------------------------------------------------------------------------------
  const ringRows = useMemo(() => [...sections.run, ...sections.fit, ...sections.pull, ...(promisesOpen ? sections.promises : [])], [sections, promisesOpen]);
  const ring = useMemo(() => ringRows.map((r) => r.key), [ringRows]);
  const selectedKey = selectedSaved && ring.includes(selectedSaved) ? selectedSaved : (ring[0] ?? null);
  const selectedRow = ringRows.find((r) => r.key === selectedKey) ?? null;
  const ringRef = useRef(ring);
  ringRef.current = ring;
  const select = useCallback(
    (key: string) => {
      setSelectedSaved(key);
      setExpandedKey((k) => (k === key ? k : null));
    },
    [setSelectedSaved],
  );
  const focusRow = useCallback((key: string) => {
    const el = rowElement(key);
    if (!el) return false;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
    return true;
  }, []);

  // ---- layout (timeline) --------------------------------------------------------------------------
  const suggestionRow = selectedRow?.section === 'pull' ? selectedRow : sections.pull[0] ?? null;
  const layoutInput: LayoutInput | null = useMemo(() => {
    if (!data) return null;
    const workIn = slots.filter((s) => s.kind !== 'gap').map((s) => ({ id: s.id, itemId: s.workItemId, start: s.start, end: s.end, label: s.label }));
    // Pulled in (start-by today) but not planned by the engine yet: show it where it starts.
    const slotted = new Set(workIn.map((w) => w.itemId));
    for (const r of sections.run) {
      const it = r.item;
      if (!it?.startBy || slotted.has(it.id) || zoned(it.startBy, tz).ymd !== zoned(now, tz).ymd || msOf(it.startBy) + it.effort.youMin * 60_000 <= msOf(now)) continue;
      workIn.push({ id: `pin:${it.id}`, itemId: it.id, start: it.startBy, end: new Date(msOf(it.startBy) + Math.max(10, it.effort.youMin) * 60_000).toISOString(), label: r.title });
    }
    const firstStart = (id: string) => slots.filter((s) => s.kind !== 'gap' && s.workItemId === id).sort((a, b) => msOf(a.start) - msOf(b.start))[0]?.start ?? null;
    const agentIn = sections.run
      .filter((r) => r.agentBg && r.item)
      .map((r) => ({ id: `agent:${r.item!.id}`, itemId: r.item!.id, start: firstStart(r.item!.id) ?? now, minutes: r.agentBg!.minutes, label: 'Agent run' }));
    return {
      nowIso: now,
      tz,
      workStart,
      workEnd,
      events: data.spine.events,
      work: workIn,
      agent: agentIn,
      // Broken connectors stay "Any": they're red, so they don't wait for a gap.
      hints: sections.fit.filter((r) => r.primary.kind !== 'reauth').map((r) => ({ key: r.key, title: r.title, minutes: r.youMin })),
      suggestion: suggestionRow?.item ? { key: suggestionRow.key, itemId: suggestionRow.item.id, title: suggestionRow.title, minutes: Math.max(10, suggestionRow.youMin) } : null,
    };
  }, [data, slots, sections.run, sections.fit, suggestionRow, now, tz, workStart, workEnd]);
  const layout = useMemo(() => (layoutInput ? layoutDay(layoutInput) : null), [layoutInput]);

  // Fit-ins say where they fit.
  const fitRows = useMemo(
    () => sections.fit.map((r) => (layout?.hintAt.has(r.key) ? { ...r, when: { ...r.when, main: hhmm(layout.hintAt.get(r.key)!) } } : r)),
    [sections.fit, layout],
  );
  const shownSections = useMemo(() => ({ ...sections, fit: fitRows }), [sections, fitRows]);

  // ---- capacity -----------------------------------------------------------------------------------
  const cap = useMemo(() => {
    const derivedYou = sections.run.reduce((s, r) => s + r.youMin, 0) + sections.fit.reduce((s, r) => s + r.youMin, 0);
    const bg = sections.run.filter((r) => r.agentBg);
    const free = data ? freeMinutesLeft(data.spine.events, now, tz, workStart, workEnd) : 0;
    return resolveCapacity(capIn, { youMin: derivedYou, freeMin: free, agentMin: bg.reduce((s, r) => s + r.agentBg!.minutes, 0), agentRuns: bg.length });
  }, [sections.run, sections.fit, data, now, tz, workStart, workEnd, capIn]);
  const agentLabels = useMemo(
    () =>
      sections.run
        .filter((r) => r.agentBg)
        .map((r) => {
          // "Smoke-test both Acme demos in the review session" → "smoke-test both Acme demos"
          const t = stripLabel(r.title).replace(/\s+(in|before|for|with|on)\s.*$/i, '').replace(/:.*$/, '');
          const short = t.length > 32 ? `${t.slice(0, 32).replace(/\s+\S*$/, '')}…` : t;
          return short.charAt(0).toLowerCase() + short.slice(1);
        }),
    [sections.run],
  );

  // ---- actions ------------------------------------------------------------------------------------
  const onRemove = useCallback((itemId: string) => model.remove(itemId), [model]);
  const actions = useTodayActions({ onRemove, onAdopt: model.adopt, tz });
  const seenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openDetails = useCallback(
    (entity: PanelEntity) => {
      notifyOpenDetails(entity);
      panel.openDetails(entity);
      if (seenTimer.current) clearTimeout(seenTimer.current);
      const it = entity.kind === 'work_item' ? items.get(entity.id) : undefined;
      if (it?.newEvidenceCount) seenTimer.current = setTimeout(() => actions.markSeen(it), 1500);
    },
    [panel, items, actions],
  );
  const openRow = useCallback((row: DayRow) => openDetails(row.entity), [openDetails]);
  const openPage = useCallback((row: DayRow) => (row.item ? navigate(`/work/${row.item.id}`) : openDetails(row.entity)), [openDetails]);

  /** Pull an item into today: PATCH its start-by to the open time where it fits (optimistic, Undo via audit). */
  const pullIn = useCallback(
    async (item: WorkItem): Promise<string | null> => {
      if (!layoutInput) return null;
      const minutes = Math.max(10, item.training?.minutes ?? item.effort.youMin);
      const at = layoutDay({ ...layoutInput, suggestion: { key: `pull:${item.id}`, itemId: item.id, title: item.title, minutes } }).suggestionAt;
      const z = zoned(now, tz);
      const [y, m, d] = z.ymd.split('-').map(Number) as [number, number, number];
      // No gap fits all of it: start-by now (rounded up to 5 minutes); it still counts toward today.
      const startMin = at ?? Math.ceil((z.min + 1) / 5) * 5;
      const start = zonedInstant(y, m, d, Math.floor(startMin / 60), startMin % 60, tz);
      setHl(item.id);
      setTimeout(() => setHl((h) => (h === item.id ? null : h)), 1600);
      return actions.setStartBy(item, start.toISOString(), `Pulled into today at ${hhmm(startMin)}: ${item.title}`);
    },
    [layoutInput, now, tz, actions],
  );

  const replan = useCallback(
    (slotId: string, deltaMin: number) => {
      if (slotId.startsWith('pin:')) {
        const it = items.get(slotId.slice(4)) ?? catalog.get(slotId.slice(4));
        if (!it?.startBy) return;
        const start = new Date(msOf(it.startBy) + deltaMin * 60_000).toISOString();
        void actions.setStartBy(it, start, `Start-by moved to ${hhmm(minuteOfDay(start, tz))}: ${it.title}`);
        return;
      }
      const slot = slots.find((s) => s.id === slotId);
      if (!slot) return;
      const prev = plan;
      const start = new Date(msOf(slot.start) + deltaMin * 60_000).toISOString();
      const len = msOf(slot.end) - msOf(slot.start);
      const next: LocalPlan = slotId.startsWith('fit:')
        ? { ...plan, fits: { ...plan.fits, [slotId.slice(4)]: { ...plan.fits[slotId.slice(4)]!, start, end: new Date(msOf(start) + len).toISOString() } } }
        : { ...plan, moves: { ...plan.moves, [slotId]: start } };
      setPlan(next);
      toast({ key: `plan:${slotId}`, title: `Re-planned to ${hhmm(minuteOfDay(start, tz))}: ${stripLabel(slot.label)}`, body: 'Local plan only; your calendar is unchanged.', undo: { run: () => setPlan(prev) } });
    },
    [slots, plan, setPlan, tz, items, catalog, actions],
  );

  const { runPrimary, rowAction } = useRowActions({ actions, openDetails, openRow, pullIn, setPopover, setReauthFor });

  const closePopover = useCallback(() => {
    setPopover(null);
    const key = selectedKey;
    requestAnimationFrame(() => key && focusRow(key));
  }, [selectedKey, focusRow]);

  // ---- agent's plan: Accept all · Undo per row ----------------------------------------------------
  const { accepting, acceptAll, toggleChange } = useAgentPlanActions({ changes, excluded, agentPlan, setAgentPlan, setAgentSaved, dayKey, items, pullIn, actions, now });

  // ---- keyboard -----------------------------------------------------------------------------------
  const moveSel = useCallback(
    (delta: number) => {
      const r = ringRef.current;
      if (!r.length) return;
      // The selection is always visible (it carries the filled action), so j/k move from it right away.
      const i = selectedKey ? r.indexOf(selectedKey) : -1;
      const next = r[Math.max(0, Math.min(r.length - 1, (i < 0 ? (delta > 0 ? -1 : r.length) : i) + delta))]!;
      select(next);
      requestAnimationFrame(() => focusRow(next));
    },
    [selectedKey, select, focusRow],
  );
  const withSel = (fn: (row: DayRow, it: WorkItem | null) => void) => () => {
    if (!selectedRow) return false;
    fn(selectedRow, selectedRow.item);
  };
  const withItem = (fn: (row: DayRow, it: WorkItem) => void) => () => {
    if (!selectedRow?.item) return false;
    fn(selectedRow, selectedRow.item);
  };
  const isPlanCollapsed = () => {
    const tab = document.querySelector<HTMLElement>('[data-today-root] [data-plan-tab]');
    return !!tab && getComputedStyle(tab).display !== 'none';
  };
  const togglePlan = useCallback(() => {
    if (embedded) return onPlanKey?.();
    if (isPlanCollapsed()) setPlanOpen((v) => !v);
    else document.querySelector<HTMLElement>('[data-today-root] [data-accept-all]')?.focus();
  }, [embedded, onPlanKey]);
  const jumpToWaiting = useCallback(() => {
    const k = sections.fit.find((r) => r.key.startsWith('fit:wait:') || r.key === 'fit:approvals')?.key;
    if (!k) return false;
    select(k);
    requestAnimationFrame(() => focusRow(k));
  }, [sections.fit, select, focusRow]);
  const undoKey = () => {
    if (toastStore.latestUndoable()) return false;
    const closed = data?.rail.find((l) => l.lane === 'closed_for_you')?.entries.find((e) => e.action?.kind === 'undo' && e.action.auditId);
    if (!closed?.action?.auditId) return false;
    actions.undoClose(closed, closed.action.auditId);
  };
  useTodayKeys(!!data, {
    move: moveSel,
    jump: (n) => {
      const k = sections.run[n - 1]?.key;
      if (!k) return false;
      select(k);
      requestAnimationFrame(() => focusRow(k));
    },
    open: (mode) => {
      if (!selectedRow) return false;
      if (mode === 'page') openPage(selectedRow);
      else openRow(selectedRow);
    },
    expand: withSel((row) => setExpandedKey((k) => (k === row.key ? null : row.key))),
    primary: withSel((row) => runPrimary(row)),
    edit: withSel((row) => openRow(row)),
    accept: withItem((row, it) => {
      const p = row.card?.proposals.find((x) => x.status === 'pending');
      if (p) actions.applyProposal(p);
      else if (it.state === 'suggested') actions.accept(it);
      else if (it.state === 'likely_done') actions.confirmDone(it);
      else return false;
    }),
    snooze: withItem((row, it) => setPopover({ kind: 'snooze', itemId: it.id, surface: row.section })),
    done: withItem((_row, it) => (it.state === 'likely_done' ? actions.confirmDone(it) : actions.done(it))),
    resolve: withItem((row, it) => setPopover({ kind: 'resolve', itemId: it.id, surface: row.section })),
    notNow: withItem((_row, it) => actions.notNow(it, 'later')),
    openSource: withItem((_row, it) => {
      const s = it.sources.find((x) => x.url);
      if (!s?.url) return false;
      openExternal(s.url);
    }),
    rerank: () => actions.rerank(),
    waiting: jumpToWaiting,
    undo: undoKey,
    acceptPlan: () => void acceptAll(),
    togglePlan,
  });
  useKeyBinding('escape', () => setPlanOpen(false), { scope: TODAY_SCOPE, enabled: planOpen });

  // ---- ⌘K and chat context for the selected row --------------------------------------------------
  const selItem = selectedRow?.item ?? null;
  useChatContext(selectedRow ? { kind: selectedRow.entity.kind, id: selectedRow.entity.id, label: selectedRow.entity.label ?? selectedRow.title } : null);
  const pendingProposal = selectedRow?.card?.proposals.find((p) => p.status === 'pending') ?? null;
  const focusedCommands: Command[] = selectedRow
    ? [
        { id: 'today.row.primary', title: selectedRow.verb, shortcut: 'mod+enter', run: () => runPrimary(selectedRow) },
        { id: 'today.row.open', title: 'Open details', shortcut: 'enter', run: () => openRow(selectedRow) },
        ...(selItem
          ? [
              { id: 'today.row.page', title: 'Open full page', shortcut: 'shift+enter', run: () => openPage(selectedRow) },
              { id: 'today.row.done', title: 'Mark done', shortcut: 'd', keywords: ['complete', 'archive', 'finish'], run: () => actions.done(selItem) },
              { id: 'today.row.resolve', title: 'Resolve with a reason…', shortcut: 'shift+d', keywords: ['handed off', 'not needed', 'duplicate'], run: () => setPopover({ kind: 'resolve', itemId: selItem.id, surface: selectedRow.section }) },
              { id: 'today.row.snooze', title: 'Snooze…', shortcut: 's', keywords: ['later', 'remind'], run: () => setPopover({ kind: 'snooze', itemId: selItem.id, surface: selectedRow.section }) },
              { id: 'today.row.later', title: 'Not now: later', shortcut: 'n', keywords: ['dismiss', 'skip'], run: () => actions.notNow(selItem, 'later') },
              { id: 'today.row.notmine', title: 'Not now: not mine', keywords: ['dismiss'], run: () => actions.notNow(selItem, 'not_mine') },
              { id: 'today.row.source', title: 'Open source', shortcut: 'o', disabled: !selItem.sources.some((s) => s.url), run: () => openExternal(selItem.sources.find((s) => s.url)!.url!) },
              ...(selectedRow.section === 'pull' || selectedRow.section === 'promise' ? [{ id: 'today.row.pull', title: 'Pull into today', keywords: ['plan', 'schedule', 'slot'], run: () => void pullIn(selItem) }] : []),
              ...(pendingProposal
                ? [
                    { id: 'today.row.apply', title: 'Apply the proposed update', shortcut: 'a', run: () => actions.applyProposal(pendingProposal) },
                    { id: 'today.row.keep', title: 'Keep mine', run: () => actions.keepMine(pendingProposal) },
                  ]
                : []),
              ...(selItem.reopened || selItem.loopedBackIn ? [{ id: 'today.row.undoreopen', title: 'Undo the reopen', run: () => void actions.undoReopen(selItem) }] : []),
            ]
          : []),
      ]
    : [];
  useFocusedCommands(selectedRow ? { label: selectedRow.title, kind: selectedRow.entity.kind } : null, focusedCommands);
  useCommands([
    { id: 'today.rerank', title: model.rerankCount ? `Apply re-rank (${model.rerankCount} would move)` : 'Re-rank now', group: 'Today', shortcut: 'r', keywords: ['rank', 'order', 'refresh'], run: () => actions.rerank() },
    { id: 'today.plan.accept', title: 'Accept the agent’s plan', group: 'Today', shortcut: 'shift+a', keywords: ['plan', 'diff', 'apply'], disabled: !!agentPlan.acceptedAt || !changes.some((c) => !excluded.has(c.id)), run: () => void acceptAll() },
    embedded
      ? { id: 'today.plan.toggle', title: 'Home: back to the briefing', group: 'Home', shortcut: 'p', keywords: ['plan', 'home'], run: togglePlan }
      : { id: 'today.plan.toggle', title: 'Show the agent’s plan', group: 'Today', shortcut: 'p', keywords: ['plan', 'diff'], run: togglePlan },
    { id: 'today.waiting', title: 'Jump to what’s waiting on you', group: 'Today', shortcut: 'w', keywords: ['approvals', 'sessions', 'outbox'], run: () => void jumpToWaiting() },
    { id: 'today.promises', title: promisesOpen ? 'Hide promises' : 'Show promises', group: 'Today', keywords: ['said by me', 'stale'], run: () => setPromisesOpen(!promisesOpen) },
    { id: 'today.assistant', title: 'Ask the assistant for a different plan', group: 'Today', keywords: ['chat', 'plan'], run: () => panel.openAssistant() },
    ...sections.run.slice(0, 3).map((r, i) => ({
      id: `today.run.${i + 1}`,
      title: `Go to run of day ${i + 1}: ${r.title}`,
      group: 'Today',
      shortcut: String(i + 1),
      run: () => {
        select(r.key);
        requestAnimationFrame(() => focusRow(r.key));
      },
    })),
  ]);

  // ---- resume scroll ------------------------------------------------------------------------------
  const runRef = useRef<HTMLDivElement | null>(null);
  const planRef = useRef<HTMLDivElement | null>(null);
  useResumeScroll(runRef, 'today-run', { enabled: !!data });
  useResumeScroll(planRef, 'today-plan', { enabled: !!data });

  // Close the plan overlay when the container grows past the collapse width.
  useEffect(() => {
    if (!planOpen) return;
    const main = document.getElementById('cc-main');
    if (!main) return;
    const ro = new ResizeObserver(() => {
      if (!isPlanCollapsed()) setPlanOpen(false);
    });
    ro.observe(main);
    return () => ro.disconnect();
  }, [planOpen]);

  // ---- derived view bits --------------------------------------------------------------------------
  const runState = usePanelState('today.now', { loading: today.isLoading, error: data ? null : today.error, empty: !!data && !sections.run.length });
  const dayState = usePanelState('today.day', { loading: today.isLoading, empty: !!data && !data.spine.events.length && !data.spine.slots.length });
  const planState = usePanelState('today.plan', { loading: today.isLoading, empty: !!data && !changes.length });
  const shownIds = useMemo(() => new Set([...sections.run, ...sections.pull].map((r) => r.item?.id).filter((x): x is string => !!x)), [sections.run, sections.pull]);
  const newIds = model.newRowIds.filter((id) => shownIds.has(id));
  const showNew = useCallback(() => {
    const first = newIds[0];
    const row = [...sections.run, ...sections.pull].find((r) => r.item?.id === first);
    if (row) {
      select(row.key);
      requestAnimationFrame(() => focusRow(row.key));
    }
    model.clearNew();
  }, [newIds, sections.run, sections.pull, select, focusRow, model]);
  const relatedItems = useMemo(() => [...items.values()].map((i) => ({ id: i.id, title: i.title })), [items]);
  const blocked = useMemo(() => new Set([...items.values()].filter(isBlocked).map((i) => i.id)), [items]);

  const meetingState = useMeetingState(data?.spine.events, items, now);

  if (!data || !layout) {
    // First paint: skeletons mirror the final layout; the shell keeps working.
    return <TodaySkeleton error={today.error ? <PanelError title="Today didn’t load" error={today.error} onRetry={() => void today.refetch()} /> : null} />;
  }

  const ctx: TodayCtx = { now, tz, data, actions, popover, setPopover, closePopover, relatedItems, cardFor, openDetails, navigate };
  const panelShowsSelected = panel.open && panel.tab === 'details' && !!selectedRow && panel.entity?.id === selectedRow.entity.id;
  const runYou = sections.run.reduce((s, r) => s + r.youMin, 0);
  const rankedAt = hhmm(minuteOfDay(data.nowStack.rankedAt, tz));
  const headCount = sections.run.length ? `${sections.run.length} to do, in order · ${approx(runYou)} of you · planned ${rankedAt}` : `nothing due today · planned ${rankedAt}`;
  const handlers: RowHandlers = {
    selectedKey,
    filledKey: panelShowsSelected ? null : selectedKey,
    hlItemId: hl,
    newIds: new Set(newIds),
    expandedKey,
    reauthFor,
    onCloseReauth: () => setReauthFor(null),
    onSelect: select,
    onOpen: openRow,
    onPrimary: runPrimary,
    onAction: rowAction,
    onHover: setHl,
  };
  const settling = data.header.catchUp?.sources.filter((s) => !s.done).map((s) => `${s.label}${s.pct !== null ? ` ${s.pct}%` : ''}`).join(' · ') || null;
  const sinceLane = data.rail.find((l) => l.lane === 'since_you_left');
  const sinceNum = (k: string) => Number(sinceLane?.summary.match(new RegExp(`(\\d+) ${k}`))?.[1] ?? 0);
  const since = sinceLane?.visible ? { changed: sinceNum('changed'), closed: sinceNum('closed'), new: sinceNum('new') } : null;
  const meetingCount = data.spine.events.filter((e) => !['declined', 'cancelled'].includes(e.attendance) && zoned(e.start, tz).ymd === dayKey).length;
  const liveChanges = changes.filter((c) => !excluded.has(c.id)).length;
  const activeItemId = selectedRow?.item?.id ?? null;
  const dayOver = minuteOfDay(now, tz) >= workEnd;

  return (
    <DomainClock now={now} tz={tz}>
      <TodayProvider value={ctx}>
        <div data-today-root className="td-root" data-plan-open={planOpen || undefined} data-today-embedded={embedded || undefined}>
          {actions.launchDialog}
          <div className="grid min-w-0 gap-3">
            <DayHeader nowIso={now} tz={tz} cap={cap} agentLabels={agentLabels} dayOver={dayOver} catchUp={settling} preview={<PreviewToggle on={previewOn} onToggle={togglePreview} />} />
            <PriorityPreviewPanel on={previewOn} onClose={togglePreview} />
          </div>
          <div className="td-panes">
            <PanelBoundary name="today.day">
              <DayTimeline
                layout={layout}
                nowIso={now}
                meetingCount={meetingCount}
                meetingState={meetingState}
                items={items}
                blocked={blocked}
                activeItemId={activeItemId}
                hlItemId={hl}
                hlHintKey={selectedRow?.section === 'fit' ? selectedRow.key : null}
                onOpenEvent={(ev) => openDetails({ kind: 'calendar_event', id: ev.id, label: ev.title })}
                onOpenItem={(id) => {
                  const row = ringRows.find((r) => r.item?.id === id);
                  if (row) select(row.key);
                  openDetails(row?.entity ?? { kind: 'work_item', id, label: items.get(id)?.title });
                }}
                onHoverItem={setHl}
                onReplan={replan}
                state={dayState}
                onRetry={() => void today.refetch()}
              />
            </PanelBoundary>
            <PanelBoundary name="today.now" onRetry={() => void today.refetch()}>
              <RunOfDay
                ref={runRef}
                sections={shownSections}
                handlers={handlers}
                headCount={headCount}
                openLabel={`${approx(cap.openMin)} open`}
                rerankCount={model.rerankCount}
                reranking={actions.reranking}
                onRerank={() => actions.rerank()}
                newCount={newIds.length}
                onShowNew={showNew}
                refreshError={today.isError}
                onRetry={() => void today.refetch()}
                promisesOpen={promisesOpen}
                onPromisesOpen={setPromisesOpen}
                dayEnd={hhmm(workEnd)}
                triageCount={data.triageCount}
                state={runState}
                error={runState === 'error' ? (today.error ?? new Error('Forced error (dev toolbar)')) : null}
              />
            </PanelBoundary>
            <PlanTab open={planOpen} count={liveChanges} onToggle={() => setPlanOpen((v) => !v)} />
            <PanelBoundary name="today.plan">
              <AgentPlan
                ref={planRef}
                changes={changes}
                summary={summary}
                excluded={excluded}
                acceptedAt={agentPlan.acceptedAt}
                proposedAt={data.nowStack.rankedAt}
                accepting={accepting}
                onAcceptAll={() => void acceptAll()}
                onToggle={toggleChange}
                onOpen={(c) => (c.itemId ? openDetails({ kind: 'work_item', id: c.itemId, label: c.title }) : c.kind === 'rerank' ? actions.rerank() : undefined)}
                hlItemId={hl}
                onHover={setHl}
                since={since}
                onAskAssistant={() => panel.openAssistant(selectedRow ? selectedRow.entity : undefined)}
                state={planState}
                onRetry={() => void today.refetch()}
              />
            </PanelBoundary>
          </div>
        </div>
      </TodayProvider>
    </DomainClock>
  );
}
