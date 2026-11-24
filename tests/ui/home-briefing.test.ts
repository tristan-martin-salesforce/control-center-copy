// @vitest-environment jsdom
/**
 * Home as the briefing, the client side: Home ▸ Plan renders the Today page's own tree (`/today` and the toggle never
 * diverge), `p` switches back, the grouped Needs-you header says the queue's total (the sidebar's number), "Move it"
 * dispatches the snooze, Respond chips open the Outbox row, and a card closed for you while Home is open stays in its
 * slot with Undo. Placeholders only.
 */
import { createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NeedsPayload, type HomeCard, type HomeMoveIt, type HomePayload, type HomeRespond } from '@/contract';
import { needsCount } from '@/engines/needs/count';
import { navCount } from '@/components/shell/Sidebar';
import { NAV_GROUPS } from '@/components/shell/nav';
import { matchRoute } from '@/components/shell/routes';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { $, $$, cleanup, click, render } from '../../src/components/composer/__tests__/dom';

const nav = vi.hoisted(() => ({ navigate: vi.fn(), search: new URLSearchParams(), openDetails: vi.fn(), needs: null as unknown }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => nav.search,
}));
vi.mock('@/components/shell/router', async (orig) => ({ ...(await orig<typeof import('@/components/shell/router')>()), navigate: nav.navigate }));
vi.mock('@/components/shell/panel', async (orig) => ({ ...(await orig<typeof import('@/components/shell/panel')>()), useRightPanel: () => ({ openDetails: nav.openDetails, open: false }) }));
vi.mock('@/components/shell', async (orig) => ({ ...(await orig<typeof import('@/components/shell')>()), useRightPanel: () => ({ openDetails: nav.openDetails, open: false }) }));
// The Today tree is the real page in the app; here a stub stands for it so the test sees which component each route mounts.
vi.mock('@/components/today/TodayPage', () => ({
  TodayView: ({ embedded = false, onPlanKey }: { embedded?: boolean; onPlanKey?: () => void }) =>
    h('div', { 'data-today-view': '', 'data-embedded': embedded ? '1' : '0' }, h('button', { type: 'button', 'data-plan-key': '', onClick: () => onPlanKey?.() }, 'p')),
  TodayPage: () => h('div', { 'data-today-view': '', 'data-embedded': '0' }),
}));
vi.mock('@/components/needs/useNeeds', () => ({
  useNeeds: () => ({ data: nav.needs, isError: false, refetch: vi.fn() }),
  useNeedActions: () => ({ run: vi.fn(), decideAsync: vi.fn(), pending: false }),
}));

const { HomePage } = await import('@/components/home/HomePage');
const { HomePlan, homeModeHref, homeModeOf } = await import('@/components/home/HomePlan');
const { HomeNeeds, groupNeeds } = await import('@/components/home/HomeNeeds');
const { MoveItLine, RespondStrip, chipText, watchingLine } = await import('@/components/home/Briefing');
const { DoNow } = await import('@/components/home/DoNow');
const { HomeViewProvider } = await import('@/components/home/ctx');
const { closedInPlace, cardsWithClosed } = await import('@/components/home/model');
const today = await import('@/components/today');

let ds: MockDataSource;
beforeAll(() => {
  ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed', delays: { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
});
afterAll(() => ds.dispose());
afterEach(async () => {
  await cleanup();
  nav.navigate.mockReset();
  nav.openDetails.mockReset();
  nav.search = new URLSearchParams();
});

