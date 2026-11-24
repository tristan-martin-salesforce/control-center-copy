/**
 * Today v2 pure model: timeline geometry, capacity (today-scoped hands-on only, never a false "over"),
 * the run-of-day / fit-in / pull-forward sections and the agent's plan diff. Placeholder data only
 * (synthetic events, or the committed example seed through the mock DataSource).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Seed, TodayPayload, type CalendarEvent } from '@/contract';
import { MockDataSource } from '@/server/datasource/mock';
import { freeMinutesLeft, normalizePullForward, resolveCapacity } from './capacity';
import { planChanges, summarize } from './plan';
import { buildSections, isTodayScoped } from './rows';
import { dueLabel, hm, approx, minuteOfDay } from './time';
import { freeIntervals, layoutDay } from './timeline';

const TZ = 'America/Denver';
// Thu 5 Nov 2026 08:22 MT = 15:22Z
const NOW = '2026-11-05T15:22:00.000Z';
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 10, 5, h + 7, m)).toISOString();
};

function ev(id: string, start: string, end: string, attendance: CalendarEvent['attendance'] = 'upcoming'): CalendarEvent {
  return {
    id,
    title: `Meeting ${id}`,
    start: at(start),
    end: at(end),
    attendance,
    isCustomerFacing: false,
    accountId: null,
    oppId: null,
    attendees: [],
    location: null,
    meetingUrl: null,
    agenda: null,
    organizer: null,
    attachments: [],
    prep: null,
    takeaways: null,
    source: { kind: 'calendar', label: 'Calendar' },
  } as CalendarEvent;
}

describe('time helpers', () => {
  it('formats durations and estimates', () => {
    expect(hm(90)).toBe('1h 30m');
    expect(hm(300)).toBe('5h');
    expect(approx(392)).toBe('~6h 30m');
    expect(minuteOfDay(NOW, TZ)).toBe(8 * 60 + 22);
  });
  it('reads "Sat 00:00" as due Friday', () => {
    expect(dueLabel(at('17:00'), NOW, TZ)).toBe('17:00');
    expect(dueLabel(new Date(Date.UTC(2026, 10, 7, 7, 0)).toISOString(), NOW, TZ)).toBe('Fri');
    expect(dueLabel('2026-12-04T12:00:00Z', NOW, TZ)).toBe('12/4');
  });
});

describe('timeline layout', () => {
  const base = { nowIso: NOW, tz: TZ, workStart: 7 * 60 + 30, workEnd: 17 * 60 + 30, agent: [], hints: [], suggestion: null };

  it('frees time around meetings and merges overlaps', () => {
    expect(freeIntervals(0, 100, [{ s: 10, e: 20 }, { s: 15, e: 30 }, { s: 50, e: 60 }])).toEqual([
      { s: 0, e: 10 },
      { s: 30, e: 50 },
      { s: 60, e: 100 },
    ]);
  });

  it('spans working hours from the first hour of the day and puts declined meetings in the side lane', () => {
    const l = layoutDay({ ...base, events: [ev('a', '08:00', '08:30', 'in_progress'), ev('d', '09:30', '10:30', 'declined'), ev('b', '10:00', '11:00')], work: [] });
    expect(l.start).toBe(8 * 60);
    expect(l.end).toBe(17 * 60 + 30);
    const declined = l.blocks.find((b) => b.type === 'meeting' && b.id === 'd')!;
    const b = l.blocks.find((x) => x.type === 'meeting' && x.id === 'b')!;
    expect(declined.type === 'meeting' && declined.side).toBe(true);
    expect(b.narrow).toBe(true); // shares 10:00–10:30 with the declined block
    const live = l.blocks.find((x) => x.type === 'meeting' && x.id === 'a');
    expect(live?.type === 'meeting' && live.live).toBeCloseTo(22 / 30, 2);
  });

  it('labels gaps with a fit-in that fits and places the suggestion in the largest open gap', () => {
    const l = layoutDay({
      ...base,
      events: [ev('a', '08:00', '08:30', 'in_progress'), ev('b', '10:00', '11:00'), ev('c', '13:30', '14:30')],
      work: [{ id: 'w1', itemId: 'i1', start: at('08:35'), end: at('08:55'), label: '08:35 ▶ Smoke test' }],
      hints: [{ key: 'fit:a', title: 'Approve 3 drafts', minutes: 6 }],
      suggestion: { key: 'pull:x', itemId: 'x', title: 'Q4 log', minutes: 30 },
    });
    const gaps = l.blocks.filter((b) => b.type === 'gap');
    expect(gaps[0]?.type === 'gap' && gaps[0].hintTitle).toBe('Approve 3 drafts');
    expect(l.hintAt.get('fit:a')).toBe(8 * 60 + 55);
    expect(l.suggestionAt).toBe(14 * 60 + 30); // the 14:30–17:30 afternoon is the largest gap
    const tail = gaps[gaps.length - 1];
    expect(tail?.type === 'gap' && tail.tail).toBe(true);
  });
});

describe('capacity', () => {
  it('counts free time outside meetings you attend, from now', () => {
    const events = [ev('a', '08:00', '08:30', 'in_progress'), ev('d', '09:30', '10:30', 'declined'), ev('b', '10:00', '11:00'), ev('c', '13:30', '15:00')];
    // 08:22–17:30 = 548 min, minus 8 + 60 + 90 attended
    expect(freeMinutesLeft(events, NOW, TZ, 450, 1050)).toBe(548 - 8 - 60 - 90);
  });

  it('fits unless today-scoped hands-on work exceeds the free time; engine fields win', () => {
    const legacy = { focusMinLeft: 150, plannedMin: 645, overByMin: 495 };
    const derived = resolveCapacity(legacy, { youMin: 90, freeMin: 390, agentMin: 20, agentRuns: 1 });
    expect(derived).toMatchObject({ fits: true, openMin: 300, overByMin: 0, fromEngine: false });
    const over = resolveCapacity(legacy, { youMin: 420, freeMin: 390, agentMin: 0, agentRuns: 0 });
    expect(over).toMatchObject({ fits: false, overByMin: 30 });
    const engine = resolveCapacity({ ...legacy, youMinToday: 80, freeMin: 400, openMin: 320, fits: true, agentMinBackground: 25, agentRunsBackground: 2 }, { youMin: 999, freeMin: 1, agentMin: 0, agentRuns: 0 });
    expect(engine).toMatchObject({ youMin: 80, freeMin: 400, openMin: 320, fits: true, agentMin: 25, agentRuns: 2, fromEngine: true });
  });

  it('reads pull-forward refs in any reasonable shape', () => {
    expect(normalizePullForward(undefined)).toBeNull();
    const refs = normalizePullForward(['w1', { itemId: 'w2', youMin: 30, due: at('12:00'), reason: 'Due Fri' }, { item: { id: 'w3', title: 'T', effort: { youMin: 15 } } }, 7]);
    expect(refs?.map((r) => r.itemId)).toEqual(['w1', 'w2', 'w3']);
    expect(refs?.[1]).toMatchObject({ youMin: 30, why: 'Due Fri' });
    expect(refs?.[2]).toMatchObject({ title: 'T', youMin: 15 });
  });
});

describe('sections and plan on the mock (placeholder seed)', () => {
  const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../mock/seed.example.json'), 'utf8')));
  const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };
  let ds: MockDataSource;
  beforeEach(() => {
    ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
  });
  afterEach(() => ds.dispose());

  it('run of day holds only today-scoped work; the rest is pull forward, never load', async () => {
    const t = TodayPayload.parse(await ds.getToday({} as never));
    const tz = undefined;
    const s = buildSections({ data: t, cards: t.nowStack.cards, rows: t.moreToday.items, nowIso: t.now, tz, slots: t.spine.slots, pinned: new Set(), pullForward: null });
    for (const r of s.run) expect(isTodayScoped(r.item!, t.now, tz, s.planned)).toBe(true);
    for (const r of s.pull) expect(isTodayScoped(r.item!, t.now, tz, s.planned)).toBe(false);
    const runIds = new Set(s.run.map((r) => r.item!.id));
    expect(s.pull.every((r) => !runIds.has(r.item!.id))).toBe(true);
    expect(s.pull.length).toBeLessThanOrEqual(4);
    expect(s.pull.every((r) => r.verb === 'Pull in')).toBe(true);
    // Every row opens something in the panel.
    for (const r of [...s.run, ...s.fit, ...s.pull]) expect(r.entity.id).toBeTruthy();
    // A broken connector becomes a red fit-in with Re-auth.
    for (const b of t.health.broken) expect(s.fit.some((r) => r.key === `fit:reauth:${b.id}` && r.tone === 'overdue')).toBe(true);
  });

  it('run rows show the ranking\'s two-part why and keep the extractor sentence as the detail (lane 07 R7, R1)', async () => {
    const t = TodayPayload.parse(await ds.getToday({} as never));
    const s = buildSections({ data: t, cards: t.nowStack.cards, rows: t.moreToday.items, nowIso: t.now, tz: TZ, slots: t.spine.slots, pinned: new Set(), pullForward: null, workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5] } });
    expect(s.run.length).toBeGreaterThan(0);
    for (const r of s.run) {
      if (!r.whyParts) continue;
      const sentence = r.card?.nba?.why ?? r.item!.why;
      expect(r.whyDetail ?? '').toContain(sentence);
      if (r.whyParts.now) expect(r.why.toLowerCase()).toContain(r.whyParts.now.toLowerCase());
    }
    expect(s.run.some((r) => r.whyParts)).toBe(true);
    // a late item: "N d late · …", never "start by"
    const late = { ...t.nowStack.cards[0]!.item, state: 'open' as const, due: '2026-11-03T22:00:00.000Z', dueKind: 'soft' as const, startBy: '2026-11-03T20:00:00.000Z', userLockedFields: [], loopedBackIn: null };
    const s2 = buildSections({ data: t, cards: [], rows: [], extras: [], nowIso: NOW, tz: TZ, slots: [], pinned: new Set([late.id]), pullForward: null, catalog: new Map([[late.id, late]]) });
    const row = s2.run.find((r) => r.item!.id === late.id)!;
    expect(row.whyParts!.now).toBe('2 d late · re-date or drop');
    expect(row.why).not.toMatch(/start by/i);
  });

  it('today scope mirrors the engine: due today, pinned start-by, start-by today for later work (tomorrow too); not overdue', async () => {
    const t = TodayPayload.parse(await ds.getToday({} as never));
    const base = { ...t.nowStack.cards[0]!.item, state: 'open' as const, startBy: null, due: null, userLockedFields: [], reopened: null, loopedBackIn: null };
    const day = (d: number, h: number) => new Date(Date.UTC(2026, 10, d, h + 7, 0)).toISOString(); // MT wall clock
    const none = new Set<string>();
    expect(isTodayScoped({ ...base, due: day(5, 17) }, NOW, TZ, none)).toBe(true);
    expect(isTodayScoped({ ...base, due: day(5, 8) }, NOW, TZ, none)).toBe(true); // earlier today still counts
    expect(isTodayScoped({ ...base, due: day(6, 12) }, NOW, TZ, none)).toBe(false); // tomorrow's work
    expect(isTodayScoped({ ...base, due: day(3, 12) }, NOW, TZ, none)).toBe(false); // overdue from an earlier day
    expect(isTodayScoped({ ...base, due: day(9, 12), startBy: day(5, 9) }, NOW, TZ, none)).toBe(true);
    // PRIO-3 (lane 07): due tomorrow but its start-by is today, so it must start today: today's load
    expect(isTodayScoped({ ...base, due: day(6, 12), startBy: day(5, 9) }, NOW, TZ, none)).toBe(true);
    expect(isTodayScoped({ ...base, due: day(6, 12), startBy: day(6, 9) }, NOW, TZ, none)).toBe(false);
    expect(isTodayScoped({ ...base, due: day(6, 12), startBy: day(5, 15), userLockedFields: ['startBy'] }, NOW, TZ, none)).toBe(true); // Pull in
    expect(isTodayScoped({ ...base, state: 'likely_done', due: day(5, 17) }, NOW, TZ, none)).toBe(false);
    expect(isTodayScoped({ ...base }, NOW, TZ, new Set([base.id]))).toBe(true); // planned today
  });

  it('the plan diff groups the engine slots per item and counts what stays in', async () => {
    const t = TodayPayload.parse(await ds.getToday({} as never));
    const items = new Map([...t.nowStack.cards.map((c) => [c.item.id, c.item] as const), ...t.moreToday.items.map((i) => [i.id, i] as const)]);
    const changes = planChanges({ nowIso: t.now, slots: t.spine.slots, cards: t.nowStack.cards, items, agentAlongside: new Set(), deferred: [], rerankReady: 2, todayIds: new Set() });
    const added = changes.filter((c) => c.kind === 'added');
    expect(new Set(added.map((c) => c.itemId ?? c.id)).size).toBe(added.length);
    expect(changes.some((c) => c.kind === 'rerank')).toBe(true);
    const all = summarize(changes, new Set());
    const less = summarize(changes, new Set([changes[0]!.id]));
    expect(all[changes[0]!.kind] - less[changes[0]!.kind]).toBe(1);
  });
});
