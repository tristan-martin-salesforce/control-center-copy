/**
 * D-69 on Postgres (fakes only, nothing real is called): the Org62 account hierarchy job (a fake read-only lookup, level
 * by level into kv), your company mapping (Change…) with Undo and Reset, a "not found" create_vdp dropping its cached
 * company match (VD-06), a running push's items never withdrawn by a read (VD-24), and a staged item pushed with new
 * values staged again (VD-26). Placeholders only.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, pgAvailable } from '../../support/pg';

import type { Seed } from '../../../src/contract';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { runHierarchyJob } from '../../../src/jobs/handlers/account-hierarchy';
import { ACCOUNT_HIERARCHY_KV, hierarchyOf } from '../../../src/lib/accounts/hierarchy';
import { mockVdpServer, mockVdpSnapshots } from '../../../src/mock/vdp';
import { OutboxGateway } from '../../../src/outbox';
import { personaOf } from '../../../src/personas';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { loadVdpServer, saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { vdpPushJobDef } from '../../../src/jobs/handlers/vdp-push';
import { VDP_PUSH_KV } from '../../../src/server/vdp/push';
import { pendingIdentityUnits } from '../../../src/jobs/handlers/vdp-identity';
import { VDP_IDENTITY_JUDGE_KV } from '../../../src/engines/vdp/identity';
import { companyQueries } from '../../../src/server/datasource/db/store/vdp';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { putKv } from '../../../src/server/datasource/db/ext';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';
const NAME = `control_center_vdprt_${SUFFIX}`;
const URL_ = `postgres://localhost:5432/${NAME}`;
const PG = pgAvailable && process.env.CC_VDP_DB !== '0';

let handle: DbHandle;
let ds: DbDataSource;
let userId: string;
let now: Date;
let byName: Map<string, string>;

const job = (payload: Record<string, unknown> = {}) => ({ job: { id: 1, payload } as never, signal: new AbortController().signal, db: handle.db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({ id: 0, inserted: false }), services: undefined });
/** A test write to an audited table, in its own change set (the triggers refuse a bare one). */
const audited = (fn: (tx: Parameters<Parameters<typeof withChangeSet>[1]>[0]) => Promise<unknown>) => withChangeSet({ db: handle.db, userId, actor: actors.system('test'), reason: 'test setup', entity: { type: 'settings', id: 'test' }, undoable: false }, fn);
const setDryRun = async (dryRun: boolean) => {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun }, confirm: true } } as never);
};

beforeAll(async () => {
  if (!PG) return;
  if (!/^control_center_vdprt_[a-z0-9]+$/.test(NAME)) throw new Error(`refusing database ${NAME}`);
  await freshDb(NAME);
  await runMigrations({ url: URL_, log: () => {} });
  handle = createDb({ url: URL_, max: 5, applicationName: 'vdp-roundtrip-test' });
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  now = mock.now();
  const s = seedFromMock(mock);
  const seed: Seed = s.seed;
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt: s.rankedAt, reset: false });
  userId = res.userId;
  const at = now.toISOString();
  const snaps = mockVdpSnapshots(mock.store.all('accounts'), mock.store.all('opps'), mock.store.meta().user, at);
  await saveVdpMirror(handle.db, userId, { snapshots: snaps, complete: true, readAt: at, server: mockVdpServer(mock.store.all('accounts'), mock.store.all('opps'), snaps, at) });
  mock.dispose();
  ds = new DbDataSource({ handle, url: URL_, userId, clock: { now: () => now }, ranker: interimRanker });
  const accs = await handle.db.execute<{ id: string; name: string }>(sql`select id, name from accounts where owner_user_id = ${userId}`);
  byName = new Map(accs.rows.map((r) => [r.name, r.id]));
  // a live push needs VDP's sign-in (VD-28): the seed's connector waits for auth, so mark it signed in
  await audited((tx) => tx.execute(sql`update connectors set status = 'healthy' where owner_user_id = ${userId} and kind = 'vdp'`));
});

