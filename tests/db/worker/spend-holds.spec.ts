/**
 * The spend governor on Postgres (0030 `spend_holds`, src/server/datasource/db/spend.ts): holds and their day
 * reservation in `llm_budget_days.reserved_usd` (one meter with every older reservation), estimates from `llm_calls`,
 * the SPEND.ASK event (one row per hold, resolved by the answer), the paused job's re-queue / cancel, receipts, the
 * worker's start gate (decline → deferred job + one SPEND.DAY_BUDGET event). Placeholder user, no external system.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import type { DbHandle } from '@/db/client';
import { insertLlmCall } from '@/db/ledger';
import { cancelSpendJob, dbSpendGovernor, deferJob, holdsLine, recordFirstScanHold, requeueSpendJob, spendHoldsPayload, spendStartGate } from '@/server/datasource/db/spend';

import { createUser, openTestDb, setUserSetting } from './helpers';

let h: DbHandle;
const NOW = new Date('2026-11-20T18:00:00.000Z'); // 11:00 in America/Denver
const DAY = '2026-11-20';

beforeAll(() => {
  h = openTestDb();
});
afterAll(async () => {
  await h.close();
});

async function userWithBudget(hardUsd: number) {
  const userId = await createUser(h.db, 'spend');
  await setUserSetting(h.db, userId, 'settings.budgets', { version: 1, softUsd: hardUsd / 2, hardUsd, alertPct: 80, readinUsdPerDay: 2, triageEscalationUsdPerDay: 1, today: null, raises: [] });
  await withChangeSet({ db: h.db, userId, actor: actors.user(), reason: 'budget row' }, (tx) =>
    tx.execute(sql`insert into llm_budgets (owner_user_id, scope, daily_limit_usd, hard_stop, effective_from) values (${userId}, 'total', ${hardUsd / 2}, false, ${DAY}::date)`),
  );
  return userId;
}

const book = (userId: string, o: { usd: number; skill: string; jobId?: number | null; startedAt?: Date }) =>
  insertLlmCall(h.db, {
    ownerUserId: userId,
    purpose: 'scan_extract',
    model: 'claude-haiku-5-5',
    skillKey: o.skill,
    requestHash: `t:${Math.random()}`,
    status: 'ok',
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: o.usd,
    budgetDay: DAY,
    startedAt: o.startedAt ?? NOW,
    finishedAt: o.startedAt ?? NOW,
    trigger: 'test',
    modelReason: 'default',
    contentHash: 'h',
    outcome: 'ok',
    jobId: o.jobId ?? null,
  });

const reserved = async (userId: string) =>
  Number(
    (await h.db.execute<{ r: string | null }>(sql`select d.reserved_usd::text as r from llm_budget_days d join llm_budgets b on b.id = d.budget_id where b.owner_user_id = ${userId} and d.day = ${DAY}::date`)).rows[0]?.r ?? 0,
  );

describe('spend_holds on Postgres', () => {
  it('a hold reserves its amount on the day, raises move it, settling releases it; the day sees every scope', async () => {
    const userId = await userWithBudget(10);
    const gov = dbSpendGovernor({ db: h.db, userId, clock: () => NOW });
    expect(await gov.store.today()).toBe(DAY);
    const a = await gov.hold({ scope: 'scan_run', jobKey: 'scan:slack:inbox:1', skill: 'scan-slack' }, { p50: 0.1, p90: 0.4, basis: 'default', n: 0 });
    const b = await gov.hold({ scope: 'chat_message', jobKey: 'msg-1' }, { p50: 0.1, p90: 0.3, basis: 'default', n: 0 }, { budgetUsd: 0.25 });
    expect(a.ok && b.ok).toBe(true);
    expect(await reserved(userId)).toBeCloseTo(0.65, 6);
    await book(userId, { usd: 9, skill: 'scan-slack' });
    const day = await gov.store.dayStatus();
    expect(day).toMatchObject({ day: DAY, spentUsd: 9, hardUsd: 10 });
    expect(day.heldUsd).toBeCloseTo(0.65, 6);
    const c = await gov.hold({ scope: 'relay', jobKey: 'r' }, { p50: 0.2, p90: 0.4, basis: 'default', n: 0 });
    expect(c).toMatchObject({ ok: false, reason: 'day_budget' });
    if (!a.ok) return;
    gov.tick(a.hold, 0.5, '41');
    await gov.ask(a.hold, { pctDone: 30 });
    const ev = await h.db.execute<{ code: string; severity: string; message: string; resolved_at: Date | null }>(sql`select code, severity::text, message, resolved_at from app_events where owner_user_id = ${userId} and code = 'SPEND.ASK'`);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.message).toMatch(/^This scan has used \$0\.50 of its \$0\.40 estimate and is 30% done; allow \$0\.\d\d more\?$/);
    const more = await gov.answer(a.hold.id, { kind: 'approve', usd: 0.2 });
    expect(more).toMatchObject({ state: 'approved', heldUsd: 0.6, answerUsd: 0.2 });
    expect(await reserved(userId)).toBeCloseTo(0.85, 6);
    expect((await h.db.execute(sql`select 1 from app_events where owner_user_id = ${userId} and code = 'SPEND.ASK' and resolved_at is null`)).rows).toHaveLength(0);
    const settled = await gov.settle(more!, 0.55);
    expect(settled).toMatchObject({ state: 'settled', spentUsd: 0.55 });
    expect(settled.callIds).toEqual(['41']);
    expect(await reserved(userId)).toBeCloseTo(0.25, 6);
    // receipts
    const all = await gov.store.listHolds({ since: new Date(NOW.getTime() - 3600_000).toISOString() });
    const payload = spendHoldsPayload(all, await gov.store.listHolds({ states: ['asked'] }));
    expect(payload.summary).toEqual({ asked: 1, approved: 1, denied: 0, overrunMedianPct: null });
    expect(holdsLine(payload.summary)).toBe('  holds: asked 1, approved 1, denied 0, overrun median -');
  });

  it('estimates from llm_calls: one sample per scan run (all its passes), the table under 10', async () => {
    const userId = await userWithBudget(15);
    const gov = dbSpendGovernor({ db: h.db, userId, clock: () => NOW });
    expect((await gov.estimate({ scope: 'job', jobKey: 'x', skill: 'brief-opportunity' })).basis).toBe('default');
    for (let i = 0; i < 12; i++) await book(userId, { usd: 0.01 * (i + 1), skill: 'brief-opportunity', startedAt: new Date(NOW.getTime() - i * 3600_000) });
    const e = await gov.estimate({ scope: 'job', jobKey: 'x', skill: 'brief-opportunity' });
    expect(e).toMatchObject({ basis: 'history', n: 12 });
    expect(e.p50).toBeCloseTo(0.065, 6);
    expect(e.p90).toBeGreaterThan(e.p50);
  });

  it('Allow re-runs the paused job now; Stop cancels it', async () => {
    const userId = await userWithBudget(15);
    const mk = async (key: string, holdId: string) =>
      Number(
        (
          await h.db.execute<{ id: string }>(sql`insert into jobs (owner_user_id, queue, kind, payload, run_at, dedupe_key)
          values (${userId}, 'scan.slack', 'scan.slack', ${JSON.stringify({ kind: 'scan', id: key, vars: { spendHoldId: holdId } })}::jsonb, now() + interval '6 hours', ${key}) returning id`)
        ).rows[0]!.id,
      );
    const j1 = await mk(`k1-${userId}`, '11111111-1111-1111-1111-111111111111');
    const j2 = await mk(`k2-${userId}`, '22222222-2222-2222-2222-222222222222');
    expect(await requeueSpendJob(h.db, userId, '11111111-1111-1111-1111-111111111111')).toBe(1);
    expect(await cancelSpendJob(h.db, userId, '22222222-2222-2222-2222-222222222222')).toBe(1);
    const rows = await h.db.execute<{ id: string; status: string; due: boolean }>(sql`select id, status::text, run_at <= now() as due from jobs where id in (${j1}, ${j2}) order by id`);
    expect(rows.rows.map((r) => [r.status, r.due])).toEqual([
      ['queued', true],
      ['cancelled', false],
    ]);
  });

  it("the worker's start gate: starts with a hold that settles with what the job booked; past the cap it defers with one event", async () => {
    const userId = await userWithBudget(1);
    const gate = spendStartGate(h.db, userId, () => NOW);
    const jobId = Number((await h.db.execute<{ id: string }>(sql`insert into jobs (owner_user_id, queue, kind, payload, status, locked_by, locked_at, lease_expires_at, attempts) values (${userId}, 'brief', 'brief.generate', '{}'::jsonb, 'running', 'w1', now(), now() + interval '5 minutes', 1) returning id`)).rows[0]!.id);
    const g = await gate({ id: jobId, kind: 'brief.generate', payload: {} });
    expect(g.start).toBe(true);
    await book(userId, { usd: 0.03, skill: 'brief-opportunity', jobId });
    if (g.start) await g.settle?.();
    const hold = (await h.db.execute<{ state: string; spent_usd: string }>(sql`select state, spent_usd::text from spend_holds where user_id = ${userId} and job_key = ${`brief.generate:${jobId}`}`)).rows[0]!;
    expect(hold).toMatchObject({ state: 'settled' });
    expect(Number(hold.spent_usd)).toBeCloseTo(0.03, 6);
    // spend the day: the next LLM job is declined and deferred, attempt not consumed
    await book(userId, { usd: 0.99, skill: 'brief-opportunity' });
    const no = await gate({ id: jobId, kind: 'org62.readback', payload: {} });
    expect(no.start).toBe(false);
    await gate({ id: jobId, kind: 'activity.notes', payload: {} });
    if (!no.start) expect(await deferJob(h.db, jobId, 'w1', no.retryAt)).toBe(true);
    const job = (await h.db.execute<{ status: string; attempts: number; run_at: Date }>(sql`select status::text, attempts, run_at from jobs where id = ${jobId}`)).rows[0]!;
    expect(job).toMatchObject({ status: 'queued', attempts: 0 });
    expect(new Date(job.run_at).toISOString()).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString()); // half an hour on
    const ev = await h.db.execute<{ n: number }>(sql`select occurrence_count as n from app_events where owner_user_id = ${userId} and code = 'SPEND.DAY_BUDGET' and resolved_at is null`);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.n).toBe(2);
  });

  it('first scan: the estimate is held on its own budget, never the day', async () => {
    const userId = await userWithBudget(15);
    const hold = await recordFirstScanHold(h.db, userId, 14, NOW);
    expect(hold).toMatchObject({ scope: 'job', jobKey: 'first_scan', budget: 'first_scan', state: 'open', estimate: { basis: 'default' } });
    expect(hold!.heldUsd).toBeGreaterThan(hold!.estimate.p50);
    expect(await reserved(userId)).toBe(0);
  });
});
