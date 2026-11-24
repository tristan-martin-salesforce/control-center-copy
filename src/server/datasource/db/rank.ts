/**
 * Ranking for the db DataSource.
 *
 * Reads: the order comes from Postgres — DATA-MODEL Q1 (work_items lane + rank cache, which points at the
 * current priority_scores row) for ranked items, then the rankable items that have no score yet. When the
 * user has no scores at all (a fresh database the scanner filled), the fallback order is due date, then
 * importance, then age.
 *
 * A `DbRanker` turns the read model into a ranking, the Today Top 3 and a policy preview:
 * - `enginesRanker` (the default): ENGINES-core, `rankWork()` / `rerank()` / `previewPolicy()` from
 *   src/engines/priority. Inputs are built here (PriorityItem from WorkItemRecord + people, meetings =
 *   calendar today + 3 days, the policy through ./policy-map.ts, working hours from settings.profile). Top 3
 *   stability: GET /today shows `rerank(previousTop3, fresh)`, so positions move only on user action, an
 *   urgent pre-emption or an explicit re-rank; `nowStack.rerankReady` is the engine's count.
 * - `interimRanker`: the mock's deterministic scorer (mock/rank.ts). The mock ↔ db parity suite injects it
 *   so both sides rank the same seed identically (D-RANK); nothing else uses it.
 */
import type { PolicyPreview, PriorityPolicy, RankReason, RankRow, TodayHeader, WorkItemRecord } from '@/contract';
import { previewPolicy as enginePreview } from '@/engines/priority/preview';
import { PRIORITY_ENGINE_VERSION, type ComponentKey, type PriorityInputs, type RankingResult, type RuleHit } from '@/engines/priority/types';
import { rerank } from '@/engines/priority/stability';
import { meetingsFrom, priorityItemsFrom } from '@/engines/priority/inputs';

import { computeRanking, scoreItem, type Scored } from '../mock/rank';
import type { Store } from '../mock/store';
import { agentStartedFor, capacityInputs, toContractCapacity } from './capacity';
import type { ReadModel } from './model';
import { enginePolicyFromContract } from './policy-map';
import { applyNudges, type PriorityConfig } from '@/engines/priority/v2/config';
import { engineOf, nudgesOf, rankShown } from '@/engines/priority/v2/shadow';
import { personaOf } from '@/personas';

/** The engine the user runs (`settings.priority.engine`; default shadow). */
const engineSettingOf = (m: Pick<ReadModel, 'settings'>) => engineOf(m.settings() as { priority?: unknown });

/** priority@2's config: the persona's priority block with the accepted learning nudges (bounded). */
export function priorityConfigOf(m: Pick<ReadModel, 'settings'> & { ctx?: { kv?: ReadonlyMap<string, unknown> } }): PriorityConfig {
  return applyNudges(personaOf(m.settings()).priority, nudgesOf(m.ctx?.kv));
}

export { priorityFor, derivedPriority, RANKABLE_STATES, isRankable } from '../mock/rank';
export type { Scored };

/** Per-item engine output persisted on the priority_scores row. */
export interface ScoreDetail {
  lane: 'top3' | 'now' | 'next' | 'later' | 'background' | 'hidden';
  startBy: string | null;
  slackMinutes: number | null;
  explanation: string;
  inputsHash: string;
  components: Partial<Record<ComponentKey, number>>;
  ruleHits: RuleHit[];
  /** priority@2 rows: V, U and the terms (`priority_scores.value`, `urgency`, `terms`); the component columns stay empty. */
  v2?: { value: number; urgency: number; terms: Record<string, number> };
}

export interface DbRanking {
  engineVersion: string;
  /** Rankable items in their final order (Top 3 first). */
  ranked: Scored[];
  /** ENGINES-core only: per-item detail for every scored item (ranked, background, rule-hidden). */
  details?: Map<string, ScoreDetail>;
  result?: RankingResult;
}

