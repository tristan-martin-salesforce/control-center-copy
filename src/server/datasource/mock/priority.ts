/**
 * priority@2 for the mock DataSource (parity with db/priority.ts): the preview, the feedback log, the learning rule and
 * Health's priority line, in memory. The engine inputs come from the same builder as the db DataSource
 * (db/rank.ts `priorityInputs`) over the store's read-model surface, so both rank the same seed the same way.
 *
 * Like the db, a re-rank in shadow records both orders (here: in memory), and Health reads the last 7 days of them, so a
 * fresh seed says "no runs yet" on both sides. Feedback rows and rules live in memory for the session; `runFeedbackPass`
 * is the nightly pass (a suggestion appears only after it, as in the db).
 */
import type { PriorityFeedbackAction, PriorityHealth, PriorityPreview, PriorityRule } from '@/contract';
import { prioritySettingsOf } from '@/contract';
import { rankWork } from '@/engines/priority/rank';
import { agreementAt3, disagreements } from '@/engines/priority/v2/compare';
import { rankWorkV2 } from '@/engines/priority/v2/rank';
import { suggestRule, termAgreement, type FeedbackRowLike } from '@/engines/priority/v2/feedback';

import { DEFAULT_OBLIGATION_WEIGHT } from '../db/policy-map';
import { feedbackSnapshot, NUDGES_KEY, nudgesOf, previewOf, shownEngineVersion } from '@/engines/priority/v2/shadow';
import type { ReadModel } from '../db/model';
import { priorityInputs } from '../db/rank';
import type { Store } from './store';

interface MockRule extends PriorityRule {
  key: string;
}

export class MockPriority {
  private readonly feedback: Array<FeedbackRowLike & { itemId: string; engineVersion: string; at: string }> = [];
  private readonly rules: MockRule[] = [];
  private readonly kv = new Map<string, unknown>();
  /** Shadow runs, tied to the policy version they ran under (db: priority_runs cascade with their policy row, so Undo of a reseed drops its runs). */
  private readonly runs: Array<{ at: number; policyVersion: number; agreement3: number; shown: string[]; shadow: string[] }> = [];

  /** A re-rank happened: in shadow, record both orders (db parity: priority_runs.ranking / shadow_ranking). */
  recordRun(store: Store, now: Date, policy = store.settings().policy): void {
    if (prioritySettingsOf(store.settings().priority).engine !== 'shadow') return;
    const inputs = priorityInputs(this.model(store), policy, now);
    const v1 = rankWork(inputs);
    const v2 = rankWorkV2(inputs);
    this.runs.push({ at: now.getTime(), policyVersion: policy.version, agreement3: agreementAt3(v1.top3, v2.top3), shown: v1.ranked.slice(0, 20).map((s) => s.workItemId), shadow: v2.ranked.slice(0, 20).map((s) => s.workItemId) });
  }

  /** The store through the read-model surface the engine inputs read (as mockCapacity does), with this session's nudges. */
  model(store: Store): ReadModel {
    return {
      all: (col: string) => store.all(col as never),
      get: (col: string, id: string) => store.get(col as never, id),
      settings: () => store.settings(),
      ctx: { kv: this.kv },
      extra: { policyRowId: null, policyEngine: { obligation: DEFAULT_OBLIGATION_WEIGHT, top3Size: 3 } },
    } as unknown as ReadModel;
  }

  preview(store: Store, now: Date): PriorityPreview {
    const m = this.model(store);
    return previewOf(priorityInputs(m, store.settings().policy, now), (id) => store.get('workItems', id)?.title ?? '');
  }

  record(store: Store, now: Date, o: { itemId: string; action: PriorityFeedbackAction; fromRank: number | null; toRank: number | null }): void {
    const m = this.model(store);
    const engine = prioritySettingsOf(store.settings().priority).engine;
    const snapshot = feedbackSnapshot(o.itemId, rankWorkV2(priorityInputs(m, store.settings().policy, now)));
    this.feedback.push({ ...o, snapshot, engineVersion: shownEngineVersion(engine), at: now.toISOString() });
  }

  feedbackCount(): number {
    return this.feedback.length;
  }

  private suggestion(): MockRule | null {
    return this.rules.find((r) => r.status === 'suggested') ?? null;
  }

  /** The nightly learning pass (db parity: `priority.feedback`): at most one suggested rule from the session's moves. */
  runFeedbackPass(now: Date): MockRule | null {
    if (this.rules.some((r) => r.status === 'suggested')) return null;
    const s = suggestRule(termAgreement(this.feedback));
    if (!s || this.rules.some((r) => r.key === s.key)) return null;
    const rule: MockRule = { id: `00000000-0000-4000-8000-${String(this.rules.length + 1).padStart(12, '0')}`, key: s.key, text: s.text, term: s.term, nudge: s.nudge, status: 'suggested', pairs: s.pairs, createdAt: now.toISOString(), decidedAt: null };
    this.rules.push(rule);
    return rule;
  }

  decide(id: string, decision: 'apply' | 'dismiss', now: Date): PriorityRule | null {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return null;
    if (r.status !== 'suggested') return strip(r);
    r.status = decision === 'apply' ? 'applied' : 'dismissed';
    r.decidedAt = now.toISOString();
    if (decision === 'apply') this.kv.set(NUDGES_KEY, [...nudgesOf(this.kv), r.nudge]);
    return strip(r);
  }

  health(store: Store, now: Date): PriorityHealth {
    const engine = prioritySettingsOf(store.settings().priority).engine;
    const versions = new Set([store.settings().policy.version, ...store.all('policyVersions').map((v) => v.version)]);
    const recent = this.runs.filter((r) => r.at >= now.getTime() - 7 * 86_400_000 && versions.has(r.policyVersion)).sort((x, y) => y.at - x.at);
    const agreement3 = recent.length ? Math.round((recent.reduce((t, r) => t + r.agreement3, 0) / recent.length) * 100) / 100 : null;
    const latest = recent[0];
    const dis = latest ? disagreements(latest.shown, latest.shadow, (id) => store.get('workItems', id)?.title ?? 'A to-do').map(({ workItemId, title, v1Rank, v2Rank }) => ({ workItemId, title, v1Rank, v2Rank })) : [];
    const suggestion = this.suggestion();
    const applied = this.rules.filter((r) => r.status === 'applied').length;
    const where = engine === 'v2' ? 'on' : engine === 'shadow' ? 'in shadow' : 'off';
    const line =
      engine === 'v1'
        ? 'Ranking: priority@1.1 (priority@2 is off)'
        : `Ranking: priority@2 ${where}${agreement3 === null ? ' · no runs yet' : ` · agrees ${agreement3.toFixed(2)} on the Top 3 over 7 days (${recent.length} run${recent.length === 1 ? '' : 's'})`}${applied ? ` · ${applied} learned rule${applied === 1 ? '' : 's'}` : ''}`;
    return { engine, runs: recent.length, agreement3, disagreements: dis, line, suggestion: suggestion ? strip(suggestion) : null, appliedRules: applied };
  }
}

function strip(r: MockRule): PriorityRule {
  const { key: _key, ...rest } = r;
  return rest;
}
