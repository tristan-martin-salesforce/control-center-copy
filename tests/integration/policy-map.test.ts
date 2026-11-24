/**
 * INTEGRATE-1: the one policy mapping (contract PolicyWeightKey ↔ engine PolicyWeights ↔ DB weight_*
 * columns, BE-1b blocker B4) and the closure bridge (WorkItemRecord ↔ ClosureItem). Pure: no database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { PolicyWeightKey, Seed, type PolicyWeights, type WorkItemRecord } from '@/contract';
import { priorityPolicies } from '@/db/schema';
import { applySignal } from '@/engines/closure/machine';
import { COMPONENT_KEYS } from '@/engines/priority/types';
import { evalPredicate, PolicyWeightsSchema, SE_IC_WEIGHTS, type FeatureValues } from '@/engines/priority/policy';
import { POINTS_PER_WEIGHT } from '@/engines/priority/score';
import { closureItemOf, recordAfterDecision } from '@/server/datasource/db/closure';
import {
  CONTRACT_TO_ENGINE_WEIGHT,
  contractWeightsFromEngine,
  contractWeightsFromRow,
  DEFAULT_OBLIGATION_WEIGHT,
  ENGINE_TO_CONTRACT_WEIGHT,
  ENGINE_WEIGHT_COLUMN,
  ENGINE_WEIGHT_COMPONENT,
  engineRuleFromContract,
  engineWeightsFromContract,
  enginePolicyFromContract,
  weightColumnsFromContract,
} from '@/server/datasource/db/policy-map';
import { utcOffsetMinutes } from '@/server/datasource/db/rank';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const contractWeights: PolicyWeights = seed.settings.policy.weights;

describe('policy weight mapping (B4)', () => {
  it('maps every contract key to a distinct engine weight; obligation is the only engine-only weight', () => {
    const engineKeys = Object.keys(PolicyWeightsSchema.shape);
    expect(Object.keys(CONTRACT_TO_ENGINE_WEIGHT).sort()).toEqual([...PolicyWeightKey.options].sort());
    const targets = Object.values(CONTRACT_TO_ENGINE_WEIGHT);
    expect(new Set(targets).size).toBe(targets.length);
    for (const t of targets) expect(engineKeys).toContain(t);
    expect(engineKeys.filter((k) => !targets.includes(k as never))).toEqual(['obligation']);
    for (const [c, e] of Object.entries(CONTRACT_TO_ENGINE_WEIGHT)) expect(ENGINE_TO_CONTRACT_WEIGHT[e]).toBe(c);
  });

  it('names a real priority_policies column for every engine weight and a priority_scores component', () => {
    const cols = getTableColumns(priorityPolicies) as Record<string, { name: string }>;
    for (const [k, prop] of Object.entries(ENGINE_WEIGHT_COLUMN)) {
      expect(cols[prop], prop).toBeDefined();
      expect(cols[prop]!.name).toBe(`weight_${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`);
    }
    for (const c of Object.values(ENGINE_WEIGHT_COMPONENT)) expect(COMPONENT_KEYS).toContain(c);
  });

  it('round-trips contract weights through the engine and the columns losslessly', () => {
    expect(contractWeightsFromEngine(engineWeightsFromContract(contractWeights))).toEqual(contractWeights);
    const row = weightColumnsFromContract(contractWeights, 2.5);
    expect(row.weightObligation).toBe(2.5);
    expect(contractWeightsFromRow(row)).toEqual(contractWeights);
    expect(engineWeightsFromContract(contractWeights).obligation).toBe(DEFAULT_OBLIGATION_WEIGHT);
    expect(DEFAULT_OBLIGATION_WEIGHT).toBe(SE_IC_WEIGHTS.obligation);
    // the decided pairs (ENGINES.md §5 + this module's header)
    expect(engineWeightsFromContract(contractWeights)).toMatchObject({
      deadlineProximity: contractWeights.due_urgency,
      calendarPressure: contractWeights.meeting_proximity,
      staleness: contractWeights.age,
      stakeholderImportance: contractWeights.customer_facing,
      commitment: contractWeights.manager_ask,
    });
  });

  it('turns contract rules into engine boost / penalty rules (points × 10) with the same predicate', () => {
    const [customer, manager, training] = seed.settings.policy.rules;
    const c = engineRuleFromContract(customer!);
    expect(c).toMatchObject({ ruleKey: customer!.id, kind: 'boost', effectValue: customer!.boost * POINTS_PER_WEIGHT, enabled: true });
    const t = engineRuleFromContract(training!);
    expect(t.kind).toBe('penalty');
    expect(t.effectValue).toBe(Math.abs(training!.boost) * POINTS_PER_WEIGHT);
    const m = engineRuleFromContract(manager!);
    const f = (over: Partial<FeatureValues>) => ({ kind: 'ask', from_manager: false, customer_facing: false, source: 'slack', due_within_hours: null, ...over }) as FeatureValues;
    expect(evalPredicate(m.condition, f({ from_manager: true, due_within_hours: 10 }))).toBe(true);
    expect(evalPredicate(m.condition, f({ from_manager: true, due_within_hours: 30 }))).toBe(false);
    expect(evalPredicate(m.condition, f({ from_manager: true, due_within_hours: null }))).toBe(false);
    expect(evalPredicate(t.condition, f({ kind: 'training' }))).toBe(true);
    expect(evalPredicate(t.condition, f({ kind: 'ask' }))).toBe(false);
  });

  it('builds a valid engine policy from both seeds’ policy (parsePolicy)', () => {
    const p = enginePolicyFromContract(seed.settings.policy, { rowId: 'row-1', obligation: 1.5, top3Size: 3 });
    expect(p).toMatchObject({ id: 'row-1', version: seed.settings.policy.version, top3Size: 3 });
    expect(p.rules).toHaveLength(seed.settings.policy.rules.length);
    for (const v of seed.policyVersions) expect(() => enginePolicyFromContract(v.policy)).not.toThrow();
  });

  it('computes the planning UTC offset from the IANA zone (DST aware)', () => {
    expect(utcOffsetMinutes('America/Denver', new Date('2026-11-05T16:00:00Z'))).toBe(-420);
    expect(utcOffsetMinutes('America/Denver', new Date('2026-07-05T16:00:00Z'))).toBe(-360);
    expect(utcOffsetMinutes('UTC', new Date('2026-07-05T16:00:00Z'))).toBe(0);
  });
});

describe('closure bridge (WorkItemRecord ↔ ClosureItem)', () => {
  const me = { id: 'me', name: 'Me' };
  const base = seed.workItems.find((w) => w.state === 'open' && w.userLockedFields.length === 0)!;
  const at = '2026-11-05T17:00:00.000Z';

  it('a Sure completion closes the item as the engine, with an inferred resolution', () => {
    const d = applySignal(closureItemOf(base, me), { type: 'evidence', role: 'completion', confidence: 'sure', evidenceId: 'ev1', at, actor: { name: 'Me', isMe: true } });
    expect(d.kind).toBe('transition');
    const next = recordAfterDecision(base, d, at);
    expect(next).toMatchObject({ state: 'done', doneBy: 'engine', resolution: 'done_by_me' });
    expect(next.resolutionDetail?.inferred).toBe(true);
    expect(next.closedReason).toBe(d.reason);
  });

  it('a done item reopened by a loop-back reads as `reopened` and drops its resolution', () => {
    const done: WorkItemRecord = { ...base, state: 'done', doneAt: at, doneBy: 'user', resolution: 'done_by_me', resolutionDetail: { inferred: false }, closedReason: 'Done' };
    const d = applySignal(closureItemOf(done, me), { type: 'loop_back', from: { name: 'Dana' }, evidenceId: 'ev2', at: '2026-11-06T17:00:00.000Z' });
    expect(d.transition?.to).toBe('open');
    const next = recordAfterDecision(done, d, '2026-11-06T17:00:00.000Z');
    expect(next).toMatchObject({ state: 'reopened', doneAt: null, doneBy: null, resolution: null, resolutionDetail: null });
    expect(next.reopened?.reason).toBeTruthy();
  });

  it('a user-locked status turns the engine move into a proposal (nothing written)', () => {
    const locked: WorkItemRecord = { ...base, userLockedFields: ['state'] };
    const d = applySignal(closureItemOf(locked, me), { type: 'evidence', role: 'completion', confidence: 'sure', evidenceId: 'ev3', at });
    expect(d.kind).toBe('proposal');
    expect(d.proposals.find((p) => p.field === 'status')?.proposedValue).toBe('done');
  });
});
