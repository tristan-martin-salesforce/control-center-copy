// @vitest-environment jsdom
/**
 * Activity ▸ History (<TimePage> with ?view=history) against the real mock DataSource with a quarter of history
 * (tests/fixtures/activity-history.ts, placeholder data), fetch bridged in-process to the route handlers (the
 * panel.test.ts harness). Covers: the current quarter by default (tracking against the target, the states by the one
 * count map, waiting on you, earlier hours), where the hours went (an account and its opportunities, internal work)
 * and each line's rows one click deeper (a second click clears), a week's rows from the chart and its table view; a
 * past quarter (its logged vs target, compact read-only rows: an Org62 row reads as read from Org62, never "Unconfirmed", and has no Undo;
 * an excluded row says why; day headers linking to History; a status filter; the "That's everything" end); every
 * quarter side by side.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';
import { mondayOf } from '../path-derive';
import { withActivityHistory, type ActivityHistory } from '../../../../tests/fixtures/activity-history';

let search = 'view=history';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/activity',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));

const { TimePage } = await import('../TimePage');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;
let H: ActivityHistory;
const sizes: Array<[keyof Element, PropertyDescriptor | undefined]> = [];

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

beforeAll(() => {
  // jsdom has no layout: give the Log's scroll pane a viewport (the virtualizer reads clientHeight) so it renders
  // rows; items measure 0 px (offsetHeight), so every one of the fixture's rows is in range
  for (const k of ['clientHeight', 'clientWidth'] as const) {
    sizes.push([k, Object.getOwnPropertyDescriptor(Element.prototype, k)]);
    Object.defineProperty(Element.prototype, k, { configurable: true, get: () => (k === 'clientHeight' ? 4000 : 1400) });
  }
  const base = createMockDataSource({ autoplay: false });
  H = withActivityHistory(base.loaded.seed);
  base.dispose();
});
afterAll(() => {
  for (const [k, d] of sizes) if (d) Object.defineProperty(Element.prototype, k, d);
});

beforeEach(() => {
  search = 'view=history';
  resetDataSourceForTests();
  ds = createMockDataSource({ seed: H.seed, autoplay: false, delays: { enrichMs: 1e8, reevalMs: 1e8, stepMs: 1e8, verifyMs: 1e8 } });
  ds.clock.freeze(new Date(H.seed.meta.asOf));
  ds.resetStore();
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
  ds.dispose();
  resetDataSourceForTests();
});

const mount = () => render(h(QueryClientProvider, { client: qc }, h(TimePage)));
const row = (id: string, root: ParentNode = document) => $(`[data-row-id="${id}"]`, root);
const byText = (sel: string, text: string, root: ParentNode = document) => $$(sel, root).find((el) => el.textContent?.startsWith(text)) ?? null;
const quarterRadio = (label: string, root: ParentNode) => $$('[role="radiogroup"][aria-label="Quarter"] [role="radio"]', root).find((b) => b.textContent?.includes(label)) ?? null;

describe('Activity ▸ History', () => {
  it('opens on the current quarter: tracking against the target, where the hours went, and the rows behind a line one click deeper', async () => {
    const { container } = await mount();
    const pane = await waitFor(() => $('[data-testid="activity-log"]', container));
    await waitFor(() => row('ac_tue_globex', pane));
    expect($('[aria-label="Activity views"] [role="tab"][aria-selected="true"]', container)?.textContent).toBe('History');

    // the current quarter is the default; the past one is a choice, then every quarter
    expect(quarterRadio(H.cur.label, container)?.getAttribute('aria-checked')).toBe('true');
    expect(quarterRadio(H.prev.label, container)?.getAttribute('aria-checked')).toBe('false');
    expect(quarterRadio('All quarters', container)).not.toBeNull();
    // a past quarter's rows are not in the current quarter's list
    expect(row(H.ids.org62A, pane)).toBeNull();

    // C8: the quarter tracking card lives on History (the card To log used to carry): logged against the target, the meter
    const card = await waitFor(() => $('[data-testid="q4-log"]', container));
    expect($('[data-testid="q4-logged"]', card)?.textContent).toMatch(/\d+(\.\d+)? h\s*logged in Org62 of \d+ h/);
    expect($('[role="meter"]', card)).not.toBeNull();
    expect($('[data-testid="ledger-tracking"]', container)).toBeNull(); // one card, not two
    // F4 (R2-4): the card tells no batch's life: no "to apply" / "to send", no per-batch lines; one quiet link to Sending
    expect(card.textContent).not.toMatch(/to apply|to send|Slackbot|on its way to Org62 ·/);
    expect($('[data-testid="q4-spill"]', card)).toBeNull();
    const flight = $('[data-testid="q4-in-flight"]', card);
    if (flight) {
      expect(flight.textContent).toMatch(/^\d+ batch(es)? in flight ▸ Sending$/);
      expect($('a', flight)?.getAttribute('href')).toContain('#time-runs');
    }
    // nothing still waiting on the user is History's: no in-flight batch here (Sending has it), no editable rows
    expect($('[data-testid="sending-batch"]', container)).toBeNull();
    expect($('[role="grid"] input, [role="grid"] select', pane)).toBeNull();
    expect($$('[data-row-id]', pane).every((r) => r.dataset.density === 'compact')).toBe(true);
    const waiting = $('[data-row-id] [data-testid="history-waiting"]', pane);
    if (waiting) expect(waiting.getAttribute('href')).toContain('#time-needs');
    // finished batches, newest first (the chip finds a batch's rows); a row on a batch still in flight says so once
    // F4: one name (batchLabel, the time when two share a day) and one row count, the same as Sending's
    for (const b of $$('[data-testid="history-batch"]', container)) expect(b.textContent).toMatch(/^✓Batch \d+ \w{3}( \d\d:\d\d( \(\d+\))?)? · \d+ rows? · .* h/);
    for (const a of $$('[data-testid="history-in-batch"]', pane)) {
      expect(a.textContent).toMatch(/^(in batch \d+ \w{3}( \d\d:\d\d( \(\d+\))?)?|on its way · Sending)/);
      expect(a.getAttribute('href')).toContain('#time-runs');
    }

    // where the hours went: an account and its opportunities, internal work on its own line
    const where = $('[data-testid="ledger-breakdowns"]', container)!;
    const acme = byText('[data-testid="ledger-account"]', H.account, where)!;
    expect(acme).not.toBeNull();
    expect($$('[data-testid="ledger-opp"]', where).map((b) => b.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Headless Phase 2')]));
    expect($('[data-testid="ledger-internal"]', where)?.textContent).toContain('Internal (no opportunity)');

    // an account's rows one click deeper; a second click is every row again
    await click(acme);
    await waitFor(() => !row('ac_tue_globex', pane) && row('ac_mon_acme', pane));
    expect(acme.getAttribute('aria-pressed')).toBe('true');
    expect($('#ledger-rows-h', container)?.textContent).toBe(`Rows · ${H.account}`);
    expect(window.location.search).toContain('account=ACME+Corp');
    await click(byText('[data-testid="ledger-account"]', H.account, where));
    await waitFor(() => row('ac_tue_globex', pane));

    // internal work's rows
    await click($('[data-testid="ledger-internal"]', where));
    await waitFor(() => row('ac_mon_cert', pane) && !row('ac_mon_acme', pane));
    expect(window.location.search).toContain('opp=internal');

    // a week's rows (the chart's column), with its chip; the table view says the same numbers
    const chart = $('[data-testid="ledger-chart"]', container)!;
    const monday = mondayOf(H.seed.activity.find((e) => e.id === 'ac_mon_acme')!.date);
    expect(monday > H.cur.start).toBe(true); // the seed's Monday is not the quarter's first (clipped) week
    await click($(`[data-period="${monday}"]`, chart));
    await waitFor(() => row('ac_mon_acme', pane) && !row(H.ids.curOrg62, pane) && $('[data-testid="log-week-chip"]', container));
    expect(window.location.search).toContain(`week=${monday}`);
    expect(window.location.search).not.toContain('opp=internal');
    await click($$('[role="radio"]', chart).find((b) => b.textContent === 'Table'));
    const table = await waitFor(() => $('[data-testid="ledger-chart-table"]', chart));
    expect($$('tbody tr', table).length).toBeGreaterThanOrEqual(13);
  });

  it('a past quarter: its logged vs target, compact done rows (an Org62 row is never unconfirmed), why excluded rows were not logged', async () => {
    const { container } = await mount();
    const pane = await waitFor(() => $('[data-testid="activity-log"]', container));
    await waitFor(() => row('ac_tue_globex', pane));

    await click(quarterRadio(H.prev.label, container));
    await waitFor(() => row(H.ids.org62A, pane) && !row('ac_tue_globex', pane));
    expect(window.location.search).toContain(`quarter=${encodeURIComponent(H.prev.label).replace(/%20/g, '+')}`);
    const track = await waitFor(() => {
      const t = $('[data-testid="ledger-tracking"]', container);
      return t?.textContent?.includes(H.prev.label) ? t : null;
    });
    expect($('[data-testid="ledger-logged"]', track)?.textContent).toMatch(new RegExp(`^${H.prevLoggedH} h\\s*in Org62 of \\d+ h`));
    expect($('[data-testid="ledger-pace"]', track)).toBeNull(); // no pace for a quarter that is over

    // an Org62 row: compact, read-only, read from Org62, never unconfirmed; no Undo (the app never sent it)
    const native = row(H.ids.org62A, pane)!;
    expect(native.hasAttribute('data-compact')).toBe(true);
    expect($('input,select', native)).toBeNull();
    expect(native.textContent).toContain('Logged in Org62 (read from there)');
    expect($('[data-testid="history-undo"]', native)).toBeNull();
    expect(native.textContent).not.toContain('Unconfirmed');
    // an excluded row says why; the overview counts it apart
    expect($('[data-testid="excluded-reason"]', row(H.ids.excluded, pane)!)?.textContent).toContain('Overlaps another row');
    expect($('[data-testid="ledger-excluded"]', track)).not.toBeNull();
    // day headers link to History; the list ends with "That's everything"
    expect($$('a[href^="/history?day="]', pane).map((a) => a.getAttribute('href'))).toContain(`/history?day=${H.seed.activity.find((e) => e.id === H.ids.org62A)!.date}`);
    expect($('[data-testid="log-end"]', pane)?.textContent).toContain(`That's everything · 4 rows in ${H.prev.label}`);

    // a status chip filters the rows
    await click($('[data-status="logged"]', container)!);
    await waitFor(() => !row(H.ids.excluded, pane) && row(H.ids.org62A, pane));
    expect($$('[data-row-id]', pane).map((r) => r.dataset.status)).toEqual($$('[data-row-id]', pane).map(() => 'logged'));
    expect(window.location.search).toContain('status=logged');

    // the past quarter's own account lines: the account with rows and no opportunity
    const where = $('[data-testid="ledger-breakdowns"]', container)!;
    await click(byText('[data-testid="ledger-account"]', 'ACCOUNT_HISTORY', where));
    await waitFor(() => row(H.ids.org62B, pane) && !row(H.ids.org62A, pane));
  });

  it('every quarter: each quarter side by side, the chart by quarter, every row', async () => {
    const { container } = await mount();
    const pane = await waitFor(() => $('[data-testid="activity-log"]', container));
    await waitFor(() => row('ac_tue_globex', pane));
    await click(quarterRadio('All quarters', container));
    const lines = await waitFor(() => $('[data-testid="ledger-quarter-lines"]', container));
    expect(lines.textContent).toContain(H.prev.label);
    expect(lines.textContent).toContain(H.cur.label);
    expect($('#ledger-chart-h', container)?.textContent).toBe('By quarter');
    await waitFor(() => $('[data-testid="log-end"]', pane)?.textContent?.includes(`That's everything · ${H.seed.activity.length} rows`) && row('ac_tue_globex', pane));
    // scale (C8): at most four weeks open; an older week is its header until opened
    const weeks = $$('[data-week]', pane);
    expect(weeks.filter((w) => w.dataset.open === 'true').length).toBeLessThanOrEqual(4);
    const old = mondayOf(H.seed.activity.find((e) => e.id === H.ids.org62A)!.date);
    if ($(`[data-week="${old}"]`, pane)?.dataset.open === 'false') await click($(`[data-week="${old}"] [data-testid="log-week-toggle"]`, pane));
    await waitFor(() => row(H.ids.org62A, pane));
    expect($$('[data-week]', pane).filter((w) => w.dataset.open === 'true').length).toBeLessThanOrEqual(5);
    // a quarter's line opens it
    await click(byText('[data-testid="ledger-quarter-lines"] button', H.prev.label, container));
    await waitFor(() => quarterRadio(H.prev.label, container)?.getAttribute('aria-checked') === 'true');
  });
});
