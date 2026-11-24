// @vitest-environment jsdom
/**
 * Activity ▸ To log ▸ Ready to log, live (2026-11-16; lane 2 since C5/C7): approving 70 rows at once left 1 row on
 * screen and the rest held behind a pill the list never drew, and the button named fewer rows than it would take. Rows
 * you approve are never held back as a burst, and the one button ("Log N · h") counts every row it takes. The rows are
 * grouped by day. On To log the lane's header is LanePage's (C7): the lane draws no button, ReadyLogButton is the one.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityEntry } from '@/contract';
import { resetIntent } from '@/client/intent';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { ReadyLane, ReadyLogButton, type ReadyLaneProps } from '@/components/time/ReadyLane';
import { useReadyLog } from '@/components/time/use-ready-log';

const { act } = await import('react');

const row = (n: number): ActivityEntry =>
  ({
    id: `r${n}`,
    version: 1,
    date: '2026-11-10',
    start: `2026-11-10T${String(8 + (n % 10)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00.000Z`,
    end: `2026-11-10T${String(9 + (n % 10)).padStart(2, '0')}:00:00.000Z`,
    durationH: 0.5,
    taskType: 'Admin',
    oppId: 'o1',
    oppName: 'ACME · Platform',
    accountName: 'ACME',
    meetingType: null,
    description: `Row ${n}`,
    status: 'approved',
    confidence: 'likely',
    sources: [],
    userLockedFields: [],
    issues: [],
  }) as unknown as ActivityEntry;

const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));

const props = (r: ActivityEntry[]): ReadyLaneProps => ({
  ready: r,
  pick: { taskTypeRequired: true, taskTypes: ['Admin'], internalActivity: true },
  dryRun: true,
  loadFresh: async () => r,
  onOpen: () => {},
});

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
const ready = (r: ActivityEntry[], more: Partial<ReadyLaneProps> = {}) => h(QueryClientProvider, { client: qc }, h(ReadyLane, { ...props(r), ...more }));

/** To log's way: the page holds the state, LanePage's header holds the button, the lane draws none. */
function Held({ r }: { r: ActivityEntry[] }) {
  const log = useReadyLog({ ready: r, taskTypeRequired: true, loadFresh: async () => r });
  return h('div', null, h('header', null, h(ReadyLogButton, { log })), h(ReadyLane, { ...props(r), log, header: false }));
}

const button = (c: HTMLElement) => c.querySelector('[data-testid="review-log"]')?.textContent ?? '';
const listed = (c: HTMLElement) => c.querySelectorAll('[data-ready-row]').length;

beforeEach(() => resetIntent());
afterEach(async () => cleanup());

describe('Ready to log, live', () => {
  it('shows rows approved in a burst at once (never held behind a pill), and the button counts them all', async () => {
    const r = await render(ready(rows(1)));
    expect(listed(r.container)).toBe(1);
    expect(button(r.container)).toBe('Log 1 row · 0.5 h');
    // 70 more rows approved at once (Accept on lane 1, or a refetch after a stale cache)
    await act(async () => r.root.render(ready(rows(71))));
    expect(listed(r.container)).toBe(8); // a group's first 8; Show more has the rest
    expect(r.container.querySelector('[data-live-pill]')).toBeNull();
    expect(button(r.container)).toBe('Log 71 rows · 35.5 h');
  });

  it('groups the rows by day', async () => {
    const two = [row(1), { ...row(2), id: 'r2b', date: '2026-11-11', start: '2026-11-11T09:00:00.000Z', end: '2026-11-11T10:00:00.000Z' } as ActivityEntry];
    const r = await render(ready(two));
    expect([...r.container.querySelectorAll<HTMLElement>('[data-ready-day]')].map((d) => d.dataset.readyDay)).toEqual(['2026-11-10', '2026-11-11']);
  });
});

describe('Ready to log on LanePage (C7): one header, one button', () => {
  it('the lane draws no header or button of its own; the held ReadyLogButton counts every row', async () => {
    const r = await render(h(QueryClientProvider, { client: qc }, h(Held, { r: rows(3) })));
    expect(r.container.querySelectorAll('[data-testid="review-log"]')).toHaveLength(1);
    expect(r.container.querySelector('header [data-testid="review-log"]')?.textContent).toBe('Log 3 rows · 1.5 h');
    expect(r.container.querySelector('[data-testid="ready-count"]')).toBeNull();
    expect(listed(r.container)).toBe(3);
  });
});
