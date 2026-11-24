'use client';
/**
 * To log ▸ Week (`?show=week`, `&week=<Monday>` for another week): what the app found, week by week. The picker on top
 * (the quarter's weeks and the one before, each with the hours found and how much is in Org62; the arrows step), then
 * the week's Suggested (what the app proposed and where it is now, onsite days, Week at a glance) and its rows, day by
 * day, each editable in place. A week with nothing in it says what fills it, and the List toggle goes back.
 */
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePersona } from '@/client/persona';
import { useApi } from '@/client/hooks';
import { useCommands } from '@/client/keyboard';
import { clearChatContext, setChatContext } from '@/components/chat';
import { ContextPage, Pane, SectionHead, useContextKeys, useDetails } from '@/components/deals/context-frame';
import { dayLabel } from '@/components/domain/lib/time';
import { loggingProfile } from '@/engines/activity/persona';
import { navigate } from '@/components/shell/router';
import { Button, cn, EmptyState, IconButton, PanelBoundary, PanelError, Skeleton, useNow, usePanelState, useTimeZone } from '@/ui';
import { ActivityHead } from './ActivityHead';
import { ActivityTable } from './ActivityTable';
import { DEFAULT_WORK, fmtH, hhmmToMin, shiftWeek } from './derive';
import { rowsWord, weekSuggested } from './path-derive';
import { useQuarterPath } from './quarter-hooks';
import { SuggestedWeek } from './SuggestedWeek';
import { TimeBodySkeleton } from './TimeSkeleton';
import { hrefForAnchor, LOG_ANCHORS } from './views';
import { pickerRange, weekGroups, type WeekGroup } from './weeks-derive';

const SCOPE = 'page:time';

/** "Solutions Events" (SE), "Sales Events" (AE): the Org62 Events the persona logs. */
const loggedEventsLabel = (p: ReturnType<typeof usePersona>) => {
  const n = loggingProfile(p).recordTypeName;
  return n.endsWith('s') ? n : `${n}s`;
};

