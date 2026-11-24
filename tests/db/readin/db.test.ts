/**
 * BE-READIN on Postgres (the real path, with a scripted SDK in place of the model):
 * triggers dedupe, new evidence supersedes and cancels a running read-in, the budget stops at the cap (and the spend
 * is recorded), a non-allowlisted tool aborts the job, the suggested reply is an Outbox draft that is never sent,
 * and the state machine as the UI sees it (DbDataSource routes + readInState on items).
 *
 * Database: control_center_readin_<CC_TEST_DB_SUFFIX> (tests/db/readin/db-setup.ts), placeholder example seed.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from '../../support/pg';

import type { ReadInEntity } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import type { Db, DbHandle } from '../../../src/db/client';
import { claimJobs, recordNewInfo } from '../../../src/db/queue';
import { configureReadIn, readInJobDef } from '../../../src/jobs/handlers/readin';
import { completeJob } from '../../../src/jobs/queue-ops';
import { JobRegistry } from '../../../src/jobs/registry';
import { SdkResearchAgent } from '../../../src/llm/readin/agent';
import { planReadIns, readInCandidates } from '../../../src/llm/readin/planner';
import { emptyReadIn } from '../../../src/llm/readin/state';
import { DbDataSource } from '../../../src/server/datasource/db';
import { uuidFor } from '../../../src/server/datasource/db/ids';
import { commitReadIn, enqueueReadIn, getReadInDb, setJobProgress } from '../../../src/server/datasource/db/readin';
import { WorkerRuntime } from '../../../src/worker/runtime';

import { freshReadInDb, READIN_TEST_URL } from './db-setup';
import { fakeQuery, finishInput, SLACK_THREAD_RESULT, T } from '../../readin/fake-sdk';


let handle: DbHandle;
let db: Db;
let userId: string;
let ds: DbDataSource;
let runtime: WorkerRuntime | null = null;

const item = (seedId: string): ReadInEntity => ({ type: 'work_item', id: uuidFor(seedId) });
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
const google = { call: async () => 'Found 0 messages', health: async () => ({ state: 'ok' as const, checkedAt: new Date().toISOString() }) };
const external = () => ({ servers: {}, tools: [T.slackRead, T.slackSearch, T.soql], unavailable: [] });
const goodSteps = [{ tool: T.ledger, input: { text: 'Dana pricing' } }, { tool: T.slackRead, input: { channel_id: 'C0ACME0001', message_ts: '1793893334.322509' }, result: SLACK_THREAD_RESULT }, { tool: T.finish, input: finishInput() }];
const agent = (o: Parameters<typeof fakeQuery>[0]) => new SdkResearchAgent({ queryFn: fakeQuery(o) });

async function waitFor<X>(fn: () => Promise<X | undefined | null | false>, ms = 30_000): Promise<X> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as X;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function jobsFor(e: ReadInEntity) {
  return rows<{ id: string; status: string; generation: string | null; priority: number; cancel_requested_at: string | null; last_error_code: string | null; result: Record<string, unknown> | null }>(
    await db.execute(sql`select id, status, generation, priority, cancel_requested_at, last_error_code, result from jobs where dedupe_key = ${`readin:${e.type}:${e.id}`} order by id`),
  );
}

async function bump(e: ReadInEntity): Promise<number> {
  const { result } = await withChangeSet({ db, userId, actor: actors.engine('test@1'), reason: 'new evidence (test)' }, (tx) => recordNewInfo(tx, e.id));
  return result.generation;
}

async function asSystem(reason: string, fn: (tx: Parameters<Parameters<typeof withChangeSet>[1]>[0]) => Promise<unknown>) {
  await withChangeSet({ db, userId, actor: actors.system('test'), reason }, async (tx) => void (await fn(tx)));
}

/** Settle the queue between tests: nothing left running, nothing queued. */
async function cancelQueued() {
  await db.execute(sql`update jobs set status = 'cancelled', finished_at = now() where kind = 'readin.generate' and status = 'queued'`);
  await waitFor(async () => rows(await db.execute(sql`select 1 from jobs where kind = 'readin.generate' and status = 'running'`)).length === 0);
}

