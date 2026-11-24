// @vitest-environment jsdom
/**
 * Plain words on Activity (D-87; 01-ui-audit UI-6, R4): every view a seller sees (To log, its Week and Review page,
 * History, VDP and My VDPs) rendered against the mock DataSource, and every string on screen (text, tooltips, labels,
 * placeholders) checked against a small deny list of internal words. An SE knows Org62, VDP and Slackbot; they don't
 * know what a canvas, the attribution engine, a mapping rule or shadow mode is, and decision ids and API names never
 * show. The Forecast tab is the AE's and is not covered here.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { vdpReauthLabel } from '@/components/time/vdp-derive';
import { entryOf } from '@/errors/catalog';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/activity',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));
vi.mock('@/components/shell/router', async (orig) => ({ ...(await orig<typeof import('@/components/shell/router')>()), navigate: () => {} }));

const { TimePage } = await import('@/components/time/TimePage');

/** The words that must never reach an Activity screen. */
export const DENY: ReadonlyArray<[RegExp, string]> = [
  [/\bcanvas(es)?\b/i, 'canvas (say "batch")'],
  [/\battribution\b/i, 'attribution (say why the app picked it)'],
  [/\bmapping rules?\b/i, 'mapping rule (say "what the app learned")'],
  [/\bshadow\b/i, 'shadow'],
  [/\bread-?back\b/i, 'read-back (say "checked in Org62")'],
  [/\(D-\d+\)|\bD-\d{2,3}\b/, 'a decision id'],
  [/__c\b/, 'an API name'],
  [/\bWhatId\b/, 'an API name'],
];

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

/** Every string a reader meets: text nodes, tooltips, accessible names, placeholders. */
function strings(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) out.push(t);
  }
  for (const el of $$('[title],[aria-label],[placeholder]', root)) for (const a of ['title', 'aria-label', 'placeholder']) {
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

const VIEWS: Array<{ name: string; q: string; ready: string }> = [
  { name: 'To log', q: '', ready: '[data-guide="log-steps"] [data-ready-row]' },
  { name: 'To log ▸ Week', q: 'show=week', ready: '#time-rows [data-activity-id]' },
  { name: 'To log ▸ Review', q: 'review=1', ready: '[data-review-row]' },
  { name: 'History', q: 'view=history', ready: '[data-testid="ledger-rows"]' },
  { name: 'VDP', q: 'view=vdp', ready: '[data-testid="vdp-view"]' },
  { name: 'VDP ▸ My VDPs', q: 'view=vdp&sub=mine', ready: '[data-testid="vdp-view"]' },
];

describe('Activity in plain words', () => {
  for (const v of VIEWS)
    it(`${v.name}: no internal words on screen`, { timeout: 20_000 }, async () => {
      search = v.q;
      const { container } = await render(h(QueryClientProvider, { client: qc }, h(TimePage)));
      await waitFor(() => $(v.ready, container), 8000);
      // let the slower sections (use cases, DC suggestions, runs) land too
      await new Promise((r) => setTimeout(r, 150));
      expect(offending(container)).toEqual([]);
    });

  // C5: lane 2's own copy: grouped by account, the unsure row's likely opps, and the result line after "Log N · h"
  it('To log ▸ Ready to log lane: by account, a row being edited, and the result line', { timeout: 20_000 }, async () => {
    search = '';
    const { container } = await render(h(QueryClientProvider, { client: qc }, h(TimePage)));
    const lane = await waitFor(() => $('#time-ready [data-testid="ready-lane"] [data-review-row]', container) && $('#time-ready [data-testid="ready-lane"]', container), 8000);
    await click($$('[role="radiogroup"][aria-label="Group by"] [role="radio"]', lane).find((b) => b.textContent === 'Account')!);
    await click($('[data-slot="where"]', $('[data-review-row]', lane)!)!);
    await new Promise((r) => setTimeout(r, 150));
    expect(offending(container)).toEqual([]);
    await click($('#lane-ready [data-testid="review-log"]', container)!);
    await waitFor(() => $('#time-ready [data-testid="review-result"]', container), 8000);
    expect(offending(container)).toEqual([]);
  });

  it('To log ▸ Sending (lane 3, C6): a batch line, its steps and not-found rows say batch and checked in Org62', { timeout: 20_000 }, async () => {
    await ds.stageLogBatch({ body: {} } as never);
    search = '';
    const { container } = await render(h(QueryClientProvider, { client: qc }, h(TimePage)));
    const lane = await waitFor(() => $('[data-testid="sending-lane"] [data-testid="sending-batch"]', container)?.closest<HTMLElement>('[data-testid="sending-lane"]') ?? null, 8000);
    expect(lane.textContent).toMatch(/Batch \d{1,2} [A-Z][a-z]{2}/);
    // R2-10: the row says the short reason; the full sentence is its title
    expect(lane.textContent).toContain('Not found in Org62');
    expect(lane.querySelector('[data-slot="where"][title="Not found in Org62 after the batch ran"]')).not.toBeNull();
    expect(offending(lane)).toEqual([]);
  });

  it('the deny list catches what it should (and lets plain words through)', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>On a canvas waiting for Apply</p><span title="verified by read-back">x</span><b>Use_Case__c</b><i>(D-63)</i><p>Logged as one batch, checked in Org62</p>';
    expect(offending(el)).toHaveLength(4);
  });

  it('To log ▸ Fix or approve (lane 1): its groups, bar and verbs in plain words', { timeout: 20_000 }, async () => {
    search = '';
    const { container } = await render(h(QueryClientProvider, { client: qc }, h(TimePage)));
    const lane = await waitFor(() => $('#time-needs [data-fix-row]', container) && $('#lane-fix', container), 8000);
    await waitFor(() => $('#time-internal', lane));
    expect(lane.textContent).toContain('Fix or approve');
    expect(lane.textContent).toContain('Suggested: Internal');
    expect(offending(lane)).toEqual([]);
  });

  it('C7: the lane is "Sending": no To log copy (toasts included) names the retired "On its way to Org62" section', () => {
    for (const f of ['Q4Log.tsx', 'ToLogView.tsx', 'ReadyLane.tsx', 'SendingLane.tsx', 'use-ready-log.ts']) {
      const src = readFileSync(join(process.cwd(), 'src/components/time', f), 'utf8');
      expect(src, f).not.toMatch(/(under|▸) On its way to Org62/);
    }
    expect(readFileSync(join(process.cwd(), 'src/components/time/Q4Log.tsx'), 'utf8')).toContain('It is under Sending');
  });

  it('the VDP re-auth button reads the error catalog’s action words', () => {
    expect(vdpReauthLabel()).toBe(entryOf('AUTH.VDP.COOKIE_EXPIRED').action!.label);
  });
});
