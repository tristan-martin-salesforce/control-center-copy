'use client';
/**
 * To log (?view=log, the default; D-87, D-102): what the app can log for me, and what it needs from me first. Three
 * lanes on the kit LanePage (C7): lane 1 left, lanes 2 and 3 stacked right while the right panel is closed and main is
 * at least 1,100 px wide; one column with lane pills otherwise.
 *
 *   header   the quarter in one sentence ("Q4 FY27 · 27.5 of 60 h in Org62 · on pace · due Thu 12:00 ▸ History"),
 *            a List / Week toggle. The full quarter card is History's (./QuarterHeader.tsx).
 *   1 Fix or approve   #time-needs   (./FixLane.tsx): rows that can't log yet, in two bands: Accept (a sure suggestion,
 *                                    the header's "Accept N suggestions" takes only these) and Review (a guess or no
 *                                    suggestion: grayed, never in Accept N); then "Use cases with a question" (C11)
 *   2 Ready for Org62  #time-ready   (./ReadyLane.tsx inside LogIt): one batch (D-47) in groups: Time rows by day, DCs to
 *                                    claim (#time-dcs), Use cases (#time-usecases), Events in Org62; header counts each
 *                                    kind, "Log N rows · 3 DCs · 29 use cases" (the one filled button)
 *   3 Sending          #time-runs    (./SendingLane.tsx): one line per batch; rows not found in Org62 under their batch
 *   A time answer that sets an opp re-runs the DC suggestions (useDcRipple), so its DC shows in lane 2 in the same visit.
 *
 * Every lane count is lanesOf's (./lanes-derive.ts). The page does not mount the "Needs you here" slice: its content
 * is the slice (D-102 amends D-86). `&show=week` is the Week (./WeekView.tsx); `&review=1` the Review page (ReadyLane
 * at full width). Old views land here at their anchor (./views.ts). Human hours only: agent time is never totalled.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEntry } from '@/contract';
import { api } from '@/client/api';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { useApi } from '@/client/hooks';
import { useCommands } from '@/client/keyboard';
import { usePersona } from '@/client/persona';
import { clearChatContext, setChatContext } from '@/components/chat';
import { ContextPage } from '@/components/deals/context-frame';
import { LanePage, type Lane } from '@/components/kit';
import { AppLink } from '@/components/shell/AppLink';
import { navigate } from '@/components/shell/router';
import { featureActive } from '@/personas/gates';
import { PanelBoundary, SegmentedToggle, Skeleton } from '@/ui';
import { ActivityHead, ActivityNeedsSlot } from './ActivityHead';
import { ActivityTabs } from './ActivityTabs';
import { answeredRows, clearAnswered } from './bulk';
import { q4Range } from './derive';
import { fixLane } from './fix-derive';
import { FixAcceptAll, FixLane } from './FixLane';
import { unsettledIds } from './history-derive';
import { lanesOf } from './lanes-derive';
import { fixMoreLine, reviewPickRows, settleLineFor } from './review-derive';
import { laneCount } from './ready-derive';
import { sendingOf } from './sending-derive';
import { SendingLane, sendingLaneHeader } from './SendingLane';
import { LogIt, useWorkOrderCanvasUrl } from './Q4Log';
import { useQuarterPath, useRowNav } from './quarter-hooks';
import { quarterSentence } from './QuarterHeader';
import { ReadyLane, ReadyLogButton } from './ReadyLane';
import { UseCaseCandidates } from './UseCaseCandidates';
import { UseCaseList, UseCaseQuestions } from './UseCasesView';
import { UseCaseSync } from './UseCaseSync';
import { useReadyLog } from './use-ready-log';
import { hrefForAnchor, hrefForReview, hrefForView, hrefForWeek, LOG_ANCHORS, type ActivityRoute, type LogShow } from './views';
import { WeekView } from './WeekView';

const SCOPE = 'page:time';

/** Scroll to the section an old view (or a count) points at, once it is on the page. */
function useAnchor(anchor: string | null, ready: boolean) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    const id = anchor ?? (typeof window !== 'undefined' ? window.location.hash.slice(1) : '') ?? '';
    if (!id || !ready || done.current === id) return;
    const el = document.getElementById(id);
    if (!el) return;
    done.current = id;
    el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  });
}