function startRuntime(): WorkerRuntime {
  const registry = new JobRegistry().register(readInJobDef());
  runtime = new WorkerRuntime({ db, userId, workerId: `readin-test:${randomUUID().slice(0, 8)}`, registry, services: {}, pools: [{ name: 'readin', queues: ['readin'], concurrency: 1 }], listenUrl: READIN_TEST_URL, log: (m, d) => (process.env.READIN_TEST_DEBUG ? console.log('[rt]', m, JSON.stringify(d ?? {})) : undefined), drainMs: 300, leaseSeconds: 60 });
  return runtime;
}

beforeAll(async () => {
  if (!pgAvailable) return;
  process.env.CC_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-readin-state-')); // no private voice profile in tests
  ({ handle, userId } = await freshReadInDb());
  db = handle.db;
  ds = new DbDataSource({ handle, userId });
  configureReadIn({ google: () => google, external, enabled: () => true, generationPollMs: 1e6 });
});

afterAll(async () => {
  await runtime?.stop('test done').catch(() => undefined);
  await ds?.dispose();
  await handle?.close();
});

describe.skipIf(!pgAvailable)('triggers', () => {
  it('top-N items are planned once: a second plan merges into the queued jobs (dedupe per entity)', async () => {
    const first = await planReadIns(db, userId);
    expect(first.skipped).toBeNull();
    const top = first.enqueued.filter((e) => e.trigger === 'top_rank');
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(5);
    expect(new Set(first.enqueued.map((e) => e.jobId)).size).toBe(first.enqueued.length);
    const second = await planReadIns(db, userId);
    expect(second.enqueued.every((e) => e.action === 'merged')).toBe(true);
    for (const e of top) {
      const js = await jobsFor(e.entity);
      expect(js.filter((j) => j.status === 'queued')).toHaveLength(1);
    }
    // Claim order follows the rank: priorities strictly decrease down the top N.
    const prios = await Promise.all(top.map(async (e) => (await jobsFor(e.entity))[0]!.priority));
    expect([...prios].sort((a, b) => b - a)).toEqual(prios);
    await cancelQueued();
  });

  it('a new direct ask of me (DM / mention / email to me) is a trigger', async () => {
    const [cand] = rows<{ id: string; sid: string }>(
      await db.execute(sql`
        select w.id, e.source_item_id as sid from work_items w join work_item_evidence e on e.work_item_id = w.id and e.role = 'origin' and e.source_item_id is not null
         where w.owner_user_id = ${userId} and w.status = 'open' and w.kind not in ('training', 'travel') order by w.priority_rank desc nulls first limit 1`),
    );
    expect(cand).toBeTruthy();
    await asSystem('an old ask, backfilled now (test)', async (tx) => {
      await tx.execute(sql`update source_items set addressed_to_me = true, from_me = false, occurred_at = now() - interval '10 days' where id = ${cand!.sid}`);
      await tx.execute(sql`update work_items set created_at = now() - interval '1 hour' where id = ${cand!.id}`);
    });
    // MIN-8: a first-scan backfill creates the item now, but the ask is ten days old: no automatic read-in.
    expect((await readInCandidates(db, userId)).find((x) => x.entity.id === cand!.id && x.trigger === 'direct_ask')).toBeUndefined();
    await asSystem('the ask is recent (test)', (tx) => tx.execute(sql`update source_items set occurred_at = now() - interval '2 hours' where id = ${cand!.sid}`));
    const c = await readInCandidates(db, userId);
    expect(c.find((x) => x.entity.id === cand!.id)).toMatchObject({ trigger: 'direct_ask' });
  });

  it('a meeting in the next 24 h with open prep is a trigger', async () => {
    const [ev] = rows<{ id: string }>(await db.execute(sql`select id from calendar_events where owner_user_id = ${userId} order by starts_at limit 1`));
    const [w] = rows<{ id: string }>(await db.execute(sql`select id from work_items where owner_user_id = ${userId} and status = 'open' order by created_at limit 1`));
    await asSystem('meeting soon (test)', async (tx) => {
      await tx.execute(sql`update calendar_events set starts_at = now() + interval '3 hours', ends_at = now() + interval '4 hours', status = 'confirmed', my_response = 'accepted', is_all_day = false where id = ${ev!.id}`);
      await tx.execute(sql`update work_items set deadline_event_id = ${ev!.id} where id = ${w!.id}`);
    });
    const c = await readInCandidates(db, userId);
    expect(c.find((x) => x.entity.type === 'calendar_event' && x.entity.id === ev!.id)).toMatchObject({ trigger: 'meeting_prep' });
    expect((await ds.getReadIn({ params: { type: 'calendar_event', id: ev!.id } })).readIn).toBeNull();
  });
});

