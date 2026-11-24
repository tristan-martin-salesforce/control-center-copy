import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import { createDb } from '@/db/client';
import { RETENTION_DAYS_MAX } from '@/contract/settings';
import { cutoff, foreignKeysTo, referencedIdsUnion, SOFT_SOURCE_REFS, SOURCE_REF_IGNORED, sourceItemReferences, SQL_RULES, type SqlRule } from '@/db/retention/policy';
import { runDataRetention, scanOrSettleActive } from '@/db/retention/run';

import { createConnector, createExtractor, createUser, createWorkItem } from '../core/helpers';

const URL_ = process.env.RETENTION_DATABASE_URL!;
const h = createDb({ url: URL_, max: 4, applicationName: 'retention-test' });
const db = h.db;
const DAY = 86_400_000;
const NOW = new Date('2026-11-20T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let userId: string;
let connectorId: string;
const ids: Record<string, string | number> = {};

const count = async (table: string, where = sql`true`) => Number((await db.execute<{ n: string }>(sql`select count(*) as n from ${sql.identifier(table)} where ${where}`)).rows[0]!.n);

async function sourceItem(label: string, days: number): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`
    insert into source_items (owner_user_id, connector_id, source, kind, external_id, dedupe_key, content_hash, occurred_at, first_seen_at, last_seen_at)
    values (${userId}, ${connectorId}, 'slack', 'slack_message', ${label}, ${label + randomUUID()}, 'h', ${ago(days)}::timestamptz, ${ago(days)}::timestamptz, ${ago(days)}::timestamptz)
    returning id`);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  await db.execute(sql`alter table llm_calls add column if not exists prompt text`);
  userId = await createUser(db, 'retention');
  connectorId = await createConnector(db, userId);
  const extractor = await createExtractor(db);
  const wi = await createWorkItem(db, userId);

  // source items: old+unreferenced (goes), old+evidence (stays), old+provenance link (stays), recent+unreferenced (stays)
  ids.srcOrphan = await sourceItem('orphan', 120);
  ids.srcEvidence = await sourceItem('evidence', 120);
  ids.srcRecent = await sourceItem('recent', 3);
  await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'seed evidence' }, (tx) =>
    tx.execute(sql`insert into work_item_evidence (work_item_id, source_item_id, role, confidence, extractor_id) values (${wi.id}, ${ids.srcEvidence}, 'origin', 0.9, ${extractor})`));

  // scan trace
  const run = await db.execute<{ id: string }>(sql`insert into scan_runs (owner_user_id, connector_id, trigger, mode, started_at) values (${userId}, ${connectorId}, 'manual', 'incremental', ${ago(2)}::timestamptz) returning id`);
  ids.run = run.rows[0]!.id;
  const ev = async (seq: number, kind: string, days: number) =>
    db.execute(sql`insert into scan_run_events (run_id, seq, ts, kind, payload) values (${ids.run}, ${seq}, ${ago(days)}::timestamptz, ${kind}, '{}'::jsonb)`);
  await ev(1, 'tool_call', 20); // full trace, past 14 days: goes
  await ev(2, 'plan', 20); // summary kind: stays to 90
  await ev(3, 'plan', 100); // past 90: goes
  await ev(4, 'tool_call', 1); // recent: stays

  // app events
  const ae = (fp: string, days: number, resolved: boolean) =>
    db.execute(sql`insert into app_events (owner_user_id, severity, component, code, message, fingerprint, resolved_at, last_occurred_at)
      values (${userId}, 'info', 'test', ${fp}, 'm', ${fp}, ${resolved ? ago(days) : null}::timestamptz, ${ago(days)}::timestamptz)`);
  await ae('old-resolved', 40, true);
  await ae('new-resolved', 5, true);
  await ae('old-open', 100, false);

  // llm calls (the temp `prompt` column stands in for raw text)
  const call = async (label: string, days: number) =>
    (await db.execute<{ id: number }>(sql`
      insert into llm_calls (owner_user_id, purpose, model, model_tier, request_hash, status, budget_day, input_tokens, output_tokens, cost_usd, started_at, prompt)
      values (${userId}, 'other', 'm', 'haiku', ${label}, 'ok', ${ago(days).slice(0, 10)}::date, 100, 50, 0.25, ${ago(days)}::timestamptz, 'secret prompt text') returning id`)).rows[0]!.id;
  ids.callOld = await call('old', 45);
  ids.callNew = await call('new', 2);

  // jobs: old succeeded ones go unless they are the newest of their kind (Health reads "last run")
  const job = async (days: number, kind = 'test.kind') =>
    (await db.execute<{ id: number }>(sql`
      insert into jobs (owner_user_id, kind, status, finished_at, created_at, updated_at)
      values (${userId}, ${kind}, 'succeeded', ${ago(days)}::timestamptz, ${ago(days)}::timestamptz, ${ago(days)}::timestamptz) returning id`)).rows[0]!.id;
  ids.jobOlder = await job(30);
  ids.jobNewestOld = await job(20);
  ids.jobRecent = await job(1);
  ids.jobSoleOfKind = await job(25, 'other.kind');

  // priority runs: run1 (40d, its only score superseded), run2 (35d, holds the latest score of item X), run3 (now)
  const pol = (await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'seed policy' }, (tx) => tx.execute<{ id: string }>(sql`insert into priority_policies (owner_user_id, version, change_summary, source) values (${userId}, 1, 'x', 'user') returning id`))).result.rows[0]!.id;
  const pr = async (days: number) =>
    (await db.execute<{ id: number }>(sql`insert into priority_runs (owner_user_id, trigger, engine_version, policy_id, started_at) values (${userId}, 'schedule', 'v', ${pol}, ${ago(days)}::timestamptz) returning id`)).rows[0]!.id;
  const score = (run: number, days: number) =>
    db.execute(sql`insert into priority_scores (run_id, work_item_id, policy_id, total, lane, inputs_hash, explanation, computed_at) values (${run}, ${wi.id}, ${pol}, 1, 'now', 'h', 'e', ${ago(days)}::timestamptz)`);
  ids.pr1 = await pr(40);
  ids.pr2 = await pr(35);
  ids.pr3 = await pr(0);
  await score(ids.pr1 as number, 40);
  await score(ids.pr2 as number, 35);
});
afterAll(() => h.close());

