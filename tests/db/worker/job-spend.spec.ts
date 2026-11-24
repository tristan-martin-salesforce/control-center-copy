/**
 * Caps audit 26 F-4 on Postgres: a background job that was capped by a fixed number now runs under the spend governor.
 * The worker's start gate holds the job's estimate; the job's paid loop raises a hand past it (one SPEND.ASK row and
 * an asked hold: Health ▸ Spend), the gate leaves that hold asked, and the continuation waits as a queued job carrying
 * it. Allow $Z more brings it forward (requeueSpendJob), it resumes the same hold and settles it; Stop cancels it.
 * Then the brief (`brief.generate`) end to end. Placeholder user and data, fake model, no external system.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import type { DbHandle } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { BRIEF_JOB_KIND, briefFollowUpKey, briefHandler } from '@/jobs/handlers/brief';
import { CONFIRM_CACHE_KV, dbConfirmCache } from '@/jobs/handlers/use-cases-extract';
import { JobRegistry } from '@/jobs/registry';
import { spendPauseResult, spendStartResult } from '@/jobs/spend-pause';
import type { JobContext, JobHandler } from '@/jobs/types';
import { answerHold, finishJobSpend, startJobSpend } from '@/llm/spend';
import type { CompletionModel } from '@/scanner/completion';
import { DbScannerStore } from '@/scanner/store-db';
import { cancelSpendJob, dbSpendGovernor, requeueSpendJob, spendStartGate } from '@/server/datasource/db/spend';
import { WorkerRuntime } from '@/worker/runtime';

import { createUser, openTestDb, setUserSetting } from './helpers';

let h: DbHandle;
beforeAll(() => {
  h = openTestDb();
});
afterAll(async () => {
  await h.close();
});

async function user(label: string, hardUsd = 15) {
  const userId = await createUser(h.db, label);
  await setUserSetting(h.db, userId, 'settings.budgets', { version: 1, softUsd: hardUsd / 2, hardUsd, alertPct: 80, readinUsdPerDay: 2, triageEscalationUsdPerDay: 1, today: null, raises: [] });
  return userId;
}

const holdsOf = async (userId: string) => (await h.db.execute<{ id: string; state: string; job_key: string; spent_usd: string; held_usd: string }>(sql`select id, state, job_key, spent_usd::text, held_usd::text from spend_holds where user_id = ${userId} order by created_at`)).rows;
const asksOf = async (userId: string) => (await h.db.execute<{ message: string; resolved: boolean }>(sql`select message, resolved_at is not null as resolved from app_events where owner_user_id = ${userId} and code = 'SPEND.ASK' order by id`)).rows;
const jobsOf = async (userId: string, kind: string) => (await h.db.execute<{ id: string; status: string; hold: string | null; run_at: string }>(sql`select id::text, status, payload #>> '{vars,spendHoldId}' as hold, run_at::text from jobs where owner_user_id = ${userId} and kind = ${kind} order by id`)).rows;

describe('a job on the spend governor: ask, wait, answer, resume (db, worker)', () => {
  it('the start gate holds, the job asks past it, the continuation carries the hold; Allow resumes and settles it', async () => {
    const userId = await user('jobspend');
    // a paid loop of 5 calls at $0.03, priced as `brief.generate` (start-gate hold: the job default p90 $0.08)
    const calls: number[] = [];
    const handler: JobHandler = async (ctx) => {
      const gov = dbSpendGovernor({ db: ctx.db, userId: ctx.userId });
      const env = await startJobSpend(gov, ctx.job, { scope: 'job', skill: 'drill-skill' });
      const early = await spendStartResult(ctx, env);
      if (early) return early;
      const done = typeof ctx.job.payload.done === 'number' ? ctx.job.payload.done : 0;
      let i = done;
      let spent = 0;
      for (; i < 5; i += 1) {
        if (env.kind === 'run' && env.gate.observe(spent) === 'ask') {
          await env.gate.ask({ pctDone: (i / 5) * 100 });
          break;
        }
        calls.push(ctx.job.id);
        spent += 0.03;
      }
      if (env.kind === 'run') env.gate.observe(spent);
      await finishJobSpend(gov, env, spent);
      return { calls: i - done, ...(await spendPauseResult(ctx, env, { payload: { done: i } })) };
    };
    const registry = new JobRegistry();
    registry.register({ kind: 'brief.generate', queue: 'spenddrill', wired: true, description: 'drill', handler });
    const worker = new WorkerRuntime({ db: h.db, userId, workerId: `test:${process.pid}:${randomUUID()}`, registry, services: {}, pools: [{ name: 'spenddrill', queues: ['spenddrill'], concurrency: 1 }], listenUrl: null, log: () => {}, startGate: spendStartGate(h.db, userId) });
    await enqueueJob(h.db, { ownerUserId: userId, kind: 'brief.generate', queue: 'spenddrill', payload: { trigger: 'schedule' } });
    await worker.pollOnce();
    await worker.idle();

    // the first run paid 3 calls ($0.09 past the $0.08 hold) and asked; the gate did not settle the asked hold
    expect(calls).toHaveLength(3);
    const [hold] = await holdsOf(userId);
    expect(hold).toMatchObject({ state: 'asked', job_key: expect.stringMatching(/^brief\.generate:\d+$/) });
    expect(Number(hold!.spent_usd)).toBeCloseTo(0.09, 6);
    const asks = await asksOf(userId);
    expect(asks).toEqual([{ message: expect.stringMatching(/^This job has used \$0\.09 of its \$0\.08 estimate and is 60% done; allow \$0\.\d\d more\?$/), resolved: false }]);
    const queued = (await jobsOf(userId, 'brief.generate')).filter((j) => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.hold).toBe(hold!.id);
    expect(Date.parse(queued[0]!.run_at)).toBeGreaterThan(Date.now() + 5 * 3600_000);

    // Allow $0.10 more: the answer brings the continuation forward; it resumes the same hold (no second one) and settles it
    const gov = dbSpendGovernor({ db: h.db, userId });
    await answerHold(gov, hold!.id, { answer: 'approve', usd: 0.1 }, { requeue: async (x) => void (await requeueSpendJob(h.db, userId, x.id)) });
    expect(Date.parse((await jobsOf(userId, 'brief.generate')).find((j) => j.status === 'queued')!.run_at)).toBeLessThanOrEqual(Date.now() + 1000);
    await worker.pollOnce();
    await worker.idle();
    expect(calls).toHaveLength(5);
    const after = await holdsOf(userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: hold!.id, state: 'settled' });
    expect((await asksOf(userId))[0]!.resolved).toBe(true);
    expect((await jobsOf(userId, 'brief.generate')).every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('Stop cancels the waiting continuation; nothing more is paid', async () => {
    const userId = await user('jobspendstop');
    const gov = dbSpendGovernor({ db: h.db, userId });
    const held = await gov.hold({ scope: 'job', jobKey: 'brief.generate:1' }, { p50: 0.01, p90: 0.01, basis: 'default', n: 0 });
    if (!held.ok) throw new Error('no hold');
    gov.observe(held.hold, 0.02);
    await gov.ask(held.hold, { pctDone: 50 });
    await enqueueJob(h.db, { ownerUserId: userId, kind: 'brief.generate', queue: 'spenddrill', payload: { vars: { spendHoldId: held.hold.id } }, delaySeconds: 3600 });
    await answerHold(gov, held.hold.id, { answer: 'deny' }, { cancel: async (x) => void (await cancelSpendJob(h.db, userId, x.id)) });
    expect((await jobsOf(userId, 'brief.generate')).map((j) => j.status)).toEqual(['cancelled']);
  });
});

describe('brief.generate on the governor (db)', () => {
  const H = 3_600_000;
  const NOW = new Date('2026-11-11T14:31:00.000Z');
  const ts = (ms: number) => (ms / 1000).toFixed(6);

  async function watchedChannels(userId: string, refs: string[]) {
    const store = new DbScannerStore({ db: h.db, userId, clock: () => NOW });
    for (const [i, ref] of refs.entries()) {
      const ch = `C0SPEND0${i}`;
      await withChangeSet({ db: h.db, userId, actor: actors.user('watch.create'), reason: `Watching ${ref}` }, async (tx) => {
        const c = await tx.execute<{ id: string }>(sql`insert into channels (owner_user_id, system, external_id, name, kind, watch_mode) values (${userId}, 'slack', ${ref}, ${ref}, 'public', 'digest') returning id`);
        await tx.execute(sql`insert into watch_subscriptions (owner_user_id, scope_kind, channel_id, label, cadence, style) values (${userId}, 'channel', ${c.rows[0]!.id}, ${ref}, 'daily', 'digest')`);
      });
      const from = new Date(NOW.getTime() - 24 * H);
      const to = new Date(NOW.getTime() - 5 * 60_000);
      const { runId } = await store.startRun({ scope: { connector: 'slack', scope: `channel:${ref}` }, trigger: 'schedule', window: { from: from.toISOString(), to: to.toISOString() } });
      const at = from.getTime() + 2 * H;
      await store.recordSourceItems(runId, [{ connector: 'slack', kind: 'message', externalId: `${ch}:${ts(at)}`, dedupeKey: `slack:${ch}:${ts(at)}`, contentHash: randomUUID(), occurredAt: new Date(at).toISOString(), threadRef: `slack:${ch}:${ts(at)}`, excerpt: `Placeholder update ${i}`, author: { name: 'PERSON_A', externalId: 'U0PERSONA' }, payload: { channelId: ch, channelName: ref.slice(1), channelType: 'channel', ts: ts(at) } }]);
      await store.reportCoverage(runId, [{ kind: 'channel_range', ref: ch, from: from.toISOString(), to: to.toISOString() }]);
      await store.finishRun(runId, { cursor: { value: ts(to.getTime()), at: to.toISOString() }, stats: { fetched: 1, new: 1, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    }
  }

  const model = (costUsd: number, seen: string[]): CompletionModel => async (req) => {
    seen.push(req.user);
    const ids = [...req.user.matchAll(/\[(s_\d+)\]/g)].map((m) => m[1]!);
    return { ok: true, costUsd, inputTokens: 2000, outputTokens: 200, text: JSON.stringify({ summary: 'A placeholder update was shared.', nothingNew: false, highlights: [], everythingElse: ids.map((id) => ({ threadRef: 'slack:x', gist: 'Update', evidenceIds: [id] })), coverageNote: null }) };
  };

  function ctxFor(userId: string, id: number, payload: Record<string, unknown>, enqueued: Array<Record<string, unknown>>): JobContext {
    return {
      job: { id, ownerUserId: userId, kind: BRIEF_JOB_KIND, queue: 'brief', payload, attempts: 1, maxAttempts: 3, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null },
      signal: new AbortController().signal,
      db: h.db,
      userId,
      clock: () => NOW,
      log: () => undefined,
      heartbeat: async () => undefined,
      enqueue: async (j) => {
        enqueued.push(j as unknown as Record<string, unknown>);
        return enqueueJob(h.db, { ...j, ownerUserId: userId });
      },
      services: undefined,
    };
  }

  it('past its hold the brief asks before the next watch call; the call budget is the runaway guard, not $0.10', async () => {
    const userId = await user('briefspend');
    await watchedChannels(userId, ['#spend-one', '#spend-two', '#spend-three']);
    const gov = dbSpendGovernor({ db: h.db, userId, clock: () => NOW });
    const job = await enqueueJob(h.db, { ownerUserId: userId, kind: BRIEF_JOB_KIND, queue: 'brief', payload: {} });
    // the start gate's hold for this job: $0.05 (the run's estimate)
    const held = await gov.hold({ scope: 'job', jobKey: `${BRIEF_JOB_KIND}:${job.id}` }, { p50: 0.03, p90: 0.05, basis: 'default', n: 0 });
    if (!held.ok) throw new Error('no hold');
    const seen: string[] = [];
    const enqueued: Array<Record<string, unknown>> = [];
    const r = (await briefHandler({ model: model(0.04, seen), spend: gov })(ctxFor(userId, job.id, {}, enqueued))) as Record<string, unknown> & { counts: Record<string, number> };
    expect(seen).toHaveLength(2);
    expect(r.counts.ready).toBe(2);
    expect(r).toMatchObject({ paused: 'spend', holdId: held.hold.id, followUpAt: null });
    expect(enqueued).toEqual([expect.objectContaining({ kind: BRIEF_JOB_KIND, dedupeKey: briefFollowUpKey(userId), payload: expect.objectContaining({ trigger: 'follow_up', vars: { spendHoldId: held.hold.id } }) })]);
    const [hold] = (await holdsOf(userId)).filter((x) => x.id === held.hold.id);
    expect(hold!.state).toBe('asked');
    expect(await asksOf(userId)).toHaveLength(1);

    // the continuation after Allow: the third watch is briefed on the same hold, which then settles
    await gov.answer(held.hold.id, { kind: 'approve', usd: 0.1 });
    const job2 = await enqueueJob(h.db, { ownerUserId: userId, kind: BRIEF_JOB_KIND, queue: 'brief', payload: { vars: { spendHoldId: held.hold.id } } });
    const r2 = (await briefHandler({ model: model(0.04, seen), spend: gov })(ctxFor(userId, job2.id, { vars: { spendHoldId: held.hold.id } }, enqueued))) as { counts: Record<string, number> };
    expect(r2.counts.ready).toBe(1);
    expect(seen).toHaveLength(3);
    expect((await holdsOf(userId)).find((x) => x.id === held.hold.id)).toMatchObject({ state: 'settled' });
  });
});

describe('use_cases.extract: the confirm answers persist in the job kv (F-3, db)', () => {
  it('a kept answer reads back on the next pass; sources no longer unsure are dropped', async () => {
    const userId = await user('uccache');
    const ctx = { db: h.db, userId, clock: () => new Date('2026-11-18T16:00:00Z') };
    const c1 = await dbConfirmCache(ctx);
    c1.set('k1', [{ i: 1, useCase: true, title: 'Follow-up questions', problem: 'p', product: null, outcome: '' }]);
    c1.set('k2', []);
    await c1.save(new Set(['k1', 'k2']));
    const c2 = await dbConfirmCache(ctx);
    expect(c2.get('k1')?.[0]?.title).toBe('Follow-up questions');
    expect(c2.get('k2')).toEqual([]);
    await c2.save(new Set(['k1']));
    const c3 = await dbConfirmCache(ctx);
    expect(c3.get('k2')).toBeUndefined();
    expect(c3.get('k1')).toBeDefined();
    const [row] = (await h.db.execute<{ n: number }>(sql`select count(*)::int as n from user_settings where owner_user_id = ${userId} and key = ${CONFIRM_CACHE_KV}`)).rows;
    expect(row!.n).toBe(1);
  });
});
