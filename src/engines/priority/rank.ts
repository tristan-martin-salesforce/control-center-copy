/**
 * rankWork: the deterministic priority engine (R-UI-2, 4, 8, 16).
 *
 * Pipeline (docs/reference/ENGINES.md §2):
 *  1. filter rankable statuses (open, in_progress, waiting_on_me); likely-done items wait in Looks done (R1);
 *  2. score each item (score.ts): deadline, start-by, components, policy rules;
 *  3. split off rule-excluded (hidden) and background promises (old, low-priority commitments);
 *  4. sort by score; 5. kick-off-first sequencing (R-UI-4); 6. never_above constraints;
 *  7. Top 3 + lanes; 8. day plan (gaps, spine, fit-ins, capacity).
 */
import type { Meeting, PriorityLane, WorkItemStatus } from '@/engines/types';
import { computeCapacity, nextWorkdayCapacity, planChores, todayScope } from './capacity';
import { makeEstimator } from './estimate';
import { evalPredicate, type Predicate, type PriorityPolicy } from './policy';
import { planDay } from './plan';
import { laneOrder, prepare, reasonsOf, whyOf, type Prepared, type ScoreContext } from './score';
import { DAY_MS, formatDuration, formatLocalWhen, freeIntervals, HOUR_MS, isBusy, localDayStart, MINUTE_MS, toMs, workingWindows } from './time';
import {
  PRIORITY_ENGINE_VERSION,
  type BackgroundEntry,
  type PriorityInputs,
  type RankingResult,
  type RankReason,
  type RuleHit,
  type ScoredItem,
} from './types';

/** R1 (priority@1.1): likely-done items are not ranked; they wait for one click in Looks done. */
export const RANKABLE_STATUSES: readonly WorkItemStatus[] = ['open', 'in_progress', 'waiting_on_me'];

const EXCLUDED_REASON: Partial<Record<WorkItemStatus, string>> = {
  likely_done: 'Looks done: waiting for your confirm',
  waiting_on_others: 'Waiting on others: shown in the rail',
  suggested: 'Suggested: lives in Triage',
  snoozed: 'Snoozed',
  done: 'Done',
  dismissed: 'Dismissed',
  merged: 'Merged',
};

function compareByScore(a: Prepared, b: Prepared): number {
  return (
    b.total - a.total ||
    (a.startByMs ?? Infinity) - (b.startByMs ?? Infinity) ||
    (a.deadlineMs ?? Infinity) - (b.deadlineMs ?? Infinity) ||
    a.item.id.localeCompare(b.item.id)
  );
}

function isBackground(p: Prepared, policy: PriorityPolicy, nowMs: number): boolean {
  if (p.laneFloor) return false;
  if (p.item.isBackground === true) return true;
  const t = policy.tuning;
  if (p.item.kind !== 'commitment' || p.item.status !== 'open') return false;
  if (p.ageDays < t.background.afterDays) return false;
  if (p.deadlineMs !== null && p.deadlineMs - nowMs <= t.horizonDays * DAY_MS) return false;
  return p.total < t.background.maxScore;
}

function isKickoff(p: Prepared, nowMs: number, policy: PriorityPolicy): boolean {
  const s = policy.tuning.sequencing;
  return (
    p.agentRemainingMin > 0 &&
    p.agentRemainingMin >= s.minAgentMin &&
    (p.item.status === 'open' || p.item.status === 'in_progress') &&
    p.deadlineMs !== null &&
    p.deadlineMs > nowMs &&
    p.deadlineMs - nowMs <= s.horizonHours * HOUR_MS
  );
}

interface SeqMove {
  movedAbove: Prepared[];
}

/**
 * Kick-off-first (R-UI-4, UI-SPEC §1.8 "lead time beats effort"): an item whose long agent run serves a
 * near deadline moves up to the earliest position where every item it jumps over still starts by its
 * own start-by (projected in rank order, your minutes only; agent time runs in parallel).
 * It never jumps an item that is "late unless started now".
 */
