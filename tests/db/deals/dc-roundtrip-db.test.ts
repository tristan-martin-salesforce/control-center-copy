/**
 * dc-roundtrip (D-68) on Postgres 17: the Deals and DC rows of docs/EDGE-CASES.md through the real path. Org62 source
 * items as the scanner stores them → runProjections → the db DataSource's pages (getDeals, getAccount, listDcRequests,
 * getHome), the read-back over a fake read-only lookup, and the hygiene sweep. The pure and mock side of the same rows
 * is tests/deals/dc-roundtrip.test.ts.
 *
 * Own database: control_center_dcrt_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder fixtures only.
 */
import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, freshDb, pgAvailable } from '../../support/pg';

import { routes, type RouteDef, type RouteKey } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type Db, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { enqueueJob } from '../../../src/db/queue';
import { ORG62_READBACK_JOB, runOrg62Readback } from '../../../src/jobs/handlers/org62-readback';
import type { JobContext } from '../../../src/jobs/types';
import { canvasActionFor } from '../../../src/lib/canvas/payload';
import { runProjections } from '../../../src/projections';
import { missedSlackEvidence } from '../../../src/projections/missed-slack';
import type { SourceRow } from '../../../src/projections/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';
import { putKv } from '../../../src/server/datasource/db/ext';
import { loadDcLiveState } from '../../../src/server/datasource/db/store/dc-requests';
import { DC_READ_KEY, engagedAccountIds } from '../../../src/server/datasource/db/store/deals-sync';
import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import { loadGapEntities } from '../../../src/server/datasource/db/store/vdp';
import { dcCanvasPreflight, DC_NOT_CREATED_GRACE_MS } from '../../../src/server/deals/dc-requests';
import { VDP_SCOPE_WITHDRAWN_REASON } from '../../../src/server/deals/scope';
import { runHygieneSweep } from '../../../src/server/hygiene/sweep';
import type { OneLookupResult, runOneReadLookup } from '../../../src/server/onboarding/identity';
import { PROFILE } from '../projections/db-setup';
import { org62Item } from '../../projections/fixtures';
import { projectionStore } from '../../../src/server/datasource/db/store/projections.run';


const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_dcrt_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_DCRT_DB !== '0';

/** Thu 2026-11-12 09:00 America/Denver: fiscal Q4 FY27. */
const T0 = Date.parse('2026-11-12T16:00:00.000Z');
let clock = new Date(T0);
const at = (min: number) => new Date(T0 + min * 60_000);

let handle: DbHandle;
let db: Db;
let ds: DbDataSource;
let userId: string;

const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
const exec = (s: ReturnType<typeof sql>) => withChangeSet({ db, userId, actor: actors.system('test'), reason: 'test setup' }, async (tx) => tx.execute(s));

async function insert(si: SourceRow) {
  const hash = createHash('sha1').update(JSON.stringify([si.title, si.meta, si.body])).digest('hex').slice(0, 16);
  await db.execute(sql`
    insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, external_container_id, dedupe_key, content_hash,
                              occurred_at, title, url, body, from_me, meta)
    values (${userId}, ${si.source}, ${si.kind}, ${si.externalId}, ${si.externalParentId}, ${si.externalContainerId}, ${si.dedupeKey}, ${hash},
            ${si.occurredAt}::timestamptz, ${si.title}, ${si.url}, ${si.body}, ${si.fromMe}, ${JSON.stringify(si.meta)}::jsonb)
    on conflict (owner_user_id, dedupe_key) do update set
      content_hash = excluded.content_hash, title = excluded.title, body = excluded.body, meta = excluded.meta, occurred_at = excluded.occurred_at,
      content_changed_at = now(), revision = source_items.revision + 1`);
}

