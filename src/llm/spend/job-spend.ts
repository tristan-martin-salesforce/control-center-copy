/**
 * A background job's spend envelope (caps audit 26 F-4, D-80, H-5): the jobs that were capped by a fixed number (read-in,
 * Find assets, the brief, the completion judge, the relink, FTI, the use-case confirm) go through the governor instead.
 *
 *   start    the job's hold: the one the worker's start gate took for it (`<kind>:<id>`, src/llm/spend/day-gate.ts),
 *            else one taken here; a continuation resumes the hold it carries (`payload.vars.spendHoldId`)
 *   run      the paid loop reports its spend after every call (`gate.observe`); past the hold it stops at the next
 *            safe point and raises a hand (`gate.ask`: one SPEND.ASK, Health ▸ Spend)
 *   pause    the job queues its continuation carrying the hold (`spendContinuation`): Allow $Z more or Allow for
 *            today runs it at once (requeueSpendJob), Stop cancels it (cancelSpendJob); unanswered, it looks again
 *   finish   a hold this module took settles with what it spent; the start gate's settles in the worker; an asked
 *            one waits for its answer
 *
 * The user budgets above (the daily hard cap, a feature's own day line) stay. Per-call and per-run SDK budgets become
 * the runaway guard (`gate.ceilingUsd()`: 4× the hold), never the line a run fails at. Ids and amounts only.
 */
import type { SpendGovernor } from './governor';
import { holdGate, type SpendGate } from './scan-gate';
import type { Hold, SpendScope } from './types';

/** Where a continuation carries its hold (the answer route finds the queued job by it). */
export const SPEND_HOLD_VAR = 'spendHoldId';
/** A continuation waiting on an unanswered ask looks again after this long (the answer runs it at once). */
export const SPEND_ASK_RECHECK_S = 6 * 3600;
/** Turns stop being a budget once the governor holds the money: a runaway guard only (as research, 62f5202). */
export const RUNAWAY_TURNS = 200;

export interface SpendJobRef {
  id: number | string;
  kind: string;
  payload?: Record<string, unknown> | null;
}

export type JobSpendStart =
  /** Run under `gate`. `owned`: this module took (or resumed) the hold and settles it in `finishJobSpend`. */
  | { kind: 'run'; gate: SpendGate; owned: boolean; resumed: boolean }
  /** No governor (tests, mock) or it could not answer: the job runs as before, under its own line. */
  | { kind: 'none' }
  /** A continuation whose ask is still unanswered. */
  | { kind: 'waiting'; hold: Hold }
  /** The user answered Stop. */
  | { kind: 'stopped'; hold: Hold }
  /** Today's hard cap has no room for the hold. */
  | { kind: 'day_budget' };

export function spendHoldIdOf(payload: Record<string, unknown> | null | undefined): string | null {
  const vars = payload?.vars;
  const id = vars && typeof vars === 'object' ? (vars as Record<string, unknown>)[SPEND_HOLD_VAR] : undefined;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The job's hold: resumed, the start gate's, or a new one. Never throws (a governor error runs the job as before).
 * `existingOnly`: never take a new one (`none` when there is no hold to run under: the relay guard then keeps its
 * per-lookup holds, src/jobs/handlers/relay-guard.ts).
 */
export async function startJobSpend(gov: SpendGovernor | null | undefined, job: SpendJobRef, o: { scope: SpendScope; skill?: string; model?: string; minCeilingUsd?: number; existingOnly?: boolean }): Promise<JobSpendStart> {
  if (!gov) return { kind: 'none' };
  const gateOf = (h: Hold) => holdGate(gov, h, o.minCeilingUsd != null ? { minCeilingUsd: o.minCeilingUsd } : {});
  try {
    const resumeId = spendHoldIdOf(job.payload);
    if (resumeId) {
      const h = await gov.store.getHold(resumeId);
      if (h?.state === 'asked') return { kind: 'waiting', hold: h };
      if (h?.state === 'denied') return { kind: 'stopped', hold: h };
      if (h && (h.state === 'approved' || h.state === 'open')) return { kind: 'run', gate: gateOf(h), owned: true, resumed: true };
      // settled or abandoned (a day went by): a fresh hold below
    }
    const jobKey = `${job.kind}:${job.id}`;
    const [started] = await gov.store.listHolds({ jobKey, states: ['open', 'approved'], limit: 1 });
    if (started) return { kind: 'run', gate: gateOf(started), owned: false, resumed: false };
    if (o.existingOnly) return { kind: 'none' };
    const spendJob = { scope: o.scope, jobKey, ...(o.skill ? { skill: o.skill } : {}), ...(o.model ? { model: o.model } : {}) };
    const r = await gov.hold(spendJob, await gov.estimate(spendJob));
    if (!r.ok) return { kind: 'day_budget' };
    return { kind: 'run', gate: gateOf(r.hold), owned: true, resumed: false };
  } catch {
    return { kind: 'none' };
  }
}

/** The gate of a started envelope (null: run under the job's own line). */
export const gateOf = (s: JobSpendStart): SpendGate | null => (s.kind === 'run' ? s.gate : null);

/** Did the run raise its hand (the hold now waits as asked)? */
export const askedOf = (s: JobSpendStart): boolean => s.kind === 'run' && s.gate.hold.state === 'asked';

/** After the paid loop: an owned hold settles with what it spent; an asked one waits; the start gate settles its own. */
export async function finishJobSpend(gov: SpendGovernor | null | undefined, s: JobSpendStart, spentUsd?: number): Promise<void> {
  if (!gov || s.kind !== 'run' || s.gate.hold.state === 'asked' || !s.owned) return;
  await gov.settle(s.gate.hold, spentUsd ?? s.gate.hold.spentUsd).catch(() => undefined);
}

/**
 * The continuation of a job that raised its hand (or is still waiting): the same kind, queue and payload, carrying
 * the hold, run when the user answers (requeueSpendJob brings `run_at` forward) or after `SPEND_ASK_RECHECK_S`.
 */
export function spendContinuation(job: { kind: string; queue: string; payload?: Record<string, unknown> | null; maxAttempts?: number; timeoutSeconds?: number }, hold: Pick<Hold, 'id'>, o: { dedupeKey?: string; delaySeconds?: number } = {}) {
  const payload = job.payload ?? {};
  const vars = payload.vars && typeof payload.vars === 'object' ? (payload.vars as Record<string, unknown>) : {};
  return {
    kind: job.kind,
    queue: job.queue,
    payload: { ...payload, vars: { ...vars, [SPEND_HOLD_VAR]: hold.id } },
    dedupeKey: o.dedupeKey ?? `${job.kind}:spend:${hold.id}`,
    delaySeconds: o.delaySeconds ?? SPEND_ASK_RECHECK_S,
    ...(job.maxAttempts ? { maxAttempts: job.maxAttempts } : {}),
    ...(job.timeoutSeconds ? { timeoutSeconds: job.timeoutSeconds } : {}),
  };
}