function sequenceKickoffs(order: Prepared[], nowMs: number, policy: PriorityPolicy, allow: (p: Prepared) => boolean = () => true): { order: Prepared[]; moves: Map<string, SeqMove> } {
  const moves = new Map<string, SeqMove>();
  let list = order.slice();
  const kickoffs = list
    .filter((p) => isKickoff(p, nowMs, policy) && allow(p))
    .sort((a, b) => (a.startByMs ?? Infinity) - (b.startByMs ?? Infinity) || a.item.id.localeCompare(b.item.id));
  for (const a of kickoffs) {
    const idx = list.indexOf(a);
    if (idx <= 0) continue;
    const rest = list.filter((x) => x !== a);
    let chosen = idx;
    for (let p = 0; p < idx; p++) {
      if (canInsert(rest, a, p, idx, nowMs)) {
        chosen = p;
        break;
      }
    }
    if (chosen < idx) {
      const jumped = rest.slice(chosen, idx);
      list = [...rest.slice(0, chosen), a, ...rest.slice(chosen)];
      moves.set(a.item.id, { movedAbove: jumped });
    }
  }
  return { order: list, moves };
}

function canInsert(rest: Prepared[], a: Prepared, p: number, idx: number, nowMs: number): boolean {
  let t = nowMs;
  for (let k = 0; k < p; k++) t += rest[k]!.youMin * MINUTE_MS;
  t += a.youMin * MINUTE_MS;
  for (let j = p; j < idx; j++) {
    const x = rest[j]!;
    if (x.preempt) return false;
    if (x.startByMs !== null && t > x.startByMs) return false;
    t += x.youMin * MINUTE_MS;
  }
  return true;
}

/** A `never_above` protected item. A likely-done item no longer needs protecting. */
const isProtected = (p: Prepared, other: Predicate): boolean => p.item.status !== 'likely_done' && evalPredicate(other, p.features);

/** never_above: an item matching `condition` never ranks above one matching `otherCondition`. */
function applyNeverAbove(order: Prepared[], policy: PriorityPolicy, extraHits: Map<string, RuleHit[]>): Prepared[] {
  let list = order.slice();
  for (const rule of policy.rules) {
    if (!rule.enabled || rule.kind !== 'never_above' || !rule.otherCondition) continue;
    const other = rule.otherCondition;
    const isA = (p: Prepared) => evalPredicate(rule.condition, p.features) && !evalPredicate(other, p.features);
    const isB = (p: Prepared) => isProtected(p, other);
    let lastB = -1;
    list.forEach((p, i) => {
      if (isB(p)) lastB = i;
    });
    if (lastB < 0) continue;
    const head = list.slice(0, lastB + 1);
    const moved = head.filter(isA);
    if (moved.length === 0) continue;
    const kept = head.filter((p) => !moved.includes(p));
    list = [...kept, ...moved, ...list.slice(lastB + 1)];
    for (const p of moved) {
      const hits = extraHits.get(p.item.id) ?? [];
      hits.push({ ruleKey: rule.ruleKey, kind: 'never_above', label: rule.label, effect: null, explanation: rule.explanation });
      extraHits.set(p.item.id, hits);
    }
  }
  return list;
}

/**
 * Lanes regroup the order (Top 3 → Now → Next → Later), so never_above also caps the lane: an item it
 * applies to sits no higher than the lowest protected item's lane. never_above beats lane_floor.
 */
function demoteNeverAboveLanes(ordered: Prepared[], laneOf: Map<string, PriorityLane>, policy: PriorityPolicy, extraHits: Map<string, RuleHit[]>): void {
  for (const rule of policy.rules) {
    if (!rule.enabled || rule.kind !== 'never_above' || !rule.otherCondition) continue;
    const other = rule.otherCondition;
    const protectedLanes = ordered.filter((p) => isProtected(p, other)).map((p) => laneOf.get(p.item.id)!);
    if (protectedLanes.length === 0) continue;
    const lowest = protectedLanes.reduce((a, b) => (laneOrder(b) > laneOrder(a) ? b : a));
    for (const p of ordered) {
      if (!evalPredicate(rule.condition, p.features) || evalPredicate(other, p.features)) continue;
      const lane = laneOf.get(p.item.id)!;
      if (lane === 'top3' || laneOrder(lane) >= laneOrder(lowest)) continue;
      laneOf.set(p.item.id, lowest);
      const hits = extraHits.get(p.item.id) ?? [];
      if (!hits.some((h) => h.ruleKey === rule.ruleKey))
        hits.push({ ruleKey: rule.ruleKey, kind: 'never_above', label: rule.label, effect: null, explanation: rule.explanation });
      extraHits.set(p.item.id, hits);
    }
  }
}

