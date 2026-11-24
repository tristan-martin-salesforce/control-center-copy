/**
 * Per-item scoring: features → deadline/start-by → weighted components → policy rules.
 * Formula (docs/reference/ENGINES.md §2): total = Σ weight·feature·10 over the weighted components
 *   + userAdjustment + penalty-rule effects + boost/sla-rule effects. Everything is deterministic.
 */
import type { Meeting, PersonLite, PriorityItem, PriorityLane, StakeholderTier, TimeWindow, WorkingHours } from '@/engines/types';
import { estimateYouMin, type EstimateSource, type Estimator } from './estimate';
import { hashOf } from './hash';
import { evalPredicate, type FeatureValues, type PolicyRule, type PriorityPolicy } from './policy';
import { clampToWorking, DAY_MS, formatDuration, formatLocalWhen, HOUR_MS, MINUTE_MS, toMs, type Interval } from './time';
import { latePhrase, lateState, mattersFrom, nowPhrase, type LateState, type WhyParts } from './why';
import type { ComponentKey, Deadline, RankReason, RuleHit, ScoreComponent } from './types';

export const POINTS_PER_WEIGHT = 10;

export const TIER_SCORE: Record<StakeholderTier, number> = {
  leader: 1,
  customer_exec: 1,
  manager: 0.9,
  customer: 0.8,
  ae: 0.7,
  partner: 0.6,
  teammate: 0.5,
  normal: 0.4,
  low: 0.1,
};