async function call<K extends RouteKey>(key: K, input: Record<string, unknown> = {}): Promise<any> {
  const def: RouteDef = routes[key];
  const inp: Record<string, unknown> = {};
  if (def.params) inp.params = def.params.parse(input.params ?? {});
  if (def.query) inp.query = def.query.parse(input.query ?? {});
  if (def.body) inp.body = def.body.parse(input.body);
  const out = await (ds[key] as unknown as (i: unknown) => Promise<unknown>).call(ds, inp);
  const r = def.response.safeParse(out);
  if (!r.success) throw new Error(`${key} failed contract validation: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return r.data;
}

const project = async (min: number) => {
  clock = at(min);
  const r = await runProjections({ store: projectionStore(db), userId, now: clock, full: true });
  expect(r.errors).toEqual([]);
  return r;
};

// ---- Org62 fixtures (placeholders: the read shapes the scan-org62 skill and the REC-2 recorder store)
const stamp = (min: number) => new Date(T0 + min * 60_000).toISOString().replace('Z', '+0000');
const teamOpp = (id: string, name: string, acct: [string, string], min = -60 * 24 * 30, o: { amount?: number; closed?: boolean } = {}) =>
  org62Item(`Opportunity:${id}@${stamp(min)}`, { title: name, meta: { Id: id, StageName: o.closed ? 'Closed Lost' : 'Discovery', Amount: o.amount ?? 120000, CloseDate: '2027-01-20', IsClosed: !!o.closed }, body: 'stage=Discovery; team_role=Solution Engineer', accountHints: acct, oppHints: [id], changedAt: stamp(min).replace('+0000', 'Z') });
const otherOpp = (id: string, name: string, acct: [string, string], min = -60 * 24 * 30) =>
  org62Item(`Opportunity:${id}@${stamp(min)}`, { title: name, meta: { Id: id, StageName: 'Discovery', Amount: 90000, CloseDate: '2027-01-20', IsClosed: false }, body: 'stage=Discovery', accountHints: acct, oppHints: [id], changedAt: stamp(min).replace('+0000', 'Z') });
const dcRow = (dcId: string, opp: string, acct: string, split: number, min: number, extra: Record<string, unknown> = {}) =>
  org62Item(`Deal_Contribution__c:${dcId}@${stamp(min)}`, { title: 'DC on a placeholder opp', meta: { Opportunity__c: opp, Opportunity_Role__c: 'AI + Data Architect', Split_Percentage__c: split, ...extra }, body: `role=AI + Data Architect; split=${split}`, accountHints: [acct], oppHints: [opp], changedAt: stamp(min).replace('+0000', 'Z') });

const appOpp = async (org62: string) => (await q<{ id: string }>(sql`select id::text as id from opportunities where owner_user_id = ${userId} and org62_opportunity_id = ${org62}`))[0]!.id;
const appAcct = async (org62: string) => (await q<{ id: string }>(sql`select id::text as id from accounts where owner_user_id = ${userId} and org62_account_id = ${org62}`))[0]!.id;
const ext = async (table: string, id: string) => (await q<{ value: Record<string, unknown> }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${`cc.ext/${table}/${id}`}`))[0]?.value ?? {};
const gapOppIds = async () => (await call('getDeals')).needs.filter((n: any) => n.section === 'fix').flatMap((n: any) => n.opps.map((g: any) => g.oppId));
const reqOf = async (id: string) => (await call('listDcRequests')).requests.find((r: any) => r.id === id);

/** One canvas item carrying the DC rows the next batch takes, applied (reached Slack) `ago` ms before `now`. */
async function appliedCanvas(now: Date, ago: number): Promise<string> {
  const b = await buildLogBatch(db, userId, { now, timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() }, dcOnly: true });
  expect(b.canvases).toHaveLength(1);
  const c = b.canvases[0]!;
  const dest = canvasActionFor({ title: c.title, markdown: c.markdown, eventIds: [], hours: 0, updates: 0, part: 1, parts: 1 });
  const id = randomUUID();
  const sent = new Date(now.getTime() - ago).toISOString();
  await exec(sql`
    insert into drafts (id, owner_user_id, action_type, channel, status, payload, content_hash, idempotency_key, created_by, approved_at, approval_method, approved_content_hash, sent_at)
    values (${id}::uuid, ${userId}, 'canvas_rewrite', 'slack_canvas', 'sent', ${JSON.stringify(dest)}::jsonb, ${`h-${id}`}, ${`idem-${id}`}, 'engine', ${sent}::timestamptz, 'click', ${`h-${id}`}, ${sent}::timestamptz)`);
  return id;
}

