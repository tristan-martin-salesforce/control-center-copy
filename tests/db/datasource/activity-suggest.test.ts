/**
 * Time rows that need an opportunity, on Postgres (placeholders only; run with `npm run test:be1b`).
 *
 * Parity: GET /time/log carries the same suggestion on both sides (the rules' ranking over the same read model). db
 * only: the `activity.suggest` pass (a fake model): it asks only about the rows the rules can't settle, books every
 * call in llm_calls with its D0 fields (trigger, model reason, content hash, outcome, tokens), keeps the answer in kv
 * `cc.time.suggestions` with the row's input hash, and GET /time shows it (basis `ai`) with nothing applied; a second
 * pass is a read (no call); a changed row is asked again; at the daily hard cap nothing is called. POST
 * /time/log/batches with `ids` stages only those rows.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../../../src/db/client';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { insertLlmCall } from '../../../src/db/ledger';
import { enqueueJob } from '../../../src/db/queue';
import { localDay } from '../../../src/engines/activity/time';
import { runActivitySuggest } from '../../../src/jobs/handlers/activity-suggest';
import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import { SUGGESTIONS_KV } from '../../../src/lib/time-suggest';
import type { CompletionModel } from '../../../src/scanner/completion/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';
import { both } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const T = (id: string) => L.idMap.get(id) ?? id;
/** A job context on a real queued job (llm_calls.job_id references it), as the worker hands one over. */
const job = async (n: number) => {
  const q = await enqueueJob(handle.db, { ownerUserId: L.userId, kind: 'activity.suggest', queue: 'engine', payload: { trigger: 'rows' }, dedupeKey: `activity.suggest:test:${n}` });
  return { job: { id: q.id, payload: { trigger: 'rows' } } as never, signal: new AbortController().signal, db: handle.db, userId: L.userId, clock: () => L.now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({ id: 0, inserted: false }), services: undefined };
};
const calls: string[] = [];
/** The fake model: every row is the first candidate, or internal for the Claude data-model row. */
const model: CompletionModel = async (req) => {
  calls.push(req.user);
  const internal = /member data model/i.test(req.user);
  return { ok: true, text: internal ? '{"choice": "internal", "confidence": 0.82, "reason": "A data model draft with no customer named"}' : '{"choice": 1, "confidence": 0.6, "reason": "The closest match"}', costUsd: 0.0004, inputTokens: 900, outputTokens: 30 };
};
const rowOf = async (seedId: string) => (await db.getActivityLog({ query: {} })).entries.find((e) => e.id === T(seedId))!;

describe.runIf(BE1B)('suggestions: mock ↔ db', () => {
  it('GET /time/log carries the same suggestion on both sides', async () => {
    const r = await both(L, db, 'getActivityLog', { query: {} });
    expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    const d = (r.raw.db as { entries: Array<{ id: string; suggestion: unknown }> }).entries;
    expect(d.find((e) => e.id === T('ac_tue_slack_initech'))?.suggestion).toMatchObject({ kind: 'opp', oppId: T('opp_initech_pilot'), basis: 'rules' });
    expect(d.find((e) => e.id === T('ac_mon_claude_model'))?.suggestion).toBeNull();
  });

  it('why the app proposed a row reads the same on both (the engine’s reason)', async () => {
    expect((await rowOf('ac_wed_roadmap')).why).toBe('external meeting, no keyword');
  });
});

