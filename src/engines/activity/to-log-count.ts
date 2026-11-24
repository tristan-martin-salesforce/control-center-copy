/**
 * Activity ▸ To log's one count, the rule both sides read (2026-11-23 activity follow-ups, C10): the To log tab badge
 * (src/components/time/lanes-derive.ts `lanesOf(...).badge`, over path-derive's `needsYou`, which groups the same rows)
 * and the sidebar's Activity badge (GET /today `navCounts.toLog`, src/server/views/today.ts). Before this the sidebar
 * counted approvals only and said 1 while the tab said 38. Pure and a leaf (no overlap-flags: the count needs no kind);
 * tests/time/internal-activity.test.ts (C10) pins `toLogCount(...).badge === lanesOf(...).badge`.
 *
 *   fix       live rows that cannot log yet (not on a canvas, not on an applied batch), never an Internal row (D-64)
 *   notFound  rows Org62 lacks after their batch ran (D-65: Log again / Leave out), lane 3's failures
 *   failed    batches that failed as a whole: the Apply failed (retry) or the read-back did not find it (unverified)
 */
import type { ActivityEntry, LogCanvas } from '@/contract';
import { needsRelog } from './org62-check';
import { hasTarget } from '@/lib/time-internal';

const LIVE: ReadonlySet<ActivityEntry['status']> = new Set(['needs_input', 'proposed', 'approved']);
/** What the count reads of a batch: its state and (when known) its rows and its Org62 check. */
export type CanvasLike = Pick<LogCanvas, 'state'> & Partial<Pick<LogCanvas, 'rowIds' | 'org62' | 'progress'>>;
const APPLIED: ReadonlySet<LogCanvas['state']> = new Set(['applying', 'applied', 'verified', 'unverified']);

/** Rows on a canvas you applied (created, or on its way): handed off, never offered to Log or to Needs you again. */
export function appliedRowIds(canvases: readonly CanvasLike[] | null | undefined): Set<string> {
  return new Set((canvases ?? []).filter((c) => APPLIED.has(c.state)).flatMap((c) => c.rowIds ?? []));
}

/**
 * A live row that cannot log without you (Needs you; path-derive's `missingOf` names what is missing, only for these):
 * no opportunity (and not internal, D-64), no task type where the persona needs one, zero hours, or held by the scan.
 */
export function cannotLogYet(e: Pick<ActivityEntry, 'status' | 'oppId' | 'internal' | 'taskType' | 'durationH'>, taskTypeRequired = true): boolean {
  if (!LIVE.has(e.status)) return false;
  return !hasTarget(e) || (taskTypeRequired && !e.taskType) || e.durationH <= 0 || e.status === 'needs_input';
}

/** The need a row is: not found in Org62 (lane 3), a fix (lane 1: open, not handed to a batch), or none. */
export function openNeedOf(e: ActivityEntry, applied: ReadonlySet<string>, taskTypeRequired = true): 'org62' | 'fix' | null {
  // D-65 (TL-14, TL-20): a row not in Org62 after all needs you even though a canvas carried it
  if (needsRelog(e)) return 'org62';
  return !e.canvasDraftId && !applied.has(e.id) && cannotLogYet(e, taskTypeRequired) ? 'fix' : null;
}

/** A batch that failed as a whole: its Apply failed (retry), or the read-back did not find the work order. */
export const batchFailed = (c: Pick<LogCanvas, 'state'>): boolean => c.state === 'retry' || c.state === 'unverified';

export interface ToLogCount {
  fix: number;
  notFound: number;
  failedBatches: number;
  /** What needs you on To log: fix rows plus sending failures (not-found rows and failed batches). */
  badge: number;
}

export function toLogCount(input: { rows: readonly ActivityEntry[]; canvases?: readonly CanvasLike[] | null; taskTypeRequired?: boolean }): ToLogCount {
  const applied = appliedRowIds(input.canvases);
  let fix = 0;
  let notFound = 0;
  for (const e of input.rows) {
    const k = openNeedOf(e, applied, input.taskTypeRequired ?? true);
    if (k === 'org62') notFound++;
    else if (k && !e.internal) fix++;
  }
  const failedBatches = (input.canvases ?? []).filter(batchFailed).length;
  return { fix, notFound, failedBatches, badge: fix + notFound + failedBatches };
}

// ── Lane 2 and lane 3 (R3-8, 2026-11-23 wave-2 review): what Home's queue row says below its first number ─────────────
// The same rules as src/components/time/derive.ts `isLoggable` (lane 2's readyIds, via q4Steps) and
// src/components/time/lanes-derive.ts `batchFinished` (lane 3's open batches); tests/time/internal-activity.test.ts
// pins the queue row's parts to `lanesOf(...)` at scale 7.

/**
 * A row the next batch logs (lane 2, Ready to log): not on a batch, ended, approved (or proposed and complete while
 * Settings ▸ approve complete is on), with an opportunity (an Internal row: approved only, D-64), a task type where
 * the persona needs one, and some hours.
 */
export function readyToLog(e: ActivityEntry, applied: ReadonlySet<string>, nowMs: number, taskTypeRequired = true, approveComplete = true): boolean {
  if (e.canvasDraftId || applied.has(e.id) || Date.parse(e.end) > nowMs) return false;
  if (e.internal) return e.status === 'approved' && (!taskTypeRequired || !!e.taskType) && e.durationH > 0;
  if (e.status !== 'approved' && !(approveComplete && e.status === 'proposed')) return false;
  return !!e.oppId && (!taskTypeRequired || !!e.taskType) && e.durationH > 0;
}

/** Rows still on their way or not found (history-derive's `unsettledIds`). */
export const unsettledRowIds = (rows: readonly Pick<ActivityEntry, 'id' | 'status'>[]): Set<string> =>
  new Set(rows.filter((e) => e.status === 'synced_to_canvas' || e.status === 'verify_failed').map((e) => e.id));

/** A batch is finished (it leaves lane 3 for History): Org62 has it all, or none of its rows is still unsettled. */
export function batchFinished(c: CanvasLike, unsettled?: ReadonlySet<string>): boolean {
  if (c.state === 'pending' || c.state === 'applying' || batchFailed(c)) return false;
  const done = c.progress ? c.progress.state === 'in_org62' : !!c.org62 && c.org62.waiting === 0 && c.org62.missing === 0;
  if (done) return true;
  if (!unsettled || !c.org62 || c.org62.waiting > 0) return false;
  if (c.progress && c.progress.state !== 'in_org62' && c.progress.state !== 'missing') return false;
  return !(c.rowIds ?? []).some((id) => unsettled.has(id));
}

export interface ToLogLanes extends ToLogCount {
  /** Lane 2's rows. */
  ready: ActivityEntry[];
  /** Lane 3's open batches: staged, applied or sent and not finished. */
  sending: number;
}

/** The To log lanes' counts over the one row set and its batches: lane 1 (fix), lane 2 (ready), lane 3 (sending). */
export function toLogLanes(input: { rows: readonly ActivityEntry[]; canvases?: readonly CanvasLike[] | null; nowMs: number; taskTypeRequired?: boolean; approveComplete?: boolean }): ToLogLanes {
  const applied = appliedRowIds(input.canvases);
  const req = input.taskTypeRequired ?? true;
  const ready = input.rows.filter((e) => readyToLog(e, applied, input.nowMs, req, input.approveComplete ?? true));
  const unsettled = unsettledRowIds(input.rows);
  const sending = (input.canvases ?? []).filter((c) => !batchFinished(c, unsettled)).length;
  return { ...toLogCount(input), ready, sending };
}
