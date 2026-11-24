// @vitest-environment jsdom
/**
 * The shared live-list hooks in React (src/components/lists/live-list.ts, docs/UX.md "Live updates"): a refetch keeps
 * the order on screen and marks what arrived; a row that left elsewhere fades (then goes), yours goes at once, the one
 * open in the panel stays; arrivals wait behind the pill while you are busy; the selection moves to its neighbour.
 */
import { createElement as h, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noteLocalWrite, resetIntent } from '@/client/intent';
import { LINGER_MS, useLiveList, useSelectionSurvives, type LiveList, type LiveListOptions } from '@/components/lists/live-list';
import { advance, cleanup, render } from '@/components/composer/__tests__/dom';

const { act } = await import('react');

type Row = { id: string; v?: number };
let last: LiveList<Row> | null = null;

function Harness({ data, opts }: { data: Row[] | undefined; opts?: LiveListOptions }) {
  last = useLiveList(data, 'test', opts);
  return null;
}

async function mount(data: Row[], opts?: LiveListOptions) {
  const r = await render(h(Harness, { data, opts }));
  const update = async (next: Row[], o?: LiveListOptions) => act(async () => r.root.render(h(Harness, { data: next, opts: o ?? opts })));
  return { update };
}

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = () => last!.items.map((r) => r.id);

// The hooks read Date.now() and set timers (linger, the "new" mark, your own writes' window): all fake, so a slow
// render can never age a mark or a linger past its window between two lines of a test.
beforeEach(() => {
  vi.useFakeTimers();
  resetIntent();
  last = null;
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

describe('useLiveList', () => {
  it('keeps the order on screen and places an arrival at its natural place, marked new', async () => {
    const { update } = await mount(rows('d1', 'd2', 'd3'));
    expect(ids()).toEqual(['d1', 'd2', 'd3']);
    // the server re-sorted (d3 first) and a new draft came in on top
    await update(rows('d9', 'd3', 'd1', 'd2')); // the server re-sorted (d3 revised) and a new draft came in on top
    expect(ids()).toEqual(['d9', 'd1', 'd2', 'd3']);
    expect(last!.liveOf('d9')).toBe('new');
    expect(last!.rowProps('d9')).toEqual({ 'data-live': 'new' });
    expect(last!.liveOf('d1')).toBeUndefined();
    expect(last!.fresh).toEqual(['d9']);
  });

  it('refreshes a row in place (same position, fresh fields)', async () => {
    const { update } = await mount([{ id: 'a', v: 1 }, { id: 'b', v: 1 }]);
    await update([{ id: 'b', v: 2 }, { id: 'a', v: 2 }]);
    expect(last!.items).toEqual([{ id: 'a', v: 2 }, { id: 'b', v: 2 }]);
  });

  it('marks AI arrivals with the AI tone', async () => {
    const { update } = await mount(rows('a'), { tone: 'ai' });
    await update(rows('n', 'a'));
    expect(last!.rowProps('n')).toEqual({ 'data-live': 'new', 'data-live-tone': 'ai' });
  });

  it('a row that left elsewhere fades in place, then goes', async () => {
    const { update } = await mount(rows('a', 'b', 'c'));
    await update(rows('a', 'c'));
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(last!.liveOf('b')).toBe('leaving');
    expect(last!.isLeaving('b')).toBe(true);
    await advance(LINGER_MS - 1);
    expect(ids()).toEqual(['a', 'b', 'c']); // still fading
    await advance(100);
    expect(ids()).toEqual(['a', 'c']);
  });

  it('a row you removed yourself goes at once', async () => {
    const { update } = await mount(rows('a', 'b', 'c'));
    noteLocalWrite(['b']);
    await update(rows('a', 'c'));
    expect(ids()).toEqual(['a', 'c']);
  });

  it('the row open in the panel stays (gone) while it is kept, and goes when you move on', async () => {
    const { update } = await mount(rows('a', 'b'), { keep: 'b' });
    await update(rows('a'), { keep: 'b' });
    expect(last!.liveOf('b')).toBe('gone');
    await advance(LINGER_MS + 100);
    await update(rows('a'), { keep: 'b' });
    expect(ids()).toEqual(['a', 'b']);
    await update(rows('a'), { keep: null });
    expect(ids()).toEqual(['a']);
  });

  it('holds arrivals while you are busy, then Show places them, marked', async () => {
    const { update } = await mount(rows('a'), { hold: true });
    await update(rows('n1', 'a'), { hold: true });
    expect(ids()).toEqual(['a']);
    expect(last!.held).toEqual(['n1']);
    await act(async () => last!.showHeld());
    expect(ids()).toEqual(['n1', 'a']);
    expect(last!.held).toEqual([]);
    expect(last!.liveOf('n1')).toBe('new');
  });

  it('a burst waits behind the pill even when you are not busy', async () => {
    const { update } = await mount(rows('a'));
    await update(rows('n1', 'n2', 'n3', 'n4', 'a'));
    expect(ids()).toEqual(['a']);
    expect(last!.held).toHaveLength(4);
  });

  it('a new tab or filter (resetKey) takes the server order, nothing marked', async () => {
    let key = 'one';
    function Keyed({ data }: { data: Row[] }) {
      last = useLiveList(data, key);
      return null;
    }
    const r = await render(h(Keyed, { data: rows('a', 'b') }));
    key = 'two';
    await act(async () => r.root.render(h(Keyed, { data: rows('b', 'x', 'a') })));
    expect(ids()).toEqual(['b', 'x', 'a']);
    expect(last!.fresh).toEqual([]);
  });
});

describe('useSelectionSurvives', () => {
  it('moves the selection to the neighbour when the selected row leaves, and leaves it alone when rows arrive', async () => {
    let selected: string | null = null;
    function Sel({ list }: { list: string[] }) {
      const [sel, setSel] = useState<string | null>('b');
      useSelectionSurvives(list, sel, setSel);
      selected = sel;
      return null;
    }
    const r = await render(h(Sel, { list: ['a', 'b', 'c'] }));
    await act(async () => r.root.render(h(Sel, { list: ['n', 'a', 'b', 'c'] })));
    expect(selected).toBe('b');
    await act(async () => r.root.render(h(Sel, { list: ['n', 'a', 'c'] })));
    expect(selected).toBe('c');
  });
});