/** An item a never_above rule applies to can't take a Top 3 slot while a protected item can't have one. */
function blockedByNeverAbove(p: Prepared, ordered: Prepared[], policy: PriorityPolicy): boolean {
  for (const rule of policy.rules) {
    if (!rule.enabled || rule.kind !== 'never_above' || !rule.otherCondition) continue;
    const other = rule.otherCondition;
    if (!evalPredicate(rule.condition, p.features) || evalPredicate(other, p.features)) continue;
    if (ordered.some((b) => isProtected(b, other) && !top3Eligible(b, policy))) return true;
  }
  return false;
}

function top3Eligible(p: Prepared, policy: PriorityPolicy): boolean {
  if (p.laneCap && laneOrder(p.laneCap) > laneOrder('top3')) return false;
  if (p.item.status === 'likely_done') return false;
  if (p.item.kind === 'training') {
    const h = p.features.due_within_hours;
    return typeof h === 'number' && h <= policy.tuning.fitIn.promoteWithinHours;
  }
  return true;
}

function baseLane(p: Prepared, nowMs: number, todayEndMs: number, policy: PriorityPolicy): PriorityLane {
  let lane: PriorityLane;
  if (p.item.status === 'in_progress' || p.item.status === 'waiting_on_me' || p.item.status === 'likely_done') lane = 'now';
  else if (p.deadlineMs !== null && p.deadlineMs <= todayEndMs) lane = 'now';
  else if (p.startByMs !== null && p.startByMs <= todayEndMs) lane = 'now';
  else if (p.deadlineMs !== null && p.deadlineMs <= nowMs + policy.tuning.nextDays * DAY_MS) lane = 'next';
  else lane = 'later';
  if (p.laneFloor) {
    const floor = p.laneFloor === 'top3' ? 'now' : p.laneFloor;
    if (laneOrder(floor) < laneOrder(lane)) lane = floor;
  }
  if (p.laneCap && laneOrder(p.laneCap) > laneOrder(lane)) lane = p.laneCap;
  return lane;
}

/**
 * The seam priority@2 plugs into (src/engines/priority/v2/rank.ts): the same pipeline (rules, sequencing, never_above,
 * Top N, lanes, day plan, capacity), with the scores and start-bys rewritten after `prepare` and the admin batch kept
 * out of the Top N. Without an engine, rankWork is priority@1.1 exactly.
 */
export interface RankEngine {
  version: string;
  /** Runs once every rankable item is prepared: may rewrite `total`, `startByMs`, `slackMinutes`, `preempt`. */
  afterPrepare?(prepared: Prepared[], ctx: ScoreContext, inputs: PriorityInputs): void;
  /**
   * Tail sections after every lane, in order (0 = the main list): priority@2 puts re-date rows (1) and then the admin
   * batch (2) there. Tail items are never fit-ins or pull-forward suggestions.
   */
  tail?(p: Prepared): number;
  /** Whether an item may take a Top N slot at all (the admin batch never does). Default: yes. */
  topNEligible?(p: Prepared): boolean;
  /** The lane an item takes after the shared rules (late items that only need re-dating move down). */
  lane?(p: Prepared, base: PriorityLane): PriorityLane;
  /** Which items kick-off-first sequencing may move up (default: every kick-off). */
  canKickOff?(p: Prepared): boolean;
  /** Items that are today's load whatever their dates (the promoted admin block). */
  extraToday?(): ReadonlySet<string>;
  decorate?(s: ScoredItem, p: Prepared): ScoredItem;
  finish?(r: RankingResult, state: { prepared: Prepared[]; today: Prepared[]; ctx: ScoreContext }): RankingResult;
}

