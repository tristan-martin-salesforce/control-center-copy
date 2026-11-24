/**
 * Home ▸ planning the next working day (`?day=next`): Home as that day starts. Its meetings (no now line), its capacity
 * named for it, what is due or starts then, today's open work carried over and anything moved there; no Outbox card,
 * no since-you-left. The toggle's day and the late-day nudge; "Move to …" wakes on the working day after the one shown.
 * Placeholder names only.
 */
import { describe, expect, it } from 'vitest';
import { CalendarEvent, Draft, HomePayload, WorkItem } from '@/contract';
import { buildHome } from '@/engines/home/build';
import { nextWorkingDay } from '@/engines/home/time';
import type { HomeInput } from '@/engines/home/types';
import { createMockDataSource } from '@/server/datasource/mock';

const TZ = 'America/Denver';
// MT in November is UTC−7; day 5 = Thursday 2026-11-05
const at = (hhmm: string, day = 5) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 7, m!)).toISOString();
};
const WH = { start: '07:30', end: '17:30', days: [1, 2, 3, 4, 5] };

const item = (p: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title'>): WorkItem =>
  WorkItem.parse({
    version: 1,
    kind: 'task',
    state: 'open',
    purpose: null,
    initiativeId: null,
    accountId: null,
    oppId: null,
    confidence: 'likely',
    why: 'Because',
    sources: [],
    effort: { youMin: 15, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt: at('07:00', 4),
    updatedAt: at('07:00'),
    ageDays: 1,
    rank: null,
    rankReasons: [],
    refs: { initiative: null, account: null, opp: null, meeting: null },
    ...p,
  });
const ev = (p: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'title' | 'start' | 'end'>) => CalendarEvent.parse({ attendance: 'upcoming', source: { kind: 'calendar', label: 'Calendar' }, ...p });
const ready = (id: string) =>
  Draft.parse({ id, version: 1, workItemId: null, nbaId: null, destination: { kind: 'slack', target: 'dm', channelId: `D_${id}`, channelName: '@Pat Example' }, mode: 'draft', doc: { type: 'doc', content: [] }, plainText: 'Hi Pat', rendered: {}, userTouched: false, status: 'ready', createdAt: at('08:00'), updatedAt: at('08:00') });

function day(now: string, d: Partial<HomeInput> = {}): HomeInput {
  return {
    now,
    timezone: TZ,
    workingHours: WH,
    wide: false,
    items: [
      item({ id: 'w_open_today', title: 'Write up the pilot notes', rank: 2, due: at('17:00') }),
      item({ id: 'w_prep', title: 'Prep the Globex demo', rank: 1, startBy: at('08:00', 6), due: at('09:00', 6), servesEventId: 'ev_fri' }),
      item({ id: 'w_moved', title: 'Review the sizing sheet', state: 'snoozed', snoozedUntil: at('07:30', 6), snoozedFrom: 'open', rank: 3 }),
      item({ id: 'w_done', title: 'Send the recap', state: 'done', due: at('12:00') }),
      item({ id: 'w_later', title: 'Draft the QBR deck', rank: 4, due: at('12:00', 11) }),
    ],
    nbas: [],
    drafts: [ready('d1'), ready('d2')],
    proposals: [],
    events: [
      ev({ id: 'ev_thu', title: 'Team sync', start: at('15:00'), end: at('16:00') }),
      ev({ id: 'ev_fri', title: 'Globex Demo', start: at('09:00', 6), end: at('10:00', 6), isCustomerFacing: true, prep: { ready: false, label: 'demo prep ›', workItemId: 'w_prep' } }),
    ],
    slots: [],
    initiatives: [],
    accounts: [],
    opps: [],
    missedOpps: [],
    activity: [],
    connectors: [],
    agentRuns: [],
    briefs: [],
    quarter: { label: 'Q4 FY27', targetH: 60, due: at('12:00', 30), loggedH: 10 },
    canvasLabel: 'Work-order canvas',
    since: { changed: 1, closed: 2, new: 3, show: true },
    spend: { usd: 0, softBudgetUsd: 5 },
    dryRun: true,
    capacity: { day: 'today', dayLabel: 'today', youMinToday: 30, freeMin: 300, openMin: 270, fits: true, agentMinBackground: 0, agentRunsBackground: 0, pullForward: [] },
    closedSince: null,
    ...d,
  };
}

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join('');

describe('the next working day', () => {
  it('is tomorrow on a weekday, Monday from a Friday or a weekend, named by its weekday', () => {
    const thu = nextWorkingDay(Date.parse(at('16:40')), TZ, WH);
    expect([thu.date, thu.label, thu.short, new Date(thu.startMs).toISOString()]).toEqual(['2026-11-06', 'Tomorrow', 'Fri 11/6', at('07:30', 6)]);
    const fri = nextWorkingDay(Date.parse(at('18:00', 6)), TZ, WH);
    expect([fri.date, fri.label, fri.short]).toEqual(['2026-11-09', 'Monday', 'Mon 11/9']);
    const sun = nextWorkingDay(Date.parse(at('10:00', 8)), TZ, WH);
    expect([sun.date, sun.label]).toEqual(['2026-11-09', 'Tomorrow']);
    // no working days set: every day works
    expect(nextWorkingDay(Date.parse(at('18:00', 6)), TZ, { ...WH, days: [] }).date).toBe('2026-11-07');
  });
});

describe('Home today: the toggle and the nudge', () => {
  it('names the next working day; the nudge starts an hour before the working day ends, and on days off', () => {
    const morning = buildHome(day(at('10:00')));
    expect(morning.day).toBe('today');
    expect(morning.nextDay).toMatchObject({ date: '2026-11-06', label: 'Tomorrow', short: 'Fri 11/6', startsAt: at('07:30', 6), nudge: false });
    expect(buildHome(day(at('16:29'))).nextDay!.nudge).toBe(false);
    expect(buildHome(day(at('16:30'))).nextDay!.nudge).toBe(true);
    expect(buildHome(day(at('21:00'))).nextDay!.nudge).toBe(true);
    expect(buildHome(day(at('11:00', 7))).nextDay).toMatchObject({ label: 'Monday', nudge: true }); // Saturday
  });

  it('"Move to …" wakes at the next working day’s start; a snoozed item stays off today', () => {
    const h = buildHome(day(at('16:40')));
    expect(h.moveTo).toEqual({ date: '2026-11-06', label: 'Tomorrow', short: 'Fri 11/6', startsAt: at('07:30', 6) });
    const ids = h.doNow.cards.map((c) => c.id);
    expect(ids).not.toContain('w_moved');
    expect(h.doNow.cards.every((c) => c.carried === null)).toBe(true);
    expect(h.doNow.cards.some((c) => c.kind === 'outbox')).toBe(true);
  });
});

describe('Home ▸ planning tomorrow (?day=next)', () => {
  const h = buildHome(day(at('16:40'), { day: 'next' }));

  it('is a valid payload for the planned day', () => {
    expect(HomePayload.safeParse(h).success).toBe(true);
    expect(h.day).toBe('next');
    expect(h.now).toBe(at('16:40')); // the real clock; the day shown is the masthead's
    expect(h.masthead.date).toBe(at('07:30', 6));
    expect(h.masthead.since.show).toBe(false);
    expect(h.closedForYou).toBeNull();
  });

  it('the ribbon is that day’s meetings with no "now", and the meeting missing prep is flagged', () => {
    const ids = h.ribbon.blocks.filter((b) => b.kind === 'meeting').map((b) => b.eventId);
    expect(ids).toEqual(['ev_fri']);
    expect(h.ribbon.blocks.find((b) => b.eventId === 'ev_fri')).toMatchObject({ state: 'risk', note: 'prep' });
    expect(h.ribbon.blocks.some((b) => b.state === 'now')).toBe(false);
    expect(Date.parse(h.ribbon.start)).toBeGreaterThanOrEqual(Date.parse(at('07:00', 6)));
  });

  it('Up first: that day’s work, today’s open work carried over, and what you moved there; no Outbox card', () => {
    const cards = Object.fromEntries(h.doNow.cards.map((c) => [c.id, c.carried]));
    expect(cards).toEqual({ w_prep: null, w_open_today: 'from_today', w_moved: 'moved' });
    expect(h.doNow.cards.some((c) => c.kind === 'outbox')).toBe(false);
    // the approvals are still a click away in Reply & approve
    expect(h.sections.find((s) => s.id === 'reply')!.batch).toMatchObject({ label: 'Approve 2', href: '/outbox' });
  });

  it('the sentence and the capacity name the planned day', () => {
    const s = text(h.masthead.sentence);
    expect(s.startsWith('Tomorrow turns on the 09:00')).toBe(true);
    // said once, after the list
    expect(s.match(/carried over from today/g)).toHaveLength(1);
    expect(s.endsWith('One is carried over from today.')).toBe(true);
    expect(h.capacity).toMatchObject({ day: 'next', dayLabel: 'tomorrow' });
  });

  it('"Move to …" from the planned day goes to the working day after it (Friday → Monday)', () => {
    expect(h.nextDay).toMatchObject({ date: '2026-11-06', label: 'Tomorrow' });
    expect(h.moveTo).toEqual({ date: '2026-11-09', label: 'Monday', short: 'Mon 11/9', startsAt: at('07:30', 9) });
  });

  it('from a Friday evening it plans Monday, and says so', () => {
    const mon = buildHome(day(at('18:00', 6), { day: 'next', events: [ev({ id: 'ev_mon', title: 'Initech Review', start: at('10:00', 9), end: at('11:00', 9), isCustomerFacing: true })] }));
    expect(text(mon.masthead.sentence).startsWith('Monday turns on the 10:00')).toBe(true);
    expect(mon.capacity.dayLabel).toBe('Monday');
  });

  it('when every card carried over, the sentence says so once', () => {
    const items = day(at('16:40')).items.filter((w) => w.id === 'w_open_today').concat(item({ id: 'w_open2', title: 'Reply to Pat', rank: 3, due: at('15:00') }));
    const all = buildHome(day(at('16:40'), { day: 'next', items, events: [] }));
    expect(all.doNow.cards.map((c) => c.carried)).toEqual(['from_today', 'from_today']);
    const t = text(all.masthead.sentence);
    expect(t.match(/carried over from today/g)).toHaveLength(1);
    expect(t.endsWith(', all carried over from today.')).toBe(true);
  });

  it('nothing lined up reads as such, not "nothing needs you right now"', () => {
    const empty = buildHome(day(at('16:40'), { day: 'next', items: [], events: [], drafts: [] }));
    expect(text(empty.masthead.sentence)).toBe('Nothing is lined up for tomorrow yet. Think ahead shows what is coming.');
  });
});

describe('the mock DataSource', () => {
  it('serves ?day=next with the planned day’s capacity', async () => {
    const ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
    try {
      const today = await ds.getHome({ query: { wide: false } });
      const next = await ds.getHome({ query: { wide: false, day: 'next' } });
      expect(HomePayload.safeParse(next).success).toBe(true);
      expect(next.day).toBe('next');
      expect(next.masthead.date).toBe(today.nextDay!.startsAt);
      expect(next.ribbon.blocks.every((b) => b.state !== 'now')).toBe(true);
      expect(next.doNow.cards.every((c) => c.kind === 'item')).toBe(true);
    } finally {
      ds.dispose();
    }
  });
});
