/**
 * D-70 landings against Postgres 17 (record_landings, landing_writes, use_cases; migration 0025), through the db
 * DataSource as the user would use it: the first read backfills; a staged batch writes one landing_writes row per
 * canvas row in its own transaction (Events, the VDP use case); Remove keeps the write as removed; reject rejects the
 * rest; an undone batch's writes are removed; the re-derive's Event update is proposed, approved, rides the next
 * canvas's UPDATE table as "update · Duration 2 h → 3 h", and Apply makes it sent; the Org62 read-back makes the use
 * case "Org62 ✓ · VDP ✓" with the same app id; Leave it out of Org62; every sync is idempotent.
 *
 * Own database: control_center_land_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder fixtures only;
 * nothing is sent anywhere (the lookup is a fake, no canvas is ever delivered).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, freshDb, pgAvailable } from '../../support/pg';

import { routes, type Seed } from '../../../src/contract';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../../src/connectors/vdp/parse';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { enqueueJob } from '../../../src/db/queue';
import { ORG62_READBACK_JOB, runOrg62Readback } from '../../../src/jobs/handlers/org62-readback';
import type { JobContext } from '../../../src/jobs/types';
import { syncLandings } from '../../../src/lib/landings/sync';
import type { VdpSnapshot } from '../../../src/lib/vdp/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { loadModel } from '../../../src/server/datasource/db/model';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { loadEventIds, loadLandingStore, loadLandingWorld } from '../../../src/server/datasource/db/store/landings';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import type { OneLookupResult, runOneReadLookup } from '../../../src/server/onboarding/identity';
import { fixture } from '../../vdp/helpers';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_land_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_VDP_DB !== '0';

const ME = '005XX0000000OWNAAA';
const OPP = '006PLACEHOLDER0XYZ';
const ACC = '001PLACEHOLDER0XYZ';
const UC1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const REC_MINE = 'a1XXX0000000UCMAAA';
const DC_ID = 'a0XXX0000000DCUAAA';
const EVT = '00UXX0000000EVTAAA';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let acme: VdpSnapshot;
let rowId: string;
let verifiedId: string;

function ctxFor(id: number, at: Date): JobContext {
  return { job: { id, ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, attempts: 1, maxAttempts: 1, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db: handle.db, userId, clock: () => at, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}

const ucRow = (o: Record<string, unknown>) => ({ attributes: { type: 'Use_Case__c' }, Name: 'UC-000001', Opportunity__c: OPP, Account__c: ACC, Product__c: 'Data Cloud', Stage__c: 'U01 - Not Started', Go_Live_Date__c: null, CreatedDate: '2026-11-01T10:00:00.000+0000', SystemModstamp: '2026-11-01T10:00:00.000+0000', ...o });

async function readBack(rows: () => unknown[] | null, at: Date) {
  const lookup = (async (look) => {
    const q = String(look.args.q);
    const r = q.includes('FROM Use_Case__c') ? rows() : null;
    const res: OneLookupResult = { text: r ? JSON.stringify({ totalSize: r.length, done: true, records: r }) : null, code: r ? 'ok' : 'mcp_failed', message: '', costUsd: 0.001, inputTokens: 50, outputTokens: 2, model: 'claude-haiku-5-5', started: true };
    return res;
  }) as typeof runOneReadLookup;
  const job = (await enqueueJob(handle.db, { ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, maxAttempts: 1 })).id;
  return runOrg62Readback(ctxFor(job, at), { lookup, live: true });
}

const ucLanding = async () => (await ds.getUseCaseLandings({} as never)).items.find((x) => x.vdpUseCaseId === UC1)!;
const count = async (table: string) => Number((await handle.db.execute<{ n: string }>(sql.raw(`select count(*) as n from ${table}`))).rows[0]!.n);

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_land_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'landings-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  mock.dispose();
  userId = res.userId;
  ds = new DbDataSource({ handle, url: URL_, userId, clock: { now: () => now }, ranker: interimRanker });
  // the use-case fixture (tests/db/vdp/use-cases-db.test.ts): one open opp of mine with my 100% DC and placeholder Org62
  // ids, my Org62 user id, one ended approved row with a WhatId; plus one verified row with an Org62 Event
  const r = await handle.db.execute<{ id: string; account_id: string }>(sql`
    select o.id, o.account_id from opportunities o where o.owner_user_id = ${userId} and not o.is_closed and o.on_my_team and o.account_id is not null order by o.created_at limit 1`);
  const opp = r.rows[0]!;
  await withChangeSet({ db: handle.db, userId, actor: actors.system('landings-test'), reason: 'test fixture: placeholder Org62 ids' }, async (tx) => {
    await tx.execute(sql`update opportunities set org62_opportunity_id = ${OPP} where id = ${opp.id}`);
    await tx.execute(sql`update accounts set org62_account_id = ${ACC} where id = ${opp.account_id}`);
    await tx.execute(sql`insert into person_identities (owner_user_id, person_id, system, external_id, method)
                         select ${userId}, u.person_id, 'org62_user', ${ME}, 'user' from users u where u.id = ${userId}
                         and not exists (select 1 from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user')`);
    await tx.execute(sql`delete from deal_contributions where owner_user_id = ${userId} and opportunity_id = ${opp.id}`);
    await tx.execute(sql`insert into deal_contributions (owner_user_id, org62_dc_id, opportunity_id, is_mine, role, split_percent) values (${userId}, ${DC_ID}, ${opp.id}, true, 'AI + Data Architect', 100)`);
    const a = await tx.execute<{ id: string }>(sql`update activity_entries set what_org62_id = ${OPP}
                          where id = (select a.id from activity_entries a where a.owner_user_id = ${userId} and a.status = 'approved' and a.se_task_type_id is not null
                                       and a.ends_at <= ${now.toISOString()}::timestamptz and a.synced_to_canvas_at is null order by a.starts_at limit 1) returning id`);
    rowId = a.rows[0]!.id;
  });
  const v = await handle.db.execute<{ id: string }>(sql`select id from activity_entries where owner_user_id = ${userId} and status = 'verified' order by starts_at limit 1`);
  verifiedId = v.rows[0]!.id;
  const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
  acme = { ...withUseCaseDetail(parseGetVdp(fixture('get_vdp_acme'))!, details), salesforceOpportunityId: OPP.slice(0, 15), salesforceOpportunityIds: [OPP.slice(0, 15)], salesforceAccountId: ACC.slice(0, 15) };
  await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: now.toISOString() });
  const s0 = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { logging: { ...s0.time.logging, approveComplete: false, org62RecordTypeId: '012XX0000000RTYAAA' } } } } as never);
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
});

describe.runIf(PG)('D-70 landings (db)', () => {
  it('the first read backfills: the verified rows get a verified Org62 landing, the VDP use case a VDP one; a second sync changes nothing', async () => {
    await readBack(() => [], now);
    const v = await ucLanding();
    expect(routes.getUseCaseLandings.response.safeParse(await ds.getUseCaseLandings({} as never)).success).toBe(true);
    expect([v.where, v.org62?.state, v.vdp?.state, v.ready]).toEqual(['vdp', 'not_sent', 'verified', true]);
    const rl = await ds.getRecordLandings({ query: { kind: 'activity_event', id: verifiedId } } as never);
    expect(rl.landings.map((l) => [l.destination, l.state])).toEqual([['org62', 'verified']]);
    const model = await loadModel(handle.db, userId, now);
    const again = syncLandings(await loadLandingStore(handle.db, userId), await loadLandingWorld(handle.db, userId, model, now), { newId: () => crypto.randomUUID() });
    expect(again.changes).toEqual({ landings: { insert: [], update: [], remove: [] }, writes: { insert: [], update: [] }, useCases: { insert: [], update: [], remove: [] } });
  });

  it('a staged batch writes one landing_writes row per canvas row, in its transaction; Remove keeps the write as removed', async () => {
    const staged = await ds.stageLogBatch({ body: {} } as never);
    const draftId = staged.entity.draftIds[0]!;
    const ucs = staged.entity.useCases.rows;
    expect(ucs).toBeGreaterThanOrEqual(1);
    const w = await ds.getCanvasWrites({ params: { id: draftId } } as never);
    expect(routes.getCanvasWrites.response.safeParse(w).success).toBe(true);
    const events = w.writes.filter((x) => x.recordKind === 'activity_event');
    const useCases = w.writes.filter((x) => x.recordKind === 'use_case');
    expect(events.map((x) => [x.recordId, x.op, x.state, x.origin])).toEqual([[rowId, 'create', 'staged', 'canvas']]);
    expect(useCases.map((x) => [x.op, x.state])).toEqual(Array.from({ length: ucs }, () => ['create', 'staged']));
    expect(useCases.map((x) => x.fields.find((f) => f.field === 'Use_Case_Name__c')?.after)).toContain('Unified customer profile');
    expect((await ucLanding()).org62?.state).toBe('staged');
    // take UC1 off the canvas before Apply: its write stays, removed; the use case is ready again
    const review = await ds.getCanvasReview({ params: { id: draftId } } as never);
    const key = review.useCases.find((x) => x.vdpUseCaseId === UC1)!.key;
    await ds.removeCanvasRows({ params: { id: draftId }, body: { ifVersion: review.version, keys: [key] } } as never);
    const after = await ds.getCanvasWrites({ params: { id: draftId } } as never);
    const uc1 = (await ucLanding()).id;
    expect(after.writes.find((x) => x.recordId === uc1)?.state).toBe('removed');
    expect(after.writes.find((x) => x.recordId === rowId)?.state).toBe('staged');
    expect(after.counts).toEqual({ create: ucs, update: 0, delete: 0, removed: 1 });
    expect(await ucLanding()).toMatchObject({ ready: true, org62: { state: 'not_sent' } });
    // reject: the rest is rejected, the rows go back to waiting
    await ds.rejectDraft({ params: { id: draftId }, body: {} } as never);
    const rej = await ds.getCanvasWrites({ params: { id: draftId } } as never);
    expect(rej.writes.filter((x) => x.recordId !== uc1).every((x) => x.state === 'rejected')).toBe(true);
    expect(rej.writes.find((x) => x.recordId === uc1)?.state).toBe('removed');
  });

  it('use cases log on their own (D-70): only the ticked use case goes; an undone batch is removed', async () => {
    const staged = await ds.stageLogBatch({ body: { useCases: [`uc:${UC1}`] } } as never);
    expect(staged.entity).toMatchObject({ events: 0, useCases: { rows: 1, later: 0 } });
    const draftId = staged.entity.draftIds[0]!;
    expect((await ds.getCanvasWrites({ params: { id: draftId } } as never)).writes.map((x) => [x.recordKind, x.state])).toEqual([['use_case', 'staged']]);
    await ds.undoAudit({ params: { id: staged.auditId! } } as never);
    const gone = await ds.getCanvasWrites({ params: { id: draftId } } as never);
    expect([gone.status, gone.writes.map((x) => x.state)]).toEqual(['gone', ['removed']]);
  });

  it('an Event update: proposed → approved → "update · Duration 2 h → 3 h" on the next canvas, sent on Apply, verified on the read', async () => {
    const known = (await loadEventIds(handle.db, userId)).get(verifiedId);
    const p = await ds.proposeEventUpdates({ body: { candidates: [{ activityEntryId: verifiedId, org62EventId: known ?? EVT, field: 'Duration__c', from: '2', to: '3', reason: 're-derived: hands-on 2 h → 3 h' }] } } as never);
    expect(p).toMatchObject({ proposed: [expect.any(String)], skipped: [] });
    const writeId = p.proposed[0]!;
    expect((await ds.getEventUpdates({} as never)).updates.map((u) => [u.summary, u.state])).toEqual([['update · Duration 2 h → 3 h', 'proposed']]);
    // approveComplete is off: a proposed update waits for your approve, like a row
    const none = await ds.stageLogBatch({ body: { updates: [writeId] } } as never);
    expect(none.entity.draftIds).toEqual([]);
    await ds.patchEventUpdate({ params: { id: writeId }, body: { action: 'approve' } } as never);
    const staged = await ds.stageLogBatch({ body: { updates: [writeId] } } as never);
    expect(staged.entity).toMatchObject({ events: 0, eventUpdates: 1 });
    const draftId = staged.entity.draftIds[0]!;
    const w = await ds.getCanvasWrites({ params: { id: draftId } } as never);
    expect(w.writes.map((x) => [x.id, x.op, x.summary, x.state, x.reason])).toEqual([[writeId, 'update', 'update · Duration 2 h → 3 h', 'staged', 're-derived: hands-on 2 h → 3 h']]);
    // Apply (the delivery marks it sent): the write is sent; the row's history reads both
    await withChangeSet({ db: handle.db, userId, actor: actors.system('landings-test'), reason: 'test: the canvas reached Slack' }, async (tx) => {
      await tx.execute(sql`update drafts set status = 'sent', approved_at = ${now.toISOString()}::timestamptz, approval_method = 'click', approved_content_hash = content_hash, sent_at = ${now.toISOString()}::timestamptz where id = ${draftId}::uuid`);
    });
    const rl = await ds.getRecordLandings({ query: { kind: 'activity_event', id: verifiedId } } as never);
    expect(rl.landings[0]!.writes.map((x) => [x.summary, x.state])).toEqual([['update · Duration 2 h → 3 h', 'sent']]);
    expect((await ds.getEventUpdates({} as never)).updates).toEqual([]);
    // the next Org62 read verifies the row again: the update is verified
    const later = new Date(now.getTime() + 2 * 3_600_000);
    await withChangeSet({ db: handle.db, userId, actor: actors.system('landings-test'), reason: 'test: the read-back verified the row' }, async (tx) => {
      await tx.execute(sql`update activity_entries set verified_at = ${later.toISOString()}::timestamptz where id = ${verifiedId}::uuid`);
    });
    const rl2 = await ds.getRecordLandings({ query: { kind: 'activity_event', id: verifiedId } } as never);
    expect(rl2.landings[0]!.writes.map((x) => x.state)).toEqual(['verified']);
  });

  it('the read-back makes the use case "Org62 ✓ · VDP ✓", the same app id; Leave it out of Org62 holds', async () => {
    const before = await ucLanding();
    await readBack(() => [ucRow({ Id: REC_MINE, OwnerId: ME, CreatedById: ME, Use_Case_Name__c: 'Unified customer profile', Stage__c: 'U03 - Scoping', Go_Live_Date__c: '2027-01-15' })], new Date(now.getTime() + 3_600_000));
    const v = await ucLanding();
    expect([v.id, v.where, v.org62?.state, v.org62?.externalId]).toEqual([before.id, 'both', 'verified', REC_MINE]);
    expect(await count('use_cases')).toBeGreaterThanOrEqual(1);
    // the second use case of the fixture, left out of Org62
    const other = (await ds.getUseCaseLandings({} as never)).items.find((x) => x.vdpUseCaseId !== UC1)!;
    const left = await ds.fixUseCase({ params: { key: other.key }, body: { leave: true } } as never);
    expect([left.entity.state, left.entity.ready, typeof left.auditId]).toEqual(['left', false, 'string']);
    await ds.undoAudit({ params: { id: left.auditId! } } as never);
    expect((await ds.getUseCaseLandings({} as never)).items.find((x) => x.key === other.key)!.state).not.toBe('left');
  });
});
