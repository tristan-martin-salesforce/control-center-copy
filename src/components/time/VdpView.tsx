'use client';
/**
 * VDP (the second main tab on Time: ?view=vdp, D-52, D-59, D-60). Two sub-tabs:
 *
 *   Changes   (?view=vdp) what goes to VDP and pushing it up, as a tree (D-63): Company → VDP → items, each item with its
 *             one verb, checkboxes and "Push N to VDP" (in order, new ids passed down); the suggestions to approve; what
 *             autopilot applied. No Copy and no handoffs: what VDP's MCP can't take yet shows disabled, with why
 *   My VDPs   (?view=vdp&sub=mine) the summary: who is on each VDP, its use cases and assets, "N missing" / "N to check"
 *
 *   head      one sentence ("3 VDPs need you · 2 waiting · 9 done"), autopilot's line ("Autopilot: on · 12 applied today ·
 *             paused: re-auth VDP", or off with a link to the setting), the VDP read and its re-auth when it lapsed
 *
 * Every row opens its details in the docked panel, and "Ask the Assistant" opens the Assistant on it. Color marks state
 * only (act, done, waiting, AI for suggestions). GET /deals/vdp · GET /outbox · POST /deals/vdp/updates (stage) ·
 * POST /deals/vdp/push (your push) · nothing reaches VDP before your Apply or push, or autopilot's own policy.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { VdpCoveragePayload } from '@/contract';
import { api, queryKey, type ApiError } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useLiveFollow } from '@/client/live';
import { toast } from '@/client/toast';
import { ContextPage } from '@/components/deals/context-frame';
import { ActivityHead } from './ActivityHead';
import { StatusBadge } from '@/components/domain';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { useConnectorActions } from '@/components/health/actions';
import { BROKEN_STATES } from '@/components/health/derive';
import { Button, EmptyState, PanelBoundary, PanelError, Skeleton, useNow, useTimeZone } from '@/ui';
import { AppLink } from '@/components/shell/AppLink';
import { findAllPlan, nextReadText, vdpReauthLabel, vdpSentence } from './vdp-derive';
import { useVdpLiveSync } from './VdpItem';
import { VdpChanges } from './VdpChanges';
import { VdpMine } from './VdpMine';
import type { VdpSub } from './views';
import { errorText } from '@/lib/error-text';

export function VdpView({ tabs, sub = 'changes' }: { tabs: ReactNode; sub?: VdpSub }) {
  // D-63: while a push runs (the worker has it), follow it; the live events refresh it as each item lands too
  // Push, not a poll: while a push runs, the coverage also follows the worker's job events (each item's draft lands
  // on the deals topic already).
  const cov = useApi('getVdpCoverage');
  const p = cov.data?.push;
  // the server settles a push against its job (a dead job's push reads as stopped), so follow it for as long as it runs
  useLiveFollow(queryKey('getVdpCoverage'), ['jobs'], !!p && (p.state === 'queued' || p.state === 'running'));
  const health = useApi('getHealth');
  const now = useNow();
  const tz = useTimeZone();
  useVdpLiveSync();
  const vdpConn = health.data?.connectors.find((c) => c.source === 'vdp') ?? null;
  const actions = useConnectorActions();
  const broken = !!vdpConn && BROKEN_STATES.has(vdpConn.state);
  const next = cov.data ? nextReadText(cov.data.nextReadAt, now.getTime(), tz) : null;
  const ap = cov.data?.autopilot;

  const head = (
    <ActivityHead
      tabs={tabs}
      sentence={vdpSentence(cov.data)}
      actions={
        <div className="flex flex-wrap items-center gap-3 text-caption text-muted">
          {ap ? <AutopilotLine ap={ap} /> : null}
          {cov.data?.lastReadAt ? <span className="tabular-nums">{`Read ${dayLabel(cov.data.lastReadAt, tz)} ${clock(cov.data.lastReadAt, tz)}${next ? ` · ${next}` : ''}`}</span> : null}
          {vdpConn && broken ? (
            <Button size="sm" variant="primary" loading={actions.reauth.isPending} onClick={() => actions.reauth.mutate(vdpConn)} data-testid="vdp-reauth">
              {vdpReauthLabel()}
            </Button>
          ) : vdpConn ? (
            <Button size="sm" variant="quiet" loading={actions.scan.isPending} onClick={() => actions.scan.mutate(vdpConn)}>
              Read VDP now
            </Button>
          ) : null}
        </div>
      }
    />
  );

  return (
    <ContextPage label="Activity" className="cc-scroll overflow-y-auto [scrollbar-gutter:stable]">
      {head}
      <div className="flex shrink-0 flex-col gap-5" data-testid="vdp-view" data-sub={sub}>
        {broken || ap?.paused === 'reauth' ? (
          <p className="rounded-md border border-line bg-surface px-4 py-3 text-body" role="status" data-testid="vdp-paused-reauth">
            <StatusBadge tone="danger" icon="warning">
              {ap?.on ? 'VDP autopilot is paused: re-auth VDP' : 'VDP needs re-auth'}
            </StatusBadge>{' '}
            <span className="text-muted">{`Showing the last read. ${vdpReauthLabel()} signs you in again (a browser opens if Okta asks for MFA); what is staged, and what autopilot would apply, waits meanwhile.`}</span>
          </p>
        ) : null}
        <PanelBoundary name="time-vdp">
          {cov.isError && !cov.data ? (
            <PanelError title="Couldn't load your VDPs" error={cov.error} onRetry={() => void cov.refetch()} />
          ) : !cov.data ? (
            <Skeleton variant="block" className="h-96 w-full" />
          ) : !cov.data.lastReadAt ? (
            <EmptyState icon="opportunity" title="VDP has not been read yet" body={`Your VDPs and what goes to each show here after the first VDP read${next ? ` (${next})` : ' once VDP is connected (Settings ▸ Sources)'}.`} />
          ) : sub === 'mine' ? (
            <VdpMine cov={cov.data} />
          ) : (
            <VdpChanges cov={cov.data} findAll={cov.data.assets.targets ? <FindAll assets={cov.data.assets} /> : null} />
          )}
        </PanelBoundary>
      </div>
    </ContextPage>
  );
}

/** "Autopilot: on · 12 applied today · paused: re-auth VDP", or "Autopilot: off · Turn on" (Settings ▸ Sending). */
function AutopilotLine({ ap }: { ap: VdpCoveragePayload['autopilot'] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2" data-testid="vdp-autopilot" data-on={ap.on ? 'true' : 'false'} data-paused={ap.paused ?? ''}>
      <StatusBadge tone={!ap.on ? 'neutral' : ap.paused ? 'warning' : 'success'} icon={ap.on ? (ap.paused ? 'pause' : 'check') : 'record_update'}>
        {ap.line}
      </StatusBadge>
      {!ap.on ? (
        <AppLink href="/settings?section=sending" className="font-bold text-link hover:underline">
          Turn on
        </AppLink>
      ) : null}
    </span>
  );
}

