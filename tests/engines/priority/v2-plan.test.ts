/** priority@2: start-by planned backwards, prep rules, onsite days, admin batching, Make room, feedback (pure). */
import { describe, expect, it } from 'vitest';
import { adminBatchOf, adminClassOf, lowestValueSlot } from '@/engines/priority/v2/admin';
import { agreementAt3, disagreements } from '@/engines/priority/v2/compare';
import { DEFAULT_PRIORITY_CONFIG as C } from '@/engines/priority/v2/config';
import { freeMinutesBetween, planBackwards } from '@/engines/priority/v2/startby';
import { lastWorkEndBefore, onsiteDays, prepAdjust } from '@/engines/priority/v2/prep';
import { makeRoom, overbookedLabel } from '@/engines/priority/v2/capacity';
import { pairsOf, suggestRule, termAgreement, type FeedbackRowLike } from '@/engines/priority/v2/feedback';
import { isBusy } from '@/engines/priority/time';
import { personaOf } from '@/personas';
import { at, meeting } from './fixtures';

const M = 60_000;
const t = (hhmm: string, day = '2026-11-05') => Date.parse(at(hhmm, day));
const iv = (a: string, b: string, day = '2026-11-05') => ({ startMs: t(a, day), endMs: t(b, day) });
const NOW = t('09:00');

describe('planBackwards', () => {
  it('walks back from the need-by through free time', () => {
    const p = planBackwards([{ id: 'a', needByMs: t('17:00'), effortMin: 60 }], [iv('09:00', '12:00'), iv('13:00', '17:00')], { nowMs: NOW });
    expect(p.get('a')).toMatchObject({ startByMs: t('16:00'), fits: true });
  });
  it('a meeting in the way moves the start earlier (a Friday deliverable with a Thursday onsite starts Wednesday)', () => {
    const wed = [iv('09:00', '18:00', '2026-11-04')];
    const thuFree = [iv('09:00', '18:00', '2026-11-05')];
    const job = [{ id: 'd', needByMs: t('12:00', '2026-11-06'), effortMin: 6 * 60 }];
    const fri = [iv('09:00', '12:00', '2026-11-06')];
    const now = t('08:00', '2026-11-04');
    const noOnsite = planBackwards(job, [...wed, ...thuFree, ...fri], { nowMs: now }).get('d')!;
    const onsite = planBackwards(job, [...wed, ...fri], { nowMs: now }).get('d')!;
    expect(new Date(noOnsite.startByMs).toISOString().slice(0, 10)).toBe('2026-11-05');
    expect(new Date(onsite.startByMs).toISOString().slice(0, 10)).toBe('2026-11-04');
  });
  it('committed work with a nearer need-by holds the hours closest to it', () => {
    const free = [iv('09:00', '17:00')];
    const p = planBackwards(
      [
        { id: 'late', needByMs: t('17:00'), effortMin: 120 },
        { id: 'soon', needByMs: t('17:00') - 30 * M, effortMin: 60 },
      ],
      free,
      { nowMs: NOW },
    );
    expect(p.get('soon')!.startByMs).toBe(t('15:30'));
    expect(p.get('late')!.startByMs).toBe(t('14:00')); // 16:30–17:00 + 14:00–15:30
  });
  it('work that cannot fit starts now; a small shortfall keeps the plan', () => {
    const p = planBackwards([{ id: 'x', needByMs: t('11:00'), effortMin: 180 }], [iv('09:00', '11:00')], { nowMs: NOW });
    expect(p.get('x')).toMatchObject({ startByMs: NOW, fits: false, shortMin: 60 });
    const q = planBackwards([{ id: 'y', needByMs: t('11:00'), effortMin: 125 }], [iv('09:00', '11:00')], { nowMs: NOW });
    expect(q.get('y')).toMatchObject({ fits: false, shortMin: 5, startByMs: NOW });
  });
  it('small work is not split across gaps; slivers are skipped', () => {
    const p = planBackwards([{ id: 's', needByMs: t('12:00'), effortMin: 20 }], [iv('09:00', '10:00'), iv('11:50', '12:00')], { nowMs: NOW });
    expect(p.get('s')!.startByMs).toBe(t('09:40'));
  });
  it('a reserve for interrupts needs more free time', () => {
    const free = [iv('09:00', '17:00')];
    const a = planBackwards([{ id: 'a', needByMs: t('17:00'), effortMin: 60 }], free, { nowMs: NOW }).get('a')!;
    const b = planBackwards([{ id: 'a', needByMs: t('17:00'), effortMin: 60 }], free, { nowMs: NOW, reservePct: 50 }).get('a')!;
    expect(b.startByMs).toBeLessThan(a.startByMs);
  });
  it('freeMinutesBetween', () => {
    expect(freeMinutesBetween([iv('09:00', '10:00'), iv('11:00', '12:00')], t('09:30'), t('11:30'))).toBe(60);
  });
});

