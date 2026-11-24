'use client';
/**
 * Outbox (UI-SPEC §12; design v2): the border of the whole app. Verb sections in focus order:
 *   Approve (pending approval) · Retry (failed) · Sending now · Going out later (scheduled) · Sent
 * Empty sections disappear. Nothing here is sent without an explicit Approve, then a confirm, then the
 * undo window. "Approve all N" is one confirm per draft (useOutboxSend's queue). Dry run is stated in
 * the lead and on every rendered row: approving then only renders the exact payload.
 *
 * Detail lives in the docked right panel: click or Enter calls openDetails({kind: 'draft'}) and V2-DETAIL's
 * draft renderer shows the composer (its own Send goes through the same preview and confirm).
 * `/outbox?draft=<id>` (B-061) opens that draft in the panel on load; the read-in's "Open draft" links here.
 * Keys: j/k move (an open Details tab follows) · Enter details · Esc close · a approve · e edit · o open the
 * message it answers (Slack / Gmail) · Space preview and history · ⇧Enter the linked work item.
 *
 * Live (docs/UX.md "Live updates"): a new draft enters at its place (the top of its section), marked in the AI color,
 * while the draft you selected stays selected and in view (the section cap grows to keep it). A draft sent or applied
 * elsewhere fades out; the one open in the panel stays, and the panel says "Sent or applied elsewhere".
 *
 * The header is the kit's PageHeader (the topbar holds the title). "Review N" opens the drain mode (OutboxReview.tsx,
 * the kit's ReviewQueue) over the drafts that wait on you; the list stays the default. Counts: the sentence, the
 * Review button and the sidebar badge all read outboxCount (src/engines/activity/needs-count.ts).
 */
import { AppLink } from '@/components/shell/AppLink';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminDraftHref, type OutboxItem } from '@/contract';
import { api } from '@/client/api';
import { toast } from '@/client/toast';
import { useApi } from '@/client/hooks';
import { useCommands, useFocusedCommands, useKeyBinding, useListKeys } from '@/client/keyboard';
import { useResumeExtra, useResumeScroll, useResumeSelection } from '@/client/resume';
import { useChatContext } from '@/components/chat';
import { destinationLabel } from '@/components/composer';
import { DomainClock, StatusBadge } from '@/components/domain';
import { outboxCount, outboxPhrase } from '@/engines/activity/needs-count';
import { PageHeader } from '@/components/kit';
import { focusItemSoon, useOpenKeys, usePageClock, useStableList } from '@/components/lists/hooks';
import { ListEnd, ListFrame, SelectionPosition, StaleRefresh } from '@/components/lists/ListFrame';
import { ListSection, SectionAction } from '@/components/lists/ListSection';
import { canApprove, OUTBOX_SECTIONS, outboxSection, sentBreakdown, stagedLabel, stagedWhere, type OutboxSection } from '@/components/lists/outbox';
import { shownCount } from '@/components/lists/grouping';
import { useFollowWhenGone, useListPanel, useWide } from '@/components/lists/panel';
import { useArrivalHold, useSelectionSurvives } from '@/components/lists/live-list';
import { Button, EmptyState, LivePill, PanelBoundary, PanelError, usePanelState } from '@/ui';
import { OutboxRow, rowSource, type RowFlow } from './OutboxRow';
import { openDeepLink } from '@/components/detail/nba/ClaudeLaunchPanel';
import { OutboxListSkeletonBody } from './OutboxSkeleton';
import { OutboxReview, reviewableDrafts } from './OutboxReview';
import { useOutboxSend } from './useOutboxSend';
import { releaseApproveKind } from './release';
import { markUploaded } from './ReleaseParts';
import { navigate } from '@/components/shell/router';

type SectionKey = OutboxSection;
const SECTIONS = OUTBOX_SECTIONS;
const sectionOf = outboxSection;

const labelOf = (it: OutboxItem) => destinationLabel(it.draft.destination);

