/**
 * priority@2 for the db DataSource (lane 07 R8, H-8): the engine switch, shadow runs, the preview, the feedback log,
 * the learning rules and Health's priority line. Additive: the shared ranking path (db/rank.ts, db/index.ts
 * `rerankIn`) calls in here; nothing here restructures the DataSource.
 *
 * - The engine comes from `settings.priority.engine` (default `shadow`). In shadow, every re-rank also ranks with
 *   priority@2 and the run records both orders (`ranking`, `shadow_ranking`, `agreement3`); priority@2 writes no
 *   scores and moves no rank. One run per re-rank, as before (first-scan, Health and replays count runs).
 * - The persona's priority block plus the accepted learning nudges (`cc.priority.nudges`, kept in the user's kv so the
 *   read model has them without another query, and Undo reverts them with the change set) make priority@2's config.
 * - `priority_feedback` rows hold ids and numbers only (*Local data, privacy-safe logs*).
 */
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';

import type { PriorityEngineSetting, PriorityFeedbackAction, PriorityHealth, PriorityRule } from '@/contract';
import type { DbOrTx } from '@/db/client';
import { priorityFeedback, priorityRules, priorityRuns, type PriorityRunRanking } from '@/db/schema';
import type { PriorityInputs, RankingResult } from '@/engines/priority/types';
import { agreementAt3, disagreements } from '@/engines/priority/v2/compare';
import { rankWorkV2 } from '@/engines/priority/v2/rank';
import { suggestRule, termAgreement, type FeedbackRowLike, type FeedbackSnapshot } from '@/engines/priority/v2/feedback';
import { engineOf, NUDGES_KEY, nudgesOf } from '@/engines/priority/v2/shadow';

import type { ReadModel } from './model';
import type { WriteCtx } from './store/common';
import { writeKv } from './store/common';

export { feedbackSnapshot, NUDGES_KEY, nudgesOf, previewOf, rankShown, shownEngineVersion } from '@/engines/priority/v2/shadow';

/** The engine the user runs (Settings ▸ priority; the default is shadow). */
export function engineSettingOf(m: Pick<ReadModel, 'settings'>): PriorityEngineSetting {
  return engineOf(m.settings() as { priority?: unknown });
}

function rankingOf(r: RankingResult): PriorityRunRanking {
  const terms: PriorityRunRanking['terms'] = {};
  for (const s of r.ranked.slice(0, 10)) if (s.v2) terms[s.workItemId] = { value: s.v2.value, urgency: s.v2.urgency };
  return { top3: r.top3, order: r.ranked.slice(0, 20).map((s) => s.workItemId), ...(Object.keys(terms).length ? { terms } : {}) };
}

/**
 * Shadow: rank the same inputs with priority@2 and record both orders on the run that was just written (priority@2
 * writes no scores and moves no ranks).
 */
export async function writeShadow(w: WriteCtx, o: { inputs: PriorityInputs; shown: RankingResult; runId: number }): Promise<{ agreement3: number }> {
  const v2 = rankWorkV2(o.inputs);
  const agreement3 = agreementAt3(o.shown.top3, v2.top3);
  await w.tx.update(priorityRuns).set({ ranking: rankingOf(o.shown), shadowEngineVersion: v2.engineVersion, shadowRanking: rankingOf(v2), agreement3 }).where(eq(priorityRuns.id, o.runId));
  return { agreement3 };
}

/** The shown order on the run (v2 on: Health then compares nothing; it reports the engine is on). */
export async function writeRanking(w: WriteCtx, o: { shown: RankingResult; runId: number }): Promise<void> {
  await w.tx.update(priorityRuns).set({ ranking: rankingOf(o.shown) }).where(eq(priorityRuns.id, o.runId));
}

// ---------------------------------------------------------------------------
// Feedback: every manual reorder, snooze, "not today", pin and "do first"
// ---------------------------------------------------------------------------

export async function recordFeedback(
  w: WriteCtx,
  o: { itemId: string; action: PriorityFeedbackAction; fromRank: number | null; toRank: number | null; engineVersion: string; snapshot: FeedbackSnapshot },
): Promise<void> {
  const [run] = await w.tx.select({ id: priorityRuns.id }).from(priorityRuns).where(eq(priorityRuns.ownerUserId, w.userId)).orderBy(desc(priorityRuns.id)).limit(1);
  await w.tx.insert(priorityFeedback).values({
    ownerUserId: w.userId,
    workItemId: o.itemId,
    action: o.action,
    fromRank: o.fromRank,
    toRank: o.toRank,
    engineVersion: o.engineVersion,
    runId: run?.id ?? null,
    terms: o.snapshot as unknown as Record<string, unknown>,
    createdAt: w.now,
  });
}

// ---------------------------------------------------------------------------
// The nightly pass and the rules
// ---------------------------------------------------------------------------

