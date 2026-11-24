/**
 * VDP asset candidates against Postgres 17: the `vdp_asset_candidates` table (insert, re-sighting, user statuses that
 * a match never resets), the mirror read closing what VDP now shows and handing waiting candidates to a new VDP, the
 * deterministic matcher pass over newly stored Drive / Slack / Gmail / Calendar items, the routes (details with its
 * ordered steps, candidate statuses, Find assets queueing), and the Find assets job with a fake research agent.
 *
 * Own database: control_center_vdpassets_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder fixtures only.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import { routes, vdpKeyOfAccount, type Seed } from '../../../src/contract';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../../src/connectors/vdp/parse';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { assetKeyOf, type CandidateDraft } from '../../../src/engines/vdp/assets';
import type { JobContext } from '../../../src/jobs/types';
import { runVdpAssetsJob } from '../../../src/jobs/handlers/vdp-assets';
import type { ResearchAgent } from '../../../src/llm/readin/agent';
import type { VdpSnapshot } from '../../../src/lib/vdp/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { runVdpAssetMatch } from '../../../src/server/datasource/db/store/vdp-assets';
import { checkTransition, loadCandidates, setCandidateStatus, upsertCandidates } from '../../../src/server/datasource/db/store/vdp-candidates';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { fixture } from '../../vdp/helpers';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_vdpassets_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_VDP_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let acme: VdpSnapshot;
let globex: VdpSnapshot;
/** The account the acme VDP links to, and an engaged account of mine with no VDP. */
let acc: { id: string; name: string };
let other: { id: string; name: string };

const DECK = 'https://docs.google.com/presentation/d/PLACEHOLDER0DECK0000000000001/edit';
const draft = (o: Partial<CandidateDraft> & { url: string }): CandidateDraft => ({
  targetKey: acc.id,
  vdpSlug: 'acme-fy27-q4',
  accountId: acc.id,
  companyName: acc.name,
  title: 'Placeholder asset',
  assetKey: assetKeyOf(o.url),
  kind: 'deck',
  why: 'Placeholder reason',
  confidence: 0.6,
  status: 'unsure',
  sources: [{ source: 'slack', label: '#placeholder', url: 'https://example.slack.com/archives/C0PLACEHOLDER/p1', at: null }],
  sourceItemIds: [],
  ...o,
});

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_vdpassets_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'vdp-assets-test' });
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

  // Two engaged accounts of mine: the first gets the acme VDP (by placeholder Org62 ids), the second has none.
  const r = await handle.db.execute<{ id: string; account_id: string; name: string }>(sql`
    select distinct on (o.account_id) o.id, o.account_id, a.name from opportunities o join accounts a on a.id = o.account_id
     where o.owner_user_id = ${userId} and not o.is_closed and o.on_my_team
       and exists (select 1 from deal_contributions d where d.opportunity_id = o.id and d.is_mine and d.split_percent = 100) -- D-63: 100% DCs
     order by o.account_id, o.created_at`);
  // D-69: the seed has more engaged accounts now (the company-identity placeholders): keep the two this suite was written for
  const pick = (name: string) => r.rows.find((x) => x.name === name)!;
  const [first, second] = [pick('Globex'), pick('Initech')];
  acc = { id: first!.account_id, name: first!.name };
  other = { id: second!.account_id, name: second!.name };
  await withChangeSet({ db: handle.db, userId, actor: actors.system('vdp-assets-test'), reason: 'test fixture: placeholder Org62 ids' }, async (tx) => {
    await tx.execute(sql`update opportunities set org62_opportunity_id = '006PLACEHOLDER0XYZ' where id = ${first!.id}`);
    await tx.execute(sql`update accounts set org62_account_id = '001PLACEHOLDER0XYZ' where id = ${acc.id}`);
    await tx.execute(sql`update accounts set org62_account_id = '001PLACEHOLDER1XYZ' where id = ${other.id}`);
  });
  const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
  acme = { ...withUseCaseDetail(parseGetVdp(fixture('get_vdp_acme'))!, details), salesforceOpportunityId: '006PLACEHOLDER0', salesforceOpportunityIds: ['006PLACEHOLDER0'], salesforceAccountId: '001PLACEHOLDER0' };
  globex = parseGetVdp(fixture('get_vdp_globex'))!;
  await saveVdpMirror(handle.db, userId, { snapshots: [acme, globex], complete: true, readAt: now.toISOString() });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

