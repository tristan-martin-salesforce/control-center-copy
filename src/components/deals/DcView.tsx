'use client';
/**
 * Deals ▸ DCs (D-58): the Deal Contributions you hold and the ones you asked for, in one place.
 *
 *   left    Requests, in the order they move: Requested (waiting for your next logging canvas with rows, or Log DCs
 *           now on Time) → On a canvas ↗ (a canvas holds it: waiting for your Apply, or with Slackbot) → Confirmed
 *           in Org62 (the next scan read the DC, and linked it: an add whatever split Org62 shows). An add says
 *           "Claim a 100% DC"; a change says "Change your DC 50% → 100%". A request still waiting can be edited or
 *           withdrawn; one on a canvas says why it can't. D-68: Not created (a canvas handed it to Slackbot and a
 *           complete Org62 read since shows no DC) offers Ask again; one the app withdrew says why (Org62 changed).
 *   right   Your DCs as the Org62 scans read them: split and role per opp ("Your DC: 100% · AI + Data Architect").
 *
 * Nothing here writes to Org62: a request rides on a logging canvas you Apply on Time, then Slackbot runs it.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { myDcWords, type DcRequest, type MyDcRow } from '@/contract';
import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { AppLink } from '@/components/shell/AppLink';
import { FeatureInactive } from '@/components/shell/FeatureInactive';
import { StatusBadge } from '@/components/domain';
import { navigate } from '@/components/shell/router';
import { Button, fmtAgo, Icon, PanelBoundary, PanelError, ShowMore, usePanelState, useShowMore } from '@/ui';
import { ContextHead, ContextPage, ContextRow, Pane, QuietLine, SectionHead } from './context-frame';
import { DealsTabs } from './DealsHeader';
import { ClaimDcDialog, useClaimDc, type ClaimTarget } from './ClaimDc';
import { useDealsFeatures } from './hooks';
import { errorText } from '@/lib/error-text';

type Group = 'not_created' | 'requested' | 'on_canvas' | 'confirmed' | 'withdrawn';

/** Where a request is, as the list groups it. */
export function dcGroupOf(r: Pick<DcRequest, 'stage'>): Group {
  if (r.stage === 'not_created') return 'not_created';
  if (r.stage === 'waiting') return 'requested';
  if (r.stage === 'in_canvas' || r.stage === 'handed_off') return 'on_canvas';
  if (r.stage === 'confirmed') return 'confirmed';
  return 'withdrawn';
}

const GROUP_TITLE: Record<Group, string> = { not_created: 'Not created in Org62', requested: 'Requested', on_canvas: 'In a batch', confirmed: 'Confirmed in Org62', withdrawn: 'Withdrawn' };
const GROUP_SUB: Record<Group, string> = {
  not_created: 'Slackbot had it, and Org62 still shows no DC: ask again, or set the opp aside on Deals',
  requested: 'go in your next batch with your hours (or Log DCs now on Activity)',
  on_canvas: 'Apply the batch on Activity, then Slackbot sends it to Org62',
  confirmed: 'the Org62 scan read the DC',
  withdrawn: 'never sent',
};

/** "Claim a 100% DC · AI + Data Architect" / "Change your DC 50% → 100% · AI + Data Architect". */
export function dcRequestLine(r: Pick<DcRequest, 'kind' | 'fromSplit' | 'splitPercent' | 'role'>): string {
  return `${r.kind === 'change' ? `Change your DC ${r.fromSplit ?? '?'}% → ${r.splitPercent}%` : `Claim a ${r.splitPercent}% DC`}${r.role ? ` · ${r.role}` : ''}`;
}

