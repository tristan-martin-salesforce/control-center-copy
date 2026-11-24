/**
 * D-67 against Postgres 17: VDP use cases → Org62 Use_Case__c through the logging canvas.
 *
 *   read-back   one `soqlQuery` per 20 opps through the read-only lookup (Use_Case__c by Opportunity__c, nothing else),
 *               stored in org62_use_cases with the read time; an unreadable batch infers nothing
 *   plan        nothing before the first read; a record someone else owns blocks the create; mine is linked
 *   canvas      the batch carries a USE CASES table (OwnerId me); a pending canvas holds the rows; a sent one hands
 *               them off; the next read links what Slackbot created (origin app) and a VDP phase change becomes one
 *               Stage__c fix; a record that left my opps is gone, never created again
 *
 * Own database: control_center_uc_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder fixtures only;
 * nothing is sent anywhere (the lookup is a fake, the canvas is never applied).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import { routes, type Seed } from '../../../src/contract';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../../src/connectors/vdp/parse';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { enqueueJob } from '../../../src/db/queue';
import { ucRowsIn } from '../../../src/engines/activity/use-cases';
import { ORG62_READBACK_JOB, runOrg62Readback, ucReadbackSoql } from '../../../src/jobs/handlers/org62-readback';
import type { JobContext } from '../../../src/jobs/types';
import { NO_HOLDS } from '../../../src/lib/canvas/payload';
import type { VdpSnapshot } from '../../../src/lib/vdp/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import { loadOrg62UseCases, loadUseCaseSync, ucReadOppIds } from '../../../src/server/datasource/db/store/use-cases';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import type { OneLookupResult, runOneReadLookup } from '../../../src/server/onboarding/identity';
import { fixture } from '../../vdp/helpers';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_uc_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_VDP_DB !== '0';

const ME = '005XX0000000OWNAAA';
const OTHER = '005XX0000000OTHAAA';
const OPP = '006PLACEHOLDER0XYZ';
const ACC = '001PLACEHOLDER0XYZ';
const UC1 = 'aaaaaaa1-0000-4000-8000-000000000001'; // "Unified customer profile", Discovery, 2027-01-15
const UC2 = 'aaaaaaa1-0000-4000-8000-000000000002'; // "Service agent deflection"
const REC_OTHER = 'a1XXX0000000UCOAAA';
const REC_MINE = 'a1XXX0000000UCMAAA';
const REC_NEW = 'a1XXX0000000UCNAAA';
const REC_X = 'a1XXX0000000UCXAAA';
const DC_ID = 'a0XXX0000000DCUAAA';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let acme: VdpSnapshot;

function ctxFor(id: number, at: Date): JobContext {
  return { job: { id, ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, attempts: 1, maxAttempts: 1, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db: handle.db, userId, clock: () => at, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}

/** A read-only lookup that answers Use_Case__c reads with `rows` and fails every other read (so nothing else changes). */
function fakeLookup(rows: () => unknown[] | null) {
  const calls: Array<{ connector: string; tool: string; q: string }> = [];
  const fn = (async (look) => {
    const q = String(look.args.q);
    calls.push({ connector: look.connector, tool: look.tool, q });
    const r = q.includes('FROM Use_Case__c') ? rows() : null;
    const res: OneLookupResult = { text: r ? JSON.stringify({ totalSize: r.length, done: true, records: r }) : null, code: r ? 'ok' : 'mcp_failed', message: '', costUsd: 0.001, inputTokens: 50, outputTokens: 2, model: 'claude-haiku-5-5', started: true };
    return res;
  }) as typeof runOneReadLookup;
  return { fn, calls };
}

const ucRow = (o: Record<string, unknown>) => ({ attributes: { type: 'Use_Case__c' }, Name: 'UC-000001', Opportunity__c: OPP, Account__c: ACC, Product__c: 'Data Cloud', Stage__c: 'U01 - Not Started', Go_Live_Date__c: null, CreatedDate: '2026-11-01T10:00:00.000+0000', SystemModstamp: '2026-11-01T10:00:00.000+0000', ...o });