function emptyLanes(): Record<PriorityLane, string[]> {
  return { top3: [], now: [], next: [], later: [], background: [], hidden: [] };
}

export function rankWork(inputs: PriorityInputs, engine: RankEngine | null = null): RankingResult {
  const policy = inputs.policy;
  const nowMs = toMs(inputs.now);
  const off = inputs.workingHours.utcOffsetMinutes;
  const windows = inputs.workingWindows ?? workingWindows(inputs.workingHours, nowMs, policy.tuning.horizonDays);
  const meetings: Meeting[] = [...inputs.meetings].sort((a, b) => toMs(a.start) - toMs(b.start) || a.id.localeCompare(b.id));
  const meetingsById = new Map(meetings.map((m) => [m.id, m]));
  const prepFor = new Map<string, string>();
  for (const m of meetings) {
    if (toMs(m.start) <= nowMs) continue; // the earliest upcoming meeting wins
    for (const id of m.prepItemIds ?? []) if (!prepFor.has(id)) prepFor.set(id, m.id);
  }
  const estimator = makeEstimator(inputs.estimates);
  const busy = meetings.filter(isBusy).map((m) => ({ startMs: toMs(m.start), endMs: toMs(m.end) }));
  const free = freeIntervals(windows, busy, nowMs, 5);
  const ctx: ScoreContext = { nowMs, policy, meetingsById, prepFor, windows, utcOffsetMinutes: off, estimator, workingHours: inputs.workingHours, free };

  const items = [...inputs.items].sort((a, b) => a.id.localeCompare(b.id));
  const excluded: RankingResult['excluded'] = [];
  const prepared: Prepared[] = [];
  for (const item of items) {
    if (!RANKABLE_STATUSES.includes(item.status)) {
      excluded.push({ workItemId: item.id, reason: EXCLUDED_REASON[item.status] ?? item.status });
      continue;
    }
    prepared.push(prepare(item, ctx));
  }
  engine?.afterPrepare?.(prepared, ctx, inputs);
  const tailOf = (p: Prepared): number => engine?.tail?.(p) ?? 0;
  const isTail = (p: Prepared): boolean => tailOf(p) > 0;

  const hidden = prepared.filter((p) => p.excluded);
  for (const p of hidden) excluded.push({ workItemId: p.item.id, reason: p.ruleHits.find((h) => h.kind === 'exclude')?.explanation ?? 'Excluded by policy' });
  const visible = prepared.filter((p) => !p.excluded);
  const background = visible.filter((p) => isBackground(p, policy, nowMs));
  const active = visible.filter((p) => !background.includes(p)).sort(compareByScore);
  const scoreRank = new Map(active.map((p, i) => [p.item.id, i + 1]));

  const { order: sequenced, moves } = sequenceKickoffs(active, nowMs, policy, engine?.canKickOff);
  const extraHits = new Map<string, RuleHit[]>();
  const neverAbove = applyNeverAbove(sequenced, policy, extraHits);
  const ordered = engine?.tail ? neverAbove.map((p, i) => ({ p, i, t: tailOf(p) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.p) : neverAbove;

  // Top 3 (lane_floor top3 first), then lanes.
  const eligible = (p: Prepared): boolean => (engine?.topNEligible ? engine.topNEligible(p) : true) && top3Eligible(p, policy) && !blockedByNeverAbove(p, ordered, policy);
  const floorTop = ordered.filter((p) => p.laneFloor === 'top3' && eligible(p));
  const top3Prepared = [...floorTop, ...ordered.filter((p) => !floorTop.includes(p) && eligible(p))].slice(0, policy.top3Size);
  const top3Set = new Set(top3Prepared.map((p) => p.item.id));
  const todayEndMs = localDayStart(nowMs, off) + DAY_MS;
  const laneOf = new Map<string, PriorityLane>();
  const laneFor = (p: Prepared): PriorityLane => {
    const base = baseLane(p, nowMs, todayEndMs, policy);
    return engine?.lane ? engine.lane(p, base) : base;
  };
  for (const p of ordered) laneOf.set(p.item.id, top3Set.has(p.item.id) ? 'top3' : isTail(p) ? 'later' : laneFor(p));
  // A kick-off sequenced above an item shows above it: promote it to that item's lane (never_above still wins).
  for (const [id, move] of moves) {
    for (const x of move.movedAbove) {
      const lx = laneOf.get(x.item.id)!;
      if (lx !== 'top3' && laneOrder(lx) < laneOrder(laneOf.get(id)!)) laneOf.set(id, lx);
    }
  }
  demoteNeverAboveLanes(ordered, laneOf, policy, extraHits);
  const finalOrder = [
    ...top3Prepared,
    ...(['now', 'next', 'later'] as const).flatMap((l) => ordered.filter((p) => !top3Set.has(p.item.id) && !isTail(p) && laneOf.get(p.item.id) === l)),
    ...ordered.filter(isTail),
  ];

  const finalRank = new Map(finalOrder.map((p, i) => [p.item.id, i + 1]));
  const toScored = (p: Prepared, lane: PriorityLane, rank: number | null): ScoredItem => {
    const rawMove = moves.get(p.item.id);
    // Only claim "kick off first" over items it really precedes in the final order.
    const kept = rawMove?.movedAbove.filter((x) => rank !== null && (finalRank.get(x.item.id) ?? 0) > rank) ?? [];
    const move = kept.length > 0 ? { movedAbove: kept } : undefined;
    const ruleHits = [...p.ruleHits, ...(extraHits.get(p.item.id) ?? [])];
    let reasons: RankReason[] = reasonsOf(p);
    for (const h of extraHits.get(p.item.id) ?? []) reasons.push({ key: `rule:${h.ruleKey}`, label: h.explanation, contribution: 0 });
    let sequencing: ScoredItem['sequencing'] = null;
    if (move) {
      const firstWithDeadline = move.movedAbove.find((x) => x.startByMs !== null);
      const fits = firstWithDeadline
        ? `; '${firstWithDeadline.item.title}' still fits before its start-by ${formatLocalWhen(firstWithDeadline.startByMs!, nowMs, off)}`
        : '';
      const reason = `Kick off first: agent ~${formatDuration(p.agentRemainingMin)} must finish before ${p.deadline?.label ?? 'its deadline'}${fits}`;
      sequencing = { movedAbove: move.movedAbove.map((x) => x.item.id), reason };
      reasons = [{ key: 'sequencing', label: reason, contribution: 0 }, ...reasons];
    }
    const explanation = reasons
      .slice(0, 3)
      .map((r) => r.label)
      .join(' · ');
    const scored: ScoredItem = {
      workItemId: p.item.id,
      title: p.item.title,
      kind: p.item.kind,
      status: p.item.status,
      policyId: policy.id,
      policyVersion: policy.version,
      total: p.total,
      components: p.components,
      ruleHits,
      reasons,
      explanation,
      why: whyOf(p, ctx),
      late: p.late,
      lane,
      rank,
      scoreRank: scoreRank.get(p.item.id) ?? null,
      deadline: p.deadline,
      startBy: p.startByMs === null ? null : new Date(p.startByMs).toISOString(),
      startByLabel: p.startByMs === null ? null : formatLocalWhen(p.startByMs, nowMs, off),
      slackMinutes: p.slackMinutes,
      preempt: p.preempt,
      effort: { youMin: p.youMin, agentMin: p.item.effort.agentMin },
      effortSource: p.effortSource,
      top3Eligible: eligible(p),
      features: p.features,
      sequencing,
      inputsHash: p.inputsHash,
    };
    return engine?.decorate ? engine.decorate(scored, p) : scored;
  };

  const ranked = finalOrder.map((p, i) => toScored(p, laneOf.get(p.item.id)!, i + 1));
  const lanes = emptyLanes();
  for (const s of ranked) lanes[s.lane].push(s.workItemId);

  const bgSorted = background
    .slice()
    .sort((a, b) => toMs(a.item.askedAt ?? a.item.createdAt) - toMs(b.item.askedAt ?? b.item.createdAt) || a.item.id.localeCompare(b.item.id));
  const bgEntries: BackgroundEntry[] = bgSorted.map((p) => ({
    workItemId: p.item.id,
    title: p.item.title,
    ageDays: p.ageDays,
    hint: p.item.kind === 'commitment' ? `promised ${p.ageDays}d ago` : `${p.ageDays}d old`,
    action:
      p.item.backgroundable ?? p.item.effort.agentMin > 0
        ? { label: 'Kick off', verb: 'kick_off' as const }
        : { label: 'Renegotiate', verb: 'renegotiate' as const },
    score: p.total,
    policyVersion: policy.version,
  }));
  lanes.background = bgEntries.map((b) => b.workItemId);
  lanes.hidden = hidden.map((p) => p.item.id);

  const scores: Record<string, ScoredItem> = {};
  for (const s of ranked) scores[s.workItemId] = s;
  for (const p of bgSorted) scores[p.item.id] = toScored(p, 'background', null);
  for (const p of hidden) scores[p.item.id] = toScored(p, 'hidden', null);

  // Day plan (DESIGN-V2 capacity): only today-scoped, hands-on work is load; fit-ins are suggestions.
  const dayStartMs = localDayStart(nowMs, off);
  const day = { startMs: dayStartMs, endMs: dayStartMs + DAY_MS };
  const pinned = new Set([...(inputs.pinnedToday ?? []), ...(engine?.extraToday?.() ?? [])]);
  const todayItems = [...finalOrder, ...bgSorted].filter((p) => todayScope(p, day, pinned) !== null);
  const todayIds = new Set(todayItems.map((p) => p.item.id));
  const isFitIn = (p: Prepared): boolean => {
    if (top3Set.has(p.item.id) || todayIds.has(p.item.id) || isTail(p)) return false;
    if (p.youMin <= 0 || p.youMin > policy.tuning.fitIn.maxYouMin) return false;
    if (p.item.status !== 'open' && p.item.status !== 'in_progress') return false;
    if (p.item.kind === 'training') return true;
    return p.total >= policy.tuning.fitIn.minScore;
  };
  const fitInCandidates = finalOrder.filter(isFitIn);
  const chores = planChores(inputs.chores ?? [], todayIds, estimator);
  const plan = planDay({
    nowMs,
    utcOffsetMinutes: off,
    windows,
    meetings,
    policy,
    today: todayItems,
    chores,
    fitInCandidates,
  });
  // MIN-22: after today's working hours the capacity counts the next working day (today's plan stays as it is)
  const capacity =
    nextWorkdayCapacity({ nowMs, utcOffsetMinutes: off, windows, meetings, candidates: [...finalOrder, ...bgSorted], ordered: finalOrder.filter((p) => !isTail(p)), pinned, chores: inputs.chores ?? [], estimator, runningAgents: inputs.runningAgents ?? [] }) ??
    computeCapacity({ freeMin: plan.freeMin, ordered: finalOrder.filter((p) => !isTail(p)), today: todayItems, chores, runningAgents: inputs.runningAgents ?? [] });

  const next = meetings.find((m) => toMs(m.start) > nowMs && m.status !== 'cancelled' && m.myResponse !== 'declined' && !m.isAllDay);
  const nextMeeting = next
    ? { eventId: next.id, title: next.title, start: next.start, minutesUntil: Math.round((toMs(next.start) - nowMs) / MINUTE_MS) }
    : null;

  const result: RankingResult = {
    engineVersion: engine?.version ?? PRIORITY_ENGINE_VERSION,
    policyId: policy.id,
    policyVersion: policy.version,
    computedAt: inputs.now,
    ranked,
    top3: top3Prepared.map((p) => p.item.id),
    top3Size: policy.top3Size,
    lanes,
    background: bgEntries,
    fitIns: plan.fitIns,
    fitInOverflow: plan.fitInOverflow,
    gaps: plan.gaps,
    spine: plan.spine,
    planSteps: plan.planSteps,
    capacity,
    calibration: estimator.calibration,
    nextMeeting,
    excluded: excluded.sort((a, b) => a.workItemId.localeCompare(b.workItemId)),
    scores,
  };
  return engine?.finish ? engine.finish(result, { prepared, today: todayItems, ctx }) : result;
}
