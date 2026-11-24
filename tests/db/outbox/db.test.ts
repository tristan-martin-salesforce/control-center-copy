/**
 * BE-OUTBOX · the db path end to end against Postgres 17: dispatch (confirm token, approval, payload hash,
 * `outbox.dispatch` job) → the job handler (approval re-check, dry-run re-read, adapters via a fake MCP
 * transport, read-back) → change sets on draft_send_attempts / draft_verifications / drafts → the Outbox.
 *
 * Own database: control_center_beoutbox_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Skipped when no
 * local Postgres 17 is reachable. No real write tool is ever called: the gateway's transport is FakeMcp.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import { routes, type Draft, type Seed } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { liveOutboxTransport, OUTBOX_QUEUE, OutboxGateway, outboxDispatchHandler, outboxJobDef, parseJobPayload, payloadHash, runOutboxJob, type OutboxJobPayload } from '../../../src/outbox';
import { createChatHost } from '../../../src/server/chat/host';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { dbOutboxPort } from '../../../src/server/datasource/db/outbox';
import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import { canvasInputOf, NO_HOLDS } from '../../../src/lib/canvas/payload';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { ensureExtractor, loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { buildIdMap, type IdMap } from '../../../src/server/datasource/db/translate';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { FakeMcp } from '../../outbox/fake';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_beoutbox_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;

/**
 * Runs wherever the repo's own DB suites run (`npm run check` needs local Postgres 17 for test:db anyway).
 * CC_BEOUTBOX_DB=0 opts out. A down server fails loudly in beforeAll rather than skipping silently.
 */
const PG = pgAvailable && process.env.CC_BEOUTBOX_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let seed: Seed;
let idMap: IdMap;
let userId: string;
let now: Date;
let extractorId: string;

const T = (id: string) => idMap.get(id) ?? id;

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_beoutbox_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'beoutbox-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  const s = seedFromMock(mock);
  seed = s.seed;
  // a freshly created database: nothing to truncate
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  mock.dispose();
  userId = res.userId;
  idMap = buildIdMap(seed);
  extractorId = await ensureExtractor(handle.db);
  ds = new DbDataSource({ handle, url: URL_, userId, clock: { now: () => now }, ranker: interimRanker });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

const routes_ok = (key: 'getCanvasReview', v: unknown) => routes[key].response.safeParse(v).success;
const port = () => dbOutboxPort(handle.db, userId, { extractorId: async () => extractorId, now: () => now });

async function setDryRun(on: boolean) {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: on }, ...(on ? {} : { confirm: true }) } });
}

async function dispatch(id: string, mode: 'draft' | 'send') {
  const p = await ds.previewDraft({ params: { id }, body: { mode } });
  const r = await ds.dispatchDraft({ params: { id }, body: { ifVersion: p.version, mode, confirmToken: p.confirmToken } });
  return { p, r };
}

