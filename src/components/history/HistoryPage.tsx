'use client';
/**
 * History (B-081, design v2): a calendar of past days; click a day to see what was done. One focal point: the
 * selected day's record. Beside it the month calendar, each cell a light summary (your hours, items finished) so you
 * can see where to click; quiet days stay quiet. Built from stored history only (no view snapshots, B-082).
 *
 * GET /history?month · GET /history/:day. URL: ?day=YYYY-MM-DD (default today) and ?month=YYYY-MM (default the
 * day's month). Keys: ←/→ previous / next day, j/k move through the day's rows, Enter opens a row in the docked
 * panel, Esc closes it. ⌘K: previous / next day and month, Today. The page never scrolls: the calendar fills its
 * pane, the day's sections scroll inside theirs, and from a 1,500 px main area they split into two columns.
 */
import { usePathname, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryDay, HistoryMonth, LiveTopic } from '@/contract';
import { api, queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useCommands, useKeyBinding } from '@/client/keyboard';
import { subscribeLive } from '@/client/live';
import { ContextHead, ContextPage, Pane, SectionHead, useContextKeys, useDetails, useMainWidth } from '@/components/deals/context-frame';
import { useContextPanels } from '@/components/deals/register-panels';
import { Button, EmptyState, IconButton, PanelBoundary, PanelError, Skeleton, usePanelState, useTimeZone } from '@/ui';
import { OnsiteChip } from '@/components/time/OnsiteChips';
import { dayHasRows, dayRows, daySentence, longDay, mondayOf, monthOfDay, SECTION_ORDER, shiftDay, SPLIT_LEFT, SPLIT_RIGHT, summaryBits, type RowRef } from './derive';
import { HistoryCalendar } from './HistoryCalendar';
import { DaySections } from './HistoryDaySections';
import { CalendarSkeleton, HistoryBodySkeleton } from './HistorySkeleton';
import { navigate } from '@/components/shell/router';

const SCOPE = 'page:history';
const SPLIT_ORDER = [...SPLIT_LEFT, ...SPLIT_RIGHT];
/** Changes that can add to a day's record: refetch the calendar and the day (the `time` topic refetches anyway). */
const LIVE_TOPICS = new Set<LiveTopic>(['item', 'items', 'draft', 'outbox', 'agents', 'tools', 'tool_run', 'calendar', 'today']);

