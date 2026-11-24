'use client';
// Missed opportunities: the sweep view (filters, groups, the selected row). Split from MissedView.tsx (max-lines).
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MissedOpp } from '@/contract';
import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useCommands, type Command } from '@/client/keyboard';
import { useOptimisticMutation, type OptimisticCache } from '@/client/optimistic';
import { useResumeExtra, useResumeSelection } from '@/client/resume/hooks';
import { toast } from '@/client/toast';
import { useChatContext } from '@/components/chat';
import { Button, cn, EmptyState, Icon, PanelBoundary, PanelError, SegmentedToggle, usePanelState } from '@/ui';
import { ContextHead, ContextPage, useContextKeys, useDetails, useMainWidth } from './context-frame';
import { ClaimDcDialog, type ClaimValues } from './ClaimDc';
import { claimedToast, claimTargetOf } from './panels';
import { DealsTabs } from './DealsHeader';
import { MissedBodySkeleton } from './DealsSkeleton';
import { useContextPanels } from './register-panels';
import { useToday } from './hooks';
import { AMOUNT_STEPS, DEFAULT_FILTERS, filterMissed, type MissedFilters } from './missed';
import { accountKey } from './needs';
import { missedDeepLink } from './links';
import { navigate } from '@/components/shell/router';
import { patchMissed, SCOPE, type RowCtx, VerdictSection, StackedSections } from './MissedView.rows';

