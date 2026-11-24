/**
 * The ONE mapping between the three policy vocabularies (BE-1b blocker B4):
 *
 *   contract `PolicyWeightKey` (W0, Settings ▸ Policy sliders, 8 keys)
 *   engine `PolicyWeights` (ENGINES-core, src/engines/priority/policy.ts, 9 keys)
 *   DB `priority_policies.weight_*` columns (9, same names as the engine, snake_case)
 *
 * | contract            | engine / DB column                                   | priority_scores component |
 * |---------------------|------------------------------------------------------|---------------------------|
 * | due_urgency         | deadlineProximity      · weight_deadline_proximity   | deadline_proximity        |
 * | meeting_proximity   | calendarPressure       · weight_calendar_pressure    | calendar_pressure         |
 * | lead_time           | leadTime               · weight_lead_time            | lead_time                 |
 * | effort_fit          | effortFit              · weight_effort_fit           | effort_fit                |
 * | deal_value          | dealValue              · weight_deal_value           | deal_value                |
 * | age                 | staleness              · weight_staleness            | staleness                 |
 * | customer_facing     | stakeholderImportance  · weight_stakeholder_importance | stakeholder_importance  |
 * | manager_ask         | commitment             · weight_commitment           | commitment_weight         |
 * | (none)              | obligation             · weight_obligation           | obligation_boost          |
 *
 * Why customer_facing / manager_ask are weights here and not engine rules (ENGINES.md §5 suggests rules):
 * the user's own contract rules already say "customer-facing beats internal" and "my manager's asks within
 * 24h" (r_customer, r_manager in both seeds), and those become engine boost rules below, so mapping the two
 * sliders to rules as well would count them twice. Mapping them to the nearest weighted component keeps
 * every slider live, keeps storage lossless (8 sliders ↔ 8 columns), and leaves `obligation` (mandatory
 * trainings) as an engine-only weight the contract cannot edit yet (kept from the previous version).
 *
 * Scale: contract weights and the engine's are both 0–10, and the engine scores `weight · feature · 10`
 * (POINTS_PER_WEIGHT). Contract rule boosts are in the contract's unscaled score units (−10…10), so they
 * become engine rule points × POINTS_PER_WEIGHT. Contract `when` → engine predicate:
 *   kinds → kind ∈ · customerFacing → customer_facing = · fromManager → from_manager = ·
 *   sources → source ∈ · dueWithinH → due_within_hours ≤ (no due date never matches).
 */
import type { PolicyRule as ContractRule, PolicyWeightKey, PolicyWeights as ContractWeights, PriorityPolicy as ContractPolicy } from '@/contract';
import { DEFAULT_TUNING, parsePolicy, SE_IC_WEIGHTS, type FieldPredicate, type PolicyRule as EngineRule, type PolicyWeights as EngineWeights, type Predicate, type PriorityPolicy as EnginePolicy } from '@/engines/priority/policy';
import { POINTS_PER_WEIGHT } from '@/engines/priority/score';
import type { ComponentKey } from '@/engines/priority/types';

export type EngineWeightKey = keyof EngineWeights;

export const CONTRACT_TO_ENGINE_WEIGHT: Record<PolicyWeightKey, EngineWeightKey> = {
  due_urgency: 'deadlineProximity',
  meeting_proximity: 'calendarPressure',
  lead_time: 'leadTime',
  effort_fit: 'effortFit',
  deal_value: 'dealValue',
  age: 'staleness',
  customer_facing: 'stakeholderImportance',
  manager_ask: 'commitment',
};

export const ENGINE_TO_CONTRACT_WEIGHT: Partial<Record<EngineWeightKey, PolicyWeightKey>> = Object.fromEntries(
  Object.entries(CONTRACT_TO_ENGINE_WEIGHT).map(([c, e]) => [e, c]),
) as Partial<Record<EngineWeightKey, PolicyWeightKey>>;

/** Engine weight → `priority_policies` column property (drizzle camelCase of `weight_*`). */
export const ENGINE_WEIGHT_COLUMN = {
  deadlineProximity: 'weightDeadlineProximity',
  calendarPressure: 'weightCalendarPressure',
  leadTime: 'weightLeadTime',
  effortFit: 'weightEffortFit',
  stakeholderImportance: 'weightStakeholderImportance',
  dealValue: 'weightDealValue',
  commitment: 'weightCommitment',
  staleness: 'weightStaleness',
  obligation: 'weightObligation',
} as const satisfies Record<EngineWeightKey, string>;
export type WeightColumn = (typeof ENGINE_WEIGHT_COLUMN)[EngineWeightKey];

