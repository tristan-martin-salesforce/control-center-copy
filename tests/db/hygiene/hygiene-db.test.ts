/**
 * HYG-1 against Postgres 17: no dead data, and no path for it.
 *
 *  - Health Rescan validates its scope (400 with the valid list), stores the ledger's `<connector>:<scope>` id, and a
 *    job the runtime refuses fails its placeholder (never "succeeded", never a quiet "cancelled");
 *  - a quick capture's `enrich` job has a handler: account match + chips, enrichment `done`, idempotent;
 *  - the Org62 read-back re-reads my logged Events and DCs by Id over a fake read-only lookup: an edit is recorded
 *    like any scan, an Event deleted in Org62 is marked and its verified app row says "Deleted in Org62";
 *  - every hygiene category, each on its own fixture, then the whole sweep twice (the second finds nothing);
 *  - dropping a projected activity row drops its ext side-car with it.
 *
 * Own database: control_center_hygiene_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder fixtures only.
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, freshDb, pgAvailable } from '../../support/pg';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { enqueueJob } from '../../../src/db/queue';
import { runMigrations } from '../../../src/db/migrate';
import { activityEntries } from '../../../src/db/schema';
import { createDefaultRegistry } from '../../../src/jobs';
import { enrichJobDef } from '../../../src/jobs/handlers/enrich';
import { hygieneJobDef } from '../../../src/jobs/handlers/hygiene';
import { DELETED_IN_ORG62, ORG62_READBACK_JOB, runOrg62Readback } from '../../../src/jobs/handlers/org62-readback';
import { scanHandler } from '../../../src/jobs/scan';
import type { JobContext } from '../../../src/jobs/types';
import { canvasActionFor } from '../../../src/lib/canvas/payload';
import { runProjections } from '../../../src/projections';
import { isAppError } from '../../../src/server/errors';
import { DbDataSource } from '../../../src/server/datasource/db';
import { loadKv } from '../../../src/server/datasource/db/ext';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { ensureExtractor, loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import type { WriteCtx } from '../../../src/server/datasource/db/store/common';
import { applyActivityWindow } from '../../../src/server/datasource/db/store/projections';
import {
  RETIRED_KV_PREFIXES,
  runHygieneSweep,
  STALE_DRAFT_REASON,
  sweepAbandonedRuns,
  sweepCanvasRows,
  sweepDcRequests,
  sweepJobs,
  sweepOrphanKv,
  sweepScanScopes,
  sweepStaleDrafts,
  sweepStuckEnriching,
} from '../../../src/server/hygiene/sweep';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import type { OneLookupResult, runOneReadLookup } from '../../../src/server/onboarding/identity';
import { projectionStore } from '../../../src/server/datasource/db/store/projections.run';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_hygiene_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_HYGIENE_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
/** The seed's frozen clock (DataSource reads); hygiene runs on the real clock (its SQL compares to now()). */
let seedNow: Date;
let org62ConnectorId: string;

const db = () => handle.db;
const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await handle.db.execute<T>(s)).rows;
const exec = (s: ReturnType<typeof sql>) => withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'test setup' }, async (tx) => tx.execute(s));

async function realJob(kind: string, payload: Record<string, unknown> = {}, queue = 'maintenance'): Promise<number> {
  return (await enqueueJob(handle.db, { ownerUserId: userId, kind, queue, payload, maxAttempts: 1 })).id;
}

