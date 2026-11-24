/**
 * priority@1.1 (lane 07 R1, R2, R7): overdue decay by working days, re-date for soft dates, likely-done out of the
 * ranking, the deal tiers, the dropped inputs (importance, dueKind, askedAt, tier, from-manager) and the two-part why.
 * Placeholder names; Thu 2026-11-05 UTC, working hours 09:00–18:00 Mon–Fri.
 */
import { describe, expect, it } from 'vitest';
import type { Evidence, WorkItemRecord } from '@/contract';
import { SE_IC_POLICY } from './policy';
import { rankWork } from './rank';
import { dealValueFeature } from './score';
import { PRIORITY_ENGINE_VERSION, type PriorityInputs } from './types';
import { lateState, whyLine, whyOfItem } from './why';
import { priorityItemsFrom, tierFor } from './inputs';
import type { PriorityItem, WorkingHours } from '@/engines/types';

const at = (hhmm: string, day = '2026-11-05'): string => `${day}T${hhmm}:00.000Z`;
const HOURS: WorkingHours = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], utcOffsetMinutes: 0 };
const item = (id: string, over: Partial<PriorityItem> = {}): PriorityItem => ({ id, title: id, kind: 'task', status: 'open', effort: { youMin: 30, agentMin: 0 }, createdAt: at('08:00', '2026-11-01'), ...over });
const inputs = (over: Partial<PriorityInputs> = {}): PriorityInputs => ({ now: at('09:00'), items: [], meetings: [], policy: SE_IC_POLICY, workingHours: HOURS, ...over });

describe('R1: overdue semantics', () => {
  it('bumps the engine version', () => {
    expect(PRIORITY_ENGINE_VERSION).toBe('priority@1.1');
    expect(rankWork(inputs()).engineVersion).toBe('priority@1.1');
  });

  it('a hard deadline keeps full urgency for one working day, then decays to 0.6 with "Late: do now or re-date"', () => {
    const due = Date.parse(at('17:00', '2026-11-04')); // Wed 17:00
    // Thu 09:00: 1 working hour (17:00–18:00) after the deadline, inside the grace day
    expect(lateState(due, Date.parse(at('09:00')), 'hard', HOURS)).toMatchObject({ kind: 'grace', urgency: 1, label: '1 d late', verb: null });
    // Thu 16:59: 8 h59m working, still grace; Thu 17:00 = 9 h = one working day → late
    expect(lateState(due, Date.parse(at('16:59')), null, HOURS)!.kind).toBe('grace');
    expect(lateState(due, Date.parse(at('17:00')), null, HOURS)).toMatchObject({ kind: 'late', urgency: 0.6, verb: 'Late: do now or re-date' });
  });

  it('the grace day counts the persona’s working days: Friday 17:00 is still in grace on Monday morning', () => {
    const due = Date.parse(at('17:00', '2026-11-06')); // Fri
    expect(lateState(due, Date.parse(at('10:00', '2026-11-09')), 'hard', HOURS)).toMatchObject({ kind: 'grace', label: '3 d late' });
    // a persona that works Saturdays has used its grace by Monday
    const sat: WorkingHours = { ...HOURS, days: [1, 2, 3, 4, 5, 6] };
    expect(lateState(due, Date.parse(at('10:00', '2026-11-09')), 'hard', sat)!.kind).toBe('late');
    // and the timezone matters: 09:00–18:00 at UTC−7 starts at 16:00Z
    const mt: WorkingHours = { ...HOURS, utcOffsetMinutes: -420 };
    expect(lateState(Date.parse(at('00:00', '2026-11-05')), Date.parse(at('15:00', '2026-11-05')), 'hard', mt)!.kind).toBe('grace');
  });

  it('soft and inferred dates drop to 0.4 at once with "Re-date or drop"', () => {
    for (const k of ['soft', 'inferred'] as const) {
      expect(lateState(Date.parse(at('08:00')), Date.parse(at('09:00')), k, HOURS)).toMatchObject({ kind: 'redate', urgency: 0.4, label: '1h late', verb: 'Re-date or drop' });
    }
  });

  it('scores late items by their late state, says "2 d late" (never "start by Mon"), and decays a 2-day-late chore', () => {
    const r = rankWork(
      inputs({
        items: [
          item('chore', { title: 'Send the value recap', kind: 'ask', due: at('17:00', '2026-11-03'), effort: { youMin: 30, agentMin: 120 } }),
          item('soft', { title: 'Send the notes', due: at('12:00', '2026-11-04'), dueKind: 'soft' }),
          item('build', { title: 'Build the demo', kind: 'commitment', due: at('10:00', '2026-11-06'), effort: { youMin: 150, agentMin: 0 }, oppAmount: 780_000, stakeholders: [{ name: 'Brendan', isExternal: true }] }),
        ],
      }),
    );
    const chore = r.scores.chore!;
    expect(chore.late).toMatchObject({ kind: 'late', label: '2 d late' });
    expect(chore.components.find((c) => c.key === 'deadlineProximity')!.feature).toBe(0.6);
    expect(chore.components.find((c) => c.key === 'leadTime')!.points).toBe(0); // "kick off early" means nothing once late
    expect(chore.startBy).toBeNull();
    expect(chore.explanation).not.toMatch(/start by/);
    expect(chore.why.now).toBe('2 d late · late: do now or re-date');
    expect(r.scores.soft!.why.now).toBe('1 d late · re-date or drop'); // yesterday 12:00: a local day ago
    expect(r.scores.soft!.components.find((c) => c.key === 'calendarPressure')!.feature).toBe(0.4);
    // the same chore inside its grace day weighs 60 − 36 = 24 points more (both time terms at 1 instead of 0.6)
    const fresh = rankWork(inputs({ now: at('09:00', '2026-11-04'), items: [item('chore', { kind: 'ask', due: at('17:00', '2026-11-03'), effort: { youMin: 30, agentMin: 120 } })] })).scores.chore!;
    expect(fresh.late!.kind).toBe('grace');
    expect(fresh.total - chore.total).toBeGreaterThan(20);
    // (the demo build overtaking it outright is priority@2's job: value × urgency; see the golden days)
  });

  it('likely-done items are not ranked: they wait in Looks done', () => {
    const r = rankWork(inputs({ items: [item('a'), item('ld', { status: 'likely_done', due: at('08:00') })] }));
    expect(r.ranked.map((s) => s.workItemId)).toEqual(['a']);
    expect(r.excluded).toContainEqual({ workItemId: 'ld', reason: 'Looks done: waiting for your confirm' });
  });
});

