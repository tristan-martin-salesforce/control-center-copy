// @vitest-environment jsdom
/**
 * Activity ▸ To log (<TimePage>, the SE's default; D-87) against the real mock DataSource, fetch bridged in-process to
 * the route handlers (the log-view.test.ts harness; placeholder seed). To log (C7): the quarter in one header sentence,
 * three LanePage lanes: Fix or approve (lane 1: the rows grouped by suggestion, edits and Accept through PATCH
 * /activity/:id), Ready for Org62 (time rows by day, then DCs to claim, use cases and Event changes as first-class
 * groups, C11) with the one "Log N …" in its header, Sending (the batches on their way); no folds below the lanes;
 * no queue slice; the To log tab carries the one count.
 * The Week toggle (`?show=week`, or an old `?view=weeks` / `?week=`) holds the week: its picker, what the app found,
 * Week at a glance behind its disclosure, and the week's rows (kit ActionRows; the day and description in the
 * expansion).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type ActivityEntry, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { $, $$, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/activity',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => h('a', { href, ...rest }, children as never),
}));

// the app's navigate, recorded (jsdom has no client router to take it)
const navigated: Array<{ href: string; replace: boolean }> = [];
vi.mock('@/components/shell/router', async (orig) => ({
  ...(await orig<typeof import('@/components/shell/router')>()),
  navigate: (href: string, opts: { replace?: boolean } = {}) => void navigated.push({ href, replace: !!opts.replace }),
}));

const { TimePage } = await import('../TimePage');
const { ActivityNeedsSlot } = await import('../ActivityHead');
const { newOpps } = await import('../ToLogView');
const { bandOf, fixAcceptPatch } = await import('../fix-derive');
const { fixPatch, missingOf, needsYou } = await import('../path-derive');

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
  search = '';
  navigated.length = 0;
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

const mount = () => render(h(QueryClientProvider, { client: qc }, h(TimePage)));

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const tabs = (c: HTMLElement) => $$('[aria-label="Activity views"] [role="tab"]', c);
/** A lane header's count (LanePage: the span after the lane's heading). */
const laneHead = (c: HTMLElement, id: string) => $(`#lane-${id}-title`, c)?.nextElementSibling?.textContent ?? '';
const selectedTab = (c: HTMLElement) => $('[aria-label="Activity views"] [role="tab"][aria-selected="true"]', c)?.textContent ?? '';

