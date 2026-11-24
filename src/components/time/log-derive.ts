/**
 * Time ▸ Ledger: pure derivations for its rows (GET /time/log). The URL filters (quarter, status buckets, search, and
 * the drill-down slice: account, opp, task type, week), the route query they make, and the flat list the virtualized
 * rows render: week headers (with week totals), day headers (each links to that day in History), rows, and the end
 * marker. No React. Tested in log.test.ts.
 */
import { ActivityLogStatus, type ActivityEntry, type ActivityExcludedReason, type ActivityLog, type ActivityLogQuery, type ActivityLogTotal } from '@/contract';
import { quarterBounds } from './derive';

export interface LogFilters {
  /** A fiscal quarter label ("Q3 FY27"); `all` = every quarter; null = the current quarter (the default). */
  quarter: string | null;
  status: ActivityLogStatus[];
  q: string;
  /** Account name (rows carry names); `none` = rows with no account. */
  account: string | null;
  /** An opportunity id; `none` = rows with no opportunity (not internal); `internal` = internal-only rows (D-64). */
  opp: string | null;
  /** A task type; `none` = rows with no type. */
  type: string | null;
  /** A week's Monday (YYYY-MM-DD): the rows of that week (inside the quarter). */
  week: string | null;
  /** A finished batch's draft id (History ▸ Batches chip, C8): only that batch's rows. Optional so older callers fit. */
  batch?: string | null;
}

export const DEFAULT_LOG_FILTERS: LogFilters = { quarter: null, status: [], q: '', account: null, opp: null, type: null, week: null };

/** A batch's rows only (the Batches chip): the route has no batch filter, so the page narrows its rows here. */
export function filterByBatch<T extends Pick<ActivityLog, 'entries'>>(log: T, rowIds: readonly string[] | null): T {
  if (!rowIds) return log;
  const ids = new Set(rowIds);
  return { ...log, entries: log.entries.filter((e) => ids.has(e.id)) };
}

/** Every quarter (the quarter picker's last choice). */
export const ALL_QUARTERS = 'all';

/** The status chips, in the order a row moves through them. `upcoming` shows only when there are such rows. */
export const LOG_CHIPS: readonly ActivityLogStatus[] = ['needs_input', 'proposed', 'approved', 'handed_off', 'logged', 'verified', 'excluded'];

export const LOG_STATUS_LABEL: Record<ActivityLogStatus, string> = {
  upcoming: 'Upcoming',
  needs_input: 'Needs input',
  proposed: 'Proposed',
  approved: 'Approved',
  handed_off: 'Handed off',
  logged: 'Logged',
  verified: 'Verified',
  excluded: 'Excluded',
};

/** Why an excluded row is not logged (the engine's reason, or you). */
export const EXCLUDED_REASON_LABEL: Record<ActivityExcludedReason, string> = {
  neither_type: 'Not customer work (neither CF nor CR)',
  overlap: 'Overlaps another row',
  ooo: 'During time off',
  placeholder: 'A placeholder, not a meeting',
  cap_trimmed: 'Over the day or week cap',
  duplicate: 'Duplicate of another row',
  dropped: 'Replaced by a newer row',
  dismissed: 'Dismissed by you',
  dismiss_rule: 'Dismissed by your rule (all from its source; Settings ▸ Time ▸ Dismissed sources)',
};

/** The same, short enough for the row's status slot. */
export const EXCLUDED_REASON_SHORT: Record<ActivityExcludedReason, string> = {
  neither_type: 'Not customer work',
  overlap: 'Overlaps another row',
  ooo: 'During time off',
  placeholder: 'A placeholder',
  cap_trimmed: 'Over the day or week cap',
  duplicate: 'A duplicate',
  dropped: 'A newer row replaced it',
  dismissed: 'By you',
  dismiss_rule: 'By your rule',
};