/**
 * "Find assets for all": every VDP and engaged account without one, the least recently searched first, planned at
 * what a run really costs. When today's assistant line can't cover them all, "Allow $N more today" raises it by
 * exactly the shortfall (today only, recorded with its reason) and runs them all.
 */
function FindAll({ assets }: { assets: VdpCoveragePayload['assets'] }) {
  const qc = useQueryClient();
  const p = findAllPlan(assets);
  const go = useMutation({
    mutationFn: (allowUsd: number | null) => api('findVdpAssets', { body: { all: true, ...(allowUsd ? { allowUsd } : {}) } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['deals'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
      const e = r.entity;
      toast(
        e.started
          ? { key: 'vdp-find-all', tone: 'success', title: `Looking for assets on ${e.queued.length} ${e.queued.length === 1 ? 'VDP' : 'VDPs'}`, body: `About $${e.estimateUsd.toFixed(2)} (at most $${e.ceilingUsd.toFixed(2)})${e.skipped.length ? ` · ${e.skipped.length} left out (${e.skipped[0]!.why})` : ''}. The finds show under each VDP's changes.` }
          : { key: 'vdp-find-all', tone: 'error', title: "Couldn't start Find assets", body: e.note ?? 'Nothing to run' },
      );
    },
    onError: (e: ApiError) => toast({ key: 'vdp-find-all', tone: 'error', title: "Couldn't start Find assets", body: errorText(e, 200) }),
  });
  if (assets.running) return <span className="tabular-nums">{`Finding assets · ${assets.running} running`}</span>;
  const each = `about $${assets.runUsd.toFixed(2)} each, at most $${assets.perRunUsd.toFixed(2)}`;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {p.fits > 0 ? (
        <Button
          size="sm"
          variant="quiet"
          icon="search"
          loading={go.isPending && go.variables == null}
          onClick={() => go.mutate(null)}
          title={`${p.fits} read-only research runs (Drive, Slack, Gmail, Calendar), the least recently searched first, ${each}; $${assets.dayLeftUsd.toFixed(2)} is left on the assistant's daily limit`}
          data-testid="vdp-find-all"
        >
          {p.shortUsd > 0 ? `Find assets for ${p.fits} of ${p.all} · about $${p.fitsUsd.toFixed(2)}` : `Find assets for all ${p.all} · about $${p.allUsd.toFixed(2)}`}
        </Button>
      ) : null}
      {p.shortUsd > 0 ? (
        <Button
          size="sm"
          variant="quiet"
          icon="add"
          loading={go.isPending && go.variables != null}
          onClick={() => go.mutate(p.shortUsd)}
          title={`Raises today's assistant limit by $${p.shortUsd.toFixed(2)} (today only, back to normal at midnight) and searches all ${p.all}, ${each}`}
          data-testid="vdp-find-all-allow"
        >
          {`Allow $${p.shortUsd.toFixed(2)} more today · find all ${p.all}`}
        </Button>
      ) : null}
    </span>
  );
}
