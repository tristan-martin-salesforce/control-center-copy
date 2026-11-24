// @vitest-environment jsdom
/**
 * Activity ▸ To log ▸ Review (`?review=1`) against the real mock DataSource (the to-log-view.test.ts harness): one page
 * of checkbox rows, pre-ticked at the settle line; the keys (space ticks, j / k move, `a` logs); zero ticked rows turn
 * the button off and say why; a row whose opp changed since the page opened is unticked and named, and nothing is
 * staged until a second press; "Log these" stages ONE batch (an Outbox item waiting for Apply) and the result screen
 * says nothing was sent. The mock DataSource is the fake: no adapter is called, no draft is dispatched.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type ActivityEntry, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';

let search = 'review=1';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/activity',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));
const navigated: string[] = [];
vi.mock('@/components/shell/router', async (orig) => ({
  ...(await orig<typeof import('@/components/shell/router')>()),
  navigate: (href: string) => void navigated.push(href),
}));

const { TimePage } = await import('../TimePage');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;
const calls: string[] = [];

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
  search = 'review=1';
  navigated.length = 0;
  calls.length = 0;
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
    if (method !== 'GET') calls.push(m.key);
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  ds.dispose();
  resetDataSourceForTests();
});

const mount = () => render(h(QueryClientProvider, { client: qc }, h(TimePage)));
const key = async (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
const box = (row: Element) => $('input[type="checkbox"]', row as HTMLElement) as HTMLInputElement;
const logBtn = (page: HTMLElement) => $('[data-testid="review-log"]', page) as HTMLButtonElement;

describe('Activity ▸ To log ▸ Review', () => {
  it('checkbox rows by day, pre-ticked at the settle line; zero ticked turns the button off with why; space, j, k', async () => {
    const { container } = await mount();
    const page = await waitFor(() => $('[data-testid="log-review"]', container));
    await waitFor(() => $$('[data-review-row]', page).length > 1);
    const rows = $$('[data-review-row]', page);
    // ready rows the app is sure of are ticked; an unsure row is not, and shows the likely opps inline
    expect(rows.some((r) => box(r).checked)).toBe(true);
    for (const r of rows.filter((x) => x.dataset.kind === 'unsure')) expect(box(r).checked).toBe(false);
    // the unsure row's where cell opens its likely opps inline (pickers only on the row being edited)
    const unsure = rows.find((x) => x.dataset.kind === 'unsure');
    if (unsure) {
      expect($('[data-testid="opp-rundown"]', unsure)).toBeNull();
      await click($('[data-slot="where"]', unsure)!);
      await waitFor(() => $('[data-slot="editor"]', unsure));
    }
    const log = logBtn(page);
    expect(log.disabled).toBe(false);
    // F3: on the Review page the extras are open and ticked; the header counts them by name, and so does the button
    const ucs = $('[data-testid="ready-use-cases"]', page);
    const nUc = ucs ? $$('[data-review-row]', ucs).length : 0;
    if (ucs) {
      expect($$('[data-review-row]', ucs).every((r) => box(r).checked)).toBe(true);
      expect($('[data-testid="group-toggle"]', ucs)).toBeNull();
    }
    // C11: every kind by name, DCs between the time rows and the use cases
    expect($('[data-testid="ready-count"]', page)?.textContent).toMatch(new RegExp(`^\\d+ rows? · [\\d.]+ h( · \\d+ DCs?)?${nUc ? ` · ${nUc} use cases?` : ''}`));
    expect(log.textContent).toMatch(nUc ? new RegExp(`^Log \\d+ rows?( · \\d+ DCs?)? · ${nUc} use cases?`) : /^Log \d+ rows?( · [\d.]+ h| · \d+ DCs?)$/);

    // untick everything: the button is off and says why
    for (const r of $$('[data-review-row]', page)) if (box(r).checked) await click(box(r));
    await waitFor(() => logBtn(page).disabled);
    expect($('[data-testid="review-why"]', page)?.textContent).toBe('Tick at least one row to log. Nothing is logged until you do.');
    // `a` with nothing ticked does nothing
    await key(page, 'a');
    expect(calls).not.toContain('stageLogBatch');

    // keys: focus a ready row, space ticks it, j moves to the next row
    const first = $$('[data-review-row]', page).find((r) => r.dataset.kind === 'ready')!;
    (first as HTMLElement).focus();
    await key(first, ' ');
    await waitFor(() => box(first).checked);
    await key(first, 'j');
    expect(document.activeElement).toBe($$('[data-review-row]', page)[$$('[data-review-row]', page).indexOf(first) + 1] ?? first);
    expect(logBtn(page).disabled).toBe(false);
  });

  it('Log these: stages one batch for your Apply and says nothing was sent', async () => {
    const before = new Set(ds.store.all('drafts').map((d) => d.id));
    const { container } = await mount();
    const page = await waitFor(() => $('[data-testid="log-review"]', container));
    await waitFor(() => $$('[data-review-row]', page).some((r) => box(r).checked));
    const ticked = $$('[data-review-row]', page).filter((r) => r.dataset.kind !== 'useCase' && r.dataset.kind !== 'update' && r.dataset.kind !== 'dc' && box(r).checked).map((r) => r.dataset.reviewRow!);
    await key(page, 'a');
    const result = await waitFor(() => $('[data-testid="review-result"]', container));
    expect(result.textContent).toMatch(/Staged (one batch|\d+ batches): \d+ rows? · [\d.]+ h/);
    expect(calls.filter((c) => c === 'stageLogBatch')).toHaveLength(1);
    expect(result.textContent).toContain('Nothing was sent.');
    expect(calls).toContain('stageLogBatch');
    expect(calls).not.toContain('dispatchDraft');
    // the new Outbox item waits for Apply; the ticked rows are on it, never sent
    const fresh = ds.store.all('drafts').filter((d) => !before.has(d.id));
    expect(fresh.length).toBeGreaterThan(0);
    for (const d of fresh) expect(d.status).not.toBe('sent');
    for (const id of ticked) expect(['approved', 'synced_to_canvas']).toContain(ds.store.get('activity', id)?.status);
    await click($('[data-testid="review-back"]', result));
    expect(navigated.at(-1)).toBe('/activity');
  });

  it('an opp that changed since the page opened: unticked and named, nothing staged until you press again', async () => {
    const { container } = await mount();
    const page = await waitFor(() => $('[data-testid="log-review"]', container));
    await waitFor(() => $$('[data-review-row]', page).some((r) => r.dataset.kind === 'ready' && box(r).checked));
    const row = $$('[data-review-row]', page).find((r) => r.dataset.kind === 'ready' && box(r).checked)!;
    const id = row.dataset.reviewRow!;
    // elsewhere (another tab, the Assistant), the row moves to another opp
    const other = ds.store.all('opps').find((o) => o.id !== ds.store.get('activity', id)?.oppId)!;
    const was = ds.store.get('activity', id)!;
    ds.store._set('activity', { ...was, oppId: other.id, oppName: other.name, version: was.version + 1 });
    await click($('[data-testid="review-log"]', page));
    const notice = await waitFor(() => $('[data-testid="review-notice"]', page));
    expect(notice.textContent).toMatch(/^1 row changed since you opened this page: .* now goes to /);
    expect(notice.textContent).toContain('check, then press Log again');
    expect(calls).not.toContain('stageLogBatch');
    expect(box($(`[data-review-row="${id}"]`, page)!).checked).toBe(false);
    // the second press logs what is ticked now
    await click($('[data-testid="review-log"]', page));
    await waitFor(() => $('[data-testid="review-result"]', container));
    expect(calls).toContain('stageLogBatch');
  });
});

// F5 (R2-6): Review is lane 2 at full width: the same header count as To log's lane header, only the unsure rows a pick
// ticks in place, and one link to lane 1 for the rest
describe('Activity ▸ To log ▸ Review is lane 2', () => {
  it('the header equals the lane header; no settled or no-suggestion rows; a link to Fix or approve for them', async () => {
    search = '';
    let { container } = await mount();
    const laneHead = () => $('#lane-ready h2 + span', container)?.textContent ?? '';
    await waitFor(() => $$('#time-ready [data-review-row]', container).length > 0 && /use case|Event change/.test(laneHead()) === !!$('#time-ready [data-testid="ready-use-cases"], #time-ready [data-testid="ready-updates"]', container) && laneHead());
    const lane = laneHead();
    expect(lane).toMatch(/^\d+ rows? · [\d.]+ h/);
    await cleanup();
    search = 'review=1';
    ({ container } = await mount());
    const page = await waitFor(() => $('[data-testid="log-review"]', container));
    await waitFor(() => $('[data-testid="ready-count"]', page)?.textContent === lane);
    const rows = $$('[data-review-row]', page);
    expect(rows.some((r) => r.dataset.kind === 'suggested')).toBe(false);
    // every unsure row has likely opps (the suggestions are the read's, not the store's)
    const log = (await (await fetch(`${API_BASE}/time/log?from=2000-01-01&to=2100-01-01`)).json()) as { entries: ActivityEntry[] };
    const byId = new Map(log.entries.map((e) => [e.id, e] as const));
    const unsure = rows.filter((x) => x.dataset.kind === 'unsure');
    for (const r of unsure) {
      const e = byId.get(r.dataset.reviewRow!);
      expect(!!e?.suggestion || !!e?.suggestions?.length).toBe(true);
    }
    const more = $('[data-testid="review-fix-more"]', container);
    if (more) {
      expect(more.textContent).toMatch(/^\d+ more rows? (needs|need) an opp first ▸ Fix or approve$/);
      expect($('a', more)?.getAttribute('href')).toBe('/activity#time-needs');
    }
  });
});

// 29-persona-qa (D-55): the likely opps under an unsure row name whose opp it is in the role's words; a Specialist AE,
// whose role has no deal contributions, never reads "your DC" (an opp in the book reads "yours")
// C5: the same lane on To log (#time-ready), with the compact row: ticked by default, one "Log N · h", the result line
describe('Activity ▸ To log ▸ Ready to log lane', () => {
  it('ticked by default; Log N · h stages ONE batch via the fake and shows the result line; Back returns to the lane', async () => {
    search = '';
    const before = new Set(ds.store.all('drafts').map((d) => d.id));
    const { container } = await mount();
    const lane = await waitFor(() => $('#time-ready [data-testid="ready-lane"]', container));
    await waitFor(() => $$('[data-review-row]', lane).some((r) => box(r).checked));
    const rows = $$('[data-review-row]', lane).filter((r) => r.dataset.kind === 'ready');
    expect(rows.length).toBeGreaterThan(0);
    // grouped by day by default: each day a group header with its count; the rows' ticks are on the lane itself
    expect($$('[data-ready-day]', lane).length).toBeGreaterThan(0);
    // C7: the one "Log N · h" is in the lane's LanePage header; R3-5: the ticked line beside it, per kind
    const btn = logBtn($('#lane-ready', container)!);
    expect($('[data-testid="review-summary"]', lane)).toBeNull();
    const tickedText = $('#lane-ready [data-testid="review-summary"]', container)?.textContent ?? '';
    expect(tickedText).toMatch(/^(\d+ of )?\d+ rows? · [\d.]+ h( · .+)? ticked$/);
    expect(tickedText).toMatch(/0 of \d+ use cases?/);
    expect(btn.textContent).toMatch(/^Log \d+/);
    await click(btn);
    const result = await waitFor(() => $('#time-ready [data-testid="review-result"]', container));
    expect(result.textContent).toMatch(/^Staged one batch: \d+ rows? · [\d.]+ h/);
    expect(result.textContent).toContain('Nothing was sent.');
    expect($('[data-testid="review-open-batch"]', result)?.textContent).toBe('Review & apply');
    expect(calls.filter((c) => c === 'stageLogBatch')).toHaveLength(1);
    expect(calls).not.toContain('dispatchDraft');
    expect(ds.store.all('drafts').filter((d) => !before.has(d.id)).length).toBe(1);
    await click($('[data-testid="review-back"]', result));
    await waitFor(() => $('#time-ready [data-testid="ready-lane"]', container));
    expect(navigated).toHaveLength(0);
  });

  it('C11: one lane for Org62: time rows, DCs to claim, use cases, Events, each a group with its count and tick; Log names each kind and stages one batch', async () => {
    search = '';
    const { container } = await mount();
    const lane = await waitFor(() => $('#time-ready [data-testid="ready-lane"]', container));
    const dcs = await waitFor(() => $('[data-testid="ready-dcs"]', lane));
    const ucs = await waitFor(() => $('[data-testid="ready-use-cases"]', lane));
    // the groups in order: the time rows by day, then DCs, use cases, Events in Org62; the old anchors land on them
    const kinds = $$('[data-ready-kind]', lane).map((g) => g.dataset.readyKind);
    expect(kinds.slice(0, 2)).toEqual(['dc', 'useCase']);
    expect(dcs.id).toBe('time-dcs');
    expect(ucs.id).toBe('time-usecases');
    const lastDay = $$('[data-ready-day]', lane).at(-1)!;
    expect(lastDay.compareDocumentPosition(dcs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // R3-2: the use cases start as a header line on To log; opened, their first 8 are seen and ticked (a DC only on
    // strong evidence), the header names every kind
    expect($$('[data-review-row]', ucs)).toHaveLength(0);
    await click($('[data-testid="group-toggle"]', ucs)!);
    await waitFor(() => $$('[data-review-row]', ucs).length > 0 && $$('[data-review-row]', ucs).every((r) => box(r).checked));
    expect($$('[data-review-row]', ucs).length).toBeLessThanOrEqual(8);
    const dcRows = $$('[data-review-row]', dcs);
    expect(dcRows.length).toBeGreaterThan(0);
    expect($$('[data-testid="dc-accept"]', dcs).length).toBeGreaterThan(0);
    const head = $('#lane-ready h2 + span', container)?.textContent ?? '';
    expect(head).toMatch(new RegExp(`^\\d+ rows? · [\\d.]+ h · ${dcRows.length} DCs? · \\d+ use cases?`));
    const btn = () => logBtn($('#lane-ready', container)!);
    // tick every DC: the button says exactly what it stages
    const dcHead = $('[data-density="group"] input[type="checkbox"]', dcs) as HTMLInputElement | null;
    if (dcHead && !dcHead.checked) await click(dcHead);
    const tickedDcs = () => $$('[data-review-row]', dcs).filter((r) => box(r).checked).length;
    await waitFor(() => tickedDcs() > 0);
    const nUc = $$('[data-review-row]', ucs).filter((r) => box(r).checked).length;
    await waitFor(() => new RegExp(`^Log \\d+ rows? · ${tickedDcs()} DCs? · ${nUc} use cases?`).test(btn().textContent ?? ''));
    // fold the use cases and reopen: the ticks I set stick (F3 per group)
    const first = $$('[data-review-row]', ucs)[0]!;
    await click(box(first));
    await click($('[data-testid="group-toggle"]', ucs)!);
    expect($$('[data-review-row]', ucs)).toHaveLength(0);
    await click($('[data-testid="group-toggle"]', ucs)!);
    await waitFor(() => $$('[data-review-row]', ucs).length > 0);
    expect(box($$('[data-review-row]', ucs)[0]!).checked).toBe(false);
    // one batch: the ticked DCs are claimed (each a DC request that rides it), then ONE stage; nothing is sent
    const claim = tickedDcs();
    await click(btn());
    await waitFor(() => $('#time-ready [data-testid="review-result"]', container));
    expect(calls.filter((c) => c === 'decideDcSuggestion')).toHaveLength(claim);
    expect(calls.filter((c) => c === 'stageLogBatch')).toHaveLength(1);
    expect(calls.lastIndexOf('decideDcSuggestion')).toBeLessThan(calls.indexOf('stageLogBatch'));
    expect(calls).not.toContain('dispatchDraft');
  });

  it('R3-7: a DC row shows who else is on the deal where Accept happens; its where cell opens the details under it', async () => {
    search = '';
    const { container } = await mount();
    const dcs = await waitFor(() => $('#time-ready [data-testid="ready-dcs"]', container));
    const withContext = await waitFor(() => $$('[data-review-row]', dcs).find((r) => $('[data-context]', r)));
    const chips = $$('[data-context]', withContext).map((c) => c.textContent ?? '');
    expect(chips.some((t) => /^(\d+ Data & AI DCs?: .+|via .+’s forecast|via opp team) · $/.test(t))).toBe(true);
    // the coverage is said once, never "AE you cover" (R3-6)
    expect(withContext.textContent).not.toMatch(/AE you cover/);
    expect($('[data-testid="dc-context"]', dcs)).toBeNull();
    await click($('[data-slot="where"]', withContext)!);
    const details = await waitFor(() => $('[data-testid="dc-context"]', dcs));
    expect($$('li', details).map((li) => li.textContent).some((t) => /^(Data & AI DC: |.+’s Specialist Forecast names this opportunity|Specialists on it: )/.test(t ?? ''))).toBe(true);
    await click($('[data-slot="where"]', withContext)!);
    await waitFor(() => !$('[data-testid="dc-context"]', dcs));
  });

  it('a group header ticks its day; Account is the other grouping, remembered per viewer', async () => {
    search = '';
    const { container } = await mount();
    const lane = await waitFor(() => $('#time-ready [data-testid="ready-lane"]', container));
    const day = await waitFor(() => $('[data-ready-day]', lane));
    const head = $('[data-density="group"] input[type="checkbox"]', day) as HTMLInputElement;
    if (head.checked) await click(head);
    await waitFor(() => $$('[data-review-row]', day).every((r) => !box(r).checked));
    await click(head);
    await waitFor(() => $$('[data-review-row]', day).filter((r) => r.dataset.kind === 'ready').every((r) => box(r).checked));
    const account = $$('[role="radiogroup"][aria-label="Group by"] [role="radio"]', lane).find((b) => b.textContent === 'Account')!;
    await click(account);
    await waitFor(() => !$('[data-ready-day]', lane) && $('[data-ready-group^="acct|"]', lane));
    expect(localStorage.getItem('cc:activity:ready-group')).toBe('account');
  });
});

describe.each([
  { persona: 'se' as const, has: 'your DC', never: null },
  { persona: 'ae' as const, has: 'yours', never: 'DC' },
])('Activity ▸ To log ▸ Review as the $persona persona', ({ persona, has, never }) => {
  it('the rundown names the opp in the role’s words', async () => {
    if (persona !== 'se') {
      const s = await ds.getSettings({} as never);
      await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { id: persona } } } as never);
    }
    search = 'view=log&review=1';
    const { container } = await mount();
    const page = await waitFor(() => $('[data-testid="log-review"]', container));
    // the likely opps open on the unsure row being edited
    await waitFor(() => $$('[data-review-row]', page).some((r) => r.dataset.kind === 'unsure'));
    const lines: string[] = [];
    for (const unsure of $$('[data-review-row]', page).filter((r) => r.dataset.kind === 'unsure')) {
      await click($('[data-slot="where"]', unsure)!);
      const ls = await waitFor(() => {
        const ed = $('[data-slot="editor"]', unsure);
        if (!ed || $('.animate-pulse, [data-skeleton]', ed)) return null;
        return $$('[data-testid="opp-rundown"] li', ed).map((li) => li.querySelectorAll('span span')[1]?.textContent ?? '').concat('');
      });
      lines.push(...ls.filter(Boolean));
      if (lines.some((l) => l.split(' · ').includes(has))) break;
    }
    expect(lines.some((l) => l.split(' · ').includes(has))).toBe(true);
    if (never) expect(lines.join(' ')).not.toContain(never);
  });
});