function RequestRow({ r, onEdit, onWithdraw, onAskAgain }: { r: DcRequest; onEdit: (r: DcRequest) => void; onWithdraw: (r: DcRequest) => void; onAskAgain: (r: DcRequest) => void }) {
  const g = dcGroupOf(r);
  const badge =
    g === 'not_created' ? (
      <StatusBadge tone="warning">Not created</StatusBadge>
    ) : g === 'confirmed' ? (
      <StatusBadge tone="success" icon="check">
        Confirmed
      </StatusBadge>
    ) : g === 'on_canvas' ? (
      <StatusBadge tone="neutral">{r.stage === 'in_canvas' ? 'Waiting for your Apply' : 'With Slackbot'}</StatusBadge>
    ) : null;
  return (
    <ContextRow
      rowId={r.id}
      title={
        <>
          {r.oppName}
          {r.accountName && !r.oppName.includes(r.accountName) ? <span className="font-normal text-muted"> · {r.accountName}</span> : null}
        </>
      }
      why={[dcRequestLine(r), r.note ?? r.comment].filter(Boolean).join(' · ')}
      // 2026-11-13 audit C5: why it can't be edited gets its own line, never the cut end of the why line
      note={r.lockedReason && !r.note && g !== 'withdrawn' && g !== 'confirmed' && g !== 'not_created' ? r.lockedReason : null}
      badge={badge}
      dimmed={g === 'withdrawn'}
      verb={
        g === 'not_created'
          ? { label: 'Ask again', onClick: () => onAskAgain(r) }
          : !r.lockedReason
            ? { label: 'Edit', onClick: () => onEdit(r) }
            : r.canvasUrl
              ? { label: 'Open in Slack', icon: 'new_window', onClick: () => window.open(r.canvasUrl!, '_blank', 'noopener,noreferrer') }
              : r.stage === 'in_canvas'
                ? { label: 'Review on Activity', onClick: () => navigate('/activity?view=week') }
                : undefined
      }
      secondary={
        !r.lockedReason ? (
          <Button size="xs" variant="quiet" onClick={() => onWithdraw(r)} data-testid={`dc-withdraw-${r.id}`}>
            Withdraw
          </Button>
        ) : r.canvasUrl ? (
          <a href={r.canvasUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-caption font-bold text-link hover:underline">
            On canvas <Icon name="new_window" size="xs" />
          </a>
        ) : null
      }
    />
  );
}

function MyDcRowView({ d }: { d: MyDcRow }) {
  return (
    <ContextRow
      rowId={`dc:${d.org62DcId ?? d.oppId}`}
      title={d.oppName}
      why={[myDcWords(d)?.replace(/^Your DC: /, ''), d.accountName, d.isOpen ? null : 'closed', d.lastSeenAt ? `read ${fmtAgo(d.lastSeenAt)}` : null].filter(Boolean).join(' · ')}
      dimmed={!d.isOpen}
      verb={d.accountId ? { label: 'Open account', onClick: () => navigate(`/deals/${d.accountId}`) } : undefined}
    />
  );
}

/** A group's rows in steps of 50, the count always said (2026-11-13 audit C7). */
function GroupRows<T>({ rows, render }: { rows: T[]; render: (r: T) => ReactNode }) {
  const page = useShowMore(rows.length, { step: 50 });
  return (
    <>
      {rows.slice(0, page.shown).map(render)}
      <ShowMore shown={page.shown} total={rows.length} step={page.step} onMore={page.more} onAll={page.all} noun="requests" />
    </>
  );
}

export function DcView() {
  const features = useDealsFeatures();
  const q = useApi('listDcRequests', undefined, { enabled: features.ready && features.dc });
  const state = usePanelState('deals.dcs', { loading: !features.ready || (features.dc && q.isLoading), error: q.data ? null : q.error });
  const [editing, setEditing] = useState<DcRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const claim = useClaimDc();

  const requests = useMemo(() => q.data?.requests ?? [], [q.data]);
  const mine = useMemo(() => q.data?.myDcs ?? [], [q.data]);
  const groups = useMemo(() => (['not_created', 'requested', 'on_canvas', 'confirmed', 'withdrawn'] as const).map((g) => ({ g, rows: requests.filter((r) => dcGroupOf(r) === g) })).filter((x) => x.rows.length), [requests]);
  const inFlight = requests.filter((r) => dcGroupOf(r) === 'requested' || dcGroupOf(r) === 'on_canvas').length;

  const withdraw = useCallback(
    async (r: DcRequest) => {
      try {
        const res = await api('withdrawDcRequest', { params: { id: r.id }, body: {} });
        toast({ key: `dc-withdraw:${r.id}`, tone: 'success', title: `Withdrew the DC request on ${r.oppName}`, body: 'It never goes to Slackbot.', undo: res.auditId ? { auditId: res.auditId } : undefined });
        await q.refetch();
      } catch (err) {
        toast({ key: `dc-withdraw-err:${r.id}`, tone: 'error', durationMs: null, title: "Couldn't withdraw it", body: errorText(err, 240) });
      }
    },
    [q],
  );
  // 2026-11-13 audit C7: every waiting request in one change, one Undo (59 of them were 59 clicks)
  const [withdrawingAll, setWithdrawingAll] = useState(false);
  const withdrawAll = useCallback(async () => {
    setWithdrawingAll(true);
    try {
      const res = await api('withdrawDcRequests', { body: {} });
      const n = res.entity.withdrawn.length;
      const skipped = res.entity.skipped;
      toast({
        key: 'dc-withdraw-all',
        tone: n ? 'success' : 'info',
        title: n ? `Withdrew ${n} DC ${n === 1 ? 'request' : 'requests'}` : 'Nothing to withdraw',
        body: [n ? 'They never go to Slackbot.' : null, skipped.length ? `${skipped.length} could not be withdrawn: ${skipped[0]!.why}` : null].filter(Boolean).join(' ') || undefined,
        undo: res.auditId ? { auditId: res.auditId, label: 'Undo all' } : undefined,
      });
      await q.refetch();
    } catch (err) {
      toast({ key: 'dc-withdraw-all-err', tone: 'error', title: "Couldn't withdraw them", body: errorText(err, 240) });
    } finally {
      setWithdrawingAll(false);
    }
  }, [q]);
  const save = useCallback(
    async (v: { split: number; role: string; comment: string }) => {
      if (!editing) return;
      setBusy(true);
      try {
        const res = await api('patchDcRequest', { params: { id: editing.id }, body: { split: v.split, role: v.role, ...(v.comment ? { comment: v.comment } : {}) } });
        toast({ key: `dc-edit:${editing.id}`, tone: 'success', title: `DC request saved: ${dcRequestLine(res.entity)}`, body: 'It goes in your next batch.', undo: res.auditId ? { auditId: res.auditId } : undefined });
        await q.refetch();
      } catch (err) {
        toast({ key: `dc-edit-err:${editing.id}`, tone: 'error', durationMs: null, title: "Couldn't save the request", body: errorText(err, 240) });
      } finally {
        setBusy(false);
      }
    },
    [editing, q],
  );
  const target: ClaimTarget | null = editing ? { oppId: editing.oppId, oppName: editing.oppName, myDc: editing.dc, comment: editing.comment ?? '', split: editing.splitPercent, role: editing.role } : null;

  if (features.ready && !features.dc) return <FeatureInactive feature="dealContributions" />;

  return (
    <ContextPage label="Deal contributions">
      <ContextHead
        title="Deals"
        sentence={q.data ? `${mine.length} ${mine.length === 1 ? 'DC' : 'DCs'} of yours in Org62 · ${inFlight} ${inFlight === 1 ? 'request' : 'requests'} in flight. A request goes in your next batch; nothing is sent from here.` : 'Loading your DCs…'}
        tabs={<DealsTabs tab="dcs" />}
      />
      <PanelBoundary name="deals.dcs">
        {state === 'error' ? (
          <PanelError title="Couldn't load your DCs" error={q.error} onRetry={() => void q.refetch()} />
        ) : state === 'loading' ? (
          <QuietLine>Loading…</QuietLine>
        ) : (
          <div className={groups.length ? 'grid min-h-0 flex-1 gap-5 @min-[1000px]/main:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]' : 'flex min-h-0 flex-1 flex-col gap-3'}>
            {/* 01-ui-audit UI-20: no requests is one quiet line, not an empty half of the page; Your DCs then gets the width */}
            {groups.length ? null : (
              <p className="text-body text-muted" data-testid="dc-requests-empty">
                <b className="font-bold text-fg">No DC requests in flight.</b> Claim one from an account page, Missed opportunities or the Assistant: it shows here, then goes in your next batch.
              </p>
            )}
            {groups.length ? (
            <Pane as="section" aria-label="DC requests" head={<SectionHead title="Requests" count={requests.length} sub="requested → in a batch → confirmed in Org62" />} bodyClassName="pb-3">
              {groups.length ? (
                groups
                  .filter((x) => x.g !== 'withdrawn' || showWithdrawn)
                  .map(({ g, rows }) => (
                    <div key={g} role="list" aria-label={GROUP_TITLE[g]} data-group={g}>
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 px-5 pt-3 pb-1">
                        <h3 className="min-w-0 text-caption font-bold text-muted">
                          {GROUP_TITLE[g]} · {rows.length} <span className="font-normal">· {GROUP_SUB[g]}</span>
                        </h3>
                        {g === 'requested' && rows.filter((r) => !r.lockedReason).length > 1 ? (
                          <Button size="xs" variant="quiet" className="ml-auto" loading={withdrawingAll} onClick={() => void withdrawAll()} data-testid="dc-withdraw-all">
                            {`Withdraw all ${rows.filter((r) => !r.lockedReason).length}`}
                          </Button>
                        ) : null}
                      </div>
                      <GroupRows rows={rows} render={(r) => <RequestRow key={r.id} r={r} onEdit={setEditing} onWithdraw={(x) => void withdraw(x)} onAskAgain={(x) => claim.open({ oppId: x.oppId, oppName: x.oppName, myDc: x.dc, comment: x.comment ?? '', split: x.splitPercent, role: x.role })} />} />
                    </div>
                  ))
              ) : null}
              {groups.some((x) => x.g === 'withdrawn') ? (
                <button type="button" onClick={() => setShowWithdrawn((v) => !v)} className="mx-5 mt-2 rounded-sm text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus">
                  {showWithdrawn ? 'Hide withdrawn' : 'Show withdrawn'}
                </button>
              ) : null}
            </Pane>
            ) : null}
            <Pane as="aside" aria-label="Your DCs" head={<SectionHead title="Your DCs" count={mine.length} sub="as the Org62 scans read them" />} bodyClassName="pb-3">
              {mine.length ? (
                <div role="list" aria-label="Your DCs">
                  {mine.map((d) => (
                    <MyDcRowView key={d.org62DcId ?? d.oppId} d={d} />
                  ))}
                </div>
              ) : (
                <QuietLine>
                  No DCs read yet. The Org62 scan reads yours (split and role) on its next run; <AppLink href="/health?connector=org62" className="font-bold text-link hover:underline">Health</AppLink> shows when it last ran.
                </QuietLine>
              )}
            </Pane>
          </div>
        )}
      </PanelBoundary>
      <ClaimDcDialog target={target} edit busy={busy} onClose={() => setEditing(null)} onSubmit={save} />
      {claim.dialog}
    </ContextPage>
  );
}