describe('Home ▸ Plan: the folded Today', () => {
  it('/today and Home ▸ Plan mount the same Today tree (TodayView); only Home’s copy is embedded', async () => {
    expect(matchRoute('/today').key).toBe('today');
    expect(matchRoute('/').key).toBe('home');
    const page = await render(h(today.TodayPage));
    nav.search = new URLSearchParams('view=plan');
    const home = await render(h(HomePage));
    const a = $('[data-today-view]', page.container);
    const b = $('[data-testid="home-plan"] [data-today-view]', home.container);
    expect(a && b).toBeTruthy();
    expect(a!.getAttribute('data-embedded')).toBe('0');
    expect(b!.getAttribute('data-embedded')).toBe('1');
  });

  it('the toggle and `p` switch between the briefing and the plan (`/?view=plan`)', async () => {
    expect(homeModeOf(new URLSearchParams('view=plan'))).toBe('plan');
    expect(homeModeOf(new URLSearchParams(''))).toBe('home');
    expect(homeModeHref('plan')).toBe('/?view=plan');
    expect(homeModeHref('home')).toBe('/');
    const onMode = vi.fn();
    const { container } = await render(h(HomePlan, { onMode }));
    // `p` inside the plan (TodayView's own key) goes back to the briefing
    await click($('[data-plan-key]', container));
    expect(onMode).toHaveBeenLastCalledWith('home');
    const radios = $$('[data-testid="home-view-toggle"] [role="radio"]', container);
    expect(radios.map((r) => r.textContent)).toEqual(['Home', 'Plan']);
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    await click(radios[0]);
    expect(onMode).toHaveBeenLastCalledWith('home');
  });
});

describe('Needs you: grouped, one count', () => {
  it('the header is the queue’s total, the same number as the sidebar; Today is open, the other groups are folded', async () => {
    const q = NeedsPayload.parse(await ds.listNeeds({} as never));
    nav.needs = q;
    const { container } = await render(h(HomeNeeds));
    const homeItem = NAV_GROUPS[0]!.items.find((i) => i.href === '/')!;
    const sidebar = navCount(undefined, homeItem.count, needsCount(q));
    expect($('[data-testid="home-needs-count"]', container)!.textContent).toBe(String(q.total));
    expect(sidebar).toBe(q.total);
    expect($('[data-testid="needs-home"]', container)!.getAttribute('data-needs-total')).toBe(String(q.total));
    const groups = groupNeeds(q.rows);
    expect($('[data-testid="home-needs-groups"]', container)!.textContent).toBe(groups.map((g) => `${g.label} ${g.rows.length}`).join(' · '));
    // the first group is open with at most 3 rows; the rest are one click each
    expect($$('[data-testid="need-row"]', container).length).toBeLessThanOrEqual(3);
    const folded = $$('[data-testid="home-needs-collapsed"] button', container).map((b) => b.getAttribute('data-group'));
    expect(folded).toEqual(groups.slice(1).map((g) => g.key));
    if (folded.length) {
      await click($('[data-testid="home-needs-collapsed"] button', container));
      expect($$('[data-testid="home-needs-collapsed"] button', container).length).toBe(folded.length - 1);
    }
  });
});

describe('the briefing strips', () => {
  it('"Move it" dispatches the snooze for the named item (the toast carries Undo)', async () => {
    const snooze = vi.fn();
    const m: HomeMoveIt = { label: 'Overbooked by 45 min', sentence: 'Move “Umbrella deck” to Monday to fit.', item: { id: 'w_deck', version: 3 }, title: 'Umbrella deck', to: { date: '2026-11-09', label: 'Monday', short: 'Mon 11/9', startsAt: '2026-11-09T15:00:00.000Z' }, freesMin: 60, covers: true };
    const { container } = await render(h(MoveItLine, { m, actions: { snooze } }));
    expect($('[data-testid="home-move-it"]', container)!.textContent).toContain('Overbooked by 45 min.');
    await click($('[data-testid="home-move-it-btn"]', container));
    expect(snooze).toHaveBeenCalledWith({ id: 'w_deck', version: 3 }, 'Umbrella deck');
  });

  it('HM-02: nothing movable shows the sentence and no button', async () => {
    const m: HomeMoveIt = { label: 'Overbooked by 45 min', sentence: 'Nothing here can move: what is left is pinned or due today.', item: null, title: null, to: null, freesMin: 0, covers: false };
    const { container } = await render(h(MoveItLine, { m, actions: { snooze: vi.fn() } }));
    expect($('[data-testid="home-move-it-btn"]', container)).toBeNull();
  });

  it('Respond chips read "Reply to Dana · Send" and open the Outbox row; all failed says so (HM-03)', async () => {
    const r: HomeRespond = {
      count: 2,
      ready: 1,
      failed: 1,
      review: { label: 'Review 2', href: '/outbox' },
      chips: [
        { id: 'd1', kind: 'draft', who: 'Dana', text: 'Re: scope', state: 'ready', verb: 'Send', href: '/outbox?draft=d1', entity: { kind: 'draft', id: 'd1' } },
        { id: 'd2', kind: 'draft', who: '#team', text: 'Update', state: 'failed', verb: 'Retry', href: '/outbox?draft=d2', entity: { kind: 'draft', id: 'd2' } },
      ],
    };
    expect(chipText(r.chips[0]!)).toEqual({ lead: 'Reply to Dana', verb: 'Send' });
    expect(chipText(r.chips[1]!)).toEqual({ lead: 'Post in #team', verb: 'Retry' });
    const { container } = await render(h(RespondStrip, { r }));
    const chips = $$('[data-chip-state]', container);
    expect(chips.map((c) => c.textContent)).toEqual(['✦Reply to Dana·Send', 'Post in #team·Retry']);
    await click(chips[0]);
    expect(nav.navigate).toHaveBeenLastCalledWith('/outbox?draft=d1');
    await cleanup();
    const failed = await render(h(RespondStrip, { r: { ...r, ready: 0, chips: [r.chips[1]!], count: 1 } }));
    expect(failed.container.textContent).toContain('The draft failed to send');
  });

  it('HM-01 the empty day says what the app is watching', () => {
    expect(watchingLine(['Slack', 'Gmail', 'Calendar'])).toBe('Nothing needs you right now. Watching Slack, Gmail and Calendar; anything new lands here.');
    expect(watchingLine([])).toMatch(/No source is connected yet/);
  });
});

