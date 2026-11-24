/**
 * Specialist Forecast (lane A) against Postgres 17: the `specialist_forecasts` mirror (an idempotent upsert that keeps
 * the previous note and never touches the review state), the `forecast.sync` job over a fake read-only lookup (the
 * pinned SOQL only, note age from History, linked to the app's opp and account, spend recorded), the job skipping
 * when the persona feature is not active, the `forecast.draft` job with a fake agent ($0.25 cap, a spend line), and
 * the db DataSource's routes: approve → ONE canvas → a second stage stages nothing → Apply (dry run) → the payload →
 * a sync after the canvas that still shows the old note flags it as not landed.
 *
 * Own database: control_center_forecast_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder fixtures only.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import type { Seed } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { enqueueJob } from '../../../src/db/queue';
import { runMigrations } from '../../../src/db/migrate';
import { LAND_GRACE_MS } from '../../../src/engines/forecast/view';
import { runForecastDraftJob, runForecastSyncJob } from '../../../src/jobs/handlers/forecast-sync';
import type { JobContext } from '../../../src/jobs/types';
import type { ResearchAgent } from '../../../src/llm/readin/agent';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { sfrNotesHistorySoql, sfrRecordsForOppSoql, sfrRecordsSoql, type Org62Sfr } from '../../../src/server/forecast/soql';
import { loadForecastRecords, saveForecastMirror } from '../../../src/server/forecast/store';
import type { OneLookupResult, runOneReadLookup } from '../../../src/server/onboarding/identity';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_forecast_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_FORECAST_DB !== '0';

const OWNER = '005XX0000000OWNAAA';
const DAY = 86_400_000;
let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let opp: { id: string; accountId: string };

const sfr = (n: number, x: Partial<Org62Sfr> = {}): Org62Sfr => ({
  org62Id: `aDdXX00000TST${String(n).padStart(2, '0')}AAA`,
  name: `SF-${n}`,
  // 18 characters; the app's opp holds the 15-character form of the first
  org62OpportunityId: `006XX0000OPP0${String(n).padStart(2, '0')}AAA`,
  opportunityName: `Placeholder opp ${n}`,
  org62AccountId: null,
  accountName: 'Placeholder Co',
  oppStage: 'Negotiation',
  oppNextStep: 'Send the order form',
  oppCloseDate: '2026-12-15',
  notes: `Compelling event: placeholder ${n} · In quarter: yes · Next step: order form · Risk: none`,
  mgrNotes: 'Core AE: budget confirmed.',
  dealRole: n === 2 ? 'None' : 'Lead',
  judgement: 'IN',
  forecastStatus: 'Commit',
  amount: 500_000 - n * 1000,
  stage: '05 - Negotiating $$ & Mutual Plan',
  closeDate: '2026-12-15',
  fiscalQuarter: 'FY27 Q4',
  ownerOrg62Id: OWNER,
  lastModifiedAt: '2026-11-01T12:00:00.000Z',
  ...x,
});

/** The Org62 soqlQuery output for a page of records. */
const page = (rows: Org62Sfr[]) =>
  JSON.stringify({
    totalSize: rows.length,
    done: true,
    records: rows.map((r) => ({
      Id: r.org62Id,
      Name: r.name,
      Opportunity__c: r.org62OpportunityId,
      Opportunity__r: { Name: r.opportunityName, AccountId: r.org62AccountId, Account: { Name: r.accountName }, StageName: r.oppStage, NextStep: r.oppNextStep, CloseDate: r.oppCloseDate },
      ForecastNotes__c: r.notes,
      MgrForecastNotes__c: r.mgrNotes,
      Deal_Role__c: r.dealRole,
      Management_Forecast_Judgement__c: r.judgement,
      ForecastStatus__c: r.forecastStatus,
      ForecastAmount__c: r.amount,
      ForecastStage__c: r.stage,
      ForecastCloseDate__c: r.closeDate,
      FiscalQuarter__c: r.fiscalQuarter,
      OwnerId: r.ownerOrg62Id,
      LastModifiedDate: r.lastModifiedAt?.replace('Z', '+0000'),
    })),
  });

