/**
 * Parity for Time ▸ VDP details: the mock's placeholder VDPs and asset candidates loaded into Postgres, then the same
 * reads and writes on both DataSources (getVdpCoverage with its asset summary, getVdpDetail for a VDP and for an
 * account with no VDP, setVdpCandidate, findVdpAssets estimate and start), compared after the standard normalizations.
 * Details keys carry account ids (`account:<id>`), so those are translated too.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, vdpKeyOfAccount, type RouteKey } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { vdpAssetCandidates } from '../../../src/db/schema';
import { mockSpecialistAes, mockVdpCandidates, mockVdpServer, mockVdpSnapshots } from '../../../src/mock/vdp';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { putKv } from '../../../src/server/datasource/db/ext';
import { VDP_AES_KV } from '../../../src/server/vdp/specialist-aes';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import type { DataSource } from '../../../src/server/datasource/types';
import { assetTargets } from '../../../src/server/vdp/detail';
import { BE1B, diffPaths, loadBoth, openTestDb, translateIds, type Loaded } from './helpers';
import { normalizeValue, placeholders } from './normalize';
import { stableIds } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;
let accountKey: string;
let slugs: string[];
let candidateIds: string[];

/** `account:<mock id>` (values, record keys, gap ids) → `account:<db id>`, then the usual id translation. */
function translateKeys(v: unknown): unknown {
  // gap ids embed them too ("account:<id>:company_not_in_vdp", "opp:<id>:opp_without_vdp")
  // D-63: and the items under a VDP name their opp ("add_opp:<id>", "remove_opp:<id>", "<slug>:remove_opp:<id>")
  const tr = (s: string) => s.replace(/^(account|opp|add_opp|remove_opp):([^:#]+)/, (_m, kind: string, id: string) => `${kind}:${L.idMap.get(id) ?? id}`).replace(/:remove_opp:([^:#]+)$/, (_m, id: string) => `:remove_opp:${L.idMap.get(id) ?? id}`).replace(/#(add_opp|remove_opp):([^:]+)$/, (_m, kind: string, id: string) => `#${kind}:${L.idMap.get(id) ?? id}`);
  const walk = (x: unknown): unknown => (typeof x === 'string' ? tr(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [tr(k), walk(y)])) : x);
  return translateIds(walk(v), L.idMap);
}

async function compare(key: RouteKey, mockInput: Record<string, unknown>, dbInput: Record<string, unknown>) {
  const def = routes[key] as { response: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } };
  const call = async (ds: DataSource, input: Record<string, unknown>) => {
    const out = await (ds[key] as unknown as (i: unknown) => Promise<unknown>).call(ds, input);
    const r = def.response.safeParse(out);
    if (!r.success) throw new Error(`${ds.kind} ${key} failed contract validation: ${JSON.stringify(r.error).slice(0, 400)}`);
    return out;
  };
  const m = await call(L.mock, mockInput);
  const d = await call(db, dbInput);
  const stable = stableIds(L);
  const norm = (v: unknown) => placeholders(normalizeValue(v), stable, { times: true });
  return { mock: m, db: d, diffs: diffPaths(norm(translateKeys(m)), norm(d), '$', [], 60) };
}

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle);
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
  // The mock's placeholder VDPs → the db mirror; its placeholder candidates → vdp_asset_candidates (same ids).
  const at = L.now.toISOString();
  const snaps = mockVdpSnapshots(L.mock.store.all('accounts'), L.mock.store.all('opps'), L.mock.store.meta().user, at);
  // D-59: the same placeholder server info (tools, company lookups) on both sides
  const server = mockVdpServer(L.mock.store.all('accounts'), L.mock.store.all('opps'), snaps, at);
  await saveVdpMirror(handle.db, L.userId, { snapshots: snaps, complete: true, readAt: at, server });
  // D-63: the mock's placeholder Specialist Forecast AEs, as the db's vdp.specialist_aes caches them (by Org62 opp id)
  const aes = mockSpecialistAes(L.mock.store.all('accounts'), L.mock.store.all('opps'));
  const byOpp: Record<string, unknown> = {};
  for (const o of L.mock.store.all('opps')) {
    const org62 = /\b(006[A-Za-z0-9]{12})/.exec(o.org62Url ?? '')?.[1];
    if (org62 && aes.get(o.id)) byOpp[org62] = aes.get(o.id);
  }
  await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('be1b'), reason: 'placeholder VDP AEs', undoable: false }, async (tx) => putKv(tx, L.userId, VDP_AES_KV, { readAt: at, byOpp, read: Object.keys(byOpp) }));
  const cov = await L.mock.getVdpCoverage({} as never);
  const cands = mockVdpCandidates(snaps, assetTargets(cov, snaps, L.mock.store.all('accounts')), at);
  for (const c of cands) {
    const accountId = c.accountId ? (L.idMap.get(c.accountId) ?? c.accountId) : null;
    await handle.db.insert(vdpAssetCandidates).values({
      id: c.id,
      ownerUserId: L.userId,
      targetKey: L.idMap.get(c.targetKey) ?? c.targetKey,
      vdpSlug: c.vdpSlug,
      accountId,
      companyName: c.companyName,
      title: c.title,
      url: c.url,
      assetKey: c.assetKey,
      kind: c.kind,
      why: c.why,
      confidence: c.confidence,
      origin: c.origin,
      status: c.status,
      sources: c.sources as unknown as Array<Record<string, unknown>>,
      firstSeenAt: new Date(c.firstSeenAt),
      lastSeenAt: new Date(c.firstSeenAt),
    });
  }
  // D-69 (VD-28): the mock's VDP is signed in (its simulated auth); the seed's db connector waits for auth: sign it in
  await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('be1b'), reason: 'VDP signed in', undoable: false }, async (tx) => tx.execute(sql`update connectors set status = 'healthy' where owner_user_id = ${L.userId} and kind = 'vdp'`));
  slugs = cov.vdps.map((v) => v.vdpSlug);
  accountKey = vdpKeyOfAccount(cands.find((c) => !c.vdpSlug)!.accountId!);
  candidateIds = cands.map((c) => c.id);
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const dbKey = (k: string) => (k.startsWith('account:') ? `account:${L.idMap.get(k.slice(8)) ?? k.slice(8)}` : k);

