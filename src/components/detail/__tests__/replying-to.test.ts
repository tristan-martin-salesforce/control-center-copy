// @vitest-environment jsdom
/**
 * "Replying to" (GET /drafts/:id/source) in the draft panel and on Outbox rows, against the real mock DataSource
 * (placeholder seed) with fetch bridged in-process to the route handlers (the panel.test.ts harness). Checks the rich
 * Slack rendering, the email headers, Open in Slack / Gmail, the folded earlier messages, the DOMPurify gate and the
 * empty cases.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type DraftSource, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/outbox',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));

const { DraftPanel, ReplyingToView } = await import('@/components/detail');
const { OutboxRow } = await import('../../../../app/outbox/_outbox/OutboxRow');

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
const texts = (els: HTMLElement[]) => els.map((e) => e.textContent);

describe('the draft panel', () => {
  it('shows the Slack message rich, who / where / when, Open in Slack, and the earlier messages folded', async () => {
    const { container } = await mount(h(DraftPanel, { draftId: 'dr_dana' }));
    const block = await waitFor(() => $('[data-replying-to="reply"]', container));
    expect(block.dataset.kind).toBe('slack');
    expect(block.getAttribute('aria-label')).toBe('Replying to Dana Reyes in #acme-ext');
    expect($('header', block)!.textContent).toMatch(/^Replying to Dana Reyes in #acme-ext · .+Open in Slack$/);
    // above the composer
    const composer = await waitFor(() => $('[data-testid="composer"]', container));
    expect(block.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const link = $('[data-testid="open-source"]', block)!;
    expect(link.getAttribute('href')).toBe('https://example.slack.com/archives/C0ACME/p1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const body = $('[data-testid="source-body"]', block)!;
    expect($('strong', body)!.textContent).toBe('service-agent handoff');
    expect($('.cc-mention', body)!.textContent).toBe('@Raj Mehta');
    expect($('code', body)!.textContent).toBe('demo-env');
    expect(texts($$('li', body))).toEqual(['Agenda for 13:00', 'demo-env access for the whole team']);
    expect($('a', body)!.getAttribute('href')).toBe('https://example.com/acme/phase-2');
    expect(body.textContent).toContain(':eyes:');
    // the earlier messages fold under it
    expect($('[data-testid="earlier-messages"]', block)).toBeNull();
    const toggle = $('[data-testid="earlier-toggle"]', block)!;
    expect(toggle.textContent).toContain('Show 2 earlier messages');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    const earlier = await waitFor(() => $('[data-testid="earlier-messages"]', block));
    expect(texts($$('li > p > span', earlier))).toEqual(['Dana Reyes', 'You']);
    expect($('strong', earlier)!.textContent).toBe('Phase 2');
  });

  it('an email shows subject and sender, the body as text, and Open in Gmail', async () => {
    const { container } = await mount(h(DraftPanel, { draftId: 'dr_nudge_globex' }));
    const block = await waitFor(() => $('[data-replying-to][data-kind="gmail"]', container));
    expect(block.getAttribute('aria-label')).toBe('Replying to you');
    expect($('[data-testid="email-headers"]', block)!.textContent).toBe('SubjectDPA redlinesFromYou');
    expect($('[data-testid="open-source"]', block)!.textContent).toBe('Open in Gmail');
    const paras = texts($$('[data-testid="source-body"] p', block));
    expect(paras[0]).toBe('Hi Marcus,');
    expect(paras).toContain('Could legal confirm by Friday?');
  });
});

describe('ReplyingToView', () => {
  const base: DraftSource = { draftId: 'dr_x', kind: 'slack', relation: 'reply', where: '#acme-ext', url: 'https://example.slack.com/archives/C0ACME/p1', message: null, earlier: [], earlierTotal: 0 };

  it('DOMPurify is the last gate: a hostile html field never reaches the DOM as markup; a purged body says so', async () => {
    const message = { id: 'm1', author: 'Dana Reyes', isMe: false, at: '2026-11-05T09:00:00.000Z', html: '<p onclick="x()">Hi</p><img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script><a href="javascript:alert(1)">x</a>', text: 'Hi', body: 'purged' as const, url: null, subject: null, from: null, to: null };
    const { container } = await mount(h(ReplyingToView, { source: { ...base, message } }));
    const body = $('[data-testid="source-body"]', container)!;
    expect(body.querySelector('script, img, [onclick], [onerror]')).toBeNull();
    expect(body.innerHTML).not.toContain('javascript:');
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect($('[data-testid="source-purged"]', container)!.textContent).toContain('cleared after 90 days');
  });

  it('with no message but a link: says so and links; with neither, or for an admin item: nothing', async () => {
    const a = await mount(h(ReplyingToView, { source: base }));
    expect(a.container.textContent).toContain('The message itself is not stored here. Open it in Slack to read it.');
    expect($('[data-testid="open-source"]', a.container)!.getAttribute('href')).toBe(base.url);
    const b = await mount(h(ReplyingToView, { source: { ...base, url: null } }));
    expect(b.container.innerHTML).toBe('');
    const c = await mount(h(ReplyingToView, { source: { ...base, kind: null } }));
    expect(c.container.innerHTML).toBe('');
  });
});

describe('Outbox rows', () => {
  it('a row with a source shows Open in Gmail (the row link, o); its preview holds the block; a bare row has neither', async () => {
    const outbox = await ds.getOutbox({} as never);
    const item = outbox.groups.flatMap((g) => g.items).find((i) => i.draft.id === 'dr_nudge_globex')!;
    const noop = () => {};
    const props = { dryRun: true, now: '2026-11-05T15:00:00.000Z', flow: { phase: 'idle' as const }, busy: false, rowProps: {}, selected: false, emphasis: false, inPanel: false, onApprove: noop, onReject: noop, onEdit: noop, onOpen: noop, onExpand: noop, onRetryFlow: noop, onDismissFlow: noop };
    const { container } = await mount(h(OutboxRow, { ...props, item, expanded: true }));
    const link = $('[data-testid="row-source-link"]', container)!;
    expect(link.textContent).toBe('Open in Gmail');
    expect(link.getAttribute('href')).toBe('https://mail.example.com/#inbox/globex1');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('title')).toBe('Open in Gmail (o)'); // ActionRow's source: the row's own link, o follows it
    await waitFor(() => $('[data-testid="row-expansion"] [data-replying-to][data-kind="gmail"]', container));
    const bare = { ...item, draft: { ...item.draft, id: 'dr_bare' }, source: null };
    const r2 = await mount(h(OutboxRow, { ...props, item: bare, expanded: false }));
    expect($('[data-testid="row-source-link"]', r2.container)).toBeNull();
    expect($('[data-testid="row-source"]', r2.container)).toBeNull();
  });
});
