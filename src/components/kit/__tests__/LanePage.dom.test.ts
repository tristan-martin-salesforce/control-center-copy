// @vitest-environment jsdom
/**
 * LanePage in one column (review finding R3-1, docs/decisions/0102-activity-lanes.md): when the panel opens and the
 * frame drops to one column, a lane with work stays open and shows its rows; only `collapsed` lanes start shut; the
 * user's own toggle wins. Chrome lost the rows of a size-container body when `#cc-main[data-panel]` flipped the layout,
 * so on every switch each body is taken out of layout and put back (pinned below by reading `display` at the reflow).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { LanePage, type Lane } from '../LanePage';

const { act } = await import('react');

const lanes: Lane[] = [
  { id: 'fix', header: { title: 'Fix or approve', count: 2 }, body: h('ul', null, h('li', { 'data-row': '' }, 'row 1'), h('li', { 'data-row': '' }, 'row 2')) },
  { id: 'ready', header: { title: 'Ready to log', count: 1 }, body: h('ul', null, h('li', { 'data-row': '' }, 'row 3')) },
  { id: 'sending', collapsed: true, header: { title: 'Sending', count: 0 }, body: h('p', null, 'nothing on its way') },
];

const section = (id: string) => document.getElementById(`lane-${id}`)!;
const body = (id: string) => section(id).querySelector<HTMLElement>('[data-lane-body]')!;
const shown = (id: string) => !/(^| )hidden( |$)/.test(body(id).className) && body(id).style.display !== 'none';

async function openPanel(main: HTMLElement) {
  await act(async () => {
    main.setAttribute('data-panel', 'open');
    await Promise.resolve(); // the MutationObserver's callback
  });
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('LanePage one column', () => {
  it('one column: a lane with work shows its rows', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
    const reflowed: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-lane-body')) reflowed.push(`${this.id}:${this.style.display}`);
      return 0;
    });
    const r = await render(h('main', { id: 'cc-main', 'data-panel': 'closed' }, h(LanePage, { lanes })));
    const frame = r.container.querySelector('[data-lane-page]')!;
    expect(frame.getAttribute('data-columns')).toBe('2');
    reflowed.length = 0; // the first layout pass corrects the server's one column; only the panel's switch counts here

    await openPanel(r.container.querySelector<HTMLElement>('#cc-main')!);
    expect(frame.getAttribute('data-columns')).toBe('1');
    for (const id of ['fix', 'ready']) {
      expect(section(id).hasAttribute('data-collapsed')).toBe(false);
      expect(section(id).querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true');
      expect(shown(id)).toBe(true);
      expect(body(id).querySelectorAll('[data-row]').length).toBeGreaterThan(0);
    }
    // the switch rebuilt every body's layout, and gave each its display back
    expect(reflowed).toEqual(['lane-fix-body:none', 'lane-ready-body:none', 'lane-sending-body:none']);
    // a lane with no work starts shut
    expect(section('sending').getAttribute('data-collapsed')).toBe('true');
    expect(shown('sending')).toBe(false);
  });

  it("the user's own toggle wins over the default, across a switch", async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    const r = await render(h('main', { id: 'cc-main', 'data-panel': 'closed' }, h(LanePage, { lanes })));
    expect(r.container.querySelector('[data-lane-page]')!.getAttribute('data-columns')).toBe('1');
    await act(async () => section('fix').querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    await act(async () => section('sending').querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    await openPanel(r.container.querySelector<HTMLElement>('#cc-main')!);
    expect(shown('fix')).toBe(false);
    expect(shown('sending')).toBe(true);
    expect(shown('ready')).toBe(true);
  });
});
