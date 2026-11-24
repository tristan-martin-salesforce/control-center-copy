'use client';
/**
 * The quarter To log works on (moved from TimePage): this week's payload (its batches, the quarter), the quarter's
 * rows, and from them the path (what needs me, the steps), the header's numbers and the logging gap.
 */
import { useCallback, useMemo } from 'react';
import type { ActivityEntry, TimeWeek } from '@/contract';
import { useApi } from '@/client/hooks';
import { TO_LOG_NEED_STATUSES, toLogRange } from '@/engines/activity/to-log-rows';
import { useDetails } from '@/components/deals/context-frame';
import { usePromptWording } from '@/components/domain/ResultLinks';
import { navigate } from '@/components/shell/router';
import { useNow, useTimeZone } from '@/ui';
import { loggingGap, q4Range, quarterRowsOf, type QuarterRows } from './derive';
import { logPath, mondayOf, quarterTruth } from './path-derive';
import { useConfirmCopied, useDcPending, useUcPending } from './Q4Log';
import { hrefForWeek } from './views';

/**
 * The rows the path works on, To log's one row set (src/engines/activity/to-log-rows.ts, F1, R2-1): the fiscal quarter
 * so far and at least the last 3 weeks (q4Range), widened back to the quarter of the oldest row that still needs you,
 * the same set Home's queue row and the sidebar count. Two reads of GET /time/log: the rows that can need you
 * (unbounded, by status) to find the start, then the whole range; this week's payload on top (deduped by id). The log
 * also carries the current quarter's verified hours (its quarter totals ignore the range).
 */
export function useQuarterRows(current: TimeWeek | undefined, taskTypeRequired = true): QuarterRows {
  const base = useMemo(() => (current ? q4Range(current) : null), [current]);
  const needy = useApi('getActivityLog', { query: base ? { to: base.to, status: TO_LOG_NEED_STATUSES } : {} }, { enabled: !!base, staleTime: 60_000 });
  const range = useMemo(
    () => (base && (needy.data || needy.isError) ? toLogRange({ rows: needy.data?.entries ?? [], canvases: current?.logCanvases, taskTypeRequired, base }) : null),
    [base, needy.data, needy.isError, current?.logCanvases, taskTypeRequired],
  );
  const log = useApi('getActivityLog', { query: range ?? {} }, { enabled: !!range, staleTime: 60_000 });
  return useMemo(() => quarterRowsOf({ log: log.data, logFailed: log.isError, week: current }), [log.data, log.isError, current]);
}

export function useQuarterPath() {
  const wording = usePromptWording();
  const tz = useTimeZone();
  const now = useNow().toISOString();
  const cur = useApi('getTime', { query: { week: undefined } });
  const settings = useApi('getSettings');
  const { rows, verifiedH, loaded } = useQuarterRows(cur.data, wording.taskType);
  const [copiedFor, markCopied] = useConfirmCopied();
  const dcPending = useDcPending();
  const ucPending = useUcPending();
  const approveComplete = settings.data?.time?.logging?.approveComplete ?? true;
  const path = useMemo(
    // 2026-11-13 audit C2: the path waits for the DC and use-case counts (null while they load): no "Nothing ready" flash,
    // and for the quarter's rows (on this week's alone the button named one row while 71 were ready)
    () => (cur.data && loaded && dcPending !== null && ucPending !== null ? logPath({ rows, week: cur.data, nowIso: now, tz, confirmCopiedFor: copiedFor, dcPending, ucPending, taskTypeRequired: wording.taskType, approveComplete, recordTypeName: wording.recordTypeName }) : null),
    [cur.data, loaded, rows, now, tz, copiedFor, dcPending, ucPending, wording.taskType, wording.recordTypeName, approveComplete],
  );
  const truth = useMemo(() => (cur.data && path ? quarterTruth({ rows, week: cur.data, nowIso: now, tz }, path, verifiedH) : null), [cur.data, path, rows, now, tz, verifiedH]);
  // 2026-11-13 audit C3: approved hours Org62 has not confirmed, over the quarter's rows (not only this week's)
  const gap = useMemo(() => (cur.data && loaded ? loggingGap({ entries: rows, org62: cur.data.org62, canvas: cur.data.canvas }, now) : null), [cur.data, loaded, rows, now]);
  return { cur, rows, path, truth, gap, dcPending, ucPending, markCopied, wording, tz, now };
}

/** Open a row in the docked panel; "show it" opens To log's Week on the row's week with the row lit. */
export function useRowNav(rows: readonly ActivityEntry[]) {
  const { open: openDetails } = useDetails();
  const byId = useMemo(() => new Map(rows.map((e) => [e.id, e] as const)), [rows]);
  const openRow = useCallback(
    (id: string) => {
      const e = byId.get(id);
      openDetails({ kind: 'activity_entry', id, label: e?.description || 'Activity row' });
    },
    [byId, openDetails],
  );
  const showRows = useCallback(
    (list: string[]) => {
      const e = list.map((id) => byId.get(id)).find(Boolean);
      if (!e) return;
      navigate(`${hrefForWeek(mondayOf(e.date))}&row=${encodeURIComponent(e.id)}`);
    },
    [byId],
  );
  return { openRow, showRows };
}
