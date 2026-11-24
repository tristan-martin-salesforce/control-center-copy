// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 4 (Work ▸ Closed):
 * - Show more keeps focus while it loads (aria-disabled, never disabled: a disabled button dropped focus to the page).
 * - A done row's why line does not repeat its badge ("Done by Raj" badge, then "Done by Raj · by Raj Mehta"); a
 *   dismissed row (badge "Dismissed") still says how it ended.
 * - A flat tab (Closed, Snoozed) has no By when / By initiative toggle (it showed both options struck through).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@/contract';
import { $, cleanup, render } from '@/components/composer/__tests__/dom';
import { MoreRow } from '../../app/work/_list/MoreRow';
import { resolutionWhy } from '../../app/work/_list/RowExtras';

afterEach(async () => {
  await cleanup();
});

describe('Work ▸ Closed', () => {
  it('Show more stays focusable while it loads', async () => {
    await render(h(MoreRow, { loaded: 50, total: 120, busy: true, failed: false, onMore: () => {} }));
    const b = $('[data-testid="work-more-button"]') as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.textContent).toBe('Loading…');
  });

  it('a done row’s why line leaves the resolution to the badge; a dismissed row keeps it', async () => {
    const item = { state: 'done', resolution: 'done_by_other', resolutionDetail: { personName: 'Raj Mehta', inferred: true }, involvement: 'owner', closedReason: 'Raj posted the doc', doneBy: 'engine', doneAt: null, loopedBackIn: null } as unknown as WorkItem;
    await render(h('div', null, resolutionWhy(item, '2026-11-21T09:00:00Z')));
    expect($('[data-testid="resolution-line"]')!.textContent).toBe('by Raj Mehta · you own it · Raj posted the doc · inferred from evidence');
    await cleanup();
    await render(h('div', null, resolutionWhy({ ...item, state: 'dismissed', resolution: 'not_needed' } as WorkItem, '2026-11-21T09:00:00Z')));
    expect($('[data-testid="resolution-line"]')!.textContent).toMatch(/^Not needed · /);
  });

  it('no grouping toggle on a flat tab', () => {
    const src = readFileSync(path.join(__dirname, '../../app/work/_list/WorkPage.tsx'), 'utf8');
    expect(src).toMatch(/\{flat \? null : \(\s*<SegmentedToggle/);
  });
});
