// @vitest-environment jsdom
/**
 * W12-5: the engine switches in Settings, one row each, saved instantly through PATCH /settings/:section against the
 * mock DataSource and the real handlers: Sending ▸ Closing items for you (closing.resolutionEngine), Budgets ▸
 * Assistant model (chat.routing) and Ranking (priority.engine) beside it; Health links to them.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, cleanup, render, waitFor } from '@/components/composer/__tests__/dom';

const nav = vi.hoisted(() => ({ section: 'data' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(`section=${nav.section}`),
}));

const { SettingsPage } = await import('../SettingsPage');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;
let calls: Array<{ method: string; path: string; body: unknown }>;

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
  calls = [];
  // jsdom has no layout: a ResizeObserver that never fires, and scroll calls that do nothing
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => {};
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = matchRoute(method, url.pathname);
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!m) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  resetDataSourceForTests();
});

const mount = () => render(h(QueryClientProvider, { client: qc }, h(SettingsPage)));
const pick = (row: string) => $(`[data-testid="${row}-row"] select`) as HTMLSelectElement | null;
const labels = (row: string) => [...pick(row)!.options].map((o) => o.textContent?.trim());
const chosen = (row: string) => pick(row)!.selectedOptions[0]?.textContent?.trim();
async function choose(row: string, value: string) {
  const el = pick(row)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const patches = (section: string) => calls.filter((c) => c.method === 'PATCH' && c.path.endsWith(`/settings/${section}`)).map((c) => (c.body as { value: Record<string, unknown> }).value);
/** Wait until the PATCH answered (its response is in the mock store), then read the saved settings. */
async function savedAfter(section: string) {
  await waitFor(() => (patches(section).length ? true : null));
  for (let i = 0; i < 50; i++) {
    const s = await ds.getSettings({} as never);
    if ((s as unknown as Record<string, { version: number }>)[section]!.version > 1) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  return ds.getSettings({} as never);
}

describe('Settings: engine switches (W12-5)', () => {
  it('Sending ▸ Closing items for you: watch only by default; The new check saves resolutionEngine live at once', async () => {
    nav.section = 'sending';
    await mount();
    await waitFor(() => pick('closing-engine'));
    expect(labels('closing-engine')).toEqual(['Watch only (default)', 'The old closers', 'The new check']);
    expect(chosen('closing-engine')).toBe('Watch only (default)');
    await choose('closing-engine', 'live');
    const s = await savedAfter('closing');
    expect(patches('closing')).toEqual([{ resolutionEngine: 'live' }]);
    expect(s.closing!.resolutionEngine).toBe('live');
    await waitFor(() => chosen('closing-engine') === 'The new check');
  });

  it('Budgets ▸ Assistant model: Auto by default; Always Sonnet saves chat.routing at once', async () => {
    nav.section = 'budgets';
    await mount();
    await waitFor(() => pick('chat-routing'));
    expect(labels('chat-routing')).toEqual(['Auto', 'Always Haiku', 'Always Sonnet', 'Always Opus']);
    expect(chosen('chat-routing')).toBe('Auto');
    await choose('chat-routing', 'sonnet');
    const s = await savedAfter('chat');
    expect(patches('chat')).toEqual([{ routing: 'sonnet' }]);
    expect(s.chat.routing).toBe('sonnet');
    await waitFor(() => chosen('chat-routing') === 'Always Sonnet');
  });

  it('Budgets ▸ Ranking, beside it: preview by default; "make this my list" saves priority.engine v2 at once', async () => {
    nav.section = 'budgets';
    await mount();
    await waitFor(() => pick('priority-engine'));
    expect(labels('priority-engine')).toEqual(['v1 only', 'Preview v2 beside it (default)', 'v2: make this my list']);
    expect(chosen('priority-engine')).toBe('Preview v2 beside it (default)');
    // next to the Assistant model row, in one section
    expect($('[data-section="budgets-ranking"] [data-testid="chat-routing-row"]')).toBeTruthy();
    expect($('[data-section="budgets-ranking"] [data-testid="priority-engine-row"]')).toBeTruthy();
    await choose('priority-engine', 'v2');
    const s = await savedAfter('priority');
    expect(patches('priority')).toEqual([{ engine: 'v2' }]);
    expect(s.priority.engine).toBe('v2');
  });
});

describe("Health's Ranking line links to its Settings row (W12-5)", () => {
  it('Change in Settings opens Budgets at the Ranking row; the Resolution line points at Sending', async () => {
    const { PriorityLine } = await import('@/components/health/PriorityLine');
    const { RESOLUTION_SETTINGS_HREF } = await import('@/components/health/settings-links');
    await render(h(QueryClientProvider, { client: qc }, h(PriorityLine, { p: { engine: 'shadow', runs: 3, agreement3: 0.67, disagreements: [], line: 'Ranking: priority@2 in shadow', suggestion: null, appliedRules: 0 } })));
    expect($('[data-settings-link="priority-engine"]')!.getAttribute('href')).toBe('/settings?section=budgets#priority-engine');
    expect(RESOLUTION_SETTINGS_HREF).toBe('/settings?section=sending#closing-engine');
  });
});
