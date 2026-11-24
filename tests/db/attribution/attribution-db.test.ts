/**
 * The attribution engine on Postgres 17 through the real path: source items as the scanners store them →
 * runProjections → activity_entries, read and written through the db DataSource and the jobs.
 *
 *   learning      a pick on a row writes mapping_rules (and an attribution_outcomes row) in the row's own change set;
 *                 Undo reverts it; the next week's meeting from the same customer domain is projected onto that opp
 *   rules         GET /attribution/rules, turn off, remove (contract-validated)
 *   engagement    attribution.opp_engagement rebuilds opp_engagement (hours only on the logged opp)
 *   DC            the batch suggests the opp with why; Accept drafts a DC request (approved, nothing sent); Undo restores
 *   discovery     org62.discover with a recorded Org62 answer (an injected one-call lookup: nothing external) upserts a
 *                 new opp with provenance (ext.via), a not-in-my-book account and the covered AE's team row; the opp
 *                 is a candidate the same day; the AE lookup caches its hits; spend is booked per lookup
 *   the tables    the migration's columns, checks and the dc_suggestions audit trigger
 *
 * Own database: control_center_attribution_<CC_TEST_DB_SUFFIX>, created and dropped per run. Placeholder data only.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, type RouteDef, type RouteKey } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type Db, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { runOppEngagement } from '../../../src/jobs/handlers/opp-engagement';
import { runOrg62Discover } from '../../../src/jobs/handlers/org62-discover';
import { runDcSuggest } from '../../../src/jobs/handlers/dc-suggest';
import { Client } from 'pg';
import type { JobContext } from '../../../src/jobs/types';
import { runProjections } from '../../../src/projections';
import type { SourceRow } from '../../../src/projections/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';
import type { OneLookupResult, runOneReadLookup } from '../../../src/server/onboarding/identity';
import { PROFILE } from '../projections/db-setup';
import { ACCT_ACME, ACCT_GLOBEX, calItem, ME, OPP_ACME, OPP_GLOBEX, org62Item } from '../../projections/fixtures';
import { projectionStore } from '../../../src/server/datasource/db/store/projections.run';


const PG_BIN = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_attribution_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const CONN = ['--host', 'localhost', '--port', '5432'];
const PG = existsSync(`${PG_BIN}/createdb`) && process.env.CC_ATTRIBUTION_DB !== '0';

// Fri 2026-11-06 09:00 America/Denver; the meetings are Thursday's (and next Thursday's)
const NOW = new Date('2026-11-06T16:00:00.000Z');
const LATER = new Date('2026-11-13T16:00:00.000Z');
const at = (hhmm: string, day = '2026-11-05') => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + ((h + 7) * 60 + m) * 60_000).toISOString();
};

let handle: DbHandle;
let db: Db;
let userId: string;
let ds: DbDataSource;

const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
async function insert(si: SourceRow) {
  const hash = createHash('sha1').update(JSON.stringify([si.title, si.meta, si.body])).digest('hex').slice(0, 16);
  await db.execute(sql`
    insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, external_container_id, dedupe_key, content_hash, occurred_at, title, url, body, from_me, meta)
    values (${userId}, ${si.source}, ${si.kind}, ${si.externalId}, ${si.externalParentId}, ${si.externalContainerId}, ${si.dedupeKey}, ${hash}, ${si.occurredAt}::timestamptz, ${si.title}, ${si.url}, ${si.body}, ${si.fromMe}, ${JSON.stringify(si.meta)}::jsonb)
    on conflict (owner_user_id, dedupe_key) do update set content_hash = excluded.content_hash, title = excluded.title, body = excluded.body, meta = excluded.meta, occurred_at = excluded.occurred_at, content_changed_at = now(), revision = source_items.revision + 1`);
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
const meeting = (id: string, title: string, from: string, to: string, day: string, who: string) => calItem(id, { title, start: at(from, day), end: at(to, day), attendees: [{ email: ME.email, response: 'accepted' }, { email: who, response: 'accepted' }], ended: true, attendance: 'attended' });
const keyOf = (id: string, from: string, day = '2026-11-05') => `cal|primary|${id}|${at(from, day)}`;
const rowOf = async (dedupeKey: string) => (await q<{ id: string; version: number; opportunity_id: string | null; account_id: string | null; status: string }>(sql`select id, version, opportunity_id, account_id, status::text as status from activity_entries where owner_user_id = ${userId} and dedupe_key = ${dedupeKey}`))[0];
const oppId = async (org62: string) => (await q<{ id: string }>(sql`select id from opportunities where owner_user_id = ${userId} and org62_opportunity_id = ${org62}`))[0]!.id;
function ctxFor(kind: string, payload: Record<string, unknown>, now: Date): JobContext {
  return { job: { id: 1, ownerUserId: userId, kind, queue: 'maintenance', payload, attempts: 1, maxAttempts: 1, timeoutSeconds: 600, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
}
/** The guard the relay jobs use, never refusing (the hard cap is tested in tests/llm). */
const openGuard = () => ({ refused: 0, run: <T>(fn: () => Promise<T>) => fn() });

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_attribution_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  execFileSync(`${PG_BIN}/dropdb`, [...CONN, '--if-exists', '--force', NAME], { stdio: 'ignore' });
  execFileSync(`${PG_BIN}/createdb`, [...CONN, NAME], { stdio: 'ignore' });
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 6, applicationName: 'attribution-test' });
  db = handle.db;
  userId = (await bootstrapUser({ db, profile: PROFILE, now: NOW })).userId;
  ds = new DbDataSource({ handle, userId, clock: { now: () => NOW } });
  // ACME: an open opp of mine; Globex: an open opp of mine, its account known only by name
  await insert(org62Item(`Opportunity:${OPP_ACME}@2026-11-05T10:00:00.000+0000`, { title: 'ACME - Data 360 Expansion', meta: { Id: OPP_ACME, Amount: 250000, CloseDate: '2026-12-15', StageName: 'Validation', IsClosed: false }, body: 'stage=Validation; close=2026-12-15; amount=250000; team_role=Solution Engineer', accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME] }));
  await insert(org62Item(`Opportunity:${OPP_GLOBEX}@2026-11-05T10:00:00.000+0000`, { title: 'Globex - Agent Rollout', meta: { Id: OPP_GLOBEX, Amount: 90000, CloseDate: '2026-12-20', StageName: 'Discovery', IsClosed: false }, body: 'stage=Discovery; close=2026-12-20; amount=90000; team_role=Solution Engineer', accountHints: [ACCT_GLOBEX, 'Globex Corp'], oppHints: [OPP_GLOBEX] }));
  await insert(meeting('a1', 'ACME discovery', '07:00', '08:00', '2026-11-05', 'dana@acme.example'));
  await insert(meeting('a2', 'ACME roadmap', '09:00', '10:00', '2026-11-05', 'dana@acme.example'));
  // a customer meeting whose title names nobody: only its attendee's domain (which no account claims yet) says who
  await insert(meeting('w1', 'Weekly sync', '13:00', '14:00', '2026-11-05', 'kim@globex.example'));
  const r = await project();
  expect(r.errors).toEqual([]);
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
  execFileSync(`${PG_BIN}/dropdb`, [...CONN, '--if-exists', '--force', NAME], { stdio: 'ignore' });
});

