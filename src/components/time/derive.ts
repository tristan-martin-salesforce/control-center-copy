/**
 * Time page: pure derivations (no React). Tested in tests/p5/time-derive.test.ts.
 * Everything that needs a timezone takes `tz` explicitly (profile timezone, never the browser's).
 */
import type { ActivityEntry, ActivityLog, LogCanvas, TimelineBlock, TimelineLane, TimeWeek } from '@/contract';
import { ymd } from '@/components/domain/lib/time';
import { logCanvasPrompt } from '@/lib/canvas/prompt';
import { org62CheckOf } from '@/engines/activity/org62-check';
import { plainIssue } from './plain';

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(iso: string, tz?: string) {
  const key = tz ?? '';
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmtCache.set(key, f);
  }
  const p = f.formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, min: Number(g('hour')) * 60 + Number(g('minute')) };
}

export const ymdIn = (iso: string, tz?: string) => parts(iso, tz).ymd;
export const minutesOfDay = (iso: string, tz?: string) => parts(iso, tz).min;

/** Mon..Fri (or `n` days) of the week that starts on `weekStart` (YYYY-MM-DD, a Monday). */
export function weekDays(weekStart: string, n = 5): string[] {
  const [y, m, d] = weekStart.split('-').map(Number) as [number, number, number];
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}

const nextDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

export function shiftWeek(weekStart: string, weeks: number): string {
  const [y, m, d] = weekStart.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + weeks * 7)).toISOString().slice(0, 10);
}

// ── Timeline layout ────────────────────────────────────────────────────────────────────────

export type RowId = 'meetings' | 'focus' | 'claude' | 'leverage' | 'drive' | 'slack' | 'git';

export interface PlacedBlock {
  id: string;
  rowId: RowId;
  label: string;
  day: string;
  startMin: number;
  endMin: number;
  activityId: string | null;
  hatched: boolean;
  start: string;
  end: string;
  /** Sub-row inside its lane/day when blocks of one lane overlap. */
  sub: number;
}

export const ROW_ORDER: Array<{ id: RowId; label: string; hint?: string }> = [
  { id: 'meetings', label: 'Meetings' },
  { id: 'focus', label: 'Your focus' },
  { id: 'claude', label: 'Claude · you', hint: 'Your time in sessions' },
  { id: 'leverage', label: 'Agent leverage', hint: 'Background agent time. Never logged or totalled.' },
  { id: 'drive', label: 'Drive edits' },
  { id: 'slack', label: 'Slack bursts' },
  { id: 'git', label: 'Git' },
];

function rowFor(lane: TimelineLane['id'], b: TimelineBlock): RowId {
  if (lane === 'claude') return b.hatched ? 'leverage' : 'claude';
  return lane;
}

/** A late session that ends by 06:00 the next morning stays on the day it started (the window runs past 24:00). */
export const NIGHT_SPILL_MIN = 6 * 60;

/**
 * Place blocks on days (profile tz) and stack overlapping blocks of a lane into sub-rows. Late work that runs past
 * midnight and ends by NIGHT_SPILL_MIN stays on its own day (endMin > 1440: "23:00–00:30" is one block on the day
 * you did it); anything longer is split at midnight onto the next day (id `<id>@<day>`). No late work is lost.
 */