describe.runIf(BE1B)('VDP details parity: mock ↔ db on the same VDPs and candidates', () => {
  it('getVdpCoverage (gaps, items, one status per VDP, the summary, Not in VDP yet, the asset summary per key)', async () => {
    const r = await compare('getVdpCoverage', {}, {});
    expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    const d = r.db as { assets: { toAdd: number }; summary: { needYou: number }; vdps: Array<{ status: { state: string } }>; notInVdp: Array<{ step: { who: string } }> };
    expect(d.assets.toAdd).toBeGreaterThan(0);
    expect(d.summary.needYou).toBeGreaterThan(0);
    expect(d.vdps.every((v) => ['open', 'waiting', 'done', 'past'].includes(v.status.state))).toBe(true);
    // the first engaged account with no VDP is known to VDP (mock lookup): its VDP is one Apply on both sides
    expect(d.notInVdp.some((x) => x.step.who === 'app')).toBe(true);
  });

  it('getVdpDetail for every VDP and for an account with no VDP', async () => {
    for (const key of [...slugs, accountKey]) {
      const r = await compare('getVdpDetail', { query: { key } }, { query: { key: dbKey(key) } });
      expect(r.diffs, `${key}\n${r.diffs.join('\n')}`).toEqual([]);
    }
  });

  it('setVdpCandidate: confirm an unsure one, mark one added, dismiss and put back', async () => {
    const unsure = candidateIds[1]!;
    for (const [id, status] of [
      [unsure, 'suggested'],
      [candidateIds[0]!, 'added'],
      [candidateIds[2]!, 'dismissed'],
      [candidateIds[2]!, 'suggested'],
    ] as const) {
      const input = { params: { id }, body: { status } };
      const r = await compare('setVdpCandidate', input, input);
      expect(r.diffs, `${id} → ${status}\n${r.diffs.join('\n')}`).toEqual([]);
    }
    const after = await compare('getVdpDetail', { query: { key: slugs[0]! } }, { query: { key: slugs[0]! } });
    expect(after.diffs, after.diffs.join('\n')).toEqual([]);
  });

  it('findVdpAssets: the estimate for all, then one run started', async () => {
    const est = await compare('findVdpAssets', { body: { all: true, estimateOnly: true } }, { body: { all: true, estimateOnly: true } });
    expect(est.diffs, est.diffs.join('\n')).toEqual([]);
    const go = await compare('findVdpAssets', { body: { key: accountKey } }, { body: { key: dbKey(accountKey) } });
    expect(go.diffs, go.diffs.join('\n')).toEqual([]);
    expect((go.db as { entity: { started: boolean } }).entity.started).toBe(true);
  });

  it('draftVdpUpdate by item: the same ONE call staged on both sides (create_vdp for an account VDP knows), then shown staged', async () => {
    const cov = (await L.mock.getVdpCoverage({} as never)) as { notInVdp: Array<{ key: string; step: { apply: { key: string } | null; disabled: string | null } }> };
    // D-69: one that can be staged (a "Needs you" company node keeps its create_vdp disabled until you confirm it)
    const row = cov.notInVdp.find((x) => x.step.apply?.key.endsWith(':create_vdp') && !x.step.disabled)!;
    const mockKey = row.step.apply!.key;
    const dbItemKey = mockKey.replace(/^account:([^:]+)/, (_m, id: string) => `account:${L.idMap.get(id) ?? id}`);
    const r = await compare('draftVdpUpdate', { body: { itemKey: mockKey } }, { body: { itemKey: dbItemKey } });
    // draft ids and stamps differ by nature; the destination (the one call) must not
    const pick = (x: unknown) => (x as { entity: { destination: unknown } }).entity.destination;
    expect(translateKeys(pick(r.mock))).toEqual(pick(r.db));
    const states = async (ds: DataSource) => ((await ds.getVdpCoverage({} as never)) as { notInVdp: Array<{ step: { kind: string; state: string } }> }).notInVdp.map((x) => [x.step.kind, x.step.state]);
    const both = [await states(L.mock), await states(db)];
    expect(both[0]).toEqual(both[1]);
    expect(both[1]).toContainEqual(['create_vdp', 'staged']);
  });
});
