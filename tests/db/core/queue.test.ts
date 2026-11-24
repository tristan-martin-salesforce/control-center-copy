import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, engineUpdate, withChangeSet } from '../../../src/db/changeset';
import { StaleGenerationError } from '../../../src/db/errors';
import { statementSql } from '../../../src/db/queries';
import { claimJobs, enqueueJob, recordNewInfo } from '../../../src/db/queue';
import { jobs, workItems } from '../../../src/db/schema';
import { createUser, createWorkItem, openTestDb } from './helpers';

const h = openTestDb();
const db = h.db;
// A second, independent pool: a different "worker process".
const h2 = openTestDb();
let userId: string;

beforeAll(async () => {
  userId = await createUser(db, 'queue');
});
afterAll(async () => {
  await h.close();
  await h2.close();
});

describe('job queue', () => {
  it('two concurrent claimers never claim the same job (FOR UPDATE SKIP LOCKED)', async () => {
    const queue = 'claim-race';
    for (let i = 0; i < 120; i++) await enqueueJob(db, { ownerUserId: userId, kind: 'noop', queue, payload: { i } });

    async function drain(workerId: string, which: typeof db): Promise<string[]> {
      const got: string[] = [];
      for (;;) {
        const batch = await claimJobs({ db: which, ownerUserId: userId, workerId, queues: [queue], limit: 3 });
        if (!batch.length) return got;
        got.push(...batch.map((j) => j.id));
      }
    }
    const [a, b, c] = await Promise.all([drain('w-a', db), drain('w-b', h2.db), drain('w-c', h2.db)]);
    const all = [...a, ...b, ...c];
    expect(all).toHaveLength(120);
    expect(new Set(all).size).toBe(120);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length + c.length).toBeGreaterThan(0);

    const rows = await db.execute<{ status: string; attempts: number; n: string }>(
      sql`select status, attempts, count(*) as n from jobs where queue = ${queue} group by 1, 2`,
    );
    expect(rows.rows).toEqual([{ status: 'running', attempts: 1, n: '120' }]);
  });

  it('a dedupe key never runs twice at once, even under concurrent claimers', async () => {
    const queue = 'dedupe';
    await enqueueJob(db, { ownerUserId: userId, kind: 'scan', queue, dedupeKey: 'scan:slack:dm' });
    const [first] = await claimJobs({ db, ownerUserId: userId, workerId: 'w-1', queues: [queue] });
    expect(first).toBeDefined();
    // A new burst for the same key queues behind the running job...
    const second = await enqueueJob(db, { ownerUserId: userId, kind: 'scan', queue, dedupeKey: 'scan:slack:dm' });
    expect(second.inserted).toBe(true);
    // ...and is not claimable while the first one runs.
    const claimed = await Promise.all([
      claimJobs({ db, ownerUserId: userId, workerId: 'w-2', queues: [queue] }),
      claimJobs({ db: h2.db, ownerUserId: userId, workerId: 'w-3', queues: [queue] }),
    ]);
    expect(claimed.flat()).toHaveLength(0);
    await db.update(jobs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(jobs.id, Number(first!.id)));
    const [next] = await claimJobs({ db, ownerUserId: userId, workerId: 'w-2', queues: [queue] });
    expect(Number(next!.id)).toBe(second.id);
  });

  it('idempotency keys enqueue exactly once; dedupe keys coalesce queued bursts', async () => {
    const a = await enqueueJob(db, { ownerUserId: userId, kind: 'outbox.send', idempotencyKey: 'send:draft-1:abc' });
    const b = await enqueueJob(db, { ownerUserId: userId, kind: 'outbox.send', idempotencyKey: 'send:draft-1:abc' });
    expect(a.inserted).toBe(true);
    expect(b).toEqual({ id: a.id, inserted: false });

    const c = await enqueueJob(db, { ownerUserId: userId, kind: 'brief', dedupeKey: 'brief:x', generation: 1, delaySeconds: 5 });
    const d = await enqueueJob(db, { ownerUserId: userId, kind: 'brief', dedupeKey: 'brief:x', generation: 2, delaySeconds: 60 });
    expect(d).toEqual({ id: c.id, inserted: false });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, c.id));
    expect(row!.generation).toBe(2);
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });
});