export function placeBlocks(lanes: TimelineLane[], days: string[], tz?: string): PlacedBlock[] {
  const out: PlacedBlock[] = [];
  for (const lane of lanes) {
    for (const b of lane.blocks) {
      const endDay = ymdIn(b.end, tz);
      const endAt = minutesOfDay(b.end, tz);
      let day = ymdIn(b.start, tz);
      let startMin = minutesOfDay(b.start, tz);
      if (endDay === nextDay(day) && endAt > 0 && endAt <= NIGHT_SPILL_MIN) {
        if (days.includes(day)) out.push({ id: b.id, rowId: rowFor(lane.id, b), label: b.label, day, startMin, endMin: 24 * 60 + endAt, activityId: b.activityId, hatched: b.hatched, start: b.start, end: b.end, sub: 0 });
        continue;
      }
      for (let piece = 0; piece < 8; piece++) {
        const last = day >= endDay;
        let endMin = last ? endAt : 24 * 60;
        if (endMin <= startMin) endMin = startMin + 5;
        if (days.includes(day)) {
          out.push({ id: piece ? `${b.id}@${day}` : b.id, rowId: rowFor(lane.id, b), label: b.label, day, startMin, endMin, activityId: b.activityId, hatched: b.hatched, start: b.start, end: b.end, sub: 0 });
        }
        if (last || (endDay === nextDay(day) && endAt === 0)) break;
        day = nextDay(day);
        startMin = 0;
      }
    }
  }
  const groups = new Map<string, PlacedBlock[]>();
  for (const b of out) {
    const k = `${b.rowId}|${b.day}`;
    const g = groups.get(k);
    if (g) g.push(b);
    else groups.set(k, [b]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    const ends: number[] = [];
    for (const b of g) {
      let i = ends.findIndex((e) => e <= b.startMin);
      if (i < 0) {
        i = ends.length;
        ends.push(0);
      }
      ends[i] = b.endMin;
      b.sub = i;
    }
  }
  return out;
}

/** Sub-row count per row (max across days). */
export function subRows(blocks: PlacedBlock[]): Record<RowId, number> {
  const r = Object.fromEntries(ROW_ORDER.map((x) => [x.id, 1])) as Record<RowId, number>;
  for (const b of blocks) r[b.rowId] = Math.max(r[b.rowId], b.sub + 1);
  return r;
}

/** Working hours in minutes since local midnight (profile settings; 07:30–17:30 → 450–1050). */
export interface WorkSpan {
  start: number;
  end: number;
}

export const DEFAULT_WORK: WorkSpan = { start: 8 * 60, end: 18 * 60 };

/** "07:30" → 450, or `fallback` for anything unparsable. */
export function hhmmToMin(v: string | null | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v ?? '');
  return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : fallback;
}

/**
 * Visible hour window, in whole hours: working hours rounded out to the hour, widened to the earliest start and
 * latest end of every block this week (agent time included) and to `extra` minutes (the now-line). Nothing is
 * clipped: from 0 to 24 + NIGHT_SPILL_MIN / 60 at most (a late session that ends after midnight keeps its day).
 */
export function dayWindow(blocks: PlacedBlock[], work: WorkSpan = DEFAULT_WORK, extra: number[] = []): [number, number] {
  let lo = Math.floor(Math.min(work.start, work.end) / 60);
  let hi = Math.ceil(Math.max(work.start, work.end) / 60);
  const fit = (s: number, e: number) => {
    lo = Math.min(lo, Math.floor(s / 60));
    hi = Math.max(hi, Math.ceil(e / 60));
  };
  for (const b of blocks) fit(b.startMin, b.endMin);
  for (const m of extra) fit(m, m);
  lo = Math.max(0, lo);
  hi = Math.min(24 + NIGHT_SPILL_MIN / 60, Math.max(hi, lo + 1));
  return [lo, hi];
}

/** "07:00", or "01:00 next day" past midnight (window ends and tooltips). */
export function windowClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const s = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return min > 24 * 60 ? `${s} next day` : min === 24 * 60 ? '24:00' : s;
}

/** The parts of [lo, hi] hours that fall outside working hours, in minutes (shaded on the grid). */
export function offHours([lo, hi]: [number, number], work: WorkSpan = DEFAULT_WORK): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (work.start > lo * 60) out.push([lo * 60, Math.min(work.start, hi * 60)]);
  if (work.end < hi * 60) out.push([Math.max(work.end, lo * 60), hi * 60]);
  return out.filter(([s, e]) => e > s);
}

/** Hour ticks inside the window on multiples of `step` hours (grid lines). */
export function hourTicks([lo, hi]: [number, number], step = 3): number[] {
  const out: number[] = [];
  for (let h = Math.ceil(lo / step) * step; h < hi; h += step) if (h > lo) out.push(h);
  return out;
}

/**
 * Hours that get a label on each day's axis: every 3 h, every 6 h once the window is longer than 15 h (a day
 * column is narrow), never within 7 % of a column edge, where it would run into the next day's first label.
 */
export function axisLabels(win: [number, number]): number[] {
  const [lo, hi] = win;
  const span = hi - lo;
  return hourTicks(win, span > 15 ? 6 : 3).filter((h) => (h - lo) / span >= 0.07 && (hi - h) / span >= 0.07);
}

/** Mon–Fri, plus Sat and Sun when they have blocks: weekend work is shown, an empty weekend isn't. */
export function visibleDays(weekStart: string, blocks: Pick<PlacedBlock, 'day'>[]): string[] {
  const all = weekDays(weekStart, 7);
  return all.filter((d, i) => i < 5 || blocks.some((b) => b.day === d));
}

