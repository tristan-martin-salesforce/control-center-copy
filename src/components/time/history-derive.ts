/**
 * History's rows, pure (tests/time/history.test.ts): each logged row's Org62 record, and whether it can still be taken
 * back. *Tenet: Nothing leaves without approval* keeps the window honest: a row in a batch that waits for my Apply has
 * not left, so Undo takes it out; once the batch is applied Slackbot may already have written it, and once it is in
 * Org62 the app never deletes or rewrites it there (the round trip's rule 7: external wins, then flag). Then Undo
 * says why it can't, and offers the correction instead.
 */
import type { ActivityEntry, EventUpdateRow, LogCanvas } from '@/contract';
import { fmtH } from './derive';
import { batchFinished } from './lanes-derive';
import type { LogItem } from './log-derive';
import type { QuarterPart, QuarterTruth } from './path-derive';
import { batchCounts, batchLabel, checkedOf } from './sending-derive';

/** The Org62 Event this row is, from its Org62 source (id and link), when the app has read it back. */
export function org62RecordOf(e: Pick<ActivityEntry, 'sources'>): { id: string; url: string | null } | null {
  const s = e.sources.find((x) => x.kind === 'org62' && x.externalId);
  return s?.externalId ? { id: s.externalId, url: s.url ?? null } : null;
}

export type UndoWindow =
  /** It waits in a batch I have not applied: Undo takes it out (it goes back to Ready to log). */
  | { state: 'open'; draftId: string; label: string; why: string }
  /** Too late to take back: why, and the correction to make instead. */
  | { state: 'closed'; why: string; fix: string }
  /** Nothing to undo (a row the app never sent, an excluded one). */
  | { state: 'none' };

export function undoWindowOf(e: Pick<ActivityEntry, 'status' | 'canvasDraftId' | 'fromOrg62'>): UndoWindow {
  if (e.canvasDraftId && e.status !== 'logged' && e.status !== 'verified') return { state: 'open', draftId: e.canvasDraftId, label: 'Take it out of the batch', why: 'It waits in a batch you have not applied, so nothing has gone to Org62 yet.' };
  if (e.fromOrg62) return { state: 'none' };
  if (e.status === 'synced_to_canvas')
    return {
      state: 'closed',
      why: 'The batch was applied: Slackbot may already have written it to Org62, so the app can’t take it back.',
      fix: 'If it is wrong, change it in Org62; the app reads it back and follows. If Org62 never gets it, it shows under Needs you with Log again and Leave out.',
    };
  if (e.status === 'logged' || e.status === 'verified')
    return {
      state: 'closed',
      why: 'It is in Org62 already, and the app never deletes or rewrites what is there.',
      fix: 'Change or delete it in Org62; the app follows on its next check, and a row deleted there comes back under Needs you to log again or leave out.',
    };
  return { state: 'none' };
}

/** A correction to an Event already in Org62, as History lists it: what changes, its state, and its one verb. */
export interface CorrectionView {
  id: string;
  title: string;
  what: string;
  state: 'waiting' | 'approved' | 'dismissed';
  /** Undo for a dismissed one (it comes back as suggested); Dismiss for the rest. */
  verb: { label: 'Undo' | 'Dismiss'; action: 'restore' | 'dismiss' };
}

export function correctionOf(u: EventUpdateRow): CorrectionView {
  const what = [u.summary.replace(/^update · /, ''), u.reason].filter(Boolean).join(' · ');
  if (u.state === 'dismissed') return { id: u.writeId, title: u.label, what, state: 'dismissed', verb: { label: 'Undo', action: 'restore' } };
  return { id: u.writeId, title: u.label, what, state: u.state === 'approved' ? 'approved' : 'waiting', verb: { label: 'Dismiss', action: 'dismiss' } };
}

export const CORRECTION_STATE: Record<CorrectionView['state'], string> = {
  waiting: 'Suggested: it goes in your next batch when you log it',
  approved: 'Approved: in your next batch',
  dismissed: 'Dismissed: Org62 keeps its value',
};

