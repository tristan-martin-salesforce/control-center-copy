/**
 * `use_cases.extract` (queue `maintenance`, holistic review 2026-11-20 lane 06 R6): read the last 21 days of Gemini
 * notes, meetings, Slack threads and mail threads with a customer for use cases, and stage each as a candidate (or as
 * more evidence on the one it matches) for Activity ▸ Needs you ▸ Use cases to add (src/server/datasource/db/use-cases.ts
 * runUseCaseExtract). Then the landing sweep marks staged ones the Org62 and VDP reads found.
 *
 * Rules first (src/engines/use-cases/extract.ts). Only the statements the rules are unsure of go to the model: ONE
 * tool-less Haiku call per source through the `ModelProvider.complete()` seam (skill `extract-use-cases`,
 * skills/extract-use-cases.md), under ONE spend-governor hold for the pass (H-5: estimate → hold → tick → raise a
 * hand at the hold, never kill; a day with no room skips the model and keeps the rules' results). F-3 (caps audit 26):
 * each answer is kept per (source, prompt version), so the next pass asks only what changed or was never answered,
 * a page at a time (the next page is queued while sources are due). Each call is one
 * llm_calls row keyed like the completion pass (`ledgerHash(model, skill version, system, user)`), so a cassette
 * (src/scanner/completion/cassette.ts) replays it offline. The statements are redacted before they are sent.
 *
 * Queued after new meeting notes, calendar or Slack items land (extractUseCasesHook, the worker's post-scan hooks) and
 * nightly (schedules.ts, 03:05). Local data only: nothing is read from or written to any external system. The model
 * runs only in the launchd worker (CC_LIVE) unless a test injects one. jobs.result holds counts and codes only.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { insertLlmCall, ledgerHash } from '@/db/ledger';
import { userSettings } from '@/db/schema';
import { enqueueJob } from '@/db/queue';
import { localDay } from '@/engines/activity/time';
import { actors, withChangeSet } from '@/db/changeset';
import { applyConfirm, confirmRequest, CONFIRM_CALL_USD, EXTRACT_USE_CASES_SKILL, EXTRACT_USE_CASES_VERSION, parseConfirm, type ConfirmedItem, type UcMention } from '@/engines/use-cases';
import { SCANNER_MODEL } from '@/llm/models';
import { modelProvider } from '@/llm/provider';
import { redactText } from '@/llm/redact';
import { finishJobSpend, gateOf, holdGate, spendHoldIdOf, startJobSpend, type Hold, type JobSpendStart, type SpendGovernor } from '@/llm/spend';
import type { CompletionModel } from '@/scanner/completion/types';
import { dbSpendGovernor } from '@/server/datasource/db/spend';
import { putKv } from '@/server/datasource/db/ext';
import { runUseCaseExtract, USE_CASES_EXTRACT_JOB, USE_CASES_QUEUE, type ExtractDeps } from '@/server/datasource/db/use-cases';

import { nextPageDue, queueNextPage } from '../pass-pages';
import { queueSpendContinuation } from '../spend-pause';
import type { JobContext, JobHandlerDef } from '../types';

export { USE_CASES_EXTRACT_JOB };

export interface UseCasesExtractDeps {
  /** The model seam (tests pass a fake or a cassette; it also turns the model on outside the launchd worker). */
  model?: CompletionModel;
  spend?: SpendGovernor;
  /** Calls a page (default PAGE_CALLS). */
  maxCalls?: number;
}

let deps: UseCasesExtractDeps = {};
export function configureUseCasesExtract(d: UseCasesExtractDeps): void {
  deps = { ...deps, ...d };
}
export function resetUseCasesExtractConfig(): void {
  deps = {};
}

const live = () => process.env.CC_LIVE === '1' || (process.env.CC_LIVE === undefined && process.env.NODE_ENV === 'production');

/** A CompletionModel over the provider seam (`ModelProvider.complete()`: one prompt in, text out, no tools). */
export function providerCompletionModel(): CompletionModel {
  return async (req) => {
    const r = await modelProvider().complete({ model: req.model, system: req.system, messages: [{ role: 'user', content: req.user }], maxTokens: 800, budgetUsd: req.maxBudgetUsd, effort: req.effort ?? 'low', ...(req.signal ? { signal: req.signal } : {}), timeoutMs: 60_000 });
    return { ok: r.ok, text: r.text, costUsd: r.usage.costUsd, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens, cacheWriteTokens: r.usage.cacheWriteTokens, ...(r.ok ? {} : { error: { message: r.error ?? 'model error', errorClass: 'unknown' as const } }) };
  };
}

