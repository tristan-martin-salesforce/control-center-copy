/**
 * `settle.check` (queue `settle`, concurrency 1): the Settle pass (SETTLE-1, docs/reference/SCANNER.md §4.11).
 *
 * After the first scan finishes, it judges every live or suggested item once with the whole conversation around it
 * (src/engines/settle), then the policy closes for you, asks, reopens or leaves each one (Closing settings). Later
 * passes judge only what changed since the last one (new evidence, new messages in an item's conversation, a due
 * date that passed). The watermark lives in the latest succeeded job's `result.through`, like `completion.check`.
 * jobs.result holds counts and ids only, never reasons (they paraphrase message content).
 *
 * Cost (COST-1): every model call goes through `guardedModel`, which
 *  - checks the daily hard cap first (the scanner store's budgetStatus, like the completion pass). At the cap nothing
 *    is called: the pass stops, the items it had not judged wait (the watermark stays) and the result is
 *    `deferred_budget`;
 *  - keeps the stronger model within `strongerModelUsdPerDay` for the day: today's stronger-model Settle spend comes
 *    from llm_calls, so the allowance holds across passes (before, each pass got the whole amount again). The first
 *    pass spends the first-scan budget, with its own allowance (at least $3);
 *  - books one llm_calls row per call, with the model that made it and its tokens (before, an escalated item was one
 *    row on the winning verdict's model, so a stronger-model call whose reply was invalid was booked as the cheap one).
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { DbHandle, DbOrTx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { loadSkill } from '@/engines/nba/prompt/skills';
import { loadSettleRaw, loadSettleUser } from '@/engines/settle/load-db';
import { closureSettingsFrom } from '@/engines/closure/signals';
import { decideSettle } from '@/engines/settle/policy';
import { CLOSURE_SETTING_KEYS } from '@/engines/types';
import { SETTLE_SKILL, SETTLE_STRONG_MODEL, settleMany } from '@/engines/settle/run';
import { loadClosingSettings, policyFacts, selectSettleItems } from '@/engines/settle/select-db';
import type { JobContext, JobHandler, JobHandlerDef } from '@/jobs/types';
import { agentSdkCompletionModel } from '@/scanner/completion/llm';
import type { CompletionModel, CompletionModelResult } from '@/scanner/completion/types';
import { DbScannerStore, localDay, modelTierOf } from '@/scanner/store-db';
import { insertLlmCall, ledgerHash, type RequiredAudit } from '@/db/ledger';
import { DbDataSource } from '@/server/datasource/db';
import { withdrawClosedItemDrafts } from '@/server/datasource/db/store/withdraw';

export const SETTLE_JOB_KIND = 'settle.check';
export const SETTLE_QUEUE = 'settle';
export const settleDedupeKey = (userId: string) => `settle.check:${userId}`;

export type SettleTrigger = 'first_scan' | 'interval' | 'manual';

export async function enqueueSettleCheck(db: DbOrTx, userId: string, o: { trigger: SettleTrigger; delaySeconds?: number } = { trigger: 'interval' }): Promise<boolean> {
  const key = settleDedupeKey(userId);
  const open = await db.execute<{ id: string }>(sql`select id from jobs where dedupe_key = ${key} and status in ('queued', 'running') limit 1`);
  if (open.rows[0]) return false;
  const r = await enqueueJob(db, { ownerUserId: userId, kind: SETTLE_JOB_KIND, queue: SETTLE_QUEUE, dedupeKey: key, payload: { trigger: o.trigger }, delaySeconds: o.delaySeconds ?? 10, maxAttempts: 2, timeoutSeconds: 3600 });
  return r.inserted;
}

/** When the latest succeeded pass started (null before the first one). */
export async function lastSettleThrough(db: DbOrTx, userId: string): Promise<string | null> {
  const r = await db.execute<{ t: string | null }>(sql`
    select result ->> 'through' as t from jobs
     where owner_user_id = ${userId} and kind = ${SETTLE_JOB_KIND} and status = 'succeeded' and result ? 'through'
     order by (result ->> 'through')::timestamptz desc nulls last, id desc limit 1`);
  return r.rows[0]?.t ?? null;
}

type SettleBudget = 'daily' | 'first_scan';

