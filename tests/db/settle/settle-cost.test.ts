/**
 * COST-1 on a scratch database: the Settle pass holds the daily hard cap (checked before every call, deferring what it
 * has not judged), keeps the stronger model within its per-day allowance across passes, and books every call on the
 * model that made it, with its tokens. Fake model, placeholder data only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { enqueueJob } from '../../../src/db/queue';
import { SETTLE_STRONG_MODEL } from '../../../src/engines/settle/run';
import { SETTLE_JOB_KIND, SETTLE_QUEUE, lastSettleThrough, settleHandler } from '../../../src/jobs/handlers/settle';
import type { JobContext } from '../../../src/jobs/types';
import type { CompletionModel, CompletionModelRequest } from '../../../src/scanner/completion/types';
import { localDay } from '../../../src/scanner/store-db';
import { pgAvailable, provisionTestDb, type TestDb } from '../scanner/helpers/pg';


const TZ = 'America/Denver';
const CHEAP = 'claude-haiku-5-5';
const reply = (verdict: string, confidence: number) => JSON.stringify({ verdict, confidence, reason: 'placeholder' });

describe.skipIf(!pgAvailable())('settle pass cost caps (scratch database)', () => {
  let t: TestDb;
  let userId = '';
  const now = () => new Date();
  const day = () => localDay(now(), TZ);

  beforeAll(async () => {
    t = await provisionTestDb('settle_cost');
    const u = await t.handle.db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values ('placeholder@example.com', 'ME Person', ${TZ}) returning id`);
    userId = u.rows[0]!.id;
  });
  afterAll(async () => t?.drop());

  /** Audited tables need a change set (cc_audit_*). */
  const exec = <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
    withChangeSet({ db: t.handle.db, userId, actor: actors.system('test'), reason: 'test' }, async (tx) => tx.execute<T>(q)).then((r) => r.result);

  beforeEach(async () => {
    await t.handle.db.execute(sql`delete from llm_calls`);
    await t.handle.db.execute(sql`delete from jobs`);
    await exec(sql`delete from work_items`);
    await exec(sql`delete from user_settings`);
  });

  const setting = (key: string, value: unknown) =>
    exec(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, ${key}, ${JSON.stringify(value)}::jsonb)
             on conflict (owner_user_id, key) do update set value = excluded.value`);

  async function items(n: number, tag: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await exec<{ id: string }>(sql`insert into work_items (owner_user_id, kind, origin, status, title) values (${userId}, 'task', 'manual', 'open', ${`Placeholder ${tag} ${i}`}) returning id`);
      ids.push(r.rows[0]!.id);
    }
    return ids;
  }

  /** A succeeded earlier pass, so the next one is a regular (daily) pass, not the first. */
  async function earlierPass() {
    const j = await enqueueJob(t.handle.db, { ownerUserId: userId, kind: SETTLE_JOB_KIND, queue: SETTLE_QUEUE, payload: { trigger: 'interval' } });
    const through = new Date(now().getTime() - 3_600_000).toISOString();
    await t.handle.db.execute(sql`update jobs set status = 'succeeded', result = ${JSON.stringify({ through })}::jsonb where id = ${j.id}`);
    return through;
  }

  async function run(model: CompletionModel, ids: string[], deps: { maxUsdPerPass?: number } = {}) {
    const j = await enqueueJob(t.handle.db, { ownerUserId: userId, kind: SETTLE_JOB_KIND, queue: SETTLE_QUEUE, payload: { trigger: 'manual' } });
    const logs: string[] = [];
    const ctx = {
      job: { id: Number(j.id) },
      signal: new AbortController().signal,
      db: t.handle.db,
      userId,
      clock: now,
      log: (m: string) => logs.push(m),
      heartbeat: async () => {},
      enqueue: async () => ({ id: 0, inserted: false }),
      services: {},
    } as unknown as JobContext;
    const out = (await settleHandler({ handle: t.handle, model, ids, concurrency: 1, ...deps })(ctx)) as Record<string, unknown>;
    return { out, logs };
  }

  const spendRows = async () =>
    (await t.handle.db.execute<{ model: string; model_tier: string; cost_usd: string; input_tokens: number; output_tokens: number; status: string; budget: string; skill_key: string }>(sql`
      select model, model_tier::text as model_tier, cost_usd::text as cost_usd, input_tokens, output_tokens, status::text as status, budget, skill_key
        from llm_calls where owner_user_id = ${userId} order by id`)).rows;

  it('defers the whole pass at the daily hard cap: no call, the watermark stays', async () => {
    const through = await earlierPass();
    await setting('settings.budgets', { softUsd: 0.5, hardUsd: 1 });
    // today's daily spend is already past the hard cap
    await t.handle.db.execute(sql`
      insert into llm_calls (owner_user_id, purpose, model, model_tier, request_hash, status, cost_usd, budget_day, budget)
      values (${userId}, 'scan_extract', ${CHEAP}, 'haiku', 'spend:none:placeholder', 'ok', 1.2, ${day()}::date, 'daily')`);
    const calls: string[] = [];
    const model: CompletionModel = async (req) => {
      calls.push(req.model);
      return { ok: true, text: reply('still_yours', 0.9), costUsd: 0.01, inputTokens: 100, outputTokens: 10 };
    };
    const { out, logs } = await run(model, await items(3, 'capped'));
    expect(calls).toHaveLength(0);
    expect(out).toMatchObject({ status: 'deferred_budget', judged: 0, unjudged: 3, through, deferred: 'daily_hard_cap' });
    expect(logs.some((m) => /hard cap/.test(m))).toBe(true);
    expect(await lastSettleThrough(t.handle.db, userId)).toBe(through);
  });

  it('stops mid-pass once its own spend reaches the hard cap; the rest waits', async () => {
    const through = await earlierPass();
    await setting('settings.budgets', { softUsd: 0.5, hardUsd: 1 });
    await setting('settings.closing', { version: 1, strongerModelForUnclear: false });
    const calls: string[] = [];
    const model: CompletionModel = async (req) => {
      calls.push(req.model);
      return { ok: true, text: reply('still_yours', 0.9), costUsd: 0.3, inputTokens: 1000, outputTokens: 50 };
    };
    // a per-pass cap well above the hard cap, so only the hard cap can stop it
    const { out } = await run(model, await items(6, 'midpass'), { maxUsdPerPass: 50 });
    // 0 → 0.3 → 0.6 → 0.9 → 1.2: the fifth call sees the cap and is never made
    expect(calls).toHaveLength(4);
    expect(out).toMatchObject({ status: 'deferred_budget', judged: 4, unjudged: 2, through, deferred: 'daily_hard_cap' });
    const rows = await spendRows();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.budget === 'daily' && r.model === CHEAP && r.input_tokens === 1000 && r.output_tokens === 50)).toBe(true);
  });

  it('the stronger model stays within its per-day allowance across passes, and each call is booked on its own model', async () => {
    await earlierPass();
    await setting('settings.closing', { version: 1, strongerModelForUnclear: true, strongerModelUsdPerDay: 0.2 });
    const seen: CompletionModelRequest[] = [];
    // The cheap model is always unsure; the stronger one answers (one item's stronger reply is unparseable).
    let garbleNext = false;
    const model: CompletionModel = async (req) => {
      seen.push(req);
      if (req.model !== SETTLE_STRONG_MODEL) return { ok: true, text: reply('still_yours', 0.3), costUsd: 0.001, inputTokens: 2000, outputTokens: 40 };
      return { ok: true, text: garbleNext ? 'not json' : reply('still_yours', 0.9), costUsd: 0.04, inputTokens: 2100, outputTokens: 60 };
    };
    const strongerToday = async () =>
      Number((await t.handle.db.execute<{ usd: string }>(sql`select coalesce(sum(cost_usd), 0)::text as usd from llm_calls where model = ${SETTLE_STRONG_MODEL} and budget_day = ${day()}::date`)).rows[0]!.usd);

    // Pass A: three escalations ($0.12 of $0.20).
    const a = await run(model, await items(3, 'a'));
    expect(a.out).toMatchObject({ status: 'ok', judged: 3, strongerUsd: 0.12 });
    expect(await strongerToday()).toBeCloseTo(0.12, 6);

    // Pass B: $0.08 left. One more fits (a call in flight holds its $0.05 per-call budget); the next is refused.
    const b = await run(model, await items(4, 'b'));
    expect(b.out).toMatchObject({ status: 'ok', judged: 4, strongerUsd: 0.04 });
    expect(Number(b.out.strongerRefused)).toBeGreaterThanOrEqual(1);
    expect(await strongerToday()).toBeCloseTo(0.16, 6);

    // Pass C: nothing left today; no stronger call at all.
    const before = seen.filter((r) => r.model === SETTLE_STRONG_MODEL).length;
    const c = await run(model, await items(2, 'c'));
    expect(c.out).toMatchObject({ judged: 2, strongerUsd: 0 });
    expect(seen.filter((r) => r.model === SETTLE_STRONG_MODEL).length).toBe(before);
    expect(await strongerToday()).toBeLessThanOrEqual(0.2);

    // Every stronger call is booked as the stronger model with its tokens; the cheap ones as the cheap model.
    const rows = await spendRows();
    const strong = rows.filter((r) => r.model === SETTLE_STRONG_MODEL);
    expect(strong).toHaveLength(4);
    expect(strong.every((r) => r.model_tier === 'sonnet' && r.input_tokens === 2100 && r.output_tokens === 60 && r.skill_key === 'settle-item')).toBe(true);
    expect(rows.filter((r) => r.model === CHEAP).every((r) => r.model_tier === 'haiku' && r.input_tokens === 2000)).toBe(true);

    // An escalation whose stronger reply is unusable keeps the cheap verdict, but its stronger calls are still booked
    // as the stronger model (before, the item's whole cost went on the cheap model's row).
    await t.handle.db.execute(sql`delete from llm_calls`);
    garbleNext = true;
    const d = await run(model, await items(1, 'd'));
    expect(d.out).toMatchObject({ judged: 1 });
    const dr = await spendRows();
    expect(dr.filter((r) => r.model === SETTLE_STRONG_MODEL).length).toBeGreaterThanOrEqual(1);
    expect(dr.filter((r) => r.model === CHEAP)).toHaveLength(1);
    expect(dr.reduce((s, r) => s + Number(r.cost_usd), 0)).toBeCloseTo(Number(d.out.costUsd), 6);
  });
});
