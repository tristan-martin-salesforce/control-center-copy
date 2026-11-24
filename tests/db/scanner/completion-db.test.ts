/**
 * CMP-1 completion pass on the real path (Postgres): a scan stores my reply → the scan afterRun hook queues ONE
 * `completion.check` → the job (fake model, real DbScannerStore) links `completion` evidence through the scanner
 * writer → the W2 bump queues `reevaluate` → the closure machine closes the item as done (engine, L4) → it shows in
 * "Closed for you" (statement Q6) with its Undo change set. A "promise only" item stays open. Placeholder data only.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { statementSql } from '../../../src/db/queries';
import { createDefaultRegistry } from '../../../src/jobs';
import { COMPLETION_JOB_KIND, completionDedupeKey, completionHandler, enqueueCompletionCheck, lastCompletionWatermark } from '../../../src/jobs/handlers/completion';
import { reevaluateHandler } from '../../../src/jobs/handlers/reevaluate';
import type { CompletionModel } from '../../../src/scanner/completion';
import { DbScannerStore } from '../../../src/scanner/store-db';
import type { NormalizedSourceItem } from '../../../src/scanner/types';
import { WorkerRuntime } from '../../../src/worker/runtime';
import { buildScanning } from '../../../src/worker/scanning';
import { loadProfileIntoDb, PLACEHOLDER_PROFILE } from '../../../scripts/stress/lib/profile';

import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

const ASKER = { name: 'PERSON_A', externalId: 'U0PERSONA' };
const ME = { name: 'ME', externalId: PLACEHOLDER_PROFILE.me.slackId, isMe: true };

describe.skipIf(!pgAvailable())('completion pass, db end to end', () => {
  let t: TestDb;
  let userId: string;
  let store: DbScannerStore;
  const calls: string[] = [];
  /** Done when my message delivers ("here is") the item's thing (a title word); a promise is not done. */
  const model: CompletionModel = async (req) => {
    calls.push(req.model);
    const r = JSON.parse(req.user) as { items: Array<{ id: string; title: string; candidates: Array<{ id: string; by: string; text: string }> }> };
    const verdicts = r.items.map((it) => {
      const words = it.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !['send', 'review', 'person_a', 'acme'].includes(w));
      const c = it.candidates.filter((x) => x.by === 'me' && /here is/i.test(x.text) && words.some((w) => x.text.toLowerCase().includes(w))).pop();
      return c ? { item: it.id, verdict: 'done', source: c.id, basis: 'delivered', confidence: 0.96, reason: 'sent the deck in the DM' } : { item: it.id, verdict: 'not_done', basis: 'none', confidence: 0.1, reason: 'a promise' };
    });
    return { ok: true, text: JSON.stringify({ verdicts }), costUsd: 0.0008, inputTokens: 3000, outputTokens: 90 };
  };

  const ts = (ms: number) => (ms / 1000).toFixed(6);
  const msg = (atMs: number, ch: string, text: string, author: typeof ASKER | typeof ME): NormalizedSourceItem => ({
    connector: 'slack',
    kind: 'message',
    externalId: `${ch}:${ts(atMs)}`,
    dedupeKey: `slack:${ch}:${ts(atMs)}`,
    contentHash: randomUUID(),
    occurredAt: new Date(atMs).toISOString(),
    threadRef: `slack:${ch}:${ts(atMs)}`,
    excerpt: text,
    author,
    participants: [ASKER, ME],
  });

  async function scanRun(items: NormalizedSourceItem[], propose?: { title: string; originIdx: number }) {
    const now = new Date();
    const window = { from: new Date(now.getTime() - 60 * 60_000).toISOString(), to: now.toISOString() };
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window });
    const rec = await store.recordSourceItems(runId, items);
    let workItemId: string | undefined;
    if (propose) workItemId = (await store.proposeItem(runId, { kind: 'ask', title: propose.title, evidence: [{ sourceItemId: rec[propose.originIdx]!.sourceItemId, role: 'origin', reason: 'direct ask' }], confidence: 'sure' })).workItemId;
    await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'search:dm', from: window.from, to: window.to }]);
    await store.finishRun(runId, { cursor: { value: ts(now.getTime()), at: window.to }, stats: { fetched: items.length, new: items.length, changed: 0, linked: 0, proposed: propose ? 1 : 0, unlinked: 0, costUsd: 0 } });
    return { runId, workItemId };
  }

  beforeAll(async () => {
    t = await provisionTestDb('completion');
    userId = await loadProfileIntoDb(t.handle.db, PLACEHOLDER_PROFILE, { channels: [] });
    store = new DbScannerStore({ db: t.handle.db, userId });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it('my reply closes the ask (Closed for you, undoable); a promise-only ask stays open', async () => {
    const db = t.handle.db;
    const base = Date.now() - 50 * 60_000;
    const kept = await scanRun([msg(base, 'D0DM00001', 'Can you send me the ACME pilot deck?', ASKER)], { title: 'Send PERSON_A the ACME pilot deck', originIdx: 0 });
    const promised = await scanRun([msg(base + 60_000, 'D0DM00002', 'Can you review the ACME SOW?', ASKER)], { title: 'Review the ACME SOW for PERSON_A', originIdx: 0 });
    // The later scan: my delivery in the first DM, a promise in the second.
    const later = await scanRun([msg(base + 20 * 60_000, 'D0DM00001', 'Here is the deck: https://docs.google.com/presentation/d/FILE_ACME_PILOT_0001/edit', ME), msg(base + 21 * 60_000, 'D0DM00002', "I'll review it tomorrow", ME)]);

    // The scan afterRun hook queues one check (and only one while it is queued).
    const scanning = buildScanning({ db, userId, store, clock: { now: () => new Date(), sleep: async () => undefined }, fetchers: [], llm: false, completionCheck: true });
    const job = { kind: 'scan', connector: 'slack', scope: 'inbox', mode: 'incremental', trigger: 'schedule', window: { from: '', to: '' }, id: 'x', dedupeKey: 'x', priority: 0, runAt: '' } as never;
    await scanning.handlerDeps.afterRun!(job, { status: 'succeeded', runId: later.runId, followUps: [] }, {} as never);
    await scanning.handlerDeps.afterRun!(job, { status: 'succeeded', runId: later.runId, followUps: [] }, {} as never);
    const queued = await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = ${COMPLETION_JOB_KIND} and dedupe_key = ${completionDedupeKey(userId)} and status = 'queued'`);
    expect(queued.rows[0]!.n).toBe(1);
    await db.execute(sql`update jobs set run_at = now() where kind = ${COMPLETION_JOB_KIND} and status = 'queued'`);

    const registry = createDefaultRegistry();
    registry.wire(COMPLETION_JOB_KIND, completionHandler({ model, limits: { settleMs: 0 } }));
    registry.wire('reevaluate', reevaluateHandler({ supersededWaitMs: 200 }));
    const runtime = new WorkerRuntime({ db, userId, workerId: `completion-test:${randomUUID().slice(0, 8)}`, registry, services: {}, listenUrl: null, hooks: [], log: () => undefined, drainMs: 200 });
    try {
      const deadline = Date.now() + 60_000;
      for (;;) {
        await runtime.pollOnce();
        await runtime.idle(30_000);
        const st = await db.execute<{ status: string }>(sql`select status::text from work_items where id = ${kept.workItemId}`);
        const open = await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind in ('reevaluate', ${COMPLETION_JOB_KIND}) and status in ('queued', 'running')`);
        if (st.rows[0]!.status === 'done' && open.rows[0]!.n === 0) break;
        if (Date.now() > deadline) throw new Error(`timed out: item ${st.rows[0]!.status}, open jobs ${open.rows[0]!.n}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      await runtime.stop('test done');
    }

    expect(calls).toEqual(['claude-haiku-5-5']);
    const ev = await db.execute<{ role: string; rationale: string; confidence: number }>(sql`
      select role::text, rationale, confidence::float8 as confidence from work_item_evidence where work_item_id = ${kept.workItemId} and role = 'completion'`);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.rationale).toMatch(/^done_check: /);
    const item = await db.execute<{ status: string; resolution: string; done_by: string; resolution_inferred: boolean }>(sql`select status::text, resolution::text, done_by::text, resolution_inferred from work_items where id = ${kept.workItemId}`);
    expect(item.rows[0]).toMatchObject({ status: 'done', resolution: 'done_by_me', done_by: 'engine', resolution_inferred: true });
    const other = await db.execute<{ status: string; n: number }>(sql`
      select w.status::text, (select count(*)::int from work_item_evidence e where e.work_item_id = w.id and e.role = 'completion') as n from work_items w where w.id = ${promised.workItemId}`);
    expect(other.rows[0]).toMatchObject({ status: 'open', n: 0 });

    // "Closed for you" (Q6) lists it with the change set its Undo reverts.
    const dayStart = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const closed = await db.execute<{ work_item_id: string; undo_change_set_id: string | null; rationale: string | null }>(statementSql('Q6', [userId, dayStart]));
    const row = closed.rows.find((r) => r.work_item_id === kept.workItemId);
    expect(row?.undo_change_set_id).toBeTruthy();
    expect(row?.rationale).toMatch(/^done_check: /);

    // The evidence was written by a completion run on the cited source's connector, and the spend was recorded.
    const runs = await db.execute<{ scope: string; status: string; cost: number }>(sql`select scope, status::text, cost_usd::float8 as cost from scan_runs where scope = 'slack:completion:check'`);
    expect(runs.rows).toEqual([{ scope: 'slack:completion:check', status: 'succeeded', cost: 0.0008 }]);
    const spend = await db.execute<{ n: number }>(sql`select count(*)::int as n from llm_calls where scan_run_id is not null and cost_usd > 0`);
    expect(spend.rows[0]!.n).toBe(1);

    // The watermark moved; a second pass with nothing new makes no call.
    const wm = await lastCompletionWatermark(db, userId);
    expect(wm?.through).toBeTruthy();
    expect(await enqueueCompletionCheck(db, userId, { trigger: 'manual', delaySeconds: 0 })).toBe(true);
    const r2 = new WorkerRuntime({ db, userId, workerId: `completion-test:${randomUUID().slice(0, 8)}`, registry, services: {}, listenUrl: null, hooks: [], log: () => undefined, drainMs: 200 });
    try {
      await r2.pollOnce();
      await r2.idle(30_000);
    } finally {
      await r2.stop('test done');
    }
    expect(calls).toHaveLength(1);
    // jobs.result carries counts and ids only, never message text or model reasons.
    const res = await db.execute<{ result: string }>(sql`select result::text from jobs where kind = ${COMPLETION_JOB_KIND} and status = 'succeeded'`);
    for (const x of res.rows) expect(x.result).not.toMatch(/deck|review|done_check/i);
  });
});
