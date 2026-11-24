import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import { enqueueJob, recordNewInfo } from '@/db/queue';
import { backoffSeconds, JobError, JobRegistry, type JobHandler } from '@/jobs';
import { HeartbeatWriter } from '@/ops/heartbeat';
import { Lifecycle, SingleInstanceLock, WakeDetector } from '@/ops/lifecycle';
import { WorkerRuntime } from '@/worker/runtime';

import { createUser, openTestDb, TEST_URL, uid, waitFor } from './helpers';

const h = openTestDb(8);
const db = h.db;
let userId: string;

beforeAll(async () => {
  userId = await createUser(db, 'worker');
});
afterAll(() => h.close());
beforeEach(async () => {
  await db.execute(sql`update jobs set status = 'cancelled', finished_at = now(), lease_expires_at = null where status in ('queued', 'running')`);
});

const job = async (id: number) =>
  (
    await db.execute<{
      status: string;
      attempts: number;
      locked_by: string | null;
      lease_expires_at: string | null;
      run_at: string;
      last_error_class: string | null;
      dead_reason: string | null;
      cancel_reason: string | null;
      result: Record<string, unknown> | null;
      heartbeat_at: string | null;
    }>(sql`select status, attempts, locked_by, lease_expires_at, run_at, last_error_class, dead_reason, cancel_reason, result, heartbeat_at from jobs where id = ${id}`)
  ).rows[0]!;

function makeWorker(handlers: Record<string, JobHandler>, opts: Partial<ConstructorParameters<typeof WorkerRuntime>[0]> = {}) {
  const registry = new JobRegistry();
  for (const [kind, handler] of Object.entries(handlers)) registry.register({ kind, queue: 'test', wired: true, description: kind, handler });
  return new WorkerRuntime({
    db,
    userId,
    workerId: `test:${uid()}`,
    registry,
    services: {},
    pools: [{ name: 'test', queues: ['test'], concurrency: 2 }],
    listenUrl: null,
    log: () => {},
    leaseSeconds: 60,
    drainMs: 300,
    ...opts,
  });
}

const enqueue = (kind: string, extra: Partial<Parameters<typeof enqueueJob>[1]> = {}) =>
  enqueueJob(db, { ownerUserId: userId, kind, queue: 'test', ...extra }).then((r) => r.id);

describe('claims and leases', () => {
  it('claims with a short lease, extends it on heartbeat, and completes with the result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = makeWorker({ 'test.ok': async () => (await gate, { done: 1 }) });
    const id = await enqueue('test.ok', { timeoutSeconds: 600 });
    expect(await w.pollOnce()).toBe(1);
    const running = await waitFor(async () => {
      const j = await job(id);
      return j.status === 'running' && j.heartbeat_at ? j : null;
    });
    const leaseSec = (Date.parse(running.lease_expires_at!) - Date.now()) / 1000;
    expect(leaseSec).toBeGreaterThan(40);
    expect(leaseSec).toBeLessThan(70); // narrowed from timeout_seconds (600) to the lease window
    await db.execute(sql`update jobs set lease_expires_at = now() + interval '5 seconds' where id = ${id}`);
    await w.heartbeatOnce();
    expect(Date.parse((await job(id)).lease_expires_at!) - Date.now()).toBeGreaterThan(40_000);
    release();
    await w.idle();
    expect(await job(id)).toMatchObject({ status: 'succeeded', result: { done: 1 }, attempts: 1 });
  });

  it('one dedupe key never runs twice at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const w = makeWorker({ 'test.key': async () => void (runs++, await gate) });
    const a = await enqueue('test.key', { dedupeKey: `k-${uid()}` });
    const key = (await db.execute<{ dedupe_key: string }>(sql`select dedupe_key from jobs where id = ${a}`)).rows[0]!.dedupe_key;
    await w.pollOnce();
    await waitFor(async () => (await job(a)).status === 'running');
    const b = await enqueue('test.key', { dedupeKey: key });
    expect(await w.pollOnce()).toBe(0); // b waits while a runs
    release();
    await w.idle();
    await w.pollOnce();
    await w.idle();
    expect(runs).toBe(2);
    expect((await job(b)).status).toBe('succeeded');
  });

  it("claims only its own user's jobs: two users' due jobs on one queue, one worker each", async () => {
    // A worker runs every job it claims as its own userId (ctx.userId), so a job it took from another user would
    // run as the wrong person (28-crash-resume.md, "Flake: relay holds under load").
    const other = await createUser(db, 'worker-other');
    const ran: { worker: string; owner: string; ctxUser: string }[] = [];
    const handler =
      (worker: string): JobHandler =>
      async (ctx) => {
        ran.push({ worker, owner: ctx.job.ownerUserId, ctxUser: ctx.userId });
        return {};
      };
    // the other user's jobs are older, so an owner-blind claim takes them first
    const theirs = [
      await enqueueJob(db, { ownerUserId: other, kind: 'test.owner', queue: 'test', runAt: new Date(Date.now() - 60_000) }),
      await enqueueJob(db, { ownerUserId: other, kind: 'test.owner', queue: 'test', runAt: new Date(Date.now() - 60_000) }),
    ].map((r) => r.id);
    const mine = [await enqueue('test.owner'), await enqueue('test.owner')];
    const wMine = makeWorker({ 'test.owner': handler('mine') });
    const wTheirs = makeWorker({ 'test.owner': handler('theirs') }, { userId: other });

    await wMine.pollOnce(); // concurrency 2: both of mine, neither of theirs
    await wMine.idle();
    expect(await wMine.pollOnce()).toBe(0);
    for (const id of mine) expect((await job(id)).status).toBe('succeeded');
    for (const id of theirs) expect((await job(id)).status).toBe('queued');

    expect(await wTheirs.pollOnce()).toBe(2);
    await wTheirs.idle();
    for (const id of theirs) expect((await job(id)).status).toBe('succeeded');
    expect(ran.filter((r) => r.worker === 'mine').map((r) => [r.owner, r.ctxUser])).toEqual([
      [userId, userId],
      [userId, userId],
    ]);
    expect(ran.filter((r) => r.worker === 'theirs').map((r) => [r.owner, r.ctxUser])).toEqual([
      [other, other],
      [other, other],
    ]);
  });
});