const TIER_LABEL: Record<StakeholderTier, string> = {
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

export const IMPORTANCE_SCORE = { critical: 1, high: 0.75, normal: 0.4, low: 0.15 } as const;

export const KIND_COMMITMENT: Record<PriorityItem['kind'], number> = {
  ask: 1,
  commitment: 0.8,
  follow_up: 0.7,
  deliverable: 0.7,
  task: 0.4,
  travel: 0.4,
  training: 0.3,
};

const KIND_REASON: Partial<Record<PriorityItem['kind'], string>> = {
  ask: 'asked of you',
  commitment: 'you promised',
  follow_up: 'meeting follow-up',
  deliverable: 'deliverable',
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function tierOf(p: PersonLite): StakeholderTier {
  if (p.tier) return p.tier;
  if (p.isManager) return 'manager';
  if (p.isExternal) return 'customer';
  return 'normal';
}

export interface ScoreContext {
  nowMs: number;
  policy: PriorityPolicy;
  meetingsById: Map<string, Meeting>;
  /** itemId → meetingId, from meetings' prep links. */
  prepFor: Map<string, string>;
  windows: TimeWindow[];
  utcOffsetMinutes: number;
  /** Hands-on estimate defaults + calibration (estimate.ts). */
  estimator: Estimator;
  /** The persona's working hours and UTC offset: overdue grace counts working days (R1). */
  workingHours: WorkingHours;
  /** Free working intervals from now on (windows minus busy meetings), for "free time before it". */
  free: Interval[];
}

/** Everything computed for one item before ordering. */
export interface Prepared {
  item: PriorityItem;
  /** Hands-on minutes as planned: the item's own estimate, else the (calibrated) default for its kind. */
  youMin: number;
  effortSource: EstimateSource;
  features: FeatureValues;
  /** The upcoming meeting it serves (null when none, or the meeting already started). */
  meeting: Meeting | null;
  deadline: Deadline | null;
  deadlineMs: number | null;
  startByMs: number | null;
  slackMinutes: number | null;
  preempt: boolean;
  /** R1: set once the deadline (due date or SLA) has passed: grace day, late, or re-date. */
  late: LateState | null;
  /** Free working minutes between now and the deadline (null when there is none, or it passed). */
  freeBeforeMin: number | null;
  ageDays: number;
  agentRemainingMin: number;
  components: ScoreComponent[];
  ruleHits: RuleHit[];
  total: number;
  laneFloor: PriorityLane | null;
  laneCap: PriorityLane | null;
  excluded: boolean;
  inputsHash: string;
}

function bestStakeholder(item: PriorityItem): { person: PersonLite; tier: StakeholderTier } | null {
  let best: { person: PersonLite; tier: StakeholderTier } | null = null;
  for (const p of item.stakeholders ?? []) {
    if (p.isMe) continue;
    const tier = tierOf(p);
    if (!best || TIER_SCORE[tier] > TIER_SCORE[best.tier]) best = { person: p, tier };
  }
  return best;
}

export function servedMeeting(item: PriorityItem, ctx: ScoreContext): Meeting | null {
  const id = item.servesEventId ?? ctx.prepFor.get(item.id) ?? null;
  if (!id) return null;
  return ctx.meetingsById.get(id) ?? null;
}

export function computeFeatures(item: PriorityItem, meeting: Meeting | null, ctx: ScoreContext, youMin: number = item.effort.youMin): FeatureValues {
  const now = ctx.nowMs;
  const stakeholders = item.stakeholders ?? [];
  const best = bestStakeholder(item);
  const upcoming = meeting && toMs(meeting.start) > now ? meeting : null;
  const externalMeeting = !!upcoming && !!(upcoming.hasExternalAttendees || upcoming.isCustomerFacing);
  const customerFacing =
    item.customerFacing ??
    (stakeholders.some((p) => !p.isMe && (p.isExternal || tierOf(p) === 'customer' || tierOf(p) === 'customer_exec')) ||
      externalMeeting);
  const fromManager = item.fromManager ?? stakeholders.some((p) => !p.isMe && (p.isManager || tierOf(p) === 'manager'));
  const dueIso = item.due ?? (item.kind === 'training' ? (item.training?.requiredBy ?? null) : null);
  const askedMs = toMs(item.askedAt ?? item.createdAt);
  return {
    kind: item.kind,
    status: item.status,
    importance: item.importance ?? 'normal',
    source: item.source ?? null,
    customer_facing: customerFacing,
    from_manager: fromManager,
    serves_meeting: !!upcoming,
    serves_external_meeting: externalMeeting,
    is_customer_prep: externalMeeting || (customerFacing && !!upcoming),
    is_training: item.kind === 'training',
    mandatory_training: item.kind === 'training' && !!item.training?.mandatory,
    has_due: !!dueIso,
    due_within_hours: dueIso ? round3((toMs(dueIso) - now) / HOUR_MS) : null,
    meeting_within_hours: upcoming ? round3((toMs(upcoming.start) - now) / HOUR_MS) : null,
    age_days: Math.max(0, Math.floor((now - askedMs) / DAY_MS)),
    you_min: youMin,
    agent_min: item.effort.agentMin,
    stakeholder_tier: best?.tier ?? null,
    has_opp: !!item.oppId,
    account_id: item.accountId ?? null,
    opp_id: item.oppId ?? null,
    initiative_id: item.initiativeId ?? null,
  };
}

const enabledRules = (policy: PriorityPolicy): PolicyRule[] => policy.rules.filter((r) => r.enabled);

/** Deadline = earliest of the item's due date, the upcoming meeting it serves, and any SLA rule. */
export function effectiveDeadline(
  item: PriorityItem,
  meeting: Meeting | null,
  features: FeatureValues,
  ctx: ScoreContext,
): { deadline: Deadline | null; ms: number | null; slaHits: Array<{ rule: PolicyRule; dueMs: number }> } {
  const now = ctx.nowMs;
  const off = ctx.utcOffsetMinutes;
  const cands: Array<{ ms: number; d: Deadline }> = [];
  const dueIso = item.due ?? (item.kind === 'training' ? (item.training?.requiredBy ?? null) : null);
  if (dueIso) {
    const ms = toMs(dueIso);
    cands.push({ ms, d: { at: dueIso, source: 'due', label: ms <= now ? lateState(ms, now, item.dueKind ?? null, ctx.workingHours)!.label : `due ${formatLocalWhen(ms, now, off)}` } });
  }
  if (meeting) {
    const ms = toMs(meeting.start);
    if (ms > now)
      cands.push({ ms, d: { at: meeting.start, source: 'meeting', label: `${meeting.title} ${formatLocalWhen(ms, now, off)}`, eventId: meeting.id } });
  }
  const slaHits: Array<{ rule: PolicyRule; dueMs: number }> = [];
  const askedMs = toMs(item.askedAt ?? item.createdAt);
  for (const rule of enabledRules(ctx.policy)) {
    if (rule.kind !== 'sla' || rule.slaHours === undefined) continue;
    if (!evalPredicate(rule.condition, features)) continue;
    const ms = askedMs + rule.slaHours * HOUR_MS;
    slaHits.push({ rule, dueMs: ms });
    const label = ms <= now ? `${lateState(ms, now, 'hard', ctx.workingHours)!.label} (your ${rule.slaHours}h rule)` : `by ${formatLocalWhen(ms, now, off)} (your ${rule.slaHours}h rule)`;
    cands.push({ ms, d: { at: new Date(ms).toISOString(), source: 'sla', label } });
  }
  // R1/PRIO-9: a passed SLA does not make an item "late" while its own due date or meeting is still ahead (a manager's
  // Saturday ask due at Wednesday's 10:00 sync is due 10:00, not "3 d late"); the SLA hit still counts as a rule.
  if (cands.some((c) => c.d.source !== 'sla' && c.ms > now)) {
    for (let i = cands.length - 1; i >= 0; i--) if (cands[i]!.d.source === 'sla' && cands[i]!.ms <= now) cands.splice(i, 1);
  }
  if (cands.length === 0) return { deadline: null, ms: null, slaHits };
  // Earliest wins; on a tie prefer the meeting, then the due date, then the SLA (most concrete first).
  const order = { meeting: 0, due: 1, sla: 2 } as const;
  cands.sort((a, b) => a.ms - b.ms || order[a.d.source] - order[b.d.source]);
  const first = cands[0]!;
  return { deadline: first.d, ms: first.ms, slaHits };
}

function component(key: ComponentKey, feature: number, weight: number, reason: string | null): ScoreComponent {
  const f = Math.max(0, Math.min(1, feature));
  const points = round3(weight * f * POINTS_PER_WEIGHT);
  return { key, feature: round3(f), weight, points, reason: points > 0 ? reason : null };
}

const effortFitFeature = (youMin: number): number =>
  youMin <= 5 ? 1 : youMin <= 15 ? 0.8 : youMin <= 30 ? 0.6 : youMin <= 60 ? 0.35 : youMin <= 120 ? 0.15 : 0.05;

export function prepare(item: PriorityItem, ctx: ScoreContext): Prepared {
  const { nowMs: now, policy } = ctx;
  const w = policy.weights;
  const t = policy.tuning;
  const off = ctx.utcOffsetMinutes;
  const meetingAny = servedMeeting(item, ctx);
  const meeting = meetingAny && toMs(meetingAny.start) > now ? meetingAny : null;
  const est = estimateYouMin(item, ctx.estimator);
  const youMin = est.youMin;
  const features = computeFeatures(item, meetingAny, ctx, youMin);
  const { deadline, ms: deadlineMs, slaHits } = effectiveDeadline(item, meeting, features, ctx);

  const agentRemainingMin = item.agentStarted ? 0 : item.effort.agentMin;
  // R1: a passed deadline (due or SLA; a meeting deadline is always ahead) is late, not "start by Mon".
  const late =
    deadlineMs !== null && deadlineMs <= now && deadline
      ? lateState(deadlineMs, now, deadline.source === 'due' ? (item.dueKind ?? null) : 'hard', ctx.workingHours)
      : null;
  let startByMs: number | null = null;
  let slackMinutes: number | null = null;
  if (deadlineMs !== null && !late) {
    const raw = deadlineMs - (t.bufferMin + agentRemainingMin + youMin) * MINUTE_MS;
    startByMs = clampToWorking(raw, youMin, ctx.windows);
    slackMinutes = Math.round((startByMs - now) / MINUTE_MS);
  }
  // "Now late unless started": not started yet, the deadline still ahead, start-by within the grace.
  const preempt =
    item.status === 'open' &&
    deadlineMs !== null &&
    startByMs !== null &&
    deadlineMs > now &&
    startByMs <= now + t.preemptGraceMin * MINUTE_MS;

  const hoursLeft = deadlineMs === null ? null : (deadlineMs - now) / HOUR_MS;
  // Soft and inferred dates weigh less while ahead; once passed, the late state sets the urgency instead.
  const dueKindFactor = !late && deadline?.source === 'due' ? (item.dueKind === 'soft' ? 0.8 : item.dueKind === 'inferred' ? 0.6 : 1) : 1;

  // deadline proximity: ½ at 8 h, ¼ at 24 h; once passed, the late urgency (1 in the grace day, then 0.6; 0.4 soft).
  let deadlineReason: string | null = null;
  if (deadline && hoursLeft !== null) {
    if (late) deadlineReason = late.label;
    else if (deadline.source === 'meeting') {
      deadlineReason = hoursLeft <= 24 && meeting ? `${meeting.title} in ${formatDuration(hoursLeft * 60)}` : deadline.label;
    } else deadlineReason = deadline.label;
  }
  const deadlineF = hoursLeft === null ? 0 : late ? late.urgency : 1 / (1 + hoursLeft / 8);

  // calendar pressure (least slack first): 1 when late unless started now, ½ at 90 min of slack; late → its urgency.
  const pressureF = late ? late.urgency : slackMinutes === null ? 0 : slackMinutes <= 0 ? 1 : 1 / (1 + slackMinutes / 90);
  const pressureReason = late
    ? late.verb
      ? late.verb.toLowerCase()
      : 'late: do it now'
    : startByMs === null
      ? null
      : slackMinutes !== null && slackMinutes <= 0
        ? `late unless started now (start by ${formatLocalWhen(startByMs, now, off)})`
        : `start by ${formatLocalWhen(startByMs, now, off)}`;

  // lead time: long agent runs that serve a near deadline should be kicked off early (never once it has passed).
  const leadF =
    agentRemainingMin > 0 && hoursLeft !== null && !late
      ? Math.min(1, agentRemainingMin / 180) * (hoursLeft <= 24 ? 1 : 24 / hoursLeft)
      : 0;
  const leadReason = `agent needs ~${formatDuration(agentRemainingMin)}: kick off early`;

  const best = bestStakeholder(item);
  const importance = item.importance ?? 'normal';
  const tierF = best ? TIER_SCORE[best.tier] : 0;
  const impF = IMPORTANCE_SCORE[importance];
  const stakeF = Math.max(tierF, impF);
  // "importance: normal" says nothing (PRIO-13): only a high or critical importance is named
  const stakeReason =
    best && tierF >= impF ? `${best.person.name} (${TIER_LABEL[best.tier]})` : importance === 'critical' || importance === 'high' ? `importance: ${importance}` : null;

  const amount = item.oppAmount ?? 0;
  const dealF = dealValueFeature(amount);
  const dealReason = amount > 0 ? `opp ${usdShort(amount)}` : null;

  const ageDays = features.age_days as number;
  const staleF = Math.min(1, ageDays / 45);

  let obligationF = 0;
  let obligationReason: string | null = null;
  if (features.mandatory_training) {
    const h = features.due_within_hours as number | null;
    obligationF = h === null ? 0.2 : h <= 0 ? 1 : h <= 48 ? 0.8 : h <= 168 ? 0.5 : 0.2;
    obligationReason = h !== null && h <= 0 ? 'mandatory training overdue' : 'mandatory training';
  }

  const components: ScoreComponent[] = [
    component('deadlineProximity', deadlineF * dueKindFactor, w.deadlineProximity, deadlineReason),
    component('calendarPressure', pressureF, w.calendarPressure, pressureReason),
    component('leadTime', leadF, w.leadTime, leadReason),
    component('effortFit', effortFitFeature(youMin), w.effortFit, youMin <= 15 ? `quick: you ${formatDuration(youMin)}` : null),
    component('stakeholderImportance', stakeF, w.stakeholderImportance, stakeReason),
    component('dealValue', dealF, w.dealValue, dealReason),
    component('commitmentWeight', KIND_COMMITMENT[item.kind], w.commitment, KIND_REASON[item.kind] ?? null),
    component('staleness', staleF, w.staleness, ageDays >= 7 ? `${ageDays}d old` : null),
    component('obligationBoost', obligationF, w.obligation, obligationReason),
  ];
  const userAdj = round3(item.userAdjustment ?? 0);
  components.push({ key: 'userAdjustment', feature: userAdj, weight: 1, points: userAdj, reason: userAdj !== 0 ? 'your manual adjustment' : null });

  // Rules.
  const ruleHits: RuleHit[] = [];
  let penalty = 0;
  let boosts = 0;
  let laneFloor: PriorityLane | null = null;
  let laneCap: PriorityLane | null = null;
  let excluded = false;
  for (const { rule, dueMs } of slaHits) {
    const when = formatLocalWhen(dueMs, now, off);
    const breached = dueMs <= now;
    const effect = rule.effectValue ?? null;
    if (effect !== null) boosts += effect;
    ruleHits.push({
      ruleKey: rule.ruleKey,
      kind: 'sla',
      label: rule.label,
      effect,
      explanation: `${rule.explanation}: ${breached ? `${lateState(dueMs, now, 'hard', ctx.workingHours)!.label} (since ${when})` : `by ${when}`}`,
    });
  }
  for (const rule of enabledRules(policy)) {
    if (rule.kind === 'sla' || rule.kind === 'never_above') continue;
    if (!evalPredicate(rule.condition, features)) continue;
    switch (rule.kind) {
      case 'boost':
        boosts += rule.effectValue ?? 0;
        ruleHits.push({ ruleKey: rule.ruleKey, kind: 'boost', label: rule.label, effect: rule.effectValue ?? 0, explanation: rule.explanation });
        break;
      case 'penalty': {
        const e = -Math.abs(rule.effectValue ?? 0);
        penalty += e;
        ruleHits.push({ ruleKey: rule.ruleKey, kind: 'penalty', label: rule.label, effect: e, explanation: rule.explanation });
        break;
      }
      case 'lane_floor':
        laneFloor = higherLane(laneFloor, rule.effectLane ?? null);
        ruleHits.push({ ruleKey: rule.ruleKey, kind: 'lane_floor', label: rule.label, effect: null, explanation: rule.explanation });
        break;
      case 'lane_cap':
        laneCap = lowerLane(laneCap, rule.effectLane ?? null);
        ruleHits.push({ ruleKey: rule.ruleKey, kind: 'lane_cap', label: rule.label, effect: null, explanation: rule.explanation });
        break;
      case 'exclude':
        excluded = true;
        ruleHits.push({ ruleKey: rule.ruleKey, kind: 'exclude', label: rule.label, effect: null, explanation: rule.explanation });
        break;
    }
  }
  components.push({ key: 'penalty', feature: round3(penalty), weight: 1, points: round3(penalty), reason: penalty !== 0 ? 'policy penalty' : null });

  const total = round3(components.reduce((s, c) => s + c.points, 0) + boosts);

  const inputsHash = hashOf({
    item,
    youMin,
    meeting: meetingAny ? { id: meetingAny.id, start: meetingAny.start, ext: !!meetingAny.hasExternalAttendees, cf: !!meetingAny.isCustomerFacing } : null,
    policyId: policy.id,
    policyVersion: policy.version,
    nowBucket: Math.floor(now / (5 * MINUTE_MS)),
  });

  return {
    item,
    youMin,
    effortSource: est.source,
    features,
    meeting,
    deadline,
    deadlineMs,
    startByMs,
    slackMinutes,
    preempt,
    late,
    freeBeforeMin: deadlineMs !== null && deadlineMs > now ? freeMinutesBefore(ctx.free, now, deadlineMs) : null,
    ageDays,
    agentRemainingMin,
    components,
    ruleHits,
    total,
    laneFloor,
    laneCap,
    excluded,
    inputsHash,
  };
}

const LANE_ORDER: Record<PriorityLane, number> = { top3: 0, now: 1, next: 2, later: 3, background: 4, hidden: 5 };
export const laneOrder = (l: PriorityLane): number => LANE_ORDER[l];
function higherLane(a: PriorityLane | null, b: PriorityLane | null): PriorityLane | null {
  if (!a) return b;
  if (!b) return a;
  return LANE_ORDER[a] <= LANE_ORDER[b] ? a : b;
}
function lowerLane(a: PriorityLane | null, b: PriorityLane | null): PriorityLane | null {
  if (!a) return b;
  if (!b) return a;
  return LANE_ORDER[a] >= LANE_ORDER[b] ? a : b;
}

/** Contributors sorted by contribution, rules phrased in the user's own words. */
export function reasonsOf(p: Prepared): RankReason[] {
  const out: RankReason[] = [];
  for (const c of p.components) if (c.reason && c.points !== 0) out.push({ key: c.key, label: c.reason, contribution: c.points });
  for (const h of p.ruleHits) {
    if (h.kind === 'penalty') continue; // already in the penalty component
    out.push({ key: `rule:${h.ruleKey}`, label: h.explanation, contribution: h.effect ?? 0 });
  }
  return out.sort((a, b) => b.contribution - a.contribution || a.key.localeCompare(b.key));
}

/**
 * Deal value (R2, PRIO-10): a monotone tier table, so a $2M deal weighs more than a $500k one (the old √(amount/$500k)
 * saturated at $500k). The tiers are lane 07 §4.1's (< $100k .3, < $500k .5, < $1M .7, < $3M .9, ≥ $3M 1); the
 * priority@2 weights and the stage factor come later.
 */
export const DEAL_TIERS: ReadonlyArray<readonly [number, number]> = [
  [3_000_000, 1],
  [1_000_000, 0.9],
  [500_000, 0.7],
  [100_000, 0.5],
  [0, 0.3],
];

export function dealValueFeature(amount: number): number {
  if (!(amount > 0)) return 0;
  for (const [min, f] of DEAL_TIERS) if (amount >= min) return f;
  return 0;
}

/** "$780k", "$1.25M". */
export function usdShort(amount: number): string {
  if (amount >= 1_000_000) return `$${Math.round(amount / 10_000) / 100}M`;
  return `$${Math.round(amount / 1000)}k`;
}

function freeMinutesBefore(free: readonly Interval[], fromMs: number, toMsValue: number): number {
  let total = 0;
  for (const i of free) {
    const s = Math.max(i.startMs, fromMs);
    const e = Math.min(i.endMs, toMsValue);
    if (e > s) total += (e - s) / MINUTE_MS;
  }
  return Math.round(total);
}

/** The two-part why for a prepared item, from the same terms that scored it (R7). */
export function whyOf(p: Prepared, ctx: Pick<ScoreContext, 'nowMs' | 'utcOffsetMinutes'>): WhyParts {
  const matters = mattersFrom(p.components.map((c) => ({ key: c.key, label: c.reason ?? '', contribution: c.points })));
  const now = p.late
    ? latePhrase(p.late)
    : nowPhrase({
        nowMs: ctx.nowMs,
        utcOffsetMinutes: ctx.utcOffsetMinutes,
        late: null,
        deadlineLabel: p.deadline?.label ?? null,
        deadlineMs: p.deadlineMs,
        startByMs: p.startByMs,
        youMin: p.youMin,
        freeBeforeMin: p.freeBeforeMin,
        ageDays: p.ageDays,
      });
  return { matters, now };
}
