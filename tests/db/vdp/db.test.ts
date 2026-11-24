/**
 * The VDP mirror and the db DataSource against Postgres 17: vdp_records upsert (linked to my accounts/opps by Org62
 * id), gone marks, getVdpCoverage, draftVdpUpdate → a `vdp` draft row, dry-run dispatch (exact update_use_case
 * payload, nothing called), and a live Apply through the outbox job with a simulated VDP (never the real one).
 *
 * Own database: control_center_vdp_<CC_TEST_DB_SUFFIX>, dropped and recreated per run. Placeholder fixtures only.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import { routes, type ActionDestination, type Seed } from '../../../src/contract';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../../src/connectors/vdp/parse';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import type { VdpSnapshot } from '../../../src/lib/vdp/types';
import { OutboxGateway, parseJobPayload, runOutboxJob, SimulatedOutboxTransport } from '../../../src/outbox';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { dbOutboxPort } from '../../../src/server/datasource/db/outbox';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { ensureExtractor, loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { dbVdpSink, loadVdpRecords, loadVdpServer, saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { SHIPPED_VDP_TOOLS } from '../../../src/mock/vdp';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { fixture } from '../../vdp/helpers';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_vdp_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_VDP_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let extractorId: string;
let acme: VdpSnapshot;
let globex: VdpSnapshot;
let link: { accountId: string; oppId: string; org62Opp: string; org62Acc: string | null };

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_vdp_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'vdp-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  mock.dispose();
  userId = res.userId;
  extractorId = await ensureExtractor(handle.db);
  ds = new DbDataSource({ handle, url: URL_, userId, clock: { now: () => now }, ranker: interimRanker });

  // The placeholder seed has no Org62 ids: give one open opp of mine (and its account) placeholder ids, then point the
  // VDP header at them, as a real VDP links its Org62 opportunity.
  const r = await handle.db.execute<{ id: string; account_id: string }>(sql`
    select o.id, o.account_id from opportunities o where o.owner_user_id = ${userId} and not o.is_closed and o.on_my_team and o.account_id is not null order by o.created_at limit 1`);
  const row = r.rows[0]!;
  await withChangeSet({ db: handle.db, userId, actor: actors.system('vdp-test'), reason: 'test fixture: placeholder Org62 ids' }, async (tx) => {
    await tx.execute(sql`update opportunities set org62_opportunity_id = '006PLACEHOLDER0XYZ' where id = ${row.id}`);
    await tx.execute(sql`update accounts set org62_account_id = '001PLACEHOLDER0XYZ' where id = ${row.account_id}`);
  });
  link = { accountId: row.account_id, oppId: row.id, org62Opp: '006PLACEHOLDER0', org62Acc: '001PLACEHOLDER0' }; // 15-char forms on the VDP side
  const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
  // D-59: the mirror links every opp id on the VDP (salesforceOpportunityIds), so the fixture points the list at the opp
  acme = { ...withUseCaseDetail(parseGetVdp(fixture('get_vdp_acme'))!, details), salesforceOpportunityId: link.org62Opp, salesforceOpportunityIds: [link.org62Opp], salesforceAccountId: link.org62Acc };
  globex = parseGetVdp(fixture('get_vdp_globex'))!;
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

describe.runIf(PG)('VDP mirror and route (db)', () => {
  it('saves my VDPs to vdp_records, linked to my opp and account by Org62 id, with every field in detail', async () => {
    const r = await saveVdpMirror(handle.db, userId, { snapshots: [acme, globex], complete: true, readAt: now.toISOString() });
    expect(r).toEqual({ written: 2, removed: 0 });
    const rows = await loadVdpRecords(handle.db, userId);
    const a = rows.find((x) => x.vdpSlug === 'acme-fy27-q4')!;
    expect(a).toMatchObject({ vdpId: acme.id, opportunityId: link.oppId, accountId: link.accountId, goneAt: null, archived: false });
    expect(a.snapshot!.useCases[0]!.detailsInput).toBe('Placeholder details for the unified profile.');
    const raw = await handle.db.execute<Record<string, unknown>>(sql`select has_ae, has_ta, use_case_count, use_case_with_ai_count, asset_count, missing_items from vdp_records where vdp_slug = 'acme-fy27-q4'`);
    expect(raw.rows[0]).toMatchObject({ has_ae: true, has_ta: true, use_case_count: 2, use_case_with_ai_count: 1, asset_count: 0 });
    expect(raw.rows[0]!.missing_items).toEqual(expect.arrayContaining(['no_assets', 'use_case_field', 'no_ai_fields']));
    const known = await dbVdpSink(handle.db, userId).known();
    expect(known.get(acme.id)).toMatchObject({ lastActivityAt: '2026-11-05T15:30:00.000Z' });
  });

  it('D-59: the server info (tools, lookups) is stored per user, replaced by the next read that carries it, kept otherwise', async () => {
    const info = { tools: SHIPPED_VDP_TOOLS, deliverableTypes: null, companies: [{ query: 'Placeholder Co', at: now.toISOString(), matches: [] }], readAt: now.toISOString() };
    await saveVdpMirror(handle.db, userId, { snapshots: [acme, globex], complete: true, readAt: now.toISOString(), server: info });
    expect(await loadVdpServer(handle.db, userId)).toEqual(info);
    await saveVdpMirror(handle.db, userId, { snapshots: [acme, globex], complete: true, readAt: now.toISOString() });
    expect(await loadVdpServer(handle.db, userId)).toEqual(info);
    const cov = await ds.getVdpCoverage({} as never);
    // D-63: the stored list governs once read (D-69: the shipped list carries vdp-app #11's entitlement_leveraged)
    expect(cov.automation).toMatchObject({ toolsKnown: true, createVdp: true, addOpportunities: true, addAsset: true, setOwners: true, entitlementHeader: true });
    expect(await dbVdpSink(handle.db, userId).companyQueries!()).toEqual(expect.any(Array));
  });

  it('a complete read marks a VDP it no longer lists gone (kept); an incomplete read never does; a return clears it', async () => {
    await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: false, readAt: now.toISOString() });
    expect((await loadVdpRecords(handle.db, userId)).find((x) => x.vdpSlug === 'globex-fy27-q4')!.goneAt).toBeNull();
    const r = await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: now.toISOString() });
    expect(r.removed).toBe(1);
    expect((await loadVdpRecords(handle.db, userId)).find((x) => x.vdpSlug === 'globex-fy27-q4')!.goneAt).not.toBeNull();
    await saveVdpMirror(handle.db, userId, { snapshots: [acme, globex], complete: true, readAt: now.toISOString() });
    expect((await loadVdpRecords(handle.db, userId)).every((x) => x.goneAt === null)).toBe(true);
  });

  it('getVdpCoverage: contract-valid gaps from the mirror, with VDP deep links', async () => {
    const cov = await ds.getVdpCoverage({} as never);
    expect(routes.getVdpCoverage.response.safeParse(cov).success).toBe(true);
    const row = cov.vdps.find((v) => v.vdpSlug === 'acme-fy27-q4')!;
    expect(row).toMatchObject({ opportunityId: link.oppId, accountId: link.accountId, useCaseCount: 2 });
    expect(row.gaps.map((g) => g.id)).toEqual(expect.arrayContaining(['acme-fy27-q4:use_case_field:aaaaaaa1-0000-4000-8000-000000000002:persona', 'acme-fy27-q4:no_assets']));
    expect(cov.vdpBaseUrl).toBe('https://vdp.example.test');
    expect(cov.lastReadAt).toBe(now.toISOString());
  });

  it('draftVdpUpdate → one pending vdp draft; dry-run dispatch records the exact update_use_case payload and calls nothing', async () => {
    const made = await ds.draftVdpUpdate({ body: { vdpSlug: 'acme-fy27-q4', op: 'update_use_case', field: 'persona', value: 'Service operations lead', useCaseId: 'aaaaaaa1-0000-4000-8000-000000000002' } } as never);
    expect(routes.draftVdpUpdate.response.safeParse(made).success).toBe(true);
    const d = made.entity.draft;
    expect(d).toMatchObject({ status: 'ready', mode: 'send', plainText: 'Persona: (empty) → Service operations lead', destination: { kind: 'action', action: 'vdp.update_use_case', input: { field: 'persona', before: null, useCaseId: 'aaaaaaa1-0000-4000-8000-000000000002' } } });
    const row = await handle.db.execute<{ channel: string; action_type: string; payload: ActionDestination; target_external_id: string }>(sql`select channel, action_type, payload, target_external_id from drafts where id = ${d.id}`);
    expect(row.rows[0]).toMatchObject({ channel: 'vdp', action_type: 'vdp_update', target_external_id: 'aaaaaaa1-0000-4000-8000-000000000002', payload: { kind: 'action', action: 'vdp.update_use_case', input: { vdpSlug: 'acme-fy27-q4' } } });
    // the stored body reads back as the same action
    expect((await ds.getDraft({ params: { id: d.id } } as never)).destination).toEqual(d.destination);
    await expect(ds.patchDraft({ params: { id: d.id }, body: { ifVersion: d.version, doc: { type: 'doc', content: [] } } } as never)).rejects.toThrow(/read-only/);
    const p = await ds.previewDraft({ params: { id: d.id }, body: { mode: 'send' } });
    expect(p.payload).toMatchObject({ tool: 'update_use_case', args: { id: 'aaaaaaa1-0000-4000-8000-000000000002', persona: 'Service operations lead' }, before: null, after: 'Service operations lead' });
    const r = await ds.dispatchDraft({ params: { id: d.id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
    expect(r).toMatchObject({ dryRun: true, attempt: { dryRun: true, outcome: 'rendered' } });
    expect(r.payload).toEqual(p.payload);
    const jobs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${d.id}`);
    expect(jobs.rows[0]!.n).toBe(0);
  });

  it('D-59: one Apply per use case: the item stages ONE update_use_case with every field typed, and the row shows it staged', async () => {
    const UC2 = 'aaaaaaa1-0000-4000-8000-000000000002';
    const first = await ds.getVdpCoverage({} as never);
    const old = first.vdps.find((v) => v.vdpSlug === 'acme-fy27-q4')!.steps.find((s) => s.apply?.key === `acme-fy27-q4:use_case:${UC2}`)!;
    // the single-field item the test above staged (no itemKey) still shows on its use case's item
    expect(old).toMatchObject({ kind: 'use_case_fields', who: 'app', state: 'staged' });
    await ds.rejectDraft({ params: { id: old.draftId! }, body: {} } as never);
    const before = await ds.getVdpCoverage({} as never);
    const item = before.vdps.find((v) => v.vdpSlug === 'acme-fy27-q4')!.steps.find((s) => s.apply?.key === `acme-fy27-q4:use_case:${UC2}`)!;
    expect(item).toMatchObject({ kind: 'use_case_fields', who: 'app', state: 'todo' });
    const made = await ds.draftVdpUpdate({ body: { itemKey: item.apply!.key, values: Object.fromEntries(item.apply!.fields.map((f) => [f.field, f.options[0] ?? (/_date$/.test(f.field) ? '2027-01-15' : `Placeholder ${f.label}`)])) } } as never);
    expect(routes.draftVdpUpdate.response.safeParse(made).success).toBe(true);
    const p = await ds.previewDraft({ params: { id: made.entity.draft.id }, body: { mode: 'send' } });
    expect(p.payload).toMatchObject({ tool: 'update_use_case', item_key: item.apply!.key, args: { id: UC2 } });
    expect(Object.keys((p.payload as { args: Record<string, unknown> }).args).sort()).toEqual(['id', ...item.apply!.fields.map((f) => f.field)].sort());
    const after = await ds.getVdpCoverage({} as never);
    expect(after.vdps.find((v) => v.vdpSlug === 'acme-fy27-q4')!.steps.find((s) => s.apply?.key === item.apply!.key)).toMatchObject({ state: 'staged', draftId: made.entity.draft.id });
    await expect(ds.draftVdpUpdate({ body: { itemKey: item.apply!.key, values: { persona: 'x' } } } as never)).rejects.toThrow(/Already staged/);
    // rejecting it leaves nothing staged: the item is open again
    await ds.rejectDraft({ params: { id: made.entity.draft.id }, body: {} } as never);
    expect((await ds.getVdpCoverage({} as never)).vdps.find((v) => v.vdpSlug === 'acme-fy27-q4')!.steps.find((s) => s.apply?.key === item.apply!.key)!.state).toBe('todo');
  });

  it('live Apply (dry-run off): the outbox job writes update_use_case through the gateway and reads it back', async () => {
    const s = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } });
    try {
      const made = await ds.draftVdpUpdate({ body: { vdpSlug: 'acme-fy27-q4', op: 'update_use_case', field: 'division', value: 'Service', useCaseId: 'aaaaaaa1-0000-4000-8000-000000000002' } } as never);
      const p = await ds.previewDraft({ params: { id: made.entity.draft.id }, body: { mode: 'send' } });
      await ds.dispatchDraft({ params: { id: made.entity.draft.id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
      const rows = await handle.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from jobs where kind = 'outbox.dispatch' and payload->>'draftId' = ${made.entity.draft.id} order by id desc limit 1`);
      const sim = new SimulatedOutboxTransport(() => now);
      const out = await runOutboxJob(parseJobPayload(rows.rows[0]!.payload)!, dbOutboxPort(handle.db, userId, { extractorId: async () => extractorId, now: () => now }), new OutboxGateway(sim), { now: () => now });
      expect(out).toMatchObject({ state: 'delivered', readback: 'confirmed' });
      expect(sim.calls).toEqual([
        // D-69 (VD-21): the live check right before the write
        { server: 'vdp-app-fir', tool: 'get_use_case', args: { id: 'aaaaaaa1-0000-4000-8000-000000000002' } },
        { server: 'vdp-app-fir', tool: 'update_use_case', args: { id: 'aaaaaaa1-0000-4000-8000-000000000002', division: 'Service' } },
        { server: 'vdp-app-fir', tool: 'get_use_case', args: { id: 'aaaaaaa1-0000-4000-8000-000000000002' } },
      ]);
      const d = await ds.getDraft({ params: { id: made.entity.draft.id } } as never);
      expect(d.destination.kind).toBe('action');
      expect(d.verification).toMatchObject({ state: 'verified' });
    } finally {
      const s2 = await ds.getSettings({} as never);
      await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s2.sending.version, value: { dryRun: true } } });
    }
  });
});