/** Minutes where two or more of YOUR blocks (not agent leverage) overlap on a day. Merged bands. */
export function overlapBands(blocks: PlacedBlock[], day: string): Array<[number, number]> {
  const mine = blocks.filter((b) => b.day === day && b.rowId !== 'leverage');
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const s = Math.max(mine[i]!.startMin, mine[j]!.startMin);
      const e = Math.min(mine[i]!.endMin, mine[j]!.endMin);
      if (e - s >= 5) edges.push([s, e]);
    }
  }
  edges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of edges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

export function hoursByRow(blocks: PlacedBlock[]): Record<RowId, number> {
  const r = Object.fromEntries(ROW_ORDER.map((x) => [x.id, 0])) as Record<RowId, number>;
  for (const b of blocks) r[b.rowId] += (b.endMin - b.startMin) / 60;
  return r;
}

// ── Logging gap and read-back ──────────────────────────────────────────────────────────────

export type ReadbackState = 'unconfirmed' | 'missing' | 'deleted' | 'differs' | null;

const WAITING_ORG62: ReadonlySet<ActivityEntry['status']> = new Set(['approved', 'synced_to_canvas', 'logged']);
const UNCONFIRMED_AFTER_MS = 12 * 3_600_000;

/**
 * D-65: `missing`: the canvas ran, and Org62 has no Event for it ("Not in Org62", TL-20). `deleted`: its Event was
 * deleted in Org62 (TL-14). Both offer Log again / Leave out. `differs`: in Org62, with other values (counted).
 * `unconfirmed`: written or approved, nothing read back yet. A row read from Org62 (`fromOrg62`) is confirmed by
 * definition: the Event is what the row came from. A row waiting in an Outbox canvas item (`canvasDraftId`) has not
 * been handed off yet, so there is nothing to confirm either.
 */
export function readbackState(e: Pick<ActivityEntry, 'status' | 'end'> & { issues?: readonly string[]; fromOrg62?: boolean; canvasDraftId?: string | undefined }, nowIso: string): ReadbackState {
  const check = org62CheckOf(e);
  if (check === 'deleted') return 'deleted';
  if (check === 'not_in_org62') return 'missing';
  if (e.status === 'verify_failed') return 'differs';
  if (e.fromOrg62 || e.canvasDraftId) return null;
  if (WAITING_ORG62.has(e.status) && Date.parse(e.end) < Date.parse(nowIso) - UNCONFIRMED_AFTER_MS) return 'unconfirmed';
  return null;
}

/** The row's read-back note on Time (D-65): "Not in Org62" (TL-20), "Deleted in Org62" (TL-14), "Differs from Org62". */
export const READBACK_LABEL: Record<NonNullable<ReadbackState>, string> = {
  missing: 'Not in Org62: the batch ran without it',
  deleted: 'Deleted in Org62',
  differs: 'Differs from Org62',
  unconfirmed: 'Unconfirmed in Org62',
};
/** The same, as a status badge. */
export const READBACK_BADGE: Record<NonNullable<ReadbackState>, string> = {
  missing: 'Not in Org62',
  deleted: 'Deleted in Org62',
  differs: 'Differs from Org62',
  unconfirmed: 'Unconfirmed',
};

export interface LoggingGap {
  show: boolean;
  unconfirmedH: number;
  unconfirmedRows: number;
  missingRows: number;
  /** The rows behind the numbers (Show them: Time scrolls to the first). */
  ids: string[];
  /** Last time Org62 read-back confirmed anything: the newest of the payload's and the rows' own read-backs. */
  lastReadbackAt: string | null;
}

/**
 * Approved (or handed-off) hours Org62 has not confirmed 12 h after they ended, and rows missing there after a canvas
 * ran (2026-11-13 audit C3: computed for long, now drawn in Time's quarter header). `week.entries` can be the quarter's
 * rows (GET /time/log), so a gap from an earlier week is never out of sight.
 */
