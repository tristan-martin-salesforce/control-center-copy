/**
 * D6 (audit 2026-11-13), spend governor (H-5, 2026-11-20), one hold per relay job (post-relay-holds, 2026-11-21): the
 * pre-call guard of the relay jobs (`vdp.specialist_aes`, `accounts.hierarchy`, `org62.readback`, `org62.discover`).
 * Each lookup is a small model run that relays one read-only call.
 *
 *   job hold   the worker's start gate holds the job's estimate before it starts (`<kind>:<id>`, LLM_JOB_KINDS: p90 of
 *              the skill's measured jobs, the static table before 10 samples), and a continuation carries its hold
 *              (`vars.spendHoldId`). Every lookup books its cost into that hold (tick, from llm_calls by job id) and
 *              takes none of its own, so the hold records report the job's spend once. Between lookups (the safe
 *              point: a relay is one call, nothing to stop inside it) a hold the spend has passed raises a hand once
 *              (one SPEND.ASK, the governor's plain words); the job keeps what it read and `finish` queues its
 *              continuation on the same hold (Allow runs it, Stop cancels it). The gate settles its own hold; one this
 *              guard resumed settles in `finish`.
 *   fallback   no job hold (a direct call with no start gate, a test): every lookup holds its estimate against today's
 *              budget while it runs (hold → call → book → settle), as before, and a lookup the day can't fit is
 *              recorded as a decision (block `hard_cap_reserve`), so the job stops cleanly.
 *   resume     a continuation resumes by position (`vars.relayDone`): the lookups done in order from the leg's start.
 *              A lookup counts only once `fn` returns, and after one throws the count stops for the rest of the leg,
 *              so a continuation starts at the failed lookup and reads it again (P33-3). The cost: lookups after the
 *              failure that did return are read once more on the continuation (re-reads are idempotent; a skipped
 *              batch would wait for the next scheduled run).
 */
import { startJobSpend, type JobSpendStart, type SpendGovernor } from '@/llm/spend';
import { dbSpendGovernor, type DbSpendStore } from '@/server/datasource/db/spend';
import { DbScannerStore } from '@/scanner/store-db';

import { spendPauseResult, spendStartResult } from '../spend-pause';
import type { JobContext } from '../types';

/** The relay skills' own per-run ceiling (skills/read-lookup.md, skills/org62-readback.md: budget_usd_per_run). */
export const RELAY_LOOKUP_CAP_USD = 0.03;

/** Where a continuation carries the lookups its earlier legs ran (a handler that resumes by position reads it). */
export const RELAY_DONE_VAR = 'relayDone';