/**
 * Why a call was not made. An item whose first call the hard cap refused counts as not judged (it waits for the next
 * pass), never as a verdict; a refused stronger-model call keeps the cheap verdict.
 */
export const SETTLE_REFUSED = { hardCap: 'settle_refused:daily_hard_cap', stronger: 'settle_refused:stronger_model_day_cap' } as const;
const refused = (code: string): CompletionModelResult => ({ ok: false, text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, error: { message: code, errorClass: 'config' } });

/**
 * The stronger model's Settle spend on one budget day: what `strongerModelUsdPerDay` caps. The first pass spends the
 * first-scan budget, so it never eats the daily allowance (BUD-1).
 */
export async function settleStrongerSpend(db: DbOrTx, userId: string, day: string, budget: SettleBudget): Promise<number> {
  const r = await db.execute<{ usd: string | null }>(sql`
    select coalesce(sum(cost_usd), 0)::text as usd from llm_calls
     where owner_user_id = ${userId} and budget_day = ${day}::date and budget = ${budget}
       and purpose = 'done_match' and skill_key = ${SETTLE_SKILL} and model_tier::text = ${modelTierOf(SETTLE_STRONG_MODEL)}`);
  return Number(r.rows[0]?.usd ?? 0);
}

/** One model call, booked as it happened: its model, tokens and cost, against its budget (and the daily roll-up). */
async function recordSettleCall(
  db: DbOrTx,
  userId: string,
  c: { model: string; out: CompletionModelResult; jobId: number | null; budget: SettleBudget; day: string; skillVersion: string | null; startedAt: Date; finishedAt: Date } & Omit<RequiredAudit, 'outcome'>,
): Promise<number | null> {
  const cost = Math.max(0, Number.isFinite(c.out.costUsd) ? c.out.costUsd : 0);
  if (!(cost > 0) && c.out.ok) return null;
  return insertLlmCall(db, {
    ownerUserId: userId,
    purpose: 'done_match',
    model: c.model,
    skillKey: SETTLE_SKILL,
    promptVersion: c.skillVersion,
    requestHash: `settle:${c.jobId ?? 'none'}:${randomUUID()}`,
    jobId: c.jobId,
    status: c.out.ok ? 'ok' : 'error',
    errorCode: c.out.ok ? null : (c.out.error?.errorClass ?? 'unknown'),
    inputTokens: c.out.inputTokens,
    outputTokens: c.out.outputTokens,
    cacheReadTokens: c.out.cacheReadTokens ?? 0,
    cacheWriteTokens: c.out.cacheWriteTokens ?? 0,
    costUsd: cost,
    budgetDay: c.day,
    budget: c.budget,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    trigger: c.trigger,
    modelReason: c.modelReason,
    contentHash: c.contentHash,
    outcome: c.out.ok ? 'ok' : (c.out.error?.errorClass ?? 'error'),
  });
}

interface GuardState {
  /** This pass's spend, all models. */
  spent: number;
  /** D4: the latest stronger-model call per item (its llm_calls id), for the escalation decision. */
  strongerCallId: Map<string, number>;
  /** The stronger model: what is left of today's allowance at the start, spent by this pass, reserved by calls in flight. */
  stronger: { left: number; spent: number; reserved: number; refused: number };
  capped: boolean;
}

/**
 * The model seam, guarded: the daily hard cap before every call, the stronger model's per-day allowance (a call in
 * flight reserves its own per-call budget, so concurrent calls never overshoot it), and one llm_calls row per call.
 */
