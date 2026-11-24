/**
 * The spend governor on Postgres (src/llm/spend; holistic review 2026-11-20, H-5). Holds live in `spend_holds`
 * (0030). A daily hold also holds its amount in today's `llm_budget_days.reserved_usd`, the same in-flight meter every
 * older reservation uses (reserveBudget, D6), so one day total covers every scope; leaving the live states releases it.
 * Samples come from `llm_calls` (14 days, same skill and model). Events are `app_events` rows with a fingerprint, so a
 * repeat bumps one row. Amounts, ids and states only; never content.
 */
import { sql } from 'drizzle-orm';

import type { SpendHoldsPayload } from '@/contract';
import type { DbOrTx } from '@/db/client';
import { backgroundDayDefault, estimateFirstScan, FIRST_SCAN_SOURCE_DAY_USD, gateJobStart, LIVE_HOLD_STATES, quantile, SpendGovernor, type DayStatus, type Hold, type HoldState, type SpendEvent, type SpendScope, type SpendStore } from '@/llm/spend';
import { DbScannerStore, localDay } from '@/scanner/store-db';

type HoldRow = {
  id: string;
  scope: string;
  job_key: string;
  estimate_p50: string | number;
  estimate_p90: string | number;
  estimate_basis: string;
  held_usd: string | number;
  spent_usd: string | number;
  state: string;
  asked_at: string | Date | null;
  answered_at: string | Date | null;
  answer_usd: string | number | null;
  budget_day: string;
  budget: string;
  created_at: string | Date;
  settled_at: string | Date | null;
  call_ids: string[] | null;
};

/** A Postgres text[] literal for ids (drizzle would spread a JS array into a value list). */
const textArray = (xs: readonly string[]): string => `{${xs.map((x) => `"${String(x).replace(/["\\]/g, '')}"`).join(',')}}`;

const iso = (v: string | Date | null): string | null => (v == null ? null : new Date(v).toISOString());
const num = (v: string | number | null): number => Number(v ?? 0);
const dayOf = (v: string | Date): string => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));

function holdOf(r: HoldRow): Hold {
  return {
    id: r.id,
    scope: r.scope as SpendScope,
    jobKey: r.job_key,
    estimate: { p50: num(r.estimate_p50), p90: num(r.estimate_p90), basis: r.estimate_basis === 'history' ? 'history' : 'default', n: 0 },
    heldUsd: num(r.held_usd),
    spentUsd: num(r.spent_usd),
    state: r.state as HoldState,
    budget: r.budget === 'first_scan' ? 'first_scan' : 'daily',
    budgetDay: dayOf(r.budget_day),
    askedAt: iso(r.asked_at),
    answeredAt: iso(r.answered_at),
    answerUsd: r.answer_usd == null ? null : num(r.answer_usd),
    createdAt: iso(r.created_at)!,
    settledAt: iso(r.settled_at),
    callIds: r.call_ids ?? [],
  };
}

export interface DbSpendStoreOptions {
  db: DbOrTx;
  userId: string;
  clock?: () => Date;
  /** "Allow for today": raise today's hard cap (the DataSource's raiseBudgetToday, so it is audited like any raise). */
  raiseToday?: (addUsd: number, reason: string) => Promise<void>;
}

export class DbSpendStore implements SpendStore {
  private readonly scanner: DbScannerStore;
  private tz: string | null = null;
  constructor(private readonly o: DbSpendStoreOptions) {
    this.scanner = new DbScannerStore({ db: o.db as never, userId: o.userId, ...(o.clock ? { clock: o.clock } : {}) });
  }

  now(): Date {
    return this.o.clock?.() ?? new Date();
  }

  private async timezone(): Promise<string> {
    if (this.tz) return this.tz;
    const r = await this.o.db.execute<{ tz: string | null }>(sql`
      select coalesce((select s.value->>'timezone' from user_settings s where s.owner_user_id = u.id and s.key in ('settings.profile', 'profile') order by (s.key = 'settings.profile') desc limit 1), u.timezone) as tz
        from users u where u.id = ${this.o.userId}`);
    this.tz = r.rows[0]?.tz || 'America/Denver';
    return this.tz;
  }