function ctxFor(kind: string, payload: Record<string, unknown>, id: number, now: Date = new Date()): JobContext {
  return { job: { id, ownerUserId: userId, kind, queue: 'maintenance', payload, attempts: 1, maxAttempts: 1, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db: handle.db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_hygiene_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'hygiene-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  seedNow = mock.now();
  const s = seedFromMock(mock);
  const res = await loadSeedIntoDb(s.seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  mock.dispose();
  userId = res.userId;
  ds = new DbDataSource({ handle, url: URL_, userId, clock: { now: () => seedNow }, ranker: interimRanker });
  org62ConnectorId = (await q<{ id: string }>(sql`select id from connectors where owner_user_id = ${userId} and kind = 'org62'`))[0]!.id;
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
});

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

describe.runIf(PG)('Health Rescan: valid scopes only', () => {
  it('an unknown scope is a 400 that lists the valid scopes, and writes nothing', async () => {
    const before = (await q<{ n: number }>(sql`select count(*)::int as n from scan_runs where owner_user_id = ${userId}`))[0]!.n;
    const err = await ds.scanConnector({ params: { id: org62ConnectorId }, body: { scope: 'org62:org62:events' } } as never).catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as { status: number }).status).toBe(400);
    expect((err as { details: { valid: string[] } }).details.valid).toEqual(['opps', 'events', 'dcs', 'book', 'missed_opps', 'readback']);
    expect((err as Error).message).toMatch(/Unknown scope "org62:org62:events".*Valid scopes: opps, events, dcs/);
    expect((await q<{ n: number }>(sql`select count(*)::int as n from scan_runs where owner_user_id = ${userId}`))[0]!.n).toBe(before);
  });

  it('`org62:events` runs scope `events`; the placeholder carries the ledger id `org62:events`', async () => {
    const r = await ds.scanConnector({ params: { id: org62ConnectorId }, body: { scope: 'org62:events' } } as never);
    expect(r.entity.scope).toBe('org62:events');
    const [job] = await q<{ kind: string; scope: string }>(sql`select j.kind, j.payload->>'scope' as scope from scan_runs r join jobs j on j.id = r.job_id where r.id = ${r.entity.id}::uuid`);
    expect(job).toEqual({ kind: 'scan.org62', scope: 'events' });
  });

  it('a bare `dcs` is stored prefixed (`org62:dcs`), never as a bare scope', async () => {
    const r = await ds.scanConnector({ params: { id: org62ConnectorId }, body: { scope: 'dcs' } } as never);
    expect(r.entity.scope).toBe('org62:dcs');
    const plain = await ds.scanConnector({ params: { id: org62ConnectorId }, body: {} } as never);
    expect(plain.entity.scope).toBe('org62:opps');
  });

  it('a job the runtime refuses (unknown scope) fails its placeholder: never succeeded, never a quiet cancel', async () => {
    const r = await ds.scanConnector({ params: { id: org62ConnectorId }, body: { scope: 'events' } } as never);
    const [row] = await q<{ job_id: string; payload: Record<string, unknown> }>(sql`select r.job_id, j.payload from scan_runs r join jobs j on j.id = r.job_id where r.id = ${r.entity.id}::uuid`);
    const fake = { executeJob: async () => ({ status: 'failed' as const, errorClass: 'config' as const, followUps: [], detail: 'unknown scope org62:org62:events (valid: opps, events)' }) };
    await scanHandler({ scanner: fake as never, queue: { enqueue: async () => undefined } as never })(ctxFor('scan.org62', row!.payload, Number(row!.job_id)));
    const [after] = await q<{ status: string; error_code: string | null; error_message: string | null }>(sql`select status::text as status, error_code, error_message from scan_runs where id = ${r.entity.id}::uuid`);
    expect(after).toMatchObject({ status: 'failed', error_code: 'config' });
    expect(after!.error_message).toMatch(/unknown scope/);
  });

  it('`readback` queues the Org62 read-back job, linked to the placeholder run', async () => {
    const r = await ds.scanConnector({ params: { id: org62ConnectorId }, body: { scope: 'readback' } } as never);
    expect(r.entity.scope).toBe('org62:readback');
    const [job] = await q<{ kind: string; queue: string }>(sql`select j.kind, j.queue from scan_runs r join jobs j on j.id = r.job_id where r.id = ${r.entity.id}::uuid`);
    expect(job).toEqual({ kind: ORG62_READBACK_JOB, queue: 'maintenance' });
  });
});

// ---------------------------------------------------------------------------
// enrich
// ---------------------------------------------------------------------------