export function ToLogView({ route }: { route: ActivityRoute }) {
  const persona = usePersona();
  const health = useApi('getHealth');
  const { cur, rows, path, truth, gap, markCopied, wording, tz, now } = useQuarterPath();
  const { openRow, showRows } = useRowNav(rows);
  const dryRun = health.data?.dryRun ?? true;
  const settle = settleLineFor(persona);
  const vdpOn = featureActive(persona, 'vdp');
  const dcOn = featureActive(persona, 'dealContributions');
  const ucs = useApi('getUseCaseLandings', undefined, { enabled: vdpOn });
  const ups = useApi('getEventUpdates', undefined);
  const ucQuestions = (ucs.data?.items ?? []).filter((x) => x.question);
  const readyUcs = useMemo(() => (vdpOn ? (ucs.data?.items ?? []).filter((x) => x.ready) : []), [vdpOn, ucs.data]);
  const readyUps = useMemo(() => (ups.data?.updates ?? []).filter((u) => u.state !== 'dismissed'), [ups.data]);
  const ucToAdd = useApi('getUseCaseCandidates', undefined, { enabled: vdpOn }).data?.counts.toAdd ?? 0;
  // C11: use cases that need me (a question, or noticed and not added yet) are lane 1's; ready ones are lane 2's
  const ucNeedN = vdpOn ? ucToAdd + ucQuestions.length : 0;

  const byId = useMemo(() => new Map(rows.map((e) => [e.id, e] as const)), [rows]);
  const readyRows = useMemo(() => (path?.readyIds ?? []).map((id) => byId.get(id)).filter((e): e is ActivityEntry => !!e).sort((a, b) => a.start.localeCompare(b.start)), [path?.readyIds, byId]);
  const notFound = useMemo(() => path?.needs.groups.find((g) => g.kind === 'org62')?.rows ?? [], [path]);
  const needOpp = useMemo(() => path?.needs.groups.find((g) => g.kind === 'opp')?.rows ?? [], [path]);
  // F5 (R2-6): Review is lane 2 at full width; of lane 1's pick-an-opp rows it lists only those a pick ticks in place
  const reviewPick = useMemo(() => reviewPickRows(needOpp, settle, wording.taskType), [needOpp, settle, wording.taskType]);

  // C1 (AX-2): one count per lane (./lanes-derive.ts); the tab badge is fix + sending failures
  // C10: a batch whose rows are all checked or settled (logged again / left out) is finished: History's, not Sending's
  const unsettled = useMemo(() => unsettledIds(rows), [rows]);
  const lanes = useMemo(() => (path ? lanesOf({ path, rows, canvases: cur.data?.logCanvases, unsettled }) : null), [path, rows, cur.data?.logCanvases, unsettled]);
  const needsN = lanes?.badge ?? 0;
  const fix = useMemo(() => (path ? fixLane({ needs: path.needs, internal: path.internal, taskTypeRequired: wording.taskType, settle }) : null), [path, wording.taskType, settle]);
  const sending = useMemo(() => sendingOf({ canvases: cur.data?.logCanvases, notFound: [...notFound], weekStart: cur.data?.weekStart, tz, unsettled }), [cur.data?.logCanvases, cur.data?.weekStart, notFound, tz, unsettled]);

  const canvasUrl = useWorkOrderCanvasUrl();
  useCommands([
    ...(canvasUrl ? [{ id: 'time.canvas', title: 'Open your Slackbot work order', group: 'Activity', run: () => window.open(canvasUrl, '_blank', 'noreferrer') }] : []),
    { id: 'time.review', title: 'Activity: review what to log', group: 'Activity', run: () => navigate(hrefForReview(persona)) },
    { id: 'time.week', title: 'Activity: this week, day by day', group: 'Activity', run: () => navigate(hrefForWeek(null, persona)) },
  ]);
  useEffect(() => () => clearChatContext({ kind: 'activity_entry', id: 'time' }), []);
  useEffect(() => {
    if (cur.data) setChatContext({ kind: 'activity_entry', id: 'time', label: `Activity · ${cur.data.quarter.label}` });
  }, [cur.data]);
  useAnchor(route.anchor, !!path);

  const loadFresh = useCallback(async () => {
    if (!cur.data) return rows as ActivityEntry[];
    const log = await api('getActivityLog', { query: q4Range(cur.data) });
    return log.entries;
  }, [cur.data, rows]);
  // lane 2's state lives here so LanePage's header carries its one "Log N · h" (one header, one button)
  const readyLog = useReadyLog({ ready: readyRows, useCases: readyUcs, updates: readyUps, timeRows: rows, taskTypeRequired: wording.taskType, loadFresh });
  useDcRipple(rows, dcOn, !!path);

  const tabs = <ActivityTabs view="log" toLog={needsN || undefined} />;
  const toggle = (
    <SegmentedToggle<LogShow>
      label="Show"
      value={route.show}
      onChange={(v) => navigate(v === 'week' ? hrefForWeek(null, persona) : hrefForView('log', persona))}
      options={[
        { value: 'list', label: 'List' },
        { value: 'week', label: 'Week' },
      ]}
    />
  );
  if (route.show === 'week') return <WeekView tabs={tabs} toggle={toggle} />;

  const quarter = cur.data?.quarter.label ?? null;
  if (route.review)
    return (
      <ContextPage label="Activity" className="cc-scroll overflow-y-auto [scrollbar-gutter:stable]">
        <ActivityHead tabs={tabs} sentence={path ? `Review what to log · ${quarter ?? 'this quarter'}. Tick what goes, pick where the unsure ones go, then log them as one batch.` : 'Loading what is ready…'} />
        {path && cur.data ? (
          <>
            {fixMoreLine(reviewPick.more) ? (
              <p className="text-body text-muted tabular-nums" data-testid="review-fix-more">
                {`${fixMoreLine(reviewPick.more)} `}
                <AppLink href={hrefForAnchor(LOG_ANCHORS.needs, persona)} className="font-bold text-link hover:underline">
                  ▸ Fix or approve
                </AppLink>
              </p>
            ) : null}
            <ReadyLane full ready={readyRows} needOpp={reviewPick.pick} useCases={readyUcs} updates={readyUps} pick={{ taskTypeRequired: wording.taskType, taskTypes: wording.taskTypes, internalActivity: wording.internal }} dryRun={dryRun} loadFresh={loadFresh} onOpen={openRow} tz={tz} onExit={() => navigate(hrefForView('log', persona))} />
          </>
        ) : (
          <Skeleton variant="block" className="h-96 w-full" />
        )}
      </ContextPage>
    );

  const sentence =
    truth && cur.data ? (
      <span data-testid="to-log-sentence">
        {quarterSentence(truth, cur.data.quarter.due, now, tz)}{' '}
        <AppLink href={hrefForView('history', persona)} className="font-bold text-link hover:underline" data-testid="to-log-history">
          ▸ History
        </AppLink>
      </span>
    ) : (
      'Loading the quarter…'
    );
  const sendingHead = sendingLaneHeader(sending.header);
  const useCaseFooter = <UseCaseReference />;
  const pageLanes: Lane[] =
    path && cur.data && fix && lanes
      ? [
          {
            id: 'fix',
            span: 'left',
            collapsed: !fix.count && !ucNeedN,
            // lane 2's Log is the page's one filled button: lane 1's Accept-all is a secondary one here
            header: { title: 'Fix or approve', count: fix.count, action: <FixAcceptAll model={fix} taskTypeRequired={wording.taskType} variant="secondary" /> },
            body: (
              <div id={LOG_ANCHORS.needs} data-testid="time-needs" className="min-w-0 scroll-mt-14">
                <FixLane frame={false} needs={path.needs} internal={path.internal} tz={tz} settle={settle} taskTypeRequired={wording.taskType} taskTypes={wording.taskTypes} internalActivity={wording.internal} onOpen={openRow} />
                {vdpOn && ucNeedN ? (
                  // they need me, not Org62: a question to answer, or a use case the app noticed to add (or not)
                  <div className="flex min-w-0 flex-col gap-3 border-t border-line px-3 py-3" data-testid="time-needs-ucs">
                    {ucQuestions.length ? (
                      <>
                        <h3 className="text-body font-bold text-fg-heading">{`Use cases with a question · ${ucQuestions.length}`}</h3>
                        <UseCaseQuestions items={ucQuestions} />
                      </>
                    ) : null}
                    <div className="flex min-w-0 flex-col gap-4" data-testid="time-needs-uc-add">
                      <UseCaseCandidates />
                    </div>
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            id: 'ready',
            span: 'right',
            collapsed: !lanes.ready.rows && !readyLog.extras.length,
            // C11: everything bound for Org62 in one lane and one batch (D-47): time rows, DCs, use cases, Event changes
            header: { title: 'Ready for Org62', count: laneCount(readyLog.rows, readyLog.extras), action: <ReadyLogButton log={readyLog} /> },
            body: (
              <div id={LOG_ANCHORS.ready} data-testid="time-logit" className="min-w-0 scroll-mt-14">
                <LogIt log={readyLog} path={path} week={cur.data} rows={rows} now={now} tz={tz} dryRun={dryRun} onShow={showRows} onOpen={openRow} markCopied={markCopied} onReview={() => navigate(hrefForReview(persona))} scope={SCOPE} />
              </div>
            ),
          },
          {
            id: 'sending',
            span: 'right',
            collapsed: !lanes.sending.batches && !lanes.sending.failed,
            header: { ...sendingHead, failure: lanes.sending.failed ? sendingHead.failure : undefined },
            body: <SendingLane header={false} canvases={cur.data.logCanvases} notFound={notFound} weekStart={cur.data.weekStart} tz={tz} unsettled={unsettled} onOpenRow={openRow} id={LOG_ANCHORS.runs} gap={gap} />,
          },
        ]
      : [];
  return (
    // D-102 amends D-86: this page's content is the queue's slice, so it does not mount "Needs you here"
    <ActivityNeedsSlot value={null}>
      <ContextPage label="Activity" className="cc-scroll overflow-y-auto [scrollbar-gutter:stable]">
        <ActivityHead tabs={tabs} sentence={sentence} actions={toggle} />
        <div className="flex min-w-0 shrink-0 flex-col gap-4" data-testid="to-log">
          <PanelBoundary name="time">
            {pageLanes.length ? <LanePage lanes={pageLanes} label="To log lanes" /> : <Skeleton variant="block" className="h-96 w-full" />}
            {/* the Org62-side use cases only I can settle, and every use case: reference under the lanes, not a lane */}
            {vdpOn && pageLanes.length ? useCaseFooter : null}
          </PanelBoundary>
        </div>
      </ContextPage>
    </ActivityNeedsSlot>
  );
}

/**
 * Under the lanes: the use cases only I can settle on the Org62 side and every use case, mounted when opened (they
 * read the whole VDP and Org62 mirror; nothing in them is bound for the next batch until I choose it there).
 */
function UseCaseReference() {
  const [open, setOpen] = useState(false);
  return (
    <details className="min-w-0 rounded-lg border border-line bg-surface px-4 py-2" data-testid="use-cases-all" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer py-1 text-body font-bold text-link">Use cases to settle in Org62, and every use case</summary>
      {open ? (
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          <UseCaseSync />
          <UseCaseList />
        </div>
      ) : null}
    </details>
  );
}

/**
 * C11, time answers ripple to DCs: when a time row gets an opp it had no row on before (Accept or a pick), re-run the
 * DC suggestions once the PATCH has landed, so that opp's DC shows in lane 2's DCs group in the same visit. The first
 * read only records the opps; nothing runs while deal contributions are off.
 */
export function newOpps(
  prev: ReadonlySet<string> | null,
  rows: readonly Pick<ActivityEntry, 'id' | 'oppId' | 'internal'>[],
  answered?: ReadonlyMap<string, 'pending' | 'landed'>,
): { opps: Set<string>; added: string[]; landed: string[] } {
  const live = rows.filter((e) => e.oppId && !e.internal);
  // R3-9: only the user's own answers (Accept or a pick, once the PATCH has landed) ripple; a refetch that brings a
  // scanner's opp is only seen. A pending answer's optimistic row is not seen yet, so it still counts as new on landing.
  const pending = (e: { id: string }) => answered?.get(e.id) === 'pending';
  const mine = answered ? live.filter((e) => answered.get(e.id) === 'landed') : live;
  const added = prev ? [...new Set(mine.map((e) => e.oppId!))].filter((o) => !prev.has(o)) : [];
  // the opps seen only grow: a refetch that briefly holds fewer rows never makes the same opps "new" again
  const now = live.filter((e) => !pending(e)).map((e) => e.oppId!);
  return { opps: new Set([...(prev ?? []), ...now]), added, landed: answered ? mine.map((e) => e.id) : [] };
}

function useDcRipple(rows: readonly ActivityEntry[], on: boolean, loaded: boolean) {
  const refresh = useOptimisticMutation({ route: 'refreshDcSuggestions', topics: ['time'] });
  const seen = useRef<Set<string> | null>(null);
  const { mutate } = refresh;
  useEffect(() => {
    if (!on || !loaded) return;
    const { opps, added, landed } = newOpps(seen.current, rows, answeredRows());
    seen.current = opps;
    clearAnswered(landed);
    if (added.length) mutate({ body: {} });
  }, [rows, on, loaded, mutate]);
}
