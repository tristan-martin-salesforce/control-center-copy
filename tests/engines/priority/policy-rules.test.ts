/** R-UI-16 per-user policy rules, explained in the user's own terms, every score carrying its policy version. */
import { describe, expect, it } from 'vitest';
import { rankWork } from '@/engines/priority/rank';
import { evalPredicate, parsePolicy, RULE_MANAGER_ASKS, SE_IC_POLICY, SE_MANAGER_POLICY } from '@/engines/priority/policy';
import { at, inputs, item, meeting, withPolicy } from './fixtures';

const yesterday = '2026-11-04';

describe("manager_asks_within_24h (SLA rule)", () => {
  const fromManager = item('mgr', {
    title: 'Send Q4 forecast notes to Morgan',
    kind: 'ask',
    askedAt: at('15:00', yesterday),
    createdAt: at('15:05', yesterday),
    effort: { youMin: 20, agentMin: 0 },
    stakeholders: [{ name: 'Morgan', isManager: true }],
  });
  const fromTeammate = { ...fromManager, id: 'peer', title: 'Send notes to Kim', stakeholders: [{ name: 'Kim', tier: 'teammate' as const }] };

  it("sets a deadline 24h after the ask and ranks the manager's ask first", () => {
    const r = rankWork(inputs({ items: [fromTeammate, fromManager] }));
    const s = r.scores.mgr!;
    expect(s.deadline).toMatchObject({ source: 'sla', at: at('15:00') });
    expect(s.rank).toBe(1);
    expect(r.scores.peer!.rank).toBe(2);
    const hit = s.ruleHits.find((h) => h.ruleKey === 'manager_asks_within_24h')!;
    expect(hit).toMatchObject({ kind: 'sla', effect: 8 });
    expect(hit.explanation).toBe("Due within 24h of the ask: your rule 'my manager's asks within 24h': by 15:00");
    expect(s.reasons.some((x) => x.key === 'rule:manager_asks_within_24h')).toBe(true);
    expect(s.policyId).toBe(SE_IC_POLICY.id);
    expect(s.policyVersion).toBe(1);
    expect(r.scores.peer!.ruleHits.some((h) => h.ruleKey === 'manager_asks_within_24h')).toBe(false);
  });

  it('reads as overdue once the SLA passes, at full deadline pressure', () => {
    const late = { ...fromManager, askedAt: at('08:00', yesterday) };
    const r = rankWork(inputs({ items: [late] }));
    const s = r.scores.mgr!;
    // R1 (priority@1.1): late text reads "N late", never "start by …"; still inside its grace working day here
    expect(s.ruleHits[0]!.explanation).toContain('late (since 08:00)');
    expect(s.late).toMatchObject({ kind: 'grace', urgency: 1 });
    expect(s.components.find((c) => c.key === 'deadlineProximity')!.feature).toBe(1);
    // a late item has no start-by (it would read "start by yesterday"): the late state carries the urgency
    expect(s.startBy).toBeNull();
    expect(s.slackMinutes).toBeNull();
  });

  it('takes the earlier of the SLA and the real due date', () => {
    const dueSooner = { ...fromManager, due: at('11:00') };
    const r = rankWork(inputs({ items: [dueSooner] }));
    expect(r.scores.mgr!.deadline).toMatchObject({ source: 'due', at: at('11:00') });
    expect(r.scores.mgr!.ruleHits.some((h) => h.ruleKey === RULE_MANAGER_ASKS.ruleKey)).toBe(true);
  });
});

describe('customer_facing_over_internal and external_attendee_boost', () => {
  it('ranks the customer-facing item above an otherwise identical internal one, saying why', () => {
    const internal = item('int', { title: 'Update internal tracker', due: at('16:00') });
    const customer = item('cust', { title: 'Update ACME tracker', due: at('16:00'), stakeholders: [{ name: 'Dana', isExternal: true }] });
    const r = rankWork(inputs({ items: [internal, customer] }));
    expect(r.ranked.map((s) => s.workItemId)).toEqual(['cust', 'int']);
    expect(r.scores.cust!.ruleHits.map((h) => h.ruleKey)).toEqual(['customer_facing_over_internal']);
    expect(r.scores.cust!.explanation).toContain("your rule 'customer-facing beats internal'");
    expect(r.scores.int!.ruleHits).toEqual([]);
  });

  it('boosts prep for a meeting with external attendees', () => {
    const ext = meeting('m-ext', at('15:00'), at('16:00'), { title: 'Globex review', hasExternalAttendees: true });
    const prep = item('prep', { servesEventId: 'm-ext' });
    const r = rankWork(inputs({ items: [prep], meetings: [ext] }));
    const keys = r.scores.prep!.ruleHits.map((h) => h.ruleKey);
    expect(keys).toContain('external_attendee_boost');
    expect(keys).toContain('customer_facing_over_internal');
    expect(r.scores.prep!.deadline!.label).toBe('Globex review 15:00');
  });
});