describe('prep rules and onsite days', () => {
  const se = personaOf({ persona: { id: 'se' } }).priority;
  const windows = [
    { start: at('09:00', '2026-11-05'), end: at('18:00', '2026-11-05') },
    { start: at('09:00', '2026-11-06'), end: at('18:00', '2026-11-06') },
    { start: at('09:00', '2026-11-09'), end: at('18:00', '2026-11-09') },
  ];
  it("a customer demo's prep inherits the meeting: high importance, ready 30 min before", () => {
    const demo = meeting('m', at('14:00', '2026-11-06'), at('15:00', '2026-11-06'), { title: 'ACME demo', hasExternalAttendees: true });
    const a = prepAdjust({ importance: 'normal' }, demo, se, { onsiteDayStarts: new Set(), windows, utcOffsetMinutes: 0 });
    expect(a).toMatchObject({ importance: 'high', needByMs: t('13:30', '2026-11-06'), rules: ['customer_build'], onsite: false });
  });
  it('an internal meeting keeps its own time and importance', () => {
    const sync = meeting('s', at('14:00'), at('15:00'), { title: 'Team sync' });
    expect(prepAdjust({ importance: 'normal' }, sync, se, { onsiteDayStarts: new Set(), windows, utcOffsetMinutes: 0 })).toMatchObject({ importance: 'normal', needByMs: t('14:00'), rules: [] });
  });
  it('onsite days pull prep forward to the end of the last working day before', () => {
    const onsite = meeting('o', at('08:00', '2026-11-09'), at('17:00', '2026-11-09'), { title: 'Globex onsite workshop', hasExternalAttendees: true });
    const days = onsiteDays([onsite], se, 0, isBusy);
    expect([...days]).toEqual([Date.parse('2026-11-09T00:00:00.000Z')]);
    const a = prepAdjust({ importance: 'normal' }, onsite, se, { onsiteDayStarts: days, windows, utcOffsetMinutes: 0 });
    expect(a).toMatchObject({ onsite: true, needByMs: t('18:00', '2026-11-06') });
    expect(lastWorkEndBefore(Date.parse('2026-11-09T00:00:00.000Z'), windows)).toBe(t('18:00', '2026-11-06'));
  });
});

describe('admin batching', () => {
  const se = personaOf({ persona: { id: 'se' } }).priority;
  it('classifies admin by the persona’s rules, never the customer work', () => {
    expect(adminClassOf({ kind: 'task', title: "Log this week's time to Org62" }, se)).toBe('logging');
    expect(adminClassOf({ kind: 'task', title: 'Add the deck to the ACME VDP' }, se)).toBe('vdp');
    expect(adminClassOf({ kind: 'training', title: 'Privacy refresh' }, se)).toBe('training');
    expect(adminClassOf({ kind: 'task', title: 'Build the ACME demo' }, se)).toBeNull();
    expect(adminClassOf({ kind: 'task', title: 'anything', adminClass: 'expense' }, se)).toBe('expense');
  });
  it('one block: promoted when due within 48 h, placed in the lowest-value free slot', () => {
    const todayFree = [iv('10:00', '11:00'), iv('15:00', '16:00')];
    const committed = [{ placed: [iv('10:00', '11:00')], value: 90 }];
    const b = adminBatchOf(
      [
        { id: 'log', title: 'Log time', cls: 'logging', youMin: 30, dueMs: t('16:00'), startByMs: t('15:00'), late: false },
        { id: 'vdp', title: 'VDP deck', cls: 'vdp', youMin: 15, dueMs: t('17:00', '2026-11-20'), startByMs: null, late: false },
      ],
      { nowMs: NOW, todayEndMs: t('23:59'), utcOffsetMinutes: 0, promoteWithinH: 48, todayFree, committed },
    )!;
    expect(b).toMatchObject({ count: 2, promoted: true, promotedIds: ['log'], youMin: 30, totalMin: 45 });
    expect(b.slot).toEqual({ start: at('15:00'), end: at('15:30') });
    expect(b.label).toBe('Admin: 2 items · ~30m today (1 of 2) · next due 16:00');
  });
  it('quiet when nothing is due soon', () => {
    const b = adminBatchOf([{ id: 'vdp', title: 'VDP', cls: 'vdp', youMin: 15, dueMs: t('17:00', '2026-11-20'), startByMs: t('16:00', '2026-11-20'), late: false }], { nowMs: NOW, todayEndMs: t('23:59'), utcOffsetMinutes: 0, promoteWithinH: 48, todayFree: [], committed: [] })!;
    expect(b.promoted).toBe(false);
    expect(b.slot).toBeNull();
  });
  it('lowestValueSlot prefers the slot the plan values least, then the later one', () => {
    expect(lowestValueSlot([iv('10:00', '11:00'), iv('14:00', '15:00')], [], 20)).toEqual(iv('14:00', '14:20'));
    expect(lowestValueSlot([], [], 20)).toBeNull();
  });
});

