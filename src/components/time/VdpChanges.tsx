'use client';
/**
 * VDP ▸ Changes (?view=vdp; D-60, the tree since D-63): what goes to VDP, as Company → VDP → items, and pushing it up.
 *
 *   company     VDP lacks it: it is the top item (create the company), the VDP to create under it, that VDP's items
 *   VDP         one that exists (its status, a quiet "Open in VDP ↗" to view it), or the one to create (its item)
 *   items       by section: Opportunities, People, Use cases (a Generate under its inputs), Assets, Header. Each has a
 *               checkbox when it can be pushed now, its one verb (Apply; Fill in for one that needs typed values, Edit
 *               to change a suggested one, e.g. an asset's Type; Find assets), who applies it, its suggestion, what
 *               autopilot did. One VDP's MCP can't take yet shows its reason, with no checkbox and no verb, and becomes
 *               pushable once VDP lists the tool (no Copy, no handoff)
 *   ticking     a node ticks what is under it; a child of a company or VDP that does not exist yet ticks those too;
 *               unticking an unborn parent unticks what is under it. "Tick all" skips disabled and unfilled rows
 *   Push N      the ticked items and what they need first, in order (company → VDP → header → people → opportunities →
 *               use cases → Generate → assets), each its own Outbox item approved by this click; a confirm lists them
 *               first. Dry run records them. A row's own Apply is the same push for that row (and what it needs)
 *
 * A row's title opens its details in the docked panel; "Ask" opens the Assistant on it. The push's progress follows
 * through live events (the worker runs it). Color marks state only: act, staged/waiting (neutral), failed, AI.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { VdpCoveragePayload } from '@/contract';
import { api, type ApiError } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { Pane, SectionHead, useDetails } from '@/components/deals/context-frame';
import { StatusBadge } from '@/components/domain';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { useRightPanel } from '@/components/shell/panel';
import { Button, cn, Dialog, IconButton, useNow, useTimeZone } from '@/ui';
import { isStaleVdpDraft } from '@/engines/vdp/status';
import { adminQueue, adminTitle, draftsById, vdpReauthLabel } from './vdp-derive';
import { autopilotLabel, pushFailures, whoLine, type PushFailure } from './vdp-changes-derive';
import { applyLabel, applyValues, needsInput, pushableKeys, pushOrder, pushProgress, pushRequest, tickState, toggleRow, treeRows, whyNot, type TreeRow } from './vdp-tree-derive';
import { AutopilotState, DisabledReason, OpenInVdp, SuggestionLine, VdpInputs, VdpStatusChip } from './VdpItem';
import { VdpPushRuns } from './VdpPushRuns';
import { activeRun, pushRunView } from './vdp-push-derive';
import { IdentityLine } from './VdpIdentity';
import { errorText } from '@/lib/error-text';

type Values = Record<string, Record<string, string>>;

export function VdpChanges({ cov, findAll }: { cov: VdpCoveragePayload; findAll?: ReactNode }) {
  const tz = useTimeZone();
  const now = useNow();
  const details = useDetails();
  const panel = useRightPanel();
  const outbox = useApi('getOutbox');
  const health = useApi('getHealth');
  const qc = useQueryClient();
  const byId = useMemo(() => draftsById(outbox.data?.admin.items ?? []), [outbox.data]);
  const rows = useMemo(() => treeRows(cov.tree, cov.push), [cov.tree, cov.push]);
  const [values, setValues] = useState<Values>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [forms, setForms] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Set<string> | null>(null);
  // 2026-11-13 audit C6: every item the last push could not send, with why, until you dismiss it (not a 6 s toast)
  const [notPushed, setNotPushed] = useState<PushFailure[]>([]);
  const pushable = useMemo(() => pushableKeys(rows, values), [rows, values]);
  const progress = pushProgress(cov.push, rows, now.getTime());
  // D-69 (VD-28): a live push waits for VDP's sign-in (a dry run records either way)
  const signedOut = cov.signIn === 'stale' && health.data?.dryRun === false;

  // the ticks follow the tree: a row that left (applied, gone) or can't go any more is unticked
  useEffect(() => {
    const live = new Set(pushable);
    setTicked((t) => (Array.from(t).every((x) => live.has(x)) ? t : new Set(Array.from(t).filter((x) => live.has(x)))));
  }, [pushable]);

  // My VDPs' "N missing" jumps here with ?focus=<vdp slug>
  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get('focus');
    if (f) requestAnimationFrame(() => document.querySelector(`[data-vdp-node="${CSS.escape(f)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, []);

  // staged VDP items no row shows (a change staged for something not open any more): still yours to Apply
  const referenced = new Set(rows.map((r) => r.step?.draftId ?? r.asset?.draftId).filter(Boolean));
  // a running push stages its items as it goes: those are its own (Push runs follows them), never "waiting for Apply"
  const running = activeRun(cov.pushes);
  const runningSince = running ? Date.parse(running.at) : null;
  const orphans = adminQueue(outbox.data?.admin.items ?? []).filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action.startsWith('vdp.') && !referenced.has(i.draft.id) && !(runningSince !== null && Date.parse(i.draft.createdAt) >= runningSince));

  const openDraft = (id: string) => {
    const d = byId.get(id);
    details.open({ kind: 'draft', id, label: d ? adminTitle(d) : 'VDP change' });
  };
  const openRow = (r: TreeRow) => details.open({ kind: 'vdp', id: r.ref ?? r.detailsKey, label: r.title });
  const ask = (r: TreeRow) => panel.openAssistant({ kind: 'vdp', id: r.ref ?? r.detailsKey, label: r.title });
  const setValue = (key: string, field: string, v: string) => setValues((x) => ({ ...x, [key]: { ...(x[key] ?? {}), [field]: v } }));
  const toggleForm = (key: string) => setForms((f) => (f.has(key) ? new Set(Array.from(f).filter((x) => x !== key)) : new Set([...f, key])));

  const discard = useMutation({
    mutationFn: (id: string) => api('rejectDraft', { params: { id }, body: { reason: 'Discarded: stale (still waiting after 14 days)' } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['outbox'] });
      void qc.invalidateQueries({ queryKey: ['deals'] });
      toast({ key: 'vdp-discard', tone: 'success', title: 'Discarded: nothing was sent' });
    },
    onError: (e: ApiError) => toast({ key: 'vdp-discard', tone: 'error', title: "Couldn't discard it", body: errorText(e, 200) }),
  });

  const order = confirm ? pushOrder(confirm, rows, values) : [];
  const push = useMutation({
    mutationFn: (keys: Set<string>) => api('pushVdpChanges', { body: { items: pushRequest(keys, rows, values) } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['outbox'] });
      void qc.invalidateQueries({ queryKey: ['deals'] });
      setConfirm(null);
      setTicked(new Set());
      const ok = r.results.filter((x) => x.state !== 'failed' && x.state !== 'skipped').length;
      const bad = pushFailures(r.results, rows);
      setNotPushed(bad);
      const queued = r.results.some((x) => x.state === 'queued');
      toast({
        key: 'vdp-push',
        tone: bad.length ? 'error' : 'success',
        // 2026-11-16: a push runs in the background; the click only queues it (Push runs follows it)
        title: queued ? `${r.dryRun ? 'Dry run' : 'Pushing'} ${ok} ${ok === 1 ? 'change' : 'changes'} ${r.dryRun ? 'in the background' : 'to VDP in the background'}` : r.dryRun ? `Dry run: ${ok} ${ok === 1 ? 'change' : 'changes'} recorded, nothing sent` : `${ok} ${ok === 1 ? 'change' : 'changes'} applied`,
        body: bad.length ? `${bad.length} not pushed: each is listed above the changes, with why.` : queued ? 'Push runs, on this page, follows it item by item: you can leave, it keeps going.' : r.dryRun ? 'Turn dry run off in Settings ▸ Sending to push for real.' : 'Each is read back; the rows follow along. The next VDP read closes them.',
      });
    },
    onError: (e: ApiError) => toast({ key: 'vdp-push', tone: 'error', title: "Couldn't push the changes", body: errorText(e, 200) }),
  });

  const ctx: RowCtx = {
    rows,
    values,
    ticked,
    forms,
    tz,
    autopilotOn: cov.autopilot.on,
    stale: (draftId) => {
      const d = draftId ? byId.get(draftId) : undefined;
      return !!d && isStaleVdpDraft(d, now.getTime());
    },
    onToggle: (r) => setTicked((t) => toggleRow(t, r, rows, values)),
    onValue: setValue,
    onForm: toggleForm,
    onApply: (r) => r.key && setConfirm(new Set([r.key])),
    onOpen: openRow,
    onAsk: ask,
    onDraft: openDraft,
    onDiscard: (id) => discard.mutate(id),
  };
  const companies = groupByCompany(rows);
  const allOn = pushable.length > 0 && pushable.every((k) => ticked.has(k));

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="vdp-changes">
      <div className="sticky top-0 z-10 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-surface px-4 py-2.5" data-testid="vdp-push-bar">
        <span className="min-w-0 flex-1 text-body text-muted">
          {progress ?? (pushable.length ? (ticked.size ? `${ticked.size} of ${pushable.length} ticked` : `${pushable.length} ${pushable.length === 1 ? 'change' : 'changes'} the app can push: tick them, then push`) : 'Nothing to push right now')}
          {cov.autopilot.on && cov.autopilot.queued ? ` · autopilot has ${cov.autopilot.queued} queued` : ''}
        </span>
        {pushable.length ? (
          <Button size="sm" variant="quiet" onClick={() => setTicked(allOn ? new Set() : new Set(pushable))} data-testid="vdp-tick-all">
            {allOn ? 'Untick all' : 'Tick all'}
          </Button>
        ) : null}
        {signedOut ? (
          <span className="text-caption font-bold text-fg" data-testid="vdp-push-signin">
            {`${vdpReauthLabel()} first: a push needs a fresh VDP sign-in`}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          disabled={!ticked.size || !!running || signedOut}
          title={signedOut ? 'VDP’s sign-in is stale: a push would fail, so it waits for the re-auth' : running ? 'VDP takes one push at a time: this one waits for the push running now (Push runs below)' : undefined}
          onClick={() => setConfirm(new Set(ticked))}
          data-testid="vdp-push"
        >
          {running ? `Waits for the push · ${pushRunView(running).done} of ${running.nodes.length}` : ticked.size ? `Push ${pushOrder(ticked, rows, values).length} to VDP` : 'Push to VDP'}
        </Button>
        {findAll}
      </div>

      <VdpPushRuns runs={cov.pushes} tz={tz} onDraft={openDraft} />

      {notPushed.length ? (
        <Pane
          aria-label="Not pushed"
          scroll={false}
          data-testid="vdp-not-pushed"
          head={
            <SectionHead
              title="Not pushed"
              count={notPushed.length}
              sub="the last push could not send these: fix what it says, then push again"
              action={
                <Button size="xs" variant="quiet" onClick={() => setNotPushed([])}>
                  Dismiss
                </Button>
              }
            />
          }
        >
          <ul className="divide-y divide-line">
            {notPushed.map((f) => (
              <li key={f.itemKey} className="flex min-w-0 flex-col gap-0.5 px-5 py-2.5" data-item-key={f.itemKey}>
                <span className="min-w-0 font-bold break-words text-fg-heading">{f.label}</span>
                <span className="min-w-0 text-caption break-words text-danger-700">{f.why}</span>
              </li>
            ))}
          </ul>
        </Pane>
      ) : null}

      {orphans.length ? (
        <Pane aria-label="Staged, waiting for your Apply" scroll={false} head={<SectionHead title="Staged, waiting for your Apply" count={orphans.length} sub="nothing reaches VDP until you Apply each one" />}>
          <ul className="divide-y divide-line">
            {orphans.map((it) => (
              <li key={it.draft.id} className="flex min-w-0 flex-wrap items-center gap-3 px-5 py-2.5">
                <span className="min-w-0 flex-1 font-bold text-fg-heading">{adminTitle(it.draft)}</span>
                {ctx.stale(it.draft.id) ? (
                  <>
                    <StatusBadge tone="warning" icon="clock">
                      Stale: still want this?
                    </StatusBadge>
                    <Button size="sm" variant="quiet" onClick={() => discard.mutate(it.draft.id)}>
                      Discard
                    </Button>
                  </>
                ) : null}
                {it.group === 'failed' ? (
                  <StatusBadge tone="danger" icon="error">
                    Failed
                  </StatusBadge>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => openDraft(it.draft.id)}>
                  Review & apply
                </Button>
              </li>
            ))}
          </ul>
        </Pane>
      ) : null}

      {companies.length ? (
        companies.map((c) => <Company key={c[0]!.id} rows={c} ctx={ctx} />)
      ) : (
        <p className="rounded-md border border-line bg-surface px-5 py-4 text-body" data-testid="vdp-no-changes">
          Nothing to push: every open opportunity where your DC is 100% is on a VDP that has what the app checks.
        </p>
      )}

      {cov.autopilot.on || cov.autopilot.recent.length ? <Recent entries={cov.autopilot.recent} tz={tz} onDraft={openDraft} /> : null}

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Push ${order.length} ${order.length === 1 ? 'change' : 'changes'} to VDP?`}
        description={health.data?.dryRun !== false ? 'Dry run is on: each is recorded with its exact payload (a new id shows as a placeholder), and nothing is sent.' : 'In this order, each written to VDP and read back; a new company’s or VDP’s id goes to the items under it. If one fails, what needs it is not pushed. Nothing is deleted, and no value is cleared.'}
        confirmLabel={`Push ${order.length}`}
        onConfirm={() => {
          if (confirm) push.mutate(confirm);
        }}
        busy={push.isPending}
      >
        <ol className="max-h-72 list-decimal space-y-1 overflow-y-auto pl-5 text-body" data-testid="vdp-push-order">
          {order.map(({ row, required }) => (
            <li key={row.id} className="min-w-0">
              <span className="font-bold">{row.title}</span>
              {required ? <span className="text-muted"> · needed first</span> : null}
              {row.step?.suggestion ? <span className="text-muted"> · {row.step.suggestion.line}</span> : null}
            </li>
          ))}
        </ol>
      </Dialog>
    </div>
  );
}

interface RowCtx {
  rows: TreeRow[];
  values: Values;
  ticked: ReadonlySet<string>;
  forms: ReadonlySet<string>;
  tz?: string;
  autopilotOn: boolean;
  stale: (draftId: string | null | undefined) => boolean;
  onToggle: (r: TreeRow) => void;
  onValue: (key: string, field: string, v: string) => void;
  onForm: (key: string) => void;
  onApply: (r: TreeRow) => void;
  onOpen: (r: TreeRow) => void;
  onAsk: (r: TreeRow) => void;
  onDraft: (id: string) => void;
  onDiscard: (id: string) => void;
}

/** The rows of each company (its own row first), in order. */
function groupByCompany(rows: readonly TreeRow[]): TreeRow[][] {
  const out: TreeRow[][] = [];
  for (const r of rows) {
    if (r.kind === 'company') out.push([r]);
    else out.at(-1)?.push(r);
  }
  return out;
}

