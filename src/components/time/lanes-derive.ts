/**
 * The one count on Activity ▸ To log (2026-11-23 activity-at-scale, AX-2, §3.4 "Counts", chunk C1). Every number the
 * page says about its lanes comes from `lanesOf`: the header sentence, the To log tab badge, the Needs you and Ready
 * to log section counts, the quarter card's "need you" part and "Select all N". Pure; tested in ./rows.test.ts.
 *
 *   fix       rows that cannot log yet (Needs you), without Internal rows (D-64: no opportunity by design, never a
 *             need) and without the rows Org62 lacks after their batch ran (those are lane 3's failures)
 *   ready     rows Log puts in the next batch (the Ready stage: approved, or complete and proposed while Settings ▸
 *             approve complete is on), not on a batch yet
 *   sending   batches staged, applied or sent and not finished (`batchFinished`: checked in Org62 or settled); `failed` = rows not found in Org62
 *             after their batch ran plus batches that failed as a whole (Apply failed, or the read-back missed it)
 *   internal  the internal-only rows the app suggests (a quiet group, never counted as needs)
 *
 * The badge (what needs you) is `fix.rows + sending.failed`.
 */
import type { ActivityEntry, LogCanvas } from '@/contract';
import { batchFailed } from '@/engines/activity/to-log-count';
import type { LogPath, NeedsYou } from './path-derive';

export interface Lanes {
  fix: { rows: number; hours: number; ids: string[] };
  ready: { rows: number; hours: number };
  sending: { batches: number; rows: number; hours: number; failed: number; notFound: number; failedBatches: number };
  internal: { rows: number };
  /** The tab badge and the header's "need you": fix rows plus sending failures. */
  badge: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const sumH = (xs: readonly Pick<ActivityEntry, 'durationH'>[]) => r2(xs.reduce((s, e) => s + e.durationH, 0));

/** Needs-you rows that are lane 1 (fix): not the Not-in-Org62 group (lane 3), never an Internal row (D-64). */
export function fixRowsOf(needs: Pick<NeedsYou, 'groups'>): ActivityEntry[] {
  return needs.groups.filter((g) => g.kind !== 'org62').flatMap((g) => g.rows.filter((e) => !e.internal));
}

/** A batch that failed as a whole (the shared rule: src/engines/activity/to-log-count.ts). */
export { batchFailed };

/** A batch Org62 has all of (checked): it leaves lane 3 for History. */
export function batchDone(c: Pick<LogCanvas, 'state' | 'org62' | 'progress'>): boolean {
  if (c.state === 'pending' || batchFailed(c)) return false;
  if (c.progress) return c.progress.state === 'in_org62';
  return !!c.org62 && c.org62.waiting === 0 && c.org62.missing === 0;
}

/**
 * A batch is finished when every row on it is checked in Org62 or settled (logged again / left out): Org62 has it all,
 * or it waits on nothing and none of its rows is still unsettled (`unsettled`: ids of rows on their way or not found,
 * history-derive's `unsettledIds`). A pending, applying or failed batch is never finished: it lives in To log ▸
 * Sending. Finished batches leave Sending and show in History ▸ Batches (C10: one rule for both).
 */
export function batchFinished(c: Pick<LogCanvas, 'state' | 'org62' | 'progress' | 'rowIds'>, unsettled?: ReadonlySet<string>): boolean {
  if (c.state === 'pending' || c.state === 'applying' || batchFailed(c)) return false;
  if (batchDone(c)) return true;
  if (!unsettled || !c.org62 || c.org62.waiting > 0) return false;
  if (c.progress && c.progress.state !== 'in_org62' && c.progress.state !== 'missing') return false;
  return !c.rowIds.some((id) => unsettled.has(id));
}

export interface LanesInput {
  path: Pick<LogPath, 'needs' | 'readyIds' | 'internal'>;
  rows: readonly ActivityEntry[];
  canvases?: readonly LogCanvas[] | null;
  /** Rows still on their way or not found (history-derive `unsettledIds`): a batch with none of them left is finished. */
  unsettled?: ReadonlySet<string>;
}

export function lanesOf({ path, rows, canvases, unsettled }: LanesInput): Lanes {
  const byId = new Map(rows.map((e) => [e.id, e] as const));
  const fix = fixRowsOf(path.needs);
  const ready = path.readyIds.map((id) => byId.get(id)).filter((e): e is ActivityEntry => !!e);
  const open = (canvases ?? []).filter((c) => !batchFinished(c, unsettled));
  const notFound = path.needs.groups.find((g) => g.kind === 'org62')?.rows.length ?? 0;
  const failedBatches = open.filter(batchFailed).length;
  const failed = notFound + failedBatches;
  return {
    fix: { rows: fix.length, hours: sumH(fix), ids: fix.map((e) => e.id) },
    ready: { rows: ready.length, hours: sumH(ready) },
    sending: { batches: open.length, rows: open.reduce((s, c) => s + c.rows, 0), hours: r2(open.reduce((s, c) => s + c.hours, 0)), failed, notFound, failedBatches },
    internal: { rows: path.internal.rows.length },
    badge: fix.length + failed,
  };
}