describe('reaper', () => {
  it('re-queues expired leases, dead-letters the final attempt, cancels a cancel-requested job', async () => {
    const insert = (over: Record<string, unknown>) =>
      db
        .execute<{ id: string }>(sql`
          insert into jobs (owner_user_id, queue, kind, status, attempts, max_attempts, locked_by, locked_at, lease_expires_at, started_at, cancel_requested_at)
          values (${userId}, 'test', 'test.reap', 'running', ${over.attempts ?? 1}, ${over.max ?? 3}, 'dead-worker:1:x', now() - interval '10 minutes',
                  now() - interval '1 minute', now() - interval '10 minutes', ${over.cancel ? sql`now()` : sql`null`})
          returning id`)
        .then((r) => Number(r.rows[0]!.id));
    const a = await insert({});
    const b = await insert({ attempts: 3, max: 3 });
    const c = await insert({ cancel: true });
    const w = makeWorker({});
    const r = await w.reap();
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    expect(await job(a)).toMatchObject({ status: 'queued', locked_by: null, last_error_class: 'transient' });
    expect(await job(b)).toMatchObject({ status: 'dead', dead_reason: 'lease expired after the final attempt' });
    expect((await job(c)).status).toBe('cancelled');
    const n = await db.execute<{ n: string }>(sql`select count(*) as n from notifications where dedupe_key = ${`job:${b}:dead`} and kind = 'job_dead_lettered'`);
    expect(n.rows[0]!.n).toBe('1');
  });
});

describe('retry and dead-letter', () => {
  it('backs off exponentially with jitter, then dead-letters after max attempts', async () => {
    const w = makeWorker({ 'test.flaky': async () => { throw new JobError('upstream 503', 'transient'); } });
    const id = await enqueue('test.flaky', { maxAttempts: 3 });
    const delays: number[] = [];
    for (let i = 1; i <= 3; i++) {
      await w.pollOnce();
      await w.idle();
      const j = await job(id);
      if (i < 3) {
        expect(j).toMatchObject({ status: 'queued', attempts: i, last_error_class: 'transient', locked_by: null });
        delays.push(Date.parse(j.run_at) - Date.now());
        await db.execute(sql`update jobs set run_at = now() where id = ${id}`);
      } else {
        expect(j).toMatchObject({ status: 'dead', attempts: 3 });
        expect(j.dead_reason).toMatch(/attempts exhausted/);
      }
    }
    expect(delays[0]!).toBeGreaterThan(10_000); // base 30 s, equal jitter: 15–30 s
    expect(delays[1]!).toBeGreaterThan(delays[0]! - 1000);
    const ev = await db.execute<{ n: string }>(sql`select count(*) as n from app_events where code = 'job_dead_lettered' and job_id = ${id}`);
    expect(Number(ev.rows[0]!.n)).toBe(1);
  });

  it('dead-letters a non-retryable error at once', async () => {
    const w = makeWorker({ 'test.bad': async () => { throw new JobError('bad payload', 'validation', { code: 'bad_payload' }); } });
    const id = await enqueue('test.bad', { maxAttempts: 5 });
    await w.pollOnce();
    await w.idle();
    expect(await job(id)).toMatchObject({ status: 'dead', attempts: 1, last_error_class: 'validation' });
  });

  it('backoff math: doubles per attempt, capped, x2 when rate limited, honours retry-after', () => {
    expect(backoffSeconds({ attempts: 1, baseSeconds: 30, maxSeconds: 3600, errorClass: 'transient', rand: 1 })).toBe(30);
    expect(backoffSeconds({ attempts: 3, baseSeconds: 30, maxSeconds: 3600, errorClass: 'transient', rand: 1 })).toBe(120);
    expect(backoffSeconds({ attempts: 3, baseSeconds: 30, maxSeconds: 3600, errorClass: 'transient', rand: 0 })).toBe(60);
    expect(backoffSeconds({ attempts: 20, baseSeconds: 30, maxSeconds: 3600, errorClass: 'transient', rand: 1 })).toBe(3600);
    expect(backoffSeconds({ attempts: 2, baseSeconds: 30, maxSeconds: 3600, errorClass: 'rate_limited', rand: 1 })).toBe(120);
    expect(backoffSeconds({ attempts: 1, baseSeconds: 30, maxSeconds: 3600, errorClass: 'transient', rand: 0, retryAfterSeconds: 90 })).toBe(90);
  });
});

