/**
 * post-relay-holds on Postgres: the four relay jobs (`vdp.specialist_aes`, `accounts.hierarchy`, `org62.readback`,
 * `org62.discover`) run under ONE hold, the worker's start gate's. Every lookup books its cost into it (relayGuard takes
 * no hold of its own), so the hold reports the job's spend once; past it the job asks once (one SPEND.ASK), keeps what
 * it read and queues its continuation on the same hold; Allow runs the continuation, which reads what is left and
 * settles the hold; Stop cancels it and nothing more is paid. The real worker, the real gate and the real handlers.
 *
 * The handlers' loaders (my opps and accounts, the use-case opps, the discovery statements) are stubbed with
 * placeholders; the Org62 lookup is a fake that answers an empty, complete result. Nothing external is called.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DbHandle } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { configureHierarchyJob, hierarchyJobDef, resetHierarchyJobConfig } from '@/jobs/handlers/account-hierarchy';
import { configureDiscoverJob, org62DiscoverJobDef, resetDiscoverJobConfig } from '@/jobs/handlers/org62-discover';
import { configureOrg62Readback, org62ReadbackJobDef, resetOrg62ReadbackConfig } from '@/jobs/handlers/org62-readback';
import { RELAY_DONE_VAR } from '@/jobs/handlers/relay-guard';
import { configureVdpAesJob, resetVdpAesJobConfig, vdpAesJobDef } from '@/jobs/handlers/vdp-specialist-aes';
import { JobRegistry } from '@/jobs/registry';
import type { JobHandlerDef } from '@/jobs/types';
import { answerHold, DEFAULT_COSTS } from '@/llm/spend';
import { cancelSpendJob, dbSpendGovernor, requeueSpendJob, spendStartGate } from '@/server/datasource/db/spend';
import type { OneLookupResult } from '@/server/onboarding/identity';
import { WorkerRuntime } from '@/worker/runtime';

import { createUser, openTestDb, setUserSetting } from './helpers';

// ---- the handlers' loaders: placeholders in place of a seeded book
vi.mock('@/personas', async (orig) => ({ ...(await orig<typeof import('@/personas')>()), featureActive: () => true }));
vi.mock('@/server/datasource/db/store/persona', () => ({ loadPersona: async () => ({ connectors: ['org62'] }) }));
vi.mock('@/server/datasource/db/store/vdp', async (orig) => ({
  ...(await orig<typeof import('@/server/datasource/db/store/vdp')>()),
  loadGapEntities: async () => ({ opps: [], accounts: ['A', 'B', 'C'].map((x) => ({ org62AccountId: `001PLACEHOLD00${x}` })) }),
}));
vi.mock('@/server/vdp/specialist-aes', async (orig) => ({
  ...(await orig<typeof import('@/server/vdp/specialist-aes')>()),
  aeTargets: () => ['A', 'B', 'C'].map((x) => `006PLACEHOLD00${x}`),
  aeBatches: (ids: string[]) => ids.map((x) => [x]),
  parseSpecialistAes: () => new Map(),
}));
vi.mock('@/lib/accounts/hierarchy', async (orig) => ({
  ...(await orig<typeof import('@/lib/accounts/hierarchy')>()),
  isAccountId: () => true,
  hierarchyBatches: (ids: string[]) => ids.map((x) => [x]),
  parseHierarchyRecords: () => [],
}));
vi.mock('@/server/datasource/db/store/use-cases', async (orig) => ({
  ...(await orig<typeof import('@/server/datasource/db/store/use-cases')>()),
  ucReadOppIds: async () => Array.from({ length: 60 }, (_, i) => `006000000000${String(i).padStart(3, '0')}`), // three batches of 20
  saveOrg62UseCaseRead: async () => ({ written: 0, gone: 0, linked: 0 }),
}));
vi.mock('@/server/datasource/db/store/deals-sync', async (orig) => ({ ...(await orig<typeof import('@/server/datasource/db/store/deals-sync')>()), readbackOppIds: async () => [] }));
vi.mock('@/server/landings/db-sync', () => ({ syncLandingsForUser: async () => undefined }));
vi.mock('@/engines/attribution/discover', async (orig) => ({
  ...(await orig<typeof import('@/engines/attribution/discover')>()),
  oppsSoql: () => ['select placeholder 1', 'select placeholder 2', 'select placeholder 3'],
  parseDiscovered: () => undefined,
}));

let h: DbHandle;
let stranger: string;
beforeAll(async () => {
  h = openTestDb();
  // The suite's files share one database. Another file's leftover, a due `doctor.checks` on `maintenance`
  // (schedules.spec.ts), was once claimed first by the read-back's worker (older run_at), so the read-back job never
  // ran in that poll ("Flake: relay holds under load", 28-crash-resume.md). claimJobs now takes only the worker's
  // user's jobs, so each case runs on its kind's real queue, and a stranger's due job on every one is the guard.
  stranger = await createUser(h.db, 'relaystranger');
  for (const c of CASES) await enqueueJob(h.db, { ownerUserId: stranger, kind: 'doctor.checks', queue: c.def().queue, payload: {} });
});
afterAll(async () => {
  // the stranger's jobs are this file's leftovers now: nothing later in the suite should find them due
  await h.db.execute(sql`update jobs set status = 'cancelled', finished_at = now() where owner_user_id = ${stranger} and status = 'queued'`);
  resetVdpAesJobConfig();
  resetHierarchyJobConfig();
  resetOrg62ReadbackConfig();
  resetDiscoverJobConfig();
  await h.close();
});

async function user(label: string) {
  const userId = await createUser(h.db, label);
  await setUserSetting(h.db, userId, 'settings.budgets', { version: 1, softUsd: 7.5, hardUsd: 15, alertPct: 80, readinUsdPerDay: 2, triageEscalationUsdPerDay: 1, today: null, raises: [] });
  return userId;
}

const holdsOf = async (userId: string) => (await h.db.execute<{ id: string; state: string; job_key: string; scope: string; spent_usd: string; held_usd: string }>(sql`select id, state, job_key, scope, spent_usd::text, held_usd::text from spend_holds where user_id = ${userId} order by created_at`)).rows;
const asksOf = async (userId: string) => (await h.db.execute<{ resolved: boolean; message: string }>(sql`select resolved_at is not null as resolved, message from app_events where owner_user_id = ${userId} and code = 'SPEND.ASK' order by id`)).rows;
const jobsOf = async (userId: string, kind: string) => (await h.db.execute<{ id: string; status: string; hold: string | null; done: string | null; result: Record<string, unknown> | null }>(sql`select id::text, status, payload #>> '{vars,spendHoldId}' as hold, payload #>> ${`{vars,${RELAY_DONE_VAR}}`} as done, result from jobs where owner_user_id = ${userId} and kind = ${kind} order by jobs.id`)).rows;
const callsOf = async (userId: string) => (await h.db.execute<{ job_id: string; cost_usd: string }>(sql`select job_id::text, cost_usd::text from llm_calls where owner_user_id = ${userId} order by id`)).rows;

/** An Org62 read that answers an empty, complete result and costs `usd`. */
function fakeLookup(usd: number) {
  const calls: unknown[] = [];
  const lookup = (async (call: unknown) => {
    calls.push(call);
    return { text: JSON.stringify({ totalSize: 0, done: true, records: [] }), code: 'ok', message: '', costUsd: usd, inputTokens: 100, outputTokens: 10, model: 'claude-haiku-5-5', started: true } satisfies OneLookupResult;
  }) as never;
  return { lookup, calls };
}

