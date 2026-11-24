'use client';
/**
 * Details renderers for Deals (docked right panel): account, opportunity, missed opp. Each pins its ONE filled action
 * in the footer (the row it came from keeps its verb quiet while it is open here).
 *   account       facts, the need (the server's DC gap / missed opps / close soon), open opps, open tasks · the need,
 *                 Not needed / Snooze 1 week (src/components/needs/SetAside.tsx), Open account
 *   opportunity   stage, amount, close, next step, my DC (split, role) · Open in Org62 (a link: nothing is written) ·
 *                 Claim DC / Change my DC (the Claim form: a DC request on the next logging canvas)
 *   missed_opp    verdict, evidence, lock and split notes, other DCs · Claim (the Claim form: split, role, what you
 *                 did; a DC request with Undo; nothing is sent) · Dismiss with a reason. The Slackbot prompt only on a
 *                 claim the app had to make a task for (it didn't know the opp)
 * Personas (D-55): the DC and VDP facts, the No DC badge and the DC need show only while the persona has deal
 * contributions and VDP; account and opportunity keep their loading state until the persona is known.
 */
import { useState } from 'react';
import { claimComment, myDcWords, type AccountDetail, type MissedOpp, type MissedPayload, type Opportunity } from '@/contract';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation, type OptimisticCache } from '@/client/optimistic';
import { toast } from '@/client/toast';
import { StatusBadge } from '@/components/domain/lib/v2';
import { useRightPanel } from '@/components/shell/panel';
import { Button, EmptyState, PanelError, Popover, Skeleton, SourceChip } from '@/ui';
import { daysUntil, fmtAmount, fmtDate, fmtHours } from './format';
import { useDealsFeatures, useMissedSweep, useToday } from './hooks';
import { DISMISS_REASONS, evidenceChip, missedNotes } from './missed';
import { accountDcWords, accountNeed, DC_WORD, VDP_WORD } from './needs';
import { ClaimDcDialog, dcRequestToast, useClaimDc, type ClaimTarget } from './ClaimDc';
import { SetAsideActions } from '@/components/needs/SetAside';
import { Facts, PanelSection, PanelShell, useCachedFind } from './panel-shell';
import { NotesBlock, PromptDraft } from './missed-parts';
import { navigate } from '@/components/shell/router';

const stageShort = (s: string) => s.replace(/^\d+\s*-\s*/, '');
const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

function Loading() {
  return (
    <div className="space-y-3 px-6 py-5">
      <Skeleton variant="line" count={2} />
      <Skeleton variant="row" count={4} />
    </div>
  );
}

// ── Account ──────────────────────────────────────────────────────────────────────────────────

