/**
 * Lane D (audit 2026-11-13) on Postgres, placeholders only: the ledger's audit fields, decisions, reservations (D6),
 * a scan's rest spend booked with its tokens per model (D0), the Slack pre-check skipping a traversal (D5), the
 * Claude-sessions quiet items (D3) and the Spend & decisions read side (view, detail, repeats).
 *
 * Database: control_center_ledger_<CC_TEST_DB_SUFFIX>, created once, migrated, emptied and bootstrapped per run.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb as createTestDb, pgAvailable } from '../../support/pg';

import { createDb, type Db, type DbHandle } from '../../../src/db/client';
import { insertLlmCall, ledgerHash, recordDecision, reserveBudget } from '../../../src/db/ledger';
import { runMigrations } from '../../../src/db/migrate';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { deterministicSpec, slackSpec } from '../../../src/scanner/runtime/connectors';
import { scanJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { DbScannerStore } from '../../../src/scanner/store-db';
import type { DeterministicFetcher, NormalizedSourceItem, SkillRunner } from '../../../src/scanner/types';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';
import { loadSpendAudit, loadSpendAuditDetail } from '../../../src/server/datasource/db/store/spend-audit';


const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').replace(/[^a-z0-9]/g, '');
const URL_ = `postgres://localhost:5432/control_center_ledger_${SUFFIX}`;
const NOW = new Date('2026-11-13T17:00:00.000Z');
const DAY = '2026-11-13'; // America/Denver
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

let handle: DbHandle;
let db: Db;
let userId: string;
let store: DbScannerStore;

async function freshDb() {
  const u = new URL(URL_);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^control_center_ledger_[a-z0-9]+$/.test(name)) throw new Error(`ledger tests only run against control_center_ledger_*, not "${name}"`);
  await createTestDb(name, { reuse: true });
  await runMigrations({ url: URL_, log: () => {} });
  const h = createDb({ url: URL_, max: 8, applicationName: 'ledger-test' });
  const res = await h.db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = res.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await h.db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  const b = await bootstrapUser({
    db: h.db,
    profile: { email: 'ada@corp.example', name: 'Ada Example', role: 'se_ic', timezone: 'America/Denver', workingHours: { start: '07:30', end: '17:30', days: [1, 2, 3, 4, 5] }, slackUserId: 'U0ME00001', org62UserId: '005XX0000000001AAA' },
    now: NOW,
  });
  return { h, userId: b.userId };
}

const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];

beforeAll(async () => {
  if (!pgAvailable) return;
  const f = await freshDb();
  handle = f.h;
  db = handle.db;
  userId = f.userId;
  store = new DbScannerStore({ db, userId, clock: () => NOW });
});

afterAll(async () => {
  await handle?.close();
});

describe.skipIf(!pgAvailable)('the ledger write side', () => {
  it('a call carries every audit field and rolls up into the day', async () => {
    const id = await insertLlmCall(db, {
      ownerUserId: userId,
      purpose: 'summarize',
      model: SONNET,
      skillKey: 'readin-ask',
      promptVersion: 'readin-ask@2',
      status: 'ok',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 3000,
      costUsd: 0.05,
      budgetDay: DAY,
      trigger: 'direct_ask',
      modelReason: 'policy:direct_ask',
      contentHash: ledgerHash('x'),
      outcome: 'ready',
    });
    expect(id).toBeGreaterThan(0);
    const [r] = rows<Record<string, unknown>>(await db.execute(sql`select model_tier::text as tier, trigger, model_reason, content_hash, outcome, cache_read_tokens, cache_write_tokens, input_tokens from llm_calls where id = ${id}`));
    expect(r).toMatchObject({ tier: 'sonnet', trigger: 'direct_ask', model_reason: 'policy:direct_ask', content_hash: ledgerHash('x'), outcome: 'ready', cache_read_tokens: 40_000, cache_write_tokens: 3000, input_tokens: 1200 });
    const [d] = rows<{ spent: string }>(await db.execute(sql`select d.spent_usd as spent from llm_budget_days d join llm_budgets b on b.id = d.budget_id where b.owner_user_id = ${userId} and d.day = ${DAY}::date`));
    expect(Number(d!.spent)).toBeCloseTo(0.05, 6);
  });

  it('a decision counts per (day, skill, kind, reason, trigger, subject); a state-like one only once', async () => {
    const d = { skill: 'scan-claude-sessions', kind: 'skip' as const, reason: 'status_only', trigger: 'file_watch', subject: 'session-1', day: DAY };
    expect(await recordDecision(db, userId, d)).toBe(true);
    await recordDecision(db, userId, d);
    await recordDecision(db, userId, { ...d, subject: 'session-2' });
    const b = { skill: 'readin-ask', kind: 'block' as const, reason: 'readin_cap', trigger: 'top_rank', subject: 'work_item:x', day: DAY, once: true };
    await recordDecision(db, userId, b);
    await recordDecision(db, userId, b);
    const got = rows<{ subject: string; count: number }>(await db.execute(sql`select subject, count from llm_decisions where owner_user_id = ${userId} order by subject`));
    expect(got).toEqual([
      { subject: 'session-1', count: 2 },
      { subject: 'session-2', count: 1 },
      { subject: 'work_item:x', count: 1 },
    ]);
    // a bad decision never throws
    expect(await recordDecision(db, userId, { ...d, kind: 'nope' as never })).toBe(false);
  });

  it('D6: parallel holds never pass the hard cap together; released holds free it', async () => {
    const day = '2026-11-14';
    await insertLlmCall(db, { ownerUserId: userId, purpose: 'other', model: HAIKU, skillKey: 'test', status: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 0.5, budgetDay: day, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: ledgerHash('hold') });
    const holds = await Promise.all(Array.from({ length: 10 }, () => reserveBudget(db, userId, { day, usd: 0.1, hardCapUsd: 1 })));
    expect(holds.filter((h) => h.ok)).toHaveLength(5);
    const refused = holds.find((h) => !h.ok)!;
    expect(refused.heldUsd).toBe(0);
    await Promise.all(holds.map((h) => h.release()));
    await Promise.all(holds.map((h) => h.release())); // idempotent
    const [r] = rows<{ reserved: string }>(await db.execute(sql`select d.reserved_usd as reserved from llm_budget_days d join llm_budgets b on b.id = d.budget_id where b.owner_user_id = ${userId} and d.day = ${day}::date`));
    expect(Number(r!.reserved)).toBe(0);
    expect((await reserveBudget(db, userId, { day, usd: 0.5, hardCapUsd: 1 })).ok).toBe(true);
  });
});

describe.skipIf(!pgAvailable)('D0: a scan books every dollar with its tokens', () => {
  it('spend no pass row covers is booked per model from the SDK usage, with the trigger and why', async () => {
    await store.recordSpend({
      connector: 'gmail',
      model: HAIKU,
      costUsd: 0.03,
      inputTokens: 700,
      outputTokens: 70,
      usage: [
        { model: HAIKU, inputTokens: 500, outputTokens: 50, cacheReadTokens: 8000, cacheWriteTokens: 100, costUsd: 0.01 },
        { model: SONNET, inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 },
      ],
      trigger: 'schedule',
      modelReason: 'default',
      contentHash: ledgerHash('gmail-run'),
      outcome: 'nothing_new',
    });
    const got = rows<{ model: string; cost: string; input_tokens: number; cache_read_tokens: number; trigger: string; model_reason: string; skill_key: string }>(
      await db.execute(sql`select model, cost_usd as cost, input_tokens, cache_read_tokens, trigger, model_reason, skill_key from llm_calls where content_hash = ${ledgerHash('gmail-run')} order by model`),
    );
    expect(got.map((g) => g.model)).toEqual([HAIKU, SONNET]);
    expect(got.reduce((a, g) => a + Number(g.cost), 0)).toBeCloseTo(0.03, 6);
    expect(got[0]).toMatchObject({ input_tokens: 500, cache_read_tokens: 8000, trigger: 'schedule', model_reason: 'default', skill_key: 'scan-gmail' });
    expect(got[1]).toMatchObject({ input_tokens: 200 });
  });
});

describe.skipIf(!pgAvailable)('D5 and D3 through the runtime', () => {
  const W = { from: '2026-11-13T16:50:00.000Z', to: '2026-11-13T17:00:00.000Z' };
  it('an empty Slack pre-check finishes the poll without the traversal: coverage, cursor, its own spend and the decision', async () => {
    const runner: SkillRunner = { run: async () => { throw new Error('the traversal must not run'); } };
    const rt = new ScannerRuntime({
      store,
      runner,
      specs: [
        slackSpec({
          mcpServers: () => ({}),
          precheck: async (i) => ({ empty: true, coverage: ['search:dm', 'search:mentions', 'search:mine', 'search:mine:files'].map((ref) => ({ kind: 'query_window' as const, ref, from: i.window.from, to: i.window.to })), cursor: { value: `${Date.parse(i.window.to) / 1000}.000000`, at: i.window.to }, costUsd: 0.0024, calls: 3, model: HAIKU, inputTokens: 1200, outputTokens: 180, cacheReadTokens: 12_000, cacheWriteTokens: 0, why: 'empty' }),
        }),
      ],
      reevaluate: async () => {},
      clock: new FakeClock(NOW.toISOString()),
      firstScan: null,
    });
    const out = await rt.executeJob(scanJob({ connector: 'slack', scope: 'inbox', window: W, mode: 'incremental', trigger: 'schedule', runAt: NOW.toISOString() }));
    expect(out.status).toBe('succeeded');
    const cur = await store.getCursor({ connector: 'slack', scope: 'inbox' });
    expect(cur?.at).toBe(W.to);
    const [pre] = rows<{ skill_key: string; cost: string; cache_read_tokens: number; outcome: string; trigger: string }>(await db.execute(sql`select skill_key, cost_usd as cost, cache_read_tokens, outcome, trigger from llm_calls where scan_run_id = ${out.runId}::uuid`));
    expect(pre).toMatchObject({ skill_key: 'slack-precheck', cache_read_tokens: 12_000, outcome: 'empty', trigger: 'schedule' });
    const [d] = rows<{ kind: string; reason: string; subject: string }>(await db.execute(sql`select kind, reason, subject from llm_decisions where skill_key = 'scan-slack' and reason = 'precheck_empty'`));
    expect(d).toMatchObject({ kind: 'skip', subject: 'slack:inbox' });
  });

  it('quiet items are recorded without the model, with their reasons; the rest goes to the model', async () => {
    const item = (id: string, status: string): NormalizedSourceItem => ({ connector: 'claude_sessions', kind: 'claude_session', externalId: id, dedupeKey: `claude:${id}`, contentHash: `${id}:${status}`, occurredAt: NOW.toISOString(), title: `Session ${id}`, excerpt: '', redacted: false, threadRef: `claude-session:${id}`, payload: { sessionId: id, status } });
    const fetcher: DeterministicFetcher = {
      connector: 'claude_sessions',
      scopes: async () => ['all'],
      health: async () => ({ state: 'ok', checkedAt: NOW.toISOString() }),
      listForReconcile: async () => [],
      fetch: async () => ({ items: [item('s-new', 'waiting')], quietItems: [item('s-busy', 'idle')], decisions: [{ reason: 'status_only', subject: 's-busy' }], coverage: [{ kind: 'session', ref: 'claude:registry', from: W.from, to: W.to }], nextCursor: { value: 'c', at: W.to }, complete: true }),
    } as unknown as DeterministicFetcher;
    const seen: string[] = [];
    const runner: SkillRunner = {
      run: async (input, st) => {
        seen.push(...(input.prefetched ?? []).map((x) => x.externalId));
        // the real runner stages the fetcher's coverage on the run (so the cursor can commit)
        if (input.preReportedCoverage?.length) await st.reportCoverage(input.runId, input.preReportedCoverage);
        return { ok: true, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 1, counts: { recorded: 1, new: 1, changed: 0, linked: 0, proposed: 0, unlinked: 0, coverage: 1 } };
      },
    };
    const rt = new ScannerRuntime({ store, runner, specs: [deterministicSpec(fetcher)], reevaluate: async () => {}, clock: new FakeClock(NOW.toISOString()), firstScan: null });
    const out = await rt.executeJob(scanJob({ connector: 'claude_sessions', scope: 'all', window: W, mode: 'incremental', trigger: 'file_watch', runAt: NOW.toISOString() }));
    expect(out.detail ?? out.status).toBe('succeeded');
    expect(seen).toEqual(['s-new']);
    const recorded = rows<{ external_id: string }>(await db.execute(sql`select external_id from source_items where kind = 'claude_session' order by external_id`)).map((r) => r.external_id);
    expect(recorded).toEqual(['s-busy']); // the runner stub records nothing itself; the quiet one the runtime recorded
    const [d] = rows<{ skill_key: string; trigger: string }>(await db.execute(sql`select skill_key, trigger from llm_decisions where reason = 'status_only' and subject = 's-busy'`));
    expect(d).toEqual({ skill_key: 'scan-claude-sessions', trigger: 'file_watch' });
  });
});

describe.skipIf(!pgAvailable)('Spend & decisions, read side', () => {
  it('the period by skill, model and trigger, identical repeats, decisions; a day drills down to its calls', async () => {
    const h = ledgerHash('same prompt');
    for (let i = 0; i < 2; i++) await insertLlmCall(db, { ownerUserId: userId, purpose: 'done_match', model: HAIKU, skillKey: 'settle-item', status: 'ok', inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, costUsd: 0.001, budgetDay: DAY, trigger: 'interval', modelReason: 'default', outcome: 'ok', contentHash: h, startedAt: new Date(NOW.getTime() + i * 1000) });
    await recordDecision(db, userId, { skill: 'settle-item', kind: 'escalate', reason: 'verdict_changed', trigger: 'interval', subject: 'wi-1', usd: 0.02, day: DAY });
    await recordDecision(db, userId, { skill: 'settle-item', kind: 'escalate', reason: 'verdict_same', trigger: 'interval', subject: 'wi-2', usd: 0.02, day: DAY });
    const p = await loadSpendAudit(db, userId, { from: '2026-11-07', to: DAY }, { now: NOW, timezone: 'America/Denver' });
    expect(p.from).toBe('2026-11-07');
    expect(p.byDay).toHaveLength(7);
    expect(p.totals.repeatCalls).toBeGreaterThanOrEqual(1);
    expect(p.bySkill.map((s) => s.key)).toEqual(expect.arrayContaining(['readin-ask', 'settle-item', 'slack-precheck']));
    expect(p.byTrigger.map((s) => s.key)).toEqual(expect.arrayContaining(['direct_ask', 'interval', 'schedule']));
    expect(p.settleEscalation).toMatchObject({ escalated: 2, changed: 1, changedPct: 50 });
    expect(p.decisions.find((d) => d.reason === 'status_only')).toMatchObject({ skill: 'scan-claude-sessions', count: 4 });
    const detail = await loadSpendAuditDetail(db, userId, { day: DAY, skill: 'settle-item', offset: 0, limit: 1 });
    expect(detail.totalCalls).toBe(2);
    expect(detail.calls).toHaveLength(1);
    expect(detail.calls[0]!.repeatOf).not.toBeNull(); // the newest is the repeat of the first
    expect(detail.decisions.map((d) => d.reason).sort()).toEqual(['verdict_changed', 'verdict_same']);
  });
});
