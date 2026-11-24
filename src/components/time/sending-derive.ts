/**
 * Lane 3, Sending (D-102; 2026-11-23 activity-at-scale AX-5, AX-6, §3.1 lane 3, chunk C6): every batch on its way to
 * Org62 as one line, newest first, with four steps (Staged · Applied · Sent · Checked x of y), its one next action, and
 * the rows Org62 lacks after it ran sitting under it (Log again / Leave out, D-65). Batch-level failures (Apply failed,
 * the last Apply got no answer, the batch was not found in Slack after Apply) are red batch lines with one fix. Finished
 * batches (everything checked in Org62, or every missing row logged again or left out) leave the lane: only their count this week shows, linking to History.
 *
 * Pure. Uses lanes-derive's `batchDone` / `batchFailed`, so the lane header's numbers match `lanesOf(...).sending`.
 */
import type { ActivityEntry, LogCanvas } from '@/contract';
import { clock } from '@/components/domain/lib/time';
import { fmtH } from './derive';
import { batchDone, batchFailed, batchFinished } from './lanes-derive';

export type SendStepId = 'staged' | 'applied' | 'sent' | 'checked';
export type SendStepState = 'done' | 'current' | 'todo' | 'problem';
export interface SendStep {
  id: SendStepId;
  label: string;
  state: SendStepState;
}

/** The batch's one next action (the existing paths only: the Review & apply panel, the Slackbot prompt, the Org62 check). */
export type SendNext = 'apply' | 'apply_again' | 'review' | 'send' | 'recheck' | null;

export const NEXT_LABEL: Record<Exclude<SendNext, null>, string> = {
  apply: 'Review & apply',
  apply_again: 'Apply again',
  review: 'Review it',
  send: 'Send to Org62 via Slackbot',
  recheck: 'Re-check Org62',
};

export interface SendingBatch {
  canvas: LogCanvas;
  /** "Batch 21 Nov", or "Batch 21 Nov 09:14" when another batch shares its day (`batchLabel` over every batch). */
  label: string;
  rows: number;
  hours: number;
  /** "14 rows · 14.5 h" */
  counts: string;
  steps: SendStep[];
  next: SendNext;
  /** A failure of the whole batch, in plain words (the batch line turns red). */
  failure: string | null;
  /** Its rows Org62 lacks after it ran (each with Log again / Leave out). */
  notFound: ActivityEntry[];
  /** "Checked 4 of 6" parts: rows checked in Org62 of the rows on it. */
  checked: { n: number; of: number } | null;
}

