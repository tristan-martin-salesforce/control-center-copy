/**
 * Time ▸ Ledger (?view=log): pure parts of the overview over GET /time/ledger. No React; tested in ./ledger.test.ts.
 *
 *   picker      the quarters oldest → newest (the current one marked), then All
 *   tracking    the quarter against its target, by the one count map: in Org62 · on its way · suggested · needs input,
 *               as one segmented meter (color is state: done green, waiting neutral, suggestion AI, needs you amber)
 *   lines       every breakdown line (an account, an opportunity under it, internal, no account, a task type, a week)
 *               and the drill-down it opens: the rows list's own filters, so the rows behind a number are one click
 *   chart       the weeks (or quarters) on one scale with clean ticks
 *
 * Human hours only: these are the rows' hours; agent time is never in them.
 */
import type { ActivityLogQuarter, TimeLedger } from '@/contract';
import { fmtH, quarterBounds } from './derive';
import { ALL_QUARTERS, quarterRangeLabel, weekRangeLabel, type LogFilters } from './log-derive';

const r1 = (n: number) => Math.round(n * 10) / 10;
const NONE = 'none';
const INTERNAL = 'internal';

// ── The quarter picker ─────────────────────────────────────────────────────────────────────

export interface QuarterChoice {
  /** The URL value: a label, or null for the current quarter (the default), `all` for every quarter. */
  value: string | null;
  label: string;
  /** "212 of 250 h" / "212 h". */
  sub: string;
  /** 0–100 of the target (0 without one). */
  pct: number;
  current: boolean;
}

/** The quarters oldest → newest (the current one's value is null: the default), then every quarter. */
export function quarterChoices(quarters: readonly ActivityLogQuarter[]): QuarterChoice[] {
  const out: QuarterChoice[] = [...quarters]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((q) => ({ value: q.current ? null : q.label, label: q.label, sub: q.targetH > 0 ? `${r1(q.loggedH)} of ${q.targetH} h` : `${r1(q.loggedH)} h`, pct: q.targetH > 0 ? Math.min(100, (q.loggedH / q.targetH) * 100) : 0, current: q.current }));
  const all = quarters.reduce((s, q) => s + q.loggedH, 0);
  out.push({ value: ALL_QUARTERS, label: 'All quarters', sub: `${r1(all)} h`, pct: 0, current: false });
  return out;
}

/** The quarter the ledger shows: its totals row, or null for all (or while it is not known). */
export function shownQuarter(l: Pick<TimeLedger, 'quarter' | 'quarters'> | undefined): ActivityLogQuarter | null {
  if (!l || l.quarter === ALL_QUARTERS) return null;
  return l.quarters.find((q) => q.label === l.quarter) ?? null;
}

/** The URL's quarter for a label: null when it is the current quarter (the default stays out of the URL). */
export const quarterParam = (label: string | null, quarters: readonly ActivityLogQuarter[]): string | null => (label && quarters.find((q) => q.label === label)?.current ? null : label);

/** "Q4 FY27 · Nov 1 – Jan 31 · this quarter" / "Every quarter · 4 quarters". */
export function quarterTitle(l: Pick<TimeLedger, 'quarter' | 'quarters' | 'from' | 'to'>): string {
  if (l.quarter === ALL_QUARTERS) return `Every quarter · ${l.quarters.length} ${l.quarters.length === 1 ? 'quarter' : 'quarters'}`;
  const q = shownQuarter(l);
  const b = l.from && l.to ? { start: l.from, end: l.to } : quarterBounds(l.quarter);
  return [l.quarter, b ? quarterRangeLabel(b.start, b.end) : null, q?.current ? 'this quarter' : null].filter(Boolean).join(' · ');
}

// ── Tracking ───────────────────────────────────────────────────────────────────────────────

export type TrackId = 'org62' | 'way' | 'suggested' | 'needs';

export interface TrackSegment {
  id: TrackId;
  label: string;
  /** The label after a number ("14 h in Org62", "2 h on its way"). */
  phrase: string;
  /** One muted line: what the state means. */
  hint: string;
  hours: number;
  rows: number | null;
  /** 0–100 of the meter's scale (the target, or the hours when they pass it). */
  pct: number;
}

export interface Tracking {
  /** In Org62 (the quarter's own number: the read-back rows, plus hours logged before the app's rows). */
  loggedH: number;
  verifiedH: number;
  targetH: number;
  /** Hours to the target (0 when met or without a target). */
  leftH: number;
  /** Everything yours if it all lands: in Org62 + on its way + suggested + needs input. */
  projectedH: number;
  segments: TrackSegment[];
  /** The meter's scale: the target, or the projected hours when they pass it (or have no target). */
  scaleH: number;
}

