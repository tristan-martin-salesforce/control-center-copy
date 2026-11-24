/**
 * `completion.check` (queue `completion`, concurrency 1): the completion pass (CMP-1, docs/reference/SCANNER.md §4.9).
 *
 * Enqueued after a scan run that stored new source items (src/worker/scanning.ts afterRun), at worker start and
 * on wake (catch-up after downtime), and as its own follow-up when a pass hit its per-pass caps. One queued job
 * per user (`completion.check:<user>`): a scan finishing while one is queued adds nothing, because the job reads
 * its window at run time, from the last pass's watermark to now. The watermark lives in the latest succeeded
 * job's `result.watermark` (like reevaluate's `result.reeval`), so a restart resumes exactly where it stopped.
 *
 * Spend (caps audit 26 F-4): the pass runs under the job's governor hold (the worker's start gate took it). Past the
 * hold with items still to judge it raises a hand (Health ▸ Spend) and the rest waits as one queued check carrying the
 * hold: Allow runs it at once, Stop cancels it. One call's SDK budget is then the runaway guard, not $0.05.
 *
 * The pass emits `completion` / `progress` evidence only; `reevaluate` and the closure machine decide. jobs.result
 * holds counts, ids and codes, never message text or model reasons.
 */
import { sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { pgReevaluateEnqueuer } from '@/jobs/scan';
import { spendPauseResult, spendStartResult } from '@/jobs/spend-pause';
import type { JobHandler, JobHandlerDef } from '@/jobs/types';
import { finishJobSpend, gateOf, startJobSpend, type SpendGovernor } from '@/llm/spend';
import { dbSpendGovernor } from '@/server/datasource/db/spend';
import { agentSdkCompletionModel, runCompletionPass, type CompletionLimits, type CompletionModel, type CompletionStore, type CompletionWatermark } from '@/scanner/completion';
import { DbScannerStore } from '@/scanner/store-db';
import { enqueueResolutionCheck, resolutionEngineMode } from '@/scanner/resolution/triggers-db';

export const COMPLETION_JOB_KIND = 'completion.check';
export const COMPLETION_QUEUE = 'completion';
export const completionDedupeKey = (userId: string) => `completion.check:${userId}`;

export type CompletionTrigger = 'scan' | 'catch_up' | 'follow_up' | 'manual';

/**
 * Queue one check unless one is already queued for the user (its window is read when it runs, so it already
 * covers what this scan stored). Returns whether a job was inserted.
 */
export async function enqueueCompletionCheck(
  db: DbOrTx,
  userId: string,
  o: { trigger: CompletionTrigger; connector?: string; runId?: string; delaySeconds?: number } = { trigger: 'scan' },
): Promise<boolean> {
  const key = completionDedupeKey(userId);
  const queued = await db.execute<{ id: string }>(sql`select id from jobs where dedupe_key = ${key} and status = 'queued' limit 1`);
  if (queued.rows[0]) return false;
  const r = await enqueueJob(db, {
    ownerUserId: userId,
    kind: COMPLETION_JOB_KIND,
    queue: COMPLETION_QUEUE,
    dedupeKey: key,
    payload: { trigger: o.trigger, ...(o.connector ? { connector: o.connector } : {}), ...(o.runId ? { run_id: o.runId } : {}) },
    delaySeconds: o.delaySeconds ?? 20,
    maxAttempts: 3,
    timeoutSeconds: 900,
  });
  return r.inserted;
}

/** The watermark of the user's latest succeeded pass (null before the first one). */
export async function lastCompletionWatermark(db: Db, userId: string): Promise<CompletionWatermark | null> {
  const r = await db.execute<{ wm: CompletionWatermark | null }>(sql`
    select result -> 'watermark' as wm from jobs
     where owner_user_id = ${userId} and kind = ${COMPLETION_JOB_KIND} and status = 'succeeded' and result ? 'watermark'
     order by (result -> 'watermark' ->> 'through')::timestamptz desc nulls last, id desc
     limit 1`);
  const wm = r.rows[0]?.wm;
  return wm && typeof wm.through === 'string' ? { through: wm.through, pending: wm.pending && typeof wm.pending === 'object' ? wm.pending : {}, ...(wm.skill ? { skill: wm.skill } : {}) } : null;
}

export interface CompletionHandlerDeps {
  /** The model seam (default: one tool-less Agent SDK turn on the skill's model). */
  model?: CompletionModel;
  /** Store override (tests); default: a DbScannerStore over the job's db and clock. */
  store?: (ctx: Parameters<JobHandler>[0]) => CompletionStore;
  limits?: Partial<CompletionLimits>;
  repoRoot?: string;
  /** The spend governor (default: the database one; null: no hold, the pass's own per-call line applies). */
  spend?: SpendGovernor | null;
}

export function completionHandler(deps: CompletionHandlerDeps = {}): JobHandler {
  let model: CompletionModel | undefined = deps.model;
  return async (ctx) => {
    model ??= agentSdkCompletionModel();
    const store = deps.store?.(ctx) ?? new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
    const watermark = await lastCompletionWatermark(ctx.db, ctx.userId);
    // H-7: with the resolution check live, this pass hands its items to it (src/scanner/resolution/triggers-db.ts)
    const resolutionEngine = await resolutionEngineMode(ctx.db, ctx.userId);
    const me = await ctx.db.execute<{ name: string | null }>(sql`select display_name as name from users where id = ${ctx.userId}`);
    const gov = deps.spend === undefined ? dbSpendGovernor({ db: ctx.db, userId: ctx.userId, clock: ctx.clock }) : deps.spend;
    const envelope = await startJobSpend(gov, ctx.job, { scope: 'job', skill: 'completion-check' });
    const early = await spendStartResult(ctx, envelope, { dedupeKey: completionDedupeKey(ctx.userId) });
    if (early) return early;
    const out = await runCompletionPass({
      store,
      model,
      now: ctx.clock(),
      watermark,
      meName: me.rows[0]?.name ?? undefined,
      repoRoot: deps.repoRoot,
      signal: ctx.signal,
      limits: deps.limits,
      reevaluate: pgReevaluateEnqueuer(ctx.db, ctx.userId),
      log: (m, d) => ctx.log(m, d),
      trigger: typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'reconcile',
      resolutionEngine,
      delegate: async (ids) => {
        for (const id of ids) await enqueueResolutionCheck(ctx.db, ctx.userId, id, 'evidence', ctx.clock());
      },
      spend: gateOf(envelope),
    }).finally(() => finishJobSpend(gov, envelope));
    // asked: the rest waits as the one queued check, carrying the hold; otherwise the usual follow-up page
    const paused = await spendPauseResult(ctx, envelope, { dedupeKey: completionDedupeKey(ctx.userId), payload: { trigger: 'follow_up' } });
    let followUp = false;
    if (!paused.paused && out.more && !ctx.signal.aborted) followUp = await enqueueCompletionCheck(ctx.db, ctx.userId, { trigger: 'follow_up', delaySeconds: 5 });
    return {
      status: out.status,
      watermark: out.watermark,
      skill: out.skill,
      items: out.items,
      withCandidates: out.withCandidates,
      checked: out.checked,
      calls: out.calls,
      costUsd: Number(out.costUsd.toFixed(6)),
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      verdicts: out.verdicts,
      // ids, roles and confidences only (no reasons: they paraphrase message content)
      signals: out.signals.map((s) => ({ workItemId: s.workItemId, sourceItemId: s.sourceItemId, role: s.role, confidence: s.confidence, gate: s.gate, p: s.modelConfidence, basis: s.basis ?? null, relations: s.relations, evidenceId: s.evidenceId ?? null })),
      runIds: out.runIds,
      errors: out.errors,
      followUp,
      ...paused,
    };
  };
}

export function completionJobDef(deps: CompletionHandlerDeps = {}): JobHandlerDef {
  return {
    kind: COMPLETION_JOB_KIND,
    queue: COMPLETION_QUEUE,
    wired: true,
    spends: true,
    description: 'completion pass: a cheap model checks new messages against open items and emits completion signals (CMP-1)',
    handler: completionHandler(deps),
  };
}
