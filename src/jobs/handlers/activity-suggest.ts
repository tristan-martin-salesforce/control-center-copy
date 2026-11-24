/**
 * `activity.suggest` (queue `engine`): the cheap model's suggestion for Time rows that need an opportunity and that the
 * rules can't place (src/lib/time-suggest.ts): internal work, or which candidate opportunity, with a short reason and a
 * confidence. One tool-less Haiku call per row (src/engines/activity/suggest-prompt.ts), the answer kept in kv
 * `cc.time.suggestions` per row with the hash of the inputs it saw; GET /time reads it and shows it with Accept.
 * Nothing is applied for you (the owner verifies each one, 2026-11-14).
 *
 * Picked: the rows the read side would ask about (DbDataSource.activitySuggestPending: live, no opp, not internal, not
 * on a canvas, no rules answer at or above RULES_SETTLE, no stored answer for the row as it is now), newest first. In
 * pages of 15 calls, each capped at $0.01, the page at $0.15; a page that stops with rows still due queues the next
 * page (src/jobs/pass-pages.ts, caps audit 2026-11-21), so every row is asked. Cost (COST-1): the daily hard cap is checked before
 * every call; at the cap nothing is called (`deferred_budget`, one llm_decisions row) and the rows keep the rules'
 * suggestion. Each call is one llm_calls row (purpose `classify`, skill `activity-suggest`, the daily budget) with its
 * trigger, model reason, content hash, outcome and tokens. An unusable answer is stored as a low-confidence none, so
 * the same inputs never cost twice; a failed call is not stored (the next pass tries again).
 *
 * Live only in the launchd worker (CC_LIVE / production) unless a test injects the model. jobs.result holds counts
 * and codes only, never row text.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db, DbHandle } from '@/db/client';
import { insertLlmCall, ledgerHash, recordDecision } from '@/db/ledger';
import { enqueueJob } from '@/db/queue';
import { parseSuggestAnswer, suggestCandidates, suggestRequest } from '@/engines/activity/suggest-prompt';
import { localDay } from '@/engines/activity/time';
import { SUGGESTIONS_KV, SUGGEST_PROMPT_VERSION, suggestKey, type StoredSuggestion } from '@/lib/time-suggest';
import { SCANNER_MODEL } from '@/llm/models';
import { agentSdkCompletionModel } from '@/scanner/completion/llm';
import type { CompletionModel } from '@/scanner/completion/types';
import { DbScannerStore } from '@/scanner/store-db';
import { DbDataSource } from '@/server/datasource/db';
import { putKv } from '@/server/datasource/db/ext';

import { nextPageDue, queueNextPage } from '../pass-pages';
import { QUEUES } from '../registry';
import type { JobContext, JobHandlerDef } from '../types';

export const ACTIVITY_SUGGEST_JOB = 'activity.suggest';
export const ACTIVITY_SUGGEST_SKILL = 'activity-suggest';
const ENGINE = 'activity-suggest@1';
export const activitySuggestDedupeKey = (userId: string) => `activity.suggest:${userId}`;

/** A page (not a cap): the next page is queued while rows are due. */
const MAX_CALLS = 15;
const PER_CALL_USD = 0.01;
/** The page's $ line (a page boundary too); the daily hard cap is the budget. */
const PER_PASS_USD = 0.15;

export interface ActivitySuggestDeps {
  /** The worker's database handle (the pending rows come from the read side's own computation). */
  handle?: DbHandle;
  /** The model seam (tests pass a fake; it also turns the job on outside the launchd worker). */
  model?: CompletionModel;
  maxCalls?: number;
}

let deps: ActivitySuggestDeps = {};
export function configureActivitySuggest(d: ActivitySuggestDeps): void {
  deps = { ...deps, ...d };
}
export function resetActivitySuggestConfig(): void {
  deps = {};
}

const live = () => process.env.CC_LIVE === '1' || (process.env.CC_LIVE === undefined && process.env.NODE_ENV === 'production');

/** Queue one pass (after the rows changed; one queued at a time). */
export async function enqueueActivitySuggest(db: Db, userId: string, trigger: string): Promise<boolean> {
  const r = await enqueueJob(db, { ownerUserId: userId, kind: ACTIVITY_SUGGEST_JOB, queue: QUEUES.engine, payload: { trigger }, dedupeKey: activitySuggestDedupeKey(userId), maxAttempts: 2, timeoutSeconds: 900 });
  return r.inserted;
}

