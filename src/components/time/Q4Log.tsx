'use client';
/**
 * Time ▸ Log it (docs/archive/2026-build/time-redesign.md): what is ready to log, and each logging run with its own status.
 *
 *   Ready to log   lane 2 (./ReadyLane.tsx, C5): the rows that have ended with what they need, ticked on the lane, then
 *                  (D-70) the updates to Events already in Org62 and the use cases ready for Org62, each a row you tick
 *                  the same way; "Log N · h" (N = everything ticked) re-reads the ticked rows, then POST /time/log/batches stages ONE new private canvas item (D-47).
 *   Sending        lane 3 (./SendingLane.tsx, C6) on To log's LanePage (C7): each batch on its way, its next action.
 *
 * ⌘↵ logs the ready rows (the Review page), else runs the Sending lane's first next action (sending-derive `sendNext`:
 * Review & apply, Send to Org62 via Slackbot). Human hours only: agent time is never totalled here.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ActivityEntry, LogCanvas, TimeSettings, TimeWeek } from '@/contract';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { featureActive } from '@/personas/gates';
import { api } from '@/client/api';
import { useCommands, useKeyBinding, type Command } from '@/client/keyboard';
import { toast } from '@/client/toast';
import { copySlackbotPrompt, usePromptWording } from '@/components/domain/ResultLinks';
import { useDetails } from '@/components/deals/context-frame';
import { AppLink } from '@/components/shell/AppLink';
import { useDraftQueueSource } from '@/components/detail/lib/draft-queue';
import { Button, Icon } from '@/ui';
import { errorText } from '@/lib/error-text';
import { dcWaitingCount, ucWaitingCount } from '@/lib/waiting-work';
import { usePatchRows } from './bulk';
import { canvasPrompt, confirmPrompt, q4Range, type Q4Step } from './derive';
import { type LogPath } from './path-derive';
import { ReadyLane, type ReadyLog } from './ReadyLane';
import { NEXT_LABEL, sendingOf, type SendingBatch } from './sending-derive';
import { copyText } from './shared';

/**
 * Link only: your own Slackbot work-order canvas, from Settings ▸ Time ▸ Work-order canvas link (each teammate has
 * their own), else NEXT_PUBLIC_CC_WORKORDER_CANVAS_URL. Null: no link is shown.
 */
export function workOrderCanvasUrl(time: Pick<TimeSettings, 'logging'> | undefined, env: string | undefined = process.env.NEXT_PUBLIC_CC_WORKORDER_CANVAS_URL): string | null {
  return time?.logging?.workOrderCanvasUrl || env || null;
}

export function useWorkOrderCanvasUrl(): string | null {
  return workOrderCanvasUrl(useApi('getSettings').data?.time);
}