function fakeLookup(rows: () => Org62Sfr[], history: () => Array<[string, string]>) {
  const calls: Array<{ connector: string; tool: string; q: string; skill: string | undefined }> = [];
  const fn = (async (look, o) => {
    const q = String(look.args.q);
    calls.push({ connector: look.connector, tool: look.tool, q, skill: o?.skillPath });
    const ok = (text: string): OneLookupResult => ({ text, code: 'ok', message: '', costUsd: 0.002, inputTokens: 100, outputTokens: 5, model: 'claude-haiku-5-5', started: true });
    if (q.includes('FROM SpecialistForecast__History')) return ok(JSON.stringify({ records: history().map(([id, at]) => ({ ParentId: id, lastAt: at.replace('Z', '+0000') })) }));
    const all = rows();
    const after = /Id > '([^']+)'/.exec(q)?.[1] ?? null;
    return ok(page(all.filter((r) => !after || r.org62Id > after).slice(0, 25)));
  }) as typeof runOneReadLookup;
  return { fn, calls };
}

/** A real jobs row (llm_calls.job_id references it). */
async function jobId(kind: string, payload: Record<string, unknown>): Promise<number> {
  const r = await enqueueJob(handle.db, { ownerUserId: userId, kind, queue: 'forecast', payload, maxAttempts: 1 });
  return r.id;
}

/** What the worker does after a handler returns: the job is no longer queued (so nothing reads as drafting). */
async function finishJobs(): Promise<void> {
  await handle.db.execute(sql`update jobs set status = 'succeeded', finished_at = now() where kind like 'forecast.%' and status = 'queued'`);
}

function ctxFor(kind: string, payload: Record<string, unknown>, id = 1): JobContext {
  return { job: { id, ownerUserId: userId, kind, queue: 'forecast', payload, attempts: 1, maxAttempts: 1, timeoutSeconds: 300, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db: handle.db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}

async function setPersona(id: 'ae' | 'se') {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { id } } } as never);
}

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_forecast_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'forecast-test' });
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
  const r = await handle.db.execute<{ id: string; account_id: string }>(sql`select id, account_id from opportunities where owner_user_id = ${userId} and not is_closed order by created_at limit 1`);
  opp = { id: r.rows[0]!.id, accountId: r.rows[0]!.account_id };
  await withChangeSet({ db: handle.db, userId, actor: actors.system('forecast-test'), reason: 'test fixture: placeholder Org62 ids' }, async (tx) => {
    await tx.execute(sql`update opportunities set org62_opportunity_id = '006XX0000OPP001' where id = ${opp.id}`);
    await tx.execute(sql`insert into person_identities (owner_user_id, person_id, system, external_id, method)
                         select ${userId}, u.person_id, 'org62_user', ${OWNER}, 'user' from users u where u.id = ${userId}
                         and not exists (select 1 from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user')`);
  });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

