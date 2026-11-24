'use client';
/**
 * Deals ▸ Accounts (UI-SPEC §12, design v2). One focal point: what needs you on a deal.
 *
 *   head      "Deals", one sentence (n need you · open opps · pipeline · hours QTD), Accounts · Missed tabs
 *   left      Needs you: the server's rows (getDeals `needs`, the ones the Assistant reads: Log & fix = DC gaps naming
 *             each opp, Think ahead = closing soon, Chase = DC requested), each with Not needed / Snooze 1 week
 *             (src/components/needs/SetAside.tsx), 3 rows each (5 on very wide screens); the #1 row carries the page's one filled button
 *   right     Accounts: every account as a quiet two-line row (amount and stage words as muted text)
 *   above     the Deals summary (stat tiles) and the pipeline by fiscal quarter (PipelineSummary.tsx); a tile, a
 *             chart segment or a table cell lists its deals (`?pipe=…`) in the Accounts pane's place (PipelineList)
 *
 * Click or Enter opens the account in the docked panel (Details); ⇧Enter or the row's verb opens the account
 * page. j/k move the selection, Esc closes the panel. The page never scrolls; each pane scrolls on its own.
 *
 * Personas (D-55): DC rows and words, VDP words and the Missed tab, link and command show only while the persona
 * has deal contributions, VDP and the missed-opp sweep (useDealsFeatures); the body keeps its skeleton until the
 * persona is known, so nothing appears under the cursor.
 */
import { AppLink } from '@/components/shell/AppLink';
import { FillingIn } from '@/components/shell/FillingIn';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AccountRow } from '@/contract';
import { useApi } from '@/client/hooks';
import { useCommands, type Command } from '@/client/keyboard';
import { useResumeSelection } from '@/client/resume/hooks';
import { useChatContext } from '@/components/chat';
import { StatusBadge } from '@/components/domain';
import { EmptyState, Icon, IconButton, LivePill, PanelBoundary, PanelError, Tooltip, usePanelState } from '@/ui';
import { ContextHead, ContextPage, ContextRow, LiveRows, Pane, SectionHead, useContextKeys, useDetails, useMainWidth } from './context-frame';
import { useArrivalHold, useLiveList, useSelectionSurvives } from '@/components/lists/live-list';
import { DealsTabs } from './DealsHeader';
import { DealsBodySkeleton } from './DealsSkeleton';
import { useContextPanels } from './register-panels';
import { fmtAmount, fmtHours } from './format';
import { useDealsFeatures, useToday, useVdpStale } from './hooks';
import { accountWhy, accountWords, groupNeeds, needsEmptyLine, noAccountsLine, type DealsFeatures, type NeedRow } from './needs';
import { SetAsideActions } from '@/components/needs/SetAside';
import { navigate } from '@/components/shell/router';
import { dealsDeepLink, oppAccountHref } from './links';
import { pipeFilterOf, pipeHref } from '@/lib/pipeline-filter';
import type { PipelineRow } from '@/contract';
import { DealsSummaryTiles, PipelineByQuarter } from './PipelineSummary';
import { PipelineListPane, pipelineListRows, pipeRowKey } from './PipelineList';
import { pipeRowHref } from './pipeline-words';

const SCOPE = 'page:deals';