/**
 * The quarter by the one count map (TL-45), against its target: in Org62 (the quarter's own logged hours, read back),
 * on its way (approved or handed to a canvas, not in Org62 yet), suggested (the app's proposals), needs input (missing
 * an opp, a type or hours, or not in Org62 after all). Segments with no hours are left out. `taskType: false` (D-55: a
 * persona that logs no task type, the AE's Sales Events) leaves "a type" out of the needs-input hint.
 */
export function tracking(l: Pick<TimeLedger, 'totals'>, q: Pick<ActivityLogQuarter, 'loggedH' | 'verifiedH' | 'targetH'> | null, opts: { taskType?: boolean } = {}): Tracking {
  const t = l.totals;
  const missing = opts.taskType === false ? 'Missing an opp or hours' : 'Missing an opp, a type or hours';
  const loggedH = q ? q.loggedH : t.loggedH + t.earlierH;
  const targetH = q?.targetH ?? 0;
  const needsH = t.needsInputH + t.missingH;
  const projectedH = Math.round((loggedH + t.approvedH + t.proposedH + needsH) * 100) / 100;
  const scaleH = Math.max(targetH, projectedH, 0.01);
  const seg = (id: TrackId, label: string, phrase: string, hint: string, hours: number, rows: number | null): TrackSegment => ({ id, label, phrase, hint, hours: Math.round(hours * 100) / 100, rows, pct: (hours / scaleH) * 100 });
  const verifiedH = q?.verifiedH ?? t.verifiedH;
  const segments = [
    seg('org62', 'In Org62', 'in Org62', verifiedH > 0 ? `${fmtH(verifiedH)} checked in Org62` : 'Read back from Org62', loggedH, null),
    seg('way', 'On its way', 'on its way', 'Approved, not in Org62 yet', t.approvedH, t.approvedRows),
    seg('suggested', 'Suggested', 'suggested', 'The app proposed them: approve or fix', t.proposedH, t.proposedRows),
    seg('needs', 'Needs input', 'needs input', t.missingRows ? `${missing} · ${t.missingRows} not in Org62 after all` : missing, needsH, t.needsInputRows + t.missingRows),
  ].filter((s) => s.hours > 0 || s.id === 'org62');
  return { loggedH: Math.round(loggedH * 100) / 100, verifiedH: q?.verifiedH ?? t.verifiedH, targetH, leftH: targetH > 0 ? Math.max(0, r1(targetH - loggedH)) : 0, projectedH, segments, scaleH };
}

// ── Lines and their drill-down ─────────────────────────────────────────────────────────────

/** A breakdown line: what it is, so its drill-down is the rows list's filters. */
export type LedgerLine =
  | { kind: 'account'; account: string | null }
  /** An opportunity under its account; `oppId` null = the account's rows with no opportunity. */
  | { kind: 'opp'; account: string | null; oppId: string | null }
  | { kind: 'internal' }
  | { kind: 'unassigned' }
  | { kind: 'type'; type: string | null }
  | { kind: 'week'; week: string };

export type SliceFilters = Pick<LogFilters, 'account' | 'opp' | 'type' | 'week'>;
const NO_SLICE: SliceFilters = { account: null, opp: null, type: null, week: null };

/** The rows behind a line, as filters (they replace the slice; the status chips and search stay). */
export function lineFilters(l: LedgerLine): SliceFilters {
  switch (l.kind) {
    case 'account':
      return { ...NO_SLICE, account: l.account ?? NONE };
    case 'opp':
      return { ...NO_SLICE, account: l.account ?? NONE, opp: l.oppId ?? NONE };
    case 'internal':
      return { ...NO_SLICE, opp: INTERNAL };
    case 'unassigned':
      return { ...NO_SLICE, account: NONE, opp: NONE };
    case 'type':
      return { ...NO_SLICE, type: l.type ?? NONE };
    case 'week':
      return { ...NO_SLICE, week: l.week };
  }
}

const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** The line the rows list shows right now (its filters are exactly the slice). */
export function isLineActive(l: LedgerLine, f: SliceFilters): boolean {
  const x = lineFilters(l);
  return same(x.account, f.account) && x.opp === f.opp && same(x.type, f.type) && x.week === f.week;
}

/** A click on a line: its rows, or back to every row when it is the one shown. */
export function toggleLine(l: LedgerLine, f: SliceFilters): SliceFilters {
  return isLineActive(l, f) ? NO_SLICE : lineFilters(l);
}

export const hasSlice = (f: SliceFilters) => !!(f.account || f.opp || f.type || f.week);

