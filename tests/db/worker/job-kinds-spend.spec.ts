/**
 * post-job-kinds on Postgres: `readin.generate` and `vdp.assets.find` are now priced by the worker's start gate
 * (LLM_JOB_KINDS named them `readin.research` and `vdp.assets` before, so the gate never held for them and each took
 * its own hold). The real worker, the real gate and the real handlers: one hold per run (the gate's; the handler runs
 * under it and takes none of its own), one SPEND.ASK past it, the run's spend booked once in llm_calls, the gate
 * leaves the asked hold alone, Allow runs the continuation on the same hold and settles it, Stop cancels it.
 *
 * The handlers' data loaders (the read-in's context pack, the VDP mirror's target) are stubbed with placeholders;
 * the research agent is a fake that spends past the hold. Nothing external is called.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DbHandle } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { configureReadIn, readInJobDef, resetReadInConfig } from '@/jobs/handlers/readin';
import { configureVdpAssets, resetVdpAssetsConfig, vdpAssetsJobDef } from '@/jobs/handlers/vdp-assets';
import { JobRegistry } from '@/jobs/registry';
import type { ResearchAgent, ResearchRunInput, ResearchRunResult } from '@/llm/readin/agent';
import { answerHold, PAUSED_FOR_SPEND } from '@/llm/spend';
import { cancelSpendJob, dbSpendGovernor, requeueSpendJob, spendStartGate } from '@/server/datasource/db/spend';
import { WorkerRuntime } from '@/worker/runtime';

import { createUser, openTestDb, setUserSetting } from './helpers';

// ---- the handlers' loaders: placeholders in place of a seeded ledger and a VDP mirror
vi.mock('@/server/datasource/db/readin-records', () => ({ loadReadInRecords: async () => ({}) }));
vi.mock('@/llm/readin/context', () => ({
  buildReadInContext: (_r: unknown, entity: { type: string; id: string }) => ({ entity, generation: 1, skill: entity.type === 'calendar_event' ? 'readin-meeting' : 'readin-ask', reply: null }),
  contextUrls: () => [],
}));
vi.mock('@/llm/readin/evidence', () => ({ readInEvidenceHash: () => 'placeholder-hash' }));
vi.mock('@/llm/readin/prompt', async (orig) => ({ ...(await orig<typeof import('@/llm/readin/prompt')>()), buildReadInPrompt: () => ({ systemPrompt: ['placeholder system'], prompt: 'placeholder prompt', skillVersion: 'readin-ask@test' }), stepForTool: () => null }));
vi.mock('@/personas', async (orig) => ({ ...(await orig<typeof import('@/personas')>()), featureActive: () => true }));
vi.mock('@/server/datasource/db/store/vdp-assets', () => ({ loadAssetState: async () => ({ snaps: [], cov: { vdps: [], unlinked: [] }, targets: [], accounts: [] }) }));
vi.mock('@/server/vdp/find', async (orig) => ({
  ...(await orig<typeof import('@/server/vdp/find')>()),
  targetForKey: (key: string) => ({ key, vdpSlug: 'example-fy27', accountId: null, companyName: 'Example Co', names: ['Example Co'], inVdp: [] }),
}));

let h: DbHandle;
beforeAll(() => {
  h = openTestDb();
});
afterAll(async () => {
  resetReadInConfig();
  resetVdpAssetsConfig();
  await h.close();
});

async function user(label: string, hardUsd = 15) {
  const userId = await createUser(h.db, label);
  await setUserSetting(h.db, userId, 'settings.budgets', { version: 1, softUsd: hardUsd / 2, hardUsd, alertPct: 80, readinUsdPerDay: 2, triageEscalationUsdPerDay: 1, today: null, raises: [] });
  return userId;
}

const holdsOf = async (userId: string) => (await h.db.execute<{ id: string; state: string; job_key: string; scope: string; spent_usd: string; held_usd: string }>(sql`select id, state, job_key, scope, spent_usd::text, held_usd::text from spend_holds where user_id = ${userId} order by created_at`)).rows;
const asksOf = async (userId: string) => (await h.db.execute<{ resolved: boolean }>(sql`select resolved_at is not null as resolved from app_events where owner_user_id = ${userId} and code = 'SPEND.ASK' order by id`)).rows;
const jobsOf = async (userId: string, kind: string) => (await h.db.execute<{ id: string; status: string; hold: string | null; result: Record<string, unknown> | null }>(sql`select id::text, status, payload #>> '{vars,spendHoldId}' as hold, result from jobs where owner_user_id = ${userId} and kind = ${kind} order by jobs.id`)).rows;
const callsOf = async (userId: string) => (await h.db.execute<{ job_id: string; cost_usd: string }>(sql`select job_id::text, cost_usd::text from llm_calls where owner_user_id = ${userId} order by id`)).rows;

/** First run: spends $0.60 against the research hold ($0.45 with no history), asks, and stops. Later runs: $0.05, then end. */
function spendingAgent() {
  const runs: ResearchRunInput[] = [];
  const agent: ResearchAgent = {
    async run(input): Promise<ResearchRunResult> {
      runs.push(input);
      const base = { output: null, inputTokens: 1000, outputTokens: 100, turns: 2, toolCalls: [] };
      if (runs.length === 1) {
        expect(input.spend?.observe(0.6)).toBe('ask');
        await input.spend!.ask({ pctDone: 50 });
        return { ...base, ok: false, costUsd: 0.6, error: { code: PAUSED_FOR_SPEND, message: 'paused for spend', errorClass: 'config' } };
      }
      expect(input.spend?.observe(0.05)).toBe('continue');
      return { ...base, ok: false, costUsd: 0.05, error: { code: 'invalid_output', message: 'placeholder end', errorClass: 'config' } };
    },
  };
  return { agent, runs };
}

