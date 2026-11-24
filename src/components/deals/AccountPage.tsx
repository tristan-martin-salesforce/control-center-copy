'use client';
/**
 * Account page (UI-SPEC §12, design v2). Two panes: the tabs (Brief · Initiatives · Assets · Sessions · Notes) on the
 * left, and what you act on beside them (opportunities, open tasks, team). When the main area is narrow (a docked
 * panel is open, or a small window) the side pane folds into an Opps tab.
 *
 * The focal point is the one thing this account needs from you (a DC gap, a possible missed opp, a close coming up),
 * as the page's only filled button. Click or Enter on an opp, task, initiative or asset opens it in the docked panel;
 * j/k move the selection, Esc closes. Brief highlights keep their own Undo (highlight-undo.ts).
 *
 * Personas (D-55): the DC need, DC badges and words, and the VDP fact show only while the persona has deal
 * contributions and VDP; the page keeps its skeleton until the persona is known, so the focal button doesn't change.
 *
 * DCs (D-58): each opp says my DC ("Your DC: 100% · AI + Data Architect") or a request in flight; an open opp of mine
 * without one has Claim DC, and the page's need claims the specific opp in place (the Claim form, a DC request on the
 * next logging canvas). `?claim=<oppId>` (or `?claim=1`: the first such opp) opens that form on arrival.
 */
import { AppLink } from '@/components/shell/AppLink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { myDcWords, type AccountDetail, type Asset, type Brief, type BriefHighlight, type DcRequest, type Opportunity, type WorkItem } from '@/contract';
import { openClaudeUrl } from '@/components/agents/claude';
import { useApi } from '@/client/hooks';
import { useCommands, type Command } from '@/client/keyboard';
import { useResumeExtra } from '@/client/resume/hooks';
import { useChatContext } from '@/components/chat';
import { BriefReader } from '@/components/briefs/BriefReader';
import { useHighlightActions } from '@/components/briefs/useHighlightActions';
import { promotedState } from '@/components/briefs/promoted';
import { AgentRunRow, DomainClock, StatusBadge } from '@/components/domain';
import { Button, EmptyState, fmtAgo, Icon, PanelBoundary, PanelError, SegmentedToggle, Skeleton, SourceChip, Tabs, tabPanelProps, useNow, usePanelState, useTimeZone } from '@/ui';
import { ContextHead, ContextPage, ContextRow, Pane, QuietLine, SectionHead, useContextKeys, useDetails, useMainWidth } from './context-frame';
import { daysUntil, fmtAmount, fmtDate, fmtHours } from './format';
import { useDealsFeatures, useMissedSweep, useToday, useVdpStale } from './hooks';
import { accountDcWords, accountNeed, claimEvidenceOf, DC_WORD, VDP_WORD } from './needs';
import { SetAsideActions } from '@/components/needs/SetAside';
import { useClaimDc, type ClaimTarget } from './ClaimDc';
import { accountOppDeepLink } from './links';
import { useContextPanels } from './register-panels';
import { navigate } from '@/components/shell/router';

type TabKey = 'brief' | 'opps' | 'initiatives' | 'assets' | 'sessions' | 'notes';
const SCOPE = 'page:account';
/** Below this main width (a docked panel open on a 1,440 px screen) the side pane folds into an "Opps & tasks" tab. */
const SIDE_MIN = 1100;
const LIVE = (t: WorkItem) => !['done', 'dismissed'].includes(t.state);
const stageShort = (s: string) => s.replace(/^\d+\s*-\s*/, '');

// ── Brief tab ───────────────────────────────────────────────────────────────────────────────

