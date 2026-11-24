/**
 * priority@2 terms (lane 07 §4.1): P = V × (floor + U) + the policy's rule effects + your manual adjustment.
 *
 * Value V (independent of time) = Σ weight · term over five terms, each in [0, 1]:
 *   who         the best stakeholder's tier (leader / customer exec 1 … other .3); a manager who is the asker counts
 *               as at least the manager tier
 *   deal        a monotone tier table over the opportunity amount (none 0 … ≥ $3M 1): $2M ≫ $500k
 *   kind        customer-facing beats internal: a promise or customer prep 1, an ask .9, a customer task .8,
 *               a follow-up .7, an internal task .4, admin .3
 *   importance  the extractor's importance (critical 1, high .75, normal .4, low .15); prep inherits the meeting's
 *   goal        pay-linked admin (logging, deal contributions) whose deadline is at risk
 *
 * Urgency U (0–1) from working slack, not wall clock: start-by passed 1, later today .8 → 1 as the slack runs out
 * (→ .85 when the need-by is a later day: it starts today only because the hours before it are committed),
 * next working day .5, within 3 working days .3, later .1, no need-by .05; a late hard deadline 1 for one working
 * day then .6, a late soft or inferred one .4 (why.ts `lateState`). Soft and inferred deadlines ahead weigh less;
 * waiting on others multiplies U down (and plans a chase instead).
 *
 * Every term is a pure function of its inputs; `tests/engines/priority/v2-terms.test.ts` pins each one.
 */
import type { ImportanceLevel, PersonLite, StakeholderTier } from '@/engines/types';
import type { LateState } from '../why';
import { VALUE_TERMS, type PriorityConfig, type ValueTerm } from './config';

