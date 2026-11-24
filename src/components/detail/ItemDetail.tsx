'use client';
/**
 * ItemDetail (UI-SPEC §12, R-UI-15/20/22): the work-item drill-in, in three variants that share every
 * behavior (autosaved fields, user-locked fields, the resolution picker, reopen, keys, optimistic
 * mutations with Undo, 409 "Changed elsewhere"):
 *
 *   <ItemDetail itemId="w_123" variant="panel" />   // the v2 docked right panel (Details tab), 520 / 600 px
 *   <ItemDetail itemId="w_123" variant="sheet" />   // inside a host's <SideSheet> (see renderItemSheet)
 *   <ItemDetail itemId="w_123" variant="page" />    // app/work/[id]
 *
 * v2 layout (DESIGN-V2; the Details tab in the home-1 mockup): a small "Do now · 1 of 3 · account · badge"
 * line, the 22 px title and purpose; Why (with evidence chips that open the source); Plan (your steps vs
 * agent steps, agent time in its own background lane) or the draft; Readiness; Same initiative; then the
 * evidence timeline, history (Undo per change), context, related, Drive and enrichment as collapsed groups.
 * The panel is the kit's DetailPanel frame (src/components/kit): its footer holds Later ▾ · Done ▾ (01-ui-audit R6)
 * and the ONE filled action. The sheet and page headers show the same two menus (header/ItemVerbs.tsx).
 *
 * Keys while focus is in the detail (or anywhere on the page variant): d done by me · ⇧D Done ▾ · l Later ▾ (s and
 * n still open it for a release) · o open source · e edit title · ⌘↵ the primary · ⇧↵ full page (panel). Every menu
 * choice is also a ⌘K command. The chat context is this item.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Effort, EnrichmentChip, ItemActionRequest, NotNowReason, Person, Proposal, SourceRef, TodayPayload, WorkItem, WorkItemDetail } from '@/contract';
import { useQueryClient } from '@tanstack/react-query';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useFocusedCommands, useKeyBinding } from '@/client/keyboard';
import { isEditableTarget } from '@/client/keyboard/keymap';
import { useResumeExtra } from '@/client/resume';
import { useChatContext } from '@/components/chat';
import type { ComposerHandle } from '@/components/composer';
import { DomainClock, ProposalDiff, type ResolveValue, type WorkRowActionKey } from '@/components/domain';
import { ReadInSection } from '@/components/readin';
import { DetailPanel, useItemMenus, type MenuRequest } from '@/components/kit';
import { useRightPanel } from '@/components/shell/panel';
import { ChangedElsewhere, cn, type ConflictField, EmptyState, PanelBoundary, PanelError, Tabs, tabPanelProps, useNow, usePanelState, useTimeZone } from '@/ui';
import { DrivePanel } from './DrivePanel';
import { Enrichment } from './Enrichment';
import { FieldRegistryContext, type FieldRegistry } from './header/fields';
import { ItemVerbs, moreWaysEntry, ResolvePopover } from './header/ItemVerbs';
import { ItemHeader } from './header/ItemHeader';
import { CLOSED_STATES, fmtMin, latestUndoable, mergePeople, openableSource, sameField } from './lib/derive';
import { useItemAction, usePatchItem, useProposalMutation, useUndoAudit } from './lib/mutations';
import './lib/register';
import { panelAvailable } from './lib/panel-host';
import { sectionLine, whyHeading } from './lib/panel-derive';
import { PrimarySlotProvider } from './lib/primary';
import { fmtWhen, whenPresets } from './lib/tz';
import { DetailSkeleton, PanelPrimary, type ItemDetailVariant, type OwnPrimary } from './panel/frame';
import { isEnriching } from './lib/enrichment-state';
import { NbaSection } from './nba/NbaSection';
import { openDeepLink } from './nba/ClaudeLaunchPanel';
import { Collapsible, useOpenSet } from './panel/bits';
import { ReadinessSection, SameInitiativeSection, WhySection } from './panel/sections';
import { ContextTab } from './tabs/ContextTab';
import { EvidenceTab } from './tabs/EvidenceTab';
import { WhyHere } from './tabs/WhyHere';
import { WhyOpen } from './sections/why-open';
import { HistoryTab } from './tabs/HistoryTab';
import { RelatedTab } from './tabs/RelatedTab';
import { navigate } from '@/components/shell/router';

export type DetailTab = 'context' | 'evidence' | 'related' | 'history';
export type { ItemDetailVariant };

export interface ItemDetailProps {
  itemId: string;
  variant: ItemDetailVariant;
  /** Hide the breadcrumb when the host chrome already shows it (ItemSheet puts it in the sheet title). */
  breadcrumb?: boolean;
  /**
   * Open another item (a sibling). Default: the panel retargets itself (useRightPanel().openDetails);
   * sheet and page go to the full page.
   */
  onOpenItem?: (id: string, mode: 'sheet' | 'page') => void;
  /**
   * Open a draft (the read-in's suggested reply). Default: the docked panel's draft details (the composer)
   * once V2-SHELL registers a 'draft' renderer, the Outbox until then.
   */
  onOpenDraft?: (draftId: string) => void;
  className?: string;
}

