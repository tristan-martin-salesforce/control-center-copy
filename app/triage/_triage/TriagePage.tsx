'use client';
/**
 * Triage (UI-SPEC §12; design v2): "What came in that might be mine?" Guesses stay here until you confirm
 * them. Verb sections in focus order, each 3 rows (5 at 2,400 px) with "See all N →":
 *   Looks done: confirm (LD-1) · Confirm asks and promises · Confirm meeting takeaways · Answer mapping questions
 *   · Claim missed opps
 * Rows are dashed ActionRows (the kit) with one quiet verb (filled on the selected row).
 *
 * Detail lives in the docked right panel: click or Enter calls openDetails (work_item for suggestions,
 * missed_opp and triage_mapping for the rest; their renderers are in @/components/lists/triage-panels).
 * j/k move the selection (an open Details tab follows), Esc closes. Keys: a accept · e edit then accept ·
 * n dismiss (reason) · m merge · o source · 1-9 answer a mapping · Space expand · ⇧Enter page.
 * Everything is optimistic with Undo (auditId), and the nav badge's Triage count drops in the same step.
 *
 * The header is the kit's PageHeader (the topbar holds the title). "Review N" opens the drain mode (TriageReview.tsx,
 * the kit's ReviewQueue) over the guesses to confirm; the list stays the default. Counts: the sentence, the position
 * line and the sidebar badge read triageCount (src/engines/activity/needs-count.ts): guesses, never the closed rows.
 */
import { AppLink } from '@/components/shell/AppLink';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TriageGroup, TriageItem } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands, useFocusedCommands, useKeyBinding, useListKeys } from '@/client/keyboard';
import { useResumeExtra, useResumeScroll, useResumeSelection } from '@/client/resume';
import { useChatContext } from '@/components/chat';
import { DomainClock, originSource, useClock } from '@/components/domain';
import { focusItemSoon, neighbourOf, useOpenKeys, usePageClock, useStableList } from '@/components/lists/hooks';
import { ListEnd, ListFrame, SelectionPosition, StaleRefresh } from '@/components/lists/ListFrame';
import { ListSection } from '@/components/lists/ListSection';
import { shownCount } from '@/components/lists/grouping';
import { useFollowWhenGone, useListPanel, useWide } from '@/components/lists/panel';
import { TRIAGE_PANELS_REGISTERED } from '@/components/lists/triage-panels';
import { useTriageActions } from '@/components/lists/useTriageActions';
import { Button, EmptyState, LivePill, PanelBoundary, PanelError, usePanelState } from '@/ui';
import { useArrivalHold, useSelectionSurvives } from '@/components/lists/live-list';
import { PageHeader } from '@/components/kit';
import { triageCount, triagePhrase } from '@/engines/activity/needs-count';
import { reviewableGuesses, TriageReview } from './TriageReview';
import { DismissDialog, MergePicker, TriageEditor } from './TriageParts';
import { closedAt, closedDayLabel, closedMessageUrl, TriageRow } from './TriageRows';
import { openDeepLink } from '@/components/detail/nba/ClaudeLaunchPanel';
import { TriageKeys, TriageListSkeletonBody } from './TriageSkeleton';
import { navigate } from '@/components/shell/router';

void TRIAGE_PANELS_REGISTERED;

export function TriagePage() {
  const clock = usePageClock();
  return (
    <DomainClock now={clock.now} tz={clock.tz}>
      <PanelBoundary name="triage">
        <TriageInner />
      </PanelBoundary>
    </DomainClock>
  );
}

const PANEL_KIND = { work_item: 'work_item', missed_opp: 'missed_opp', mapping: 'triage_mapping' } as const;