/** A complete daily book read at `min`: every open team opp the app has, every live DC of mine, and the manifest. */
async function completeBookRead(min: number, o: { drop?: string[] } = {}) {
  const book = stamp(min).replace('+0000', 'Z');
  const team = await q<{ org62: string; name: string; acct: string | null }>(sql`
    select o.org62_opportunity_id as org62, o.name, a.org62_account_id as acct from opportunities o left join accounts a on a.id = o.account_id
     where o.owner_user_id = ${userId} and o.on_my_team and not o.is_closed and o.archived_at is null and o.org62_opportunity_id ~ '^006'`);
  for (const t of team) await insert({ ...org62Item(`Book:${t.org62}`, { title: t.name, body: `book_at=${book}; stage=Discovery; close=2027-01-20; amount=120000; team_role=Solution Engineer`, accountHints: t.acct ? [t.acct, 'Placeholder'] : [], oppHints: [t.org62] }), occurredAt: '2026-10-01T10:00:00.000Z' });
  const dcs = await q<{ dc: string; opp: string | null; split: number | null }>(sql`
    select dc.org62_dc_id as dc, o.org62_opportunity_id as opp, dc.split_percent::float8 as split from deal_contributions dc left join opportunities o on o.id = dc.opportunity_id
     where dc.owner_user_id = ${userId} and dc.is_mine and dc.deleted_upstream_at is null`);
  for (const d of dcs.filter((x) => !(o.drop ?? []).includes(x.dc))) await insert({ ...org62Item(`BookDc:${d.dc}`, { title: 'DC', body: `book_at=${book}; role=AI + Data Architect; split=${d.split ?? 100}`, oppHints: d.opp ? [d.opp] : [] }), occurredAt: '2026-10-01T10:00:00.000Z' });
  await insert({ ...org62Item(`BookRun:run-${book}`, { title: 'Book read', body: `book_at=${book}; rows=${team.length}; complete=true` }), occurredAt: book });
}

function ctxFor(id: number, now: Date): JobContext {
  return { job: { id, ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, attempts: 1, maxAttempts: 1, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_dcrt_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 4, applicationName: 'dc-roundtrip-test' });
  db = handle.db;
  userId = (await bootstrapUser({ db, profile: PROFILE, now: clock })).userId;
  ds = new DbDataSource({ handle, userId, clock: { now: () => clock } });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
});

const A1: [string, string] = ['001XX00000DRT01AAA', 'Alpha Health'];
const O1 = '006XX00000DRT01AAA';
const O2 = '006XX00000DRT02AAA';
const O3 = '006XX00000DRT03AAA';
const A4: [string, string] = ['001XX00000DRT04AAA', 'Delta Retail'];
const O4 = '006XX00000DRT04AAA';
const O5 = '006XX00000DRT05AAA';
const O6 = '006XX00000DRT06AAA';
const A7: [string, string] = ['001XX00000DRT07AAA', 'Gamma Bank'];
const O7 = '006XX00000DRT07AAA';
const A8: [string, string] = ['001XX00000DRT08AAA', 'Epsilon Labs'];
const O8 = '006XX00000DRT08AAA';

