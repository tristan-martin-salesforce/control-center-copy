// @vitest-environment jsdom
/**
 * The drain mode in the DOM (02-ui-research P1, P3, P10, P11): one card at a time, keys a/e/s/x/j/k/z, "3 of 11",
 * order stable under live data, Undo scoped to the open batch, and a terminal "That's everything" screen.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@/components/composer/__tests__/dom';
import { ReviewQueue, type ReviewAdapter, type ReviewQueueProps } from '../ReviewQueue';

const { act } = await import('react');

type Row = { id: string; title: string; sure?: boolean };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, title: `Draft ${id}` }));

function adapter(over: Partial<ReviewAdapter<Row>> = {}) {
  return {
    approve: vi.fn(),
    snooze: vi.fn(),
    dismiss: vi.fn(),
    undo: vi.fn(),
    ...over,
  } satisfies ReviewAdapter<Row>;
}

async function mount(items: Row[], props: Partial<ReviewQueueProps<Row>> = {}) {
  const a = (props.adapter as ReturnType<typeof adapter>) ?? adapter();
  const make = (xs: Row[]) => h(ReviewQueue<Row>, { title: 'Review drafts', items: xs, adapter: a, renderCard: (it: Row) => h('p', { 'data-card-title': '' }, it.title), toastMs: 60_000, nextCheckMin: 15, ...props });
  const r = await render(make(items));
  const root = r.container.querySelector<HTMLElement>('[data-review-queue]')!;
  const key = async (k: string, target: Element = root) => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
  const update = async (xs: Row[]) => act(async () => r.root.render(make(xs)));
  const card = () => r.container.querySelector('[data-review-card]')?.getAttribute('data-review-card') ?? null;
  const progress = () => r.container.querySelector('[data-testid="review-progress"]')!.textContent;
  const toast = () => r.container.querySelector('[data-testid="review-toast"]')?.textContent ?? null;
  return { r, a, key, update, card, progress, toast };
}

afterEach(async () => cleanup());

describe('ReviewQueue', () => {
  it('focuses itself and shows one card with progress', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    expect(document.activeElement?.hasAttribute('data-review-queue')).toBe(true);
    expect(q.card()).toBe('a');
    expect(q.progress()).toBe('1 of 3');
  });

  it('a approves and moves on; s snoozes; x dismisses; each calls the adapter with its item', async () => {
    const q = await mount(rows('a', 'b', 'c', 'd'));
    await q.key('a');
    await q.key('s');
    await q.key('x');
    expect(q.a.approve).toHaveBeenCalledWith({ id: 'a', title: 'Draft a' });
    expect(q.a.snooze).toHaveBeenCalledWith({ id: 'b', title: 'Draft b' });
    expect(q.a.dismiss).toHaveBeenCalledWith({ id: 'c', title: 'Draft c' });
    expect(q.card()).toBe('d');
    expect(q.progress()).toBe('4 of 4');
  });

  it('j/k move without acting', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    await q.key('j');
    await q.key('j');
    expect(q.card()).toBe('c');
    await q.key('k');
    expect(q.card()).toBe('b');
    expect(q.a.approve).not.toHaveBeenCalled();
  });

  it('keeps its order when live data re-sorts, drops what you did, and adds arrivals at the end, marked new', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    await q.key('a');
    expect(q.card()).toBe('b');
    await q.update(rows('n1', 'c', 'b')); // server re-sorted; a left (sent); n1 arrived on top
    expect(q.card()).toBe('b');
    expect(q.progress()).toBe('2 of 4');
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(q.card()!);
      await q.key('j');
    }
    expect(seen).toEqual(['b', 'c', 'n1']);
    expect(q.r.container.querySelector('[data-review-card]')!.getAttribute('data-state')).toBe('new');
  });

  it('z undoes only the open batch, and the toast names it', async () => {
    const q = await mount(rows('a', 'b', 'c', 'd'));
    await q.key('a');
    await q.key('a');
    expect(q.toast()).toContain('Approved 2');
    await q.key('s');
    expect(q.toast()).toContain('Snoozed 1');
    await q.key('z');
    expect(q.a.undo).toHaveBeenCalledTimes(1);
    expect(q.a.undo).toHaveBeenCalledWith({ verb: 'snooze', items: [{ id: 'c', title: 'Draft c' }] });
    expect(q.card()).toBe('c');
    expect(q.progress()).toBe('3 of 4'); // a and b stay approved
    expect(q.toast()).toBeNull();
    await q.key('z'); // nothing open to undo
    expect(q.a.undo).toHaveBeenCalledTimes(1);
  });

  it('the toast Undo reverts a whole batch back into place', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    await q.key('a');
    await q.key('a');
    await act(async () => q.r.container.querySelector<HTMLElement>('[data-testid="review-undo"]')!.click());
    expect(q.a.undo).toHaveBeenCalledWith({ verb: 'approve', items: [{ id: 'a', title: 'Draft a' }, { id: 'b', title: 'Draft b' }] });
    expect(q.card()).toBe('a');
    expect(q.progress()).toBe('1 of 3');
  });

  it('ends on "That\'s everything" with what happened and the next check', async () => {
    const q = await mount(rows('a', 'b', 'c'));
    await q.key('a');
    await q.key('a');
    await q.key('x');
    const done = q.r.container.querySelector('[data-testid="review-done"]')!;
    expect(done.textContent).toContain("That's everything.");
    expect(done.textContent).toContain('2 approved · 1 dismissed');
    expect(done.textContent).toContain('Next check in 15 min.');
    expect(q.progress()).toBe('3 of 3');
    await q.key('z'); // the last batch (Dismissed 1) is still open: back to it
    expect(q.card()).toBe('c');
  });

  it('a failed approve comes back as a Retry card, not a toast', async () => {
    const a = adapter({ approve: vi.fn().mockRejectedValueOnce(new Error('Slack is rate limiting; nothing was sent.')) });
    const q = await mount(rows('a', 'b'), { adapter: a });
    await q.key('a');
    await waitFor(() => q.r.container.querySelector('[data-testid="review-error"]'));
    expect(q.card()).toBe('a');
    expect(q.r.container.querySelector('[data-testid="review-error"]')!.textContent).toContain('rate limiting');
    expect(q.toast()).toBeNull();
    await q.key('a');
    expect(a.approve).toHaveBeenCalledTimes(2);
    expect(q.card()).toBe('b');
  });

  it('a row handled elsewhere stays as "Handled elsewhere"; a does nothing; j moves on', async () => {
    const q = await mount(rows('a', 'b'));
    await q.update(rows('b'));
    expect(q.card()).toBe('a');
    expect(q.r.container.textContent).toContain('Handled elsewhere.');
    await q.key('a');
    expect(q.a.approve).not.toHaveBeenCalled();
    await q.key('j');
    expect(q.card()).toBe('b');
    expect(q.progress()).toBe('1 of 1');
  });

  it('e opens the inline editor and keys typed into it are text, not verbs', async () => {
    const q = await mount(rows('a', 'b'), { renderEditor: (it: Row) => h('textarea', { 'data-editor': it.id, defaultValue: it.title }) });
    await q.key('e');
    const field = q.r.container.querySelector('[data-editor="a"]')!;
    expect(field).not.toBeNull();
    await q.key('a', field);
    expect(q.a.approve).not.toHaveBeenCalled();
    expect(q.card()).toBe('a');
  });

  it('"Approve all sure" approves the sure ones as one batch after one confirm', async () => {
    const items: Row[] = [{ id: 'a', title: 'A', sure: true }, { id: 'b', title: 'B' }, { id: 'c', title: 'C', sure: true }];
    const q = await mount(items, { bulk: { label: 'Approve all sure', filter: (r: Row) => !!r.sure, describe: (r: Row) => r.title } });
    await act(async () => q.r.container.querySelector<HTMLElement>('[data-testid="review-bulk"]')!.click());
    expect(q.r.container.querySelector('[data-testid="review-confirm"]')!.textContent).toContain('Approve all sure 2?');
    expect(q.a.approve).not.toHaveBeenCalled(); // nothing before the confirm
    await act(async () => q.r.container.querySelector<HTMLElement>('[data-testid="review-confirm-go"]')!.click());
    await waitFor(() => (q.a.approve as ReturnType<typeof vi.fn>).mock.calls.length === 2);
    expect(q.toast()).toContain('Approved 2');
    expect(q.card()).toBe('b');
  });
});
