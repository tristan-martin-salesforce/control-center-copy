/**
 * `resolution.check` (queue `settle`, concurrency 1): the resolution check (src/engines/resolution, holistic review
 * H-7). Three payloads:
 *
 *   { itemId, trigger }   queued per item by the triggers (src/scanner/resolution/triggers-db.ts), deduped per item per
 *                         10 minutes; the job also takes up to 7 other queued item checks of the user, so items sharing a
 *                         conversation share one model call
 *   { trigger: 'sweep' }  the nightly sweep (src/worker/schedules.ts): items with no check in 7 days, and quiet ones
 *   { trigger: 'recall' } the Slack recall sweep (R5, SCN-1): re-read my channel threads (read-only) and record the
 *                         replies through REC-1; the scan-run hook then triggers checks on them
 *
 * `settings.closing.resolutionEngine`: `legacy` → nothing runs; `shadow` (the 1.x default) → checks run and record to
 * closure_checks, nothing else is written (the completion pass and Settle act); `live` → the outcomes are applied
 * (evidence through the scanner's writer, Settle-policy actions through settleApply) and the legacy closers stand down.
 *
 * Cost: the daily hard cap is checked before each batch; every model call is booked in llm_calls (skill resolve-item,
 * items in / decided by rules, escalations linked to the cheap call with escalation_changed_items: the data gate).
 * Nothing leaves the machine but the model calls and the allowlisted Slack read; jobs.result holds counts and ids only.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { DbHandle } from '@/db/client';
import { insertLlmCall, ledgerHash } from '@/db/ledger';
import { runResolutionChecks, type CheckResult } from '@/engines/resolution/check';
import { RESOLUTION_SKILL, type ResolutionTrigger } from '@/engines/resolution/types';
import { loadClosingSettings } from '@/engines/settle/select-db';
import { pgReevaluateEnqueuer } from '@/jobs/scan';
import type { JobContext, JobHandler, JobHandlerDef } from '@/jobs/types';
import { createRunState } from '@/llm/cc-tools';
import { SlackAutoRecorder } from '@/llm/slack-rec';
import { agentSdkCompletionModel } from '@/scanner/completion/llm';
import type { CompletionModel } from '@/scanner/completion/types';
import { RECALL_POLL_MS, followThreads, threadsToFollow } from '@/scanner/resolution/recall';
import { loadResolutionSkill } from '@/scanner/resolution/skill';
import { RESOLUTION_JOB_KIND, RESOLUTION_QUEUE, myThreadRows, selectSweepItems } from '@/scanner/resolution/triggers-db';
import { DbScannerStore, localDay } from '@/scanner/store-db';
import type { ConnectorId } from '@/scanner/types';
import { DbDataSource } from '@/server/datasource/db';
import { dbResolutionStore } from '@/server/datasource/db/resolution';

export { RESOLUTION_JOB_KIND, RESOLUTION_QUEUE };
export const RESOLUTION_BATCH = 8;
const SWEEP_CHUNK = 40;

export interface ResolutionHandlerDeps {
  /** For live Settle-policy actions (settleApply). Without it, live mode applies evidence only. */
  handle?: DbHandle;
  model?: CompletionModel;
  /** The recall sweep's read (one allowlisted `slack_read_thread`); default: the connector's one-call read path. */
  readThread?: (args: Record<string, unknown>) => Promise<{ text: string | null; costUsd?: number; code?: string; model?: string; inputTokens?: number; outputTokens?: number }>;
}

/** Up to `n` other queued item checks of this user, taken into this run (marked succeeded, batched here). */
async function claimSiblings(ctx: JobContext, n: number): Promise<Array<{ id: string; trigger: ResolutionTrigger }>> {
  const r = await ctx.db.execute<{ item: string | null; trigger: string | null }>(sql`
    update jobs set status = 'succeeded', finished_at = now(), updated_at = now(), result = jsonb_build_object('batchedInto', ${ctx.job.id ?? null}::bigint)
     where id in (select id from jobs where owner_user_id = ${ctx.userId} and kind = ${RESOLUTION_JOB_KIND} and status = 'queued' and payload ? 'itemId'
                     and id <> ${ctx.job.id ?? -1} and run_at <= now() + interval '5 minutes' order by run_at limit ${n} for update skip locked)
     returning payload->>'itemId' as item, payload->>'trigger' as trigger`);
  return r.rows.filter((x) => !!x.item).map((x) => ({ id: x.item!, trigger: (x.trigger ?? 'evidence') as ResolutionTrigger }));
}