export const TIER_LABEL: Record<StakeholderTier, string> = {
  leader: 'leader',
  customer_exec: 'customer exec',
  manager: 'your manager',
  customer: 'customer',
  ae: 'AE',
  partner: 'partner',
  teammate: 'teammate',
  normal: 'contact',
  low: 'low priority contact',
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function tierOfPerson(p: PersonLite): StakeholderTier {
  if (p.tier) return p.tier;
  if (p.isManager) return 'manager';
  if (p.isExternal) return 'customer';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Value terms
// ---------------------------------------------------------------------------

export interface WhoTerm {
  value: number;
  /** "Valentina (customer exec)", or null when nobody stands out. */
  label: string | null;
  tier: StakeholderTier | null;
}

/**
 * The best stakeholder by the persona's tier table; a manager who asked counts as at least `managerAskTier`; with
 * nobody named, an item on a customer account counts as that customer (`accountWhoTier`).
 */
export function whoTerm(stakeholders: readonly PersonLite[], fromManager: boolean, cfg: Pick<PriorityConfig, 'whoTier' | 'managerAskTier'> & Partial<Pick<PriorityConfig, 'accountWhoTier'>>, onAccount = false): WhoTerm {
  let best: { p: PersonLite; tier: StakeholderTier } | null = null;
  for (const p of stakeholders) {
    if (p.isMe) continue;
    const tier = tierOfPerson(p);
    if (!best || cfg.whoTier[tier] > cfg.whoTier[best.tier]) best = { p, tier };
  }
  let value = best ? cfg.whoTier[best.tier] : 0;
  let label = best ? `${best.p.name} (${TIER_LABEL[best.tier]})` : null;
  let tier = best?.tier ?? null;
  const askFloor = cfg.whoTier[cfg.managerAskTier];
  if (fromManager && askFloor > value) {
    const mgr = stakeholders.find((p) => !p.isMe && (p.isManager || p.tier === 'manager'));
    value = askFloor;
    label = mgr ? `${mgr.name} (${TIER_LABEL.manager})` : 'your manager asked';
    tier = cfg.managerAskTier;
  }
  if (!best && !fromManager && onAccount && cfg.accountWhoTier) return { value: round3(cfg.whoTier[cfg.accountWhoTier]), label: null, tier: cfg.accountWhoTier };
  return { value: round3(value), label, tier };
}

/** The persona's deal band for an amount: monotone in the amount (a bigger deal never weighs less). */
export function dealTerm(amount: number | null | undefined, cfg: Pick<PriorityConfig, 'dealTiersUsd' | 'dealTierValues'>): number {
  const a = typeof amount === 'number' && amount > 0 ? amount : 0;
  let band = 0;
  for (let i = 0; i < cfg.dealTiersUsd.length; i++) if (a >= cfg.dealTiersUsd[i]!) band = i + 1;
  // never let a misconfigured table go down: take the running max
  let v = 0;
  for (let i = 0; i <= band; i++) v = Math.max(v, cfg.dealTierValues[i] ?? 0);
  return round3(clamp01(v));
}

export type KindClass = keyof PriorityConfig['kindValue'];

export const KIND_LABEL: Record<KindClass, string | null> = {
  promise: 'you promised',
  customerPrep: 'customer prep',
  ask: 'asked of you',
  followUp: 'meeting follow-up',
  customerTask: 'customer work',
  internalTask: null,
  admin: 'admin',
};

export interface KindInput {
  kind: string;
  customerFacing: boolean;
  customerPrep: boolean;
  admin: boolean;
}

/** What kind of work it is, customer-facing first. */
export function kindClassOf(k: KindInput): KindClass {
  if (k.admin || k.kind === 'training') return 'admin';
  if (k.customerPrep) return 'customerPrep';
  if (k.kind === 'commitment') return 'promise';
  if (k.kind === 'ask') return 'ask';
  if (k.kind === 'follow_up') return 'followUp';
  return k.customerFacing ? 'customerTask' : 'internalTask';
}

export function kindTerm(k: KindInput, cfg: Pick<PriorityConfig, 'kindValue'>): { value: number; cls: KindClass } {
  const cls = kindClassOf(k);
  return { value: round3(clamp01(cfg.kindValue[cls])), cls };
}

const IMPORTANCE_RANK: Record<ImportanceLevel, number> = { low: 0, normal: 1, high: 2, critical: 3 };

/** The higher of two importances (a prep item inherits its meeting's). */
export function maxImportance(a: ImportanceLevel, b: ImportanceLevel | null | undefined): ImportanceLevel {
  return b && IMPORTANCE_RANK[b] > IMPORTANCE_RANK[a] ? b : a;
}

export function importanceTerm(level: ImportanceLevel, cfg: Pick<PriorityConfig, 'importanceValue'>): number {
  return round3(clamp01(cfg.importanceValue[level]));
}

/** Pay-linked admin whose deadline is at risk (due soon or must start today). */
export function goalTerm(o: { payLinked: boolean; atRisk: boolean }, cfg: Pick<PriorityConfig, 'goalPayLinkedAtRisk'>): number {
  return o.payLinked && o.atRisk ? round3(clamp01(cfg.goalPayLinkedAtRisk)) : 0;
}

export type ValueTerms = Record<ValueTerm, number>;

/** V = Σ weight · term (0–100 with the default weights). */
export function valueOf(terms: ValueTerms, weights: Record<ValueTerm, number>): number {
  let v = 0;
  for (const t of VALUE_TERMS) v += weights[t] * terms[t];
  return round3(v);
}

/** Each term's points (weight · term), for the why and the stored components. */
export function valuePoints(terms: ValueTerms, weights: Record<ValueTerm, number>): ValueTerms {
  const out = {} as ValueTerms;
  for (const t of VALUE_TERMS) out[t] = round3(weights[t] * terms[t]);
  return out;
}

// ---------------------------------------------------------------------------
// Urgency
// ---------------------------------------------------------------------------

export type UrgencyBucket = 'late' | 'start_now' | 'later_today' | 'next_work_day' | 'within_3_work_days' | 'later' | 'no_need_by';

export interface UrgencyInput {
  nowMs: number;
  /** null: nothing dated. */
  needByMs: number | null;
  /** The planned start-by (null when nothing is dated or it is late). */
  startByMs: number | null;
  late: LateState | null;
  /** The kind of the deadline the need-by came from (soft and inferred weigh less while ahead). */
  dueKind: 'hard' | 'soft' | 'inferred' | null;
  awaitingThem: boolean;
  /** Free working minutes between now and the start-by. */
  slackWorkMin: number;
  /** The slack scale for "later today" (config `laterTodaySlackMin`). */
  workdayMin: number;
  /** Local-day boundaries (UTC instants): end of today, end of the next working day, end of the 3rd working day. */
  todayEndMs: number;
  nextWorkDayEndMs: number;
  thirdWorkDayEndMs: number;
}

export function urgencyBucket(u: Pick<UrgencyInput, 'nowMs' | 'needByMs' | 'startByMs' | 'late' | 'todayEndMs' | 'nextWorkDayEndMs' | 'thirdWorkDayEndMs'>): UrgencyBucket {
  if (u.late) return 'late';
  if (u.needByMs === null || u.startByMs === null) return 'no_need_by';
  if (u.startByMs <= u.nowMs) return 'start_now';
  if (u.startByMs < u.todayEndMs) return 'later_today';
  if (u.startByMs < u.nextWorkDayEndMs) return 'next_work_day';
  if (u.startByMs < u.thirdWorkDayEndMs) return 'within_3_work_days';
  return 'later';
}

/** U in [0, 1]. Monotone: an earlier start-by (a nearer deadline, more work before it) never lowers it. */
export function urgencyOf(u: UrgencyInput, cfg: Pick<PriorityConfig, 'urgency'>): { value: number; bucket: UrgencyBucket } {
  const c = cfg.urgency;
  const bucket = urgencyBucket(u);
  // work that must start today for a need-by on a later day (the hours before it are committed) is urgent, but less so
  // than work due today: it caps at `laterDayStartTodayMax` (monotone: a nearer need-by never lowers U)
  const laterDay = u.needByMs !== null && u.needByMs >= u.todayEndMs;
  let v: number;
  switch (bucket) {
    case 'late':
      v = u.late!.urgency;
      break;
    case 'start_now':
      v = laterDay ? c.laterDayStartTodayMax : c.startByNow;
      break;
    case 'later_today': {
      const used = 1 - Math.min(1, Math.max(0, u.slackWorkMin) / Math.max(1, u.workdayMin));
      v = c.laterToday + ((laterDay ? c.laterDayStartTodayMax : c.startByNow) - c.laterToday) * used;
      break;
    }
    case 'next_work_day':
      v = c.nextWorkDay;
      break;
    case 'within_3_work_days':
      v = c.within3WorkDays;
      break;
    case 'later':
      v = c.later;
      break;
    default:
      v = c.noNeedBy;
  }
  if (bucket !== 'late' && bucket !== 'no_need_by') v *= u.dueKind === 'soft' ? c.softFactor : u.dueKind === 'inferred' ? c.inferredFactor : 1;
  if (u.awaitingThem) v *= c.awaitingThemFactor;
  return { value: round3(clamp01(v)), bucket };
}

/** P = V × (floor + U) + rule effects + manual adjustment. */
export function priorityOf(value: number, urgency: number, floor: number, extra = 0): number {
  return round3(value * (floor + urgency) + extra);
}
