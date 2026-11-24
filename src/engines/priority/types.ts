/**
 * Priority engine inputs and outputs. Output names mirror `priority_scores` (components as columns,
 * `latest_start_at`, `slack_minutes`, `lane`, `rank`, `inputs_hash`, `explanation`),
 * `priority_score_rule_hits`, `priority_plan_steps` and `priority_runs.available_focus_minutes`;
 * view-facing names mirror W0 (`RankReason`, `SpineSlot`, `ShelfEntry`, `capacity`, `rerankReady`).
 */
import type {
  Effort,
  Meeting,
  PlanStepMode,
  PolicyRuleKind,
  PriorityItem,
  PriorityLane,
  TimeWindow,
  WorkingHours,
  WorkItemKind,
  WorkItemStatus,
} from '@/engines/types';
import type { Calibration, EffortActual, EstimateKind, EstimateSource, HandsOnDefaults } from './estimate';
import type { FeatureValues, PriorityPolicy } from './policy';
import type { LateState, WhyParts } from './why';
import type { AdminBatch } from './v2/admin';
import type { MakeRoom } from './v2/capacity';
import type { PriorityConfig } from './v2/config';
import type { Chase, V2Facts } from './v2/rank';

/** priority@1.1: overdue decay, likely-done out of the ranking, deal tiers, the two-part why (lane 07 R1, R2, R7). */
export const PRIORITY_ENGINE_VERSION = 'priority@1.1';

/**
 * What priority@2 reads beyond `PriorityItem` (all optional: priority@1.1 ignores them, and an item without them
 * defaults: no admin class, awaiting none, no size class). `size` and `awaiting` are the extractor's / the resolution
 * check's when they exist (lane 07 §4.3); `counterpartyId` names who the item is with.
 */
export interface PriorityItemV2 extends PriorityItem {
  adminClass?: string | null;
  awaiting?: 'me' | 'them' | 'none' | null;
  /** When it started waiting on them (the expected reply is planned from here). */
  awaitingSince?: string | null;
  size?: 'xs' | 's' | 'm' | 'l' | 'xl' | null;
  counterpartyId?: string | null;
}

export interface PriorityInputs {
  now: string;
  items: PriorityItemV2[];
  /** Today + the next 3 days. */
  meetings: Meeting[];
  policy: PriorityPolicy;
  workingHours: WorkingHours;
  /** Optional override of the working windows the engine would derive from `workingHours`. */
  workingWindows?: TimeWindow[];
  /** Items explicitly pinned or planned for today ("Pull in", a start-by you set to today): always today's load. */
  pinnedToday?: string[];
  /** Hands-on chores waiting on you today that are not work items (Outbox approvals, connector re-auth). */
  chores?: CapacityChore[];
  /** Agent runs in flight now (queued or running). Background only: they never count against capacity. */
  runningAgents?: RunningAgent[];
  /** Hands-on estimate defaults and recent actuals for calibration (estimate.ts). */
  estimates?: { defaults?: Partial<HandsOnDefaults>; actuals?: EffortActual[] };
  /** priority@2: the persona's priority block (with accepted learning nudges applied). priority@1.1 ignores it. */
  priorityConfig?: PriorityConfig;
  /** priority@2: meetings over the backward plan's horizon (10 working days); defaults to `meetings`. */
  horizonMeetings?: Meeting[];
  /** priority@2: items waiting on others (not ranked), for the chase list. */
  waitingItems?: PriorityItemV2[];
}

/** A hands-on chore that is not a work item. `kind` picks the default estimate. */
export interface CapacityChore {
  id: string;
  kind: EstimateKind;
  title: string;
  /** The work item it belongs to (a draft's item). Skipped when that item is already today's load. */
  workItemId?: string | null;
  /** Its own estimate; else the (calibrated) default for its kind. */
  youMin?: number | null;
}

/** A chore as planned: approvals are batched into one "Approve N drafts". */
export interface PlannedChore {
  id: string;
  kind: EstimateKind;
  title: string;
  youMin: number;
  count: number;
  choreIds: string[];
}

export interface RunningAgent {
  id: string;
  workItemId: string | null;
  /** Agent minutes still to run, when known. */
  agentMinLeft?: number | null;
}

