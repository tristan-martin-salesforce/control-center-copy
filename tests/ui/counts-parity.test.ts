/**
 * 01 UI-3, R12: the sidebar badge, the page sentence and the page's position line say the same number. The sidebar
 * reads the server's navCounts (getToday); Triage and the Outbox count their own payload with triageCount /
 * outboxCount (src/engines/activity/needs-count.ts). This pins that both sides agree over the mock world, before and
 * after a change, so they cannot drift apart again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OutboxPayload, TriagePayload } from '@/contract';
import { outboxCount, outboxPhrase, triageCount, triagePhrase } from '@/engines/activity/needs-count';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';

let ds: MockDataSource | null = null;
afterEach(() => {
  ds?.dispose?.();
  ds = null;
});

const make = () => (ds = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } }));

/** What the Outbox page counts: its Approve and Retry sections. */
function outboxOf(p: OutboxPayload) {
  const all = p.groups.flatMap((g) => g.items);
  return outboxCount({ pending: all.filter((i) => i.group === 'pending_approval').length, failed: all.filter((i) => i.group === 'failed').length });
}

/** What the Triage page counts: the guesses, and the closed rows apart. */
function triageOf(p: TriagePayload) {
  return triageCount({ guesses: p.count, closed: p.groups.find((g) => g.group === 'closed_for_you')?.items.length ?? 0 });
}

describe('counts: one number per page, sidebar included', () => {
  it('the Outbox badge is the page’s pending plus failed, and Triage’s is its guesses, never the closed rows', async () => {
    const d = make();
    const today = await d.getToday({} as never);
    const outbox = outboxOf(await d.getOutbox({} as never));
    const triage = await d.getTriage({} as never);
    const tc = triageOf(triage);
    expect(today.navCounts.outbox).toBe(outbox.total);
    expect(today.navCounts.triage).toBe(tc.guesses);
    const rows = triage.groups.reduce((n, g) => n + g.items.length, 0);
    expect(tc.rows).toBe(rows);
    expect(tc.closed).toBeGreaterThan(0); // the mock world has Closed for you rows: the case that drifted ("9 guesses" vs "12 items")
    expect(tc.guesses).toBeLessThan(rows);
  });

  it('stays equal after a reject and an accept', async () => {
    const d = make();
    const box = await d.getOutbox({} as never);
    const pending = box.groups.flatMap((g) => g.items).find((i) => i.group === 'pending_approval');
    expect(pending).toBeTruthy();
    await d.rejectDraft({ params: { id: pending!.draft.id }, body: {} } as never);
    const triage = await d.getTriage({} as never);
    const guess = triage.groups.flatMap((g) => g.items).find((i) => i.group === 'asks_promises');
    expect(guess).toBeTruthy();
    await d.acceptTriage({ params: { id: guess!.id }, body: {} } as never);

    const today = await d.getToday({} as never);
    expect(today.navCounts.outbox).toBe(outboxOf(await d.getOutbox({} as never)).total);
    expect(today.navCounts.triage).toBe(triageOf(await d.getTriage({} as never)).guesses);
  });
});

describe('triageCount and outboxCount', () => {
  it('say only what waits, and agree in number', () => {
    expect(triagePhrase(triageCount({ guesses: 9, closed: 3 }))).toBe('9 guesses to confirm');
    expect(triagePhrase(triageCount({ guesses: 1, closed: 0 }))).toBe('1 guess to confirm');
    expect(triagePhrase(triageCount({ guesses: 0, closed: 3 }))).toBeNull();
    expect(triageCount({ guesses: 9, closed: 3 })).toEqual({ guesses: 9, closed: 3, rows: 12 });
    expect(outboxPhrase(outboxCount({ pending: 2, failed: 1 }))).toBe('2 drafts wait for your approval, and 1 failed');
    expect(outboxPhrase(outboxCount({ pending: 1, failed: 0 }))).toBe('1 draft waits for your approval');
    expect(outboxPhrase(outboxCount({ pending: 0, failed: 2 }))).toBe('2 failed to send');
    expect(outboxPhrase(outboxCount({ pending: 0, failed: 0 }))).toBeNull();
    expect(outboxCount({ pending: -1, failed: Number.NaN })).toEqual({ pending: 0, failed: 0, total: 0 });
  });
});