/** A section of the page: a title, a count and one muted line; no box. */
export function PathSection({ id, title, count, sub, testId, children }: { id: string; title: string; count?: string; sub?: ReactNode; testId?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} data-testid={testId} className="flex min-w-0 scroll-mt-4 flex-col gap-3 border-t border-line pt-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={`${id}-h`} className="text-lead font-bold text-fg-heading">
          {title}
        </h2>
        {count ? <span className="text-body text-muted tabular-nums">{count}</span> : null}
        {sub ? <span className="min-w-0 text-caption text-muted">{sub}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** The week picker: the quarter's weeks and the one before, each with the hours found and how much is in Org62. */
function WeekPicker({ groups, value, onPick }: { groups: WeekGroup[]; value: string; onPick: (monday: string) => void }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [value, groups.length]);
  if (!groups.length) return <Skeleton variant="block" className="h-16 w-full" />;
  return (
    <div ref={scroller} role="radiogroup" aria-label="Week" data-testid="weeks-picker" className="cc-scroll flex min-w-0 gap-4 overflow-x-auto pb-1">
      {groups.map((g) => (
        <div key={g.quarter} className="flex shrink-0 flex-col gap-1.5" role="group" aria-label={g.quarter}>
          <span className="text-caption font-bold text-muted">{g.quarter}</span>
          <div className="flex gap-1.5">
            {g.weeks.map((w) => {
              const on = w.monday === value;
              return (
                <button
                  key={w.monday}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-week={w.monday}
                  onClick={() => onPick(w.monday)}
                  title={`Week of ${w.label}: ${fmtH(w.hours)} found, ${fmtH(w.loggedH)} in Org62`}
                  className={cn('flex shrink-0 flex-col gap-1 rounded-lg border px-2.5 py-1.5 text-left', w.current ? 'w-32' : 'w-28', 'transition-colors focus-visible:outline-none focus-visible:shadow-focus', on ? 'border-accent bg-selected' : 'border-line bg-surface hover:bg-surface-muted')}
                >
                  <span className="flex min-w-0 items-baseline gap-1">
                    <span className="text-caption font-bold whitespace-nowrap text-fg-heading">{w.label}</span>
                    {w.current ? <span className="text-caption whitespace-nowrap text-muted">this week</span> : null}
                  </span>
                  <span className="text-caption text-muted tabular-nums">{w.hours ? `${w.loggedH} / ${fmtH(w.hours)}` : '—'}</span>
                  <span className="block h-1 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                    <i className="block h-full rounded-full bg-accent" style={{ width: `${w.pct}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function WeekView({ tabs, toggle }: { tabs: ReactNode; toggle: ReactNode }) {
  const persona = usePersona();
  const params = useSearchParams();
  const pathname = usePathname();
  const weekParam = params.get('week') ?? undefined;
  const rowParam = params.get('row');
  const tz = useTimeZone();
  const now = useNow().toISOString();
  const { open: openDetails } = useDetails();
  const q = useApi('getTime', { query: { week: weekParam } });
  const { cur, path } = useQuarterPath();
  const settings = useApi('getSettings');
  const wh = settings.data?.profile.workingHours;
  const work = useMemo(() => ({ start: hhmmToMin(wh?.start, DEFAULT_WORK.start), end: hhmmToMin(wh?.end, DEFAULT_WORK.end), days: wh?.days }), [wh?.start, wh?.end, wh?.days]);
  const range = cur.data ? pickerRange(cur.data.quarter.label, cur.data.weekEnd) : null;
  const pickerLog = useApi('getActivityLog', { query: range ?? {} }, { enabled: !!range, staleTime: 60_000 });
  const groups = useMemo(() => (cur.data ? weekGroups(pickerLog.data, cur.data.quarter.label, cur.data.weekStart) : []), [pickerLog.data, cur.data]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const week = q.data;
  const state = usePanelState('time.page', { loading: q.isLoading, error: q.data ? null : q.error, empty: !!week && week.entries.length === 0 && week.timeline.every((l) => l.blocks.length === 0) });
  const suggested = useMemo(() => (week && path ? weekSuggested(week.entries, path, cur.data?.logCanvases) : null), [week, path, cur.data?.logCanvases]);

  const goWeek = useCallback(
    (to: string | null) => {
      const sp = new URLSearchParams(params.toString());
      sp.set('show', 'week');
      sp.delete('row');
      if (to && to !== cur.data?.weekStart) sp.set('week', to);
      else sp.delete('week');
      navigate(`${pathname}?${sp}`, { replace: true });
    },
    [params, pathname, cur.data?.weekStart],
  );

  const ids = useMemo(() => (week ? [...week.entries].filter((e) => e.status !== 'dismissed').sort((a, b) => a.start.localeCompare(b.start)).map((e) => e.id) : []), [week]);
  const byId = useMemo(() => new Map((week?.entries ?? []).map((e) => [e.id, e] as const)), [week]);
  const openRow = useCallback(
    (id: string) => {
      const e = byId.get(id);
      if (!e) return;
      setSelected(id);
      openDetails({ kind: 'activity_entry', id, label: e.description || 'Activity row' });
    },
    [byId, openDetails],
  );
  const showRows = useCallback((list: string[]) => {
    const id = list[0];
    if (!id) return;
    setHighlight(id);
    setSelected(id);
    requestAnimationFrame(() => document.querySelector(`[data-activity-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    window.setTimeout(() => setHighlight(null), 2500);
  }, []);
  // ?row= (a "show it" from the list or a panel): the row lights up once its week is here
  const shownRow = useRef<string | null>(null);
  useEffect(() => {
    if (!rowParam || shownRow.current === rowParam || !byId.has(rowParam)) return;
    shownRow.current = rowParam;
    showRows([rowParam]);
  }, [rowParam, byId, showRows]);

  // a count's jump in the week's summary: what needs me lives on the list
  const jump = useCallback((to: string) => navigate(hrefForAnchor(to === 'needs' ? LOG_ANCHORS.needs : LOG_ANCHORS.ready, persona)), [persona]);

  useContextKeys({ scope: SCOPE, rootRef, ids, selected: selected && ids.includes(selected) ? selected : null, setSelected, enabled: state === 'ready', onOpen: openRow });

  useCommands([
    { id: 'time.prev', title: 'Previous week', group: 'Activity', run: () => week && goWeek(shiftWeek(week.weekStart, -1)) },
    { id: 'time.next', title: 'Next week', group: 'Activity', run: () => week && goWeek(shiftWeek(week.weekStart, 1)) },
    { id: 'time.this', title: 'This week', group: 'Activity', run: () => goWeek(null) },
  ]);

  useEffect(() => () => clearChatContext({ kind: 'activity_entry', id: 'time' }), []);
  useEffect(() => {
    if (week) setChatContext({ kind: 'activity_entry', id: 'time', label: `Activity · week of ${week.weekStart}` });
  }, [week]);

  const isThisWeek = !weekParam || weekParam === cur.data?.weekStart;
  const weekRange = week ? `${dayLabel(`${week.weekStart}T12:00:00Z`, 'UTC')} to ${dayLabel(`${week.weekEnd}T12:00:00Z`, 'UTC')}` : null;
  const sentence = weekRange ? `${weekRange}${isThisWeek ? ' · this week' : ''} · ${rowsWord(ids.length)}` : 'Loading the week…';

  return (
    <ContextPage label="Activity" className="cc-scroll overflow-y-auto [scrollbar-gutter:stable]">
      <ActivityHead
        tabs={tabs}
        sentence={sentence}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {toggle}
            <span className="flex items-center gap-1">
              <IconButton icon="chevronleft" label="Previous week" onClick={() => week && goWeek(shiftWeek(week.weekStart, -1))} />
              <Button size="sm" variant="quiet" disabled={isThisWeek} onClick={() => goWeek(null)}>
                This week
              </Button>
              <IconButton icon="chevronright" label="Next week" onClick={() => week && goWeek(shiftWeek(week.weekStart, 1))} />
            </span>
          </div>
        }
      />
      <div ref={rootRef} className="flex min-w-0 shrink-0 flex-col gap-6" data-testid="to-log-week">
        <WeekPicker groups={groups} value={week?.weekStart ?? weekParam ?? cur.data?.weekStart ?? ''} onPick={(m) => goWeek(m)} />
        <PanelBoundary name="time">
          <PathSection id="time-suggested" title="What the app found" sub={weekRange ? `${weekRange} · from your calendar, onsite days, Drive, Slack and Claude sessions, and where each one is now.` : undefined} testId="time-suggested">
            {state === 'error' ? (
              <PanelError title="Couldn't load this week" error={q.error ?? new Error('Forced error state')} onRetry={() => void q.refetch()} />
            ) : state === 'loading' || !week || !suggested ? (
              <TimeBodySkeleton />
            ) : state === 'empty' ? (
              <div data-testid="week-empty">
                <EmptyState icon="clock" title="Nothing found for this week" body="Rows come in as the scans run: a meeting after it ends, then Claude sessions, Drive edits and Slack bursts as they are found. Nothing here waits on you; the List shows what is ready to log." />
              </div>
            ) : (
              <SuggestedWeek week={week} s={suggested} isThisWeek={isThisWeek} now={now} tz={tz} work={work} onOpenActivity={(id) => showRows([id])} onJump={jump} />
            )}
          </PathSection>

          {week && state === 'ready' ? (
            <section id="time-rows" aria-labelledby="time-rows-h" className="min-w-0 scroll-mt-4">
              <Pane aria-label="Activity log" head={<SectionHead id="time-rows-h" title={isThisWeek ? 'This week’s rows' : 'That week’s rows'} count={ids.length} sub={`Every row of the week, as it goes to Org62 (${loggedEventsLabel(persona)}). Change a field and it saves; rows already in Org62 are read only, and changing a row that waits in a batch takes it out of that batch. Click a row for its details.`} />} scroll={false}>
                <ActivityTable
                  entries={week.entries}
                  now={now}
                  tz={tz}
                  highlightId={highlight}
                  selectedId={selected}
                  onSelect={(e) => openRow(e.id)}
                  onFocusEntry={(e) => setChatContext(e ? { kind: 'activity_entry', id: e.id, label: e.description || 'Activity row' } : null)}
                />
              </Pane>
            </section>
          ) : null}
        </PanelBoundary>
      </div>
    </ContextPage>
  );
}