export interface RelayGuard {
  /** Run one lookup (and book its spend, inside `fn`); `null` when it did not run (`stop` says why). */
  run<T>(fn: () => Promise<T>, at?: { pctDone?: number | null }): Promise<T | null>;
  /** Lookups the daily hard cap refused so far (the fallback path). */
  refused: number;
  /** Why the last `run` returned null: the day's hard cap refused it, or the job passed its hold and asked. */
  stop?: 'hard_cap' | 'spend' | null;
  /** Lookups earlier legs of this job ran (`vars.relayDone` of a continuation; 0 on a first run). */
  resumeAt?: number;
  /** Before the first lookup: the job's result when its hold says wait (an unanswered ask) or Stop; else null. */
  start?(): Promise<Record<string, unknown> | null>;
  /**
   * After the loop (and on the way out of a throw): settle a hold this guard resumed; when the job asked, queue its
   * continuation (`payload` merged into it) and return the result fields that say so. Runs once.
   */
  finish?(o?: { payload?: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

const varsOf = (payload: Record<string, unknown> | null | undefined): Record<string, unknown> => (payload?.vars && typeof payload.vars === 'object' ? (payload.vars as Record<string, unknown>) : {});

const relayDoneOf = (payload: Record<string, unknown> | null | undefined): number => {
  const n = varsOf(payload)[RELAY_DONE_VAR];
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function relayGuard(
  ctx: JobContext,
  skill: string,
  o: { capUsd?: number; store?: Pick<DbScannerStore, 'reserveSpend' | 'recordDecision'>; spend?: SpendGovernor } = {},
): RelayGuard {
  const store = o.store ?? new DbScannerStore({ db: ctx.db, userId: ctx.userId, clock: ctx.clock });
  const trigger = typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'schedule';
  // A test that hands in its own store keeps the reservation path; the app goes through the governor.
  const gov = o.spend ?? (o.store ? null : dbSpendGovernor({ db: ctx.db, userId: ctx.userId, clock: ctx.clock }));
  const booked = async (): Promise<number | null> => {
    const s = gov?.store as Partial<DbSpendStore> | undefined;
    return s?.jobSpend && ctx.job.id != null ? s.jobSpend(ctx.job.id).catch(() => null) : null;
  };
  // the job's hold (the start gate's, or the one a continuation carries); never a new one
  let envelope: Promise<JobSpendStart | null> | null = null;
  const jobHold = (): Promise<JobSpendStart | null> =>
    (envelope ??=
      gov && ctx.job.id != null
        ? startJobSpend(gov, { id: ctx.job.id, kind: ctx.job.kind, payload: ctx.job.payload }, { scope: 'relay', skill, existingOnly: true }).then((s) => (s.kind === 'none' || s.kind === 'day_budget' ? null : s))
        : Promise.resolve(null));
  let lookups = 0;
  /** A lookup threw on this leg: the count stops there (resume by position starts at the failed one). */
  let broken = false;
  let finished = false;
  const counted = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const r = await fn();
      if (!broken) lookups += 1;
      return r;
    } catch (e) {
      broken = true;
      throw e;
    }
  };

  const g: RelayGuard = {
    refused: 0,
    stop: null,
    resumeAt: relayDoneOf(ctx.job.payload),
    async start() {
      const s = await jobHold();
      return s ? spendStartResult(ctx, s) : null;
    },
    async finish(f = {}) {
      if (finished) return {};
      finished = true;
      const s = await jobHold();
      if (!gov || !s || s.kind !== 'run') return {};
      if (s.gate.hold.state === 'asked') {
        const vars = { ...varsOf(ctx.job.payload), ...varsOf(f.payload), [RELAY_DONE_VAR]: (g.resumeAt ?? 0) + lookups };
        return spendPauseResult(ctx, s, { payload: { ...(f.payload ?? {}), vars } });
      }
      if (s.owned) await gov.settle(s.gate.hold, s.gate.hold.spentUsd).catch(() => undefined);
      return {};
    },
    async run(fn, at = {}) {
      g.stop = null;
      const s = gov ? await jobHold() : null;
      if (gov && s) {
        if (s.kind !== 'run') {
          g.stop = 'spend';
          return null;
        }
        const hold = s.gate.hold;
        // the safe point: past the hold, raise a hand once and run nothing more on this leg
        if (hold.state === 'asked' || gov.exceeded(hold) === 'ask') {
          if (hold.state !== 'asked') await s.gate.ask({ pctDone: at.pctDone ?? null }).catch(() => undefined);
          g.stop = 'spend';
          return null;
        }
        const before = await booked();
        try {
          return await counted(fn);
        } finally {
          const after = await booked();
          if (before != null && after != null) gov.tick(hold, Math.max(0, after - before));
        }
      }
      if (gov) {
        const job = { scope: 'relay' as const, jobKey: `${ctx.job.kind}:${ctx.job.id ?? 'none'}`, skill };
        const est = await gov.estimate(job);
        const h = await gov.hold(job, est).catch(() => null);
        if (h && !h.ok) {
          g.refused += 1;
          g.stop = 'hard_cap';
          await store.recordDecision({ skill, kind: 'block', reason: 'hard_cap_reserve', trigger, detail: { jobId: ctx.job.id ?? null, spentUsd: h.day.spentUsd, heldUsd: h.day.heldUsd, capUsd: h.day.hardUsd } });
          return null;
        }
        const before = await booked();
        try {
          return await counted(fn);
        } finally {
          if (h?.ok) {
            const after = await booked();
            await gov.settle(h.hold, before != null && after != null ? Math.max(0, after - before) : undefined).catch(() => undefined);
          }
        }
      }
      const hold = await store.reserveSpend(o.capUsd ?? RELAY_LOOKUP_CAP_USD).catch(() => null);
      if (hold && !hold.ok) {
        g.refused += 1;
        g.stop = 'hard_cap';
        await store.recordDecision({ skill, kind: 'block', reason: 'hard_cap_reserve', trigger, detail: { jobId: ctx.job.id ?? null, spentUsd: hold.spentUsd, heldUsd: hold.reservedUsd, capUsd: hold.hardCapUsd } });
        return null;
      }
      try {
        return await counted(fn);
      } finally {
        await hold?.release();
      }
    },
  };
  return g;
}
