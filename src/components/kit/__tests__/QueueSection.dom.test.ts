// @vitest-environment jsdom
/**
 * QueueSection over the one live-list pattern (D-73, docs/UX.md "Live updates"): stable order, arrivals at their
 * natural place (a burst behind the "N new · Show" pill), a cap that grows to keep the selection, See all, Select all,
 * and the selection moving to its neighbour when its row leaves.
 */
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteLocalWrite, resetIntent } from '@/client/intent';
import { cleanup, render, waitFor } from '@/components/composer/__tests__/dom';
import { ActionRow } from '../ActionRow';
import { QueueSection, type QueueSectionProps } from '../QueueSection';

const { act } = await import('react');
// jsdom has no CSS.escape (Show scrolls the first placed arrival into view by its data-item-id)
(globalThis as { CSS?: { escape?: (v: string) => string } }).CSS ??= { escape: (v: string) => v.replace(/["\\]/g, '\\$&') };

type Row = { id: string; title: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, title: `Row ${id}` }));

async function mount(items: Row[] | undefined, props: Partial<QueueSectionProps<Row>> = {}) {
  const make = (xs: Row[] | undefined, p: Partial<QueueSectionProps<Row>> = props) =>
    h(QueueSection<Row>, {
      title: 'Approve',
      items: xs,
      resetKey: 'outbox',
      cap: 10,
      renderRow: (it: Row, ctx) => h(ActionRow, { key: it.id, id: it.id, title: it.title, selected: ctx.selected, live: ctx.live, check: p.select ? { checked: ctx.checked, onChange: ctx.toggle, label: it.title } : undefined }),
      ...p,
    });
  const r = await render(make(items));
  const update = async (xs: Row[] | undefined, p?: Partial<QueueSectionProps<Row>>) => act(async () => r.root.render(make(xs, p ?? props)));
  const ids = () => [...r.container.querySelectorAll('[data-row]')].map((e) => e.getAttribute('data-item-id'));
  return { r, update, ids };
}

beforeEach(() => resetIntent());
afterEach(async () => cleanup());

describe('QueueSection', () => {
  it('renders nothing while loading or empty (unless told what to say)', async () => {
    const a = await mount(undefined);
    expect(a.r.container.innerHTML).toBe('');
    await a.update([]);
    expect(a.r.container.innerHTML).toBe('');
    await a.update([], { empty: h('p', null, "That's everything.") });
    expect(a.r.container.textContent).toBe("That's everything.");
  });

  it('title, count and rows in the server order on first data', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    expect(q.r.container.querySelector('h2')!.textContent).toBe('Approve');
    expect(q.r.container.querySelector('[data-testid="queue-count"]')!.textContent).toBe('3');
    expect(q.ids()).toEqual(['a', 'b', 'c']);
  });

  it('a refetch never reorders; an arrival enters at its natural place, marked new', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    await q.update(rows('n', 'c', 'b', 'a'));
    expect(q.ids()).toEqual(['n', 'a', 'b', 'c']);
    expect(q.r.container.querySelector('[data-item-id="n"]')!.getAttribute('data-live')).toBe('new');
  });

  it('more than three at once wait behind the pill; Show places them', async () => {
    const q = await mount(rows('a'));
    await q.update(rows('n1', 'n2', 'n3', 'n4', 'a'));
    expect(q.ids()).toEqual(['a']);
    const pill = await waitFor(() => q.r.container.querySelector<HTMLButtonElement>('[data-live-pill] button'));
    expect(pill.textContent).toContain('4 new');
    await act(async () => pill.click());
    expect(q.ids()).toEqual(['n1', 'n2', 'n3', 'n4', 'a']);
  });

  it('a row that left elsewhere fades in place; one you removed goes at once', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    await q.update(rows('a', 'c'));
    expect(q.ids()).toEqual(['a', 'b', 'c']);
    expect(q.r.container.querySelector('[data-item-id="b"]')!.getAttribute('data-live')).toBe('leaving');
    noteLocalWrite(['c']);
    await q.update(rows('a'));
    expect(q.ids()).not.toContain('c');
  });

  it('caps rows, grows the cap to keep the selected row, and See all expands', async () => {
    const q = await mount(rows('a', 'b', 'c', 'd', 'e'), { cap: 2 });
    expect(q.ids()).toEqual(['a', 'b']);
    await q.update(rows('a', 'b', 'c', 'd', 'e'), { cap: 2, selectedId: 'd' });
    expect(q.ids()).toEqual(['a', 'b', 'c', 'd']);
    await act(async () => q.r.container.querySelector<HTMLButtonElement>('[data-testid="see-all"]')!.click());
    expect(q.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(q.r.container.querySelector('[data-testid="show-fewer"]')).not.toBeNull();
  });

  it('See all can navigate instead', async () => {
    const onClick = vi.fn();
    const q = await mount(rows('a', 'b', 'c'), { cap: 1, seeAll: { onClick, noun: 'drafts' } });
    const btn = q.r.container.querySelector<HTMLButtonElement>('[data-testid="see-all"]')!;
    expect(btn.textContent).toBe('See all 3 drafts →');
    await act(async () => btn.click());
    expect(onClick).toHaveBeenCalled();
  });

  it('Select all ticks every row, and again clears them', async () => {
    let selected = new Set<string>();
    const onChange = vi.fn((next: Set<string>) => (selected = next));
    const q = await mount(rows('a', 'b'), { select: { selected, onChange } });
    await act(async () => q.r.container.querySelector<HTMLInputElement>('[data-testid="select-all"]')!.click());
    expect([...selected]).toEqual(['a', 'b']);
    await q.update(rows('a', 'b'), { select: { selected, onChange } });
    expect(q.r.container.querySelector<HTMLInputElement>('[data-testid="select-all"]')!.checked).toBe(true);
    await act(async () => q.r.container.querySelector<HTMLInputElement>('[data-testid="select-all"]')!.click());
    expect([...selected]).toEqual([]);
  });

  it('the selection moves to its neighbour when its row leaves; j/k move focus and selection', async () => {
    const onSelectedChange = vi.fn();
    const q = await mount(rows('a', 'b', 'c'), { selectedId: 'b', onSelectedChange, live: { linger: false } });
    await q.update(rows('a', 'c'));
    expect(onSelectedChange).toHaveBeenLastCalledWith('c');
    const first = q.r.container.querySelector<HTMLElement>('[data-item-id="a"]')!;
    first.focus();
    await act(async () => void first.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })));
    expect(document.activeElement?.getAttribute('data-item-id')).toBe('c'); // b has left
    expect(onSelectedChange).toHaveBeenLastCalledWith('c');
  });
});