describe.skipIf(!pgAvailable)('the read-in job (real path, scripted SDK)', () => {
  it('Read me in → researching → ready; the reply is an Outbox draft that is never sent; spend is recorded', async () => {
    await cancelQueued();
    const e = item('w_dana_reply');
    configureReadIn({ agent: agent({ steps: goodSteps, costUsd: 0.04 }) });
    const draftsBefore = Number(rows<{ n: string }>(await db.execute(sql`select count(*) as n from drafts where work_item_id = ${e.id}`))[0]!.n);
    const req = await ds.requestReadIn({ params: e, body: { force: false } });
    expect(req.entity.state).toBe('queued');
    expect(req.auditId).toBeNull();
    const w = startRuntime();
    await w.start();
    await w.pollOnce();
    const done = await waitFor(async () => {
      const p = await ds.getReadIn({ params: e });
      return p.readIn?.state === 'ready' ? p.readIn : null;
    });
    expect(done.tldr).toMatch(/pricing/);
    expect(done.background[0]!.source?.url).toBe('https://example.slack.com/archives/C0ACME0001/p1793893334322509');
    expect(done.background.some((b) => b.text.includes('abcd1234efgh5678ijkl'))).toBe(false);
    expect(done.background[1]!.source?.url).toBeUndefined(); // an invented link is dropped
    expect(done.costUsd).toBe(0.04);
    expect(done.skillVersion).toBe('readin-ask@2');
    // the suggested reply: a new drafts row, ready (pending approval), created by the engine, never dispatched
    const draftId = done.suggestedReply!.draftId;
    const [d] = rows<{ status: string; created_by: string; delivery_mode: string; work_item_id: string; channel: string }>(await db.execute(sql`select status, created_by, delivery_mode, work_item_id, channel from drafts where id = ${draftId}`));
    expect(d).toMatchObject({ status: 'ready', created_by: 'engine', delivery_mode: 'stage', work_item_id: e.id, channel: 'slack' });
    expect(Number(rows<{ n: string }>(await db.execute(sql`select count(*) as n from drafts where work_item_id = ${e.id}`))[0]!.n)).toBe(draftsBefore + 1);
    expect(rows(await db.execute(sql`select 1 from draft_send_attempts where draft_id = ${draftId}`))).toHaveLength(0);
    expect(rows(await db.execute(sql`select 1 from jobs where kind like 'outbox%' or (payload->>'draft_id') = ${draftId}`))).toHaveLength(0);
    const draft = await ds.getDraft({ params: { id: draftId } });
    expect(draft.status).toBe('ready');
    expect(draft.plainText).toMatch(/Sam will walk through pricing/);
    // spend
    const [spend] = rows<{ skill_key: string; cost_usd: string; purpose: string; model_tier: string; job_id: string }>(await db.execute(sql`select skill_key, cost_usd, purpose, model_tier, job_id from llm_calls where skill_key like 'readin-%' order by id desc limit 1`));
    expect(spend).toMatchObject({ skill_key: 'readin-ask', purpose: 'summarize', model_tier: 'sonnet' });
    expect(Number(spend!.cost_usd)).toBeCloseTo(0.04, 6);
    // readInState rides on list and detail payloads
    expect((await ds.getItem({ params: { id: e.id } })).item.readInState).toBe('ready');
    const list = await ds.listItems({ query: { tab: 'all_open' } } as never);
    expect(list.items.find((x) => x.id === e.id)?.readInState).toBe('ready');
    // new evidence → stale (with a reason); a ready read-in for the current generation is not re-run
    await bump(e);
    const stale = (await ds.getReadIn({ params: e })).readIn!;
    expect(stale.state).toBe('stale');
    expect(stale.staleReason).toMatch(/new/i);
    // Regenerate replaces the untouched read-in draft (the old one is discarded, not sent)
    configureReadIn({ agent: agent({ steps: goodSteps, costUsd: 0.03 }) });
    await ds.requestReadIn({ params: e, body: { force: true } });
    await w.pollOnce();
    const again = await waitFor(async () => {
      const p = await ds.getReadIn({ params: e });
      return p.readIn?.state === 'ready' && p.readIn.suggestedReply?.draftId !== draftId ? p.readIn : null;
    });
    expect(rows<{ status: string }>(await db.execute(sql`select status from drafts where id = ${draftId}`))[0]!.status).toBe('discarded');
    expect(again.generation).toBeGreaterThan(done.generation);
  });

  it('new evidence supersedes and cancels a running read-in; the restart researches the new generation', async () => {
    await cancelQueued();
    const e = item('w_nce_capture');
    let blocked!: () => void;
    const isBlocked = new Promise<void>((r) => (blocked = r));
    configureReadIn({ agent: agent({ steps: goodSteps, blockAfter: 1, onBlocked: () => blocked() }) });
    const before = (await jobsFor(e)).length; // earlier planner jobs for this item (cancelled) stay out of the picture
    const mine = async () => (await jobsFor(e)).slice(before);
    await ds.requestReadIn({ params: e, body: { force: false } });
    const w = runtime ?? startRuntime();
    await w.pollOnce();
    await isBlocked;
    const [j1] = await mine();
    expect(j1!.status).toBe('running');
    expect((await ds.getReadIn({ params: e })).readIn?.state).toBe('researching');
    const g1 = await bump(e);
    configureReadIn({ agent: agent({ steps: goodSteps, costUsd: 0.02 }) });
    const plan = await planReadIns(db, userId, { topN: 0, horizonHours: 0, directAskWindowHours: 0 }); // only the supersede pass
    expect(plan.enqueued.find((x) => x.entity.id === e.id)?.action).toBe('superseded');
    await waitFor(async () => (await mine())[0]!.status === 'cancelled');
    await w.pollOnce();
    const r = await waitFor(async () => {
      const p = await ds.getReadIn({ params: e });
      return p.readIn?.state === 'ready' ? p.readIn : null;
    });
    expect(r.generation).toBe(g1);
    const js = await waitFor(async () => {
      const x = await mine();
      return x.every((j) => j.status !== 'running' && j.status !== 'queued') ? x : null;
    });
    expect(js.map((j) => j.status)).toEqual(['cancelled', 'succeeded']);
    expect(Number(js[1]!.generation)).toBe(g1);
  });

  it('a tool outside the read-only allowlist aborts the job (dead-lettered, nothing drafted)', async () => {
    await cancelQueued();
    const e = item('w_priya_forecast');
    const before = Number(rows<{ n: string }>(await db.execute(sql`select count(*) as n from drafts where work_item_id = ${e.id}`))[0]!.n);
    configureReadIn({ agent: agent({ steps: [{ tool: T.ledger, input: { text: 'Priya' } }, { tool: T.slackSend, input: { channel_id: 'C0ACME0001', message: 'hi' } }, { tool: T.finish, input: finishInput() }] }) });
    await ds.requestReadIn({ params: e, body: { force: false } });
    const w = runtime ?? startRuntime();
    await w.pollOnce();
    const j = await waitFor(async () => {
      const x = (await jobsFor(e)).at(-1); // the newest job (earlier planner jobs were cancelled)
      return x && x.status === 'dead' ? x : null;
    });
    expect(j.last_error_code).toBe('disallowed_tool');
    const r = (await ds.getReadIn({ params: e })).readIn!;
    expect(r.state).toBe('failed');
    expect(r.error).toMatchObject({ code: 'disallowed_tool', retryable: false });
    expect(Number(rows<{ n: string }>(await db.execute(sql`select count(*) as n from drafts where work_item_id = ${e.id}`))[0]!.n)).toBe(before);
  });

  it('the state machine as the UI sees it: none → queued → researching (progress) → ready → stale → queued', async () => {
    await runtime?.stop('switch to manual claims');
    runtime = null;
    await cancelQueued();
    const e = item('w_acme_onepager');
    expect((await ds.getReadIn({ params: e })).readIn).toBeNull();
    expect((await ds.requestReadIn({ params: e, body: { force: false } })).entity.state).toBe('queued');
    expect((await ds.requestReadIn({ params: e, body: { force: false } })).entity.state).toBe('queued'); // deduped
    expect((await jobsFor(e)).filter((j) => j.status === 'queued')).toHaveLength(1);
    const [c] = await claimJobs({ db, ownerUserId: userId, workerId: 'manual', queues: ['readin'], limit: 1 });
    expect(c!.dedupe_key).toBe(`readin:work_item:${e.id}`);
    await setJobProgress(db, Number(c!.id), { step: 'gmail', label: 'Searching email', done: 2, total: 6 });
    expect((await ds.getReadIn({ params: e })).readIn).toMatchObject({ state: 'researching', progress: { step: 'gmail', label: 'Searching email' } });
    expect((await ds.getItem({ params: { id: e.id } })).item.readInState).toBe('researching');
    const gen = Number(c!.generation);
    const content = { ...emptyReadIn(e, new Date().toISOString()), state: 'ready' as const, tldr: 'Placeholder ask', generation: gen, generatedAt: new Date().toISOString() };
    await commitReadIn(db, userId, { entity: e, jobId: Number(c!.id), readIn: content, outcome: 'ready', fenceGeneration: gen });
    await completeJob(db, Number(c!.id), 'manual', { draftId: null });
    expect((await getReadInDb(db, userId, e)).readIn?.state).toBe('ready');
    await bump(e);
    expect((await ds.getReadIn({ params: e })).readIn?.state).toBe('stale');
    const refresh = await ds.requestReadIn({ params: e, body: { force: false } });
    expect(refresh.entity).toMatchObject({ state: 'queued', tldr: 'Placeholder ask' }); // older content stays visible
    // a stale commit (generation moved on) is fenced: it writes nothing
    const fenced = await commitReadIn(db, userId, { entity: e, jobId: 1, readIn: { ...content, tldr: 'stale write' }, outcome: 'ready', fenceGeneration: gen });
    expect(fenced).toMatchObject({ committed: false, reason: 'superseded' });
    await cancelQueued();
  });
});

