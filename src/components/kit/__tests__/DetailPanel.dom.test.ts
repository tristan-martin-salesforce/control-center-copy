// @vitest-environment jsdom
/**
 * DetailPanel: sections from the per-kind registry (ordered, conditional, collapsible) and the two item menus with
 * their keys (d done by me, ⇧D Done ▾, l Later ▾), each choice handed to the menus adapter.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@/components/composer/__tests__/dom';
import { DetailPanel, type DetailPanelProps } from '../DetailPanel';
import { getDetailSections, registerDetailSections } from '../detail-sections';
import type { ItemMenuHandlers } from '../useItemMenus';

const { act } = await import('react');

const NOW = '2026-11-18T16:00:00.000Z';
const entity = { kind: 'work_item' as const, id: 'wi-001', label: 'Send the Saltmere blueprint' };

function menus(): ItemMenuHandlers & { onDone: ReturnType<typeof vi.fn>; onLater: ReturnType<typeof vi.fn> } {
  return { now: NOW, tz: 'America/Denver', onDone: vi.fn(), onLater: vi.fn() };
}

async function mount(props: Partial<DetailPanelProps> = {}) {
  const r = await render(h(DetailPanel, { entity, ...props }));
  const panel = r.container.querySelector<HTMLElement>('[data-detail-panel]')!;
  const key = async (k: string, init: KeyboardEventInit = {}, target: Element = panel) => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })));
  const menuItems = () => [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((e) => e.textContent);
  return { r, panel, key, menuItems };
}

afterEach(async () => cleanup());

describe('detail section registry', () => {
  it('orders by `order`, then registration; replaces by id; unregisters', () => {
    const off1 = registerDetailSections('initiative', [
      { id: 'b', order: 20, render: () => null },
      { id: 'a', order: 10, render: () => null },
    ]);
    const off2 = registerDetailSections('initiative', [{ id: 'c', order: 10, render: () => null }]);
    expect(getDetailSections('initiative').map((s) => s.id)).toEqual(['a', 'c', 'b']);
    off2();
    expect(getDetailSections('initiative').map((s) => s.id)).toEqual(['a', 'b']);
    off1();
    expect(getDetailSections('initiative')).toEqual([]);
  });
});

describe('DetailPanel', () => {
  it('renders registered and passed sections in order, honouring `when` and `collapsed`', async () => {
    const off = registerDetailSections('work_item', [
      { id: 'why', title: 'Why it is here', order: 10, render: () => h('p', null, 'Marisol asked on Tuesday') },
      { id: 'hidden', title: 'Never', when: () => false, render: () => h('p', null, 'nope') },
    ]);
    const { r } = await mount({ sections: [{ id: 'evidence', title: 'Evidence', order: 20, collapsed: true, render: () => h('p', null, '3 messages') }] });
    expect([...r.container.querySelectorAll('[data-detail-section]')].map((s) => s.getAttribute('data-detail-section'))).toEqual(['why', 'evidence']);
    expect(r.container.textContent).toContain('Marisol asked on Tuesday');
    expect(r.container.textContent).not.toContain('3 messages');
    await act(async () => r.container.querySelector<HTMLButtonElement>('[data-detail-section="evidence"] button')!.click());
    expect(r.container.textContent).toContain('3 messages');
    expect(r.container.querySelector('[data-testid="detail-title"]')!.textContent).toBe('Send the Saltmere blueprint');
    off();
  });

  it('d is Done by me', async () => {
    const m = menus();
    const { key } = await mount({ menus: m });
    await key('d');
    expect(m.onDone).toHaveBeenCalledWith('by_me');
  });

  it('⇧D opens Done ▾ with the four ways it ended; choosing one sends it', async () => {
    const m = menus();
    const { key, menuItems } = await mount({ menus: m });
    await key('D', { shiftKey: true });
    await waitFor(() => document.querySelector('[role="menu"]'));
    const labels = ['Done by me', 'Done by someone else', 'Not mine', 'Not needed'];
    expect(menuItems().map((t, i) => t?.startsWith(labels[i]!))).toEqual([true, true, true, true]);
    const notNeeded = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((e) => e.textContent?.startsWith('Not needed'))!;
    await act(async () => notNeeded.click());
    expect(m.onDone).toHaveBeenCalledWith('not_needed');
  });

  it('l opens Later ▾: tomorrow, next week, pick a date, not now', async () => {
    const m = menus();
    const { key } = await mount({ menus: m });
    await key('l');
    await waitFor(() => document.querySelector('[role="menu"]'));
    const text = document.querySelector('[role="menu"]')!.textContent!;
    for (const want of ['Tomorrow', 'Next week', 'Pick a date', 'Not now']) expect(text).toContain(want);
    const nextWeek = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((e) => e.textContent?.startsWith('Next week'))!;
    await act(async () => nextWeek.click());
    expect(m.onLater).toHaveBeenCalledWith('next_week');
  });

  it('keys typed in a field stay text', async () => {
    const m = menus();
    const { r, key } = await mount({ menus: m, sections: [{ id: 'note', render: () => h('textarea', { 'data-note': '' }) }] });
    await key('d', {}, r.container.querySelector('[data-note]')!);
    expect(m.onDone).not.toHaveBeenCalled();
  });

  it('no menus, no footer menus (an entity that is not closeable work)', async () => {
    const { r } = await mount({ primary: { label: 'Open in VDP', onClick: vi.fn() } });
    expect(r.container.querySelector('[data-testid="menu-done"]')).toBeNull();
    expect(r.container.querySelector('[data-testid="detail-primary"]')!.textContent).toBe('Open in VDP');
  });

  it('a rich panel keeps its own header, body and primary in the frame; extra Done ▾ entries and Later keys', async () => {
    const m = menus();
    const more = vi.fn();
    const { r, panel, key } = await mount({
      menus: m,
      header: h('div', { 'data-own-header': '' }, 'Editable title'),
      children: h('p', { 'data-own-body': '' }, 'Read-in first'),
      primaryNode: h('button', { type: 'button', 'data-own-primary': '' }, 'Start in Claude'),
      primary: { label: 'Ignored', onClick: vi.fn() },
      doneExtra: [{ id: 'done-more', label: 'More ways it ended…', onSelect: more }],
      laterKeys: ['l', 's'],
    });
    expect(r.container.querySelector('[data-own-header]')).not.toBeNull();
    expect(r.container.querySelector('[data-testid="detail-title"]')).toBeNull();
    expect(r.container.querySelector('[data-panel-scroll] [data-own-body]')).not.toBeNull();
    expect(r.container.querySelector('[data-panel-footer] [data-own-primary]')).not.toBeNull();
    expect(r.container.querySelector('[data-testid="detail-primary"]')).toBeNull();
    await key('s');
    await waitFor(() => document.querySelector('[role="menu"]')?.textContent?.includes('Next week'));
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await key('D', { shiftKey: true });
    const extra = await waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((e) => e.textContent?.startsWith('More ways it ended')));
    await act(async () => extra.click());
    expect(more).toHaveBeenCalled();
    expect(panel).toBeTruthy();
  });

  it('a row inside the panel owns its keys (its d is not the panel item’s)', async () => {
    const m = menus();
    const { r, key } = await mount({ menus: m, sections: [{ id: 'related', render: () => h('div', { role: 'row', tabIndex: 0, 'data-row': '' }, 'Sibling') }] });
    await key('d', {}, r.container.querySelector('[data-row]')!);
    expect(m.onDone).not.toHaveBeenCalled();
  });
});