export function loggingGap(week: Pick<TimeWeek, 'entries' | 'org62' | 'canvas'>, nowIso: string): LoggingGap {
  let unconfirmedH = 0;
  let unconfirmedRows = 0;
  let missingRows = 0;
  const ids: string[] = [];
  let lastSeen = week.org62.lastReadbackAt;
  for (const e of week.entries) {
    if ((e.status === 'logged' || e.status === 'verified') && !e.fromOrg62 && (!lastSeen || e.updatedAt > lastSeen)) lastSeen = e.updatedAt;
    const s = readbackState(e, nowIso);
    if (s === 'unconfirmed') {
      unconfirmedH += e.durationH;
      unconfirmedRows++;
      ids.push(e.id);
    } else if (s === 'missing' || s === 'deleted') {
      missingRows++;
      ids.push(e.id);
    }
  }
  const lastReadbackAt = lastSeen ?? null;
  return { show: unconfirmedRows > 0 || missingRows > 0, unconfirmedH: Math.round(unconfirmedH * 100) / 100, unconfirmedRows, missingRows, ids, lastReadbackAt };
}

export const fmtH = (h: number) => `${Math.round(h * 100) / 100} h`;

/** The persona's logging wording a prompt needs: loggingProfile().recordTypeName and whether rows carry a task type. */
export interface PromptWording {
  recordTypeName: string;
  taskType: boolean;
}

/** "Copy prompt" for one logging canvas: its own title and link, the persona's record type (src/lib/canvas/prompt.ts). */
export function canvasPrompt(c: Pick<LogCanvas, 'title' | 'url' | 'rows' | 'hours' | 'dcs' | 'updates'>, w: PromptWording): string {
  return logCanvasPrompt({ title: c.title, url: c.url, rows: c.rows, hours: c.hours, dcs: c.dcs, updates: c.updates, recordTypeName: w.recordTypeName, taskType: w.taskType });
}

/**
 * What the Confirm step's button copies: the prompt of each handed-off canvas, in order; rows handed off on no canvas
 * the app knows (the old shared work-order canvas) get one prompt naming `fallbackLabel`. No secrets.
 */
export function confirmPrompt(s: Pick<Q4Step, 'ids' | 'hours' | 'canvases'>, w: PromptWording, fallbackLabel: string, rows: readonly ActivityEntry[] = []): string {
  const on = new Set((s.canvases ?? []).flatMap((c) => c.rowIds));
  const loose = s.ids.filter((id) => !on.has(id));
  const looseH = Math.round(rows.filter((r) => loose.includes(r.id)).reduce((t, r) => t + r.durationH, 0) * 100) / 100;
  const parts = (s.canvases ?? []).map((c) => canvasPrompt(c, w));
  if (loose.length || !parts.length) parts.push(logCanvasPrompt({ title: fallbackLabel, rows: loose.length || s.ids.length, hours: loose.length ? looseH : s.hours, recordTypeName: w.recordTypeName, taskType: w.taskType }));
  return parts.join('\n\n');
}

/**
 * Hours that overlap inside a set of rows: their summed spans minus the clock time they cover, to 0.25 h. Every
 * accepted meeting logs and an onsite day logs in full with its meetings (D-18 amended), so a day or week can total
 * more than the clock; the caption says by how much rather than claiming the total is wall-clock time.
 */
