/**
 * priority@2 configuration: every weight, table and rule the v2 model reads (lane 07 §4.1, §4.4). The values live in
 * the persona's `priority` block (src/personas/*: the SE and the Specialist AE differ on what "customer-facing" and
 * "deal tier" mean); the engine only reads this shape, so no persona-specific code lives here (*Config over code*).
 *
 * `applyNudges` folds accepted learning rules (`priority_rules`, *Suggest, then learn*) into a config: each nudge
 * moves one weight by a step, clamped to `bounds` around the preset, never outside.
 */
import type { ImportanceLevel, StakeholderTier, WorkItemKind } from '@/engines/types';

/** The terms of the value side, in the order the why names them. */
export const VALUE_TERMS = ['who', 'deal', 'kind', 'importance', 'goal'] as const;
export type ValueTerm = (typeof VALUE_TERMS)[number];

/** Every term the feedback loop measures agreement on (value terms + urgency). */
export const PRIORITY_TERMS = [...VALUE_TERMS, 'urgency'] as const;
export type PriorityTerm = (typeof PRIORITY_TERMS)[number];

/** A weight a learning rule may nudge: one value weight, or the urgency floor (how much value counts without urgency). */
export type NudgeTarget = ValueTerm | 'urgencyFloor';

export type AdminClassId = 'logging' | 'dc' | 'vdp' | 'use_case' | 'expense' | 'training' | 'forecast' | 'sweep';

export interface AdminClassRule {
  id: AdminClassId;
  /** Case-insensitive pattern over the title (deterministic; the persona's words). */
  titlePattern?: string;
  /** Kinds that are always this class (a training). */
  kinds?: WorkItemKind[];
}

export interface PrepRule {
  id: string;
  /** Case-insensitive pattern over the meeting title ("demo|poc|workshop"). */
  meetingTitlePattern?: string;
  /** Only meetings the persona counts as customer-facing. */
  customerFacing?: boolean;
  /** The prep item takes at least this importance (it inherits the meeting's weight). */
  importance: ImportanceLevel;
  /** Minutes before the meeting the prep must be ready (needBy = start − this). */
  readyBeforeMin: number;
}