describe('graceful shutdown', () => {
  it('SIGTERM stops claiming, aborts runs and releases their leases (attempt given back)', async () => {
    const seen: string[] = [];
    const w = makeWorker(
      {
        // cooperative: returns as soon as the signal aborts
        'test.coop': async (ctx) => {
          await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r(), { once: true }));
          seen.push(String((ctx.signal.reason as Error).message));
        },
        // stubborn: ignores the signal for longer than the drain window
        'test.stubborn': async () => {
          await new Promise((r) => setTimeout(r, 1500));
          return { finished: true };
        },
      },
      { drainMs: 300 },
    );
    const a = await enqueue('test.coop');
    const b = await enqueue('test.stubborn');
    await w.pollOnce();
    await waitFor(async () => (await job(a)).status === 'running' && (await job(b)).status === 'running');
    const proc = new EventEmitter();
    const exits: number[] = [];
    const life = new Lifecycle({ exit: (c) => exits.push(c), log: () => {} });
    life.installSignalHandlers(proc as unknown as NodeJS.Process);
    life.onShutdown('drain jobs', (reason) => w.stop(reason).then(() => undefined));
    proc.emit('SIGTERM');
    await waitFor(() => exits.length > 0, 5000);
    expect(exits).toEqual([0]);
    expect(seen[0]).toMatch(/shutdown/);
    for (const id of [a, b]) expect(await job(id)).toMatchObject({ status: 'queued', attempts: 0, locked_by: null, lease_expires_at: null });
    expect(await w.pollOnce()).toBe(0); // no claims after stop
    await new Promise((r) => setTimeout(r, 1400)); // the stubborn handler finishes late: its completion is fenced out
    expect((await job(b)).status).toBe('queued');
  });
});

