/**
 * BE-CHAT on Postgres (its own database: control_center_bechat_<CC_TEST_DB_SUFFIX>, dropped and recreated
 * per run; skipped when Postgres 17 is not reachable). The db DataSource with the real chat runner over the
 * fake model, through the same code path the app uses (createDbDataSource wiring aside).
 *
 * Covers: proposal → apply in ONE change set (actor chat) → receipt part → undo, also for a mixed plan
 * (pin, edit, evidence, new item, policy); rescan → a RuntimeJob row (trigger chat) its scan row follows;
 * draft card → Add to Outbox (queueDraft, undoable; no send attempt); session → a launched-by-app session record + deep link; spend → an
 * llm_calls row (purpose chat) linked to the message + the Health line; the daily cap; cancel.
 */
import net from 'node:net';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ChatPart, ChatSseEvent } from '../../../src/contract';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { createFakeChatQuery, type FakeChatOptions } from '../../../src/llm/chat/fake';
import { createAgentSdkChatRunner } from '../../../src/llm/chat/runner';
import { createChatHost } from '../../../src/server/chat/host';
import { createDbDataSource, DbDataSource } from '../../../src/server/datasource/db';
import { chatRunnerBackend } from '../../../src/server/datasource/db/chat';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { uuidFor } from '../../../src/server/datasource/db/ids';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { NO_HOLDS } from '../../../src/lib/canvas/payload';
import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import { logDiscrepancies } from '../../../src/server/datasource/db/store/log-check';
import { cards, collect, of, textOf } from '../../chat/helpers';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_bechat_${SUFFIX}`;
const URL = `postgres://localhost:5432/${NAME}`;
/** Postgres on localhost:5432 (a TCP probe; the suite skips without it). */
const AVAILABLE = await new Promise<boolean>((resolve) => {
  const s = net.connect(5432, '127.0.0.1', () => {
    s.end();
    resolve(true);
  });
  s.on('error', () => resolve(false));
  s.setTimeout(1500, () => {
    s.destroy();
    resolve(false);
  });
});

let handle: DbHandle;
let db: DbDataSource;
let userId: string;
let now: Date;
let threadId: string;
const envBefore = { ...process.env };
const T = (mockId: string) => uuidFor(mockId);

function dbWith(fake: FakeChatOptions = {}) {
  return new DbDataSource({
    handle,
    userId,
    clock: { now: () => now },
    chatBackend: chatRunnerBackend(createAgentSdkChatRunner({ queryFn: createFakeChatQuery({ resultCostUsd: 0.002, ...fake }), scanPollMs: 20, scanFollowMs: 300 })),
  });
}
const rows = async <R extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await handle.db.execute<R>(q)).rows;
const ask = (d: DbDataSource, text: string, signal = new AbortController().signal) => collect(d.chat({ body: { threadId, text, context: [] }, signal } as never));
async function lastAssistant(d: DbDataSource = db) {
  return (await d.getChatThread({ params: { id: threadId } } as never)).messages.filter((m) => m.role === 'assistant').at(-1)!;
}