describe('capacity honesty', () => {
  it('"Overbooked by N min" everywhere', () => {
    expect(overbookedLabel(45)).toBe('Overbooked by 45 min');
    expect(overbookedLabel(0.2)).toBe('Overbooked by 1 min');
  });
  it('Make room: lowest value first, latest deadline first among equals, until the overflow is covered', () => {
    const r = makeRoom(
      [
        { id: 'big', title: 'Big', youMin: 90, value: 90, needByMs: t('17:00') },
        { id: 'low-late', title: 'Low later', youMin: 30, value: 20, needByMs: t('17:00', '2026-11-09') },
        { id: 'low-soon', title: 'Low sooner', youMin: 30, value: 20, needByMs: t('17:00') },
        { id: 'pinned', title: 'Pinned', youMin: 60, value: 1, needByMs: null, locked: true },
      ],
      45,
      { nowMs: NOW, utcOffsetMinutes: 0 },
    )!;
    expect(r.rows.map((x) => x.itemId)).toEqual(['low-late', 'low-soon']);
    expect(r).toMatchObject({ overByMin: 45, label: 'Overbooked by 45 min', freesMin: 60 });
    expect(makeRoom([], 0, { nowMs: NOW, utcOffsetMinutes: 0 })).toBeNull();
  });
});

describe('shadow comparison', () => {
  it('agreement@3 and the biggest disagreements', () => {
    expect(agreementAt3(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(1);
    expect(agreementAt3(['a', 'b', 'c'], ['a', 'x', 'y'])).toBe(0.33);
    const d = disagreements(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'], (id) => id.toUpperCase());
    expect(d[0]).toEqual({ workItemId: 'd', title: 'D', v1Rank: 4, v2Rank: 1, delta: 3 });
  });
});

describe('feedback → per-term agreement → one suggestion', () => {
  const row = (action: FeedbackRowLike['action'], from: number, to: number | null, me: Record<string, number>, others: Array<[number, Record<string, number>]>): FeedbackRowLike => ({
    action,
    fromRank: from,
    toRank: to,
    snapshot: { item: { id: 'me', rank: from, terms: me }, neighbours: others.map(([rank, terms], i) => ({ id: `n${i}`, rank, terms })) },
  });
  it('a "do first" pairs the item with everything ranked above it; a snooze with what is below', () => {
    expect(pairsOf(row('do_first', 3, 1, { deal: 0.3 }, [[1, { deal: 0.9 }], [2, { deal: 0.7 }], [4, { deal: 0.1 }]]))).toHaveLength(2);
    expect(pairsOf(row('snooze', 2, null, { deal: 0.9 }, [[1, { deal: 0.1 }], [3, { deal: 0.2 }], [4, { deal: 0.3 }]]))).toHaveLength(2);
  });
  it('a term that keeps pointing the wrong way becomes one bounded suggestion', () => {
    // the user keeps doing the urgent, smaller-deal item first
    const rows = Array.from({ length: 8 }, () => row('do_first', 2, 1, { deal: 0.3, urgency: 1 }, [[1, { deal: 0.9, urgency: 0.3 }]]));
    const ag = termAgreement(rows);
    expect(ag.find((a) => a.term === 'deal')).toMatchObject({ agree: 0, disagree: 8, rate: 0 });
    expect(ag.find((a) => a.term === 'urgency')).toMatchObject({ agree: 8, disagree: 0, rate: 1 });
    const s = suggestRule(ag)!;
    expect(s).toMatchObject({ term: 'deal', counterTerm: 'urgency', nudge: { target: 'deal', direction: -1 }, pairs: 8 });
    expect(s.text).toBe('The model keeps ranking bigger deals above the most urgent work; you keep doing the most urgent work first (8 of 8 times).');
  });
  it('nothing stands out with few pairs or mixed signals', () => {
    expect(suggestRule(termAgreement([row('do_first', 2, 1, { deal: 0.3 }, [[1, { deal: 0.9 }]])]))).toBeNull();
    expect(suggestRule([])).toBeNull();
  });
  it('urgency disagreeing raises the urgency floor (value counts more)', () => {
    const rows = Array.from({ length: 6 }, () => row('do_first', 2, 1, { deal: 0.9, urgency: 0.2 }, [[1, { deal: 0.3, urgency: 1 }]]));
    expect(suggestRule(termAgreement(rows))!.nudge).toEqual({ target: 'urgencyFloor', direction: 1 });
  });
  it('defaults are sane', () => {
    expect(C.weights.who + C.weights.deal + C.weights.kind + C.weights.importance + C.weights.goal).toBe(100);
  });
});
