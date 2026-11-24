/**
 * D-63 on Postgres (fakes only, nothing real is called): the Changes tree from the db mirror (the same shapes as the
 * mock: parity), "Push N to VDP" in dry run (each item its own Outbox item, recorded with placeholders), live through
 * the worker's `vdp.push` (in order, approved by the push click, new ids passed down, read back; a failure stops its
 * branch), and `vdp.specialist_aes` (a fixed read-only SOQL, one fake lookup) feeding the AE. Placeholders only.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import type { Seed, VdpCoveragePayload } from '../../../src/contract';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { vdpPushJobDef } from '../../../src/jobs/handlers/vdp-push';
import { runVdpAesJob } from '../../../src/jobs/handlers/vdp-specialist-aes';
import { vdpActionPayload } from '../../../src/lib/vdp/payload';
import { mockAccountHierarchy, mockIdentityOverrides, mockVdpServer, mockVdpSnapshots } from '../../../src/mock/vdp';
import { runVdpIdentityJob } from '../../../src/jobs/handlers/vdp-identity';
import { ACCOUNT_HIERARCHY_KV } from '../../../src/lib/accounts/hierarchy';
import { VDP_IDENTITY_KV } from '../../../src/engines/vdp/identity';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { putKv as writeKv } from '../../../src/server/datasource/db/ext';
import { OutboxGateway, SimulatedOutboxTransport } from '../../../src/outbox';
import { personaOf } from '../../../src/personas';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { createMockDataSource } from '../../../src/server/datasource/mock';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_vdppush_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_VDP_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let mockTree: VdpCoveragePayload['tree'];
let userId: string;
let now: Date;
let ids: Map<string, string>;

/**
 * The tree's shape without ids: company, VDP and section kinds, each item's kind (db and mock agree on these). Assets
 * are left out: the mock invents its candidates, the db has none here (tests/db/datasource/vdp-detail.test.ts loads the same
 * candidates on both sides and compares those).
 */
const shape = (tree: VdpCoveragePayload['tree']) => tree.map((c) => [c.companyName, c.exists, c.node?.step?.kind ?? null, c.vdps.map((v) => [v.exists, v.node?.step?.kind ?? null, v.sections.filter((s) => s.kind !== 'assets').map((s) => [s.kind, s.items.map((i) => [i.step?.kind ?? 'asset', i.step?.disabled ?? i.asset?.disabled ?? null, i.children.map((x) => x.step?.kind)])])])]);
const setDryRun = async (dryRun: boolean) => {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun }, confirm: true } } as never);
};
const key = (k: string) => k.replace(/^account:([^:]+)/, (_m, id: string) => `account:${ids.get(id) ?? id}`);
const job = (pushId: string) => ({ job: { id: 1, payload: { pushId } } as never, signal: new AbortController().signal, db: handle.db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({ id: 0, inserted: false }), services: undefined });

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_vdppush_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'vdp-push-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  mockTree = (await mock.getVdpCoverage({} as never)).tree;
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  userId = res.userId;
  // the mock's placeholder VDPs and server info, as a VDP read would store them
  const at = now.toISOString();
  const snaps = mockVdpSnapshots(mock.store.all('accounts'), mock.store.all('opps'), mock.store.meta().user, at);
  await saveVdpMirror(handle.db, userId, { snapshots: snaps, complete: true, readAt: at, server: mockVdpServer(mock.store.all('accounts'), mock.store.all('opps'), snaps, at) });
  // D-69: the same Org62 hierarchy (keyed by Org62 ids) and your mapping (db ids) as the mock, as kv
  const mockAccounts = mock.store.all('accounts');
  mock.dispose();
  ds = new DbDataSource({ handle, url: URL_, userId, clock: { now: () => now }, ranker: interimRanker });
  const accs = await handle.db.execute<{ id: string; name: string }>(sql`select id, name from accounts where owner_user_id = ${userId}`);
  const byName = new Map(accs.rows.map((r) => [r.name, r.id]));
  const putKv = (k: string, v: unknown) => withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'test setup', entity: { type: 'settings', id: k }, undoable: false }, (tx) => writeKv(tx, userId, k, v));
  // D-69 (VD-28): a live push needs VDP's sign-in: the seed's connector waits for auth, so mark it signed in
  await withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'test setup', entity: { type: 'settings', id: 'vdp' }, undoable: false }, (tx) => tx.execute(sql`update connectors set status = 'healthy' where owner_user_id = ${userId} and kind = 'vdp'`));
  await putKv(ACCOUNT_HIERARCHY_KV, mockAccountHierarchy(mockAccounts, at));
  await putKv(VDP_IDENTITY_KV, { overrides: mockIdentityOverrides(mockAccounts.map((a) => ({ ...a, id: byName.get(a.name)! })), at) });
  // the judgment for the ambiguous one, through the job and a fake model (the mock's placeholder decision)
  const model = async (req: { user: string }) => {
    const u = JSON.parse(req.user) as { accounts: Array<{ id: string; name: string }> };
    const nexus = u.accounts.find((a) => a.name === 'Nexus Care');
    return { ok: !!nexus, text: JSON.stringify({ accounts: nexus ? [{ accountId: nexus.id, pick: { kind: 'create', name: 'Nexus Care', aliases: [] }, level: 0, confidence: 0.86, reason: 'Its own brand under Tyrell Holdings: a company of its own' }] : [] }), costUsd: 0, inputTokens: 0, outputTokens: 0 };
  };
  const judged = await runVdpIdentityJob(job('x') as never, { model: model as never, live: true, persona: async () => personaOf({}) });
  if (!judged.judged) throw new Error(`the identity job judged nothing: ${JSON.stringify(judged)}`);
  ids = new Map([
    ['acc_initech', byName.get('Initech')!],
    ['acc_globex', byName.get('Globex')!],
    ['acc_acme', byName.get('ACME Corp')!],
  ]);
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