function guardedModel(
  ctx: JobContext,
  model: CompletionModel,
  st: GuardState,
  o: { store: DbScannerStore; budget: SettleBudget; timezone: string; skillVersion: string | null; trigger: string; onSpend: () => void; stop: () => void },
): CompletionModel {
  return async (req) => {
    if (st.capped || (await o.store.budgetStatus()).state === 'capped') {
      st.capped = true;
      o.stop();
      return refused(SETTLE_REFUSED.hardCap);
    }
    const stronger = req.model === SETTLE_STRONG_MODEL;
    const hold = Math.max(0, req.maxBudgetUsd || 0);
    if (stronger) {
      if (st.stronger.spent + st.stronger.reserved + hold > st.stronger.left + 1e-9) {
        st.stronger.refused += 1;
        return refused(SETTLE_REFUSED.stronger);
      }
      st.stronger.reserved += hold;
    }
    // D6: the call's cost cap is held against the daily hard cap while it runs (parallel calls can't overshoot it).
    const reservation = await o.store.reserveSpend(hold, { budget: o.budget }).catch(() => null);
    if (reservation && !reservation.ok) {
      if (stronger) st.stronger.reserved -= hold;
      st.capped = true;
      o.stop();
      await o.store.recordDecision({ skill: SETTLE_SKILL, kind: 'block', reason: 'hard_cap_reserve', trigger: o.trigger, detail: { jobId: ctx.job.id ?? null, spentUsd: reservation.spentUsd, heldUsd: reservation.reservedUsd, capUsd: reservation.hardCapUsd } });
      return refused(SETTLE_REFUSED.hardCap);
    }
    const startedAt = ctx.clock();
    let out: CompletionModelResult;
    try {
      out = await model(req);
    } finally {
      if (stronger) st.stronger.reserved -= hold;
    }
    const cost = Math.max(0, Number.isFinite(out.costUsd) ? out.costUsd : 0);
    st.spent += cost;
    if (stronger) st.stronger.spent += cost;
    const finishedAt = ctx.clock();
    try {
      const id = await recordSettleCall(ctx.db, ctx.userId, {
        model: req.model,
        out,
        jobId: ctx.job.id ?? null,
        budget: o.budget,
        day: localDay(startedAt, o.timezone),
        skillVersion: o.skillVersion,
        startedAt,
        finishedAt,
        trigger: o.trigger,
        modelReason: stronger ? 'escalation:unclear' : 'default',
        contentHash: ledgerHash(req.model, o.skillVersion, req.system, req.user),
      });
      const item = req.tag;
      if (stronger && id != null && item) st.strongerCallId.set(item, id);
    } finally {
      await reservation?.release();
    }
    o.onSpend();
    return out;
  };
}

/**
 * D4: one decision per escalated item: did the stronger model change the verdict (and the action the policy takes)?
 * The rate is on Health ▸ Spend ▸ Spend & decisions, so whether the escalation earns its price is decided with data.
 */
async function recordEscalations(
  store: DbScannerStore,
  results: Array<Parameters<typeof decideSettle>[0]>,
  facts: Awaited<ReturnType<typeof policyFacts>>,
  settings: Awaited<ReturnType<typeof loadClosingSettings>>,
  o: { trigger: string; jobId: number | null; callIds: Map<string, number> },
): Promise<{ escalated: number; changed: number }> {
  let escalated = 0;
  let changed = 0;
  for (const r of results) {
    if (!r.escalatedFrom) continue;
    escalated += 1;
    const verdictChanged = !!r.strongerValid && r.verdict !== r.escalatedFrom;
    if (verdictChanged) changed += 1;
    const f = facts.get(r.workItemId);
    const action = f ? decideSettle(r, f, settings).action : null;
    const cheapAction = f && r.strongerValid ? decideSettle({ ...r, verdict: r.escalatedFrom, confidence: r.escalatedFromConfidence ?? r.confidence }, f, settings).action : action;
    await store.recordDecision({
      skill: SETTLE_SKILL,
      kind: 'escalate',
      reason: !r.strongerValid ? 'stronger_invalid' : verdictChanged ? 'verdict_changed' : 'verdict_same',
      trigger: o.trigger,
      subject: r.workItemId,
      usd: r.escalationUsd ?? 0,
      llmCallId: o.callIds.get(r.workItemId) ?? null,
      detail: { jobId: o.jobId, from: r.escalatedFrom, to: r.verdict, action, cheapAction, actionChanged: action !== cheapAction },
    });
  }
  return { escalated, changed };
}

export interface SettleHandlerDeps {
  handle: DbHandle;
  model?: CompletionModel;
  /** Most items one pass judges (the rest wait for the next pass). */
  maxItems?: number;
  /** Most a pass spends; it stops judging once reached. */
  maxUsdPerPass?: number;
  concurrency?: number;
  /** Judge exactly these items (an operator rerun: scripts/settle/run-pass.ts --ids), ignoring the watermark. */
  ids?: string[];
}