/** The checkbox of a row or a node (mixed when only some of what is under it is ticked); none when nothing can go. */
function Tick({ row, ctx }: { row: TreeRow; ctx: RowCtx }) {
  const ref = useRef<HTMLInputElement>(null);
  const st = tickState(row, ctx.ticked, ctx.rows, ctx.values);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = st === 'some';
  }, [st]);
  const why = row.key && st === 'off' ? whyNot(row, ctx.rows, ctx.values) : null;
  // a row with nothing to send (Find assets, the assets to confirm) has its own verb, no checkbox
  if (!row.key && !row.descendants.length) return <span className="h-8 w-5 shrink-0" aria-hidden />;
  return (
    <span className="flex h-8 w-5 shrink-0 items-center" title={why ?? undefined}>
      <input
        ref={ref}
        type="checkbox"
        aria-label={`Push: ${row.title}`}
        className="size-4 accent-current disabled:opacity-40"
        checked={st === 'all'}
        disabled={st === 'off'}
        onChange={() => ctx.onToggle(row)}
        data-testid="vdp-change-tick"
        data-tick={st}
      />
    </span>
  );
}

function Company({ rows, ctx }: { rows: TreeRow[]; ctx: RowCtx }) {
  const head = rows[0]!;
  const rest = rows.slice(1);
  return (
    <Pane aria-label={`Changes for ${head.title}`} scroll={false} data-vdp-node={head.detailsKey} data-testid="vdp-company">
      <div className="flex min-w-0 items-start gap-3 border-b border-line px-4 pt-3 pb-2.5">
        <Tick row={head} ctx={ctx} />
        {head.step ? (
          <div className="min-w-0 flex-1">
            <ItemBody row={head} ctx={ctx} heading />
            {head.identity ? <IdentityLine identity={head.identity} /> : null}
          </div>
        ) : (
          <div className="min-w-0 flex-1 py-1">
            <h2 className="min-w-0 text-lead font-bold text-fg-heading">{head.title}</h2>
            {head.identity ? <IdentityLine identity={head.identity} /> : null}
          </div>
        )}
      </div>
      <ul className="flex min-w-0 flex-col" data-testid="vdp-change-rows">
        {rest.map((r) => (
          <TreeLine key={r.id} row={r} ctx={ctx} />
        ))}
      </ul>
    </Pane>
  );
}

