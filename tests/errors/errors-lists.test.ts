/**
 * 2026-11-13 audit C6 (errors stay, readable), C7 (bulk is a batch, DCs withdraw in one change) and C8 (the smaller
 * ones). Placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { ToastStore } from '@/client/toast/store';
import { clipSentence, errorText, stripHtml } from '@/lib/error-text';
import { failureLines, rowLabel, runPool } from '@/components/time/bulk';
import { pushFailures } from '@/components/time/vdp-changes-derive';
import { rankTasks } from '@/components/agents/claude';
import { captureLanding } from '@/components/shell/capture-landing';
import { setsDiffer } from '@/components/chat/ChatReceiptCard';
import { planWithdrawDcs } from '@/server/deals/dc-requests';
import { shownCount } from '@/ui/ShowMore';
import { nodeText } from '@/lib/node-text';
import { createElement } from 'react';

describe('C6: error toasts stay', () => {
  it('an error toast is sticky unless the caller sets a duration; others keep 6 s', () => {
    const s = new ToastStore();
    const e = s.push({ title: 'Boom', tone: 'error' });
    const ok = s.push({ title: 'Saved', tone: 'success' });
    const timed = s.push({ title: 'Brief', tone: 'error', durationMs: 3000 });
    expect(s.get(e)!.durationMs).toBeNull();
    expect(s.get(ok)!.durationMs).toBeUndefined();
    expect(s.get(timed)!.durationMs).toBe(3000);
  });

  it('newer toasts push out the oldest non-error first', () => {
    const s = new ToastStore(3);
    const e = s.push({ title: 'Failed', tone: 'error' });
    for (let i = 0; i < 5; i++) s.push({ title: `ok ${i}`, tone: 'success' });
    expect(s.get(e)).toBeDefined();
    expect(s.getSnapshot()).toHaveLength(3);
  });

  it('a replaced error that is now fine gets its normal duration back', () => {
    const s = new ToastStore();
    const id = s.push({ key: 'k', title: 'Failed', tone: 'error' });
    s.push({ key: 'k', title: 'Done', tone: 'success' });
    expect(s.get(id)!.durationMs).toBeUndefined();
  });
});

describe('C6: error text is readable', () => {
  it('an HTML page becomes its title, never markup', () => {
    expect(stripHtml('<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad</h1></body></html>')).toBe('502 Bad Gateway');
    expect(stripHtml('Upstream said: <html><body><p>Sign in &amp; retry</p></body></html>')).toBe('Upstream said: Sign in & retry');
    expect(stripHtml('Plain message\nwith a line')).toBe('Plain message\nwith a line');
  });

  it('shortening ends at a sentence (or a word), never mid-word', () => {
    const long = `First sentence is here. ${'Second sentence goes on and on '.repeat(10)}end.`;
    expect(clipSentence(long, 60)).toBe('First sentence is here.');
    const words = 'word '.repeat(80).trim();
    const c = clipSentence(words, 50);
    expect(c.endsWith('…')).toBe(true);
    expect(c.length).toBeLessThanOrEqual(50);
    expect(c.replace('…', '').endsWith('word')).toBe(true);
    expect(errorText(new Error('<html><title>Sign in</title></html>'))).toBe('Sign in');
  });
});

describe('C6: a VDP push lists every failure', () => {
  it('each failed or skipped item with its own reason, in order', () => {
    const f = pushFailures(
      [
        { itemKey: 'a', state: 'applied' },
        { itemKey: 'b', state: 'failed', error: 'VDP refused the stage' },
        { itemKey: 'c', state: 'skipped', error: null, required: true },
        { itemKey: 'd', state: 'failed', error: 'Timed out' },
      ],
      [
        { key: 'b', title: 'Use case: PLACEHOLDER_B' },
        { key: 'c', title: 'New VDP: PLACEHOLDER_C' },
      ],
    );
    expect(f.map((x) => [x.label, x.why])).toEqual([
      ['Use case: PLACEHOLDER_B', 'VDP refused the stage'],
      ['New VDP: PLACEHOLDER_C (needed first)', 'Not pushed: an item it needs failed first'],
      ['d', 'Timed out'],
    ]);
  });
});

describe('C7: bulk fixes run as a batch', () => {
  it('runPool keeps at most four in flight and runs every item', async () => {
    let live = 0;
    let peak = 0;
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (x) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      done.push(x);
      live--;
    });
    expect(peak).toBe(4);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('every failed row is named with why (the first 8, then how many more)', () => {
    const f = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, label: rowLabel({ date: '2026-11-10', description: `Meeting ${i}` }), why: 'Changed since you opened it' }));
    const text = failureLines(f);
    expect(text.split('\n')).toHaveLength(9);
    expect(text).toContain('2026-11-10 · Meeting 0: Changed since you opened it');
    expect(text).toContain('and 2 more');
  });

  it('Withdraw all waiting takes the waiting ones and skips the rest with why', () => {
    const r = (id: string, stage: 'waiting' | 'in_canvas', lockedReason: string | null = null) => ({ id, stage, status: 'approved', lockedReason }) as never;
    const plan = planWithdrawDcs([r('a', 'waiting'), r('b', 'waiting'), r('c', 'in_canvas', 'On a canvas waiting for your Apply')]);
    expect(plan.withdraw.map((x) => x.id)).toEqual(['a', 'b']);
    expect(plan.skipped).toEqual([]);
    const asked = planWithdrawDcs([r('a', 'waiting'), r('c', 'in_canvas', 'On a canvas waiting for your Apply')], ['a', 'c', 'zz']);
    expect(asked.withdraw.map((x) => x.id)).toEqual(['a']);
    expect(asked.skipped).toEqual([
      { id: 'c', why: 'On a canvas waiting for your Apply' },
      { id: 'zz', why: 'No such DC request' },
    ]);
  });

  it('long lists render in steps, and always up to the selected row', () => {
    expect(shownCount(869, 1)).toBe(100);
    expect(shownCount(869, 2)).toBe(200);
    expect(shownCount(869, 1, 100, 450)).toBe(451);
    expect(shownCount(40, 1)).toBe(40);
  });
});

describe('C5 and C8', () => {
  it('a truncated row title reads in full from its node text', () => {
    expect(nodeText(createElement('span', null, 'OPP_1', createElement('span', null, ' · CUSTOMER_1')))).toBe('OPP_1 · CUSTOMER_1');
  });

  it('Start in Claude ranks every task, searchable by title and account', () => {
    const t = (id: string, title: string, rank: number | null, account?: string) => ({ id, title, rank, refs: { account: account ? { label: account } : null } });
    const items = Array.from({ length: 60 }, (_, i) => t(`w${i}`, `Task ${i}`, i < 50 ? i + 1 : null));
    items.push(t('acme', 'Prep the demo', 70, 'CUSTOMER_9'));
    expect(rankTasks(items, '')).toHaveLength(61);
    expect(rankTasks(items, '')[0]!.id).toBe('w0');
    expect(rankTasks(items, 'customer_9 demo').map((x) => x.id)).toEqual(['acme']);
  });

  it("Capture says where the item landed", () => {
    const now = '2026-11-13T09:00:00.000Z';
    expect(captureLanding({ due: null, startBy: null }, now, 'UTC')).toMatch(/^Added to Work ▸ All open/);
    expect(captureLanding({ due: '2026-11-13T17:00:00.000Z', startBy: null, refs: { account: { label: 'CUSTOMER_1' } } }, now, 'UTC')).toBe('Added to Today · on CUSTOMER_1');
    expect(captureLanding({ due: '2026-11-18T17:00:00.000Z', startBy: null }, now, 'UTC')).toMatch(/^Added to Think ahead, due /);
    expect(captureLanding({ due: '2027-01-20T17:00:00.000Z', startBy: null }, now, 'UTC')).toMatch(/^Added to Work ▸ All open, due /);
  });

  it('a receipt of many change sets of one kind gets one Undo; different kinds get one each', () => {
    const same = Array.from({ length: 54 }, (_, i) => ({ auditId: `a${i}`, label: 'DC request' }));
    expect(setsDiffer(same)).toBe(false);
    expect(setsDiffer([...same, { auditId: 'x', label: 'Due' }])).toBe(true);
    expect(setsDiffer([{ auditId: 'a', label: 'Due' }])).toBe(false);
  });
});

describe('C8: an applied card after a reload is one card', () => {
  it('the receipt stored right after an applied proposal joins it; a receipt of its own stays a receipt', async () => {
    const { viewOfServer } = await import('@/client/chat/turn');
    const proposal = { id: 'p1', status: 'applied', entity: { kind: 'work_item', id: 'w1' }, changes: [], reason: '', source: null, createdAt: '2026-11-13T10:00:00.000Z', actor: 'chat', baseVersion: null, textDiff: null, resolvedAt: null };
    const receipt = (id: string) => ({ id, at: '2026-11-13T10:01:00.000Z', actor: 'chat', summary: 'Applied', changes: [], staged: false });
    const v = viewOfServer({ id: 'm1', threadId: 't1', role: 'assistant', at: '2026-11-13T10:00:00.000Z', text: '', parts: [{ type: 'proposal', proposal, status: 'applied' }, { type: 'receipt', receipt: receipt('r1') }, { type: 'receipt', receipt: receipt('r2') }] } as never);
    expect(v.proposals).toHaveLength(1);
    expect(v.proposals[0]!.receipt?.id).toBe('r1');
    expect(v.receipts.map((r) => r.id)).toEqual(['r2']);
  });
});
