/**
 * Caps audit 2026-11-21: the Assistant's per-turn context pack shows a few rows of each list (a prompt budget), and
 * every list carries its whole count so the model knows when to read on (src/server/chat/compact.ts).
 */
import { describe, expect, it } from 'vitest';

import { createChatHost } from '@/server/chat/host';
import { MockDataSource } from '@/server/datasource/mock';

describe('context pack counts', () => {
  it('each trimmed list carries its whole count', async () => {
    const ds = new MockDataSource();
    try {
      const host = createChatHost(ds, ds.be6.backend(), () => ds.now());
      const pack = (await host.contextPack()) as {
        today: { promises: unknown[]; promisesCount: number; fitIns: unknown[]; fitInsCount: number; moreToday: unknown[]; moreTodayCount: number };
        calendar: unknown[];
        calendarCount: number;
        outbox: { applied: unknown[]; appliedCount: number };
      };
      const today = await ds.getToday({} as never);
      expect(pack.today.promisesCount).toBe(today.shelves.promises.length);
      expect(pack.today.fitInsCount).toBe(today.shelves.fitIns.length);
      expect(pack.calendarCount).toBe(today.spine.events.length);
      expect(pack.today.promises.length).toBeLessThanOrEqual(pack.today.promisesCount);
      expect(pack.calendar.length).toBeLessThanOrEqual(pack.calendarCount);
      expect(pack.outbox.appliedCount).toBeGreaterThanOrEqual(pack.outbox.applied.length);
    } finally {
      await ds.dispose?.();
    }
  });
});

// post-contract-bounds: the unused searchConnectors seam is gone; searchSources reads the ledger only, and a live source
// asked of it gets a note (live Gmail and Drive search is the search tool's own source), never a throw.
describe('chat host searchSources', () => {
  it('reads the ledger and says live sources are searched with the search tool', async () => {
    const ds = new MockDataSource();
    try {
      const host = createChatHost(ds, ds.be6.backend(), () => ds.now());
      const r = await host.searchSources('pricing', { sources: ['ledger', 'gmail', 'drive'], limit: 5 });
      expect(Array.isArray(r.hits)).toBe(true);
      expect(r.notes).toContain('gmail, drive: not searched here (ledger only); search with source gmail or drive for live results');
      const ledgerOnly = await host.searchSources('pricing', { sources: ['ledger'], limit: 5 });
      expect(ledgerOnly.notes.some((n) => n.includes('not searched here'))).toBe(false);
    } finally {
      await ds.dispose?.();
    }
  });
});