describe.skipIf(!pgAvailable)('D2: the model per trigger, and no second read-in of unchanged evidence', () => {
  it('an automatic read-in runs on the light model with its trigger and reason booked; unchanged evidence is skipped and recorded', async () => {
    await cancelQueued();
    const e = item('w_umbrella_deck');
    configureReadIn({ agent: agent({ steps: goodSteps, costUsd: 0.01 }) });
    const q = await enqueueReadIn(db, userId, e, { trigger: 'top_rank', priority: 50 });
    expect(q.action).toBe('queued');
    const w = startRuntime();
    await w.start();
    await w.pollOnce();
    const first = await waitFor(async () => {
      const p = await ds.getReadIn({ params: e });
      return p.readIn?.state === 'ready' ? p.readIn : null;
    });
    expect(first.model).toBe('claude-haiku-5-5');
    expect(first.evidenceHash).toMatch(/^[0-9a-f]{32}$/);
    const [call] = rows<{ model: string; trigger: string; model_reason: string; content_hash: string | null; outcome: string }>(
      await db.execute(sql`select model, trigger, model_reason, content_hash, outcome from llm_calls where skill_key = 'readin-ask' and job_id = ${q.jobId} order by id desc limit 1`),
    );
    expect(call).toMatchObject({ model: 'claude-haiku-5-5', trigger: 'top_rank', model_reason: 'policy:top_rank', outcome: 'ready' });
    expect(call!.content_hash).toMatch(/^[0-9a-f]{32}$/);
    // a new generation whose evidence the read-in already saw (a ranking or status bump): no second research
    await bump(e);
    const callsBefore = rows(await db.execute(sql`select 1 from llm_calls where skill_key = 'readin-ask'`)).length;
    const again = await enqueueReadIn(db, userId, e, { trigger: 'top_rank', priority: 50 });
    expect(again.action).toBe('queued');
    await w.pollOnce();
    const j = await waitFor(async () => {
      const x = (await jobsFor(e)).at(-1);
      return x && x.status === 'succeeded' ? x : null;
    });
    expect(j.result).toMatchObject({ skipped: 'evidence_unchanged' });
    expect(rows(await db.execute(sql`select 1 from llm_calls where skill_key = 'readin-ask'`)).length).toBe(callsBefore);
    const [d] = rows<{ kind: string; reason: string; trigger: string; subject: string; count: number }>(
      await db.execute(sql`select kind, reason, trigger, subject, count from llm_decisions where skill_key = 'readin-ask' and reason = 'evidence_unchanged' and subject = ${`work_item:${e.id}`}`),
    );
    expect(d).toMatchObject({ kind: 'skip', trigger: 'top_rank', count: 1 });
    // the read-in is current for the new generation (the planner stops asking), its content unchanged
    const now = (await ds.getReadIn({ params: e })).readIn!;
    expect(now.tldr).toBe(first.tldr);
    expect(now.generation).toBeGreaterThan(first.generation);
    // the user asking always researches, on the strong model
    configureReadIn({ agent: agent({ steps: goodSteps, costUsd: 0.02 }) });
    await ds.requestReadIn({ params: e, body: { force: true } });
    await w.pollOnce();
    await waitFor(async () => rows(await db.execute(sql`select 1 from llm_calls where skill_key = 'readin-ask'`)).length > callsBefore);
    const [asked] = rows<{ model: string; trigger: string; model_reason: string }>(await db.execute(sql`select model, trigger, model_reason from llm_calls where skill_key = 'readin-ask' order by id desc limit 1`));
    expect(asked).toMatchObject({ model: 'claude-sonnet-5-5', trigger: 'on_demand', model_reason: 'user_asked' });
  });
});

