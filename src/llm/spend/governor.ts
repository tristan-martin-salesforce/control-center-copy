/**
 * The spend governor (holistic review 2026-11-20: 04 §4.3 and #7, 05 §6, H-5). Every LLM caller goes through it:
 *
 *   estimate(job)        p50 / p90 from llm_calls (same skill and model, 14 days); the static table under 10 samples
 *   hold(job, estimate)  holds p90 (or the user's budget for the unit: one Assistant message) against today's budget;
 *                        refused only when the daily hard cap would be passed (a user budget: the runaway guard)
 *   tick(hold, usd)      after every model request, with its actual cost
 *   exceeded(hold)       'ask' once the hold is passed, else 'continue'. Ask means: pause at the next safe point and
 *                        raise a question to the user. Never fail, never kill.
 *   ask / answer         "This scan has used $X of its $Y estimate and is N% done; allow $Z more?" → Allow $Z more,
 *                        Allow for today, or Stop (settled as denied; partial results stay)
 *   settle(hold, actual) writes the outcome and releases what the hold still held
 *
 * Tenet *Suggest, then learn* and the owner's rule: a limit exists only for a real external limit, a user budget or
 * safety; otherwise estimate, warn, pause and continue. Amounts, ids and states only; never content.
 */
import { defaultEstimate } from './defaults';
import { LIVE_HOLD_STATES, type DayStatus, type Estimate, type Hold, type SpendAnswer, type SpendJob, type SpendScope, type SpendStore } from './types';

/** Fewer measured samples than this and the static table answers. */
export const MIN_SAMPLES = 10;
export const HISTORY_DAYS = 14;
/** An open hold no one settled (a crash, a lost worker) is abandoned after this long; an unanswered ask after a day. */
export const ABANDON_OPEN_MS = 6 * 3600_000;
export const ABANDON_ASKED_MS = 24 * 3600_000;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const upCents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;
export const fmtUsd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

/** Linear-interpolated quantile of ascending `sorted` (q in 0..1). */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** p50 / p90 of measured samples, or the fallback when there are fewer than MIN_SAMPLES. */
export function estimateFromSamples(samples: readonly number[], fallback: Estimate, scale = 1): Estimate {
  const xs = samples.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (xs.length < MIN_SAMPLES) return fallback;
  const p50 = quantile(xs, 0.5) * scale;
  const p90 = Math.max(p50, quantile(xs, 0.9) * scale);
  return { p50: round6(p50), p90: round6(p90), basis: 'history', n: xs.length };
}

/**
 * What a hold holds: the user's budget for the unit when there is one (an Assistant message: its per-message budget,
 * plus a one-time "Allow more"), else p90 (never the worst case: holding caps starved parallel scopes, COST-7).
 */
export function holdAmount(est: Pick<Estimate, 'p90'>, budgetUsd?: number | null): number {
  if (budgetUsd != null && budgetUsd > 0) return round6(budgetUsd);
  return round6(Math.max(0.0001, est.p90));
}

/** 'ask' once the spend passes the hold. A hold allowed for today never asks again; a stopped one always asks. */
export function exceededOf(h: Pick<Hold, 'spentUsd' | 'heldUsd' | 'state' | 'answerUsd'>): 'ask' | 'continue' {
  if (h.state === 'denied') return 'ask';
  if (h.state === 'approved' && h.answerUsd === null) return 'continue';
  return h.spentUsd > h.heldUsd + 1e-9 ? 'ask' : 'continue';
}

/** The "Allow $Z more" an ask offers: half the hold or the p50→p90 spread, whichever is more, in whole cents. */
export function askMoreUsd(h: Pick<Hold, 'heldUsd' | 'estimate'>): number {
  return upCents(Math.max(0.01, h.heldUsd * 0.5, h.estimate.p90 - h.estimate.p50));
}

const SCOPE_NOUN: Record<SpendScope, string> = {
  scan_run: 'scan',
  chat_message: 'answer',
  settle_pass: 'settle pass',
  relay: 'lookup',
  research: 'research run',
  feedback: 'diagnose run',
  job: 'job',
};

/** The plain question (docs/UX.md, Spend asks). `pctDone` null when the run can't tell how far it got. */
export function askQuestion(h: Pick<Hold, 'scope' | 'spentUsd' | 'heldUsd' | 'estimate'> & { jobKey?: string }, pctDone: number | null, moreUsd: number): string {
  // W12-1: the scanner's day-cap ask is about the day, not one run's estimate
  if (h.jobKey?.startsWith(SCAN_DAY_BUDGET_PREFIX)) return `Scans that use the model paused at today's spend cap; allow ${fmtUsd(moreUsd)} more, or allow them for today?`;
  const what = SCOPE_NOUN[h.scope];
  const done = pctDone == null ? '' : ` and is ${Math.round(Math.min(100, Math.max(0, pctDone)))}% done`;
  // an Assistant message holds the per-message limit you set; everything else holds its estimate
  const line = h.scope === 'chat_message' ? 'limit' : 'estimate';
  return `This ${what} has used ${fmtUsd(h.spentUsd)} of its ${fmtUsd(h.heldUsd)} ${line}${done}; allow ${fmtUsd(moreUsd)} more?`;
}

