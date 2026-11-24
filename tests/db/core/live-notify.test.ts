/**
 * 0026_live_notify (D-73, docs/UX.md "Live updates") against Postgres: the unaudited tables the UI used to poll notify
 * `cc_change` on their transitions, under a `tx:` change set, so the live buses push them; a write that changes nothing
 * a view shows (a heartbeat, a lease) stays quiet; the read mirrors notify once per statement, with no row id.
 */
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimJobs, enqueueJob } from '../../../src/db/queue';
import { createUser, openTestDb, TEST_URL } from './helpers';

const h = openTestDb();
const db = h.db;
let userId: string;
let listen: Client;
const got: Array<{ cs: string; entity_type: string; entity_id: string; table: string; op: string }> = [];

beforeAll(async () => {
  userId = await createUser(db, 'live-notify');
  listen = new Client({ connectionString: TEST_URL });
  await listen.connect();
  listen.on('notification', (n) => {
    if (n.channel === 'cc_change' && n.payload) got.push(JSON.parse(n.payload));
  });
  await listen.query('LISTEN cc_change');
});
afterAll(async () => {
  await listen.end();
  await h.close();
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

describe('0026_live_notify', () => {
  it("a job's insert and status change notify (tx: change set, the job's id); a heartbeat does not", async () => {
    got.length = 0;
    const r = await enqueueJob(db, { ownerUserId: userId, kind: 'noop', queue: 'live-notify', payload: {} });
    const id = String(r.id);
    await settle();
    const ins = got.filter((n) => n.table === 'jobs');
    expect(ins.length).toBeGreaterThan(0);
    expect(ins[0]).toMatchObject({ entity_type: 'jobs', op: 'insert' });
    expect(ins[0]!.cs.startsWith('tx:')).toBe(true);
    expect(ins[0]!.entity_id).toBe(id);
    const jobId = ins[0]!.entity_id;

    got.length = 0;
    await db.execute(sql`update jobs set heartbeat_at = now() where id = ${jobId}::bigint`);
    await settle();
    expect(got.filter((n) => n.table === 'jobs')).toEqual([]);

    await claimJobs({ db, ownerUserId: userId, workerId: 'w-live', queues: ['live-notify'], limit: 1 }); // queued → running, the real claim
    await settle();
    expect(got.filter((n) => n.table === 'jobs').map((n) => n.op)).toEqual(['update']);
  });

  it('a read mirror notifies once per statement, with no row id', async () => {
    got.length = 0;
    await db.execute(sql`update vdp_records set id = id where false`); // a statement trigger fires even on no rows
    await settle();
    const v = got.filter((n) => n.table === 'vdp_records');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ entity_id: '', op: 'update' });
  });
});