const CASES = [
  {
    kind: 'readin.generate',
    queue: 'readin',
    payload: { entity_type: 'work_item', entity_id: 'placeholder-item', trigger: 'on_demand' },
    def: () => readInJobDef(),
    configure: (agent: ResearchAgent) => configureReadIn({ agent, enabled: () => true, google: () => null, external: () => ({ servers: {}, tools: [], unavailable: [] }), generationPollMs: 60_000 }),
  },
  {
    kind: 'vdp.assets.find',
    queue: 'vdp',
    payload: { key: 'example-fy27' },
    def: () => vdpAssetsJobDef(),
    configure: (agent: ResearchAgent) => configureVdpAssets({ agent, google: () => null, external: () => ({ servers: {}, tools: [], unavailable: [] }) }),
  },
] as const;

/**
 * Each kind on a queue of this file's own. Since claimJobs takes only the worker's user's jobs, another file's
 * leftover (another user's) is no longer claimable; the per-file queue stays as belt and braces, and relay-holds.spec.ts
 * holds the regression guard ("Flake: relay holds under load", docs/reviews/2026-11-20-holistic/28-crash-resume.md).
 */
const FILE_Q = randomUUID().slice(0, 8);
const queueOf = (c: (typeof CASES)[number]) => `${c.queue}.kinds.${FILE_Q}`;

function workerFor(userId: string, c: (typeof CASES)[number]) {
  const registry = new JobRegistry();
  registry.register({ ...c.def(), queue: queueOf(c) });
  return new WorkerRuntime({ db: h.db, userId, workerId: `test:${process.pid}:${randomUUID()}`, registry, services: {}, pools: [{ name: queueOf(c), queues: [queueOf(c)], concurrency: 1 }], listenUrl: null, log: () => {}, startGate: spendStartGate(h.db, userId) });
}