const INDENT: Record<TreeRow['level'], string> = { 0: 'pl-4', 1: 'pl-4', 2: 'pl-12', 3: 'pl-20' };

function TreeLine({ row, ctx }: { row: TreeRow; ctx: RowCtx }) {
  if (row.kind === 'section') {
    return (
      <li className="pt-3 pr-4 pb-1 pl-[4.25rem]" data-section={row.section}>
        <span className="text-caption font-bold tracking-wide text-muted uppercase">{row.title}</span>
      </li>
    );
  }
  if (row.kind === 'vdp') {
    const v = row.vdp!;
    return (
      <li className={cn('mt-1 flex min-w-0 items-start gap-3 border-t border-line pt-2.5 pr-4 pb-1.5', INDENT[1])} data-vdp-node={row.detailsKey} data-testid="vdp-node">
        <span className="w-4 shrink-0" aria-hidden />
        <Tick row={row} ctx={ctx} />
        {row.step ? (
          <div className="min-w-0 flex-1">
            <ItemBody row={row} ctx={ctx} heading />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-1">
            <button type="button" className="min-w-0 text-left font-bold text-fg-heading hover:underline" onClick={() => ctx.onOpen(row)} data-testid="vdp-group-open">
              {v.label}
              {v.opportunities.length ? <span className="font-normal text-muted"> · {v.opportunities.join(', ')}</span> : null}
            </button>
            {v.status ? <VdpStatusChip status={v.status} /> : null}
            {v.url ? (
              <span className="ml-auto">
                <OpenInVdp url={v.url} />
              </span>
            ) : null}
          </div>
        )}
      </li>
    );
  }
  const st = row.step?.state ?? row.asset?.state ?? 'todo';
  return (
    <li className={cn('flex min-w-0 items-start gap-3 pt-1.5 pr-4 pb-1.5', INDENT[row.level], ctx.ticked.has(row.key ?? '') && 'bg-surface-sunken')} data-change={row.ref} data-state={st} data-disabled={row.disabled ? 'true' : undefined} data-kind={row.kind}>
      {row.kind === 'child' ? <span aria-hidden className="mt-1 h-5 w-3 shrink-0 rounded-bl border-b border-l border-line" /> : null}
      <Tick row={row} ctx={ctx} />
      <div className="min-w-0 flex-1">
        <ItemBody row={row} ctx={ctx} />
      </div>
    </li>
  );
}

