// @vitest-environment jsdom
/**
 * SEC-10 on Today: Start in Claude (useTodayActions.launchClaude) prepares the session (POST /agents/launch, mock
 * DataSource, real handlers), then Review prompt shows the whole prompt and "runs with your permissions"; only its
 * Open in Claude opens the claude:// link. openClaude with a resume link opens at once; with a new-session link it is
 * reviewed first.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey, type WorkItem } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { useTodayActions, type TodayActions } from '@/components/today/useTodayActions';

let calls: Array<{ method: string; path: string }>;
let opened: string[];
let ds: ReturnType<typeof createMockDataSource>;

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
  calls = [];
  opened = [];
  (window as { __ccOpenExternal?: (u: string) => void }).__ccOpenExternal = (u) => opened.push(u);
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

let actions: TodayActions | null = null;
function Harness() {
  const a = useTodayActions();
  useEffect(() => {
    actions = a;
  });
  return h('div', null, a.launchDialog);
}
const mount = () => render(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, h(Harness)));
const openButton = () => $$('[role="alertdialog"] button').find((b) => b.textContent?.trim() === 'Open in Claude');

describe('Today ▸ Start in Claude (SEC-10)', () => {
  it('launchClaude prepares the session, shows Review prompt, and opens only on Open in Claude', async () => {
    const w: WorkItem = (await ds.getItem({ params: { id: 'w_acme_build' } } as never)).item;
    await mount();
    await act(async () => actions!.launchClaude(w, w.title));
    const whole = await waitFor(() => $('[data-launch-review] [data-prompt-whole]'));
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/agents/launch'))).toBe(true);
    expect(whole.textContent).toContain(`[cc:${w.id}]`);
    expect($('[data-launch-permissions]')!.textContent).toMatch(/runs it with your permissions/);
    expect(opened).toEqual([]);
    await click(openButton());
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^claude:\/\/code\/new\?/);
  });

  it('openClaude: a resume link opens at once; a new-session link is reviewed first', async () => {
    await mount();
    await act(async () => actions!.openClaude('claude://code/continue?session=local_3', 'Resume'));
    expect(opened).toEqual(['claude://code/continue?session=local_3']);
    await act(async () => actions!.openClaude('claude://code/new?folder=%2Ftmp&q=hello', 'New'));
    expect($('[data-launch-review] [data-prompt-whole]')!.textContent).toBe('hello');
    expect(opened).toHaveLength(1);
    await click(openButton());
    expect(opened[1]).toBe('claude://code/new?folder=%2Ftmp&q=hello');
  });
});
