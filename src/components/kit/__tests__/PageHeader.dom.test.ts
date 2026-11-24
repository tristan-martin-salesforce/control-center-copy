// @vitest-environment jsdom
/** PageHeader: the title comes from the route table, whatever the tab (no Activity / Time / VDP drift). */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { ROUTES } from '@/components/shell/routes';
import { PageHeader, pageTitle } from '../PageHeader';

const { act } = await import('react');

afterEach(async () => cleanup());

const TABS = [
  { value: 'log', label: 'To log', count: 6 },
  { value: 'history', label: 'History' },
  { value: 'vdp', label: 'VDP', count: 2 },
];

describe('PageHeader', () => {
  it('reads every title from the route table', () => {
    for (const r of ROUTES) expect(pageTitle(r.key)).toBe(ROUTES.find((x) => x.key === r.key)!.title);
    expect(pageTitle('time')).toBe('Activity');
  });

  it('keeps one title across tabs, with the sentence, crumb and actions', async () => {
    const onTab = vi.fn();
    const make = (tab: string) => h(PageHeader, { route: 'time', tabs: TABS, tab, onTab, sentence: '6 rows wait on you.', actions: h('button', { type: 'button' }, 'Log 6') });
    const r = await render(make('log'));
    const title = () => r.container.querySelector('[data-testid="page-title"]')!.textContent;
    expect(title()).toBe('Activity');
    expect(r.container.querySelector('h1')).not.toBeNull();
    expect(r.container.querySelector('[data-testid="page-sentence"]')!.textContent).toBe('6 rows wait on you.');
    expect(r.container.textContent).toContain('Log 6');
    await act(async () => [...r.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.includes('VDP'))!.click());
    expect(onTab).toHaveBeenCalledWith('vdp');
    await act(async () => r.root.render(make('vdp')));
    expect(title()).toBe('Activity');
  });

  it('an entity page names its entity after the title', async () => {
    const r = await render(h(PageHeader, { route: 'account', crumb: 'Saltmere Health' }));
    expect(r.container.querySelector('[data-testid="page-title"]')!.textContent).toBe('Account');
    expect(r.container.querySelector('[data-testid="page-crumb"]')!.textContent).toContain('Saltmere Health');
  });

  it('in the app frame leaves the title to the topbar (one h1), keeping crumb, sentence and tabs', async () => {
    const r = await render(h(PageHeader, { route: 'settings', titleIn: 'topbar', inset: false, crumb: 'Sending', sentence: 'Nothing leaves without your approval.', tabs: TABS, tab: 'log', onTab: () => {} }));
    expect(r.container.querySelector('h1')).toBeNull();
    expect(r.container.querySelector('[data-testid="page-title"]')).toBeNull();
    expect(r.container.querySelector('[data-page-header="settings"]')!.getAttribute('data-title-in')).toBe('topbar');
    expect(r.container.querySelector('[data-testid="page-crumb"]')!.textContent).toBe('Sending');
    expect(r.container.querySelector('[data-testid="page-sentence"]')!.textContent).toContain('Nothing leaves');
    expect(r.container.querySelectorAll('[role="tab"]').length).toBe(3);
  });
});
