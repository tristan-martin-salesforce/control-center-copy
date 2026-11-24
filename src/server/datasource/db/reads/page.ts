/**
 * List paging for the page reads (p4-page-scoped-reads; both DataSources call it, so they page alike). Additive:
 * no `limit` returns every row and no `nextCursor` (as before). With `limit`, `nextCursor` is the next page's
 * cursor, null on the last. The cursor is opaque to clients. Pagination, never a cap: a first-scan backfill day with
 * thousands of rows pages through all of them (RD-3).
 *
 *   offset cursor (`o:<n>`)   Deals: an offset into the page's own order (its rows don't move between pages)
 *   keyset cursor (`k:…`)     the Work list's Closed tab (P25-6): the last row's (closed at, created at, id), so a close
 *                             or a reopen between pages neither repeats nor skips a row (closedCursor below)
 */
import type { ItemsPayload, WorkItem } from '@/contract';

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  rows: T[];
  /** undefined without `limit`; null on the last page. */
  nextCursor?: string | null;
}

const PREFIX = 'o:';

export function pageOf<T>(rows: readonly T[], q: PageQuery | undefined): Page<T> {
  if (!q?.limit) return { rows: [...rows] };
  const start = cursorOffset(q.cursor);
  const end = start + q.limit;
  return { rows: rows.slice(start, end), nextCursor: nextCursorOf(end, rows.length) };
}

/** The next page's cursor when the page ending at `end` (exclusive) leaves rows of `total`; null on the last. */
export function nextCursorOf(end: number, total: number): string | null {
  return end < total ? `${PREFIX}${end}` : null;
}

/** A cursor this module made (anything else reads from the start): the offset a page store pages from in SQL. */
export function cursorOffset(c: string | undefined): number {
  if (!c?.startsWith(PREFIX)) return 0;
  const n = Number(c.slice(PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// The Closed tab's keyset cursor (P25-6)
// ---------------------------------------------------------------------------

/** Where a Closed page ended: the last row's closed and created instants (epoch ms; closed null sorts last) and id. */
export interface ClosedKey {
  doneMs: number | null;
  createdMs: number;
  id: string;
}

const KEY_PREFIX = 'k:';
const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

export const closedKeyOf = (w: Pick<WorkItem, 'doneAt' | 'createdAt' | 'id'>): ClosedKey => ({ doneMs: ms(w.doneAt), createdMs: ms(w.createdAt) ?? 0, id: w.id });

/** The opaque cursor for the page after `k` (base64url of "closed.created.id", the instants in base 36). */
export function closedCursor(k: ClosedKey): string {
  const raw = `${k.doneMs === null ? '-' : k.doneMs.toString(36)}.${k.createdMs.toString(36)}.${k.id}`;
  return `${KEY_PREFIX}${Buffer.from(raw, 'utf8').toString('base64url')}`;
}

/** A keyset cursor this module made, or null (anything else, an old `o:` cursor included, reads from the start). */
export function parseClosedCursor(c: string | undefined): ClosedKey | null {
  if (!c?.startsWith(KEY_PREFIX)) return null;
  const m = /^(-|[0-9a-z]+)\.([0-9a-z]+)\.(.+)$/.exec(Buffer.from(c.slice(KEY_PREFIX.length), 'base64url').toString('utf8'));
  if (!m) return null;
  const doneMs = m[1] === '-' ? null : parseInt(m[1]!, 36);
  const createdMs = parseInt(m[2]!, 36);
  return Number.isFinite(createdMs) && (doneMs === null || Number.isFinite(doneMs)) ? { doneMs, createdMs, id: m[3]! } : null;
}

/** The Closed order on the key alone (closed newest first, null last; then created oldest first): <0 = a before b. */
export function compareClosedKey(a: Omit<ClosedKey, 'id'>, b: Omit<ClosedKey, 'id'>): number {
  if (a.doneMs !== b.doneMs) return a.doneMs === null ? 1 : b.doneMs === null ? -1 : b.doneMs - a.doneMs;
  return a.createdMs - b.createdMs;
}

/**
 * The rows after the cursor in a Closed list already in the view's order: after the cursor's row when it is still
 * there with the same key; otherwise (reopened, or closed again later) after every row with an earlier key, so a row
 * that left the list between pages skips nothing (ties with its key may repeat; the client dedupes by id).
 */
export function closedRowsAfter<T extends Pick<WorkItem, 'doneAt' | 'createdAt' | 'id'>>(rows: readonly T[], k: ClosedKey): T[] {
  const at = rows.findIndex((r) => r.id === k.id);
  if (at >= 0 && compareClosedKey(closedKeyOf(rows[at]!), k) === 0) return rows.slice(at + 1);
  return rows.filter((r) => compareClosedKey(closedKeyOf(r), k) >= 0 && r.id !== k.id);
}

/**
 * The Work list's page (GET /items, both DataSources): with `limit`, the tab's rows from `cursor` and the next cursor;
 * `total` stays the tab's rows over every page. Without `limit`, the payload as it was. The Closed tab pages by its
 * keyset cursor, the other tabs (ranked lists that re-rank under the user) by offset.
 */
export function pageList(view: ItemsPayload, q: PageQuery | undefined): ItemsPayload {
  if (!q?.limit) return view;
  if (view.tab === 'done') {
    const k = parseClosedCursor(q.cursor);
    const rest = k ? closedRowsAfter(view.items, k) : view.items;
    return closedPage(view, rest, q.limit);
  }
  const p = pageOf(view.items, q);
  return { ...view, items: p.rows, nextCursor: p.nextCursor ?? null };
}

/** `limit` of `rest` (the rows after the cursor; one more tells whether a next page exists) and its keyset cursor. */
export function closedPage(view: ItemsPayload, rest: readonly WorkItem[], limit: number): ItemsPayload {
  const items = rest.slice(0, limit);
  const last = items[items.length - 1];
  return { ...view, items, nextCursor: rest.length > limit && last ? closedCursor(closedKeyOf(last)) : null };
}