/** Would holding `wantUsd` more pass today's hard cap? (booked spend + what live holds still hold + the new hold.) */
export function dayHeadroom(d: Pick<DayStatus, 'spentUsd' | 'heldUsd' | 'hardUsd'>, wantUsd: number): { ok: boolean; afterUsd: number; leftUsd: number } {
  const afterUsd = round6(d.spentUsd + d.heldUsd + wantUsd);
  return { ok: afterUsd <= d.hardUsd + 1e-9, afterUsd, leftUsd: round6(Math.max(0, d.hardUsd - d.spentUsd - d.heldUsd)) };
}

/** Job key prefix of the scanner's day-cap ask (one per pause): `scan:day_budget:<day>:<n>`. */
export const SCAN_DAY_BUDGET_PREFIX = 'scan:day_budget:';

export type HoldResult = { ok: true; hold: Hold } | { ok: false; reason: 'day_budget'; day: DayStatus; wantUsd: number };

export interface AskResult {
  hold: Hold;
  question: string;
  moreUsd: number;
}

export class SpendGovernor {
  constructor(readonly store: SpendStore) {}

  /** p50 / p90 for a job: its skill's measured runs (per item × items when it scales), else the static table. */
  async estimate(job: SpendJob): Promise<Estimate> {
    const fallback = defaultEstimate(job.scope, job.skill, job.items);
    const perItem = job.items != null && job.items > 0 && fallback.p50 > 0 && job.scope === 'settle_pass';
    const samples = await this.store.costSamples({ scope: job.scope, ...(job.skill ? { skill: job.skill } : {}), ...(job.model ? { model: job.model } : {}), sinceDays: HISTORY_DAYS, perItem }).catch(() => [] as number[]);
    return estimateFromSamples(samples, fallback, perItem ? job.items! : 1);
  }

  /**
   * Hold the estimate (or `budgetUsd`) for a job. A daily hold is refused only when it would pass today's hard cap:
   * the caller then declines to start (the worker writes one SPEND.DAY_BUDGET event). First-scan holds count on the
   * first scan's own envelope, never on the day.
   */
  async hold(job: SpendJob, est: Estimate, o: { budgetUsd?: number | null; skipDayCheck?: boolean } = {}): Promise<HoldResult> {
    const heldUsd = holdAmount(est, o.budgetUsd);
    const budget = job.budget ?? 'daily';
    if (budget === 'daily' && !o.skipDayCheck) {
      const day = await this.store.dayStatus();
      if (!dayHeadroom(day, heldUsd).ok) return { ok: false, reason: 'day_budget', day, wantUsd: heldUsd };
    }
    const hold = await this.store.insertHold({ scope: job.scope, jobKey: job.jobKey, estimate: est, heldUsd, spentUsd: 0, state: 'open', budget, budgetDay: await this.store.today() });
    return { ok: true, hold };
  }

  /** After every request: add its actual cost (in memory; ask and settle persist it). Returns what to do next. */
  tick(hold: Hold, usd: number, callId?: string): 'ask' | 'continue' {
    if (Number.isFinite(usd) && usd > 0) hold.spentUsd = round6(hold.spentUsd + usd);
    if (callId && !hold.callIds.includes(callId)) hold.callIds.push(callId);
    return this.exceeded(hold);
  }

  /** Set the running total (callers that meter cumulatively, like the SDK's per-message usage). */
  observe(hold: Hold, spentUsd: number): 'ask' | 'continue' {
    if (Number.isFinite(spentUsd) && spentUsd > hold.spentUsd) hold.spentUsd = round6(spentUsd);
    return this.exceeded(hold);
  }

  exceeded(hold: Hold): 'ask' | 'continue' {
    return exceededOf(hold);
  }

  /** Raise a hand: the hold waits as `asked`, with one SPEND.ASK event (Health's needs-you list, the Assistant card). */
  async ask(hold: Hold, o: { pctDone?: number | null } = {}): Promise<AskResult> {
    const moreUsd = askMoreUsd(hold);
    const question = askQuestion(hold, o.pctDone ?? null, moreUsd);
    const at = this.store.now().toISOString();
    const saved = (await this.store.updateHold(hold.id, { state: 'asked', askedAt: at, spentUsd: hold.spentUsd, callIds: hold.callIds })) ?? { ...hold, state: 'asked' as const, askedAt: at };
    Object.assign(hold, saved);
    await this.store
      .recordEvent({
        code: 'SPEND.ASK',
        message: question,
        fingerprint: askFingerprint(hold.id),
        severity: 'warn',
        detail: { holdId: hold.id, scope: hold.scope, jobKey: hold.jobKey, spentUsd: hold.spentUsd, heldUsd: hold.heldUsd, moreUsd, pctDone: o.pctDone ?? null, question },
      })
      .catch(() => undefined);
    return { hold, question, moreUsd };
  }