  async today(): Promise<string> {
    return localDay(this.now(), await this.timezone());
  }

  async costSamples(q: { scope: SpendScope; skill?: string; model?: string; sinceDays: number; perItem?: boolean }): Promise<number[]> {
    const since = new Date(this.now().getTime() - q.sinceDays * 86_400_000).toISOString();
    const { db, userId } = this.o;
    const model = q.model ? sql`and c.model = ${q.model}` : sql``;
    if (q.scope === 'scan_run') {
      // One sample per scan run: every pass of the run (traversal, triage, escalation), for runs of this skill.
      const r = await db.execute<{ usd: string }>(sql`
        select sum(c.cost_usd)::text as usd from llm_calls c
         where c.owner_user_id = ${userId} and c.started_at >= ${since}::timestamptz and c.scan_run_id is not null
           and c.scan_run_id in (select x.scan_run_id from llm_calls x where x.owner_user_id = ${userId} and x.started_at >= ${since}::timestamptz
                                   and x.scan_run_id is not null ${q.skill ? sql`and x.skill_key = ${q.skill}` : sql``} ${q.model ? sql`and x.model = ${q.model}` : sql``})
         group by c.scan_run_id order by max(c.started_at) desc limit 500`);
      return r.rows.map((x) => Number(x.usd));
    }
    if (q.perItem) {
      // Per item: one call is one item (settle judges one item a call).
      const r = await db.execute<{ usd: string }>(sql`
        select c.cost_usd::text as usd from llm_calls c
         where c.owner_user_id = ${userId} and c.started_at >= ${since}::timestamptz ${q.skill ? sql`and c.skill_key = ${q.skill}` : sql``} ${model}
         order by c.started_at desc limit 500`);
      return r.rows.map((x) => Number(x.usd));
    }
    // One sample per job (several calls of one job are one run), else per call (a chat message is one row).
    const r = await db.execute<{ usd: string }>(sql`
      select sum(c.cost_usd)::text as usd from llm_calls c
       where c.owner_user_id = ${userId} and c.started_at >= ${since}::timestamptz ${q.skill ? sql`and c.skill_key = ${q.skill}` : sql``} ${model}
       group by coalesce(c.job_id::text, c.chat_message_id::text, c.id::text) order by max(c.started_at) desc limit 500`);
    return r.rows.map((x) => Number(x.usd));
  }

  /** Today's `llm_budget_days` row for the user's total budget (created when missing); null without a budget row. */
  private async budgetId(tx: DbOrTx): Promise<string | null> {
    const r = await tx.execute<{ id: string }>(sql`select id from llm_budgets where owner_user_id = ${this.o.userId} and scope = 'total' limit 1`);
    return r.rows[0]?.id ?? null;
  }

  private async moveReserved(tx: DbOrTx, day: string, deltaUsd: number): Promise<void> {
    if (!deltaUsd) return;
    const bid = await this.budgetId(tx);
    if (!bid) return;
    await tx.execute(sql`insert into llm_budget_days (budget_id, day) values (${bid}::uuid, ${day}::date) on conflict (budget_id, day) do nothing`);
    await tx.execute(sql`update llm_budget_days set reserved_usd = greatest(0, reserved_usd + ${deltaUsd}), updated_at = now() where budget_id = ${bid}::uuid and day = ${day}::date`);
  }

  async insertHold(h: Parameters<SpendStore['insertHold']>[0]): Promise<Hold> {
    const r = await this.o.db.execute<HoldRow>(sql`
      insert into spend_holds (scope, job_key, user_id, estimate_p50, estimate_p90, estimate_basis, held_usd, spent_usd, state, budget_day, budget, call_ids)
      values (${h.scope}, ${h.jobKey}, ${this.o.userId}, ${h.estimate.p50}, ${h.estimate.p90}, ${h.estimate.basis}, ${h.heldUsd}, ${h.spentUsd}, ${h.state},
              ${h.budgetDay}::date, ${h.budget}, ${textArray(h.callIds ?? [])}::text[])
      returning *`);
    if (h.budget === 'daily' && LIVE_HOLD_STATES.has(h.state)) await this.moveReserved(this.o.db, h.budgetDay, h.heldUsd);
    const out = holdOf(r.rows[0]!);
    out.estimate.n = h.estimate.n;
    return out;
  }

