/**
 * Crash-resume drill (holistic review 2026-11-20, ask #14; report 28-crash-resume.md). A real worker process runs a
 * three-page scan against Postgres with a fake mail source and a fake classifier that spends money, and is killed
 * hard (SIGKILL) at one point of the run. A new worker then starts on the same database, as launchd would restart it.
 * Whatever the point: no run stays `running`, nothing is lost or duplicated, the watermark never passes data that was
 * not written, spend already booked stays booked once, and Health says in plain words what happened.
 *
 * Own database: control_center_crashdrill_<CC_TEST_DB_SUFFIX>. The child is tests/db/worker/crash-child.ts.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '@/db/client';
import { runMigrations } from '@/db/migrate';
import { enqueueJob } from '@/db/queue';
import { reapExpiredLeases } from '@/jobs/queue-ops';
import { JobRegistry } from '@/jobs/registry';
import { JobError } from '@/jobs/types';
import { stateWriteFailed } from '@/scanner/runtime/state-write';
import { DbScannerStore } from '@/scanner/store-db';
import { installDbTraceSink } from '@/scanner/trace';
import { dbSpendGovernor, spendStartGate } from '@/server/datasource/db/spend';
import { watchStateWrites } from '@/worker/health-events';
import { recoverInterruptedWork } from '@/worker/recovery';
import { WorkerRuntime } from '@/worker/runtime';

import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';
import { CALL_USD, drillFacts, drillItems, drillWorker, H, iso, NOW, SDK_KILL_TURN, T0, TURN_USD, turnsOfPage, workerIdOf, type DrillPoint } from './crash-drill';

const NAME = `control_center_crashdrill_${testDbSuffix}`;
const CHILD = path.resolve(__dirname, 'crash-child.ts');
let url = '';
let h: DbHandle;

beforeAll(async () => {
  if (!pgAvailable) return;
  url = await freshDb(NAME);
  await runMigrations({ url, log: () => {} });
  h = createDb({ url, max: 6, applicationName: 'crash-drill' });
  installDbTraceSink(h.db, { flushMs: 50 });
});

// jobs claim by queue, not by user: one drill's leftovers must not run under the next one
beforeEach(async () => {
  if (!pgAvailable) return;
  await h.db.execute(sql`update jobs set status = 'cancelled', finished_at = now(), lease_expires_at = null where status in ('queued', 'running')`);
});

afterAll(async () => {
  if (!pgAvailable) return;
  await h?.close();
  await dropDb(NAME);
});

/** A user whose Gmail inbox was read up to T0 (the cursor), with one standing work item the scan links to. */
async function seed(label: string): Promise<{ userId: string; standingItemId: string }> {
  const db = h.db;
  const u = await db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values (${`${label}-${Date.now()}@example.com`}, 'Drill Example', 'America/Denver') returning id`);
  const userId = u.rows[0]!.id;
  const store = new DbScannerStore({ db, userId, clock: () => new Date(T0) });
  const { runId } = await store.startRun({ scope: { connector: 'gmail', scope: 'inbox' }, trigger: 'schedule', window: { from: iso(T0 - H), to: iso(T0) } });
  const [rec] = await store.recordSourceItems(runId, [{ connector: 'gmail', kind: 'email', externalId: 'standing-1', dedupeKey: 'gmail:standing-1', contentHash: 'standing-1', occurredAt: iso(T0 - 30 * 60_000), title: 'Standing thread', author: { name: 'Example Person', email: 'person@example.com', isMe: false, isExternal: true } }]);
  const { workItemId } = await store.proposeItem(runId, { kind: 'task', title: 'Standing item', confidence: 'sure', evidence: [{ sourceItemId: rec!.sourceItemId, role: 'origin', reason: 'seed' }] });
  await store.reportCoverage(runId, [{ kind: 'mailbox_range', ref: 'gmail:inbox', from: iso(T0 - H), to: iso(T0) }]);
  await store.finishRun(runId, { cursor: { value: '{}', at: iso(T0) }, stats: { fetched: 1, new: 1, changed: 0, linked: 0, proposed: 1, unlinked: 0, costUsd: 0 } });
  // the seed's own re-evaluation is not what the drill looks for
  await db.execute(sql`delete from jobs where owner_user_id = ${userId}`);
  return { userId, standingItemId: workItemId };
}

/** Run the drill worker in a child process and let it kill itself at `point` on `page`. */
function runChild(env: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], { cwd: path.resolve(__dirname, '../../..'), env: { ...process.env, DATABASE_URL: url, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

/** The next start of the worker, as src/worker/index.ts runs it: recovery, stale plans dropped, reap, plan, then work. */
async function restart(userId: string, standingItemId: string, runner?: 'fti' | 'agentic') {
  const d = drillWorker({ db: h.db, userId, standingItemId, ...(runner ? { runner } : {}) });
  const recovered = await recoverInterruptedWork({ db: h.db, userId, workerId: d.worker['o'].workerId, store: d.store, clock: () => d.clock.now() });
  await d.scanning.dropStalePlans();
  await d.worker.reap();
  await d.plan();
  await d.drain();
  return { d, recovered };
}

const POINTS: Array<{ point: DrillPoint; page: number; what: string; runInterrupted: boolean }> = [
  { point: 'run_started', page: 1, what: '(a) after the run row is created, before the first page', runInterrupted: true },
  { point: 'items_staged', page: 2, what: '(b) mid-page: items written, the watermark not advanced', runInterrupted: true },
  { point: 'after_commit', page: 1, what: '(c) after the watermark committed, before re-evaluations and the next page are queued', runInterrupted: false },
  { point: 'llm_spent', page: 2, what: '(d) during classification, after a paid model call', runInterrupted: true },
  { point: 'finish_tx', page: 2, what: '(e) inside the finish step (the commit transaction)', runInterrupted: true },
  { point: 'job_complete', page: 2, what: '(e) after the run finished, before its job row is marked done', runInterrupted: false },
];

describe.skipIf(!pgAvailable)('crash-resume drill: the worker is killed mid-scan and started again (db)', () => {
  for (const p of POINTS) {
    it(`${p.what}: nothing lost, duplicated or stuck; Health says what happened`, async () => {
      const { userId, standingItemId } = await seed(p.point);
      const deadWorker = workerIdOf(999_999); // a pid no process has: the worker the kill leaves behind
      const r = await runChild({ DRILL_USER: userId, DRILL_STANDING: standingItemId, DRILL_POINT: p.point, DRILL_PAGE: String(p.page), DRILL_WORKER_ID: deadWorker });
      expect(r.signal, r.stderr).toBe('SIGKILL');

      const before = await drillFacts(h.db, userId);
      if (p.runInterrupted) expect(before.runs.some((x) => x.status === 'running')).toBe(true);
      expect(before.jobs.some((j) => j.status === 'running')).toBe(true);
      // the watermark never passes what was written: every message before the cursor is stored and has its ask
      const behind = drillItems().filter((x) => Date.parse(x.occurredAt) < Date.parse(before.cursorAt ?? iso(T0)));
      expect(before.items.distinct_keys).toBeGreaterThanOrEqual(behind.length);
      for (const x of behind) expect(before.asks.map((a) => a.title)).toContain(`Send ${x.title}`);

      const { d, recovered } = await restart(userId, standingItemId);
      const f = await drillFacts(h.db, userId);

      // never stuck: no run and no job stays running; the interrupted run is closed as cancelled, with why
      expect.soft(f.runs.filter((x) => x.status === 'running')).toEqual([]);
      expect.soft(f.jobs.filter((j) => j.status === 'running')).toEqual([]);
      if (p.runInterrupted) {
        expect.soft(recovered.runs).toBe(1);
        expect.soft(f.runs.filter((x) => x.status === 'cancelled').length).toBeGreaterThanOrEqual(1);
      }
      // nothing lost or duplicated: six messages, six asks, each once; the cursor at now with no coverage hole
      expect.soft(f.items).toEqual({ n: 6, distinct_keys: 6 });
      expect.soft(f.asks).toHaveLength(6);
      expect.soft(f.asks.every((a) => a.n === 1)).toBe(true);
      expect.soft(f.cursorAt).toBe(iso(NOW));
      expect.soft(await d.store.coverageGaps({ connector: 'gmail', scope: 'inbox' }, { from: iso(T0), to: iso(NOW) })).toEqual([]);
      // the standing item the scan linked to is re-evaluated (its link is not dropped by the kill)
      expect.soft(f.standingContext).toBeGreaterThanOrEqual(1);
      expect.soft(f.reevals.some((x) => x.work_item_id === standingItemId)).toBe(true);
      // spend: every paid call that reached the database is booked, once (no double booking on the re-run)
      const hashes = f.calls.map((c) => c.request_hash);
      expect.soft(new Set(hashes).size).toBe(hashes.length);
      for (const pr of f.passRows) expect.soft(hashes).toContain(`pass:${pr.run_id}:${pr.seq}`);
      expect.soft(f.calls.every((c) => Math.abs(Number(c.cost_usd) - CALL_USD) < 1e-6)).toBe(true);
      // the killed run's hold does not keep holding today's money
      expect.soft(f.holds.filter((x) => x.state === 'open')).toEqual([]);
      // Health: a row the user can read, closed once the scan picked up again
      if (p.runInterrupted) {
        const ev = f.events.filter((e) => e.code === 'WORKER.SCAN_INTERRUPTED');
        expect.soft(ev).toHaveLength(1);
        expect.soft(ev[0]!.message).toMatch(/^Inbox: a scan stopped when the app closed; it picked up where it left off/);
        expect.soft(ev[0]!.resolved).toBe(true);
      }
    });
  }
});

describe.skipIf(!pgAvailable)('crash-resume drill on the real FTI runner (db)', () => {
  it('(d) killed during classification after a paid call: the call is booked once, nothing lost or stuck', async () => {
    const { userId, standingItemId } = await seed('fti-llm-spent');
    const r = await runChild({ DRILL_USER: userId, DRILL_STANDING: standingItemId, DRILL_POINT: 'llm_spent', DRILL_PAGE: '2', DRILL_WORKER_ID: workerIdOf(999_997), DRILL_RUNNER: 'fti' });
    expect(r.signal, r.stderr).toBe('SIGKILL');

    const before = await drillFacts(h.db, userId);
    const killed = before.runs.find((x) => x.status === 'running');
    expect(killed).toBeDefined();
    // the paid call that returned before the kill left its pass row (traced as it returned, not at the run's end)
    expect(before.passRows.filter((x) => x.run_id === killed!.id)).toHaveLength(1);
    expect(before.calls.filter((c) => c.scan_run_id === killed!.id)).toEqual([]);

    const { d, recovered } = await restart(userId, standingItemId, 'fti');
    const f = await drillFacts(h.db, userId);
    expect.soft(recovered.runs).toBe(1);
    expect.soft(f.runs.filter((x) => x.status === 'running')).toEqual([]);
    expect.soft(f.jobs.filter((j) => j.status === 'running')).toEqual([]);
    expect.soft(f.runs.find((x) => x.id === killed!.id)?.status).toBe('cancelled');
    expect.soft(f.items).toEqual({ n: 6, distinct_keys: 6 });
    expect.soft(f.asks).toHaveLength(6);
    expect.soft(f.asks.every((a) => a.n === 1)).toBe(true);
    expect.soft(f.cursorAt).toBe(iso(NOW));
    expect.soft(await d.store.coverageGaps({ connector: 'gmail', scope: 'inbox' }, { from: iso(T0), to: iso(NOW) })).toEqual([]);
    // the killed run's paid call is booked by recovery, once, at its price; every pass row has exactly one llm_calls row
    const hashes = f.calls.map((c) => c.request_hash);
    expect.soft(new Set(hashes).size).toBe(hashes.length);
    for (const pr of f.passRows) expect.soft(hashes).toContain(`pass:${pr.run_id}:${pr.seq}`);
    expect.soft(f.calls.filter((c) => c.scan_run_id === killed!.id)).toHaveLength(1);
    expect.soft(f.calls.every((c) => Math.abs(Number(c.cost_usd) - CALL_USD) < 1e-6)).toBe(true);
    // three pages of two calls each, plus the killed run's one
    expect.soft(f.calls).toHaveLength(7);
    expect.soft(f.holds.filter((x) => x.state === 'open')).toEqual([]);
    const ev = f.events.filter((e) => e.code === 'WORKER.SCAN_INTERRUPTED');
    expect.soft(ev).toHaveLength(1);
    expect.soft(ev[0]?.resolved).toBe(true);
  });
});

describe.skipIf(!pgAvailable)('crash-resume drill on the real Agent SDK runner (db)', () => {
  it('killed inside the SDK session loop mid-query: the turns paid before the kill are booked once, the hold settled with them', async () => {
    const { userId, standingItemId } = await seed('agentic-sdk-turn');
    const r = await runChild({ DRILL_USER: userId, DRILL_STANDING: standingItemId, DRILL_POINT: 'sdk_turn', DRILL_PAGE: '2', DRILL_WORKER_ID: workerIdOf(999_996), DRILL_RUNNER: 'agentic' });
    expect(r.signal, r.stderr).toBe('SIGKILL');

    const before = await drillFacts(h.db, userId);
    const killed = before.runs.find((x) => x.status === 'running');
    expect(killed).toBeDefined();
    // the turns the SDK reported before the kill reached the database as they came; the query's end row never did
    const killedTurns = before.turnRows.filter((x) => x.run_id === killed!.id);
    expect(killedTurns).toHaveLength(SDK_KILL_TURN);
    for (const t of killedTurns) expect(Number(t.cost)).toBeCloseTo(TURN_USD, 6);
    expect(before.passRows.filter((x) => x.run_id === killed!.id)).toEqual([]);
    expect(before.agentCalls.filter((c) => c.scan_run_id === killed!.id)).toEqual([]);
    // page 1 ended before the kill: one row for its whole query (its turn rows are not booked again)
    expect(before.agentCalls).toHaveLength(1);
    expect(Number(before.agentCalls[0]!.cost_usd)).toBeCloseTo(turnsOfPage(1) * TURN_USD, 6);

    const { d, recovered } = await restart(userId, standingItemId, 'agentic');
    const f = await drillFacts(h.db, userId);
    expect.soft(recovered.runs).toBe(1);
    expect.soft(recovered.bookedUsd).toBeCloseTo(SDK_KILL_TURN * TURN_USD, 6);
    expect.soft(f.runs.filter((x) => x.status === 'running')).toEqual([]);
    expect.soft(f.jobs.filter((j) => j.status === 'running')).toEqual([]);
    expect.soft(f.runs.find((x) => x.id === killed!.id)?.status).toBe('cancelled');
    expect.soft(Number(f.runs.find((x) => x.id === killed!.id)?.cost_usd)).toBeCloseTo(SDK_KILL_TURN * TURN_USD, 6);
    expect.soft(f.items).toEqual({ n: 6, distinct_keys: 6 });
    expect.soft(f.asks).toHaveLength(6);
    expect.soft(f.asks.every((a) => a.n === 1)).toBe(true);
    expect.soft(f.cursorAt).toBe(iso(NOW));
    expect.soft(await d.store.coverageGaps({ connector: 'gmail', scope: 'inbox' }, { from: iso(T0), to: iso(NOW) })).toEqual([]);
    expect.soft(f.reevals.some((x) => x.work_item_id === standingItemId)).toBe(true);
    // the killed query: one llm_calls row per turn paid before the kill, at its price, booked by recovery
    const killedCalls = f.agentCalls.filter((c) => c.scan_run_id === killed!.id);
    expect.soft(killedCalls).toHaveLength(SDK_KILL_TURN);
    expect.soft(killedCalls.every((c) => Math.abs(Number(c.cost_usd) - TURN_USD) < 1e-6 && c.outcome === 'interrupted')).toBe(true);
    // every pass row has exactly one llm_calls row; no hash twice. The re-runs (the reaped job, its continuations and
    // the planner's catch-up read pages again: an agent re-reads what it is given) each book their own query once:
    // per run, what is booked is exactly what the SDK reported turn by turn, the killed run's included
    const hashes = f.agentCalls.map((c) => c.request_hash);
    expect.soft(new Set(hashes).size).toBe(hashes.length);
    for (const pr of f.passRows) expect.soft(hashes).toContain(`pass:${pr.run_id}:${pr.seq}`);
    const byRun = (rows: Array<{ run: string | null; usd: number }>) => rows.reduce((m, x) => m.set(x.run ?? '', Math.round(((m.get(x.run ?? '') ?? 0) + x.usd) * 1e6) / 1e6), new Map<string, number>());
    const booked = byRun(f.agentCalls.map((c) => ({ run: c.scan_run_id, usd: Number(c.cost_usd) })));
    const reported = byRun(f.turnRows.map((t) => ({ run: t.run_id, usd: Number(t.cost) })));
    expect.soft(booked).toEqual(reported);
    expect.soft(f.runs.filter((x) => reported.has(x.id)).every((x) => Math.abs(Number(x.cost_usd) - reported.get(x.id)!) < 1e-6)).toBe(true);
    expect.soft(reported.get(f.runs.find((x) => x.status === 'succeeded' && x.window_start.startsWith('2026-11-18 15:00'))?.id ?? '')).toBeCloseTo(turnsOfPage(1) * TURN_USD, 6);
    // the killed run's hold is settled with what its turns cost, not left open or settled at $0
    expect.soft(f.holds.filter((x) => x.state === 'open')).toEqual([]);
    const abandoned = f.holds.filter((x) => x.state === 'abandoned');
    expect.soft(abandoned).toHaveLength(1);
    expect.soft(Number(abandoned[0]?.spent_usd)).toBeCloseTo(SDK_KILL_TURN * TURN_USD, 6);
    const ev = f.events.filter((e) => e.code === 'WORKER.SCAN_INTERRUPTED');
    expect.soft(ev).toHaveLength(1);
    expect.soft(ev[0]?.resolved).toBe(true);

    // a second start (or the W-3 close at every start) books nothing twice
    const again = await recoverInterruptedWork({ db: h.db, userId, workerId: workerIdOf(), store: d.store, clock: () => d.clock.now() });
    expect.soft(again).toMatchObject({ runs: 0, bookedUsd: 0 });
    await d.scanning.dropStalePlans();
    const g = await drillFacts(h.db, userId);
    expect.soft(g.agentCalls).toHaveLength(f.agentCalls.length);
    expect.soft(g.passRows).toHaveLength(f.passRows.length);
  });
});

describe.skipIf(!pgAvailable)('two workers of one user recover the same interrupted run at once (db, P34-3)', () => {
  it('the run\'s passes are booked once: the booking takes a per-run advisory lock', async () => {
    const u = await h.db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values (${`race-${Date.now()}@example.com`}, 'Drill Example', 'America/Denver') returning id`);
    const userId = u.rows[0]!.id;
    const storeOf = () => new DbScannerStore({ db: h.db, userId, clock: () => new Date(T0) });
    const { runId } = await storeOf().startRun({ scope: { connector: 'gmail', scope: 'inbox' }, trigger: 'schedule', window: { from: iso(T0 - H), to: iso(T0) } });
    // the dead worker's three paid passes reached the database; nothing booked them
    const seqs = [1001, 1002, 1003];
    for (const seq of seqs) {
      const payload = { pass: 'traversal', model: 'claude-haiku-5-5', costUsd: CALL_USD, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, contentHash: `race-${seq}`, ok: true };
      await h.db.execute(sql`insert into scan_run_events (run_id, seq, ts, kind, payload) values (${runId}::uuid, ${seq}, now(), 'pass', ${JSON.stringify(payload)}::jsonb)`);
    }
    const start = (n: number) => recoverInterruptedWork({ db: h.db, userId, workerId: workerIdOf(990_000 + n), store: storeOf(), clock: () => new Date(T0) });
    const [a, b] = await Promise.all([start(1), start(2)]);
    const calls = (await h.db.execute<{ request_hash: string }>(sql`select request_hash from llm_calls where scan_run_id = ${runId}::uuid order by request_hash`)).rows;
    expect(calls.map((c) => c.request_hash)).toEqual(seqs.map((seq) => `pass:${runId}:${seq}`));
    expect(a.bookedUsd + b.bookedUsd).toBeCloseTo(3 * CALL_USD, 6);
    const [run] = (await h.db.execute<{ status: string; cost_usd: string }>(sql`select status, cost_usd::text from scan_runs where id = ${runId}::uuid`)).rows;
    expect(run!.status).toBe('cancelled');
    expect(Number(run!.cost_usd)).toBeCloseTo(3 * CALL_USD, 6);
  });
});