async function readBack(rows: () => unknown[] | null, at: Date) {
  const look = fakeLookup(rows);
  const job = (await enqueueJob(handle.db, { ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, maxAttempts: 1 })).id;
  const res = await runOrg62Readback(ctxFor(job, at), { lookup: look.fn, live: true });
  return { res, calls: look.calls };
}

const state = async () => Object.fromEntries((await loadUseCaseSync(handle.db, userId)).items.map((x) => [x.vdpUseCaseId, x]));

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_uc_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'uc-test' });
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
  // one open opp of mine (and its account) gets placeholder Org62 ids, my Org62 user id is known, and one ended,
  // approved Time row has a WhatId and a task type, so a batch has a canvas for the use cases to ride on
  const r = await handle.db.execute<{ id: string; account_id: string }>(sql`
    select o.id, o.account_id from opportunities o where o.owner_user_id = ${userId} and not o.is_closed and o.on_my_team and o.account_id is not null order by o.created_at limit 1`);
  const row = r.rows[0]!;
  await withChangeSet({ db: handle.db, userId, actor: actors.system('uc-test'), reason: 'test fixture: placeholder Org62 ids' }, async (tx) => {
    await tx.execute(sql`update opportunities set org62_opportunity_id = ${OPP} where id = ${row.id}`);
    await tx.execute(sql`update accounts set org62_account_id = ${ACC} where id = ${row.account_id}`);
    await tx.execute(sql`insert into person_identities (owner_user_id, person_id, system, external_id, method)
                         select ${userId}, u.person_id, 'org62_user', ${ME}, 'user' from users u where u.id = ${userId}
                         and not exists (select 1 from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user')`);
    // D-63: a use case goes only on an open opp with my 100% DC
    await tx.execute(sql`delete from deal_contributions where owner_user_id = ${userId} and opportunity_id = ${row.id}`);
    await tx.execute(sql`insert into deal_contributions (owner_user_id, org62_dc_id, opportunity_id, is_mine, role, split_percent) values (${userId}, ${DC_ID}, ${row.id}, true, 'AI + Data Architect', 100)`);
    await tx.execute(sql`update activity_entries set what_org62_id = ${OPP}
                          where id = (select a.id from activity_entries a where a.owner_user_id = ${userId} and a.status = 'approved' and a.se_task_type_id is not null
                                       and a.ends_at <= ${now.toISOString()}::timestamptz and a.synced_to_canvas_at is null order by a.starts_at limit 1)`);
  });
  const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
  acme = { ...withUseCaseDetail(parseGetVdp(fixture('get_vdp_acme'))!, details), salesforceOpportunityId: OPP.slice(0, 15), salesforceOpportunityIds: [OPP.slice(0, 15)], salesforceAccountId: ACC.slice(0, 15) };
  await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: now.toISOString() });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

const batch = (at: Date) => buildLogBatch(handle.db, userId, { now: at, timezone: 'America/Los_Angeles', recordTypeId: '012XX0000000RTYAAA', approveComplete: false, held: NO_HOLDS });