export function HistoryPage() {
  useContextPanels();
  const params = useSearchParams();
  const pathname = usePathname();
  const qc = useQueryClient();
  const tz = useTimeZone();
  const mainW = useMainWidth();
  const split = mainW >= 1500;
  const { open: openDetails, openId } = useDetails();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const dayParam = params.get('day');
  const monthParam = params.get('month');
  const month = useApi('getHistoryMonth', { query: { month: monthParam ?? (dayParam ? monthOfDay(dayParam) : undefined) } }, { placeholderData: keepPreviousData });
  const today = month.data?.today ?? null;
  const day = dayParam ?? today;
  const dayQ = useApi('getHistoryDay', { params: { day: day ?? '1970-01-01' } }, { enabled: !!day, placeholderData: keepPreviousData });
  const d: HistoryDay | undefined = dayQ.data;

  const state = usePanelState('history.page', { loading: month.isLoading || (!!day && dayQ.isLoading), error: month.data ? null : month.error ?? dayQ.error });

  const go = useCallback(
    (next: { day?: string | null; month?: string | null }) => {
      const sp = new URLSearchParams(params.toString());
      for (const k of ['day', 'month'] as const) {
        const v = next[k];
        if (v === undefined) continue;
        if (v) sp.set(k, v);
        else sp.delete(k);
      }
      if (sp.get('day') && sp.get('day') === today && !sp.get('month')) sp.delete('day');
      navigate(`${pathname}${sp.size ? `?${sp}` : ''}`, { replace: true });
    },
    [params, pathname, today],
  );
  const pickDay = useCallback((next: string) => go({ day: next, month: null }), [go]);
  const prevDay = useCallback(() => {
    if (day) pickDay(shiftDay(day, -1));
  }, [day, pickDay]);
  const nextDay = useCallback(() => {
    if (day && today && shiftDay(day, 1) <= today) pickDay(shiftDay(day, 1));
  }, [day, today, pickDay]);
  const goToday = useCallback(() => go({ day: null, month: null }), [go]);
  const shownMonth = month.data?.month ?? null;
  const prevMonth = useCallback(() => {
    if (month.data) go({ month: month.data.prevMonth });
  }, [month.data, go]);
  const nextMonth = useCallback(() => {
    if (month.data?.nextMonth) go({ month: month.data.nextMonth });
  }, [month.data, go]);

  // a new day starts with nothing selected
  useEffect(() => setSelected(null), [day]);

  // live: anything that can add to a day's record refetches the calendar and the open day
  useEffect(
    () =>
      subscribeLive((e) => {
        if (!LIVE_TOPICS.has(e.topic)) return;
        void qc.invalidateQueries({ queryKey: ['time', 'getHistoryMonth'] });
        void qc.invalidateQueries({ queryKey: ['time', 'getHistoryDay'] });
      }),
    [qc],
  );

  // Activity rows open the Time page's Details renderer, which reads its row from a cached Time week: load the
  // weeks this day's rows live in (the day itself, and the work days of rows logged to Org62 today).
  // A row clicked before its week arrives waits for it (at most 1.5 s), so the panel never says "Not loaded here".
  const activityWeeks = useCallback(() => {
    if (!d) return Promise.resolve();
    const weeks = [...new Set([d.day, ...d.org62.map((o) => o.workDay)].map(mondayOf))];
    const load = Promise.all(weeks.map((week) => qc.ensureQueryData({ queryKey: queryKey('getTime', { query: { week } }), queryFn: ({ signal }) => api('getTime', { query: { week } }, { signal }), staleTime: 60_000 }))).catch(() => undefined);
    return Promise.race([load, new Promise<void>((r) => setTimeout(r, 1500))]);
  }, [d, qc]);
  useEffect(() => void activityWeeks(), [activityWeeks]);

  const order = split ? SPLIT_ORDER : SECTION_ORDER;
  const refs = useMemo(() => (d ? dayRows(d, order) : []), [d, order]);
  const byRow = useMemo(() => new Map<string, RowRef>(refs.map((r) => [r.rowId, r])), [refs]);
  const ids = useMemo(() => refs.map((r) => r.rowId), [refs]);
  const openRow = useCallback(
    (rowId: string) => {
      const r = byRow.get(rowId);
      if (!r) return;
      setSelected(rowId);
      if (r.entity.kind === 'activity_entry') void activityWeeks().then(() => openDetails(r.entity));
      else openDetails(r.entity);
    },
    [byRow, openDetails, activityWeeks],
  );

  const ready = state === 'ready' && !!d;
  const { live } = useContextKeys({ scope: SCOPE, rootRef, ids, selected: selected && ids.includes(selected) ? selected : null, setSelected, enabled: ready, onOpen: openRow });
  useKeyBinding('left', () => prevDay(), { scope: SCOPE, enabled: ready && live });
  useKeyBinding('right', () => nextDay(), { scope: SCOPE, enabled: ready && live });

  useCommands([
    { id: 'history.prevDay', title: 'Previous day', group: 'History', shortcut: 'left', run: prevDay },
    { id: 'history.nextDay', title: 'Next day', group: 'History', shortcut: 'right', disabled: !d?.nextDay, run: nextDay },
    { id: 'history.today', title: 'Today', group: 'History', run: goToday },
    { id: 'history.prevMonth', title: 'Previous month', group: 'History', run: prevMonth },
    { id: 'history.nextMonth', title: 'Next month', group: 'History', disabled: !month.data?.nextMonth, run: nextMonth },
  ]);

  const isToday = !!day && day === today;
  const thisMonth = !!today && shownMonth === monthOfDay(today);

  return (
    <ContextPage label="Journal">
      <ContextHead
        title="Journal"
        sentence={d ? daySentence(d) : 'Loading the day…'}
        actions={
          <div className="flex items-center gap-1">
            {/* the day's onsite chip (onsite lane): same signals and corrections as on Time */}
            {d?.onsite ? (
              <span className="mr-2">
                <OnsiteChip day={d.onsite} compact />
              </span>
            ) : null}
            <IconButton icon="chevronleft" label="Previous day" onClick={prevDay} disabled={!day} />
            <Button size="sm" variant="quiet" disabled={isToday && thisMonth} onClick={goToday}>
              Today
            </Button>
            <IconButton icon="chevronright" label="Next day" onClick={nextDay} disabled={!d?.nextDay} />
          </div>
        }
      />
      <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
        <PanelBoundary name="history">
          {state === 'error' ? (
            <PanelError title="Couldn't load history" error={month.error ?? dayQ.error ?? new Error('Forced error state')} onRetry={() => void Promise.all([month.refetch(), dayQ.refetch()])} />
          ) : state === 'loading' || !month.data ? (
            <HistoryBodySkeleton />
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[32rem_minmax(0,1fr)] gap-5 @max-[1300px]/main:grid-cols-[24rem_minmax(0,1fr)] @max-[1300px]/main:gap-4 @min-[2200px]/main:grid-cols-[38rem_minmax(0,1fr)]">
              <Pane
                aria-label="Calendar"
                scroll={false}
                bodyClassName="flex flex-col"
                head={
                  <SectionHead
                    title={month.data.label}
                    action={
                      <>
                        <IconButton icon="chevronleft" size="sm" label="Previous month" onClick={prevMonth} />
                        {!thisMonth ? (
                          <Button size="xs" variant="quiet" onClick={goToday}>
                            This month
                          </Button>
                        ) : null}
                        <IconButton icon="chevronright" size="sm" label="Next month" onClick={nextMonth} disabled={!month.data.nextMonth} />
                      </>
                    }
                  />
                }
              >
                {month.isPlaceholderData ? <CalendarSkeleton /> : <HistoryCalendar month={month.data} selected={day ?? ''} onSelect={pickDay} />}
                <MonthFooter month={month.data} />
              </Pane>
              {!d ? (
                <Pane aria-label="Day loading">
                  <Skeleton variant="row" count={6} className="px-5 pt-4" />
                </Pane>
              ) : d.future ? (
                <Pane aria-label={d.label}>
                  <EmptyState icon="recent" title={`${d.label} hasn't happened yet`} body="Pick today or an earlier day." />
                </Pane>
              ) : !dayHasRows(d) ? (
                <Pane aria-label={d.label}>
                  <EmptyState
                    icon="recent"
                    title={`Nothing recorded on ${longDay(d.day)}`}
                    body="A day fills in from what the app stores: closes, the activity log, meetings, Outbox dispatches and agent runs. Days before the first scan stay empty."
                  />
                </Pane>
              ) : split ? (
                <div className="grid min-h-0 min-w-0 grid-cols-2 gap-5">
                  <DayPane day={d} label={`${d.label}: outcomes`} sections={SPLIT_LEFT} tz={tz} selected={selected} openId={openId} rows={byRow} onOpen={openRow} />
                  <DayPane day={d} label={`${d.label}: time and context`} sections={SPLIT_RIGHT} tz={tz} selected={selected} openId={openId} rows={byRow} onOpen={openRow} />
                </div>
              ) : (
                <DayPane day={d} label={d.label} sections={SECTION_ORDER} tz={tz} selected={selected} openId={openId} rows={byRow} onOpen={openRow} />
              )}
            </div>
          )}
        </PanelBoundary>
      </div>
    </ContextPage>
  );
}

function DayPane(props: { day: HistoryDay; label: string; sections: typeof SECTION_ORDER; tz?: string; selected: string | null; openId: string | null; rows: Map<string, RowRef>; onOpen: (rowId: string) => void }) {
  const { label, ...rest } = props;
  const has = rest.sections.some((s) => dayRows(rest.day, [s]).length > 0 || (s === 'time' && rest.day.time.agentMin > 0));
  return (
    <Pane aria-label={label} bodyClassName="pt-1 pb-3" data-history-pane="">
      {has ? <DaySections {...rest} /> : <p className="px-5 py-4 text-body text-muted">Nothing else recorded.</p>}
    </Pane>
  );
}

function MonthFooter({ month }: { month: HistoryMonth }) {
  const bits = summaryBits(month.totals);
  return (
    <p className="shrink-0 border-t border-line px-5 py-2.5 text-caption text-muted">
      {bits.length ? `${month.totals.activeDays} active ${month.totals.activeDays === 1 ? 'day' : 'days'}: ${bits.join(' · ')}` : 'Nothing recorded this month yet.'}
    </p>
  );
}