/**
 * Each case: the lookups cost enough that the hold (the skill's row of the static table, no history yet) is passed
 * after two of them, so the third asks; the continuation reads what is left (`more` lookups).
 */
const CASES: Array<{ kind: string; skill: string; usd: number; more: number; payload: Record<string, unknown>; def: () => JobHandlerDef; configure: (lookup: never) => void }> = [
  { kind: 'vdp.specialist_aes', skill: 'vdp-specialist-aes', usd: 0.012, more: 1, payload: {}, def: vdpAesJobDef, configure: (lookup) => configureVdpAesJob({ lookup, live: true }) },
  { kind: 'accounts.hierarchy', skill: 'accounts-hierarchy', usd: 0.02, more: 1, payload: {}, def: hierarchyJobDef, configure: (lookup) => configureHierarchyJob({ lookup, live: true }) },
  // the continuation reads on from the batch the first leg stopped at (vars.relayDone = 2): one use-case batch left
  { kind: 'org62.readback', skill: 'org62-readback', usd: 0.04, more: 1, payload: { trigger: 'manual' }, def: () => org62ReadbackJobDef(), configure: (lookup) => configureOrg62Readback({ lookup, live: true }) },
  // discovery runs again in full (bounded by its 20 lookups a day)
  { kind: 'org62.discover', skill: 'org62-discover', usd: 0.03, more: 3, payload: { trigger: 'manual' }, def: org62DiscoverJobDef, configure: (lookup) => configureDiscoverJob({ lookup, live: true }) },
];