export function settleHandler(deps: SettleHandlerDeps): JobHandler {
  let model: CompletionModel | undefined = deps.model;
  return async (ctx) => {
    model ??= agentSdkCompletionModel({ timeoutMs: 120_000 });
    const startedAt = ctx.clock();
    const since = await lastSettleThrough(ctx.db, ctx.userId);
    const firstPass = !since;
    const user = await loadSettleUser(ctx.db, ctx.userId);
    const settings = await loadClosingSettings(ctx.db, ctx.userId);
    const reopenWindowDays = closureSettingsFrom(
      Object.fromEntries((await ctx.db.execute<{ key: string; value: unknown }>(sql`select key, value from user_settings where owner_user_id = ${ctx.userId} and key = ${CLOSURE_SETTING_KEYS.reopenWindowDays}`)).rows.map((r) => [r.key, r.value])),
    ).reopenWindowDays;
    const picked = deps.ids?.length
      ? (await ctx.db.execute<{ id: string; status: string }>(sql`select id::text as id, status::text as status from work_items where owner_user_id = ${ctx.userId} and id::text = any(${sql`array[${sql.join(deps.ids.map((i) => sql`${i}`), sql`, `)}]::text[]`})`)).rows
      : await selectSettleItems(ctx.db, ctx.userId, since, startedAt, deps.maxItems ?? 600, { reopenOnFollowUp: settings.reopenOnFollowUp, reopenWindowDays });
    if (!picked.length) return { status: 'nothing_to_do', through: startedAt.toISOString(), firstPass, judged: 0 };
    const budget: SettleBudget = firstPass ? 'first_scan' : 'daily';
    const store = new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
    // COST-1: at the daily hard cap nothing is called; every item waits for the next budget day (the watermark stays).
    if ((await store.budgetStatus()).state === 'capped') {
      ctx.log('settle: daily hard cap reached; items wait for the next budget day', { pending: picked.length });
      await store.recordDecision({ skill: SETTLE_SKILL, kind: 'block', reason: 'hard_cap', trigger: typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'interval', count: picked.length, detail: { jobId: ctx.job.id ?? null } });
      return { status: 'deferred_budget', through: since ?? null, firstPass, judged: 0, unjudged: picked.length, costUsd: 0, deferred: 'daily_hard_cap' };
    }
    const facts = await policyFacts(ctx.db, ctx.userId, picked.map((p) => p.id));
    const cap = deps.maxUsdPerPass ?? (firstPass ? 5 : 1);
    const timezone = (await ctx.db.execute<{ tz: string | null }>(sql`select timezone as tz from users where id = ${ctx.userId}`)).rows[0]?.tz ?? user.timezone ?? 'UTC';
    // The stronger model's allowance is per day: what earlier passes today already spent on it comes off (the first pass,
    // on the first-scan budget: at least $3).
    const allowance = settings.strongerModelForUnclear ? (firstPass ? Math.max(3, settings.strongerModelUsdPerDay) : settings.strongerModelUsdPerDay) : 0;
    const strongerToday = allowance > 0 ? await settleStrongerSpend(ctx.db, ctx.userId, localDay(startedAt, timezone), budget) : 0;
    const st: GuardState = { spent: 0, strongerCallId: new Map(), stronger: { left: Math.max(0, allowance - strongerToday), spent: 0, reserved: 0, refused: 0 }, capped: false };
    const trigger = typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : deps.ids?.length ? 'manual' : 'interval';
    const ac = new AbortController();
    ctx.signal.addEventListener('abort', () => ac.abort(), { once: true });
    const call = guardedModel(ctx, model, st, { store, budget, timezone, trigger, skillVersion: loadSkill(SETTLE_SKILL).version, onSpend: () => (st.spent >= cap ? ac.abort() : undefined), stop: () => ac.abort() });
    const all = await settleMany(picked.map((p) => p.id), (id) => loadSettleRaw(ctx.db, ctx.userId, id, { now: startedAt }), call, {
      now: startedAt,
      timezone: user.timezone,
      me: user.me,
      rules: settings.rules || null,
      concurrency: deps.concurrency ?? 4,
      // Unclear cheap verdicts go to the stronger model, within what is left of today's allowance.
      escalate: st.stronger.left > 0 ? { model: SETTLE_STRONG_MODEL, maxUsd: st.stronger.left } : null,
      signal: ac.signal,
    });
    // An item whose first call the hard cap refused was not judged: it waits, like the ones never started.
    const results = all.filter((r) => r.error !== SETTLE_REFUSED.hardCap);
    const esc = await recordEscalations(store, results, facts, settings, { trigger, jobId: ctx.job.id ?? null, callIds: st.strongerCallId });
    if (st.stronger.refused) await store.recordDecision({ skill: SETTLE_SKILL, kind: 'block', reason: 'stronger_day_cap', trigger, count: st.stronger.refused, detail: { jobId: ctx.job.id ?? null, allowanceUsd: allowance, spentTodayUsd: strongerToday + st.stronger.spent } });
    if (st.capped) await store.recordDecision({ skill: SETTLE_SKILL, kind: 'block', reason: 'hard_cap', trigger, count: Math.max(1, picked.length - results.length), detail: { jobId: ctx.job.id ?? null } });
    const counts: Record<string, number> = {};
    const entries: Parameters<DbDataSource['settleApply']>[0] = [];
    for (const r of results) {
      counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
      const f = facts.get(r.workItemId);
      if (!f) continue;
      const d = decideSettle(r, f, settings);
      if (d.action === 'leave') continue;
      entries.push({
        itemId: r.workItemId,
        expectedState: f.status === 'in_progress' ? 'in_progress' : f.status,
        action: d.action,
        reasonClass: d.reason,
        ...(d.resolution ? { resolution: d.resolution } : {}),
        reason: r.reason || (d.reason ?? r.verdict),
        verdict: r.verdict,
        confidence: r.confidence,
        check: r.skill,
        ...(r.cite ? { cite: { sourceItemId: r.cite.sourceItemId, url: r.cite.url, byName: r.cite.by, fromMe: r.cite.fromMe, ...(r.cite.at ? { at: r.cite.at } : {}) } } : {}),
        ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}),
      });
    }
    const ds = new DbDataSource({ handle: deps.handle, userId: ctx.userId });
    const applied = entries.length ? await ds.settleApply(entries) : { applied: {}, skipped: 0, auditIds: {} };
    // OUTBOX-W: each close above withdrew its own pending drafts; this sweep clears any a close left behind (older
    // rows, a draft that raced a close), so the Outbox never asks to send a reply to a closed to-do.
    const withdrawn = (await withdrawClosedItemDrafts(ctx.db, ctx.userId, { ref: 'settle.withdraw', at: ctx.clock() })).length;
    const unjudged = picked.length - results.length;
    if (st.capped) ctx.log('settle: daily hard cap reached mid-pass; the rest waits for the next budget day', { judged: results.length, pending: unjudged });
    // An aborted pass (cost cap, hard cap, shutdown) leaves its watermark where it was, so the next pass picks the rest up.
    return {
      status: st.capped ? 'deferred_budget' : unjudged ? 'partial' : 'ok',
      through: unjudged || st.capped ? (since ?? null) : startedAt.toISOString(),
      firstPass,
      judged: results.length,
      unjudged,
      costUsd: Number(st.spent.toFixed(6)),
      strongerUsd: Number(st.stronger.spent.toFixed(6)),
      strongerLeftUsd: Number(Math.max(0, st.stronger.left - st.stronger.spent).toFixed(6)),
      ...(st.stronger.refused ? { strongerRefused: st.stronger.refused } : {}),
      ...(esc.escalated ? { escalated: esc.escalated, escalationChanged: esc.changed } : {}),
      ...(st.capped ? { deferred: 'daily_hard_cap' } : {}),
      verdicts: counts,
      applied: applied.applied,
      skipped: applied.skipped,
      ...(withdrawn ? { withdrawn } : {}),
      errors: results.filter((r) => r.error).length,
    };
  };
}

export function settleJobDef(deps: SettleHandlerDeps): JobHandlerDef {
  return {
    kind: SETTLE_JOB_KIND,
    queue: SETTLE_QUEUE,
    wired: true,
    spends: true,
    description: 'Settle pass: judge each item with the whole conversation around it, then close for you, ask or leave it (SETTLE-1)',
    handler: settleHandler(deps),
  };
}
