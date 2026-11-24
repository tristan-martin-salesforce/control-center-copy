// @vitest-environment jsdom
/**
 * MEETING-HOVER: the hover card on Home's ribbon (and its HoverCard primitive), the ribbon's click routing (a meeting
 * opens the meeting, never its prep item), and the meeting panel's details (agenda with links, organizer, each
 * guest's answer, externals, attachments, account and opp, prep one click away). Real mock DataSource (placeholder
 * seed), fetch bridged in-process to the route handlers.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, routes, type HomeRibbon, type RouteKey } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { resetDataSourceForTests } from '@/server/datasource';
import { handle } from '@/server/http';
import { syncServerNow } from '@/ui/clock';
import { $, $$, advance, cleanup, click, render, waitFor } from '../../composer/__tests__/dom';

const opened = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/shell', async (orig) => ({ ...(await orig<typeof import('@/components/shell')>()), useRightPanel: () => ({ openDetails: opened }) }));

const { act } = await import('react');
const { HoverCard } = await import('@/ui/HoverCard');
const { DayRibbon, ribbonTarget } = await import('@/components/home/DayRibbon');
const { EventPanel } = await import('@/components/panels/EventPanel');
const { AgendaText, MeetingCard } = await import('@/components/panels/meeting');

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;
let qc: QueryClient;
let calls: string[];

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
  ds = createMockDataSource({ delays: { enrichMs: 1e8, reevalMs: 1e8, stepMs: 1e8, verifyMs: 1e8 }, autoplay: false });
  (globalThis as { __ccDataSource?: unknown }).__ccDataSource = ds;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  calls = [];
  opened.mockReset();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const m = matchRoute(method, url.pathname);
    if (!m) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route', retryable: false } }), { status: 404 });
    calls.push(m.key);
    return handle(m.key)(new Request(url, { method, headers: init?.headers, body: init?.body }), { params: Promise.resolve(m.params) });
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  resetDataSourceForTests();
  delete (window as { __ccOpenDetails?: unknown }).__ccOpenDetails;
});

const mount = (el: ReactElement) => render(h(QueryClientProvider, { client: qc }, el));
const hover = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
const leave = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
const key = (k: string) => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k })));

async function ribbon(): Promise<HomeRibbon> {
  const home = await ds.getHome({ query: {} } as never);
  syncServerNow(home.ribbon.now);
  return home.ribbon;
}

// The card's open and close delays run on fake timers (only setTimeout / clearTimeout): the test steps the clock to
// either side of each delay, so a loaded machine can neither open the card early nor close it before the hover lands.
describe('HoverCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after the delay (never at once), fires onIntent at once, stays open over the card, closes on leave, Esc and click', async () => {
    const intent = vi.fn();
    const clicked = vi.fn();
    const { container } = await mount(h(HoverCard, { content: () => h('a', { href: 'https://docs.example.com/x', 'data-in-card': '' }, 'Inside'), onIntent: intent, openDelayMs: 120, closeDelayMs: 80, children: h('button', { type: 'button', onClick: clicked }, 'Trigger') }));
    const btn = $('button', container)!;
    await hover(btn);
    expect(intent).toHaveBeenCalledTimes(1);
    expect($('[data-hovercard]')).toBeNull();
    await advance(119);
    expect($('[data-hovercard]')).toBeNull(); // not before the delay
    await advance(1);
    const card = $('[data-hovercard]')!;
    expect(card).not.toBeNull();
    expect(btn.contains(card)).toBe(false); // beside the trigger (a portal), never over or inside it
    expect(btn.getAttribute('aria-describedby')).toBe(card.id);
    // crossing into the card keeps it open; leaving the card closes it
    await leave(btn);
    await hover(card);
    await advance(150);
    expect($('[data-hovercard]')).not.toBeNull();
    await leave(card);
    await advance(79);
    expect($('[data-hovercard]')).not.toBeNull(); // the close waits its delay too
    await advance(1);
    expect($('[data-hovercard]')).toBeNull();
    // Esc closes
    await hover(btn);
    await advance(120);
    expect($('[data-hovercard]')).not.toBeNull();
    await key('Escape');
    expect($('[data-hovercard]')).toBeNull();
    // a click is the trigger's: its handler runs and the card closes (a pending open is cancelled too)
    await hover(btn);
    await advance(120);
    expect($('[data-hovercard]')).not.toBeNull();
    await click(btn);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect($('[data-hovercard]')).toBeNull();
    await hover(btn);
    await click(btn);
    await advance(200);
    expect($('[data-hovercard]')).toBeNull();
  });

  it('opens on keyboard focus too, and closes on blur', async () => {
    const { container } = await mount(h(HoverCard, { content: 'Card', openDelayMs: 50, children: h('button', { type: 'button' }, 'Trigger') }));
    const btn = $('button', container)!;
    await act(async () => btn.focus());
    expect($('[data-hovercard]')).toBeNull();
    await advance(50);
    expect($('[data-hovercard]')).not.toBeNull();
    await act(async () => btn.blur());
    expect($('[data-hovercard]')).toBeNull();
  });
});

describe('Home ribbon: meeting hover card and click routing', () => {
  it('a meeting opens the meeting, never its prep item; the open block still opens its pull-forward item', () => {
    expect(ribbonTarget({ kind: 'meeting', itemId: 'w_prep', eventId: 'ev_1', fullTitle: '13:00 Demo' })).toEqual({ kind: 'calendar_event', id: 'ev_1', label: '13:00 Demo' });
    expect(ribbonTarget({ kind: 'open', itemId: 'w_pf', eventId: null, fullTitle: 'open' })).toEqual({ kind: 'work_item', id: 'w_pf', label: 'open' });
    expect(ribbonTarget({ kind: 'open', itemId: null, eventId: null, fullTitle: 'open' })).toBeNull();
  });

  it('hovering a meeting shows who is coming, the join link, prep, read-in and the agenda; a click opens the meeting', async () => {
    const r = await ribbon();
    const demo = r.blocks.find((b) => b.eventId === 'ev_acme_demo')!;
    expect(demo.itemId).toBe('w_acme_build'); // the block still knows its prep item…
    const { container } = await mount(h(DayRibbon, { r, tz: 'America/Denver', nowMs: Date.parse(r.now) }));
    const btn = $('button[data-event-id="ev_acme_demo"]', container)!;
    expect(btn.hasAttribute('title')).toBe(false); // the card replaces the native tooltip
    // the name starts with what the block shows ("13:00 ▲ prep …", WCAG 2.5.3), then the full line (30-a11y)
    expect(btn.getAttribute('aria-label')).toMatch(/^13:00 ▲ prep ACME Phase 2 demo: /);
    expect(btn.getAttribute('aria-label')!.endsWith(demo.fullTitle)).toBe(true);

    await hover(btn);
    const card = await waitFor(() => $('[data-meeting-card="ev_acme_demo"]'));
    await waitFor(() => $('[data-card-where]', card));
    expect(calls).toContain('getCalendarEvent');
    expect($('[data-card-title]', card)?.textContent).toBe('ACME Phase 2 demo');
    expect($('[data-card-when]', card)?.textContent).toMatch(/^in /);
    expect($('[data-card-where]', card)?.textContent).toBe('ACME Corp · ACME · Headless Phase 2');
    const people = $('[data-card-people]', card)!.textContent!;
    expect(people).toContain('2 guests · 1 external');
    expect(people).toContain('you accepted');
    expect($('[data-card-person="p_dana"]', card)?.textContent).toBe('Dana Reyesorganizer · external · accepted');
    expect($('[data-card-person="p_raj"]', card)?.textContent).toBe('Raj Mehtamaybe');
    expect($('[data-card-prep]', card)?.dataset.cardPrep).toBe('todo');
    expect($('[data-card-prep]', card)?.textContent).toMatch(/Prep \d of \d ready/);
    expect($('[data-card-readin]', card)).not.toBeNull();
    expect($('[data-card-agenda]', card)?.textContent).toContain('Headless portal walkthrough');
    expect($('[data-card-join]', card)?.getAttribute('href')).toBe('https://meet.example.com/acme');
    expect($('[data-card-join]', card)?.getAttribute('rel')).toBe('noopener noreferrer');

    await click(btn);
    expect(opened).toHaveBeenCalledWith({ kind: 'calendar_event', id: 'ev_acme_demo', label: demo.fullTitle }); // …but a click opens the meeting
    expect($('[data-meeting-card]')).toBeNull();
  });

  it('my own meeting with a guest who has not answered says so', async () => {
    const r = await ribbon();
    const { container } = await mount(h(DayRibbon, { r, tz: 'America/Denver', nowMs: Date.parse(r.now) }));
    await hover($('button[data-event-id="ev_umbrella"]', container)!);
    const card = await waitFor(() => $('[data-meeting-card="ev_umbrella"]'));
    expect($('[data-card-people]', card)?.textContent).toContain('your meeting');
    expect($('[data-card-person="p_alice"]', card)?.textContent).toContain('no answer');
    expect($('[data-card-join]', card)).toBeNull(); // no conference link on this invite
  });
});

describe('meeting hover card: answers', () => {
  const guest = (id: string, response: 'accepted' | 'tentative' | 'declined' | 'needs_action', isExternal = false) => ({ id, name: `Guest ${id}`, isExternal, response });
  const meeting = (attendees: ReturnType<typeof guest>[]) =>
    ({ id: 'ev_big', title: 'Quarterly review', start: '2030-01-01T17:00:00.000Z', end: '2030-01-01T18:00:00.000Z', attendance: 'upcoming', isCustomerFacing: true, accountId: null, oppId: null, attendees, location: null, meetingUrl: null, agenda: null, organizer: null, attachments: [], prep: null, takeaways: null, source: { kind: 'calendar', label: 'Calendar', url: null } }) as never;

  it('more guests than it names: the tally covers the ones under "+N more"', async () => {
    const { container } = await mount(h(MeetingCard, { ev: meeting([guest('1', 'accepted', true), guest('2', 'declined', true), guest('3', 'accepted'), guest('4', 'accepted'), guest('5', 'needs_action'), guest('6', 'tentative')]) }));
    expect($('[data-card-people]', container)?.textContent).toContain('6 guests · 2 external');
    expect($('[data-card-answers]', container)?.textContent).toBe('3 accepted · 1 maybe · 1 declined · 1 no answer');
    expect($$('[data-card-person]', container)).toHaveLength(3);
    expect($('[data-card-people]', container)?.textContent).toContain('+3 more');
  });

  it('every guest named: each shows their own answer, no tally', async () => {
    const { container } = await mount(h(MeetingCard, { ev: meeting([guest('1', 'accepted'), guest('2', 'declined')]) }));
    expect($('[data-card-answers]', container)).toBeNull();
    expect($('[data-card-person="2"]', container)?.textContent).toContain('declined');
  });
});

describe('meeting panel', () => {
  it('shows the agenda with clickable links, the organizer, each answer, externals, attachments, account and opp', async () => {
    const spy = vi.fn();
    (window as { __ccOpenDetails?: unknown }).__ccOpenDetails = spy;
    const { container } = await mount(h(EventPanel, { eventId: 'ev_acme_demo' }));
    const agenda = await waitFor(() => $('[data-event-agenda]', container));
    expect(agenda.textContent).toContain('Service-agent handoff: Phase 3, scope only');
    const link = $('a[href="https://docs.example.com/acme-demo-script"]', agenda)!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    const dana = $('[data-attendee="p_dana"]', container)!;
    expect(dana.dataset.response).toBe('accepted');
    expect(dana.dataset.external).toBe('true');
    expect(dana.textContent).toContain('organizer');
    expect(dana.textContent).toContain('external');
    expect($('[data-attendee="p_raj"]', container)?.textContent).toContain('maybe');
    // the organizer is on the list (marked): no separate line
    expect($('[data-event-organizer]', container)).toBeNull();
    // the organizer is listed first
    expect($$('[data-attendee]', container).map((li) => li.dataset.attendee)).toEqual(['p_dana', 'p_raj']);

    const files = $('[data-event-attachments]', container)!;
    expect($('a', files)?.getAttribute('href')).toBe('https://docs.example.com/acme-demo-script');
    expect(files.textContent).toContain('Doc');
    expect((await waitFor(() => $('[data-event-deal]', container))).textContent).toContain('ACME Corp');

    // the prep task stays one click away
    const prep = await waitFor(() => $$('[data-check] button', container).find((b) => /demo-org build/i.test(b.textContent ?? '')));
    await click(prep);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_item', id: 'w_acme_build' }));
  });

  it('my own meeting says so; an unknown meeting is gone, not an error', async () => {
    const a = await mount(h(EventPanel, { eventId: 'ev_umbrella' }));
    expect((await waitFor(() => $('[data-event-organizer]', a.container))).textContent).toBe('You organized this meeting');
    expect($('[data-attendee="p_alice"]', a.container)?.textContent).toContain('no answer');
    expect($('[data-event-attachments] a', a.container)?.textContent).toContain('Umbrella architecture review deck');
    await a.unmount();
    const b = await mount(h(EventPanel, { eventId: 'ev_nope' }));
    await waitFor(() => /isn’t here any more/.test(b.container.textContent ?? ''));
  });

  it('agenda text is never parsed as HTML: markup shows as text, only http(s) and mailto become links', async () => {
    const { container } = await mount(h(AgendaText, { text: '<img src=x onerror=alert(1)> see https://docs.example.com/a, javascript:alert(1) or mailto:team@example.com' }));
    expect($('img', container)).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect($$('a', container).map((a) => a.getAttribute('href'))).toEqual(['https://docs.example.com/a', 'mailto:team@example.com']);
  });
});
