/**
 * A model pass over a backlog works in pages (caps audit 2026-11-21, the owner's rule: a limit exists only for a real
 * external limit, a user budget or safety). The page size and the page's $ line keep one job short and its heartbeat
 * fresh; they are not a cap on the work. A pass that stops at its page with rows still due queues the next page, so
 * the whole backlog is done. The user budget (the daily hard cap) still stops it: that is checked before every call.
 *
 * Safety: the next page is queued only when this page made progress (at least one answer stored). A page where every
 * call failed stops; the next natural trigger (new rows, a worker start) tries again.
 */
import type { JobContext } from './types';

export interface PageOutcome {
  /** The loop stopped at its page size or the page's $ line (not at the daily cap, an abort or the end). */
  stoppedAtPage: boolean;
  /** Rows still due after this page. */
  left: number;
  /** Answers stored this page (answered + unusable kept as none). */
  progressed: number;
  aborted: boolean;
}

export function nextPageDue(o: PageOutcome): boolean {
  return o.stoppedAtPage && o.left > 0 && o.progressed > 0 && !o.aborted;
}

/** Queue the next page of the same job (its dedupe key keeps one queued; it starts after this one finishes). */
export async function queueNextPage(ctx: Pick<JobContext, 'enqueue'>, job: { kind: string; queue: string; dedupeKey: string; maxAttempts?: number; timeoutSeconds?: number }): Promise<boolean> {
  const r = await ctx
    .enqueue({ kind: job.kind, queue: job.queue, payload: { trigger: 'next_page' }, dedupeKey: job.dedupeKey, delaySeconds: 5, ...(job.maxAttempts ? { maxAttempts: job.maxAttempts } : {}), ...(job.timeoutSeconds ? { timeoutSeconds: job.timeoutSeconds } : {}) })
    .catch(() => null);
  return !!r?.inserted;
}
