/**
 * B-058: `nba.generate` on a work item that is gone is a quiet no-op. The real path: a re-eval opens a sibling
 * and queues its NBA follow-up; Undo deletes the sibling while that job is still queued; the default
 * registry's `nba.generate` then succeeds with `skipped: 'gone'` (no retry, no dead letter). Placeholder text.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { enqueueJob } from '@/db/queue';
import { createDefaultRegistry } from '@/jobs';
import { DbDataSource } from '@/server/datasource/db';
import { WorkerRuntime } from '@/worker/runtime';

import { drain, linkEvidence, loadExampleSeed, makeItem, openTestDb, reevalWorker, rows } from './helpers';

const h = openTestDb(6);
const db = h.db;
let userId: string;
let ds: DbDataSource;

beforeAll(async () => {
  userId = await loadExampleSeed(db);
  ds = new DbDataSource({ handle: h, userId });
});
afterAll(async () => {
  await ds.dispose();
  await h.close();
});
beforeEach(async () => {
  await db.execute(sql`update jobs set status = 'cancelled', finished_at = now(), lease_expires_at = null where status in ('queued', 'running')`);
});

/** The worker with the app's own registry, running only the `nba` queue. */
function nbaWorker() {
  return new WorkerRuntime({
    db,
    userId,
    workerId: `bereeval-nba:${randomUUID().slice(0, 8)}`,
    registry: createDefaultRegistry(),
    services: {},
    pools: [{ name: 'nba', queues: ['nba'], concurrency: 1 }],
    listenUrl: null,
    log: () => {},
    leaseSeconds: 60,
    drainMs: 500,
  });
}

const jobRow = async (id: number | string) =>
  (await rows<{ status: string; attempts: number; result: Record<string, unknown> | null; last_error_class: string | null }>(db, sql`select status, attempts, result, last_error_class from jobs where id = ${id}`))[0]!;

const REQ = { role: 'contradiction' as const, confidence: 0.75, reason: 'requirements_change: add a data-residency slide' };

describe('nba.generate on a missing work item (B-058)', () => {
  it('an Undo removed the sibling while its NBA job was queued: the job succeeds as skipped, nothing dead-letters', async () => {
    const reeval = reevalWorker(db, userId);
    let sibId: string;
    let nbaJobId: string;
    try {
      const [ini] = await rows<{ id: string }>(db, sql`select id from initiatives where owner_user_id = ${userId} limit 1`);
      const id = await makeItem(db, userId, { status: 'done', doneDaysAgo: 20, initiativeId: ini!.id });
      await linkEvidence(db, userId, id, REQ);
      await drain(reeval);
      const [cs] = await rows<{ id: string }>(db, sql`select id from change_sets where actor_ref = 'reeval' and entity_id = ${id}`);
      const [sib] = await rows<{ id: string }>(db, sql`select new_work_item_id as id from reopen_decisions where done_work_item_id = ${id}`);
      sibId = sib!.id;
      const [nba] = await rows<{ id: string; status: string }>(db, sql`select id, status from jobs where kind = 'nba.generate' and payload ->> 'work_item_id' = ${sibId}`);
      expect(nba!.status).toBe('queued');
      nbaJobId = nba!.id;

      await ds.undoAudit({ params: { id: cs!.id }, body: {} } as never); // "New task: … · Undo"
      expect(await rows(db, sql`select 1 from work_items where id = ${sibId}`)).toHaveLength(0);
      expect((await jobRow(nbaJobId)).status).toBe('queued'); // the follow-up is still waiting
    } finally {
      await reeval.stop();
    }

    const w = nbaWorker();
    try {
      await drain(w);
    } finally {
      await w.stop();
    }
    const done = await jobRow(nbaJobId);
    expect(done).toMatchObject({ status: 'succeeded', attempts: 1, last_error_class: null });
    expect(done.result).toEqual({ outcome: 'skipped', skipped: 'gone', workItemId: sibId });
  });

  it('a job for an item that exists still reaches the generator (the BE-4 stub today)', async () => {
    const id = await makeItem(db, userId, { status: 'open' });
    const j = await enqueueJob(db, { ownerUserId: userId, kind: 'nba.generate', queue: 'nba', payload: { work_item_id: id, trigger: 'test' }, dedupeKey: `nba:work_item:${id}` });
    const w = nbaWorker();
    try {
      await drain(w);
    } finally {
      await w.stop();
    }
    expect(await jobRow(j.id)).toMatchObject({ status: 'succeeded', result: { notWired: true, owner: 'BE-4' } });
  });
});