// ── Batches (Activity-at-scale C8, §4 History: "History owns the past") ──────────────────────────────────────────

const whenOf = (c: Pick<LogCanvas, 'appliedAt' | 'createdAt'>) => c.appliedAt ?? c.createdAt;

// the finished rule lives with the lanes (./lanes-derive.ts), so To log ▸ Sending and History ▸ Batches tell each batch
// in one place only
export { batchFinished };

export interface FinishedBatch {
  canvas: LogCanvas;
  /** "Batch 21 Nov" (`batchLabel` over every batch: the name it had on Sending) */
  label: string;
  /** "Batch 21 Nov · 14 rows · 14.5 h · Checked 14 of 14" */
  line: string;
  /** Where its hours landed in Org62, by quarter: "Landed in Q3 FY27 2.5 h · Q4 FY27 6 h" (null: not known). */
  landed: string | null;
}

/** "Landed in Q4 FY27", or by quarter when its rows span quarters: "Landed in Q3 FY27 2.5 h · Q4 FY27 6 h". */
export function landedLine(c: Pick<LogCanvas, 'quarters'>): string | null {
  const qs = (c.quarters ?? []).filter((q) => q.hours > 0);
  if (!qs.length) return null;
  if (qs.length === 1) return `Landed in ${qs[0]!.label}`;
  return `Landed in ${qs.map((q) => `${q.label} ${fmtH(q.hours)}`).join(' · ')}`;
}

export interface BatchOpts {
  /** Rows still on their way or not found (`unsettledIds`). */
  unsettled?: ReadonlySet<string>;
  tz?: string;
}

/** History ▸ Batches: the finished batches, newest first. */
export function finishedBatchesOf(canvases: readonly LogCanvas[] | null | undefined, opts: BatchOpts = {}): FinishedBatch[] {
  const all = canvases ?? [];
  return [...all]
    .filter((c) => batchFinished(c, opts.unsettled))
    .sort((a, b) => whenOf(b).localeCompare(whenOf(a)))
    .map((c) => {
      const label = batchLabel(c, all, opts.tz);
      const ck = checkedOf(c);
      const parts = [label, batchCounts(c), ck ? `Checked ${ck.n} of ${ck.of}` : null].filter(Boolean);
      return { canvas: c, label, line: parts.join(' · '), landed: landedLine(c) };
    });
}

/** A row handed to a batch still in To log ▸ Sending: History marks it quietly, once ("in batch 21 Nov"). */
export interface InBatch {
  draftId: string;
  /** "in batch 21 Nov" */
  label: string;
  /** The batch waits for Apply: Undo (take it out) is still valid there. */
  pending: boolean;
}

/** Row id → the in-flight batch it rides on (batches not finished; the newest wins). */
export function inBatchOf(canvases: readonly LogCanvas[] | null | undefined, opts: BatchOpts = {}): Map<string, InBatch> {
  const out = new Map<string, InBatch>();
  const all = canvases ?? [];
  const open = [...all].filter((c) => !batchFinished(c, opts.unsettled)).sort((a, b) => whenOf(b).localeCompare(whenOf(a)));
  for (const c of open) {
    const label = `in ${batchLabel(c, all, opts.tz).replace(/^Batch/, 'batch')}`;
    for (const id of c.rowIds) if (!out.has(id)) out.set(id, { draftId: c.draftId, label, pending: c.state === 'pending' });
  }
  return out;
}

/** Batches still in To log ▸ Sending (not finished): the quarter card's one "N batches in flight ▸ Sending" line. */
export function inFlightCount(canvases: readonly LogCanvas[] | null | undefined, opts: BatchOpts = {}): number {
  return (canvases ?? []).filter((c) => !batchFinished(c, opts.unsettled)).length;
}

/** The parts the card tells: what waits on you before a batch (need you, ready to log). A batch's own steps are Sending's. */
const CARD_PARTS: ReadonlySet<QuarterPart['id']> = new Set(['needs', 'ready']);