describe.runIf(PG)('VDP asset candidates (db)', () => {
  it('a re-sighting adds a source and promotes unsure → suggested; a status you set is never reset by a match', async () => {
    const a = await upsertCandidates(handle.db, userId, [draft({ url: DECK })], { origin: 'matcher', now });
    expect(a).toMatchObject({ added: 1, updated: 0 });
    const b = await upsertCandidates(handle.db, userId, [draft({ url: `${DECK}?usp=sharing`, confidence: 0.85, status: 'suggested', why: 'Shared in #acme-ext', sources: [{ source: 'slack', label: '#acme-ext', url: 'https://example.slack.com/archives/C0PLACEHOLDER/p2', at: null }] })], { origin: 'matcher', now });
    expect(b).toMatchObject({ added: 0, updated: 1 });
    let row = (await loadCandidates(handle.db, userId)).find((c) => c.url === DECK)!;
    expect(row).toMatchObject({ status: 'suggested', confidence: 0.85, why: 'Shared in #acme-ext', origin: 'matcher' });
    expect(row.sources.map((s) => s.label)).toEqual(['#placeholder', '#acme-ext']);

    const { after } = await setCandidateStatus(handle.db, userId, row.id, 'dismissed', now);
    expect(after.status).toBe('dismissed');
    await upsertCandidates(handle.db, userId, [draft({ url: DECK, confidence: 0.95, status: 'suggested' })], { origin: 'backfill', now });
    row = (await loadCandidates(handle.db, userId)).find((c) => c.url === DECK)!;
    expect(row.status).toBe('dismissed');
    await setCandidateStatus(handle.db, userId, row.id, 'suggested', now); // put back
    expect(() => checkTransition('in_vdp', 'added')).toThrow(/already shows/);
    expect(() => checkTransition('unsure', 'added')).toThrow(/can't become/);
  });

  it('the next mirror read closes a candidate VDP now shows, and gives a new VDP the candidates that waited for it', async () => {
    const added = 'https://docs.google.com/document/d/PLACEHOLDER0ADDED000000000001/edit';
    await upsertCandidates(handle.db, userId, [draft({ url: added, status: 'suggested', confidence: 0.8, kind: 'doc', title: 'Added doc' }), draft({ url: 'https://www.loom.com/share/PLACEHOLDER0WAIT', targetKey: other.id, accountId: other.id, vdpSlug: null, companyName: other.name, kind: 'recording', title: 'Waiting demo recording' })], { origin: 'matcher', now });
    const id = (await loadCandidates(handle.db, userId)).find((c) => c.url === added)!.id;
    await setCandidateStatus(handle.db, userId, id, 'added', now);
    const newVdp: VdpSnapshot = { ...globex, id: '22222222-2222-4222-8222-000000000009', slug: 'other-fy27-q4', company: { ...globex.company, name: other.name }, salesforceAccountId: '001PLACEHOLDER1', salesforceOpportunityId: null, salesforceOpportunityIds: [] };
    const withAsset: VdpSnapshot = { ...acme, assets: [{ id: 'as-1', title: 'Added doc', url: 'https://docs.google.com/document/d/PLACEHOLDER0ADDED000000000001/view', type: 'Doc', description: null }] };
    await saveVdpMirror(handle.db, userId, { snapshots: [withAsset, globex, newVdp], complete: true, readAt: now.toISOString() });
    const all = await loadCandidates(handle.db, userId);
    expect(all.find((c) => c.id === id)).toMatchObject({ status: 'in_vdp' });
    expect(all.find((c) => c.title === 'Waiting demo recording')).toMatchObject({ vdpSlug: 'other-fy27-q4', status: 'unsure' });
    // back to the original mirror for the rest
    await saveVdpMirror(handle.db, userId, { snapshots: [acme, globex], complete: true, readAt: now.toISOString() });
  });

  it('the matcher: new Drive files, Slack links, Gmail links and meeting attachments become candidates with provenance; Gemini notes and other accounts do not', async () => {
    const { result: ch } = await withChangeSet({ db: handle.db, userId, actor: actors.system('vdp-assets-test'), reason: 'test fixture: an account channel and a Drive file' }, async (tx) => {
      const c = await tx.execute<{ id: string }>(sql`insert into channels (owner_user_id, system, external_id, name, kind, is_customer_channel) values (${userId}, 'slack', 'C0PLACEHOLDERX', 'acct-placeholder-ext', 'shared_external', true) returning id`);
      await tx.execute(sql`insert into channel_account_maps (channel_id, account_id, method, confidence) values (${c.rows[0]!.id}, ${acc.id}, 'rule', 0.9)`);
      await tx.execute(sql`insert into assets (owner_user_id, system, external_id, kind, title, url, mime_type, account_id, mapping_method, mapping_confidence) values (${userId}, 'drive', 'PLACEHOLDER0FILE00000000001', 'deck', 'Q4 plan', 'https://docs.google.com/presentation/d/PLACEHOLDER0FILE00000000001/edit', 'application/vnd.google-apps.presentation', ${acc.id}, 'rule', 0.8)`);
      // the deck the Slack message shares: Drive knows its title (an untitled link is never a candidate, 2026-11-14)
      await tx.execute(sql`insert into assets (owner_user_id, system, external_id, kind, title, url, mime_type) values (${userId}, 'drive', 'PLACEHOLDER0SLACK0000000001', 'deck', 'Readout deck', 'https://docs.google.com/presentation/d/PLACEHOLDER0SLACK0000000001/edit', 'application/vnd.google-apps.presentation')`);
      return c.rows[0]!.id;
    });
    const ins = async (o: { source: string; kind: string; ext: string; title: string | null; body?: string | null; meta?: Record<string, unknown>; channel?: string | null; url?: string | null }) => {
      const r = await handle.db.execute<{ id: string }>(sql`
        insert into source_items (owner_user_id, source, kind, external_id, dedupe_key, content_hash, occurred_at, title, url, body, meta, channel_id)
        values (${userId}, ${o.source}::source_system, ${o.kind}::source_item_kind, ${o.ext}, ${`test:${o.ext}`}, 'h', now(), ${o.title}, ${o.url ?? null}, ${o.body ?? null}, ${JSON.stringify(o.meta ?? {})}::jsonb, ${o.channel ?? null})
        returning id`);
      return r.rows[0]!.id;
    };
    await ins({ source: 'drive', kind: 'drive_file_revision', ext: 'PLACEHOLDER0FILE00000000001@1', title: 'Q4 plan', meta: { fileId: 'PLACEHOLDER0FILE00000000001' } });
    const slack = await ins({ source: 'slack', kind: 'slack_message', ext: '1700000000.000001', title: null, body: 'here is the readout https://docs.google.com/presentation/d/PLACEHOLDER0SLACK0000000001/edit', channel: ch, url: 'https://example.slack.com/archives/C0PLACEHOLDERX/p1700000000000001' });
    await handle.db.execute(sql`insert into source_item_refs (source_item_id, kind, value) values (${slack}, 'drive_file', 'PLACEHOLDER0SLACK0000000001')`);
    await ins({ source: 'gmail', kind: 'email_message', ext: 'gm-1', title: 'Demo follow-up', body: `Thanks for the time with ${acc.name} today.`, meta: { urls: ['https://www.loom.com/share/PLACEHOLDER0GMAIL'] }, url: 'https://mail.google.com/mail/u/0/#inbox/PLACEHOLDER' });
    await ins({ source: 'calendar', kind: 'calendar_event', ext: 'ev-1', title: `${acc.name} workshop`, meta: { attachments: [{ title: 'Workshop deck', fileId: 'PLACEHOLDER0CAL000000000001', mimeType: 'application/vnd.google-apps.presentation' }, { title: 'Notes by Gemini', fileId: 'PLACEHOLDER0GEM000000000001', mimeType: 'application/vnd.google-apps.document' }] } });
    await ins({ source: 'slack', kind: 'slack_message', ext: '1700000000.000002', title: null, body: 'unrelated deck https://docs.google.com/presentation/d/PLACEHOLDER0NOPE00000000001/edit' });

    const since = new Date(Date.now() - 3_600_000);
    const r = await runVdpAssetMatch(handle.db, userId, { since, now });
    expect(r.added).toBe(3);
    const all = await loadCandidates(handle.db, userId);
    const by = (part: string) => all.find((c) => c.url.includes(part));
    expect(by('PLACEHOLDER0FILE')).toMatchObject({ status: 'suggested', kind: 'deck', title: 'Q4 plan', vdpSlug: 'acme-fy27-q4', origin: 'matcher', sources: [{ source: 'drive', label: 'Drive' }] });
    expect(by('PLACEHOLDER0SLACK')).toMatchObject({ status: 'suggested', title: 'Readout deck', sources: [{ source: 'slack', label: '#acct-placeholder-ext', url: 'https://example.slack.com/archives/C0PLACEHOLDERX/p1700000000000001' }] });
    expect(by('PLACEHOLDER0SLACK')!.why).toMatch(/the channel is/);
    // an untitled recording link is never a candidate (nothing says what it is: 2026-11-14 asset screen)
    expect(by('PLACEHOLDER0GMAIL')).toBeUndefined();
    expect(by('PLACEHOLDER0CAL')).toMatchObject({ status: 'suggested', kind: 'deck', title: 'Workshop deck', sources: [{ source: 'calendar' }] });
    expect(by('PLACEHOLDER0GEM')).toBeUndefined();
    expect(by('PLACEHOLDER0NOPE')).toBeUndefined();
    // the same window again adds nothing
    expect((await runVdpAssetMatch(handle.db, userId, { since, now })).added).toBe(0);
  });

  // D-59: the steps are the coverage row's open items. D-63: the DC note is not checked; Generate sits under the inputs;
  // the execution phase and target date are inputs too.
  it('getVdpDetail: the open items in order, the candidates with their Assets-tab handoff, everything in VDP; an account without a VDP starts with creating it', async () => {
    const d = await ds.getVdpDetail({ query: { key: 'acme-fy27-q4' } } as never);
    expect(routes.getVdpDetail.response.safeParse(d).success).toBe(true);
    expect(d.vdp).toMatchObject({ slug: 'acme-fy27-q4', fiscalYear: 27, useCases: [{ title: 'Unified customer profile', hasAi: true }, { title: 'Service agent deflection', hasAi: false }], stakeholders: [{ name: 'Stakeholder Placeholder' }] });
    // no "confirm" row: the untitled recording the matcher used to keep as unsure is screened out (2026-11-14)
    expect(d.steps.map((s) => [s.kind, s.section])).toEqual([
      ['use_case_fields', 'use_cases'],
      ['ai_fields', 'use_cases'],
    ]);
    expect(d.steps.every((s) => s.handoff === null)).toBe(true);
    const cov0 = await ds.getVdpCoverage({} as never);
    expect(cov0.vdps.find((v) => v.vdpSlug === 'acme-fy27-q4')!.steps).toEqual(d.steps); // the card and the panel: one list
    expect(d.status).toMatchObject({ state: 'open', open: 2, appCanFix: 2 });
    // D-63: Generate goes after the use case's inputs (it needs that item first)
    expect(d.steps.find((s) => s.kind === 'ai_fields')).toMatchObject({ state: 'todo', requires: ['acme-fy27-q4:use_case:aaaaaaa1-0000-4000-8000-000000000002'], parentKey: 'acme-fy27-q4:use_case:aaaaaaa1-0000-4000-8000-000000000002' });
    const deck = d.candidates.find((c) => c.title === 'Q4 plan')!;
    expect(deck.handoff).toMatchObject({ url: 'https://vdp.example.test/vdp/acme-fy27-q4?tab=assets' });
    expect(deck.handoff.copyText).toContain('Type: Deck');

    const o = await ds.getVdpDetail({ query: { key: vdpKeyOfAccount(other.id) } } as never);
    expect(routes.getVdpDetail.response.safeParse(o).success).toBe(true);
    expect(o).toMatchObject({ vdp: null, account: { id: other.id } });
    // no company lookup yet: create the company (VDP refuses a likely duplicate), the VDP under it, then its items
    expect(o.steps.slice(0, 2)).toMatchObject([{ kind: 'create_company', state: 'todo', requires: [] }, { kind: 'create_vdp', requires: [`account:${other.id}:create_company`] }]);
    expect(o.steps.every((s) => s.handoff === null)).toBe(true);

    const cov = await ds.getVdpCoverage({} as never);
    expect(cov.assets.byKey['acme-fy27-q4']!.toAdd).toBeGreaterThanOrEqual(3);
    const set = await ds.setVdpCandidate({ params: { id: deck.id }, body: { status: 'added' } } as never);
    expect(routes.setVdpCandidate.response.safeParse(set).success).toBe(true);
    expect(set.entity.status).toBe('added');
    await expect(ds.setVdpCandidate({ params: { id: deck.id }, body: { status: 'added' } } as never)).resolves.toBeTruthy(); // idempotent
  });

  it('findVdpAssets: an estimate starts nothing; a run is one queued job per key; a key already looking is skipped', async () => {
    const est = await ds.findVdpAssets({ body: { key: 'acme-fy27-q4', estimateOnly: true } } as never);
    // planned at what a run costs (no history yet: $0.20), at most the per-run cap
    expect(est.entity).toMatchObject({ started: false, queued: [{ key: 'acme-fy27-q4' }], estimateUsd: 0.2, ceilingUsd: 0.5, runUsd: 0.2 });
    const count = async () => Number((await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'vdp.assets.find'`)).rows[0]!.n);
    expect(await count()).toBe(0);
    const go = await ds.findVdpAssets({ body: { key: 'acme-fy27-q4' } } as never);
    expect(routes.findVdpAssets.response.safeParse(go).success).toBe(true);
    expect(go.entity.started).toBe(true);
    const job = await handle.db.execute<{ queue: string; payload: Record<string, unknown>; dedupe_key: string }>(sql`select queue, payload, dedupe_key from jobs where kind = 'vdp.assets.find'`);
    expect(job.rows).toEqual([{ queue: 'vdp', payload: { key: 'acme-fy27-q4', cap_usd: 0.5 }, dedupe_key: 'vdp.assets.find:acme-fy27-q4' }]);
    const again = await ds.findVdpAssets({ body: { key: 'acme-fy27-q4' } } as never);
    expect(again.entity).toMatchObject({ started: false, skipped: [{ why: 'already looking' }] });
    expect((await ds.getVdpDetail({ query: { key: 'acme-fy27-q4' } } as never)).backfill.last).toMatchObject({ status: 'queued' });
  });

  it('the Find assets job: a read-only research run records candidates (backfill) and its spend on the assistant line; no budget, no run', async () => {
    const job = (await handle.db.execute<{ id: number }>(sql`select id from jobs where kind = 'vdp.assets.find' limit 1`)).rows[0]!;
    const found = 'https://docs.google.com/spreadsheets/d/PLACEHOLDER0RESEARCH0000001/edit';
    const agent: ResearchAgent & { prompt?: string } = {
      async run(input) {
        agent.prompt = `${input.systemPrompt.join('\n')}\n${input.prompt}`;
        input.state.seenUrls.add(found); // as a Slack search result would
        input.state.seenUrls.add('https://example.slack.com/archives/C0PLACEHOLDERX/p1700000000000009');
        const refused = await input.local!.call!('assets_finish', { assets: [{ title: 'Made up', url: 'https://docs.google.com/document/d/PLACEHOLDER0UNSEEN000000001/edit', why: 'x', source: 'drive', sourceLabel: 'Drive', confidence: 'sure' }], searched: [], notFound: [] });
        expect(refused.isError).toBe(true);
        await input.local!.call!('assets_finish', { assets: [{ title: 'Consumption estimate', url: found, kind: 'sheet', why: 'Sent to the AE with the pricing thread', source: 'slack', sourceLabel: '#acct-placeholder-ext', sourceUrl: 'https://example.slack.com/archives/C0PLACEHOLDERX/p1700000000000009', at: '2026-10-01', confidence: 'likely' }], searched: [{ source: 'slack', query: 'acme has:link', hits: 3 }], notFound: ['no recordings'] });
        return { ok: true, output: null, costUsd: 0.21, inputTokens: 12_000, outputTokens: 800, turns: 6, toolCalls: ['mcp__cc_vdp_assets__assets_finish'] };
      },
    };
    const ctx = { job: { id: job.id, ownerUserId: userId, kind: 'vdp.assets.find', queue: 'vdp', payload: { key: 'acme-fy27-q4', cap_usd: 0.5 }, attempts: 1, maxAttempts: 1, timeoutSeconds: 420, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db: handle.db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} } as unknown as JobContext;
    const out = await runVdpAssetsJob(ctx, { agent, google: () => null, external: () => ({ servers: {}, tools: [], unavailable: ['Slack'] }) });
    expect(out).toMatchObject({ added: 1, assets: 1, costUsd: 0.21 });
    expect(agent.prompt).toContain('Q4 plan'); // what is already known is passed, so it is not reported again
    expect((await loadCandidates(handle.db, userId)).find((c) => c.url === found)).toMatchObject({ origin: 'backfill', status: 'suggested', confidence: 0.75, kind: 'sheet', sources: [{ source: 'slack', label: '#acct-placeholder-ext' }] });
    const spend = await handle.db.execute<{ purpose: string; skill_key: string; cost_usd: string }>(sql`select purpose::text as purpose, skill_key, cost_usd from llm_calls where skill_key = 'vdp-assets'`);
    expect(spend.rows).toEqual([{ purpose: 'chat', skill_key: 'vdp-assets', cost_usd: expect.stringMatching(/^0\.21/) }]);

    // the assistant's day line used up: the job succeeds as skipped and calls nothing
    await handle.db.execute(sql`insert into llm_calls (owner_user_id, purpose, model, model_tier, skill_key, prompt_version, request_hash, status, input_tokens, output_tokens, cost_usd, budget_day, started_at, finished_at, latency_ms)
      values (${userId}, 'chat', 'claude-sonnet-5-5', 'sonnet', 'chat-assistant', 'chat-assistant@4', 'test:spend', 'ok', 0, 0, 5, (select (now() at time zone coalesce((select timezone from users where id = ${userId}), 'UTC'))::date), now(), now(), 0)`);
    let called = false;
    const skipped = await runVdpAssetsJob({ ...ctx, clock: () => new Date() } as JobContext, { agent: { run: async () => ((called = true), { ok: false, output: null, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: [] }) }, google: () => null });
    expect(skipped).toMatchObject({ skipped: 'budget' });
    expect(called).toBe(false);
  });
});