describe.runIf(PG)('VDP use cases → Org62 Use_Case__c (db)', () => {
  it('before the first Org62 read nothing is created; getUseCaseSync says why', async () => {
    const s = await ds.getUseCaseSync({} as never);
    expect(routes.getUseCaseSync.response.safeParse(s).success).toBe(true);
    expect(s.readAt).toBeNull();
    expect(s.items.map((x) => [x.title, x.state])).toEqual([
      ['Unified customer profile', 'skipped'],
      ['Service agent deflection', 'skipped'],
    ]);
    expect(s.items[0]!.why).toMatch(/first Org62 read/);
    expect((await batch(now)).useCases).toEqual({ rows: 0, later: 0 });
  });

  it('D-63: the read-back reads only opps with my 100% DC (a 50% DC creates nothing and is not read)', async () => {
    expect(await ucReadOppIds(handle.db, userId)).toContain(OPP);
    await handle.db.execute(sql`update deal_contributions set split_percent = 50 where org62_dc_id = ${DC_ID}`);
    expect(await ucReadOppIds(handle.db, userId)).not.toContain(OPP);
    expect((await state())[UC1]!.why).toMatch(/Waiting for your 100% DC/);
    await handle.db.execute(sql`update deal_contributions set split_percent = 100 where org62_dc_id = ${DC_ID}`);
  });

  it('the read-back reads Use_Case__c by opp (read tools only); another owner’s record blocks that create', async () => {
    const { res, calls } = await readBack(() => [ucRow({ Id: REC_OTHER, OwnerId: OTHER, CreatedById: OTHER, Use_Case_Name__c: 'Service Agent Deflection', Product__c: 'Agentforce' })], now);
    expect(calls.every((c) => c.connector === 'org62' && c.tool === 'soqlQuery' && /^SELECT /.test(c.q))).toBe(true);
    const uc = calls.filter((c) => c.q.includes('FROM Use_Case__c'));
    // every open opp with my 100% DC, 20 per read
    const opps = await ucReadOppIds(handle.db, userId);
    expect(uc.map((c) => c.q)).toEqual([ucReadbackSoql(opps)]);
    expect(uc[0]!.q).toMatch(new RegExp(`^SELECT Id, Name, OwnerId, CreatedById, CreatedDate, Opportunity__c, Account__c, Use_Case_Name__c, Product__c, Stage__c, Go_Live_Date__c, SystemModstamp FROM Use_Case__c WHERE Opportunity__c IN \\(.*'${OPP}'.*\\) ORDER BY Id LIMIT 200$`));
    expect(res).toMatchObject({ useCasesRead: 1, useCasesGone: 0, useCasesLinked: 0 });
    expect(res.useCaseOpps).toBe(opps.length);
    const st = await state();
    expect(st[UC1]).toMatchObject({ state: 'create', org62OpportunityId: OPP });
    expect(st[UC2]).toMatchObject({ state: 'others', org62UseCaseId: REC_OTHER });
    const stored = await loadOrg62UseCases(handle.db, userId);
    expect(stored.readAt).toBe(now.toISOString());
    expect(stored.links).toEqual([]);
  });

  it('an unreadable batch infers nothing (the other owner’s record stays, the read time does not move)', async () => {
    const later = new Date(now.getTime() + 3_600_000);
    const { res } = await readBack(() => null, later);
    expect(res.useCasesRead).toBe(0);
    const stored = await loadOrg62UseCases(handle.db, userId);
    expect(stored.readAt).toBe(now.toISOString());
    expect(stored.records.find((r) => r.id === REC_OTHER)!.goneAt).toBeNull();
  });

  it('the batch carries one USE CASES row (OwnerId me, VDP’s mapping); a pending canvas holds it', async () => {
    const b = await batch(now);
    expect(b.useCases).toEqual({ rows: 1, later: 0 });
    const md = b.canvases.map((c) => c.markdown).find((m) => m.includes('## USE CASES TO CREATE ('))!;
    expect(md).toMatch(/create one Use_Case__c per row with OwnerId `005XX0000000OWNAAA`/);
    expect(ucRowsIn(md).creates).toEqual([{ vdpUseCaseId: UC1, opportunityId: OPP, name: 'Unified customer profile', stage: 'U03 - Scoping', goLive: '2027-01-15' }]);
    // WO-1: its own table, every column named by its Use_Case__c field
    expect(md).toMatch(/## USE CASES TO CREATE \(1 row\)\n\n\*\*USE CASES TO CREATE:\*\*/);
    expect(md).toContain('|#|Use_Case_Name__c|Opportunity__c|Account__c|Product__c|');
    expect(md).toContain(`|1|Unified customer profile|${OPP}|${ACC}|Data Cloud|`);
    expect(md).not.toContain('Service agent deflection|');

    // stage it as the user would (Time ▸ Log these): the canvas item now holds the row
    const s0 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { logging: { ...s0.time.logging, org62RecordTypeId: '012XX0000000RTYAAA' } } } } as never);
    const staged = await ds.stageLogBatch({ body: {} } as never);
    expect(staged.entity.useCases.rows).toBe(1);
    const st = await state();
    expect(st[UC1]).toMatchObject({ state: 'in_canvas', canvasDraftId: expect.any(String) });
    expect((await batch(now)).useCases.rows).toBe(0);
    const t = await ds.getTime({ query: {} } as never);
    expect(t.logCanvases.find((c) => c.draftId === st[UC1]!.canvasDraftId)?.useCases).toBe(1);
  });

  it('sent → handed off; the next read links what Slackbot created (app); a VDP phase change becomes one Stage__c fix', async () => {
    const draftId = (await state())[UC1]!.canvasDraftId!;
    const sentAt = new Date(now.getTime() + 2 * 3_600_000);
    await withChangeSet({ db: handle.db, userId, actor: actors.system('uc-test'), reason: 'test: the canvas reached Slack' }, async (tx) => {
      await tx.execute(sql`update drafts set status = 'sent', approved_at = ${sentAt.toISOString()}::timestamptz, approval_method = 'click', approved_content_hash = content_hash, sent_at = ${sentAt.toISOString()}::timestamptz, updated_at = ${new Date(sentAt.getTime() + 5 * 3_600_000).toISOString()}::timestamptz where id = ${draftId}::uuid`);
    });
    // handed off; the sent time is sent_at, not a later touch of the row (updated_at is 5 h later here)
    expect((await state())[UC1]).toMatchObject({ state: 'handed_off', canvasDraftId: draftId });

    const readAt = new Date(sentAt.getTime() + 3_600_000);
    const mine = ucRow({ Id: REC_MINE, OwnerId: ME, CreatedById: ME, Use_Case_Name__c: 'Unified customer profile', Stage__c: 'U03 - Scoping', Go_Live_Date__c: '2027-01-15', CreatedDate: new Date(sentAt.getTime() + 600_000).toISOString() });
    const other = ucRow({ Id: REC_OTHER, OwnerId: OTHER, CreatedById: OTHER, Use_Case_Name__c: 'Service Agent Deflection', Product__c: 'Agentforce' });
    const { res } = await readBack(() => [mine, other], readAt);
    expect(res).toMatchObject({ useCasesRead: 2, useCasesLinked: 1 });
    const stored = await loadOrg62UseCases(handle.db, userId);
    expect(stored.links).toEqual([{ vdpUseCaseId: UC1, org62UseCaseId: REC_MINE, origin: 'app', syncedStage: 'U03 - Scoping', syncedGoLive: '2027-01-15', syncedName: 'Unified customer profile' }]);
    expect((await state())[UC1]).toMatchObject({ state: 'in_org62', org62Url: expect.stringContaining(`/lightning/r/Use_Case__c/${REC_MINE}/view`) });

    // VDP moves the use case to Build: one Stage__c fix on my record (the other owner's record is never touched)
    const build: VdpSnapshot = { ...acme, useCases: acme.useCases.map((u) => (u.id === UC1 ? { ...u, executionPhase: 'Build' } : u)) };
    await saveVdpMirror(handle.db, userId, { snapshots: [build], complete: true, readAt: readAt.toISOString() });
    expect((await state())[UC1]).toMatchObject({ state: 'update', updates: [{ field: 'Stage__c', from: 'U03 - Scoping', to: 'U05 - Implementation' }] });
    const b = await batch(readAt);
    const md = b.canvases.map((c) => c.markdown).find((m) => m.includes('## USE CASES TO UPDATE ('))!;
    expect(ucRowsIn(md)).toEqual({ creates: [], updates: [{ recordId: REC_MINE, field: 'Stage__c', newValue: 'U05 - Implementation' }] });
    expect(md).not.toContain(REC_OTHER);
  });

  it('a record that left my opps (a complete read without it) is gone: kept, never created again, never deleted', async () => {
    const at = new Date(now.getTime() + 6 * 3_600_000);
    const { res } = await readBack(() => [], at);
    expect(res.useCasesGone).toBe(2);
    const stored = await loadOrg62UseCases(handle.db, userId);
    expect(stored.records.map((r) => [r.id, !!r.goneAt]).sort()).toEqual([
      [REC_MINE, true],
      [REC_OTHER, true],
    ]);
    const st = await state();
    expect(st[UC1]!.state).toBe('gone');
    // UC2's blocker left too: it may be created now (the other owner's record is gone from my opps)
    expect(st[UC2]!.state).toBe('create');
    const b = await batch(at);
    expect(b.canvases.flatMap((c) => ucRowsIn(c.markdown).creates.map((x) => x.vdpUseCaseId))).toEqual([UC2]);
  });

  it('Add it again (decideNeed use_case_readd): a create; the new record links and the deleted one lets go of the use case', async () => {
    expect((await state())[UC1]).toMatchObject({ state: 'gone', options: ['readd', 'leave'] });
    await ds.decideNeed({ body: { rule: 'use_case_readd', subjectIds: [`uc:${UC1}`], kind: 'not_needed', reason: 'Deleted by mistake' } } as never);
    expect((await state())[UC1]).toMatchObject({ state: 'create', decided: 'readd' });
    const at = new Date(now.getTime() + 8 * 3_600_000);
    const { res } = await readBack(() => [ucRow({ Id: REC_NEW, OwnerId: ME, CreatedById: ME, Use_Case_Name__c: 'Unified customer profile', Stage__c: 'U05 - Implementation', Go_Live_Date__c: '2027-01-15', CreatedDate: at.toISOString() })], at);
    expect(res.useCasesLinked).toBe(1);
    const links = (await loadOrg62UseCases(handle.db, userId)).links;
    expect(links.filter((l) => l.vdpUseCaseId === UC1).map((l) => l.org62UseCaseId)).toEqual([REC_NEW]);
    await ds.clearNeedDecision({ body: { rule: 'use_case_readd', subjectIds: [`uc:${UC1}`] } } as never);
    expect((await state())[UC1]!.state).toBe('in_org62');
  });

  it('Org62-only → a create_use_case item under the VDP in getVdpCoverage (never autopilot); Leave it closes both', async () => {
    const at = new Date(now.getTime() + 9 * 3_600_000);
    await readBack(() => [ucRow({ Id: REC_NEW, OwnerId: ME, CreatedById: ME, Use_Case_Name__c: 'Unified customer profile', Stage__c: 'U05 - Implementation', Go_Live_Date__c: '2027-01-15' }), ucRow({ Id: REC_X, OwnerId: OTHER, CreatedById: OTHER, Use_Case_Name__c: 'Claims triage agent', Product__c: 'Agentforce' })], at);
    expect((await ds.getUseCaseSync({} as never)).items.find((x) => x.key === `rec:${REC_X.slice(0, 15)}`)).toMatchObject({ state: 'org62_only', track: 'agentforce' });
    const cov = await ds.getVdpCoverage({} as never);
    const step = cov.vdps.find((v) => v.vdpSlug === acme.slug)!.steps.find((x) => x.apply?.key === `${acme.slug}:org62_use_case:${REC_X.slice(0, 15)}`)!;
    expect(step).toMatchObject({ kind: 'create_use_case', section: 'use_cases', policy: 'suggest' });
    expect(step.apply!.fields.find((f) => f.field === 'title')!.suggested).toBe('Claims triage agent');
    await ds.decideNeed({ body: { rule: 'use_case', subjectIds: [`rec:${REC_X.slice(0, 15)}`], kind: 'not_needed', reason: 'A teammate’s' } } as never);
    expect((await ds.getUseCaseSync({} as never)).items.find((x) => x.key === `rec:${REC_X.slice(0, 15)}`)!.state).toBe('left');
    expect((await ds.getVdpCoverage({} as never)).vdps.find((v) => v.vdpSlug === acme.slug)!.steps.some((x) => x.apply?.key?.includes(':org62_use_case:'))).toBe(false);
  });

  it('a new use case either system already has is refused (409) at draftVdpUpdate, never staged', async () => {
    await expect(ds.draftVdpUpdate({ body: { vdpSlug: acme.slug, op: 'create_use_case', field: 'title', value: 'unified customer profile' } } as never)).rejects.toThrow(/Already a use case/);
    await expect(ds.draftVdpUpdate({ body: { vdpSlug: acme.slug, op: 'create_use_case', field: 'title', value: 'Claims Triage Agent' } } as never)).rejects.toThrow(/in Org62/);
  });
});