  async getHold(id: string): Promise<Hold | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.o.db.execute<HoldRow>(sql`select * from spend_holds where id = ${id}::uuid and user_id = ${this.o.userId}`);
    return r.rows[0] ? holdOf(r.rows[0]) : null;
  }

  async updateHold(id: string, patch: Parameters<SpendStore['updateHold']>[1]): Promise<Hold | null> {
    const cur = await this.getHold(id);
    if (!cur) return null;
    const add = patch.addHeldUsd ?? 0;
    const r = await this.o.db.execute<HoldRow>(sql`
      update spend_holds set
        spent_usd = coalesce(${patch.spentUsd ?? null}::numeric, spent_usd),
        state = coalesce(${patch.state ?? null}, state),
        asked_at = coalesce(${patch.askedAt ?? null}::timestamptz, asked_at),
        answered_at = coalesce(${patch.answeredAt ?? null}::timestamptz, answered_at),
        answer_usd = ${'answerUsd' in patch ? sql`${patch.answerUsd ?? null}::numeric` : sql`answer_usd`},
        settled_at = coalesce(${patch.settledAt ?? null}::timestamptz, settled_at),
        call_ids = coalesce(${patch.callIds ? textArray(patch.callIds) : null}::text[], call_ids),
        held_usd = held_usd + ${add}
       where id = ${id}::uuid and user_id = ${this.o.userId}
       returning *`);
    const next = r.rows[0] ? holdOf(r.rows[0]) : null;
    if (next && cur.budget === 'daily') {
      const wasLive = LIVE_HOLD_STATES.has(cur.state);
      const isLive = LIVE_HOLD_STATES.has(next.state);
      // A raise holds more; leaving the live states releases everything the hold held.
      const delta = wasLive && isLive ? add : wasLive && !isLive ? -cur.heldUsd : !wasLive && isLive ? next.heldUsd : 0;
      await this.moveReserved(this.o.db, cur.budgetDay, delta);
    }
    return next;
  }

  async listHolds(q: Parameters<SpendStore['listHolds']>[0]): Promise<Hold[]> {
    const r = await this.o.db.execute<HoldRow>(sql`
      select * from spend_holds where user_id = ${this.o.userId}
        ${q.since ? sql`and created_at >= ${q.since}::timestamptz` : sql``}
        ${q.states?.length ? sql`and state = any(${textArray(q.states)}::text[])` : sql``}
        ${q.scope ? sql`and scope = ${q.scope}` : sql``}
        ${q.jobKey ? sql`and job_key = ${q.jobKey}` : sql``}
        ${q.jobKeyPrefix ? sql`and starts_with(job_key, ${q.jobKeyPrefix})` : sql``}
       order by created_at desc ${q.limit != null ? sql`limit ${q.limit}` : sql``}`);
    return r.rows.map(holdOf);
  }

  async dayStatus(): Promise<DayStatus> {
    const day = await this.today();
    const b = await this.scanner.budgetStatus();
    const r = await this.o.db.execute<{ reserved: string | null; has_budget: boolean; holds: string | null }>(sql`
      select (select d.reserved_usd from llm_budget_days d join llm_budgets bb on bb.id = d.budget_id where bb.owner_user_id = ${this.o.userId} and bb.scope = 'total' and d.day = ${day}::date)::text as reserved,
             exists (select 1 from llm_budgets bb where bb.owner_user_id = ${this.o.userId} and bb.scope = 'total') as has_budget,
             (select coalesce(sum(held_usd), 0) from spend_holds where user_id = ${this.o.userId} and budget = 'daily' and budget_day = ${day}::date and state in ('open', 'asked', 'approved'))::text as holds`);
    const row = r.rows[0];
    // With a budget row, the reservation meter already holds every live hold (and every older reservation).
    const heldUsd = row?.has_budget ? Number(row.reserved ?? 0) : Number(row?.holds ?? 0);
    return { day, spentUsd: b.todayUsd, heldUsd: Math.round(heldUsd * 1e6) / 1e6, softUsd: b.softCapUsd, hardUsd: b.hardCapUsd };
  }

  async recordEvent(e: SpendEvent): Promise<void> {
    await this.o.db.execute(sql`
      insert into app_events (owner_user_id, severity, component, code, message, detail, fingerprint)
      values (${this.o.userId}, ${e.severity}, 'spend.governor', ${e.code}, ${e.message.slice(0, 500)}, ${JSON.stringify(e.detail)}::jsonb, ${`${this.o.userId}|${e.fingerprint}`})
      on conflict (fingerprint) where resolved_at is null
      do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), message = excluded.message, detail = excluded.detail`);
  }

  async resolveEvent(fingerprint: string): Promise<void> {
    await this.o.db.execute(sql`update app_events set resolved_at = now() where fingerprint = ${`${this.o.userId}|${fingerprint}`} and resolved_at is null`);
  }

  async raiseToday(addUsd: number, reason: string): Promise<void> {
    await this.o.raiseToday?.(addUsd, reason);
  }

  /** Booked spend of one job (llm_calls.job_id): what a job's hold settles with. */
  async jobSpend(jobId: number | string): Promise<number> {
    const r = await this.o.db.execute<{ usd: string | null }>(sql`select coalesce(sum(cost_usd), 0)::text as usd from llm_calls where owner_user_id = ${this.o.userId} and job_id = ${Number(jobId)}`);
    return Number(r.rows[0]?.usd ?? 0);
  }

  /** Per connector skill: $/day of daily scanning over 14 days (p50 / p90 / days), for the first-scan estimate. */
  async sourceDayCosts(): Promise<Record<string, { p50: number; p90: number; n: number }>> {
    const r = await this.o.db.execute<{ skill: string; days: string[] | null }>(sql`
      select skill_key as skill, array_agg(usd::text) as days from (
        select skill_key, budget_day, sum(cost_usd) as usd from llm_calls
         where owner_user_id = ${this.o.userId} and purpose = 'scan_extract' and budget = 'daily' and skill_key like 'scan-%'
           and budget_day >= (current_date - 14) group by skill_key, budget_day) d group by skill_key`);
    const out: Record<string, { p50: number; p90: number; n: number }> = {};
    for (const row of r.rows) {
      const xs = (row.days ?? []).map(Number).sort((a, b) => a - b);
      const source = row.skill.replace(/^scan-/, '').replace('gemini-notes', 'gemini').replace('claude-sessions', 'claude');
      out[source] = { p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), n: xs.length };
    }
    return out;
  }

  /** Health: a day of background scanning (p50 / p90 of the last 14 days), the table before 5 days. */
  async backgroundEstimate(): Promise<{ p50: number; p90: number; basis: 'history' | 'default'; heldUsd: number }> {
    const r = await this.o.db.execute<{ usd: string }>(sql`
      select sum(cost_usd)::text as usd from llm_calls where owner_user_id = ${this.o.userId} and purpose = 'scan_extract' and budget = 'daily'
         and budget_day >= (current_date - 14) and budget_day < current_date group by budget_day`);
    const day = await this.dayStatus().catch(() => null);
    const xs = r.rows.map((x) => Number(x.usd)).sort((a, b) => a - b);
    const cents = (n: number) => Math.round(n * 100) / 100;
    if (xs.length >= 5) return { p50: cents(quantile(xs, 0.5)), p90: cents(Math.max(quantile(xs, 0.5), quantile(xs, 0.9))), basis: 'history', heldUsd: day?.heldUsd ?? 0 };
    return { ...backgroundDayDefault(), heldUsd: day?.heldUsd ?? 0 };
  }
}

