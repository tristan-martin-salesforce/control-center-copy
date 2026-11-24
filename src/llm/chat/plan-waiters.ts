/**
 * The plan card's answer hand-off (Assistant v2): a turn that showed a plan with a research-class `run` waits here, its
 * SDK query alive (the model waits on the `plan` tool's result, so no tokens are spent), for POST /chat/plan-answer.
 * Process-wide (globalThis): every Next route bundle shares it, like the spend waiters.
 */
export type PlanAnswer = { answer: 'run' | 'skip' | 'edit'; note?: string };
type Waiter = (a: PlanAnswer | null) => void;

const g = globalThis as { __ccPlanWaiters?: Map<string, Waiter> };
const waiters = (): Map<string, Waiter> => (g.__ccPlanWaiters ??= new Map());

/** Wait for the answer to `planId`: null after `timeoutMs` or on abort. */
export function waitForPlan(planId: string, o: { timeoutMs: number; signal?: AbortSignal }): Promise<PlanAnswer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (a: PlanAnswer | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
      if (waiters().get(planId) === finish) waiters().delete(planId);
      resolve(a);
    };
    const onAbort = () => finish(null);
    const t = setTimeout(() => finish(null), Math.max(0, o.timeoutMs));
    t.unref?.();
    if (o.signal?.aborted) return finish(null);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    waiters().set(planId, finish);
  });
}

/** Hand the answer to the turn waiting on `planId`; false when none waits here (the turn ended or moved on). */
export function deliverPlanAnswer(planId: string, a: PlanAnswer): boolean {
  const w = waiters().get(planId);
  if (!w) return false;
  w(a);
  return true;
}

export const isPlanWaiting = (planId: string) => waiters().has(planId);
