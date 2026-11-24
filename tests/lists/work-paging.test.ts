/**
 * Work ▸ Closed pages (GET /items limit + cursor → nextCursor; 18-ui-polish.md): "Show 50 more" appends the next page
 * to the window without moving a row already on screen, the counts stay the payload's, and a live refetch of the
 * whole window keeps the live-list merge rules (an arrival enters at its place; nothing reorders).
 */
import { describe, expect, it } from 'vitest';
import { appendPage, moreRow, PAGE_SIZE, windowLimit } from '@/components/lists/paging';
import { mergeLive } from '@/components/lists/live-merge';

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `w${from + i}` }));
const page = (from: number, n: number, total: number, next: string | null) => ({ items: rows(from, n), total, counts: { done: total }, nextCursor: next });

describe('Closed paging', () => {
  it('appends the next page after the window, once per row, with the page’s counts and cursor', () => {
    const w = page(0, 50, 120, 'o:50');
    const p2 = page(49, 50, 121, 'o:99');
    const out = appendPage(w, p2);
    expect(out.items.slice(0, 50)).toEqual(w.items);
    expect(out.items).toHaveLength(99);
    expect(new Set(out.items.map((i) => i.id)).size).toBe(99);
    expect([out.total, out.counts.done, out.nextCursor]).toEqual([121, 121, 'o:99']);
    expect(appendPage(out, page(99, 22, 121, null)).nextCursor).toBeNull();
  });

  it('a live refetch reads the whole window: pages × 50', () => {
    expect(PAGE_SIZE).toBe(50);
    expect([windowLimit(1), windowLimit(2), windowLimit(0)]).toEqual([50, 100, 50]);
  });

  it('the more row says what the next page brings and how many of the total are on screen', () => {
    expect(moreRow(50, 120)).toEqual({ next: 50, label: 'Show 50 more', shown: '50 of 120 shown' });
    expect(moreRow(100, 120)).toEqual({ next: 20, label: 'Show 20 more', shown: '100 of 120 shown' });
    expect(moreRow(120, 120)).toBeNull();
  });

  it('an item closed meanwhile enters at its place in the window; the rows on screen keep their order', () => {
    const shown = rows(0, 100).map((r) => r.id);
    const incoming = ['wNew', ...shown.slice(0, 99)];
    const m = mergeLive({ shown, incoming, linger: () => true });
    expect(m.order.filter((id) => id !== 'wNew')).toEqual(shown);
    expect(m.inserted).toEqual(['wNew']);
  });
});