const snapshot = async () => ({
  src: await count('source_items'),
  trace: await count('scan_run_events'),
  events: await count('app_events'),
  calls: await count('llm_calls', sql`prompt is not null`),
  jobs: await count('jobs'),
  pr: await count('priority_runs'),
});

describe('data retention policy against Postgres', () => {
  it('a dry run touches nothing and reports the plan', async () => {
    const before = await snapshot();
    const r = await runDataRetention(db, userId, { now: NOW, dry: true, recordEvent: true });
    expect(await snapshot()).toEqual(before);
    expect(await count('app_events', sql`code = 'DATA.RETENTION_RUN'`)).toBe(0);
    const rows = Object.fromEntries(r.tables.map((t) => [t.table, t.rows]));
    expect(rows).toMatchObject({ source_items: 1, scan_run_events: 2, app_events: 1, llm_calls: 1, priority_runs: 1 });
  });

  it('is skipped while a scan job is running, and when disabled', async () => {
    const j = await db.execute<{ id: number }>(sql`insert into jobs (owner_user_id, kind, status, locked_by, lease_expires_at, started_at) values (${userId}, 'scan.slack', 'running', 'w', now() + interval '1 hour', now()) returning id`);
    expect(await scanOrSettleActive(db)).toBe(true);
    const before = await snapshot();
    const r = await runDataRetention(db, userId, { now: NOW, dry: false });
    expect(r.skipped).toBe('scan_active');
    expect(await snapshot()).toEqual(before);
    await db.execute(sql`delete from jobs where id = ${j.rows[0]!.id}`);
    expect(await scanOrSettleActive(db)).toBe(false);
  });

  it('ages out only what the policy allows, and records the run', async () => {
    const r = await runDataRetention(db, userId, { now: NOW, dry: false, batch: 1 }); // batch of 1: the loop must continue
    expect(r.skipped).toBeUndefined();

    // source items: the orphan goes; the referenced and the recent stay
    expect(await count('source_items', sql`id = ${ids.srcOrphan}`)).toBe(0);
    expect(await count('source_items', sql`id = ${ids.srcEvidence}`)).toBe(1);
    expect(await count('source_items', sql`id = ${ids.srcRecent}`)).toBe(1);

    // trace: full detail past 14 days goes, summary kinds stay to 90 days
    const left = (await db.execute<{ seq: number }>(sql`select seq from scan_run_events where run_id = ${ids.run} order by seq`)).rows.map((x) => x.seq);
    expect(left).toEqual([2, 4]);

    // events: old resolved goes; recent resolved and old open stay (the run's own record is added after)
    const fps = (await db.execute<{ fingerprint: string }>(sql`select fingerprint from app_events where code <> 'DATA.RETENTION_RUN' order by fingerprint`)).rows.map((x) => x.fingerprint);
    expect(fps).toEqual(['new-resolved', 'old-open']);

    // llm: text nulled after 30 days, usage and cost kept; recent text untouched
    const old = (await db.execute<{ prompt: string | null; cost: string; i: number }>(sql`select prompt, cost_usd::text as cost, input_tokens as i from llm_calls where id = ${ids.callOld}`)).rows[0]!;
    expect(old.prompt).toBeNull();
    expect(Number(old.cost)).toBe(0.25);
    expect(old.i).toBe(100);
    expect((await db.execute<{ prompt: string | null }>(sql`select prompt from llm_calls where id = ${ids.callNew}`)).rows[0]!.prompt).toBe('secret prompt text');

    // jobs: old ones go; the newest of each kind stays (the recent one, and the old sole job of its kind)
    expect(await count('jobs', sql`id = ${ids.jobOlder}`)).toBe(0);
    expect(await count('jobs', sql`id = ${ids.jobNewestOld}`)).toBe(0);
    expect(await count('jobs', sql`id = ${ids.jobSoleOfKind}`)).toBe(1);
    expect(await count('jobs', sql`id = ${ids.jobRecent}`)).toBe(1);

    // priority runs: the fully superseded run goes; the one holding a latest score and the newest stay
    expect(await count('priority_runs', sql`id = ${ids.pr1}`)).toBe(0);
    expect(await count('priority_runs', sql`id = ${ids.pr2}`)).toBe(1);
    expect(await count('priority_runs', sql`id = ${ids.pr3}`)).toBe(1);

    // the run is recorded with counts per table and sizes
    const ev = (await db.execute<{ detail: { counts: Record<string, number>; bytesBefore: number } }>(sql`select detail from app_events where code = 'DATA.RETENTION_RUN'`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail.counts).toMatchObject({ source_items: 1, scan_run_events: 2, app_events: 1, llm_calls: 1, priority_runs: 1, jobs: 2 });
    expect(ev[0]!.detail.bytesBefore).toBeGreaterThan(0);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const r = await runDataRetention(db, userId, { now: NOW, dry: true });
    expect(r.tables.filter((t) => t.rows).map((t) => t.table)).toEqual([]);
  });

  it('settings: disabled does nothing unless forced', async () => {
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'seed settings' }, (tx) => tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, 'retention', '{"enabled": false}'::jsonb)`));
    expect((await runDataRetention(db, userId, { now: NOW, dry: true })).skipped).toBe('disabled');
    expect((await runDataRetention(db, userId, { now: NOW, dry: true, force: true })).skipped).toBeUndefined();
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'clear settings' }, (tx) => tx.execute(sql`delete from user_settings where key = 'retention' and owner_user_id = ${userId}`));
  });

  // P33-1: a horizon past AD 1 used to serialise as `-00xxxx-…`, which Postgres rejects, and the nightly run failed
  it.each([740_001, RETENTION_DAYS_MAX])('a horizon of %i days keeps everything instead of failing the run', async (days) => {
    expect(cutoff(NOW, days)).toBe('0001-01-01T00:00:00.000Z');
    const value = JSON.stringify({ llmTextDays: days, traceDays: days, eventsDays: days, orphanSourceDays: days });
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'seed settings' }, (tx) => tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, 'retention', ${value}::jsonb)`));
    const orphan = await sourceItem('old-orphan', 400);
    try {
      const plan = await runDataRetention(db, userId, { now: NOW, dry: true });
      expect(plan.failed).toBeUndefined();
      expect(plan.tables.filter((t) => SQL_RULES.some((r) => r.id === t.rule)).map((t) => t.rows)).toEqual(SQL_RULES.map(() => 0));
      const run = await runDataRetention(db, userId, { now: NOW, dry: false });
      expect(run.failed).toBeUndefined();
      expect(await count('source_items', sql`id = ${orphan}`)).toBe(1);
    } finally {
      await db.execute(sql`delete from source_items where id = ${orphan}`);
      await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'clear settings' }, (tx) => tx.execute(sql`delete from user_settings where key = 'retention' and owner_user_id = ${userId}`));
    }
  });

  it('one rule that throws does not fail the run; Health names it until it runs clean', async () => {
    let broken = true;
    const bad: SqlRule = {
      id: 'test_bad_rule',
      table: 'source_items',
      describe: 'a rule whose SQL fails',
      action: 'delete',
      candidates: () => (broken ? sql`select id from no_such_table_for_retention` : sql`select id from source_items where false`),
    };
    SQL_RULES.unshift(bad);
    const open = sql`code = 'DATA.RETENTION_RULE_FAILED' and entity_id = 'test_bad_rule' and resolved_at is null`;
    try {
      const r = await runDataRetention(db, userId, { now: NOW, dry: false });
      expect(r.failed).toEqual(['test_bad_rule']);
      expect(r.tables.find((t) => t.rule === 'test_bad_rule')).toMatchObject({ rows: null, note: 'failed (42P01)' });
      // every other rule still ran
      expect(r.tables.map((t) => t.rule)).toEqual(expect.arrayContaining(SQL_RULES.filter((x) => x !== bad).map((x) => x.id)));
      expect(r.tables.filter((t) => t.rule !== 'test_bad_rule').every((t) => typeof t.rows === 'number')).toBe(true);
      const ev = (await db.execute<{ message: string; severity: string }>(sql`select message, severity from app_events where ${open}`)).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ severity: 'warn' });
      expect(ev[0]!.message).toContain('test_bad_rule');

      broken = false;
      const again = await runDataRetention(db, userId, { now: NOW, dry: false });
      expect(again.failed).toBeUndefined();
      expect(await count('app_events', open)).toBe(0);
    } finally {
      SQL_RULES.splice(SQL_RULES.indexOf(bad), 1);
    }
  });
});