function BriefTab({ briefs, selected, openId, onSelect, onOpen }: { briefs: Brief[]; selected: string | null; openId: string | null; onSelect: (id: string) => void; onOpen: (h: BriefHighlight) => void }) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const brief = briefs.find((b) => b.id === pickedId) ?? briefs[0];
  const tz = useTimeZone();
  const now = useNow(30_000).toISOString();
  const actions = useHighlightActions();
  const { open } = useDetails();
  if (!brief) {
    return <EmptyState icon="summary" title="No opportunity brief yet" body="Briefs are written for open opps on this account once Slack, Gmail and Drive have been scanned." />;
  }
  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      {briefs.length > 1 ? <SegmentedToggle label="Brief" size="sm" value={brief.id} onChange={setPickedId} options={briefs.map((b) => ({ value: b.id, label: b.title }))} /> : null}
      <BriefReader
        brief={brief}
        tz={tz}
        now={now}
        compact
        selectedHighlight={selected}
        openId={openId}
        onPromote={actions.promote}
        onMakeTask={actions.makeTask}
        onDismiss={actions.dismiss}
        onUndo={(h) => void actions.undo(h)}
        onOpenTask={(h) => {
          // In Triage → that row in Triage; a task → its Details (the same one state the row shows).
          const to = promotedState(h, actions.kindOf(h.id))?.open;
          if (to && 'href' in to) navigate(to.href);
          else if (to) open({ kind: 'work_item', id: to.taskId, label: h.title });
        }}
        onOpenSource={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
        onOpen={(h) => {
          onSelect(h.id);
          onOpen(h);
        }}
      />
    </div>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────

interface Sel {
  selected: string | null;
  openId: string | null;
  select: (id: string, open: () => void) => void;
}

/** An opp's DC words: my DC, else a request in flight ("DC requested: 100%", "DC change requested: 50% → 100%"). */
export function oppDcWords(o: Pick<Opportunity, 'myDc' | 'dcAssigned'>, req: Pick<DcRequest, 'kind' | 'fromSplit' | 'splitPercent' | 'stage'> | undefined): string | null {
  const pending = req && req.stage !== 'confirmed' && req.stage !== 'dismissed' && req.stage !== 'not_created' ? `${req.kind === 'change' ? `DC change requested: ${req.fromSplit ?? '?'}% → ${req.splitPercent}%` : `DC requested: ${req.splitPercent}%`}${req.stage === 'waiting' ? '' : req.stage === 'in_canvas' ? ' (in a batch)' : ' (with Slackbot)'}` : null;
  const mine = myDcWords(o.myDc) ?? (o.dcAssigned ? 'DC assigned' : null);
  // D-68: Slackbot had it and Org62 shows no DC: the opp is a gap again (Ask again on Deals ▸ DCs)
  const notCreated = req?.stage === 'not_created' && !o.myDc ? 'DC request not created in Org62' : null;
  return [mine, pending, notCreated].filter(Boolean).join(' · ') || null;
}

function OppRows({ opps, today, s, onOpen, requests, onClaim, gaps }: { opps: Opportunity[]; today: string; s: Sel; onOpen: (o: Opportunity) => void; requests: ReadonlyMap<string, DcRequest>; onClaim: (o: Opportunity) => void; gaps: ReadonlySet<string> }) {
  const { dc } = useDealsFeatures();
  return (
    <>
      {opps.map((o) => {
        const req = requests.get(o.id);
        // on the team with no DC, or a DC gap the server counts (my hours, the sweep): Claim DC in place
        const noDc = dc && o.isOpen && !o.dcAssigned && !req && (o.isMine || gaps.has(o.id));
        const passed = o.isOpen && o.closeDate && daysUntil(o.closeDate, today) < 0;
        return (
          <ContextRow
            key={o.id}
            rowId={o.id}
            title={o.name}
            meta={
              <>
                <span className="text-body text-fg">{fmtAmount(o.amount)}</span>
                <span className={passed ? 'text-danger-700' : undefined}>{fmtDate(o.closeDate)}</span>
              </>
            }
            badge={
              passed ? (
                <StatusBadge tone="danger" icon="error">
                  Close passed
                </StatusBadge>
              ) : noDc ? (
                <StatusBadge tone="warning" icon="warning">
                  No DC
                </StatusBadge>
              ) : null
            }
            why={[stageShort(o.stage), o.nextStep ? `Next: ${o.nextStep}` : o.products.length ? o.products.join(', ') : o.owner ? `Owner ${o.owner.name}` : null, dc ? oppDcWords(o, req) : null].filter(Boolean).join(' · ')}
            edge={passed ? 'danger' : noDc ? 'warning' : 'none'}
            dimmed={!o.isOpen}
            selected={s.selected === o.id}
            inPanel={s.openId === o.id}
            verb={noDc ? { label: 'Claim DC', onClick: () => onClaim(o) } : o.org62Url ? { label: 'Org62', icon: 'new_window', onClick: () => window.open(o.org62Url!, '_blank', 'noopener,noreferrer') } : undefined}
            onClick={() => s.select(o.id, () => onOpen(o))}
          />
        );
      })}
    </>
  );
}

type SideProps = { d: AccountDetail; today: string; s: Sel; onOpenOpp: (o: Opportunity) => void; onOpenTask: (t: WorkItem) => void; onOpenTaskPage: (t: WorkItem) => void; requests: ReadonlyMap<string, DcRequest>; onClaim: (o: Opportunity) => void };

function SidePane(p: SideProps) {
  return (
    <Pane as="aside" aria-label="Opportunities and tasks" bodyClassName="pb-3">
      <SideContent {...p} />
    </Pane>
  );
}

function SideContent({ d, today, s, onOpenOpp, onOpenTask, onOpenTaskPage, requests, onClaim }: SideProps) {
  const { dc } = useDealsFeatures();
  const open = d.opps.filter((o) => o.isOpen);
  const closed = d.opps.filter((o) => !o.isOpen);
  const tasks = d.items.filter(LIVE);
  const gaps = new Set((d.needs ?? []).flatMap((n) => n.opps.map((g) => g.oppId)));
  return (
    <>
      <SectionHead title="Opportunities" count={open.length} sub={closed.length ? `${closed.length} closed` : undefined} />
      {d.opps.length ? (
        <div role="list" aria-label="Opportunities">
          <OppRows opps={open} today={today} s={s} onOpen={onOpenOpp} requests={requests} onClaim={onClaim} gaps={gaps} />
          {closed.length ? <h3 className="px-5 pt-3 pb-1 text-caption font-bold text-muted">Closed · {closed.length}</h3> : null}
          <OppRows opps={closed} today={today} s={s} onOpen={onOpenOpp} requests={requests} onClaim={onClaim} gaps={gaps} />
        </div>
      ) : (
        <QuietLine>{dc ? 'No opportunities. Opps appear when Org62 shows you on the team or a DC.' : 'No opportunities. Opps appear when Org62 shows you as the owner or on the team.'}</QuietLine>
      )}
      <SectionHead title="Open tasks" count={tasks.length} className="mt-2" />
      {tasks.length ? (
        <div role="list" aria-label="Open tasks">
          {tasks.map((t) => (
            <ContextRow
              key={t.id}
              rowId={t.id}
              title={t.title}
              why={t.why || t.state.replace(/_/g, ' ')}
              meta={t.due ? <span>{fmtDate(t.due)}</span> : null}
              selected={s.selected === t.id}
              inPanel={s.openId === t.id}
              verb={{ label: 'Open page', onClick: () => onOpenTaskPage(t) }}
              onClick={() => s.select(t.id, () => onOpenTask(t))}
            />
          ))}
        </div>
      ) : (
        <QuietLine>No open tasks on this account.</QuietLine>
      )}
      <SectionHead title="Team" count={d.account.team.length} className="mt-2" />
      {d.account.team.length ? (
        <ul className="px-5 pb-2">
          {d.account.team.map((p) => (
            <li key={p.id} className="py-1 text-body">
              <span className="font-bold text-fg">{p.name}</span>
              {p.role ? <span className="text-muted"> · {p.role}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <QuietLine>No team recorded in Org62.</QuietLine>
      )}
    </>
  );
}

const INI_WORD = { proposed: 'Proposed', active: 'Active', paused: 'Paused', completed: 'Completed', abandoned: 'Abandoned' } as const;
const DOC_ICON: Record<string, string> = { slides: 'gpres', doc: 'gdoc', sheet: 'gsheet', pdf: 'pdf', folder: 'folder', canvas: 'slack_canvas', link: 'link' };

function InitiativesTab({ d, s, onOpen }: { d: AccountDetail; s: Sel; onOpen: (id: string, label: string) => void }) {
  if (!d.initiatives.length) return <EmptyState icon="flow" title="No initiatives yet" body="An initiative groups the tasks, assets and sessions behind one outcome, such as a demo or a proposal." />;
  return (
    <div role="list" aria-label="Initiatives" className="py-2">
      {d.initiatives.map((i) => {
        const n = d.items.filter((t) => t.initiativeId === i.id && LIVE(t)).length;
        return (
          <ContextRow
            key={i.id}
            rowId={i.id}
            title={i.title}
            why={i.purpose || i.summary}
            meta={
              <>
                <span>{INI_WORD[i.status]}</span>
                <span>
                  {n} open {n === 1 ? 'task' : 'tasks'}
                </span>
              </>
            }
            selected={s.selected === i.id}
            inPanel={s.openId === i.id}
            verb={{ label: 'Open page', onClick: () => navigate(`/initiatives/${i.id}`) }}
            onClick={() => s.select(i.id, () => onOpen(i.id, i.title))}
          />
        );
      })}
    </div>
  );
}

function AssetsTab({ assets, s, onOpen }: { assets: Asset[]; s: Sel; onOpen: (a: Asset) => void }) {
  const now = useNow(60_000);
  if (!assets.length) return <EmptyState icon="file" title="No assets linked" body="Drive files, canvases and demo orgs that belong to this account show up here with their last edit." />;
  return (
    <div role="list" aria-label="Assets" className="py-2">
      {assets.map((a) => (
        <ContextRow
          key={a.id}
          rowId={a.id}
          lead={DOC_ICON[a.kind] ? <Icon set="doctype" name={DOC_ICON[a.kind]!} size="lg" /> : <Icon name={a.kind === 'claude_session' ? 'agent_session' : 'file'} size="lg" className="text-muted" />}
          title={a.title}
          why={a.updatedAt ? `Last edit ${fmtAgo(a.updatedAt, now)}${a.updatedBy ? ` by ${a.updatedBy}` : ''}` : 'No edit time recorded'}
          meta={<SourceChip source={a.source} />}
          selected={s.selected === a.id}
          inPanel={s.openId === a.id}
          verb={a.url ? { label: 'Open', icon: 'new_window', onClick: () => window.open(a.url!, '_blank', 'noopener,noreferrer') } : undefined}
          onClick={() => s.select(a.id, () => onOpen(a))}
        />
      ))}
    </div>
  );
}

function SessionsTab({ d }: { d: AccountDetail }) {
  const { open } = useDetails();
  const now = useNow(5_000);
  if (!d.runs.length) return <EmptyState icon="agent_session" title="No sessions for this account" body="Claude sessions and tool runs linked to this account's tasks appear here." />;
  const titleOf = (id: string | null) => d.items.find((i) => i.id === id)?.title ?? null;
  return (
    <DomainClock now={now.toISOString()}>
      <div className="px-3 py-2">
        {d.runs.map((r) => (
          <AgentRunRow
            key={r.id}
            run={r}
            taskTitle={titleOf(r.workItemId)}
            onOpenDeepLink={(url) => openClaudeUrl(url)}
            onOpenTask={(id) => open({ kind: 'work_item', id, label: titleOf(id) ?? undefined })}
            onAction={() => open({ kind: 'agent_run', id: r.id, label: r.title })}
          />
        ))}
      </div>
    </DomainClock>
  );
}

function NotesTab({ d }: { d: AccountDetail }) {
  return (
    <div className="px-6 py-5">
      <h3 className="text-lead font-bold text-fg-heading">Notes</h3>
      {d.account.notes ? (
        <div className="cx-prose mt-2">
          {d.account.notes.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="whitespace-pre-line">
              {para.split(/\*\*(.+?)\*\*/g).map((part, j) => (j % 2 ? <strong key={j}>{part}</strong> : part))}
            </p>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-body text-muted">No notes. Account notes come from Org62.</p>
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────

export function AccountPage({ accountId }: { accountId: string }) {
  useContextPanels();
  const today = useToday();
  const q = useApi('getAccount', { params: { accountId } });
  const features = useDealsFeatures();
  // my DC requests in flight, per opp (the DC words and Claim on each row)
  const dcList = useApi('listDcRequests', undefined, { enabled: features.ready && features.dc });
  const requests = useMemo(() => {
    const m = new Map<string, DcRequest>();
    for (const r of dcList.data?.requests ?? []) if (r.stage !== 'dismissed' && r.stage !== 'confirmed' && !m.has(r.oppId)) m.set(r.oppId, r);
    return m;
  }, [dcList.data]);
  const { open: openClaim, dialog: claimDialog } = useClaimDc();
  // strong evidence only: the form says what the app knows (your hours, the team, the sweep) before you write what you did
  const claimOpp = useCallback((o: Opportunity) => openClaim({ oppId: o.id, oppName: o.name, myDc: o.myDc, evidence: q.data ? claimEvidenceOf(q.data, o) : undefined, ...((o.hoursQtd ?? 0) >= 1 ? { comment: `Logged ${fmtHours(o.hoursQtd)} on it this quarter` } : {}) } satisfies ClaimTarget), [openClaim, q.data]);
  const search = useSearchParams();
  const claimParam = search?.get('claim') ?? null;
  const sweep = useMissedSweep(features);
  const vdpStale = useVdpStale();
  const mainW = useMainWidth();
  const side = mainW >= SIDE_MIN;
  const [tabPref, setTab] = useResumeExtra<TabKey>(`account-tab:${accountId}`, 'brief');
  const tab: TabKey = side && tabPref === 'opps' ? 'brief' : tabPref;
  // When the side pane folds (a docked panel opened from one of its rows), follow that row into the tab, so the row
  // you clicked doesn't vanish under the cursor.
  const sideWas = useRef(side);
  const state = usePanelState('deals.account', { loading: q.isLoading || !features.ready, error: q.data ? null : q.error });
  const { open: openDetails, openId } = useDetails();
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const d = q.data;
  useChatContext(d ? { kind: 'account', id: d.account.id, label: d.account.name, href: `/deals/${d.account.id}` } : null);

  // Every row this page can select, with what Enter opens for it.
  const targets = useMemo(() => {
    const m = new Map<string, () => void>();
    if (!d) return m;
    const brief = d.briefs[0];
    if (tab === 'brief' && brief) for (const h of brief.highlights) m.set(h.id, () => openDetails({ kind: 'brief_highlight', id: h.id, label: h.title }));
    if (tab === 'initiatives') for (const i of d.initiatives) m.set(i.id, () => openDetails({ kind: 'initiative', id: i.id, label: i.title }));
    if (tab === 'assets') for (const a of d.assets) m.set(a.id, () => openDetails({ kind: 'asset', id: a.id, label: a.title }));
    if (side || tab === 'opps') {
      for (const o of [...d.opps.filter((x) => x.isOpen), ...d.opps.filter((x) => !x.isOpen)]) m.set(o.id, () => openDetails({ kind: 'opportunity', id: o.id, label: o.name }));
      for (const t of d.items.filter(LIVE)) m.set(t.id, () => openDetails({ kind: 'work_item', id: t.id, label: t.title }));
    }
    return m;
  }, [d, tab, side, openDetails]);
  const ids = useMemo(() => [...targets.keys()], [targets]);
  const active = selected && targets.has(selected) ? selected : null;
  useEffect(() => {
    const was = sideWas.current;
    sideWas.current = side;
    if (was && !side && d && selected && (d.opps.some((o) => o.id === selected) || d.items.some((t) => t.id === selected))) setTab('opps');
  }, [side, selected, d, setTab]);

  const s: Sel = {
    selected: active,
    openId,
    select: useCallback((id: string, open: () => void) => {
      setSelected(id);
      open();
    }, []),
  };

  useContextKeys({
    scope: SCOPE,
    rootRef,
    ids,
    selected: active,
    setSelected,
    enabled: state === 'ready',
    onOpen: (id) => targets.get(id)?.(),
  });

  const { dc, vdp, missed: hasMissed } = features;
  const need = d ? accountNeed(d, sweep.data?.missed ?? [], today, { dc, vdp, missed: hasMissed }) : null;
  // the need claims the specific opp in place (the Claim form), never a trip to Missed
  const runNeed = useCallback(() => {
    if (!need) return;
    const o = need.claimOppId ? d?.opps.find((x) => x.id === need.claimOppId) : undefined;
    if (o) claimOpp(o);
    else if (need.href.startsWith('http')) window.open(need.href, '_blank', 'noopener,noreferrer');
    else navigate(need.href);
  }, [need, d, claimOpp]);
  // ?claim=<oppId> (or ?claim=1: the first open opp of mine without a DC) opens the Claim form once
  const claimedParam = useRef<string | null>(null);
  useEffect(() => {
    if (!claimParam || !d || !features.ready || !dc || claimedParam.current === claimParam) return;
    claimedParam.current = claimParam;
    const o = d.opps.find((x) => x.id === claimParam) ?? (need?.claimOppId ? d.opps.find((x) => x.id === need.claimOppId) : undefined);
    if (o) claimOpp(o);
  }, [claimParam, d, features.ready, dc, need, claimOpp]);
  // ?opp=<oppId> (a deep link: hrefFor, ⌘K, /deals?opp=) selects that opportunity and opens it in Details, once
  const oppParam = accountOppDeepLink(search);
  const oppOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!oppParam || !d || oppOpened.current === oppParam) return;
    oppOpened.current = oppParam;
    const o = d.opps.find((x) => x.id === oppParam);
    if (!o) return;
    if (!side) setTab('opps');
    setSelected(o.id);
    openDetails({ kind: 'opportunity', id: o.id, label: o.name });
  }, [oppParam, d, side, setTab, openDetails]);
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [{ id: 'account.all-deals', title: 'Back to all deals', group: 'Deals', run: () => navigate('/deals') }];
    if (need) list.push({ id: 'account.need', title: `${need.label}: ${need.why}`, group: 'Deals', run: runNeed });
    if (d?.account.org62Url) list.push({ id: 'account.org62', title: `Open ${d.account.name} in Org62`, group: 'Deals', run: () => window.open(d.account.org62Url!, '_blank', 'noopener,noreferrer') });
    return list;
  }, [need, d, runNeed]);
  useCommands(commands);

  if (state === 'error') return <PanelError title="Couldn't load this account" error={q.error} onRetry={() => void q.refetch()} className="m-8" />;
  if (state === 'loading' || !d) {
    return (
      <ContextPage label="Account loading">
        <Skeleton variant="line" count={2} className="w-1/2" />
        <div className="grid min-h-0 flex-1 gap-5 @min-[1180px]/main:grid-cols-[minmax(0,1fr)_minmax(24rem,34rem)]">
          <Pane aria-label="Loading">
            <Skeleton variant="row" count={6} className="px-5 pt-4" />
          </Pane>
          <Pane aria-label="Loading opportunities" className="hidden @min-[1180px]/main:flex">
            <Skeleton variant="row" count={4} className="px-5 pt-4" />
          </Pane>
        </div>
      </ContextPage>
    );
  }

  const { account } = d;
  const openOpps = d.opps.filter((o) => o.isOpen);
  const openTasks = d.items.filter(LIVE);
  const nextClose = openOpps.map((o) => o.closeDate).filter((x): x is string => !!x).sort()[0] ?? null;
  const highlightCount = d.briefs.reduce((n, b) => n + b.highlights.filter((h) => h.status === 'new' || h.status === 'seen').length, 0);
  const facts = [
    openOpps.length ? `${openOpps.length} open ${openOpps.length === 1 ? 'opp' : 'opps'} · ${fmtAmount(openOpps.reduce((x, o) => x + (o.amount ?? 0), 0))}` : 'No open opps',
    nextClose ? `next close ${fmtDate(nextClose)}` : null,
    `${fmtHours(account.hoursQtd)} this quarter`,
    `${openTasks.length} open ${openTasks.length === 1 ? 'task' : 'tasks'}`,
    openOpps.length && dc ? (accountDcWords(openOpps.filter((o) => o.myDc).map((o) => ({ oppId: o.id, oppName: o.name, split: o.myDc!.split, role: o.myDc!.role }))) ?? DC_WORD[account.dcStatus]) : null,
    openOpps.length && vdp ? `${VDP_WORD[account.vdpStatus]}${vdpStale && account.vdpStatus !== 'none' ? ' (unverified)' : ''}` : null,
  ].filter(Boolean);

  const tabs: Array<{ value: TabKey; label: string; count?: number }> = [
    { value: 'brief', label: 'Brief', count: highlightCount || undefined },
    ...(side ? [] : [{ value: 'opps' as const, label: 'Opps & tasks', count: d.opps.length + openTasks.length }]),
    { value: 'initiatives', label: 'Initiatives', count: d.initiatives.length },
    { value: 'assets', label: 'Assets', count: d.assets.length },
    { value: 'sessions', label: 'Sessions', count: d.runs.length },
    { value: 'notes', label: 'Notes' },
  ];

  return (
    <ContextPage label={account.name}>
      <ContextHead
        crumb={
          <span className="flex items-center gap-2">
            <AppLink href="/deals" className="text-link hover:underline">
              Deals
            </AppLink>
            <span aria-hidden>›</span>
            {/* 01-ui-audit UI-21: the crumb names the account (the industry is not a level of Deals) */}
            <span className="font-bold text-fg">{account.name}</span>
            {account.industry ? <span className="text-muted">· {account.industry}</span> : null}
          </span>
        }
        title={account.name}
        sentence={
          <>
            {need ? <span className="font-bold text-fg">{need.why}. </span> : null}
            {facts.join(' · ')}
          </>
        }
        actions={
          <>
            {account.org62Url ? (
              <Button variant="quiet" size="sm" icon="new_window" onClick={() => window.open(account.org62Url!, '_blank', 'noopener,noreferrer')}>
                Org62
              </Button>
            ) : null}
            {/* the need can always be set aside: Not needed (a DC gap, per opp) or Snooze 1 week (a close coming up) */}
            {need?.resolve ? <SetAsideActions resolve={need.resolve} size="md" /> : null}
            {need ? (
              <Button variant="primary" size="md" onClick={runNeed} data-testid="account-need">
                {need.label}
              </Button>
            ) : null}
          </>
        }
      />
      <div ref={rootRef} className="grid min-h-0 flex-1 gap-5 @min-[1180px]/main:grid-cols-[minmax(0,1fr)_minmax(24rem,34rem)]">
        <Pane
          aria-label="Account sections"
          head={
            <div className="px-3 pt-1">
              <Tabs<TabKey> label="Account sections" idBase="acct" variant="line" value={tab} onChange={setTab} tabs={tabs} />
            </div>
          }
        >
          <div {...tabPanelProps('acct', tab)} className="outline-none">
            <PanelBoundary name={`deals.account.${tab}`}>
              {tab === 'brief' ? <BriefTab briefs={d.briefs} selected={active} openId={openId} onSelect={setSelected} onOpen={(h) => openDetails({ kind: 'brief_highlight', id: h.id, label: h.title })} /> : null}
              {tab === 'opps' ? (
                <div className="pb-3">
                  <SideContent
                    d={d}
                    today={today}
                    s={s}
                    onOpenOpp={(o) => openDetails({ kind: 'opportunity', id: o.id, label: o.name })}
                    onOpenTask={(t) => openDetails({ kind: 'work_item', id: t.id, label: t.title })}
                    onOpenTaskPage={(t) => navigate(`/work/${t.id}`)}
                    requests={requests}
                    onClaim={claimOpp}
                  />
                </div>
              ) : null}
              {tab === 'initiatives' ? <InitiativesTab d={d} s={s} onOpen={(id, label) => openDetails({ kind: 'initiative', id, label })} /> : null}
              {tab === 'assets' ? <AssetsTab assets={d.assets} s={s} onOpen={(a) => openDetails({ kind: 'asset', id: a.id, label: a.title })} /> : null}
              {tab === 'sessions' ? <SessionsTab d={d} /> : null}
              {tab === 'notes' ? <NotesTab d={d} /> : null}
            </PanelBoundary>
          </div>
        </Pane>
        {side ? (
          <SidePane
            d={d}
            today={today}
            s={s}
            onOpenOpp={(o) => openDetails({ kind: 'opportunity', id: o.id, label: o.name })}
            onOpenTask={(t) => openDetails({ kind: 'work_item', id: t.id, label: t.title })}
            onOpenTaskPage={(t) => navigate(`/work/${t.id}`)}
            requests={requests}
            onClaim={claimOpp}
          />
        ) : null}
      </div>
      {claimDialog}
    </ContextPage>
  );
}
