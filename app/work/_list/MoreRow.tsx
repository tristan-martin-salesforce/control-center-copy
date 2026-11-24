'use client';
/**
 * Work ▸ Closed pages (GET /items `limit` + `cursor` → `nextCursor`; src/components/lists/paging.ts): a window of
 * `pages` × 50 rows, "Show 50 more" under it. Show more reads the next page by the window's cursor, appends it and seeds
 * the bigger window's query, so the next live refetch reads the whole window through the same live-list merge.
 * A new tab or filter starts again at one page.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { ItemsPayload } from '@/contract';
import { api, queryKey } from '@/client/api';
import { itemsQueryOf, type WorkFilters } from '@/components/lists/url-filters';
import { appendPage, moreRow, PAGE_SIZE, windowLimit } from '@/components/lists/paging';
import { Button } from '@/ui';

/** The window size for this list (one page until Show more; reset by a new tab or filter). */
export function usePageCount(resetKey: string, paged: boolean) {
  const [pg, setPg] = useState({ key: resetKey, n: 1 });
  const pages = paged && pg.key === resetKey ? pg.n : 1;
  const setPages = useCallback((n: number) => setPg({ key: resetKey, n }), [resetKey]);
  return { pages, setPages };
}

/** The GET /items query: Closed asks for its window, the other tabs for everything. */
export function windowQuery(f: WorkFilters, paged: boolean, pages: number) {
  return paged ? { ...itemsQueryOf(f), limit: windowLimit(pages) } : itemsQueryOf(f);
}

export function useShowMore(o: { data: ItemsPayload | undefined; placeholder: boolean; paged: boolean; filters: WorkFilters; pages: number; setPages: (n: number) => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState<{ busy: boolean; failed: boolean }>({ busy: false, failed: false });
  const { data, placeholder, paged, filters, pages, setPages } = o;
  const showMore = useCallback(async () => {
    if (!paged || !data?.nextCursor || state.busy || placeholder) return;
    setState({ busy: true, failed: false });
    try {
      const page = await api('listItems', { query: { ...itemsQueryOf(filters), cursor: data.nextCursor, limit: PAGE_SIZE } });
      qc.setQueryData(queryKey('listItems', { query: windowQuery(filters, true, pages + 1) }), appendPage(data, page));
      setPages(pages + 1);
      setState({ busy: false, failed: false });
    } catch {
      setState({ busy: false, failed: true });
    }
  }, [data, placeholder, paged, state.busy, filters, qc, pages, setPages]);
  return { ...state, showMore };
}

/** Under a paged list: "Show 50 more" and how many of the total are on screen (the counts are the payload's). */
export function MoreRow({ loaded, total, busy, failed, onMore }: { loaded: number; total: number; busy: boolean; failed: boolean; onMore: () => void }) {
  const m = moreRow(loaded, total) ?? { label: 'Show more', shown: `${loaded} shown` };
  return (
    <div className="flex flex-wrap items-center gap-3 px-1 pt-3 pb-2" data-testid="work-more">
      {/* aria-disabled, not disabled: a disabled button drops focus to the page mid-load (useShowMore ignores a second click) */}
      <Button variant="secondary" size="sm" onClick={onMore} aria-disabled={busy || undefined} aria-busy={busy || undefined} data-testid="work-more-button">
        {busy ? 'Loading…' : m.label}
      </Button>
      <span className="text-caption text-muted tabular-nums">{m.shown}</span>
      {failed ? (
        <span className="text-caption text-danger-700" role="alert">
          Couldn’t load more. Try again.
        </span>
      ) : null}
    </div>
  );
}