export function OutboxPage() {
  const clock = usePageClock();
  return (
    <DomainClock now={clock.now} tz={clock.tz}>
      <PanelBoundary name="outbox">
        <OutboxInner now={clock.now} tz={clock.tz} />
      </PanelBoundary>
    </DomainClock>
  );
}

function OutboxInner({ now, tz }: { now: string; tz?: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const q = useApi('getOutbox');
  const settings = useApi('getSettings');
  const dryRun = q.data?.dryRun ?? true;
  const undoSec = settings.data?.sending.undoWindowSec ?? 10;
  const wide = useWide();
  const panel = useListPanel();

  // undefined while loading: the first data is the list, not arrivals
  const flat = useMemo(() => q.data?.groups.flatMap((g) => g.items.map((i) => ({ ...i, id: i.draft.id }))), [q.data]);
  const [sel, setSel] = useResumeSelection('outbox');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hold = useArrivalHold(bodyRef);
  const stable = useStableList(flat, 'outbox', false, { hold, keep: panel.openId ?? sel, tone: 'ai' });
  const [open, setOpen] = useResumeExtra('open-sections', {} as Record<string, boolean>);
  // The draft you are on stays in view: a section's cap grows to keep the selected (or open) row when arrivals land above it.
  const pinId = panel.openId ?? sel;
  const sections = useMemo(() => {
    const m = new Map<SectionKey, OutboxItem[]>();
    for (const it of stable.items) {
      const k = sectionOf(it);
      m.set(k, [...(m.get(k) ?? []), it]);
    }
    return SECTIONS.map((s) => {
      const items = m.get(s.key) ?? [];
      const pin = pinId ? items.findIndex((i) => i.draft.id === pinId) : -1;
      const shown = Math.max(shownCount(items.length, { expanded: !!open[s.key], wide }), pin + 1);
      return { ...s, items, shown, rows: items.slice(0, shown) };
    }).filter((s) => s.items.length > 0);
  }, [stable.items, open, wide, pinId]);
  const leaving = stable.isLeaving;
  const ids = useMemo(() => sections.flatMap((s) => s.rows.map((i) => i.draft.id)).filter((id) => !leaving(id)), [sections, leaving]);
  const allIds = useMemo(() => sections.flatMap((s) => s.items.map((i) => i.draft.id)).filter((id) => !leaving(id)), [sections, leaving]);
  const byId = useMemo(() => new Map(stable.items.map((i) => [i.draft.id, i] as const)), [stable.items]);

  const explicit = !!sel && ids.includes(sel);
  const activeId = explicit ? sel : (ids[0] ?? null);
  const active = activeId ? (byId.get(activeId) ?? null) : null;
  const [expanded, setExpanded] = useResumeExtra<string | null>('expanded', null);
  useResumeScroll(bodyRef, 'outbox-list');
  useChatContext(active && { kind: 'draft', id: active.draft.id, label: labelOf(active) });
  const state = usePanelState('outbox.list', { loading: q.isLoading, error: q.isError && !q.data, empty: !q.isLoading && (flat?.length ?? 0) === 0 });

  // ---- selection and the docked panel -------------------------------------------------------
  const entity = useCallback((it: OutboxItem) => ({ kind: 'draft' as const, id: it.draft.id, label: labelOf(it) }), []);
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
      panel.open(it ? entity(it) : { kind: 'draft', id });
    },
    [byId, entity, panel, setSel],
  );
  const focusRow = useCallback((id: string | null) => focusItemSoon(bodyRef.current, id), []);
  useFollowWhenGone(ids, panel.openId, select, '', {
    goneTitle: 'Sent or applied elsewhere',
    goneBody: 'This draft left the Outbox while you had it open (sent, applied or withdrawn somewhere else). It stays here so you can read it.',
    nextLabel: 'Next draft',
  });
  useSelectionSurvives(allIds, explicit ? sel : null, setSel);

  // B-061: /outbox?draft=<id> opens that draft in the panel (once the Outbox has loaded, so the row is selected too).
  const draftParam = search.get('draft');
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!draftParam || handled.current === draftParam || (!q.data && !q.isError)) return;
    handled.current = draftParam;
    // D-52, D-75: a logging canvas or a VDP change is Activity's, applied or not (older links, the Assistant's answers)
    const admin = [...(q.data?.admin.items ?? []), ...(q.data?.admin.applied ?? [])].find((i) => i.draft.id === draftParam);
    if (admin) {
      navigate(adminDraftHref(admin.draft), { replace: true });
      return;
    }
    openDetails(draftParam);
    if (byId.has(draftParam)) focusRow(draftParam);
    // The panel's own URL state takes over; drop ours so a later reload doesn't reopen a closed panel.
    const url = new URL(window.location.href);
    url.searchParams.delete('draft');
    window.history.replaceState(window.history.state, '', `${pathname}${url.search}`);
  }, [draftParam, q.data, q.isError, byId, openDetails, focusRow, pathname]);

  const send = useOutboxSend({
    dryRun,
    undoSec,
    onDone: (draft, outcome) => {
      if (outcome === 'dry_run') {
        toast({
          key: `outbox:${draft.id}`,
          title: 'Dry run: payload rendered',
          body: 'Nothing was sent. The result is on the row.',
          action: { label: 'View', onClick: () => setExpanded(draft.id) },
        });
      } else {
        const where = outcome === 'staged' ? stagedWhere(draft.destination) : null;
        toast({
          key: `outbox:${draft.id}`,
          title: outcome === 'staged' ? (stagedLabel(draft.destination) ?? 'Draft saved') : 'Sent',
          body: `${where ? `Find it ${where}. ` : ''}Checking it landed. The row shows Verified when it does.`,
          tone: 'success',
        });
      }
    },
  });

  // D-90: "Mark uploaded" on a release upload hand-off: recorded by the server, nothing is sent (no confirm dialog, no undo)
  const markHandedOff = useCallback(
    async (it: OutboxItem) => {
      try {
        await markUploaded(it.draft);
        toast({ key: `outbox:${it.draft.id}`, title: 'Marked uploaded', body: 'The hand-off is recorded. Nothing was sent: next, approve the announcement.', tone: 'success' });
      } catch (err) {
        toast({ key: `outbox:${it.draft.id}`, tone: 'error', title: "Couldn't mark it uploaded", body: err instanceof Error ? err.message : undefined, durationMs: null });
      }
      void q.refetch();
    },
    [q],
  );
  const approve = useCallback(
    (it: OutboxItem) => {
      if (!canApprove(it.group)) return;
      setSel(it.draft.id);
      if (releaseApproveKind(it) === 'mark') return void markHandedOff(it);
      send.approve(it.draft);
    },
    [send, setSel, markHandedOff],
  );
  // REJECT-1: turn a draft down. It leaves the Outbox, nothing is sent, the task stays open; Undo on the toast.
  const reject = useCallback(
    async (it: OutboxItem) => {
      if (!canApprove(it.group)) return;
      try {
        const r = await api('rejectDraft', { params: { id: it.draft.id }, body: {} });
        toast({ key: `outbox:${it.draft.id}`, title: 'Draft rejected', body: 'Nothing was sent. The task stays open.', ...(r.auditId ? { undo: { auditId: r.auditId } } : {}) });
        void q.refetch();
      } catch (err) {
        toast({ key: `outbox:${it.draft.id}`, tone: 'error', title: "Couldn't reject the draft", body: err instanceof Error ? err.message : undefined, durationMs: null });
      }
    },
    [q],
  );
  const onId = (fn: (it: OutboxItem) => void) => (id: string) => {
    const it = byId.get(id);
    if (it) fn(it);
  };
  const toggleExpand = useCallback((id: string) => setExpanded(expanded === id ? null : id), [expanded, setExpanded]);
  // o: the message the draft answers, in Slack or Gmail
  const openSource = useCallback((it: OutboxItem) => {
    const src = rowSource(it);
    if (src) openDeepLink(src.url);
  }, []);

  const lk = useListKeys({
    scope: 'list:outbox',
    ids,
    // The explicit selection only: the first j selects the first row (as on Home).
    activeId: explicit ? activeId : null,
    primary: true,
    moveFocus: false,
    onActiveChange: (id) => {
      select(id);
      focusRow(id);
    },
    actions: { a: onId(approve), e: onId((it) => it.group !== 'sent' && openDetails(it.draft.id)), o: onId(openSource) },
  });
  useOpenKeys({
    scope: 'list:outbox',
    enabled: lk.active,
    activeId,
    onOpen: openDetails,
    onOpenPage: onId((it) => it.workItem && navigate(`/work/${it.workItem.id}`)),
    onExpand: toggleExpand,
  });
  useKeyBinding(
    'escape',
    () => {
      if (!panel.close()) return false;
      focusRow(activeId);
    },
    { scope: 'list:outbox', enabled: lk.active },
  );

  const pending = sections.find((s) => s.key === 'approve')?.items ?? [];
  const approveAll = () => send.approveAll(pending.map((i) => i.draft));
  // Drain mode: one draft at a time (the list stays the default view)
  const [reviewing, setReviewing] = useState(false);
  const reviewable = useMemo(() => reviewableDrafts(flat ?? []), [flat]);
  const refetch = useCallback(() => void q.refetch(), [q]);
  useCommands([
    { id: 'outbox.settings', title: 'Outbox: sending settings (dry run, undo window)', group: 'View', run: () => navigate('/settings?section=sending') },
    ...(reviewable.length && !reviewing ? [{ id: 'outbox.review', title: `Outbox: review ${reviewable.length} one at a time`, group: 'Outbox', keywords: ['drain', 'queue', 'approve'], run: () => setReviewing(true) }] : []),
    ...(pending.length > 1 ? [{ id: 'outbox.approve-all', title: `Outbox: approve all ${pending.length} (one confirm each)`, group: 'Outbox', keywords: ['batch', 'send'], run: approveAll }] : []),
  ]);
  const activeSource = active ? rowSource(active) : null;
  useFocusedCommands(
    { label: active ? labelOf(active) : 'Outbox item', kind: 'draft' },
    active
      ? [
          ...(canApprove(active.group) ? [{ id: 'outbox.approve', title: 'Approve… (shows the payload first)', shortcut: 'a', run: () => approve(active) }] : []),
          ...(canApprove(active.group) && active.group !== 'failed' ? [{ id: 'outbox.reject', title: 'Reject the draft (nothing is sent)', run: () => void reject(active) }] : []),
          ...(active.group !== 'sent' ? [{ id: 'outbox.edit', title: 'Edit the draft in the panel', shortcut: 'e', run: () => openDetails(active.draft.id) }] : []),
          { id: 'outbox.open', title: 'Open details', shortcut: 'enter', run: () => openDetails(active.draft.id) },
          ...(activeSource ? [{ id: 'outbox.source', title: `${activeSource.label}: the message this answers`, shortcut: 'o', run: () => openSource(active) }] : []),
          ...(panel.detailsOpen ? [{ id: 'outbox.close', title: 'Close details', shortcut: 'escape', run: () => void panel.close() }] : []),
          { id: 'outbox.preview', title: expanded === active.draft.id ? 'Hide the preview and history' : 'Show the preview and history', shortcut: 'space', run: () => toggleExpand(active.draft.id) },
          ...(active.workItem ? [{ id: 'outbox.item', title: 'Open the linked work item', shortcut: 'shift+enter', run: () => navigate(`/work/${active.workItem!.id}`) }] : []),
        ]
      : [],
  );

  const flowFor = (id: string): RowFlow => {
    if (send.target?.id !== id) return { phase: 'idle' };
    const s = send.state;
    if (s.phase === 'error') return { phase: 'error', error: s.error?.message, retryable: s.error?.retryable || s.error?.reconfirm };
    if (s.phase === 'done') return { phase: 'done', outcome: s.outcome };
    if (s.phase === 'idle') return { phase: 'idle' };
    return { phase: 'working' };
  };
  const working = ['previewing', 'confirming', 'countdown', 'dispatching'].includes(send.state.phase);

  const counts = q.data?.counts;
  const failed = sections.find((s) => s.key === 'retry')?.items.length ?? 0;
  const sent = sections.find((s) => s.key === 'sent')?.items ?? [];
  // one count: the sentence, the Review button and the sidebar badge (navCounts.outbox, pinned by tests/ui/counts-parity)
  const waiting = outboxCount({ pending: pending.length, failed });
  const lead = waiting.pending ? (
    <>
      <b data-testid="outbox-count">{outboxPhrase(waiting)}</b>. Nothing is sent until you confirm each one.
    </>
  ) : waiting.failed ? (
    <>
      <b data-testid="outbox-count">{outboxPhrase(waiting)}.</b> Retry shows a fresh preview and asks again.
    </>
  ) : (
    <>
      <b>Nothing to approve.</b> {sent.length ? `${sent.length} sent${sentBreakdown(sent.map((i) => i.draft)) ? `: ${sentBreakdown(sent.map((i) => i.draft))}` : ''}.` : 'Drafts you ask to send land here first.'}
    </>
  );

  const sectionSub = (key: SectionKey, items: OutboxItem[]) =>
    key === 'approve' ? (dryRun ? 'dry run: approving renders the payload, nothing is sent' : 'each one shows its payload and asks you to confirm') : key === 'sent' ? sentBreakdown(items.map((i) => i.draft)) : key === 'retry' ? 'a fresh preview and confirm each' : undefined;

  const sectionAction = (key: SectionKey, items: OutboxItem[]) => {
    if (key !== 'approve' || items.length < 2) return undefined;
    if (send.queue)
      return (
        <span className="inline-flex items-center gap-2 text-caption text-muted" aria-live="polite" data-testid="approve-queue">
          Approving <b className="font-bold text-fg tabular-nums">{send.queue.index}</b> of {send.queue.total}
          <SectionAction onClick={send.stopQueue} title="Stop after this one">
            Stop
          </SectionAction>
        </span>
      );
    return (
      <SectionAction onClick={approveAll} disabled={working} title="One preview and one confirm per draft. Cancelling any confirm stops the rest." testId="approve-all">
        Approve all {items.length}
        {dryRun ? ' (dry run)' : ''}
      </SectionAction>
    );
  };

  const sub = q.data ? (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="dry-run-mode">
      {dryRun ? (
        <>
          <StatusBadge tone="neutral" icon="lock">
            Dry run is on
          </StatusBadge>
          <span className="cc-hide-narrow">Approving renders the exact payload and records it here. Nothing leaves this machine.</span>
        </>
      ) : (
        <>
          <StatusBadge tone="warning" icon="send">
            Live send is on
          </StatusBadge>
          <span className="cc-hide-narrow">Approve shows the payload, asks you to confirm, then waits {undoSec} s so you can undo before it goes.</span>
        </>
      )}
      <AppLink href="/settings?section=sending" className="font-bold text-link hover:underline">
        Sending settings
      </AppLink>
    </span>
  ) : null;

  if (reviewing)
    return (
      <>
        <OutboxReview items={flat ?? []} send={send} dryRun={dryRun} now={now} tz={tz} onEdit={openDetails} onExit={() => setReviewing(false)} refetch={refetch} />
        {send.overlays}
      </>
    );

  return (
    <>
      <ListFrame
        label="Outbox"
        data-state={state}
        header={
          <>
            <PageHeader
              route="outbox"
              titleIn="topbar"
              inset={false}
              rule={false}
              sentence={<span data-testid="list-lead">{q.isLoading ? 'Loading the Outbox…' : lead}</span>}
              actions={
                <>
                  {q.isError && q.data ? <StaleRefresh onRetry={() => void q.refetch()} /> : null}
                  <span className="text-caption text-muted">
                    {/* while a row is selected, where it sits among every row; otherwise what waits on you (the sentence's number) */}
                    <SelectionPosition index={explicit && activeId ? allIds.indexOf(activeId) : -1} total={explicit && activeId ? allIds.length : waiting.total} noun={explicit && activeId ? 'draft' : 'waiting'} nouns={explicit && activeId ? 'drafts' : 'waiting'} />
                  </span>
                  {reviewable.length ? (
                    <Button size="sm" variant="secondary" icon="preview" onClick={() => setReviewing(true)} title="Go through the drafts one at a time: a approve · e edit · x reject · j skip" data-testid="outbox-review-open">
                      Review {reviewable.length}
                    </Button>
                  ) : null}
                </>
              }
            />
            {sub ? <div className="cc-list-sub">{sub}</div> : null}
          </>
        }
        bodyRef={bodyRef}
      >
        <PanelBoundary name="outbox.list" onRetry={() => void q.refetch()}>
          {state === 'loading' ? (
            <OutboxListSkeletonBody />
          ) : state === 'error' || (q.isError && !q.data) ? (
            <PanelError title="The Outbox failed to load" error={q.error} onRetry={() => void q.refetch()} />
          ) : state === 'empty' ? (
            <EmptyState
              icon="send"
              title="The Outbox is empty"
              body="A draft lands here when you ask for one (Draft on a task, or the Assistant) or when the app drafts a reply to something that waits on you after a scan. Nothing is sent without you."
            />
          ) : (
            <div
              {...lk.containerProps}
              data-testid="outbox-list"
              onFocusCapture={(e) => {
                const id = (e.target as HTMLElement).closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
                if (id && id !== sel && ids.includes(id)) select(id);
              }}
            >
              <LivePill count={stable.held.length} noun={stable.held.length === 1 ? 'new draft' : 'new drafts'} onShow={stable.showHeld} />
              <div className="cc-list-sections" data-cols={sections.length >= 2 ? '2' : '1'}>
                {sections.map((s) => (
                  <ListSection
                    key={s.key}
                    data-section={s.key}
                    title={s.title}
                    count={s.items.length}
                    sub={sectionSub(s.key, s.items)}
                    action={sectionAction(s.key, s.items)}
                    total={s.items.length}
                    shown={s.shown}
                    expanded={!!open[s.key]}
                    onExpand={(v) => setOpen({ ...open, [s.key]: v })}
                    noun={s.noun}
                  >
                    {s.rows.map((it, i) => (
                        <OutboxRow
                          key={it.draft.id}
                          item={it}
                          dryRun={dryRun}
                          now={now}
                          tz={tz}
                          expanded={expanded === it.draft.id}
                          flow={flowFor(it.draft.id)}
                          busy={send.target?.id === it.draft.id && ['previewing', 'countdown', 'dispatching'].includes(send.state.phase)}
                          rowProps={{ ...lk.rowProps(it.draft.id), ...stable.rowProps(it.draft.id) }}
                          selected={explicit && activeId === it.draft.id}
                          emphasis={!explicit && i === 0 && s === sections[0]}
                          inPanel={panel.openId === it.draft.id}
                          onApprove={() => approve(it)}
                          onReject={() => void reject(it)}
                          onEdit={() => openDetails(it.draft.id)}
                          onOpen={(mode) => (mode === 'page' && it.workItem ? navigate(`/work/${it.workItem.id}`) : openDetails(it.draft.id))}
                          onExpand={() => toggleExpand(it.draft.id)}
                          onRetryFlow={send.retry}
                          onDismissFlow={send.reset}
                          onMarkUploaded={() => void markHandedOff(it)}
                        />
                    ))}
                  </ListSection>
                ))}
              </div>
              <ListEnd>
                {counts ? (
                  <span className="tabular-nums">
                    {counts.pending_approval} pending · {counts.scheduled} scheduled · {counts.sent} sent · {counts.failed} failed
                    {dryRun ? ' · dry run' : ''}
                  </span>
                ) : null}
              </ListEnd>
            </div>
          )}
        </PanelBoundary>
      </ListFrame>
      {send.overlays}
    </>
  );
}