export interface PullForwardEntry {
  itemId: string;
  title: string;
  youMin: number;
  /** The deadline it serves (due, meeting or SLA), or null. */
  due: string | null;
}

/** `priority_scores` component columns, camelCase. */
export type ComponentKey =
  | 'deadlineProximity'
  | 'calendarPressure'
  | 'leadTime'
  | 'effortFit'
  | 'stakeholderImportance'
  | 'dealValue'
  | 'commitmentWeight'
  | 'staleness'
  | 'obligationBoost'
  | 'userAdjustment'
  | 'penalty';

export const COMPONENT_KEYS: readonly ComponentKey[] = [
  'deadlineProximity',
  'calendarPressure',
  'leadTime',
  'effortFit',
  'stakeholderImportance',
  'dealValue',
  'commitmentWeight',
  'staleness',
  'obligationBoost',
  'userAdjustment',
  'penalty',
];

export interface ScoreComponent {
  key: ComponentKey;
  /** Feature value in [0,1] (raw points for userAdjustment / penalty). */
  feature: number;
  /** The policy weight applied (1 for unweighted components). */
  weight: number;
  /** Points contributed to `total` (`priority_scores.<column>`). */
  points: number;
  /** Human-readable, in the user's terms ("ACME demo in 5h"). Null when it contributes nothing. */
  reason: string | null;
}

/** `priority_score_rule_hits`. */
export interface RuleHit {
  ruleKey: string;
  kind: PolicyRuleKind;
  label: string;
  /** Points added (negative demotes); null for lane/sla/never_above effects. */
  effect: number | null;
  explanation: string;
}

/** W0 `RankReason`: one line per contributor, sorted by contribution. */
export interface RankReason {
  /** A ComponentKey, `rule:<ruleKey>`, or `sequencing`. */
  key: string;
  label: string;
  contribution: number;
}

export interface Deadline {
  at: string;
  source: 'due' | 'meeting' | 'sla';
  /** "ACME demo Thu 14:00", "due 11:00", "your 24h rule: by Thu 10:00". */
  label: string;
  eventId?: string;
}

export interface ScoredItem {
  workItemId: string;
  title: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  /** The policy this score was computed under (R-UI-16: every score carries its policy version). */
  policyId: string;
  policyVersion: number;
  total: number;
  components: ScoreComponent[];
  ruleHits: RuleHit[];
  reasons: RankReason[];
  /** One line for the card's why ("ACME demo 14:00 · kick off now: agent ~3h"). */
  explanation: string;
  /** R7: the card's why from the same terms: why it matters (who, deal, kind) and why now (late, deadline, start-by). */
  why: WhyParts;
  /** R1: set once the deadline passed: the grace day, late ("Late: do now or re-date") or re-date ("Re-date or drop"). */
  late: LateState | null;
  lane: PriorityLane;
  /** 1-based final rank among ranked items; null in background/hidden. */
  rank: number | null;
  /** Position by score alone (before sequencing and never_above), 1-based. */
  scoreRank: number | null;
  deadline: Deadline | null;
  /** `latest_start_at`: deadline − buffer − agent lead time − your effort, clamped to working hours. */
  startBy: string | null;
  /** Local "10:45" / "Thu 14:00" for the StartBy chip. */
  startByLabel: string | null;
  /** `slack_minutes`: start-by minus now. Negative = late. */
  slackMinutes: number | null;
  /** "Now late unless started": start-by within the pre-emption grace and the deadline not yet passed. */
  preempt: boolean;
  /** Effort as planned: `youMin` is the item's own estimate, else the (calibrated) default for its kind. */
  effort: Effort;
  effortSource: EstimateSource;
  top3Eligible: boolean;
  /** The feature view the policy predicates were evaluated against (for "why" and tests). */
  features: FeatureValues;
  /** Set when kick-off-first sequencing moved this item above others (R-UI-4). */
  sequencing: { movedAbove: string[]; reason: string } | null;
  inputsHash: string;
  /** priority@2 only: value, urgency, the terms and the planned start-by behind `total`. */
  v2?: V2Facts;
}

