/**
 * In-process answer hand-off for an ask a live run is waiting on (the Assistant's turn waits at its next tool call;
 * 05 §6.3: the SDK query stays alive, so nothing is paid twice). The answer route (POST /chat/spend-answer, POST
 * /spend/holds/:id/answer) delivers here; a run in another process (the worker) reads the answer from its hold instead.
 */
import type { SpendAnswer } from './types';

type Waiter = (a: SpendAnswer | null) => void;
const waiters = new Map<string, Waiter>();

/** Wait for the user's answer to `holdId`: null after `timeoutMs` or on abort. */
export function waitForAnswer(holdId: string, o: { timeoutMs: number; signal?: AbortSignal }): Promise<SpendAnswer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (a: SpendAnswer | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
      if (waiters.get(holdId) === finish) waiters.delete(holdId);
      resolve(a);
    };
    const onAbort = () => finish(null);
    const t = setTimeout(() => finish(null), Math.max(0, o.timeoutMs));
    t.unref?.();
    if (o.signal?.aborted) return finish(null);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    waiters.set(holdId, finish);
  });
}

/** Hand an answer to the run waiting on `holdId`; false when none waits here (the stream ended, or another process). */
export function deliverAnswer(holdId: string, a: SpendAnswer): boolean {
  const w = waiters.get(holdId);
  if (!w) return false;
  w(a);
  return true;
}

export function isWaiting(holdId: string): boolean {
  return waiters.has(holdId);
}