export function MissedSweep() {
  useContextPanels();
  const today = useToday();
  const pathname = usePathname();
  const sp = useSearchParams();
  const account = sp.get('account')?.trim().toLowerCase() || null;
  const missed = useApi('getMissed');
  const deals = useApi('getDeals');
  const mainW = useMainWidth();
  const { open: openDetails, openId } = useDetails();
  const [filters, setFilters] = useResumeExtra<MissedFilters>('missed-filters', DEFAULT_FILTERS);
  const [selected, setSelected] = useResumeSelection('missed');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dismissOpenId, setDismissOpenId] = useState<string | null>(null);
  const [batchDismissOpen, setBatchDismissOpen] = useState<string | null>(null);
  const [touched, setTouched] = useState<Map<string, string | null>>(new Map()); // id → auditId (undo)
  const orderRef = useRef<string[]>([]);
  const keepRef = useRef<Set<string>>(new Set());
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const all = useMemo(() => missed.data?.missed ?? [], [missed.data]);

  // Stable order: first-seen order; rows that arrive later append below with a "n new" marker.
  useEffect(() => {
    if (!missed.data) return;
    const known = new Set(orderRef.current);
    for (const m of all) if (!known.has(m.id)) orderRef.current.push(m.id);
    // Rows still to review when first seen stay in place for the session, whoever acts on them (this list, the
    // docked panel's Claim, another tab): nothing moves under the cursor.
    for (const m of all) if (m.status === 'new') keepRef.current.add(m.id);
    setSeen((s) => s ?? new Set(all.map((m) => m.id)));
  }, [missed.data, all]);

  const filtered = useMemo(() => {
    const touchedIds = new Set([...touched.keys(), ...keepRef.current]);
    const rows = filterMissed(all, filters, touchedIds).filter((m) => !account || accountKey(m.accountName) === account || m.accountName.toLowerCase().includes(account));
    const idx = new Map(orderRef.current.map((id, i) => [id, i] as const));
    return rows.slice().sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
    // orderRef is intentionally read at render: it only ever appends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filters, touched, missed.data, account]);

  const claimRows = useMemo(() => filtered.filter((m) => m.verdict === 'claim'), [filtered]);
  const checkRows = useMemo(() => filtered.filter((m) => m.verdict === 'check'), [filtered]);
  const newIds = useMemo(() => new Set(seen ? filtered.filter((m) => !seen.has(m.id)).map((m) => m.id) : []), [filtered, seen]);
  const ids = useMemo(() => [...claimRows, ...checkRows].map((m) => m.id), [claimRows, checkRows]);
  const byId = useMemo(() => new Map(all.map((m) => [m.id, m] as const)), [all]);
  const state = usePanelState('deals.missed', { loading: missed.isLoading, error: missed.data ? null : missed.error, empty: false });
  const active = selected && ids.includes(selected) ? selected : null;
  const activeRow = active ? byId.get(active) : undefined;
  useChatContext(activeRow ? { kind: 'missed_opp', id: activeRow.id, label: activeRow.oppName } : null);

  // ── Mutations ──
  const forget = (id: string) =>
    setTouched((t) => {
      const n = new Map(t);
      n.delete(id);
      return n;
    });
  const claimCfg = {
    route: 'claimMissed' as const,
    topics: ['deals', 'today', 'work', 'time'],
    rebase: false as const,
    optimistic: (input: { params: { id: string } }, cache: OptimisticCache) => patchMissed(cache, input.params.id, { status: 'claimed' }),
    onSuccess: (res: { entity: MissedOpp; auditId: string | null }) => setTouched((t) => new Map(t).set(res.entity.id, res.auditId)),
  };
  const claim = useOptimisticMutation({
    ...claimCfg,
    onSuccess: (res, input) => {
      claimCfg.onSuccess(res);
      claimedToast(res.entity, res.auditId ?? null, input.body?.split ?? 100);
    },
    onError: (err, input) => {
      forget(input.params.id);
      toast({ title: "Couldn't claim", body: `${err.message}. The row is back as it was.`, tone: 'error', durationMs: null, key: `claim-err:${input.params.id}` });
    },
  });
  const claimQuiet = useOptimisticMutation({ ...claimCfg, onError: (_e, input) => forget(input.params.id) });
  const dismissCfg = {
    route: 'dismissMissed' as const,
    topics: ['deals', 'today'],
    rebase: false as const,
    optimistic: (input: { params: { id: string }; body?: { reason: string; note?: string } }, cache: OptimisticCache) =>
      patchMissed(cache, input.params.id, { status: 'dismissed', dismissReason: input.body?.note ? `${input.body?.reason}: ${input.body?.note}` : (input.body?.reason ?? null) }),
    onSuccess: (res: { entity: MissedOpp; auditId: string | null }) => setTouched((t) => new Map(t).set(res.entity.id, res.auditId)),
  };
  const dismiss = useOptimisticMutation({
    ...dismissCfg,
    toast: (res) => ({ title: `Dismissed ${res.entity.oppName}`, body: res.entity.dismissReason ?? undefined, key: `dismiss:${res.entity.id}` }),
    onError: (err, input) => {
      forget(input.params.id);
      toast({ title: "Couldn't dismiss", body: `${err.message}. The row is back as it was.`, tone: 'error', durationMs: null, key: `dismiss-err:${input.params.id}` });
    },
  });
  const dismissQuiet = useOptimisticMutation({ ...dismissCfg, onError: (_e, input) => forget(input.params.id) });

  // The Claim form: one row (its evidence as the comment to edit) or a batch (one split and role for all; each row
  // keeps its own evidence unless you write a comment for all of them)
  const [claimAsk, setClaimAsk] = useState<MissedOpp[] | null>(null);
  const onClaim = useCallback((m: MissedOpp) => {
    if (m.status === 'new') setClaimAsk([m]);
  }, []);
  const claimNow = useCallback(
    (m: MissedOpp, v: ClaimValues) => {
      if (m.status !== 'new') return;
      setTouched((t) => new Map(t).set(m.id, null)); // keep the row in place the moment it's claimed
      setSelected(m.id);
      setPicked((p) => {
        const n = new Set(p);
        n.delete(m.id);
        return n;
      });
      claim.mutate({ params: { id: m.id }, body: { split: v.split, role: v.role, ...(v.comment ? { comment: v.comment } : {}) } });
    },
    [claim, setSelected],
  );
  const onDismiss = useCallback(
    (m: MissedOpp, reason: string, note: string) => {
      if (m.status !== 'new' || !reason) return;
      setTouched((t) => new Map(t).set(m.id, null));
      dismiss.mutate({ params: { id: m.id }, body: note ? { reason, note } : { reason } });
    },
    [dismiss],
  );

  const undoMany = useCallback(
    async (auditIds: string[], label: string) => {
      for (const a of auditIds) await api('undoAudit', { params: { id: a }, body: {} });
      await missed.refetch();
      toast({ title: `Undone: ${label}`, key: `undo:${label}`, durationMs: 4800 });
    },
    [missed],
  );
  const runManyNow = useCallback(
    async (ms: MissedOpp[], kind: 'claim' | 'dismiss', reason?: string, note?: string, values?: ClaimValues) => {
      const live = ms.filter((m) => m.status === 'new');
      if (!live.length) return;
      setTouched((t) => {
        const n = new Map(t);
        for (const m of live) n.set(m.id, null);
        return n;
      });
      setPicked(new Set());
      const audits: string[] = [];
      let failed = 0;
      for (const m of live) {
        try {
          const res =
            kind === 'claim'
              ? await claimQuiet.mutateAsync({ params: { id: m.id }, body: values ? { split: values.split, role: values.role, ...(values.comment ? { comment: values.comment } : {}) } : {} })
              : await dismissQuiet.mutateAsync({ params: { id: m.id }, body: note ? { reason: reason!, note } : { reason: reason! } });
          if (res.auditId) audits.push(res.auditId);
        } catch {
          failed++;
        }
      }
      const done = live.length - failed;
      const verb = kind === 'claim' ? 'Claimed' : 'Dismissed';
      if (done)
        toast({
          key: `batch:${kind}`,
          title: `${verb} ${done} ${done === 1 ? 'opp' : 'opps'}`,
          body: kind === 'claim' ? 'DC requests added: they go in your next batch (Deals ▸ DCs). Nothing was sent.' : reason,
          tone: failed ? 'warning' : 'success',
          undo: audits.length ? { run: () => undoMany(audits, `${kind} on ${done} ${done === 1 ? 'opp' : 'opps'}`) } : undefined,
        });
      if (failed) toast({ key: `batch-err:${kind}`, tone: 'error', durationMs: null, title: `${failed} ${failed === 1 ? 'opp' : 'opps'} couldn't be ${kind === 'claim' ? 'claimed' : 'dismissed'}`, body: 'They are back as they were. Try them one by one.' });
    },
    [claimQuiet, dismissQuiet, undoMany],
  );
  // a batch Claim asks once (the form), a batch Dismiss runs at once
  const runMany = useCallback(
    async (ms: MissedOpp[], kind: 'claim' | 'dismiss', reason?: string, note?: string) => {
      if (kind === 'claim') {
        const live = ms.filter((m) => m.status === 'new');
        if (live.length) setClaimAsk(live);
        return;
      }
      await runManyNow(ms, kind, reason, note);
    },
    [runManyNow],
  );

  const onUndo = useCallback(
    async (m: MissedOpp) => {
      const auditId = touched.get(m.id);
      if (!auditId) return;
      try {
        await api('undoAudit', { params: { id: auditId }, body: {} });
        setTouched((t) => new Map(t).set(m.id, null)); // stays in place as a normal row
        await missed.refetch();
        toast({ title: `Undone: ${m.status === 'claimed' ? 'claim' : 'dismiss'} on ${m.oppName}`, key: `undo:${m.id}`, durationMs: 4800 });
      } catch (e) {
        toast({ title: "Couldn't undo", body: (e as Error).message, tone: 'error', durationMs: null, key: `undo-err:${m.id}` });
      }
    },
    [touched, missed],
  );

  const toggle = useCallback(
    (id: string) =>
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  const pick = useCallback((m: MissedOpp) => {
    if (m.status !== 'new') return;
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(m.id)) n.delete(m.id);
      else n.add(m.id);
      return n;
    });
  }, []);
  const pickAll = useCallback(
    (ms: MissedOpp[], on: boolean) =>
      setPicked((p) => {
        const n = new Set(p);
        for (const m of ms) if (on) n.add(m.id);
        else n.delete(m.id);
        return n;
      }),
    [],
  );

  const openRow = useCallback(
    (id: string) => {
      const m = byId.get(id);
      if (!m) return;
      setSelected(id);
      openDetails({ kind: 'missed_opp', id: m.id, label: m.oppName });
    },
    [byId, openDetails, setSelected],
  );
  // ?id=<missedId> (a deep link: hrefFor, ⌘K, a notification) selects that row and opens it in Details, once.
  const linked = missedDeepLink(sp);
  const linkedOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!linked || linkedOpened.current === linked || !byId.has(linked)) return;
    linkedOpened.current = linked;
    openRow(linked);
  }, [linked, byId, openRow]);
  const openTask = useCallback(
    (m: MissedOpp) => {
      if (m.claimedWorkItemId) openDetails({ kind: 'work_item', id: m.claimedWorkItemId, label: `DC task: ${m.oppName}` });
    },
    [openDetails],
  );

  useContextKeys({
    scope: SCOPE,
    rootRef,
    ids,
    selected: active,
    setSelected,
    enabled: state === 'ready',
    onOpen: openRow,
    onPrimary: (id) => {
      const m = byId.get(id);
      if (m) onClaim(m);
    },
    actions: {
      a: (id) => {
        const m = byId.get(id);
        if (m) onClaim(m);
      },
      n: (id) => byId.get(id)?.status === 'new' && setDismissOpenId(id),
      x: (id) => {
        const m = byId.get(id);
        if (m) pick(m);
      },
      space: (id) => toggle(id),
    },
  });

  const setAccount = (v: string | null) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set('account', v);
    else p.delete('account');
    navigate(`${pathname}${p.size ? `?${p}` : ''}`, { replace: true });
  };

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'missed.filter.claim', title: 'Missed: show Claim only', group: 'Deals', run: () => setFilters({ ...filters, verdict: 'claim' }) },
      { id: 'missed.filter.check', title: 'Missed: show Check only', group: 'Deals', run: () => setFilters({ ...filters, verdict: 'check' }) },
      { id: 'missed.filter.reset', title: 'Missed: reset filters', group: 'Deals', run: () => (setFilters(DEFAULT_FILTERS), setAccount(null)) },
    ];
    const pickedRows = [...picked].map((id) => byId.get(id)).filter((m): m is MissedOpp => !!m && m.status === 'new');
    if (pickedRows.length) list.push({ id: 'missed.claim-selected', title: `Missed: claim ${pickedRows.length} selected`, subtitle: 'Adds DC requests for your next batch. Nothing is sent.', group: 'Deals', run: () => void runMany(pickedRows, 'claim') });
    if (activeRow && activeRow.status === 'new')
      list.push(
        { id: 'missed.claim', title: `Claim: ${activeRow.oppName}`, subtitle: 'Adds a DC request for your next batch. Nothing is sent.', group: 'Deals', shortcut: 'a', run: () => onClaim(activeRow) },
        { id: 'missed.dismiss', title: `Dismiss: ${activeRow.oppName}`, subtitle: 'Needs a reason', group: 'Deals', shortcut: 'n', run: () => setDismissOpenId(activeRow.id) },
        { id: 'missed.select', title: `Select: ${activeRow.oppName}`, group: 'Deals', shortcut: 'x', run: () => pick(activeRow) },
      );
    if (activeRow) list.push({ id: 'missed.details', title: `Details: ${activeRow.oppName}`, group: 'Deals', shortcut: 'enter', run: () => openRow(activeRow.id) });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, picked, byId, activeRow, runMany, onClaim, pick, openRow]);
  useCommands(commands);

  const c: RowCtx = {
    today,
    selected: active,
    firstId: (claimRows.find((m) => m.status === 'new') ?? checkRows.find((m) => m.status === 'new'))?.id ?? null,
    openId,
    picked,
    expanded,
    newIds,
    dismissOpenId,
    canUndo: (id) => !!touched.get(id),
    onSelect: (m) => openRow(m.id),
    onPick: pick,
    onClaim,
    onDismiss,
    onUndo: (m) => void onUndo(m),
    onOpenTask: openTask,
    onToggle: toggle,
    setDismissOpenId,
  };

  const openCount = all.filter((m) => m.status === 'new').length;
  const claimCount = all.filter((m) => m.status === 'new' && m.verdict === 'claim').length;
  const handledCount = all.length - openCount;
  const lastSweep = missed.data?.lastSweepAt ?? null;
  const tzFmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const both = filters.verdict === 'all';
  const sideBySide = both && mainW >= 1500;

  return (
    <ContextPage label="Missed opportunities">
      <ContextHead
        title="Missed opportunities"
        sentence={
          missed.data ? (
            <>
              <span className="font-bold text-fg">{openCount ? `${openCount} opps look like yours with no DC from you` : 'Nothing to claim'}</span>
              {openCount ? ` · ${claimCount} to claim, ${openCount - claimCount} to check` : ''}
              {lastSweep ? ` · swept ${tzFmt(lastSweep)}` : ''}. Claiming adds a DC request for your next batch; nothing is sent.
            </>
          ) : (
            'Loading the missed-opp sweep…'
          )
        }
        tabs={<DealsTabs tab="missed" missedCount={deals.data?.missedCount} />}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="Filters">
        <SegmentedToggle
          label="Verdict"
          size="sm"
          value={filters.verdict}
          onChange={(v) => setFilters({ ...filters, verdict: v })}
          options={[
            { value: 'all', label: 'Claim + check' },
            { value: 'claim', label: 'Claim' },
            { value: 'check', label: 'Check' },
          ]}
        />
        <SegmentedToggle
          label="Opp status"
          size="sm"
          value={filters.stage}
          onChange={(v) => setFilters({ ...filters, stage: v })}
          options={[
            { value: 'all', label: 'Open + closed' },
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
        <label className="flex items-center gap-2 text-caption text-muted">
          Amount
          <select
            value={filters.minAmount}
            onChange={(e) => setFilters({ ...filters, minAmount: Number(e.target.value) })}
            aria-label="Minimum amount"
            className="h-8 rounded-md border border-line-input bg-surface-input px-2 text-caption text-fg focus:border-accent focus:outline-none"
          >
            {AMOUNT_STEPS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <SegmentedToggle
          label="Show"
          size="sm"
          value={filters.scope}
          onChange={(v) => setFilters({ ...filters, scope: v })}
          options={[
            { value: 'review', label: 'To review' },
            { value: 'handled', label: `Handled${handledCount ? ` ${handledCount}` : ''}` },
            { value: 'all', label: 'All' },
          ]}
        />
        {account ? (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface-sunken pr-1 pl-2.5 text-caption font-bold text-fg">
            Account: {account}
            <button type="button" aria-label="Clear the account filter" onClick={() => setAccount(null)} className="inline-grid size-6 place-items-center rounded-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-focus">
              <Icon name="close" size="xs" />
            </button>
          </span>
        ) : null}
        <span className="text-caption text-muted tabular-nums" aria-live="polite">
          {filtered.length} of {all.length}
        </span>
        {newIds.size ? (
          <button
            type="button"
            onClick={() => {
              const first = [...newIds][0]!;
              document.querySelector(`[data-row-id="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'center' });
              setSeen(new Set(all.map((m) => m.id)));
            }}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-caption font-bold text-link hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus"
          >
            {newIds.size} new <Icon name="arrowdown" size="xs" />
          </button>
        ) : null}
        <span className="ml-auto text-caption text-muted">
          <kbd className="font-mono">x</kbd> select · <kbd className="font-mono">a</kbd> claim · <kbd className="font-mono">n</kbd> dismiss
        </span>
      </div>

      <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
        <PanelBoundary name="deals.missed">
          {state === 'error' ? (
            <PanelError title="Couldn't load missed opportunities" error={missed.error} onRetry={() => void missed.refetch()} />
          ) : state === 'loading' ? (
            <MissedBodySkeleton />
          ) : !filtered.length ? (
            (() => {
              // everything the sweep found is handled (dismissed or claimed): say so, and offer the handled list
              const handled = all.filter((m) => m.status !== 'new').length;
              const caughtUp = all.length > 0 && handled === all.length && filters.scope === 'review';
              return (
                <EmptyState
                  icon="success"
                  title={caughtUp ? 'All caught up' : all.length ? 'Nothing matches these filters' : 'No missed opportunities'}
                  body={
                    caughtUp
                      ? `The sweep's ${handled === 1 ? 'one finding is' : `${handled} findings are`} already handled (dismissed or claimed). It runs again after the next Org62 scan.`
                      : all.length
                        ? 'Loosen a filter, or switch Show to All.'
                        : 'The sweep found no opps that look like yours without a DC. It runs again after the next Org62 scan.'
                  }
                  action={
                    caughtUp ? (
                      <Button size="sm" variant="secondary" onClick={() => setFilters({ ...filters, scope: 'handled' })}>
                        Show handled
                      </Button>
                    ) : all.length ? (
                      <Button size="sm" variant="secondary" onClick={() => (setFilters({ ...DEFAULT_FILTERS, scope: 'all' }), setAccount(null))}>
                        Show everything
                      </Button>
                    ) : undefined
                  }
                />
              );
            })()
          ) : (
            <div className={cn('grid min-h-0 flex-1 gap-5', sideBySide ? 'grid-cols-2' : 'grid-cols-1')}>
              {sideBySide || !both ? (
                <>
                  {filters.verdict !== 'check' ? (
                    <VerdictSection verdict="claim" rows={claimRows} c={c} onClaimMany={(ms) => void runMany(ms, 'claim')} onDismissMany={(ms, r, n) => void runMany(ms, 'dismiss', r, n)} onPickAll={pickAll} batchDismissOpen={batchDismissOpen} setBatchDismissOpen={setBatchDismissOpen} />
                  ) : null}
                  {filters.verdict !== 'claim' ? (
                    <VerdictSection verdict="check" rows={checkRows} c={c} onClaimMany={(ms) => void runMany(ms, 'claim')} onDismissMany={(ms, r, n) => void runMany(ms, 'dismiss', r, n)} onPickAll={pickAll} batchDismissOpen={batchDismissOpen} setBatchDismissOpen={setBatchDismissOpen} />
                  ) : null}
                </>
              ) : (
                <StackedSections claimRows={claimRows} checkRows={checkRows} c={c} runMany={runMany} pickAll={pickAll} batchDismissOpen={batchDismissOpen} setBatchDismissOpen={setBatchDismissOpen} />
              )}
            </div>
          )}
        </PanelBoundary>
        <p className="mt-2 shrink-0 text-caption text-muted">
          Claim adds a DC request (Deals ▸ DCs): it goes in your next batch, which you Apply on Activity before Slackbot sees it. Command Center never writes to Org62.
        </p>
      </div>
      <ClaimDcDialog
        target={claimAsk ? (claimAsk.length === 1 ? claimTargetOf(claimAsk[0]!) : { oppId: null, oppName: `${claimAsk.length} opps`, myDc: null, comment: '' }) : null}
        commentRequired={(claimAsk?.length ?? 0) <= 1}
        onClose={() => setClaimAsk(null)}
        onSubmit={(v) => {
          const rows = claimAsk ?? [];
          if (rows.length === 1) claimNow(rows[0]!, v);
          else void runManyNow(rows, 'claim', undefined, undefined, v);
        }}
      />
    </ContextPage>
  );
}