export function overlapHours(rows: readonly Pick<ActivityEntry, 'start' | 'end'>[]): number {
  const iv = rows
    .map((r) => [Date.parse(r.start), Date.parse(r.end)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let covered = 0;
  let cs = 0;
  let ce = -Infinity;
  for (const [s, e] of iv) {
    total += e - s;
    if (s >= ce) {
      if (ce > cs) covered += ce - cs;
      cs = s;
      ce = e;
    } else ce = Math.max(ce, e);
  }
  if (ce > cs) covered += ce - cs;
  return Math.round(((total - covered) / 3_600_000) * 4) / 4;
}

/** "includes 0.5 h of overlapping meetings", or null when nothing overlaps. */
export const overlapCaption = (rows: readonly Pick<ActivityEntry, 'start' | 'end'>[]): string | null => {
  const h = overlapHours(rows);
  return h >= 0.25 ? `includes ${fmtH(h)} of overlapping meetings` : null;
};

// ── Quarter ────────────────────────────────────────────────────────────────────────────────

/** CF/CR split of this week's rows. CC = CF + CR (customer contact hours). */
export function weekSplit(entries: ActivityEntry[]) {
  const live = entries.filter((e) => e.status !== 'dismissed' && e.status !== 'upcoming');
  const sum = (m: 'CF' | 'CR') => live.filter((e) => e.meetingType === m).reduce((s, e) => s + e.durationH, 0);
  const cf = sum('CF');
  const cr = sum('CR');
  return { cf, cr, cc: cf + cr, unassigned: live.filter((e) => !e.meetingType).reduce((s, e) => s + e.durationH, 0) };
}

// ── The quarter log: steps and the one action ──────────────────────────────────────────────

export type Q4StepId = 'approve' | 'submit' | 'dcs' | 'outbox' | 'confirm' | 'fix';
export type Q4StepState = 'done' | 'current' | 'later' | 'waiting';

export interface Q4Step {
  id: Q4StepId;
  state: Q4StepState;
  /** Confirm: the applied canvases its rows are on (each with Open ↗ and its own prompt), newest first. */
  canvases?: LogCanvas[];
  /** "Approve 2 rows the agent proposed" */
  title: string;
  /** One muted why line. */
  why: string;
  /** The verb ("Approve 2", "Submit the Q4 log", "Confirm 21 rows", "Show"). */
  verb: string;
  ids: string[];
  /** Human hours behind the step (agent time is never counted). */
  hours: number;
  /** The canvas items the step applies (the draft panel pages through them, on Time: D-52). */
  draftIds?: string[];
}

export interface Q4Input {
  /** Rows of the quarter so far and at least the last 3 weeks (q4Range, GET /time/log), deduped by id. */
  rows: ActivityEntry[];
  /** This week's payload: its `logCanvases` say which canvases wait for Apply and which were applied (with their rows). */
  week: Pick<TimeWeek, 'entries' | 'canvas' | 'quarter'> & { logCanvases?: LogCanvas[] };
  nowIso: string;
  /** How many rows "Confirm N rows" last copied the Slackbot prompt for (session memory). */
  confirmCopiedFor?: number | null;
  /** Deal Contribution requests waiting for a canvas (Deals ▸ DCs: approved, not on a canvas yet). */
  dcPending?: number;
  /** D-67: VDP use cases (Use_Case__c creates and Stage / Go-Live fixes) that ride on the next canvas with rows. */
  ucPending?: number;
  /**
   * D-55: rows need an SE task type before they can be logged (the SE's Solutions Events; default). An AE's Sales
   * Events carry none, so a complete proposed row is ready without one and no step asks for a type.
   */
  taskTypeRequired?: boolean;
  /**
   * Settings ▸ Time ▸ Logging `approveComplete` (default on): a batch also takes complete proposed rows and approves
   * them. Off: only approved rows are ready to log.
   */
  approveComplete?: boolean;
}

/**
 * A row the next batch can log, the server's rule (stageLogBatch): ended, approved (or proposed and complete when the
 * batch approves those), with an opportunity (or internal, D-64: approved only), a task type when the persona needs
 * one, and some hours.
 */
export function isLoggable(e: Pick<ActivityEntry, 'status' | 'end' | 'oppId' | 'taskType' | 'durationH'> & { internal?: boolean }, nowMs: number, taskTypeRequired = true, approveComplete = true): boolean {
  if (Date.parse(e.end) > nowMs) return false;
  // D-64: an internal row logs with no opportunity, once you Log it (a batch never approves one for you)
  if (e.internal) return e.status === 'approved' && (!taskTypeRequired || !!e.taskType) && e.durationH > 0;
  if (e.status !== 'approved' && !(approveComplete && e.status === 'proposed')) return false;
  return !!e.oppId && (!taskTypeRequired || !!e.taskType) && e.durationH > 0;
}

export const dcWord = (n: number) => `${n} DC ${n === 1 ? 'request' : 'requests'}`;
export const ucWord = (n: number) => `${n} VDP use ${n === 1 ? 'case' : 'cases'}`;

const sumH = (xs: ActivityEntry[]) => Math.round(xs.reduce((s, e) => s + e.durationH, 0) * 100) / 100;
const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

/**
 * The rows the quarter log works on (GET /time/log): the fiscal quarter so far, and at least this week and the
 * `lookbackWeeks` before it, so late rows of the quarter that just ended still show up to approve. Ends on
 * this week's Sunday.
 */
export function q4Range(week: Pick<TimeWeek, 'weekStart' | 'weekEnd' | 'quarter'>, lookbackWeeks = 3): { from: string; to: string } {
  const lookback = shiftWeek(week.weekStart, -lookbackWeeks);
  const q = quarterBounds(week.quarter.label);
  return { from: q && q.start < lookback ? q.start : lookback, to: week.weekEnd };
}

const APPLIED_CANVAS: ReadonlySet<LogCanvas['state']> = new Set(['applying', 'applied', 'verified', 'unverified']);
const CANVAS_EXISTS: ReadonlySet<LogCanvas['state']> = new Set(['applied', 'verified', 'unverified']);

/**
 * Rows handed to Slackbot (or written to Org62) that Org62 hasn't confirmed yet. `onCanvas`: rows a created canvas
 * carries, handed off even when their status still reads approved.
 */
export function handedOffRows(rows: ActivityEntry[], nowIso: string, onCanvas: ReadonlySet<string> = new Set()): ActivityEntry[] {
  return rows.filter((e) => e.status === 'synced_to_canvas' || (e.status === 'approved' && onCanvas.has(e.id)) || (e.status !== 'approved' && readbackState(e, nowIso) !== null));
}

/**
 * The quarter log as a short sequence (approve → submit → outbox → confirm → fix) with exactly one `current` step:
 * the one action that is due. Submit stages a logging batch (new canvas items); Outbox opens the staged items still
 * waiting for your Apply, here on Time (their rows are not offered to Submit again); Confirm hands each applied canvas
 * to Slackbot (a copied prompt per canvas: nothing is sent from here); Fix jumps to the rows that need your input. A
 * row on an applied canvas is never offered to Submit again, even when its status still reads approved.
 */
export function q4Steps({ rows, week, nowIso, confirmCopiedFor, dcPending = 0, ucPending = 0, taskTypeRequired = true, approveComplete = true }: Q4Input): Q4Step[] {
  const canvases = week.logCanvases ?? [];
  // rows on a canvas that was applied (created, or on its way): never offered to Log again
  const appliedOn = new Map<string, LogCanvas>();
  for (const c of [...canvases].reverse()) if (APPLIED_CANVAS.has(c.state)) for (const id of c.rowIds) appliedOn.set(id, c);
  const created = new Set([...appliedOn].filter(([, c]) => CANVAS_EXISTS.has(c.state)).map(([id]) => id));
  const applying = new Set(canvases.filter((c) => c.state === 'applying').map((c) => c.draftId));
  // D-64: internal suggestions have their own quiet group (Log / Dismiss), never this step
  const proposed = rows.filter((e) => e.status === 'proposed' && !e.internal && !appliedOn.has(e.id));
  const needs = rows.filter((e) => e.status === 'needs_input');
  const handed = handedOffRows(rows, nowIso, created);
  const copied = !!confirmCopiedFor && confirmCopiedFor === handed.length;

  const steps: Q4Step[] = [];
  if (proposed.length)
    steps.push({ id: 'approve', state: 'later', title: `${rowsWord(proposed.length)} the agent proposed`, why: `${fmtH(sumH(proposed))} · check the ${taskTypeRequired ? 'type, ' : ''}opp and CF/CR, then approve`, verb: `Approve ${proposed.length}`, ids: proposed.map((e) => e.id), hours: sumH(proposed) });
  // "Log these" (D-47): rows that have ended and are approved, or proposed and complete (they are approved with the
  // batch), go to Slackbot as a new private canvas: an Outbox item the user Applies. Rows already in a staged item
  // wait for that item's Apply instead.
  const nowMs = Date.parse(nowIso);
  // held by a canvas item you have not applied yet (one you applied that is still on its way is a receipt, not a step)
  const held = rows.filter((e) => !!e.canvasDraftId && !applying.has(e.canvasDraftId) && (e.status === 'approved' || e.status === 'proposed'));
  // an approved row still needs its opp (and type) to log: the batch skips it otherwise, and Needs you lists it
  const ready = rows.filter((e) => !e.canvasDraftId && !appliedOn.has(e.id) && isLoggable(e, nowMs, taskTypeRequired, approveComplete));
  // canvas items waiting for Apply that hold no row here (Deal Contributions or Duration fixes only)
  const heldIds = new Set(held.map((e) => e.canvasDraftId!));
  const pendingOnly = canvases.filter((c) => (c.state === 'pending' || c.state === 'retry') && !heldIds.has(c.draftId));
  // D-58: pending DC requests ride on the next canvas that has rows (the Log step says so); with no rows ready they
  // wait, and "Log DCs now" makes a canvas of only them, on purpose (never the page's default action)
  const dcs = Math.max(0, dcPending);
  // D-67: VDP use cases ride on the same canvas (never one of their own)
  const along = [dcs ? dcWord(dcs) : null, ucPending > 0 ? ucWord(ucPending) : null].filter(Boolean).join(' · ');
  steps.push(
    ready.length
      ? { id: 'submit', state: 'later', title: `${rowsWord(ready.length)} ready for Slackbot${along ? ` · ${along} ride along` : ''}`, why: `${fmtH(sumH(ready))} · a new batch to Apply here, then send it to Org62 via Slackbot`, verb: `Log the ${rowsWord(ready.length)} ready to Slackbot`, ids: ready.map((e) => e.id), hours: sumH(ready) }
      : { id: 'submit', state: 'done', title: held.length || pendingOnly.length ? 'Nothing new to log' : 'Nothing ready to log', why: `Rows that have ended, with ${taskTypeRequired ? 'a task type and ' : ''}an opportunity, land here`, verb: `Log to Slackbot`, ids: [], hours: 0 },
  );
  if (dcs && !ready.length)
    steps.push({ id: 'dcs', state: 'later', title: `${dcWord(dcs)} ride in your next batch`, why: 'They wait for the next batch with rows. Log DCs now puts them in a batch of their own (Deals ▸ DCs lists them)', verb: 'Log DCs now', ids: [], hours: 0 });
  if (held.length || pendingOnly.length) {
    const items = [...heldIds, ...pendingOnly.map((c) => c.draftId)];
    const canvasWord = items.length === 1 ? 'a new batch' : `${items.length} batches`;
    // B3: an Apply that got no answer may have made the canvas already: check Slack first (never a blind second one)
    const maybe = canvases.filter((c) => c.maybeCreated && items.includes(c.draftId)).length;
    steps.push({
      id: 'outbox',
      state: 'later',
      title: held.length ? `${rowsWord(held.length)} waiting for your Apply` : `${items.length === 1 ? '1 batch' : `${items.length} batches`} waiting for your Apply`,
      why: `${maybe ? `${maybe === 1 ? '1 may' : `${maybe} may`} already be in Slack (no answer to the last Apply): check Slack before you Apply again · ` : ''}${held.length ? `${fmtH(sumH(held))} · ` : ''}${canvasWord} to Apply, then send it to Org62 via Slackbot`,
      verb: items.length === 1 ? 'Review & apply' : `Review & apply ${items.length}`,
      ids: held.map((e) => e.id),
      hours: sumH(held),
      draftIds: items,
    });
  }
  if (handed.length) {
    // each handed-off row's canvas (newest first): the step lists them with Open ↗ and their own prompt
    const handedIds = new Set(handed.map((e) => e.id));
    const onCanvas = canvases.filter((c) => CANVAS_EXISTS.has(c.state) && c.rowIds.some((id) => handedIds.has(id)));
    const n = onCanvas.length;
    steps.push({
      id: 'confirm',
      state: copied ? 'waiting' : 'later',
      title: copied ? `${rowsWord(handed.length)} waiting for Org62` : `${rowsWord(handed.length)} handed off, not in Org62 yet`,
      why: copied
        ? `Prompt copied · the Org62 check confirms ${fmtH(sumH(handed))}`
        : `${fmtH(sumH(handed))}${n ? ` on ${n === 1 ? '1 batch' : `${n} batches`}` : ''} · confirming copies the Slackbot prompt that runs ${n > 1 ? 'them' : 'it'}`,
      verb: `Confirm ${rowsWord(handed.length)}`,
      ids: handed.map((e) => e.id),
      hours: sumH(handed),
      canvases: onCanvas,
    });
  }
  if (needs.length)
    steps.push({
      id: 'fix',
      state: 'later',
      title: `${rowsWord(needs.length)} ${needs.length === 1 ? 'needs' : 'need'} your input`,
      why: needs.map((e) => (e.issues[0] ? (plainIssue(e.issues[0], e) ?? e.description) : e.description)).filter((v, i, xs) => xs.indexOf(v) === i).slice(0, 2).join(' · ') || (taskTypeRequired ? 'Missing an opp, a task type or CF/CR' : 'Missing an opp or CF/CR'),
      verb: 'Show',
      ids: needs.map((e) => e.id),
      hours: sumH(needs),
    });
  // Log DCs now is a choice, never the one filled button: DCs wait for rows unless you ask
  const cur = steps.find((s) => s.state === 'later' && s.id !== 'dcs');
  if (cur) cur.state = 'current';
  return steps;
}

/**
 * Calendar bounds of a Salesforce fiscal quarter label. The fiscal year starts on 1 February, so FY27 runs
 * Feb 2026 to Jan 2027: "Q4 FY27" → 2026-11-01 … 2027-01-31, "Q1 FY27" → 2026-02-01 … 2026-04-30.
 */
export function quarterBounds(label: string): { start: string; end: string } | null {
  const m = /^Q([1-4])\s+FY(\d{2})$/.exec(label.trim());
  if (!m) return null;
  const q = Number(m[1]);
  const fy = 2000 + Number(m[2]);
  const startMonth = 1 + (q - 1) * 3; // 0-based: Feb, May, Aug, Nov — all in calendar year fy − 1
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { start: day(new Date(Date.UTC(fy - 1, startMonth, 1))), end: day(new Date(Date.UTC(fy - 1, startMonth + 3, 0))) };
}

/** Mon–Fri days from `from` to `to`, inclusive (YYYY-MM-DD). */
function workdays(from: string, to: string): number {
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

export interface QuarterPace {
  /** Hours you'd have logged by today at an even pace over the quarter's workdays. */
  expectedH: number;
  /** loggedH − expectedH (negative = behind). */
  deltaH: number;
  /** Within one workday's worth of hours of the even pace counts as on pace. */
  state: 'ahead' | 'on_pace' | 'behind';
  workdaysLeft: number;
}

/**
 * How the quarter is tracking: logged hours against an even pace over the quarter's Mon–Fri days, today
 * included. Null when the label isn't a fiscal quarter, there's no target, or today is outside the quarter.
 */
export function quarterPace(quarter: Pick<TimeWeek['quarter'], 'label' | 'loggedH' | 'targetH'>, nowIso: string, tz?: string): QuarterPace | null {
  const b = quarterBounds(quarter.label);
  if (!b || quarter.targetH <= 0) return null;
  const today = ymd(nowIso, tz);
  if (today < b.start || today > b.end) return null;
  const total = workdays(b.start, b.end);
  const done = workdays(b.start, today);
  const perDay = quarter.targetH / total;
  const expectedH = Math.round(perDay * done * 10) / 10;
  const deltaH = Math.round((quarter.loggedH - expectedH) * 10) / 10;
  const state = quarter.loggedH >= quarter.targetH || deltaH > perDay ? 'ahead' : deltaH < -perDay ? 'behind' : 'on_pace';
  return { expectedH, deltaH, state, workdaysLeft: total - done };
}

/** The quarter log's one color: red past due, amber within 3 days of the deadline, otherwise none. */
export function q4Tone(quarter: TimeWeek['quarter'], nowIso: string): 'danger' | 'warning' | 'none' {
  if (quarter.loggedH >= quarter.targetH || !quarter.due) return 'none';
  const ms = Date.parse(quarter.due) - Date.parse(nowIso);
  if (ms < 0) return 'danger';
  return ms <= 3 * 86_400_000 ? 'warning' : 'none';
}

export interface QuarterRows {
  /** The quarter's rows (GET /time/log over q4Range) with this week's on top, deduped by id. */
  rows: ActivityEntry[];
  /** The current quarter's hours Org62 confirmed (null until the log is in). */
  verifiedH: number | null;
  /**
   * The log is in (or failed, and this week's rows are all there is): until then the counts and Log it's button wait.
   * On this week's rows alone they named 1 row while 71 were ready (2026-11-16).
   */
  loaded: boolean;
}

/** Log it's rows: the quarter's log with this week's payload on top, and whether the log is in yet. */
export function quarterRowsOf(i: { log: Pick<ActivityLog, 'entries' | 'quarters'> | undefined; logFailed?: boolean; week: Pick<TimeWeek, 'entries'> | undefined }): QuarterRows {
  const map = new Map<string, ActivityEntry>();
  for (const e of i.log?.entries ?? []) map.set(e.id, e);
  for (const e of i.week?.entries ?? []) map.set(e.id, e);
  return { rows: [...map.values()], verifiedH: i.log?.quarters.find((q) => q.current)?.verifiedH ?? null, loaded: !!i.week && (!!i.log || !!i.logFailed) };
}