describe('HM-05: a Top-3 card closed for you while Home is open', () => {
  const card = (id: string, rank: number): HomeCard => ({ rank, kind: 'item', id, entity: { kind: 'work_item', id }, tag: null, title: `Card ${id}`, why: null, whyMatters: null, whyNow: null, state: null, stateLabel: null, aiLabel: null, prep: null, context: null, drafts: [], draftIds: [], youMin: 10, agentMin: 0, due: null, foot: null, carried: null, verb: { label: 'Open', action: 'open', href: `/work/${id}`, targetId: id }, now: null });
  const closed = { id: 'b', title: 'Card b', badge: 'Done by you', why: 'You sent the deck', version: 4 };

  it('stays in its slot (pure): kept until it comes back or is undone', () => {
    const prev = [card('a', 1), card('b', 2), card('c', 3)];
    const next = { doNow: { cards: [card('a', 1), card('c', 2), card('d', 3)], total: 3, elsewhere: [], elsewhereNote: '' }, closedNow: [closed] } as unknown as HomePayload;
    const kept = closedInPlace(prev, next, []);
    expect(kept.map((k) => [k.card.id, k.index])).toEqual([['b', 1]]);
    expect(cardsWithClosed(next.doNow.cards, kept).map((x) => [x.card.id, !!x.closed])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
    // reopened (back in the cards): no longer kept
    const back = { ...next, doNow: { ...next.doNow, cards: [card('a', 1), card('b', 2), card('c', 3)] } } as HomePayload;
    expect(closedInPlace(next.doNow.cards, back, kept)).toEqual([]);
  });

  it('renders the "Closed for you" tag with Undo, which reopens the item', async () => {
    const reopen = vi.fn();
    const view = { tz: 'UTC', nowMs: 0, primaryKey: null, selectedKey: null, openKey: null, openEntityId: null, panelOpen: false, select: vi.fn(), openTarget: vi.fn(), target: () => undefined, actions: { reopen, errors: {} } as never, moveLabel: 'Mon' };
    const payload = { day: 'today', nextDay: null, closedForYou: null, watching: [], capacity: { day: 'today', dayLabel: 'today', youMinToday: 0, freeMin: 0, openMin: 0, fits: true, agentMinBackground: 0, agentRunsBackground: 0, pullForward: [] }, doNow: { cards: [], total: 0, elsewhere: [], elsewhereNote: '' } } as unknown as HomePayload;
    const { container } = await render(h(HomeViewProvider, { value: view, children: null }, h(DoNow, { h: payload, kept: [{ card: card('b', 2), index: 0, closed }] })));
    const c = $('[data-testid="home-closed-card"]', container)!;
    expect(c.textContent).toContain('Closed for you');
    expect(c.textContent).toContain('You sent the deck');
    await click($('[data-testid="home-closed-undo"]', container));
    expect(reopen).toHaveBeenCalledWith({ id: 'b', version: 4 }, 'Card b');
  });
});
