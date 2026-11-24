/**
 * D-65 on Postgres 17: the Time ↔ Org62 round trip through the real path. Source items as the scanners store them →
 * runProjections → activity_entries, read through the db DataSource. The moves the projection writes (Org62's values
 * adopted once, Related To cleared, verify_failed back to verified, a rescheduled meeting re-keyed), the no-overlap
 * constraint that never hides a real Org62 record (migration 0022), the CC# key read from the Event's snapshot,
 * Log again, the canvas preflight at Apply and on an edit, the canvas expiry sweep, concurrent passes and a
 * read-back where every batch fails.
 *
 * Own database: control_center_roundtrip_<CC_TEST_DB_SUFFIX>, created and dropped per run. Placeholder data only.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDb, freshDb, pgAvailable } from '../../support/pg';

import { routes, type RouteDef, type RouteKey } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type Db, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { enqueueJob } from '../../../src/db/queue';
import { DUPLICATE_MARKER, LOG_AGAIN_FLAG, ORG62_CHECK_PREFIX, START_DIFFERS_MARKER } from '../../../src/engines/activity/org62-check';
import { markOrg62Deleted, ORG62_READBACK_JOB, org62ReadbackJobDef, runOrg62Readback } from '../../../src/jobs/handlers/org62-readback';
import type { JobContext } from '../../../src/jobs/types';
import { canvasInputOf } from '../../../src/lib/canvas/payload';
import { runProjections } from '../../../src/projections';
import { recomputeWeeks } from '../../../src/projections/run';
import type { SourceRow } from '../../../src/projections/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';
import { sweepStaleCanvases } from '../../../src/server/hygiene/sweep';
import type { OneLookupResult, runOneReadLookup } from '../../../src/server/onboarding/identity';
import { EXPIRED_CANVAS_REASON } from '../../../src/server/time/canvas-preflight';
import { PROFILE } from '../projections/db-setup';
import { ACCT_ACME, calItem, ME, OPP_ACME, org62Item } from '../../projections/fixtures';
import { projectionStore } from '../../../src/server/datasource/db/store/projections.run';


const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_roundtrip_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_ROUNDTRIP_DB !== '0';

// Fri 2026-11-06 09:00 America/Denver (MST, UTC-7); the meetings are Thursday's
const NOW = new Date('2026-11-06T16:00:00.000Z');
const at = (hhmm: string, day = '2026-11-05') => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + ((h + 7) * 60 + m) * 60_000).toISOString();
};
const sfAt = (iso: string) => iso.replace(/\.\d{3}Z$/, '.000+0000');

let handle: DbHandle;
let db: Db;
let userId: string;
let ds: DbDataSource;

const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
/** A write the test makes as the user would (inside a change set: the audit trigger requires one). */
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
const project = (now: Date = NOW) => runProjections({ store: projectionStore(db), userId, now });
const ACME = [{ email: ME.email, response: 'accepted' }, { email: 'dana@acme.example', response: 'accepted' }];
const meeting = (id: string, title: string, from: string, to: string) => calItem(id, { title, start: at(from), end: at(to), attendees: ACME, ended: true, attendance: 'attended' });
const keyOf = (id: string, from: string) => `cal|primary|${id}|${at(from)}`;
/** An Org62 Event snapshot (`Event:<Id>@<stamp>`), as the scans record it (payload → meta). */
const event = (id: string, stamp: string, o: { subject: string; start: string; end: string; hours: number; what?: string | null; type?: string; ccKey?: string | null }) =>
  org62Item(`Event:${id}@${stamp}`, {
    title: o.subject,
    meta: { Id: id, StartDateTime: sfAt(o.start), EndDateTime: sfAt(o.end), Duration__c: o.hours, SE_Task_Type__c: o.type ?? 'Customer Discovery', RecordTypeName: 'Solutions Event', WhatId: o.what === undefined ? OPP_ACME : o.what, CreatedDate: stamp, ccKey: o.ccKey ?? null, rec: 'auto' },
    body: `type=${o.type ?? 'Customer Discovery'}; rt=Solutions Event; hrs=${o.hours}`,
    oppHints: o.what === null ? [] : [OPP_ACME],
  });