async function jobFor(draftId: string): Promise<OutboxJobPayload> {
  const rows = await handle.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${draftId} order by id desc limit 1`);
  const p = parseJobPayload(rows.rows[0]!.payload);
  expect(p).not.toBeNull();
  return p!;
}

async function attemptRow(attemptId: string) {
  const r = await handle.db.execute<{ status: string; dry_run: boolean; external_id: string | null; error_code: string | null; request_hash: string; adapter: string; finished_at: string | null }>(
    sql`select status, dry_run, external_id, error_code, request_hash, adapter, finished_at from draft_send_attempts where id = ${Number(attemptId)}`,
  );
  return r.rows[0]!;
}

describe.runIf(PG)('db Outbox delivery path', () => {
  it('Settings → Sending: channels default to draft and merge per channel', async () => {
    const s = await ds.getSettings({} as never);
    expect(s.sending.dryRun).toBe(true);
    expect(s.sending.channels).toEqual({ slack: { mode: 'draft' }, gmail: { mode: 'draft' }, vdp: { mode: 'send', autopilot: false, dailyCap: 40 }, slack_canvas: { mode: 'send' } });
    const r = await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { channels: { gmail: { mode: 'send' } } } } });
    expect(r.entity.sending.channels).toEqual({ slack: { mode: 'draft' }, gmail: { mode: 'send' }, vdp: { mode: 'send', autopilot: false, dailyCap: 40 }, slack_canvas: { mode: 'send' } });
    expect((await ds.previewDraft({ params: { id: T('dr_globex_sow') }, body: {} })).mode).toBe('send');
    expect((await ds.previewDraft({ params: { id: T('dr_dana') }, body: {} })).mode).toBe('draft');
    const s2 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s2.sending.version, value: { channels: { gmail: { mode: 'draft' } } } } });
  });

  it('dry-run dispatch records the payload hash, says "Dry-run delivered" and queues nothing', async () => {
    const { p, r } = await dispatch(T('dr_onepager'), 'send');
    expect(r.dryRun).toBe(true);
    expect(r.attempt.outcome).toBe('rendered');
    expect(r.attempt.detail).toMatch(/^Dry-run delivered: payload recorded \(sha256:/);
    expect(r.draft.status).toBe('drafting');
    const row = await attemptRow(r.attempt.id);
    expect(row).toMatchObject({ status: 'succeeded', dry_run: true, request_hash: payloadHash(p.payload) });
    const jobs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'outbox.dispatch'`);
    expect(jobs.rows[0]!.n).toBe(0);
  });

  it('send: dispatch records the approval → the job sends through the fake, reads back, and the draft is verified', async () => {
    await setDryRun(false);
    const fake = new FakeMcp();
    const { p, r } = await dispatch(T('dr_globex_sow'), 'send');
    expect(r.draft.status).toBe('sending');
    expect(fake.calls).toHaveLength(0); // dispatch itself never calls out
    const job = await jobFor(r.draft.id);
    expect(job.payloadHash).toBe(payloadHash(p.payload));
    const q = await handle.db.execute<{ queue: string }>(sql`select queue from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${r.draft.id}`);
    expect(q.rows.map((x) => x.queue)).toEqual([OUTBOX_QUEUE]);
    expect(outboxJobDef({ port: () => port(), gateway: null })).toMatchObject({ kind: 'outbox.dispatch', queue: OUTBOX_QUEUE, wired: true });
    const appr = await handle.db.execute<{ ok: boolean }>(sql`select approved_at is not null and approved_content_hash = content_hash as ok from drafts where id = ${r.draft.id}`);
    expect(appr.rows[0]!.ok).toBe(true);

    const out = await runOutboxJob(job, port(), new OutboxGateway(fake), { now: () => now });
    expect(out).toMatchObject({ state: 'delivered', readback: 'confirmed' });
    expect(fake.calls.map((c) => c.tool)).toEqual(['send_gmail_message', 'get_gmail_message_content']);
    expect(fake.calls[0]!.args).toMatchObject({ subject: 'Re: Revised SOW pricing', body_format: 'html', body: p.payload.html });

    const d = await ds.getDraft({ params: { id: r.draft.id } });
    expect(d.status).toBe('verified');
    expect(d.verification).toMatchObject({ state: 'verified', detail: 'Verified in Gmail ✓' });
    expect(d.attempts.at(-1)).toMatchObject({ outcome: 'sent', dryRun: false });
    const row = await attemptRow(job.attemptId);
    expect(row).toMatchObject({ status: 'succeeded', dry_run: false, adapter: 'gmail:send', request_hash: job.payloadHash });
    expect(row.external_id).toBeTruthy();
    expect(row.finished_at).not.toBeNull();
    const outbox = await ds.getOutbox({} as never);
    expect(outbox.groups.find((g) => g.group === 'sent')!.items.map((i) => i.draft.id)).toContain(r.draft.id);
    // every delivery state was its own system change set
    const cs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from change_sets where actor_ref = 'outbox.deliver' and entity_id = ${r.draft.id}`);
    expect(cs.rows[0]!.n).toBeGreaterThanOrEqual(2);
    // re-running the job is a no-op (no double send)
    expect(await runOutboxJob(job, port(), new OutboxGateway(fake), { now: () => now })).toMatchObject({ skipped: 'draft_verified' });
    expect(fake.writes()).toHaveLength(1);
  });

  it('draft mode: the job calls the fake slack_send_message_draft; the draft is staged (no Slack draft read tool)', async () => {
    const fake = new FakeMcp();
    const { r } = await dispatch(T('dr_dana'), 'draft');
    const out = await runOutboxJob(await jobFor(r.draft.id), port(), new OutboxGateway(fake), { now: () => now });
    expect(out).toMatchObject({ state: 'delivered', readback: 'unconfirmed' });
    expect(fake.writes().map((c) => c.tool)).toEqual(['slack_send_message_draft']);
    const d = await ds.getDraft({ params: { id: r.draft.id } });
    expect(d.status).toBe('staged');
    expect(d.verification?.state).toBe('unverified');
  });

  it('a failure is an Outbox error (Failed group, error code on the attempt); Retry is a fresh confirm', async () => {
    const fake = new FakeMcp().failOnce('slack_send_message', 'channel_not_found');
    const { r } = await dispatch(T('dr_chat_initech'), 'send');
    const job = await jobFor(r.draft.id);
    const out = await runOutboxJob(job, port(), new OutboxGateway(fake), { now: () => now });
    expect(out).toMatchObject({ state: 'failed', code: 'channel_not_found' });
    const d = await ds.getDraft({ params: { id: r.draft.id } });
    expect(d.status).toBe('failed');
    expect(d.attempts.at(-1)).toMatchObject({ outcome: 'failed' });
    expect(d.attempts.at(-1)!.detail).toMatch(/channel_not_found/);
    expect(await attemptRow(job.attemptId)).toMatchObject({ status: 'failed', error_code: 'channel_not_found' });
    const outbox = await ds.getOutbox({} as never);
    expect(outbox.groups.find((g) => g.group === 'failed')!.items.map((i) => i.draft.id)).toContain(r.draft.id);

    const again = await dispatch(r.draft.id, 'send');
    expect(again.r.draft.status).toBe('sending');
    const ok = await runOutboxJob(await jobFor(r.draft.id), port(), new OutboxGateway(fake), { now: () => now });
    expect(ok).toMatchObject({ state: 'delivered', readback: 'confirmed' });
    expect(fake.writes()).toHaveLength(2);
  });

  it('the job refuses to deliver when the draft changed after the confirm (no tool call)', async () => {
    const fake = new FakeMcp();
    const { r } = await dispatch(T('dr_onepager'), 'send');
    await withChangeSet({ db: handle.db, userId, actor: actors.system('test.tamper'), reason: 'tamper' }, async (tx) => {
      await tx.execute(sql`update drafts set content_hash = 'tampered', approved_content_hash = null where id = ${r.draft.id}`);
    });
    const out = await runOutboxJob(await jobFor(r.draft.id), port(), new OutboxGateway(fake), { now: () => now });
    expect(out).toMatchObject({ state: 'failed', code: 'not_confirmed' });
    expect(fake.calls).toHaveLength(0);
    expect((await ds.getDraft({ params: { id: r.draft.id } })).status).toBe('failed');
  });

  it('dry-run switched back on before the job runs: dry-run delivered, nothing called, back to pending approval', async () => {
    const fake = new FakeMcp();
    const { r } = await dispatch(T('dr_nudge_globex'), 'send');
    await setDryRun(true);
    const out = await runOutboxJob(await jobFor(r.draft.id), port(), new OutboxGateway(fake), { now: () => now });
    expect(out).toMatchObject({ state: 'dry_run_delivered' });
    expect(fake.calls).toHaveLength(0);
    const d = await ds.getDraft({ params: { id: r.draft.id } });
    expect(d.status).toBe('ready');
    expect(d.attempts.at(-1)).toMatchObject({ outcome: 'rendered', dryRun: true });
    await setDryRun(false);
  });

  it('B3: one attempt only; "write started" is committed before the write; a run that finds it never writes again', async () => {
    const { r } = await dispatch(T('dr_nce'), 'send');
    const job = await jobFor(r.draft.id);
    const j = await handle.db.execute<{ max_attempts: number }>(sql`select max_attempts from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${r.draft.id} order by id desc limit 1`);
    expect(j.rows[0]!.max_attempts).toBe(1);
    // the worker dies between the write and its record: the write lands, the save never happens
    let seen: string | null = null;
    const first = new FakeMcp();
    const sent = first.on('slack_send_message', async () => {
      seen = (await attemptRow(job.attemptId)).status;
      return { text: JSON.stringify({ ok: true, ts: '1730800000.900001' }) };
    });
    const p0 = port();
    const dying = { ...p0, save: async (pl: OutboxJobPayload, rec: Parameters<typeof p0.save>[1]) => (rec.state === 'delivered' || rec.state === 'failed' ? Promise.reject(new Error('worker killed')) : p0.save(pl, rec)) };
    await expect(runOutboxJob(job, dying, new OutboxGateway(sent), { now: () => now })).rejects.toThrow(/worker killed/);
    expect(seen).toBe('started'); // durable before the write left
    expect((await ds.getDraft({ params: { id: r.draft.id } })).status).toBe('sending');
    // the run again (a restart): no second write, the outcome is unknown
    const again = new FakeMcp();
    expect(await runOutboxJob(job, port(), new OutboxGateway(again), { now: () => now })).toMatchObject({ state: 'failed', code: 'outcome_unknown', recovered: true });
    expect(again.calls).toHaveLength(0);
    expect(first.writes()).toHaveLength(1); // sent once, never twice
    const d = await ds.getDraft({ params: { id: r.draft.id } });
    expect(d.status).toBe('failed');
    expect(d.attempts.at(-1)).toMatchObject({ outcome: 'unconfirmed' });
    expect(d.attempts.at(-1)!.detail).toMatch(/may have been created\. Check Slack before you try again/);
    expect(d.attempts.at(-1)!.detail).not.toMatch(/Nothing was sent/);
    expect(await attemptRow(job.attemptId)).toMatchObject({ status: 'unknown', error_code: 'outcome_unknown' });
  });

  it('B3: the reaper never requeues an Outbox job; the handed-back run never writes (nothing had started: "nothing was sent")', async () => {
    const { reapExpiredLeases } = await import('../../../src/jobs/queue-ops');
    const { r } = await dispatch(T('dr_failed_globex'), 'send');
    const job = await jobFor(r.draft.id);
    await handle.db.execute(sql`update jobs set status = 'running', attempts = 0, max_attempts = 5, locked_by = 'w-dead', lease_expires_at = now() - interval '1 minute' where kind = 'outbox.dispatch' and payload->>'draftId' = ${r.draft.id}`);
    const reaped = await reapExpiredLeases(handle.db);
    expect(reaped.outbox.map((x) => x.payload.draftId)).toContain(r.draft.id);
    const st = await handle.db.execute<{ status: string; dead_reason: string }>(sql`select status, dead_reason from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${r.draft.id}`);
    expect(st.rows[0]).toMatchObject({ status: 'dead', dead_reason: expect.stringMatching(/never re-runs on its own/) });
    const fake = new FakeMcp();
    const out = await runOutboxJob(job, port(), new OutboxGateway(fake), { now: () => now, recoverOnly: true });
    expect(out).toMatchObject({ state: 'failed', code: 'interrupted' });
    expect(fake.calls).toHaveLength(0);
    const d = await ds.getDraft({ params: { id: r.draft.id } });
    expect(d.status).toBe('failed');
    expect(d.attempts.at(-1)!.detail).toMatch(/nothing was sent/i);
    // Health ▸ Retry never re-runs a delivery
    const jobs = await ds.getJobs({} as never);
    const dead = jobs.jobs.find((x) => x.type === 'outbox.dispatch' && x.status === 'dead');
    if (dead) await expect(ds.retryJob({ params: { id: dead.id }, body: {} } as never)).rejects.toThrow(/never re-run from Health/);
  });

  it('wired with the build’s live transport, delivery fails closed: Outbox error, nothing leaves', async () => {
    const { r } = await dispatch(T('dr_priya'), 'send');
    const job = await handle.db.execute<{ id: string; payload: Record<string, unknown> }>(sql`select id, payload from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${r.draft.id} order by id desc limit 1`);
    const handler = outboxDispatchHandler({ port: () => port(), gateway: new OutboxGateway(liveOutboxTransport()) });
    const ctrl = new AbortController();
    const out = await handler({ job: { id: Number(job.rows[0]!.id), payload: job.rows[0]!.payload } as never, signal: ctrl.signal, db: handle.db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({ id: 0, inserted: false }), services: undefined });
    expect(out).toMatchObject({ state: 'failed', code: 'live_disabled' });
    const d: Draft = await ds.getDraft({ params: { id: r.draft.id } });
    expect(d.status).toBe('failed');
    await setDryRun(true);
  });
});

describe.runIf(PG)('db: Log to Slackbot (D-47)', () => {
  it('a logged row never re-logs: chat edits its opp and status → the canvas is applied → synced_to_canvas → the next batch is empty', async () => {
    const hooli = T('ac_wed_hooli'); // needs input until the chat edit gives it an opp, a type and approval
    const later = new DbDataSource({ handle, userId, clock: { now: () => new Date(now.getTime() + 7 * 86_400_000) } });
    try {
      const s0 = await later.getSettings({} as never);
      // the work-order canvas link (Settings ▸ Time) is the canvas link the app knows: its workspace and team
      await later.patchSettings({ params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { logging: { ...s0.time.logging, org62RecordTypeId: '012XX0000000RTYAAA', workOrderCanvasUrl: 'https://example.slack.com/docs/T0PLACE/F0WORKORDER1' } } } } as never);
      await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, async (tx) => {
        await tx.execute(sql`insert into person_identities (owner_user_id, person_id, system, external_id, method)
                             select ${userId}, u.person_id, 'org62_user', '005XX0000000OWNAAA', 'user' from users u where u.id = ${userId}
                             and not exists (select 1 from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user')`);
      });
      const host = createChatHost(later, later.be6.backend(), () => new Date(now.getTime() + 7 * 86_400_000));
      const threadId = (await later.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id;
      const preview = await host.previewChanges([{ op: 'edit_activities', entryIds: [hooli], patch: { oppId: T('opp_acme_af'), status: 'approved', taskType: 'Solution Design' } }], threadId);
      expect(preview.errors).toEqual([]);
      const p = await host.stageChanges({ threadId, messageId: crypto.randomUUID(), changes: preview.changes, lines: preview.lines, entity: preview.entity, reason: 'Log it on the ACME opp?' });
      await later.applyProposal({ params: { id: p.id }, body: {} } as never);
      const m1 = await later.model();
      expect(m1.get('activity', hooli)).toMatchObject({ status: 'approved', oppId: T('opp_acme_af') });
      expect(m1.get('activity', hooli)!.userLockedFields).toContain('oppId');
      expect(m1.get('activity', hooli)!.userLockedFields).not.toContain('status');
      // an older edit's lock on status (before the fix) must not hold the row either; and give it a real WhatId
      await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, async (tx) => {
        await tx.execute(sql`update activity_entries set what_org62_id = '006XX0000000OPPBBB', user_locked_fields = array['status', 'opportunity_id'] where id = ${hooli}::uuid`);
      });

      // only hooli's day: the seed's opps carry Org62 ids (D-63), so other approved rows are complete too, and the
      // next test stages those itself
      const day = (await later.model()).get('activity', hooli)!.date;
      const staged = await later.stageLogBatch({ body: { from: day, to: day } } as never);
      const ids = staged.entity.draftIds;
      expect(ids.length).toBeGreaterThan(0);
      await setDryRun(false);
      let created = '';
      const fake = new FakeMcp()
        // Slack answers with the canvas id only: the link is built from the known canvas link
        .on('slack_create_canvas', (call) => ((created = String(call.args.content)), { text: JSON.stringify({ ok: true, canvas_id: 'F0PLACEHOLDR' }) }))
        .on('slack_read_canvas', () => ({ text: created }));
      for (const d of ids) {
        const pv = await later.previewDraft({ params: { id: d }, body: { mode: 'send' } });
        const r = await later.dispatchDraft({ params: { id: d }, body: { ifVersion: pv.version, mode: 'send', confirmToken: pv.confirmToken } });
        expect(await runOutboxJob(await jobFor(r.draft.id), port(), new OutboxGateway(fake), { now: () => now })).toMatchObject({ state: 'delivered' });
      }
      const m2 = await later.model();
      expect(m2.get('activity', hooli)!.status).toBe('synced_to_canvas');
      expect(m2.get('activity', hooli)!.userLockedFields).not.toContain('status');
      const [{ n }] = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from change_proposals where entity_id = ${hooli}::uuid and field = 'status' and status = 'pending'`)).rows as [{ n: number }];
      expect(n).toBe(0);
      const canvas = ids.map((d) => m2.get('drafts', d)!).find((d) => d.destination.kind === 'action' && canvasInputOf(d.destination).eventIds.includes(hooli))!;
      expect(canvas).toMatchObject({ status: 'verified', resultUrl: 'https://example.slack.com/docs/T0PLACE/F0PLACEHOLDR' });

      const next = await later.stageLogBatch({ body: { from: day, to: day } } as never);
      expect(next.entity.draftIds).toEqual([]);
      expect(next.entity.waiting.rows).toBe(0);
      // a row the canvas already handed off (synced_to_canvas_at set) is skipped even if its status reads approved
      await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'old bug state' }, async (tx) => {
        await tx.execute(sql`update activity_entries set status = 'approved' where id = ${hooli}::uuid`);
      });
      const b = await buildLogBatch(handle.db, userId, { now: new Date(now.getTime() + 7 * 86_400_000), timezone: 'America/Los_Angeles', recordTypeId: '012XX0000000RTYAAA', approveComplete: true, held: NO_HOLDS });
      expect(b.canvases.flatMap((c) => c.eventIds)).not.toContain(hooli);
      await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'restore' }, async (tx) => {
        await tx.execute(sql`update activity_entries set status = 'synced_to_canvas' where id = ${hooli}::uuid`);
      });
    } finally {
      await setDryRun(true);
      await later.dispose();
    }
  });

  it('2026-11-13 B2: the review before Apply on Postgres: edit an Event and a DC (kept on their records), remove a row, Undo', async () => {
    const acme = T('ac_thu_acme'); // a demo that has ended by the later clock
    const umb = T('opp_umbrella_af');
    await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, async (tx) => {
      await tx.execute(sql`update activity_entries set status = 'approved', approved_at = now(), what_org62_id = '006XX0000000OPPCCC' where id = ${acme}::uuid`);
      await tx.execute(sql`update opportunities set org62_opportunity_id = '006XX0000000UMBAAA' where id = ${umb}::uuid`);
      await tx.execute(sql`insert into person_identities (owner_user_id, person_id, system, external_id, method)
                           select ${userId}, u.person_id, 'org62_user', '005XX0000000OWNAAA', 'user' from users u where u.id = ${userId}
                           and not exists (select 1 from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user')`);
    });
    const s0 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { logging: { ...s0.time.logging, org62RecordTypeId: '012XX0000000RTYAAA' } } } } as never);
    const later = new DbDataSource({ handle, userId, clock: { now: () => new Date(now.getTime() + 7 * 86_400_000) } });
    try {
      const dc = await later.createDcRequest({ body: { opp: umb, split: 100, comment: 'Built the POC with the customer team' } } as never);
      const day = (await later.model()).get('activity', acme)!.date;
      const staged = await later.stageLogBatch({ body: { from: day, to: day } } as never);
      expect(staged.entity.draftIds).toHaveLength(1);
      const id = staged.entity.draftIds[0]!;
      const review = await later.getCanvasReview({ params: { id } } as never);
      expect(routes_ok('getCanvasReview', review)).toBe(true);
      const ev = review.events.find((e) => e.entryId === acme)!;
      expect(ev).toMatchObject({ taskType: 'Demo', hours: 1, whatId: '006XX0000000OPPCCC' });
      const dcRow = review.dcs.find((d) => d.requestId === dc.entity.id)!;
      expect(dcRow).toMatchObject({ kind: 'add', split: 100 });

      const pv = await later.previewDraft({ params: { id }, body: { mode: 'send' } });
      const e1 = await later.editCanvasRow({ params: { id }, body: { ifVersion: review.version, key: ev.key, event: { entryVersion: ev.entry!.version, durationH: 1.5, note: 'Demoed the agent to the team. Next step: pilot scope' } } } as never);
      expect(e1.entity.events.find((e) => e.key === ev.key)).toMatchObject({ hours: 1.5, note: 'Demoed the agent to the team. Next step: pilot scope' });
      const row = (await later.model()).get('activity', acme)!;
      expect(row).toMatchObject({ durationH: 1.5, logNote: 'Demoed the agent to the team. Next step: pilot scope' });
      expect((await later.getActivityLog({ query: {} } as never)).entries.find((e) => e.id === acme)?.canvasDraftId).toBe(id); // still on this canvas
      // the confirm made before the edit no longer applies
      await expect(later.dispatchDraft({ params: { id }, body: { ifVersion: pv.version, mode: 'send', confirmToken: pv.confirmToken } })).rejects.toThrow();

      const e2 = await later.editCanvasRow({ params: { id }, body: { ifVersion: e1.entity.version, key: dcRow.key, dc: { split: 50 } } } as never);
      expect(e2.entity.dcs.find((d) => d.requestId === dc.entity.id)).toMatchObject({ split: 50 });
      expect((await later.listDcRequests({} as never)).requests.find((x) => x.id === dc.entity.id)).toMatchObject({ splitPercent: 50, stage: 'in_canvas' });

      const rm = await later.removeCanvasRows({ params: { id }, body: { ifVersion: e2.entity.version, keys: [e2.entity.dcs[0]!.key] } } as never);
      expect(rm.entity.dcs).toEqual([]);
      expect((await later.listDcRequests({} as never)).requests.find((x) => x.id === dc.entity.id)?.stage).toBe('waiting');
      await later.undoAudit({ params: { id: rm.auditId! }, body: {} } as never);
      expect((await later.getCanvasReview({ params: { id } } as never)).dcs).toHaveLength(1);
      await later.rejectDraft({ params: { id }, body: {} } as never);
    } finally {
      await later.dispose();
    }
  });

  it('stages one ready canvas item per work order, Undo puts it all back, and a live Apply hands the rows off', async () => {
    const sow = T('ac_tue_sow'); // approved, ended
    const nce = T('ac_wed_nce'); // proposed, complete once it has a WhatId
    await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'setup' }, async (tx) => {
      await tx.execute(sql`update activity_entries set what_org62_id = '006XX0000000OPPAAA' where id in (${sow}::uuid, ${nce}::uuid)`);
      await tx.execute(sql`insert into person_identities (owner_user_id, person_id, system, external_id, method)
                           select ${userId}, u.person_id, 'org62_user', '005XX0000000OWNAAA', 'user' from users u where u.id = ${userId}
                           and not exists (select 1 from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user')`);
    });
    const s0 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { logging: { ...s0.time.logging, org62RecordTypeId: '012XX0000000RTYAAA' } } } } as never);

    const later = new DbDataSource({ handle, userId, clock: { now: () => new Date(now.getTime() + 7 * 86_400_000) } });
    try {
      // only the two rows' days: the seed's opps carry Org62 ids since D-63, so rows on other days are complete too
      const m0 = await later.model();
      const days = [m0.get('activity', sow)!.date, m0.get('activity', nce)!.date].sort();
      const range = { from: days[0]!, to: days[1]! };
      const staged = await later.stageLogBatch({ body: { includeProposed: true, ...range } } as never);
      expect(staged.entity.draftIds.length).toBe(1);
      expect(staged.entity.approved).toBeGreaterThanOrEqual(1);
      const m1 = await later.model();
      expect(m1.get('activity', nce)!.status).toBe('approved');
      const draft = m1.get('drafts', staged.entity.draftIds[0]!)!;
      expect(draft).toMatchObject({ status: 'ready', destination: { kind: 'action', action: 'slack_canvas.create' } });
      expect(draft.destination.kind === 'action' && draft.destination.text).toContain('RecordTypeId `012XX0000000RTYAAA`');
      const [{ channel }] = (await handle.db.execute<{ channel: string }>(sql`select channel::text from drafts where id = ${draft.id}::uuid`)).rows as [{ channel: string }];
      expect(channel).toBe('slack_canvas');

      // The staged rows are marked as waiting in that item, and a second click stages nothing new
      const log1 = await later.getActivityLog({ query: {} } as never);
      expect(log1.entries.find((e) => e.id === sow)?.canvasDraftId).toBe(draft.id);
      expect(log1.entries.find((e) => e.id === nce)?.canvasDraftId).toBe(draft.id);
      const twice = await later.stageLogBatch({ body: { includeProposed: true, ...range } } as never);
      expect(twice.entity.draftIds).toEqual([]);
      expect(twice.entity.waiting).toMatchObject({ rows: staged.entity.events, draftIds: [draft.id] });
      const preview = await createChatHost(later, later.be6.backend(), () => new Date(now.getTime() + 7 * 86_400_000)).logBatch({ includeProposed: true, ...range });
      expect(preview.events).toBe(0);
      expect(preview.waiting).toMatchObject({ rows: staged.entity.events, draftIds: [draft.id] });

      // Undo the staging: the proposed row is proposed again and the item is gone
      await later.undoAudit({ params: { id: staged.auditId! }, body: {} } as never);
      const m2 = await later.model();
      expect(m2.get('activity', nce)!.status).toBe('proposed');
      expect(m2.get('drafts', draft.id)?.status ?? 'gone').not.toBe('ready');

      // Stage again and Apply live (fake Slack): the canvas exists, so its rows are handed off
      const again = await later.stageLogBatch({ body: { includeProposed: true, ...range } } as never);
      const id = again.entity.draftIds[0]!;
      await setDryRun(false);
      const p = await later.previewDraft({ params: { id }, body: { mode: 'send' } });
      const r = await later.dispatchDraft({ params: { id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
      let created = '';
      const fake = new FakeMcp()
        .on('slack_create_canvas', (call) => ((created = String(call.args.content)), { text: JSON.stringify({ ok: true, canvas_id: 'F0PLACEHOLD9', canvas_url: 'https://example.slack.com/docs/T0PLACE/F0PLACEHOLD9' }) }))
        .on('slack_read_canvas', () => ({ text: created }));
      const out = await runOutboxJob(await jobFor(r.draft.id), port(), new OutboxGateway(fake), { now: () => now });
      expect(out).toMatchObject({ state: 'delivered', readback: 'confirmed' });
      expect(fake.calls.map((c) => c.tool)).toEqual(['slack_create_canvas', 'slack_read_canvas']);
      const m3 = await later.model();
      expect(m3.get('activity', sow)!.status).toBe('synced_to_canvas');
      expect(m3.get('activity', nce)!.status).toBe('synced_to_canvas');
      // the item is sent: nothing is held any more
      const log3 = await later.getActivityLog({ query: {} } as never);
      expect(log3.entries.find((e) => e.id === sow)?.canvasDraftId).toBeUndefined();

      // the result keeps its link: on the draft, in the canvases table and in Time's receipts
      const CANVAS = 'https://example.slack.com/docs/T0PLACE/F0PLACEHOLD9';
      expect(await later.getDraft({ params: { id } })).toMatchObject({ status: 'verified', resultUrl: CANVAS });
      const [cv] = (await handle.db.execute<{ purpose: string; url: string | null; title: string | null; last_read_at: string | null }>(sql`select purpose::text, url, title, last_read_at from canvases where owner_user_id = ${userId} and external_id = 'F0PLACEHOLD9'`)).rows;
      expect(cv).toMatchObject({ purpose: 'slackbot_work_order', url: CANVAS, title: m3.get('drafts', id)!.destination.kind === 'action' ? (m3.get('drafts', id)!.destination as { target: { label: string } }).target.label : '' });
      expect(cv!.last_read_at).not.toBeNull();
      const outbox = await later.getOutbox({} as never);
      // D-75: never on the Outbox page; the payload's applied list (the assistant's) keeps the link
      expect(outbox.groups.find((g) => g.group === 'sent')!.items.map((i) => i.draft.id)).not.toContain(id);
      expect(outbox.admin.applied.find((i) => i.draft.id === id)?.draft.resultUrl).toBe(CANVAS);
      expect(outbox.admin.items.map((i) => i.draft.id)).not.toContain(id);
      const week = await later.getTime({ query: {} } as never);
      expect(week.logCanvases.find((c) => c.draftId === id)).toMatchObject({ state: 'verified', url: CANVAS, rows: again.entity.events, org62: { waiting: again.entity.events, logged: 0, missing: 0 } });
    } finally {
      await setDryRun(true);
      await later.dispose();
    }
  });
});