export interface PriorityConfig {
  /** Names the template the weights came from ("se_ic@2"). */
  template: string;
  topN: number;
  /** Share of free time kept for interrupts in the backward plan (0–50). The golden days are calibrated at 0. */
  reservePct: number;
  /** How far ahead the backward plan reaches, in working days. */
  horizonWorkDays: number;
  /** V = Σ weight · term (0–100 when the weights sum to 100). */
  weights: Record<ValueTerm, number>;
  /** Who: the asker or counterparty first; the best stakeholder otherwise. */
  whoTier: Record<StakeholderTier, number>;
  /** A manager who is the asker counts as at least this tier. */
  managerAskTier: StakeholderTier;
  /** Which tiers make an item customer-facing (the SE: customers; the AE: customers and partners). */
  customerFacingTiers: StakeholderTier[];
  /** Work on a customer opportunity is customer work even when no person is named on it. */
  oppIsCustomerWork: boolean;
  /** Who, when no person is named but the item is on an account or opportunity: that customer's tier (null: 0). */
  accountWhoTier: StakeholderTier | null;
  /**
   * Role-template rules whose effect the v2 terms already carry (customer-facing → kind, external prep → kind, the
   * manager's ask → who). Their deadlines still count (an SLA's need-by); their points don't, so nothing counts twice.
   * Rules the user added always apply.
   */
  supersededRuleEffects: string[];
  /** Deal tiers, ascending lower bounds in USD, and the term for each band (`values.length = tiersUsd.length + 1`). */
  dealTiersUsd: number[];
  dealTierValues: number[];
  /** Kind of work: customer-facing kinds weigh more than internal ones. */
  kindValue: {
    promise: number;
    customerPrep: number;
    ask: number;
    followUp: number;
    customerTask: number;
    internalTask: number;
    admin: number;
  };
  importanceValue: Record<ImportanceLevel, number>;
  /** Goal: pay-linked admin with its deadline at risk. */
  goalPayLinkedAtRisk: number;
  urgency: {
    /** P = V × (floor + U): the share of value an item keeps with no urgency at all. */
    floor: number;
    /** U by bucket (lane 07 §4.1). */
    startByNow: number;
    laterToday: number;
    /** "Later today" rises from `laterToday` to `startByNow` as the free minutes before the start-by fall below this. */
    laterTodaySlackMin: number;
    /** Start-today work whose need-by is a later day caps here (due-today work goes to `startByNow`). */
    laterDayStartTodayMax: number;
    nextWorkDay: number;
    within3WorkDays: number;
    later: number;
    noNeedBy: number;
    /** Ahead-of-time weight of a soft or inferred deadline (a hard one is 1). */
    softFactor: number;
    inferredFactor: number;
    /** Waiting on others: U is multiplied by this, and a chase is planned at the expected reply time. */
    awaitingThemFactor: number;
  };
  /** Owed replies with no due date: needBy = asked + this many working hours, by the asker's tier. */
  replySlaWorkH: Partial<Record<StakeholderTier, number>>;
  prepRules: PrepRule[];
  /** Kick-off-first sequencing moves an agent run up only when its value is at least this (0–100). */
  kickoffMinValue: number;
  /**
   * An item whose work is attending the meeting it serves ("Take the Oakhallow call if Theo is out"): the meeting holds
   * its time, so it needs no hands-on minutes before it (the same rule as Home's "a meeting holds its work").
   */
  attendPattern: string | null;
  onsite: {
    /** A busy block at least this long (or a working-location "onsite") makes the day an onsite day. */
    minBlockMin: number;
    /** Prep for an onsite is ready by the end of the last working day before it (you travel the morning of). */
    prepReadyDayBefore: boolean;
  };
  admin: {
    classes: AdminClassRule[];
    /** Classes whose deadline is pay-linked (logging hours, deal contributions). */
    payLinked: AdminClassId[];
    /** Admin leaves the quiet batch for today's load when due within this many hours. */
    promoteWithinH: number;
  };
  /** Learning-rule bounds: a nudged weight stays within [preset × min, preset × max]. */
  bounds: { min: number; max: number; step: number };
}

/** The neutral defaults (the SE preset starts from these; src/personas/se.ts). */
export const DEFAULT_PRIORITY_CONFIG: PriorityConfig = {
  template: 'default@2',
  topN: 3,
  reservePct: 0,
  horizonWorkDays: 10,
  weights: { who: 30, deal: 25, kind: 20, importance: 15, goal: 10 },
  whoTier: { leader: 1, customer_exec: 1, manager: 0.9, customer: 0.8, ae: 0.7, partner: 0.6, teammate: 0.5, normal: 0.3, low: 0.1 },
  managerAskTier: 'manager',
  customerFacingTiers: ['customer', 'customer_exec'],
  oppIsCustomerWork: true,
  accountWhoTier: 'customer',
  supersededRuleEffects: ['customer_facing_over_internal', 'external_attendee_boost', 'manager_asks_within_24h'],
  dealTiersUsd: [1, 100_000, 500_000, 1_000_000, 3_000_000],
  dealTierValues: [0, 0.3, 0.5, 0.7, 0.9, 1],
  kindValue: { promise: 1, customerPrep: 1, ask: 0.9, followUp: 0.7, customerTask: 0.8, internalTask: 0.4, admin: 0.3 },
  importanceValue: { critical: 1, high: 0.75, normal: 0.4, low: 0.15 },
  goalPayLinkedAtRisk: 0.8,
  urgency: {
    floor: 0.25,
    startByNow: 1,
    laterToday: 0.8,
    laterTodaySlackMin: 240,
    laterDayStartTodayMax: 0.85,
    nextWorkDay: 0.5,
    within3WorkDays: 0.3,
    later: 0.1,
    noNeedBy: 0.05,
    softFactor: 0.9,
    inferredFactor: 0.8,
    awaitingThemFactor: 0.3,
  },
  replySlaWorkH: { customer_exec: 4, leader: 8, customer: 8, manager: 24, ae: 24, partner: 24, teammate: 48 },
  prepRules: [],
  kickoffMinValue: 50,
  attendPattern: '^(take|join|attend|run|cover|lead|present|host)\\b.*\\b(call|meeting|session|sync|demo|review|workshop|standup)\\b',
  onsite: { minBlockMin: 360, prepReadyDayBefore: true },
  admin: {
    classes: [{ id: 'training', kinds: ['training'] }],
    payLinked: ['logging', 'dc'],
    promoteWithinH: 48,
  },
  bounds: { min: 0.5, max: 1.5, step: 0.1 },
};

