/**
 * Use cases to add on Postgres 17 through the real path: source items as the scanners store them → the
 * `use_cases.extract` job (rules, then the model for the unsure ones through a cassette, under the spend governor) →
 * use_case_candidates → the routes (contract-validated) → Accept / Reject / Undo → the logging canvas and the reads.
 *
 *   the table     columns, checks, the audit trigger; pg_trgm's similarity() agrees with the engine's
 *   extract       a customer note's use case lands on its meeting's opp with evidence; the internal note's never; the
 *                 unsure sentence goes to the model (one booked llm_calls row keyed by the cassette's hash, a settled
 *                 spend hold) and comes back worded by it (basis ai)
 *   accept        BOTH drafts: the VDP create_use_case Outbox item (ready; nothing dispatched) and the Org62 row on the
 *                 next logging canvas (CC-UC#cand-<id>); Undo restores the candidate and removes the item
 *   reject        why is recorded; a wrong-opp reject with the right opp is a correction (mapping_rules +
 *                 attribution_outcomes, in the decision's change set, reverted by Undo)
 *   landing       the Org62 read and the VDP mirror find it → landed with both ids
 *
 * Own database: control_center_usecases_<CC_TEST_DB_SUFFIX>, created and dropped per run. Placeholder data only;
 * nothing is sent anywhere (the model is a cassette, the canvas is never applied).
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attributionSettingsOf, routes, type RouteDef, type RouteKey, type Seed } from '../../../src/contract';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../../src/connectors/vdp/parse';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { enqueueJob } from '../../../src/db/queue';
import { confirmRequest, EXTRACT_USE_CASES_VERSION } from '../../../src/engines/use-cases/confirm';
import { mentionsOf } from '../../../src/engines/use-cases/mentions';
import { trigramSimilarity } from '../../../src/engines/use-cases/similar';
import type { UcSource } from '../../../src/engines/use-cases/types';
import { runUseCasesExtract } from '../../../src/jobs/handlers/use-cases-extract';
import type { JobContext } from '../../../src/jobs/types';
import { NO_HOLDS } from '../../../src/lib/canvas/payload';
import type { VdpSnapshot } from '../../../src/lib/vdp/types';
import { SCANNER_MODEL } from '../../../src/llm/models';
import { redactText } from '../../../src/llm/redact';
import { cassetteHash, cassetteModel } from '../../../src/scanner/completion/cassette';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { dbSpendGovernor } from '../../../src/server/datasource/db/spend';
import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';
import { fixture } from '../../vdp/helpers';

const NAME = `control_center_usecases_${testDbSuffix}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_USE_CASES_DB !== '0';

const OPP = '006PLACEHOLDER0UCA';
const ACC = '001PLACEHOLDER0UCA';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let oppId: string;
let otherOppId: string;
let acme: VdpSnapshot;

const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await handle.db.execute<T>(s)).rows;
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
/** A job context on a real `jobs` row (llm_calls.job_id references it). */
async function jobCtx(at: Date): Promise<JobContext> {
  const id = (await enqueueJob(handle.db, { ownerUserId: userId, kind: 'use_cases.extract', queue: 'maintenance', payload: { trigger: 'test' }, maxAttempts: 1 })).id;
  return ctxFor(id, at);
}
function ctxFor(id: number, at: Date): JobContext {
  return { job: { id, ownerUserId: userId, kind: 'use_cases.extract', queue: 'maintenance', payload: { trigger: 'test' }, attempts: 1, maxAttempts: 1, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db: handle.db, userId, clock: () => at, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}

const NOTE = '## Summary\nDiscovery with the customer service leads. Dana wants a working demo of order status tracking before the steering committee. Dana asked for follow-up question support in the chat.\n## Decisions\n- Order status first';
const INTERNAL = '## Summary\nWe want to build a demo kit for the team and plan to automate the weekly report.';

async function insertItem(key: string, title: string, body: string, participants: Array<{ email: string; isExternal: boolean }>, at: Date) {
  const hash = createHash('sha1').update(body).digest('hex').slice(0, 16);
  const r = await q<{ id: string }>(sql`
    insert into source_items (owner_user_id, source, kind, external_id, dedupe_key, content_hash, occurred_at, title, url, body, from_me, meta)
    values (${userId}, 'gemini_notes', 'gemini_note', ${key}, ${`gemini|${key}`}, ${hash}, ${at.toISOString()}::timestamptz, ${title}, ${`https://docs.example.com/document/d/${key}`}, ${body}, false,
            ${JSON.stringify({ connector: 'gemini_notes', itemKind: 'meeting_notes', participants })}::jsonb)
    returning id`);
  return r[0]!.id;
}

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_usecases_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'use-cases-test' });
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
  // one open opp of mine on an account with another open opp: placeholder Org62 ids, and a meeting on it
  const r = await q<{ id: string; account_id: string; other: string }>(sql`
    select o.id, o.account_id, (select o2.id from opportunities o2 where o2.account_id = o.account_id and o2.id <> o.id and not o2.is_closed limit 1) as other
      from opportunities o where o.owner_user_id = ${userId} and not o.is_closed and o.on_my_team and o.account_id is not null
       and exists (select 1 from opportunities o2 where o2.account_id = o.account_id and o2.id <> o.id and not o2.is_closed)
     order by o.created_at limit 1`);
  oppId = r[0]!.id;
  otherOppId = r[0]!.other;
  const noteId = await insertItem('ucnote1', 'Customer discovery - Notes by Gemini', NOTE, [{ email: 'dana.reyes@acme.example', isExternal: true }, { email: 'jordan.lee@example.com', isExternal: false }], new Date(now.getTime() - 2 * 86_400_000));
  await insertItem('ucnote2', 'SE team stand-up - Notes by Gemini', INTERNAL, [{ email: 'jordan.lee@example.com', isExternal: false }, { email: 'priya.shah@example.com', isExternal: false }], new Date(now.getTime() - 86_400_000));
  await withChangeSet({ db: handle.db, userId, actor: actors.system('use-cases-test'), reason: 'test fixture' }, async (tx) => {
    await tx.execute(sql`update opportunities set org62_opportunity_id = ${OPP} where id = ${oppId}`);
    await tx.execute(sql`update accounts set org62_account_id = ${ACC} where id = ${r[0]!.account_id}`);
    const ev = (await tx.execute<{ id: string }>(sql`select id from calendar_events where owner_user_id = ${userId} order by starts_at limit 1`)).rows[0]!.id;
    await tx.execute(sql`update calendar_events set opportunity_id = ${oppId}, account_id = ${r[0]!.account_id} where id = ${ev}`);
    await tx.execute(sql`insert into meeting_notes (owner_user_id, calendar_event_id, source_item_id, kind, arrived_at) values (${userId}, ${ev}, ${noteId}, 'gemini_notes', ${now.toISOString()}::timestamptz)`);
  });
  const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
  acme = { ...withUseCaseDetail(parseGetVdp(fixture('get_vdp_acme'))!, details), salesforceOpportunityId: OPP.slice(0, 15), salesforceOpportunityIds: [OPP.slice(0, 15)], salesforceAccountId: ACC.slice(0, 15) };
  await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: now.toISOString() });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  await dropDb(NAME);
});

/** The one unsure sentence of the note, and the request the job sends for it (what the cassette is keyed by). */
async function expectedRequest() {
  const src: UcSource = { kind: 'gemini_note', key: 'k', sourceItemIds: [], title: 'Customer discovery', text: NOTE, at: now.toISOString(), url: null, externalEmails: ['dana.reyes@acme.example'], externalDomains: ['acme.example'] };
  const unsure = [...mentionsOf([src]).unsure.values()].flat();
  expect(unsure.map((m) => m.title)).toEqual(['Follow-up question support in the chat']);
  const products = attributionSettingsOf((await call('getSettings')).time).dcProducts;
  return confirmRequest(unsure.map((m) => ({ statement: redactText(m.statement) })), products);
}

describe.runIf(PG)('use cases to add on Postgres', () => {
  it('the table: checks, the audit trigger; pg_trgm agrees with the engine’s similarity', async () => {
    const trg = await q<{ tbl: string }>(sql`select c.relname as tbl from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.proname = 'cc_audit' and c.relname = 'use_case_candidates'`);
    expect(trg).toHaveLength(1);
    const chk = await q<{ conname: string }>(sql`select conname from pg_constraint where conrelid = 'use_case_candidates'::regclass and contype = 'c' order by conname`);
    expect(chk.map((c) => c.conname)).toEqual(['use_case_candidates_reject_reason_chk', 'use_case_candidates_source_chk', 'use_case_candidates_status_chk', 'use_case_candidates_track_chk']);
    for (const [a, b] of [['Order status', 'Order Status Agent'], ['Claims status lookup', 'Claim status'], ['Fraud agent', 'Customer 360 for Risk'], ['unified member profile', 'Unified Member Profile']]) {
      const [{ s }] = await q<{ s: string }>(sql`select similarity(${a}, ${b})::text as s`);
      expect(trigramSimilarity(a, b), `${a} ~ ${b}`).toBeCloseTo(Number(s), 2);
    }
  });

  it('extract: the customer note’s use cases on its meeting’s opp; the internal note’s never; the model only for the unsure one', async () => {
    const req = await expectedRequest();
    const hash = cassetteHash({ model: SCANNER_MODEL, system: req.system, user: req.user }, EXTRACT_USE_CASES_VERSION);
    const tape = cassetteModel({ skill: EXTRACT_USE_CASES_VERSION, entries: [{ hash, label: 'unsure', origin: 'hand', text: '{"items":[{"i":1,"useCase":true,"title":"Follow-up questions in chat","problem":"Answer follow-up questions in the chat","product":"Agentforce","outcome":""}]}' }] });
    // a recorded answer that cost something when it was made: book it as a live call would (the cassette replays at 0)
    const model = async (r: Parameters<typeof tape.model>[0]) => ({ ...(await tape.model(r)), costUsd: 0.0004, inputTokens: 300, outputTokens: 60 });
    const res = await runUseCasesExtract(await jobCtx(now), { model, spend: dbSpendGovernor({ db: handle.db, userId, clock: () => now }) });
    expect(res).toMatchObject({ created: 2, calls: 1 });
    expect(tape.misses).toEqual([]);
    const p = await call('getUseCaseCandidates');
    const order = p.candidates.find((c: any) => c.title === 'Order status tracking');
    expect(order).toMatchObject({ oppId, needsPick: false, basis: 'rules', source: 'gemini_note' });
    expect(order.evidence[0].quote).toMatch(/working demo of order status tracking/);
    expect(order.sends).toMatch(/VDP item under acme-fy27-q4 and an Org62 row/);
    const ai = p.candidates.find((c: any) => c.title === 'Follow-up questions in chat');
    expect(ai).toMatchObject({ basis: 'ai', products: expect.arrayContaining(['Agentforce']) });
    expect(p.candidates.some((c: any) => /demo kit|weekly report/i.test(c.title))).toBe(false);
    // booked once, keyed by the cassette's hash, under one settled hold
    const calls = await q<{ skill_key: string; content_hash: string; cost_usd: string; purpose: string }>(sql`select skill_key, content_hash, cost_usd::text, purpose::text from llm_calls where owner_user_id = ${userId} and skill_key = 'extract-use-cases'`);
    expect(calls).toEqual([{ skill_key: 'extract-use-cases', content_hash: hash, cost_usd: expect.stringMatching(/^0\.0004/), purpose: 'classify' }]);
    const holds = await q<{ scope: string; state: string }>(sql`select scope, state from spend_holds where user_id = ${userId} and job_key like 'use_cases.extract:%'`);
    expect(holds).toEqual([{ scope: 'job', state: 'settled' }]);
    // a second pass adds nothing new (deduped by key) and makes no second call for the same notes' sure part
    const again = await runUseCasesExtract(await jobCtx(now), {});
    expect(again).toMatchObject({ created: 0 });
  });

  it('accept drafts BOTH: the VDP item (ready, nothing sent) and the Org62 row on the next canvas; Undo restores it', async () => {
    const c = (await call('getUseCaseCandidates')).candidates.find((x: any) => x.title === 'Order status tracking');
    const r = await call('decideUseCaseCandidate', { params: { id: c.id }, body: { decision: 'accept' } });
    expect(r.entity).toMatchObject({ org62Staged: true, candidate: { status: 'accepted', vdp: 'staged', org62: 'staged', vdpSlug: 'acme-fy27-q4' } });
    const [d] = await q<{ status: string; action: string; sends: string }>(sql`
      select d.status::text as status, d.payload ->> 'action' as action, (select count(*)::text from draft_send_attempts a where a.draft_id = d.id) as sends from drafts d where d.id = ${r.entity.vdpDraftId}::uuid`);
    expect(d).toEqual({ status: 'ready', action: 'vdp.create_use_case', sends: '0' });
    const b = await buildLogBatch(handle.db, userId, { now, timezone: 'America/Los_Angeles', recordTypeId: '012XX0000000RTYAAA', approveComplete: false, held: NO_HOLDS });
    const md = b.canvases.map((x) => x.markdown).join('\n');
    expect(md).toContain(`CC-UC#cand-${c.id}`);
    expect(md).toContain('|Order status tracking|');
    // Undo: the candidate waits again and the VDP item is gone
    await call('undoAudit', { params: { id: r.auditId }, body: {} });
    expect((await call('getUseCaseCandidates')).candidates.find((x: any) => x.id === c.id)?.status).toBe('suggested');
    expect(await q(sql`select id from drafts where id = ${r.entity.vdpDraftId}::uuid`)).toEqual([]);
  });

  it('reject: why is recorded; wrong opp with the right one is a correction the engine learns (Undo reverts it)', async () => {
    const c = (await call('getUseCaseCandidates')).candidates.find((x: any) => x.title === 'Follow-up questions in chat');
    // the learned rules' state: every rule's key, target and counts (a correction adds or changes rows)
    const rules = async () => (await q<{ s: string }>(sql`select coalesce(string_agg(kind::text || ':' || pattern || '>' || coalesce(account_id::text, '') || '/' || coalesce(opportunity_id::text, '') || '#' || hit_count || '-' || miss_count, ',' order by kind::text, pattern), '') as s from mapping_rules where owner_user_id = ${userId}`))[0]!.s;
    const before = await rules();
    const r = await call('decideUseCaseCandidate', { params: { id: c.id }, body: { decision: 'reject', reason: 'wrong_opp', oppId: otherOppId } });
    expect(r.entity.candidate).toMatchObject({ status: 'edited', oppId: otherOppId });
    const out = await q<{ outcome: string; chosen_target: string; rule_ids: string[] }>(sql`select outcome, chosen_target, rule_ids from attribution_outcomes where owner_user_id = ${userId} and subject_kind = 'use_case_candidate' and subject_id = ${c.id}`);
    expect(out).toMatchObject([{ outcome: 'edit', chosen_target: otherOppId }]);
    expect(out[0]!.rule_ids.length).toBeGreaterThan(0);
    expect(await rules()).not.toBe(before);
    expect(await rules()).toMatch(/domain_to_account:acme\.example>/); // the customer's domain → the account (domain rules name accounts)
    await call('undoAudit', { params: { id: r.auditId }, body: {} });
    expect(await rules()).toBe(before);
    const no = await call('decideUseCaseCandidate', { params: { id: c.id }, body: { decision: 'reject', reason: 'not_use_case' } });
    expect(no.entity.candidate).toMatchObject({ status: 'rejected', rejectReason: 'not_use_case' });
  });

  it('landing: the Org62 read and the VDP mirror find it → landed with both ids', async () => {
    const c = (await call('getUseCaseCandidates')).candidates.find((x: any) => x.title === 'Order status tracking');
    await call('decideUseCaseCandidate', { params: { id: c.id }, body: { decision: 'accept' } });
    await withChangeSet({ db: handle.db, userId, actor: actors.system('use-cases-test'), reason: 'the reads' }, async (tx) => {
      await tx.execute(sql`insert into org62_use_cases (owner_user_id, org62_use_case_id, org62_opportunity_id, org62_account_id, name, product, stage, owner_org62_id) values (${userId}, 'a1XXX0000000UCZAAA', ${OPP}, ${ACC}, 'Order status tracking', 'Agentforce', 'U03 - Scoping', '005XX0000000OWNAAA')`);
    });
    await saveVdpMirror(handle.db, userId, { snapshots: [{ ...acme, useCases: [...acme.useCases, { ...acme.useCases[0]!, id: 'bbbbbbb1-0000-4000-8000-000000000009', title: 'Order status tracking', displayOrder: 9 }] }], complete: true, readAt: now.toISOString() });
    await runUseCasesExtract(await jobCtx(now), {});
    const done = (await call('getUseCaseCandidates')).decided.find((x: any) => x.id === c.id);
    expect(done).toMatchObject({ status: 'landed', org62UseCaseId: 'a1XXX0000000UCZAAA', vdpUseCaseId: 'bbbbbbb1-0000-4000-8000-000000000009', org62: 'landed', vdp: 'landed' });
  });
});
