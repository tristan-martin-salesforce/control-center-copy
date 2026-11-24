/**
 * 0027 on Postgres (holistic review 04 §4.5): a Slack scan with a triage pass and a Sonnet escalation books one
 * llm_calls row per pass, each with what its query measured (turns, first / max prompt, long-tier requests, tools,
 * prefix hash, items in / by rules / out); the escalation row points at the triage call it re-did and says how many
 * verdicts it changed (D4). insertLlmCall books a measurement; old-style rows keep every new column null.
 * Placeholders only; the fake CLI from tests/trace plays the model.
 *
 * Database: control_center_llmmeasure_<CC_TEST_DB_SUFFIX>, created once, migrated, emptied and bootstrapped per run.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Db, type DbHandle } from '../../../src/db/client';
import { insertLlmCall } from '../../../src/db/ledger';
import { runMigrations } from '../../../src/db/migrate';
import { AgentSdkSkillRunner } from '../../../src/llm/skill-runner';
import { FakeClock } from '../../../src/scanner/runtime/clock';
import { slackRecallDefaults, slackSpec } from '../../../src/scanner/runtime/connectors';
import { scanJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { DbTraceSink, setTraceSink } from '../../../src/scanner/trace';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';

import { escalateSteps, fakeCli, ME, replay, traversal, triageSteps, WINDOW } from '../../trace/fake-cli';


const PG_BIN = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').replace(/[^a-z0-9]/g, '');
const URL_ = `postgres://localhost:5432/control_center_llmmeasure_${SUFFIX}`;
const NOW = new Date(WINDOW.to);

let handle: DbHandle;
let db: Db;
let userId: string;
let sink: DbTraceSink;

async function freshDb() {
  const u = new URL(URL_);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^control_center_llmmeasure_[a-z0-9]+$/.test(name)) throw new Error(`measurement tests only run against control_center_llmmeasure_*, not "${name}"`);
  const run = promisify(execFile);
  const exists = await run(`${PG_BIN}/psql`, ['--host', 'localhost', '--port', '5432', '-d', 'postgres', '-Atc', `select 1 from pg_database where datname = '${name}'`]).then((r) => r.stdout.trim() === '1');
  if (!exists) await run(`${PG_BIN}/createdb`, ['--host', 'localhost', '--port', '5432', name]);
  await runMigrations({ url: URL_, log: () => {} });
  const h = createDb({ url: URL_, max: 4, applicationName: 'llm-measure-test' });
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

beforeAll(async () => {
  const f = await freshDb();
  handle = f.h;
  db = handle.db;
  userId = f.userId;
  sink = new DbTraceSink(db, { flushMs: 20 });
  setTraceSink(sink);
});

afterAll(async () => {
  setTraceSink(null);
  await handle?.close();
});

type Row = {
  id: string;
  skill_key: string;
  model: string;
  model_reason: string;
  first_prompt_tokens: number | null;
  max_prompt_tokens: number | null;
  long_tier_requests: number | null;
  turns: number | null;
  tool_count: number | null;
  prefix_hash: string | null;
  items_in: number | null;
  items_decided_by_rules: number | null;
  items_out: number | null;
  escalated_from_call_id: string | null;
  escalation_changed_items: number | null;
};

describe('llm_calls measurement (0027) on Postgres', () => {
  it('a scan with triage and escalation books each pass with its measurement; the escalation points at its triage call', async () => {
    const store = new DbScannerStore({ db, userId, clock: () => NOW });
    const d = slackRecallDefaults({ CC_SLACK_TRIAGE: '1', CC_SLACK_ESCALATE: '1' });
    const rt = new ScannerRuntime({
      store,
      runner: new AgentSdkSkillRunner({ queryFn: fakeCli({ traversal, triage: triageSteps, escalate: escalateSteps }, replay()) }),
      specs: [slackSpec({ mcpServers: () => ({}), ...d })],
      reevaluate: async () => {},
      clock: new FakeClock(NOW.toISOString()),
      firstScan: null,
    });
    const out = await rt.executeJob(scanJob({ connector: 'slack', scope: 'inbox', window: WINDOW, mode: 'incremental', trigger: 'schedule', runAt: NOW.toISOString() }));
    expect(out.status).toBe('succeeded');
    await sink.flush();
    const rows = (
      await db.execute<Row>(sql`
        select id::text, skill_key, model, model_reason, first_prompt_tokens, max_prompt_tokens, long_tier_requests, turns, tool_count, prefix_hash,
               items_in, items_decided_by_rules, items_out, escalated_from_call_id::text, escalation_changed_items
          from llm_calls where scan_run_id = ${out.runId}::uuid order by id`)
    ).rows;
    expect(rows.map((r) => r.skill_key)).toEqual(['scan-slack', 'triage-slack', 'triage-slack']);
    const [trav, tri, esc] = rows as [Row, Row, Row];
    // the fake CLI reports 50 prompt tokens per request: one request per tool call
    expect(trav).toMatchObject({ first_prompt_tokens: 50, max_prompt_tokens: 50, long_tier_requests: 0, tool_count: 0, escalated_from_call_id: null, escalation_changed_items: null });
    expect(trav.turns).toBe(traversal.length);
    expect(trav.prefix_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(trav.items_in).toBeGreaterThan(0);
    expect(tri).toMatchObject({ model: 'claude-haiku-5-5', items_in: 6, escalated_from_call_id: null });
    expect(tri.items_decided_by_rules).not.toBeNull();
    expect(tri.prefix_hash).not.toBe(trav.prefix_hash); // another skill and toolset: another cache prefix
    expect(esc).toMatchObject({ model: 'claude-sonnet-5-5', model_reason: 'escalation:unsure', items_in: 1, escalation_changed_items: 1, escalated_from_call_id: tri.id });
  });

  it('insertLlmCall books a measurement; a row without one keeps every new column null', async () => {
    const base = { ownerUserId: userId, purpose: 'other', model: 'claude-haiku-5-5', skillKey: 'measure-test', status: 'ok' as const, inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, costUsd: 0.0001, budgetDay: '2026-11-04', trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'h' };
    const a = await insertLlmCall(db, { ...base, measure: { firstPromptTokens: 910, maxPromptTokens: 120_000, longTierRequests: 1, turns: 2, toolCount: 1, toolSchemaTokens: 300, prefixHash: 'p'.repeat(32), itemsIn: 3, itemsDecidedByRules: 1, itemsOut: 2 } });
    const b = await insertLlmCall(db, { ...base, measure: { turns: 1, firstPromptTokens: 50, escalatedFromCallId: a, escalationChangedItems: 0 } });
    const c = await insertLlmCall(db, { ...base, measure: { escalatedFromCallId: 999_999_999 } }); // a dangling id books null, never fails
    const old = await insertLlmCall(db, base);
    const got = await db.execute<Record<string, unknown>>(sql`
      select id, first_prompt_tokens, max_prompt_tokens, long_tier_requests, turns, tool_count, tool_schema_tokens, prefix_hash, items_in, items_decided_by_rules, items_out, escalated_from_call_id, escalation_changed_items
        from llm_calls where id in (${a}, ${b}, ${c}, ${old}) order by id`);
    const [ra, rb, rc, ro] = got.rows;
    expect(ra).toMatchObject({ first_prompt_tokens: 910, max_prompt_tokens: 120_000, long_tier_requests: 1, turns: 2, tool_count: 1, tool_schema_tokens: 300, prefix_hash: 'p'.repeat(32), items_in: 3, items_decided_by_rules: 1, items_out: 2, escalated_from_call_id: null });
    expect(rb).toMatchObject({ turns: 1, first_prompt_tokens: 50, escalated_from_call_id: String(a), escalation_changed_items: 0 });
    expect(rc).toMatchObject({ escalated_from_call_id: null });
    for (const k of Object.keys(ro!).filter((k) => k !== 'id')) expect(ro![k], k).toBeNull();
  });
});