/** A learning rule as the engine applies it (a `priority_rules` row that the user accepted). */
export interface PriorityNudge {
  target: NudgeTarget;
  /** +1 raises the weight one step, −1 lowers it. */
  direction: 1 | -1;
}

/** The config with accepted nudges applied, each clamped to the bounds around the preset value. */
export function applyNudges(base: PriorityConfig, nudges: readonly PriorityNudge[]): PriorityConfig {
  if (!nudges.length) return base;
  const { min, max, step } = base.bounds;
  const weights = { ...base.weights };
  let floor = base.urgency.floor;
  const count = new Map<NudgeTarget, number>();
  for (const n of nudges) count.set(n.target, (count.get(n.target) ?? 0) + n.direction);
  for (const [target, c] of count) {
    const factor = Math.min(max, Math.max(min, 1 + c * step));
    if (target === 'urgencyFloor') floor = round3(base.urgency.floor * factor);
    else weights[target] = round3(base.weights[target] * factor);
  }
  return { ...base, weights, urgency: { ...base.urgency, floor } };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** A persona block may set only part of the config: deep-merge it over the defaults. */
export function priorityConfigOf(partial: PriorityConfigInput | null | undefined): PriorityConfig {
  if (!partial) return DEFAULT_PRIORITY_CONFIG;
  const d = DEFAULT_PRIORITY_CONFIG;
  return {
    ...d,
    ...partial,
    weights: { ...d.weights, ...partial.weights },
    whoTier: { ...d.whoTier, ...partial.whoTier },
    kindValue: { ...d.kindValue, ...partial.kindValue },
    importanceValue: { ...d.importanceValue, ...partial.importanceValue },
    urgency: { ...d.urgency, ...partial.urgency },
    replySlaWorkH: { ...d.replySlaWorkH, ...partial.replySlaWorkH },
    onsite: { ...d.onsite, ...partial.onsite },
    admin: { ...d.admin, ...partial.admin },
    bounds: { ...d.bounds, ...partial.bounds },
  };
}

/** What a persona's `priority` block may set (everything optional; nested tables merge over the defaults). */
export type PriorityConfigInput = Partial<Omit<PriorityConfig, 'weights' | 'whoTier' | 'kindValue' | 'importanceValue' | 'urgency' | 'replySlaWorkH' | 'onsite' | 'admin' | 'bounds'>> & {
  weights?: Partial<PriorityConfig['weights']>;
  whoTier?: Partial<PriorityConfig['whoTier']>;
  kindValue?: Partial<PriorityConfig['kindValue']>;
  importanceValue?: Partial<PriorityConfig['importanceValue']>;
  urgency?: Partial<PriorityConfig['urgency']>;
  replySlaWorkH?: PriorityConfig['replySlaWorkH'];
  onsite?: Partial<PriorityConfig['onsite']>;
  admin?: Partial<PriorityConfig['admin']>;
  bounds?: Partial<PriorityConfig['bounds']>;
};