afterAll(async () => {
  if (!PG) return;
  await ds?.dispose();
  await handle?.close();
});

describe.runIf(PG)('D-69 on the db', () => {
  it('accounts.hierarchy: one read-only SOQL per batch and level (a fake lookup), the parents outside my book kept; the identity reads it', async () => {
    const asked: string[] = [];
    const lookup = async (l: { tool: string; args: Record<string, unknown> }) => {
      const q = String(l.args.q);
      asked.push(q);
      // level 0: my book; Globex - Marketing Cloud's parent is Globex, Nexus Care's is outside the book
      const records = q.includes("'001XX0000SEED90'")
        ? [{ Id: '001XX0000SEED90AAA', Name: 'Tyrell Holdings', ParentId: null }]
        : [
            { Id: '001XX0000SEED02AAA', Name: 'Globex', ParentId: null },
            { Id: '001XX0000SEED06AAA', Name: 'Globex - Marketing Cloud', ParentId: '001XX0000SEED02AAA' },
            { Id: '001XX0000SEED07AAA', Name: 'Nexus Care', ParentId: '001XX0000SEED90AAA' },
          ];
      return { text: JSON.stringify({ records }), code: 'ok', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, model: '', started: true };
    };
    const r = await runHierarchyJob(job({ trigger: 'daily' }) as never, { lookup: lookup as never, live: true, persona: async () => personaOf({}) });
    expect(r).toMatchObject({ full: true, withParent: 2 });
    expect(asked[0]).toMatch(/^SELECT Id, Name, ParentId, SystemModstamp FROM Account WHERE Id IN \(/);
    // level 1: only the parent outside my book (Globex is in it, read at level 0)
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("Id IN ('001XX0000SEED90')");
    const kv = await handle.db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${ACCOUNT_HIERARCHY_KV}`);
    const h = hierarchyOf(kv.rows[0]!.value);
    expect(h.nodes['001XX0000SEED90']).toMatchObject({ name: 'Tyrell Holdings', parentId: null });
    expect(h.nodes['001XX0000SEED06']).toMatchObject({ parentId: '001XX0000SEED02' });
    // a second run with nothing new reads nothing
    expect(await runHierarchyJob(job() as never, { lookup: lookup as never, live: true, persona: async () => personaOf({}) })).toMatchObject({ skipped: 'fresh' });
    // the Marketing Cloud child now goes with Globex: one node, one VDP to create for both
    const cov = await ds.getVdpCoverage({} as never);
    const globex = cov.identities.find((i) => i.accounts.some((a) => a.name === 'Globex'))!;
    expect(globex.accounts.map((a) => a.name)).toEqual(['Globex', 'Globex - Marketing Cloud']);
  });

  it('VD-35 the identity judgment judges exactly the view’s units, so a judgment it stores is one the view applies', async () => {
    // every text the view asks about has been looked up (no match): the companies with a parent of another name are ambiguous
    const qs = await companyQueries(handle.db, userId);
    const saved = (await handle.db.execute<{ c: unknown }>(sql`select info->'companies' as c from vdp_server where owner_user_id = ${userId}`)).rows[0]?.c ?? [];
    const lookups = qs.map((q) => ({ query: q, at: now.toISOString(), matches: [] }));
    await handle.db.execute(sql`update vdp_server set info = jsonb_set(info, '{companies}', ${JSON.stringify(lookups)}::jsonb) where owner_user_id = ${userId}`);
    const view = await ds.vdpIdentityPending();
    expect(view.length).toBeGreaterThan(0);
    // the job (with the worker's handle) asks about the very same units: keys and hashes
    const fromJob = await pendingIdentityUnits(handle.db, userId, handle);
    expect(fromJob.pending.map((u) => [u.key, u.hash])).toEqual(view.map((u) => [u.key, u.hash]));
    // a judgment stored for the view's unit is applied by the view, and the unit is no longer pending
    const unit = view[0]!;
    const acct = unit.accounts[0]!;
    const judgments = { [unit.key]: { hash: unit.hash, at: now.toISOString(), model: 'test', accounts: unit.accounts.map((a) => ({ accountId: a.id, pick: { kind: 'create' as const, name: a.name, aliases: [] }, level: 0, confidence: 0.9, reason: 'Its own company (test judgment)' })) } };
    await audited((tx) => putKv(tx, userId, VDP_IDENTITY_JUDGE_KV, { units: judgments }));
    const cov = await ds.getVdpCoverage({} as never);
    const shown = cov.identities.find((i) => i.accounts.some((a) => a.id === acct.id))!;
    expect(shown).toMatchObject({ by: 'judgment', state: 'resolved' });
    expect((await ds.vdpIdentityPending()).map((u) => u.key)).not.toContain(unit.key);
    await audited((tx) => putKv(tx, userId, VDP_IDENTITY_JUDGE_KV, {}));
    await handle.db.execute(sql`update vdp_server set info = jsonb_set(info, '{companies}', ${JSON.stringify(saved)}::jsonb) where owner_user_id = ${userId}`);
  });

  it('Change… on the db: your mapping is kept, used everywhere, undone by Undo, dropped by Reset', async () => {
    const soylent = byName.get('Soylent Foods')!;
    const key = `account:${soylent}`;
    const set = await ds.setVdpIdentity({ body: { key, accountIds: [soylent], pick: { kind: 'match', id: '00000000-0000-4000-8000-000000000204', name: 'Soylent Corporation' } } } as never);
    expect(set.entity.identity).toMatchObject({ state: 'resolved', by: 'you', pick: { kind: 'match', name: 'Soylent Corporation' } });
    expect(set.auditId).toBeTruthy();
    let cov = await ds.getVdpCoverage({} as never);
    expect(cov.notInVdp.find((r) => r.key === key)!.step).toMatchObject({ kind: 'create_vdp', apply: { fields: expect.arrayContaining([expect.objectContaining({ field: 'company_id', suggested: '00000000-0000-4000-8000-000000000204' })]) } });
    await ds.undoAudit({ params: { id: set.auditId! }, body: {} } as never);
    cov = await ds.getVdpCoverage({} as never);
    expect(cov.identities.find((i) => i.key === key)).toMatchObject({ by: 'rules', pick: { kind: 'create', name: 'Soylent Foods' } });
    const again = await ds.setVdpIdentity({ body: { key, accountIds: [soylent], pick: { kind: 'create', name: 'Soylent Group Placeholder', aliases: [] } } } as never);
    expect(again.entity.identity).toMatchObject({ by: 'you', pick: { kind: 'create', name: 'Soylent Group Placeholder' } });
    const reset = await ds.clearVdpIdentity({ body: { key } } as never);
    expect(reset.entity).toMatchObject({ overrides: 0, identity: { by: 'rules' } });
    await expect(ds.setVdpIdentity({ body: { accountIds: ['00000000-0000-4000-8000-00000000dead'], pick: { kind: 'create', name: 'X', aliases: [] } } } as never)).rejects.toThrow(/Not an account of yours/);
  });

  it('VD-06 a "not found" create_vdp drops the cached company match, so the next read looks the name up again', async () => {
    const before = await loadVdpServer(handle.db, userId);
    const globexLookup = before!.companies.find((c) => c.matches.some((m) => m.name === 'Globex'))!;
    const companyId = globexLookup.matches.find((m) => m.name === 'Globex')!.id;
    await setDryRun(false);
    try {
      const globex = byName.get('Globex')!;
      const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: `account:${globex}:create_vdp` }] } } as never);
      expect(r.results[0]).toMatchObject({ state: 'queued' });
      const gone = { callTool: async (c: { tool: string }) => (c.tool === 'create_vdp' ? { isError: true, text: `createVdp: company ${companyId} not found` } : { text: '{}' }) };
      await vdpPushJobDef({ handle, gateway: new OutboxGateway(gone) }).handler(job({ pushId: r.pushId }) as never);
      const after = await loadVdpServer(handle.db, userId);
      expect(after!.companies.some((c) => c.matches.some((m) => m.id === companyId))).toBe(false);
      const cov = await ds.getVdpCoverage({} as never);
      expect(cov.push!.nodes[0]).toMatchObject({ state: 'failed', detail: expect.stringMatching(/not_found/) });
      // the name is "Not looked up yet" again until the next read (never pushed on the dead id)
      expect(cov.notInVdp.find((x) => x.key === `account:${globex}`)!.step.disabled).toBe('Not looked up yet: the next VDP read looks the company up in VDP');
    } finally {
      await setDryRun(true);
    }
  });

  it('VD-24 a read landing mid-push withdraws none of the running push’s items; VD-26 values pushed again restage the item', async () => {
    const acme = 'acme-corp-1';
    const setEntitlement = (v: string | null) => handle.db.execute(sql`update vdp_records set detail = jsonb_set(detail, '{entitlementLeveraged}', ${JSON.stringify(v)}::jsonb), last_seen_at = ${now} where owner_user_id = ${userId} and vdp_slug = ${acme}`);
    const staged = await ds.draftVdpUpdate({ body: { itemKey: `${acme}:entitlement`, values: { entitlement_leveraged: 'Flex' } } } as never);
    await audited((tx) => tx.execute(sql`update drafts set created_at = ${new Date(now.getTime() - 120_000)} where id = ${staged.entity.draft.id}`));
    // the next read shows the value (the item closes) while a push of it is running: the withdraw leaves it be
    now = new Date(now.getTime() + 60_000);
    await setEntitlement('Flex');
    const run = { id: 'push-x', at: now.toISOString(), dryRun: false, state: 'running', finishedAt: null, nodes: [{ key: `${acme}:entitlement`, title: 'Entitlement', companyName: 'ACME Corp', op: 'update_vdp_header', requires: [], draftId: staged.entity.draft.id, state: 'queued', detail: null, externalId: null, slug: null, at: null }] };
    await audited((tx) => putKv(tx, userId, VDP_PUSH_KV, [run]));
    expect(await ds.withdrawGoneVdpDrafts()).toEqual([]);
    // once the push is done, the same read withdraws it (VDP already has it)
    await audited((tx) => putKv(tx, userId, VDP_PUSH_KV, [{ ...run, state: 'done' }]));
    expect(await ds.withdrawGoneVdpDrafts()).toEqual([staged.entity.draft.id]);
    // VD-26: the value open again, staged with Flex, then pushed with another: staged again, the old one withdrawn
    await setEntitlement(null);
    await audited((tx) => putKv(tx, userId, VDP_PUSH_KV, null));
    const first = await ds.draftVdpUpdate({ body: { itemKey: `${acme}:entitlement`, values: { entitlement_leveraged: 'Flex' } } } as never);
    const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: `${acme}:entitlement`, values: { entitlement_leveraged: 'Conversations' } }] } } as never);
    // 2026-11-16: the click queues the push (a dry run too); the worker stages the item, then records it
    expect(r.results[0]).toMatchObject({ state: 'queued', draftId: null });
    await vdpPushJobDef({ handle, gateway: null }).handler(job({ pushId: r.pushId }) as never);
    const node = (await ds.getVdpCoverage({} as never)).push!.nodes[0]!;
    expect(node).toMatchObject({ state: 'dry_run' });
    expect(node.draftId).not.toBe(first.entity.draft.id);
    const old = await ds.getDraft({ params: { id: first.entity.draft.id } } as never);
    expect(old).toMatchObject({ status: 'discarded', rejectedReason: 'Replaced: staged again with the values you pushed' });
    const fresh = await ds.getDraft({ params: { id: node.draftId! } } as never);
    expect((fresh.destination as unknown as { input: { value: unknown } }).input.value).toBe('Conversations');
  });
});