/** What GET /today shows. `plan` (ENGINES-core) replaces the seeded spine slots, capacity and shelves. */
export interface TodayRank {
  top: WorkItemRecord[];
  rest: WorkItemRecord[];
  rerankReady: number;
  plan?: {
    capacity: TodayHeader['capacity'];
    slots: { id: string; kind: 'work' | 'gap' | 'fit_in' | 'focus'; start: string; end: string; label: string; workItemId: string | null }[];
    fitIns: { id: string; hint: string }[];
    promises: { id: string; hint: string; verb: 'kick_off' | 'renegotiate' }[];
  };
}

export interface DbRanker {
  readonly engineVersion: string;
  rank(model: ReadModel, policy: PriorityPolicy, now: Date): DbRanking;
  /** Top 3 + the rest from the stored order (Q1), with the stability rule of this ranker. */
  today(model: ReadModel, stored: WorkItemRecord[], now: Date): TodayRank;
  /** Before/after Top 10 under `proposed` vs the current policy (nothing is written). */
  preview(model: ReadModel, stored: WorkItemRecord[], proposed: PriorityPolicy, now: Date): PolicyPreview;
  /** One item's score under `policy` (chat "move to #1" computes the boost from it). */
  scoreOf(item: WorkItemRecord, model: ReadModel, policy: PriorityPolicy, now: Date): number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Stored order: ranked ids in Q1 order, then unranked rankable items (fallback when nothing is ranked). */
export function storedOrderFrom(model: ReadModel, rankedIds: string[]): WorkItemRecord[] {
  const rankable = model.all('workItems').filter((w) => ['open', 'in_progress', 'waiting_on_me', 'likely_done', 'reopened'].includes(w.state) && !w.isBackground);
  const pos = new Map(rankedIds.map((id, i) => [id, i]));
  const ranked = rankable.filter((w) => w.rank !== null).sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || (a.rank ?? 0) - (b.rank ?? 0));
  const unranked = rankable.filter((w) => w.rank === null);
  if (!ranked.length) {
    // fallback: nothing has a priority_scores row yet → due, then importance (the extractor's), then age
    const imp = { critical: 0, high: 1, normal: 2, low: 3 } as const;
    return unranked.sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9') || imp[a.importance ?? 'normal'] - imp[b.importance ?? 'normal'] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  return [...ranked, ...unranked.sort((a, b) => a.createdAt.localeCompare(b.createdAt))];
}

export function toRankRows(model: ReadModel, scored: Scored[], baseline: string[], limit = 10): RankRow[] {
  return scored.slice(0, limit).map((s, i) => {
    const before = baseline.indexOf(s.id);
    return { workItemId: s.id, title: model.get('workItems', s.id)?.title ?? s.id, rank: i + 1, score: s.score, moved: before === -1 ? 0 : before - i, topReason: s.reasons[0]?.label ?? null };
  });
}

function previewSummary(changedCount: number, lead: RankRow | undefined, before: RankRow[]): string {
  return changedCount ? `${changedCount} of the Top 10 move${lead && lead.workItemId !== before[0]?.workItemId ? `; "${lead.title}" takes #1` : ''}` : 'No change to the Top 10';
}

// ---------------------------------------------------------------------------
// Interim ranker: the mock's scorer (parity only)
// ---------------------------------------------------------------------------

/** The mock scorer reads `get('events' | 'opps', id)` and `all('workItems')` only. */
function asStore(model: ReadModel): Store {
  return { get: (col: string, id: string) => model.get(col as never, id), all: (col: string) => model.all(col as never) } as unknown as Store;
}

export const interimRanker: DbRanker = {
  engineVersion: 'cc-interim@1',
  rank: (model, policy, now) => ({ engineVersion: 'cc-interim@1', ranked: computeRanking(asStore(model), policy, now) }),
  scoreOf: (item, model, policy, now) => scoreItem(item, asStore(model), policy, now).score,
  today(model, ordered, now) {
    let top = ordered.slice(0, 3);
    // the mock's rule: a waiting-on-me item whose meeting starts within 3 h takes the third slot
    const promote = ordered.slice(3).find((i) => {
      if (i.state !== 'waiting_on_me' || !i.servesEventId) return false;
      const ev = model.get('events', i.servesEventId);
      return ev ? (Date.parse(ev.start) - now.getTime()) / 3_600_000 <= 3 && Date.parse(ev.start) > now.getTime() : false;
    });
    if (promote && top.length === 3) top = [top[0]!, top[1]!, promote];
    const ids = new Set(top.map((i) => i.id));
    const current = ordered.map((i) => i.id);
    const fresh = computeRanking(asStore(model), model.settings().policy, new Date(model.meta().rankedAt)).map((s) => s.id);
    let changed = 0;
    for (let i = 0; i < Math.min(10, Math.max(current.length, fresh.length)); i++) if (current[i] !== fresh[i]) changed++;
    return { top, rest: ordered.filter((i) => !ids.has(i.id)), rerankReady: changed };
  },
  preview(model, ordered, proposed, now) {
    const baseline = ordered.map((i) => i.id);
    const current = model.settings().policy;
    const before = ordered.slice(0, 10).map((w, i) => {
      const s = scoreItem(w, asStore(model), current, now);
      return { workItemId: w.id, title: w.title, rank: i + 1, score: s.score, moved: 0, topReason: s.reasons[0]?.label ?? null };
    });
    const after = toRankRows(model, computeRanking(asStore(model), proposed, now), baseline, 10);
    const changedCount = after.filter((r, i) => before[i]?.workItemId !== r.workItemId).length;
    return { basedOnVersion: current.version, before, after, changedCount, summary: previewSummary(changedCount, after[0], before) };
  },
};

// ---------------------------------------------------------------------------
// ENGINES-core
// ---------------------------------------------------------------------------

const STARTED_RUN = new Set(['running', 'waiting_on_you', 'done_review', 'done']);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Minutes east of UTC for an IANA zone at an instant (the engine plans with a fixed offset). */
export function utcOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The engine's inputs from the read model (pure; no I/O). */
export function priorityInputs(m: ReadModel, policy: PriorityPolicy, now: Date, opts: { rowId?: string } = {}): PriorityInputs {
  const profile = m.settings().profile;
  const current = m.settings().policy;
  const engine = m.extra.policyEngine;
  const utcOffset = utcOffsetMinutes(profile.timezone, now);
  return {
    now: now.toISOString(),
    // the shared pure builder (engines/priority/inputs.ts): the golden-day evals run the same mapping
    items: priorityItemsFrom({
      items: m.all('workItems'),
      person: (id) => m.get('people', id),
      oppAmount: (id) => m.get('opps', id)?.amount ?? null,
      evidence: m.all('evidence'),
      agentStarted: (w) => agentStartedFor(w as WorkItemRecord, m, STARTED_RUN),
    }),
    meetings: meetingsFrom(m.all('events'), now),
    // priority@2 plans back over 10 working days with the persona's priority block (+ accepted learning nudges);
    // priority@1.1 ignores both
    horizonMeetings: meetingsFrom(m.all('events'), now, 16),
    priorityConfig: priorityConfigOf(m),
    // the stored row id names the version a score was computed under (the proposed one has none yet)
    policy: enginePolicyFromContract(policy, { rowId: opts.rowId ?? (policy.version === current.version ? (m.extra.policyRowId ?? policy.id) : `${policy.id}@v${policy.version}`), obligation: engine.obligation, top3Size: engine.top3Size }),
    workingHours: { start: profile.workingHours.start, end: profile.workingHours.end, days: profile.workingHours.days, utcOffsetMinutes: utcOffset, ...(profile.timezone ? { timeZone: profile.timezone } : {}) },
    // capacity (DESIGN-V2): pinned items, approvals + re-auth chores, agents in flight, effort actuals
    ...capacityInputs(m, now, utcOffset),
  };
}

/** GET /today's capacity: the engine's (rankWork), the same for the mock and the db DataSource. */
export function todayCapacity(m: ReadModel, now: Date): TodayHeader['capacity'] {
  return toContractCapacity(rankShown(engineSettingOf(m), priorityInputs(m, m.settings().policy, now)).capacity);
}

function scoredOf(r: RankingResult): Scored[] {
  const top = r.top3.map((id) => r.scores[id]!).filter(Boolean);
  const rest = r.ranked.filter((s) => !r.top3.includes(s.workItemId));
  return [...top, ...rest].map((s) => ({ id: s.workItemId, score: round2(s.total), reasons: s.reasons.slice(0, 5).map((x): RankReason => ({ key: x.key, label: x.label, contribution: round2(x.contribution) })) }));
}

export const enginesRanker: DbRanker = {
  engineVersion: PRIORITY_ENGINE_VERSION,
  rank(model, policy, now) {
    // settings.priority.engine: v2 ranks and stores as priority@2; v1 and shadow store priority@1.1 (shadow's v2 run
    // is recorded beside it by rerankIn)
    const result = rankShown(engineSettingOf(model), priorityInputs(model, policy, now));
    const details = new Map<string, ScoreDetail>();
    for (const s of Object.values(result.scores)) {
      details.set(s.workItemId, {
        lane: result.top3.includes(s.workItemId) ? 'top3' : s.lane === 'top3' ? 'now' : s.lane,
        startBy: s.startBy,
        slackMinutes: s.slackMinutes === null ? null : Math.round(s.slackMinutes),
        explanation: s.explanation,
        inputsHash: s.inputsHash,
        components: s.v2 ? {} : Object.fromEntries(s.components.map((c) => [c.key, c.points])),
        ruleHits: s.ruleHits,
        ...(s.v2 ? { v2: { value: s.v2.value, urgency: s.v2.urgency, terms: s.v2.terms } } : {}),
      });
    }
    return { engineVersion: result.engineVersion, ranked: scoredOf(result), details, result };
  },
  scoreOf(item, model, policy, now) {
    const result = rankShown(engineSettingOf(model), priorityInputs(model, policy, now));
    return round2(result.scores[item.id]?.total ?? 0);
  },
  today(model, stored, now) {
    const fresh = rankShown(engineSettingOf(model), priorityInputs(model, model.settings().policy, now));
    const previous = stored.slice(0, fresh.top3Size).map((i) => i.id);
    const rr = rerank(previous, fresh);
    const top = rr.top3.map((id) => model.get('workItems', id)).filter((w): w is WorkItemRecord => !!w);
    const shown = new Set(top.map((w) => w.id));
    const dayEnd = new Date(now.getTime() + 86_400_000).getTime();
    return {
      top,
      rest: stored.filter((i) => !shown.has(i.id)),
      rerankReady: rr.rerankReady,
      plan: {
        capacity: toContractCapacity(fresh.capacity),
        slots: fresh.spine.filter((s) => Date.parse(s.start) < dayEnd).map((s) => ({ id: s.id, kind: s.kind, start: s.start, end: s.end, label: s.label, workItemId: s.workItemId })),
        fitIns: fresh.fitIns.map((f) => ({ id: f.workItemId, hint: f.hint })),
        promises: fresh.background.map((b) => ({ id: b.workItemId, hint: b.hint, verb: b.action.verb })),
      },
    };
  },
  preview(model, _stored, proposed, now) {
    const current = model.settings().policy;
    const inputs = priorityInputs(model, current, now);
    const p = enginePreview(inputs.policy, priorityInputs(model, proposed, now).policy, inputs);
    const row = (r: (typeof p.before)[number]): RankRow => ({ workItemId: r.workItemId, title: r.title, rank: r.rank, score: round2(r.score), moved: r.moved, topReason: r.topReason });
    const before = p.before.map(row);
    const after = p.after.map(row);
    return { basedOnVersion: current.version, before, after, changedCount: p.changedCount, summary: p.summary || previewSummary(p.changedCount, after[0], before) };
  },
};