/** The status word of a not-logged row: the engine excluded it, a newer row dropped it, or you dismissed it. */
export const EXCLUDED_WORD: Record<ActivityExcludedReason, string> = {
  neither_type: 'Excluded',
  overlap: 'Excluded',
  ooo: 'Excluded',
  placeholder: 'Excluded',
  cap_trimmed: 'Excluded',
  duplicate: 'Excluded',
  dropped: 'Dropped',
  dismissed: 'Dismissed',
  dismiss_rule: 'Dismissed',
};

const QUARTER = /^Q[1-4] FY\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set<string>(ActivityLogStatus.options);

/** `?view=history&quarter=Q3+FY27&status=logged,verified&q=demo&account=…&opp=…&type=…&week=…` → filters (unknown values dropped). */
export function parseLogFilters(p: URLSearchParams): LogFilters {
  const quarter = p.get('quarter');
  const week = p.get('week');
  const status = (p.get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s, i, xs): s is ActivityLogStatus => STATUSES.has(s) && xs.indexOf(s) === i);
  return {
    quarter: quarter && (QUARTER.test(quarter) || quarter === ALL_QUARTERS) ? quarter : null,
    status,
    q: p.get('q') ?? '',
    account: p.get('account') || null,
    opp: p.get('opp') || null,
    type: p.get('type') || null,
    week: week && DAY.test(week) ? week : null,
    ...(p.get('batch') ? { batch: p.get('batch') } : {}),
  };
}

/** Filters → History's query string (always `view=history` first; defaults are left out). */
export function serializeLogFilters(f: LogFilters): string {
  const sp = new URLSearchParams({ view: 'history' });
  if (f.quarter) sp.set('quarter', f.quarter);
  if (f.status.length) sp.set('status', LOG_CHIPS.concat('upcoming').filter((s) => f.status.includes(s)).join(','));
  if (f.q.trim()) sp.set('q', f.q);
  if (f.account) sp.set('account', f.account);
  if (f.opp) sp.set('opp', f.opp);
  if (f.type) sp.set('type', f.type);
  if (f.week) sp.set('week', f.week);
  if (f.batch) sp.set('batch', f.batch);
  return sp.toString();
}

export function activeLogFilterCount(f: LogFilters): number {
  return f.status.length + (f.q.trim() ? 1 : 0) + (f.account ? 1 : 0) + (f.opp ? 1 : 0) + (f.type ? 1 : 0) + (f.week ? 1 : 0) + (f.batch ? 1 : 0);
}

/** The quarter's days the rows cover: the label's calendar range, the current quarter's (`current`), none for all. */
export function quarterRangeOf(f: Pick<LogFilters, 'quarter'>, current?: { start: string; end: string } | null): { start: string; end: string } | null {
  if (f.quarter === ALL_QUARTERS) return null;
  if (f.quarter) return quarterBounds(f.quarter);
  return current ?? null;
}

/**
 * Filters → GET /time/log query. A quarter becomes its calendar range (FY starts 1 Feb; no quarter = the current one,
 * `current`); a week narrows it to that week. The rows are history: they run to `thisWeekEnd` (this week's Sunday),
 * and next weeks' rows show only with the Upcoming chip on (or when a quarter that has not started yet is picked).
 */
export function logQueryOf(f: LogFilters, thisWeekEnd?: string, current?: { start: string; end: string } | null): ActivityLogQuery {
  const q0 = quarterRangeOf(f, current);
  // a week inside the quarter (clipped to it), else the quarter
  const b = f.week ? { start: q0 && q0.start > f.week ? q0.start : f.week, end: q0 && q0.end < plus6(f.week) ? q0.end : plus6(f.week) } : q0;
  const cap = thisWeekEnd && !f.status.includes('upcoming') && (!b || b.start <= thisWeekEnd) ? thisWeekEnd : null;
  const q: ActivityLogQuery = {};
  if (b) {
    q.from = b.start;
    q.to = cap && cap < b.end ? cap : b.end;
  } else if (cap) q.to = cap;
  if (f.status.length) q.status = f.status.join(',');
  if (f.q.trim()) q.q = f.q.trim();
  if (f.account) q.account = f.account;
  if (f.opp) q.opp = f.opp;
  if (f.type) q.type = f.type;
  return q;
}