/** The card's "Waiting on you" block without the in-flight parts (to apply, to send): Sending tells those (F4). */
export function cardWaiting(w: QuarterTruth['waiting']): QuarterTruth['waiting'] {
  const parts = w.parts.filter((p) => CARD_PARTS.has(p.id));
  return { parts, rows: parts.reduce((s, p) => s + p.rows, 0), hours: Math.round(parts.reduce((s, p) => s + p.hours, 0) * 100) / 100 };
}

/** "2 batches in flight" (null: none). */
export function inFlightLine(n: number | undefined): string | null {
  return n ? `${n} ${n === 1 ? 'batch' : 'batches'} in flight` : null;
}

/** What History's compact row says about a row: its batch (in flight, said once), waiting on you, left out, or done. */
export type HistoryState =
  | { kind: 'in_batch'; text: string; draftId: string; pending: boolean }
  | { kind: 'waiting'; text: string }
  | { kind: 'excluded' }
  | { kind: 'done' };

const DONE = new Set<ActivityEntry['status']>(['logged', 'verified', 'synced_to_canvas', 'verify_failed']);

export function historyStateOf(e: Pick<ActivityEntry, 'id' | 'status'>, inBatch: ReadonlyMap<string, InBatch>): HistoryState {
  if (e.status === 'dismissed') return { kind: 'excluded' };
  const b = inBatch.get(e.id);
  if (b && e.status !== 'logged' && e.status !== 'verified') return { kind: 'in_batch', text: b.pending ? `${b.label} · waiting for your Apply` : b.label, draftId: b.draftId, pending: b.pending };
  if (DONE.has(e.status)) return { kind: 'done' };
  return { kind: 'waiting', text: 'Waiting on you in To log' };
}

/** The rows still unsettled: on their way to Org62, or not found after their batch ran. */
export function unsettledIds(rows: readonly Pick<ActivityEntry, 'id' | 'status'>[]): Set<string> {
  return new Set(rows.filter((e) => e.status === 'synced_to_canvas' || e.status === 'verify_failed').map((e) => e.id));
}

// ── Scale: rows paged per day, at most four weeks open (§3.4) ─────────────────────────────────────────────────────

export type HistoryItem =
  | Exclude<LogItem, { kind: 'week' }>
  | (Extract<LogItem, { kind: 'week' }> & { open: boolean })
  | { kind: 'more'; key: string; day: string; hidden: number };

export const ROWS_PER_DAY = 8;
export const MAX_OPEN_WEEKS = 4;

/** The first `maxOpen` weeks of a list (the default open set). */
export function defaultOpenWeeks(items: readonly LogItem[], maxOpen = MAX_OPEN_WEEKS): Set<string> {
  return new Set(items.flatMap((it) => (it.kind === 'week' ? [it.weekStart] : [])).slice(0, maxOpen));
}

/**
 * Pages the flat list: a day shows 8 rows then "Show N more" (until opened, `days`), and only the open weeks show
 * their days (`weeks`; default the first four). A closed week is its header with its counts.
 */
export function pageHistoryItems(items: readonly LogItem[], view: { days?: ReadonlySet<string>; weeks?: ReadonlySet<string> | null; perDay?: number } = {}): HistoryItem[] {
  const perDay = view.perDay ?? ROWS_PER_DAY;
  const weeks = view.weeks ?? defaultOpenWeeks(items);
  const out: HistoryItem[] = [];
  let weekOpen = true;
  let day: string | null = null;
  let shown = 0;
  let hidden = 0;
  const flush = () => {
    if (day && hidden) out.push({ kind: 'more', key: `m:${day}`, day, hidden });
    hidden = 0;
  };
  for (const it of items) {
    if (it.kind === 'week') {
      flush();
      day = null;
      weekOpen = weeks.has(it.weekStart);
      out.push({ ...it, open: weekOpen });
    } else if (it.kind === 'day') {
      flush();
      day = it.day;
      shown = 0;
      if (weekOpen) out.push(it);
    } else if (it.kind === 'row') {
      if (!weekOpen) continue;
      if (shown < perDay || (day && view.days?.has(day))) {
        out.push(it);
        shown += 1;
      } else hidden += 1;
    } else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}
