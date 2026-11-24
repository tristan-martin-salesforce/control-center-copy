/**
 * The drain mode's state, pure (ReviewQueue.tsx draws it). One card at a time over a queue whose order never moves:
 *
 *  - `order` keeps every row in the place it had, acted ones included, so Undo puts a row back exactly where it was.
 *  - Arrivals while you drain go to the end (live-merge.ts, place 'end', never behind the pill: the queue is the
 *    focus) and are marked new. A row that left elsewhere drops out, except the one on screen: it stays, marked gone
 *    ("Handled elsewhere"), until you move on (D-73).
 *  - Acting moves to the next row still to do (else the previous one, else the end: "That's everything").
 *  - Consecutive acts with the same verb form one batch ("Approved 6 · Undo"); a different verb, a bulk approve or the
 *    toast closing starts a new one. Undo reverts only the open batch.
 *  - A failed act puts the row back with its error; it stays as a Retry card, never a toast.
 */
import { mergeLive } from '@/components/lists/live-merge';

export type ReviewVerb = 'approve' | 'snooze' | 'dismiss';

export interface ReviewBatch {
  n: number;
  verb: ReviewVerb;
  ids: string[];
}

export interface QueueModel {
  order: string[];
  acted: Readonly<Record<string, ReviewVerb>>;
  cursor: string | null;
  /** The open batch (its toast offers Undo). */
  batch: ReviewBatch | null;
  nextBatch: number;
  /** Arrivals since the queue opened. */
  fresh: string[];
  /** The row on screen left elsewhere. */
  gone: string[];
  failed: Readonly<Record<string, string>>;
}

export function initQueue(ids: readonly string[]): QueueModel {
  return { order: [...ids], acted: {}, cursor: ids[0] ?? null, batch: null, nextBatch: 1, fresh: [], gone: [], failed: {} };
}

/** Rows still to do, in order (the gone row on screen included until you move on). */
export function pendingOf(m: QueueModel): string[] {
  return m.order.filter((id) => !m.acted[id]);
}

export function progressOf(m: QueueModel): { position: number; total: number; done: number } {
  const pending = pendingOf(m);
  const done = m.order.length - pending.length;
  const at = m.cursor ? pending.indexOf(m.cursor) : -1;
  return { position: at >= 0 ? done + at + 1 : done, total: m.order.length, done };
}

export function summaryOf(m: QueueModel): Record<ReviewVerb, number> {
  const out: Record<ReviewVerb, number> = { approve: 0, snooze: 0, dismiss: 0 };
  for (const v of Object.values(m.acted)) out[v] += 1;
  return out;
}

/** Fresh data from the server (its order). */
export function syncQueue(m: QueueModel, incoming: readonly string[]): QueueModel {
  const r = mergeLive({ shown: m.order, incoming, place: 'end', flush: true, linger: (id) => !!m.acted[id] || id === m.cursor });
  const gone = r.lingering.filter((id) => !m.acted[id]);
  const fresh = [...m.fresh.filter((id) => r.order.includes(id)), ...r.inserted.filter((id) => !m.fresh.includes(id))];
  const next: QueueModel = { ...m, order: r.order, gone, fresh };
  if (!next.cursor || !next.order.includes(next.cursor)) next.cursor = pendingOf(next)[0] ?? null;
  return next;
}

function after(m: QueueModel, id: string, acted: Readonly<Record<string, ReviewVerb>>): string | null {
  const i = m.order.indexOf(id);
  for (let j = i + 1; j < m.order.length; j++) if (!acted[m.order[j]!]) return m.order[j]!;
  for (let j = i - 1; j >= 0; j--) if (!acted[m.order[j]!]) return m.order[j]!;
  return null;
}

function withoutFailure(failed: Readonly<Record<string, string>>, ids: readonly string[]): Record<string, string> {
  const out = { ...failed };
  for (const id of ids) delete out[id];
  return out;
}

/** Act on one row: it joins the open batch when the verb matches, else starts a new one. */
export function actOn(m: QueueModel, id: string, verb: ReviewVerb): QueueModel {
  if (m.acted[id] || !m.order.includes(id) || m.gone.includes(id)) return m;
  const acted = { ...m.acted, [id]: verb };
  const joins = m.batch && m.batch.verb === verb;
  const batch = joins ? { ...m.batch!, ids: [...m.batch!.ids, id] } : { n: m.nextBatch, verb, ids: [id] };
  return { ...m, acted, batch, nextBatch: joins ? m.nextBatch : m.nextBatch + 1, cursor: m.cursor === id || !m.cursor ? after(m, id, acted) : m.cursor, failed: withoutFailure(m.failed, [id]) };
}

/** A bulk act ("Approve all sure"): always its own batch. */
export function actOnMany(m: QueueModel, ids: readonly string[], verb: ReviewVerb): QueueModel {
  const take = ids.filter((id) => !m.acted[id] && m.order.includes(id) && !m.gone.includes(id));
  if (!take.length) return m;
  const acted = { ...m.acted };
  for (const id of take) acted[id] = verb;
  const cursor = m.cursor && acted[m.cursor] ? after(m, m.cursor, acted) : m.cursor;
  return { ...m, acted, batch: { n: m.nextBatch, verb, ids: [...take] }, nextBatch: m.nextBatch + 1, cursor, failed: withoutFailure(m.failed, take) };
}

/** The act failed: the row is back, on screen, with its error. */
export function failOn(m: QueueModel, id: string, message: string): QueueModel {
  if (!m.acted[id]) return m;
  const acted = { ...m.acted };
  delete acted[id];
  const ids = m.batch?.ids.filter((x) => x !== id) ?? [];
  return { ...m, acted, batch: m.batch && ids.length ? { ...m.batch, ids } : null, cursor: id, failed: { ...m.failed, [id]: message } };
}

/** Undo the open batch only: its rows return to their places; the first of them is on screen. */
export function undoBatch(m: QueueModel): QueueModel {
  if (!m.batch) return m;
  const acted = { ...m.acted };
  for (const id of m.batch.ids) delete acted[id];
  const first = m.order.find((id) => m.batch!.ids.includes(id)) ?? m.cursor;
  return { ...m, acted, batch: null, cursor: first };
}

/** The toast closed: the batch can no longer be undone from here. */
export function closeBatch(m: QueueModel): QueueModel {
  return m.batch ? { ...m, batch: null } : m;
}

/** j (+1) / k (−1) over the rows still to do. Leaving a gone row drops it. */
export function moveCursor(m: QueueModel, dir: 1 | -1): QueueModel {
  const pending = pendingOf(m);
  if (!pending.length) return m;
  const at = m.cursor ? pending.indexOf(m.cursor) : -1;
  const leaving = m.cursor && m.gone.includes(m.cursor) ? m.cursor : null;
  if (leaving) {
    // a gone row never stays the only way forward: past either end, go the other way, or to the end screen
    const target = pending[at + dir] ?? pending[at - dir] ?? null;
    return { ...m, cursor: target, order: m.order.filter((id) => id !== leaving), gone: m.gone.filter((id) => id !== leaving) };
  }
  const target = pending[Math.min(pending.length - 1, Math.max(0, at + dir))] ?? null;
  return !target || target === m.cursor ? m : { ...m, cursor: target };
}
