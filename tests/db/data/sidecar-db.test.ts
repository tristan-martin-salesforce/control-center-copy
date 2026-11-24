/**
 * D-98 (0036) on Postgres 17: the kv side-car → columns and tables, end to end.
 *   - the seed writes promoted fields to their columns (the kv keeps only what a listed reader still reads);
 *   - dual read: a legacy kv-only row reads the same, counted as a fallback (Doctor's DATA.KV.FALLBACK);
 *   - the backfill: plan (dry), copy, idempotent second run, stopped and resumed at its cursor;
 *   - need_decisions and canvas_row_overrides: routed writes, Undo, legacy fallback, backfill;
 *   - `*_id15` columns and the 15/18-character opp match;
 *   - VDP child tables from the recorded mirror fixture, mirror_reads, phase history, the blob fallback;
 *   - a Slack and a Gmail item the user Applied become landings (simulated transport: nothing is sent).
 *
 * Own database: control_center_data_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder data only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, type Seed } from '../../../src/contract';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../../src/connectors/vdp/parse';
import { actors, undoChangeSet, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { BACKFILL_FAMILIES, backfillPlan, runKvBackfill } from '../../../src/jobs/handlers/kv-backfill';
import type { VdpSnapshot } from '../../../src/lib/vdp/types';
import { checkKvFallback } from '../../../src/ops/checks/data';
import type { DoctorContext } from '../../../src/ops/checks/types';
import { OutboxGateway, parseJobPayload, runOutboxJob, SimulatedOutboxTransport } from '../../../src/outbox';
import { DbDataSource } from '../../../src/server/datasource/db';
import { loadRowOverridesTable } from '../../../src/server/datasource/db/canvas-overrides';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { loadModel } from '../../../src/server/datasource/db/model';
import { loadNeedDecisions } from '../../../src/server/datasource/db/needs-decisions';
import { dbOutboxPort } from '../../../src/server/datasource/db/outbox';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { ensureExtractor, loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { writeKv, type WriteCtx } from '../../../src/server/datasource/db/store/common';
import { engagedAccountIds, lastDcRead, rememberDcRead } from '../../../src/server/datasource/db/store/deals-sync';
import { loadMessageLandings } from '../../../src/server/datasource/db/store/landings';
import { kvFallbacks } from '../../../src/server/datasource/db/store/sidecar';
import { loadVdpRecords, saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { buildIdMap, type IdMap } from '../../../src/server/datasource/db/translate';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { ROW_OVERRIDES_KV, withRowOverride } from '../../../src/lib/canvas/overrides';
import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';
import { fixture } from '../../vdp/helpers';

const NAME = `control_center_data_${testDbSuffix}`;
const PG = pgAvailable && process.env.CC_DATA_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let extractorId: string;
let idMap: IdMap;
const T = (id: string) => idMap.get(id) ?? id;

const one = async <R extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await handle.db.execute<R>(q)).rows[0]!;
const n = async (q: ReturnType<typeof sql>) => Number((await one<{ n: string | number }>(q)).n);
const fixtureCs = <T>(fn: (tx: Parameters<Parameters<typeof withChangeSet>[1]>[0]) => Promise<T>) => withChangeSet({ db: handle.db, userId, actor: actors.system('data-test'), reason: 'test fixture: legacy side-car' }, fn);
const withDb: DoctorContext['withDb'] = async (_d, fn) => fn(async (s, p) => (await handle.pool.query(s, p as unknown[])).rows as Array<Record<string, unknown>>);
const doctor = () => checkKvFallback({ appDb: NAME, withDb } as unknown as DoctorContext);
const oppOf = async (id: string) => (await loadModel(handle.db, userId, now)).get('opps', id)!;

beforeAll(async () => {
  if (!PG) return;
  await freshDb(NAME);
  await runMigrations({ url: `postgres://localhost:5432/${NAME}`, log: () => {} });
  handle = createDb({ url: `postgres://localhost:5432/${NAME}`, max: 5, applicationName: 'data-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  mock.dispose();
  userId = res.userId;
  idMap = buildIdMap(seed);
  extractorId = await ensureExtractor(handle.db);
  ds = new DbDataSource({ handle, url: `postgres://localhost:5432/${NAME}`, userId, clock: { now: () => now }, ranker: interimRanker });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
});

describe.runIf(PG)('kv side-car → columns (D-98, 0036)', () => {
  it('the seed writes promoted fields to their columns; the kv keeps only dcAssigned (its listed readers)', async () => {
    expect(await n(sql`select count(*) as n from opportunities where owner_user_id = ${userId} and next_step is not null`)).toBeGreaterThan(0);
    expect(await n(sql`select count(*) as n from opportunities where owner_user_id = ${userId} and products is not null`)).toBeGreaterThan(0);
    expect(await n(sql`select count(*) as n from accounts where owner_user_id = ${userId} and dc_status is not null`)).toBeGreaterThan(0);
    for (const f of ['nextStep', 'products', 'ownerId', 'leftBookAt']) expect(await n(sql`select count(*) as n from user_settings where owner_user_id = ${userId} and key like 'cc.ext/opportunities/%' and value ? ${f}`)).toBe(0);
    expect(await n(sql`select count(*) as n from user_settings where owner_user_id = ${userId} and key like 'cc.ext/accounts/%' and (value ? 'dcStatus' or value ? 'org62Url')`)).toBe(0);
    // dual-write until 2.1: the column and the kv agree
    const col = await n(sql`select count(*) as n from opportunities where owner_user_id = ${userId} and dc_assigned`);
    const kv = await n(sql`select count(*) as n from user_settings where owner_user_id = ${userId} and key like 'cc.ext/opportunities/%' and (value->>'dcAssigned')::boolean`);
    expect(col).toBe(kv);
    // nothing pending, nothing read from the kv
    expect(Object.values(await backfillPlan(handle.db, userId)).every((x) => x === 0)).toBe(true);
    expect((await doctor()).status).toBe('ok');
  });

  it('dual read: a legacy kv-only opp reads the same (counted as a fallback); the backfill copies it, twice is a no-op', async () => {
    const row = await one<{ id: string }>(sql`select id::text as id from opportunities where owner_user_id = ${userId} and next_step is not null and products is not null and archived_at is null order by id limit 1`);
    const before = await oppOf(row.id);
    // as a database from before 0036 holds it: the columns empty, the values in cc.ext/opportunities/<id>
    await fixtureCs(async (tx) => {
      const x = await tx.execute<{ next_step: string; products: string[] }>(sql`select next_step, products from opportunities where id = ${row.id}::uuid`);
      const legacy = JSON.stringify({ nextStep: x.rows[0]!.next_step, products: x.rows[0]!.products });
      await tx.execute(sql`update opportunities set next_step = null, products = null where id = ${row.id}::uuid`);
      await tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}::uuid, ${`cc.ext/opportunities/${row.id}`}, ${legacy}::jsonb)
                           on conflict (owner_user_id, key) do update set value = user_settings.value || excluded.value`);
    });
    const f0 = kvFallbacks();
    expect(await oppOf(row.id)).toEqual(before);
    expect(kvFallbacks()).toBeGreaterThan(f0);
    const warn = await doctor();
    expect(warn).toMatchObject({ status: 'warn', data: { counter: 'DATA.KV.FALLBACK', pending: { 'ext:opportunities.nextStep': 1, 'ext:opportunities.products': 1 } } });
    // the plan writes nothing
    const dry = await runKvBackfill(handle.db, userId, { dry: true });
    expect(dry.pending).toMatchObject({ 'ext:opportunities.nextStep': 1, 'ext:opportunities.products': 1 });
    expect(await n(sql`select count(*) as n from opportunities where id = ${row.id}::uuid and next_step is null`)).toBe(1);
    const run = await runKvBackfill(handle.db, userId);
    expect(run).toMatchObject({ state: 'done', copied: { 'ext:opportunities.nextStep': 1, 'ext:opportunities.products': 1 } });
    expect(await n(sql`select count(*) as n from opportunities where id = ${row.id}::uuid and next_step is not null and products is not null`)).toBe(1);
    const f1 = kvFallbacks();
    expect(await oppOf(row.id)).toEqual(before);
    expect(kvFallbacks()).toBe(f1);
    expect(await runKvBackfill(handle.db, userId)).toMatchObject({ state: 'done', copied: {}, chunks: 0 });
    expect((await doctor()).status).toBe('ok');
    // the kv was never deleted (the old build still reads it after a restore)
    expect(await n(sql`select count(*) as n from user_settings where key = ${`cc.ext/opportunities/${row.id}`} and value ? 'nextStep'`)).toBe(1);
  });

  it('resumable: a run stopped after a chunk keeps its cursor, and the next run finishes from there', async () => {
    const ids = (await handle.db.execute<{ id: string }>(sql`select id::text as id from opportunities where owner_user_id = ${userId} and next_step is not null order by id limit 2`)).rows.map((r) => r.id);
    expect(ids).toHaveLength(2);
    await fixtureCs(async (tx) => {
      for (const id of ids) {
        const x = await tx.execute<{ next_step: string }>(sql`select next_step from opportunities where id = ${id}::uuid`);
        await tx.execute(sql`update opportunities set next_step = null where id = ${id}::uuid`);
        await tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}::uuid, ${`cc.ext/opportunities/${id}`}, ${JSON.stringify({ nextStep: x.rows[0]!.next_step })}::jsonb)
                             on conflict (owner_user_id, key) do update set value = user_settings.value || excluded.value`);
      }
    });
    const at = BACKFILL_FAMILIES.findIndex((f) => f.id === 'ext:opportunities.nextStep');
    // the families before it have nothing to do (one empty chunk each), then one row of this one
    const stopped = await runKvBackfill(handle.db, userId, { chunk: 1, maxChunks: at + 1 });
    expect(stopped).toMatchObject({ state: 'stopped', copied: { 'ext:opportunities.nextStep': 1 } });
    const p = await one<{ state: string; cursor: { family: string; after: string } }>(sql`select state, cursor from data_backfills where owner_user_id = ${userId} and name = '0036_sidecar_columns'`);
    expect(p).toMatchObject({ state: 'running', cursor: { family: 'ext:opportunities.nextStep', after: ids[0] } });
    expect((await backfillPlan(handle.db, userId))['ext:opportunities.nextStep']).toBe(1);
    const done = await runKvBackfill(handle.db, userId, { chunk: 1 });
    expect(done).toMatchObject({ state: 'done', copied: { 'ext:opportunities.nextStep': 1 } });
    expect(await n(sql`select count(*) as n from opportunities where id::text in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and next_step is not null`)).toBe(2);
    const fin = await one<{ state: string; counts: Record<string, number>; runs: number }>(sql`select state, counts, runs from data_backfills where owner_user_id = ${userId} and name = '0036_sidecar_columns'`);
    expect(fin.state).toBe('done');
    expect(fin.counts['ext:opportunities.nextStep']).toBeGreaterThanOrEqual(2);
  });

  it('need decisions live in need_decisions: decide → a row (no kv), list reads it, Undo removes it', async () => {
    const acc = (await one<{ id: string }>(sql`select id::text as id from accounts where owner_user_id = ${userId} and archived_at is null order by id limit 1`)).id;
    const r = await ds.decideNeed({ body: { rule: 'deals_ahead', subjectIds: [acc], kind: 'snooze', label: 'Placeholder account' } } as never);
    expect(await n(sql`select count(*) as n from need_decisions where owner_user_id = ${userId} and rule = 'deals_ahead' and subject_id = ${acc}`)).toBe(1);
    expect(await n(sql`select count(*) as n from user_settings where owner_user_id = ${userId} and key like 'cc.need/%'`)).toBe(0);
    const listed = await ds.listNeedDecisions({} as never);
    expect(routes.listNeedDecisions.response.safeParse(listed).success).toBe(true);
    expect(listed.decisions).toEqual([expect.objectContaining({ rule: 'deals_ahead', subjectId: acc, kind: 'snooze', label: 'Placeholder account' })]);
    await undoChangeSet(r.auditId!, { db: handle.db });
    expect(await n(sql`select count(*) as n from need_decisions where owner_user_id = ${userId}`)).toBe(0);
    expect((await ds.listNeedDecisions({} as never)).decisions).toEqual([]);
  });

  it('a legacy kv decision is read (fallback) until the backfill copies it into need_decisions', async () => {
    const acc = (await one<{ id: string }>(sql`select id::text as id from accounts where owner_user_id = ${userId} and archived_at is null order by id desc limit 1`)).id;
    const legacy = { rule: 'deals_chase', subjectId: acc, kind: 'not_needed', until: null, reason: 'Not my deal', label: 'Placeholder', baseline: { hours: 2 }, decidedAt: now.toISOString() };
    await fixtureCs((tx) => tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}::uuid, ${`cc.need/deals_chase/${acc}`}, ${JSON.stringify(legacy)}::jsonb)`));
    expect((await ds.listNeedDecisions({} as never)).decisions).toEqual([legacy]);
    expect(await loadNeedDecisions(handle.db, userId)).toEqual([legacy]);
    expect((await runKvBackfill(handle.db, userId)).copied).toMatchObject({ need_decisions: 1 });
    expect(await n(sql`select count(*) as n from need_decisions where owner_user_id = ${userId} and subject_id = ${acc} and reason = 'Not my deal' and baseline = '{"hours": 2}'::jsonb`)).toBe(1);
    expect((await ds.listNeedDecisions({} as never)).decisions).toEqual([legacy]);
    // clearing it goes through the table and drops the old kv copy
    await ds.clearNeedDecision({ body: { rule: 'deals_chase', subjectIds: [acc] } } as never);
    expect(await n(sql`select (select count(*) from need_decisions where owner_user_id = ${userId}) + (select count(*) from user_settings where owner_user_id = ${userId} and key like 'cc.need/%') as n`)).toBe(0);
  });

  it('canvas row overrides: the old map reads as a fallback; the routed write makes rows and drops the map', async () => {
    const at = now.toISOString();
    await fixtureCs((tx) => tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}::uuid, ${ROW_OVERRIDES_KV}, ${JSON.stringify({ 'uc:placeholder-1': { fields: { Stage__c: 'U3' }, at } })}::jsonb)`));
    const old = await loadRowOverridesTable(handle.db, userId);
    expect(old).toEqual({ 'uc:placeholder-1': { fields: { Stage__c: 'U3' }, at } });
    await withChangeSet({ db: handle.db, userId, actor: actors.user(), reason: 'canvas edit' }, async (tx, cs) => {
      const w: WriteCtx = { tx, cs, userId, me: { id: userId, name: 'me' }, now, extractorId, timezone: 'America/Denver', kv: new Map() };
      await writeKv(w, ROW_OVERRIDES_KV, withRowOverride(old, 'update:Event:00UPLACEHOLDER0:Duration__c', { newValue: '2' }, at));
    });
    expect(await n(sql`select count(*) as n from canvas_row_overrides where owner_user_id = ${userId}`)).toBe(2);
    expect(await n(sql`select count(*) as n from user_settings where owner_user_id = ${userId} and key = ${ROW_OVERRIDES_KV}`)).toBe(0);
    expect(await loadRowOverridesTable(handle.db, userId)).toEqual({ 'uc:placeholder-1': { fields: { Stage__c: 'U3' }, at }, 'update:Event:00UPLACEHOLDER0:Duration__c': { fields: { newValue: '2' }, at } });
  });

  it('Org62 ids: *_id15 are left(id, 15); a DC on the 15-character row makes the 18-character opp engaged', async () => {
    const acc = (await one<{ id: string }>(sql`select id::text as id from accounts where owner_user_id = ${userId} and archived_at is null order by id limit 1 offset 1`)).id;
    await fixtureCs(async (tx) => {
      await tx.execute(sql`insert into opportunities (owner_user_id, account_id, org62_opportunity_id, name) values (${userId}::uuid, ${acc}::uuid, '006PLACEHLDRID1XYZ', 'Placeholder 18')`);
      const twin = await tx.execute<{ id: string }>(sql`insert into opportunities (owner_user_id, org62_opportunity_id, name, is_closed) values (${userId}::uuid, '006PLACEHLDRID1', 'Placeholder 15', true) returning id::text as id`);
      await tx.execute(sql`insert into deal_contributions (owner_user_id, org62_dc_id, opportunity_id, is_mine, split_percent) values (${userId}::uuid, 'a0DPLACEHOLDER1', ${twin.rows[0]!.id}::uuid, true, 100)`);
    });
    const ids = await handle.db.execute<{ a: string; b: string }>(sql`select org62_opportunity_id15 as a, left(org62_opportunity_id, 15) as b from opportunities where owner_user_id = ${userId}`);
    expect(ids.rows.every((r) => r.a === r.b)).toBe(true);
    expect([...(await engagedAccountIds(handle.db, userId))]).toContain(acc);
    expect(await n(sql`select count(*) as n from pg_indexes where indexname in ('opportunities_owner_org62_id15_idx', 'accounts_owner_org62_id15_idx', 'org62_events_owner_event_id15_idx')`)).toBe(3);
  });
});

describe.runIf(PG)('VDP child tables and the mirror convention (D-98)', () => {
  let acme: VdpSnapshot;
  beforeAll(() => {
    const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
    acme = withUseCaseDetail(parseGetVdp(fixture('get_vdp_acme'))!, details);
  });
  const rec = async () => (await loadVdpRecords(handle.db, userId)).find((r) => r.vdpId === acme.id)!;

  it('a read writes the use cases, assets and people as rows (mirrored_at), one mirror_reads row, and reads back the same snapshot', async () => {
    await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: now.toISOString() });
    const r = await rec();
    expect(r.snapshot).toEqual(acme);
    expect(await n(sql`select count(*) as n from vdp_use_cases where owner_user_id = ${userId} and mirrored_at = ${now.toISOString()}::timestamptz`)).toBe(acme.useCases.length);
    expect(await n(sql`select count(*) as n from vdp_members where owner_user_id = ${userId}`)).toBe(acme.aes.length + acme.tas.length + acme.collaborators.length + (acme.createdBy ? 1 : 0));
    expect(await n(sql`select count(*) as n from vdp_assets where owner_user_id = ${userId}`)).toBe(acme.assets.length);
    const read = await one<{ source: string; scope: string; rows: number; complete: boolean; hash: string }>(sql`select source, scope, rows, complete, hash from mirror_reads where owner_user_id = ${userId} order by id desc limit 1`);
    expect(read).toMatchObject({ source: 'vdp', scope: 'my_vdps', rows: 1, complete: true });
    expect(read.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('readers get the tables, not the blob; a phase change is stage history; the same read again adds none', async () => {
    // a reader reads the child rows: change the blob only and the snapshot does not move
    await handle.db.execute(sql`update vdp_records set detail = jsonb_set(detail, '{useCases,0,title}', '"blob only"') where owner_user_id = ${userId} and vdp_id = ${acme.id}`);
    expect((await rec()).snapshot!.useCases[0]!.title).toBe(acme.useCases[0]!.title);
    const uc = acme.useCases[0]!;
    const moved = { ...acme, useCases: acme.useCases.map((u, i) => (i === 0 ? { ...u, executionPhase: u.executionPhase === 'Build' ? 'Live' : 'Build' } : u)) };
    const later = new Date(now.getTime() + 3600_000).toISOString();
    await saveVdpMirror(handle.db, userId, { snapshots: [moved], complete: true, readAt: later });
    await saveVdpMirror(handle.db, userId, { snapshots: [moved], complete: true, readAt: later });
    const phases = await handle.db.execute<{ phase: string | null }>(sql`select phase from vdp_use_case_phases where owner_user_id = ${userId} and vdp_use_case_id = ${uc.id} order by observed_at, id`);
    expect(phases.rows.map((p) => p.phase)).toEqual([uc.executionPhase, moved.useCases[0]!.executionPhase]);
    expect((await rec()).snapshot!.useCases[0]!.executionPhase).toBe(moved.useCases[0]!.executionPhase);
    expect(await n(sql`select count(*) as n from mirror_reads where owner_user_id = ${userId}`)).toBe(3);
    await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: now.toISOString() });
  });

  it('the complete read of my DCs is a mirror_reads row (org62 / my_dcs); a read only the kv holds still counts', async () => {
    const at = new Date(now.getTime() - 86_400_000).toISOString();
    await fixtureCs(async (tx) => rememberDcRead({ tx, cs: null as never, userId, me: { id: userId, name: 'me' }, now, extractorId, timezone: 'America/Denver', kv: new Map() }, { at, complete: true }));
    expect(await one<{ source: string; scope: string; complete: boolean }>(sql`select source, scope, complete from mirror_reads where owner_user_id = ${userId} and source = 'org62'`)).toEqual({ source: 'org62', scope: 'my_dcs', complete: true });
    expect(await lastDcRead(handle.db, userId)).toEqual({ at, complete: true });
    const newer = new Date(now.getTime() - 3600_000).toISOString();
    await fixtureCs((tx) => tx.execute(sql`update user_settings set value = ${JSON.stringify({ at: newer, complete: true })}::jsonb where owner_user_id = ${userId} and key = 'cc.deals/dc-read'`));
    expect(await lastDcRead(handle.db, userId)).toEqual({ at: newer, complete: true });
  });

  it('a VDP mirrored before 0036 reads its blob until the backfill writes its children', async () => {
    await handle.db.execute(sql`delete from vdp_use_cases where owner_user_id = ${userId}`);
    await handle.db.execute(sql`delete from vdp_members where owner_user_id = ${userId}`);
    await handle.db.execute(sql`update vdp_records set mirrored_at = null where owner_user_id = ${userId}`);
    expect((await rec()).snapshot).toEqual(acme);
    expect((await backfillPlan(handle.db, userId)).vdp_children).toBe(1);
    expect((await runKvBackfill(handle.db, userId)).copied).toMatchObject({ vdp_children: 1 });
    expect(await n(sql`select count(*) as n from vdp_use_cases where owner_user_id = ${userId}`)).toBe(acme.useCases.length);
    expect((await rec()).snapshot).toEqual(acme);
  });
});

describe.runIf(PG)('Slack and Gmail landings (09 R5)', () => {
  const port = () => dbOutboxPort(handle.db, userId, { extractorId: async () => extractorId, now: () => now });
  async function setDryRun(on: boolean) {
    const s = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: on }, ...(on ? {} : { confirm: true }) } } as never);
  }
  async function apply(id: string, mode: 'draft' | 'send', sim: SimulatedOutboxTransport) {
    const p = await ds.previewDraft({ params: { id }, body: { mode } } as never);
    const r = await ds.dispatchDraft({ params: { id }, body: { ifVersion: p.version, mode, confirmToken: p.confirmToken } } as never);
    if (r.dryRun) return null;
    const rows = await handle.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${id} order by id desc limit 1`);
    return runOutboxJob(parseJobPayload(rows.rows[0]!.payload)!, port(), new OutboxGateway(sim), { now: () => now });
  }

  it('a dry run leaves no landing', async () => {
    const sim = new SimulatedOutboxTransport(() => now);
    expect(await apply(T('dr_onepager'), 'send', sim)).toBeNull();
    expect(sim.calls).toEqual([]);
    expect(await loadMessageLandings(handle.db, userId)).toEqual([]);
  });

  it('an Applied Slack draft and Gmail send are landings with their writes, in the delivery change set; ids and targets only', async () => {
    await setDryRun(false);
    try {
      const sim = new SimulatedOutboxTransport(() => now);
      const slack = await apply(T('dr_dana'), 'draft', sim);
      expect(slack).toMatchObject({ state: 'delivered' });
      const gmail = await apply(T('dr_globex_sow'), 'send', sim);
      expect(gmail).toMatchObject({ state: 'delivered', readback: 'confirmed' });
      // the simulated transport is the only "destination": nothing real was called
      expect(sim.calls.map((c) => c.tool)).toEqual(['slack_send_message_draft', 'send_gmail_message', 'get_gmail_message_content']);
      const [s] = await loadMessageLandings(handle.db, userId, T('dr_dana'));
      expect(s).toMatchObject({ destination: 'slack', state: 'staged', externalId: expect.any(String), writes: [expect.objectContaining({ state: 'sent', values: expect.objectContaining({ mode: 'draft', tool: 'slack_send_message_draft' }) })] });
      const [g] = await loadMessageLandings(handle.db, userId, T('dr_globex_sow'));
      expect(g).toMatchObject({ destination: 'gmail', state: 'verified', verifiedAt: now.toISOString(), writes: [expect.objectContaining({ state: 'verified', values: expect.objectContaining({ mode: 'send', recipients: expect.any(String) }) })] });
      const stored = await handle.db.execute<{ after: unknown }>(sql`select after from landing_writes where owner_user_id = ${userId} and origin = 'outbox'`);
      expect(JSON.stringify(stored.rows)).not.toMatch(/@|<p>|subject/i);
      // the D-70 views never see them (their destinations are Org62 and VDP only)
      expect(routes.getUseCaseLandings.response.safeParse(await ds.getUseCaseLandings({} as never)).success).toBe(true);
    } finally {
      await setDryRun(true);
    }
  });

  it('a delivery from before 0036 gets its landing from the backfill (origin backfill)', async () => {
    await handle.db.execute(sql`delete from record_landings where owner_user_id = ${userId} and record_kind = 'message' and record_id = ${T('dr_globex_sow')}`);
    expect((await backfillPlan(handle.db, userId)).message_landings).toBe(1);
    expect((await runKvBackfill(handle.db, userId)).copied).toMatchObject({ message_landings: 1 });
    const [g] = await loadMessageLandings(handle.db, userId, T('dr_globex_sow'));
    expect(g).toMatchObject({ destination: 'gmail', state: 'verified', writes: [expect.objectContaining({ rowKey: 'backfill' })] });
    expect((await backfillPlan(handle.db, userId)).message_landings).toBe(0);
  });
});
