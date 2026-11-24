// @vitest-environment jsdom
/**
 * Deals in plain words (18-ui-polish.md; the same rule as Activity, tests/ui/time-plain-words.test.ts): a DC request
 * "goes in your next batch", never "on your next logging canvas", and the missed-opp sweep is "looks like yours". Also:
 * no DC requests is one quiet line above a full-width Your DCs (01-ui-audit UI-20), and the account page's crumb names
 * the account, not its industry (UI-21). Rendered against the mock DataSource; placeholder seed only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, render, waitFor } from '@/components/composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/deals',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));
vi.mock('@/components/shell/router', async (orig) => ({ ...(await orig<typeof import('@/components/shell/router')>()), navigate: () => {} }));

const { DcView } = await import('@/components/deals/DcView');
const { MissedView } = await import('@/components/deals/MissedView');
const { AccountPage } = await import('@/components/deals/AccountPage');

const DENY: ReadonlyArray<[RegExp, string]> = [
  [/\bcanvas(es)?\b/i, 'canvas (say "batch")'],
  [/\bsweep says\b/i, 'the sweep says (say "looks like yours")'],
  [/\(D-\d+\)|\bD-\d{2,3}\b/, 'a decision id'],
  [/__c\b/, 'an API name'],
];

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;

function matchRoute(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | null {
  // static paths first, as Next routes them (/deals/dc-requests is not /deals/:accountId)
  const ordered = Object.entries(routes).sort(([, a], [, b]) => Number(a.path.includes(':')) - Number(b.path.includes(':')));
  for (const [key, def] of ordered) {
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
  ds = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, reevalMs: 1e8, stepMs: 1e8, verifyMs: 1e8 } });
  ds.resetStore();
  (globalThis as { __ccDataSource?: unknown }).__ccDataSource = ds;
  localStorage.clear();
  sessionStorage.clear();
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
  ds.dispose();
  resetDataSourceForTests();
});

function strings(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) out.push(t);
  }
  for (const el of $$('[title],[aria-label],[placeholder]', root))
    for (const a of ['title', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(a)?.trim();
      if (v) out.push(v);
    }
  return out;
}

function offending(root: HTMLElement): string[] {
  const bad: string[] = [];
  for (const s of strings(root)) for (const [re, why] of DENY) if (re.test(s)) bad.push(`${why}: “${s.slice(0, 140)}”`);
  return [...new Set(bad)];
}

const shown = (el: ReturnType<typeof h>) => render(h(QueryClientProvider, { client: qc }, el));

describe('Deals in plain words', () => {
  it('DCs: no requests is one quiet line, Your DCs gets the width, and no internal words', { timeout: 20_000 }, async () => {
    const { container } = await shown(h(DcView));
    await waitFor(() => $('[aria-label="Your DCs"]', container), 8000).catch((e) => {
      throw new Error(`${String(e)}: ${(container.textContent ?? '').slice(0, 400)}`);
    });
    // the placeholder seed has no DC requests: no empty Requests pane, one line instead
    expect($$('[aria-label="DC requests"]', container)).toHaveLength(0);
    expect($('[data-testid="dc-requests-empty"]', container)!.textContent).toContain('goes in your next batch');
    expect(offending(container)).toEqual([]);
  });

  it('Missed opportunities: no internal words', { timeout: 20_000 }, async () => {
    const { container } = await shown(h(MissedView));
    await waitFor(() => $('[aria-label="Missed opportunities"]', container), 8000);
    await new Promise((r) => setTimeout(r, 150));
    expect(offending(container)).toEqual([]);
  });

  it('the account page: the crumb names the account; no internal words', { timeout: 20_000 }, async () => {
    const deals = (await (await fetch(`${API_BASE}/deals`)).json()) as { accounts: Array<{ id: string; name: string }> };
    const acct = deals.accounts[0]!;
    const { container } = await shown(h(AccountPage, { accountId: acct.id }));
    await waitFor(() => (container.textContent ?? '').includes('Opportunities'), 8000);
    const head = container.textContent ?? '';
    expect(head).toContain(`Deals›${acct.name}`); // the crumb: Deals › the account (then its industry, quiet)
    expect(head).not.toContain('No industry set');
    expect(offending(container)).toEqual([]);
  });

  it('the deny list catches what it should', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>It goes on your next logging canvas.</p><p>1 opp the missed-opp sweep says is yours</p><p>It goes in your next batch.</p>';
    expect(offending(el)).toHaveLength(2);
  });
});
