// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md): "In this thread" shows six items, six sources and three agent lines first, and
 * Show more / Show all reaches every one (no list cut with no way to the rest).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, $$, cleanup, click, render } from '@/components/composer/__tests__/dom';

const N = 9;
const touched = {
  changes: [],
  pending: [],
  itemIds: Array.from({ length: N }, (_, i) => ({ id: `wi_${i}`, label: `Item ${i}` })),
  drafts: [],
  sessions: [],
  scans: [],
  sources: Array.from({ length: N }, (_, i) => ({ kind: 'url', id: `src_${i}`, label: `Source ${i}`, href: `/triage?s=${i}` })),
};
const item = (i: number) => ({ id: `wi_${i}`, title: `Item ${i}`, state: 'open', effort: { youMin: 5, agentMin: 10 } });

vi.mock('../thread-model', async (orig) => ({ ...(await orig<typeof import('../thread-model')>()), threadTouched: () => touched, touchedCount: () => N * 2 }));
vi.mock('../ui-context', () => ({ useChatUi: () => ({ actions: {}, timeZone: 'UTC', undo: vi.fn() }) }));
vi.mock('../assistant-context', () => ({ useAssistantSurface: () => ({ scrollToMessage: vi.fn() }) }));
vi.mock('@/client/hooks', () => ({ useApi: () => ({ data: undefined, isPending: false, isSuccess: false, isError: false }) }));
vi.mock('@/client/api', () => ({
  queryKey: (k: string, i: unknown) => [k, i],
  api: async (_k: string, i: { params: { id: string } }) => ({ item: item(Number(i.params.id.slice(3))) }),
}));

const { ThreadContextPane } = await import('../ThreadContextPane');

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const group = (title: string) => $$('[data-thread-context] section').find((x) => x.querySelector('h3')?.textContent?.startsWith(title))!;
const rows = (title: string) => group(title).querySelectorAll('li').length;

describe('In this thread: long groups open up', () => {
  it('items and sources show 6 of 9 with Show 3 more; agent lines show 3 with Show all', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(h(QueryClientProvider, { client: qc }, h(ThreadContextPane, { messages: [] })));
    expect(rows('Items')).toBe(6);
    expect(rows('Sources cited')).toBe(6);
    expect(group('Items').textContent).toContain('6 of 9');

    await click(group('Items').querySelector('[data-show-more]'));
    expect(rows('Items')).toBe(N);
    await click(group('Sources cited').querySelector('[data-show-more]'));
    expect(rows('Sources cited')).toBe(N);
    expect(group('Sources cited').textContent).toContain('Source 8');

    // agent time: each loaded item runs ~10 min in the background; three lines first, then every one
    const more = await vi.waitFor(() => {
      const b = $('[data-agents-more]');
      if (!b) throw new Error('no agents control yet');
      return b;
    });
    expect(more.textContent).toBe(`Show all ${N}`);
    expect($('[data-cx-time]')!.textContent).not.toContain('Item 8 ~');
    await click(more);
    expect($('[data-cx-time]')!.textContent).toContain('Item 8 ~');
  });
});
