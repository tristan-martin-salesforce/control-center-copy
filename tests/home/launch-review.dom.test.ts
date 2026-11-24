// @vitest-environment jsdom
/**
 * SEC-10 on Home: a card's Open in Claude and Coming builds prepare the session (POST /agents/launch, against the
 * mock DataSource and the real handlers) and then show Review prompt: the whole prompt and "runs with your
 * permissions". Only its Open in Claude click opens the claude:// link. A build with a resume link opens on its click.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type HomeBuild, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { ComingBuilds } from '@/components/home/Briefing';
import { useHomeActions } from '@/components/home/useHomeActions';
import seed from '@/mock/seed.example.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

let calls: Array<{ method: string; path: string }>;
let opened: string[];

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
  (globalThis as { __ccDataSource?: unknown }).__ccDataSource = createMockDataSource({ delays: { enrichMs: 5, reevalMs: 5, stepMs: 5, verifyMs: 5 }, autoplay: false });
  calls = [];
  opened = [];
  (window as { __ccOpenExternal?: (u: string) => void }).__ccOpenExternal = (u) => opened.push(u);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname });
    const m = matchRoute(method, url.pathname);
    if (!m) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  await cleanup();
  delete (window as { __ccOpenExternal?: unknown }).__ccOpenExternal;
  vi.unstubAllGlobals();
  resetDataSourceForTests();
});

function Harness({ builds }: { builds: HomeBuild[] }): ReactNode {
  const actions = useHomeActions();
  return h('div', null, h(ComingBuilds, { builds, actions }), actions.launchDialog);
}
const mount = (builds: HomeBuild[]) => render(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, h(Harness, { builds })));

const item = (seed as { workItems: Array<{ id: string; title: string; state: string }> }).workItems.find((w) => w.state === 'open')!;
const build = (over: Partial<HomeBuild>): HomeBuild => ({ id: 'b1', title: 'Demo-org build', state: 'queued', etaLabel: 'Queued', eta: null, progressLabel: null, workItemId: null, deepLink: null, ...over });
const openButton = () => $$('[role="alertdialog"] button').find((b) => b.textContent?.trim() === 'Open in Claude');

describe('Home ▸ Open in Claude (SEC-10)', () => {
  it('a build with no session yet: Review prompt prepares it, shows the whole prompt, and opens only on Open in Claude', async () => {
    await mount([build({ workItemId: item.id, title: item.title })]);
    const verb = $('[data-build-open]')!;
    expect(verb.textContent).toBe('Review prompt');
    await click(verb);
    const whole = await waitFor(() => $('[data-prompt-whole]'));
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/agents/launch'))).toBe(true);
    expect(whole.textContent).toContain(`[cc:${item.id}]`);
    expect($('[data-launch-permissions]')!.textContent).toMatch(/runs it with your permissions/);
    expect(opened).toEqual([]);
    await click(openButton());
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^claude:\/\/code\/new\?/);
  });

  it('a build carrying a prepared prompt is reviewed first; a resume link opens on its click', async () => {
    const q = 'Build the demo org.\nThen load the profiles.';
    await mount([build({ id: 'b1', deepLink: `claude://code/new?folder=%2Ftmp&q=${encodeURIComponent(q)}` }), build({ id: 'b2', state: 'running', deepLink: 'claude://code/continue?session=local_2' })]);
    const [first, second] = $$('[data-build-open]');
    expect(first!.textContent).toBe('Review prompt');
    expect(second!.textContent).toBe('Open in Claude');
    await click(second);
    expect(opened).toEqual(['claude://code/continue?session=local_2']);
    await click(first);
    expect((await waitFor(() => $('[data-prompt-whole]'))).textContent).toBe(q);
    expect(opened).toHaveLength(1);
    await click(openButton());
    expect(opened[1]).toMatch(/^claude:\/\/code\/new\?/);
  });
});