type ActionVerb = 'done' | 'resolve' | 'snooze' | 'accept' | 'confirm-done' | 'reopen' | 'not-now';

function displayValue(field: string, v: unknown, now: string, tz?: string): unknown {
  if ((field === 'due' || field === 'startBy') && typeof v === 'string') return fmtWhen(v, now, tz, { today: true });
  if (field === 'effort' && v && typeof v === 'object') return `you ${fmtMin((v as Effort).youMin)} · agent ${fmtMin((v as Effort).agentMin)}`;
  return v;
}

const FIELD_LABEL: Record<string, string> = { title: 'Title', purpose: 'Purpose', due: 'Due', startBy: 'Start by', effort: 'Effort', notes: 'Notes' };

export function ItemDetail(props: ItemDetailProps) {
  return (
    <PanelBoundary name="item.detail" resetKeys={[props.itemId]}>
      <ItemDetailQuery {...props} />
    </PanelBoundary>
  );
}

function ItemDetailQuery(props: ItemDetailProps) {
  const q = useApi('getItem', { params: { id: props.itemId } });
  const tzCtx = useTimeZone();
  const settings = useApi('getSettings');
  const tz = tzCtx ?? settings.data?.profile.timezone;
  const now = useNow(30_000).toISOString();
  const state = usePanelState('item.detail', { loading: q.isLoading, error: q.data ? null : q.error, empty: !q.isLoading && !q.error && !q.data });

  const shell = (node: React.ReactNode) => (
    <div data-item-detail={props.variant} className={cn(props.variant === 'page' ? '@container/detail h-full min-h-0' : props.variant === 'panel' ? '@container/panel h-full min-h-0' : '@container', props.className)}>
      {node}
    </div>
  );
  if (state === 'loading') return shell(<DetailSkeleton variant={props.variant} />);
  if (state === 'error') {
    const gone = q.error?.code === 'not_found';
    return shell(
      <div className={props.variant === 'panel' ? 'p-6' : undefined}>
        {gone ? (
          <EmptyState size={props.variant === 'page' ? 'page' : 'panel'} icon="search" title="This item no longer exists" body="It may have been merged or removed. Undo in History on the item it merged into." />
        ) : (
          <PanelError title="This item failed to load" error={q.error} onRetry={() => void q.refetch()} />
        )}
      </div>,
    );
  }
  if (state === 'empty' || !q.data) return shell(<EmptyState size="panel" icon="task" title="Nothing to show" body="Pick a task to see what it's for, its evidence and its next step." />);
  return (
    <DomainClock now={now} tz={tz}>
      <Loaded key={q.data.item.id} {...props} detail={q.data} now={now} tz={tz} meName={settings.data?.profile.name} />
    </DomainClock>
  );
}

/** The NOW stack ids if Today/Home already loaded them (read passively, never fetched from here). */
function useNowIds(): string[] | null {
  const qc = useQueryClient();
  const hit = qc.getQueriesData<TodayPayload>({ queryKey: ['today', 'getToday'] }).find(([, d]) => !!d?.nowStack)?.[1];
  return hit ? hit.nowStack.cards.map((c) => c.item.id) : null;
}