async function liveApply(ctx: JobContext, deps: ResolutionHandlerDeps, results: CheckResult[]): Promise<{ evidence: number; actions: number }> {
  const store = new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
  const now = ctx.clock().toISOString();
  const runs = new Map<string, { runId: string; touched: Set<string> }>();
  let evidence = 0;
  for (const r of results) {
    const ev = r.plan.evidence;
    if (!ev) continue;
    const src = await ctx.db.execute<{ s: string }>(sql`select source::text as s from source_items where id = ${ev.sourceItemId}::uuid`);
    const s0 = src.rows[0]?.s ?? 'slack';
    const connector = (s0 === 'claude' ? 'claude_sessions' : s0) as ConnectorId;
    let run = runs.get(connector);
    if (!run) {
      const { runId } = await store.startRun({ scope: { connector, scope: 'resolution:check' }, trigger: 'reconcile', window: { from: now, to: now } });
      run = { runId, touched: new Set() };
      runs.set(connector, run);
    }
    try {
      const l = await store.linkEvidence(run.runId, { workItemId: r.itemId, sourceItemId: ev.sourceItemId, role: ev.role, confidence: ev.confidence, reason: ev.reason });
      run.touched.add(l.touchedWorkItemId);
      evidence += 1;
    } catch {
      /* the item or source vanished meanwhile (an Undo, a merge): skip that one */
    }
  }
  const reeval = pgReevaluateEnqueuer(ctx.db, ctx.userId);
  for (const [connector, run] of runs) {
    await store.reportCoverage(run.runId, [{ kind: 'query_window', ref: 'resolution', from: now, to: now }]);
    const fin = await store.finishRun(run.runId, { cursor: { value: 'resolution', at: now }, stats: { fetched: 0, new: 0, changed: 0, linked: run.touched.size, proposed: 0, unlinked: 0, costUsd: 0 } });
    const ids = [...new Set([...fin.touchedWorkItemIds, ...run.touched])];
    if (ids.length) await reeval(ids, { runId: run.runId, connector: connector as ConnectorId, trigger: 'reconcile' });
  }
  const entries = results
    .filter((r) => r.plan.settle)
    .map((r) => ({
      itemId: r.itemId,
      expectedState: r.record.statusBefore,
      action: r.plan.settle!.action,
      reasonClass: r.plan.settle!.reasonClass as Parameters<DbDataSource['settleApply']>[0][number]['reasonClass'],
      ...(r.plan.settle!.resolution ? { resolution: r.plan.settle!.resolution as Parameters<DbDataSource['settleApply']>[0][number]['resolution'] } : {}),
      reason: r.plan.why.slice(0, 200),
      verdict: r.plan.settle!.verdict,
      confidence: r.plan.settle!.confidence,
      check: r.record.engineVersion,
      ...(r.decision.cite?.sourceItemId ? { cite: { sourceItemId: r.decision.cite.sourceItemId, ...(r.decision.cite.url ? { url: r.decision.cite.url } : {}), byName: r.decision.cite.by, fromMe: r.decision.cite.fromMe, ...(r.decision.cite.at ? { at: r.decision.cite.at } : {}) } } : {}),
    }));
  if (entries.length && deps.handle) await new DbDataSource({ handle: deps.handle, userId: ctx.userId }).settleApply(entries);
  return { evidence, actions: deps.handle ? entries.length : 0 };
}

