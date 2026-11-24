/**
 * `priority.rerank` (queue `priority`, concurrency 1): the auto re-rank (lane 07 R4, H-8 decision 7). Ranking used to
 * run only when the user pressed r, applied a policy or switched persona, so new asks sat unranked and start-bys went
 * stale (PRIO-5). Now it runs when the inputs change, debounced 60 s:
 *
 * - writers that change an input (a captured item, a due-date / start-by / effort / importance edit, a state change)
 *   call `enqueueRerank` in their own transaction;
 * - `rerankHook` (the worker) watches a cheap fingerprint of work items and calendar events, so scans, calendar syncs,
 *   meetings added or moved and the closure pass all count without touching their code;
 * - every enqueue merges into the one queued job (dedupe key) and pushes it 60 s out, so a burst ranks once.
 *
 * The job ranks with the deterministic engine (no model call, no spend) and keeps what is on screen stable: the shown
 * Top 3 moves only for an urgent pre-emption (stability.ts `rerank`, D-73), the rest takes the new order. The ops
 * endpoint POST /admin/priority/rerank-all queues one per user. jobs.result holds counts only.
 */
import { sql } from 'drizzle-orm';

import type { DbHandle, DbOrTx } from '@/db/client';
import { enqueueJob } from '@/db/queue';

import type { JobHandlerDef } from '../types';

export const RERANK_JOB_KIND = 'priority.rerank';
export const RERANK_QUEUE = 'priority';
export const RERANK_DEBOUNCE_S = 60;
export const rerankDedupeKey = (userId: string) => `priority.rerank:${userId}`;

export type RerankTrigger = 'new_info' | 'calendar_change' | 'schedule' | 'startup' | 'ops';

/** Queue (or push back) the one re-rank for this user: a burst of changes ranks once, 60 s after the last. */
export async function enqueueRerank(db: DbOrTx, userId: string, trigger: RerankTrigger, o: { delaySeconds?: number } = {}): Promise<{ id: number; inserted: boolean }> {
  return enqueueJob(db, { ownerUserId: userId, kind: RERANK_JOB_KIND, queue: RERANK_QUEUE, dedupeKey: rerankDedupeKey(userId), payload: { trigger }, delaySeconds: o.delaySeconds ?? RERANK_DEBOUNCE_S, maxAttempts: 2, timeoutSeconds: 300 });
}

export interface RerankDeps {
  /** The DataSource's stable system re-rank (db/index.ts `autoRerank`); injected so tests use a fake. */
  rerank: (userId: string, trigger: RerankTrigger) => Promise<{ top3: string[]; changed: number }>;
}

export function rerankJobDef(deps: RerankDeps): JobHandlerDef {
  return {
    kind: RERANK_JOB_KIND,
    queue: RERANK_QUEUE,
    wired: true,
    description: 'auto re-rank after inputs change (debounced 60 s; deterministic, no model call; the shown Top 3 stays stable)',
    handler: async (ctx) => {
      const trigger = (ctx.job.payload as { trigger?: RerankTrigger }).trigger ?? 'new_info';
      const r = await deps.rerank(ctx.userId, trigger);
      ctx.log('priority: re-ranked', { trigger, changed: r.changed });
      return { trigger, changed: r.changed, top3: r.top3.length };
    },
  };
}

/** The DataSource-backed deps (the worker passes its handle). */
export function dbRerankDeps(handle: DbHandle): RerankDeps {
  return {
    rerank: async (userId, trigger) => {
      const { DbDataSource } = await import('@/server/datasource/db');
      return new DbDataSource({ handle, userId }).autoRerank(trigger);
    },
  };
}

export interface InputsFingerprint {
  items: string;
  events: string;
}

/**
 * A cheap fingerprint of what ranking reads: the work items' ranking inputs (status, due, start-by, effort, importance,
 * version) and the calendar events (count + latest change). The rank and score columns a re-rank writes are not in it,
 * so a re-rank never re-triggers itself.
 */
export async function inputsFingerprint(db: DbOrTx, userId: string): Promise<InputsFingerprint> {
  const r = await db.execute<{ items: string; events: string }>(sql`
    select (select count(*)::text || ':' || coalesce(sum(version), 0)::text || ':' ||
                   coalesce(sum(hashtext(status::text || '|' || coalesce(due_at::text, '') || '|' || coalesce(effort_minutes, 0)::text || '|' || importance::text || '|' || coalesce(deadline_event_id::text, ''))::bigint), 0)::text
              from work_items where owner_user_id = ${userId}) as items,
           (select count(*)::text || ':' || coalesce(max(updated_at)::text, '') from calendar_events where owner_user_id = ${userId}) as events`);
  return { items: r.rows[0]?.items ?? '', events: r.rows[0]?.events ?? '' };
}

/**
 * The worker hook: every 15 s, compare the fingerprint; a change queues the debounced re-rank (calendar changes are
 * tagged `calendar_change`). The first look only records the baseline (a restart never ranks by itself).
 */
export function rerankHook(db: DbOrTx, userId: string, log: (msg: string, f?: Record<string, unknown>) => void, deps: { fingerprint?: typeof inputsFingerprint; enqueue?: typeof enqueueRerank } = {}) {
  let last: InputsFingerprint | null = null;
  const fp = deps.fingerprint ?? inputsFingerprint;
  const enqueue = deps.enqueue ?? enqueueRerank;
  return {
    name: 'priority.rerank',
    everyMs: 15_000,
    run: async () => {
      try {
        const now = await fp(db, userId);
        const prev = last;
        last = now;
        if (!prev) return;
        if (now.items === prev.items && now.events === prev.events) return;
        await enqueue(db, userId, now.events !== prev.events ? 'calendar_change' : 'new_info');
      } catch (err) {
        log('priority re-rank hook failed', { code: (err as { code?: string }).code ?? (err as Error).name });
      }
    },
  };
}
