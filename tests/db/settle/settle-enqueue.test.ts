/**
 * SETTLE-1 queueing against a scratch database: the hook's enqueue must run on the real jobs table (before, it
 * filtered on a status the job_status enum doesn't have, so every attempt threw and no pass was ever queued).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SETTLE_JOB_KIND, enqueueSettleCheck } from '../../../src/jobs/handlers/settle';
import { settleHook } from '../../../src/worker/settle-hook';
import { pgAvailable, provisionTestDb, type TestDb } from '../scanner/helpers/pg';


describe.skipIf(!pgAvailable())('settle.check queueing (scratch database)', () => {
  let t: TestDb;
  let userId = '';
  beforeAll(async () => {
    t = await provisionTestDb('settle_enqueue');
    const u = await t.handle.db.execute<{ id: string }>(sql`insert into users (email, display_name, timezone) values ('placeholder@example.com', 'ME Person', 'America/Denver') returning id`);
    userId = u.rows[0]!.id;
  });
  afterAll(async () => t?.drop());

  const queued = async () => (await t.handle.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = ${SETTLE_JOB_KIND} and status = 'queued'`)).rows[0]!.n;

  it('queues one pass and keeps a single one queued', async () => {
    expect(await enqueueSettleCheck(t.handle.db, userId, { trigger: 'first_scan' })).toBe(true);
    expect(await enqueueSettleCheck(t.handle.db, userId, { trigger: 'interval' })).toBe(false);
    expect(await queued()).toBe(1);
  });

  it('the hook waits for an explicit first-scan done, then queues without an error', async () => {
    await t.handle.db.execute(sql`delete from jobs where kind = ${SETTLE_JOB_KIND}`);
    const logs: string[] = [];
    let state: { status?: string } | null = null;
    const hook = settleHook(t.handle.db, userId, (m) => logs.push(m), { readState: () => state });
    await hook.run();
    state = { status: 'active' };
    await hook.run();
    expect(await queued()).toBe(0);
    state = { status: 'done' };
    await hook.run();
    expect(await queued()).toBe(1);
    expect(logs.some((m) => /could not queue/.test(m))).toBe(false);
    expect(logs.some((m) => /queued the first Settle pass/.test(m))).toBe(true);
  });
});
