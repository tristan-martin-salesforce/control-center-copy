'use client';
/**
 * Time ▸ Forecast (?view=forecast; the Specialist AE's default Time view, persona feature `specialistForecast`).
 * The AE's weekly Org62 duty on one page, from the read-only mirror of their Specialist Forecasts:
 *
 *   head       one sentence (this quarter · notes due by the deadline · Deal Roles to set · opps with no record) and
 *              when the mirror was last read, with Sync now
 *   Waiting    forecast canvases staged and not applied: Review & apply opens the Outbox draft panel (D-52)
 *   With Slackbot  applied canvases until the sync sees their notes land: Open ↗ and the Slackbot prompt
 *   This week  the notes queue, biggest and furthest along first: Draft (✦ read-only research, $0.25 cap; a
 *              placeholder on mock) or write your own → edit → Approve → "Stage N notes" builds ONE canvas and opens
 *              its preview, where the one Apply is
 *   Deal Roles Deal Role None on a deal with ACV: Aware unless you pick another → Approve (same canvas)
 *   No record  opps with Data 360 or Flex work but no Specialist Forecast: a handoff to the opp's Forecast tab, then
 *              "I created it, check now" (the worker re-reads that opp, read-only; checking… → found / not yet),
 *              and what such a check found in the last hours
 *   All        the table: amount, stage, forecast, judgement, notes age, deal role; a row opens its details
 *
 * Color is state only (overdue, due, ready, AI, landed, didn't land). Nothing reaches Org62 before Apply, and then
 * only through Slackbot running the canvas.
 *
 * GET /time/forecast · PATCH /time/forecast/records/:id · POST /time/forecast/drafts · POST /time/forecast/stage ·
 * POST /time/forecast/sync · POST /time/forecast/missing/:id/check
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { toast } from '@/client/toast';
import type { ForecastCheck, ForecastPayload, ForecastRow, PersonaFeature } from '@/contract';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useLiveFollow } from '@/client/live';
import { ContextPage, Pane, SectionHead, useDetails } from '@/components/deals/context-frame';
import { ActivityHead } from './ActivityHead';
import { useDraftQueueSource } from '@/components/detail/lib/draft-queue';
import { StatusBadge } from '@/components/domain';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { featureActive, type ResolvedPersona } from '@/personas';
import { forecastCanvasPrompt } from '@/lib/canvas/prompt';
import { CopyPromptButton, OpenResult } from '@/components/domain/ResultLinks';
import { Button, cn, EmptyState, PanelBoundary, PanelError, Skeleton, useTimeZone } from '@/ui';
import { NoteEditor, NotesAgeBadge, OrgLink, RoleFix, stageLabel, UpdateBadge, usd, useForecastActions } from './ForecastParts';
import { checkButton, checkLine, checkOutcomes, stageButton } from './forecast-derive';

/** The Time tab entry (TimePage TIME_VIEWS). */
export const FORECAST_TAB = { value: 'forecast' as const, label: 'Forecast', feature: 'specialistForecast' as PersonaFeature };

/** An AE (the preset that turns Specialist Forecast on) lands on Forecast; everyone else on Week. */
export function defaultTimeView(p: ResolvedPersona | null): 'forecast' | 'week' {
  return p && p.id === 'ae' && featureActive(p, 'specialistForecast') ? 'forecast' : 'week';
}

const QUEUE_OWNER = 'time-forecast';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function forecastSentence(v: ForecastPayload | undefined): string {
  if (!v) return 'Loading your Specialist Forecasts…';
  if (!v.active) return 'Specialist Forecast is not active for your role.';
  const live = v.rows.filter((r) => !r.gone);
  const parts = [`${v.quarter.current} · ${plural(live.length, 'Specialist Forecast')}`];
  parts.push(v.counts.due ? `${plural(v.counts.due, 'note')} due ${v.due.label}${v.counts.overdue ? ` (${v.counts.overdue} overdue)` : ''}` : `notes current until ${v.due.label}`);
  if (v.counts.roles) parts.push(`${plural(v.counts.roles, 'Deal Role')} to set`);
  if (v.counts.missing) parts.push(`${plural(v.counts.missing, 'opp')} with no record`);
  if (v.counts.notLanded) parts.push(`${v.counts.notLanded} didn't land`);
  return parts.join(' · ');
}