describe('re-evaluation: cancel by generation (W2/W3)', () => {
  async function workItem(): Promise<string> {
    const { result } = await withChangeSet({ db, userId, actor: actors.user(), reason: 'seed' }, (tx) =>
      tx.execute<{ id: string }>(sql`insert into work_items (owner_user_id, kind, origin, status, title) values (${userId}, 'task', 'manual', 'open', 'Re-eval target') returning id`),
    );
    return result.rows[0]!.id;
  }
  const newInfo = (id: string) => withChangeSet({ db, userId, actor: actors.engine('test@1'), reason: 'new info' }, (tx) => recordNewInfo(tx, id, { debounceSeconds: 0 })).then((r) => r.result);

  it('new info while a re-eval runs aborts it (cc_job_cancel) and the newer generation runs next', async () => {
    const wid = await workItem();
    const runs: Array<{ generation: number | null; outcome: string }> = [];
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => (firstStarted = r));
    const registry = new JobRegistry();
    registry.register({
      kind: 'reevaluate',
      queue: 'engine',
      wired: true,
      description: 'test re-eval',
      handler: async (ctx) => {
        if (!runs.length) {
          firstStarted();
          await new Promise<void>((r) => {
            ctx.signal.addEventListener('abort', () => r(), { once: true });
            setTimeout(r, 4000);
          });
        }
        runs.push({ generation: ctx.job.generation, outcome: ctx.signal.aborted ? String((ctx.signal.reason as Error).message) : 'done' });
      },
    });
    const w = new WorkerRuntime({ db, userId, workerId: `test:${uid()}`, registry, services: {}, pools: [{ name: 'engine', queues: ['engine'], concurrency: 2 }], listenUrl: TEST_URL, log: () => {}, drainMs: 200 });
    await w.start();
    try {
      const g1 = await newInfo(wid);
      await w.pollOnce();
      await started;
      const g2 = await newInfo(wid); // bumps the generation and requests cancel of the running job
      expect(g2.cancelledRunning).toBe(1);
      await waitFor(() => runs.length >= 1, 5000);
      expect(runs[0]).toMatchObject({ generation: g1.generation });
      expect(runs[0]!.outcome).toMatch(/cancel/);
      await waitFor(async () => (await job(g1.jobId)).status === 'cancelled', 5000);
      await waitFor(async () => {
        await w.pollOnce();
        return runs.length >= 2;
      }, 5000);
      expect(runs[1]).toEqual({ generation: g2.generation, outcome: 'done' });
      await w.idle();
      expect((await job(g2.jobId)).status).toBe('succeeded');
    } finally {
      await w.stop();
    }
  });

  it('a queued re-eval for an older generation never starts (fenced)', async () => {
    const wid = await workItem();
    let ran = 0;
    const registry = new JobRegistry();
    registry.register({ kind: 'reevaluate', queue: 'engine', wired: true, description: 'x', handler: async () => void ran++ });
    const w = new WorkerRuntime({ db, userId, workerId: `test:${uid()}`, registry, services: {}, pools: [{ name: 'engine', queues: ['engine'], concurrency: 1 }], listenUrl: null, log: () => {} });
    await newInfo(wid);
    await newInfo(wid);
    const stale = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: wid }, generation: 1 });
    await db.execute(sql`update jobs set status = 'cancelled' where dedupe_key = ${`reeval:work_item:${wid}`} and status = 'queued'`);
    await w.pollOnce();
    await w.idle();
    expect(ran).toBe(0);
    expect(await job(stale.id)).toMatchObject({ status: 'cancelled' });
    expect((await job(stale.id)).cancel_reason).toMatch(/superseded by generation 2/);
  });
});

describe('single instance, heartbeat file, wake detection (OPS helpers)', () => {
  it('a second worker cannot take the advisory lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-be1a-lock-'));
    const c1 = new Client({ connectionString: TEST_URL });
    const c2 = new Client({ connectionString: TEST_URL });
    await c1.connect();
    await c2.connect();
    try {
      const a = new SingleInstanceLock({ client: c1, pidFile: join(dir, 'a.pid'), key: [4327, 99] });
      const b = new SingleInstanceLock({ client: c2, pidFile: join(dir, 'b.pid'), key: [4327, 99] });
      expect(await a.acquire()).toEqual({ acquired: true });
      expect(await b.acquire()).toEqual({ acquired: false, reason: 'advisory' });
      await a.release();
      expect(await b.acquire()).toEqual({ acquired: true });
      await b.release();
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it('writes the heartbeat file (pid, started, last beat, active jobs, version)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cc-be1a-hb-')), 'worker.heartbeat');
    const hb = new HeartbeatWriter({ path, appVersion: '9.9.9' });
    hb.activeJobs = 2;
    hb.state = 'running';
    hb.beat();
    const j = JSON.parse(readFileSync(path, 'utf8'));
    expect(j).toMatchObject({ v: 1, pid: process.pid, state: 'running', active_jobs: 2, app_version: '9.9.9' });
    expect(Date.parse(j.started_at)).toBeGreaterThan(0);
    expect(Date.parse(j.beat_at)).toBeGreaterThan(0);
    hb.stop();
    expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('stopped');
  });

  it('a clock jump (sleep) triggers onWake: leases first, then re-planning', async () => {
    let t = Date.parse('2026-11-02T08:00:00Z');
    let planned = 0;
    const w = makeWorker({}, { hooks: [{ name: 'plan', everyMs: 60_000, run: async () => void planned++ }] });
    const wakes: number[] = [];
    const wd = new WakeDetector((e) => void (wakes.push(e.gapMs), w.onWake(e.gapMs)), { intervalMs: 5000, thresholdMs: 30_000, now: () => t });
    t += 5000;
    expect(wd.check()).toBeNull();
    t += 3 * 3600_000; // the lid was closed for 3 h
    expect(wd.check()?.gapMs).toBeGreaterThan(3 * 3600_000 - 10_000);
    await waitFor(() => planned >= 1);
    expect(wakes).toHaveLength(1);
  });
});
