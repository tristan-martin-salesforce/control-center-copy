/**
 * AUDIT on Postgres (the real path, placeholders only): a Slack scan through the ScannerRuntime, the AgentSdkSkillRunner
 * (a fake CLI), the DbScannerStore and the database trace sink. Then the read side: the run's ordered trace,
 * "why wasn't this picked up?" for a recorded and an unrecorded message, the provenance chain of a proposed item, the
 * per-scope report, spend attribution (run, job, budget) and the Health error feed (a failure opens an event, a success
 * closes it).
 *
 * Database: control_center_trace_<CC_TEST_DB_SUFFIX>, created once, migrated, emptied and bootstrapped per run.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb as createTestDb, pgAvailable } from '../../support/pg';

import { createDb, type Db, type DbHandle } from '../../../src/db/client';
import { enqueueJob } from '../../../src/db/queue';
import { runMigrations } from '../../../src/db/migrate';
import { runRetentionScrub } from '../../../src/jobs/handlers/retention';
import { AgentSdkSkillRunner } from '../../../src/llm/skill-runner';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { slackRecallDefaults, slackSpec } from '../../../src/scanner/runtime/connectors';
import { scanJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { DbTraceSink, setTraceSink, trace, withTraceContext } from '../../../src/scanner/trace';
import { explainSourceItem, loadRunTrace, scanReport, workItemChain } from '../../../src/scanner/trace/queries';
import { readInBudget } from '../../../src/server/datasource/db/readin';
import { loadFirstScanProgress } from '../../../src/server/datasource/db/first-scan';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';
import { DbDataSource } from '../../../src/server/datasource/db';

import { escalateSteps, fakeCli, ME, perma, replay, traversal, triageSteps, ts, WINDOW, type Step } from '../../trace/fake-cli';


const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').replace(/[^a-z0-9]/g, '');
const URL_ = `postgres://localhost:5432/control_center_trace_${SUFFIX}`;
const NOW = new Date(WINDOW.to);

let handle: DbHandle;
let db: Db;
let userId: string;
let sink: DbTraceSink;
let store: DbScannerStore;

async function freshDb() {
  const u = new URL(URL_);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^control_center_trace_[a-z0-9]+$/.test(name)) throw new Error(`trace tests only run against control_center_trace_*, not "${name}"`);
  await createTestDb(name, { reuse: true });
  await runMigrations({ url: URL_, log: () => {} });
  const h = createDb({ url: URL_, max: 4, applicationName: 'trace-test' });
  const res = await h.db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = res.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await h.db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  const b = await bootstrapUser({
    db: h.db,
    profile: { email: 'ada@corp.example', name: 'Ada Example', role: 'se_ic', timezone: 'America/Denver', workingHours: { start: '07:30', end: '17:30', days: [1, 2, 3, 4, 5] }, slackUserId: ME, org62UserId: '005XX0000000001AAA' },
    now: NOW,
  });
  return { h, userId: b.userId };
}

function runtime(script: { traversal: Step[]; triage?: () => Step[]; escalate?: () => Step[] }) {
  const d = slackRecallDefaults({ CC_SLACK_TRIAGE: '1', CC_SLACK_ESCALATE: '1' });
  return new ScannerRuntime({
    store,
    runner: new AgentSdkSkillRunner({ queryFn: fakeCli(script, replay()) }),
    specs: [slackSpec({ mcpServers: () => ({}), ...d })],
    reevaluate: async () => {},
    clock: new FakeClock(NOW.toISOString()),
    firstScan: null,
  });
}

async function job() {
  return (await enqueueJob(db, { ownerUserId: userId, kind: 'scan.slack', queue: 'scan.slack', payload: { kind: 'scan', connector: 'slack', scope: 'inbox' } })).id;
}

beforeAll(async () => {
  if (!pgAvailable) return;
  const f = await freshDb();
  handle = f.h;
  db = handle.db;
  userId = f.userId;
  sink = new DbTraceSink(db, { flushMs: 20 });
  setTraceSink(sink);
  store = new DbScannerStore({ db, userId, clock: () => NOW });
});

afterAll(async () => {
  setTraceSink(null);
  await handle?.close();
});

let okRun: string;
let failedRun: string;

describe.skipIf(!pgAvailable)('scan audit trail on Postgres', () => {
  it('a failed run opens a Health error event, traced to its cause; spend is attributed to its run, job and budget', async () => {
    const jobId = await job();
    // the agent reads but never calls cc_finish: the run fails
    const rt = runtime({ traversal: traversal.filter((s) => !s.tool.endsWith('cc_finish')) });
    const out = await withTraceContext({ jobId: Number(jobId) }, () => rt.executeJob(scanJob({ connector: 'slack', scope: 'inbox', window: WINDOW, mode: 'incremental', trigger: 'schedule', runAt: NOW.toISOString() }), undefined, { dbJobId: jobId }));
    expect(out.status).toBe('failed');
    failedRun = out.runId!;
    await sink.flush();
    const t = await loadRunTrace(db, failedRun, userId);
    expect(t.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['plan', 'tool_call', 'rec', 'recorded', 'prompt', 'pass', 'spend', 'failed', 'retry', 'outcome']));
    expect(t.events.at(-1)).toMatchObject({ kind: 'outcome', payload: { status: 'failed' } });
    expect(t.events.find((e) => e.kind === 'failed')!.payload).toMatchObject({ code: 'no_finish' });
    const ev = await db.execute<{ code: string; severity: string; entity_id: string; occurrence_count: number; scan_run_id: string }>(sql`select code, severity::text, entity_id, occurrence_count, scan_run_id from app_events where component = 'scanner.slack' and resolved_at is null`);
    expect(ev.rows).toEqual([{ code: 'scan_run_failed', severity: 'error', entity_id: 'slack:inbox', occurrence_count: 1, scan_run_id: failedRun }]);
    const calls = await db.execute<{ job_id: string; budget: string; scan_run_id: string }>(sql`select job_id, budget, scan_run_id from llm_calls`);
    expect(calls.rows).toEqual([{ job_id: String(jobId), budget: 'daily', scan_run_id: failedRun }]);
    // Health's error feed shows it
    const ds = new DbDataSource({ handle, userId, clock: { now: () => NOW } });
    const log = await ds.getEventLog({} as never);
    expect(log.entries.find((e) => e.code === 'scan_run_failed')).toMatchObject({ level: 'error', source: 'scanner.slack', suggestedAction: expect.stringContaining('scan:trace') });
    await ds.dispose();
  });

  it('a successful run: the full trace end to end; it closes the error event', async () => {
    const jobId = await job();
    const rt = runtime({ traversal, triage: triageSteps, escalate: escalateSteps });
    const out = await withTraceContext({ jobId: Number(jobId) }, () => rt.executeJob(scanJob({ connector: 'slack', scope: 'inbox', window: WINDOW, mode: 'incremental', trigger: 'schedule', runAt: NOW.toISOString() }), undefined, { dbJobId: jobId }));
    expect(out.status).toBe('succeeded');
    okRun = out.runId!;
    await sink.flush();
    const t = await loadRunTrace(db, okRun, userId);
    expect(t.run).toMatchObject({ connector: 'slack', scope: 'slack:inbox', status: 'succeeded', jobId: Number(jobId) });
    const kinds = t.events.map((e) => e.kind);
    expect(kinds[0]).toBe('plan');
    expect(kinds.at(-1)).toBe('outcome');
    for (const k of ['tool_call', 'rec', 'recorded', 'prompt', 'pass', 'triage_select', 'verdict', 'proposal', 'coverage', 'commit', 'spend']) expect(kinds, k).toContain(k);
    expect(t.events.filter((e) => e.kind === 'proposal')).toHaveLength(3);
    expect(t.events.filter((e) => e.kind === 'verdict').map((e) => e.payload.pass)).toEqual(['triage', 'triage', 'triage', 'triage', 'triage', 'triage', 'escalate']);
    expect(JSON.stringify(t.events)).not.toMatch(/SECRET_TEXT/);
    expect((await db.execute(sql`select 1 from app_events where component = 'scanner.slack' and resolved_at is null`)).rows).toHaveLength(0);
  });

  it('SPEND-1: an escalated run is booked per pass, on the model that ran it, with its tokens', async () => {
    const passes = (await loadRunTrace(db, okRun, userId)).events.filter((e) => e.kind === 'pass').map((e) => e.payload as { pass: string; model: string; costUsd: number; inputTokens: number; outputTokens: number });
    expect(passes.map((p) => p.pass)).toEqual(expect.arrayContaining(['traversal', 'triage', 'escalate']));
    const rows = (await db.execute<{ model: string; model_tier: string; skill_key: string; cost_usd: string; input_tokens: number; output_tokens: number; request_hash: string; job_id: string | null }>(sql`
      select model, model_tier::text as model_tier, skill_key, cost_usd::text as cost_usd, input_tokens, output_tokens, request_hash, job_id from llm_calls where scan_run_id = ${okRun} order by id`)).rows;
    expect(rows).toHaveLength(passes.length);
    expect(rows.map((r) => r.model)).toEqual(passes.map((p) => p.model));
    const esc = rows.find((r) => r.model_tier === 'sonnet')!;
    expect(esc).toMatchObject({ model: 'claude-sonnet-5-5', skill_key: 'triage-slack' });
    expect(esc.input_tokens).toBeGreaterThan(0);
    expect(esc.output_tokens).toBeGreaterThan(0);
    expect(rows.find((r) => r.skill_key === 'scan-slack')).toMatchObject({ model_tier: 'haiku' });
    expect(rows.every((r) => r.request_hash.startsWith(`pass:${okRun}:`) && r.job_id != null && r.input_tokens > 0)).toBe(true);
    // the parts add up to what the run spent
    const runCost = Number((await db.execute<{ c: string }>(sql`select cost_usd::text as c from scan_runs where id = ${okRun}`)).rows[0]!.c);
    expect(rows.reduce((a, r) => a + Number(r.cost_usd), 0)).toBeCloseTo(runCost, 6);
    // A later booking on the same run never books those passes again: it stays on the caller's model, with its tokens.
    await store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.001, runId: okRun, inputTokens: 30, outputTokens: 4, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    const more = (await db.execute<{ model: string; input_tokens: number; request_hash: string }>(sql`select model, input_tokens, request_hash from llm_calls where scan_run_id = ${okRun} order by id`)).rows;
    expect(more).toHaveLength(passes.length + 1);
    expect(more.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', input_tokens: 30, request_hash: expect.stringMatching(/^spend:/) });
    await db.execute(sql`delete from llm_calls where scan_run_id = ${okRun} and request_hash like 'spend:%'`);
    await db.execute(sql`update scan_runs set cost_usd = cost_usd - 0.001 where id = ${okRun}`);
  });

  it('explain: a recorded message (verdict and why), a proposed one, and a permalink nobody recorded', async () => {
    const noise = await explainSourceItem(db, userId, { url: perma('C0GDM0001', ts(25)) });
    expect(noise.found).toBe(true);
    expect(noise.fetched.length).toBeGreaterThanOrEqual(1);
    expect(noise.triage.at(-1)).toMatchObject({ pass: 'triage', decision: 'noise', why: 'asks someone else' });
    expect(noise.verdict).toMatch(/triaged: noise \(asks someone else\)/);
    const thanks = await explainSourceItem(db, userId, { url: perma('D0DM00011', ts(12)) });
    expect(thanks.triage.at(-1)?.decision).toMatch(/trivial/);
    const asked = await explainSourceItem(db, userId, { url: perma('D0DM00011', ts(5)) });
    expect(asked.verdict).toMatch(/^Recorded and linked: origin evidence/);
    expect(asked.item?.url).toBe(perma('D0DM00011', ts(5)));
    const missing = await explainSourceItem(db, userId, { url: perma('D0DM00011', ts(50)) });
    expect(missing.found).toBe(false);
    expect(missing.coverage.length).toBeGreaterThan(0); // the inbox runs covered that moment
    expect(missing.verdict).toMatch(/searches did not return it/);
  });

  it('the Details chain: origin message (link) → the run that proposed it → the verdict → its spend', async () => {
    const wi = (await db.execute<{ id: string }>(sql`select id from work_items where title = 'Tell PERSON_B whether I can present at ACME today'`)).rows[0]!.id;
    const chain = await workItemChain(db, userId, wi);
    expect(chain.steps).toHaveLength(1);
    const s = chain.steps[0]!;
    expect(s).toMatchObject({ role: 'origin', source: { kind: 'slack', url: perma('C0GDM0001', ts(20)) }, run: { id: okRun, via: 'trace', skillVersion: expect.any(String) } });
    expect(s.verdict).toMatchObject({ v: 'unsure', why: 'who is you in the group DM', escalated: true, final: { v: 'act', why: 'a direct question to me' } });
    // one llm_calls row per pass of that run (SPEND-1), every model it used
    expect(s.spend).toMatchObject({ budget: 'daily', calls: 3, model: 'claude-haiku-5-5 + claude-sonnet-5-5' });
    expect(s.spend!.costUsd).toBeGreaterThan(0);
    const ds = new DbDataSource({ handle, userId, clock: { now: () => NOW } });
    const api = await ds.getItemTrace({ params: { id: wi } } as never);
    expect(api.steps[0]).toMatchObject({ run: { id: okRun }, verdict: { final: { v: 'act' } }, source: { url: perma('C0GDM0001', ts(20)) } });
    await ds.dispose();
  });

  it('report: per scope, runs and failures by code, holes up to the cursor, spend by budget, triage', async () => {
    // trace rows carry wall-clock time (the runs here run on a fake clock): the window spans both
    const r = await scanReport(db, userId, new Date(NOW.getTime() - 24 * 3_600_000), new Date(Date.now() + 60_000));
    const inbox = r.scopes.find((s) => s.scope === 'slack:inbox')!;
    expect(inbox).toMatchObject({ runs: 2, ok: 1, failed: 1, failures: { no_finish: 1 }, cursorAt: WINDOW.to });
    expect(r.spend.byBudget.daily).toBeGreaterThan(0);
    expect(r.spend.unattributed).toBe(0);
    expect(r.triage).toMatchObject({ messages: 6, act: 1, noise: 4, unsure: 1, escalated: 1 });
    expect(r.trace.runs).toBe(2);
    // SPEND-1: by model (the escalation is Sonnet's, with its tokens) and by skill (scan vs triage)
    expect(r.spend.byModel['claude-sonnet-5-5']).toMatchObject({ calls: 1 });
    expect(r.spend.byModel['claude-sonnet-5-5']!.usd).toBeGreaterThan(0);
    expect(r.spend.byModel['claude-sonnet-5-5']!.inputTokens).toBeGreaterThan(0);
    expect(r.spend.byModel['claude-haiku-5-5']!.usd).toBeGreaterThan(0);
    expect(Object.keys(r.spend.bySkill)).toEqual(expect.arrayContaining(['scan-slack', 'triage-slack']));
    const sum = (m: Record<string, { usd: number }>) => Object.values(m).reduce((a, x) => a + x.usd, 0);
    expect(sum(r.spend.byModel)).toBeCloseTo(r.spend.totalUsd, 4);
    expect(sum(r.spend.bySkill)).toBeCloseTo(r.spend.totalUsd, 4);
    expect(r.spend.fromTrace).toEqual({ runs: 0, usd: 0 });
  });

  it('SPEND-1: the report splits a run booked whole on one model (before the fix) by its pass trace rows', async () => {
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
    trace(runId, 'pass', { pass: 'traversal', model: 'claude-haiku-5-5', ok: true, costUsd: 0.003, inputTokens: 900, outputTokens: 30 });
    trace(runId, 'pass', { pass: 'escalate', model: 'claude-sonnet-5-5', ok: true, costUsd: 0.005, inputTokens: 700, outputTokens: 20 });
    await sink.flush();
    // the old booking: the whole run on the run's model, no tokens
    await db.execute(sql`
      insert into llm_calls (owner_user_id, purpose, model, model_tier, skill_key, request_hash, scan_run_id, status, cost_usd, budget_day, budget, started_at)
      values (${userId}, 'scan_extract', 'claude-haiku-5-5', 'haiku', 'scan-slack', ${`spend:${runId}:legacy`}, ${runId}, 'ok', 0.008, '2026-11-04', 'daily', now())`);
    const before = await scanReport(db, userId, new Date(NOW.getTime() - 24 * 3_600_000), new Date(Date.now() + 60_000));
    expect(before.spend.fromTrace).toEqual({ runs: 1, usd: 0.008 });
    const sonnet = before.spend.byModel['claude-sonnet-5-5']!;
    expect(sonnet.inputTokens).toBeGreaterThanOrEqual(700);
    // that run's Sonnet share is Sonnet's, its Haiku share Haiku's, and the totals still add up
    const sum = (m: Record<string, { usd: number }>) => Object.values(m).reduce((a, x) => a + x.usd, 0);
    expect(sum(before.spend.byModel)).toBeCloseTo(before.spend.totalUsd, 4);
    expect(before.spend.bySkill['triage-slack']!.usd).toBeGreaterThanOrEqual(0.005);
    await db.execute(sql`delete from llm_calls where scan_run_id = ${runId}`);
    const after = await scanReport(db, userId, new Date(NOW.getTime() - 24 * 3_600_000), new Date(Date.now() + 60_000));
    expect(after.spend.byModel['claude-sonnet-5-5']!.usd).toBeCloseTo(sonnet.usd - 0.005, 6);
  });

  it("ORG-7: a coverage object's account count shows in the trace (Q2: opps on my accounts)", async () => {
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'schedule', window: WINDOW });
    await store.reportCoverage(runId, [{ kind: 'query_window', ref: 'soql:Opportunity:accounts', from: WINDOW.from, to: WINDOW.to, meta: { accounts: 3 } }]);
    await sink.flush();
    const t = await loadRunTrace(db, runId, userId);
    const cov = t.events.find((e) => e.kind === 'coverage')!;
    expect((cov.payload as { notes?: string[] }).notes).toEqual(['soql:Opportunity:accounts:accounts=3']);
  });

  it('BUD-1: first-scan spend never counts toward the daily caps; daily spend still caps', async () => {
    const before = await store.budgetStatus();
    await withTraceContext({ budget: 'first_scan' }, () => store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 20, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' }));
    const after = await store.budgetStatus();
    expect(after.todayUsd).toBeCloseTo(before.todayUsd, 6);
    expect(after.state).toBe(before.state);
    expect(after.state).not.toBe('capped');
    const ri = await readInBudget(db, userId, NOW);
    expect(ri.totalUsd).toBeCloseTo(before.todayUsd, 6);
    const day = (await db.execute<{ n: string }>(sql`select coalesce(sum(spent_usd), 0)::text as n from llm_budget_days d join llm_budgets b on b.id = d.budget_id where b.owner_user_id = ${userId}`)).rows[0]!.n;
    expect(Number(day)).toBeLessThan(20);
    await store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 16, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    expect((await store.budgetStatus()).state).toBe('capped');
  });

  it('a "Today only" override raises the caps for its own day: scanners, read-ins and the spend chip; another day is ignored', async () => {
    const ds = new DbDataSource({ handle, userId, clock: { now: () => NOW } });
    try {
      const s0 = await ds.getSettings({} as never);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: s0.profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(NOW);
      const before = await store.budgetStatus();
      const r = await ds.patchSettings({ params: { section: 'budgets' }, body: { ifVersion: s0.budgets.version, value: { today: { day, softUsd: 40, hardUsd: 60, chatUsd: 9 } } } } as never);
      expect(r.entity.budgets.today).toMatchObject({ day, softUsd: 40, hardUsd: 60 });
      const during = await store.budgetStatus();
      expect(during).toMatchObject({ softCapUsd: 40, hardCapUsd: 60 });
      expect(during.state).not.toBe('capped');
      expect((await readInBudget(db, userId, NOW)).hardUsd).toBe(60);
      expect((await ds.getHealth({} as never)).spend.today).toMatchObject({ softBudgetUsd: 40, hardCapUsd: 60 });
      const r2 = await ds.patchSettings({ params: { section: 'budgets' }, body: { ifVersion: r.entity.budgets.version, value: { today: { day: '2020-01-01', softUsd: 40, hardUsd: 60, chatUsd: null } } } } as never);
      expect(await store.budgetStatus()).toMatchObject({ softCapUsd: before.softCapUsd, hardCapUsd: before.hardCapUsd });
      await expect(ds.patchSettings({ params: { section: 'budgets' }, body: { ifVersion: r2.entity.budgets.version, value: { today: { day, softUsd: 70, hardUsd: 60, chatUsd: null } } } } as never)).rejects.toThrow(/soft budget cannot exceed/i);
      await ds.patchSettings({ params: { section: 'budgets' }, body: { ifVersion: r2.entity.budgets.version, value: { today: null } } } as never);
    } finally {
      await ds.dispose();
    }
  });

  it("FS-LATE on Health's First scan card: a channel that joined later shows when, its own coverage span and its spend", async () => {
    const joined = new Date(NOW.getTime() - 3_600_000).toISOString();
    const floor = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'channel:C0PLACEHOLD' }, trigger: 'catch_up', window: { from: floor, to: joined } });
    await withTraceContext({ budget: 'first_scan' }, () => store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.42, runId, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' }));
    const file = { lookbackDays: 30, budgetUsd: 100, startedAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(), floorAt: new Date(NOW.getTime() - 40 * 86_400_000).toISOString(), spentUsd: 10.42, status: 'active' as const, scopes: { 'slack:inbox': 'done' as const, 'slack:channel:C0PLACEHOLD': 'pending' as const }, floors: { 'slack:channel:C0PLACEHOLD': floor }, late: { 'slack:channel:C0PLACEHOLD': joined } };
    const p = (await loadFirstScanProgress(db, userId, file))!;
    const ch = p.scopes.find((x) => x.scope === 'slack:channel:C0PLACEHOLD')!;
    expect(ch).toMatchObject({ status: 'pending', floorAt: floor, joinedAt: joined, spentUsd: 0.42 });
    expect(p.scopes.find((x) => x.scope === 'slack:inbox')!.joinedAt).toBeNull();
  });

  it('first-scan spend lands on the first-scan budget; retention drops trace rows after 30 days', async () => {
    await withTraceContext({ budget: 'first_scan' }, () => store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.01, runId: okRun, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' }));
    const b = await db.execute<{ budget: string }>(sql`select budget from llm_calls where scan_run_id = ${okRun} order by id`);
    // the run's own passes (one row each, SPEND-1) on the daily budget, then the first-scan booking
    expect(b.rows.map((x) => x.budget)).toEqual(['daily', 'daily', 'daily', 'first_scan']);
    await sink.flush();
    const before = (await db.execute<{ n: number }>(sql`select count(*)::int as n from scan_run_events`)).rows[0]!.n;
    const r = await runRetentionScrub(db, userId, { now: new Date(Date.now() + 31 * 86_400_000) });
    expect(r.traceEventsPurged).toBe(before);
  });
});

