/**
 * A job handler's side of the spend envelope (src/llm/spend/job-spend.ts; caps audit 26 F-4): what a job does when its
 * hold says wait, stop or ask. The pass-pages pattern (src/jobs/pass-pages.ts) queues the next page while work is
 * due; this queues the same job again once the user answers a spend ask.
 *
 *   waiting      a continuation whose ask is unanswered: queued again for later (the answer runs it at once)
 *   stopped      the user answered Stop: nothing more is paid; what the job already did stays
 *   day_budget   today's hard cap has no room: the job does what it can without the model (each says what)
 *   asked        the paid loop passed its hold and raised a hand: the continuation is queued carrying the hold
 */
import { spendContinuation, type JobSpendStart } from '@/llm/spend/job-spend';
import type { Hold } from '@/llm/spend';

import type { JobContext } from './types';

/** Queue the job again carrying `hold` (once per hold). Returns whether it was queued. */
export async function queueSpendContinuation(ctx: Pick<JobContext, 'job' | 'enqueue'>, hold: Pick<Hold, 'id'>, o: { dedupeKey?: string; payload?: Record<string, unknown>; delaySeconds?: number } = {}): Promise<boolean> {
  const c = spendContinuation({ kind: ctx.job.kind, queue: ctx.job.queue, payload: { ...ctx.job.payload, ...(o.payload ?? {}) }, maxAttempts: ctx.job.maxAttempts, timeoutSeconds: ctx.job.timeoutSeconds }, hold, { ...(o.dedupeKey ? { dedupeKey: o.dedupeKey } : {}), ...(o.delaySeconds != null ? { delaySeconds: o.delaySeconds } : {}) });
  const r = await ctx.enqueue(c).catch(() => null);
  return !!r;
}

/**
 * The job's result when its envelope does not let it run (null: run). A waiting continuation is queued again, so it
 * keeps waiting on the answer; Stop ends it quietly (`skipped`). The day's cap (`day_budget`) is the caller's: each job
 * already says what it does there (skip, defer, or the rules alone).
 */
export async function spendStartResult(ctx: Pick<JobContext, 'job' | 'enqueue' | 'log'>, s: JobSpendStart, o: { dedupeKey?: string } = {}): Promise<Record<string, unknown> | null> {
  if (s.kind === 'waiting') {
    const queued = await queueSpendContinuation(ctx, s.hold, o);
    ctx.log(`${ctx.job.kind}: waiting for your answer to a spend ask`, { holdId: s.hold.id, code: 'spend_ask_open' });
    return { skipped: 'spend_ask_open', holdId: s.hold.id, queued };
  }
  if (s.kind === 'stopped') return { skipped: 'spend_stopped', holdId: s.hold.id };
  return null;
}

/** After the paid loop: when it raised its hand, queue the continuation. Returns the result fields to add. */
export async function spendPauseResult(ctx: Pick<JobContext, 'job' | 'enqueue' | 'log'>, s: JobSpendStart, o: { dedupeKey?: string; payload?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
  if (s.kind !== 'run' || s.gate.hold.state !== 'asked') return {};
  const queued = await queueSpendContinuation(ctx, s.gate.hold, o);
  ctx.log(`${ctx.job.kind}: paused at its spend estimate; asked you to allow more`, { holdId: s.gate.hold.id, code: 'paused_for_spend' });
  return { paused: 'spend', holdId: s.gate.hold.id, queued };
}