describe('Activity ▸ To log', () => {
  it('three tabs; To log is three lanes (Fix or approve, Ready to log, Sending), a header sentence, Also waiting, no queue slice', async () => {
    // the page mounts a slice where app/activity offers one (ActivityNeedsSlot); To log's content is the slice, so it shows none
    const { container } = await render(h(QueryClientProvider, { client: qc }, h(ActivityNeedsSlot, { value: h('div', { 'data-testid': 'slice-probe' }) }, h(TimePage))));
    const sentence = await waitFor(() => $('[data-testid="to-log-sentence"]', container));
    await waitFor(() => $('[data-guide="log-steps"]', container) && $('[data-ready-row]', container) && $('[data-testid="fix-groups"]', container));

    expect(tabs(container).map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['To log', 'History', 'VDP']);
    expect(selectedTab(container)).toMatch(/^To log\d+$/);

    // C7: the quarter card is one header sentence, its own words, with ▸ History; the card itself is History's
    expect(sentence.textContent).toMatch(new RegExp(`^${ds.loaded.seed.meta.quarter.label} · [\\d.]+ of \\d+ h in Org62 · (on pace|[\\d.]+ h (behind|ahead of) pace)( · (past )?due .+)? ▸ History$`));
    expect($('[data-testid="to-log-history"]', container)!.getAttribute('href')).toBe('/activity?view=history');
    expect($('[data-testid="q4-log"]', container)).toBeNull();
    expect($('[data-testid="review-header"]', container)).toBeNull();
    // D-102 amends D-86: no "Needs you here" slice on To log
    expect($('[data-testid="activity-needs"]', container)).toBeNull();
    expect($('[data-testid="slice-probe"]', container)).toBeNull();

    // the lanes, in order, each holding the anchor old links land on
    expect($$('section[data-lane]', container).map((s) => s.id)).toEqual(['lane-fix', 'lane-ready', 'lane-sending']);
    expect($('#lane-fix #time-needs', container)).not.toBeNull();
    expect($('#lane-ready #time-ready', container)).not.toBeNull();
    expect($('#lane-sending #time-runs', container)).not.toBeNull();
    // C11: DCs and use cases are groups of lane 2, not folds under the lanes; the old anchors land on those groups
    // (under the lanes only the reference: the use cases to settle in Org62, every use case)
    expect($$('section[id^="time-"]', container).map((s) => s.id).filter((id) => id !== 'time-use-cases')).toEqual(['time-runs']);
    expect($('[data-testid="also-waiting"]', container)).toBeNull();
    expect($('details#time-usecases', container)).toBeNull();
    expect($('details#time-dcs', container)).toBeNull();
    await waitFor(() => $('#lane-ready #time-usecases[data-ready-kind="useCase"]', container));
    expect($('#lane-ready #time-usecases', container)).not.toBeNull();
    expect($('#time-rows', container)).toBeNull();

    // lane 2: rows grouped by day; its header holds the page's one "Log N · h"
    const steps = $('[data-guide="log-steps"]', container)!;
    expect($$('[data-step]', steps).map((el) => el.dataset.step)).toEqual(['ready']);
    const days = $$('[data-ready-day]', steps).map((d) => d.dataset.readyDay!);
    expect(days.length).toBeGreaterThan(0);
    expect([...days].sort()).toEqual(days);
    const ready = $$('[data-ready-row]', steps);
    expect(ready.length).toBeGreaterThan(0);
    await waitFor(() => $('[data-testid="ready-use-cases"]', steps));
    expect(laneHead(container, 'ready')).toMatch(new RegExp(`^${ready.length} rows? · `));
    // R3-2: on To log the use cases are a header line, closed and unticked until opened (F3), so Sending stays above the
    // fold at scale; opening it shows its first 8
    const ucGroup = $('[data-testid="ready-use-cases"]', steps)!;
    expect($('[data-slot="title"]', ucGroup)?.textContent).toMatch(/^▸?Use cases ?\d+$/);
    expect($$('[data-review-row]', ucGroup)).toHaveLength(0);
    expect(($('[data-density="group"] input[type="checkbox"]', ucGroup) as HTMLInputElement | null)?.checked ?? false).toBe(false);
    expect($('#lane-ready [data-testid="review-log"]', container)?.textContent).not.toMatch(/use case/);
    await click($('[data-testid="group-toggle"]', ucGroup)!);
    await waitFor(() => $$('[data-review-row]', ucGroup).length > 0);
    expect($$('[data-review-row]', ucGroup).length).toBeLessThanOrEqual(8);
    expect($$('[data-testid="review-log"]', container)).toHaveLength(1);
    expect($('#lane-ready [data-testid="review-log"]', container)?.textContent).toMatch(/^Log \d+ rows?( · [\d.]+ h)?( · \d+ DCs?)?( · \d+ use cases?)?( · \d+ Event changes?)?$/);
    expect($$('[aria-label="Rows ready to log"] input[type="checkbox"]', steps).length).toBeGreaterThan(0);
  });

  it('time answers ripple to DCs: a row that gets a new opp re-runs the DC suggestions; the first read only records', () => {
    const first = newOpps(null, [{ id: 'r1', oppId: 'o1', internal: false }]);
    expect(first.added).toEqual([]);
    expect(newOpps(first.opps, [{ id: 'r1', oppId: 'o1', internal: false }, { id: 'r2', oppId: null, internal: false }]).added).toEqual([]);
    expect(newOpps(first.opps, [{ id: 'r1', oppId: 'o1', internal: false }, { id: 'r2', oppId: 'o2', internal: false }]).added).toEqual(['o2']);
    expect(newOpps(first.opps, [{ id: 'r3', oppId: 'o3', internal: true }]).added).toEqual([]);
  });

  it('R3-9: only the user’s own answers ripple; a refetch that brings a scanner’s opp is only seen', () => {
    const first = newOpps(null, [{ id: 'r1', oppId: 'o1', internal: false }], new Map());
    // a scanner's new row on a new opp: seen, no ripple
    const scan = newOpps(first.opps, [{ id: 'r1', oppId: 'o1', internal: false }, { id: 'r9', oppId: 'o9', internal: false }], new Map());
    expect(scan.added).toEqual([]);
    expect(scan.opps.has('o9')).toBe(true);
    // my pick while its PATCH is in flight: the optimistic row is not seen yet, nothing runs
    const pend = newOpps(scan.opps, [{ id: 'r2', oppId: 'o2', internal: false }], new Map([['r2', 'pending' as const]]));
    expect(pend.added).toEqual([]);
    expect(pend.opps.has('o2')).toBe(false);
    // it landed: the ripple runs once, and the row is cleared
    const landed = newOpps(pend.opps, [{ id: 'r2', oppId: 'o2', internal: false }], new Map([['r2', 'landed' as const]]));
    expect(landed).toMatchObject({ added: ['o2'], landed: ['r2'] });
  });

  it('the Week toggle: the week picker, what the app found, Week at a glance, then the week’s rows on the kit', async () => {
    search = 'show=week';
    const { container } = await mount();
    await waitFor(() => $('[data-testid="weeks-picker"] [role="radio"]', container) && $('[data-testid="suggested-total"]', container) && $('#time-rows [data-activity-id]', container));
    expect(selectedTab(container)).toMatch(/^To log/);
    expect($('[role="radiogroup"][aria-label="Show"] [aria-checked="true"]', container)?.textContent).toBe('Week');
    expect($$('section[id^="time-"]', container).map((s) => s.id)).toEqual(['time-suggested', 'time-rows']);
    expect($('[data-testid="weeks-picker"] [aria-checked="true"]', container)!.textContent).toContain('this week');
    expect($('[data-guide="log-steps"]', container)).toBeNull();
    // each row is an ActionRow; the day and the description open in its expansion
    const first = $('#time-rows [data-activity-id]', container)!;
    expect($('[data-row]', first)).not.toBeNull();
    expect($('textarea[aria-label="Description"]', first)).toBeNull();
    await click($('[data-testid="activity-expand"]', first));
    await waitFor(() => $('textarea[aria-label="Description"]', first));
    expect($('input[aria-label="Date"]', first)).not.toBeNull();
    expect($('#time-glance', container)).toBeNull();
    await click($('[data-testid="week-glance-toggle"]', container));
    await waitFor(() => $('#time-glance', container));
    expect(localStorage.getItem('cc:time:week-at-a-glance')).toBe('1');
  });

  it('the Week toggle on a week with no rows says what fills it, and nothing waits on you there', async () => {
    search = 'show=week&week=2025-01-06';
    const { container } = await mount();
    const empty = await waitFor(() => $('[data-testid="week-empty"]', container));
    expect(empty.textContent).toContain('Nothing found for this week');
    expect(empty.textContent).toContain('Nothing here waits on you');
    expect($('#time-rows', container)).toBeNull();
  });

  it('old links land: ?view=week&week= opens the Week on that week, ?view=needs opens To log at Needs you', async () => {
    search = 'view=week&week=2026-11-02';
    const a = await mount();
    await waitFor(() => $('[data-testid="weeks-picker"]', a.container));
    await waitFor(() => navigated.some((n) => n.replace && n.href === '/activity?show=week&week=2026-11-02'));
    await cleanup();
    search = 'view=needs';
    const b = await mount();
    await waitFor(() => $('#time-needs [data-testid="fix-groups"]', b.container));
    expect(selectedTab(b.container)).toMatch(/^To log/);
    await waitFor(() => navigated.some((n) => n.replace && n.href === '/activity#time-needs'));
  });

  const fixRow = (c: HTMLElement, id: string) => $(`[data-fix-row="${id}"]`, c);
  const groupOf = (c: HTMLElement, id: string) => $(`[data-fix-group="${id}"]`, c);

  it('Fix or approve: grouped by suggestion; editing a row (its pickers only while edited) saves', async () => {
    const { container } = await mount();
    await waitFor(() => $('[data-testid="fix-groups"]', container));
    expect($$('[data-fix-group]', container).map((g) => g.dataset.fixGroup)).toEqual(['sugg:opp_hooli_nce', 'sugg:opp_initech_pilot', 'internal', 'r|sugg:opp_globex_d360', 'r|pick']);
    // C11: the guess (Globex) and the row with none are the Review band, after the Accept band
    expect($$('[data-fix-group][data-band="review"]', container).map((g) => g.dataset.fixGroup)).toEqual(['r|sugg:opp_globex_d360', 'r|pick']);
    // the label names the opp once; its rows don't repeat it
    expect($('[data-row]', groupOf(container, 'sugg:opp_hooli_nce')!)!.getAttribute('aria-label')).toBe('Suggested: Hooli · Nimbus Context Engine, 1');
    const row = fixRow(container, 'ac_wed_hooli')!;
    expect($('[data-slot="where"]', row)!.textContent).toBe('92%✓');
    expect($('[data-testid="opp-picker"]', row)).toBeNull();
    // at most four groups open: the fifth is its header line with its count
    expect($$('[data-fix-row]', groupOf(container, 'r|pick')!)).toHaveLength(0);
    await click($('[data-testid="group-toggle"]', groupOf(container, 'r|pick')!));
    await waitFor(() => $$('[data-fix-row]', groupOf(container, 'r|pick')!).length === 1);
    expect($$('[data-fix-row]', groupOf(container, 'sugg:opp_hooli_nce')!)).toHaveLength(0);
    await click($('[data-testid="group-toggle"]', groupOf(container, 'sugg:opp_hooli_nce')!));
    await click($('[data-slot="where"]', await waitFor(() => fixRow(container, 'ac_wed_hooli'))));
    const edited = await waitFor(() => $('[data-slot="editor"]', fixRow(container, 'ac_wed_hooli')!) && fixRow(container, 'ac_wed_hooli'));
    expect($('[data-testid="opp-picker"]', edited)).not.toBeNull();
    await choose($('select[aria-label="Task type"]', edited) as HTMLSelectElement, 'Customer Discovery');
    await waitFor(() => ds.store.get('activity', 'ac_wed_hooli')?.taskType === 'Customer Discovery');
    expect(ds.store.get('activity', 'ac_wed_hooli')?.status).toBe('needs_input');
  });

  it('D-64: the Internal group (#time-internal) is never in the count; its Accept logs them; Leave out sets one aside', async () => {
    const { container } = await mount();
    const group = await waitFor(() => groupOf(container, 'internal'));
    expect($('#time-internal', container)).not.toBeNull();
    expect(group.dataset.counted).toBe('false');
    expect($$('[data-fix-row]', group).map((li) => li.dataset.fixRow).sort()).toEqual(['ac_mon_cert', 'ac_tue_repo', 'ac_wed_docs']);
    // C1 (AX-2): the tab's one count is lanesOf's badge (fix rows + not found in Org62); lane 1's count is the fix rows
    await waitFor(() => selectedTab(container) === 'To log6');
    expect(laneHead(container, 'fix')).toBe('4');
    // R3-4: the band headers count the counted rows (Accept + Review = the lane's 4); Internal is named apart
    const bandN = (b: string) => Number(/^(?:Accept|Review) (\d+)/.exec($(`[data-testid="fix-band-${b}"] [role="rowheader"]`, container)?.textContent ?? '')?.[1] ?? 0);
    expect(bandN('accept') + bandN('review')).toBe(4);
    expect($('[data-testid="fix-band-accept"] [role="rowheader"]', container)?.textContent).toMatch(/^Accept \d+ · Internal 3$/);
    expect(laneHead(container, 'ready')).toBe('2 rows · 2 h · 2 DCs · 2 use cases');
    // lane 3's red mark: the 2 rows not found in Org62 (fix 4 + failed 2 = the tab's 6)
    expect($('#lane-sending [data-lane-failure]', container)!.textContent).toBe('▲2 not found');
    // rows not found in Org62 are lane 3's: never in lane 1
    expect($$('[data-testid="relog-actions"]', container)).toHaveLength(0);
    await click($('[data-testid="row-accept"]', fixRow(group, 'ac_tue_repo')!));
    await waitFor(() => ds.store.get('activity', 'ac_tue_repo')?.status === 'approved');
    await click($('[data-testid="row-verb-menu"]', fixRow(container, 'ac_wed_docs')!));
    await click(await waitFor(() => $$('[role="menuitem"]', document.body).find((o) => o.textContent?.includes('Leave out'))));
    await waitFor(() => ds.store.get('activity', 'ac_wed_docs')?.status === 'dismissed');
    await waitFor(() => $$('[data-fix-row]', groupOf(container, 'internal')!).length === 1);
  });

  it('D-64: the opportunity picker offers "Internal (no opportunity)": the row becomes internal and leaves the lane', async () => {
    const { container } = await mount();
    await click($('[data-slot="where"]', await waitFor(() => fixRow(container, 'ac_wed_hooli'))));
    await click(await waitFor(() => $('[data-testid="opp-picker"]', fixRow(container, 'ac_wed_hooli')!)));
    const option = await waitFor(() => $$('[role="option"]', document.body).find((o) => o.textContent?.startsWith('Internal (no opportunity)')));
    await click(option);
    await waitFor(() => ds.store.get('activity', 'ac_wed_hooli')?.internal === true);
    expect(ds.store.get('activity', 'ac_wed_hooli')).toMatchObject({ status: 'approved', oppId: null, accountName: null });
    await waitFor(() => !fixRow(container, 'ac_wed_hooli'));
    await waitFor(() => laneHead(container, 'fix') === '3');
  });

  it('C6 lane 3 (Sending): one line per batch with its steps and one action; not-found rows under it with Log again / Leave out', async () => {
    const staged = await ds.stageLogBatch({ body: {} } as never);
    const id = staged.entity.draftIds[0]!;
    const { container } = await mount();
    const lane = await waitFor(() => $('#time-runs[data-testid="sending-lane"]', container));
    const batches = await waitFor(() => ($$('[data-testid="sending-batch"]', lane).length ? $$('[data-testid="sending-batch"]', lane) : null));
    expect(batches.map((b) => b.dataset.canvasId)).toEqual([id]);
    const b = batches[0]!;
    expect($('[data-testid="sending-batch-title"]', b)!.textContent).toMatch(/^Batch \d{1,2} [A-Z][a-z]{2}$/);
    expect(b.textContent).toContain(`${staged.entity.events} ${staged.entity.events === 1 ? 'row' : 'rows'}`);
    expect($$('[data-step]', b).map((s) => `${s.dataset.step}:${s.dataset.state}`)).toEqual(['staged:current', 'applied:todo', 'sent:todo', 'checked:todo']);
    expect($('[data-testid="sending-next"]', b)!.textContent).toBe('Review & apply');
    // C10: one filled button per page (Ready's "Log N · h"): the batch's next action is secondary
    expect($('[data-testid="sending-next"]', b)!.dataset.variant).toBe('secondary');
    expect($$('#lane-sending button[data-variant="primary"], #lane-sending button[data-variant="danger"]', container)).toEqual([]);
    expect($('[data-testid="sending-batch-open"]', b)).toBeTruthy();
    // the header: its batches and hours, and the red mark with the not-found count (lanesOf's sending.failed)
    expect(laneHead(container, 'sending')).toMatch(/^1 batch · [\d.]+ h$/);
    expect($('#lane-sending [data-lane-failure]', container)!.textContent).toBe('▲2 not found');
    // the seed's two rows Org62 lacks: their batch is not in the list, so they sit under Earlier batches
    const earlier = $('[data-testid="sending-earlier"]', lane)!;
    expect(earlier.textContent).toContain('Not found in Org62');
    expect($('[data-slot="where"][title="Not found in Org62 after the batch ran"]', earlier)).not.toBeNull();
    expect(earlier.textContent).toContain('Deleted in Org62');
    const again = $$('[data-testid="sending-log-again"]', earlier);
    expect(again).toHaveLength(2);
    await click(again[0]!);
    await waitFor(() => ['ac_mon_globex_arch', 'ac_mon_acme_review'].some((x) => ds.store.get('activity', x)?.status === 'approved'));
    expect($('[data-testid="sending-finished"]', lane)).toBeNull();
    expect(lane.textContent).not.toMatch(/\bcanvas(es)?\b|read-?back/i);
  });

  it('Fix or approve: plain words, a row’s one-click Accept, and the chevron opens the details panel', async () => {
    const { container } = await mount();
    const slack = await waitFor(() => fixRow(container, 'ac_tue_slack_initech'));
    expect(container.textContent).not.toMatch(/NEEDS WhatId|=> 006|=> skip|CF forced/);
    expect($('[data-row]', groupOf(container, 'sugg:opp_initech_pilot')!)!.getAttribute('aria-label')).toContain('Initech · D360 Pilot');
    expect($('[data-testid="where-percent"]', slack)!.className).toMatch(/text-ai-700/);
    expect($('[data-testid="row-chevron"]', slack)).not.toBeNull();
    await click($('[data-testid="row-accept"]', slack));
    await waitFor(() => ds.store.get('activity', 'ac_tue_slack_initech')?.oppId === 'opp_initech_pilot');
    expect(ds.store.get('activity', 'ac_tue_slack_initech')?.status).toBe('approved');
    await waitFor(() => !fixRow(container, 'ac_tue_slack_initech'));
  });

  it('Fix or approve: tick a row, shift-click a range; the bar names how many; a group’s Accept saves them all', async () => {
    const { container } = await mount();
    await waitFor(() => fixRow(container, 'ac_wed_roadmap'));
    // C11: the header's Accept takes the sure suggestions only (the Globex guess is Review)
    expect($('[data-testid="fix-accept-all"]', container)!.textContent).toBe('Accept 2 suggestions');
    await click($('[data-testid="row-check"]', fixRow(container, 'ac_wed_hooli')!));
    const last = $('[data-testid="row-check"]', fixRow(container, 'ac_wed_roadmap')!)!;
    await act(async () => {
      last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true }));
    });
    await click(last);
    const bar = await waitFor(() => $('[data-testid="needs-bulk"]', container));
    // C11: the range runs in the order shown, so it crosses the Internal group (Accept band) into the Review band
    expect($('[data-testid="needs-selected"]', bar)!.textContent).toMatch(/^\d+ ticked · /);
    expect($('[data-testid="bulk-accept"]', bar)!.textContent).toMatch(/^Accept \d+ suggestions$/);
    // the group header's box shows the group ticked
    expect(($('[data-testid="row-check"]', groupOf(container, 'sugg:opp_hooli_nce')!) as HTMLInputElement).checked).toBe(true);
    // a group's Accept: every row in it, through the same save as a row's Accept
    const internal = groupOf(container, 'internal')!;
    expect($('[data-testid="group-accept"]', internal)!.textContent).toBe('Accept 3');
    await click($('[data-testid="group-accept"]', internal));
    await waitFor(() => ['ac_mon_cert', 'ac_tue_repo', 'ac_wed_docs'].every((id) => ds.store.get('activity', id)?.status === 'approved'));
  });
});