async function recall(ctx: JobContext, deps: ResolutionHandlerDeps): Promise<Record<string, unknown>> {
  const now = ctx.clock();
  const threads = threadsToFollow(await myThreadRows(ctx.db, ctx.userId, now), now);
  if (!threads.length) return { status: 'nothing_to_do', trigger: 'recall', threads: 0 };
  const store = new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
  if ((await store.budgetStatus()).state === 'capped') return { status: 'deferred_budget', trigger: 'recall', threads: threads.length };
  const window = { from: new Date(now.getTime() - RECALL_POLL_MS).toISOString(), to: now.toISOString() };
  const scope = { connector: 'slack' as const, scope: 'threads' };
  const { runId } = await store.startRun({ scope, trigger: 'reconcile', window });
  const context = await store.getContext(scope);
  const state = createRunState({ runId, connector: 'slack', window, context });
  const rec = new SlackAutoRecorder(store, state, context);
  // TODO(p1-connector-runtime): read through the ConnectorRuntime seam once it lands; today the one-call read path.
  const read =
    deps.readThread ??
    (async (args: Record<string, unknown>) => {
      const { runOneReadLookup } = await import('@/server/onboarding/identity');
      return runOneReadLookup({ connector: 'slack', tool: 'slack_read_thread', args });
    });
  const spent = { usd: 0, input: 0, output: 0, model: 'claude-haiku-5-5' };
  const out = await followThreads(
    threads,
    {
      read: async (args) => {
        const r = await read(args);
        spent.usd += r.costUsd ?? 0;
        spent.input += r.inputTokens ?? 0;
        spent.output += r.outputTokens ?? 0;
        if (r.model) spent.model = r.model;
        return r;
      },
      record: (tool, args, text, id) => rec.onToolResult(tool, args, { results: text }, id),
    },
    ctx.signal,
  );
  if (spent.usd > 0) await store.recordSpend({ connector: 'slack', model: spent.model, costUsd: spent.usd, runId, skill: 'recall-thread', inputTokens: spent.input, outputTokens: spent.output, trigger: 'recall', modelReason: 'relay', outcome: out.failed ? `partial:${out.failed}` : 'ok', contentHash: ledgerHash(spent.model, 'recall-thread', String(threads.length), threads.map((t) => `${t.channelId}:${t.threadTs}`).join(',')) });
  await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'threads', from: window.from, to: window.to }]);
  // finishRun's hook queues the checks the new replies trigger
  await store.finishRun(runId, { cursor: { value: 'threads', at: window.to }, stats: { fetched: out.recorded, new: out.recorded, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: spent.usd } });
  return { status: out.failed && !out.read ? 'failed' : 'ok', trigger: 'recall', threads: threads.length, read: out.read, recorded: out.recorded, failed: out.failed, errors: [...new Set(out.errors)], costUsd: Number(spent.usd.toFixed(6)) };
}