export interface BackgroundEntry {
  workItemId: string;
  title: string;
  ageDays: number;
  /** "promised 70d ago" */
  hint: string;
  action: { label: string; verb: 'kick_off' | 'renegotiate' };
  score: number;
  policyVersion: number;
}

export interface Gap {
  start: string;
  end: string;
  minutes: number;
}

export interface FitInEntry {
  workItemId: string;
  title: string;
  /** "fits your 11:30 gap" */
  hint: string;
  gap: Gap;
  plannedStart: string;
  plannedEnd: string;
  youMin: number;
  action: { label: string; verb: 'start' };
}

/** W0 `SpineSlot`: labels only; they never duplicate cards. */
export interface SpineSlot {
  id: string;
  kind: 'work' | 'gap' | 'fit_in' | 'focus';
  start: string;
  end: string;
  label: string;
  workItemId: string | null;
  mode: PlanStepMode | null;
}

/** `priority_plan_steps`. */
export interface PlanStep {
  ordinal: number;
  workItemId: string | null;
  calendarEventId: string | null;
  mode: PlanStepMode;
  plannedStartAt: string;
  plannedEndAt: string;
  reason: string;
}

export interface Capacity {
  /** MIN-22: the working day counted: today, or the next working day once today's working hours are over. */
  day: 'today' | 'next';
  /** That day in words: "today", "tomorrow", "Monday". */
  dayLabel: string;
  /** Hands-on minutes of today-scoped work still to do (items + chores). Agent time never counts. */
  youMinToday: number;
  /** Free minutes outside busy meetings, from now to the end of working hours (= Σ gaps). */
  freeMin: number;
  /** freeMin − youMinToday. Negative = overbooked by that much. */
  openMin: number;
  /** youMinToday ≤ freeMin. "Overbooked" is said only when this is false. */
  fits: boolean;
  /** Agent and Claude-session minutes running in parallel: today's kick-offs plus runs in flight. */
  agentMinBackground: number;
  agentRunsBackground: number;
  /** Up to 5 items that are not today's load, worth pulling in, in rank order. Empty when the day is full. */
  pullForward: PullForwardEntry[];
  /** The today-scoped items behind `youMinToday`, in rank order. */
  todayItemIds: string[];
  /** The chores behind `youMinToday`. */
  chores: PlannedChore[];
  /** Legacy (W0): = freeMin (`priority_runs.available_focus_minutes`). */
  focusMinLeft: number;
  /** Legacy (W0): = youMinToday. */
  plannedMin: number;
  /** Legacy (W0): = youMinToday − freeMin. Positive = over-planned by this many minutes. */
  overByMin: number;
  /** Agent minutes behind today's kick-offs (runs in the background; never counted as yours). */
  agentMinQueued: number;
}

export interface RankingResult {
  engineVersion: string;
  policyId: string;
  policyVersion: number;
  computedAt: string;
  /** Ranked items in final order (rank 1..n). Background and hidden items are not here. */
  ranked: ScoredItem[];
  top3: string[];
  /** The policy's Top 3 size (`priority_policies.top3_size`). */
  top3Size: number;
  lanes: Record<PriorityLane, string[]>;
  /** Old, low-priority commitments, oldest first (R-UI-8). */
  background: BackgroundEntry[];
  fitIns: FitInEntry[];
  /** Fit-in candidates that found no gap today. */
  fitInOverflow: string[];
  gaps: Gap[];
  spine: SpineSlot[];
  planSteps: PlanStep[];
  capacity: Capacity;
  /** Per-kind estimate calibration learned from the actuals (empty when there are none). */
  calibration: Calibration;
  nextMeeting: { eventId: string; title: string; start: string; minutesUntil: number } | null;
  excluded: Array<{ workItemId: string; reason: string }>;
  /** All scored items by id (ranked + background + rule-hidden). */
  scores: Record<string, ScoredItem>;
  /** priority@2: the quiet admin batch (one row, never individually in the Top N). */
  adminBatch?: AdminBatch | null;
  /** priority@2: what to move when today is overbooked (lowest value × latest deadline first). */
  makeRoom?: MakeRoom | null;
  /** priority@2: chases planned at the expected reply time of items waiting on others. */
  chases?: Chase[];
}