describe('re-evaluation generation fence (W2 + W3)', () => {
  it('new info bumps the generation, cancels the running re-eval, and the stale job writes nothing', async () => {
    const item = await createWorkItem(db, userId, { title: 'Reply to ACME pricing ask', status: 'open' });
    const scanner = actors.scanner('slack');

    // New info #1: saved first, then bump + enqueue (one transaction).
    const { result: n1 } = await withChangeSet({ db, userId, actor: scanner, reason: 'new Slack reply' }, (tx) =>
      recordNewInfo(tx, item.id, { debounceSeconds: 0 }),
    );
    expect(n1).toMatchObject({ generation: 1, cancelledRunning: 0 });
    // A second burst before the job starts coalesces into the same queued job.
    const { result: n1b } = await withChangeSet({ db, userId, actor: scanner, reason: 'another reply' }, (tx) =>
      recordNewInfo(tx, item.id, { debounceSeconds: 0 }),
    );
    expect(n1b).toMatchObject({ generation: 2, jobId: n1.jobId });

    const [staleJob] = await claimJobs({ db, ownerUserId: userId, workerId: 'w-reeval', queues: ['engine'] });
    expect(Number(staleJob!.id)).toBe(n1.jobId);
    expect(Number(staleJob!.generation)).toBe(2);

    // The worker LISTENs for cancels.
    const listener = await h2.pool.connect();
    await listener.query('LISTEN cc_job_cancel');
    const cancelled = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no cc_job_cancel notification')), 5000);
      listener.once('notification', (msg) => {
        clearTimeout(timer);
        resolve(msg.payload ?? '');
      });
    });

    // New info #2 arrives while the re-eval runs.
    const { result: n2 } = await withChangeSet({ db, userId, actor: scanner, reason: 'requirements changed' }, (tx) =>
      recordNewInfo(tx, item.id, { debounceSeconds: 0 }),
    );
    expect(n2).toMatchObject({ generation: 3, cancelledRunning: 1 });
    expect(n2.jobId).not.toBe(n1.jobId);
    expect(await cancelled).toBe(String(n1.jobId));
    listener.release();
    const [runningRow] = await db.select().from(jobs).where(eq(jobs.id, n1.jobId));
    expect(runningRow!.cancelRequestedAt).not.toBeNull();

    // The superseded job ignores the cancel and tries to write: fenced.
    const stale = await withChangeSet({ db, userId, actor: actors.engine('reeval@1'), reason: 'reeval result' }, (tx) =>
      engineUpdate(tx, workItems, item.id, { status: 'likely_done', likelyDoneAt: new Date() }, { generation: Number(staleJob!.generation) }),
    ).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(StaleGenerationError);
    expect(stale).toMatchObject({ expectedGeneration: 2, currentGeneration: 3 });

    // W3 verbatim: zero rows for the stale generation.
    const [cur] = await db.select().from(workItems).where(eq(workItems.id, item.id));
    const w3Stale = await withChangeSet({ db, userId, actor: 'engine', reason: 'W3 stale' }, async (tx) =>
      (await tx.execute(statementSql('W3', [item.id, 2, cur!.version, 'likely_done']))).rowCount,
    );
    expect(w3Stale.result).toBe(0);
    expect((await db.select().from(workItems).where(eq(workItems.id, item.id)))[0]!.status).toBe('open');

    // The current job (generation 3) writes.
    const [fresh] = await claimJobs({ db, ownerUserId: userId, workerId: 'w-reeval', queues: ['engine'] });
    expect(Number(fresh!.generation)).toBe(3);
    const ok = await withChangeSet({ db, userId, actor: actors.engine('reeval@1'), reason: 'reeval result' }, (tx) =>
      engineUpdate(tx, workItems, item.id, { status: 'likely_done', likelyDoneAt: new Date() }, { generation: 3 }),
    );
    expect(ok.result.row).toMatchObject({ status: 'likely_done', reevalGeneration: 3 });
  });
});
