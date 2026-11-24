/**
 * Caps audit F-2: GET /scans took a `limit` with no cursor, so runs older than the newest 500 could not be reached.
 * The query takes `cursor` (additive; the default page stays 100), the payload says `nextCursor` and `total`, and the
 * pager (both DataSources call it) reaches the oldest run with ties at one instant neither repeated nor skipped.
 */
import { describe, expect, it } from 'vitest';
import { routes, ScansPayload, type ScanRun } from '@/contract';
import { parseScanCursor, scanPage } from '@/server/views/health';

const run = (id: string, startedAt: string): ScanRun =>
  ({ id, connectorId: 'c1', scope: 'inbox', kind: 'poll', windowStart: startedAt, windowEnd: startedAt, status: 'ok', startedAt, endedAt: startedAt, itemsSeen: 1, itemsNew: 0, itemsChanged: 0, costUsd: 0, model: null, error: null }) as ScanRun;

// 1,203 runs: one a minute, with every tenth instant shared by three runs (a tie group)
const runs: ScanRun[] = [];
for (let i = 0; i < 1100; i++) {
  const at = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
  runs.push(run(`r${i}`, at));
  if (i % 10 === 0) runs.push(run(`r${i}b`, at), run(`r${i}c`, at));
}

describe('GET /scans paging', () => {
  it('the query is additive: no cursor = the first page of 100, as before; a cursor parses', () => {
    const q = routes.getScans.query!;
    expect(q.parse({})).toEqual({ limit: 100 });
    expect(q.parse({ cursor: 's:2026-10-01T00:00:00.000Z|2', limit: '50' })).toEqual({ cursor: 's:2026-10-01T00:00:00.000Z|2', limit: 50 });
  });

  it('pages newest first to the oldest run: every run once, total counts all, the last page says null', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const p = scanPage(runs, { limit: 7, cursor });
      expect(ScansPayload.parse(p)).toBeTruthy();
      expect(p.total).toBe(runs.length);
      seen.push(...p.runs.map((r) => r.id));
      pages++;
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(pages).toBe(Math.ceil(runs.length / 7));
    expect(seen).toHaveLength(runs.length);
    expect(new Set(seen).size).toBe(runs.length);
    expect(seen[0]).toBe('r1099');
    expect(seen.at(-1)).toBe('r0c'); // the oldest instant's tie group, in load order
  });

  it('a cursor inside a tie group continues inside it; a scan that starts between pages does not shift page 2', () => {
    const tie = runs.filter((r) => r.startedAt === runs.find((x) => x.id === 'r1000')!.startedAt).map((r) => r.id);
    expect(tie).toEqual(['r1000', 'r1000b', 'r1000c']);
    const first = scanPage(runs, { limit: 119 }); // r1099 … r1000 is 118 rows (nine tie groups of three on the way), then r1000b
    expect(first.runs.at(-1)!.id).toBe('r1000b');
    expect(parseScanCursor(first.nextCursor!)).toEqual({ startedAt: runs.find((x) => x.id === 'r1000')!.startedAt, n: 2 });
    const later = [run('new', '2026-12-01T00:00:00.000Z'), ...runs];
    expect(scanPage(later, { limit: 3, cursor: first.nextCursor! }).runs.map((r) => r.id)).toEqual(['r1000c', 'r999', 'r998']);
  });

  it('a cursor it did not make reads from the start', () => {
    expect(scanPage(runs, { limit: 1, cursor: 'o:40' }).runs[0]!.id).toBe('r1099');
    expect(parseScanCursor('s:x|-1')).toBeNull();
  });
});