describe('source_items reference check covers the schema', () => {
  it('every foreign key into source_items is in the union', async () => {
    const fks = await foreignKeysTo(db, 'source_items');
    expect(fks.length).toBeGreaterThan(10);
    const refs = await sourceItemReferences(db);
    for (const fk of fks) expect(refs, `${fk.table}.${fk.column} missing from the union`).toContainEqual(expect.objectContaining({ table: fk.table, column: fk.column }));
    // multi-column FKs are not handled by the single-column catalog read: there must be none
    const multi = await db.execute<{ n: string }>(sql`select count(*) as n from pg_constraint where contype = 'f' and confrelid = 'public.source_items'::regclass and array_length(conkey, 1) > 1`);
    expect(Number(multi.rows[0]!.n)).toBe(0);
  });

  it('every *source_item* column is a foreign key, a listed soft reference, or ignored', async () => {
    const fks = new Set((await foreignKeysTo(db, 'source_items')).map((f) => `${f.table}.${f.column}`));
    const soft = new Set(SOFT_SOURCE_REFS.map((s) => `${s.table}.${s.column}`));
    const cols = await db.execute<{ t: string; c: string; ty: string }>(sql`
      select table_name as t, column_name as c, data_type as ty from information_schema.columns
       where table_schema = 'public' and column_name like '%source_item%' and column_name not like '%count%' order by 1, 2`);
    const unaccounted = cols.rows.map((x) => `${x.t}.${x.c}`).filter((k) => !fks.has(k) && !soft.has(k) && !SOURCE_REF_IGNORED.has(k));
    expect(unaccounted, 'a new column that points at source_items: add it to SOFT_SOURCE_REFS (or make it a foreign key)').toEqual([]);
  });

  it('the union executes and a referenced item appears in it', async () => {
    const refs = await sourceItemReferences(db);
    const r = await db.execute<{ id: string }>(sql`select id from (${referencedIdsUnion(refs)}) u where id = ${String(ids.srcEvidence)}`);
    expect(r.rows).toHaveLength(1);
  });
});