describe.runIf(PG)('D-63 on the db', () => {
  it('the tree: the same three shapes as the mock (parity), the disabled row included', async () => {
    const cov = await ds.getVdpCoverage({} as never);
    expect(shape(cov.tree)).toEqual(shape(mockTree));
    expect(cov.tree.map((c) => c.companyName)).toEqual(['Initech', 'Nexus Care', 'Cyberdyne Systems', 'Globex', 'Soylent Corporation', 'ACME Corp']);
    // D-69: the identities agree with the mock's (the judgment came through the db's own vdp.identity job)
    expect(cov.tree.map((c) => [c.companyName, c.identity?.state, c.identity?.by])).toEqual(mockTree.map((c) => [c.companyName, c.identity?.state, c.identity?.by]));
  });

  it('vdp.specialist_aes (the SE persona too): one fixed read-only SOQL per batch (a fake lookup), cached per opp; the AE comes from it', async () => {
    const calls: string[] = [];
    const globex = await handle.db.execute<{ org62: string }>(sql`select org62_opportunity_id as org62 from opportunities where owner_user_id = ${userId} and name = 'Globex · Data 360 Expansion'`);
    const lookup = async (l: { tool: string; args: Record<string, unknown> }) => {
      calls.push(`${l.tool}:${String(l.args.q)}`);
      return { text: JSON.stringify({ records: [{ Opportunity__c: globex.rows[0]!.org62, ForecastType__c: 'BtL Data Cloud', OwnerId: '005XX0000000001AAA', Owner: { Name: 'BtL AE Placeholder', Email: 'btl.ae@example.com' } }] }), code: 'ok', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, model: '', started: true };
    };
    const r = await runVdpAesJob(job('x') as never, { lookup: lookup as never, live: true, persona: async () => personaOf({}) });
    expect(r).toMatchObject({ opps: 8, withAe: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^soqlQuery:SELECT Opportunity__c, ForecastType__c, OwnerId, Owner\.Name, Owner\.Email FROM SpecialistForecast__c WHERE Opportunity__c IN \(/);
    // a second run with nothing new reads nothing
    expect(await runVdpAesJob(job('x') as never, { lookup: lookup as never, live: true, persona: async () => personaOf({}) })).toMatchObject({ skipped: 'fresh' });
    const cov = await ds.getVdpCoverage({} as never);
    const ae = cov.notInVdp.find((n) => n.key === key('account:acc_globex'))!.children.find((s) => s.kind === 'ae')!;
    expect(ae).toMatchObject({ title: 'AE: BtL AE Placeholder', policy: 'auto', apply: { fields: [{ field: 'account_executives', suggested: ['btl.ae@example.com'] }] } });
  });

  it('dry run: queued at once (the click never waits), then the worker records each item with placeholders and sends nothing', async () => {
    const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: key('account:acc_globex:new_vdp:owners:ta') }] } } as never);
    expect(r.dryRun).toBe(true);
    // 2026-11-16: nothing is staged on the click; the worker stages each item right before it records it
    expect(r.results.map((x) => [x.state, x.required, x.draftId])).toEqual([
      ['queued', true, null],
      ['queued', false, null],
    ]);
    const jobs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'vdp.push' and payload->>'pushId' = ${r.pushId}`);
    expect(jobs.rows[0]!.n).toBe(1);
    expect((await ds.getVdpCoverage({} as never)).push).toMatchObject({ id: r.pushId, state: 'queued', dryRun: true });
    // the worker's job, with a live transport at hand: a dry-run push records only, it never sends
    const sim = new SimulatedOutboxTransport(() => now);
    const out = await vdpPushJobDef({ handle, gateway: new OutboxGateway(sim) }).handler(job(r.pushId!) as never);
    expect(out).toMatchObject({ items: 2, dryRun: 2, applied: 0, failed: 0 });
    expect(sim.calls).toEqual([]);
    const run = (await ds.getVdpCoverage({} as never)).push!;
    expect(run).toMatchObject({ id: r.pushId, state: 'done', dryRun: true });
    expect(run.stage).toBeUndefined();
    const ta = await ds.getDraft({ params: { id: run.nodes[1]!.draftId! } } as never);
    expect(vdpActionPayload(ta.destination as never)).toMatchObject({ tool: 'set_vdp_owners', vdp_id: '(new VDP id)', pending: ['vdp_id'] });
    expect(ta.attempts.at(-1)).toMatchObject({ dryRun: true });
  });

  it('one push at a time: a second is refused while one is queued; a push whose job died reads as stopped and frees VDP', async () => {
    const first = await ds.pushVdpChanges({ body: { items: [{ itemKey: key('account:acc_globex:new_vdp:owners:ta') }] } } as never);
    await expect(ds.pushVdpChanges({ body: { items: [{ itemKey: 'acme-corp-1:owners:ta' }] } } as never)).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/A push to VDP is running \(0 of 2 done\)/) });
    // its worker job ended without finishing it (a crash past its retries)
    await handle.db.execute(sql`update jobs set status = 'dead', dead_at = now(), finished_at = now() where kind = 'vdp.push' and payload->>'pushId' = ${first.pushId}`);
    const cov = await ds.getVdpCoverage({} as never);
    expect(cov.push).toMatchObject({ id: first.pushId, state: 'stopped' });
    expect(cov.push!.nodes.map((n) => n.state)).toEqual(['skipped', 'skipped']);
    expect(cov.pushes[0]!.id).toBe(first.pushId);
    // and a new push goes
    const next = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'acme-corp-1:owners:ta' }] } } as never);
    expect(next.pushId).not.toBe(first.pushId);
    await vdpPushJobDef({ handle, gateway: new OutboxGateway(new SimulatedOutboxTransport(() => now)) }).handler(job(next.pushId!) as never);
    expect((await ds.getVdpCoverage({} as never)).pushes.map((p) => p.state).slice(0, 2)).toEqual(['done', 'stopped']);
  });

  it('live: the route stages and queues vdp.push; the worker applies in order, passes the new ids, approved by the click', async () => {
    await setDryRun(false);
    try {
      const uc = { title: 'Pilot use case', priority: '3 - High', division: 'IT', persona: 'Architect', details_input: 'Placeholder details.' };
      const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: key('account:acc_initech:new_vdp:create_use_case:generate') }, { itemKey: key('account:acc_initech:new_vdp:create_use_case'), values: uc }, { itemKey: key('account:acc_initech:new_vdp:owners:ta') }] } } as never);
      expect(r.dryRun).toBe(false);
      expect(r.results.map((x) => [x.itemKey.replace(/^account:[^:]+/, 'account:X'), x.state])).toEqual([
        ['account:X:create_company', 'queued'],
        ['account:X:create_vdp', 'queued'],
        ['account:X:new_vdp:owners:ta', 'queued'],
        ['account:X:new_vdp:create_use_case', 'queued'],
        ['account:X:new_vdp:create_use_case:generate', 'queued'],
      ]);
      const q = await handle.db.execute<{ payload: Record<string, unknown>; queue: string }>(sql`select payload, queue from jobs where kind = 'vdp.push' order by id desc limit 1`);
      expect(q.rows[0]).toEqual({ payload: { pushId: r.pushId }, queue: 'vdp' });
      // the worker's job, over the simulated VDP
      const sim = new SimulatedOutboxTransport(() => now);
      const out = await vdpPushJobDef({ handle, gateway: new OutboxGateway(sim) }).handler(job(r.pushId!) as never);
      expect(out).toMatchObject({ items: 5, applied: 5, failed: 0, skipped: 0 });
      const writes = sim.calls.filter((c) => !/^(get_|list_)/.test(c.tool));
      expect(writes.map((c) => c.tool)).toEqual(['create_company', 'create_vdp', 'set_vdp_owners', 'create_use_case', 'generate_use_case']);
      const run = (await ds.getVdpCoverage({} as never)).push!;
      const ext = (suffix: string) => run.nodes.find((n) => n.key.endsWith(suffix))!.externalId;
      expect(writes[1]!.args).toMatchObject({ company_id: ext(':create_company') });
      expect(writes[2]!.args).toMatchObject({ vdp_id: ext(':create_vdp') });
      expect(writes[4]!.args).toEqual({ vdp_id: ext(':create_vdp'), use_case_id: ext(':new_vdp:create_use_case') });
      // each item its own Outbox item, approved by the push click (approval method click), read back
      const approvals = await handle.db.execute<{ approval_method: string; status: string }>(sql`select approval_method::text, status::text from drafts where id in (${sql.join(run.nodes.map((n) => sql`${n.draftId}::uuid`), sql`, `)})`);
      expect(approvals.rows.every((x) => x.approval_method === 'click' && ['sent', 'verified'].includes(x.status))).toBe(true);
    } finally {
      await setDryRun(true);
    }
  });

  it('a failure stops its branch, the others go on; nothing is retried', async () => {
    await setDryRun(false);
    try {
      const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: key('account:acc_globex:new_vdp:owners:ae') }, { itemKey: 'acme-corp-1:owners:ta' }] } } as never);
      const sim = new SimulatedOutboxTransport(() => now);
      sim.failNextWith = 'placeholder_failure';
      await vdpPushJobDef({ handle, gateway: new OutboxGateway(sim) }).handler(job(r.pushId!) as never);
      const run = (await ds.getVdpCoverage({} as never)).push!;
      const st = Object.fromEntries(run.nodes.map((n) => [n.key.replace(/^account:[^:]+/, 'account:X'), n.state]));
      // the VDP to create goes first and fails: what needs it is not pushed; the ACME TA (another branch) is applied
      expect(st).toEqual({ 'account:X:create_vdp': 'failed', 'account:X:new_vdp:owners:ae': 'skipped', 'acme-corp-1:owners:ta': 'applied' });
      expect(sim.calls.filter((c) => c.tool === 'create_vdp')).toHaveLength(1);
    } finally {
      await setDryRun(true);
    }
  });
});