/** Queue one pass (one queued at a time). */
export async function enqueueUseCasesExtract(db: Db, userId: string, trigger: string): Promise<boolean> {
  const r = await enqueueJob(db, { ownerUserId: userId, kind: USE_CASES_EXTRACT_JOB, queue: USE_CASES_QUEUE, payload: { trigger }, dedupeKey: `${USE_CASES_EXTRACT_JOB}:${userId}`, runAt: new Date(Date.now() + 60_000), maxAttempts: 2, timeoutSeconds: 900 });
  return r.inserted;
}

/**
 * The calls one page makes (caps audit 26 F-3): a page keeps the job short and its heartbeat fresh, it is not a cap. A
 * pass that stops at its page with unsure sources still unanswered queues the next page (src/jobs/pass-pages.ts), so
 * every source is asked once; the answer cache keeps an answered one from being asked again.
 */
export const PAGE_CALLS = 12;

/**
 * The confirm answers, per (source, prompt version, statements): `ledgerHash(version, source key, system, user)`. A
 * source whose statements or prompt changed is asked again; an unusable answer is kept as "none" (the same inputs never
 * cost twice); a failed call is not kept. Entries for sources no longer unsure are dropped. Stored in the job's own kv
 * (`user_settings`, next to `cc.use_cases.extract`): local data, model wording of the user's own notes, like the
 * suggestions kv.
 */
export const CONFIRM_CACHE_KV = 'cc.use_cases.confirm';

export interface ConfirmCache {
  get(key: string): ConfirmedItem[] | undefined;
  set(key: string, items: ConfirmedItem[]): void;
  /** Persist, keeping only `keys` (the sources unsure now). Never throws. */
  save(keys: ReadonlySet<string>): Promise<void>;
}

type CacheValue = { v: 1; entries: Record<string, { at: string; items: ConfirmedItem[] }> };

/** The kv-backed cache (a tolerant read: no row, an odd row or a fake db reads as empty). */
export async function dbConfirmCache(ctx: Pick<JobContext, 'db' | 'userId' | 'clock'>): Promise<ConfirmCache> {
  let v: CacheValue | undefined;
  try {
    const [row] = await ctx.db.select({ value: userSettings.value }).from(userSettings).where(and(eq(userSettings.ownerUserId, ctx.userId), eq(userSettings.key, CONFIRM_CACHE_KV))).limit(1);
    v = row?.value as CacheValue | undefined;
  } catch {
    v = undefined;
  }
  const entries: CacheValue['entries'] = v && v.v === 1 && v.entries && typeof v.entries === 'object' ? { ...v.entries } : {};
  const before = JSON.stringify(entries);
  return {
    get: (k) => entries[k]?.items,
    set: (k, items) => void (entries[k] = { at: ctx.clock().toISOString(), items }),
    save: async (keys) => {
      for (const k of Object.keys(entries)) if (!keys.has(k)) delete entries[k];
      if (JSON.stringify(entries) === before) return;
      await withChangeSet({ db: ctx.db, userId: ctx.userId, actor: actors.engine('use-cases'), reason: 'Use cases to add: the model answers kept for the unsure sources', entity: { type: 'settings', id: CONFIRM_CACHE_KV }, undoable: false }, async (tx) => {
        await putKv(tx, ctx.userId, CONFIRM_CACHE_KV, Object.keys(entries).length ? { v: 1, entries } : null);
      }).catch(() => undefined);
    },
  };
}

export const confirmCacheKey = (sourceKey: string, req: { system: string; user: string }) => ledgerHash(EXTRACT_USE_CASES_VERSION, sourceKey, req.system, req.user);

/** What a pass's model step did, for the job's next page or continuation. */
export interface ConfirmPage {
  /** Sources still unanswered after this page. */
  left: number;
  stoppedAtPage: boolean;
  progressed: number;
  /** The hold this pass asked on (its continuation carries it). */
  askedHold: Hold | null;
}

/**
 * The job's spend envelope: a continuation's own hold; while an ask of this job is unanswered, no model (one question
 * stands, as for a scan scope); an allowed one is resumed by the next pass; else a new hold.
 */
async function envelopeFor(gov: SpendGovernor | null, ctx: JobContext): Promise<JobSpendStart> {
  if (!gov) return { kind: 'none' };
  const opts = { scope: 'job' as const, skill: EXTRACT_USE_CASES_SKILL, model: SCANNER_MODEL };
  if (spendHoldIdOf(ctx.job.payload)) return startJobSpend(gov, ctx.job, opts);
  const prefix = `${USE_CASES_EXTRACT_JOB}:`;
  const [asked] = await gov.store.listHolds({ states: ['asked'], jobKeyPrefix: prefix, limit: 1 }).catch(() => [] as Hold[]);
  if (asked) return { kind: 'waiting', hold: asked };
  const [allowed] = await gov.store.listHolds({ states: ['approved'], jobKeyPrefix: prefix, limit: 1 }).catch(() => [] as Hold[]);
  if (allowed) return { kind: 'run', gate: holdGate(gov, allowed), owned: true, resumed: true };
  return startJobSpend(gov, ctx.job, opts);
}

