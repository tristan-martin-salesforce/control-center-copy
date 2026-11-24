/**
 * Paging a long list (Work ▸ Closed; GET /items `limit` + `cursor` → `nextCursor`): the page shows a window of the
 * first N rows and a "Show 50 more" row under it.
 *
 *   Show more   fetches the next page with the window's `nextCursor`, appends it (rows already on screen keep their
 *               place; a row the window already holds is not added twice) and seeds the window's own query, so the
 *               next live refetch reads the whole window (`limit` = pages × size) and the live-list merge applies it
 *               as usual: arrivals at their place, rows closed elsewhere fading, nothing reordered under you.
 *   Counts      always the payload's (`counts`, `total`): every row over every page, never the rows loaded.
 */

/** Rows per page on a paged tab. */
export const PAGE_SIZE = 50;

export interface PagedPayload<T extends { id: string }> {
  items: T[];
  total: number;
  nextCursor?: string | null;
}

/** The window plus the next page: the window's rows first, then the page's new ones; counts and cursor from the page. */
export function appendPage<T extends { id: string }, P extends PagedPayload<T>>(window: P, page: P): P {
  const seen = new Set(window.items.map((i) => i.id));
  return { ...page, items: [...window.items, ...page.items.filter((i) => !seen.has(i.id))], nextCursor: page.nextCursor ?? null };
}

/** The `limit` that reads a window of `pages` pages back in one request (live refetches). */
export const windowLimit = (pages: number, size = PAGE_SIZE): number => Math.max(1, pages) * size;

/** What the more row says: how many the next page brings, and how many of the total are on screen. */
export function moreRow(loaded: number, total: number, size = PAGE_SIZE): { next: number; label: string; shown: string } | null {
  const left = total - loaded;
  if (left <= 0) return null;
  const next = Math.min(size, left);
  return { next, label: `Show ${next} more`, shown: `${loaded} of ${total} shown` };
}