describe.runIf(PG)('dc-roundtrip on Postgres', () => {
  it('DC-01 DC created manually for a flagged opp: the gap closes on the next read (Postgres)', async () => {
    await insert(teamOpp(O1, 'Alpha Health - Data Cloud Pilot', A1));
    await project(1);
    const id = await appOpp(O1);
    expect(await gapOppIds()).toContain(id);
    await insert(dcRow('a0XXX00000DRT01AAA', O1, A1[0], 100, 2));
    await project(3);
    expect(await gapOppIds()).not.toContain(id);
    expect((await call('getAccount', { params: { accountId: await appAcct(A1[0]) } })).opps.find((o: any) => o.id === id)).toMatchObject({ dcAssigned: true, myDc: { split: 100 } });
  });

  it('DC-03 waiting add, DC created manually at another split: the request confirms, no ADD on the canvas (Postgres)', async () => {
    await insert(teamOpp(O2, 'Alpha Health - Agent Rollout', A1));
    await project(4);
    const c = await call('createDcRequest', { body: { opp: O2, split: 100, comment: 'Built the agent demo' } });
    await insert(dcRow('a0XXX00000DRT02AAA', O2, A1[0], 50, 5));
    const r = await project(6);
    expect(r.written.deal_contributions).toBeGreaterThanOrEqual(2);
    expect(await reqOf(c.entity.id)).toMatchObject({ status: 'verified', stage: 'confirmed', dc: { split: 50, org62DcId: 'a0XXX00000DRT02AAA' } });
    const b = await buildLogBatch(db, userId, { now: clock, timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() }, dcOnly: true });
    expect(b.canvases).toEqual([]);
  });

  it('DC-04 waiting change 50→100, Org62 hand-edited to 75: withdrawn, never overwrites (Postgres)', async () => {
    await insert(teamOpp(O3, 'Alpha Health - Member 360', A1));
    await insert(dcRow('a0XXX00000DRT03AAA', O3, A1[0], 50, 7));
    await project(8);
    const c = await call('createDcRequest', { body: { opp: O3, split: 100, comment: 'Took over the build' } });
    expect(c.entity).toMatchObject({ kind: 'change', fromSplit: 50, stage: 'waiting' });
    // DC-05: while it waits, the preflight's live state has the DC at 50%: a row written now would still be needed
    const b = await buildLogBatch(db, userId, { now: clock, timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() }, dcOnly: true });
    expect(dcCanvasPreflight(b.canvases[0]!.markdown, await loadDcLiveState(db, userId))).toEqual([]);
    // someone sets 75% in Org62
    await insert(dcRow('a0XXX00000DRT03AAA', O3, A1[0], 75, 9));
    await project(10);
    expect(await reqOf(c.entity.id)).toMatchObject({ status: 'dismissed', stage: 'dismissed', outcome: 'changed_in_org62', note: expect.stringMatching(/Org62 now shows your DC at 75%/) });
    const [row] = await q<{ outcome: string }>(sql`select outcome from deal_contribution_requests where id = ${c.entity.id}::uuid`);
    expect(row!.outcome).toBe('changed_in_org62');
    // DC-05: the row written before would now be dropped as a conflict (never overwritten)
    expect(dcCanvasPreflight(b.canvases[0]!.markdown, await loadDcLiveState(db, userId))).toEqual([expect.objectContaining({ conflict: true, reason: expect.stringMatching(/75%, not the 50%/) })]);
    const again = await buildLogBatch(db, userId, { now: clock, timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() }, dcOnly: true });
    expect(again.canvases).toEqual([]);
  });

  it('DC-11 DC removed (non-team opp): dcAssigned clears; the claim comes back (Postgres)', async () => {
    // an opp I only hold a DC on (no team row): its account is in my book only through the DC
    await insert(dcRow('a0XXX00000DRT04AAA', O4, A4[0], 100, 11, { IsClosed: false }));
    await project(12);
    const id = await appOpp(O4);
    expect(await ext('opportunities', id)).toMatchObject({ dcAssigned: true });
    // removed in Org62 (the read-back found it gone): its snapshots are marked
    await exec(sql`update source_items set deleted_upstream_at = now() where owner_user_id = ${userId} and external_id like 'Deal\\_Contribution\\_\\_c:a0XXX00000DRT04AAA@%'`);
    await project(13);
    expect((await q<{ gone: boolean }>(sql`select deleted_upstream_at is not null as gone from deal_contributions where org62_dc_id = 'a0XXX00000DRT04AAA'`))[0]!.gone).toBe(true);
    expect((await ext('opportunities', id)).dcAssigned).toBeUndefined();
    const c = await call('createDcRequest', { body: { opp: O4, split: 100, comment: 'Ran the retail workshop' } });
    expect(c.entity.kind).toBe('add');
    await call('withdrawDcRequest', { params: { id: c.entity.id }, body: {} });
    // DC-21: its account left my book with it: no stale DC status or hours
    expect(await ext('accounts', await appAcct(A4[0]))).not.toHaveProperty('dcStatus');
  });

  it('DC-13 DC reassigned to another SE: not mine any more, the gap is back (Postgres)', async () => {
    await insert(teamOpp(O5, 'Alpha Health - Payer Analytics', A1));
    await insert(dcRow('a0XXX00000DRT05AAA', O5, A1[0], 100, 14));
    await project(15);
    const id = await appOpp(O5);
    expect(await gapOppIds()).not.toContain(id);
    // the read-back reads it by Id and records whose it is now
    await insert(dcRow('a0XXX00000DRT05AAA', O5, A1[0], 100, 16, { SE_Name__c: '005XX0000000099AAA' }));
    await project(17);
    expect((await q<{ gone: boolean }>(sql`select deleted_upstream_at is not null as gone from deal_contributions where org62_dc_id = 'a0XXX00000DRT05AAA'`))[0]!.gone).toBe(true);
    expect(await gapOppIds()).toContain(id);
  });

  it('DC-14 two DCs of mine on one opp (Flex 50/50): splits summed per opp (Postgres)', async () => {
    await insert(teamOpp(O6, 'Alpha Health - Flex Credits', A1));
    await insert(dcRow('a0XXX00000DRT61AAA', O6, A1[0], 50, 18));
    await insert(dcRow('a0XXX00000DRT62AAA', O6, A1[0], 50, 19));
    await project(20);
    const id = await appOpp(O6);
    expect((await call('getAccount', { params: { accountId: await appAcct(A1[0]) } })).opps.find((o: any) => o.id === id)).toMatchObject({ myDc: { split: 100, dcCount: 2 } });
    expect((await loadGapEntities(db, userId)).opps.find((o) => o.id === id)!.dcSplit).toBe(100);
    expect(await engagedAccountIds(db, userId)).toContain(await appAcct(A1[0]));
    expect((await call('listDcRequests')).myDcs.filter((d: any) => d.oppId === id)).toHaveLength(2);
    await expect(ds.createDcRequest({ body: { opp: O6, split: 50, comment: 'Shared with the partner' } } as never)).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/You hold 2 DCs/) });
  });

  it('DC-10 split changed 100→50: staged VDP items for an account that leaves the 100% scope are withdrawn (Postgres)', async () => {
    await insert(teamOpp(O8, 'Epsilon Labs - Data Cloud', A8));
    await insert(dcRow('a0XXX00000DRT08AAA', O8, A8[0], 100, 21));
    await project(22);
    const acc = await appAcct(A8[0]);
    expect(await engagedAccountIds(db, userId)).toContain(acc);
    const draft = async (slug: string, edited = false) => {
      const id = randomUUID();
      await exec(sql`
        insert into drafts (id, owner_user_id, action_type, channel, status, payload, content_hash, idempotency_key, created_by, edited_by_user)
        values (${id}::uuid, ${userId}, 'vdp_update', 'vdp', 'ready', ${JSON.stringify({ api: 'vdp.create_vdp', tool: 'create_vdp', vdp_slug: slug, fields: [] })}::jsonb, ${`h-${id}`}, ${`idem-${id}`}, 'engine', ${edited})`);
      return id;
    };
    const out = await draft(`account:${acc}`);
    const mine = await draft(`account:${acc}`, true);
    const stays = await draft(`account:${await appAcct(A1[0])}`);
    await insert(dcRow('a0XXX00000DRT08AAA', O8, A8[0], 50, 23));
    await project(24);
    const st = Object.fromEntries((await q<{ id: string; status: string; why: string | null }>(sql`select id::text as id, status::text as status, reject_reason as why from drafts where action_type = 'vdp_update'`)).map((r) => [r.id, r]));
    expect(st[out]).toMatchObject({ status: 'discarded', why: VDP_SCOPE_WITHDRAWN_REASON });
    expect(st[mine]!.status).toBe('ready');
    expect(st[stays]!.status).toBe('ready');
  });

  it('DC-06 canvas applied partially: after the next complete read with no DC, not_created and unlocked; the gap comes back; Chase works on Postgres', async () => {
    await insert(teamOpp(O7, 'Gamma Bank - Wealth 360', A7));
    await project(25);
    const id = await appOpp(O7);
    const c = await call('createDcRequest', { body: { opp: O7, split: 100, comment: 'Built the wealth demo' } });
    await appliedCanvas(clock, DC_NOT_CREATED_GRACE_MS + 3_600_000);
    expect(await reqOf(c.entity.id)).toMatchObject({ stage: 'handed_off' });
    expect(await gapOppIds()).not.toContain(id);
    // Chase reads the request handed to Slackbot (the account status "requested" was never written here)
    expect((await call('getDeals')).needs.filter((n: any) => n.section === 'chase').map((n: any) => n.accountId)).toEqual([await appAcct(A7[0])]);
    // the next complete book read: no DC of mine on it
    await completeBookRead(26);
    await project(27);
    expect(await reqOf(c.entity.id)).toMatchObject({ status: 'dismissed', stage: 'not_created', outcome: 'not_created', lockedReason: expect.stringMatching(/Ask again/) });
    expect(await gapOppIds()).toContain(id);
    expect((await call('getDeals')).needs.filter((n: any) => n.section === 'chase')).toEqual([]);
    expect((await q<{ value: { at: string } }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${DC_READ_KEY}`))[0]!.value.at).toBe(stamp(26).replace('+0000', 'Z'));
    // Ask again: a new request, waiting for the next canvas (not "handed off" on the canvas that didn't create it)
    const again = await call('createDcRequest', { body: { opp: O7, split: 100, comment: 'Built the wealth demo' } });
    expect(again.entity).toMatchObject({ kind: 'add', stage: 'waiting' });
    expect(await gapOppIds()).not.toContain(id);
  });

  it('DC-21 opp moved to another account: the old account loses its state (Postgres)', async () => {
    const A21: [string, string] = ['001XX00000DRT21AAA', 'Iota Freight'];
    const B21: [string, string] = ['001XX00000DRT22AAA', 'Kappa Logistics'];
    const O21 = '006XX00000DRT21AAA';
    await insert(teamOpp(O21, 'Iota Freight - Routing Agent', A21, 28));
    await insert(otherOpp('006XX00000DRT22AAA', 'Iota Freight - Renewal', A21)); // someone else's: the account is no merge
    await insert(org62Item(`Event:00UXX00000DRT21AAA@${stamp(28)}`, { title: 'Iota routing workshop', meta: { SE_Task_Type__c: 'Workshop', Duration__c: 2, WhatId: O21 }, body: `type=Workshop; rt=Solutions Event; start=${new Date(T0 - 86_400_000).toISOString()}; hrs=2; what=Iota Freight - Routing Agent`, oppHints: [O21] }));
    await project(29);
    const old = await appAcct(A21[0]);
    expect(await ext('accounts', old)).toMatchObject({ hoursQtd: 2 });
    await insert(teamOpp(O21, 'Kappa Logistics - Routing Agent', B21, 30));
    await project(31);
    expect(await ext('accounts', old)).not.toHaveProperty('hoursQtd');
    expect(await ext('accounts', await appAcct(B21[0]))).toMatchObject({ hoursQtd: 2 });
    expect((await q<{ archived: boolean }>(sql`select archived_at is not null as archived from accounts where id = ${old}::uuid`))[0]!.archived).toBe(false);
  });

  it('DC-24 account merged in Org62: the surviving account takes over its links (Postgres)', async () => {
    const A24: [string, string] = ['001XX00000DRT24AAA', 'Lambda Media'];
    const B24: [string, string] = ['001XX00000DRT25AAA', 'Lambda Media Group'];
    const O24 = '006XX00000DRT24AAA';
    await insert(teamOpp(O24, 'Lambda Media - Audience 360', A24, 32));
    await project(33);
    const dead = await appAcct(A24[0]);
    // the VDP mirror links a VDP to it
    await exec(sql`insert into vdp_records (owner_user_id, vdp_slug, account_id, last_seen_at) values (${userId}, 'lambda-media-1', ${dead}::uuid, now())`);
    // merged in Org62: every opp it had now sits on the survivor
    await insert(teamOpp(O24, 'Lambda Media - Audience 360', B24, 34));
    await project(35);
    const survivor = await appAcct(B24[0]);
    expect((await q<{ archived: boolean }>(sql`select archived_at is not null as archived from accounts where id = ${dead}::uuid`))[0]!.archived).toBe(true);
    expect(await ext('accounts', dead)).toMatchObject({ mergedInto: survivor });
    expect((await q<{ acc: string }>(sql`select account_id::text as acc from vdp_records where vdp_slug = 'lambda-media-1'`))[0]!.acc).toBe(survivor);
    expect((await q<{ value: string }>(sql`select value from account_aliases where account_id = ${survivor}::uuid and kind = 'name'`)).map((x) => x.value)).toEqual(['Lambda Media']);
    expect((await call('getDeals')).accounts.map((a: any) => a.id)).not.toContain(dead);
  });

  it('DC-22 opp deleted in Org62: tombstoned, never a gap (Postgres)', async () => {
    const A22: [string, string] = ['001XX00000DRT26AAA', 'Mu Energy'];
    const O22 = '006XX00000DRT26AAA';
    await insert(teamOpp(O22, 'Mu Energy - Grid 360', A22, 36));
    await project(37);
    const id = await appOpp(O22);
    expect(await gapOppIds()).toContain(id);
    const c = await call('createDcRequest', { body: { opp: O22, split: 100, comment: 'Ran the grid workshop' } });
    // the read-back asks Org62 by Id: every opp but this one comes back
    const calls: string[] = [];
    const lookup = (async (look) => {
      const soql = String(look.args.q);
      calls.push(soql);
      const rows = soql.includes('FROM Opportunity') ? [...soql.matchAll(/'(006[A-Za-z0-9]{12,15})'/g)].map((m) => m[1]!).filter((x) => x !== O22).map((Id) => ({ attributes: { type: 'Opportunity' }, Id })) : null;
      const r: OneLookupResult = { text: rows ? JSON.stringify({ totalSize: rows.length, done: true, records: rows }) : null, code: rows ? 'ok' : 'mcp_failed', message: '', costUsd: 0.001, inputTokens: 50, outputTokens: 2, model: 'claude-haiku-5-5', started: true };
      return r;
    }) as typeof runOneReadLookup;
    const job = (await enqueueJob(db, { ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, maxAttempts: 1 })).id;
    const res = await runOrg62Readback(ctxFor(Number(job), at(38)), { lookup, live: true });
    expect(res).toMatchObject({ oppsDeleted: 1 });
    expect(calls.find((x) => x.includes('FROM Opportunity'))).toMatch(new RegExp(`^SELECT Id, Name, AccountId, .*FROM Opportunity WHERE Id IN \\(.*'${O22}'.*\\) ORDER BY Id LIMIT 50$`));
    expect((await q<{ archived: boolean }>(sql`select archived_at is not null as archived from opportunities where id = ${id}::uuid`))[0]!.archived).toBe(true);
    expect(await ext('opportunities', id)).toHaveProperty('deletedInOrg62At');
    expect(await reqOf(c.entity.id)).toMatchObject({ status: 'dismissed', outcome: 'opp_deleted', note: expect.stringMatching(/deleted in Org62/) });
    // never a gap, and the next pass does not bring it back
    await project(39);
    expect(await gapOppIds()).not.toContain(id);
    expect((await q<{ archived: boolean }>(sql`select archived_at is not null as archived from opportunities where id = ${id}::uuid`))[0]!.archived).toBe(true);
  });

  it('DC-31 Home vs Deals DC counts: one source; Claim DC marks the finding claimed (Postgres)', async () => {
    const A31: [string, string] = ['001XX00000DRT31AAA', 'Nu Insurance'];
    const O31 = '006XX00000DRT31AAA';
    await insert(teamOpp('006XX00000DRT32AAA', 'Nu Insurance - Claims Agent', A31, 40));
    await insert(org62Item(`MissedOpp:${O31}`, { title: 'Nu Insurance - Data Cloud Expansion', meta: { Id: O31, AccountId: A31[0], AccountName: A31[1], StageName: 'Proposal', Amount: 180000, CloseDate: '2026-12-31', IsClosed: false, IsWon: false, signal: 'd360', hours: 3.5, d360Amount: 120000, products: ['Data 360 Profiles'] }, body: 'tier=claim; signal=d360; evidence=strong; hours=3.5; d360_amount=120000; close=2026-12-31; won=false; other_architect_dc=none', accountHints: A31, oppHints: [O31] }));
    await project(41);
    const id = await appOpp(O31);
    const home = async () => (await call('getHome', { query: {} })).sections.flatMap((s: any) => s.rows).find((r: any) => r.id === 'gap:missed_dc');
    const gaps = await gapOppIds();
    expect(gaps).toContain(id);
    expect((await home()).resolve.baseline.subjects).toBe([...new Set(gaps)].sort().join(','));
    const finding = (await call('getMissed')).missed.find((m: any) => m.oppId === id);
    expect(finding).toMatchObject({ status: 'new', verdict: 'claim' });
    const c = await call('createDcRequest', { body: { opp: O31, split: 100, comment: 'Ran the expansion workshop' } });
    expect((await call('getMissed')).missed.find((m: any) => m.oppId === id)).toMatchObject({ status: 'claimed', dcRequestId: c.entity.id });
    const after = await gapOppIds();
    expect(after).not.toContain(id);
    expect((await home())?.resolve.baseline.subjects ?? '').toBe([...new Set(after)].sort().join(','));
  });

  it('DC-32 a VDP I am on links an open opp with no DC of mine: gap reason vdp (Postgres)', async () => {
    const A32: [string, string] = ['001XX00000DRT33AAA', 'Xi Pharma'];
    const O32 = '006XX00000DRT33AAA';
    await insert(otherOpp('006XX00000DRT34AAA', 'Xi Pharma - Field Agent', A32));
    await insert(teamOpp('006XX00000DRT35AAA', 'Xi Pharma - Renewal', A32, 42, { closed: true })); // keeps the account in my book
    await insert(otherOpp(O32, 'Xi Pharma - Patient 360', A32));
    await project(43);
    const id = await appOpp(O32);
    expect(await gapOppIds()).not.toContain(id);
    const snap = { id: 'vdp-xi-1', slug: 'xi-pharma-1', url: null, company: { id: 'c1', name: 'Xi Pharma', slug: 'xi-pharma', industry: null, segment: null }, fiscalYear: 27, fiscalQuarter: 4, salesforceAccountId: A32[0], salesforceOpportunityId: O32, salesforceOpportunityIds: [O32], isSeed: false, archivedAt: null, createdAt: null, updatedAt: null, lastActivityAt: null, aes: [], tas: [{ email: PROFILE.email, name: PROFILE.name, placeholder: false }], createdBy: null, collaborators: [], useCases: [], stakeholders: [], assets: [], dcNoteCached: false, executiveSummary: null };
    await exec(sql`insert into vdp_records (owner_user_id, vdp_slug, vdp_id, detail, last_seen_at) values (${userId}, 'xi-pharma-1', 'vdp-xi-1', ${JSON.stringify(snap)}::jsonb, now())`);
    const row = (await call('getDeals')).needs.find((n: any) => n.section === 'fix' && n.opps.some((g: any) => g.oppId === id));
    expect(row.opps.find((g: any) => g.oppId === id)).toMatchObject({ reasons: ['vdp'], onTeam: false });
    // a VDP I'm not on links nothing for me
    await exec(sql`update vdp_records set detail = jsonb_set(detail, '{tas}', '[]'::jsonb) where vdp_slug = 'xi-pharma-1'`);
    expect(await gapOppIds()).not.toContain(id);
  });

  it('DC-33 Slack as evidence: my messages per named channel, counted, mapped to the one account it names (Postgres)', async () => {
    const msg = (ch: string, name: string | null, n: number, fromMe = true) => ({ ...org62Item(`x${n}`), source: 'slack', kind: 'slack_message', externalId: `${ch}:17000000${n}.0001`, dedupeKey: `slack:${ch}:17000000${n}.0001`, occurredAt: new Date(T0 - n * 3_600_000).toISOString(), fromMe, title: null, body: null, meta: name ? { channelName: name } : {} });
    for (let i = 1; i <= 4; i++) await insert(msg('C0XIPHARM1', 'ext-xi-pharma-patient360', i));
    await insert(msg('C0XIPHARM1', 'ext-xi-pharma-patient360', 9, false)); // someone else's: not mine
    await insert(msg('D0DIRECT01', null, 5)); // a DM: no channel name, never evidence
    const ev = await missedSlackEvidence(db, userId, clock);
    expect(ev).toEqual([{ id: 'C0XIPHARM1', channelName: 'ext-xi-pharma-patient360', at: new Date(T0 - 3_600_000).toISOString(), messages: 4, accountOrg62Id: '001XX00000DRT33AAA' }]);
  });

  it('DC-25 hygiene: sweeps stale dcAssigned, stale account dcStatus and stranded hand-offs; a second sweep finds nothing (Postgres)', async () => {
    const o1 = await appOpp(O1);
    const a7 = await appAcct(A7[0]);
    // left by an older build: a flag no DC supports (its DC removed upstream), "requested" on an account, a hand-off with no canvas
    await exec(sql`update deal_contributions set deleted_upstream_at = now() where org62_dc_id = 'a0XXX00000DRT01AAA'`);
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'legacy state' }, async (tx) => {
      await putKv(tx, userId, `cc.ext/opportunities/${o1}`, { dcAssigned: true });
      await putKv(tx, userId, `cc.ext/accounts/${a7}`, { dcStatus: 'requested' });
    });
    const stranded = randomUUID();
    await exec(sql`
      insert into deal_contribution_requests (id, owner_user_id, opportunity_id, kind, role, split_percent, status, approved_at, approval_method, created_at, updated_at)
      values (${stranded}::uuid, ${userId}, ${await appOpp(O2)}::uuid, 'add', 'AI + Data Architect', 100, 'synced_to_canvas', now(), 'click', ${at(-60 * 24 * 3).toISOString()}::timestamptz, ${at(-60 * 24 * 3).toISOString()}::timestamptz)`);
    // O2 has my DC (DC-03 confirmed it): the stranded hand-off is answered by it
    const r = await runHygieneSweep(db, userId, { now: at(50) });
    expect(r.errors).toEqual([]);
    expect(r.counts).toMatchObject({ staleDcFlags: 1, staleDcStatus: 1 });
    expect(r.counts.dcRequestsConfirmed).toBeGreaterThanOrEqual(1);
    expect((await ext('opportunities', o1)).dcAssigned).toBeUndefined();
    expect(await ext('accounts', a7)).not.toHaveProperty('dcStatus');
    expect((await q<{ status: string }>(sql`select status::text as status from deal_contribution_requests where id = ${stranded}::uuid`))[0]!.status).toBe('verified');
    const again = await runHygieneSweep(db, userId, { now: at(51) });
    expect(again.counts).toMatchObject({ staleDcFlags: 0, staleDcStatus: 0, vdpItemsOutOfScope: 0, dcRequestsConfirmed: 0 });
  });
});
