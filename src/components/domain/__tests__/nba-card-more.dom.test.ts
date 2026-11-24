// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md, low): the NBA card's Why popover shows the four strongest rank reasons and
 * "+N more reasons"; its Plan block shows three tool inputs and "+N more inputs". Each reaches the rest.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NbaCard, WorkItem } from '@/contract';
import { $, cleanup, click, render } from '@/components/composer/__tests__/dom';
import { PlanBlock, WhyPopover } from '../NbaCard.parts';

afterEach(async () => {
  await cleanup();
});

describe('NBA card: nothing cut without a way to it', () => {
  it('Why: four reasons, then +2 more reasons shows all six', async () => {
    const item = { why: 'why', rank: 2, rankReasons: Array.from({ length: 6 }, (_, i) => ({ key: `r${i}`, label: `Reason ${i}`, contribution: 10 - i })) } as unknown as WorkItem;
    await render(h(WhyPopover, { id: 'why', pinned: true, detail: null, item, sources: [] }));
    expect(document.querySelectorAll('li')).toHaveLength(4);
    const more = $('[data-more-reasons]')!;
    expect(more.textContent).toBe('+2 more reasons');
    await click(more);
    expect(document.querySelectorAll('li')).toHaveLength(6);
    expect(document.body.textContent).toContain('Reason 5');
  });

  it('Plan: three inputs, then +2 more inputs shows all five', async () => {
    const nba = { verb: 'run_tool', toolAdapterId: null, claudeLaunch: null, why: 'w', toolInputs: { a: '1', b: '2', c: '3', d: '4', e: '5', accountId: 'acc_1' } } as unknown as NbaCard;
    await render(h(PlanBlock, { nba, run: null, now: '2026-11-21T10:00:00.000Z' }));
    expect(document.querySelectorAll('dt')).toHaveLength(3);
    const more = $('[data-more-inputs]')!;
    expect(more.textContent).toBe('+2 more inputs');
    await click(more);
    expect(document.querySelectorAll('dt')).toHaveLength(5); // an id stays out, as before
  });
});
