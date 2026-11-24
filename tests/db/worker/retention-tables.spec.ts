/**
 * E4 (audit 2026-11-13, lane E): table retention, against Postgres. Placeholders only.
 *  - the scan ledger compacts with the same coverage answers the scanner reads (gaps, span, low watermark, objects),
 *    and only then do old runs go (a run anything points at stays);
 *  - jobs by status and age, keeping the newest of each kind and anything a row still points at;
 *  - connector health checks, keeping each connector's newest;
 *  - the LLM audit trail: kept 400 days (whatever the options), then rolled up per day and deleted in one transaction,
 *    never twice, never a call something points at.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compactLedger, runTableRetention } from '@/jobs';
import { DbScannerStore } from '@/scanner/store-db';
import type { CoverageObject, ScopeKey } from '@/scanner/types';

import { createUser, openTestDb, uid } from './helpers';

const h = openTestDb(4);
const db = h.db;
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
let userId: string;

beforeAll(async () => {
  userId = await createUser(db, 'retention-e');
});
afterAll(() => h.close());

async function run(connectorId: string, scope: string, createdDays: number, extra: { status?: string } = {}): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`
    insert into scan_runs (owner_user_id, connector_id, scope, trigger, mode, status, started_at, finished_at, created_at)
    values (${userId}, ${connectorId}, ${scope}, 'schedule', 'incremental', ${extra.status ?? 'succeeded'}, ${at(createdDays)}::timestamptz,
            ${at(createdDays)}::timestamptz, ${at(createdDays)}::timestamptz) returning id`);
  return r.rows[0]!.id;
}

async function ledger(runId: string, connectorId: string, scope: string, row: { kind: string; ref: string | null; from?: string | null; to?: string | null; st?: string | null; et?: string | null; outcome?: string; createdDays: number; items?: number }) {
  await db.execute(sql`
    insert into scan_ledger_entries (scan_run_id, connector_id, scope, object_kind, object_external_id, covered_from, covered_to, start_token, end_token,
                                     item_count, outcome, created_at)
    values (${runId}, ${connectorId}, ${scope}, ${row.kind}::ledger_object_kind, ${row.ref}, ${row.from ?? null}::timestamptz, ${row.to ?? null}::timestamptz,
            ${row.st ?? null}, ${row.et ?? null}, ${row.items ?? 1}, ${row.outcome ?? 'complete'}::ledger_outcome, ${at(row.createdDays)}::timestamptz)`);
}

describe('scan ledger compaction and scan run retention', () => {
  const scope = `primary-${uid()}`;
  const SCOPE: ScopeKey = { connector: 'calendar', scope };
  /** The ledger and runs store the scope id (`connector:scope`), as the store writes them. */
  const scopeName = `calendar:${scope}`;
  let store: DbScannerStore;
  let connectorId: string;
  const runs: string[] = [];

  const answers = async () => {
    const listed: CoverageObject[] = [
      { kind: 'calendar_range', ref: 'cal-a', from: at(5), to: at(30.5) },
      { kind: 'calendar_range', ref: 'cal-a', from: at(5), to: at(41) }, // past the last coverage
      { kind: 'file', ref: 'file-x', to: at(12) },
      { kind: 'file', ref: 'file-x', to: at(15) }, // past file-x's furthest position
      { kind: 'file', ref: 'file-y' }, // read before, no position
      { kind: 'file', ref: 'file-z' }, // never read
    ];
    const low = await db.execute<{ low: string | null; n: number }>(sql`
      select min(covered_from)::text as low, count(*)::int as n from scan_ledger_entries
       where connector_id = ${connectorId} and scope = ${scopeName} and outcome = 'complete' and covered is not null`);
    const union = await db.execute<{ r: string }>(sql`
      select unnest(range_agg(covered))::text as r from scan_ledger_entries
       where connector_id = ${connectorId} and scope = ${scopeName} and outcome = 'complete' and covered is not null order by 1`);
    return {
      gaps: await store.coverageGaps(SCOPE, { from: at(-10), to: at(45) }),
      span: await store.coverageSpan(SCOPE),
      uncovered: (await store.uncoveredObjects(SCOPE, listed)).map((o) => `${o.ref}@${o.to ?? '-'}`),
      low: low.rows[0]!.low,
      union: union.rows.map((x) => x.r),
    };
  };
  const rows = async () => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from scan_ledger_entries where scope = ${scopeName}`)).rows[0]!.n);

  beforeAll(async () => {
    store = new DbScannerStore({ db, userId });
    connectorId = await store.connectorId('calendar');
    // 40 daily runs: cal-a covered day by day (with a rerun of each fifth day and a hole on day 20), file-x read at
    // growing positions with point ranges (Drive-like), file-y read with no range, an error row now and then, and the
    // scope's earliest start an empty range on day -5 (the low watermark)
    for (let d = 0; d < 40; d++) {
      const r = await run(connectorId, scopeName, d);
      runs.push(r);
      if (d !== 20) await ledger(r, connectorId, scopeName, { kind: 'calendar_range', ref: 'cal-a', from: at(d), to: at(d + 1), st: at(d), et: at(d + 1), createdDays: d });
      if (d % 5 === 0 && d) await ledger(r, connectorId, scopeName, { kind: 'calendar_range', ref: 'cal-a', from: at(d - 0.5), to: at(d + 0.5), createdDays: d });
      if (d < 15) await ledger(r, connectorId, scopeName, { kind: 'file', ref: 'file-x', from: at(d), to: at(d), et: at(d), createdDays: d });
      if (d % 7 === 0) await ledger(r, connectorId, scopeName, { kind: 'file', ref: 'file-y', createdDays: d });
      if (d % 3 === 0) await ledger(r, connectorId, scopeName, { kind: 'calendar_range', ref: 'cal-a', from: at(d), to: at(d + 3), outcome: 'error', createdDays: d });
    }
    await ledger(runs[0]!, connectorId, scopeName, { kind: 'file', ref: 'file-w', from: at(-5), to: at(-5), createdDays: 0 });
  });

  it('compacts to far fewer rows with the same coverage answers, and a second pass changes nothing', async () => {
    const before = await answers();
    const n0 = await rows();
    expect(before.uncovered).toEqual([`cal-a@${at(41)}`, `file-x@${at(15)}`, 'file-z@-']);
    // from the low watermark (day -5) on: up to day 0, the missed day 20 less the rerun's half, and after day 40
    expect(before.gaps).toEqual([{ from: at(-5), to: at(0) }, { from: at(20.5), to: at(21) }, { from: at(40), to: at(45) }]);
    const r = await runTableRetention(db, userId, { now: new Date(T0 + 70 * DAY), horizons: { scanRunsDays: 365 } }); // compact only
    expect(r.errors).toEqual([]);
    expect(r.ledgerRowsDropped).toBe(14); // the error rows (every third day)
    expect(r.ledgerRowsCompacted).toBeGreaterThan(40);
    expect(r.scanRunsDeleted).toBe(0);
    const n1 = await rows();
    expect(n1).toBeLessThan(10);
    expect(n1).toBeLessThan(n0 / 8);
    expect(await answers()).toEqual(before);
    // every kept row sits on one run, the newest of them (the anchor)
    const on = await db.execute<{ run: string }>(sql`select distinct scan_run_id as run from scan_ledger_entries where scope = ${scopeName}`);
    expect(on.rows.map((x) => x.run)).toEqual([runs[39]]);
    const again = await runTableRetention(db, userId, { now: new Date(T0 + 70 * DAY), horizons: { scanRunsDays: 365 } });
    expect([again.ledgerRowsCompacted, again.ledgerRowsWritten, again.ledgerRowsDropped]).toEqual([0, 0, 0]);
    expect(await rows()).toBe(n1);
  });

  it('then deletes old runs nothing points at, keeping the anchor, the newest, and a run a model call names', async () => {
    const before = await answers();
    await db.execute(sql`
      insert into llm_calls (owner_user_id, purpose, model, model_tier, request_hash, status, budget_day, scan_run_id, trigger, model_reason, outcome, content_hash)
      values (${userId}, 'scan_extract', 'model-x', 'haiku', 'h-run-pin', 'ok', '2026-01-10', ${runs[10]}, 'schedule', 'default', 'items:0', 'c-run-pin')`);
    const r = await runTableRetention(db, userId, { now: new Date(T0 + 200 * DAY) });
    expect(r.errors).toEqual([]);
    const left = (await db.execute<{ id: string }>(sql`select id from scan_runs where scope = ${scopeName}`)).rows.map((x) => x.id).sort();
    expect(left).toEqual([runs[10], runs[39]].sort());
    expect(r.scanRunsDeleted).toBe(38);
    expect(await answers()).toEqual(before); // nothing cascaded away
  });

  it('compactLedger keeps an object its furthest position when no merged range reaches it', () => {
    const row = (id: string, o: Partial<Parameters<typeof compactLedger>[0][number]>) => ({ id, scanRunId: 'r', kind: 'file', ref: 'f', from: null, to: null, startToken: null, endToken: null, items: 1, newItems: 0, createdAt: 0, ...o });
    const out = compactLedger([row('1', { from: 0, to: 100, endToken: '100' }), row('2', { from: 100, to: 200, endToken: '200' }), row('3', { endToken: '500' })]);
    expect(out.filter((x) => !x.keepId)).toEqual([expect.objectContaining({ from: 0, to: 200, endToken: '200', items: 2 })]);
    expect(out.filter((x) => x.keepId).map((x) => x.keepId)).toEqual(['3']);
  });
});

describe('jobs retention', () => {
  const NOW = new Date('2026-11-14T12:00:00Z');
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
  const job = async (kind: string, status: 'succeeded' | 'cancelled' | 'dead' | 'queued', days: number, o: { idem?: string } = {}) => {
    const r = await db.execute<{ id: string }>(sql`
      insert into jobs (owner_user_id, queue, kind, status, finished_at, dead_at, idempotency_key, created_at, updated_at)
      values (${userId}, 'maintenance', ${kind}, ${status}, ${status === 'queued' ? null : ago(days)}::timestamptz, ${status === 'dead' ? ago(days) : null}::timestamptz,
              ${o.idem ?? null}, ${ago(days)}::timestamptz, ${ago(days)}::timestamptz) returning id`);
    return r.rows[0]!.id;
  };

  it('deletes by status and age, keeps the newest of each kind, outbound records for 400 days, and anything pointed at', async () => {
    const k = `retention-test-${uid()}`;
    const oldDone = await job(k, 'succeeded', 40);
    const oldDone2 = await job(k, 'succeeded', 35);
    const recentDone = await job(k, 'succeeded', 5);
    const oldCancelled = await job(k, 'cancelled', 60);
    const newestCancelled = await job(k, 'cancelled', 50); // the newest cancelled one of the kind stays
    const oldDead = await job(k, 'dead', 100);
    const deadRecent = await job(k, 'dead', 50); // newer than 90 days
    const queued = await job(k, 'queued', 200);
    const outbound = await job(`outbox.dispatch.${k}`, 'succeeded', 100, { idem: `outbox.dispatch:${uid()}` });
    const outboundOld = await job(`outbox.dispatch.${k}`, 'succeeded', 500, { idem: `outbox.dispatch:${uid()}` });
    const pinned = await job(k, 'succeeded', 45);
    await db.execute(sql`insert into notifications (owner_user_id, kind, severity, title, dedupe_key, job_id) values (${userId}, 'job_dead_lettered', 'warn', 'placeholder', ${`job:${pinned}`}, ${pinned})`);
    const logged = await job(k, 'succeeded', 44); // only a model call names it: that link may go null
    await db.execute(sql`
      insert into llm_calls (owner_user_id, purpose, model, model_tier, request_hash, status, budget_day, job_id, trigger, model_reason, outcome, content_hash)
      values (${userId}, 'other', 'model-x', 'haiku', ${`h-${logged}`}, 'ok', '2026-10-01', ${logged}, 'schedule', 'default', 'ok', ${`c-${logged}`})`);

    const r = await runTableRetention(db, userId, { now: NOW });
    expect(r.errors).toEqual([]);
    const left = new Set((await db.execute<{ id: string }>(sql`select id from jobs where kind like ${`%${k}`}`)).rows.map((x) => x.id));
    for (const id of [oldDone, oldDone2, oldCancelled, oldDead, outboundOld, logged]) expect(left.has(id), `job ${id} should be gone`).toBe(false);
    for (const id of [recentDone, newestCancelled, deadRecent, queued, outbound, pinned]) expect(left.has(id), `job ${id} should stay`).toBe(true);
    const call = await db.execute<{ job_id: string | null }>(sql`select job_id from llm_calls where request_hash = ${`h-${logged}`}`);
    expect(call.rows[0]!.job_id).toBeNull(); // the call itself is the audit trail and stays
  });
});

describe('connector health checks retention', () => {
  it('drops checks over 30 days old, always keeping each connector its newest', async () => {
    const store = new DbScannerStore({ db, userId });
    const a = await store.connectorId('gmail');
    const b = await store.connectorId('drive');
    const NOW = new Date('2026-11-14T12:00:00Z');
    const put = (c: string, days: number) =>
      db.execute(sql`insert into connector_health_checks (connector_id, checked_at, ok, status, probe) values (${c}, ${new Date(NOW.getTime() - days * DAY).toISOString()}::timestamptz, true, 'healthy', 'probe')`);
    for (const d of [60, 50, 40, 10]) await put(a, d);
    for (const d of [70, 45]) await put(b, d);
    const r = await runTableRetention(db, userId, { now: NOW });
    expect(r.healthChecksDeleted).toBe(4);
    const left = await db.execute<{ c: string; n: number }>(sql`select connector_id as c, count(*)::int as n from connector_health_checks where connector_id in (${a}, ${b}) group by 1`);
    expect(Object.fromEntries(left.rows.map((x) => [x.c, x.n]))).toEqual({ [a]: 1, [b]: 1 });
  });
});

describe('LLM audit trail: 400 days, then daily rollups', () => {
  const NOW = new Date('2026-11-14T12:00:00Z');
  const day = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
  const D1 = day(500);
  const D2 = day(450);
  const RECENT = day(100);
  let uid2: string;
  const call = async (u: string, d: string, o: { trigger?: string; cost?: number; tokens?: number } = {}) => {
    const r = await db.execute<{ id: string }>(sql`
      insert into llm_calls (owner_user_id, purpose, model, model_tier, skill_key, request_hash, status, budget_day, input_tokens, output_tokens,
                             cache_read_tokens, cost_usd, trigger, model_reason, outcome, content_hash, latency_ms, started_at)
      values (${u}, 'scan_extract', 'model-x', 'haiku', 'scan-slack', ${`h-${uid()}`}, 'ok', ${d}::date, ${o.tokens ?? 100}, 10, 50, ${o.cost ?? 0.01},
              ${o.trigger ?? 'schedule'}, 'default', 'items:1', ${`c-${uid()}`}, 200, ${`${d}T12:00:00Z`}::timestamptz) returning id`);
    return r.rows[0]!.id;
  };
  const decision = (u: string, d: string, subject: string, o: { kind?: string; reason?: string; count?: number; callId?: string } = {}) =>
    db.execute(sql`
      insert into llm_decisions (owner_user_id, day, skill_key, kind, reason, trigger, subject, count, usd, llm_call_id, first_at, last_at)
      values (${u}, ${d}::date, 'scan-slack', ${o.kind ?? 'skip'}, ${o.reason ?? 'precheck_empty'}, 'schedule', ${subject}, ${o.count ?? 1}, 0.002,
              ${o.callId ?? null}, ${`${d}T08:00:00Z`}::timestamptz, ${`${d}T20:00:00Z`}::timestamptz)`);

  it('rolls up past 400 days in one go, keeps what a row points at, and never counts twice', async () => {
    uid2 = await createUser(db, 'rollup');
    for (let i = 0; i < 3; i++) await call(uid2, D1, { cost: 0.01, tokens: 100 });
    await call(uid2, D1, { trigger: 'manual', cost: 0.05 });
    const pinned = await call(uid2, D1);
    const thread = await db.execute<{ id: string }>(sql`insert into chat_threads (owner_user_id) values (${uid2}) returning id`);
    await db.execute(sql`insert into chat_messages (thread_id, seq, role, llm_call_id) values (${thread.rows[0]!.id}, 1, 'assistant', ${pinned})`);
    const escalated = await call(uid2, D2, { trigger: 'schedule', cost: 0.2 });
    await decision(uid2, D2, 'item-1', { kind: 'escalate', reason: 'verdict_changed', callId: escalated });
    await decision(uid2, D1, 'item-a', { count: 3 });
    await decision(uid2, D1, 'item-b', { count: 2 });
    const recent = await call(uid2, RECENT);
    await decision(uid2, RECENT, 'item-r');

    // the audit trail is kept at least 400 days, whatever the options say
    const r = await runTableRetention(db, uid2, { now: NOW, horizons: { llmAuditDays: 10 } });
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ llmCallsRolledUp: 5, llmDecisionsRolledUp: 3 });
    const days = await db.execute<{ day: string; trigger: string; calls: number; cost: string; input: string; cache_read: string; latency: string }>(sql`
      select day::text, trigger, calls, cost_usd::text as cost, input_tokens::text as input, cache_read_tokens::text as cache_read, latency_ms_total::text as latency
        from llm_call_days where owner_user_id = ${uid2} order by day, trigger`);
    expect(days.rows.map((x) => [x.day, x.trigger, x.calls, Number(x.cost), Number(x.input), Number(x.cache_read), Number(x.latency)])).toEqual([
      [D1, 'manual', 1, 0.05, 100, 50, 200],
      [D1, 'schedule', 3, 0.03, 300, 150, 600],
      [D2, 'schedule', 1, 0.2, 100, 50, 200], // freed once its decision rolled up
    ]);
    const dd = await db.execute<{ day: string; kind: string; decisions: number; count: number }>(sql`select day::text, kind, decisions, count from llm_decision_days where owner_user_id = ${uid2} order by day`);
    expect(dd.rows).toEqual([
      { day: D1, kind: 'skip', decisions: 2, count: 5 },
      { day: D2, kind: 'escalate', decisions: 1, count: 1 },
    ]);
    const callsLeft = (await db.execute<{ id: string }>(sql`select id from llm_calls where owner_user_id = ${uid2} order by id`)).rows.map((x) => x.id);
    expect(callsLeft).toEqual([pinned, recent].sort((a, b) => Number(a) - Number(b))); // the chat message keeps its call whole
    expect(Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from llm_decisions where owner_user_id = ${uid2}`)).rows[0]!.n)).toBe(1); // the recent one

    const again = await runTableRetention(db, uid2, { now: NOW });
    expect(again).toMatchObject({ llmCallsRolledUp: 0, llmDecisionsRolledUp: 0, llmDaysRolledUp: 0 }); // a pinned day isn't picked again
    const total = await db.execute<{ calls: number; cost: string }>(sql`select sum(calls)::int as calls, sum(cost_usd)::text as cost from llm_call_days where owner_user_id = ${uid2}`);
    expect([total.rows[0]!.calls, Number(total.rows[0]!.cost)]).toEqual([5, 0.28]);
  });
});