describe.runIf(BE1B)('activity.suggest on db', () => {
  it('asks only about the rows the rules can’t settle, books each call with its D0 fields, and stores the answer (nothing applied)', async () => {
    const before = await rowOf('ac_mon_claude_model');
    const r = await runActivitySuggest((await job(901)) as never, { handle, model });
    expect(r).toMatchObject({ status: 'done', calls: expect.any(Number), answered: expect.any(Number), failed: 0 });
    expect(calls.some((u) => /member data model/i.test(u))).toBe(true);
    // a row the Slack channel settles is never asked
    expect(calls.some((u) => /Snowflake data share/i.test(u))).toBe(false);
    const rows = (await handle.db.execute<{ trigger: string; model_reason: string; outcome: string; content_hash: string; input_tokens: number; output_tokens: number; skill_key: string; purpose: string }>(sql`
      select trigger, model_reason, outcome, content_hash, input_tokens, output_tokens, skill_key, purpose::text from llm_calls where owner_user_id = ${L.userId} and skill_key = 'activity-suggest'`)).rows;
    expect(rows.length).toBe(r.calls);
    for (const x of rows) {
      expect(x).toMatchObject({ trigger: 'rows', model_reason: 'default', purpose: 'classify', input_tokens: 900, output_tokens: 30 });
      expect(x.outcome).toMatch(/^(opp|internal):\d+$/);
      expect(x.content_hash).toMatch(/^[0-9a-f]{32}$/);
    }
    const kv = (await handle.db.execute<{ value: { rows: Record<string, { kind: string }> } }>(sql`select value from user_settings where owner_user_id = ${L.userId} and key = ${SUGGESTIONS_KV}`)).rows[0]?.value;
    expect(kv?.rows[T('ac_mon_claude_model')]).toMatchObject({ kind: 'internal' });
    const after = await rowOf('ac_mon_claude_model');
    expect(after.suggestion).toMatchObject({ kind: 'internal', basis: 'ai', confidence: 0.82, reason: 'A data model draft with no customer named' });
    // nothing applied: the row is as it was
    expect(after).toMatchObject({ oppId: null, internal: false, status: before.status, version: before.version });
  });

  it('a second pass is a read; a row that changed is asked again', async () => {
    const n = calls.length;
    const again = await runActivitySuggest((await job(902)) as never, { handle, model });
    expect(again).toMatchObject({ calls: 0 });
    expect(calls.length).toBe(n);
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.user('test'), reason: 'test setup', undoable: false }, (tx) => tx.execute(sql`update activity_entries set description = 'Claude: member data model, second pass' where id = ${T('ac_mon_claude_model')}::uuid`));
    expect((await rowOf('ac_mon_claude_model')).suggestion).toBeNull(); // the old answer no longer applies
    const third = await runActivitySuggest((await job(903)) as never, { handle, model });
    expect(third).toMatchObject({ calls: 1 });
    expect((await rowOf('ac_mon_claude_model')).suggestion).toMatchObject({ basis: 'ai' });
  });

  it('at the daily hard cap nothing is called (the rows keep the rules’ suggestion)', async () => {
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.user('test'), reason: 'test setup', undoable: false }, (tx) => tx.execute(sql`update activity_entries set description = 'Claude: member data model, third pass' where id = ${T('ac_mon_claude_model')}::uuid`));
    const n = calls.length;
    // spend today up to the hard cap (booked like any call, with its D0 fields)
    const tz = (await handle.db.execute<{ tz: string | null }>(sql`select timezone as tz from users where id = ${L.userId}`)).rows[0]?.tz ?? 'UTC';
    const day = localDay(L.now.getTime(), tz);
    const id = await insertLlmCall(handle.db, { ownerUserId: L.userId, purpose: 'other', model: 'claude-haiku-5-5', skillKey: 'test-cap', status: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 1000, budgetDay: day, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'f'.repeat(32), rollup: false });
    const capped = await runActivitySuggest((await job(904)) as never, { handle, model });
    expect(calls.length).toBe(n);
    expect(capped).toMatchObject({ calls: 0, deferred: 'daily_hard_cap' });
    await handle.db.execute(sql`delete from llm_calls where id = ${id}`);
  });

  it('a logging batch of the rows you ticked takes only those (POST /time/log/batches ids)', async () => {
    const held = { rows: new Map<string, string>(), updates: new Set<string>() };
    const base = { now: L.now, timezone: 'America/Denver', approveComplete: true, recordTypeId: '012XX0000000MOCKAA', held };
    const all = await buildLogBatch(handle.db, L.userId, base);
    expect(all.events).toBeGreaterThanOrEqual(1);
    const one = await buildLogBatch(handle.db, L.userId, { ...base, ids: new Set([T('ac_tue_sow')]) });
    expect(one.events).toBe(1);
    expect(one.canvases.flatMap((c) => c.eventIds)).toEqual([T('ac_tue_sow')]);
    // picked rows none of which are ready: no canvas at all
    const none = await buildLogBatch(handle.db, L.userId, { ...base, ids: new Set([T('ac_mon_claude_model')]) });
    expect(none.canvases).toEqual([]);
  });

  it('caps audit: a pass that stops at its page with rows still due queues the next page (every row is asked)', async () => {
    // forget every stored answer: every row the rules can't place is due again
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.user('test'), reason: 'test setup', undoable: false }, (tx) => tx.execute(sql`delete from user_settings where owner_user_id = ${L.userId} and key = ${SUGGESTIONS_KV}`));
    const queued: Array<{ kind: string; dedupeKey?: string }> = [];
    const ctx = { ...(await job(905)), enqueue: async (i: { kind: string; dedupeKey?: string }) => (queued.push(i), { id: 1, inserted: true }) };
    const first = await runActivitySuggest(ctx as never, { handle, model, maxCalls: 1 });
    expect(first.due as number).toBeGreaterThan(1);
    expect(first).toMatchObject({ calls: 1, more: true, nextPage: true });
    expect(queued).toEqual([expect.objectContaining({ kind: 'activity.suggest', dedupeKey: `activity.suggest:${L.userId}` })]);
    // the pages run until nothing is due; the last one queues nothing
    let last = first;
    for (let i = 0; i < 20 && last.more; i += 1) last = await runActivitySuggest(ctx as never, { handle, model, maxCalls: 1 });
    expect(last.more).toBeUndefined();
    expect(await runActivitySuggest(ctx as never, { handle, model, maxCalls: 1 })).toMatchObject({ calls: 0 });
  });
});