/**
 * The model pass over the unsure mentions: one call per source not answered before (the cache), a page at a time, under
 * one governor hold (H-5: past it, raise a hand and stop; the continuation carries the hold), every call booked.
 */
export function confirmWith(ctx: JobContext, model: CompletionModel, gov: SpendGovernor | null, o: { maxCalls?: number; day: string; cache?: ConfirmCache; page?: ConfirmPage }): NonNullable<ExtractDeps['confirm']> {
  return async (unsure, products) => {
    const confirmed = new Map<string, UcMention[]>();
    const cache = o.cache ?? (await dbConfirmCache(ctx));
    const pageSize = o.maxCalls ?? PAGE_CALLS;
    const todo: Array<{ k: string; ms: readonly UcMention[]; req: { system: string; user: string }; key: string }> = [];
    const keys = new Set<string>();
    let fromCache = 0;
    for (const [k, ms] of unsure) {
      const req = confirmRequest(
        ms.map((m) => ({ statement: redactText(m.statement) })),
        products,
      );
      const key = confirmCacheKey(k, req);
      keys.add(key);
      const hit = cache.get(key);
      if (hit) {
        fromCache += 1;
        const yes = applyConfirm(ms, hit);
        if (yes.length) confirmed.set(k, yes);
      } else todo.push({ k, ms, req, key });
    }
    const page = o.page ?? { left: 0, stoppedAtPage: false, progressed: 0, askedHold: null };
    page.left = todo.length;
    if (!todo.length) {
      await cache.save(keys);
      return { confirmed, calls: 0, costUsd: 0, deferred: null, cached: fromCache };
    }
    const env = await envelopeFor(gov, ctx);
    if (env.kind === 'day_budget') return { confirmed, calls: 0, costUsd: 0, deferred: 'day_budget', cached: fromCache };
    if (env.kind === 'waiting' || env.kind === 'stopped') {
      await cache.save(keys);
      return { confirmed, calls: 0, costUsd: 0, deferred: env.kind === 'waiting' ? 'spend_ask_open' : 'spend_stopped', cached: fromCache };
    }
    const gate = gateOf(env);
    let calls = 0;
    let costUsd = 0;
    let deferred: string | null = null;
    try {
      for (const t of todo) {
        if (ctx.signal.aborted) break;
        if (calls >= pageSize) {
          page.stoppedAtPage = true;
          break;
        }
        const started = Date.now();
        const maxBudgetUsd = gate ? Math.max(CONFIRM_CALL_USD, gate.ceilingUsd()) : CONFIRM_CALL_USD;
        const out = await model({ system: t.req.system, user: t.req.user, model: SCANNER_MODEL, effort: 'low', maxBudgetUsd, signal: ctx.signal });
        calls += 1;
        costUsd += Math.max(0, out.costUsd || 0);
        const hash = ledgerHash(SCANNER_MODEL, EXTRACT_USE_CASES_VERSION, t.req.system, t.req.user);
        await book(ctx, o.day, { costUsd: out.costUsd, inputTokens: out.inputTokens, outputTokens: out.outputTokens, cacheReadTokens: out.cacheReadTokens ?? 0, cacheWriteTokens: out.cacheWriteTokens ?? 0, ok: out.ok, errorCode: out.ok ? null : (out.error?.errorClass ?? 'unknown'), latencyMs: Date.now() - started, contentHash: hash }).catch(() => undefined);
        void ctx.heartbeat().catch(() => undefined);
        if (out.ok) {
          const items = parseConfirm(out.text, t.ms.length);
          // F-3: kept, an unusable answer as none, so this source is not asked again until it changes
          cache.set(t.key, items);
          page.progressed += 1;
          page.left -= 1;
          const yes = applyConfirm(t.ms, items);
          if (yes.length) confirmed.set(t.k, yes);
        }
        // H-5: past the hold with sources still to ask, raise a hand and stop at this safe point (what is confirmed stays)
        if (gate && gate.observe(costUsd) === 'ask' && t !== todo[todo.length - 1]) {
          await gate.ask({ pctDone: Math.round((calls / todo.length) * 100) }).catch(() => undefined);
          deferred = 'spend_ask';
          page.askedHold = gate.hold;
          break;
        }
      }
    } finally {
      await finishJobSpend(gov, env, gate ? gate.hold.spentUsd : costUsd);
      await cache.save(keys);
    }
    return { confirmed, calls, costUsd: Math.round(costUsd * 10_000) / 10_000, deferred, cached: fromCache };
  };
}