/**
 * A scan paused for spend waits as a queued job carrying its hold id (`vars.spendHoldId`, src/scanner/runtime). Allow
 * $Z more / Allow for today: run it now. Stop: cancel it (what the run already did stays).
 */
export async function requeueSpendJob(db: DbOrTx, userId: string, holdId: string): Promise<number> {
  const r = await db.execute(sql`update jobs set run_at = now(), updated_at = now()
     where owner_user_id = ${userId} and status = 'queued' and payload #>> '{vars,spendHoldId}' = ${holdId}`);
  return r.rowCount ?? 0;
}

export async function cancelSpendJob(db: DbOrTx, userId: string, holdId: string): Promise<number> {
  const r = await db.execute(sql`update jobs set status = 'cancelled', finished_at = now(), cancel_reason = 'stopped from a spend ask', updated_at = now()
     where owner_user_id = ${userId} and status = 'queued' and payload #>> '{vars,spendHoldId}' = ${holdId}`);
  return r.rowCount ?? 0;
}

export function dbSpendGovernor(o: DbSpendStoreOptions): SpendGovernor & { store: DbSpendStore } {
  return new SpendGovernor(new DbSpendStore(o)) as SpendGovernor & { store: DbSpendStore };
}

/** The API shapes of a hold and an ask live in the shared read views (both DataSources; ENG-5: the mock reads them without the scanner store). */
export { spendAskOf, spendHoldsPayload, spendHoldView } from '@/server/views/health';

