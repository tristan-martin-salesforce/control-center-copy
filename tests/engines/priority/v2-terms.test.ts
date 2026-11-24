/** priority@2 terms: every value and urgency term is a pure function (src/engines/priority/v2/terms.ts). */
import { describe, expect, it } from 'vitest';
import { applyNudges, DEFAULT_PRIORITY_CONFIG as C, priorityConfigOf } from '@/engines/priority/v2/config';
import { dealTerm, goalTerm, importanceTerm, kindClassOf, kindTerm, maxImportance, priorityOf, urgencyBucket, urgencyOf, valueOf, valuePoints, whoTerm, type UrgencyInput } from '@/engines/priority/v2/terms';
import { personaOf } from '@/personas';

const H = 3_600_000;
const NOW = Date.parse('2026-11-05T09:00:00.000Z');
const base: UrgencyInput = {
  nowMs: NOW,
  needByMs: NOW + 8 * H,
  startByMs: NOW + 2 * H,
  late: null,
  dueKind: 'hard',
  awaitingThem: false,
  slackWorkMin: 120,
  workdayMin: 240,
  todayEndMs: NOW + 15 * H,
  nextWorkDayEndMs: NOW + 39 * H,
  thirdWorkDayEndMs: NOW + 87 * H,
};

describe('value terms', () => {
  it('who: the best stakeholder by tier, named with the tier', () => {
    const w = whoTerm([{ id: 'a', name: 'Dana', tier: 'teammate' }, { id: 'b', name: 'Vera', tier: 'customer_exec' }], false, C);
    expect(w).toEqual({ value: 1, label: 'Vera (customer exec)', tier: 'customer_exec' });
  });
  it('who: a manager who asked counts as at least the manager tier; nobody named on an account is that customer', () => {
    expect(whoTerm([{ id: 'm', name: 'Hana', isManager: true }, { id: 't', name: 'Theo', tier: 'teammate' }], true, C).value).toBe(0.9);
    expect(whoTerm([], false, C, true)).toEqual({ value: 0.8, label: null, tier: 'customer' });
    expect(whoTerm([], false, C, false).value).toBe(0);
  });
  it('deal: a monotone tier table ($2M ≫ $500k; none is 0)', () => {
    expect(dealTerm(null, C)).toBe(0);
    expect(dealTerm(50_000, C)).toBe(0.3);
    expect(dealTerm(500_000, C)).toBe(0.7);
    expect(dealTerm(2_000_000, C)).toBe(0.9);
    expect(dealTerm(5_000_000, C)).toBe(1);
    let last = -1;
    for (let a = 0; a <= 6_000_000; a += 25_000) {
      const v = dealTerm(a, C);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
  it('deal: a misconfigured table never goes down with the amount', () => {
    expect(dealTerm(2_000_000, { dealTiersUsd: [1, 1_000_000], dealTierValues: [0, 0.9, 0.4] })).toBe(0.9);
  });
  it('kind: customer-facing beats internal; admin is lowest', () => {
    expect(kindClassOf({ kind: 'task', customerFacing: true, customerPrep: true, admin: false })).toBe('customerPrep');
    expect(kindClassOf({ kind: 'commitment', customerFacing: false, customerPrep: false, admin: false })).toBe('promise');
    expect(kindClassOf({ kind: 'task', customerFacing: false, customerPrep: false, admin: true })).toBe('admin');
    const cust = kindTerm({ kind: 'task', customerFacing: true, customerPrep: false, admin: false }, C).value;
    const internal = kindTerm({ kind: 'task', customerFacing: false, customerPrep: false, admin: false }, C).value;
    expect(cust).toBeGreaterThan(internal);
    expect(internal).toBeGreaterThan(kindTerm({ kind: 'training', customerFacing: false, customerPrep: false, admin: false }, C).value);
  });
  it('importance and goal', () => {
    expect(importanceTerm('critical', C)).toBe(1);
    expect(importanceTerm('low', C)).toBe(0.15);
    expect(maxImportance('normal', 'high')).toBe('high');
    expect(maxImportance('critical', 'high')).toBe('critical');
    expect(goalTerm({ payLinked: true, atRisk: true }, C)).toBe(0.8);
    expect(goalTerm({ payLinked: true, atRisk: false }, C)).toBe(0);
    expect(goalTerm({ payLinked: false, atRisk: true }, C)).toBe(0);
  });
  it('V = Σ weight · term, with the points per term', () => {
    const terms = { who: 1, deal: 0.7, kind: 1, importance: 1, goal: 0 };
    expect(valueOf(terms, C.weights)).toBe(82.5);
    expect(valuePoints(terms, C.weights)).toEqual({ who: 30, deal: 17.5, kind: 20, importance: 15, goal: 0 });
  });
});

describe('urgency', () => {
  it('buckets from the planned start-by', () => {
    expect(urgencyBucket({ ...base, startByMs: NOW })).toBe('start_now');
    expect(urgencyBucket(base)).toBe('later_today');
    expect(urgencyBucket({ ...base, startByMs: NOW + 20 * H })).toBe('next_work_day');
    expect(urgencyBucket({ ...base, startByMs: NOW + 60 * H })).toBe('within_3_work_days');
    expect(urgencyBucket({ ...base, startByMs: NOW + 200 * H })).toBe('later');
    expect(urgencyBucket({ ...base, needByMs: null, startByMs: null })).toBe('no_need_by');
  });
  it('later today rises toward 1 as the slack runs out; a later-day need-by caps at .85', () => {
    const lo = urgencyOf({ ...base, slackWorkMin: 400 }, C).value;
    const hi = urgencyOf({ ...base, slackWorkMin: 10 }, C).value;
    expect(lo).toBe(0.8);
    expect(hi).toBeGreaterThan(0.95);
    const laterDay = urgencyOf({ ...base, needByMs: NOW + 30 * H, slackWorkMin: 0 }, C).value;
    expect(laterDay).toBe(0.85);
    expect(urgencyOf({ ...base, needByMs: NOW + 30 * H, startByMs: NOW }, C).value).toBe(0.85);
    expect(urgencyOf({ ...base, startByMs: NOW }, C).value).toBe(1);
  });
  it('late: the late state sets it (1 in the grace day, .6 after, .4 for a soft date)', () => {
    const late = (urgency: number, kind: 'grace' | 'late' | 'redate') => ({ kind, minutesLate: 60, label: '1h late', verb: null, urgency });
    expect(urgencyOf({ ...base, late: late(1, 'grace') }, C).value).toBe(1);
    expect(urgencyOf({ ...base, late: late(0.6, 'late') }, C).value).toBe(0.6);
    expect(urgencyOf({ ...base, late: late(0.4, 'redate') }, C).value).toBe(0.4);
  });
  it('soft and inferred deadlines weigh less ahead of time; waiting on them lowers it', () => {
    const hard = urgencyOf(base, C).value;
    expect(urgencyOf({ ...base, dueKind: 'soft' }, C).value).toBeLessThan(hard);
    expect(urgencyOf({ ...base, dueKind: 'inferred' }, C).value).toBeLessThan(urgencyOf({ ...base, dueKind: 'soft' }, C).value);
    expect(urgencyOf({ ...base, awaitingThem: true }, C).value).toBeCloseTo(hard * 0.3, 2);
  });
  it('no need-by: .05', () => {
    expect(urgencyOf({ ...base, needByMs: null, startByMs: null }, C).value).toBe(0.05);
  });
  it('P = V × (floor + U) + extra', () => {
    expect(priorityOf(80, 1, 0.25)).toBe(100);
    expect(priorityOf(80, 0, 0.25, 5)).toBe(25);
  });
});

describe('config', () => {
  it('nudges move one weight a step, clamped to the bounds', () => {
    const one = applyNudges(C, [{ target: 'deal', direction: -1 }]);
    expect(one.weights.deal).toBe(22.5);
    const many = applyNudges(C, Array.from({ length: 20 }, () => ({ target: 'deal' as const, direction: -1 as const })));
    expect(many.weights.deal).toBe(12.5); // 0.5 × 25
    expect(applyNudges(C, [{ target: 'urgencyFloor', direction: 1 }]).urgency.floor).toBe(0.275);
    expect(applyNudges(C, [])).toBe(C);
  });
  it('the SE and the Specialist AE differ on deal tiers and what customer-facing means', () => {
    const se = personaOf({ persona: { id: 'se' } }).priority;
    const ae = personaOf({ persona: { id: 'ae' } }).priority;
    expect(se.template).toBe('se_ic@2');
    expect(ae.template).toBe('ae@2');
    expect(dealTerm(300_000, ae)).toBeGreaterThan(dealTerm(300_000, se));
    expect(ae.customerFacingTiers).toContain('partner');
    expect(se.customerFacingTiers).not.toContain('partner');
    expect(priorityConfigOf(null)).toBe(C);
  });
});