function NeedsPane({
  groups,
  features,
  cap,
  selected,
  openId,
  onSelect,
  onVerb,
  missedToReview = 0,
}: {
  groups: ReturnType<typeof groupNeeds>;
  features: DealsFeatures;
  /** Missed findings still to review (status new): the "Review in Missed" link shows only when there are some. */
  missedToReview?: number;
  cap: number;
  selected: string | null;
  openId: string | null;
  onSelect: (r: NeedRow) => void;
  onVerb: (r: NeedRow) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const first = groups[0]?.rows[0]?.id ?? null;
  return (
    <Pane as="section" aria-label="Needs you" className="@container max-h-full self-start" bodyClassName="pb-3">
      {groups.length === 0 ? (
        <FillingIn variant="panel">
          <div className="px-5 py-6">
            <h2 className="text-lead font-bold text-fg-heading">Nothing needs you on a deal</h2>
            <p className="mt-1 max-w-[52ch] text-body text-muted">{needsEmptyLine(features)}</p>
          </div>
        </FillingIn>
      ) : (
        groups.map((g) => {
          const open = expanded.has(g.section);
          const shown = open ? g.rows : g.rows.slice(0, cap);
          return (
            <section key={g.section} aria-labelledby={`need-${g.section}`} className="pb-1">
              <SectionHead
                id={`need-${g.section}`}
                title={g.title}
                count={g.rows.length}
                sub={g.section === 'ahead' ? 'next 45 days' : g.section === 'fix' ? 'DC gaps' : 'waiting on the AE'}
                action={
                  // these rows are DC gaps you claim in place; Missed is linked only when it has findings to review
                  g.section === 'fix' && features.missed && missedToReview > 0 ? (
                    <AppLink href="/deals/missed" className="rounded-sm text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus">
                      {missedToReview} to review in Missed →
                    </AppLink>
                  ) : undefined
                }
              />
              <div role="list" aria-label={g.title}>
                {shown.map((r) => (
                  <ContextRow
                    key={r.id}
                    rowId={r.id}
                    title={r.title}
                    why={r.why}
                    badge={
                      r.badge ? (
                        <StatusBadge tone={r.tone === 'danger' ? 'danger' : 'warning'} icon={r.tone === 'danger' ? 'error' : r.section === 'ahead' ? 'clock' : 'warning'}>
                          {r.badge}
                        </StatusBadge>
                      ) : null
                    }
                    edge={r.tone}
                    selected={selected === r.id}
                    emphasized={!selected && r.id === first}
                    inPanel={openId === r.accountId && selected === r.id}
                    verb={{ label: r.verb.label, kbd: 'mod+enter', onClick: () => onVerb(r) }}
                    // every row can be set aside: Not needed (a DC gap, per opp), Snooze 1 week (Think ahead, Chase)
                    secondary={r.resolve ? <SetAsideActions resolve={r.resolve} /> : undefined}
                    onClick={() => onSelect(r)}
                  />
                ))}
              </div>
              {g.rows.length > cap ? (
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(g.section)) n.delete(g.section);
                      else n.add(g.section);
                      return n;
                    })
                  }
                  className="mx-5 mt-1 rounded-sm text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus"
                >
                  {open ? 'Show fewer' : `See all ${g.rows.length} →`}
                </button>
              ) : null}
            </section>
          );
        })
      )}
    </Pane>
  );
}

