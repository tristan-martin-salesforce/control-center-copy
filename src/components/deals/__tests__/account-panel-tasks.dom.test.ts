// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md): the account panel lists six open tasks; past six, "See all N in Work" opens Work
 * filtered by the account, so every task is one click away (the title already counted all of them).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, cleanup, click, render } from '@/components/composer/__tests__/dom';

const nav = vi.hoisted(() => vi.fn());
const detail = {
  account: { id: 'acc_globex', name: 'Globex', industry: null, dcStatus: 'none', vdpStatus: 'none', hoursQtd: 0, org62Url: null },
  opps: [],
  items: Array.from({ length: 9 }, (_, i) => ({ id: `wi_${i}`, title: `Task ${i}`, why: null, state: i === 8 ? 'done' : 'open' })),
};
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: detail, isError: false, isPending: false, refetch: vi.fn() }) }));
vi.mock('@/components/shell/router', () => ({ navigate: nav }));
vi.mock('@/components/shell/panel', () => ({ useRightPanel: () => ({ openDetails: vi.fn(), close: vi.fn() }) }));
vi.mock('../hooks', () => ({ useToday: () => '2026-11-21', useDealsFeatures: () => ({ ready: true, dc: false, vdp: false, missed: false }), useMissedSweep: () => ({ data: undefined }) }));
vi.mock('../needs', async (orig) => ({ ...(await orig<typeof import('../needs')>()), accountNeed: () => null }));

const { AccountPanel } = await import('../panels');

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('Account panel ▸ open tasks', () => {
  it('shows six of eight open tasks and See all 8 in Work, filtered by the account', async () => {
    await render(h(AccountPanel, { id: 'acc_globex' }));
    expect(document.body.textContent).toContain('Open tasks · 8');
    expect(document.body.textContent).toContain('Task 5');
    expect(document.body.textContent).not.toContain('Task 6');
    const all = $('[data-testid="account-tasks-all"]')!;
    expect(all.textContent).toBe('See all 8 in Work');
    await click(all);
    expect(nav).toHaveBeenCalledWith('/work?account=acc_globex');
  });
});
