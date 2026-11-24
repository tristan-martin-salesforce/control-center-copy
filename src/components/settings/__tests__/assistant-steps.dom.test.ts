// @vitest-environment jsdom
/**
 * Caps audit F-1 (26-caps-audit.md): Settings ▸ Budgets ▸ Assistant limits, "Steps per message". The setting defaults
 * to 200 (a runaway guard; cost is the per-message budget), so the input takes every value the setting does (no
 * max of 80, and since post-caps-ui-2 no max at all: any positive number), the helper says the default and that the
 * Assistant stops and asks, and Save stores a value above the old 400 ceiling.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams('section=budgets'),
}));

const { AssistantLimitsSection, ThresholdsSection } = await import('../BasicSections');
const { SettingsModelProvider } = await import('../state');
const { parseThresholds } = await import('../derive');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;

function matchRoute(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | null {
  for (const [key, def] of Object.entries(routes)) {
    if (def.method !== method || (def as { stream?: boolean }).stream) continue;
    const names = [...def.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]!);
    const m = new RegExp(`^${API_BASE}${def.path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`).exec(pathname);
    if (m) return { key: key as RouteKey, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
  }
  return null;
}

beforeEach(() => {
  resetDataSourceForTests();
  ds = createMockDataSource({ delays: { enrichMs: 5, reevalMs: 5, stepMs: 5, verifyMs: 5 }, autoplay: false });
  (globalThis as { __ccDataSource?: unknown }).__ccDataSource = ds;
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => {};
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = matchRoute(method, url.pathname);
    if (!m) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  resetDataSourceForTests();
});

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const stored = () => (ds as unknown as { store: { settings(): { chat: { maxSteps: number } } } }).store.settings().chat.maxSteps;

describe('Settings ▸ Assistant limits: steps per message', () => {
  it('shows the default 200, has no ceiling, and Save stores 1000', async () => {
    await render(h(QueryClientProvider, { client: qc }, h(SettingsModelProvider, null, h(AssistantLimitsSection))));
    const input = await waitFor(() => $('#a-steps') as HTMLInputElement | null);
    expect(input.value).toBe('200');
    expect(input.max).toBe(''); // no ceiling: any positive number (src/contract/settings.ts)
    expect(input.min).toBe('1');
    expect(document.body.textContent).toContain('Any positive number; the default is 200. The Assistant stops and asks when it is reached.');

    await type(input, '1000');
    expect(input.validity.rangeOverflow).toBe(false);
    await click($('[data-testid="save-assistant-limits"]'));
    await waitFor(() => stored() === 1000);
  });
});

// Settings ▸ Thresholds, "Reopen window" (26-caps-audit.md, other lanes): the input's max={60} was a bound only in the UI
// (the contract has none), so it keeps its floor of 1, has no ceiling, and the helper says what the window does.
describe('Settings ▸ Thresholds: reopen window', () => {
  it('has a floor of 1 and no ceiling, says what the window does, and Save keeps 90 days', async () => {
    await render(h(QueryClientProvider, { client: qc }, h(SettingsModelProvider, null, h(ThresholdsSection))));
    const input = await waitFor(() => $('#t-reopen') as HTMLInputElement | null);
    expect(input.value).toBe('14');
    expect(input.min).toBe('1');
    expect(input.max).toBe('');
    expect(document.body.textContent).toContain('A done item that gets a new requirement within this many days of closing reopens and says why; later than that, a new item is created.');

    await type(input, '90');
    expect(input.value).toBe('90');
    expect(input.validity.rangeOverflow).toBe(false);
    await click($('[data-testid="save-thresholds"]'));
    await waitFor(() => (JSON.parse(localStorage.getItem('cc:settings:thresholds') ?? '{}') as { reopenWindowDays?: number }).reopenWindowDays === 90);

    // a reload reads it back unclamped (parseThresholds: floor 1, no ceiling)
    await cleanup();
    await render(h(QueryClientProvider, { client: qc }, h(SettingsModelProvider, null, h(ThresholdsSection))));
    expect((await waitFor(() => $('#t-reopen') as HTMLInputElement | null)).value).toBe('90');
  });

  it('parseThresholds keeps a saved window past the old 60-day ceiling and floors it at 1', () => {
    expect(parseThresholds(JSON.stringify({ reopenWindowDays: 90 })).reopenWindowDays).toBe(90);
    expect(parseThresholds(JSON.stringify({ reopenWindowDays: 400 })).reopenWindowDays).toBe(400);
    expect(parseThresholds(JSON.stringify({ reopenWindowDays: 0 })).reopenWindowDays).toBe(1);
  });
});