async function book(ctx: JobContext, day: string, c: { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; ok: boolean; errorCode: string | null; latencyMs: number; contentHash: string }) {
  const finished = new Date();
  await insertLlmCall(ctx.db, {
    ownerUserId: ctx.userId,
    purpose: 'classify',
    model: SCANNER_MODEL,
    skillKey: EXTRACT_USE_CASES_SKILL,
    promptVersion: EXTRACT_USE_CASES_VERSION,
    requestHash: `${EXTRACT_USE_CASES_SKILL}:${ctx.job.id}:${randomUUID()}`,
    jobId: ctx.job.id,
    status: c.ok ? 'ok' : 'error',
    errorCode: c.errorCode,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheWriteTokens: c.cacheWriteTokens,
    costUsd: c.costUsd,
    latencyMs: c.latencyMs,
    budgetDay: day,
    budget: 'daily',
    startedAt: new Date(finished.getTime() - c.latencyMs),
    finishedAt: finished,
    rollup: false,
    trigger: typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'schedule',
    modelReason: 'default',
    contentHash: c.contentHash,
    outcome: c.ok ? 'ok' : (c.errorCode ?? 'error'),
  });
}

export async function runUseCasesExtract(ctx: JobContext, d: UseCasesExtractDeps = deps): Promise<Record<string, unknown>> {
  const now = ctx.clock();
  const tz = (await ctx.db.execute<{ tz: string | null }>(sql`select timezone as tz from users where id = ${ctx.userId}`)).rows[0]?.tz ?? 'UTC';
  const model = d.model ?? (live() ? providerCompletionModel() : null);
  const gov = d.spend ?? (model ? dbSpendGovernor({ db: ctx.db, userId: ctx.userId, clock: ctx.clock }) : null);
  const page: ConfirmPage = { left: 0, stoppedAtPage: false, progressed: 0, askedHold: null };
  const res = await runUseCaseExtract(ctx.db, ctx.userId, now, model ? { confirm: confirmWith(ctx, model, gov, { ...(d.maxCalls ? { maxCalls: d.maxCalls } : {}), day: localDay(now.getTime(), tz), page }) } : {});
  // asked: the continuation carries the hold (Allow runs it at once); else the next page while sources are due
  if (page.askedHold) return { ...res, paused: 'spend', holdId: page.askedHold.id, queued: await queueSpendContinuation(ctx, page.askedHold) };
  if (nextPageDue({ stoppedAtPage: page.stoppedAtPage, left: page.left, progressed: page.progressed, aborted: ctx.signal.aborted })) {
    return { ...res, more: page.left, nextPage: await queueNextPage(ctx, { kind: USE_CASES_EXTRACT_JOB, queue: USE_CASES_QUEUE, dedupeKey: `${USE_CASES_EXTRACT_JOB}:${ctx.userId}`, maxAttempts: 2, timeoutSeconds: 900 }) };
  }
  return res;
}

export function extractUseCasesJobDef(): JobHandlerDef {
  return { kind: USE_CASES_EXTRACT_JOB, queue: USE_CASES_QUEUE, wired: true, spends: true, description: 'Use cases to add: notes, meetings, Slack and mail with a customer → use-case candidates (rules first, Haiku only for unsure statements, under the spend governor); nothing is sent', handler: (ctx) => runUseCasesExtract(ctx) };
}

/**
 * The worker's post-scan hook: a pass after new meeting notes, calendar events or Slack / Gmail items land (and one
 * after each start). The job's dedupe key keeps one queued; it runs a minute later, so a scan's burst is one pass.
 */
export function extractUseCasesHook(db: Db, userId: string, log: (msg: string, f?: Record<string, unknown>) => void, o: { everyMs?: number } = {}) {
  let seen: string | null | undefined;
  return {
    name: USE_CASES_EXTRACT_JOB,
    everyMs: o.everyMs ?? 5 * 60_000,
    run: async () => {
      try {
        const r = await db.execute<{ last: Date | string | null }>(sql`
          select max(updated_at) as last from source_items
           where owner_user_id = ${userId} and source::text in ('gemini_notes', 'calendar', 'slack', 'gmail') and updated_at > now() - interval '21 days'`);
        const last = r.rows[0]?.last ? new Date(r.rows[0].last).toISOString() : null;
        if (last === seen) return;
        seen = last;
        if (!last) return;
        if (await enqueueUseCasesExtract(db, userId, 'scan')) log('use_cases.extract: queued after new items');
      } catch (err) {
        log('use_cases.extract: could not queue a pass', { code: (err as Error).name });
      }
    },
  };
}