describe.skipIf(!pgAvailable)('the model fails mid-job, a job dies with the worker, the disk is full (db)', () => {
  const plainUser = async (label: string) =>
    (await h.db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values (${`${label}-${Date.now()}@example.com`}, 'Drill Example', 'America/Denver') returning id`)).rows[0]!.id;

  it('a model job that spent and then failed is queued again, its cost booked and its hold settled with it', async () => {
    const userId = await plainUser('llmfail');
    const store = new DbScannerStore({ db: h.db, userId });
    const registry = new JobRegistry();
    registry.register({
      kind: 'completion.check',
      queue: 'drill',
      wired: true,
      description: 'drill: a model job that fails after one paid call',
      handler: async (ctx) => {
        await store.recordSpend({ connector: 'brief', model: 'claude-haiku-5-5', costUsd: 0.04, jobId: ctx.job.id, inputTokens: 400, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, trigger: 'drill', modelReason: 'default', outcome: 'error:transient', contentHash: 'drill-llm-fail' });
        throw new JobError('the model call failed (overloaded)', 'transient', { code: 'overloaded' });
      },
    });
    const worker = new WorkerRuntime({ db: h.db, userId, workerId: workerIdOf(), registry, services: {}, pools: [{ name: 'drill', queues: ['drill'], concurrency: 1 }], listenUrl: null, log: () => {}, startGate: spendStartGate(h.db, userId) });
    const { id } = await enqueueJob(h.db, { ownerUserId: userId, kind: 'completion.check', queue: 'drill', payload: {} });
    await worker.pollOnce();
    await worker.idle();
    const [job] = (await h.db.execute<{ status: string; attempts: number; last_error_class: string; run_at: string }>(sql`select status, attempts, last_error_class, run_at::text from jobs where id = ${id}`)).rows;
    expect(job).toMatchObject({ status: 'queued', attempts: 1, last_error_class: 'transient' });
    // the next try waits for its backoff (a later tick), it does not spin
    expect(Date.parse(job!.run_at)).toBeGreaterThan(Date.now());
    const calls = (await h.db.execute<{ cost_usd: string }>(sql`select cost_usd::text from llm_calls where owner_user_id = ${userId} and job_id = ${id}`)).rows;
    expect(calls.map((c) => Number(c.cost_usd))).toEqual([0.04]);
    const [hold] = (await h.db.execute<{ state: string; spent_usd: string }>(sql`select state, spent_usd::text from spend_holds where user_id = ${userId} and job_key = ${`completion.check:${id}`}`)).rows;
    expect(hold).toMatchObject({ state: 'settled' });
    expect(Number(hold!.spent_usd)).toBeCloseTo(0.04, 6);
  });

  it('a model job the kill left running: its lease ends at once, its hold stops holding, Health says it runs again', async () => {
    const userId = await plainUser('jobkill');
    const dead = workerIdOf(999_998);
    const { id } = await enqueueJob(h.db, { ownerUserId: userId, kind: 'settle.check', queue: 'settle', payload: {} });
    await h.db.execute(sql`update jobs set status = 'running', attempts = 1, locked_by = ${dead}, locked_at = now(), lease_expires_at = now() + interval '90 seconds', started_at = now() where id = ${id}`);
    await h.db.execute(sql`insert into worker_instances (id, role, hostname, pid, app_version) values (${dead}, 'worker', 'drill', 999998, '0.0.0')`);
    const gov = dbSpendGovernor({ db: h.db, userId });
    const held = await gov.hold({ scope: 'settle_pass', jobKey: `settle.check:${id}`, skill: 'settle-item' }, { p50: 0.01, p90: 0.02, basis: 'default', n: 0 });
    expect(held.ok).toBe(true);
    const store = new DbScannerStore({ db: h.db, userId });
    const r = await recoverInterruptedWork({ db: h.db, userId, workerId: workerIdOf(), store });
    expect(r).toMatchObject({ jobs: 1, holds: 1, runs: 0 });
    const reaped = await reapExpiredLeases(h.db);
    expect(reaped.requeued).toBeGreaterThanOrEqual(1);
    const [job] = (await h.db.execute<{ status: string; last_error_code: string }>(sql`select status, last_error_code from jobs where id = ${id}`)).rows;
    expect(job).toEqual({ status: 'queued', last_error_code: 'lease_expired' });
    const [hold] = (await h.db.execute<{ state: string }>(sql`select state from spend_holds where job_key = ${`settle.check:${id}`}`)).rows;
    expect(hold!.state).toBe('abandoned');
    const [ev] = (await h.db.execute<{ message: string }>(sql`select message from app_events where owner_user_id = ${userId} and code = 'WORKER.JOBS_INTERRUPTED'`)).rows;
    expect(ev!.message).toBe('A background job stopped when the app closed; it runs again now.');
    // the dead worker no longer reads as running (Health's "worker alive" reads open worker rows)
    const [inst] = (await h.db.execute<{ stop_reason: string | null }>(sql`select stop_reason from worker_instances where id = ${dead}`)).rows;
    expect(inst!.stop_reason).toBe('killed: stopped without draining');
  });

  it('a full disk is one Health row (DEP.DISK.LOW) in plain words, said once per 10 minutes', async () => {
    const userId = await plainUser('diskfull');
    const stop = watchStateWrites(h.db, () => userId, () => undefined);
    try {
      stateWriteFailed('first-scan state', Object.assign(new Error('no space'), { code: 'ENOSPC' }));
      stateWriteFailed('the scan schedule', Object.assign(new Error('no space'), { code: 'ENOSPC' }));
      stateWriteFailed('first-scan state', Object.assign(new Error('denied'), { code: 'EACCES' }));
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      stop();
    }
    const rows = (await h.db.execute<{ code: string; message: string; occurrence_count: number; detail: { suggestedAction?: string } }>(sql`select code, message, occurrence_count, detail from app_events where owner_user_id = ${userId}`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'DEP.DISK.LOW', occurrence_count: 1 });
    expect(rows[0]!.message).toBe('The disk is full: Command Center could not save first-scan state. Scans retry once there is room; nothing already saved is lost.');
    expect(rows[0]!.detail.suggestedAction).toBe('Free up a few GB of disk space.');
  });
});