  /**
   * The user's answer. Allow $Z more: the hold grows by Z and the run continues (or is re-queued). Allow for today:
   * no more asks on this hold today, and today's hard cap moves up by the hold when the day has no room for it.
   * Stop: settled as denied; what the run already did stays.
   */
  async answer(holdId: string, a: SpendAnswer): Promise<Hold | null> {
    const cur = await this.store.getHold(holdId);
    if (!cur) return null;
    if (!LIVE_HOLD_STATES.has(cur.state)) return cur;
    const at = this.store.now().toISOString();
    let next: Hold | null;
    if (a.kind === 'approve') {
      const usd = round6(Math.max(0.01, a.usd));
      next = await this.store.updateHold(holdId, { state: 'approved', answeredAt: at, answerUsd: usd, addHeldUsd: usd });
    } else if (a.kind === 'today') {
      const day = await this.store.dayStatus();
      if (!dayHeadroom(day, 0).ok || day.hardUsd - day.spentUsd - day.heldUsd < cur.heldUsd) await this.store.raiseToday?.(upCents(Math.max(0.01, cur.heldUsd)), 'Allowed for today from a spend ask').catch(() => undefined);
      next = await this.store.updateHold(holdId, { state: 'approved', answeredAt: at, answerUsd: null });
    } else {
      next = await this.store.updateHold(holdId, { state: 'denied', answeredAt: at, settledAt: at });
    }
    await this.store.resolveEvent(askFingerprint(holdId)).catch(() => undefined);
    return next;
  }

  /**
   * W12-1: a caller that pauses at the day cap instead of declining one job (the scanner's traversal scopes). The hold
   * is refused (`day_budget`), one SPEND.DAY_BUDGET event says so (the day gate's fingerprint), and the hand is raised
   * as an asked hold, so Health offers Allow $Z more · Allow for today (`raiseToday`) · Stop. No SPEND.ASK event: the
   * day event is the one event. Returns the asked hold and the day it was refused on.
   */
  async askDayBudget(job: SpendJob, est: Estimate, message: (d: DayStatus) => string, detail: Record<string, unknown> = {}): Promise<{ hold: Hold; day: DayStatus }> {
    const r = await this.hold(job, est);
    const day = r.ok ? await this.store.dayStatus() : r.day;
    const hold = r.ok ? r.hold : ((await this.hold(job, est, { skipDayCheck: true })) as { ok: true; hold: Hold }).hold;
    const at = this.store.now().toISOString();
    Object.assign(hold, (await this.store.updateHold(hold.id, { state: 'asked', askedAt: at })) ?? { state: 'asked', askedAt: at });
    await this.store
      .recordEvent({ code: 'SPEND.DAY_BUDGET', message: message(day), fingerprint: dayBudgetFingerprint(day.day), severity: 'warn', detail: { day: day.day, spentUsd: day.spentUsd, heldUsd: day.heldUsd, hardUsd: day.hardUsd, wantUsd: r.ok ? hold.heldUsd : r.wantUsd, holdId: hold.id, ...detail } })
      .catch(() => undefined);
    return { hold, day };
  }

  /** Write the outcome and release what the hold still held. A stopped (denied) hold stays denied. */
  async settle(hold: Hold, actualUsd?: number, state: 'settled' | 'abandoned' = 'settled'): Promise<Hold> {
    const spentUsd = round6(actualUsd != null && Number.isFinite(actualUsd) ? Math.max(0, actualUsd) : hold.spentUsd);
    const cur = await this.store.getHold(hold.id);
    const final = cur?.state === 'denied' ? 'denied' : state;
    const saved = await this.store.updateHold(hold.id, { spentUsd, state: final, settledAt: cur?.settledAt ?? this.store.now().toISOString(), callIds: hold.callIds });
    if (cur?.state === 'asked') await this.store.resolveEvent(askFingerprint(hold.id)).catch(() => undefined);
    Object.assign(hold, saved ?? { spentUsd, state: final });
    return hold;
  }

  /** Holds nobody settled (a crash, a lost worker): open ones after 6 h, unanswered asks after a day. */
  async sweep(): Promise<number> {
    const now = this.store.now().getTime();
    // every live hold: one left out would keep holding money against the day (caps audit 2026-11-21)
    const live = await this.store.listHolds({ states: ['open', 'approved', 'asked'] });
    let n = 0;
    for (const h of live) {
      const age = now - Date.parse(h.askedAt ?? h.createdAt);
      if (age < (h.state === 'asked' ? ABANDON_ASKED_MS : ABANDON_OPEN_MS)) continue;
      await this.settle(h, undefined, 'abandoned');
      n += 1;
    }
    return n;
  }
}

export const askFingerprint = (holdId: string) => `spend.ask|${holdId}`;
export const dayBudgetFingerprint = (day: string) => `spend.day_budget|${day}`;