// DC4 follow-up (D-103 (c)): a row that logs to the account itself (accountId set, no opp, not internal) has its target.
// Lane 1 never asks it for an opp: missingOf, the Accept band, the Accept patch and fixPatch read hasTarget().
const acctEntry = (o: Partial<ActivityEntry> = {}): ActivityEntry =>
  ({
    id: 'r1',
    version: 1,
    date: '2026-11-03',
    start: '2026-11-03T22:00:00.000Z',
    end: '2026-11-03T23:00:00.000Z',
    durationH: 1,
    taskType: 'Solution Creation',
    oppId: null,
    oppName: null,
    accountId: 'acc-placeholder',
    accountName: 'Placeholder Co',
    meetingType: 'CR',
    description: 'Placeholder Co: discovery call',
    status: 'proposed',
    confidence: 'likely',
    sources: [],
    userLockedFields: [],
    issues: [],
    updatedAt: '2026-11-03T23:00:00.000Z',
    fromOrg62: false,
    excludedReason: null,
    loggedAt: null,
    verifiedAt: null,
    internal: false,
    logNote: null,
    logNoteBasis: null,
    why: null,
    suggestion: { kind: 'opp', oppId: 'opp-placeholder', oppName: 'Placeholder Co - Data 360', confidence: 0.9 },
    ...o,
  }) as unknown as ActivityEntry;

describe('Fix lane: the account itself is a target (D-103 (c))', () => {
  it('an account-target row is not a Fix row', () => {
    const acct = acctEntry();
    expect(missingOf(acct)).toBeNull();
    expect(needsYou([acct]).ids).toEqual([]);
    expect(bandOf(acct, 'opp', 0.75)).toBe('review');
    expect(fixAcceptPatch(acct)).toBeNull();
    // a held account-target row with every field filled: your input approves it, no opp asked
    expect(fixPatch(acctEntry({ status: 'needs_input' }), { durationH: 1 })).toMatchObject({ status: 'approved' });
    // the same row with no account still asks for an opp
    expect(missingOf(acctEntry({ accountId: null, status: 'needs_input' }))).toBe('opp');
  });
});
