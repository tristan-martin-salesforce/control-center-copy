// @vitest-environment jsdom
/**
 * P2 integration: ItemDetail and InitiativePage against the real mock DataSource (placeholder seed),
 * with fetch bridged in-process to the generated route handlers. Covers autosave + ifVersion, the
 * ?fail=1 rollback, seen-on-view, Done → Undo from History, hand-off via the ResolvePicker, the Drive
 * panel, capture enrichment chips, and the initiative's sheet.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '../../src/components/composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/work/test',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));

const { ItemDetail, InitiativePage } = await import('@/components/detail');
const { resetChipDecisions } = await import('@/components/detail/lib/enrichment-store');
const { syncServerNow } = await import('@/ui/clock');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let calls: Array<{ method: string; path: string; body: unknown }>;
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
  calls = [];
  localStorage.clear();
  resetChipDecisions();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = matchRoute(method, url.pathname);
    calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!m) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
  resetDataSourceForTests();
});

const mount = (el: ReactElement) => render(h(QueryClientProvider, { client: qc }, el));
const item = async (id: string) => (await ds.getItem({ params: { id } } as never)).item;

/** Type into a React-controlled input (native setter + input event). */
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const { act } = await import('react');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function blur(el: HTMLElement) {
  const { act } = await import('react');
  await act(async () => {
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}
const tab = (label: string) => $$('[role="tab"]').find((t) => t.textContent?.startsWith(label))!;

describe('ItemDetail (page)', () => {
  it('renders the record header, the NBA composer and the tabs', async () => {
    const { container } = await mount(h(ItemDetail, { itemId: 'w_dana_reply', variant: 'page' }));
    await waitFor(() => $('[data-item-header="page"]', container));
    const title = $('input[data-field="title"]', container) as HTMLInputElement;
    expect(title.value).toBe((await item('w_dana_reply')).title);
    await waitFor(() => $('[data-testid="composer"]', container));
    expect($('[data-nba-section="send"]', container)).not.toBeNull();
    expect(tab('Context').getAttribute('aria-selected')).toBe('true');
    expect($('[data-context-tab]', container)).not.toBeNull();
  });

  it('autosaves the title with ifVersion and locks the field', async () => {
    const before = await item('w_dana_reply');
    const { container } = await mount(h(ItemDetail, { itemId: 'w_dana_reply', variant: 'page' }));
    const title = (await waitFor(() => $('input[data-field="title"]', container))) as HTMLInputElement;
    await typeInto(title, 'Reply to Dana: confirm scope + pricing');
    await blur(title);
    await waitFor(() => calls.find((c) => c.method === 'PATCH' && c.path.startsWith('/api/v1/items/w_dana_reply')));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ ifVersion: before.version, patch: { title: 'Reply to Dana: confirm scope + pricing' } });
    await waitFor(async () => (await item('w_dana_reply')).title === 'Reply to Dana: confirm scope + pricing');
    expect((await item('w_dana_reply')).userLockedFields).toContain('title');
    await waitFor(() => $('[data-save-state="saved"]', container));
  });

  it('?fail=1 rolls the purpose back on the server and shows Couldn’t save · Retry · Revert', async () => {
    history.replaceState(null, '', '/work/w_dana_reply?fail=1');
    const before = await item('w_dana_reply');
    const { container } = await mount(h(ItemDetail, { itemId: 'w_dana_reply', variant: 'page' }));
    const purpose = (await waitFor(() => $('input[data-field="purpose"]', container))) as HTMLInputElement;
    await typeInto(purpose, 'Something else entirely');
    await blur(purpose);
    const status = await waitFor(() => $('[data-save-state="error"]', container));
    expect(status.textContent).toContain("Couldn't save");
    expect((await item('w_dana_reply')).purpose).toBe(before.purpose);
    expect(purpose.value).toBe('Something else entirely'); // typed text kept for Retry
    await click($$('button', status).find((b) => b.textContent === 'Revert'));
    await waitFor(() => purpose.value === (before.purpose ?? '').replace(/^For:\s*/i, ''));
  });

  it('a change made elsewhere while you type surfaces as Changed elsewhere: keep yours / take theirs', async () => {
    const id = 'w_dana_reply';
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'page' }));
    const title = (await waitFor(() => $('input[data-field="title"]', container))) as HTMLInputElement;
    await typeInto(title, 'Mine: confirm scope');
    // Meanwhile chat (or another window) renames it, and the live channel refreshes the view.
    const cur = await item(id);
    await ds.patchItem({ params: { id }, body: { ifVersion: cur.version, patch: { title: 'Theirs: confirm pricing' } } } as never);
    await qc.invalidateQueries();
    await waitFor(() => $('nav[aria-label="Breadcrumb"] [aria-current="page"]', container)?.textContent === 'Theirs: confirm pricing');
    expect(title.value).toBe('Mine: confirm scope'); // your text isn't replaced while you edit
    await blur(title);
    const banner = await waitFor(() => $$('[role="alert"]', container).find((el) => el.textContent?.includes('Changed elsewhere')));
    expect(banner.textContent).toContain('Mine: confirm scope');
    expect(banner.textContent).toContain('Theirs: confirm pricing');
    expect((await item(id)).title).toBe('Theirs: confirm pricing'); // nothing overwritten yet
    await click($$('button', banner).find((b) => b.textContent === 'Keep yours'));
    await waitFor(async () => (await item(id)).title === 'Mine: confirm scope');
    await waitFor(() => !$$('[role="alert"]', container).some((el) => el.textContent?.includes('Changed elsewhere')));
  });

  it('take theirs adopts the other value and clears the error', async () => {
    const id = 'w_dana_reply';
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'page' }));
    const purpose = (await waitFor(() => $('input[data-field="purpose"]', container))) as HTMLInputElement;
    await typeInto(purpose, 'My purpose');
    const cur = await item(id);
    await ds.patchItem({ params: { id }, body: { ifVersion: cur.version, patch: { purpose: 'Their purpose' } } } as never);
    await qc.invalidateQueries();
    await waitFor(() => qc.getQueriesData({ queryKey: ['item'] }).some(([, d]) => (d as { item?: { purpose?: string } } | undefined)?.item?.purpose === 'Their purpose'));
    await blur(purpose);
    const banner = await waitFor(() => $$('[role="alert"]', container).find((el) => el.textContent?.includes('Changed elsewhere')));
    await click($$('button', banner).find((b) => b.textContent === 'Take theirs'));
    await waitFor(() => purpose.value === 'Their purpose');
    expect((await item(id)).purpose).toBe('Their purpose');
    const fieldRoot = purpose.parentElement!.parentElement!; // TextField wrapper: input row + its InlineStatus
    await waitFor(() => $('[data-save-state]', fieldRoot)?.getAttribute('data-save-state') !== 'error');
  });

  it('marks evidence seen when the Evidence tab opens, keeping the New markers for this visit', async () => {
    const id = 'w_dana_reply';
    expect((await item(id)).newEvidenceCount).toBeGreaterThan(0);
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'page' }));
    await waitFor(() => $('[data-detail-tabs]', container));
    await click(tab('Evidence'));
    await waitFor(() => $('[data-evidence-groups]', container));
    await waitFor(() => calls.find((c) => c.method === 'POST' && c.path === `/api/v1/items/${id}/seen`));
    await waitFor(async () => (await item(id)).newEvidenceCount === 0);
    expect($$('[data-new]', container).length).toBeGreaterThan(0);
  });

  it('Done is instant, and History undoes it', async () => {
    const id = 'w_dana_reply';
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'page' }));
    await click(await waitFor(() => $('[data-testid="menu-done"]', container)));
    await click(await waitFor(() => $$('[role="menu"] [role^="menuitem"]').find((m) => m.textContent?.startsWith('Done by me'))));
    await waitFor(async () => (await item(id)).state === 'done');
    await click(tab('History'));
    const undoBtn = await waitFor(() => $$('[data-audit-id]', container).find((li) => li.textContent?.startsWith('You') && li.textContent.includes('Done:'))?.querySelector<HTMLButtonElement>('[data-undo]'));
    await click(undoBtn);
    await waitFor(async () => (await item(id)).state === 'open');
  });

  it('resolves as handed off through the ResolvePicker (R-UI-22)', async () => {
    const id = 'w_dana_reply';
    const { container } = await mount(h(ItemDetail, { itemId: id, variant: 'page' }));
    // Done ▾ ▸ More ways it ended… opens the ResolvePicker (handed off, duplicate, superseded).
    await click(await waitFor(() => $('[data-testid="menu-done"]', container)));
    await click(await waitFor(() => $$('[role="menu"] [role^="menuitem"]').find((m) => m.textContent?.startsWith('More ways it ended'))));
    const picker = await waitFor(() => $('[role="dialog"][aria-label^="Resolve"]'));
    await click($$('[role="radio"]', picker).find((r) => r.textContent?.includes('Handed off')));
    const person = await waitFor(() => $('input[aria-label="Person"]', picker) as HTMLInputElement);
    await typeInto(person, 'Raj');
    const pick = await waitFor(() => $$('li button', picker).find((b) => b.textContent?.includes('Raj')));
    await click(pick);
    await click($$('button', picker).find((b) => b.textContent?.startsWith('Resolve')));
    await waitFor(async () => (await item(id)).resolution === 'handed_off');
    const after = await item(id);
    expect(after.state).toBe('done');
    expect(after.involvement).toBe('watcher');
    expect(after.owner?.name).toContain('Raj');
  });

  it('Run tool renders the adapter form, runs explicitly, and reports progress', async () => {
    const { container } = await mount(h(ItemDetail, { itemId: 'w_globex_estimate', variant: 'sheet' }));
    const form = await waitFor(() => $('[data-tool-form]', container));
    for (const input of $$('input', form) as HTMLInputElement[]) if (!input.value) await typeInto(input, 'Globex');
    const run = await waitFor(() => $('button[data-nba-primary]:not([disabled])', form));
    await click(run);
    const call = await waitFor(() => calls.find((c) => c.method === 'POST' && c.path.startsWith('/api/v1/tools/')));
    expect(call.body).toMatchObject({ workItemId: 'w_globex_estimate', nbaId: expect.any(String) });
    await waitFor(() => $('[data-tool-run]', form), 4000);
  });

  it('Start in Claude shows the context pack, then Review prompt (SEC-10); only Open in Claude opens it', async () => {
    const opened: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      opened.push(this.href);
    };
    try {
      const { container } = await mount(h(ItemDetail, { itemId: 'w_acme_build', variant: 'sheet' }));
      const pack = await waitFor(() => $('[data-claude-launch]', container));
      expect(pack.textContent).toContain('Context pack');
      expect(opened).toEqual([]);
      // the item's live session resumes on its click (a continue link carries no prompt)
      await click(await waitFor(() => $('[data-nba-primary]', pack)));
      expect(opened).toEqual(['claude://code/continue?session=mock-acme-build']);
      // New session prepares one (POST /agents/launch) and shows Review prompt; only its Open in Claude opens it
      await click($$('button', pack).find((b) => b.textContent?.trim() === 'New session'));
      const whole = await waitFor(() => $('[data-launch-review] [data-prompt-whole]'));
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/agents/launch'))).toBe(true);
      expect(whole.textContent).toContain('[cc:w_acme_build]');
      expect($('[data-launch-permissions]')!.textContent).toMatch(/runs it with your permissions/);
      expect(opened).toHaveLength(1);
      await click($$('[role="alertdialog"] button').find((b) => b.textContent?.trim() === 'Open in Claude'));
      expect(opened).toHaveLength(2);
      expect(opened[1]).toMatch(/^claude:\/\/code\/new\?/);
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });

  it('shows the Drive panel and the requested-updates judgment for a deliverable (R-UI-15)', async () => {
    const { container } = await mount(h(ItemDetail, { itemId: 'w_acme_recap', variant: 'sheet' }));
    const panel = await waitFor(() => $('[data-drive-panel]', container));
    expect(panel.textContent).toContain('Requested updates made?');
    expect($('[data-judgment]', panel)?.getAttribute('data-judgment')).toMatch(/Yes|Partial|No|Unknown/);
  });

  it('shows enriching… on a fresh capture, then related-work chips you can accept', async () => {
    const res = await ds.captureItem({ body: { text: 'Talk to product about NCE gaps' } } as never);
    // The shell aligns the client clock with the server's (the mock's seed time); "enriching" is measured on it.
    syncServerNow(res.entity.enrichment!.startedAt);
    const { container } = await mount(h(ItemDetail, { itemId: res.entity.id, variant: 'sheet' }));
    await waitFor(() => $('[data-enrichment="enriching"]', container));
    await new Promise((r) => setTimeout(r, 120));
    await qc.invalidateQueries(); // what the live channel does on the enrichment event
    const chip = await waitFor(() => $('[data-chip-status="suggested"]', container), 4000);
    await click($('[data-chip-accept]', chip));
    await waitFor(() => $('[data-chip-status="accepted"]', container));
    expect(localStorage.getItem(`cc:enrich:${res.entity.id}`)).toContain('accepted');
    syncServerNow(new Date().toISOString());
  });
});

describe('InitiativePage', () => {
  it('groups child tasks by state and opens a task in the item sheet', async () => {
    const { container } = await mount(h(InitiativePage, { id: 'ini_acme_p2' }));
    await waitFor(() => $('[data-initiative-page]', container));
    const rows = await waitFor(() => ($$('[data-row][data-item-id]', container).length ? $$('[data-row][data-item-id]', container) : null));
    expect(rows.length).toBeGreaterThan(1);
    await click(rows[0]);
    await waitFor(() => $('[data-item-detail="sheet"] [data-item-header="sheet"]'));
  });
});
