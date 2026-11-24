// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md): Cap raises (Health ▸ Spend, Settings ▸ Budgets) lists the newest eight, then
 * "Show all N" lists every kept raise (it stopped at eight).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, cleanup, click, render } from '../../composer/__tests__/dom';

const raises = Array.from({ length: 11 }, (_, i) => ({ at: `2026-11-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`, day: `2026-11-${String(i + 1).padStart(2, '0')}`, fromHardUsd: 5 + i, toHardUsd: 6 + i, reason: `Raise ${i}` }));
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: { budgets: { raises } }, isPending: false, isSuccess: true }) }));

const { RaiseHistory } = await import('../RaiseCap');

afterEach(async () => {
  await cleanup();
});

const rows = () => $('[data-testid="raise-history"]')!.querySelectorAll('li').length;

describe('Cap raises', () => {
  it('eight newest first, then Show all 11', async () => {
    await render(h(RaiseHistory, {}));
    expect(rows()).toBe(8);
    expect(document.body.textContent).toContain('Raise 10'); // newest first
    expect(document.body.textContent).not.toContain('Raise 0');
    const all = $('[data-testid="raise-history-all"]')!;
    expect(all.textContent).toBe('Show all 11');
    await click(all);
    expect(rows()).toBe(11);
    expect(document.body.textContent).toContain('Raise 0');
  });
});