export interface SendingModel {
  /** In flight, newest first. */
  batches: SendingBatch[];
  /** Not-found rows whose batch is not in the list (an older batch): shown under "Earlier batches". */
  orphans: ActivityEntry[];
  /** Finished batches this week (History shows them). */
  finishedThisWeek: number;
  /** The lane header: batches in flight, their hours, not found rows and failed batches. */
  header: { batches: number; hours: number; notFound: number; failedBatches: number; failed: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "21 Nov" in the user's zone. */
export function batchDay(iso: string, tz?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', timeZone: tz }).formatToParts(new Date(iso));
    const d = parts.find((p) => p.type === 'day')?.value;
    const m = Number(parts.find((p) => p.type === 'month')?.value);
    if (d && m) return `${Number(d)} ${MONTHS[m - 1]}`;
  } catch {
    /* fall through */
  }
  const dt = new Date(iso);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
}

const CREATED: ReadonlySet<LogCanvas['state']> = new Set(['applied', 'verified', 'unverified']);

/** Rows checked in Org62 of the rows on it (null before Apply, or a batch with no rows). */
export function checkedOf(c: Pick<LogCanvas, 'state' | 'rows' | 'org62' | 'progress'>): { n: number; of: number } | null {
  if (!CREATED.has(c.state) && c.state !== 'applying') return null;
  if (c.progress && c.progress.events.total) return { n: c.progress.events.inOrg62, of: c.progress.events.total };
  if (c.org62 && c.rows) return { n: c.org62.logged, of: c.rows };
  return null;
}

/** The batch-level failure and its one fix, or null. */
export function batchFailure(c: Pick<LogCanvas, 'state' | 'maybeCreated'>): { reason: string; next: SendNext } | null {
  if (c.state === 'retry') return c.maybeCreated ? { reason: 'The last Apply got no answer: check Slack before you apply again', next: 'review' } : { reason: 'The Apply did not go through', next: 'apply_again' };
  if (c.state === 'unverified') return { reason: 'Not found in Slack after Apply', next: 'recheck' };
  return null;
}

/**
 * The four steps, the one the batch is at filled (R2-11): Staged while it waits for Apply (its next action is
 * "Review & apply"), Applied while it waits for the Slackbot send, Sent while Org62 is checked. A step reads done only
 * once the batch has passed it; a failed step is a problem.
 */
export function sendSteps(c: LogCanvas, notFound: number): SendStep[] {
  const created = CREATED.has(c.state);
  const p = c.progress;
  const sent = !!p && (p.state === 'checking' || p.state === 'in_org62' || p.state === 'missing' || !!p.toldAt);
  const ck = checkedOf(c);
  const missing = notFound > 0 || p?.state === 'missing' || (!!c.org62 && c.org62.missing > 0);
  const done = batchDone(c);
  const staged: SendStepState = c.state === 'pending' || c.state === 'applying' ? 'current' : 'done';
  const applied: SendStepState = c.state === 'retry' ? 'problem' : !created ? 'todo' : sent || c.state === 'unverified' ? 'done' : 'current';
  const sentState: SendStepState = !created ? 'todo' : c.state === 'unverified' ? 'problem' : !sent ? 'todo' : done || missing ? 'done' : 'current';
  const checkedState: SendStepState = done ? 'done' : missing ? 'problem' : 'todo';
  return [
    { id: 'staged', label: 'Staged', state: staged },
    { id: 'applied', label: 'Applied', state: applied },
    { id: 'sent', label: 'Sent', state: sentState },
    { id: 'checked', label: ck ? `Checked ${ck.n} of ${ck.of}` : 'Checked', state: checkedState },
  ];
}

/** What the batch waits on. */
export function sendNext(c: LogCanvas, steps: readonly SendStep[]): SendNext {
  const f = batchFailure(c);
  if (f) return f.next;
  if (c.state === 'pending') return 'apply';
  if (c.state === 'applying') return null;
  if (steps.find((s) => s.id === 'applied')?.state === 'current') return 'send';
  return 'recheck';
}

export interface SendingInput {
  canvases?: readonly LogCanvas[] | null;
  /** The rows Org62 lacks after their batch ran (path.needs' org62 group). */
  notFound?: readonly ActivityEntry[];
  /** Monday of this week (YYYY-MM-DD): finished batches applied since count as "this week". */
  weekStart?: string | null;
  tz?: string;
  /** Rows still on their way or not found (`unsettledIds`): a batch whose rows are all checked or settled is finished. */
  unsettled?: ReadonlySet<string>;
}

const whenOf = (c: Pick<LogCanvas, 'appliedAt' | 'createdAt'>) => c.appliedAt ?? c.createdAt;

/**
 * A batch's row count, the one Sending, History ▸ Batches and the quarter card use (R2-4): the rows on the batch as
 * staged. A row Org62 lacks after the batch ran is still a row of the batch.
 */
export function batchRows(c: Pick<LogCanvas, 'rows'>): number {
  return c.rows;
}

/** "14 rows · 14.5 h" (`batchRows`). */
export function batchCounts(c: Pick<LogCanvas, 'rows' | 'hours'>): string {
  return `${rowsWord(batchRows(c))} · ${fmtH(c.hours)}`;
}

type Dated = Pick<LogCanvas, 'draftId' | 'appliedAt' | 'createdAt'>;

/**
 * A batch's name, the same on Sending and History (R2-5): "Batch 22 Nov", and "Batch 22 Nov 09:14" when another of
 * `siblings` falls on the same day, so two batches never share a name. Pass every batch (in flight and finished) as
 * `siblings`, so a batch keeps its name when it moves from Sending to History (F4).
 */
export function batchLabel(c: Dated, siblings: readonly Dated[], tz?: string): string {
  const day = batchDay(whenOf(c), tz);
  const others = siblings.filter((o) => o.draftId !== c.draftId && batchDay(whenOf(o), tz) === day);
  if (!others.length) return `Batch ${day}`;
  const time = clock(whenOf(c), tz);
  // the same minute too (a seed, or two Applies at once): number them in the order they came, the first unnumbered
  const before = others.filter((o) => clock(whenOf(o), tz) === time && (whenOf(o) < whenOf(c) || (whenOf(o) === whenOf(c) && o.draftId < c.draftId))).length;
  return `Batch ${day} ${time}${before ? ` (${before + 1})` : ''}`;
}

export function sendingOf({ canvases, notFound = [], weekStart, tz, unsettled }: SendingInput): SendingModel {
  const all = [...(canvases ?? [])].sort((a, b) => whenOf(b).localeCompare(whenOf(a)));
  const open = all.filter((c) => !batchFinished(c, unsettled));
  const owner = new Map<string, string>();
  for (const c of open) for (const id of c.rowIds) if (!owner.has(id)) owner.set(id, c.draftId);
  const under = new Map<string, ActivityEntry[]>();
  const orphans: ActivityEntry[] = [];
  for (const e of notFound) {
    const d = (e.canvasDraftId && open.some((c) => c.draftId === e.canvasDraftId) ? e.canvasDraftId : null) ?? owner.get(e.id) ?? null;
    if (d) under.set(d, [...(under.get(d) ?? []), e]);
    else orphans.push(e);
  }
  const batches = open.map((c): SendingBatch => {
    const nf = under.get(c.draftId) ?? [];
    const steps = sendSteps(c, nf.length);
    const f = batchFailure(c);
    return {
      canvas: c,
      label: batchLabel(c, all, tz),
      rows: batchRows(c),
      hours: c.hours,
      counts: batchCounts(c),
      steps,
      next: sendNext(c, steps),
      failure: f?.reason ?? null,
      notFound: nf,
      checked: checkedOf(c),
    };
  });
  const since = weekStart ? `${weekStart}T00:00:00` : null;
  const finishedThisWeek = all.filter((c) => batchFinished(c, unsettled) && (!since || whenOf(c) >= since)).length;
  const failedBatches = open.filter(batchFailed).length;
  return {
    batches,
    orphans,
    finishedThisWeek,
    header: { batches: open.length, hours: r2(open.reduce((s, c) => s + c.hours, 0)), notFound: notFound.length, failedBatches, failed: notFound.length + failedBatches },
  };
}

/** The lane header's count: "2 batches · 14.5 h" (or "Nothing on its way"). */
export function sendingCount(h: SendingModel['header']): string {
  return h.batches ? `${h.batches} ${h.batches === 1 ? 'batch' : 'batches'} · ${fmtH(h.hours)}` : 'Nothing on its way';
}

/** The lane header's failure mark: "2 not found · 1 batch failed" (null when nothing failed). */
export function sendingFailure(h: SendingModel['header']): string | null {
  const parts = [h.notFound ? `${h.notFound} not found` : null, h.failedBatches ? `${h.failedBatches} ${h.failedBatches === 1 ? 'batch' : 'batches'} failed` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