describe.runIf(PG)('captures: the enrich job has a handler and ends "enriching"', () => {
  it('matches the account the title names, records chips, ends `done`, and a second run changes nothing', async () => {
    const acct = (await q<{ id: string; name: string }>(sql`select id, name from accounts where owner_user_id = ${userId} order by name limit 1`))[0]!;
    const cap = await ds.captureItem({ body: { text: `Prep the ${acct.name} pricing walkthrough` } } as never);
    const id = cap.entity.id;
    expect(cap.entity.enrichment?.status).toBe('enriching');
    const [job] = await q<{ id: string; queue: string; payload: Record<string, unknown> }>(sql`select id, queue, payload from jobs where kind = 'enrich' and payload->>'workItemId' = ${id}`);
    expect(job!.queue).toBe('engine');
    const out = await enrichJobDef().handler(ctxFor('enrich', job!.payload, Number(job!.id), seedNow));
    expect(out).toMatchObject({ status: 'done', accountSet: true });
    const ext = (await q<{ value: { enrichment: { status: string; chips: Array<{ kind: string; ref?: { id: string } }> } } }>(sql`select value from user_settings where key = ${`cc.ext/work_items/${id}`}`))[0]!.value;
    expect(ext.enrichment.status).toBe('done');
    expect(ext.enrichment.chips.find((c) => c.kind === 'account')?.ref?.id).toBe(acct.id);
    const [w] = await q<{ account_id: string | null }>(sql`select account_id from work_items where id = ${id}::uuid`);
    expect(w!.account_id).toBe(acct.id);
    // History: one engine change set for the item
    const cs = await q<{ summary: string }>(sql`select summary from change_sets where entity_id = ${id} and actor_ref = 'enrich@1'`);
    expect(cs).toHaveLength(1);
    expect(await enrichJobDef().handler(ctxFor('enrich', job!.payload, Number(job!.id), seedNow))).toMatchObject({ status: 'not_enriching' });
    // the read model no longer shows it enriching once the job is done
    await db().execute(sql`update jobs set status = 'succeeded', finished_at = now() where id = ${job!.id}`);
    const item = await ds.getItem({ params: { id } } as never);
    expect(item.item.enrichment?.status).toBe('done');
    expect(item.item.reevaluating).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Org62 read-back
// ---------------------------------------------------------------------------

const EV_GONE = '00UXX0000000E01AAA';
const EV_EDITED = '00UXX0000000E02AAA';
const DC_ID = 'a0BXX0000000D01AAA';
const OPP_ORG62 = '006XX0000000OP1AAA';

function eventRow(id: string, stamp: string, x: Record<string, unknown> = {}) {
  return { attributes: { type: 'Event' }, Id: id, Subject: 'Placeholder workshop', StartDateTime: '2026-11-08T15:00:00.000+0000', EndDateTime: '2026-11-08T16:00:00.000+0000', DurationInMinutes: 60, Duration__c: 1, SE_Task_Type__c: 'Demo', Meeting_Type__c: null, RecordType: { Name: 'Solutions Event' }, WhatId: null, What: null, AccountId: null, IsChild: false, CreatedDate: '2026-11-08T17:00:00.000+0000', SystemModstamp: stamp, ...x };
}

/** DC-22: an answer that has every opp a read-back SOQL asks for (Id only: still there, nothing to record). */
const oppsAsked = (soql: string) => [...soql.matchAll(/'(006[A-Za-z0-9]{12,15})'/g)].map((m) => ({ attributes: { type: 'Opportunity' }, Id: m[1] }));

function fakeLookup(answer: (q: string) => unknown[] | null) {
  const calls: Array<{ connector: string; tool: string; q: string }> = [];
  const fn = (async (look) => {
    const soql = String(look.args.q);
    calls.push({ connector: look.connector, tool: look.tool, q: soql });
    const rows = answer(soql);
    const r: OneLookupResult = { text: rows ? JSON.stringify({ totalSize: rows.length, done: true, records: rows }) : null, code: rows ? 'ok' : 'mcp_failed', message: '', costUsd: 0.002, inputTokens: 100, outputTokens: 5, model: 'claude-haiku-5-5', started: true };
    return r;
  }) as typeof runOneReadLookup;
  return { fn, calls };
}

describe.runIf(PG)('Org62 read-back: edits are read, deletions are never "verified"', () => {
  let verifiedRow: string;
  let loggedRow: string;

  beforeAll(async () => {
    if (!PG) return;
    const rows = await q<{ id: string; status: string; starts_at: Date | string; ends_at: Date | string }>(sql`select id, status::text as status, starts_at, ends_at from activity_entries where owner_user_id = ${userId} and status in ('verified', 'logged') order by starts_at`);
    verifiedRow = rows.find((r) => r.status === 'verified')!.id;
    loggedRow = rows.find((r) => r.status === 'logged')!.id;
    const ins = async (eventId: string, rowId: string) => {
      const r = rows.find((x) => x.id === rowId)!;
      const [e] = await q<{ id: string }>(sql`
        insert into org62_events (owner_user_id, org62_event_id, record_type_name, subject, starts_at, ends_at, org62_modified_at)
        values (${userId}, ${eventId}, 'Solutions Event', 'Placeholder workshop', ${new Date(r.starts_at).toISOString()}::timestamptz, ${new Date(r.ends_at).toISOString()}::timestamptz, '2026-11-08T17:00:00Z')
        returning id`);
      await exec(sql`update activity_entries set org62_event_row_id = ${e!.id}::uuid where id = ${rowId}::uuid`);
    };
    await ins(EV_GONE, verifiedRow);
    await ins(EV_EDITED, loggedRow);
    const opp = (await q<{ id: string }>(sql`select id from opportunities where owner_user_id = ${userId} and not is_closed order by name limit 1`))[0]!;
    await exec(sql`update opportunities set org62_opportunity_id = ${OPP_ORG62} where id = ${opp.id}::uuid`);
    await db().execute(sql`insert into deal_contributions (owner_user_id, org62_dc_id, opportunity_id, is_mine, role, split_percent) values (${userId}, ${DC_ID}, ${opp.id}::uuid, true, 'Solution Engineer', 50)`);
  });

  it('one SOQL per batch by Id (read tools only); the edit is recorded as a new snapshot; the deleted Event is marked', async () => {
    const edited = '2026-11-11T10:00:00.000+0000';
    const look = fakeLookup((soql) =>
      soql.includes('FROM Event')
        ? [eventRow(EV_EDITED, edited, { SE_Task_Type__c: 'Customer Presentation' })]
        : soql.includes('FROM Use_Case__c')
          ? [] // D-67: the use cases on my opps (none here)
          : soql.includes('FROM Opportunity')
            ? oppsAsked(soql) // DC-22: every opp asked for still exists (Id only: nothing new to record)
            : [{ attributes: { type: 'Deal_Contribution__c' }, Id: DC_ID, Opportunity__c: OPP_ORG62, Opportunity__r: { Name: 'Placeholder opp', AccountId: null, StageName: 'Discovery', CloseDate: '2026-12-31', IsClosed: false, IsWon: false }, SE_Name__c: '005XX0000000ME1AAA', Opportunity_Role__c: 'Solution Engineer', Split_Percentage__c: 50, SystemModstamp: '2026-11-11T09:00:00.000+0000' }],
    );
    const jobId = await realJob(ORG62_READBACK_JOB, { trigger: 'manual' });
    const res = await runOrg62Readback(ctxFor(ORG62_READBACK_JOB, {}, jobId, new Date('2026-11-11T18:00:00Z')), { lookup: look.fn, live: true });
    // Events, my DCs, the opps a DC question hangs on (DC-22), then the use cases (D-67): read-only SOQL each
    expect(look.calls.every((c) => c.connector === 'org62' && c.tool === 'soqlQuery')).toBe(true);
    expect(look.calls.map((c) => /FROM (\w+)/.exec(c.q)![1])).toEqual(['Event', 'Deal_Contribution__c', 'Opportunity', 'Use_Case__c']);
    expect(look.calls[2]!.q).toMatch(/^SELECT Id, Name, AccountId, .* FROM Opportunity WHERE Id IN \(.+\) ORDER BY Id LIMIT 50$/);
    look.calls.splice(2, 1);
    expect(look.calls[0]!.q).toBe(`SELECT Id, Subject, StartDateTime, EndDateTime, DurationInMinutes, Duration__c, SE_Task_Type__c, Meeting_Type__c, RecordType.Name, WhatId, What.Name, What.Type, AccountId, IsChild, Description, CreatedDate, SystemModstamp FROM Event WHERE Id IN ('${EV_GONE}', '${EV_EDITED}') ORDER BY Id LIMIT 35`);
    expect(look.calls[1]!.q).toContain(`FROM Deal_Contribution__c WHERE Id IN ('${DC_ID}')`);
    // D-67: then the use cases on my open opps with my 100% DC, by opp (read only); this fixture's opp has a 50% DC (D-63)
    expect(look.calls[2]!.q).toMatch(/^SELECT Id, Name, OwnerId, .* FROM Use_Case__c WHERE Opportunity__c IN \(.+\) ORDER BY Id LIMIT 200$/);
    expect(look.calls[2]!.q).not.toContain(OPP_ORG62);
    expect(res).toMatchObject({ events: 2, eventsRead: 1, eventsDeleted: 1, dcs: 1, dcsRead: 1, dcsDeleted: 0, recorded: 2, new: 2, failedBatches: 0 });
    // the edit is a source item like any scan's (the projection takes it from here)
    const si = await q<{ external_id: string }>(sql`select external_id from source_items where owner_user_id = ${userId} and source = 'org62' and external_id like ${`Event:${EV_EDITED}@%`}`);
    expect(si.map((x) => x.external_id)).toEqual([`Event:${EV_EDITED}@${edited}`]);
    const [run] = await q<{ scope: string; status: string; job_id: string }>(sql`select scope, status::text as status, job_id from scan_runs where job_id = ${jobId}`);
    expect(run).toMatchObject({ scope: 'org62:readback', status: 'succeeded' });
    // the deleted Event: marked, and its verified app row says so (never silently verified)
    const [gone] = await q<{ deleted: Date | null }>(sql`select deleted_upstream_at as deleted from org62_events where org62_event_id = ${EV_GONE}`);
    expect(gone!.deleted).not.toBeNull();
    const [row] = await q<{ status: string; verify_issue: string | null }>(sql`select status::text as status, verify_issue from activity_entries where id = ${verifiedRow}::uuid`);
    expect(row).toEqual({ status: 'verify_failed', verify_issue: DELETED_IN_ORG62 });
    expect(res.weeks).toBeGreaterThan(0);
    // spend lines for every lookup (Events, DCs, the opps of a DC question (DC-22), use cases)
    expect((await q<{ n: number }>(sql`select count(*)::int as n from llm_calls where job_id = ${jobId}`))[0]!.n).toBe(4);
    // and the projections take the edit like any scan's: the Event row now says what Org62 says
    const p = await runProjections({ store: projectionStore(db()), userId, now: new Date('2026-11-11T18:05:00Z') });
    expect(p.errors).toEqual([]);
    const [e] = await q<{ t: string | null; deleted: Date | null }>(sql`select se_task_type_name as t, deleted_upstream_at as deleted from org62_events where org62_event_id = ${EV_EDITED}`);
    expect(e).toEqual({ t: 'Customer Presentation', deleted: null });
    // the deleted one stays deleted (its snapshots are marked, so the recompute does not bring it back)
    expect((await q<{ deleted: Date | null }>(sql`select deleted_upstream_at as deleted from org62_events where org62_event_id = ${EV_GONE}`))[0]!.deleted).not.toBeNull();
  });

  it('a DC deleted in Org62: its snapshots are marked, so no projection brings it back; an unreadable answer infers nothing', async () => {
    const look = fakeLookup((soql) => (soql.includes('FROM Event') ? null : soql.includes('FROM Opportunity') ? oppsAsked(soql) : []));
    const jobId = await realJob(ORG62_READBACK_JOB, { trigger: 'manual' });
    const res = await runOrg62Readback(ctxFor(ORG62_READBACK_JOB, {}, jobId, new Date('2026-11-11T19:00:00Z')), { lookup: look.fn, live: true });
    expect(res).toMatchObject({ eventsDeleted: 0, dcsDeleted: 1, failedBatches: 1 });
    const snaps = await q<{ deleted: Date | null }>(sql`select deleted_upstream_at as deleted from source_items where owner_user_id = ${userId} and external_id like ${`Deal_Contribution__c:${DC_ID}@%`}`);
    expect(snaps.length).toBe(1);
    expect(snaps.every((s) => s.deleted !== null)).toBe(true);
    // the edited Event (unreadable this time) is not marked deleted
    const [ev] = await q<{ deleted: Date | null }>(sql`select deleted_upstream_at as deleted from org62_events where org62_event_id = ${EV_EDITED}`);
    expect(ev!.deleted).toBeNull();
  });

  it('outside the launchd worker it reads nothing', async () => {
    const jobId = await realJob(ORG62_READBACK_JOB, {});
    expect(await runOrg62Readback(ctxFor(ORG62_READBACK_JOB, {}, jobId), { live: false })).toMatchObject({ skipped: 'not_live', events: 0 });
  });
});

// ---------------------------------------------------------------------------
// The hygiene sweep, category by category
// ---------------------------------------------------------------------------

function workerKinds(): Set<string> {
  return new Set([...createDefaultRegistry({}).kinds(), 'outbox.dispatch', 'settle.check', 'vdp.autopilot']);
}

async function draft(o: { createdBy: 'engine' | 'user'; daysOld: number; workItemId?: string | null; edited?: boolean }): Promise<string> {
  const id = randomUUID();
  await exec(sql`
    insert into drafts (id, owner_user_id, work_item_id, action_type, channel, status, doc_json, plain_text, content_hash, idempotency_key, created_by, edited_by_user, created_at, updated_at)
    values (${id}::uuid, ${userId}, ${o.workItemId ?? null}, 'slack_message', 'slack', 'ready', '{"type":"doc","content":[]}'::jsonb, 'Placeholder', ${`h-${id}`}, ${`idem-${id}`},
            ${o.createdBy}, ${o.edited ?? false}, now() - make_interval(days => ${o.daysOld}), now() - make_interval(days => ${o.daysOld}))`);
  return id;
}

describe.runIf(PG)('hygiene: each category cleans through the app, flags what you wrote', () => {
  // the placeholder seed carries some dead data of its own (mock-era runs, an unapplied canvas row): cleared first, so
  // each test below counts exactly its own fixture
  beforeAll(async () => {
    if (!PG) return;
    expect((await runHygieneSweep(db(), userId, { now: new Date(), knownKinds: workerKinds() })).errors).toEqual([]);
  });

  it('stale drafts: an engine draft with no to-do, 20 days old, is withdrawn; yours is flagged on Health, not touched', async () => {
    const mine = await draft({ createdBy: 'user', daysOld: 20 });
    const engine = await draft({ createdBy: 'engine', daysOld: 20 });
    const fresh = await draft({ createdBy: 'engine', daysOld: 2 });
    const r = await sweepStaleDrafts(db(), userId, { now: new Date() });
    expect(r).toEqual({ withdrawn: 1, flagged: 1 });
    const st = async (id: string) => (await q<{ status: string; reject_reason: string | null }>(sql`select status::text as status, reject_reason from drafts where id = ${id}::uuid`))[0]!;
    expect(await st(engine)).toEqual({ status: 'discarded', reject_reason: STALE_DRAFT_REASON });
    expect((await st(mine)).status).toBe('ready');
    expect((await st(fresh)).status).toBe('ready');
    const [ev] = await q<{ code: string; detail: { count: number } }>(sql`select code, detail from app_events where fingerprint = 'hygiene|stale_user_drafts' and resolved_at is null`);
    expect(ev).toEqual({ code: 'stale_user_drafts', detail: { count: 1 } });
    // audited in a hygiene change set (History, Undo)
    const audit = await q<{ summary: string }>(sql`select cs.summary from audit_events a join change_sets cs on cs.id = a.change_set_id where (a.row_id::text = ${engine} or a.entity_id = ${engine}) and cs.actor_ref = 'hygiene'`);
    expect(audit[0]?.summary).toBe('Hygiene: withdrew 1 stale draft');
    // a draft of a merged to-do: subject gone
    await exec(sql`update drafts set status = 'discarded' where id = ${mine}::uuid`);
    await flagCleared();
  });

  async function flagCleared() {
    await sweepStaleDrafts(db(), userId, { now: new Date() });
    expect((await q(sql`select 1 from app_events where fingerprint = 'hygiene|stale_user_drafts' and resolved_at is null`)).length).toBe(0);
  }

  it('DC requests: handed off on a delivered canvas and Org62 shows my DC (another split) → confirmed', async () => {
    const opp = (await q<{ id: string }>(sql`select id from opportunities where owner_user_id = ${userId} and org62_opportunity_id = ${OPP_ORG62}`))[0]!;
    await db().execute(sql`update deal_contributions set deleted_upstream_at = null, split_percent = 40 where org62_dc_id = ${DC_ID}`);
    const reqId = randomUUID();
    await exec(sql`insert into deal_contribution_requests (id, owner_user_id, opportunity_id, kind, role, split_percent, status, approved_at, approval_method) values (${reqId}::uuid, ${userId}, ${opp.id}::uuid, 'add', 'Solution Engineer', 50, 'approved', now(), 'click')`);
    const md = ['# ADD (1 row · 1 deal contribution)', '|#|Object|Name|Start|End|Role|Split|Opportunity__c|Meeting|Comment|', `|1|Deal_Contribution__c|Placeholder DC|||Solution Engineer|50|${OPP_ORG62}|||`].join('\n');
    const dest = canvasActionFor({ title: 'Placeholder canvas', markdown: md, eventIds: [], hours: 0, updates: 0, part: 1, parts: 1 });
    const canvas = randomUUID();
    await exec(sql`
      insert into drafts (id, owner_user_id, action_type, channel, status, payload, content_hash, idempotency_key, created_by, approved_at, approval_method, approved_content_hash)
      values (${canvas}::uuid, ${userId}, 'canvas_rewrite', 'slack_canvas', 'verified', ${JSON.stringify(dest)}::jsonb, ${`h-${canvas}`}, ${`idem-${canvas}`}, 'engine', now(), 'click', ${`h-${canvas}`})`);
    expect(await sweepDcRequests(db(), userId, { now: new Date() })).toBe(1);
    const [r] = await q<{ status: string; dc: string | null }>(sql`select status::text as status, deal_contribution_id as dc from deal_contribution_requests where id = ${reqId}::uuid`);
    expect(r!.status).toBe('verified');
    expect(r!.dc).not.toBeNull();
    expect(await sweepDcRequests(db(), userId, { now: new Date() })).toBe(0);
  });

  it('jobs: a dead job a later run of the same job fixed is resolved (and its notification); a kind no worker handles is cancelled', async () => {
    const dead = await realJob('scan.drive', { kind: 'scan', connector: 'drive', scope: 'tracked' }, 'scan.drive');
    await db().execute(sql`update jobs set status = 'dead', dead_at = now(), finished_at = now(), last_error_code = 'timeout', created_at = now() - interval '2 hours' where id = ${dead}`);
    await db().execute(sql`insert into notifications (owner_user_id, kind, severity, title, body, entity_type, entity_id, job_id, dedupe_key) values (${userId}, 'job_dead_lettered', 'error', 'Background job failed: scan.drive', 'attempts exhausted: timeout', 'job', ${String(dead)}, ${dead}, ${`job:${dead}:dead`})`);
    await db().execute(sql`insert into app_events (owner_user_id, severity, component, code, message, job_id, detail, fingerprint) values (${userId}, 'error', 'worker.jobs', 'job_dead_lettered', 'scan.drive dead-lettered (timeout)', ${dead}, '{"kind":"scan.drive","code":"timeout"}'::jsonb, 'worker.jobs|job_dead_lettered|scan.drive|timeout')`);
    const ok = await realJob('scan.drive', { kind: 'scan', connector: 'drive', scope: 'tracked' }, 'scan.drive');
    await db().execute(sql`update jobs set status = 'succeeded', finished_at = now() where id = ${ok}`);
    const otherDead = await realJob('scan.gmail', { kind: 'scan', connector: 'gmail', scope: 'inbox' }, 'scan.gmail');
    await db().execute(sql`update jobs set status = 'dead', dead_at = now(), finished_at = now() where id = ${otherDead}`);
    const orphan = await realJob('agent.answer', { runId: 'x' }, 'default');
    const r = await sweepJobs(db(), userId, { now: new Date(), knownKinds: workerKinds() });
    expect(r).toEqual({ resolved: 1, unhandled: 1 });
    const st = async (id: number) => (await q<{ status: string; by: string | null; why: string | null }>(sql`select status::text as status, superseded_by_id as by, cancel_reason as why from jobs where id = ${id}`))[0]!;
    expect(await st(dead)).toMatchObject({ status: 'cancelled', by: String(ok) });
    expect((await st(otherDead)).status).toBe('dead'); // nothing fixed it: still Health's to show
    expect(await st(orphan)).toMatchObject({ status: 'cancelled', why: 'no handler: no worker runs this kind of job' });
    expect((await q<{ status: string }>(sql`select status::text as status from notifications where job_id = ${dead}`))[0]!.status).toBe('resolved');
    expect((await q<{ r: Date | null }>(sql`select resolved_at as r from app_events where fingerprint = 'worker.jobs|job_dead_lettered|scan.drive|timeout'`))[0]!.r).not.toBeNull();
    await db().execute(sql`update jobs set status = 'cancelled', dead_at = null where id = ${otherDead}`);
  });

  it('a to-do left "enriching" with no enrich job is enriched now', async () => {
    const cap = await ds.captureItem({ body: { text: 'Placeholder follow-up nobody enriched' } } as never);
    await db().execute(sql`update jobs set status = 'cancelled', finished_at = now() where kind = 'enrich' and payload->>'workItemId' = ${cap.entity.id}`);
    await exec(sql`update user_settings set value = jsonb_set(value, '{enrichment,startedAt}', to_jsonb((now() - interval '1 hour')::text)) where key = ${`cc.ext/work_items/${cap.entity.id}`}`);
    expect(await sweepStuckEnriching(db(), userId, { now: new Date() })).toBe(1);
    const [v] = await q<{ s: string }>(sql`select value->'enrichment'->>'status' as s from user_settings where key = ${`cc.ext/work_items/${cap.entity.id}`}`);
    expect(v!.s).toBe('done');
    expect(await sweepStuckEnriching(db(), userId, { now: new Date() })).toBe(0);
  });

  it('scan runs on a scope that does not exist are removed (cursor too); an unprefixed placeholder is repaired', async () => {
    await db().execute(sql`insert into scan_runs (owner_user_id, connector_id, scope, trigger, mode, status, started_at, finished_at) values (${userId}, ${org62ConnectorId}::uuid, 'org62:org62:events', 'manual', 'incremental', 'succeeded', now() - interval '1 day', now() - interval '1 day')`);
    await db().execute(sql`insert into scan_runs (owner_user_id, connector_id, scope, trigger, mode, status, started_at, finished_at) values (${userId}, ${org62ConnectorId}::uuid, 'dcs', 'manual', 'incremental', 'failed', now() - interval '1 day', now() - interval '1 day')`);
    await db().execute(sql`insert into scan_cursors (owner_user_id, connector_id, scope, cursor_kind, cursor_value) values (${userId}, ${org62ConnectorId}::uuid, 'org62:org62:events', 'record_modstamp', 'x')`);
    const r = await sweepScanScopes(db(), userId, { now: new Date() });
    expect(r).toEqual({ removed: 1, repaired: 1, cursors: 1 });
    // (a run with items on an unknown scope keeps its history: only the ones that read nothing go)
    expect((await q(sql`select 1 from scan_runs where scope like 'org62:org62:%'`)).length).toBe(0);
    expect((await q(sql`select 1 from scan_cursors where scope like 'org62:org62:%'`)).length).toBe(0);
    expect((await q(sql`select 1 from scan_runs where scope = 'dcs'`)).length).toBe(0);
    expect((await q(sql`select 1 from scan_runs where scope = 'org62:dcs'`)).length).toBeGreaterThan(0);
    expect(await sweepScanScopes(db(), userId, { now: new Date() })).toEqual({ removed: 0, repaired: 0, cursors: 0 });
  });

  it('side-car kv rows of deleted rows (and of features no longer present) are removed; yours and live ones stay', async () => {
    const live = (await q<{ key: string }>(sql`select key from user_settings where key like 'cc.ext/activity_entries/%' limit 1`))[0]!.key;
    await exec(sql`insert into user_settings (owner_user_id, key, value) values
      (${userId}, ${`cc.ext/activity_entries/${randomUUID()}`}, '{"sources":[]}'::jsonb),
      (${userId}, 'cc.ext/retired_feature_rows/abc', '{"x":1}'::jsonb),
      (${userId}, ${`readin/work_item/${randomUUID()}`}, '{"x":1}'::jsonb)`);
    expect(await sweepOrphanKv(db(), userId, { now: new Date() })).toBe(2);
    // a key under a name that is not a table is a singleton (app runs, mapping questions): never matched to a row
    expect((await q(sql`select 1 from user_settings where key = 'cc.ext/retired_feature_rows/abc'`)).length).toBe(1);
    expect((await q(sql`select 1 from user_settings where key like 'cc.ext/app_runs/%'`)).length).toBeGreaterThan(0);
    expect(RETIRED_KV_PREFIXES.every((p) => !p.startsWith('settings.') && !p.startsWith('cc.ext/'))).toBe(true);
    expect((await q(sql`select 1 from user_settings where key = ${live}`)).length).toBe(1);
    expect((await q(sql`select 1 from user_settings where key = 'settings.profile'`)).length).toBe(1);
    expect(await sweepOrphanKv(db(), userId, { now: new Date() })).toBe(0);
  });

  it('activity rows "on a canvas" that never reached Slack go back to approved', async () => {
    const rows = await q<{ id: string }>(sql`select id from activity_entries where owner_user_id = ${userId} and status = 'approved' limit 1`);
    await exec(sql`update activity_entries set status = 'synced_to_canvas', synced_to_canvas_at = now() where id = ${rows[0]!.id}::uuid`);
    expect(await sweepCanvasRows(db(), userId, { now: new Date() })).toBe(1);
    const [a] = await q<{ status: string; synced: Date | null }>(sql`select status::text as status, synced_to_canvas_at as synced from activity_entries where id = ${rows[0]!.id}::uuid`);
    expect(a).toEqual({ status: 'approved', synced: null });
  });

  it('a scan run left running after its worker stopped is closed as abandoned', async () => {
    await db().execute(sql`insert into scan_runs (owner_user_id, connector_id, scope, trigger, mode, status, started_at) values (${userId}, ${org62ConnectorId}::uuid, 'org62:opps', 'schedule', 'incremental', 'running', now() - interval '3 hours')`);
    expect(await sweepAbandonedRuns(db(), userId, { now: new Date() })).toBe(1);
    expect((await q(sql`select 1 from scan_runs where status = 'running' and started_at < now() - interval '2 hours'`)).length).toBe(0);
  });

  it('the sweep job runs every category; a second run finds nothing (idempotent)', async () => {
    const jobId = await realJob('hygiene.sweep', {});
    const def = hygieneJobDef({ kinds: () => workerKinds() });
    const first = (await def.handler(ctxFor('hygiene.sweep', {}, jobId))) as Record<string, unknown>;
    expect(first.errors).toEqual([]);
    const second = (await def.handler(ctxFor('hygiene.sweep', {}, jobId))) as Record<string, number | string[]>;
    expect(second.errors).toEqual([]);
    for (const [k, v] of Object.entries(second)) if (k !== 'errors' && k !== 'staleDraftsFlagged') expect(v, k).toBe(0);
    expect(await runHygieneSweep(db(), userId, { now: new Date() })).toMatchObject({ errors: [] });
  });
});

// ---------------------------------------------------------------------------
// Prevention: a dropped projected row takes its ext with it
// ---------------------------------------------------------------------------

describe.runIf(PG)('projections: dropping an activity row drops its side-car', () => {
  it('applyActivityWindow deletes the ext of the rows it drops', async () => {
    const [row] = await q<{ id: string }>(sql`select id from activity_entries where owner_user_id = ${userId} and status = 'upcoming' limit 1`);
    await exec(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, ${`cc.ext/activity_entries/${row!.id}`}, '{"sources":[{"kind":"calendar","label":"x"}]}'::jsonb) on conflict (owner_user_id, key) do update set value = excluded.value`);
    const existing = await q<Record<string, unknown>>(sql`select * from activity_entries where id = ${row!.id}::uuid`);
    const me = (await q<{ person_id: string | null }>(sql`select person_id from users where id = ${userId}`))[0]!;
    await withChangeSet({ db: db(), userId, actor: actors.engine('projections@test'), reason: 'test drop' }, async (tx, cs) => {
      const w: WriteCtx = { tx, cs, userId, me: { id: me.person_id ?? userId, name: 'me' }, now: new Date(), extractorId: await ensureExtractor(db()), timezone: 'America/Denver', kv: await loadKv(tx, userId) };
      const typed = await tx.select().from(activityEntries).where(eq(activityEntries.id, row!.id));
      expect(existing.length).toBe(1);
      const out = await applyActivityWindow(w, {} as never, typed, [], [], () => true);
      expect(out.deleted).toBe(1);
    });
    expect((await q(sql`select 1 from activity_entries where id = ${row!.id}::uuid`)).length).toBe(0);
    expect((await q(sql`select 1 from user_settings where key = ${`cc.ext/activity_entries/${row!.id}`}`)).length).toBe(0);
  });
});