describe('R2: deal tiers', () => {
  it('is monotone and no longer saturates at $500k', () => {
    const xs = [0, 50_000, 100_000, 499_999, 500_000, 999_999, 1_000_000, 2_000_000, 3_000_000, 9_000_000].map(dealValueFeature);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(dealValueFeature(2_000_000)).toBeGreaterThan(dealValueFeature(500_000));
    expect(dealValueFeature(0)).toBe(0);
  });
});

describe('R2: the shared input builder', () => {
  const rec = (id: string, over: Partial<WorkItemRecord> = {}) =>
    ({
      id,
      title: id,
      kind: 'ask',
      state: 'open',
      due: null,
      effort: { youMin: 10, agentMin: 0 },
      people: [],
      counterparty: null,
      accountId: null,
      oppId: null,
      initiativeId: null,
      servesEventId: null,
      createdAt: at('09:00'),
      isBackground: false,
      signals: { customerFacing: false, fromManager: false, boost: 0 },
      training: null,
      sources: [],
      ...over,
    }) as WorkItemRecord;
  const hana = { id: 'p-hana', name: 'Hana Lind' };
  const val = { id: 'p-val', name: 'Valentina Ruiz' };
  const people: Record<string, { isManager?: boolean; isExternal?: boolean; tier?: 'customer_exec' | 'normal'; title?: string }> = {
    'p-hana': { isManager: true },
    'p-val': { isExternal: true, tier: 'customer_exec' },
  };
  const ev = (workItemId: string, author: string, atIso: string): Evidence => ({ id: `e-${workItemId}`, workItemId, role: 'origin', source: { kind: 'slack', label: 'x', at: atIso }, at: at('09:00'), summary: '', snippet: null, author, isNew: false, confidence: null });

  it('passes importance, dueKind, askedAt and the stored tier, and sets from-manager only for the asker or counterparty', () => {
    const items = priorityItemsFrom({
      items: [
        rec('asked', { importance: 'critical', dueKind: 'soft', people: [hana] }),
        rec('attends', { people: [hana, val] }),
        rec('cp', { counterparty: hana }),
      ],
      person: (id) => people[id],
      oppAmount: () => null,
      evidence: [ev('asked', 'Hana Lind', at('07:00', '2026-11-04')), ev('attends', 'Valentina Ruiz', at('08:00'))],
    });
    const [asked, attends, cp] = items;
    expect(asked).toMatchObject({ importance: 'critical', dueKind: 'soft', askedAt: at('07:00', '2026-11-04'), fromManager: true });
    expect(attends!.fromManager).toBe(false); // the manager is only on the item
    expect(attends!.stakeholders!.find((s) => s.id === 'p-val')!.tier).toBe('customer_exec');
    expect(cp!.fromManager).toBe(true);
    expect(asked!.customerFacing).toBeUndefined(); // left to the engine unless the extractor said so
  });

  it('prefers the stored tier over the role guess, and guesses only for the default tier', () => {
    expect(tierFor({ tier: 'customer_exec', isExternal: true })).toBe('customer_exec');
    expect(tierFor({ tier: 'normal', isExternal: true, title: 'VP Member Services' })).toBe('customer_exec');
    expect(tierFor({ isExternal: true, title: 'Analyst' })).toBe('customer');
  });
});

describe('R7: the two-part why', () => {
  it('the engine’s why: matters from who/deal/kind, now from the deadline and start-by', () => {
    const r = rankWork(
      inputs({
        items: [item('build', { kind: 'commitment', due: at('10:00', '2026-11-06'), effort: { youMin: 150, agentMin: 0 }, oppAmount: 780_000, stakeholders: [{ name: 'Brendan', isExternal: true }] })],
      }),
    );
    const w = r.scores.build!.why;
    expect(w.matters).toBe('Brendan (customer) · you promised');
    expect(w.now).toMatch(/^due Fri 10:00 · start by \d\d:\d\d/);
    expect(whyLine(w)).toMatch(/^Due Fri 10:00 · start by .*\. Brendan \(customer\) · you promised$/);
  });

  it('the view’s why from a stored item agrees and is recomputed at render time', () => {
    const parts = whyOfItem(
      {
        due: at('17:00', '2026-11-03'),
        dueKind: 'hard',
        startBy: at('14:15', '2026-11-03'),
        rankReasons: [
          { key: 'stakeholderImportance', label: 'Anjali (customer)', contribution: 12 },
          { key: 'rule:customer_facing', label: 'customer-facing beats internal', contribution: 12 },
          { key: 'commitmentWeight', label: 'asked of you', contribution: 10 },
        ],
      },
      Date.parse(at('09:00')),
      HOURS,
    );
    expect(parts).toEqual({ matters: 'Anjali (customer) · asked of you', now: '2 d late · late: do now or re-date' });
  });
});