const rowOf = async (dedupeKey: string) =>
  (await q<{ id: string; status: string; dedupe_key: string; flags: string[] | null; duration_hours: string; what_kind: string; opportunity_id: string | null; account_id: string | null; what_org62_id: string | null; org62_event_row_id: string | null; verify_issue: string | null; version: number; starts_at: Date; ends_at: Date; synced_to_canvas_at: Date | null }>(
    sql`select id, status::text as status, dedupe_key, flags, duration_hours, what_kind::text as what_kind, opportunity_id, account_id, what_org62_id, org62_event_row_id, verify_issue, version, starts_at, ends_at, synced_to_canvas_at from activity_entries where owner_user_id = ${userId} and dedupe_key = ${dedupeKey}`,
  ))[0];
const byId = async (id: string) => (await q<{ status: string; dedupe_key: string; flags: string[] | null; org62_event_row_id: string | null; synced_to_canvas_at: Date | null; version: number }>(sql`select status::text as status, dedupe_key, flags, org62_event_row_id, synced_to_canvas_at, version from activity_entries where id = ${id}::uuid`))[0]!;
/** The user approves a row (and, `synced`, a canvas carried it to Slackbot). */
async function approve(dedupeKey: string, synced = false) {
  await exec(sql`
    update activity_entries set status = ${synced ? 'synced_to_canvas' : 'approved'}::activity_status, approved_at = now(), approval_method = 'click',
           synced_to_canvas_at = ${synced ? NOW.toISOString() : null}::timestamptz,
           se_task_type_id = coalesce(se_task_type_id, (select id from se_task_types order by name limit 1)), version = version + 1
     where owner_user_id = ${userId} and dedupe_key = ${dedupeKey}`);
}
function ctxFor(id: number, now: Date): JobContext {
  return { job: { id, ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, attempts: 1, maxAttempts: 1, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_roundtrip_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 6, applicationName: 'roundtrip-test' });
  db = handle.db;
  userId = (await bootstrapUser({ db, profile: PROFILE, now: NOW })).userId;
  ds = new DbDataSource({ handle, userId, clock: { now: () => NOW } });
  // ACME: an open opp of mine (team)
  await insert(org62Item(`Opportunity:${OPP_ACME}@2026-11-05T10:00:00.000+0000`, { title: 'ACME - Data 360 Expansion', meta: { Id: OPP_ACME, Amount: 250000, CloseDate: '2026-12-15', StageName: 'Validation', IsClosed: false }, body: 'stage=Validation; close=2026-12-15; amount=250000; team_role=Solution Engineer', accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME] }));
  for (const [id, title, from, to] of [
    ['m1', 'ACME discovery', '07:00', '08:00'],
    ['m2', 'ACME roadmap', '09:00', '10:00'],
    ['m3', 'ACME pricing', '10:30', '11:30'],
    ['m4', 'ACME check-in', '12:00', '12:30'],
    ['m5', 'ACME demo', '13:00', '14:00'],
    ['m6', 'ACME workshop prep', '14:30', '15:30'],
  ] as const)
    await insert(meeting(id, title, from, to));
  const r = await project();
  expect(r.errors).toEqual([]);
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
});

