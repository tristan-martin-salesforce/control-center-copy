/**
 * D-60, VDP autopilot against Postgres 17 (its own database, dropped and recreated per run), with a simulated VDP
 * (SimulatedOutboxTransport) and FakeMcp, never the real one:
 *   - off for a new user, the same coverage fields as the mock (parity)
 *   - on, dry run off: a run stages each item the app can fix with known values and applies it through the Outbox under
 *     the autonomy policy (approval_method autonomy_policy, the user's autonomy_policies row), reads it back, and
 *     History's actor is the policy; the draft says "Applied automatically" (appliedBy autopilot), never on the Outbox page
 *   - a second run makes no call twice; a stale cookie pauses it; dry run on writes nothing
 *   - a read-back that finds nothing returns the item to you, with the error
 *   - a staged change VDP already has is withdrawn after the next read
 * Placeholder fixtures only.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import type { Seed } from '../../../src/contract';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../../src/connectors/vdp/parse';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import type { VdpServerInfo, VdpSnapshot } from '../../../src/lib/vdp/types';
import { SHIPPED_VDP_TOOLS } from '../../../src/mock/vdp';
import { OutboxGateway, SimulatedOutboxTransport } from '../../../src/outbox';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { FakeMcp } from '../../outbox/fake';
import { fixture } from '../../vdp/helpers';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_vdpap_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_VDP_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let acme: VdpSnapshot;
let mockCoverage: Awaited<ReturnType<ReturnType<typeof createMockDataSource>['getVdpCoverage']>>;

const PENDING = [
  { name: 'set_vdp_owners', args: ['account_executives', 'technical_architects', 'vdp_id'] },
  { name: 'generate_use_case', args: ['regenerate', 'use_case_id', 'vdp_id'] },
];

async function setSending(value: Record<string, unknown>, confirm = false) {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value, ...(confirm ? { confirm: true } : {}) } } as never);
}

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_vdpap_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'vdp-autopilot-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  mockCoverage = await mock.getVdpCoverage({} as never);
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  mock.dispose();
  userId = res.userId;
  ds = new DbDataSource({ handle, url: URL_, userId, clock: { now: () => now }, ranker: interimRanker });

  // one open opp of mine (and its account) gets placeholder Org62 ids; the VDP links the opp, its header has no
  // account id and no period (both known from Org62), and no TA (me)
  const r = await handle.db.execute<{ id: string; account_id: string; close_date: string | null }>(sql`
    select o.id, o.account_id, o.close_date from opportunities o where o.owner_user_id = ${userId} and not o.is_closed and o.on_my_team and o.account_id is not null order by o.created_at limit 1`);
  const row = r.rows[0]!;
  await withChangeSet({ db: handle.db, userId, actor: actors.system('vdp-test'), reason: 'test fixture: placeholder Org62 ids' }, async (tx) => {
    await tx.execute(sql`update opportunities set org62_opportunity_id = '006PLACEHOLDR01XYZ', close_date = '2026-12-15' where id = ${row.id}`);
    await tx.execute(sql`update accounts set org62_account_id = '001PLACEHOLDR01XYZ' where id = ${row.account_id}`);
  });
  const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
  const base = withUseCaseDetail(parseGetVdp(fixture('get_vdp_acme'))!, details);
  acme = { ...base, salesforceOpportunityId: '006PLACEHOLDR01', salesforceOpportunityIds: ['006PLACEHOLDR01'], salesforceAccountId: null, fiscalYear: null, fiscalQuarter: null, tas: [] };
  const server: VdpServerInfo = { tools: [...SHIPPED_VDP_TOOLS, ...PENDING], deliverableTypes: null, companies: [], readAt: now.toISOString() };
  await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: new Date(now.getTime() - 60_000).toISOString(), server });
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

describe.runIf(PG)('VDP autopilot (db)', () => {
  it('off for a new user; the coverage carries the same autopilot fields as the mock (parity)', async () => {
    const s = await ds.getSettings({} as never);
    expect(s.sending.channels.vdp).toEqual({ mode: 'send', autopilot: false, dailyCap: 40 });
    const cov = await ds.getVdpCoverage({} as never);
    expect(cov.autopilot).toEqual({ ...mockCoverage.autopilot, lastRunAt: null });
    expect(Object.keys(cov.autopilot).sort()).toEqual(Object.keys(mockCoverage.autopilot).sort());
    const row = cov.vdps.find((v) => v.vdpSlug === acme.slug)!;
    expect(row.steps.find((x) => x.kind === 'account_id')).toMatchObject({ policy: 'auto', autopilot: null });
    expect(row.summary).toMatchObject({ people: { tas: [] } });
    expect(Object.keys(row).sort()).toEqual(Object.keys(mockCoverage.vdps[0]!).sort());
    const r = await ds.runVdpAutopilot({ gateway: null, auth: async () => 'ok' });
    expect(r).toMatchObject({ skipped: 'off' });
  });

  it('on with dry run on: nothing is staged or sent; Health says it is paused', async () => {
    await setSending({ channels: { vdp: { autopilot: true } } }, true);
    const before = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from drafts where owner_user_id = ${userId}`)).rows[0]!.n;
    const sim = new SimulatedOutboxTransport(() => now);
    const r = await ds.runVdpAutopilot({ gateway: new OutboxGateway(sim), auth: async () => 'ok' });
    expect(r).toMatchObject({ paused: 'dry_run', applied: 0 });
    expect(sim.calls).toEqual([]);
    expect((await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from drafts where owner_user_id = ${userId}`)).rows[0]!.n).toBe(before);
    expect((await ds.getHealth({} as never)).vdpAutopilot).toMatchObject({ paused: 'dry_run' });
  });

  it('a stale cookie pauses it ("re-auth VDP"): no call', async () => {
    await setSending({ dryRun: false }, true);
    const sim = new SimulatedOutboxTransport(() => now);
    const r = await ds.runVdpAutopilot({ gateway: new OutboxGateway(sim), auth: async () => 'stale' });
    expect(r).toMatchObject({ paused: 'reauth', applied: 0 });
    expect(sim.calls).toEqual([]);
  });

  it('applies the known fills through the Outbox under the autonomy policy, reads each back, once', async () => {
    const sim = new SimulatedOutboxTransport(() => now);
    const r = await ds.runVdpAutopilot({ gateway: new OutboxGateway(sim), auth: async () => 'ok' });
    expect(r.applied).toBeGreaterThanOrEqual(3);
    const writes = sim.calls.filter((c) => !c.tool.startsWith('get_'));
    expect(writes.map((c) => c.tool)).toEqual(expect.arrayContaining(['update_vdp_header', 'set_vdp_owners']));
    // the account id and the period from Org62; me as the TA, as the role's full list; never an AE, never a use-case edit
    expect(writes.find((c) => c.tool === 'update_vdp_header' && 'salesforce_account_id' in c.args)?.args).toMatchObject({ salesforce_account_id: '001PLACEHOLDR01XYZ' });
    expect(writes.find((c) => c.tool === 'update_vdp_header' && 'fiscal_year' in c.args)?.args).toMatchObject({ fiscal_year: 27, fiscal_quarter: 4 });
    const owners = writes.find((c) => c.tool === 'set_vdp_owners')!.args;
    expect(owners).not.toHaveProperty('account_executives');
    expect(Array.isArray(owners.technical_architects)).toBe(true);
    expect(writes.some((c) => c.tool === 'update_use_case' || c.tool === 'create_use_case' || c.tool.startsWith('delete_'))).toBe(false);
    // the approval is the autonomy policy's, anchored on the user's policy row; History's actor is the policy
    const rows = await handle.db.execute<{ approval_method: string; autonomy_level: string; autonomy_policy_id: string | null; status: string }>(sql`
      select approval_method::text, autonomy_level::text, autonomy_policy_id::text, status::text from drafts where owner_user_id = ${userId} and approval_method = 'autonomy_policy'`);
    expect(rows.rows.length).toBe(r.applied);
    expect(rows.rows.every((x) => x.autonomy_level === 'L4_auto' && x.autonomy_policy_id && x.status === 'verified')).toBe(true);
    const cs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from change_sets where owner_user_id = ${userId} and actor_kind = 'autonomy_policy'`);
    expect(cs.rows[0]!.n).toBeGreaterThan(0);
    // D-75: Activity's, never the Outbox page's ("Applied automatically" is on the draft; the payload's applied list has it)
    const outbox = await ds.getOutbox({} as never);
    expect(outbox.groups.flatMap((g) => g.items).filter((i) => i.draft.appliedBy === 'autopilot').length).toBe(0);
    expect(outbox.admin.applied.filter((i) => i.draft.appliedBy === 'autopilot').length).toBe(Math.min(r.applied, 50));
    // the page: applied, waiting for the next read; the head's line
    const cov = await ds.getVdpCoverage({} as never);
    expect(cov.autopilot).toMatchObject({ on: true, appliedToday: r.applied });
    expect(cov.vdps.find((v) => v.vdpSlug === acme.slug)!.steps.find((s) => s.kind === 'account_id')).toMatchObject({ state: 'waiting', autopilot: { state: 'applied' } });
    // a second run makes no call twice
    const sim2 = new SimulatedOutboxTransport(() => now);
    const again = await ds.runVdpAutopilot({ gateway: new OutboxGateway(sim2), auth: async () => 'ok' });
    expect(again.applied).toBe(0);
    expect(sim2.calls).toEqual([]);
  });

  it('a read-back that finds nothing returns the item to you, with the error; it is never retried', async () => {
    // a newer read: the opp now closes next quarter (FY28 Q1) and VDP still shows no period: a new call, whose
    // read-back finds no VDP
    now = new Date(now.getTime() + 60 * 60_000);
    await withChangeSet({ db: handle.db, userId, actor: actors.system('vdp-test'), reason: 'test fixture: the close date moved' }, async (tx) => {
      await tx.execute(sql`update opportunities set close_date = '2027-03-15' where org62_opportunity_id = '006PLACEHOLDR01XYZ' and owner_user_id = ${userId}`);
    });
    await saveVdpMirror(handle.db, userId, { snapshots: [acme], complete: true, readAt: now.toISOString() });
    const fake = new FakeMcp().on('update_vdp_header', () => ({ text: JSON.stringify({ vdp: { id: acme.id }, message: 'Updated (fake).' }) })).on('get_vdp', () => ({ text: JSON.stringify({ vdp: null }) })).on('set_vdp_owners', () => ({ text: JSON.stringify({ vdp: { id: acme.id } }) }));
    const r = await ds.runVdpAutopilot({ gateway: new OutboxGateway(fake), auth: async () => 'ok' });
    expect(fake.calls.filter((c) => c.tool === 'update_vdp_header').map((c) => c.args)).toEqual([expect.objectContaining({ fiscal_year: 28, fiscal_quarter: 1 })]);
    expect(r.failed).toBe(1);
    const cov = await ds.getVdpCoverage({} as never);
    const step = cov.vdps.find((v) => v.vdpSlug === acme.slug)!.steps.find((s) => s.kind === 'fiscal_period')!;
    expect(step).toMatchObject({ state: 'todo', autopilot: { state: 'failed' } });
    expect(step.autopilot!.detail).toMatch(/Read-back/);
    expect(cov.autopilot).toMatchObject({ failedToday: 1 });
    // never retried: the next run makes no call for it
    const fake2 = new FakeMcp();
    await ds.runVdpAutopilot({ gateway: new OutboxGateway(fake2), auth: async () => 'ok' });
    expect(fake2.calls.filter((c) => c.tool === 'update_vdp_header')).toEqual([]);
  });

  it('a staged change VDP already has is withdrawn after the next read', async () => {
    await setSending({ channels: { vdp: { autopilot: false } } });
    const cov = await ds.getVdpCoverage({} as never);
    const uc = cov.vdps.find((v) => v.vdpSlug === acme.slug)!.steps.find((s) => s.kind === 'use_case_fields' && s.state === 'todo')!;
    const made = await ds.draftVdpUpdate({ body: { itemKey: uc.apply!.key, values: Object.fromEntries(uc.apply!.fields.map((f) => [f.field, f.field === 'persona' ? 'Placeholder persona' : f.options[0] ?? (/_date$/.test(f.field) ? '2027-01-15' : 'Placeholder')])) } } as never);
    // the next read shows the use case complete
    now = new Date(now.getTime() + 60 * 60_000);
    const filled = { ...acme, useCases: acme.useCases.map((u) => (u.id === uc.gaps[0]!.useCaseId ? { ...u, persona: 'Placeholder persona', division: u.division ?? 'Placeholder', priority: u.priority ?? '2 - Medium', title: u.title ?? 'Placeholder', detailsInput: u.detailsInput ?? 'Placeholder', executionPhase: u.executionPhase ?? 'Build', executionTargetDate: u.executionTargetDate ?? '2027-01-15' } : u)) };
    await saveVdpMirror(handle.db, userId, { snapshots: [filled], complete: true, readAt: now.toISOString() });
    const ids = await ds.withdrawGoneVdpDrafts();
    expect(ids).toContain(made.entity.draft.id);
    const d = await ds.getDraft({ params: { id: made.entity.draft.id } } as never);
    expect(d).toMatchObject({ status: 'discarded', rejectedReason: 'Withdrawn: VDP already has this' });
    expect(await ds.withdrawGoneVdpDrafts()).toEqual([]);
  });
});