const COPIED_KEY = 'cc:time:confirm-copied';
function readCopied(): number | null {
  try {
    const v = sessionStorage.getItem(COPIED_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

/** How many rows "Tell Slackbot" last copied the prompt for (session memory): the stop then waits on Org62. */
export function useConfirmCopied(): [number | null, (n: number | null) => void] {
  const [copiedFor, setCopiedFor] = useState<number | null>(() => (typeof window === 'undefined' ? null : readCopied()));
  const mark = useCallback((n: number | null) => {
    setCopiedFor(n);
    try {
      if (n === null) sessionStorage.removeItem(COPIED_KEY);
      else sessionStorage.setItem(COPIED_KEY, String(n));
    } catch {
      /* memory only */
    }
  }, []);
  return [copiedFor, mark];
}

/**
 * D-58: Deal Contribution requests waiting for a canvas (they ride on the next one with rows, or Log DCs now). Null
 * while the list loads (2026-11-13 audit C2: never a "Nothing ready" flash before the count is known); 0 when the role
 * has no DCs, or the list could not be read (Deals ▸ DCs says why).
 */
export function useDcPending(): number | null {
  const persona = usePersona();
  const dcActive = featureActive(persona, 'dealContributions');
  const dcList = useApi('listDcRequests', undefined, { enabled: dcActive });
  if (!dcActive) return 0;
  if (dcList.data) return dcWaitingCount(dcList.data.requests);
  return dcList.isError ? 0 : null;
}

/** D-67: VDP use cases waiting for a canvas (creates and Stage / Go-Live fixes ride on the next one with rows). Null while loading. */
export function useUcPending(): number | null {
  const persona = usePersona();
  const on = featureActive(persona, 'vdp');
  const sync = useApi('getUseCaseSync', undefined, { enabled: on });
  if (!on) return 0;
  if (sync.data) return ucWaitingCount(sync.data.counts);
  return sync.isError ? 0 : null;
}

/** "Slackbot's done: check now": the Org62 reads for this canvas at once (read only, deduped with the queued ones). */
export function useCanvasCheck() {
  const [busy, setBusy] = useState<string | null>(null);
  const check = useCallback(async (c: Pick<LogCanvas, 'draftId' | 'title'>, reason: 'copied' | 'now') => {
    if (reason === 'now') setBusy(c.draftId);
    try {
      const r = await api('checkCanvasOrg62', { params: { id: c.draftId }, body: { reason } });
      if (reason === 'now' || r.note)
        toast({
          key: `canvas-check:${c.draftId}`,
          tone: r.queued.length ? 'success' : 'info',
          title: r.queued.length ? `Checking Org62 for ${c.title}` : `Nothing to check for ${c.title}`,
          body: r.note ?? 'The Org62 reads run now (read only); this batch’s line updates when they finish.',
        });
    } catch (err) {
      toast({ key: `canvas-check:${c.draftId}`, tone: 'error', title: `Couldn't queue the Org62 check for ${c.title}`, body: errorText(err) });
    } finally {
      if (reason === 'now') setBusy(null);
    }
  }, []);
  return { check, busy };
}

export interface LogItProps {
  path: LogPath;
  /** This week (its `logCanvases`: the canvases waiting for Apply and the applied ones). */
  week: TimeWeek;
  /** The quarter so far and at least the last 3 weeks (GET /time/log, q4Range), deduped with this week's rows. */
  rows: ActivityEntry[];
  now: string;
  tz?: string;
  dryRun: boolean;
  /** Jump to rows in the week's table. */
  onShow: (ids: string[]) => void;
  /** Open a row in the docked panel. */
  onOpen?: (id: string) => void;
  /** Tell Slackbot's session memory (useConfirmCopied): the copy moves the stop to waiting. */
  markCopied: (n: number | null) => void;
  /** Open the Review page ("Review N to log"). */
  onReview: () => void;
  /** The page's key scope: ⌘↵ runs the current stop. */
  scope?: string;
  /** Lane 2's state, held by To log so LanePage's header carries "Log N · h" (C7); the lane then draws no header. */
  log?: ReadyLog;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function LogIt({ path, week, rows, tz, dryRun, onShow, onOpen, markCopied, onReview, scope = 'page:time', log }: LogItProps) {
  const canvasUrl = useWorkOrderCanvasUrl();
  const wording = usePromptWording();
  const { many } = usePatchRows();
  const { check: checkCanvas } = useCanvasCheck();
  const { stages, steps } = path;
  const label = week.quarter.label;
  const ready = stages.find((s) => s.id === 'ready')!;
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r] as const)), [rows]);
  const readyRows = useMemo(() => path.readyIds.map((id) => byId.get(id)).filter((e): e is ActivityEntry => !!e).sort((a, b) => a.start.localeCompare(b.start)), [path.readyIds, byId]);
  // ⌘↵ past the ready rows: the Sending lane's first batch waiting on you (one rule, sending-derive's)
  const nextBatch = useMemo(() => sendingOf({ canvases: week.logCanvases, tz }).batches.find((b) => b.next === 'apply' || b.next === 'review' || b.next === 'apply_again' || b.next === 'send') ?? null, [week.logCanvases, tz]);
  const lastCanvas = (week.logCanvases ?? []).find((c) => c.state !== 'pending' && c.state !== 'retry' && c.state !== 'applying') ?? null;
  // D-52: canvas items are applied here, in the same draft panel as the Outbox; it pages through every waiting one
  const { open: openPanel } = useDetails();
  const canvasIds = steps.find((x) => x.id === 'outbox')?.draftIds;
  useDraftQueueSource('time-log', canvasIds);
  const openCanvas = useCallback((id: string) => openPanel({ kind: 'draft', id, label: 'Logging batch' }), [openPanel]);
  const pick = { taskTypeRequired: wording.taskType, taskTypes: wording.taskTypes, internalActivity: wording.internal };
  // D-70: use cases ready for Org62 and updates to Events already there are rows of Ready to log like any other
  const persona = usePersona();
  const vdpOn = featureActive(persona, 'vdp');
  const ucq = useApi('getUseCaseLandings', undefined, { enabled: vdpOn });
  const upq = useApi('getEventUpdates', undefined);
  const readyUcs = useMemo(() => (vdpOn ? (ucq.data?.items ?? []).filter((x) => x.ready) : []), [vdpOn, ucq.data]);
  const readyUps = useMemo(() => (upq.data?.updates ?? []).filter((u) => u.state !== 'dismissed'), [upq.data]);
  const anyReady = readyRows.length + readyUcs.length + readyUps.length > 0;
  // the button names what it logs: it waits until the use cases and Event updates are counted too (they load apart)
  const counting = (vdpOn && ucq.isPending) || upq.isPending;
  // the re-check before staging: the rows as they are now on the server
  const loadFresh = useCallback(async () => (await api('getActivityLog', { query: q4Range(week) })).entries, [week]);

  const approveAll = useCallback(
    async (ids: string[]) => {
      await many(
        ids.map((id) => byId.get(id)).filter((e): e is ActivityEntry => !!e),
        () => ({ status: 'approved' }),
        { key: 'time:approve', title: (n) => `Approved ${n} ${n === 1 ? 'row' : 'rows'}`, body: 'They stay in Ready to log until you log them to Slackbot.' },
      );
    },
    [many, byId],
  );

  // D-58: a batch with only the DC requests on it (lane 2 stages the rows; this is the DCs-only "Log DCs now")
  const [logging, setLogging] = useState(false);
  const logDcs = useCallback(async () => {
    setLogging(true);
    try {
      const r = (await api('stageLogBatch', { body: { dcOnly: true } })).entity;
      toast(
        r.draftIds.length
          ? { key: 'time:log-batch', tone: 'success', title: 'DC batch ready to apply', body: 'Only your DC requests are on it. It is under Sending: Review & apply, then send it to Org62 via Slackbot.', action: { label: 'Review & apply', onClick: () => openCanvas(r.draftIds[0]!) } }
          : { key: 'time:log-batch', tone: 'info', title: 'No DC requests waiting', body: 'They may already be in a batch waiting for your Apply (Deals ▸ DCs).' },
      );
    } catch (err) {
      toast({ key: 'time:log-batch-err', tone: 'error', durationMs: null, title: "Couldn't build the batch", body: errorText(err, 200) });
    } finally {
      setLogging(false);
    }
  }, [openCanvas]);

  // Tell Slackbot for every created canvas at once (⌘K): each one's own prompt, copied in one go
  const confirm = useCallback(
    async (s: Q4Step) => {
      const ok = await copyText(confirmPrompt(s, wording, week.canvas.label, rows));
      if (ok) markCopied(s.ids.length);
      // 2026-11-13 audit C4: the app re-checks Org62 for each of these canvases about 5, 15, 30 and 60 min from now
      if (ok) for (const c of s.canvases ?? []) void checkCanvas(c, 'copied');
      const n = s.canvases?.length ?? 0;
      toast({
        key: 'slackbot-prompt',
        tone: ok ? 'success' : 'error',
        title: ok ? `Slackbot prompt copied: ${plural(s.ids.length, 'row')}${n > 1 ? ` in ${n} batches` : ''}` : "Couldn't copy the prompt",
        body: ok ? 'Paste it to Slackbot yourself; it runs the batch in Org62. Nothing was sent from here.' : 'Open the batch in Slack and send it to Org62 via Slackbot instead.',
        undo: ok ? { label: 'Not yet', run: () => markCopied(null) } : undefined,
      });
    },
    [wording, week.canvas.label, rows, markCopied, checkCanvas],
  );

  // ⌘↵: log the ready rows, else the Sending lane's first batch waiting on you
  const primary: { kind: 'log' } | { kind: 'batch'; batch: SendingBatch } | null = anyReady ? { kind: 'log' } : nextBatch ? { kind: 'batch', batch: nextBatch } : null;
  const runPrimary = (): false | void => {
    if (!primary) return false;
    // the same as the button: the ticked ones, or everything ready; never while the use cases and updates are counted
    if (primary.kind === 'log') {
      if (counting) return false;
      onReview();
    } else if (primary.batch.next === 'send') {
      const c = primary.batch.canvas;
      void copySlackbotPrompt(canvasPrompt(c, wording), c.title).then((ok) => {
        if (ok) void checkCanvas(c, 'copied');
      });
    } else openCanvas(primary.batch.canvas.draftId);
  };
  useKeyBinding('mod+enter', runPrimary, { scope, enabled: !!primary });

  const run = (s: Q4Step) => {
    if (s.id === 'approve') void approveAll(s.ids);
    else if (s.id === 'submit') onReview();
    else if (s.id === 'dcs') void logDcs();
    else if (s.id === 'outbox' && s.draftIds?.length) openCanvas(s.draftIds[0]!);
    else if (s.id === 'confirm') void confirm(s);
    else onShow(s.ids);
  };
  const commands = useMemo<Command[]>(
    () => [
      ...stages.flatMap((st) => [st.step, ...st.secondary]).filter((s): s is Q4Step => !!s).map((s) => ({ id: `time.q4.${s.id}`, title: `${label} log: ${s.verb}`, subtitle: s.why, group: 'Time', run: () => run(s) })),
      ...(lastCanvas?.url ? [{ id: 'time.last-canvas', title: 'Open the last batch', subtitle: lastCanvas.title, group: 'Time', run: () => window.open(lastCanvas.url!, '_blank', 'noopener,noreferrer') }] : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stages.map((s) => `${s.id}:${s.state}:${s.rows}:${s.secondary.map((x) => x.ids.length).join(',')}`).join('|'), label, lastCanvas?.url],
  );
  useCommands(commands);

  // F3 (R2-9): lane 2 has no "Approve N now": a proposed row waiting on approval is lane 1's (Check and approve), and
  // the ⌘K command above still runs it
  const dcsStep = steps.find((s) => s.id === 'dcs');
  const secondaryOn = !anyReady && !!dcsStep;
  // D-58: DC requests ride along on the canvas (D-70: use cases are rows of their own above, no longer riders)
  const along = ready.dcs ? (
    <span>
      {anyReady ? 'Riding along on it: ' : 'Waiting for your next batch: '}
      <AppLink href="/deals/dcs" className="font-bold text-link hover:underline" data-testid="q4-dcs-link">
        {ready.dcs === 1 ? 'your DC request' : `your ${ready.dcs} DC requests`}
      </AppLink>
    </span>
  ) : null;
  const secondary = (
    <>
      {!anyReady && dcsStep ? (
        <Button size="xs" variant={primary ? 'quiet' : 'secondary'} onClick={() => run(dcsStep)} loading={logging} title={dcsStep.why} data-testid="q4-dcs">
          {dcsStep.verb}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="@container/logit flex min-w-0 flex-col gap-5" data-guide="log-steps">
      {/* C5: lane 2, Ready to log (./ReadyLane.tsx): ticks on the lane, one "Log N · h" stages one batch for your Apply */}
      <section aria-labelledby={log ? undefined : 'time-ready-h'} className="min-w-0" data-testid="q4-ready" data-step="ready">
        <ReadyLane log={log} header={!log} ready={readyRows} useCases={readyUcs} updates={readyUps} pick={pick} dryRun={dryRun} loadFresh={loadFresh} onOpen={(id) => onOpen?.(id)} tz={tz} />
        {secondaryOn || along ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-caption text-muted">
            {secondary}
            {along}
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 text-caption text-muted">
        {/* C7: the lane's own line says dry run; this one said it twice */}
        {log ? null : <span>{dryRun ? 'Dry run: Apply shows the payload and creates nothing.' : 'Apply creates one batch; Slackbot writes Org62.'}</span>}
        {/* F3 (R2-4): no "Last batch" line here; Sending owns the batch's life */}
        {canvasUrl ? (
          <a href={canvasUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 font-bold text-link hover:underline">
            Your Slackbot work order <Icon name="new_window" size="xs" />
          </a>
        ) : null}
      </div>
      {primary ? (
        <span className="sr-only" aria-live="polite">
          {primary.kind === 'log' ? `Next: log ${plural(readyRows.length + readyUcs.length + readyUps.length, 'row')} to Slackbot` : `Next: ${NEXT_LABEL[primary.batch.next!]} (${primary.batch.label})`}
        </span>
      ) : null}
    </div>
  );
}