/** Toggle one status chip. */
export function toggleStatus(list: readonly ActivityLogStatus[], s: ActivityLogStatus): ActivityLogStatus[] {
  return list.includes(s) ? list.filter((x) => x !== s) : [...list, s];
}

/**
 * History's done rows are compact and read-only: logged, verified and excluded ones, and the ones handed to a batch
 * (waiting for Apply, or applied and on their way to Org62), which carry their Undo. Every other row stays editable.
 */
export function isCompactRow(e: Pick<ActivityEntry, 'status'> & { canvasDraftId?: string | undefined }): boolean {
  return e.status === 'logged' || e.status === 'verified' || e.status === 'dismissed' || e.status === 'synced_to_canvas' || !!e.canvasDraftId;
}

/** This week's Sunday (YYYY-MM-DD) for a local day. */
export function weekEndOf(day: string): string {
  return plus6(weekOf(day));
}

const weekOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};
const plus6 = (monday: string) => {
  const [y, m, d] = monday.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const liveH = (rows: ActivityEntry[]) => r2(rows.filter((e) => e.status !== 'dismissed' && e.status !== 'upcoming').reduce((s, e) => s + e.durationH, 0));

export type LogItem =
  | { kind: 'week'; key: string; weekStart: string; weekEnd: string; total: ActivityLogTotal }
  | { kind: 'day'; key: string; day: string; rows: number; hours: number }
  | { kind: 'row'; key: string; entry: ActivityEntry; compact: boolean }
  | { kind: 'end'; key: string; rows: number };

/**
 * The Log as one flat list for the virtualizer: newest week first, a week's days newest first, a day's rows in
 * clock order (the route's order), and "That's everything" at the end. Week totals come from the route.
 */
export function logItems(log: Pick<ActivityLog, 'entries' | 'weeks'>): LogItem[] {
  const weekTotals = new Map(log.weeks.map((w) => [w.weekStart, w] as const));
  const byDay = new Map<string, ActivityEntry[]>();
  for (const e of log.entries) {
    const g = byDay.get(e.date);
    if (g) g.push(e);
    else byDay.set(e.date, [e]);
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  const out: LogItem[] = [];
  let week: string | null = null;
  for (const day of days) {
    const rows = byDay.get(day)!;
    const ws = weekOf(day);
    if (ws !== week) {
      week = ws;
      const t = weekTotals.get(ws);
      out.push({ kind: 'week', key: `w:${ws}`, weekStart: ws, weekEnd: t?.weekEnd ?? plus6(ws), total: t ? { rows: t.rows, hours: t.hours, loggedH: t.loggedH } : { rows: 0, hours: 0, loggedH: 0 } });
    }
    out.push({ kind: 'day', key: `d:${day}`, day, rows: rows.length, hours: liveH(rows) });
    for (const e of rows) out.push({ kind: 'row', key: e.id, entry: e, compact: isCompactRow(e) });
  }
  out.push({ kind: 'end', key: 'end', rows: log.entries.length });
  return out;
}

/** "Aug 3 – 9" / "Oct 27 – Nov 2" (UTC calendar days). */
export function weekRangeLabel(weekStart: string, weekEnd: string): string {
  const f = (d: string, withMonth: boolean) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: withMonth ? 'short' : undefined, day: 'numeric' });
  if (weekStart === weekEnd) return f(weekStart, true); // a week clipped to one day of the quarter
  const sameMonth = weekStart.slice(0, 7) === weekEnd.slice(0, 7);
  return `${f(weekStart, true)} – ${f(weekEnd, !sameMonth)}`;
}

/** "Aug 1 – Oct 31". */
export function quarterRangeLabel(start: string, end: string): string {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `${f(start)} – ${f(end)}`;
}

/** The History page's URL for a local day (the day header link). */
export const historyHref = (day: string) => `/history?day=${day}`;