describe.each(CASES)('$kind under the start gate (db, worker)', (c) => {
  it('one hold (the gate’s), one ask, spend booked once; Allow runs the continuation on the same hold and settles it', async () => {
    const userId = await user(`kinds${c.queue}`);
    const { agent, runs } = spendingAgent();
    c.configure(agent);
    const worker = workerFor(userId, c);
    const first = await enqueueJob(h.db, { ownerUserId: userId, kind: c.kind, queue: queueOf(c), payload: c.payload });
    await worker.pollOnce();
    await worker.idle();
    expect(runs).toHaveLength(1);
    const holds = await holdsOf(userId);
    expect(holds).toHaveLength(1); // the gate's; the handler found it by `<kind>:<id>` and took no second one
    expect(holds[0]).toMatchObject({ state: 'asked', scope: 'research', job_key: `${c.kind}:${first.id}` });
    expect(Number(holds[0]!.held_usd)).toBeCloseTo(0.45, 6);
    expect(Number(holds[0]!.spent_usd)).toBeCloseTo(0.6, 6);
    expect(await asksOf(userId)).toEqual([{ resolved: false }]);
    expect((await callsOf(userId)).map((x) => [x.job_id, Number(x.cost_usd)])).toEqual([[String(first.id), 0.6]]);
    const jobs = await jobsOf(userId, c.kind);
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'queued']);
    expect(jobs[0]!.result).toMatchObject({ skipped: PAUSED_FOR_SPEND, paused: 'spend', holdId: holds[0]!.id, queued: true });
    expect(jobs[1]!.hold).toBe(holds[0]!.id);

    // Allow $0.50 more: the continuation runs now, on the same hold (the gate takes none for it), and settles it
    const gov = dbSpendGovernor({ db: h.db, userId });
    await answerHold(gov, holds[0]!.id, { answer: 'approve', usd: 0.5 }, { requeue: async (x) => void (await requeueSpendJob(h.db, userId, x.id)) });
    await worker.pollOnce();
    await worker.idle();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.spend?.hold.id).toBe(holds[0]!.id);
    const after = await holdsOf(userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: holds[0]!.id, state: 'settled' });
    expect(Number(after[0]!.spent_usd)).toBeCloseTo(0.65, 6);
    expect(await asksOf(userId)).toEqual([{ resolved: true }]);
    expect((await callsOf(userId)).map((x) => Number(x.cost_usd))).toEqual([0.6, 0.05]);
    expect((await jobsOf(userId, c.kind)).map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('Stop cancels the waiting continuation; nothing more runs or is paid', async () => {
    const userId = await user(`kindsstop${c.queue}`);
    const { agent, runs } = spendingAgent();
    c.configure(agent);
    const worker = workerFor(userId, c);
    await enqueueJob(h.db, { ownerUserId: userId, kind: c.kind, queue: queueOf(c), payload: c.payload });
    await worker.pollOnce();
    await worker.idle();
    const [hold] = await holdsOf(userId);
    expect(hold!.state).toBe('asked');

    await answerHold(dbSpendGovernor({ db: h.db, userId }), hold!.id, { answer: 'deny' }, { cancel: async (x) => void (await cancelSpendJob(h.db, userId, x.id)) });
    expect((await jobsOf(userId, c.kind)).map((j) => j.status)).toEqual(['succeeded', 'cancelled']);
    await worker.pollOnce();
    await worker.idle();
    expect(runs).toHaveLength(1);
    expect(await holdsOf(userId)).toEqual([expect.objectContaining({ id: hold!.id, state: 'denied' })]);
    expect((await callsOf(userId)).map((x) => Number(x.cost_usd))).toEqual([0.6]);
  });

  it('a day with no room for its hold: the gate defers the job (no hold, no run, one SPEND.DAY_BUDGET), it is not skipped', async () => {
    const userId = await user(`kindsday${c.queue}`, 0.3); // under the research hold of $0.45
    const { agent, runs } = spendingAgent();
    c.configure(agent);
    const worker = workerFor(userId, c);
    await enqueueJob(h.db, { ownerUserId: userId, kind: c.kind, queue: queueOf(c), payload: c.payload });
    await worker.pollOnce();
    await worker.idle();
    expect(runs).toHaveLength(0);
    expect(await holdsOf(userId)).toEqual([]);
    const [job] = await jobsOf(userId, c.kind);
    expect(job).toMatchObject({ status: 'queued', result: null });
    const evs = (await h.db.execute<{ code: string; kind: string }>(sql`select code, detail->>'kind' as kind from app_events where owner_user_id = ${userId}`)).rows;
    expect(evs).toEqual([{ code: 'SPEND.DAY_BUDGET', kind: c.kind }]);
  });
});
