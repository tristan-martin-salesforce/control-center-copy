'use client';
/**
 * Details renderer for one VDP (kind `vdp`, id = its slug) or one engaged account with no VDP yet (`account:<id>`),
 * opened from Time ▸ VDP. Opening it makes it the Assistant's "Looking at", so "what use cases does it have?", "what's
 * missing?" or "go back and find everything" are about this VDP.
 *
 *   What's open    the VDP's open items, in order: exactly the ones its Time ▸ VDP tree lists (one source, D-59), each
 *                  saying who applies it; one under a company or VDP that does not exist yet goes with them ("Apply · N
 *                  first", the same push as the tree); one VDP's MCP can't take yet says so (D-63: no handoffs, no
 *                  Copy). Nothing open: Done.
 *   Assets to add  the candidates the matcher and Find assets found, each with where it was shared and why: confirm the
 *                  unsure ones, then Apply (add_vdp_asset; Edit first to change its title, Type or Deliverable, VDP's
 *                  own choices), or Dismiss
 *   In VDP         everything the mirror read: header, owners, use cases (fields, AI fields), assets, stakeholders
 *
 * GET /deals/vdp/detail · POST /deals/vdp/candidates/:id · POST /deals/vdp/find-assets · nothing here writes to VDP.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import type { VdpAssetCandidate, VdpDetailPayload, VdpDetailUseCase } from '@/contract';
import { api, queryKey, type ApiError } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useLiveFollow } from '@/client/live';
import { toast } from '@/client/toast';
import { Facts, PanelSection, PanelShell } from '@/components/deals/panel-shell';
import { useDetails } from '@/components/deals/context-frame';
import { StatusBadge } from '@/components/domain';
import { ActionRow } from '@/components/kit';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { useRightPanel } from '@/components/shell/panel';
import { Button, cn, Dialog, EmptyState, Icon, PanelError, Skeleton, useNow, useTimeZone } from '@/ui';
import { adminTitle, draftsById, editableFields, fiscalLabel } from './vdp-derive';
import { candidateGroups, KIND_LABEL, panelSentence, personList, runLine } from './vdp-panel-derive';
import { ApplyForm, DisabledReason, useStageItem, useVdpLiveSync, VdpItemRow, VdpStatusChip } from './VdpItem';
import { errorText } from '@/lib/error-text';

const openUrl = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

function Loading() {
  return (
    <div className="space-y-3 px-6 py-5">
      <Skeleton variant="line" count={2} />
      <Skeleton variant="row" count={5} />
    </div>
  );
}

export function VdpPanel({ id, label }: { id: string; label?: string }) {
  const tz = useTimeZone();
  const panel = useRightPanel();
  const details = useDetails();
  const qc = useQueryClient();
  // Push, not a poll: while a backfill runs, the panel follows the worker's job events.
  const q = useApi('getVdpDetail', { query: { key: id } });
  const backfilling = !!q.data?.backfill.last && ['queued', 'running'].includes(q.data.backfill.last.status);
  useLiveFollow(queryKey('getVdpDetail', { query: { key: id } }), ['jobs'], backfilling);
  const outbox = useApi('getOutbox');
  const now = useNow();
  useVdpLiveSync();
  const byId = useMemo(() => draftsById(outbox.data?.admin.items ?? []), [outbox.data]);
  const openDraft = (id: string) => {
    const d = byId.get(id);
    details.open({ kind: 'draft', id, label: d ? adminTitle(d) : 'VDP change' });
  };
  const [pushKey, setPushKey] = useState<string | null>(null);
  const push = useMutation({
    mutationFn: (key: string) => api('pushVdpChanges', { body: { items: [{ itemKey: key, useSuggestion: true }] } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['deals'] });
      void qc.invalidateQueries({ queryKey: ['outbox'] });
      setPushKey(null);
      const bad = r.results.filter((x) => x.state === 'failed' || x.state === 'skipped');
      toast({ key: `vdp-push-${id}`, tone: bad.length ? 'error' : 'success', title: r.dryRun ? 'Dry run: recorded, nothing sent' : bad.length ? `${bad.length} not pushed` : 'On its way to VDP, in order', body: bad[0]?.error ?? undefined });
    },
    onError: (e: ApiError) => toast({ key: `vdp-push-${id}`, tone: 'error', title: "Couldn't push it", body: errorText(e, 200) }),
  });
  const find = useMutation({
    mutationFn: () => api('findVdpAssets', { body: { key: id } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['deals'] });
      const e = r.entity;
      toast(
        e.started
          ? {
              key: `vdp-find-${id}`,
              tone: 'success',
              title: 'Looking for assets',
              body: `Drive, Slack, Gmail and Calendar, up to $${e.estimateUsd.toFixed(2)}. The finds show under Assets to add.`,
            }
          : {
              key: `vdp-find-${id}`,
              tone: 'error',
              title: "Couldn't start Find assets",
              body: e.note ?? e.skipped[0]?.why ?? 'Nothing to run',
            },
      );
    },
    onError: (e: ApiError) =>
      toast({
        key: `vdp-find-${id}`,
        tone: 'error',
        title: "Couldn't start Find assets",
        body: errorText(e, 200),
      }),
  });

  if (q.isError && !q.data) return <PanelError title="Couldn't load this VDP" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  // D-63: an item under a company or VDP that does not exist yet goes with them, in order (the tree's same push)
  const pushWith = (key: string) => setPushKey(key);
  const pushStep = pushKey ? d.steps.find((s) => s.apply?.key === pushKey) : undefined;
  const pushChain = pushStep ? [...pushStep.requires.map((k) => d.steps.find((s) => s.apply?.key === k)).filter((s): s is NonNullable<typeof s> => !!s && s.state !== 'waiting'), pushStep] : [];
  const groups = candidateGroups(d.candidates);
  const running = !!d.backfill.last && (d.backfill.last.status === 'queued' || d.backfill.last.status === 'running');
  const fiscal = d.vdp ? fiscalLabel(d.vdp) : null;
  // D-60: a ref to one item (`<key>#<item id>`) puts that item first; the Assistant gets the same ref
  const focus = d.focus ? (d.steps.find((s) => s.id === d.focus) ?? null) : null;
  const ask = () =>
    panel.openAssistant({
      kind: 'vdp',
      id: focus ? id : d.key,
      label: label ?? d.companyName,
    });
  const findButton = (variant: 'primary' | 'secondary' | 'quiet') => (
    <Button
      size={variant === 'primary' ? 'md' : 'sm'}
      variant={variant}
      icon="search"
      loading={find.isPending}
      disabled={running || !d.backfill.available}
      onClick={() => find.mutate()}
      data-testid="vdp-find-assets"
      title={`Looks back through Drive, Slack, Gmail and Calendar. Up to $${d.backfill.perRunUsd.toFixed(2)} (research budget per run).`}
    >
      {running ? 'Looking…' : `Find assets · up to $${d.backfill.perRunUsd.toFixed(2)}`}
    </Button>
  );

  return (
    <PanelShell
      testId="panel-vdp"
      from={d.vdp ? `VDP${fiscal ? ` · ${fiscal}` : ''}${d.opportunity ? ` · ${d.opportunity.name}` : ''}` : 'Not in VDP yet'}
      title={d.companyName}
      sub={panelSentence(d, groups, now.getTime(), tz)}
      badge={
        <span className="flex flex-wrap items-center gap-2">
          {!d.vdp ? (
            <StatusBadge tone="warning" icon="warning">
              No VDP
            </StatusBadge>
          ) : (
            <VdpStatusChip status={d.status} nowMs={now.getTime()} tz={tz} />
          )}
          {running ? (
            <StatusBadge tone="ai" icon="sparkle">
              Finding assets
            </StatusBadge>
          ) : null}
        </span>
      }
      footer={
        <>
          {groups.open.length || running ? null : findButton('primary')}
          <Button variant={groups.open.length || running ? 'primary' : 'quiet'} size="md" icon="chat" onClick={ask} data-testid="vdp-ask">
            Ask the Assistant
          </Button>
          {d.vdp?.url ? (
            <Button variant="quiet" size="md" icon="new_window" onClick={() => openUrl(d.vdp!.url!)}>
              Open in VDP
            </Button>
          ) : null}
          <span className="ml-auto text-caption text-muted">Nothing reaches VDP before your Apply.</span>
          <Dialog
            open={!!pushStep}
            onClose={() => setPushKey(null)}
            title={`Push ${pushChain.length} ${pushChain.length === 1 ? 'change' : 'changes'} to VDP?`}
            description="In this order: each new id goes to the item under it. If one fails, what needs it is not pushed. Dry run records them only."
            confirmLabel={`Push ${pushChain.length}`}
            onConfirm={() => {
              if (pushKey) push.mutate(pushKey);
            }}
            busy={push.isPending}
          >
            <ol className="list-decimal space-y-1 pl-5 text-body" data-testid="vdp-push-order">
              {pushChain.map((s) => (
                <li key={s.id}>{s.title}</li>
              ))}
            </ol>
          </Dialog>
        </>
      }
    >
      {focus ? (
        <PanelSection title="This change">
          <div className="min-w-0 rounded-md border border-line-strong p-1" data-testid="vdp-focus">
            <div role="grid" aria-label="This change">
              <VdpItemRow step={focus} onDraft={openDraft} onPush={pushWith} tz={tz} emphasis />
            </div>
            {focus.gaps.some((g) => g.why) ? <p className="mt-2 px-3 text-caption text-muted">{[...new Set(focus.gaps.map((g) => g.why).filter(Boolean))].join(' · ')}</p> : null}
            <p className="mt-2 mb-2 px-3 text-caption text-muted">{focus.policy === 'auto' ? (d.autopilot.on ? 'VDP autopilot applies it by itself: every value it sends is a known fact.' : 'VDP autopilot could apply it by itself (it is off: Settings ▸ Sending).') : focus.disabled ? focus.disabled : 'A person decides this one: approve the suggestion, or change it first.'}</p>
          </div>
        </PanelSection>
      ) : null}
      <PanelSection title={d.steps.length ? `What's open · ${d.steps.length}` : "What's open"}>
        {d.steps.length ? (
          <div role="grid" aria-label="What's open" className="-mx-3 min-w-0" data-testid="vdp-steps">
            {d.steps.map((s, i) => (
              <VdpItemRow
                key={s.id}
                step={s}
                n={i + 1}
                onDraft={openDraft}
                onPush={pushWith}
                extra={
                  s.kind === 'assets' ? (
                    <a href="#vdp-assets" className="text-caption font-bold text-link hover:underline">
                      {running ? 'See them below (still looking)' : 'See them below'}
                    </a>
                  ) : s.kind === 'add_assets_manually' && !running && d.backfill.last?.status !== 'done' ? (
                    findButton('quiet')
                  ) : null
                }
              />
            ))}
          </div>
        ) : d.vdp && d.status.state === 'past' ? (
          <p className="text-body text-muted">An old fiscal period on closed opportunities: the app doesn&apos;t check it.</p>
        ) : (
          <p className="flex items-center gap-2 text-body text-fg" data-testid="vdp-done">
            <Icon name="check" className="text-success-700" /> Done: VDP has everything the app checks.
          </p>
        )}
      </PanelSection>

      <section className="min-w-0" id="vdp-assets" data-testid="vdp-assets-to-add">
        <div className="mb-2 flex min-w-0 items-baseline gap-2">
          <h3 className="text-body-lg font-bold text-fg-heading">Assets to add</h3>
          <span className="text-caption text-muted">{runLine(d.backfill, tz)}</span>
          {groups.open.length ? <span className="ml-auto">{findButton('quiet')}</span> : null}
        </div>
        {groups.open.length ? (
          <div role="grid" aria-label="Assets to add" className="rounded-md border border-line px-1">
            {groups.open.map((c) => (
              <CandidateRow key={c.id} c={c} company={d.companyName} hasVdp={!!d.vdp} onDraft={openDraft} />
            ))}
          </div>
        ) : (
          <EmptyState
            size="inline"
            icon="search"
            title={running ? 'Looking through Drive, Slack, Gmail and Calendar…' : 'No assets waiting'}
            body={
              running
                ? 'Each find shows here with where it was shared.'
                : 'New decks, docs and recordings about this account show up here as the scans see them. Find assets looks back through its history.'
            }
          />
        )}
        {groups.closed.length ? <ClosedCandidates list={groups.closed} /> : null}
      </section>

      {d.vdp ? <InVdp d={d} tz={tz} /> : null}
      {d.lastReadAt ? <p className="text-caption text-muted">VDP read {`${dayLabel(d.lastReadAt, tz)} ${clock(d.lastReadAt, tz)}`}.</p> : null}
    </PanelShell>
  );
}

// ── Assets to add ─────────────────────────────────────────────────────────────────────────

function useSetCandidate(c: VdpAssetCandidate) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: 'suggested' | 'added' | 'dismissed') => api('setVdpCandidate', { params: { id: c.id }, body: { status } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['deals'] });
      const s = r.entity.status;
      toast({
        key: `vdp-cand-${c.id}`,
        tone: 'success',
        title: s === 'added' ? 'Marked added: the next VDP read confirms it' : s === 'dismissed' ? 'Dismissed: it won’t be suggested again' : 'Kept as an asset to add',
      });
    },
    onError: (e: ApiError) =>
      toast({
        key: `vdp-cand-${c.id}`,
        tone: 'error',
        title: "Couldn't update the asset",
        body: errorText(e, 200),
      }),
  });
}

/** One asset the app found for this VDP, an ActionRow: its title and kind, why, where it was seen; its one next step. */
function CandidateRow({ c, company, hasVdp, onDraft }: { c: VdpAssetCandidate; company: string; hasVdp: boolean; onDraft: (id: string) => void }) {
  const set = useSetCandidate(c);
  // Edit: the Apply's inputs first (Title, the Type and Deliverable as VDP's own choices, Description)
  const [editing, setEditing] = useState(false);
  const stage = useStageItem((d) => {
    setEditing(false);
    onDraft(d.id);
  });
  const src = c.sources[0];
  const seen = src ? [src.label, src.at ? src.at.slice(0, 10) : null, c.sources.length > 1 ? `+${c.sources.length - 1} more` : null].filter(Boolean).join(' · ') : null;
  const dismiss = (
    <Button size="sm" variant="quiet" loading={set.isPending && set.variables === 'dismissed'} onClick={() => set.mutate('dismissed')}>
      Dismiss
    </Button>
  );
  const trailing =
    c.status === 'unsure' ? (
      <>
        <Button size="sm" variant="secondary" loading={set.isPending && set.variables === 'suggested'} onClick={() => set.mutate('suggested')} data-testid="vdp-candidate-confirm">
          It&apos;s for {company}
        </Button>
        <Button size="sm" variant="quiet" loading={set.isPending && set.variables === 'dismissed'} onClick={() => set.mutate('dismissed')}>
          Not for this VDP
        </Button>
      </>
    ) : c.status === 'added' ? (
      <Button size="sm" variant="quiet" loading={set.isPending} onClick={() => set.mutate('suggested')} title="The next VDP read confirms it and closes it">
        Not added yet
      </Button>
    ) : c.draftId ? (
      <Button size="sm" variant="secondary" onClick={() => onDraft(c.draftId!)} data-testid="vdp-candidate-review">
        Review & apply
      </Button>
    ) : c.apply && editing ? null : c.apply ? (
      <>
        <Button size="sm" variant="secondary" loading={stage.isPending} onClick={() => stage.mutate({ key: c.apply!.key, values: {} })} title="The app can do this: it adds it to the VDP's Assets tab" data-testid="vdp-candidate-apply">
          Apply
        </Button>
        {editableFields(c.apply).length ? (
          <Button size="sm" variant="quiet" onClick={() => setEditing(true)} data-testid="vdp-candidate-edit">
            Edit
          </Button>
        ) : null}
        {dismiss}
      </>
    ) : (
      dismiss
    );
  return (
    <ActionRow
      id={c.id}
      data-candidate={c.status}
      data-testid="vdp-candidate"
      title={c.title}
      titleNode={
        <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>
          {c.title}
        </a>
      }
      meta={<span>{KIND_LABEL[c.kind]}</span>}
      dashed={c.status === 'unsure' || c.origin === 'backfill'}
      edge={c.status === 'unsure' ? 'warning' : c.origin === 'backfill' ? 'ai' : 'none'}
      badge={
        c.status === 'unsure' ? (
          <StatusBadge tone="warning" icon="question">
            Confirm
          </StatusBadge>
        ) : c.status === 'added' ? (
          <StatusBadge tone="neutral" icon="clock">
            Marked added
          </StatusBadge>
        ) : c.origin === 'backfill' ? (
          <StatusBadge tone="ai" icon="sparkle">
            Found by research
          </StatusBadge>
        ) : null
      }
      source={src?.url ? { label: src.label, url: src.url } : null}
      why={[c.why, src?.url ? null : seen, c.status === 'added' ? 'The next VDP read confirms it and closes it' : null].filter(Boolean).join(' · ')}
      whyTitle={[c.why, seen].filter(Boolean).join(' · ')}
      trailing={<span className="flex flex-wrap items-center justify-end gap-2">{trailing}</span>}
      extra={
        !c.draftId && c.status !== 'unsure' && c.status !== 'added' && !c.apply ? (
          <DisabledReason text={hasVdp ? 'Not an http(s) link: VDP takes http(s) links only' : 'It goes on the VDP once that is created (Activity ▸ VDP)'} />
        ) : c.apply && editing && !c.draftId && c.status === 'suggested' ? (
          <ApplyForm apply={c.apply} pending={stage.isPending} onStage={(values) => stage.mutate({ key: c.apply!.key, values })} onCancel={() => setEditing(false)} />
        ) : undefined
      }
    />
  );
}

