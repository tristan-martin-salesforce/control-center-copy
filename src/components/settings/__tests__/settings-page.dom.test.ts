// @vitest-environment jsdom
/**
 * Settings in five sections (01-ui-audit R8): the nav shows Me · Sources · Sending · Budgets · Data with Advanced
 * folded (open when one of its pages is), the title is the topbar's (no h1 in the page), and Data ▸ "Clean up now"
 * checks first (counts, nothing changes) and then removes, against the mock DataSource through the real handlers.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type PersonaId, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';

const nav = vi.hoisted(() => ({ section: 'data' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(`section=${nav.section}`),
}));

const { SettingsPage } = await import('../SettingsPage');

type Ds = ReturnType<typeof createMockDataSource>;
type Ev = { id: string; acknowledged: boolean; at: string; lastSeenAt: string };
let ds: Ds;
let qc: QueryClient;
let calls: Array<{ method: string; path: string; body: unknown }>;

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
  localStorage.clear();
  calls = [];
  // jsdom has no layout: a ResizeObserver that never fires, and scroll calls that do nothing
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => {};
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = matchRoute(method, url.pathname);
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!m) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  resetDataSourceForTests();
});

const mount = () => render(h(QueryClientProvider, { client: qc }, h(SettingsPage)));
const groupLabels = () => $$('[data-testid^="settings-group-"]').map((g) => g.textContent?.replace(/\d+$/, '').trim());
const pages = () => $$('a[data-go]').map((a) => a.getAttribute('data-go'));

describe('Settings: five sections', () => {
  it('shows Me · Sources · Sending · Budgets · Data with Advanced folded, and no h1 of its own', async () => {
    nav.section = 'data';
    const { container } = await mount();
    await waitFor(() => $('[data-testid="settings-nav"]', container));
    expect(groupLabels()).toEqual(['Me', 'Sources', 'Sending', 'Budgets', 'Data', 'Advanced']);
    expect(pages()).not.toContain('policy');
    expect($('[data-testid="settings-group-advanced"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('h1')).toBeNull();
    expect($('[data-page-header="settings"]')!.textContent).toContain('Data ▸ Data & backups');
    await click($('[data-testid="settings-group-advanced"]'));
    expect(pages()).toEqual(expect.arrayContaining(['policy', 'thresholds', 'closing']));
  });

  it('an old link into Advanced opens it there', async () => {
    nav.section = 'policy';
    await mount();
    await waitFor(() => $('[data-testid="settings-nav"]'));
    expect($('[data-testid="settings-group-advanced"]')!.getAttribute('aria-expanded')).toBe('true');
    expect($('a[data-go="policy"]')!.getAttribute('aria-current')).toBe('page');
  });

  it('Data: checks what the clean-up would remove, then removes it', async () => {
    nav.section = 'data';
    const store = (ds as unknown as { store: { all(t: 'eventLog'): Ev[]; c: { eventLog: Map<string, Ev> } } }).store;
    const first = store.all('eventLog')[0]!;
    store.c.eventLog.set(first.id, { ...first, acknowledged: true, at: '2020-01-01T00:00:00Z', lastSeenAt: '2020-01-01T00:00:00Z' });
    const n = store.all('eventLog').length;
    await mount();
    await waitFor(() => $('[data-testid="data-llmTextDays"]'));
    expect(($('[data-testid="data-eventsDays"]') as HTMLInputElement).value).toBe('30');
    expect($('[data-testid="data-backup-dir"]')!.textContent).toContain('command-center/backups');
    await click($('[data-testid="data-run-dry"]'));
    const res = await waitFor(() => $('[data-testid="data-run-result"]'));
    expect(res.textContent).toContain('Would remove 1 records');
    expect(store.all('eventLog').length).toBe(n);
    await click(await waitFor(() => $('[data-testid="data-run-now"]')));
    await waitFor(() => $('[data-testid="data-run-result"]')?.textContent?.includes('Removed 1'));
    expect(store.all('eventLog').length).toBe(n - 1);
    expect(calls.filter((c) => c.path.endsWith('/retention/run')).map((c) => (c.body as { dry: boolean }).dry)).toEqual([true, false]);
  });
});

// ── 29-persona-qa (D-55): Settings as each persona ─────────────────────────────────────────────
// Profile's role pack names the persona's own role; Role & rules names it once and logs in plural Events; Time words
// the logging help and Org62 discovery for it and keeps the DC suggestions to a role with deal contributions;
// Connectors shows VDP re-auth only while the VDP source is active.
async function as(persona: PersonaId, section: string) {
  if (persona !== 'se') {
    const s = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { id: persona } } } as never);
  }
  nav.section = section;
  return render(h(QueryClientProvider, { client: qc }, h(SettingsPage)));
}

const text = () => document.body.textContent ?? '';

describe.each([
  { persona: 'se' as const, pack: 'SE role pack', dc: true, vdp: true, rows: 'a task type and an opportunity', whose: 'Your opp teams, the AEs you cover', title: 'SE (Solutions Engineer)', role: 'SE (Solutions Engineer)', covers: true, logs: 'as Solutions Events, each with an SE task type, toward 250 h a quarter.' },
  { persona: 'ae' as const, pack: 'Specialist AE role pack', dc: false, vdp: false, rows: 'have an opportunity (or account)', whose: 'The opportunities you own or are on the team of', title: 'Specialist AE · Preview', role: 'Specialist AE', covers: false, logs: 'as Sales Events.' },
])('Settings as the $persona persona', ({ persona, pack, dc, vdp, rows, whose, title, role, covers, logs }) => {
  it('Role & rules: what follows the role names it once and logs in plural Events', async () => {
    await as(persona, 'role');
    const effect = await waitFor(() => $('[data-testid="role-effect"]'));
    expect(effect.textContent).toContain(title);
    expect(effect.textContent).not.toContain('Specialist AE (Specialist AE)');
    expect(effect.textContent).toContain(`Customer meetings are logged in Org62 ${logs}`);
    // the SE's Level row (the AE has one level) no longer points at Profile & hours, which links back here
    if (persona === 'se') expect(text()).toContain('From your setup. Pick the other level here to change it.');
    expect(text()).not.toContain('Follows Me ▸ Profile & hours');
  });

  it('Profile: the role pack is the persona’s own', async () => {
    await as(persona, 'profile');
    await waitFor(() => text().includes(pack));
    expect(text()).toContain(pack);
    expect(text()).not.toContain('SE (IC) role pack');
    // the Role row names the role once (roleTitle)
    const roleRow = await waitFor(() => $('#l-role')?.parentElement?.parentElement?.parentElement ?? null);
    expect(roleRow.textContent).toContain(`${role}Change in Role & rules`);
    expect(text()).not.toContain('Specialist AE (Specialist AE)');
    // "AEs I cover" is the SE's list; the Specialist AE's persona declares none (its book is its own opps): no row
    expect(!!$('[data-testid="profile-coverage-slot"]')).toBe(covers);
    expect(text().includes('AEs I cover')).toBe(covers);
  });

  it('Sending: VDP autopilot, its trusted sites and its daily cap only while VDP is active', async () => {
    await as(persona, 'sending');
    await waitFor(() => $('[data-testid="dry-run-switch"]'));
    await waitFor(() => (vdp ? $('[data-testid="sending-vdp-autopilot"]') : true));
    expect(!!$('[data-testid="sending-vdp-autopilot"]')).toBe(vdp);
    expect(!!$('[data-testid="sending-vdp-asset-hosts"]')).toBe(vdp);
    expect(text().includes("Autopilot's daily cap")).toBe(vdp);
    expect(text()).toContain('Read-back verification');
  });

  it('Time: logging and discovery in the persona’s words, DC suggestions only with deal contributions', async () => {
    await as(persona, 'time');
    await waitFor(() => $('[data-testid="t-discovery"]'));
    expect(text()).toContain(rows);
    expect(text()).toContain(whose);
    expect(!!$('[data-testid="t-dc-products"]')).toBe(dc);
    expect(text().includes('DC suggestions and Org62 discovery')).toBe(dc);
    if (!dc) expect(text()).toContain('Org62 discovery');
    expect(text().includes('AEs I cover')).toBe(covers);
  });

  it('Connectors: VDP re-auth only while the VDP source is active', async () => {
    await as(persona, 'connectors');
    await waitFor(() => text().includes('Read tools only'));
    await waitFor(() => (vdp ? text().includes('VDP re-auth') : true));
    expect(text().includes('VDP re-auth')).toBe(vdp);
  });
});