/** The words for a special filter value (the filter chips and the rows' title). */
export const ACCOUNT_NONE_LABEL = 'No account';
export const OPP_NONE_LABEL = 'No opportunity';
export const INTERNAL_LABEL = 'Internal (no opportunity)';
export const TYPE_NONE_LABEL = 'No type';
export const UNASSIGNED_LABEL = 'No account or opportunity yet';

/** "ACME Corp · Phase 2" / "Internal (no opportunity)" / "Demo" / "Week of Nov 2 – 8": what the rows list shows. */
export function sliceTitle(f: SliceFilters, l?: Pick<TimeLedger, 'accounts' | 'to' | 'from'>): string | null {
  const parts: string[] = [];
  if (f.opp === INTERNAL) parts.push(INTERNAL_LABEL);
  else if (f.account === NONE && f.opp === NONE) parts.push(UNASSIGNED_LABEL);
  else {
    if (f.account) parts.push(f.account === NONE ? ACCOUNT_NONE_LABEL : f.account);
    if (f.opp) parts.push(f.opp === NONE ? OPP_NONE_LABEL : (oppName(l, f.opp) ?? 'One opportunity'));
  }
  if (f.type) parts.push(f.type === NONE ? TYPE_NONE_LABEL : f.type);
  if (f.week) {
    const end = plus6(f.week);
    parts.push(`Week of ${weekRangeLabel(l?.from && l.from > f.week ? l.from : f.week, l?.to && l.to < end ? l.to : end)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** An opportunity's name from the ledger's lines. */
export function oppName(l: Pick<TimeLedger, 'accounts'> | undefined, oppId: string): string | null {
  for (const a of l?.accounts ?? []) for (const o of a.opps) if (o.oppId === oppId) return o.name;
  return null;
}

/** "Phase 2 · Globex": an opportunity's name without its account's when it starts with it ("ACME · Phase 2" → "Phase 2"). */
export function shortOppName(name: string, account: string | null): string {
  if (!account) return name;
  const a = account.toLowerCase();
  const n = name.toLowerCase();
  for (const sep of [' · ', ' - ', ' – ', ': ', ' ']) {
    for (const head of [a, a.split(/\s+/)[0]!]) if (head.length >= 3 && n.startsWith(`${head}${sep}`)) return name.slice(head.length + sep.length) || name;
  }
  return name;
}

/** "35%" / "<1%" / "0%". */
export function shareText(share: number): string {
  if (share <= 0) return '0%';
  const p = share * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** The two-state bar of a line: in Org62 and not yet, each as % of the longest line. */
export function lineBar(x: { hours: number; loggedH: number }, maxH: number): { org62: number; rest: number } {
  if (maxH <= 0 || x.hours <= 0) return { org62: 0, rest: 0 };
  const org62 = (Math.min(x.loggedH, x.hours) / maxH) * 100;
  return { org62, rest: ((x.hours - Math.min(x.loggedH, x.hours)) / maxH) * 100 };
}

// ── The chart ──────────────────────────────────────────────────────────────────────────────

/** A clean scale for the chart: a top tick at 5 · 10 · 20 · 25 · 50 … at or above the highest column, and its middle. */
export function chartScale(maxH: number): { top: number; ticks: number[] } {
  if (maxH <= 0) return { top: 10, ticks: [0, 5, 10] };
  const steps = [1, 2, 2.5, 5, 10];
  const mag = 10 ** Math.floor(Math.log10(maxH));
  const top = steps.map((s) => s * mag).find((s) => s >= maxH) ?? 10 * mag;
  const nice = top < 4 ? Math.ceil(maxH) : top;
  return { top: nice, ticks: [0, nice / 2, nice] };
}

/** A week column that has not started yet (after this week): drawn empty, not a drill-down. */
export const isLaterWeek = (p: { start: string }, thisWeekEnd: string) => p.start > thisWeekEnd;

/** The column's words (its aria label and tooltip): "Week of Nov 2 – 8: 12 h, 9.5 h in Org62, 8 rows". */
export function periodWords(p: { label: string; start: string; end: string; hours: number; loggedH: number; rows: number }, kind: 'week' | 'quarter'): string {
  const name = kind === 'week' ? `Week of ${weekRangeLabel(p.start, p.end)}` : p.label;
  return p.rows ? `${name}: ${fmtH(p.hours)}, ${fmtH(p.loggedH)} in Org62, ${p.rows} ${p.rows === 1 ? 'row' : 'rows'}` : `${name}: nothing logged`;
}

const plus6 = (monday: string) => {
  const [y, m, d] = monday.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
};