/** One item's words and its one verb (Apply, Fill in, Review & apply, Find assets, Open the details). */
function ItemBody({ row, ctx, heading }: { row: TreeRow; ctx: RowCtx; heading?: boolean }) {
  const s = row.step;
  const a = row.asset;
  const apply = s?.apply ?? a?.apply ?? null;
  const st = s?.state ?? a?.state ?? 'todo';
  const key = row.key;
  const typed = key ? (ctx.values[key] ?? {}) : {};
  const suggestion = st === 'todo' ? (s?.suggestion ?? null) : null;
  // an item with a value you can change (a typed one, or a choice such as an asset's Type) opens its inputs: Fill in
  // when one is missing, Edit when every value is there already (the suggestion stays yours to change)
  const editable = !!apply && !row.disabled && st === 'todo' && apply.fields.some((f) => !f.fixed);
  const inputs = editable && needsInput(apply, suggestion);
  const formOpen = !!key && (ctx.forms.has(key) || (inputs && Object.keys(typed).length > 0));
  const label = applyLabel(row, ctx.rows);
  const failed = row.push && (row.push.state === 'failed' || row.push.state === 'skipped') && st !== 'waiting' ? row.push : null;
  const canGo = !!key && !whyNot(row, ctx.rows, ctx.values);
  // an item under a company or VDP that does not exist yet goes with them (autopilot waits for the VDP read)
  const who =
    s?.kind === 'find_assets'
      ? 'The app looks for them here'
      : s?.kind === 'assets'
        ? 'Confirm them in the details'
        : row.requires.length && st === 'todo'
          ? 'Goes after what it needs, in one push'
          : s
            ? whoLine({ ...s, disabled: null }, ctx.autopilotOn)
            : a
              ? whoLine({ policy: a.policy, state: a.state, check: 'missing', disabled: null }, ctx.autopilotOn)
              : '';
  const detail = s?.detail ?? (a ? `${a.why}${a.policyReason ? ` · ${a.policyReason}` : ''}` : null);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="vdp-item" data-step={s?.kind ?? 'asset'}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <button type="button" className={cn('min-w-0 text-left font-bold hover:underline', row.disabled ? 'text-muted' : heading ? 'text-fg-heading' : 'text-fg', heading && 'text-body-lg')} onClick={() => ctx.onOpen(row)} data-testid="vdp-item-open">
            {row.title}
          </button>
          <p className="text-caption text-muted">
            {row.disabled ? detail : [who, detail].filter(Boolean).join(' · ')}
            {st === 'waiting' ? ' · applied: waiting for VDP to refresh' : st === 'staged' ? ' · staged: waiting for your Apply' : st === 'maybe_made' ? ' · maybe made already: a push looks in VDP first, never sends it twice' : ''}
          </p>
          {row.disabled ? <DisabledReason text={row.disabled} /> : null}
          {suggestion || s?.autopilot || a?.autopilot ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              {suggestion ? <SuggestionLine s={suggestion} /> : null}
              {s?.autopilot ? <AutopilotState a={s.autopilot} tz={ctx.tz} /> : a?.autopilot ? <AutopilotState a={a.autopilot} tz={ctx.tz} /> : null}
            </div>
          ) : null}
          {failed ? (
            <div className="mt-1">
              <StatusBadge tone="danger" icon="error">
                {failed.state === 'skipped' ? failed.detail ?? 'Not pushed' : `Not pushed: ${failed.detail ?? 'failed'}`}
              </StatusBadge>
            </div>
          ) : null}
          {st === 'staged' && s?.draftId && ctx.stale(s.draftId) ? (
            <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="vdp-stale">
              <StatusBadge tone="warning" icon="clock">
                Stale: still want this?
              </StatusBadge>
              <Button size="sm" variant="quiet" onClick={() => ctx.onDiscard(s.draftId!)}>
                Discard
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {a ? (
            <a href={a.url} target="_blank" rel="noreferrer" className="text-caption font-bold text-link hover:underline">
              The asset ↗
            </a>
          ) : null}
          {row.disabled ? null : st === 'waiting' ? (
            <StatusBadge tone="neutral" icon="clock">
              Waiting for VDP to refresh
            </StatusBadge>
          ) : s?.kind === 'find_assets' ? (
            <FindAssets detailsKey={row.detailsKey} />
          ) : s?.kind === 'assets' ? (
            <Button size="sm" variant="secondary" onClick={() => ctx.onOpen(row)}>
              Open the details
            </Button>
          ) : st === 'staged' && (s?.draftId ?? a?.draftId) && !row.requires.length ? (
            <Button size="sm" variant="secondary" onClick={() => ctx.onDraft((s?.draftId ?? a?.draftId)!)} data-testid="vdp-review">
              Review & apply
            </Button>
          ) : apply && key ? (
            <>
              {editable ? (
                <Button size="sm" variant="quiet" onClick={() => ctx.onForm(key)} aria-expanded={formOpen} data-testid={inputs ? 'vdp-fill' : 'vdp-edit'}>
                  {formOpen ? 'Hide' : inputs ? 'Fill in' : 'Edit'}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" disabled={!canGo} title={label.above.length ? `Pushes ${label.above.map((x) => x.title).join(', then ')} first` : undefined} onClick={() => ctx.onApply(row)} data-testid="vdp-apply">
                {label.label}
              </Button>
            </>
          ) : null}
          <IconButton icon="chat" label="Ask the Assistant about this" onClick={() => ctx.onAsk(row)} />
        </div>
      </div>
      {apply && key && formOpen && !row.disabled ? <VdpInputs apply={apply} values={applyValues(apply, typed, suggestion)} onChange={(f, v) => ctx.onValue(key, f, v)} footer={<span className="text-caption text-muted">Tick it once it is filled in, or Apply it now; nothing reaches VDP before that.</span>} /> : null}
    </div>
  );
}

/** "Find assets" (D-63: in-app, never a handoff): a read-only research run whose finds become items here. */
function FindAssets({ detailsKey }: { detailsKey: string }) {
  const qc = useQueryClient();
  const go = useMutation({
    mutationFn: () => api('findVdpAssets', { body: { key: detailsKey } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['deals'] });
      const e = r.entity;
      toast(e.started ? { key: `vdp-find-${detailsKey}`, tone: 'success', title: 'Looking for assets', body: `Drive, Slack, Gmail and Calendar, up to $${e.estimateUsd.toFixed(2)}. The finds show here.` } : { key: `vdp-find-${detailsKey}`, tone: 'error', title: "Couldn't start Find assets", body: e.note ?? e.skipped[0]?.why ?? 'Nothing to run' });
    },
    onError: (e: ApiError) => toast({ key: `vdp-find-${detailsKey}`, tone: 'error', title: "Couldn't start Find assets", body: errorText(e, 200) }),
  });
  return (
    <Button size="sm" variant="secondary" icon="search" loading={go.isPending} onClick={() => go.mutate()} data-testid="vdp-find-assets">
      Find assets
    </Button>
  );
}

/** Autopilot's recent applies and failures, newest first. */
function Recent({ entries, tz, onDraft }: { entries: VdpCoveragePayload['autopilot']['recent']; tz?: string; onDraft: (id: string) => void }) {
  return (
    <Pane aria-label="Applied automatically" scroll={false} head={<SectionHead title="Applied automatically" count={entries.length} sub="what VDP autopilot applied or tried lately (Settings ▸ Sending ▸ VDP autopilot)" />}>
      {entries.length ? (
        <ul className="divide-y divide-line border-t border-line" data-testid="vdp-autopilot-recent">
          {entries.map((e) => {
            const l = autopilotLabel({ state: e.state, at: e.at, detail: e.detail, draftId: e.draftId, url: e.url }, (iso) => `${dayLabel(iso, tz)} ${clock(iso, tz)}`);
            return (
              <li key={`${e.key}:${e.at}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2" data-state={e.state}>
                <span className="min-w-0 flex-1">
                  <span className="font-bold text-fg">{e.companyName}</span> · {e.title}
                </span>
                <StatusBadge tone={l.tone} icon={e.state === 'applied' ? 'check' : 'error'}>
                  {l.text}
                </StatusBadge>
                {e.url ? <OpenInVdp url={e.url} label="Open" /> : null}
                {e.draftId ? (
                  <Button size="sm" variant="quiet" onClick={() => onDraft(e.draftId!)}>
                    Details
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-t border-line px-5 py-3 text-caption text-muted">Nothing yet: it applies the items marked “autopilot can apply it” after the next VDP read.</p>
      )}
    </Pane>
  );
}
