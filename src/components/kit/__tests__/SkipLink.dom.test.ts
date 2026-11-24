// @vitest-environment jsdom
/** SkipLink (30-a11y): the frame's first tab stop moves focus into the page, its first row or control, else main. */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { focusInto, SkipLink } from '../SkipLink';

const { act } = await import('react');

afterEach(async () => {
  await cleanup();
  document.body.innerHTML = '';
});

/** jsdom has no layout: give every element a client rect so the "visible" filter keeps it. */
function visible(el: Element) {
  (el as HTMLElement).getClientRects = () => [{}] as unknown as DOMRectList;
}

describe('SkipLink', () => {
  it('is a real link to #cc-main named "Skip to content"', async () => {
    const r = await render(h(SkipLink));
    const a = r.container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('#cc-main');
    expect(a.textContent).toBe('Skip to content');
    expect(a.className).toContain('sr-only');
    expect(a.className).toContain('focus:not-sr-only');
  });

  it('a click focuses the first row inside main and keeps the URL as it was', async () => {
    const main = document.createElement('main');
    main.id = 'cc-main';
    main.tabIndex = -1;
    main.innerHTML = '<div data-row tabindex="0">row 1</div><button>later</button>';
    document.body.appendChild(main);
    main.querySelectorAll('*').forEach(visible);
    const r = await render(h(SkipLink));
    const before = window.location.href;
    await act(async () => r.container.querySelector('a')!.click());
    expect(document.activeElement?.textContent).toBe('row 1');
    expect(window.location.href).toBe(before);
  });

  it('with nothing focusable inside, main itself takes focus', () => {
    const main = document.createElement('main');
    main.tabIndex = -1;
    main.innerHTML = '<p>Nothing here</p>';
    document.body.appendChild(main);
    expect(focusInto(main)).toBe(main);
    expect(document.activeElement).toBe(main);
  });

  it('skips hidden controls', () => {
    const main = document.createElement('main');
    main.tabIndex = -1;
    main.innerHTML = '<div hidden><button>hidden</button></div><button>shown</button>';
    document.body.appendChild(main);
    main.querySelectorAll('button').forEach(visible);
    expect(focusInto(main).textContent).toBe('shown');
  });
});