beforeAll(async () => {
  if (!AVAILABLE) return;
  process.env.DATABASE_URL = URL;
  if (!/^control_center_bechat_[a-z0-9]+$/.test(NAME)) throw new Error(`BE-CHAT tests only run against control_center_bechat_*, not ${NAME}`);
  const admin = createDb({ url: 'postgres://localhost:5432/postgres', max: 1, applicationName: 'bechat-test-admin' });
  try {
    await admin.db.execute(sql.raw(`drop database if exists ${NAME} with (force)`));
    await admin.db.execute(sql.raw(`create database ${NAME}`));
  } finally {
    await admin.close();
  }
  await runMigrations({ url: URL, log: () => {} });
  handle = createDb({ url: URL, max: 5, applicationName: 'bechat-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  const { seed, rankedAt } = seedFromMock(mock);
  now = mock.now();
  mock.dispose();
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt, reset: true });
  userId = res.userId;
  db = dbWith();
  threadId = (await db.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id;
});

afterEach(() => {
  process.env = { ...envBefore, DATABASE_URL: URL };
});

afterAll(async () => {
  if (!AVAILABLE) return;
  await db?.dispose();
  await handle?.close();
});

describe.runIf(AVAILABLE)('BE-CHAT on Postgres', () => {
  it('top 3: streams the answer from the context pack, persisted with usage', async () => {
    const evs = await ask(db, 'What are my top 3 today and why?');
    expect(of(evs, 'done')).toHaveLength(1);
    expect(textOf(evs)).toMatch(/^Your top \d today:\n\n1\. \*\*/);
    const msg = await lastAssistant();
    expect(msg).toMatchObject({ status: 'complete', model: 'sonnet', usage: { costUsd: 0.002 } });
  });

  it('proposal → Apply in one change set (actor chat) → receipt part → Undo', async () => {
    const id = T('w_vdp_globex');
    const before = (await db.getItem({ params: { id } } as never)).item;
    const evs = await ask(db, 'propose: snooze the Globex VDP update until 14:00');
    const p = of(evs, 'proposal')[0]!.proposal;
    expect(p).toMatchObject({ status: 'pending', actor: 'chat', entity: { type: 'work_item', id } });
    expect((await db.getItem({ params: { id } } as never)).item.state).toBe(before.state);
    const [plan] = await rows<{ n: number }>(sql`select count(*)::int as n from user_settings where key = ${`cc.chat.plan/${p.id}`}`);
    expect(plan!.n).toBe(1);

    const applied = await db.applyProposal({ params: { id: p.id }, body: {} } as never);
    expect(applied.entity.status).toBe('applied');
    const [cs] = await rows<{ actor_kind: string; actor_ref: string; undoable: boolean }>(sql`select actor_kind, actor_ref, undoable from change_sets where id = ${applied.auditId}`);
    expect(cs).toEqual({ actor_kind: 'chat', actor_ref: 'chat.apply', undoable: true });
    expect(applied.receipt!.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['state', 'snoozedUntil']));
    const after = (await db.getItem({ params: { id } } as never)).item;
    expect(after).toMatchObject({ state: 'snoozed', snoozedFrom: before.state });
    expect(Date.parse(after.snoozedUntil!)).toBe(Date.parse(p.changes[1]!.after as string));
    expect(after.userLockedFields).toEqual(before.userLockedFields);

    let msg = await lastAssistant();
    const i = msg.parts.findIndex((x) => x.type === 'proposal');
    expect(msg.parts[i]).toMatchObject({ status: 'applied' });
    expect(msg.parts[i + 1]).toMatchObject({ type: 'receipt', receipt: { actor: 'chat' } });

    await db.undoAudit({ params: { id: applied.auditId! }, body: {} } as never);
    expect((await db.getItem({ params: { id } } as never)).item.state).toBe(before.state);
    msg = await lastAssistant();
    const r = msg.parts.find((x): x is Extract<ChatPart, { type: 'receipt' }> => x.type === 'receipt')!;
    expect(r.receipt.changes.every((c) => !!c.undoneAt)).toBe(true);
    expect(msg.parts[i]).toMatchObject({ status: 'applied' });
  });

  it('edit_activities on several Time-page rows applies as ONE change set, locks the fields (never status), and undoes as one', async () => {
    const host = createChatHost(db, db.be6.backend(), () => now);
    const ids = [T('ac_wed_hooli'), T('ac_wed_nce')];
    const opp = T('opp_acme_af');
    const m0 = await db.model();
    const before = ids.map((id) => m0.get('activity', id)!);
    expect((await host.previewChanges([{ op: 'edit_activities', entryIds: [T('ac_mon_prep')], patch: { oppId: opp } }], threadId)).errors[0]).toMatch(/already logged/);
    expect((await host.previewChanges([{ op: 'edit_activities', entryIds: ids, patch: { oppId: opp, status: 'approved' } }], threadId)).errors[0]).toMatch(/needs a task type/);
    expect((await host.previewChanges([{ op: 'edit_activities', entryIds: ids, patch: { taskType: 'Made Up Type' } }], threadId)).errors[0]).toMatch(/unknown task type/);
    const preview = await host.previewChanges([{ op: 'edit_activities', entryIds: ids, patch: { oppId: opp, status: 'approved', taskType: 'Solution Design' } }], threadId);
    expect(preview.errors).toEqual([]);
    const p = await host.stageChanges({ threadId, messageId: crypto.randomUUID(), changes: preview.changes, lines: preview.lines, entity: preview.entity, reason: 'Put these on the ACME Agentforce opp?' });
    const [{ n: cs0 }] = (await rows<{ n: number }>(sql`select count(*)::int as n from change_sets where undoable`)) as [{ n: number }];
    const applied = await db.applyProposal({ params: { id: p.id }, body: {} } as never);
    const [{ n: cs1 }] = (await rows<{ n: number }>(sql`select count(*)::int as n from change_sets where undoable`)) as [{ n: number }];
    expect(cs1 - cs0).toBe(1);
    const m1 = await db.model();
    for (const id of ids) {
      expect(m1.get('activity', id)).toMatchObject({ oppId: opp, status: 'approved' });
      expect(m1.get('activity', id)!.userLockedFields).toEqual(expect.arrayContaining(['oppId']));
      // status is the logging pipeline's (a created canvas moves it): never a user lock
      expect(m1.get('activity', id)!.userLockedFields).not.toContain('status');
    }
    const [row] = await rows<{ n: number }>(sql`select count(*)::int as n from activity_entries where id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) and opportunity_id is not null and approved_at is not null`);
    expect(row!.n).toBe(2);
    expect(applied.receipt!.changes.filter((c) => c.entity.type === 'activity_entry').length).toBeGreaterThanOrEqual(4);
    await db.undoAudit({ params: { id: applied.auditId! }, body: {} } as never);
    const m2 = await db.model();
    for (const b of before) expect(m2.get('activity', b.id)).toMatchObject({ oppId: b.oppId, status: b.status });
  });

  it('a log batch takes approved (and complete proposed) rows that have ended, skips incomplete ones, and adds Duration__c backfills', async () => {
    const sow = T('ac_tue_sow'); // approved, Proposal, on opp_globex_d360
    const nce = T('ac_wed_nce'); // proposed, Solution Design
    const hooli = T('ac_wed_hooli'); // needs input: not in a batch
    await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, (tx) => tx.execute(sql`update activity_entries set what_org62_id = '006XX0000000OPPAAA' where id in (${sow}::uuid, ${nce}::uuid)`));
    await handle.db.execute(sql`insert into org62_events (owner_user_id, org62_event_id, record_type_name, subject, starts_at, ends_at, duration_field)
                                values (${userId}, '00UXX0000000EVTAAA', 'Solutions Event', 'PLACEHOLDER review', ${new Date(now.getTime() - 3 * 3_600_000).toISOString()}::timestamptz, ${new Date(now.getTime() - 3 * 3_600_000 + 5_400_000).toISOString()}::timestamptz, null)`);
    const o = { now: new Date(now.getTime() + 7 * 86_400_000), timezone: 'America/Los_Angeles', recordTypeId: '012XX0000000RTYAAA', held: NO_HOLDS };
    const onlyApproved = await buildLogBatch(handle.db, userId, { ...o, approveComplete: false });
    expect(onlyApproved.canvases.flatMap((c) => c.eventIds)).toContain(sow);
    expect(onlyApproved.canvases.flatMap((c) => c.eventIds)).not.toContain(nce);
    const b = await buildLogBatch(handle.db, userId, { ...o, approveComplete: true });
    const ids = b.canvases.flatMap((c) => c.eventIds);
    expect(ids).toEqual(expect.arrayContaining([sow, nce]));
    expect(ids).not.toContain(hooli);
    expect(b.approveIds).toContain(nce);
    expect(b.approveIds).not.toContain(sow);
    expect(b.updates).toBe(1);
    const md = b.canvases[0]!.markdown;
    expect(md).toContain(`CC#${sow}`);
    expect(md).toContain('RecordTypeId `012XX0000000RTYAAA`');
    // WO-1: one table per object and verb; the Duration fix is a row of EVENTS TO UPDATE
    expect(md).toMatch(/## EVENTS TO UPDATE \(1 row\)\n\n\*\*EVENTS TO UPDATE:\*\*[^\n]*\n\n\|#\|Record Id\|Field\|New value\|Current value\|Why\|\n\|---\|---\|---\|---\|---\|---\|\n\|1\|00UXX0000000EVTAAA\|Duration__c\|1\.5\|\(blank\)\|/);
    expect(b.canvases[0]!.title).toMatch(/^Activity log · .+ · \d+ rows$/);
    expect(b.canvases[0]!.updateIds).toEqual(['00UXX0000000EVTAAA']);
    expect(b.waiting).toEqual({ rows: 0, hours: 0, draftIds: [] });
    // a row (and a Duration fix) an earlier canvas item still holds is left out and counted as waiting
    const again = await buildLogBatch(handle.db, userId, { ...o, approveComplete: true, held: { rows: new Map([[sow, 'draft-held']]), updates: new Set(['00UXX0000000EVTAAA']) } });
    expect(again.canvases.flatMap((c) => c.eventIds)).not.toContain(sow);
    expect(again.canvases.flatMap((c) => c.eventIds)).toContain(nce);
    expect(again.waiting).toMatchObject({ rows: 1, draftIds: ['draft-held'] });
    expect(again.waiting.hours).toBeGreaterThan(0);
    expect(again.updates).toBe(0);
  });

  it('chat_log_batch previews the batch with the logging settings, skips and the Org62 check (no live lookup without connectors)', async () => {
    const host = createChatHost(db, db.be6.backend(), () => new Date(now.getTime() + 7 * 86_400_000));
    const b = await host.logBatch({});
    expect(b.available).toBe(true);
    expect(b).toMatchObject({ mode: 'on_demand', canvasStyle: 'per_batch', recordTypeKnown: false });
    expect(b.events).toBeGreaterThan(0);
    expect(b.canvases[0]!.preview).toContain('Slackbot: this canvas is a complete work order');
    expect(b.canvases[0]!.chars).toBeLessThanOrEqual(12_000);
    const onlyApproved = await host.logBatch({ includeProposed: false });
    expect(onlyApproved.events).toBeLessThan(b.events);
    expect(onlyApproved.approveCount).toBe(0);
  });

  it('D-58: the preview reads only (no kv write, no lookup); prompt_version is the skill’s', async () => {
    const host = createChatHost(db, db.be6.backend({ liveConnectors: true }), () => new Date(now.getTime() + 7 * 86_400_000));
    const before = await rows<{ n: string }>(sql`select count(*)::text as n from user_settings where owner_user_id = ${userId}`);
    const cs0 = await rows<{ n: string }>(sql`select count(*)::text as n from change_sets where owner_user_id = ${userId}`);
    const b = await host.logBatch({});
    expect(b.recordTypeKnown).toBe(false);
    expect(await rows<{ n: string }>(sql`select count(*)::text as n from user_settings where owner_user_id = ${userId}`)).toEqual(before);
    expect(await rows<{ n: string }>(sql`select count(*)::text as n from change_sets where owner_user_id = ${userId}`)).toEqual(cs0);
    await ask(db, 'top 3 today');
    const msg = await lastAssistant();
    const [call] = await rows<{ prompt_version: string; skill_key: string }>(sql`select prompt_version, skill_key from llm_calls where request_hash like ${`chat:${msg.id}:%`}`);
    expect(call!.skill_key).toBe('chat-assistant');
    expect(call!.prompt_version).toMatch(/^chat-assistant@\d+$/);
    expect(call!.prompt_version).not.toBe('chat-assistant@3');
  });

  it('D-58: a DC request rides on the next db logging batch as an ADD row (held once a canvas item carries it)', async () => {
    const opp = T('opp_umbrella_af');
    await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, (tx) => tx.execute(sql`update opportunities set org62_opportunity_id = '006XX0000000DCRAAA' where id = ${opp}::uuid`));
    const r = await db.createDcRequest({ body: { opp: '006XX0000000DCR', split: 40, comment: 'Ran the Agentforce Care POC' } } as never);
    expect(r.entity).toMatchObject({ oppId: opp, org62OpportunityId: '006XX0000000DCRAAA', splitPercent: 40, status: 'approved', stage: 'waiting' });
    expect(r.auditId).toBeTruthy();
    const o = { now: new Date(now.getTime() + 7 * 86_400_000), timezone: 'America/Los_Angeles', recordTypeId: '012XX0000000RTYAAA', held: NO_HOLDS, approveComplete: true };
    const b = await buildLogBatch(handle.db, userId, o);
    const md = b.canvases.map((c) => c.markdown).join('\n');
    // WO-1: the DC is a row of its own table, DEAL CONTRIBUTIONS TO CREATE, its cells named by their Org62 fields
    expect(md).toMatch(/## DEAL CONTRIBUTIONS TO CREATE \(1 row\)\n\n\*\*DEAL CONTRIBUTIONS TO CREATE:\*\*/);
    expect(md).toContain('|#|Opportunity|Opportunity__c|Opportunity_Role__c|Split_Percentage__c|Comments__c|');
    expect(md).toContain('|1|Umbrella · Agentforce Care|006XX0000000DCRAAA|AI + Data Architect|40|Ran the Agentforce Care POC|');
    expect(b.canvases.at(-1)!.title).toMatch(/· 1 DC$/);
    // undo removes the request (audited table)
    await db.undoAudit({ params: { id: r.auditId! }, body: {} } as never);
    expect((await db.listDcRequests({} as never)).requests).toEqual([]);
    expect((await buildLogBatch(handle.db, userId, o)).canvases.map((c) => c.markdown).join('\n')).not.toContain('Umbrella · Agentforce Care|006XX0000000DCRAAA');
  });

  it('the Org62 check flags rows handed off a day ago and still missing, and logged rows whose Org62 hours differ', async () => {
    const globex = T('ac_tue_globex'); // synced_to_canvas
    const later = new Date(now.getTime() + 2 * 86_400_000);
    await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, (tx) => tx.execute(sql`update activity_entries set synced_to_canvas_at = ${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz, org62_event_row_id = null where id = ${globex}::uuid`));
    const d = await logDiscrepancies(handle.db, userId, { now: later, timezone: 'America/Los_Angeles' });
    expect(d.find((x) => x.id === globex)).toMatchObject({ kind: 'not_in_org62' });
    expect(await logDiscrepancies(handle.db, userId, { now: new Date(now.getTime() + 3_600_000), timezone: 'America/Los_Angeles' })).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: globex })]));
    const [ev] = (await handle.db.execute<{ id: string }>(sql`insert into org62_events (owner_user_id, org62_event_id, record_type_name, subject, starts_at, ends_at, duration_field)
      values (${userId}, '00UXX0000000EV2AAA', 'Solutions Event', 'PLACEHOLDER briefing', ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz, 3) returning id`)).rows;
    await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, (tx) => tx.execute(sql`update activity_entries set org62_event_row_id = ${ev!.id}::uuid where id = ${globex}::uuid`));
    const d2 = await logDiscrepancies(handle.db, userId, { now: later, timezone: 'America/Los_Angeles' });
    expect(d2.find((x) => x.id === globex)).toMatchObject({ kind: 'hours_differ', org62EventId: '00UXX0000000EV2AAA' });
  });

  it('a mixed plan (pin, edit, evidence, new item, policy weight) applies as ONE change set and undoes as one', async () => {
    const host = createChatHost(db, db.be6.backend(), () => now);
    const pinId = T('w_initech_prep');
    const editId = T('w_umbrella_deck');
    const pol0 = (await db.getSettings({} as never)).policy;
    const preview = await host.previewChanges(
      [
        { op: 'pin', itemId: pinId },
        { op: 'edit_fields', itemId: editId, patch: { notes: 'Bring the FHIR mapping (from chat)' } },
        { op: 'link_evidence', itemId: editId, role: 'context', source: { kind: 'drive', label: 'Umbrella architecture deck v3' }, summary: 'The deck to update' },
        { op: 'create_item', title: 'Follow up with Umbrella on FHIR', effortMin: 20 },
        { op: 'policy_weights', deltas: { customer_facing: 1 } },
      ],
      threadId,
    );
    expect(preview.errors).toEqual([]);
    expect(preview.entity.type).toBe('chat_thread');
    const p = await host.stageChanges({ threadId, messageId: crypto.randomUUID(), changes: preview.changes, lines: preview.lines, entity: preview.entity, reason: 'Re-plan the Umbrella work?' });
    const [{ n: cs0 }] = (await rows<{ n: number }>(sql`select count(*)::int as n from change_sets where undoable`)) as [{ n: number }];
    const applied = await db.applyProposal({ params: { id: p.id }, body: {} } as never);
    const [{ n: cs1 }] = (await rows<{ n: number }>(sql`select count(*)::int as n from change_sets where undoable`)) as [{ n: number }];
    expect(cs1 - cs0).toBe(1); // one undoable change set for everything
    const m = await db.model();
    expect(m.get('workItems', pinId)!.rank).toBe(1);
    expect(m.get('workItems', editId)!.notes).toContain('Bring the FHIR mapping (from chat)');
    expect(m.settings().policy.version).toBe(pol0.version + 1);
    expect(m.settings().policy.weights.customer_facing).toBe(Math.min(10, pol0.weights.customer_facing + 1));
    const created = applied.receipt!.changes.find((c) => c.label === 'Created')!;
    expect(m.get('workItems', created.entity.id)!.title).toBe('Follow up with Umbrella on FHIR');
    expect(applied.receipt!.changes.some((c) => c.label === 'Evidence')).toBe(true);
    const [ev] = await rows<{ n: number }>(sql`select count(*)::int as n from work_item_evidence where work_item_id = ${editId} and created_by = 'chat'`);
    expect(ev!.n).toBeGreaterThanOrEqual(1);

    await db.undoAudit({ params: { id: applied.auditId! }, body: {} } as never);
    const m2 = await db.model();
    expect(m2.get('workItems', created.entity.id)).toBeUndefined();
    expect(m2.get('workItems', editId)!.notes).not.toContain('from chat');
    expect(m2.settings().policy.version).toBe(pol0.version);
    expect(m2.settings().policy.weights.customer_facing).toBe(pol0.weights.customer_facing);
  });

  it('rescan enqueues a manual scan job (trigger chat); the slack.scan row shows progress and a reload follows the job row', async () => {
    const evs = await ask(db, 'rescan slack for the last 48 hours');
    const start = of(evs, 'tool-start').find((t) => t.name === 'slack.scan')!;
    expect(of(evs, 'tool-progress').find((e) => e.id === start.id)).toMatchObject({ done: 0, total: 3 });
    const result = of(evs, 'tool-result').find((e) => e.id === start.id)!;
    expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('continues in the background') }); // no worker in this test
    const jobId = JSON.parse(result.result!).scanId as string;
    const [job] = await rows<{ kind: string; status: string; payload: { kind: string; trigger: string; mode: string; connector: string; scope: string; window: { from: string; to: string } } }>(sql`select kind, status::text as status, payload from jobs where id = ${Number(jobId)}`);
    expect(job).toMatchObject({ kind: 'scan.slack', status: 'queued', payload: { kind: 'scan', trigger: 'chat', mode: 'manual', connector: 'slack', scope: 'inbox' } });
    expect(Date.parse(job!.payload.window.to) - Date.parse(job!.payload.window.from)).toBe(48 * 3_600_000);
    // the worker finishes it: the row reads done on reload
    await handle.db.execute(sql`update jobs set status = 'succeeded', finished_at = now() where id = ${Number(jobId)}`);
    const msg = await lastAssistant();
    const row = msg.parts.find((x): x is Extract<ChatPart, { type: 'tool' }> => x.type === 'tool' && x.name === 'slack.scan')!;
    expect(row).toMatchObject({ ok: true, summary: 'Slack scan done', progress: { done: 3, total: 3 } });
  });

  it('a draft card (drafting) → Add to Outbox (queueDraft: ready, audited, undoable; idempotent) → no send attempt', async () => {
    const evs = await ask(db, 'draft an email to dana@acme.example about moving the demo to Thursday');
    const d = cards(evs, 'draft')[0]!.draft;
    expect(d).toMatchObject({ channel: 'email', to: 'dana@acme.example', status: 'drafting' });
    const inOutbox = async () => (await db.getOutbox({} as never)).groups.find((g) => g.group === 'pending_approval')!.items.some((i) => i.draft.id === d.draftId);
    expect(await inOutbox()).toBe(false);
    const draft = await db.getDraft({ params: { id: d.draftId } } as never);
    await expect(db.queueDraft({ params: { id: d.draftId }, body: { ifVersion: draft.version + 3 } } as never)).rejects.toMatchObject({ code: 'conflict' });
    const q = await db.queueDraft({ params: { id: d.draftId }, body: { ifVersion: draft.version } } as never);
    expect(q.entity).toMatchObject({ status: 'ready', version: draft.version + 1 });
    const [cs] = await rows<{ actor_kind: string; actor_ref: string; undoable: boolean }>(sql`select actor_kind, actor_ref, undoable from change_sets where id = ${q.auditId}`);
    expect(cs).toEqual({ actor_kind: 'user', actor_ref: 'draft.queue', undoable: true });
    expect(await inOutbox()).toBe(true);
    expect(await db.queueDraft({ params: { id: d.draftId }, body: { ifVersion: 1 } } as never)).toMatchObject({ entity: { status: 'ready' }, auditId: null });
    const [att] = await rows<{ n: number }>(sql`select count(*)::int as n from draft_send_attempts where draft_id = ${d.draftId}`);
    expect(att!.n).toBe(0);
    await db.undoAudit({ params: { id: q.auditId! }, body: {} } as never);
    expect((await db.getDraft({ params: { id: d.draftId } } as never)).status).toBe('drafting');
  });

  it('REJECT-1: Reject takes a pending draft out of the Outbox (rejected, audited, undoable; idempotent), never a send attempt', async () => {
    const evs = await ask(db, 'draft an email to lee@initech.example about the pilot timeline');
    const d = cards(evs, 'draft')[0]!.draft;
    const draft = await db.getDraft({ params: { id: d.draftId } } as never);
    await db.queueDraft({ params: { id: d.draftId }, body: { ifVersion: draft.version } } as never);
    const inOutbox = async () => (await db.getOutbox({} as never)).groups.some((g) => g.items.some((i) => i.draft.id === d.draftId));
    expect(await inOutbox()).toBe(true);
    const r = await db.rejectDraft({ params: { id: d.draftId }, body: { reason: 'not needed' } } as never);
    expect(r.entity).toMatchObject({ status: 'rejected', rejectedReason: 'not needed' });
    const [cs] = await rows<{ actor_ref: string; undoable: boolean }>(sql`select actor_ref, undoable from change_sets where id = ${r.auditId}`);
    expect(cs).toEqual({ actor_ref: 'draft.reject', undoable: true });
    expect(await inOutbox()).toBe(false);
    expect(await db.rejectDraft({ params: { id: d.draftId }, body: {} } as never)).toMatchObject({ entity: { status: 'rejected' }, auditId: null });
    const [att] = await rows<{ n: number }>(sql`select count(*)::int as n from draft_send_attempts where draft_id = ${d.draftId}`);
    expect(att!.n).toBe(0);
    await db.undoAudit({ params: { id: r.auditId! }, body: {} } as never);
    expect((await db.getDraft({ params: { id: d.draftId } } as never)).status).toBe('ready');
    expect(await inOutbox()).toBe(true);
  });

  it('a session is a prepared deep link plus a launched-by-app session record (never opened)', async () => {
    const evs = await ask(db, 'start a claude code session in command-center: tidy the chat runner logs');
    const s = cards(evs, 'session')[0]!.session;
    expect(s.url.startsWith('claude://code/new?folder=')).toBe(true);
    const [row] = await rows<{ launched_by_app: boolean; launch_prompt: string }>(sql`select launched_by_app, launch_prompt from claude_sessions where id = ${s.id}`);
    expect(row!.launched_by_app).toBe(true);
    expect(row!.launch_prompt).toContain(`[cc:${s.id}]`);
  });

  it('spend: one llm_calls row per turn (purpose chat) linked to the message, and the chat line in Health', async () => {
    await ask(db, 'top 3 today');
    const msg = await lastAssistant();
    const [call] = await rows<{ purpose: string; cost_usd: string; chat_message_id: string | null; status: string }>(sql`select purpose::text, cost_usd, chat_message_id, status::text from llm_calls where request_hash like ${`chat:${msg.id}:%`}`);
    expect(call).toMatchObject({ purpose: 'chat', chat_message_id: msg.id, status: 'ok' });
    expect(Number(call!.cost_usd)).toBeCloseTo(0.002, 6);
    const health = await db.getHealth({} as never);
    expect(health.spend.byScanner.find((s) => s.name === 'chat')!.usd).toBeGreaterThan(0);
  });

  it("the chat's daily line stops the next turn with budget_exceeded before any model call", async () => {
    process.env.CC_CHAT_DAILY_USD = '0.001';
    const evs = await ask(db, 'top 3 today');
    expect(of(evs, 'error')[0]!.error).toMatchObject({ code: 'budget_exceeded' });
    expect(of(evs, 'tool-start')).toHaveLength(0);
  });

  it('Stop cancels the turn and the message persists as stopped', async () => {
    const slow = dbWith({ delayMs: 60 });
    try {
      const ac = new AbortController();
      const evs = await collect(slow.chat({ body: { threadId, text: 'snooze the Globex VDP update until 14:00', context: [] }, signal: ac.signal } as never), {
        onEvent: (e: ChatSseEvent) => {
          if (e.type === 'tool-start') ac.abort();
        },
      });
      expect(of(evs, 'done')).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 150));
      expect((await lastAssistant(slow)).status).toBe('stopped');
    } finally {
      await slow.dispose();
    }
  });

  it('DM-10: the ledger search finds the right source item by full-text rank over title + body (it used to query a missing column and return nothing)', async () => {
    const add = (ext: string, title: string, body: string, at: string) =>
      handle.db.execute(sql`
        insert into source_items (owner_user_id, source, kind, external_id, dedupe_key, content_hash, occurred_at, from_me, title, body, body_format, url, meta)
        values (${userId}::uuid, 'slack', 'slack_message', ${ext}, ${`slack:${ext}`}, ${`h:${ext}`}, ${at}::timestamptz, false, ${title}, ${body}, 'plain', ${`https://example.slack.com/archives/C0DM10/${ext}`}, '{}'::jsonb)`);
    await add('p1793893334000001', 'Zanzibar pricing workshop', 'Dana asked for the Zanzibar pricing workshop deck before Friday.', now.toISOString());
    await add('p1793893334000002', 'Quokka renewal', 'Where is it now? The Quokka renewal deck still needs the security appendix.', new Date(now.getTime() - 86_400_000).toISOString());
    const host = createChatHost(db, db.be6.backend(), () => now);
    const r = await host.searchSources('zanzibar workshops', { sources: ['ledger'], limit: 5 });
    expect(r.notes).toEqual([]);
    expect(r.hits.map((h) => h.title)).toEqual(['Zanzibar pricing workshop']);
    expect(r.hits[0]).toMatchObject({ source: 'slack', kind: 'slack_message', externalId: 'p1793893334000001', url: 'https://example.slack.com/archives/C0DM10/p1793893334000001' });
    // the excerpt is computed from the body
    expect(r.hits[0]!.excerpt).toMatch(/^Dana asked for the Zanzibar pricing workshop deck/);
    // ranked: the item whose title and body both match comes first
    const both = await host.searchSources('quokka OR zanzibar', { sources: ['ledger'], limit: 5 });
    expect(both.hits.map((h) => h.externalId).sort()).toEqual(['p1793893334000001', 'p1793893334000002']);
    // a query with no full-text words (only stop words) falls back to matching words in titles and bodies, and says so
    const stop = await host.searchSources('where is it', { sources: ['ledger'], limit: 5 });
    expect(stop.hits.map((h) => h.externalId)).toContain('p1793893334000002');
    expect(stop.hits.map((h) => h.externalId)).not.toContain('p1793893334000001');
    expect(stop.notes.join(' ')).toMatch(/no full-text words/);
    // and through the chat tool the model calls
    const evs = await ask(db, 'find the zanzibar workshop thread');
    expect(of(evs, 'error')).toHaveLength(0);
  });

  it('createDbDataSource wires the chat runner (fake model unless CC_CHAT_LLM=1); a bare DbDataSource stays "not wired"', async () => {
    const wired = createDbDataSource({ handle, userId, clock: { now: () => now } });
    const bare = new DbDataSource({ handle, userId, clock: { now: () => now } });
    try {
      expect(of(await ask(wired, 'top 3 today'), 'done')).toHaveLength(1);
      const evs = await ask(bare, 'top 3 today');
      expect(evs.map((e) => e.type)).toEqual(['start', 'error']);
    } finally {
      await wired.dispose();
      await bare.dispose();
    }
  });

  it('CHAT-1: an install with no chat thread gets one default "Today" thread (once, under concurrency), so Send works', async () => {
    const wired = createDbDataSource({ handle, userId, clock: { now: () => now } });
    try {
      await handle.db.execute(sql`delete from chat_threads where owner_user_id = ${userId}`);
      const lists = await Promise.all([wired.listChatThreads({} as never), wired.listChatThreads({} as never), wired.listChatThreads({} as never)]);
      const [n] = await rows<{ n: number }>(sql`select count(*)::int as n from chat_threads where owner_user_id = ${userId} and scope = 'day'`);
      expect(n!.n).toBe(1);
      for (const l of lists) expect(l.threads.filter((t) => t.isDefault)).toHaveLength(1);
      // POST /chat without a thread id lands in it (before: "Chat thread (default) not found").
      await handle.db.execute(sql`delete from chat_threads where owner_user_id = ${userId}`);
      const evs = await collect(wired.chat({ body: { text: 'top 3 today', context: [] }, signal: new AbortController().signal } as never));
      expect(of(evs, 'error')).toHaveLength(0);
      expect(of(evs, 'done')).toHaveLength(1);
    } finally {
      await wired.dispose();
    }
  });
  it('Assistant v2: act runs a snooze at once (one change set, actor chat, undoable); the route rides on the message', async () => {
    threadId = (await db.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id; // CHAT-1 above recreates it
    const id = T('w_acme_build');
    const before = (await db.getItem({ params: { id } } as never)).item;
    const evs = await ask(db, 'snooze the ACME Phase 2 demo until 14:00');
    expect(of(evs, 'start')[0]!.route).toMatchObject({ intent: 'act', tier: 'fast', model: 'haiku' });
    const receipt = of(evs, 'receipt')[0]!.receipt;
    expect((await db.getItem({ params: { id } } as never)).item.state).toBe('snoozed');
    const [cs] = await rows<{ actor_kind: string; undoable: boolean }>(sql`select actor_kind, undoable from change_sets where id = ${receipt.changes[0]!.auditId}`);
    expect(cs).toMatchObject({ actor_kind: 'chat', undoable: true });
    const msg = await lastAssistant();
    expect(msg).toMatchObject({ model: 'haiku', route: { intent: 'act', tier: 'fast' }, usage: { tier: 'fast' } });
    await db.undoAudit({ params: { id: receipt.changes[0]!.auditId }, body: {} } as never);
    expect((await db.getItem({ params: { id } } as never)).item.state).toBe(before.state);
  });

  it('Assistant v2: the thread keeps its SDK session (chat_threads.sdk_session_id) and the next message resumes it', async () => {
    const seen: Array<{ resume?: string; sessionId?: string; persistSession?: boolean }> = [];
    const spy = createFakeChatQuery({ resultCostUsd: 0.002 });
    const d = new DbDataSource({ handle, userId, clock: { now: () => now }, chatBackend: chatRunnerBackend(createAgentSdkChatRunner({ queryFn: (p) => (seen.push({ resume: p.options.resume, sessionId: p.options.sessionId, persistSession: p.options.persistSession }), spy(p)), scanPollMs: 20, scanFollowMs: 50 })) });
    try {
      const t = await d.createChatThread({ body: { title: 'Sessions', context: [] } } as never);
      const send = (text: string) => collect(d.chat({ body: { threadId: t.id, text, context: [] }, signal: new AbortController().signal } as never));
      await send('top 3 today');
      const [row] = await rows<{ s: string | null }>(sql`select sdk_session_id as s from chat_threads where id = ${t.id}::uuid`);
      expect(row!.s).toBe(seen[0]!.sessionId);
      expect(seen[0]).toMatchObject({ persistSession: true, resume: undefined });
      await send('top 3 again');
      expect(seen[1]).toMatchObject({ resume: seen[0]!.sessionId, sessionId: undefined });
    } finally {
      await d.dispose();
    }
  });

  it('Assistant v2: remember → chat_memory (a preference for every thread), listed and forgotten through the routes', async () => {
    threadId = (await db.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id; // CHAT-1 above recreates it
    const evs = await ask(db, 'remember that I always log in 15-minute steps');
    expect(of(evs, 'done')).toHaveLength(1);
    const [m] = await rows<{ kind: string; pinned: boolean; thread_id: string | null }>(sql`select kind, pinned, thread_id from chat_memory where owner_user_id = ${userId}::uuid`);
    expect(m).toMatchObject({ kind: 'preference', pinned: true, thread_id: null });
    const list = await db.listChatMemory({ query: { threadId } } as never);
    expect(list.entries.map((e) => e.text)).toContain('I always log in 15-minute steps');
    // it rides on the next turn's header
    const evs2 = await ask(db, 'top 3 today');
    expect(of(evs2, 'done')).toHaveLength(1);
    const del = await db.deleteChatMemory({ params: { id: list.entries[0]!.id }, body: {} } as never);
    expect(del).toEqual({ deleted: true });
    expect((await db.listChatMemory({ query: {} } as never)).entries).toHaveLength(0);
  });

  it('Assistant v2: Settings ▸ Budgets routing "always Opus" overrides Auto; a message’s own choice still wins', async () => {
    threadId = (await db.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id; // CHAT-1 above recreates it
    const s0 = await db.getSettings({} as never);
    await db.patchSettings({ params: { section: 'chat' }, body: { ifVersion: s0.chat.version, value: { routing: 'opus' } } } as never);
    const a = await ask(db, 'snooze the ACME Phase 2 demo until 15:00');
    expect(of(a, 'start')[0]).toMatchObject({ model: 'opus', route: { override: true, why: 'Settings: always Opus' } });
    const b = await collect(db.chat({ body: { threadId, text: 'top 3 today', context: [], model: 'haiku' }, signal: new AbortController().signal } as never));
    expect(of(b, 'start')[0]).toMatchObject({ model: 'haiku', route: { why: 'you chose Haiku' } });
    const s1 = await db.getSettings({} as never);
    await db.patchSettings({ params: { section: 'chat' }, body: { ifVersion: s1.chat.version, value: { routing: 'auto' } } } as never);
  });
});
