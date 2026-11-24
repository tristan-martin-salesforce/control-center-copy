/**
 * Deterministic priority scoring for the mock (BE-3 owns the real engine; this mirrors its shape).
 * score = Σ weight[k] · feature[k] (features in [0,1]) + Σ matching rule boosts + signals.boost.
 * Ties break by id so the same inputs always produce the same order.
 */
import type { PolicyWeightKey, PriorityPolicy, RankReason, RankRow, WorkItemRecord } from '@/contract';
import type { Store } from './store';

export const RANKABLE_STATES = new Set(['open', 'in_progress', 'waiting_on_me', 'likely_done', 'reopened']);

export function isRankable(item: WorkItemRecord): boolean {
  return RANKABLE_STATES.has(item.state) && !item.isBackground;
}

const WEIGHT_LABEL: Record<PolicyWeightKey, string> = {
  customer_facing: 'Customer-facing',
  meeting_proximity: 'Meeting soon',
  due_urgency: 'Due soon',
  manager_ask: 'Manager ask',
  deal_value: 'Deal value',
  lead_time: 'Long lead time',
  age: 'Waiting a while',
  effort_fit: 'Quick win',
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const H = 3_600_000;

export interface Scored {
  id: string;
  score: number;
  reasons: RankReason[];
}

export function scoreItem(item: WorkItemRecord, store: Store, policy: PriorityPolicy, now: Date): Scored {
  const nowMs = now.getTime();
  const meeting = item.servesEventId ? store.get('events', item.servesEventId) : undefined;
  const meetingInH = meeting ? (Date.parse(meeting.start) - nowMs) / H : null;
  const dueInH = item.due ? (Date.parse(item.due) - nowMs) / H : null;
  const opp = item.oppId ? store.get('opps', item.oppId) : undefined;

  const features: Record<PolicyWeightKey, number> = {
    customer_facing: item.signals.customerFacing ? 1 : 0,
    meeting_proximity: meetingInH !== null && meetingInH > -0.5 ? clamp01(1 - meetingInH / 24) : 0,
    due_urgency: dueInH !== null ? (dueInH <= 0 ? 1 : clamp01(1 - dueInH / 72)) : 0,
    manager_ask: item.signals.fromManager ? 1 : 0,
    deal_value: opp?.amount ? clamp01(opp.amount / 1_000_000) : 0,
    lead_time: clamp01(item.effort.agentMin / 120) * (meetingInH !== null && meetingInH > 0 ? 1 : 0.4),
    age: clamp01(item.ageDays / 30),
    effort_fit: item.effort.youMin <= 15 ? 1 : item.effort.youMin <= 30 ? 0.6 : item.effort.youMin <= 60 ? 0.25 : 0,
  };

  const reasons: RankReason[] = [];
  let score = 0;
  for (const key of Object.keys(features) as PolicyWeightKey[]) {
    const contribution = (policy.weights[key] ?? 0) * features[key];
    if (contribution <= 0) continue;
    score += contribution;
    let label = WEIGHT_LABEL[key];
    if (key === 'meeting_proximity' && meeting && meetingInH !== null) label = `${meeting.title} in ${fmtHours(meetingInH)}`;
    if (key === 'due_urgency' && dueInH !== null) label = dueInH <= 0 ? 'Overdue' : `Due in ${fmtHours(dueInH)}`;
    if (key === 'deal_value' && opp?.amount) label = `Deal $${Math.round(opp.amount / 1000)}k`;
    reasons.push({ key, label, contribution: round(contribution) });
  }
  for (const rule of policy.rules) {
    if (!rule.enabled) continue;
    const w = rule.when;
    if (w.kinds && !w.kinds.includes(item.kind)) continue;
    if (w.customerFacing !== undefined && w.customerFacing !== item.signals.customerFacing) continue;
    if (w.fromManager !== undefined && w.fromManager !== item.signals.fromManager) continue;
    if (w.sources && !item.sources.some((s) => w.sources!.includes(s.kind))) continue;
    if (w.dueWithinH !== undefined && (dueInH === null || dueInH > w.dueWithinH)) continue;
    score += rule.boost;
    reasons.push({ key: `rule:${rule.id}`, label: `Rule: ${rule.text}`, contribution: round(rule.boost) });
  }
  if (item.signals.boost) {
    score += item.signals.boost;
    reasons.push({ key: 'boost', label: item.signals.boost > 0 ? 'Bumped up' : 'Pushed down', contribution: round(item.signals.boost) });
  }
  reasons.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { id: item.id, score: round(score), reasons: reasons.slice(0, 4) };
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
const round = (n: number) => Math.round(n * 100) / 100;

/** Fresh ordering of rankable items under `policy`. */
export function computeRanking(store: Store, policy: PriorityPolicy, now: Date): Scored[] {
  return store
    .all('workItems')
    .filter(isRankable)
    .map((i) => scoreItem(i, store, policy, now))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** The current (stored) ordering: ranked items by rank, then unranked rankable items (e.g. fresh captures) by createdAt. */
export function storedOrder(store: Store): WorkItemRecord[] {
  const items = store.all('workItems').filter(isRankable);
  return items.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** How many of the top N positions would change if re-ranked now (drives "Re-rank ready · n"). */
export function pendingRerank(store: Store, policy: PriorityPolicy, at: Date, topN = 10): number {
  const current = storedOrder(store).map((i) => i.id);
  const fresh = computeRanking(store, policy, at).map((s) => s.id);
  let changed = 0;
  for (let i = 0; i < Math.min(topN, Math.max(current.length, fresh.length)); i++) if (current[i] !== fresh[i]) changed++;
  return changed;
}

export function priorityFor(rank: number | null): 'high' | 'medium' | 'low' {
  if (rank === null) return 'low';
  if (rank <= 5) return 'high';
  if (rank <= 15) return 'medium';
  return 'low';
}

/**
 * The contract's `priority` (lane 07 R2): a derived view field, from the rank alone, medium while unranked. Both
 * DataSources derive it the same way and never store it; `importance` is the extractor's judgment.
 */
export function derivedPriority(rank: number | null): 'high' | 'medium' | 'low' {
  return rank === null ? 'medium' : priorityFor(rank);
}

export function toRankRows(store: Store, scored: Scored[], baseline: string[], limit = 10): RankRow[] {
  return scored.slice(0, limit).map((s, i) => {
    const before = baseline.indexOf(s.id);
    return {
      workItemId: s.id,
      title: store.get('workItems', s.id)?.title ?? s.id,
      rank: i + 1,
      score: s.score,
      moved: before === -1 ? 0 : before - i,
      topReason: s.reasons[0]?.label ?? null,
    };
  });
}
