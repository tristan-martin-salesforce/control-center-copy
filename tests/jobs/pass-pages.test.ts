/**
 * Caps audit 2026-11-21: a model pass over a backlog works in pages, and a page that stops with rows due queues the
 * next one (src/jobs/pass-pages.ts). Safety: no progress, no next page.
 */
import { describe, expect, it } from 'vitest';

import { nextPageDue, queueNextPage } from '@/jobs/pass-pages';

describe('pass pages', () => {
  it('the next page is due only when the page stopped early, rows are left and this page stored answers', () => {
    expect(nextPageDue({ stoppedAtPage: true, left: 3, progressed: 2, aborted: false })).toBe(true);
    expect(nextPageDue({ stoppedAtPage: false, left: 3, progressed: 2, aborted: false })).toBe(false); // the daily cap or the end
    expect(nextPageDue({ stoppedAtPage: true, left: 0, progressed: 2, aborted: false })).toBe(false);
    expect(nextPageDue({ stoppedAtPage: true, left: 3, progressed: 0, aborted: false })).toBe(false); // every call failed
    expect(nextPageDue({ stoppedAtPage: true, left: 3, progressed: 2, aborted: true })).toBe(false);
  });

  it('queues the same job under its dedupe key, a few seconds out', async () => {
    const seen: unknown[] = [];
    const ok = await queueNextPage({ enqueue: async (i) => (seen.push(i), { id: 7, inserted: true }) }, { kind: 'activity.notes', queue: 'engine', dedupeKey: 'activity.notes:u1', maxAttempts: 2 });
    expect(ok).toBe(true);
    expect(seen).toEqual([{ kind: 'activity.notes', queue: 'engine', payload: { trigger: 'next_page' }, dedupeKey: 'activity.notes:u1', delaySeconds: 5, maxAttempts: 2 }]);
    expect(await queueNextPage({ enqueue: async () => Promise.reject(new Error('db down')) }, { kind: 'k', queue: 'q', dedupeKey: 'd' })).toBe(false);
  });
});