function ClosedCandidates({ list }: { list: VdpAssetCandidate[] }) {
  const [open, setOpen] = useState(false);
  const inVdp = list.filter((c) => c.status === 'in_vdp').length;
  const dismissed = list.length - inVdp;
  return (
    <div className="mt-2">
      <button type="button" className="text-caption font-bold text-link hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {[inVdp ? `${inVdp} now in VDP` : null, dismissed ? `${dismissed} dismissed` : null].filter(Boolean).join(' · ')}
      </button>
      {open ? (
        <div role="grid" aria-label="Closed assets" className="mt-2">
          {list.map((c) => (
            <ClosedRow key={c.id} c={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** An asset that is done: in VDP, or dismissed (Put back). */
function ClosedRow({ c }: { c: VdpAssetCandidate }) {
  const set = useSetCandidate(c);
  return (
    <ActionRow
      id={c.id}
      title={c.title}
      done={c.status === 'dismissed'}
      source={{ label: 'Open', url: c.url }}
      why={c.status === 'in_vdp' ? 'In VDP' : 'Dismissed'}
      verb={c.status === 'dismissed' ? { label: 'Put back', onClick: () => set.mutate('suggested'), loading: set.isPending } : null}
    />
  );
}

// ── In VDP ────────────────────────────────────────────────────────────────────────────────

function InVdp({ d, tz }: { d: VdpDetailPayload; tz: string | undefined }) {
  const v = d.vdp!;
  return (
    <>
      <PanelSection title="In VDP">
        <Facts
          rows={[
            ['Company', `${v.companyName}${v.industry ? ` · ${v.industry}` : ''}`],
            ['Fiscal period', fiscalLabel(v) ?? 'Not set'],
            [v.salesforceOpportunityIds.length > 1 ? 'Opportunities' : 'Opportunity', v.salesforceOpportunityIds.length ? v.salesforceOpportunityIds.join(', ') + (d.opportunity ? ` · ${d.opportunity.name}${v.salesforceOpportunityIds.length > 1 ? ' and more' : ''}` : '') : d.opportunity ? d.opportunity.name : 'Not linked'],
            ['Account', d.account?.name ?? (v.salesforceAccountId ? v.salesforceAccountId : 'Not linked')],
            ['AE', personList(v.aes) ?? 'None'],
            ['TA', personList(v.tas) ?? 'None'],
            ...(v.collaborators.length ? [['Collaborators', personList(v.collaborators)!] as [string, ReactNode]] : []),
            ...(v.lastActivityAt ? [['Last change', `${dayLabel(v.lastActivityAt, tz)} ${clock(v.lastActivityAt, tz)}`] as [string, ReactNode]] : []),
            ...(v.isSeed ? [['Seed', 'A seed VDP: writable because you are on it (it is never deleted)'] as [string, ReactNode]] : []),
          ]}
        />
        {v.executiveSummary ? <p className="mt-3 max-w-[68ch] text-body text-fg">{v.executiveSummary}</p> : null}
      </PanelSection>
      <PanelSection title={`Use cases · ${v.useCases.length}`}>
        {v.useCases.length ? (
          <ul className="space-y-3" data-testid="vdp-use-cases">
            {v.useCases.map((u) => (
              <UseCase key={u.id} u={u} />
            ))}
          </ul>
        ) : (
          <p className="text-body text-muted">No use case yet.</p>
        )}
      </PanelSection>
      <PanelSection title={`Assets · ${v.assets.length}`}>
        {v.assets.length ? (
          <ul className="space-y-1.5" data-testid="vdp-assets">
            {v.assets.map((a) => (
              <li key={a.id} className="min-w-0 text-body">
                <a href={a.url} target="_blank" rel="noreferrer" className="font-bold text-link hover:underline">
                  {a.title ?? a.url}
                </a>
                {a.type ? <span className="text-caption text-muted"> · {a.type}</span> : null}
                {a.description ? <p className="text-caption text-muted">{a.description}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-muted">No assets in VDP yet.</p>
        )}
      </PanelSection>
      {v.stakeholders.length ? (
        <PanelSection title={`Stakeholders · ${v.stakeholders.length}`}>
          <ul className="space-y-1 text-body">
            {v.stakeholders.map((s) => (
              <li key={`${s.name}${s.title ?? ''}`}>
                {s.name}
                <span className="text-caption text-muted">{[s.title, s.role].filter(Boolean).length ? ` · ${[s.title, s.role].filter(Boolean).join(' · ')}` : ''}</span>
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}
    </>
  );
}

function UseCase({ u }: { u: VdpDetailUseCase }) {
  const [more, setMore] = useState(false);
  const fields: Array<[string, string | null]> = [
    ['Priority', u.priority],
    ['Division', u.division],
    ['Persona', u.persona],
    ['Phase', u.executionPhase],
    ['Start', u.executionStartDate],
    ['Target', u.executionTargetDate],
    ['Duration', u.duration],
  ];
  return (
    <li className="min-w-0 rounded-md border border-line px-4 py-3" data-use-case={u.id}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="min-w-0 font-bold text-fg-heading">{u.title}</p>
        <span className="text-caption text-muted">{u.track === 'agentforce' ? 'Agentforce' : 'D360'}</span>
        {u.hasAi ? (
          <StatusBadge tone="ai" icon="sparkle">
            AI fields done
          </StatusBadge>
        ) : (
          <StatusBadge tone="warning" icon="warning">
            AI fields not generated
          </StatusBadge>
        )}
      </div>
      <p className="mt-1 text-caption text-muted">
        {fields
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ') || 'No fields set'}
      </p>
      {u.missing.length ? <p className="mt-1 text-caption font-bold text-warning-700">Missing: {u.missing.join(', ')}</p> : null}
      {u.details ? (
        <p className={cn('mt-1.5 max-w-[68ch] text-body text-fg', !more && 'line-clamp-3')}>
          {u.details}
          {u.details.length > 220 ? (
            <button type="button" className="ml-1 text-caption font-bold text-link hover:underline" onClick={() => setMore(!more)}>
              {more ? 'Less' : 'More'}
            </button>
          ) : null}
        </p>
      ) : !u.detailLoaded ? (
        <p className="mt-1 text-caption text-muted">Details not read yet (the next VDP read fetches them).</p>
      ) : null}
      {u.hasAi && u.aiFields.length ? <p className="mt-1 text-caption text-muted">AI fields: {u.aiFields.map((f) => f.replace(/_/g, ' ')).join(', ')}</p> : null}
    </li>
  );
}
