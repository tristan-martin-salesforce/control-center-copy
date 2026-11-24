// @vitest-environment jsdom
/**
 * SEC-8: Settings ▸ Budgets ▸ What the Assistant remembers lists every preference and pinned note with the message it
 * came from (thread title and date, plain words) and a Forget that takes a second click and calls
 * POST /chat/memory/:id/delete (mock DataSource, real handlers). An unpinned thread note stays out of the list.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { AssistantMemoryBlock } from '@/components/settings/AssistantMemory';

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let calls: Array<{ method: string; path: string }>;

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
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: `${url.pathname}${url.search}` });
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

const mount = () => render(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }) }, h(AssistantMemoryBlock)));

describe('Settings ▸ What the Assistant remembers (SEC-8)', () => {
  it('lists preferences and pinned notes with their source message; Forget takes a second click and removes it', async () => {
    const threads = (await ds.listChatThreads({} as never)).threads;
    const hooli = threads.find((t) => t.title === 'Hooli NCE scoping')!;
    const pref = await ds.chatMemory.add({ threadId: null, kind: 'preference', text: 'Globex pricing comes first', pinned: true });
    const pinned = await ds.chatMemory.add({ threadId: hooli.id, kind: 'note', text: 'Retrieval layer is on pgvector', pinned: true });
    await ds.chatMemory.add({ threadId: hooli.id, kind: 'note', text: 'An unpinned scratch note', pinned: false });

    await mount();
    await waitFor(() => $$('[data-memory]').length === 2 || null);
    expect(calls.some((c) => c.method === 'GET' && c.path.includes('/chat/memory?scope=pinned'))).toBe(true);
    expect(document.body.textContent).not.toContain('An unpinned scratch note');

    const p = $(`[data-memory="${pref.id}"]`)!;
    expect(p.querySelector('[data-memory-text]')!.textContent).toBe('Globex pricing comes first');
    expect(p.querySelector('[data-memory-source]')!.textContent).toMatch(/^Every thread · from your message in “Today”, Nov \d+, \d\d:\d\d$/);
    expect(p.textContent).toContain('Globex pricing is more urgent than the one-pager.');
    const n = $(`[data-memory="${pinned.id}"]`)!;
    expect(n.querySelector('[data-memory-source]')!.textContent).toMatch(/^Pinned in its thread · from your message in “Hooli NCE scoping”, Nov \d+, \d\d:\d\d$/);

    const forget = () => p.querySelector<HTMLElement>('[data-memory-forget]')!;
    await click(forget());
    expect(forget().textContent).toBe('Forget for good');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await click(forget());
    await waitFor(() => (!$(`[data-memory="${pref.id}"]`) ? true : null));
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith(`/chat/memory/${pref.id}/delete`))).toBe(true);
    expect((await ds.chatMemory.list(null)).map((e) => e.id)).not.toContain(pref.id);
    expect($(`[data-memory="${pinned.id}"]`)).not.toBeNull();
  });

  it('nothing kept: says so', async () => {
    await mount();
    await waitFor(() => $('[data-memory-empty]'));
    expect($('[data-memory-empty]')!.textContent).toMatch(/Nothing kept/);
  });
});