function Loaded({ detail, variant, now, tz, meName, onOpenItem, onOpenDraft, breadcrumb, className }: ItemDetailProps & { detail: WorkItemDetail; now: string; tz?: string; meName?: string }) {
  const { item, nba, draft } = detail;
  const id = item.id;
  const panelApi = useRightPanel();
  const patch = usePatchItem();
  const action = useItemAction();
  const undo = useUndoAudit();
  const apply = useProposalMutation('apply');
  const reject = useProposalMutation('reject');
  const history = useApi('getItemHistory', { params: { id } });
  const registry = useRef<FieldRegistry>(new Map()).current;
  const titleRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useResumeExtra<DetailTab>(`detail-tab:${id}`, 'context');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const page = variant === 'page';
  const panel = variant === 'panel';
  const nowIds = useNowIds();
  const line = sectionLine(item, nba, nowIds);
  const enrichPending = isEnriching(item.enrichment, Date.parse(now)) || (item.enrichment?.chips ?? []).some((c) => c.status === 'suggested');
  const more = useOpenSet(enrichPending ? ['enrichment'] : []);

  useChatContext({ kind: 'work_item', id, label: item.title, href: `/work/${id}` });

  // ---- saves ---------------------------------------------------------------------------------
  const ifVersion = useCallback(() => patch.versionOf(id) ?? item.version, [patch, id, item.version]);
  // The latest server copy (live updates land here) and the fields the user chose to keep anyway.
  const qc = useQueryClient();
  const latest = useRef(item);
  latest.current = item;
  /** The cached copy is newer than the last render when a live refetch just landed; versionOf reads it too. */
  const serverItem = useCallback(() => (qc.getQueryData(queryKey('getItem', { params: { id } })) as WorkItemDetail | undefined)?.item ?? latest.current, [qc, id]);
  const forced = useRef(new Set<string>());
  const [localConflict, setLocalConflict] = useState<ConflictField[] | null>(null);
  const saveField = useCallback(
    async (field: string, value: unknown, basis?: unknown) => {
      // Someone (chat, an engine write that landed, another window) changed this field after you
      // started editing it: ask instead of overwriting (R-UI-20, UI-SPEC §10).
      const theirs = (serverItem() as Record<string, unknown>)[field];
      if (basis !== undefined && !forced.current.delete(field) && !sameField(field, theirs, basis) && !sameField(field, theirs, value)) {
        setLocalConflict((prev) => [...(prev ?? []).filter((f) => f.field !== field), { field, label: FIELD_LABEL[field] ?? field, mine: value, theirs }]);
        throw new Error('Changed elsewhere while you were editing');
      }
      return patch.mutateAsync({ params: { id }, body: { ifVersion: ifVersion(), patch: { [field]: value } } });
    },
    [patch, id, ifVersion, serverItem],
  );

  // ---- actions -------------------------------------------------------------------------------
  const act = useCallback(
    (verb: ActionVerb, body: Omit<ItemActionRequest, 'ifVersion'> = {}) =>
      action.mutate({ params: { id, verb }, body: { ifVersion: action.versionOf(id) ?? item.version, ...body } }),
    [action, id, item.version],
  );
  const resolve = (v: ResolveValue) => act('resolve', { resolution: v.resolution, detail: v.detail, involvement: v.involvement });
  const snooze = (until: string) => act('snooze', { until });
  const notNow = (reason: NotNowReason) => act('not-now', { reason });
  // Done ▾ / Later ▾ go through this detail's own action (its error banner and Retry see them too).
  const sendMenu = useCallback((r: MenuRequest) => act(r.verb, r.body), [act]);
  const menus = useItemMenus({ id, version: item.version }, { now, tz }, sendMenu);
  const snoozeTomorrow = () => {
    const t = whenPresets(now, tz).find((p) => p.id === 'tomorrow') ?? whenPresets(now, tz)[0];
    if (t) snooze(t.at);
  };
  const source = openableSource(item, nba);
  const openSource = (s: SourceRef) => s.url && openDeepLink(s.url);
  const statusUndo = latestUndoable(history.data?.entries ?? [], ['item.loop_back', 'item.reopen']);
  const openPage = useCallback(() => navigate(`/work/${id}`), [id]);
  // The panel's Assistant tab holds the composer on every page, the full item page included (focusChat alone finds no composer while the panel is closed).
  const askChat = useCallback(() => panelApi.openAssistant({ kind: 'work_item', id, label: item.title }), [panelApi, id, item.title]);

  const siblingTitle = useCallback((otherId: string) => detail.siblings.find((s) => s.id === otherId)?.title, [detail.siblings]);
  const openItem = useCallback(
    (otherId: string, mode: 'sheet' | 'page') => {
      if (onOpenItem) onOpenItem(otherId, mode);
      else if (panel && mode === 'sheet') panelApi.openDetails({ kind: 'work_item', id: otherId, label: siblingTitle(otherId) });
      else navigate(`/work/${otherId}`);
    },
    [onOpenItem, panel, panelApi, siblingTitle],
  );

  const siblingAction = (key: WorkRowActionKey, sib: WorkItem) => {
    const v = action.versionOf(sib.id) ?? sib.version;
    if (key === 'done') action.mutate({ params: { id: sib.id, verb: 'done' }, body: { ifVersion: v } });
    else if (key === 'snooze') {
      const t = whenPresets(now, tz).find((p) => p.id === 'tomorrow');
      if (t) action.mutate({ params: { id: sib.id, verb: 'snooze' }, body: { ifVersion: v, until: t.at } });
    } else if (key === 'edit' || key === 'resolve') openItem(sib.id, 'sheet');
  };

  // Evidence, history, … are tabs on the sheet and page, collapsed groups in the panel.
  const showTab = (t: DetailTab) => {
    if (!panel) return setTab(t);
    more.open(t);
    requestAnimationFrame(() => rootRef.current?.querySelector(`[data-collapsible="${t}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
  };

  // ---- people ---------------------------------------------------------------------------------
  const people = useMemo<Person[]>(
    () =>
      mergePeople(item.counterparty ? [item.counterparty] : [], item.people, detail.initiative?.people, detail.account?.team).map((p) => ({
        ...p,
        accountId: (p as Partial<Person>).accountId ?? null,
      })),
    [item.counterparty, item.people, detail.initiative?.people, detail.account?.team],
  );
  const threadPeople = useMemo(() => [...(item.counterparty ? [item.counterparty.id] : []), ...item.people.map((p) => p.id)], [item.counterparty, item.people]);

  // ---- enrichment fills the NBA ------------------------------------------------------------------
  const fill = (chip: EnrichmentChip) => {
    const c = composerRef.current;
    if (!c || !chip.url) return false;
    const text = c.getDoc() ? JSON.stringify(c.getDoc()) : '';
    if (text.includes(chip.url) || text.includes(chip.label)) return true;
    c.appendText(`${chip.label}: ${chip.url}`);
    return true;
  };

  // ---- keyboard + ⌘K ------------------------------------------------------------------------------
  const closed = CLOSED_STATES.has(item.state);
  const openLater = () => (!closed ? setLaterOpen(true) : undefined);
  // The panel's frame (kit DetailPanel) owns d / ⇧D / l (and the s, n aliases); the sheet and page bind them here.
  const keyMap: Record<string, () => void> = {
    ...(panel
      ? {}
      : {
          d: () => (!closed ? menus.onDone('by_me') : undefined),
          D: () => (!closed ? setDoneOpen(true) : undefined),
          l: openLater,
          s: openLater,
          n: openLater,
        }),
    o: () => (source ? openSource(source) : undefined),
    e: () => titleRef.current?.focus(),
  };
  /** ⌘↵: the one primary (the composer's Send/Push, Start in Claude, Run, … or the panel footer's). */
  const firePrimary = () => {
    if (composerRef.current) return composerRef.current.send();
    const root = rootRef.current;
    const btn = root?.querySelector<HTMLButtonElement>('[data-nba-primary]:not([disabled])') ?? (panel ? root?.querySelector<HTMLButtonElement>('[data-panel-primary]:not([disabled])') : null);
    btn?.click();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isEditableTarget(e.target)) {
      e.preventDefault();
      firePrimary();
      return;
    }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
    if ((e.target as HTMLElement).closest('[role="row"],[data-row],[role="dialog"],[role="menu"]')) return; // rows and popovers own their keys
    if (panel && e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      openPage();
      return;
    }
    const fn = keyMap[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  };
  // The page has nothing else focused: the same keys work from anywhere on it.
  useKeyBinding('d', () => (page ? keyMap.d!() : false), { enabled: page, description: 'Done by me', group: 'Item' });
  useKeyBinding('shift+d', () => (page ? keyMap.D!() : false), { enabled: page, description: 'Done ▾ (more ways it ended)', group: 'Item' });
  useKeyBinding('l', () => (page ? keyMap.l!() : false), { enabled: page, description: 'Later ▾', group: 'Item' });
  useKeyBinding('s', () => (page ? keyMap.s!() : false), { enabled: page, description: 'Later ▾ (old key)', group: 'Item' });
  useKeyBinding('n', () => (page ? keyMap.n!() : false), { enabled: page, description: 'Later ▾ (old key)', group: 'Item' });
  useKeyBinding('o', () => (page && source ? keyMap.o!() : false), { enabled: page, description: 'Open source', group: 'Item' });
  useKeyBinding('e', () => (page ? keyMap.e!() : false), { enabled: page, description: 'Edit title', group: 'Item' });
  useKeyBinding('mod+enter', () => (page ? firePrimary() : false), { enabled: page, description: 'Next best action', group: 'Item' });

  useFocusedCommands({ label: item.title, kind: 'work_item' }, [
    ...(!closed
      ? [
          { id: 'item.done', title: 'Done by me', shortcut: 'd', keywords: ['mark done', 'finish'], run: () => menus.onDone('by_me') },
          { id: 'item.done.someone_else', title: 'Done by someone else', keywords: ['resolve', 'close'], run: () => menus.onDone('someone_else') },
          { id: 'item.done.not_mine', title: 'Not mine', keywords: ['dismiss', 'not now'], run: () => menus.onDone('not_mine') },
          { id: 'item.done.not_needed', title: 'Not needed', keywords: ['resolve', 'close', 'moment passed'], run: () => menus.onDone('not_needed') },
          { id: 'item.resolve', title: 'More ways it ended… (handed off, duplicate, superseded)', keywords: ['resolve', 'handed off', 'hand off', 'duplicate', 'close'], run: () => setResolveOpen(true) },
          { id: 'item.later.tomorrow', title: 'Later: tomorrow', keywords: ['snooze'], run: () => menus.onLater('tomorrow') },
          { id: 'item.later.next_week', title: 'Later: next week', keywords: ['snooze'], run: () => menus.onLater('next_week') },
          { id: 'item.later.not_now', title: 'Not now (until the next working day)', keywords: ['later', 'snooze', 'skip'], run: () => menus.onLater('not_now') },
          { id: 'item.not-now.wrong_account', title: 'Wrong account: unlink it and keep the item', keywords: ['not now', 'account'], run: () => notNow('wrong_account') },
        ]
      : [{ id: 'item.reopen', title: 'Reopen', run: () => act('reopen') }]),
    ...(item.state === 'suggested' ? [{ id: 'item.accept', title: 'Accept suggestion', shortcut: 'a', run: () => act('accept') }] : []),
    ...(item.state === 'likely_done' ? [{ id: 'item.confirm', title: 'Confirm done', run: () => act('confirm-done') }] : []),
    ...(nba ? [{ id: 'item.primary', title: `Next best action: ${nba.primaryLabel || nba.title}`, shortcut: 'mod+enter', run: firePrimary }] : []),
    { id: 'item.edit-title', title: 'Edit title', shortcut: 'e', run: () => titleRef.current?.focus() },
    ...(source ? [{ id: 'item.open-source', title: `Open source: ${source.label}`, shortcut: 'o', run: () => openSource(source) }] : []),
    ...(draft ? [{ id: 'item.compose', title: 'Edit the draft', run: () => composerRef.current?.focus() }] : []),
    ...(!page ? [{ id: 'item.open-page', title: 'Open full page', shortcut: 'shift+enter', run: openPage }] : []),
    ...(item.refs.initiative ? [{ id: 'item.open-initiative', title: `Open initiative: ${item.refs.initiative.label}`, run: () => navigate(`/initiatives/${item.refs.initiative!.id}`) }] : []),
    { id: 'item.tab.evidence', title: 'Show evidence', run: () => showTab('evidence') },
    { id: 'item.tab.related', title: 'Show related tasks and assets', run: () => showTab('related') },
    { id: 'item.tab.history', title: 'Show history (undo a change)', run: () => showTab('history') },
    { id: 'item.ask-chat', title: 'Ask the assistant about this task', shortcut: 'mod+j', run: askChat },
  ]);

  // Scroll the detail back to the top when a different item loads into the same host.
  useEffect(() => {
    rootRef.current?.closest('.cc-scroll')?.scrollTo?.({ top: 0 });
    rootRef.current?.querySelector('[data-panel-scroll]')?.scrollTo?.({ top: 0 });
  }, [id]);

  // ---- render ---------------------------------------------------------------------------------------
  const conflict = patch.conflict;
  const conflictFields: ConflictField[] = [
    ...(localConflict ?? []),
    ...(conflict?.fields ?? []).filter((f) => !localConflict?.some((l) => l.field === f.field)).map((f) => ({ ...f, label: FIELD_LABEL[f.field] ?? f.field })),
  ].map((f) => ({ ...f, mine: displayValue(f.field, f.mine, now, tz), theirs: displayValue(f.field, f.theirs, now, tz) }));
  const conflictBanner = conflictFields.length ? (
    <ChangedElsewhere
      fields={conflictFields}
      onKeepMine={() => {
        for (const f of conflictFields) {
          forced.current.add(f.field);
          registry.get(f.field)?.retry();
        }
        setLocalConflict(null);
        patch.reset();
      }}
      onTakeTheirs={() => {
        const theirs = (conflict?.theirs ?? serverItem()) as Record<string, unknown>;
        for (const f of conflictFields) registry.get(f.field)?.adopt(theirs[f.field]);
        setLocalConflict(null);
        if (conflict) conflict.takeTheirs();
      }}
    />
  ) : null;

  const relatedItems = detail.siblings.map((x) => ({ id: x.id, title: x.title }));
  const resolveProps = { item, people, threadPeople, relatedItems, onResolve: resolve, open: resolveOpen, onOpenChange: setResolveOpen };
  const verbs = (cls: string) => (
    <ItemVerbs
      {...resolveProps}
      menus={menus}
      source={source}
      doneOpen={doneOpen}
      onDoneOpenChange={setDoneOpen}
      laterOpen={laterOpen}
      onLaterOpenChange={setLaterOpen}
      resolveOpen={resolveOpen}
      onResolveOpenChange={setResolveOpen}
      onReopen={() => act('reopen')}
      onAccept={() => act('accept')}
      onConfirmDone={() => act('confirm-done')}
      onOpenSource={openSource}
      className={cls}
    />
  );

  const header = (
    <ItemHeader
      variant={variant}
      item={item}
      meeting={detail.meeting}
      now={now}
      tz={tz}
      meName={meName}
      breadcrumb={breadcrumb}
      sectionLine={line}
      saveField={(f, v, b) => saveField(f, v, b)}
      saveEffort={(v, b) => saveField('effort', v, b)}
      actions={panel ? undefined : verbs(page ? 'flex flex-wrap items-center justify-end gap-1' : 'flex flex-wrap items-center gap-1')}
      onUndoStatus={statusUndo ? () => undo.mutate({ params: { id: statusUndo.id }, body: {} }) : undefined}
      onShowEvidence={() => showTab('evidence')}
      onOpenPage={panel ? openPage : undefined}
      titleRef={titleRef}
    />
  );

  const itemProposals = detail.proposals.filter((p: Proposal) => p.status === 'pending' && p.entity.type === 'work_item');
  const proposals = itemProposals.length ? (
    <div className="space-y-2" data-proposals={itemProposals.length}>
      {itemProposals.map((p) => (
        // Strip variant: secondary Apply / Keep mine, so the next step keeps the view's one primary (UI-SPEC §1.2).
        <div key={p.id} className="overflow-hidden rounded-lg border-x border-b border-line" data-proposal-id={p.id}>
          <ProposalDiff proposal={p} variant="strip" defaultDiffOpen onApply={(x) => apply.mutate({ params: { id: x.id }, body: {} })} onKeepMine={(x) => reject.mutate({ params: { id: x.id }, body: {} })} />
        </div>
      ))}
      {apply.error || reject.error ? <p className="text-caption text-danger-700">Couldn&apos;t resolve the proposal: {(apply.error ?? reject.error)!.message}</p> : null}
    </div>
  ) : null;

  const nbaSection = (
    <PanelBoundary name="item.nba" resetKeys={[id, nba?.version]}>
      <NbaSection
        item={item}
        nba={nba}
        draft={draft}
        runs={detail.runs}
        people={people}
        now={now}
        tz={tz}
        variant={variant}
        composerRef={composerRef}
        onConfirmDone={() => act('confirm-done')}
        onSnoozeTomorrow={snoozeTomorrow}
        onOpenUrl={openDeepLink}
        onAskChat={askChat}
        onReviewRelated={() => {
          const focusChip = () => rootRef.current?.querySelector<HTMLElement>('[data-chip-accept]')?.focus();
          if (panel && (item.enrichment?.chips ?? []).some((c) => c.status === 'suggested')) {
            more.open('enrichment'); // collapsed in the panel: open it, then focus once it mounts
            requestAnimationFrame(focusChip);
            return true;
          }
          const el = rootRef.current?.querySelector<HTMLElement>('[data-chip-accept]');
          el?.focus();
          return !!el;
        }}
      />
    </PanelBoundary>
  );

  const why = <WhySection item={item} nba={nba} heading={whyHeading(line)} mentions={detail.mentions} />;
  // BE-READIN: the read-in leads the detail (panel and page). Its suggested reply opens in the composer.
  const openDraft = (draftId: string) => {
    if (onOpenDraft) onOpenDraft(draftId);
    // The shell renders the docked panel once it has registered the work-item renderer (V2-SHELL).
    else if (panelAvailable()) panelApi.openDetails({ kind: 'draft', id: draftId, label: 'Suggested reply' });
    else navigate(`/outbox?draft=${encodeURIComponent(draftId)}`);
  };
  const readIn = <ReadInSection entityId={id} onOpenDraft={openDraft} />;
  const readinessSection = <ReadinessSection detail={detail} now={now} tz={tz} onOpenItem={(x) => openItem(x, 'sheet')} />;
  const sameInitiative = <SameInitiativeSection detail={detail} now={now} tz={tz} cap={panel ? 3 : 5} onOpenItem={(x) => openItem(x, 'sheet')} />;

  const evidenceNew = item.newEvidenceCount;
  const tabContent = (t: DetailTab, active: boolean) => (
    <PanelBoundary name={`item.${t}`} resetKeys={[id, t]}>
      {t === 'context' ? <ContextTab detail={detail} now={now} tz={tz} saveNotes={(v, b) => saveField('notes', v, b)} /> : null}
      {t === 'evidence' ? <EvidenceTab itemId={id} active={active} now={now} tz={tz} /> : null}
      {t === 'related' ? <RelatedTab detail={detail} now={now} tz={tz} onOpenItem={openItem} onSiblingAction={siblingAction} /> : null}
      {t === 'history' ? <HistoryTab itemId={id} now={now} tz={tz} /> : null}
    </PanelBoundary>
  );

  const idBase = `detail-${id}`;
  const tabs = (
    <div className="min-w-0" data-detail-tabs>
      <Tabs<DetailTab>
        idBase={idBase}
        label="Task detail"
        size={page ? 'md' : 'sm'}
        value={tab}
        onChange={setTab}
        className={page ? 'sticky top-0 z-10 -mx-6 bg-surface px-4' : '-mx-4 px-2'}
        tabs={[
          { value: 'context', label: 'Context' },
          { value: 'evidence', label: evidenceNew ? `Evidence · ${evidenceNew} new` : 'Evidence', count: evidenceNew ? undefined : detail.evidenceCount },
          { value: 'related', label: 'Related', count: detail.siblings.length + detail.assets.length + detail.runs.length },
          { value: 'history', label: 'History' },
        ]}
      />
      <div {...tabPanelProps(idBase, tab)} className="pt-4 focus:outline-none">
        {tabContent(tab, true)}
      </div>
    </div>
  );

  const actionError = action.error ? (
    <p role="alert" className="flex items-center gap-2 rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-caption text-danger-700" data-action-error>
      Couldn&apos;t update the task: {action.error.message}
      <button type="button" className="font-bold hover:underline" onClick={action.retry}>
        Retry
      </button>
      <button type="button" className="ml-auto text-muted hover:text-fg" onClick={action.reset} aria-label="Dismiss">
        ✕
      </button>
    </p>
  ) : null;

  const banners = conflictBanner || actionError ? (
    <div className="space-y-2" data-detail-banners>
      {conflictBanner}
      {actionError}
    </div>
  ) : null;

  // ---- panel ----------------------------------------------------------------------------------------
  if (panel) {
    const collapsed: Array<{ key: string; title: string; meta?: ReactNode; node: (open: boolean) => ReactNode } | null> = [
      // AUDIT: the provenance chain (source → scan run → triage verdict → model cost); loads only while open.
      { key: 'why-here', title: 'Why is this here?', meta: 'source · scan · verdict', node: (open) => (open ? <WhyHere itemId={id} now={now} tz={tz} /> : null) },
      // H-7: the resolution check's last decision (closure_checks); loads only while open
      { key: 'why-open', title: closed ? 'Why was this closed?' : 'Why is this still open?', meta: 'last check', node: (open) => (open ? <WhyOpen itemId={id} now={now} tz={tz} /> : null) },
      { key: 'evidence', title: 'Evidence timeline', meta: evidenceNew ? <span className="font-bold text-link">{evidenceNew} new</span> : detail.evidenceCount || undefined, node: (open) => tabContent('evidence', open) },
      { key: 'history', title: 'History', meta: 'Undo any change', node: () => tabContent('history', true) },
      { key: 'context', title: 'Context and notes', meta: [detail.account?.name, detail.opp ? 'opportunity' : null].filter(Boolean).join(' · ') || undefined, node: () => tabContent('context', true) },
      { key: 'related', title: 'Related', meta: detail.siblings.length + detail.assets.length + detail.runs.length || undefined, node: () => tabContent('related', true) },
      item.deliverable ? { key: 'drive', title: 'Drive file', meta: item.deliverable.fileName, node: () => <DrivePanel item={item} now={now} tz={tz} /> } : null,
      item.enrichment && item.enrichment.status !== 'idle' ? { key: 'enrichment', title: 'Related work found', meta: enrichPending ? <span className="font-bold text-ai-700">✦ to review</span> : undefined, node: () => <Enrichment item={item} onFill={fill} /> } : null,
    ];
    const fallback: OwnPrimary = { action: 'done', label: 'Done', icon: 'check', kbd: 'd', run: () => menus.onDone('by_me') };
    const forcedPrimary: OwnPrimary | null = closed
      ? { action: 'reopen', label: 'Reopen', icon: 'undo', run: () => act('reopen') }
      : item.state === 'suggested'
        ? { action: 'accept', label: 'Accept', icon: 'check', kbd: 'a', run: () => act('accept') }
        : item.state === 'likely_done'
          ? { action: 'confirm', label: 'Confirm done', icon: 'check', run: () => act('confirm-done') }
          : null;
    return (
      <FieldRegistryContext.Provider value={registry}>
        <PrimarySlotProvider>
          {/* tabIndex -1: a click anywhere in the panel puts focus inside, so its keys (d, l, ⌘↵…) work. */}
          <div ref={rootRef} tabIndex={-1} data-item-detail="panel" data-item-id={id} onKeyDown={onKeyDown} className={cn('@container/panel flex h-full min-h-0 flex-col bg-surface focus:outline-none', className)}>
            <DetailPanel
              entity={{ kind: 'work_item', id, label: item.title }}
              header={header}
              menus={closed ? null : menus}
              doneExtra={[moreWaysEntry(() => setResolveOpen(true))]}
              laterKeys={['l', 's', 'n']}
              bodyClassName="px-6 pt-5 pb-6"
              primaryNode={
                <PanelPrimary fallback={fallback} forced={forcedPrimary}>
                  {closed ? null : <ResolvePopover {...resolveProps} placement="top-end" />}
                </PanelPrimary>
              }
            >
              <div className="flex flex-col gap-6">
                {banners}
                {readIn}
                {proposals}
                {why}
                {nbaSection}
                {readinessSection}
                {sameInitiative}
                <div className="-mx-1" data-detail-more>
                  {collapsed.map((c) =>
                    c ? (
                      <Collapsible key={c.key} id={c.key} title={c.title} meta={c.meta} open={more.isOpen(c.key)} onToggle={(o) => more.toggle(c.key, o)}>
                        <div className="px-1">{c.node(more.isOpen(c.key))}</div>
                      </Collapsible>
                    ) : null,
                  )}
                </div>
              </div>
            </DetailPanel>
          </div>
        </PrimarySlotProvider>
      </FieldRegistryContext.Provider>
    );
  }

  // ---- page and sheet ---------------------------------------------------------------------------------
  const body = (
    <>
      {page ? readIn : null}
      {proposals}
      <Enrichment item={item} onFill={fill} />
      {why}
      {nbaSection}
      <DrivePanel item={item} now={now} tz={tz} />
    </>
  );

  return (
    <FieldRegistryContext.Provider value={registry}>
      {page ? (
        <div ref={rootRef} data-item-detail="page" data-item-id={id} onKeyDown={onKeyDown} className={cn('@container/detail flex h-full min-h-0 flex-col', className)}>
          {header}
          {banners ? <div className="px-6 pt-3">{banners}</div> : null}
          <div className="cc-scroll relative min-h-0 flex-1 overflow-y-auto @5xl/detail:grid @5xl/detail:grid-cols-[minmax(0,1.2fr)_minmax(26rem,1fr)] @5xl/detail:overflow-hidden @min-[140rem]/detail:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(32rem,1fr)]">
            {/* Main + context share one scroll until the page is wide enough for a third pane (DESIGN-V2 principle 6). */}
            <div className="cc-scroll relative @5xl/detail:min-h-0 @5xl/detail:overflow-y-auto @min-[140rem]/detail:contents" data-detail-col="main">
              <div className="@container cc-scroll relative space-y-6 px-6 pt-6 pb-6 @min-[140rem]/detail:min-h-0 @min-[140rem]/detail:overflow-y-auto">{body}</div>
              <div className="@container cc-scroll relative space-y-6 px-6 pb-6 empty:hidden @min-[140rem]/detail:min-h-0 @min-[140rem]/detail:overflow-y-auto @min-[140rem]/detail:border-l @min-[140rem]/detail:border-line @min-[140rem]/detail:pt-6" data-detail-col="context">
                {readinessSection}
                {sameInitiative}
              </div>
            </div>
            <div className="@container cc-scroll relative border-t border-line px-6 pb-6 @5xl/detail:min-h-0 @5xl/detail:overflow-y-auto @5xl/detail:border-t-0 @5xl/detail:border-l" data-detail-col="tabs">
              {tabs}
            </div>
          </div>
        </div>
      ) : (
        <div ref={rootRef} data-item-detail="sheet" data-item-id={id} onKeyDown={onKeyDown} className={cn('@container space-y-6', className)}>
          {banners}
          {header}
          {body}
          {readinessSection}
          {sameInitiative}
          {tabs}
        </div>
      )}
    </FieldRegistryContext.Provider>
  );
}