/** Focus order and verb names (the contract's labels are nouns: "Asks & promises"). */
const SECTION: Record<string, { order: number; title: string; sub: string; noun: string }> = {
  looks_done: { order: -1, title: 'Looks done: confirm', sub: 'one click each', noun: 'finished items' },
  asks_promises: { order: 0, title: 'Confirm asks and promises', sub: 'someone may be waiting on you', noun: 'asks and promises' },
  meeting_takeaways: { order: 1, title: 'Confirm meeting takeaways', sub: 'from meeting notes', noun: 'takeaways' },
  mappings: { order: 2, title: 'Answer mapping questions', sub: 'one key each', noun: 'questions' },
  missed_opps: { order: 3, title: 'Claim missed opportunities', sub: 'Org62 deals you may be on', noun: 'missed opps' },
  // DEEP-1: asks already over 30 days old when first seen, out of Today until you keep one
  still_needed: { order: 4, title: 'Still needed?', sub: 'asks over 30 days old when found: keep or close', noun: 'old asks' },
  // SETTLE-1: finished work the app closed for you (a record, never counted): its reason, its message, Undo
  closed_for_you: { order: 5, title: 'Closed for you', sub: 'last 14 days · each with its reason, its message and Undo', noun: 'closed items' },
};
const CLOSED = 'closed_for_you';
/** Edit (e) and merge (m) are for guesses: not a Looks done row, not a Closed for you row. */
const editable = (it: TriageItem) => it.kind === 'work_item' && it.group !== 'looks_done' && it.group !== CLOSED;

/**
 * SETTLE-1: a day header inside Closed for you ("Today", "Yesterday", "Mon Nov 3"), drawn before the first row of
 * each day. Presentation only: j/k and the grid's rows skip it.
 */
function ClosedDay({ rows, index }: { rows: TriageItem[]; index: number }) {
  const { now, tz } = useClock();
  const label = closedDayLabel(closedAt(rows[index]!), now, tz);
  if (index > 0 && closedDayLabel(closedAt(rows[index - 1]!), now, tz) === label) return null;
  return (
    <div role="presentation" data-testid="closed-day" className="px-3 pt-2 pb-0.5 text-caption font-bold text-muted">
      {label}
    </div>
  );
}
const sectionOf = (g: string, label: string) => SECTION[g] ?? { order: 9, title: label, sub: '', noun: label.toLowerCase() };