describe('never_rank_trainings_above_customer_prep', () => {
  it('keeps a high-scoring training below customer prep, with the rule as the reason', () => {
    const ext = meeting('m-ext', at('16:00'), at('17:00'), { title: 'ACME exec briefing', hasExternalAttendees: true });
    const prep = item('prep', { title: 'Prep briefing', servesEventId: 'm-ext', effort: { youMin: 30, agentMin: 0 } });
    const training = item('cert', {
      title: 'Overdue compliance training',
      kind: 'training',
      effort: { youMin: 20, agentMin: 0 },
      training: { mandatory: true, requiredBy: at('08:00') },
      userAdjustment: 60,
    });
    const r = rankWork(inputs({ items: [training, prep], meetings: [ext] }));
    expect(r.scores.cert!.total).toBeGreaterThan(r.scores.prep!.total);
    expect(r.scores.cert!.scoreRank).toBe(1);
    expect(r.ranked.map((s) => s.workItemId)).toEqual(['prep', 'cert']);
    expect(r.scores.cert!.ruleHits.map((h) => h.ruleKey)).toContain('never_rank_trainings_above_customer_prep');
  });

  it('also holds across lanes: a training never sits in Now above customer prep that is in Next', () => {
    const later = meeting('m-later', at('15:00', '2026-11-07'), at('16:00', '2026-11-07'), { title: 'ACME demo', hasExternalAttendees: true });
    const prep = item('prep', { servesEventId: 'm-later', effort: { youMin: 60, agentMin: 0 } });
    const training = item('cert', { kind: 'training', effort: { youMin: 20, agentMin: 0 }, training: { mandatory: true, requiredBy: at('17:00', '2026-11-08') } });
    const busy = ['t1', 't2', 't3'].map((id) => item(id, { due: at('16:00'), kind: 'ask', effort: { youMin: 15, agentMin: 0 } }));
    const r = rankWork(inputs({ items: [training, prep, ...busy], meetings: [later] }));
    expect(r.top3).toEqual(['t1', 't2', 't3']);
    expect(r.scores.prep!.lane).toBe('next');
    expect(r.scores.cert!.rank!).toBeGreaterThan(r.scores.prep!.rank!);
    expect(r.scores.cert!.lane).toBe('next');
    // Still recommended for today on the Fit-ins shelf (R-UI-2).
    expect(r.fitIns.map((f) => f.workItemId)).toContain('cert');
  });
});

describe('policy DSL and versions', () => {
  it('validates policies with zod (role templates parse, bad rules are rejected)', () => {
    expect(parsePolicy(SE_IC_POLICY)).toEqual(SE_IC_POLICY);
    expect(parsePolicy(SE_MANAGER_POLICY).role).toBe('se_manager');
    const bad = { ...SE_IC_POLICY, rules: [{ ...RULE_MANAGER_ASKS, kind: 'boost', slaHours: undefined, effectValue: undefined }] };
    expect(() => parsePolicy(bad)).toThrow(/boost needs effectValue/);
    const dup = { ...SE_IC_POLICY, rules: [RULE_MANAGER_ASKS, RULE_MANAGER_ASKS] };
    expect(() => parsePolicy(dup)).toThrow(/duplicate ruleKey/);
    expect(() => parsePolicy({ ...SE_IC_POLICY, weights: { ...SE_IC_POLICY.weights, leadTime: 11 } })).toThrow();
  });

  it('evaluates all / any / not / in / gte / lte / exists', () => {
    const f = { kind: 'ask', age_days: 10, due_within_hours: null, customer_facing: true } as unknown as Parameters<typeof evalPredicate>[1];
    expect(evalPredicate({ all: [{ field: 'kind', in: ['ask', 'task'] }, { field: 'age_days', gte: 7 }] }, f)).toBe(true);
    expect(evalPredicate({ any: [{ field: 'age_days', lte: 3 }, { not: { field: 'customer_facing', eq: false } }] }, f)).toBe(true);
    expect(evalPredicate({ field: 'due_within_hours', lte: 24 }, f)).toBe(false);
    expect(evalPredicate({ field: 'due_within_hours', exists: false }, f)).toBe(true);
  });

  it('stamps every score with the policy version it was computed under', () => {
    const v7 = withPolicy({}, 7);
    const r = rankWork(inputs({ policy: v7, items: [item('a'), item('b', { kind: 'commitment', createdAt: '2026-08-01T09:00:00.000Z' })] }));
    expect(r.policyVersion).toBe(7);
    for (const s of Object.values(r.scores)) expect(s.policyVersion).toBe(7);
    for (const b of r.background) expect(b.policyVersion).toBe(7);
  });

  it('a lane_cap rule keeps an item out of the Top 3; an exclude rule hides it with the reason', () => {
    const policy = withPolicy({
      rules: [
        { ruleKey: 'no_travel_top3', label: 'Travel never in Top 3', explanation: "Capped: your rule 'travel never in Top 3'", kind: 'lane_cap', condition: { field: 'kind', eq: 'travel' }, effectLane: 'next', enabled: true },
        { ruleKey: 'hide_low', label: 'Hide low importance', explanation: "Hidden: your rule 'hide low importance'", kind: 'exclude', condition: { field: 'importance', eq: 'low' }, enabled: true },
      ],
    });
    const trip = item('trip', { kind: 'travel', due: at('10:00'), effort: { youMin: 10, agentMin: 0 } });
    const low = item('low', { importance: 'low' });
    const r = rankWork(inputs({ policy, items: [trip, low] }));
    expect(r.top3).toEqual([]);
    expect(r.scores.trip!.lane).toBe('next');
    expect(r.lanes.hidden).toEqual(['low']);
    expect(r.excluded).toContainEqual({ workItemId: 'low', reason: "Hidden: your rule 'hide low importance'" });
  });
});