/**
 * The worker's start gate (src/llm/spend/day-gate.ts): a job that calls a model holds its estimate before it starts.
 * Declined (today's spend + live holds + this one would pass the hard cap): the job goes back to the queue for later,
 * its attempt not consumed, and one SPEND.DAY_BUDGET event says why. Started: its hold settles with what it booked.
 */
export function spendStartGate(db: DbOrTx, userId: string, clock?: () => Date) {
  const gov = dbSpendGovernor({ db, userId, ...(clock ? { clock } : {}) });
  return async (job: { id: number; kind: string; payload: Record<string, unknown> }): Promise<{ start: true; settle?: () => Promise<void> } | { start: false; retryAt: Date }> => {
    const d = await gateJobStart(gov, job);
    if (!d.start) return { start: false, retryAt: d.retryAt };
    const hold = d.hold;
    // F-4: a job that raised its hand on this hold left it asked; its continuation carries it to the answer
    const settle = async () => {
      if ((await gov.store.getHold(hold!.id))?.state === 'asked') return;
      await gov.settle(hold!, await gov.store.jobSpend(job.id));
    };
    return hold ? { start: true, settle } : { start: true };
  };
}

/** Put a claimed job back for later without consuming an attempt (the day-budget gate declined it). */
export async function deferJob(db: DbOrTx, id: number, workerId: string, runAt: Date): Promise<boolean> {
  const r = await db.execute(sql`
    update jobs set status = 'queued', attempts = greatest(attempts - 1, 0), run_at = ${runAt.toISOString()}::timestamptz, locked_by = null, locked_at = null,
                    lease_expires_at = null, heartbeat_at = null, started_at = null, updated_at = now()
     where id = ${id} and status = 'running' and locked_by = ${workerId}`);
  return (r.rowCount ?? 0) > 0;
}

/** COST-9: the first scan's estimate (per source, × the days of history), held on the first scan's own budget. */
export async function recordFirstScanHold(db: DbOrTx, userId: string, days: number, now: Date): Promise<Hold | null> {
  const gov = dbSpendGovernor({ db, userId, clock: () => now });
  const measured = await gov.store.sourceDayCosts().catch(() => ({}));
  const e = estimateFirstScan(Object.keys(FIRST_SCAN_SOURCE_DAY_USD), { days }, measured);
  const r = await gov.hold({ scope: 'job', jobKey: 'first_scan', budget: 'first_scan' }, { p50: e.p50, p90: e.p90, basis: e.basis === 'default' ? 'default' : 'history', n: 0 });
  return r.ok ? r.hold : null;
}

/** `scan:report --yield`: "holds: asked 3, approved 2, denied 1, overrun median 40%". */
export function holdsLine(s: SpendHoldsPayload['summary']): string {
  return `  holds: asked ${s.asked}, approved ${s.approved}, denied ${s.denied}, overrun median ${s.overrunMedianPct == null ? '-' : `${s.overrunMedianPct}%`}`;
}