function AccountsPane({
  accounts,
  features,
  today,
  selected,
  openId,
  onSelect,
  onOpenPage,
}: {
  accounts: AccountRow[];
  features: DealsFeatures;
  today: string;
  selected: string | null;
  openId: string | null;
  onSelect: (a: AccountRow) => void;
  onOpenPage: (a: AccountRow) => void;
}) {
  const withOpps = accounts.filter((a) => a.openOpps > 0);
  const without = accounts.filter((a) => a.openOpps === 0);
  const row = (a: AccountRow) => {
    const id = `acct:${a.id}`;
    const words = accountWords(a, features);
    return (
      <ContextRow
        key={a.id}
        rowId={id}
        title={a.name}
        meta={
          a.pipelineAmount ? (
            <>
              <span className="text-body text-fg">{fmtAmount(a.pipelineAmount)}</span>
            </>
          ) : a.hoursQtd ? (
            <span>{fmtHours(a.hoursQtd)} QTD</span>
          ) : null
        }
        why={
          <>
            {accountWhy(a, today)}
            {words ? <span className="text-faint"> · {words}</span> : null}
          </>
        }
        selected={selected === id}
        inPanel={openId === a.id && selected === id}
        verb={{ label: 'Open account', kbd: 'shift+enter', onClick: () => onOpenPage(a) }}
        secondary={
          a.org62Url ? (
            <Tooltip content="Open in Org62">
              <a
                href={a.org62Url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${a.name} in Org62`}
                className="inline-grid size-7 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-fg focus-visible:outline-none focus-visible:shadow-focus"
              >
                <Icon name="new_window" size="sm" />
              </a>
            </Tooltip>
          ) : null
        }
        onClick={() => onSelect(a)}
        onDoubleClick={() => onOpenPage(a)}
      />
    );
  };
  return (
    <Pane as="section" aria-label="Accounts" head={<SectionHead title="Accounts" count={accounts.length} sub="by open pipeline" />} bodyClassName="pb-3">
      {withOpps.length ? (
        <div>
          {/* the heading sits above its list (a list holds only its items) */}
          <h3 className="px-5 pt-2 pb-1 text-caption font-bold text-muted">With open opportunities · {withOpps.length}</h3>
          <div role="list" aria-label="Accounts with open opportunities">
            {withOpps.map(row)}
          </div>
        </div>
      ) : null}
      {without.length ? (
        <div className="mt-2">
          {/* the heading sits above its list (a list holds only its items) */}
          <h3 className="px-5 pt-2 pb-1 text-caption font-bold text-muted">No open opportunities · {without.length}</h3>
          <div role="list" aria-label="Accounts without open opportunities">
            {without.map(row)}
          </div>
        </div>
      ) : null}
    </Pane>
  );
}

export function DealsView() {
  useContextPanels();
  const today = useToday();
  const deals = useApi('getDeals');
  const features = useDealsFeatures();
  const vdpStale = useVdpStale();
  const mainW = useMainWidth();
  const { open: openDetails, openId } = useDetails();
  const [selected, setSelected] = useResumeSelection('deals');
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Deep links (hrefFor, ⌘K, notifications): `?opp=` lands on the opp's account page with the opp open (an opp loads
  // with its account), `?tab=missed&id=` on Missed with the row open. Each link is acted on once.
  const sp = useSearchParams();
  const link = useMemo(() => dealsDeepLink(sp), [sp]);
  const oppLookup = useApi('getOppOptions', { query: {} }, { enabled: link?.kind === 'opp' });
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!link) return;
    const key = link.kind === 'opp' ? `opp:${link.id}` : link.href;
    if (handled.current === key) return;
    if (link.kind === 'missed') {
      handled.current = key;
      navigate(link.href, { replace: true });
      return;
    }
    if (oppLookup.isPending) return;
    handled.current = key;
    const href = oppAccountHref(oppLookup.data?.opps, link.id);
    // Unknown opp (or no account): the panel says where it loads from instead of landing nowhere.
    if (href) navigate(href, { replace: true });
    else openDetails({ kind: 'opportunity', id: link.id });
  }, [link, oppLookup.isPending, oppLookup.data, openDetails]);

  // Live (docs/UX.md "Live updates"): needs and accounts keep their places on a background refresh; arrivals are
  // marked where they land, rows settled elsewhere fade out, the one open in the panel stays.
  const hold = useArrivalHold(rootRef);
  const keepId = openId ?? (selected?.startsWith('acct:') ? selected.slice(5) : selected) ?? null;
  const liveAccounts = useLiveList(deals.data?.accounts, 'deals:accounts', { hold, keep: keepId });
  const liveNeeds = useLiveList(deals.data?.needs, 'deals:needs', { hold, keep: selected ?? null });
  const accounts = useMemo(() => (deals.data ? liveAccounts.items : []), [deals.data, liveAccounts.items]);
  const showAcctHeld = liveAccounts.showHeld;
  const showNeedHeld = liveNeeds.showHeld;
  const showHeld = useCallback(() => {
    showAcctHeld();
    showNeedHeld();
  }, [showAcctHeld, showNeedHeld]);
  const acctLiveOf = liveAccounts.liveOf;
  const needLiveOf = liveNeeds.liveOf;
  const rowLive = useCallback((rowId: string) => (rowId.startsWith('acct:') ? acctLiveOf(rowId.slice(5)) : needLiveOf(rowId)), [acctLiveOf, needLiveOf]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  // the summary's filter (`?pipe=…`): its deals take the Accounts pane's place
  const pipeline = deals.data?.pipeline ?? null;
  const pipeFilter = useMemo(() => pipeFilterOf(sp), [sp]);
  const pipeList = useMemo(() => (pipeline && pipeFilter ? pipelineListRows(pipeline, pipeFilter) : []), [pipeline, pipeFilter]);
  const pipeById = useMemo(() => new Map<string, PipelineRow>(pipeList.map((r) => [pipeRowKey(r), r])), [pipeList]);
  const { dc, missed: hasMissed } = features;
  // the server's rows (src/engines/deals/needs.ts), the same ones the Assistant reads; set-aside rows are left out
  const needs = useMemo(() => (deals.data ? liveNeeds.items : []), [deals.data, liveNeeds.items]);
  const groups = useMemo(() => groupNeeds(needs), [needs]);
  const cap = mainW >= 2100 ? 5 : 3;
  const needById = useMemo(() => new Map(needs.map((n) => [n.id, n])), [needs]);
  const ids = useMemo(
    () => [...groups.flatMap((g) => g.rows.slice(0, cap).map((r) => r.id)), ...(pipeFilter ? pipeList.map(pipeRowKey) : [...accounts.filter((a) => a.openOpps > 0).map((a) => `acct:${a.id}`), ...accounts.filter((a) => a.openOpps === 0).map((a) => `acct:${a.id}`)])],
    [groups, accounts, cap, pipeFilter, pipeList],
  );
  // Wait for the persona, which decides the DC words and the Missed link (the rows come with getDeals).
  const sweepLoading = !features.ready;
  const state = usePanelState('deals.accounts', { loading: deals.isLoading || sweepLoading, error: deals.data ? null : deals.error, empty: !accounts.length });

  const active = selected && ids.includes(selected) ? selected : null;
  useSelectionSurvives(ids, selected, setSelected);
  const accountOf = useCallback(
    (key: string | null) => (key ? byId.get(key.startsWith('acct:') ? key.slice(5) : key.startsWith('pipe:') ? (pipeById.get(key)?.accountId ?? '') : (needById.get(key)?.accountId ?? '')) : undefined),
    [byId, needById, pipeById],
  );
  /** A deal row's page: its account page with the opp open, else the record in Org62. */
  const openDeal = useCallback((r: PipelineRow) => {
    const href = pipeRowHref(r);
    if (href) navigate(href);
    else if (r.url) window.open(r.url, '_blank', 'noopener,noreferrer');
  }, []);
  const activeAccount = accountOf(active);
  useChatContext(activeAccount ? { kind: 'account', id: activeAccount.id, label: activeAccount.name, href: `/deals/${activeAccount.id}` } : null);

  const openKey = useCallback(
    (key: string) => {
      const a = accountOf(key);
      if (!a && !key.startsWith('pipe:')) return;
      setSelected(key);
      if (a) openDetails({ kind: 'account', id: a.id, label: a.name });
    },
    [accountOf, openDetails, setSelected],
  );
  const verbOf = useCallback(
    (key: string) => {
      const n = needById.get(key);
      const deal = pipeById.get(key);
      if (n) navigate(n.verb.href);
      else if (deal) openDeal(deal);
      else {
        const a = accountOf(key);
        if (a) navigate(`/deals/${a.id}`);
      }
    },
    [needById, accountOf, pipeById, openDeal],
  );

  useContextKeys({
    scope: SCOPE,
    rootRef,
    ids,
    selected: active,
    setSelected,
    enabled: state === 'ready',
    onOpen: openKey,
    onPrimary: verbOf,
    onOpenPage: (key) => {
      const deal = pipeById.get(key);
      if (deal) return openDeal(deal);
      const a = accountOf(key);
      if (a) navigate(`/deals/${a.id}`);
    },
  });

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = hasMissed ? [{ id: 'deals.missed', title: 'Open Missed opportunities', group: 'Deals', keywords: ['dc', 'claim', 'sweep'], run: () => navigate('/deals/missed') }] : [];
    if (dc) list.push({ id: 'deals.dcs', title: 'Open Deal contributions: my DCs and DC requests', group: 'Deals', keywords: ['dc', 'split', 'claim', 'request'], run: () => navigate('/deals/dcs') });
    list.push(
      { id: 'deals.pipe.open', title: 'Deals: list my open pipeline', group: 'Deals', keywords: ['pipe', 'pipeline', 'opps'], run: () => navigate(pipeHref({ scope: 'open' })) },
      { id: 'deals.pipe.soon', title: 'Deals: closing in the next 30 days', group: 'Deals', keywords: ['pipe', 'close', 'soon'], run: () => navigate(pipeHref({ scope: 'soon' })) },
      { id: 'deals.pipe.attention', title: 'Deals: needs attention (past close, no next step)', group: 'Deals', keywords: ['pipe', 'overdue', 'next step'], run: () => navigate(pipeHref({ scope: 'attention' })) },
    );
    if (pipeFilter) list.push({ id: 'deals.pipe.clear', title: 'Deals: back to all accounts', group: 'Deals', run: () => navigate('/deals') });
    for (const n of needs.slice(0, 12)) list.push({ id: `deals.need.${n.id}`, title: `Deals: ${n.verb.label} · ${n.title}`, group: 'Deals', run: () => navigate(n.verb.href) });
    if (activeAccount) {
      list.push(
        { id: 'deals.details', title: `Details: ${activeAccount.name}`, group: 'Deals', shortcut: 'enter', run: () => openKey(active!) },
        { id: 'deals.open-account', title: `Open account page: ${activeAccount.name}`, group: 'Deals', shortcut: 'shift+enter', run: () => navigate(`/deals/${activeAccount.id}`) },
      );
    }
    return list;
  }, [needs, activeAccount, active, openKey, hasMissed, dc, pipeFilter]);
  useCommands(commands);

  const totals = useMemo(
    // pipeline and opp counts are the summary tiles' (team or DC opps); the sentence keeps accounts and hours
    () => ({ withOpps: accounts.filter((a) => a.openOpps > 0).length, hours: accounts.reduce((s, a) => s + a.hoursQtd, 0) }),
    [accounts],
  );
  const needCount = needs.length;

  return (
    <ContextPage label="Deals">
      <ContextHead
        title="Deals"
        sentence={
          deals.data && !sweepLoading ? (
            <>
              <span className={needCount ? 'font-bold text-fg' : undefined}>{needCount ? `${needCount} ${needCount === 1 ? 'needs' : 'need'} you` : 'Nothing needs you'}</span>
              {` · ${totals.withOpps} ${totals.withOpps === 1 ? 'account' : 'accounts'} with open opps · ${fmtHours(totals.hours)} this quarter`}
              {vdpStale ? (
                <span className="ml-2 inline-flex items-center gap-1.5 whitespace-nowrap text-danger-700">
                  <Icon name="error" size="xs" />
                  VDP links unverified
                  <AppLink href="/health?connector=vdp" className="font-bold text-link hover:underline">
                    Fix in Health
                  </AppLink>
                </span>
              ) : null}
            </>
          ) : (
            'Loading your accounts…'
          )
        }
        tabs={<DealsTabs tab="deals" missedCount={deals.data?.missedCount} />}
        actions={<IconButton icon="refresh" label="Refresh deals" onClick={() => void deals.refetch()} />}
      />
      <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
        <LivePill count={liveAccounts.held.length + liveNeeds.held.length} onShow={showHeld} placement="overlay" />
        <PanelBoundary name="deals.accounts">
          {state === 'error' ? (
            <PanelError title="Couldn't load your accounts" error={deals.error} onRetry={() => void deals.refetch()} />
          ) : state === 'loading' ? (
            <DealsBodySkeleton />
          ) : state === 'empty' ? (
            <FillingIn variant="panel">
              <EmptyState icon="account" title="No accounts yet" body={noAccountsLine(features)} />
            </FillingIn>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              {pipeline ? (
                <>
                  <DealsSummaryTiles p={pipeline} filter={pipeFilter} />
                  <PipelineByQuarter p={pipeline} filter={pipeFilter} />
                </>
              ) : null}
              <LiveRows value={rowLive}>
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-5 @min-[1000px]/main:grid-cols-[minmax(22rem,0.85fr)_minmax(0,1.5fr)] @min-[1000px]/main:grid-rows-1 @max-[1100px]/main:gap-4">
                <NeedsPane groups={groups} features={features} cap={cap} selected={active} openId={openId} onSelect={(r) => openKey(r.id)} onVerb={(r) => navigate(r.verb.href)} missedToReview={hasMissed ? (deals.data?.missedCount ?? 0) : 0} />
                {pipeline && pipeFilter ? (
                  <PipelineListPane p={pipeline} filter={pipeFilter} selected={active} openId={openId} onSelect={(r) => openKey(pipeRowKey(r))} onOpenPage={openDeal} />
                ) : (
                  <AccountsPane accounts={accounts} features={features} today={today} selected={active} openId={openId} onSelect={(a) => openKey(`acct:${a.id}`)} onOpenPage={(a) => navigate(`/deals/${a.id}`)} />
                )}
              </div>
              </LiveRows>
            </div>
          )}
        </PanelBoundary>
      </div>
    </ContextPage>
  );
}