describe.skipIf(!pgAvailable)('budget', () => {
  it('automatic read-ins stop at the daily read-in cap; on-demand may pass it but never the hard cap', async () => {
    await cancelQueued();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: rows<{ tz: string }>(await db.execute(sql`select timezone as tz from users where id = ${userId}`))[0]!.tz }).format(new Date());
    await db.execute(sql`insert into llm_calls (owner_user_id, purpose, model, model_tier, skill_key, request_hash, status, cost_usd, budget_day)
                         values (${userId}, 'summarize', 'claude-sonnet-5-5', 'sonnet', 'readin-ask', ${`test:${randomUUID()}`}, 'ok', 2.5, ${day}::date)`);
    const plan = await planReadIns(db, userId);
    expect(plan.skipped).toBe('budget');
    expect(plan.enqueued).toHaveLength(0);
    // An automatic job that was already queued is skipped quietly when it reaches the front.
    const e = item('w_globex_sow');
    const q = await enqueueReadIn(db, userId, e, { trigger: 'top_rank', priority: 50 });
    expect(q.action).toBe('queued');
    configureReadIn({ agent: agent({ steps: goodSteps, costUsd: 0.05 }) });
    const w = startRuntime();
    await w.start();
    await w.pollOnce();
    const j = await waitFor(async () => {
      const x = (await jobsFor(e)).at(-1); // the newest job (earlier planner jobs were cancelled)
      return x && x.status === 'succeeded' ? x : null;
    });
    expect(j.result).toMatchObject({ skipped: 'budget' });
    expect((await ds.getReadIn({ params: e })).readIn).toMatchObject({ state: 'failed', error: { code: 'budget' } });
    // An automatic re-trigger does not loop on it.
    expect((await enqueueReadIn(db, userId, e, { trigger: 'top_rank', priority: 50 })).action).toBe('failed_recently');
    // On-demand: allowed past the read-in line (explicit), inside the hard cap.
    await ds.requestReadIn({ params: e, body: { force: false } });
    await w.pollOnce();
    await waitFor(async () => (await ds.getReadIn({ params: e })).readIn?.state === 'ready');
    // Hard cap: nothing runs, on-demand included.
    await asSystem('tight hard cap (test)', (tx) => tx.execute(sql`update user_settings set value = value || '{"hardUsd": 1}'::jsonb where owner_user_id = ${userId} and key = 'settings.budgets'`));
    await ds.requestReadIn({ params: e, body: { force: true } });
    await w.pollOnce();
    const hard = await waitFor(async () => {
      const js = await jobsFor(e);
      const last = js.at(-1)!;
      return last.status === 'succeeded' && last.result?.skipped ? last : null;
    });
    expect(hard.result).toMatchObject({ skipped: 'hard_cap' });
    expect((await ds.getReadIn({ params: e })).readIn).toMatchObject({ state: 'ready', error: { code: 'hard_cap' } }); // older content kept
  });
});
