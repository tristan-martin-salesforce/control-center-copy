// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 8: a release announcement staged with no channel (D-90) is not "Ready to apply" in the
 * Details panel. It says what to set (config/team.json, in words), its pill reads Set up first, and Apply is off;
 * the replying-to harness (the real mock DataSource, fetch bridged to the route handlers).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, cleanup, render, waitFor } from '../../composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/outbox',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));

const { DraftPanel } = await import('@/components/detail');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;

function matchRoute(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | null {
  for (const [key, def] of Object.entries(routes)) {
    if (def.method !== method || (def as { stream?: boolean }).stream) continue;
    const names = [...def.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]!);
    const re = new RegExp(`^${API_BASE}${def.path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    const m = re.exec(pathname);
    if (m) return { key: key as RouteKey, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
  }
  return null;
}

beforeEach(() => {
  resetDataSourceForTests();
  ds = createMockDataSource({ delays: { enrichMs: 40, reevalMs: 10, stepMs: 20, verifyMs: 20 }, autoplay: false });
  (globalThis as { __ccDataSource?: unknown }).__ccDataSource = ds;
  localStorage.clear();
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

const mount = (el: ReactElement) => render(h(QueryClientProvider, { client: qc }, el));

describe('Details panel: a release item that cannot go yet', () => {
  it('names what to set, says Set up first and keeps Apply off', async () => {
    delete process.env.CC_DISTRIBUTION_CHANNEL;
    delete process.env.CC_DISTRIBUTION_FOLDER;
    const sha = 'a'.repeat(64);
    const r = await fetch(`${API_BASE}/outbox/releases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '2.1.0', channel: 'stable', artifactName: 'cc-2.1.0.tgz', artifactPath: '/tmp/cc-2.1.0.tgz', feedPath: '/tmp/feed.json', installShPath: '/tmp/install.sh', sha256: sha, bytes: 1, notes: '- fixes' }) });
    const res = (await r.json()) as { entity: { drafts: Array<{ id: string }> } };
    const announce = res.entity.drafts[1]!;
    await mount(h(DraftPanel, { draftId: announce.id }));
    const line = await waitFor(() => $('[data-testid="release-missing-panel"]'));
    expect(line.textContent).toMatch(/^No announcement channel is set: add the channel’s id as distributionAnnounceChannel in config\/team\.json\.$/);
    expect(document.body.textContent).toContain('Set up first');
    expect(document.body.textContent).not.toContain('Ready to apply');
    const primary = await waitFor(() => $('[data-panel-primary]'));
    expect((primary as HTMLButtonElement).disabled).toBe(true);
  });
});