/** Engine weight → the `priority_scores` component column it scales. */
export const ENGINE_WEIGHT_COMPONENT: Record<EngineWeightKey, ComponentKey> = {
  deadlineProximity: 'deadlineProximity',
  calendarPressure: 'calendarPressure',
  leadTime: 'leadTime',
  effortFit: 'effortFit',
  stakeholderImportance: 'stakeholderImportance',
  dealValue: 'dealValue',
  commitment: 'commitmentWeight',
  staleness: 'staleness',
  obligation: 'obligationBoost',
};

/** The engine-only weight's default (SE IC role template). */
export const DEFAULT_OBLIGATION_WEIGHT = SE_IC_WEIGHTS.obligation;

export function engineWeightsFromContract(w: ContractWeights, obligation: number = DEFAULT_OBLIGATION_WEIGHT): EngineWeights {
  const out = { obligation } as EngineWeights;
  for (const [c, e] of Object.entries(CONTRACT_TO_ENGINE_WEIGHT) as [PolicyWeightKey, EngineWeightKey][]) out[e] = w[c];
  return out;
}

export function contractWeightsFromEngine(w: EngineWeights): ContractWeights {
  const out = {} as ContractWeights;
  for (const [c, e] of Object.entries(CONTRACT_TO_ENGINE_WEIGHT) as [PolicyWeightKey, EngineWeightKey][]) out[c] = w[e];
  return out;
}

/** Contract weights (+ the engine-only obligation) → `priority_policies` column values. */
export function weightColumnsFromContract(w: ContractWeights, obligation: number = DEFAULT_OBLIGATION_WEIGHT): Record<WeightColumn, number> {
  const e = engineWeightsFromContract(w, obligation);
  return Object.fromEntries((Object.keys(ENGINE_WEIGHT_COLUMN) as EngineWeightKey[]).map((k) => [ENGINE_WEIGHT_COLUMN[k], e[k]])) as Record<WeightColumn, number>;
}

/** A `priority_policies` row → engine weights. */
export function engineWeightsFromRow(row: Record<WeightColumn, number | string | null>): EngineWeights {
  return Object.fromEntries((Object.keys(ENGINE_WEIGHT_COLUMN) as EngineWeightKey[]).map((k) => [k, Number(row[ENGINE_WEIGHT_COLUMN[k]] ?? 0)])) as EngineWeights;
}

export function contractWeightsFromRow(row: Record<WeightColumn, number | string | null>): ContractWeights {
  return contractWeightsFromEngine(engineWeightsFromRow(row));
}

/** Contract rule (W0 `{when, boost}`) → engine boost / penalty rule. */
export function engineRuleFromContract(r: ContractRule): EngineRule {
  const all: Predicate[] = [];
  const w = r.when;
  if (w.kinds?.length) all.push({ field: 'kind', in: [...w.kinds] } satisfies FieldPredicate);
  if (w.customerFacing !== undefined) all.push({ field: 'customer_facing', eq: w.customerFacing });
  if (w.fromManager !== undefined) all.push({ field: 'from_manager', eq: w.fromManager });
  if (w.sources?.length) all.push({ field: 'source', in: [...w.sources] });
  if (w.dueWithinH !== undefined) all.push({ field: 'due_within_hours', lte: w.dueWithinH });
  const points = Math.round(r.boost * POINTS_PER_WEIGHT * 1000) / 1000;
  const label = r.text.trim() || r.id;
  return {
    ruleKey: r.id,
    label,
    explanation: `${points < 0 ? 'Ranked down' : 'Ranked up'}: your rule '${label}'`,
    kind: points < 0 ? 'penalty' : 'boost',
    condition: { all },
    // a penalty's effect is a magnitude (the engine subtracts it)
    effectValue: Math.min(100, Math.abs(points)),
    enabled: r.enabled,
  };
}

export interface EnginePolicyOpts {
  /** `priority_policies.id` of this version (scores reference it). Defaults to the contract policy id. */
  rowId?: string;
  obligation?: number;
  top3Size?: number;
}

/** Contract policy → the engine's (validated with parsePolicy). Tuning = the engine defaults. */
export function enginePolicyFromContract(p: ContractPolicy, o: EnginePolicyOpts = {}): EnginePolicy {
  return parsePolicy({
    id: o.rowId ?? p.id,
    version: p.version,
    name: p.name,
    role: p.role,
    weights: engineWeightsFromContract(p.weights, o.obligation),
    rules: p.rules.map(engineRuleFromContract),
    top3Size: o.top3Size ?? 3,
    tuning: DEFAULT_TUNING,
    changeSummary: p.note ?? '',
  });
}
