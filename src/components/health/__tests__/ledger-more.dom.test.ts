// @vitest-environment jsdom
/**
 * Caps audit F-2: Health ▸ Ledger lists the newest 100 scan runs and "Show 100 more" reads older ones by the cursor
 * (GET /scans `cursor` → `nextCursor`), so every run is reachable; the count says how many of the total are loaded,
 * and the button goes when the last page is in. Synthetic runs through the real handler shape (scanPage).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connector, ScanRun } from '@/contract';
import { scanPage } from '@/server/views/health';
import { $, $$, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/health',
  useSearchParams: () => new URLSearchParams('tab=ledger'),
}));

const { LedgerTab } = await import('../LedgerTab');

const RUNS: ScanRun[] = Array.from({ length: 230 }, (_, i) => {
  const at = new Date(Date.UTC(2026, 10, 1) + i * 600_000).toISOString();
  return { id: `run${i}`, connectorId: 'c_slack', scope: 'inbox', kind: 'poll', windowStart: at, windowEnd: at, status: 'ok', startedAt: at, endedAt: at, itemsSeen: 1, itemsNew: 0, itemsChanged: 0, costUsd: 0, model: null, error: null } as ScanRun;
});
const connectors = [{ id: 'c_slack', label: 'Slack' }] as Connector[];
let calls: string[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    calls.push(`${url.pathname}${url.search}`);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    return new Response(JSON.stringify(scanPage(RUNS, { limit, cursor })), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

describe('Health ▸ Ledger: Show more', () => {
  it('pages by the cursor to the oldest run, then the button goes', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    await render(h(QueryClientProvider, { client: qc }, h(LedgerTab, { connectors, filterId: 'all', onFilter: () => {}, onOpenConnector: () => {} })));
    await waitFor(() => $$('[data-run]').length === 100);
    const more = $('[data-testid="ledger-more"]')!;
    expect(more.textContent).toContain('Show 100 more');
    expect(more.textContent).toContain('100 of 230 runs loaded');

    await click($('[data-testid="ledger-more-button"]'));
    await waitFor(() => $$('[data-run]').length === 200);
    expect(calls.some((c) => c.includes('cursor='))).toBe(true);
    expect($('[data-testid="ledger-more"]')!.textContent).toContain('Show 30 more');

    await click($('[data-testid="ledger-more-button"]'));
    await waitFor(() => $$('[data-run]').length === 230);
    const ids = $$('[data-run]').map((r) => r.getAttribute('data-run'));
    expect(new Set(ids).size).toBe(230);
    expect(ids[0]).toBe('run229');
    expect(ids.at(-1)).toBe('run0');
    expect($('[data-testid="ledger-more"]')).toBeNull();
  });
});