/** Per-term agreement over the last `days` of feedback; a suggestion row when one term keeps disagreeing. */
export async function runFeedbackPass(db: DbOrTx, userId: string, now: Date, o: { days?: number } = {}): Promise<{ rows: number; suggested: string | null }> {
  const since = new Date(now.getTime() - (o.days ?? 30) * 86_400_000);
  const rows = await db
    .select({ action: priorityFeedback.action, fromRank: priorityFeedback.fromRank, toRank: priorityFeedback.toRank, terms: priorityFeedback.terms })
    .from(priorityFeedback)
    .where(and(eq(priorityFeedback.ownerUserId, userId), gte(priorityFeedback.createdAt, since)));
  const like: FeedbackRowLike[] = rows
    .map((r) => ({ action: r.action as PriorityFeedbackAction, fromRank: r.fromRank, toRank: r.toRank, snapshot: r.terms as unknown as FeedbackSnapshot }))
    .filter((r) => r.snapshot && r.snapshot.item && Array.isArray(r.snapshot.neighbours));
  const s = suggestRule(termAgreement(like));
  if (!s) return { rows: rows.length, suggested: null };
  // the same finding once: a pending suggestion is unique per key; one decided in the last 14 days is not re-asked
  const recent = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from priority_rules
     where owner_user_id = ${userId} and rule_key = ${s.key} and (status = 'suggested' or decided_at > ${new Date(now.getTime() - 14 * 86_400_000).toISOString()}::timestamptz)`);
  if ((recent.rows[0]?.n ?? 0) > 0) return { rows: rows.length, suggested: null };
  await db
    .insert(priorityRules)
    .values({ ownerUserId: userId, ruleKey: s.key, term: s.term, target: s.nudge.target, direction: s.nudge.direction, text: s.text, status: 'suggested', pairs: s.pairs, createdAt: now })
    .onConflictDoNothing();
  return { rows: rows.length, suggested: s.key };
}

type RuleRow = typeof priorityRules.$inferSelect;
const ruleOf = (r: RuleRow): PriorityRule => ({
  id: r.id,
  text: r.text,
  term: r.term as PriorityRule['term'],
  nudge: { target: r.target as PriorityRule['nudge']['target'], direction: (r.direction === 1 ? 1 : -1) as 1 | -1 },
  status: r.status as PriorityRule['status'],
  pairs: r.pairs,
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
});

/** Apply (the nudge joins the config; recorded in the kv so Undo reverts it) or dismiss a suggested rule. */
export async function decideRule(w: WriteCtx, id: string, decision: 'apply' | 'dismiss'): Promise<PriorityRule | null> {
  const [row] = await w.tx.select().from(priorityRules).where(and(eq(priorityRules.id, id), eq(priorityRules.ownerUserId, w.userId))).limit(1);
  if (!row) return null;
  if (row.status !== 'suggested') return ruleOf(row);
  const status = decision === 'apply' ? 'applied' : 'dismissed';
  const [next] = await w.tx.update(priorityRules).set({ status, decidedAt: w.now }).where(eq(priorityRules.id, id)).returning();
  if (decision === 'apply') await writeKv(w, NUDGES_KEY, [...nudgesOf(w.kv), { target: row.target, direction: row.direction === 1 ? 1 : -1 }]);
  return ruleOf(next!);
}

/** Health's priority line: agreement@3 over 7 days of shadow runs, the biggest disagreements, the pending suggestion. */
export async function priorityHealth(db: DbOrTx, userId: string, m: Pick<ReadModel, 'settings' | 'get'>, now: Date): Promise<PriorityHealth> {
  const engine = engineSettingOf(m);
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const shadows = await db
    .select({ id: priorityRuns.id, agreement3: priorityRuns.agreement3, ranking: priorityRuns.ranking, shadow: priorityRuns.shadowRanking })
    .from(priorityRuns)
    .where(and(eq(priorityRuns.ownerUserId, userId), isNotNull(priorityRuns.shadowRanking), gte(priorityRuns.startedAt, since)))
    .orderBy(desc(priorityRuns.id));
  const vals = shadows.map((s) => s.agreement3).filter((x): x is number => typeof x === 'number');
  const agreement3 = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
  const latest = shadows[0];
  const dis: PriorityHealth['disagreements'] =
    latest?.ranking && latest.shadow ? disagreements(latest.ranking.order, latest.shadow.order, (id) => m.get('workItems', id)?.title ?? 'A to-do').map(({ workItemId, title, v1Rank, v2Rank }) => ({ workItemId, title, v1Rank, v2Rank })) : [];
  const rules = await db.select().from(priorityRules).where(eq(priorityRules.ownerUserId, userId)).orderBy(desc(priorityRules.createdAt));
  const suggestion = rules.find((r) => r.status === 'suggested');
  const applied = rules.filter((r) => r.status === 'applied').length;
  const where = engine === 'v2' ? 'on' : engine === 'shadow' ? 'in shadow' : 'off';
  const line =
    engine === 'v1'
      ? 'Ranking: priority@1.1 (priority@2 is off)'
      : `Ranking: priority@2 ${where}${agreement3 === null ? ' · no runs yet' : ` · agrees ${agreement3.toFixed(2)} on the Top 3 over 7 days (${shadows.length} run${shadows.length === 1 ? '' : 's'})`}${applied ? ` · ${applied} learned rule${applied === 1 ? '' : 's'}` : ''}`;
  return { engine, runs: shadows.length, agreement3, disagreements: dis, line, suggestion: suggestion ? ruleOf(suggestion) : null, appliedRules: applied };
}

/** Every user id (the ops "re-rank all users" endpoint queues one job each). */
export async function allUserIds(db: DbOrTx): Promise<string[]> {
  const r = await db.execute<{ id: string }>(sql`select id from users order by id`);
  return r.rows.map((x) => x.id);
}