function TriageInner() {
  const q = useApi('getTriage');
  const wide = useWide();
  const panel = useListPanel();
  // undefined while loading: the first data is the list, not arrivals
  const flatItems = useMemo(() => q.data?.groups.flatMap((g) => g.items), [q.data]);
  const [sel, setSel] = useResumeSelection('triage');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hold = useArrivalHold(bodyRef);
  // Live (docs/UX.md "Live updates"): suggestions arrive marked in the AI color at their place; the one you are on stays.
  const stable = useStableList(flatItems, 'triage', false, { hold, keep: panel.openId ?? sel, tone: 'ai' });
  const [open, setOpen] = useResumeExtra('open-groups', {} as Record<string, boolean>);
  const pinId = panel.openId ?? sel;
  const sections = useMemo(() => {
    const byGroup = new Map<string, TriageItem[]>();
    for (const it of stable.items) byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), it]);
    return (q.data?.groups ?? [])
      .map((g) => {
        const items = byGroup.get(g.group) ?? [];
        const meta = sectionOf(g.group, g.label);
        // the row you are on stays in view when arrivals land above it
        const pin = pinId ? items.findIndex((i) => i.id === pinId) : -1;
        const shown = Math.max(shownCount(items.length, { expanded: !!open[g.group], wide }), pin + 1);
        return { group: g.group as TriageGroup, ...meta, items, shown, rows: items.slice(0, shown) };
      })
      .filter((g) => g.items.length > 0)
      .sort((a, b) => a.order - b.order);
  }, [q.data, stable.items, open, wide, pinId]);
  // Keys and ids follow what is shown (rows fading out are not selectable).
  const leaving = stable.isLeaving;
  const ids = useMemo(() => sections.flatMap((g) => g.rows.map((i) => i.id)).filter((id) => !leaving(id)), [sections, leaving]);
  const allIds = useMemo(() => sections.flatMap((g) => g.items.map((i) => i.id)).filter((id) => !leaving(id)), [sections, leaving]);
  const byId = useMemo(() => new Map(stable.items.map((i) => [i.id, i] as const)), [stable.items]);

  const explicit = !!sel && ids.includes(sel);
  const activeId = explicit ? sel : (ids[0] ?? null);
  const active = activeId ? (byId.get(activeId) ?? null) : null;
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mergeFor, setMergeFor] = useState<TriageItem | null>(null);
  const [dismissFor, setDismissFor] = useState<TriageItem | null>(null);
  const actions = useTriageActions();
  // SETTLE-1: /triage#closed_for_you (Home's "Closed N for you · Review") opens that group in full and scrolls to it
  const hasClosed = (q.data?.groups ?? []).some((g) => g.group === CLOSED && g.items.length > 0);
  const hashDone = useRef(false);
  useEffect(() => {
    if (!hasClosed || hashDone.current || typeof window === 'undefined' || window.location.hash !== `#${CLOSED}`) return;
    hashDone.current = true;
    if (!open[CLOSED]) setOpen({ ...open, [CLOSED]: true });
    requestAnimationFrame(() => document.getElementById(CLOSED)?.scrollIntoView({ block: 'start' }));
  }, [hasClosed, open, setOpen]);
  useResumeScroll(bodyRef, 'triage-list');
  useChatContext(active && { kind: PANEL_KIND[active.kind], id: active.id, label: active.title });
  const state = usePanelState('triage.list', { loading: q.isLoading, error: q.isError && !q.data, empty: !q.isLoading && ids.length === 0 });

  // ---- selection and the docked panel -------------------------------------------------------
  const entity = useCallback((it: TriageItem) => ({ kind: PANEL_KIND[it.kind], id: it.id, label: it.kind === 'missed_opp' ? (it.missedOpp?.oppName ?? it.title) : it.title }), []);
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
  const focusRow = useCallback((id: string | null) => focusItemSoon(bodyRef.current, id), []);

  // /triage?item=<id> (a promoted brief highlight's "Open in Triage", any deep link): open its group in full, select
  // the row and open it in Details. An item no longer in Triage (accepted, dismissed) still opens in Details.
  const itemDone = useRef(false);
  const loaded = !!q.data;
  useEffect(() => {
    if (itemDone.current || !loaded || typeof window === 'undefined') return;
    const want = new URLSearchParams(window.location.search).get('item');
    if (!want) return;
    itemDone.current = true;
    const it = byId.get(want);
    if (!it) {
      panel.open({ kind: 'work_item', id: want });
      return;
    }
    if (!ids.includes(it.id) && !open[it.group]) setOpen({ ...open, [it.group]: true });
    openDetails(it.id);
    focusRow(it.id);
  }, [loaded, byId, ids, open, setOpen, openDetails, focusRow, panel]);

  // An item accepted or dismissed from the panel leaves the list: Details moves on to its neighbour.
  useFollowWhenGone(ids, panel.openId, select, '', { goneTitle: 'Handled elsewhere', goneBody: 'This suggestion left Triage while you had it open (accepted, dismissed or closed somewhere else).', nextLabel: 'Next suggestion' });
  useSelectionSurvives(allIds, explicit ? sel : null, setSel);

  const land = useCallback(
    (fromId: string) => {
      const next = neighbourOf(ids, fromId);
      if (next) {
        select(next);
        focusRow(next);
      }
    },
    [ids, select, focusRow],
  );
  const openPage = useCallback(
    (it: TriageItem) => {
      if (it.kind === 'work_item') navigate(`/work/${it.id}`);
      else if (it.kind === 'missed_opp') navigate('/deals/missed');
      else openDetails(it.id);
    },
    [openDetails],
  );

  const accept = useCallback(
    (it: TriageItem) => {
      if (it.group === CLOSED) return false; // already closed: nothing to confirm
      if (it.kind === 'mapping') {
        // Never guess an answer for the user: put focus on the first choice.
        bodyRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(it.id)}"] [data-testid="mapping-choice"]`)?.focus();
        return;
      }
      land(it.id);
      if (it.group === 'looks_done') actions.confirmDone(it);
      else actions.accept(it.id); // a Still needed? row: Keep
    },
    [actions, land],
  );
  /** n: dismiss with a reason; a Looks done row (Not done) and a Still needed? row (Close) have one answer each. */
  const askDismiss = useCallback(
    (it: TriageItem) => {
      if (it.group === CLOSED) return false;
      if (it.group !== 'looks_done' && it.group !== 'still_needed') return setDismissFor(it);
      land(it.id);
      if (it.group === 'still_needed') actions.closeNotNeeded(it);
      else actions.notDone(it);
    },
    [actions, land],
  );
  const choose = useCallback(
    (it: TriageItem, choiceId: string, label: string) => {
      land(it.id);
      actions.accept(it.id, { choiceId, choiceLabel: label });
    },
    [actions, land],
  );
  const dismissWith = useCallback(
    (it: TriageItem, reason: string) => {
      land(it.id);
      actions.dismiss(it.id, reason);
      setDismissFor(null);
    },
    [actions, land],
  );
  const edit = useCallback((it: TriageItem) => editable(it) && setEditing(it.id), []);
  const merge = useCallback((it: TriageItem) => editable(it) && setMergeFor(it), []);
  // o: the origin source; on a Closed for you row, the message that settled it
  const openSource = useCallback((it: TriageItem) => {
    const url = it.group === CLOSED ? closedMessageUrl(it) : originSource(it.sources)?.url;
    if (url) openDeepLink(url);
  }, []);
  /** SETTLE-1: Undo a close for you (or Reopen); it leaves the group and does not come back on its own. */
  const undoClose = useCallback(
    (it: TriageItem) => {
      land(it.id);
      actions.undoClose(it);
    },
    [actions, land],
  );

  const on = (fn: (it: TriageItem) => void) => (id: string) => {
    const it = byId.get(id);
    if (it) fn(it);
  };

  const lk = useListKeys({
    scope: 'list:triage',
    ids,
    // The explicit selection only: the first j selects the first row (as on Home).
    activeId: explicit ? activeId : null,
    primary: true,
    moveFocus: false,
    onActiveChange: (id) => {
      select(id);
      focusRow(id);
    },
    actions: { a: on(accept), e: on(edit), n: on(askDismiss), o: on(openSource) },
  });
  useOpenKeys({ scope: 'list:triage', enabled: lk.active, activeId, onOpen: openDetails, onOpenPage: on(openPage), onExpand: (id) => setExpanded((e) => (e === id ? null : id)) });
  useKeyBinding('m', () => (active && editable(active) ? merge(active) : false), { scope: 'list:triage', enabled: lk.active, description: 'Merge into an existing item', group: 'Triage' });
  useKeyBinding(
    'escape',
    () => {
      if (!panel.close()) return false;
      focusRow(activeId);
    },
    { scope: 'list:triage', enabled: lk.active },
  );

  // Drain mode: one guess at a time (the list stays the default view)
  const [reviewing, setReviewing] = useState(false);
  const reviewable = useMemo(() => reviewableGuesses(flatItems ?? []), [flatItems]);
  const refetch = useCallback(() => void q.refetch(), [q]);
  useCommands([
    { id: 'triage.open-missed', title: 'Triage: view missed opportunities in Deals', group: 'View', keywords: ['deals'], run: () => navigate('/deals/missed') },
    ...(reviewable.length && !reviewing ? [{ id: 'triage.review', title: `Triage: review ${reviewable.length} one at a time`, group: 'Triage', keywords: ['drain', 'queue', 'accept'], run: () => setReviewing(true) }] : []),
  ]);
  useFocusedCommands(
    { label: active?.title ?? 'Triage item', kind: active ? PANEL_KIND[active.kind] : undefined },
    active && active.group === CLOSED
      ? [
          ...(closedMessageUrl(active) ? [{ id: 'triage.open-message', title: 'Open the message that settled it', shortcut: 'o', run: () => openSource(active) }] : []),
          { id: 'triage.undo-close', title: active.undoAuditId ? 'Undo: back to how it was' : 'Reopen it', keywords: ['reopen', 'not done', 'undo'], run: () => undoClose(active) },
          { id: 'triage.details', title: 'Open details', shortcut: 'enter', run: () => openDetails(active.id) },
          ...(panel.detailsOpen ? [{ id: 'triage.close', title: 'Close details', shortcut: 'escape', run: () => void panel.close() }] : []),
        ]
      : active
      ? [
          { id: 'triage.accept', title: active.group === 'looks_done' ? 'Confirm done' : active.group === 'still_needed' ? 'Keep: still needed' : active.kind === 'missed_opp' ? 'Claim: add a DC request' : 'Accept', shortcut: 'a', keywords: ['confirm'], disabled: active.kind === 'mapping', run: () => accept(active) },
          ...(editable(active)
            ? [
                { id: 'triage.edit', title: 'Edit, then accept', shortcut: 'e', run: () => edit(active) },
                { id: 'triage.merge', title: 'Merge into an existing item…', shortcut: 'm', run: () => merge(active) },
              ]
            : []),
          ...(active.kind === 'mapping' ? active.mapping!.choices.slice(0, 9).map((c, i) => ({ id: `triage.choice.${c.id}`, title: `Answer: ${c.label}`, shortcut: String(i + 1), run: () => choose(active, c.id, c.label) })) : []),
          { id: 'triage.dismiss', title: active.group === 'looks_done' ? 'Not done' : active.group === 'still_needed' ? 'Close: not needed' : active.kind === 'mapping' ? 'Not sure…' : 'Dismiss…', shortcut: 'n', keywords: ['not mine', 'reject'], run: () => askDismiss(active) },
          { id: 'triage.details', title: 'Open details', shortcut: 'enter', run: () => openDetails(active.id) },
          ...(panel.detailsOpen ? [{ id: 'triage.close', title: 'Close details', shortcut: 'escape', run: () => void panel.close() }] : []),
          ...(active.kind === 'missed_opp' ? [{ id: 'triage.expand', title: expanded === active.id ? 'Hide the evidence' : 'Show the evidence', shortcut: 'space', run: () => setExpanded((e) => (e === active.id ? null : active.id)) }] : []),
        ]
      : [],
  );

  const n = (g: string) => sections.find((s) => s.group === g)?.items.length ?? 0;
  // one count: the sentence, the position line and the sidebar badge (navCounts.triage, pinned by tests/ui/counts-parity)
  const tc = triageCount({ guesses: q.data?.count ?? 0, closed: n(CLOSED) });
  const count = tc.guesses;
  const asks = n('asks_promises') + n('meeting_takeaways');
  const questions = n('mappings');
  const missed = n('missed_opps');
  const looks = n('looks_done');
  const old = n('still_needed');
  const closedN = n(CLOSED);
  const parts = [
    looks ? `${looks} ${looks === 1 ? 'looks' : 'look'} done` : '',
    asks ? `${asks} ${asks === 1 ? 'ask or takeaway' : 'asks and takeaways'}` : '',
    questions ? `${questions} ${questions === 1 ? 'question' : 'questions'}` : '',
    missed ? `${missed} possible missed ${missed === 1 ? 'opp' : 'opps'}` : '',
    old ? `${old} old ${old === 1 ? 'ask' : 'asks'} to keep or close` : '',
  ].filter(Boolean);
  // SETTLE-1: what closed for you is said after the guesses, never counted with them
  const closedNote = closedN ? ` ${closedN} closed for you in the last 14 days, each with Undo.` : '';
  const lead = !count ? (
    <>
      <b>Triage is clear.</b>
      {closedNote}
    </>
  ) : (
    <>
      <b data-testid="triage-count">{triagePhrase(tc)}</b>
      {parts.length ? `: ${parts.join(', ')}` : ''}.{closedNote}
    </>
  );

  if (reviewing) return <TriageReview items={flatItems ?? []} onEdit={openDetails} onExit={() => setReviewing(false)} refetch={refetch} />;

  const position = explicit && activeId ? allIds.indexOf(activeId) : -1;
  return (
    <>
      <ListFrame
        label="Triage"
        data-state={state}
        header={
          <>
            <PageHeader
              route="triage"
              titleIn="topbar"
              inset={false}
              rule={false}
              sentence={<span data-testid="list-lead">{q.isLoading ? 'Loading what came in…' : lead}</span>}
              actions={
                <>
                  {q.isError && q.data ? <StaleRefresh onRetry={() => void q.refetch()} /> : null}
                  {/* the position counts every row while one is selected; otherwise the guesses (never the closed rows) */}
                  <span className="text-caption text-muted">
                    <SelectionPosition index={position} total={position >= 0 ? tc.rows : tc.guesses} noun={position >= 0 && closedN ? 'item' : 'guess'} nouns={position >= 0 && closedN ? 'items' : 'guesses'} />
                  </span>
                  {reviewable.length ? (
                    <Button size="sm" variant="secondary" icon="preview" onClick={() => setReviewing(true)} title="Go through the guesses one at a time: a accept · s later · x not mine · j skip" data-testid="triage-review-open">
                      Review {reviewable.length}
                    </Button>
                  ) : null}
                </>
              }
            />
            <div className="cc-list-sub">
              <TriageKeys />
            </div>
          </>
        }
        bodyRef={bodyRef}
      >
        <PanelBoundary name="triage.list" onRetry={() => void q.refetch()}>
          {state === 'loading' ? (
            <TriageListSkeletonBody />
          ) : state === 'error' || (q.isError && !q.data) ? (
            <PanelError title="Triage failed to load" error={q.error} onRetry={() => void q.refetch()} />
          ) : state === 'empty' ? (
            <EmptyState
              icon="success"
              title="Triage is clear"
              body="New asks, promises, meeting takeaways and mapping questions land here as the scanners read Slack, Gmail and meeting notes, each time the worker runs a scan."
              action={
                <AppLink href="/work">
                  <Button variant="secondary" size="sm">
                    Go to Work
                  </Button>
                </AppLink>
              }
            />
          ) : (
            <div
              {...lk.containerProps}
              data-testid="triage-list"
              onFocusCapture={(e) => {
                const id = (e.target as HTMLElement).closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
                if (id && id !== sel && ids.includes(id)) select(id);
              }}
            >
              <LivePill count={stable.held.length} noun={stable.held.length === 1 ? 'new suggestion' : 'new suggestions'} onShow={stable.showHeld} />
              <div className="cc-list-sections" data-cols={sections.length >= 3 ? '3' : sections.length === 2 ? '2' : '1'}>
                {sections.map((g) => (
                  <ListSection
                    key={g.group}
                    id={g.group === CLOSED ? CLOSED : undefined}
                    data-section={g.group}
                    title={g.title}
                    count={g.items.length}
                    sub={g.sub}
                    action={
                      g.group === 'missed_opps' ? (
                        <AppLink href="/deals/missed" className="inline-flex h-8 items-center rounded-md px-2 text-caption font-bold text-link hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus">
                          Open in Deals
                        </AppLink>
                      ) : undefined
                    }
                    total={g.items.length}
                    shown={g.shown}
                    expanded={!!open[g.group]}
                    onExpand={(v) => setOpen({ ...open, [g.group]: v })}
                    noun={g.noun}
                  >
                    {g.rows.map((it, i) => (
                      <Fragment key={it.id}>
                      {g.group === CLOSED ? <ClosedDay rows={g.rows} index={i} /> : null}
                      <TriageRow
                        item={it}
                        rowProps={{ ...lk.rowProps(it.id), ...stable.rowProps(it.id) }}
                        selected={explicit && activeId === it.id}
                        emphasis={!explicit && i === 0 && g === sections[0]}
                        inPanel={panel.openId === it.id}
                        expanded={expanded === it.id}
                        onOpen={(mode) => (mode === 'page' ? openPage(it) : openDetails(it.id))}
                        onAccept={() => accept(it)}
                        onDismiss={() => askDismiss(it)}
                        onEdit={() => edit(it)}
                        onMerge={() => merge(it)}
                        onChoose={(cid, label) => choose(it, cid, label)}
                        onUndo={() => undoClose(it)}
                        editor={
                          editing === it.id && it.workItem ? (
                            <TriageEditor
                              item={it.workItem}
                              onCancel={() => {
                                setEditing(null);
                                focusRow(it.id);
                              }}
                              onSave={(edits) => {
                                setEditing(null);
                                land(it.id);
                                actions.accept(it.id, { edits });
                              }}
                            />
                          ) : null
                        }
                      />
                      </Fragment>
                    ))}
                  </ListSection>
                ))}
              </div>
              <ListEnd>Guesses stay here until you confirm them. Nothing becomes a task, and nothing leaves, without you.</ListEnd>
            </div>
          )}
        </PanelBoundary>
      </ListFrame>

      <MergePicker
        source={mergeFor}
        onClose={() => setMergeFor(null)}
        onPick={(target) => {
          if (mergeFor) {
            land(mergeFor.id);
            actions.merge(mergeFor.id, target.id, target.title);
          }
          setMergeFor(null);
        }}
      />
      <DismissDialog item={dismissFor} onClose={() => setDismissFor(null)} onPick={(reason) => dismissFor && dismissWith(dismissFor, reason)} />
    </>
  );
}