async function recordCall(ctx: JobContext, day: string, c: { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; ok: boolean; errorCode?: string; latencyMs: number; contentHash: string; outcome: string }) {
  const finished = new Date();
  await insertLlmCall(ctx.db, {
    ownerUserId: ctx.userId,
    purpose: 'classify',
    model: SCANNER_MODEL,
    skillKey: ACTIVITY_SUGGEST_SKILL,
    promptVersion: SUGGEST_PROMPT_VERSION,
    requestHash: `${ACTIVITY_SUGGEST_SKILL}:${ctx.job.id}:${randomUUID()}`,
    jobId: ctx.job.id,
    status: c.ok ? 'ok' : 'error',
    errorCode: c.errorCode ?? null,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens: c.cacheReadTokens ?? 0,
    cacheWriteTokens: c.cacheWriteTokens ?? 0,
    costUsd: c.costUsd,
    latencyMs: c.latencyMs,
    budgetDay: day,
    budget: 'daily',
    startedAt: new Date(finished.getTime() - c.latencyMs),
    finishedAt: finished,
    trigger: typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'schedule',
    modelReason: 'default',
    contentHash: c.contentHash,
    outcome: c.outcome,
  });
}

export async function runActivitySuggest(ctx: JobContext, d: ActivitySuggestDeps = deps): Promise<Record<string, unknown>> {
  if (!d.model && !live()) return { skipped: 'not_live', note: 'Opportunity suggestions by the model run in the launchd worker only (CC_LIVE)' };
  const handle = d.handle ?? deps.handle;
  if (!handle) return { skipped: 'no_handle' };
  const now = ctx.clock();
  const ds = new DbDataSource({ handle, userId: ctx.userId, clock: { now: () => now } });
  try {
    const pending = await ds.activitySuggestPending();
    const keep = new Set(pending.live);
    // answers for rows that no longer want one (given an opp, internal, logged, gone) are dropped
    const stored: Record<string, StoredSuggestion> = Object.fromEntries(Object.entries(pending.stored).filter(([id]) => keep.has(id)));
    const dropped = Object.keys(pending.stored).length - Object.keys(stored).length;
    const due = [...pending.rows].sort((a, b) => b.entry.start.localeCompare(a.entry.start) || a.entry.id.localeCompare(b.entry.id));
    const tz = (await ctx.db.execute<{ tz: string | null }>(sql`select timezone as tz from users where id = ${ctx.userId}`)).rows[0]?.tz ?? 'UTC';
    const day = localDay(now.getTime(), tz);
    const store = new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
    const model = d.model ?? agentSdkCompletionModel({ timeoutMs: 60_000 });
    const maxCalls = d.maxCalls ?? MAX_CALLS;
    let calls = 0;
    let spent = 0;
    let answered = 0;
    let unusable = 0;
    let failed = 0;
    let deferred: string | null = null;
    let atPage = false;
    for (const { entry, candidates: ranked } of due) {
      if (calls >= maxCalls || spent + PER_CALL_USD > PER_PASS_USD) {
        atPage = true;
        break;
      }
      // COST-1: the daily hard cap first; at the cap nothing is called and the rows keep the rules' suggestion
      if ((await store.budgetStatus()).state === 'capped') {
        deferred = 'daily_hard_cap';
        await recordDecision(ctx.db, ctx.userId, { skill: ACTIVITY_SUGGEST_SKILL, kind: 'block', reason: 'hard_cap', trigger: 'schedule', subject: 'activity.suggest', usd: PER_CALL_USD * (due.length - calls), day, once: true, detail: { rows: due.length - calls } });
        break;
      }
      if (ctx.signal.aborted) break;
      const candidates = suggestCandidates(ranked);
      const facts = { entry, candidates, internalActivity: pending.internalActivity };
      const req = suggestRequest(facts);
      const started = Date.now();
      const out = await model({ system: req.system, user: req.user, model: SCANNER_MODEL, effort: 'low', maxBudgetUsd: PER_CALL_USD, signal: ctx.signal });
      calls += 1;
      spent += Math.max(0, out.costUsd || 0);
      const answer = out.ok ? parseSuggestAnswer(out.text, facts) : null;
      await recordCall(ctx, day, {
        costUsd: out.costUsd,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        cacheReadTokens: out.cacheReadTokens ?? 0,
        cacheWriteTokens: out.cacheWriteTokens ?? 0,
        contentHash: ledgerHash(SCANNER_MODEL, SUGGEST_PROMPT_VERSION, req.system, req.user),
        ok: out.ok,
        ...(out.ok ? {} : { errorCode: out.error?.errorClass ?? 'unknown' }),
        latencyMs: Date.now() - started,
        outcome: !out.ok ? (out.error?.errorClass ?? 'error') : answer ? `${answer.kind}:${Math.round(answer.confidence * 100)}` : 'unusable',
      }).catch(() => undefined);
      void ctx.heartbeat().catch(() => undefined);
      if (!out.ok) {
        failed += 1;
        continue;
      }
      // an unusable answer is kept as a none (no opp, confidence 0) the read side never shows: the same inputs never cost twice
      if (answer) answered += 1;
      else unusable += 1;
      stored[entry.id] = answer
        ? { key: suggestKey(entry), kind: answer.kind, oppId: answer.oppId, taskType: null, confidence: answer.confidence, reason: answer.reason, model: SCANNER_MODEL, at: now.toISOString() }
        : { key: suggestKey(entry), kind: 'opp', oppId: null, taskType: null, confidence: 0, reason: '', model: SCANNER_MODEL, at: now.toISOString() };
    }
    if (answered || unusable || dropped) {
      await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.engine(ENGINE), reason: `Time: suggestions for ${answered} ${answered === 1 ? 'row' : 'rows'} that need an opportunity`, entity: { type: 'settings', id: SUGGESTIONS_KV }, undoable: false }, async (tx) => {
        await putKv(tx, ctx.userId, SUGGESTIONS_KV, Object.keys(stored).length ? { rows: stored } : null);
      });
    }
    const more = nextPageDue({ stoppedAtPage: atPage, left: due.length - calls, progressed: answered + unusable, aborted: ctx.signal.aborted });
    const nextPage = more ? await queueNextPage(ctx, { kind: ACTIVITY_SUGGEST_JOB, queue: QUEUES.engine, dedupeKey: activitySuggestDedupeKey(ctx.userId), maxAttempts: 2, timeoutSeconds: 900 }) : false;
    return { status: deferred ? 'deferred_budget' : 'done', due: due.length, calls, answered, unusable, failed, dropped, costUsd: Math.round(spent * 10_000) / 10_000, ...(deferred ? { deferred } : {}), ...(more ? { more, nextPage } : {}) };
  } finally {
    await ds.dispose().catch(() => undefined);
  }
}