export function AccountPanel({ id }: { id: string }) {
  const panel = useRightPanel();
  const today = useToday();
  const q = useApi('getAccount', { params: { accountId: id } });
  const f = useDealsFeatures();
  const sweep = useMissedSweep(f);
  if (q.isError && !q.data) return <PanelError title="Couldn't load this account" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data || !f.ready) return <Loading />;
  const d = q.data;
  const need = accountNeed(d, sweep.data?.missed ?? [], today, f);
  const opps = d.opps.filter((o) => o.isOpen);
  const tasks = d.items.filter((t) => !['done', 'dismissed'].includes(t.state));
  const go = (href: string) => (href.startsWith('http') ? open(href) : navigate(href));
  return (
    <PanelShell
      testId="panel-account"
      from={`Account${d.account.industry ? ` · ${d.account.industry}` : ''}`}
      title={d.account.name}
      sub={need ? need.why : opps.length ? `${opps.length} open ${opps.length === 1 ? 'opp' : 'opps'} · ${fmtAmount(opps.reduce((s, o) => s + (o.amount ?? 0), 0))}` : 'No open opportunities'}
      badge={need ? <StatusBadge tone="warning" icon="warning">Needs you</StatusBadge> : null}
      footer={
        <>
          {need ? (
            <Button variant="primary" size="md" onClick={() => go(need.href)}>
              {need.label}
            </Button>
          ) : null}
          {/* the need can be set aside here too (Not needed per opp, Snooze 1 week), the same decision as Deals */}
          {need?.resolve ? <SetAsideActions resolve={need.resolve} size="md" /> : null}
          <Button variant={need ? 'quiet' : 'primary'} size="md" onClick={() => navigate(`/deals/${d.account.id}`)}>
            Open account
          </Button>
          {d.account.org62Url ? (
            <Button variant="quiet" size="md" icon="new_window" onClick={() => open(d.account.org62Url!)}>
              Org62
            </Button>
          ) : null}
        </>
      }
    >
      <Facts
        rows={[
          ...(f.dc ? ([['My DC', opps.length ? (accountDcWords(opps.filter((o) => o.myDc).map((o) => ({ oppId: o.id, oppName: o.name, split: o.myDc!.split, role: o.myDc!.role }))) ?? DC_WORD[d.account.dcStatus]) : 'No open opps']] as Array<[string, string]>) : []),
          ...(f.vdp ? ([['VDP link', VDP_WORD[d.account.vdpStatus]]] as Array<[string, string]>) : []),
          ['Hours this quarter', fmtHours(d.account.hoursQtd)],
          ['Open tasks', String(tasks.length)],
        ]}
      />
      <PanelSection title={`Open opportunities · ${opps.length}`}>
        {opps.length ? (
          <ul className="divide-y divide-line">
            {opps.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => panel.openDetails({ kind: 'opportunity', id: o.id, label: o.name })} className="block w-full py-2 text-left hover:underline focus-visible:outline-none focus-visible:shadow-focus">
                  <span className="block truncate text-body font-bold text-fg">{o.name}</span>
                  <span className="block truncate text-caption text-muted tabular-nums">
                    {stageShort(o.stage)} · {fmtAmount(o.amount)} · closes {fmtDate(o.closeDate)}
                    {f.dc && o.myDc ? ` · ${myDcWords(o.myDc)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-muted">None open.</p>
        )}
      </PanelSection>
      {tasks.length ? (
        <PanelSection title={`Open tasks · ${tasks.length}`}>
          <ul className="divide-y divide-line">
            {tasks.slice(0, 6).map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => panel.openDetails({ kind: 'work_item', id: t.id, label: t.title })} className="block w-full py-2 text-left hover:underline focus-visible:outline-none focus-visible:shadow-focus">
                  <span className="block truncate text-body text-fg">{t.title}</span>
                  {t.why ? <span className="block truncate text-caption text-muted">{t.why}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {/* caps audit F-13: six here; the rest are one click away, on Work filtered by this account */}
          {tasks.length > 6 ? (
            <button type="button" onClick={() => navigate(`/work?account=${encodeURIComponent(d.account.id)}`)} className="mt-1 rounded-sm text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus" data-testid="account-tasks-all">
              See all {tasks.length} in Work
            </button>
          ) : null}
        </PanelSection>
      ) : null}
    </PanelShell>
  );
}

// ── Opportunity ──────────────────────────────────────────────────────────────────────────────

export function OpportunityPanel({ id, label }: { id: string; label?: string }) {
  const today = useToday();
  const f = useDealsFeatures();
  const { open: openClaim, dialog: claimDialog } = useClaimDc();
  const hit = useCachedFind<{ opp: Opportunity; account: AccountDetail['account'] }>('deals', (data) => {
    const d = data as Partial<AccountDetail>;
    const opp = Array.isArray(d.opps) ? d.opps.find((o) => o.id === id) : undefined;
    return opp && d.account ? { opp, account: d.account } : null;
  });
  if (!hit) {
    return (
      <PanelShell from="Opportunity" title={label ?? 'Opportunity'} sub="Open its account to see the opp; it loads with the account.">
        <EmptyState size="inline" icon="opportunity" title="Not loaded here" body="Opportunities come with their account page." />
      </PanelShell>
    );
  }
  if (!f.ready) return <Loading />;
  const { opp: o, account } = hit;
  const passed = o.isOpen && o.closeDate ? daysUntil(o.closeDate, today) < 0 : false;
  const canClaim = f.dc && o.isOpen && (!o.dcAssigned || !!o.myDc);
  const claimTarget: ClaimTarget = { oppId: o.id, oppName: o.name, myDc: o.myDc };
  return (
    <PanelShell
      testId="panel-opportunity"
      from={`Opportunity · ${account.name}`}
      title={o.name}
      sub={o.nextStep ? `Next: ${o.nextStep}` : (o.products.join(', ') || undefined)}
      badge={passed ? <StatusBadge tone="danger" icon="error">Close date passed</StatusBadge> : f.dc && o.isOpen && o.isMine && !o.dcAssigned ? <StatusBadge tone="warning" icon="warning">No DC</StatusBadge> : null}
      footer={
        <>
          {o.org62Url ? (
            <Button variant="primary" size="md" icon="new_window" onClick={() => open(o.org62Url!)}>
              Open in Org62
            </Button>
          ) : null}
          <Button variant={o.org62Url ? 'quiet' : 'primary'} size="md" onClick={() => navigate(`/deals/${account.id}`)}>
            Open account
          </Button>
          {canClaim ? (
            <Button variant="quiet" size="md" onClick={() => openClaim(claimTarget)} data-testid="panel-claim-dc">
              {o.myDc ? 'Change my DC' : 'Claim DC'}
            </Button>
          ) : null}
        </>
      }
    >
      <Facts
        rows={[
          ['Stage', o.stage],
          ['Amount', fmtAmount(o.amount)],
          ['Close', `${fmtDate(o.closeDate)}${o.isOpen ? '' : ' · closed'}`],
          // holding a DC and being on the team are two facts: the DC says split and role
          ...(f.dc ? ([['My DC', myDcWords(o.myDc)?.replace(/^Your DC: /, '') ?? (o.dcAssigned ? 'Assigned (the next Org62 scan reads its split)' : 'No DC yet')], ['Opp team', o.isMine ? 'You are on it' : 'Not on it']] as Array<[string, string]>) : []),
          ...(f.vdp ? ([['VDP', o.vdpLinked ? 'Linked' : 'Not linked']] as Array<[string, string]>) : []),
          ['Hours this quarter', fmtHours(o.hoursQtd)],
          ['Owner', o.owner?.name ?? 'Not recorded'],
        ]}
      />
      <p className="text-caption text-muted">Read only. Command Center never writes to Org62: a DC request goes in your next batch.</p>
      {claimDialog}
    </PanelShell>
  );
}

// ── Missed opp ───────────────────────────────────────────────────────────────────────────────

function patchMissed(cache: OptimisticCache, id: string, patch: Partial<MissedOpp>) {
  cache.setQuery<MissedPayload>(queryKey('getMissed'), (old) => (old ? { ...old, missed: old.missed.map((m) => (m.id === id ? { ...m, ...patch } : m)) } : old));
}

export function MissedPanel({ id }: { id: string }) {
  const today = useToday();
  const panel = useRightPanel();
  const q = useApi('getMissed');
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [claimFor, setClaimFor] = useState<ClaimTarget | null>(null);
  const claim = useOptimisticMutation({
    route: 'claimMissed',
    topics: ['deals', 'today', 'work', 'time'],
    rebase: false,
    optimistic: (input, cache) => patchMissed(cache, input.params.id, { status: 'claimed' }),
    onSuccess: (res, input) => claimedToast(res.entity, res.auditId ?? null, input.body?.split ?? 100),
    onError: (err) => toast({ title: "Couldn't claim", body: `${err.message}. It is back as it was.`, tone: 'error', durationMs: null, key: `claim-err:${id}` }),
  });
  const dismiss = useOptimisticMutation({
    route: 'dismissMissed',
    topics: ['deals', 'today'],
    rebase: false,
    optimistic: (input, cache) => patchMissed(cache, input.params.id, { status: 'dismissed', dismissReason: input.body?.reason ?? null }),
    toast: (res) => ({ title: `Dismissed ${res.entity.oppName}`, body: res.entity.dismissReason ?? undefined, key: `dismiss:${res.entity.id}` }),
    onError: (err) => toast({ title: "Couldn't dismiss", body: `${err.message}. It is back as it was.`, tone: 'error', durationMs: null, key: `dismiss-err:${id}` }),
  });
  if (q.isError && !q.data) return <PanelError title="Couldn't load the missed-opp sweep" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Loading />;
  const m = q.data.missed.find((x) => x.id === id);
  if (!m) return <EmptyState size="panel" icon="search" title="This missed opp is gone" body="The next sweep may have resolved it." />;
  const notes = missedNotes(m, today);
  const isNew = m.status === 'new';
  return (
    <PanelShell
      testId="panel-missed"
      from={`Missed opportunity · ${m.verdict === 'claim' ? 'Claim: clearly yours' : 'Check first: ambiguous'}`}
      title={m.oppName}
      sub={`${m.accountName} · ${stageShort(m.stage)} · ${fmtAmount(m.amount)} · closes ${fmtDate(m.closeDate)}`}
      badge={
        m.status === 'claimed' ? (
          <StatusBadge tone="success" icon="check">
            Claimed
          </StatusBadge>
        ) : m.status === 'dismissed' ? (
          <StatusBadge tone="neutral">Dismissed</StatusBadge>
        ) : notes.lock ? (
          <StatusBadge tone="danger" icon="lock">
            Locked
          </StatusBadge>
        ) : null
      }
      footer={
        isNew ? (
          <>
            <Button variant="primary" size="md" kbd="a" onClick={() => setClaimFor(claimTargetOf(m))} data-testid="panel-claim">
              Claim…
            </Button>
            <Popover
              open={dismissOpen}
              onOpenChange={setDismissOpen}
              placement="top-start"
              width={360}
              label="Dismiss with a reason"
              trigger={
                <Button variant="quiet" size="md">
                  Dismiss…
                </Button>
              }
            >
              {({ close }) => (
                <div className="flex flex-col gap-3 p-4">
                  <p className="text-body font-bold text-fg-heading">Why isn&apos;t this yours?</p>
                  <div role="radiogroup" aria-label="Reason" className="flex flex-wrap gap-1.5">
                    {DISMISS_REASONS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        role="radio"
                        aria-checked={reason === r}
                        onClick={() => setReason(r)}
                        className={reason === r ? 'h-8 rounded-md border border-accent bg-selected px-2.5 text-caption font-bold text-fg-heading' : 'h-8 rounded-md border border-line-strong bg-surface px-2.5 text-caption text-fg hover:bg-surface-muted'}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="quiet" onClick={close}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!reason}
                      onClick={() => {
                        close();
                        if (reason) dismiss.mutate({ params: { id: m.id }, body: { reason } });
                      }}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}
            </Popover>
            <span className="ml-auto text-caption text-muted">Nothing is sent.</span>
          </>
        ) : m.status === 'claimed' && m.dcRequestId ? (
          <Button variant="primary" size="md" onClick={() => navigate('/deals/dcs')}>
            Open the DC list
          </Button>
        ) : m.status === 'claimed' && m.claimedWorkItemId ? (
          <Button variant="primary" size="md" onClick={() => panel.openDetails({ kind: 'work_item', id: m.claimedWorkItemId!, label: `DC task: ${m.oppName}` })}>
            Open the DC task
          </Button>
        ) : null
      }
    >
      <NotesBlock notes={notes} />
      <PanelSection title="Why it looks like yours">
        <div className="flex flex-wrap gap-1.5">
          {m.evidence.map((e) => (
            <span key={e} title={e} className="inline-flex max-w-full min-w-0">
              <SourceChip source={evidenceChip(e).source} label={e} />
            </span>
          ))}
        </div>
      </PanelSection>
      <Facts
        rows={[
          ['Other DCs', m.otherDcs.length ? m.otherDcs.join(', ') : 'None'],
          ['Found', fmtDate(m.foundAt)],
          ...(m.dismissReason ? ([['Dismissed', m.dismissReason]] as Array<[string, string]>) : []),
        ]}
      />
      {m.status === 'claimed' && m.claimedWorkItemId ? <PromptDraft m={m} /> : null}
      <ClaimDcDialog target={claimFor} onClose={() => setClaimFor(null)} onSubmit={(v) => claim.mutate({ params: { id: m.id }, body: v })} />
    </PanelShell>
  );
}

/** The Claim form's target for a missed opp: the sweep's evidence as the comment to edit. */
export function claimTargetOf(m: MissedOpp): ClaimTarget {
  return { oppId: null, oppName: m.oppName, myDc: null, comment: claimComment(m.evidence) };
}

/** After a Claim: the DC request toast (DC list link, Undo), or the fallback task's when the app didn't know the opp. */
export function claimedToast(m: MissedOpp, auditId: string | null, split: number): void {
  if (m.dcRequestId) dcRequestToast({ kind: 'add', fromSplit: null, splitPercent: split, oppName: m.oppName }, auditId, `claim:${m.id}`);
  else toast({ key: `claim:${m.id}`, tone: 'success', title: `Claimed ${m.oppName}`, body: "The app doesn't track this opp yet, so it's a task to add the DC, with the Slackbot prompt draft. Nothing was sent.", undo: auditId ? { auditId } : undefined });
}
