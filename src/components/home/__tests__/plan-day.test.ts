// @vitest-environment jsdom
/**
 * Home ▸ planning the next working day, the client side: the Today / next-day toggle on the masthead (it asks for the
 * day; Home never switches by itself), the late-day "Plan tomorrow →" nudge, the planned day's masthead and ribbon
 * (no now line), and the lead line ("Up first": what the day starts with, what carried over). Placeholders only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeCard, HomeMasthead, HomeNextDay, HomePayload, HomeRibbon } from '@/contract';
import { $, $$, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/shell', async (orig) => ({ ...(await orig<typeof import('@/components/shell')>()), useRightPanel: () => ({ openDetails: vi.fn() }) }));

const { Masthead } = await import('../Masthead');
const { DayRibbon } = await import('../DayRibbon');
const { leadNote } = await import('../DoNow');
const { homeDayHref } = await import('../HomePage');

afterEach(cleanup);

const TZ = 'America/Denver';
const mast = (date: string, show = true): HomeMasthead => ({ sentence: [{ text: 'Today turns on the review.', em: false, mark: null }], date, timezone: TZ, tzLabel: 'MT', since: { changed: 1, closed: 2, new: 3, show }, ahead: [] });
const next = (nudge: boolean): HomeNextDay => ({ date: '2026-11-06', label: 'Tomorrow', short: 'Fri 11/6', startsAt: '2026-11-06T14:30:00.000Z', nudge });
const wrap = (el: ReturnType<typeof h>) => h(QueryClientProvider, { client: new QueryClient() }, el);

describe('the masthead', () => {
  it('today: the toggle asks for the next day; the nudge only shows late in the day', async () => {
    const onDay = vi.fn();
    const { container } = await render(h(Masthead, { m: mast('2026-11-05T23:40:00.000Z'), nowMs: Date.parse('2026-11-05T23:40:00.000Z'), day: 'today', next: next(true), onDay }));
    const radios = $$('[role="radio"]', container);
    expect(radios.map((r) => r.textContent)).toEqual(['Today', 'Tomorrow']);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    await click(radios[1]);
    expect(onDay).toHaveBeenLastCalledWith('next');
    const nudge = $('[data-testid="home-plan-nudge"]', container)!;
    expect(nudge.textContent).toBe('Look ahead · Plan tomorrow →');
    await click(nudge.querySelector('button'));
    expect(onDay).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Since you left');
  });

  it('"Since you left: N changed…" opens the Since you left list', async () => {
    const digest = {
      since: '2026-11-05T15:00:00.000Z',
      until: '2026-11-05T23:40:00.000Z',
      awayMinutes: 520,
      show: true,
      counts: { changed: 1, closed: 2, new: 3, reopened: 0 },
      entries: [{ at: '2026-11-05T20:00:00.000Z', kind: 'closed', title: 'Send ACCOUNT_1 the recap', detail: 'Closed for you', ref: { type: 'work_item', id: 'w_1', label: 'Send ACCOUNT_1 the recap' }, auditId: null }],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(digest), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    try {
      const { container } = await render(wrap(h(Masthead, { m: mast('2026-11-05T23:40:00.000Z'), nowMs: Date.parse('2026-11-05T23:40:00.000Z'), day: 'today', next: next(false), onDay: vi.fn() })));
      const btn = $('[data-testid="home-since"]', container)!;
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.textContent).toBe('Since you left: 1 changed · 2 closed · 3 new');
      expect(fetch).not.toHaveBeenCalled(); // the digest loads on open
      await click(btn);
      const list = await waitFor(() => (document.querySelector('[data-testid="home-since-list"]')?.textContent?.includes('Send ACCOUNT_1 the recap') ? document.querySelector('[data-testid="home-since-list"]') : null));
      expect(list!.textContent).toContain('2 closed');
      expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/since/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('no nudge earlier in the day', async () => {
    const { container } = await render(h(Masthead, { m: mast('2026-11-05T17:00:00.000Z'), nowMs: Date.parse('2026-11-05T17:00:00.000Z'), day: 'today', next: next(false), onDay: vi.fn() }));
    expect($('[data-testid="home-plan-nudge"]', container)).toBeNull();
  });

  it('planning: names the day and its start, never the clock or a nudge; the toggle shows the request at once', async () => {
    const { container } = await render(h(Masthead, { m: mast('2026-11-06T14:30:00.000Z', false), nowMs: Date.parse('2026-11-05T23:40:00.000Z'), day: 'next', next: next(true), requested: 'next', onDay: vi.fn() }));
    expect(container.textContent).toContain('Planning Friday 6 November · starts 07:30 MT');
    expect($('[data-testid="home-plan-nudge"]', container)).toBeNull();
    expect($$('[role="radio"]', container)[1]!.getAttribute('aria-checked')).toBe('true');
    expect($('[data-home-panel="masthead"]', container)!.getAttribute('aria-label')).toBe('Tomorrow in one sentence');
  });

  it('the URL names the day: /?day=next, and / for today', () => {
    expect(homeDayHref('next')).toBe('/?day=next');
    expect(homeDayHref('today')).toBe('/');
  });
});

describe('the ribbon', () => {
  const r: HomeRibbon = {
    start: '2026-11-06T14:00:00.000Z',
    end: '2026-11-07T00:30:00.000Z',
    now: '2026-11-06T14:30:00.000Z',
    blocks: [{ id: 'e1', kind: 'meeting', start: '2026-11-06T16:00:00.000Z', end: '2026-11-06T17:00:00.000Z', title: 'Globex demo', fullTitle: '09:00 Globex demo · 1h', itemId: null, eventId: 'e1', state: 'risk', note: 'prep', star: false }],
  };
  it('planning draws no now line or past shade, and starts the axis at the day start', async () => {
    const { container } = await render(wrap(h(DayRibbon, { r, tz: TZ, nowMs: Date.parse('2026-11-05T23:40:00.000Z'), plan: 'Tomorrow' })));
    expect($('.hm-nowline', container)).toBeNull();
    expect($('.hm-past', container)).toBeNull();
    expect($('.hm-axis .is-now', container)).toBeNull();
    expect($('.hm-axis .is-start', container)!.textContent).toBe('07:00');
    expect($('[data-home-panel="ribbon"]', container)!.getAttribute('aria-label')).toMatch(/^Tomorrow's calendar/);
  });
  it('today keeps them', async () => {
    const { container } = await render(wrap(h(DayRibbon, { r, tz: TZ, nowMs: Date.parse('2026-11-06T18:00:00.000Z') })));
    expect($('.hm-nowline', container)).not.toBeNull();
  });
});

describe('the lead line', () => {
  const card = (id: string, carried: HomeCard['carried']) => ({ id, kind: 'item', carried }) as HomeCard;
  const base = (cards: HomeCard[], day: HomePayload['day']) => ({ day, nextDay: next(false), doNow: { total: cards.length, cards, elsewhere: [], elsewhereNote: '' } });
  it('planning says what the day starts with and what carried over', () => {
    expect(leadNote(base([card('a', null), card('b', 'from_today'), card('c', 'moved')], 'next'))).toBe('What tomorrow starts with · 1 carried over from today, 1 moved here.');
    expect(leadNote(base([card('a', null)], 'next'))).toBe('What tomorrow starts with.');
    expect(leadNote(base([], 'next'))).toBe('Nothing lined up for tomorrow yet.');
    expect(leadNote(base([card('a', null)], 'today'))).toBe('Top 1 of 1.');
  });
});