function workerFor(userId: string, def: JobHandlerDef) {
  const registry = new JobRegistry();
  registry.register(def);
  return new WorkerRuntime({ db: h.db, userId, workerId: `test:${process.pid}:${randomUUID()}`, registry, services: {}, pools: [{ name: def.queue, queues: [def.queue], concurrency: 1 }], listenUrl: null, log: () => {}, startGate: spendStartGate(h.db, userId) });
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

describe.each(CASES)('$kind: one hold per relay job (db, worker)', (c) => {
  const heldUsd = DEFAULT_COSTS.relay.skills![c.skill]!.p90;

  it('one hold (the gate’s), N lookups booked once, one ask; Allow continues on the same hold and settles it', async () => {
    const userId = await user(`relay${c.skill}`);
    const { lookup, calls } = fakeLookup(c.usd);
    c.configure(lookup);
    const def = c.def();
    const worker = workerFor(userId, def);
    const first = await enqueueJob(h.db, { ownerUserId: userId, kind: c.kind, queue: def.queue, payload: c.payload });
    await worker.pollOnce();
    await worker.idle();

    expect(calls).toHaveLength(2); // the third lookup found the hold passed and asked instead
    const holds = await holdsOf(userId);
    expect(holds).toHaveLength(1); // the gate's; no hold per lookup
    expect(holds[0]).toMatchObject({ state: 'asked', scope: 'relay', job_key: `${c.kind}:${first.id}` });
    expect(Number(holds[0]!.held_usd)).toBeCloseTo(heldUsd, 6);
    expect(Number(holds[0]!.spent_usd)).toBeCloseTo(2 * c.usd, 6); // the job's spend, reported once
    const asks = await asksOf(userId);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.resolved).toBe(false);
    expect(asks[0]!.message).toMatch(/^This lookup has used \$[\d.]+ of its \$[\d.]+ estimate( and is \d+% done)?; allow \$[\d.]+ more\?$/);
    expect((await callsOf(userId)).map((x) => [x.job_id, Number(x.cost_usd)])).toEqual([
      [String(first.id), c.usd],
      [String(first.id), c.usd],
    ]);
    const jobs = await jobsOf(userId, c.kind);
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'queued']);
    expect(jobs[0]!.result).toMatchObject({ paused: 'spend', holdId: holds[0]!.id, queued: true });
    expect(jobs[1]).toMatchObject({ hold: holds[0]!.id, done: '2' });

    // Allow $0.20 more: the continuation runs now, on the same hold (the gate takes none for it), and settles it
    const gov = dbSpendGovernor({ db: h.db, userId });
    await answerHold(gov, holds[0]!.id, { answer: 'approve', usd: 0.2 }, { requeue: async (x) => void (await requeueSpendJob(h.db, userId, x.id)) });
    await worker.pollOnce();
    await worker.idle();
    expect(calls).toHaveLength(2 + c.more);
    const after = await holdsOf(userId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: holds[0]!.id, state: 'settled' });
    expect(Number(after[0]!.spent_usd)).toBeCloseTo(round6((2 + c.more) * c.usd), 6);
    expect(await asksOf(userId)).toEqual([expect.objectContaining({ resolved: true })]);
    expect((await callsOf(userId)).map((x) => Number(x.cost_usd))).toEqual(Array.from({ length: 2 + c.more }, () => c.usd));
    const done = await jobsOf(userId, c.kind);
    expect(done.map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
    expect(done[1]!.result).not.toHaveProperty('paused');
  });

  it('Stop cancels the waiting continuation; nothing more runs or is paid', async () => {
    const userId = await user(`relaystop${c.skill}`);
    const { lookup, calls } = fakeLookup(c.usd);
    c.configure(lookup);
    const def = c.def();
    const worker = workerFor(userId, def);
    await enqueueJob(h.db, { ownerUserId: userId, kind: c.kind, queue: def.queue, payload: c.payload });
    await worker.pollOnce();
    await worker.idle();
    const [hold] = await holdsOf(userId);
    expect(hold!.state).toBe('asked');

    await answerHold(dbSpendGovernor({ db: h.db, userId }), hold!.id, { answer: 'deny' }, { cancel: async (x) => void (await cancelSpendJob(h.db, userId, x.id)) });
    expect((await jobsOf(userId, c.kind)).map((j) => j.status)).toEqual(['succeeded', 'cancelled']);
    await worker.pollOnce();
    await worker.idle();
    expect(calls).toHaveLength(2);
    expect(await holdsOf(userId)).toEqual([expect.objectContaining({ id: hold!.id, state: 'denied' })]);
    expect((await callsOf(userId)).map((x) => Number(x.cost_usd))).toEqual([c.usd, c.usd]);
  });
});

it('a relay worker never claims another user’s due job on the real queues (the suite shares one database)', async () => {
  const r = await h.db.execute<{ status: string }>(sql`select status from jobs where owner_user_id = ${stranger} order by id`);
  expect(r.rows.map((x) => x.status)).toEqual(CASES.map(() => 'queued'));
});
