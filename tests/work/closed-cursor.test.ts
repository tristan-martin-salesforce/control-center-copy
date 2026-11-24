/**
 * P25-6: Work ▸ Closed pages by a keyset cursor (the last row's closed at, created at and id, opaque), so a close or a
 * reopen between pages neither repeats nor skips a row. The db pages the same way in SQL
 * (tests/db/datasource/parity-reads.test.ts, tests/db/reads/work-list.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ItemsPayload, WorkItem } from '@/contract';
import { closedCursor, closedKeyOf, closedRowsAfter, compareClosedKey, pageList, parseClosedCursor } from '@/server/datasource/db/reads/page';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';

let ds: MockDataSource;
beforeEach(() => {
  ds = createMockDataSource({ autoplay: false });
});
afterEach(() => ds.dispose());

const closed = async (q: { limit?: number; cursor?: string | null } = {}) =>
  (await ds.listItems({ query: { tab: 'done', ...(q.limit ? { limit: q.limit } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) } } as never)) as ItemsPayload;
const ids = (p: ItemsPayload) => p.items.map((i) => i.id);

describe('the Closed keyset cursor (P25-6)', () => {
  it('round-trips, is opaque and fits the contract; anything else reads from the start', () => {
    const k = { doneMs: Date.parse('2026-11-20T10:00:00.123Z'), createdMs: Date.parse('2026-11-01T08:00:00Z'), id: '0b6f8a2e-4c1d-5e3f-8a9b-1c2d3e4f5a6b' };
    const c = closedCursor(k);
    expect(c).toMatch(/^k:[A-Za-z0-9_-]+$/);
    expect(c.length).toBeLessThanOrEqual(128);
    expect(c).not.toContain(k.id);
    expect(parseClosedCursor(c)).toEqual(k);
    expect(parseClosedCursor(closedCursor({ ...k, doneMs: null }))).toEqual({ ...k, doneMs: null });
    for (const bad of [undefined, '', 'o:50', 'k:', 'k:!!', `k:${Buffer.from('x.y').toString('base64url')}`]) expect(parseClosedCursor(bad)).toBeNull();
  });

  it('orders as the view does: closed newest first (none last), then created oldest first', () => {
    const a = { doneMs: 2, createdMs: 5 };
    expect(compareClosedKey(a, { doneMs: 1, createdMs: 0 })).toBeLessThan(0);
    expect(compareClosedKey(a, { doneMs: 2, createdMs: 6 })).toBeLessThan(0);
    expect(compareClosedKey(a, { doneMs: null, createdMs: 0 })).toBeLessThan(0);
    expect(compareClosedKey({ doneMs: null, createdMs: 1 }, { doneMs: null, createdMs: 2 })).toBeLessThan(0);
    expect(compareClosedKey(a, a)).toBe(0);
  });

  it('pages through every row once', async () => {
    const whole = ids(await closed());
    expect(whole.length).toBeGreaterThan(3);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const p = await closed({ limit: 2, cursor });
      seen.push(...ids(p));
      if (!p.nextCursor) break;
      expect(p.nextCursor).toMatch(/^k:/);
      cursor = p.nextCursor;
    }
    expect(seen).toEqual(whole);
  });

  it('a reopen of the last row shown skips nothing', async () => {
    const before = ids(await closed());
    const p1 = await closed({ limit: 2 });
    const last = p1.items.at(-1)!;
    await ds.itemAction({ params: { id: last.id, verb: 'reopen' }, body: { ifVersion: last.version } } as never);
    // an offset cursor would start one row late now
    expect(ids(await closed({ limit: 2, cursor: p1.nextCursor }))).toEqual(before.slice(2, 4));
  });

  it('a close between pages repeats nothing', async () => {
    const before = ids(await closed());
    const p1 = await closed({ limit: 2 });
    const open = ((await ds.listItems({ query: { tab: 'all_open' } } as never)) as ItemsPayload).items.find((i) => i.state === 'open')!;
    await ds.itemAction({ params: { id: open.id, verb: 'done' }, body: { ifVersion: open.version } } as never);
    expect(ids(await closed())[0]).toBe(open.id);
    // an offset cursor would repeat page 1's last row now
    expect(ids(await closed({ limit: 2, cursor: p1.nextCursor }))).toEqual(before.slice(2, 4));
  });

  it('a cursor row that is gone keeps every row after its key (ties may repeat; the client dedupes)', () => {
    const row = (id: string, doneAt: string | null, createdAt: string) => ({ id, doneAt, createdAt }) as WorkItem;
    const rows = [row('a', '2026-11-20T10:00:00Z', '2026-11-01T00:00:00Z'), row('b', '2026-11-20T09:00:00Z', '2026-11-01T00:00:00Z'), row('c', '2026-11-20T09:00:00Z', '2026-11-01T00:00:00Z'), row('d', null, '2026-10-01T00:00:00Z')];
    expect(closedRowsAfter(rows, closedKeyOf(rows[1]!)).map((r) => r.id)).toEqual(['c', 'd']);
    expect(closedRowsAfter(rows, { ...closedKeyOf(rows[1]!), id: 'gone' }).map((r) => r.id)).toEqual(['b', 'c', 'd']);
    const view = { tab: 'done', items: rows, counts: { done: 4 }, total: 4 } as unknown as ItemsPayload;
    const p = pageList(view, { limit: 3 });
    expect([p.items.map((r) => r.id), parseClosedCursor(p.nextCursor ?? undefined)?.id]).toEqual([['a', 'b', 'c'], 'c']);
    expect(pageList(view, { limit: 4 }).nextCursor).toBeNull();
  });
});