describe.runIf(PG)('the attribution engine on Postgres', () => {
  it('the tables: columns, checks, the audit trigger on dc_suggestions only', async () => {
    const cols = await q<{ table_name: string; column_name: string }>(sql`select table_name, column_name from information_schema.columns where table_name in ('opp_engagement', 'dc_suggestions', 'attribution_outcomes', 'mapping_rules') and column_name in ('hours_logged', 'credit', 'share_percent', 'split_percent', 'shown_confidence', 'miss_count', 'last_miss_at')`);
    expect(cols.length).toBe(7);
    const trg = await q<{ tbl: string }>(sql`select c.relname as tbl from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.proname = 'cc_audit' and c.relname in ('dc_suggestions', 'opp_engagement', 'attribution_outcomes')`);
    expect(trg.map((x) => x.tbl)).toEqual(['dc_suggestions']);
    const kinds = await q<{ v: string }>(sql`select unnest(enum_range(null::mapping_rule_kind))::text as v`);
    expect(kinds.map((k) => k.v)).toEqual(expect.arrayContaining(['person_to_account', 'keyword_to_opportunity']));
    await expect(withChangeSet({ db, userId, actor: actors.system('test'), reason: 'bad state' }, async (tx) => tx.execute(sql`insert into dc_suggestions (owner_user_id, opportunity_id, quarter, group_key, state) values (${userId}, ${await oppId(OPP_ACME)}, 'FY27 Q4', 'g', 'maybe')`))).rejects.toThrow();
  });

  it('a pick writes a learned rule and an outcome in the row’s change set; Undo reverts the rule with the pick', async () => {
    const w = (await rowOf(keyOf('w1', '13:00')))!;
    expect(w.opportunity_id).toBeNull();
    const globex = await oppId(OPP_GLOBEX);
    const r = await call('patchActivity', { params: { id: w.id }, body: { ifVersion: w.version, patch: { oppId: globex } } });
    expect(r.entity.oppId).toBe(globex);
    const rules = (await call('getAttributionRules')).rules;
    const dom = rules.find((x: { kind: string; pattern: string }) => x.kind === 'domain' && x.pattern === 'globex.example');
    expect(dom, JSON.stringify(rules)).toBeTruthy();
    expect(dom.target.name).toMatch(/Globex/);
    expect(dom.source).toBe('user_correction');
    const out = await q<{ outcome: string; chosen_target: string }>(sql`select outcome, chosen_target from attribution_outcomes where owner_user_id = ${userId} and subject_id = ${w.id}`);
    // the legacy rules already suggested Globex (the domain's name reads as Globex): so it is an accept, and the domain is learned
    expect(out).toEqual([{ outcome: 'accept', chosen_target: globex }]);
    await call('undoAudit', { params: { id: r.auditId }, body: {} });
    expect((await call('getAttributionRules')).rules).toHaveLength(0);
    expect((await rowOf(keyOf('w1', '13:00')))!.opportunity_id).toBeNull();
  });

  it('a correction changes the next guess: next week’s meeting with the same customer domain is projected onto that opp', async () => {
    const w = (await rowOf(keyOf('w1', '13:00')))!;
    const globex = await oppId(OPP_GLOBEX);
    await call('patchActivity', { params: { id: w.id }, body: { ifVersion: w.version, patch: { oppId: globex } } });
    await insert(meeting('w2', 'Weekly sync', '13:00', '14:00', '2026-11-12', 'kim@globex.example'));
    expect((await project(LATER)).errors).toEqual([]);
    const next = (await rowOf(keyOf('w2', '13:00', '2026-11-12')))!;
    expect(next, 'the next week’s row').toBeTruthy();
    expect(next.opportunity_id).toBe(globex);
  });

  it('rules: turn one off (the engine stops reading it), then remove it; both undoable, both contract-valid', async () => {
    const rule = (await call('getAttributionRules')).rules[0];
    const off = await call('patchAttributionRule', { params: { id: rule.id }, body: { enabled: false } });
    expect(off.entity).toMatchObject({ id: rule.id, enabled: false, active: false });
    expect(off.auditId).toBeTruthy();
    const gone = await call('deleteAttributionRule', { params: { id: rule.id }, body: {} });
    expect(gone.entity.rules.some((x: { id: string }) => x.id === rule.id)).toBe(false);
    await call('undoAudit', { params: { id: gone.auditId }, body: {} });
    expect((await call('getAttributionRules')).rules.some((x: { id: string }) => x.id === rule.id)).toBe(true);
  });

  it('engagement: the nightly job rolls rows up per opp × week; hours count only on the logged opp', async () => {
    const a1 = (await rowOf(keyOf('a1', '07:00')))!;
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'approve' }, async (tx) =>
      tx.execute(sql`update activity_entries set status = 'approved'::activity_status, approved_at = now(), approval_method = 'click', se_task_type_id = coalesce(se_task_type_id, (select id from se_task_types order by name limit 1)), version = version + 1 where id = ${a1.id}`),
    );
    const res = await runOppEngagement(ctxFor('attribution.opp_engagement', { trigger: 'nightly' }, NOW));
    expect(res.rows).toBeGreaterThan(0);
    const acme = await oppId(OPP_ACME);
    const e = await q<{ meetings: string; external_meetings: string; hours_logged: string; week_start: string }>(sql`select meetings, external_meetings, hours_logged, week_start::text from opp_engagement where owner_user_id = ${userId} and opportunity_id = ${acme}`);
    expect(e).toHaveLength(1);
    expect(Number(e[0]!.meetings)).toBe(2);
    expect(Number(e[0]!.hours_logged)).toBe(1);
    expect(e[0]!.week_start).toBe('2026-11-02');
  });

  it('DC suggestions: the batch suggests my opp with why; Accept drafts a DC request (approved, nothing sent); Undo restores', async () => {
    const p = await call('getDcSuggestions');
    expect(p.enabled).toBe(true);
    const acme = await oppId(OPP_ACME);
    const s = p.suggestions.find((x: { oppId: string }) => x.oppId === acme);
    expect(s, JSON.stringify(p)).toBeTruthy();
    expect(s.reasons.map((r: { code: string }) => r.code)).toContain('team');
    expect(s.splitPercent).toBe(100);
    const r = await call('decideDcSuggestion', { params: { id: s.id }, body: { decision: 'accept' } });
    expect(r.entity.suggestion.state).toBe('accepted');
    const req = await q<{ status: string; split_percent: number; comment: string }>(sql`select status::text as status, split_percent, comment from deal_contribution_requests where owner_user_id = ${userId} and opportunity_id = ${acme}`);
    expect(req).toHaveLength(1);
    expect(req[0]!.status).toBe('approved');
    expect(req[0]!.comment).toMatch(/team/);
    // nothing left the app: no Outbox item was sent, the request waits for the next logging canvas
    expect((await q<{ n: number }>(sql`select count(*)::int as n from draft_send_attempts`))[0]!.n).toBe(0);
    await call('undoAudit', { params: { id: r.auditId }, body: {} });
    expect((await q<{ n: number }>(sql`select count(*)::int as n from deal_contribution_requests where owner_user_id = ${userId}`))[0]!.n).toBe(0);
    expect((await call('getDcSuggestions')).suggestions.some((x: { id: string }) => x.id === s.id)).toBe(true);
  });

  it('discovery: a recorded Org62 answer upserts the new opp with provenance and the covered AE’s team row; it is a candidate the same day', async () => {
    const asked: string[] = [];
    const recorded = JSON.stringify({
      totalSize: 1,
      done: true,
      records: [{ attributes: { type: 'OpportunityTeamMember' }, OpportunityId: '006XX0000000099AAA', UserId: '005XX0000000050AAA', TeamMemberRole: 'Account Executive', Opportunity: { Name: 'Quartzline - Data 360 Pilot', AccountId: '001XX0000000099AAA', Account: { Name: 'Quartzline Labs' }, StageName: 'Discovery', CloseDate: '2027-01-30', Amount: 300000, IsClosed: false, IsWon: false, OwnerId: '005XX0000000050AAA', Owner: { Name: 'Dana AE' } } }],
    });
    const lookup = (async (look: { args: { q?: unknown } }) => {
      asked.push(String(look.args.q));
      return { text: String(look.args.q).includes('FROM OpportunityTeamMember') ? recorded : JSON.stringify({ records: [] }), code: 'ok', message: '', costUsd: 0.004, inputTokens: 900, outputTokens: 120, model: 'claude-haiku-5-5', started: true } as OneLookupResult;
    }) as unknown as typeof runOneReadLookup;
    // the AE I cover, toggled on
    const s0 = await call('getSettings');
    await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { coveredAes: [{ name: 'Dana AE', org62UserId: '005XX0000000050AAA', enabled: true }] } } });
    const res = await runOrg62Discover(ctxFor('org62.discover', { trigger: 'daily' }, NOW), { lookup, live: true, guard: openGuard });
    expect(res).toMatchObject({ mode: 'discover', added: 1 });
    expect(asked.every((x) => /^SELECT /.test(x))).toBe(true);
    expect(asked[0]).toContain(`UserId IN ('${PROFILE.org62UserId}', '005XX0000000050AAA')`);
    const o = (await q<{ id: string; on_my_team: boolean; account_id: string }>(sql`select id, on_my_team, account_id from opportunities where owner_user_id = ${userId} and org62_opportunity_id = '006XX0000000099AAA'`))[0]!;
    expect(o.on_my_team).toBe(false);
    const ext = (await q<{ value: { via?: string } }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${`cc.ext/opportunities/${o.id}`}`))[0]!.value;
    expect(ext.via).toBe('covered_ae');
    expect((await q<{ is_my_book: boolean }>(sql`select is_my_book from accounts where id = ${o.account_id}`))[0]!.is_my_book).toBe(false);
    expect((await q<{ team_role: string; is_me: boolean }>(sql`select team_role, is_me from opportunity_team_members where opportunity_id = ${o.id}`))).toEqual([{ team_role: 'Account Executive', is_me: false }]);
    // one booked call per lookup, with its audit fields
    expect((await q<{ n: number }>(sql`select count(*)::int as n from llm_calls where owner_user_id = ${userId} and skill_key = 'org62-discover'`))[0]!.n).toBe(asked.length);
    // the same day: the new opp is in the picker and the rundown can name it
    const opts = await call('getOppOptions', { query: {} });
    expect(opts.opps.some((x: { id: string }) => x.id === o.id)).toBe(true);
    // the AE lookup: one User read, its hits kept and listed on the next ask
    const users = (async () => ({ text: JSON.stringify({ records: [{ Id: '005XX0000000050AAA', Name: 'Dana AE', Email: 'dana.ae@corp.example', Title: 'Account Executive' }] }), code: 'ok', message: '', costUsd: 0.003, inputTokens: 800, outputTokens: 90, model: 'claude-haiku-5-5', started: true }) as OneLookupResult) as unknown as typeof runOneReadLookup;
    const ae = await runOrg62Discover(ctxFor('org62.discover', { mode: 'lookup_ae', q: 'Dana' }, NOW), { lookup: users, live: true, guard: openGuard });
    expect(ae).toMatchObject({ mode: 'lookup_ae', hits: 1 });
    const hits = await call('lookupCoveredAe', { body: { q: 'Dana' } });
    expect(hits.hits.find((h: { source: string }) => h.source === 'org62')?.org62UserId).toBe('005XX0000000050AAA');
  });

  it('discovery: 600 covered AEs read in several team statements (Salesforce length limits), merged; the last AE’s opp lands', async () => {
    const aes = Array.from({ length: 600 }, (_, i) => `005XX${String(i + 1).padStart(10, '0')}AAA`);
    const last = aes.at(-1)!;
    const team: string[] = [];
    const lookup = (async (look: { args: { q?: unknown } }) => {
      const soql = String(look.args.q);
      const recs = [];
      if (soql.includes('FROM OpportunityTeamMember')) {
        team.push(soql);
        if (soql.includes(`'${last}'`)) recs.push({ attributes: { type: 'OpportunityTeamMember' }, Id: '01MXX0000000077AAA', OpportunityId: '006XX0000000077AAA', UserId: last, TeamMemberRole: 'Account Executive', Opportunity: { Name: 'Tidewater - Data 360', AccountId: '001XX0000000077AAA', Account: { Name: 'Tidewater' }, StageName: 'Qualify', CloseDate: '2027-03-01', Amount: 50000, IsClosed: false, IsWon: false, OwnerId: last, Owner: { Name: 'Last AE' } } });
      }
      return { text: JSON.stringify({ totalSize: recs.length, done: true, records: recs }), code: 'ok', message: '', costUsd: 0.001, inputTokens: 900, outputTokens: 120, model: 'claude-haiku-5-5', started: true } as OneLookupResult;
    }) as unknown as typeof runOneReadLookup;
    const s0 = await call('getSettings');
    await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { coveredAes: aes.map((id, i) => ({ name: `AE ${i + 1}`, org62UserId: id, enabled: true })) } } });
    const res = await runOrg62Discover(ctxFor('org62.discover', { trigger: 'manual' }, NOW), { lookup, live: true, guard: openGuard });
    expect(team.length).toBeGreaterThan(1);
    for (const x of team) expect(x.length).toBeLessThanOrEqual(90_000);
    expect(res).toMatchObject({ mode: 'discover', teamStatements: team.length, teamReads: team.length });
    expect(res).not.toHaveProperty('partial');
    expect((await q<{ n: number }>(sql`select count(*)::int as n from opportunities where owner_user_id = ${userId} and org62_opportunity_id = '006XX0000000077AAA'`))[0]!.n).toBe(1);
  });

  it('discovery (D-103 b): one Specialist Forecast read of my covered AEs, same tool and cap; eligible opps carry it, the rest are skipped with why', async () => {
    const asked: string[] = [];
    const tools: string[] = [];
    const sfr = (id: string, opp: string, name: string, amount: number, line = 'Data Cloud') => ({ attributes: { type: 'SpecialistForecast__c' }, Id: id, Opportunity__c: opp, ForecastType__c: line, OwnerId: '005XX0000000060AAA', Owner: { Name: 'Sam AE' }, Opportunity__r: { Name: name, AccountId: '001XX0000000088AAA', Account: { Name: 'Placeholder Holdings' }, StageName: 'Discovery', CloseDate: '2027-02-01', Amount: amount, IsClosed: false, OwnerId: '005XX0000000061AAA', Owner: { Name: 'Other Owner' } } });
    const lookup = (async (look: { tool: string; args: { q?: unknown } }) => {
      const soql = String(look.args.q);
      asked.push(soql);
      tools.push(look.tool);
      const recs = soql.includes('FROM SpecialistForecast__c') ? [sfr('a0XXX0000000001AAA', '006XX0000000081AAA', 'Placeholder Holdings - Data 360', 300000), sfr('a0XXX0000000002AAA', '006XX0000000082AAA', 'Placeholder Holdings - Data 360 Mini', 5000), sfr('a0XXX0000000003AAA', '006XX0000000083AAA', 'Placeholder Holdings - Renewal', 300000, 'BtL Data Cloud')] : [];
      return { text: JSON.stringify({ totalSize: recs.length, done: true, records: recs }), code: 'ok', message: '', costUsd: 0.001, inputTokens: 900, outputTokens: 120, model: 'claude-haiku-5-5', started: true } as OneLookupResult;
    }) as unknown as typeof runOneReadLookup;
    const s0 = await call('getSettings');
    await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { coveredAes: [{ name: 'Sam AE', org62UserId: '005XX0000000060AAA', enabled: true }], dcProducts: ['Data 360'] } } });
    const calls0 = (await q<{ n: number }>(sql`select count(*)::int as n from llm_calls where owner_user_id = ${userId} and skill_key = 'org62-discover'`))[0]!.n;
    const res = await runOrg62Discover(ctxFor('org62.discover', { trigger: 'manual' }, NOW), { lookup, live: true, guard: openGuard });
    const sfrQs = asked.filter((x) => x.includes('FROM SpecialistForecast__c'));
    expect(sfrQs).toHaveLength(1);
    expect(sfrQs[0]).toContain(`OwnerId IN ('005XX0000000060AAA')`);
    expect(new Set(tools)).toEqual(new Set(['soqlQuery']));
    // the same cap: every read (the forecast one too) is a booked lookup
    expect(res).toMatchObject({ mode: 'discover', lookups: asked.length, sfr: 3, sfrOpps: 1, sfrSkipped: { below_threshold: 1, not_dc_product: 1 } });
    expect((await q<{ n: number }>(sql`select count(*)::int as n from llm_calls where owner_user_id = ${userId} and skill_key = 'org62-discover'`))[0]!.n - calls0).toBe(asked.length);
    // eligible: in the mirror with the forecast's owners on its ext; skipped ones are not written, the trace says why
    const o = await oppId('006XX0000000081AAA');
    const ext = (await q<{ value: { seenVia?: string; specialistForecasts?: { ownerIds: string[]; productLines: string[] } } }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${`cc.ext/opportunities/${o}`}`))[0]!.value;
    expect(ext).toMatchObject({ seenVia: 'sfr', specialistForecasts: { ownerIds: ['005XX0000000060AAA'], productLines: ['Data Cloud'] } });
    expect((await q<{ n: number }>(sql`select count(*)::int as n from opportunities where owner_user_id = ${userId} and org62_opportunity_id in ('006XX0000000082AAA', '006XX0000000083AAA')`))[0]!.n).toBe(0);
    const trace = (await q<{ value: { sfrSkips?: Array<{ opp: string; reason: string }> } }>(sql`select value from user_settings where owner_user_id = ${userId} and key = 'cc.attribution.discover'`))[0]!.value;
    expect(trace.sfrSkips).toEqual([{ opp: '006XX0000000082AAA', reason: 'below_threshold' }, { opp: '006XX0000000083AAA', reason: 'not_dc_product' }]);
    // the daily cap: with one lookup left, the forecast read is refused and the run says partial
    // user_settings is audited (cc_audit_kv): the fixture writes in a change set, as the job's own putKv does
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'cap fixture' }, (tx) => tx.execute(sql`update user_settings set value = jsonb_set(value, '{days}', ${JSON.stringify({ '2026-11-06': 18 })}::jsonb) where owner_user_id = ${userId} and key = 'cc.attribution.discover'`));
    asked.length = 0;
    const capped = await runOrg62Discover(ctxFor('org62.discover', { trigger: 'manual' }, NOW), { lookup, live: true, guard: openGuard });
    expect(capped).toMatchObject({ partial: 'cap' });
    expect(asked.length).toBe(2);
  });

  it('discovery honours the cadence and the daily cap; not live here, it does nothing', async () => {
    expect(await runOrg62Discover(ctxFor('org62.discover', {}, NOW), {})).toMatchObject({ skipped: 'not_live' });
    const s0 = await call('getSettings');
    await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { discovery: 'off' } } });
    expect(await runOrg62Discover(ctxFor('org62.discover', { trigger: 'daily' }, NOW), { lookup: (async () => ({}) as OneLookupResult) as unknown as typeof runOneReadLookup, live: true, guard: openGuard })).toMatchObject({ skipped: 'off' });
  });

  // G4: R3-3 (the forecast's product lines reach the DC gate), R3-9 (the batch wakes the lane), R3-14 (windows)
  const sfrRec = (id: string, opp: string, owner: string, name: string) => ({ attributes: { type: 'SpecialistForecast__c' }, Id: id, Opportunity__c: opp, ForecastType__c: 'Data Cloud', OwnerId: owner, Owner: { Name: 'Pat AE' }, Opportunity__r: { Name: name, AccountId: '001XX0000000071AAA', Account: { Name: 'Placeholder Plains' }, StageName: 'Discovery', CloseDate: '2027-01-15', Amount: 300000, IsClosed: false, OwnerId: '005XX0000000079AAA', Owner: { Name: 'Other Owner' } } });
  const sfrLookup = (asked: string[], recs: unknown[]) =>
    (async (look: { args: { q?: unknown } }) => {
      const soql = String(look.args.q);
      asked.push(soql);
      const r = soql.includes('FROM SpecialistForecast__c') ? recs : [];
      return { text: JSON.stringify({ totalSize: r.length, done: true, records: r }), code: 'ok', message: '', costUsd: 0.001, inputTokens: 900, outputTokens: 120, model: 'claude-haiku-5-5', started: true } as OneLookupResult;
    }) as unknown as typeof runOneReadLookup;

  it('R3-3 + R3-9: a forecast-only opp with no products and a plain name is suggested; the batch publishes time and deals', async () => {
    const s0 = await call('getSettings');
    await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: s0.time.version, value: { discovery: 'daily', coveredAes: [{ name: 'Pat AE', org62UserId: '005XX0000000070AAA', enabled: true }], dcProducts: ['Data Cloud'] } } });
    const asked: string[] = [];
    const res = await runOrg62Discover(ctxFor('org62.discover', { trigger: 'manual' }, LATER), { lookup: sfrLookup(asked, [sfrRec('a0XXX0000000071AAA', '006XX0000000071AAA', '005XX0000000070AAA', 'Placeholder Plains - Renewal FY27')]), live: true, guard: openGuard });
    expect(res).toMatchObject({ mode: 'discover', sfrOpps: 1 });
    const o = await oppId('006XX0000000071AAA');
    // R3-9: listen as the web process does, then run the batch the ripple queues
    const listen = new Client({ connectionString: URL_ });
    await listen.connect();
    const heard: Array<{ o?: string; t?: string }> = [];
    listen.on('notification', (n) => n.channel === 'cc_live' && heard.push(JSON.parse(n.payload ?? '{}')));
    await listen.query('LISTEN cc_live');
    try {
      const r = await runDcSuggest(ctxFor('attribution.dc_suggest', {}, LATER));
      expect(r.changed).toBeGreaterThan(0);
      // R3-3: the opp has no products and no product word in its name; the forecast's line (Data Cloud) passes the gate
      const sug = await q<{ state: string; covered_ae: string | null }>(sql`select state, covered_ae from dc_suggestions where owner_user_id = ${userId} and opportunity_id = ${o}::uuid`);
      expect(sug, JSON.stringify(r)).toHaveLength(1);
      expect(sug[0]!.state).toBe('new');
      for (let i = 0; i < 50 && heard.filter((h) => h.o === 'attribution.dc_suggest').length < 2; i++) await new Promise((ok) => setTimeout(ok, 20));
      expect(heard.filter((h) => h.o === 'attribution.dc_suggest').map((h) => h.t).sort()).toEqual(['deals', 'time']);
    } finally {
      await listen.end();
    }
  });

  it('R3-14: the forecast read skips a covered AE whose coverage window ended', async () => {
    const s0 = await call('getSettings');
    await call('patchSettings', {
      params: { section: 'time' },
      body: { ifVersion: s0.time.version, value: { coveredAes: [{ name: 'Pat AE', org62UserId: '005XX0000000070AAA', enabled: true, kind: 'ooo', window: { from: '2026-11-01', to: '2026-11-30' } }, { name: 'Old Cover', org62UserId: '005XX0000000073AAA', enabled: true, kind: 'ooo', window: { from: '2026-10-01', to: '2026-10-31' } }] } },
    });
    const asked: string[] = [];
    await runOrg62Discover(ctxFor('org62.discover', { trigger: 'manual' }, LATER), { lookup: sfrLookup(asked, []), live: true, guard: openGuard });
    const sfrQs = asked.filter((x) => x.includes('FROM SpecialistForecast__c'));
    expect(sfrQs).toHaveLength(1);
    expect(sfrQs[0]).toContain(`OwnerId IN ('005XX0000000070AAA')`);
    expect(sfrQs[0]).not.toContain('005XX0000000073AAA');
    // only the expired one: no forecast read at all
    const s1 = await call('getSettings');
    await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: s1.time.version, value: { coveredAes: [{ name: 'Old Cover', org62UserId: '005XX0000000073AAA', enabled: true, kind: 'ooo', window: { from: '2026-10-01', to: '2026-10-31' } }] } } });
    asked.length = 0;
    await runOrg62Discover(ctxFor('org62.discover', { trigger: 'manual' }, LATER), { lookup: sfrLookup(asked, []), live: true, guard: openGuard });
    expect(asked.some((x) => x.includes('FROM SpecialistForecast__c'))).toBe(false);
  });
});
