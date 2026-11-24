/**
 * FTI on Postgres (the real DbScannerStore and DB trace sink): a Slack inbox first scan through the runtime, read by
 * code through a fake relay over the placeholder corpus and interpreted by a scripted classifier. It lands where the
 * agentic path lands (source_items, work_items with origin evidence, the cursor), and the spend is booked one
 * `llm_calls` row per pass row: relay reads under `relay:slack:<tool>`, classifier calls under `classify-items`, on the
 * run's budget (the first scan's one-time budget; a reconcile re-read after it, the daily one), each with its
 * tokens, content hash and measurement (first_prompt_tokens, items_in, items out,
 * items decided by rules). Skips without Postgres.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FtiSkillRunner } from '../../../src/scanner/interpret';
import { SIGNAL_CADENCE } from '../../../src/scanner/runtime/cadence';
import { slackSpec } from '../../../src/scanner/runtime/connectors';
import { FirstScan, MemoryFirstScanLedger } from '../../../src/scanner/runtime/first-scan';
import { ftiTraversalOverrides } from '../../../src/scanner/runtime/fti-specs';
import type { RuntimeJob } from '../../../src/scanner/runtime/jobs';
import { ScannerRuntime } from '../../../src/scanner/runtime/scanner-runtime';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { flushTrace, installDbTraceSink, setTraceSink } from '../../../src/scanner/trace';
import { loadProfileIntoDb, PLACEHOLDER_PROFILE } from '../../../scripts/stress/lib/profile';
import { corpusRelay, loadCorpus, scriptedClassifier } from '../../scanner/helpers';
import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

const NOW = '2026-11-06T18:00:00.000Z';

describe.skipIf(!pgAvailable())('FTI on Postgres: a first scan books like the agentic path', () => {
  let t: TestDb;
  let userId: string;

  beforeAll(async () => {
    t = await provisionTestDb(`fti_${process.env.CC_TEST_DB_SUFFIX ?? 'main'}`);
    userId = await loadProfileIntoDb(t.handle.db, PLACEHOLDER_PROFILE, { channels: [] });
    installDbTraceSink(t.handle.db, { flushMs: 50 });
    const store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date(NOW) });
    const relay = corpusRelay(loadCorpus());
    const rt = new ScannerRuntime({
      store,
      runner: new FtiSkillRunner({ fallback: { run: async () => ({ ok: false, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: { message: 'no agent here' } }) }, runtimeFor: (c) => (c === 'slack' ? relay : null), model: scriptedClassifier }),
      specs: [slackSpec({ ...ftiTraversalOverrides('slack'), scopes: () => ['inbox'] })],
      reevaluate: async () => undefined,
      clock: { now: () => new Date(NOW), sleep: async () => undefined } as never,
      cadence: SIGNAL_CADENCE,
      firstScan: new FirstScan({ lookbackDays: 8, budgetUsd: 5, connectors: ['slack'] }, new MemoryFirstScanLedger()),
    });
    const queue: RuntimeJob[] = await rt.planJobs(new Date(NOW));
    while (queue.length) {
      const out = await rt.executeJob(queue.shift()!);
      expect(out.status).toBe('succeeded');
      queue.push(...out.followUps);
    }
    await flushTrace();
  });

  afterAll(async () => {
    setTraceSink(null);
    await t?.drop();
  });

  it('records the messages, proposes the asks and promises with origin evidence, and moves the cursor', async () => {
    const db = t.handle.db;
    const items = await db.execute<{ n: number }>(sql`select count(*)::int as n from source_items where owner_user_id = ${userId} and source = 'slack'`);
    expect(items.rows[0]!.n).toBeGreaterThanOrEqual(9);
    const wi = await db.execute<{ title: string; origins: number }>(sql`
      select w.title, (select count(*)::int from work_item_evidence e where e.work_item_id = w.id and e.role = 'origin') as origins
        from work_items w where w.owner_user_id = ${userId} order by w.title`);
    const titles = wi.rows.map((r) => r.title).join(' | ');
    expect(titles).toMatch(/GLOBEX sizing sheet/);
    expect(titles).toMatch(/ACME demo deck/);
    expect(titles).toMatch(/pricing slide/);
    expect(wi.rows.every((r) => r.origins >= 1)).toBe(true);
    const cur = await db.execute<{ at: Date | null }>(sql`select high_watermark_at as at from scan_cursors where owner_user_id = ${userId} and scope = 'slack:inbox'`);
    expect(cur.rows[0]?.at).toBeTruthy();
  });

  it('books one llm_calls row per relay read and classifier call, on the first-scan budget, with the measurement', async () => {
    const rows = await t.handle.db.execute<{ skill_key: string; budget: string; cost_usd: string; input_tokens: number; content_hash: string | null; first_prompt_tokens: number | null; items_in: number | null; items_out: number | null; items_decided_by_rules: number | null; trigger: string | null; model_reason: string | null; outcome: string | null }>(sql`
      select skill_key, budget, cost_usd, input_tokens, content_hash, first_prompt_tokens, items_in, items_out, items_decided_by_rules, trigger, model_reason, outcome
        from llm_calls where owner_user_id = ${userId}`);
    const by = (k: string) => rows.rows.filter((r) => r.skill_key === k);
    expect(by('relay:slack:slack_search_public_and_private').length).toBeGreaterThan(5);
    const classify = by('classify-items');
    expect(classify.length).toBeGreaterThan(0);
    expect(rows.rows.filter((r) => r.skill_key === 'scan-slack' || r.skill_key === 'triage-slack')).toEqual([]);
    for (const r of rows.rows) {
      // the first scan's runs spend the one-time budget; a reconcile re-read after it (a targeted thread) the daily one
      expect(r.budget).toBe(r.trigger === 'reconcile' ? 'daily' : 'first_scan');
      expect(Number(r.cost_usd)).toBeGreaterThan(0);
      expect(r.input_tokens).toBeGreaterThan(0);
      expect(r.content_hash).toMatch(/^[0-9a-f]{32}$/);
      expect(r.first_prompt_tokens).toBeGreaterThan(0);
      expect(r.trigger && r.model_reason && r.outcome).toBeTruthy();
    }
    for (const r of classify) expect(r.items_in).toBeGreaterThan(0);
    expect(classify.some((r) => r.items_decided_by_rules !== null)).toBe(true);
    expect(classify.some((r) => (r.items_out ?? 0) > 0)).toBe(true);
  });

  it('carries earlier verdicts forward (TRI-NOISE) and records what rules settled', async () => {
    const v = await t.handle.db.execute<{ n: number }>(sql`select count(*)::int as n from source_items where owner_user_id = ${userId} and source = 'slack' and meta ? 'triage'`);
    const d = await t.handle.db.execute<{ reason: string }>(sql`select reason from llm_decisions where owner_user_id = ${userId} and skill_key = 'classify-items'`);
    expect(v.rows[0]!.n).toBeGreaterThan(0);
    expect(d.rows.map((r) => r.reason)).toEqual(expect.arrayContaining(['rule_trivial']));
  });
});