describe.runIf(PG)('the round trip on Postgres', () => {
  let m1: string;
  let m3: string;

  it('the meetings are proposals of the ACME opp', async () => {
    for (const [id, from] of [['m1', '07:00'], ['m2', '09:00'], ['m3', '10:30'], ['m4', '12:00'], ['m5', '13:00'], ['m6', '14:30']] as const) {
      const r = await rowOf(keyOf(id, from));
      expect(r, id).toBeTruthy();
      expect(r!.what_org62_id).toBe(OPP_ACME);
    }
  });

  it('TL-23 / TL-22 a canvas-made Event joins on its CC# key (read from the snapshot) though Slackbot moved its start 7 h; one row, verified, the start flagged', async () => {
    await approve(keyOf('m1', '07:00'), true);
    m1 = (await rowOf(keyOf('m1', '07:00')))!.id;
    // Slackbot wrote the UTC instant as local time: 07:00 → 14:00, and its own subject
    await insert(event('00UXX0000000R01AAA', '2026-11-05T22:00:00.000+0000', { subject: 'ACME discovery (Slackbot)', start: at('14:00'), end: at('15:00'), hours: 1, ccKey: m1 }));
    expect((await project()).errors).toEqual([]);
    const r = await byId(m1);
    expect(r.status).toBe('verified');
    expect(r.org62_event_row_id).toBeTruthy();
    expect((r.flags ?? []).some((f) => f.startsWith(`${START_DIFFERS_MARKER} by 420 min`))).toBe(true);
    expect((await q<{ n: number }>(sql`select count(*)::int as n from activity_entries where owner_user_id = ${userId} and dedupe_key = 'org62|00UXX0000000R01AAA'`))[0]!.n).toBe(0);
  });

  it('TL-11 / TL-13 Duration edited and Related To cleared in Org62: adopted (what_kind none, no opp, no account), and written once', async () => {
    await insert(event('00UXX0000000R01AAA', '2026-11-06T15:00:00.000+0000', { subject: 'ACME discovery (Slackbot)', start: at('14:00'), end: at('15:30'), hours: 1.5, what: null, ccKey: m1 }));
    expect((await project()).errors).toEqual([]);
    const r = (await rowOf(keyOf('m1', '07:00')))!;
    expect(r).toMatchObject({ status: 'verified', duration_hours: '1.50', what_kind: 'none', opportunity_id: null, account_id: null, what_org62_id: null });
    expect((r.flags ?? []).some((f) => f.startsWith('Updated from Org62'))).toBe(true);
    // the next passes write nothing to it
    await recomputeWeeks({ store: projectionStore(db), userId, days: ['2026-11-05'], now: NOW });
    await recomputeWeeks({ store: projectionStore(db), userId, days: ['2026-11-05'], now: NOW });
    expect((await rowOf(keyOf('m1', '07:00')))!.version).toBe(r.version);
  });

  it('TL-04 / TL-07 two Org62 Events for one meeting: both logged rows (the constraint holds, migration 0022); the second flagged a duplicate', async () => {
    await insert(event('00UXX0000000R02AAA', '2026-11-05T18:00:00.000+0000', { subject: 'ACME roadmap', start: at('09:00'), end: at('10:00'), hours: 1 }));
    await insert(event('00UXX0000000R03AAA', '2026-11-05T18:30:00.000+0000', { subject: 'ACME roadmap review', start: at('09:00'), end: at('10:00'), hours: 1 }));
    expect((await project()).errors).toEqual([]);
    const a = (await rowOf('org62|00UXX0000000R02AAA'))!;
    const b = (await rowOf('org62|00UXX0000000R03AAA'))!;
    expect([a.status, b.status]).toEqual(['logged', 'logged']);
    expect([a, b].filter((x) => (x.flags ?? []).some((f) => f.startsWith(DUPLICATE_MARKER)))).toHaveLength(1);
    expect(await rowOf(keyOf('m2', '09:00'))).toBeUndefined(); // the proposal is closed by its twin
    const t = await call('getTime', { query: { week: '2026-11-05' } });
    expect(t.entries.filter((e: any) => e.fromOrg62 && e.start === at('09:00'))).toHaveLength(2);
  });

  it('TL-15 verify_failed (Slackbot wrote 2 h), then fixed in Org62: back to verified', async () => {
    await approve(keyOf('m3', '10:30'), true);
    m3 = (await rowOf(keyOf('m3', '10:30')))!.id;
    // the row's own task type (Slackbot got the type right; only the hours are off)
    const type = (await q<{ t: string }>(sql`select t.name as t from activity_entries a join se_task_types t on t.id = a.se_task_type_id where a.id = ${m3}::uuid`))[0]!.t;
    await insert(event('00UXX0000000R04AAA', '2026-11-05T19:00:00.000+0000', { subject: 'ACME pricing', start: at('10:30'), end: at('12:30'), hours: 2, type, ccKey: m3 }));
    await project();
    expect(await byId(m3)).toMatchObject({ status: 'verify_failed' });
    expect((await rowOf(keyOf('m3', '10:30')))!.verify_issue).toMatch(/Duration__c: expected 1, Org62 has 2/);
    await insert(event('00UXX0000000R04AAA', '2026-11-06T15:10:00.000+0000', { subject: 'ACME pricing', start: at('10:30'), end: at('11:30'), hours: 1, type, ccKey: m3 }));
    await project();
    expect(await byId(m3)).toMatchObject({ status: 'verified' });
  });

  it('TL-14 an app-logged Event deleted in Org62: "Deleted in Org62" on Time, and Log again puts it back for the next batch', async () => {
    // as the read-back marks it: its Event row and its snapshots (so no projection brings it back)
    await markOrg62Deleted(db, userId, { events: ['00UXX0000000R04AAA'], dcs: [] }, NOW);
    await recomputeWeeks({ store: projectionStore(db), userId, days: ['2026-11-05'], now: NOW });
    expect(await byId(m3)).toMatchObject({ status: 'verify_failed' });
    const t = await call('getTime', { query: { week: '2026-11-05' } });
    const e = t.entries.find((x: any) => x.id === m3);
    expect(e.issues).toContain(`${ORG62_CHECK_PREFIX}Deleted in Org62`);
    const r = await call('resolveActivity', { params: { id: m3 }, body: { ifVersion: e.version, action: 'log_again' } });
    expect(r.entity).toMatchObject({ status: 'approved' });
    const row = await byId(m3);
    expect(row).toMatchObject({ status: 'approved', org62_event_row_id: null, synced_to_canvas_at: null });
    expect(row.flags).toContain(LOG_AGAIN_FLAG);
    // the "Org62 check" line is the read side's: never written back as a flag
    expect((row.flags ?? []).some((f) => f.startsWith(ORG62_CHECK_PREFIX))).toBe(false);
  });

  it('TL-32 a meeting rescheduled after approve: the row is re-keyed and moves; no stale row, no new proposal', async () => {
    await approve(keyOf('m4', '12:00'));
    const id = (await rowOf(keyOf('m4', '12:00')))!.id;
    await insert({ ...meeting('m4', 'ACME check-in', '16:00', '16:30'), changedAt: '2026-11-06T15:20:00.000Z' });
    expect((await project()).errors).toEqual([]);
    const moved = (await rowOf(keyOf('m4', '16:00')))!;
    expect(moved).toMatchObject({ id, status: 'approved' });
    expect(new Date(moved.starts_at).toISOString()).toBe(at('16:00'));
    expect(await rowOf(keyOf('m4', '12:00'))).toBeUndefined();
    expect((await q<{ n: number }>(sql`select count(*)::int as n from activity_entries where owner_user_id = ${userId} and dedupe_key like 'cal|primary|m4|%'`))[0]!.n).toBe(1);
  });

  it('TL-44 concurrent passes over one week: the per-week lock serialises them; no error, no duplicate row', async () => {
    const before = (await q<{ n: number }>(sql`select count(*)::int as n from activity_entries where owner_user_id = ${userId}`))[0]!.n;
    const runs = await Promise.all([0, 1, 2].map(() => recomputeWeeks({ store: projectionStore(db), userId, days: ['2026-11-05'], now: NOW })));
    expect(runs.flatMap((r) => r.errors)).toEqual([]);
    expect((await q<{ n: number }>(sql`select count(*)::int as n from activity_entries where owner_user_id = ${userId}`))[0]!.n).toBe(before);
    const dupes = await q<{ k: string }>(sql`select dedupe_key as k from activity_entries where owner_user_id = ${userId} group by dedupe_key having count(*) > 1`);
    expect(dupes).toEqual([]);
  });

  it('TL-25 / TL-06 an edit unstages a held row; a held row logged by hand before Apply: Apply refuses, and with nothing left the item is discarded', async () => {
    const s = await call('getSettings');
    await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: s.time.version, value: { logging: { ...s.time.logging, org62RecordTypeId: '012XX0000000RTYAAA' } } } });
    await approve(keyOf('m5', '13:00'));
    await approve(keyOf('m6', '14:30'));
    const m5 = (await rowOf(keyOf('m5', '13:00')))!.id;
    const m6 = (await rowOf(keyOf('m6', '14:30')))!.id;
    const b = await call('stageLogBatch', { body: {} });
    const draftId = b.entity.draftIds[0];
    const held = await call('getDraft', { params: { id: draftId } });
    expect(canvasInputOf(held.destination).eventIds).toEqual(expect.arrayContaining([m5, m6, m3]));
    // TL-25: an edit to a held row unstages it
    const t = await call('getTime', { query: { week: '2026-11-05' } });
    const e6 = t.entries.find((x: any) => x.id === m6);
    await call('patchActivity', { params: { id: m6 }, body: { ifVersion: e6.version, patch: { description: 'ACME workshop prep (agenda)' } } });
    const after = await call('getDraft', { params: { id: draftId } });
    expect(canvasInputOf(after.destination).eventIds).not.toContain(m6);
    expect(canvasInputOf(after.destination).markdown).not.toContain(`CC#${m6}`);
    // TL-06: the other rows are logged by hand before Apply
    const m4 = (await rowOf(keyOf('m4', '16:00')))!.id;
    await exec(sql`update activity_entries set status = 'verified', logged_at = now(), verified_at = now() where id in (${m5}::uuid, ${m3}::uuid, ${m4}::uuid)`);
    const p = await call('previewDraft', { params: { id: draftId }, body: { mode: 'send' } });
    const err = await call('dispatchDraft', { params: { id: draftId }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } }).catch((x: unknown) => x as Error);
    expect((err as Error).message).toMatch(/^Nothing left to log on this canvas: 3 rows left out/);
    const gone = await call('getDraft', { params: { id: draftId } });
    expect(gone.status).toBe('discarded');
    expect((await q<{ n: number }>(sql`select count(*)::int as n from draft_send_attempts where draft_id = ${draftId}::uuid`))[0]!.n).toBe(0);
  });

  it('TL-24 a canvas never applied for 14 days expires with a notice; its rows go on the next batch', async () => {
    const b = await call('stageLogBatch', { body: {} });
    const draftId = b.entity.draftIds[0];
    expect(draftId).toBeTruthy();
    const n = await sweepStaleCanvases(db, userId, { now: new Date(Date.now() + 15 * 86_400_000) });
    expect(n).toBe(1);
    const d = await call('getDraft', { params: { id: draftId } });
    expect(d).toMatchObject({ status: 'discarded', rejectedReason: EXPIRED_CANVAS_REASON });
    const ev = (await q<{ n: number }>(sql`select count(*)::int as n from app_events where owner_user_id = ${userId} and code = 'expired_canvases' and resolved_at is null`))[0]!.n;
    expect(ev).toBe(1);
  });

  it('B3: a canvas whose last Apply may have created it (no answer) never expires: it keeps its rows until you check', async () => {
    const b = await call('stageLogBatch', { body: {} });
    const draftId = b.entity.draftIds[0];
    expect(draftId).toBeTruthy();
    await exec(sql`update drafts set status = 'failed' where id = ${draftId}::uuid`);
    await exec(sql`insert into draft_send_attempts (draft_id, attempt_no, dry_run, adapter, request_hash, status, error_code) values (${draftId}::uuid, 1, false, 'slack_canvas:send', 'h', 'unknown', 'outcome_unknown')`);
    expect(await sweepStaleCanvases(db, userId, { now: new Date(Date.now() + 15 * 86_400_000) })).toBe(0);
    expect((await call('getDraft', { params: { id: draftId } })).status).toBe('failed');
    await exec(sql`update drafts set status = 'rejected' where id = ${draftId}::uuid`);
  });

  it('TL-42 every read-back batch fails (token expired): the run fails, Health degrades, nothing is inferred', async () => {
    const fails = (async () => ({ text: null, code: 'auth_expired', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, model: 'claude-haiku-5-5', started: true }) as OneLookupResult) as typeof runOneReadLookup;
    const before = (await q<{ n: number }>(sql`select coalesce((select consecutive_failures from connectors where owner_user_id = ${userId} and kind = 'org62' limit 1), 0)::int as n`))[0]!.n;
    const jobId = (await enqueueJob(db, { ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, maxAttempts: 1 })).id;
    const res = await runOrg62Readback(ctxFor(jobId, NOW), { lookup: fails, live: true });
    expect(res).toMatchObject({ failed: 'auth', eventsDeleted: 0, recorded: 0 });
    expect(res.failedBatches).toBe(res.lookups);
    const [run] = await q<{ status: string; error_code: string }>(sql`select status::text as status, error_code from scan_runs where job_id = ${jobId}`);
    expect(run).toMatchObject({ status: 'failed', error_code: 'auth' });
    expect((await q<{ n: number }>(sql`select c.consecutive_failures as n from scan_runs r join connectors c on c.id = r.connector_id where r.job_id = ${jobId}`))[0]!.n).toBe(before + 1);
    // nothing inferred: no Event marked deleted, the verified row stays verified
    expect((await q<{ n: number }>(sql`select count(*)::int as n from org62_events where owner_user_id = ${userId} and deleted_upstream_at is not null and org62_event_id <> '00UXX0000000R04AAA'`))[0]!.n).toBe(0);
    expect(await byId(m1)).toMatchObject({ status: 'verified' });
    // and the job fails too (its handler throws with the class), so the queue says so as well
    const job2 = (await enqueueJob(db, { ownerUserId: userId, kind: ORG62_READBACK_JOB, queue: 'maintenance', payload: {}, maxAttempts: 1 })).id;
    await expect(org62ReadbackJobDef({ lookup: fails, live: true }).handler(ctxFor(job2, NOW))).rejects.toThrow(/every Org62 read-back batch failed/);
  });
});