export function resolutionCheckHandler(deps: ResolutionHandlerDeps = {}): JobHandler {
  let model = deps.model;
  return async (ctx) => {
    const settings = await loadClosingSettings(ctx.db, ctx.userId);
    const mode = settings.resolutionEngine;
    const trigger = (typeof ctx.job.payload?.trigger === 'string' ? ctx.job.payload.trigger : 'manual') as ResolutionTrigger | 'recall';
    if (mode === 'legacy') return { status: 'disabled', mode, trigger };
    if (trigger === 'recall') return recall(ctx, deps);
    model ??= agentSdkCompletionModel({ timeoutMs: 120_000 });
    const now = ctx.clock();
    const own = typeof ctx.job.payload?.itemId === 'string' ? [{ id: ctx.job.payload.itemId as string, trigger: trigger as ResolutionTrigger }] : [];
    const items = own.length ? [...own, ...(await claimSiblings(ctx, RESOLUTION_BATCH - 1))] : await selectSweepItems(ctx.db, ctx.userId, now);
    const unique = [...new Map(items.map((i) => [i.id, i])).values()];
    if (!unique.length) return { status: 'nothing_to_do', mode, trigger };
    const scanner = new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
    const u = (await ctx.db.execute<{ name: string | null; tz: string | null }>(sql`select display_name as name, timezone as tz from users where id = ${ctx.userId}`)).rows[0];
    const timezone = u?.tz ?? 'UTC';
    const skill = loadResolutionSkill();
    const skillVersion = skill.versionTag;
    const store = dbResolutionStore(ctx.db, ctx.userId, settings);
    const cheapIds = new Map<string, number>();
    const totals = { checks: 0, calls: 0, costUsd: 0, outcomes: {} as Record<string, number>, missing: 0, applied: { evidence: 0, actions: 0 } };
    for (let i = 0; i < unique.length; i += SWEEP_CHUNK) {
      if (ctx.signal.aborted) break;
      if ((await scanner.budgetStatus()).state === 'capped') {
        await scanner.recordDecision?.({ skill: RESOLUTION_SKILL, kind: 'block', reason: 'hard_cap', trigger, count: unique.length - i, detail: { jobId: ctx.job.id ?? null } });
        return { status: 'deferred_budget', mode, trigger, ...totals, pending: unique.length - i };
      }
      const out = await runResolutionChecks({
        items: unique.slice(i, i + SWEEP_CHUNK),
        mode: mode === 'live' ? 'live' : 'shadow',
        store,
        model,
        skill,
        settings,
        now,
        me: u?.name ?? 'me',
        timezone,
        signal: ctx.signal,
        onCall: async (c) => {
          const started = ctx.clock();
          const id = await insertLlmCall(ctx.db, {
            ownerUserId: ctx.userId,
            purpose: 'done_match',
            model: c.model,
            skillKey: RESOLUTION_SKILL,
            promptVersion: skillVersion,
            requestHash: `resolution:${ctx.job.id ?? 'none'}:${randomUUID()}`,
            jobId: ctx.job.id ?? null,
            status: c.ok ? 'ok' : 'error',
            errorCode: c.ok ? null : (c.errorClass ?? 'unknown'),
            inputTokens: c.inputTokens,
            outputTokens: c.outputTokens,
            cacheReadTokens: c.cacheReadTokens,
            cacheWriteTokens: c.cacheWriteTokens,
            costUsd: Math.max(0, c.costUsd),
            budgetDay: localDay(started, timezone),
            budget: 'daily',
            startedAt: started,
            finishedAt: started,
            trigger,
            modelReason: c.tier === 'strong' ? `escalation:${c.escalationReason ?? 'uncertain'}` : 'default',
            contentHash: ledgerHash(c.model, skillVersion, c.system, c.user),
            outcome: c.ok ? 'ok' : (c.errorClass ?? 'error'),
            measure: {
              itemsIn: c.itemIds.length,
              ...(c.tier === 'strong' ? { escalatedFromCallId: cheapIds.get(c.itemIds[0]!) ?? null, escalationChangedItems: c.changed ? 1 : 0 } : {}),
            },
          });
          if (c.tier === 'cheap' && id != null) for (const it of c.itemIds) cheapIds.set(it, id);
          return id;
        },
        ...(mode === 'live' ? { apply: async (rs: CheckResult[]) => void Object.assign(totals.applied, await liveApply(ctx, deps, rs)) } : {}),
      });
      totals.checks += out.results.length;
      totals.calls += out.calls;
      totals.costUsd += out.costUsd;
      totals.missing += out.missing.length;
      for (const [k, v] of Object.entries(out.outcomes)) totals.outcomes[k] = (totals.outcomes[k] ?? 0) + v;
    }
    ctx.log('resolution: checks done', { mode, trigger, checks: totals.checks, calls: totals.calls, costUsd: Number(totals.costUsd.toFixed(5)) });
    return { status: 'ok', mode, trigger, ...totals, costUsd: Number(totals.costUsd.toFixed(6)) };
  };
}

export function resolutionCheckJobDef(deps: ResolutionHandlerDeps = {}): JobHandlerDef {
  return {
    kind: RESOLUTION_JOB_KIND,
    queue: RESOLUTION_QUEUE,
    wired: true,
    spends: true,
    description: 'Resolution check: rules, then the cheap model, then a narrow escalation decide whether items are done; shadow records, live acts (H-7)',
    handler: resolutionCheckHandler(deps),
  };
}