export function ForecastView({ tabs }: { tabs: ReactNode }) {
  // Push, not a poll: while a sync, a drafting run or an Org62 check is under way, Forecast also follows the job events.
  const q = useApi('getForecast');
  const d = q.data;
  useLiveFollow(queryKey('getForecast'), ['jobs'], !!d && (d.sync.status === 'queued' || d.sync.status === 'running' || d.drafting.running.length > 0 || d.queue.missing.some((m) => m.check?.status === 'checking')));
  const v = q.data;
  const tz = useTimeZone();
  const a = useForecastActions();
  const canvasIds = useMemo(() => (v?.canvases ?? []).map((c) => c.draftId), [v]);
  useDraftQueueSource(QUEUE_OWNER, canvasIds);
  const syncing = v?.sync.status === 'queued' || v?.sync.status === 'running';
  // a check that finished since the last read says what it found (found, not yet, didn't finish)
  const checked = useRef<Map<string, ForecastCheck['status']> | null>(null);
  useEffect(() => {
    if (!v?.active) return;
    const r = checkOutcomes(checked.current, v, tz);
    checked.current = r.statuses;
    for (const t of r.toasts) toast(t);
  }, [v, tz]);

  const head = (
    <ActivityHead
      tabs={tabs}
      sentence={forecastSentence(v)}
      actions={
        v?.active ? (
          <div className="flex items-center gap-3 text-caption text-muted">
            {v.sync.lastAt ? <span className="tabular-nums" title={v.sync.note ?? undefined}>{`${v.mode === 'mock' ? 'Placeholders · ' : ''}Read ${dayLabel(v.sync.lastAt, tz)} ${clock(v.sync.lastAt, tz)}${v.sync.nextAt ? ` · again ${clock(v.sync.nextAt, tz)}` : ''}`}</span> : null}
            {v.sync.status === 'failed' || v.sync.status === 'partial' ? (
              <StatusBadge tone="danger" icon="warning" title={v.sync.note ?? undefined}>
                {v.sync.status === 'failed' ? 'Last read failed' : 'Last read partial'}
              </StatusBadge>
            ) : null}
            <Button size="sm" variant="quiet" icon="refresh" loading={a.sync.isPending || syncing} onClick={() => a.sync.mutate()} data-testid="forecast-sync">
              {syncing ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
        ) : null
      }
    />
  );

  return (
    <ContextPage label="Time" className="cc-scroll overflow-y-auto [scrollbar-gutter:stable]">
      {head}
      <div className="flex shrink-0 flex-col gap-5" data-testid="forecast-view">
        <PanelBoundary name="time-forecast">
          {q.isError && !v ? (
            <PanelError title="Couldn't load your Specialist Forecasts" error={q.error} onRetry={() => void q.refetch()} />
          ) : !v ? (
            <Skeleton variant="block" className="h-96 w-full" />
          ) : !v.active ? (
            <EmptyState icon="trending" title="Specialist Forecast is not active for your role" body="Activate it in Settings ▸ Role & rules to see your forecast notes, Deal Roles and missing records here." />
          ) : !v.rows.length && v.sync.status !== 'mock' && !v.sync.lastAt ? (
            <EmptyState
              icon="trending"
              title={syncing ? 'Reading your Specialist Forecasts…' : 'Not read from Org62 yet'}
              body="One read-only query a day mirrors your Specialist Forecasts for this and next quarter, with when each note last changed."
              action={
                <Button size="sm" variant="primary" loading={a.sync.isPending || syncing} onClick={() => a.sync.mutate()}>
                  Sync now
                </Button>
              }
            />
          ) : (
            <>
              {v.canvases.length ? <Waiting v={v} onOpen={a.openDraft} /> : null}
              {v.withSlackbot.length ? <WithSlackbot v={v} /> : null}
              <NotesQueue v={v} />
              {v.queue.roles.length ? <Roles v={v} /> : null}
              {v.queue.missing.length || v.found.length ? <Missing v={v} /> : null}
              <AllRecords v={v} />
            </>
          )}
        </PanelBoundary>
      </div>
    </ContextPage>
  );
}

// ── Waiting for Apply ─────────────────────────────────────────────────────────────────────

function Waiting({ v, onOpen }: { v: ForecastPayload; onOpen: (id: string, label?: string) => void }) {
  const failed = v.canvases.filter((c) => c.status === 'failed' || c.status === 'verify_failed').length;
  return (
    <Pane
      aria-label="Waiting for your Apply"
      data-testid="forecast-waiting"
      scroll={false}
      head={
        <SectionHead
          title="Waiting for your Apply"
          count={v.canvases.length}
          sub={failed ? `${failed} failed: Apply again shows a fresh preview` : 'a new private canvas for Slackbot; nothing reaches Org62 until you Apply it and tell Slackbot "Execute this canvas"'}
          action={
            <Button size="sm" variant="primary" onClick={() => onOpen(v.canvases[0]!.draftId, v.canvases[0]!.title)} data-testid="forecast-apply-first">
              {v.canvases.length === 1 ? 'Review & apply' : `Review & apply ${v.canvases.length}`}
            </Button>
          }
        />
      }
    >
      <ul className="divide-y divide-line">
        {v.canvases.map((c) => (
          <li key={c.draftId} className="flex min-w-0 items-center gap-3 px-5 py-2.5" data-canvas-id={c.draftId}>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold text-fg-heading">{`Slack canvas · ${c.title}`}</p>
              <p className="truncate text-caption text-muted">{[c.notes ? plural(c.notes, 'forecast note') : null, c.roles ? plural(c.roles, 'Deal Role') : null].filter(Boolean).join(' · ')} · updates to the Specialist Forecast</p>
            </div>
            {c.status === 'failed' || c.status === 'verify_failed' ? (
              <StatusBadge tone="danger" icon="error">
                Failed
              </StatusBadge>
            ) : null}
            <Button size="sm" variant="quiet" onClick={() => onOpen(c.draftId, c.title)}>
              Review & apply
            </Button>
          </li>
        ))}
      </ul>
    </Pane>
  );
}

// ── With Slackbot ─────────────────────────────────────────────────────────────────────────

/** Applied canvases whose notes and Deal Roles the sync has not seen land yet: the link and the prompt, until they do. */
function WithSlackbot({ v }: { v: ForecastPayload }) {
  const tz = useTimeZone();
  return (
    <Pane
      aria-label="With Slackbot"
      data-testid="forecast-with-slackbot"
      scroll={false}
      head={<SectionHead title="With Slackbot" count={v.withSlackbot.length} sub='applied: open each canvas in Slack and tell Slackbot "Execute this canvas"; the next sync checks the records' />}
    >
      <ul className="divide-y divide-line">
        {v.withSlackbot.map((c) => (
          <li key={c.draftId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5" data-canvas-id={c.draftId}>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold text-fg-heading">{`Slack canvas · ${c.title}`}</p>
              <p className="truncate text-caption text-muted tabular-nums">
                {[c.notes ? plural(c.notes, 'forecast note') : null, c.roles ? plural(c.roles, 'Deal Role') : null].filter(Boolean).join(' · ')} · {`${c.waiting} not seen in Org62 yet`} · {`applied ${dayLabel(c.at, tz)} ${clock(c.at, tz)}`}
              </p>
            </div>
            {c.url ? <OpenResult href={c.url} title="Open the canvas in Slack" testId="forecast-canvas-open" /> : <span className="text-caption text-muted">no link from Slack</span>}
            <CopyPromptButton prompt={forecastCanvasPrompt({ title: c.title, url: c.url, notes: c.notes, roles: c.roles })} title={c.title} testId="forecast-canvas-prompt" />
          </li>
        ))}
      </ul>
    </Pane>
  );
}

// ── This week's notes ─────────────────────────────────────────────────────────────────────

function RecordTitle({ row, onOpen, open }: { row: ForecastRow; onOpen: () => void; open: boolean }) {
  return (
    <button type="button" className={cn('block w-full min-w-0 truncate text-left font-bold text-fg-heading hover:underline', open && 'underline')} onClick={onOpen} aria-expanded={open} title={[row.opportunityName ?? row.name, row.accountName].filter(Boolean).join(' · ')} data-testid="forecast-open">
      {row.opportunityName ?? row.name}
      {row.accountName ? <span className="font-normal text-muted"> · {row.accountName}</span> : null}
    </button>
  );
}

function Facts({ row }: { row: ForecastRow }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-x-3 text-caption text-muted tabular-nums">
      <span className="font-bold text-fg">{usd(row.amount)}</span>
      <span>{stageLabel(row.stage)}</span>
      {row.forecastStatus ? <span>{row.forecastStatus}</span> : null}
      {row.judgement ? <span>{`Judgement ${row.judgement}`}</span> : null}
    </span>
  );
}

function NotesQueue({ v }: { v: ForecastPayload }) {
  const a = useForecastActions();
  const details = useDetails();
  const byId = useMemo(() => new Map(v.rows.map((r) => [r.id, r] as const)), [v.rows]);
  const rows = v.queue.notes.map((id) => byId.get(id)!).filter(Boolean);
  const undrafted = rows.filter((r) => r.notes.state === 'none').length;
  const est = v.mode === 'mock' ? 0 : Math.min(undrafted * v.drafting.perDraftUsd, v.drafting.dayLeftUsd);
  const ready = v.counts.ready;
  const stage = stageButton(v);
  const open = (r: ForecastRow) => details.open({ kind: 'specialist_forecast', id: r.id, label: r.opportunityName ?? r.name });
  return (
    <Pane
      aria-label="This week's forecast notes"
      data-testid="forecast-queue"
      scroll={false}
      head={
        <SectionHead
          title="This week's notes"
          count={rows.length}
          sub={`in-quarter, ${usd(v.thresholds.minAmountUsd)}+ and ${v.thresholds.staleDays}+ days old by ${v.due.label}; biggest and furthest along first`}
          action={
            <>
              {undrafted ? (
                <Button size="sm" variant="ai" loading={a.draft.isPending && !a.draft.variables} onClick={() => a.draft.mutate(undefined)} title={v.mode === 'mock' ? 'Mock mode: placeholder drafts, no model call' : `One read-only research run per note, up to $${v.drafting.perDraftUsd.toFixed(2)} each`} data-testid="forecast-draft-all">
                  {v.mode === 'mock' ? `Draft all ${undrafted}` : `Draft all ${undrafted} · up to $${est.toFixed(2)}`}
                </Button>
              ) : null}
              <Button size="sm" variant="primary" disabled={!ready} loading={a.stage.isPending} onClick={() => a.stage.mutate()} title={ready ? 'Approved notes and Deal Roles → ONE Slackbot canvas. Its preview opens; you Apply it there' : 'Approve a note or a Deal Role first'} data-testid="forecast-stage">
                {stage.label}
              </Button>
            </>
          }
        />
      }
    >
      {rows.length === 0 ? (
        <p className="border-t border-line px-5 py-3 text-caption text-muted">{`Every in-quarter note is current until ${v.due.label}.`}</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((r) => (
            <li key={r.id} className={cn('flex min-w-0 flex-col gap-2 px-5 py-3', details.openId === r.id && 'bg-surface-sunken')} data-forecast-id={r.id} data-notes-state={r.notesState} data-update={r.notes.state}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-6 shrink-0 text-caption text-muted tabular-nums">{r.rank}</span>
                <span className="block min-w-0 flex-1 basis-48">
                  <RecordTitle row={r} onOpen={() => open(r)} open={details.openId === r.id} />
                </span>
                <Facts row={r} />
                <NotesAgeBadge row={r} dueLabel={v.due.label} />
              </div>
              <div className="flex min-w-0 flex-col gap-2 pl-9">
                {r.currentNotes ? (
                  <p className="line-clamp-2 text-caption text-muted" title={r.currentNotes}>
                    <span className="font-bold">Now:</span> {r.currentNotes}
                  </p>
                ) : (
                  <p className="text-caption text-muted">No notes yet</p>
                )}
                <NoteEditor row={r} view={v} compact />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

// ── Deal Roles ────────────────────────────────────────────────────────────────────────────

function Roles({ v }: { v: ForecastPayload }) {
  const details = useDetails();
  const byId = new Map(v.rows.map((r) => [r.id, r] as const));
  const rows = v.queue.roles.map((id) => byId.get(id)!).filter(Boolean);
  return (
    <Pane aria-label="Deal Roles to set" data-testid="forecast-roles" scroll={false} head={<SectionHead title="Deal Roles to set" count={rows.length} sub="Deal Role is never None on a deal with ACV: at least Aware; approved fixes go in the same canvas" />}>
      <ul className="divide-y divide-line border-t border-line">
        {rows.map((r) => (
          <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2.5" data-role-id={r.id}>
            <span className="block min-w-0 flex-1 basis-48">
              <RecordTitle row={r} onOpen={() => details.open({ kind: 'specialist_forecast', id: r.id, label: r.opportunityName ?? r.name })} open={details.openId === r.id} />
            </span>
            <span className="text-caption font-bold text-fg tabular-nums">{usd(r.amount)}</span>
            <RoleFix row={r} />
          </li>
        ))}
      </ul>
    </Pane>
  );
}

// ── Opps with no Specialist Forecast ──────────────────────────────────────────────────────

/**
 * The handoff to Org62 (create the record from the opp's Forecast tab), then "I created it, check now": the worker
 * re-reads that opp (read-only) and the row says checking…, then not yet (with when it reads again) or the opp moves to
 * Found ✓ with its record one click away.
 */
function Missing({ v }: { v: ForecastPayload }) {
  const details = useDetails();
  const a = useForecastActions();
  const tz = useTimeZone();
  const nowIso = new Date().toISOString();
  return (
    <Pane
      aria-label="Opps with no Specialist Forecast"
      data-testid="forecast-missing"
      scroll={false}
      head={<SectionHead title="No Specialist Forecast" count={v.queue.missing.length} sub="opps of yours with Data 360 or Flex work closing this or next quarter: create the record from the opp's Forecast tab, then check it here" />}
    >
      <ul className="divide-y divide-line border-t border-line">
        {v.queue.missing.map((m) => {
          const btn = checkButton(m, a.check.isPending && a.check.variables === m.opportunityId);
          const line = checkLine(m.check, { nextAt: v.sync.nextAt, tz, now: nowIso });
          return (
            <li key={m.opportunityId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2.5" data-missing-opp={m.opportunityId} data-check={m.check?.status ?? 'none'}>
              <span className="block min-w-0 flex-1 basis-48">
                <button type="button" className="block w-full min-w-0 truncate text-left font-bold text-fg-heading hover:underline" onClick={() => details.open({ kind: 'opportunity', id: m.opportunityId, label: m.opportunityName })}>
                  {m.opportunityName}
                  {m.accountName ? <span className="font-normal text-muted"> · {m.accountName}</span> : null}
                </button>
                <span className="block truncate text-caption text-muted">{`${m.signal === 'flex_only' ? 'Flex credits' : m.signal === 'name_token' ? 'Data 360 in the name' : 'Data 360 line items'}${m.products.length ? ` · ${m.products.join(', ')}` : ''}${m.closeDate ? ` · closes ${m.closeDate}` : ''} · only you can, in Org62`}</span>
                {line ? (
                  <span className={cn('block truncate text-caption', m.check?.status === 'failed' ? 'text-danger-700' : 'text-muted')} role="status" data-testid="forecast-missing-check-line">
                    {line}
                  </span>
                ) : null}
              </span>
              <span className="text-caption font-bold text-fg tabular-nums">{usd(m.amount)}</span>
              {m.url ? <OrgLink url={m.url} label="Open the opp ▸ Forecast tab" /> : <span className="text-caption text-muted">Open the opp in Org62 ▸ Forecast tab ▸ New Specialist Forecast</span>}
              <Button size="sm" variant="quiet" icon="refresh" loading={btn.busy} disabled={btn.busy} onClick={() => a.check.mutate(m.opportunityId)} title="Re-read this opp's Specialist Forecast from Org62 (read-only; the worker runs it, and reads everything again 30 minutes later)" data-testid="forecast-missing-check">
                {btn.label}
              </Button>
            </li>
          );
        })}
        {v.found.map((f) => (
          <li key={`found:${f.opportunityId}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2.5" data-found-opp={f.opportunityId}>
            <span className="block min-w-0 flex-1 basis-48 truncate font-bold text-fg-heading">{f.opportunityName ?? 'Opportunity'}</span>
            <StatusBadge tone="success" icon="success">
              Found
            </StatusBadge>
            <span className="text-caption text-muted tabular-nums">{checkLine(f, { tz, now: nowIso })}</span>
            {f.recordId ? (
              <Button size="sm" variant="quiet" onClick={() => details.open({ kind: 'specialist_forecast', id: f.recordId!, label: f.opportunityName ?? 'Specialist Forecast' })} data-testid="forecast-found-open">
                Open its Specialist Forecast
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Pane>
  );
}

// ── Every record ──────────────────────────────────────────────────────────────────────────

function AllRecords({ v }: { v: ForecastPayload }) {
  const details = useDetails();
  const rows = v.rows.filter((r) => !r.gone);
  const gone = v.rows.length - rows.length;
  const open = (r: ForecastRow) => details.open({ kind: 'specialist_forecast', id: r.id, label: r.opportunityName ?? r.name });
  return (
    <Pane aria-label="All Specialist Forecasts" data-testid="forecast-table" scroll={false} head={<SectionHead title="All Specialist Forecasts" count={rows.length} sub={`${v.quarter.current} and ${v.quarter.next}, read-only from Org62${gone ? ` · ${gone} no longer listed` : ''}`} />} bodyClassName="overflow-x-auto">
      <table className="w-full min-w-[56rem] border-t border-line text-body">
        <thead>
          <tr className="text-left text-caption text-muted">
            <th className="px-5 py-2 font-bold">Opportunity</th>
            <th className="px-3 py-2 text-right font-bold">Amount</th>
            <th className="px-3 py-2 font-bold">Stage</th>
            <th className="px-3 py-2 font-bold">Forecast</th>
            <th className="px-3 py-2 font-bold">Judgement</th>
            <th className="px-3 py-2 font-bold">Notes age</th>
            <th className="px-3 py-2 font-bold">Deal role</th>
            <th className="px-5 py-2 font-bold">Update</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              tabIndex={0}
              className={cn('cursor-pointer border-t border-line hover:bg-surface-sunken focus-visible:outline-2', details.openId === r.id && 'bg-surface-sunken')}
              onClick={() => open(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') open(r);
              }}
              data-table-id={r.id}
            >
              <td className="max-w-[24rem] px-5 py-2">
                <span className="block truncate font-bold text-fg">{r.opportunityName ?? r.name}</span>
                <span className="block truncate text-caption text-muted">{[r.accountName, r.fiscalQuarter].filter(Boolean).join(' · ')}</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{usd(r.amount)}</td>
              <td className="px-3 py-2 text-caption">{stageLabel(r.stage)}</td>
              <td className="px-3 py-2 text-caption">{r.forecastStatus ?? '—'}</td>
              <td className="px-3 py-2 text-caption">{r.judgement ?? '—'}</td>
              <td className="px-3 py-2">{r.notesState === 'not_required' ? <span className="text-caption text-muted tabular-nums">{r.notesAgeDays === null ? '—' : `${r.notesAgeDays} d`}</span> : <NotesAgeBadge row={r} dueLabel={v.due.label} />}</td>
              <td className="px-3 py-2">
                {r.roleFix ? (
                  <StatusBadge tone="warning" icon="warning" title="Deal Role None on a deal with ACV">
                    {r.dealRole ?? 'None'}
                  </StatusBadge>
                ) : (
                  <span className="text-caption">{r.dealRole ?? '—'}</span>
                )}
              </td>
              <td className="px-5 py-2">
                <UpdateBadge state={r.notes.state !== 'none' ? r.notes.state : r.role.state} origin={r.notes.origin} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Pane>
  );
}
