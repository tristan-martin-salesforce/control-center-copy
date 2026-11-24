// @vitest-environment jsdom
/**
 * Today's header outside working hours (18-ui-polish.md): when the meter counts the next working day (MIN-22), the
 * sentence says "Outside your working hours", which is true after hours and on a day off. "The working day is over"
 * at 09:00 on a Saturday was not.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DayCapacity } from '@/components/today/capacity';
import { $, cleanup, render } from '@/components/composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/today',
  useSearchParams: () => new URLSearchParams(),
}));

const { DayHeader } = await import('@/components/today/DayHeader');

afterEach(cleanup);

const cap = (over: Partial<DayCapacity> = {}): DayCapacity => ({ youMin: 85, freeMin: 600, openMin: 515, fits: true, overByMin: 0, agentMin: 0, agentRuns: 0, fromEngine: true, next: true, dayLabel: 'Monday', ...over });
const wrap = (el: ReturnType<typeof h>) => h(QueryClientProvider, { client: new QueryClient() }, el);

describe('Today header verdict', () => {
  it('the next working day is counted: "Outside your working hours. Monday: …"', async () => {
    const { container } = await render(wrap(h(DayHeader, { nowIso: '2026-11-21T16:03:00.000Z', tz: 'America/Denver', cap: cap(), agentLabels: [], dayOver: false, catchUp: null })));
    const v = $('[data-verdict]', container)!.textContent ?? '';
    expect(v).toMatch(/^Outside your working hours\. Monday: about 1h 25m of your work/);
    expect(v).not.toContain('working day is over');
  });

  it('within the day, the verdict is today’s', async () => {
    const { container } = await render(wrap(h(DayHeader, { nowIso: '2026-11-19T16:03:00.000Z', tz: 'America/Denver', cap: cap({ next: false, dayLabel: 'today' }), agentLabels: [], dayOver: false, catchUp: null })));
    expect($('[data-verdict]', container)!.textContent).not.toContain('Outside your working hours');
  });
});