export function activitySuggestJobDef(d: ActivitySuggestDeps = {}): JobHandlerDef {
  if (d.handle || d.model) configureActivitySuggest(d);
  return { kind: ACTIVITY_SUGGEST_JOB, queue: QUEUES.engine, wired: true, spends: true, description: 'Time: the cheap model’s suggestion (internal, or which opportunity) for rows the rules can’t place (under the daily hard cap)', handler: (ctx) => runActivitySuggest(ctx) };
}

/**
 * The worker's hook: a pass after the activity rows change (and one after each start). The job's dedupe key keeps one
 * queued; with nothing due it is a read.
 */
export function activitySuggestHook(db: Db, userId: string, log: (msg: string, f?: Record<string, unknown>) => void, o: { everyMs?: number } = {}) {
  let seen: string | null | undefined;
  return {
    name: 'activity.suggest',
    everyMs: o.everyMs ?? 5 * 60_000,
    run: async () => {
      try {
        const r = await db.execute<{ last: Date | string | null; n: string | number }>(sql`
          select max(updated_at) as last, count(*) filter (where status in ('needs_input', 'proposed', 'approved') and opportunity_id is null) as n
            from activity_entries where owner_user_id = ${userId}`);
        const last = r.rows[0]?.last ? new Date(r.rows[0].last).toISOString() : null;
        if (last === seen) return;
        seen = last;
        if (!last || !Number(r.rows[0]?.n ?? 0)) return;
        if (await enqueueActivitySuggest(db, userId, 'rows')) log('activity.suggest: queued after the rows changed');
      } catch (err) {
        log('activity.suggest: could not queue a pass', { code: (err as Error).name });
      }
    },
  };
}
