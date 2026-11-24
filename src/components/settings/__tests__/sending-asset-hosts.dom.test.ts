// @vitest-environment jsdom
/**
 * SEC-6 (D-60 amended 2026-11-21): Settings ▸ Sending shows VDP autopilot's trusted sites under the autopilot toggle,
 * in plain words, with an add/remove row; Save stores the list (normalised) through the real handlers on the mock.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams('section=sending'),
}));

const { SettingsPage } = await import('../SettingsPage');

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

const stored = () => (ds as unknown as { store: { settings(): { sending: { autopilotAssetHosts: string[] } } } }).store.settings().sending.autopilotAssetHosts;

describe('Settings ▸ Sending: trusted sites for asset links', () => {
  it('lists the default sites under the autopilot toggle in plain words; add and remove, then Save stores them', async () => {
    await render(h(QueryClientProvider, { client: qc }, h(SettingsPage)));
    const row = await waitFor(() => $('[data-testid="sending-vdp-asset-hosts"]'));
    expect(row.textContent).toContain('Autopilot adds links only from these sites; anything else waits for you.');
    expect(row.textContent).toContain('docs.google.com');
    expect(row.textContent).toContain('salesforce.com');
    // it sits right under the autopilot toggle
    const rows = $$('[data-testid^="sending-"]').map((r) => r.getAttribute('data-testid'));
    expect(rows.indexOf('sending-vdp-asset-hosts')).toBe(rows.indexOf('sending-vdp-autopilot') + 1);

    const input = row.querySelector<HTMLInputElement>('input[aria-label="Add to Trusted sites"]')!;
    const add = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Add')!;
    await type(input, '1.2.3.4');
    expect(add.disabled).toBe(true); // not a site name
    await type(input, 'https://www.Loom.com/share/abc');
    await click(add);
    expect(row.textContent).toContain('www.loom.com');
    await click(row.querySelector('button[aria-label="Remove drive.google.com"]'));
    expect(row.textContent).not.toContain('drive.google.com');

    await click($('[data-testid="save-sending"]'));
    await waitFor(() => stored().includes('www.loom.com'));
    expect(stored()).not.toContain('drive.google.com');
    expect(stored()).toContain('docs.google.com');
  });
});
