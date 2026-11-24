// @vitest-environment jsdom
/**
 * The kit's accessibility rules (30-a11y, docs/UX.md "Keyboard and screen reader"): what the axe smoke found at kit
 * level, pinned where it was fixed.
 * - ActionRow: a row owns one gridcell (never bare buttons), and the cell takes no box.
 * - ReviewQueue: its title is an h2 (the topbar holds the page's one h1).
 * - Tabs: aria-controls names a panel only when that panel is on the page.
 * - KbdHint: no aria-label on a plain span; `decorative` hides the caps from screen readers.
 * - Button with kbd: the name is the visible label, the shortcut is aria-keyshortcuts.
 * - Menu: Tab on an item closes the menu (WAI-ARIA menu pattern).
 * - LanePage: lanes are labelled sections; pills (buttons) only in one column; a collapsed lane shows its header only.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@/components/composer/__tests__/dom';
import { Button } from '@/ui/Button';
import { ariaKeyShortcuts, KbdHint } from '@/ui/Kbd';
import { Menu } from '@/ui/Menu';
import { tabPanelProps, Tabs } from '@/ui/Tabs';
import { ActionRow } from '../ActionRow';
import { LanePage, type Lane } from '../LanePage';
import { ReviewQueue } from '../ReviewQueue';

const { act } = await import('react');

afterEach(async () => cleanup());

describe('ActionRow roles', () => {
  it('the row holds one gridcell, and the verbs sit inside it', async () => {
    const r = await render(h(ActionRow, { id: 'wi-1', title: 'Send the blueprint', why: 'Asked by Friday', verb: { label: 'Review', onClick: vi.fn() }, overflow: [{ id: 'snooze', label: 'Snooze', icon: 'clock', onClick: vi.fn() }] }));
    const row = r.container.querySelector<HTMLElement>('[role="row"]')!;
    const kids = Array.from(row.children);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.getAttribute('role')).toBe('gridcell');
    expect(kids[0]!.className).toContain('contents');
    for (const b of row.querySelectorAll('button')) expect(b.closest('[role="gridcell"]')).toBe(kids[0]);
  });
});

describe('ReviewQueue heading', () => {
  it('titles the drain with an h2, never a second h1', async () => {
    const r = await render(h(ReviewQueue<{ id: string }>, { title: 'Review drafts', items: [{ id: 'a' }], adapter: { approve: vi.fn(), snooze: vi.fn(), dismiss: vi.fn(), undo: vi.fn() }, renderCard: () => h('p', null, 'card'), toastMs: 60_000, nextCheckMin: 15 }));
    expect(r.container.querySelector('h1')).toBeNull();
    expect(r.container.querySelector('h2')?.textContent).toBe('Review drafts');
  });
});

describe('Tabs aria-controls', () => {
  const tabs = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];
  it('names no panel when none is on the page (a tab row that switches the route)', async () => {
    const r = await render(h(Tabs, { tabs, value: 'a', onChange: vi.fn(), idBase: 'route' }));
    for (const t of r.container.querySelectorAll('[role="tab"]')) expect(t.hasAttribute('aria-controls')).toBe(false);
  });
  it('names the panel when it is there (tabPanelProps)', async () => {
    const r = await render(h('div', null, h(Tabs, { tabs, value: 'a', onChange: vi.fn(), idBase: 'pp' }), h('div', tabPanelProps('pp', 'a'), 'panel')));
    await waitFor(() => r.container.querySelector('#pp-tab-a')?.getAttribute('aria-controls'));
    expect(r.container.querySelector('#pp-tab-a')!.getAttribute('aria-controls')).toBe('pp-panel-a');
  });
});

describe('KbdHint and Button kbd', () => {
  it('a hint is read as its caps: no aria-label on a plain span', async () => {
    const r = await render(h(KbdHint, { combo: 'g h' }));
    expect(r.container.querySelector('[aria-label]')).toBeNull();
    expect(r.container.querySelector('[aria-hidden]')).toBeNull();
    expect(r.container.textContent).toContain('then');
  });
  it('decorative hides the caps from screen readers', async () => {
    const r = await render(h(KbdHint, { combo: 'mod+k', decorative: true }));
    expect(r.container.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
  });
  it('a Button with kbd announces the shortcut as aria-keyshortcuts and hides the caps', async () => {
    const r = await render(h(Button, { kbd: 'shift+d' }, 'Done'));
    const b = r.container.querySelector('button')!;
    expect(b.getAttribute('aria-keyshortcuts')).toBe('Shift+D');
    expect(b.querySelector('[aria-hidden="true"] kbd')).not.toBeNull();
    expect(b.hasAttribute('aria-label')).toBe(false);
  });
  it('a caller’s own aria-keyshortcuts wins', async () => {
    const r = await render(h(Button, { kbd: 'mod+j', 'aria-keyshortcuts': 'Meta+J' }, 'Assistant'));
    expect(r.container.querySelector('button')!.getAttribute('aria-keyshortcuts')).toBe('Meta+J');
  });
  it('ariaKeyShortcuts: mod by platform, alternatives, chords left out', () => {
    expect(ariaKeyShortcuts('mod+k', true)).toBe('Meta+K');
    expect(ariaKeyShortcuts('mod+k', false)).toBe('Control+K');
    expect(ariaKeyShortcuts('j|k', true)).toBe('J K');
    expect(ariaKeyShortcuts('shift+enter', true)).toBe('Shift+Enter');
    expect(ariaKeyShortcuts('esc', true)).toBe('Escape');
    expect(ariaKeyShortcuts('g h', true)).toBeUndefined();
  });
});

describe('Menu keyboard', () => {
  it('Tab on an item closes the menu and gives focus back to the trigger', async () => {
    const r = await render(h(Menu, { label: 'More', trigger: h('button', { type: 'button' }, 'More'), items: [{ id: 'a', label: 'Alpha', onSelect: vi.fn() }, { id: 'b', label: 'Beta', kbd: 'b', onSelect: vi.fn() }] }));
    const trigger = r.container.querySelector('button')!;
    await act(async () => trigger.click());
    const item = await waitFor(() => document.querySelector<HTMLElement>('[role="menuitem"]'));
    expect(document.querySelectorAll('[role="menuitem"]')[1]!.getAttribute('aria-keyshortcuts')).toBe('B');
    item.focus();
    await act(async () => void item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('LanePage', () => {
  const lanes: Lane[] = [
    { id: 'fix', span: 'left', header: { title: 'Fix or approve', count: 36, action: h('button', { type: 'button' }, 'Accept 21') }, body: h('p', null, 'fix rows') },
    { id: 'ready', span: 'right', collapsed: true, header: { title: 'Ready to log', count: 11 }, body: h('p', null, 'ready rows') },
    { id: 'sending', span: 'right', collapsed: true, header: { title: 'Sending', count: 2, failure: '2 not found' }, body: h('p', null, 'sending rows') },
  ];
  const frame = (panel: 'open' | 'closed', width: number) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    return render(h('main', { id: 'cc-main', 'data-panel': panel }, h(LanePage, { lanes })));
  };
  afterEach(() => vi.restoreAllMocks());

  it('renders one section per lane, each named by its heading', async () => {
    const r = await frame('closed', 1400);
    const sections = [...r.container.querySelectorAll('section')];
    expect(sections.map((s) => s.id)).toEqual(['lane-fix', 'lane-ready', 'lane-sending']);
    for (const s of sections) {
      const heading = document.getElementById(s.getAttribute('aria-labelledby')!)!;
      expect(heading.tagName).toBe('H2');
      expect(s.contains(heading)).toBe(true);
    }
    expect(r.container.querySelector('#lane-sending [data-lane-failure]')!.textContent).toContain('2 not found');
    // lane 1 left; lanes 2 and 3 stacked right
    expect([...r.container.querySelectorAll('[data-lane-column="right"] section')].map((s) => s.id)).toEqual(['lane-ready', 'lane-sending']);
  });

  it('shows the pills only in one column: panel open, or main under 1,100 px', async () => {
    let r = await frame('closed', 1400);
    expect(r.container.querySelector('[data-lane-page]')!.getAttribute('data-columns')).toBe('2');
    expect(r.container.querySelector('nav')).toBeNull();
    expect(r.container.querySelector('[data-collapsed]')).toBeNull();
    await cleanup();
    vi.restoreAllMocks();
    r = await frame('closed', 900);
    expect(r.container.querySelector('[data-lane-page]')!.getAttribute('data-columns')).toBe('1');
    await cleanup();
    vi.restoreAllMocks();
    r = await frame('open', 1400);
    const pills = [...r.container.querySelectorAll<HTMLButtonElement>('nav button')];
    expect(pills.map((b) => b.textContent)).toEqual(['Fix or approve36', 'Ready to log11', 'Sending2▲, 2 not found']);
    expect(pills.every((b) => b.type === 'button')).toBe(true);
  });

  it('a collapsed lane shows its header line only; its pill opens it', async () => {
    const r = await frame('open', 1400);
    const ready = r.container.querySelector<HTMLElement>('#lane-ready')!;
    expect(ready.getAttribute('data-collapsed')).toBe('true');
    expect(ready.querySelector('[data-lane-body]')!.className).toMatch(/(^| )hidden( |$)/);
    expect(ready.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false');
    expect(r.container.querySelector('#lane-fix')!.hasAttribute('data-collapsed')).toBe(false);
    const pill = [...r.container.querySelectorAll<HTMLButtonElement>('nav button')].find((b) => b.textContent?.startsWith('Ready'))!;
    await act(async () => pill.click());
    expect(ready.hasAttribute('data-collapsed')).toBe(false);
    expect(ready.querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(document.getElementById('lane-ready-title'));
  });
});