describe.runIf(PG)('Specialist Forecast (db)', () => {
  it('the mirror upsert is idempotent, keeps the previous note and never touches the review state', async () => {
    const readAt = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    const hist = new Map([[sfr(1).org62Id, '2026-10-20T12:00:00.000Z']]);
    const a = await saveForecastMirror(handle.db, userId, { rows: [sfr(1), sfr(2)], history: hist, complete: true, readAt });
    expect(a).toMatchObject({ inserted: 2, updated: 0, gone: 0, linked: 1 });
    const first = await loadForecastRecords(handle.db, userId);
    const b = await saveForecastMirror(handle.db, userId, { rows: [sfr(1), sfr(2)], history: hist, complete: true, readAt });
    expect(b).toMatchObject({ inserted: 0, updated: 2, gone: 0 });
    expect(await loadForecastRecords(handle.db, userId)).toEqual(first);
    expect((await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from specialist_forecasts`)).rows[0]!.n).toBe(2);
    const one = first.find((r) => r.org62Id === sfr(1).org62Id)!;
    // linked by the 15-character Org62 opp id to the app's opp and its account; note age from History
    expect(one).toMatchObject({ opportunityId: opp.id, accountId: opp.accountId, notesUpdatedAt: '2026-10-20T12:00:00.000Z', prevNotes: null, url: expect.stringContaining('/lightning/r/SpecialistForecast__c/aDdXX00000TST01AAA/view') });

    // a review state survives a read; a changed note keeps the one before it; a history that failed keeps the age
    await handle.db.execute(sql`update specialist_forecasts set pending = ${JSON.stringify({ notes: { text: 'mine', state: 'drafted', origin: 'manual', at: readAt, basedOnNotesAt: null } })}::jsonb where org62_id = ${sfr(1).org62Id}`);
    await saveForecastMirror(handle.db, userId, { rows: [sfr(1, { notes: 'Compelling event: changed' }), sfr(2)], history: null, complete: true, readAt });
    const after = (await loadForecastRecords(handle.db, userId)).find((r) => r.org62Id === sfr(1).org62Id)!;
    expect(after).toMatchObject({ notes: 'Compelling event: changed', prevNotes: sfr(1).notes, notesUpdatedAt: '2026-10-20T12:00:00.000Z', pending: { notes: { text: 'mine' } } });
    // the same read again does not move the previous note
    await saveForecastMirror(handle.db, userId, { rows: [sfr(1, { notes: 'Compelling event: changed' }), sfr(2)], history: hist, complete: true, readAt });
    expect((await loadForecastRecords(handle.db, userId)).find((r) => r.org62Id === sfr(1).org62Id)!.prevNotes).toBe(sfr(1).notes);
    // a complete read that no longer lists a record marks it gone (kept, never deleted); an incomplete one never does
    await saveForecastMirror(handle.db, userId, { rows: [sfr(1)], history: hist, complete: false, readAt });
    expect((await loadForecastRecords(handle.db, userId)).every((r) => !r.goneAt)).toBe(true);
    const c = await saveForecastMirror(handle.db, userId, { rows: [sfr(1)], history: hist, complete: true, readAt });
    expect(c.gone).toBe(1);
    await handle.db.execute(sql`delete from specialist_forecasts`);
  });

  it('forecast.sync skips while the feature is not active for the persona (SE)', async () => {
    const l = fakeLookup(() => [sfr(1)], () => []);
    const r = await runForecastSyncJob(ctxFor('forecast.sync', {}), { lookup: l.fn });
    expect(r).toMatchObject({ skipped: 'inactive' });
    expect(l.calls).toEqual([]);
    expect((await ds.getForecast({} as never)).active).toBe(false);
  });

  it('forecast.sync reads with the pinned SOQL only, pages by Id, and mirrors the records with History note ages', async () => {
    await setPersona('ae');
    const rows = Array.from({ length: 27 }, (_, i) => sfr(i + 1));
    rows.push(sfr(40, { ownerOrg62Id: '005XX0000OTHER0AAA' })); // someone else's: never mirrored
    const hist: Array<[string, string]> = [[sfr(1).org62Id, new Date(now.getTime() - 13 * DAY).toISOString()]];
    const l = fakeLookup(() => rows, () => hist);
    const r = await runForecastSyncJob(ctxFor('forecast.sync', {}, await jobId('forecast.sync', {})), { lookup: l.fn });
    await finishJobs();
    expect(r).toMatchObject({ records: 27, inserted: 27, pages: 2, history: 1, quarters: ['FY27 Q4', 'FY28 Q1'] });
    expect(l.calls.map((c) => [c.connector, c.tool, c.skill])).toEqual(Array(3).fill(['org62', 'soqlQuery', 'skills/read-lookup.md']));
    expect(l.calls.map((c) => c.q)).toEqual([sfrRecordsSoql(OWNER, ['FY27 Q4', 'FY28 Q1']), sfrRecordsSoql(OWNER, ['FY27 Q4', 'FY28 Q1'], sfr(25).org62Id), sfrNotesHistorySoql(OWNER, ['FY27 Q4', 'FY28 Q1'])]);
    const recs = await loadForecastRecords(handle.db, userId);
    expect(recs).toHaveLength(27);
    expect(recs.find((x) => x.org62Id === sfr(1).org62Id)!.notesUpdatedAt).toBe(hist[0]![1]);
    const spend = (await handle.db.execute<{ n: number; purpose: string }>(sql`select count(*)::int as n, min(purpose::text) as purpose from llm_calls where skill_key = 'forecast-sync'`)).rows[0]!;
    expect(spend).toEqual({ n: 3, purpose: 'other' });
    // jobs.result: counts and codes only
    expect(JSON.stringify(r)).not.toMatch(/Placeholder|order form/);
    // keep a small set for the routes below
    await handle.db.execute(sql`delete from specialist_forecasts where org62_id not in (${sfr(1).org62Id}, ${sfr(2).org62Id})`);
  });

  it('caps audit: a book past 200 records is read whole (was 8 pages, then a partial read)', async () => {
    const p3 = (i: number) => String(i).padStart(3, '0');
    // the two records the routes below use stay in the read (a whole read marks what it did not see as gone)
    const rows = [sfr(1), sfr(2), ...Array.from({ length: 230 }, (_, i) => sfr(1, { org62Id: `aDdXX0000TST${p3(i)}AAA`, name: `SF-${i}`, org62OpportunityId: `006XX0000OPP${p3(i)}AAA` }))];
    const l = fakeLookup(() => rows, () => []);
    const r = await runForecastSyncJob(ctxFor('forecast.sync', {}, await jobId('forecast.sync', {})), { lookup: l.fn });
    await finishJobs();
    expect(r).toMatchObject({ records: 232, pages: 10 });
    expect(r).not.toHaveProperty('partial');
    await handle.db.execute(sql`delete from specialist_forecasts where org62_id not in (${sfr(1).org62Id}, ${sfr(2).org62Id})`);
  });

  it('forecast.draft writes a drafted note within the $0.25 cap and records the spend; not live → the placeholder', async () => {
    const rec = (await loadForecastRecords(handle.db, userId)).find((x) => x.org62Id === sfr(1).org62Id)!;
    let cap = 0;
    const agent: ResearchAgent = {
      run: async (input) => {
        cap = input.costCapUsd;
        const bad = await input.local!.call!('notes_finish', { notes: 'Compelling event: placeholder go-live · In quarter: yes', sources: [{ source: 'slack', label: '#acct-placeholder', url: 'https://example.slack.com/archives/C0PLACEHOLDER/p1' }], changed: 'x' });
        expect(bad.isError).toBe(true); // a link the run was never shown
        await input.local!.call!('notes_finish', { notes: 'Compelling event: placeholder go-live · In quarter: yes, paper started · Next step (core AE, Fri): order form · Risk: none new', sources: [{ source: 'org62', label: 'Manager notes' }], changed: 'Paper process started' });
        return { ok: true, output: null, costUsd: 0.11, inputTokens: 9000, outputTokens: 300, turns: 3, toolCalls: [] };
      },
    };
    const r = await runForecastDraftJob(ctxFor('forecast.draft', { recordId: rec.id, cap_usd: 0.25 }, await jobId('forecast.draft', { recordId: rec.id })), { agent, google: () => null, external: () => ({ servers: {}, tools: [], unavailable: ['Slack'] }) });
    await finishJobs();
    expect(r).toMatchObject({ drafted: true, costUsd: 0.11 });
    expect(cap).toBeLessThanOrEqual(0.25);
    const after = (await loadForecastRecords(handle.db, userId)).find((x) => x.id === rec.id)!;
    expect(after.pending.notes).toMatchObject({ state: 'drafted', origin: 'model', costUsd: 0.11, basedOnNotesAt: rec.notesUpdatedAt, sources: [{ source: 'org62', label: 'Manager notes' }] });
    const spend = (await handle.db.execute<{ purpose: string; cost: string }>(sql`select purpose::text as purpose, cost_usd::text as cost from llm_calls where skill_key = 'forecast-notes'`)).rows;
    expect(spend).toEqual([{ purpose: 'draft_generate', cost: expect.stringMatching(/^0\.11/) }]);

    const other = (await loadForecastRecords(handle.db, userId)).find((x) => x.org62Id === sfr(2).org62Id)!;
    const p = await runForecastDraftJob(ctxFor('forecast.draft', { recordId: other.id }, 22), { live: false });
    expect(p).toMatchObject({ drafted: true, model: 'placeholder', costUsd: 0 });
    // the persona gate: an SE never drafts
    await setPersona('se');
    expect(await runForecastDraftJob(ctxFor('forecast.draft', { recordId: other.id }, 23), { live: false })).toMatchObject({ skipped: 'inactive' });
    await setPersona('ae');
  });

  it('approve → ONE canvas → a second stage stages nothing → Apply (dry run) → the payload → a later read flags what did not land', async () => {
    const v = await ds.getForecast({} as never);
    expect(v.active).toBe(true);
    const r1 = v.rows.find((x) => x.org62Id === sfr(1).org62Id)!;
    const r2 = v.rows.find((x) => x.org62Id === sfr(2).org62Id)!;
    expect(r1.notes.state).toBe('drafted');
    expect(r2.roleFix).toEqual({ from: 'None', to: 'Aware', approved: false });
    await ds.patchForecast({ params: { id: r1.id }, body: { notes: r1.notes.text!, notesState: 'approved' } } as never);
    await ds.patchForecast({ params: { id: r2.id }, body: { dealRole: 'Aware' } } as never);
    expect((await ds.getForecast({} as never)).counts.ready).toBe(2);

    const s1 = await ds.stageForecast({ body: {} } as never);
    expect(s1.entity).toMatchObject({ notes: 1, roles: 1, deferred: [] });
    const s2 = await ds.stageForecast({ body: {} } as never);
    expect(s2.entity).toMatchObject({ draftId: null, notes: 0, roles: 0, waiting: { updates: 2, draftIds: [s1.entity.draftId] } });
    const canvases = (await ds.getOutbox({} as never)).admin.items.filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action === 'slack_canvas.create');
    expect(canvases.map((i) => i.draft.id)).toEqual([s1.entity.draftId]);

    const prev = await ds.previewDraft({ params: { id: s1.entity.draftId! }, body: {} } as never);
    const out = await ds.dispatchDraft({ params: { id: s1.entity.draftId! }, body: { mode: 'send', confirmToken: (prev as { confirmToken: string }).confirmToken } } as never);
    expect(out.dryRun).toBe(true);
    const payload = out.payload as { tool: string; args: { title: string; content: string } };
    expect(payload.tool).toBe('slack_create_canvas');
    const lines = payload.args.content.split('\n').filter((l) => /^\|\d+\|/.test(l));
    expect(lines).toHaveLength(2);
    // WO-1: both rows sit in the one SPECIALIST FORECASTS TO UPDATE table (#, Record Id, ForecastNotes__c, Deal_Role__c)
    expect(payload.args.content).toMatch(/## SPECIALIST FORECASTS TO UPDATE \(2 rows[^)]*\)/);
    expect(payload.args.content).toContain('|#|Record Id|ForecastNotes__c|Deal_Role__c|');
    expect(payload.args.content.split('\n').filter((l) => /^#{1,3} /.test(l) && / TO (CREATE|UPDATE) /.test(l))).toHaveLength(1);
    expect(payload.args.content).toContain(`User Id ${OWNER}`);
    // the dry run leaves it waiting: still held, still not staged twice
    expect((await ds.stageForecast({ body: {} } as never)).entity.draftId).toBeNull();

    // the canvas was created (Apply, dry run off) and Slackbot ran it except for the note: the next read flags it
    const sentAt = now;
    await withChangeSet({ db: handle.db, userId, actor: actors.system('forecast-test'), reason: 'test: the canvas was created' }, async (tx) => {
      await tx.execute(sql`update drafts set status = 'sent', approved_at = ${sentAt.toISOString()}::timestamptz, approval_method = 'click', approved_content_hash = content_hash, sent_at = ${sentAt.toISOString()}::timestamptz, updated_at = ${sentAt.toISOString()}::timestamptz where id = ${s1.entity.draftId}`);
    });
    // the next read, after Slackbot had time to run it
    now = new Date(now.getTime() + 2 * LAND_GRACE_MS);
    const l = fakeLookup(() => [sfr(1), sfr(2, { dealRole: 'Aware' })], () => [[sfr(1).org62Id, new Date(now.getTime() - 13 * DAY - 2 * LAND_GRACE_MS).toISOString()]]);
    await runForecastSyncJob(ctxFor('forecast.sync', {}, await jobId('forecast.sync', {})), { lookup: l.fn });
    await finishJobs();
    const v2 = await ds.getForecast({} as never);
    const a = v2.rows.find((x) => x.org62Id === sfr(1).org62Id)!;
    const b = v2.rows.find((x) => x.org62Id === sfr(2).org62Id)!;
    expect(a.notes.state).toBe('not_landed');
    expect(b.role.state).toBe('landed');
    expect(b.roleFix).toBeNull();
    expect(v2.counts).toMatchObject({ notLanded: 1, ready: 1 });
    // it can be staged again, into a new canvas
    expect((await ds.stageForecast({ body: {} } as never)).entity).toMatchObject({ notes: 1, roles: 0 });

    // Home ▸ Log & fix carries the AE rows
    const home = await ds.getHome({ query: {} } as never);
    const fix = home.sections.find((s) => s.id === 'fix')!;
    expect(fix.count).toBeGreaterThan(0);
  });

  it('"I created it, check now": a one-opp forecast.sync job for the worker and a full read 30 min later; checking → found', async () => {
    await finishJobs();
    const v0 = await ds.getForecast({} as never);
    const miss = v0.queue.missing[0];
    expect(miss, 'the placeholder seed has an opp with Data 360 work and no record').toBeDefined();
    const ORG62_OPP = '006XX0000OPP009AAA';
    await withChangeSet({ db: handle.db, userId, actor: actors.system('forecast-test'), reason: 'test fixture: placeholder Org62 id' }, async (tx) => {
      await tx.execute(sql`update opportunities set org62_opportunity_id = ${ORG62_OPP} where id = ${miss!.opportunityId}`);
    });
    const before = v0.sync;

    // the web only queues: one job of scope opp (the app's opp id, never an Org62 id from the client) and the follow-up
    const r = await ds.checkMissingForecast({ params: { id: miss!.opportunityId }, body: {} } as never);
    expect(r.entity).toMatchObject({ queued: true, check: { status: 'checking', opportunityId: miss!.opportunityId }, followUpAt: expect.any(String) });
    const jobs = (await handle.db.execute<{ payload: Record<string, unknown>; later: boolean }>(sql`select payload, run_at > now() + interval '20 minutes' as later from jobs where kind = 'forecast.sync' and status = 'queued' order by id`)).rows;
    expect(jobs).toEqual([
      { payload: { scope: 'opp', opportunityId: miss!.opportunityId, trigger: 'missing_check' }, later: false },
      { payload: { trigger: 'missing_check_followup' }, later: true },
    ]);
    // neither is "Syncing…" or a last read; the follow-up is when it reads again
    const v1 = await ds.getForecast({} as never);
    expect(v1.sync).toMatchObject({ status: before.status, lastAt: before.lastAt, nextAt: expect.any(String) });
    expect(v1.queue.missing.find((m) => m.opportunityId === miss!.opportunityId)!.check).toMatchObject({ status: 'checking' });
    // a second click while it waits queues nothing new
    expect((await ds.checkMissingForecast({ params: { id: miss!.opportunityId }, body: {} } as never)).entity.queued).toBe(false);

    // the worker: ONE pinned read of my records on that opp, nothing marked gone
    const l = fakeLookup(() => [sfr(9, { org62OpportunityId: ORG62_OPP, notes: null, dealRole: 'None' })], () => []);
    const id = Number((await handle.db.execute<{ id: string }>(sql`select id from jobs where kind = 'forecast.sync' and payload->>'scope' = 'opp' and status = 'queued' limit 1`)).rows[0]!.id);
    const res = await runForecastSyncJob(ctxFor('forecast.sync', { scope: 'opp', opportunityId: miss!.opportunityId }, id), { lookup: l.fn });
    expect(res).toMatchObject({ scope: 'opp', found: 1, inserted: 1, linked: 1 });
    expect(l.calls.map((c) => c.q)).toEqual([sfrRecordsForOppSoql(OWNER, ['FY27 Q4', 'FY28 Q1'], ORG62_OPP)]);
    expect(JSON.stringify(res)).not.toMatch(/Placeholder/);
    expect((await loadForecastRecords(handle.db, userId)).every((x) => !x.goneAt)).toBe(true);
    await handle.db.execute(sql`update jobs set status = 'succeeded', finished_at = now(), result = ${JSON.stringify(res)}::jsonb where id = ${id}`);

    const v2 = await ds.getForecast({} as never);
    expect(v2.queue.missing.map((m) => m.opportunityId)).not.toContain(miss!.opportunityId);
    const found = v2.found.find((f) => f.opportunityId === miss!.opportunityId)!;
    expect(found).toMatchObject({ status: 'found', recordId: expect.any(String) });
    expect(v2.rows.find((x) => x.id === found.recordId)).toMatchObject({ opportunityId: miss!.opportunityId, roleFix: { from: 'None', to: 'Aware' } });

    // an opp the app has no Org62 id for: the check is skipped with the reason, nothing is read
    const none = fakeLookup(() => [], () => []);
    expect(await runForecastSyncJob(ctxFor('forecast.sync', { scope: 'opp', opportunityId: '00000000-0000-4000-8000-0000000000ff' }), { lookup: none.fn })).toMatchObject({ scope: 'opp', skipped: 'no_org62_id' });
    expect(none.calls).toEqual([]);
    await finishJobs();
  });
});
