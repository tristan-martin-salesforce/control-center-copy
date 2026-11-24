/**
 * D-70 landings parity: the same seed, VDP mirror and asset candidates on the mock and on Postgres, then every landing
 * read and mutation on both (getUseCaseLandings, getRecordLandings, getEventUpdates, proposeEventUpdates,
 * patchEventUpdate, fixUseCase, pickUseCaseValue, getCanvasWrites), compared after the standard normalizations. The
 * landing sync is one pure pass (src/lib/landings/sync.ts) both DataSources run over the same world, so the first read
 * backfills the same landings on both. Row keys embed a row's id (`event:<id>`), so those are translated too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, type RouteKey } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { vdpAssetCandidates } from '../../../src/db/schema';
import { mockVdpCandidates, mockVdpSnapshots } from '../../../src/mock/vdp';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import type { DataSource } from '../../../src/server/datasource/types';
import { assetTargets } from '../../../src/server/vdp/detail';
import { BE1B, diffPaths, loadBoth, openTestDb, translateIds, type Loaded } from './helpers';
import { normalizeValue, placeholders } from './normalize';
import { stableIds } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

const EVT = '00UXX0000000EVPAAA';

/** Row keys and record ids that embed a seed id (`event:<id>`, `upd:Event:<id>:<field>`) → the db's ids. */
function translateKeys(v: unknown): unknown {
  const tr = (s: string) => s.replace(/^(event):(.+)$/, (_m, kind: string, id: string) => `${kind}:${L.idMap.get(id) ?? id}`);
  const walk = (x: unknown): unknown => (typeof x === 'string' ? tr(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
  return translateIds(walk(v), L.idMap);
}

async function compare(key: RouteKey, mockInput: Record<string, unknown>, dbInput: Record<string, unknown> = translateIds(mockInput, L.idMap) as Record<string, unknown>) {
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

const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }));

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle);
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
  // the mock's placeholder asset candidates → vdp_asset_candidates (same ids), as tests/db/datasource/vdp-detail.test.ts does
  const at = L.now.toISOString();
  const snaps = mockVdpSnapshots(L.mock.store.all('accounts'), L.mock.store.all('opps'), L.mock.store.meta().user, at);
  const cov = await L.mock.getVdpCoverage({} as never);
  for (const c of mockVdpCandidates(snaps, assetTargets(cov, snaps, L.mock.store.all('accounts')), at)) {
    await handle.db.insert(vdpAssetCandidates).values({
      id: c.id,
      ownerUserId: L.userId,
      targetKey: L.idMap.get(c.targetKey) ?? c.targetKey,
      vdpSlug: c.vdpSlug,
      accountId: c.accountId ? (L.idMap.get(c.accountId) ?? c.accountId) : null,
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
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const verifiedRow = () => L.seed.activity.find((a) => a.status === 'verified')!.id;

describe.runIf(BE1B)('D-70 landings parity: mock ↔ db', () => {
  it('getUseCaseLandings: every VDP use case, where it landed, its assets and question (the first read backfills)', async () => {
    const r = await compare('getUseCaseLandings', {});
    expect(r.diffs).toEqual([]);
    const items = (r.mock as { items: Array<{ where: string; assets: unknown[] }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((x) => x.where === 'vdp')).toBe(true);
  });

  it('getRecordLandings: a verified row has a verified Org62 landing on both (backfill)', async () => {
    const r = await compare('getRecordLandings', { query: { kind: 'activity_event', id: verifiedRow() } });
    expect(r.diffs).toEqual([]);
    expect((r.mock as { landings: Array<{ state: string }> }).landings.map((l) => l.state)).toEqual(['verified']);
  });

  it('getEventUpdates, proposeEventUpdates, patchEventUpdate: the same proposed and approved update', async () => {
    expect((await compare('getEventUpdates', {})).diffs).toEqual([]);
    const cand = { activityEntryId: verifiedRow(), org62EventId: EVT, field: 'duration', from: '2', to: '3', reason: 're-derived: hands-on 2 h → 3 h' };
    const p = await compare('proposeEventUpdates', { body: { candidates: [cand, { ...cand, field: 'Colour' }] } });
    expect(p.diffs).toEqual([]);
    const list = await compare('getEventUpdates', {});
    expect(list.diffs).toEqual([]);
    expect((list.mock as { updates: Array<{ summary: string }> }).updates.map((u) => u.summary)).toEqual(['update · Duration 2 h → 3 h']);
    const mockId = (p.mock as { proposed: string[] }).proposed[0]!;
    const dbId = (p.db as { proposed: string[] }).proposed[0]!;
    const a = await compare('patchEventUpdate', { params: { id: mockId }, body: { action: 'approve' } }, { params: { id: dbId }, body: { action: 'approve' } });
    expect(a.diffs).toEqual([]);
    expect((await compare('getRecordLandings', { query: { kind: 'activity_event', id: verifiedRow() } })).diffs).toEqual([]);
  });

  it('fixUseCase (leave it out of Org62, then back) and pickUseCaseValue (nothing differs: refused the same way)', async () => {
    const items = (L.mock.getUseCaseLandings({} as never) as unknown as Promise<{ items: Array<{ key: string; ready: boolean }> }>);
    const ready = (await items).items.find((x) => x.ready)!;
    const left = await compare('fixUseCase', { params: { key: ready.key }, body: { leave: true } });
    expect(left.diffs).toEqual([]);
    expect((left.mock as { entity: { state: string } }).entity.state).toBe('left');
    expect((await compare('getUseCaseLandings', {})).diffs).toEqual([]);
    const back = await compare('fixUseCase', { params: { key: ready.key }, body: { leave: false } });
    expect(back.diffs).toEqual([]);
    const body = { field: 'stage', take: 'vdp' };
    expect(await errorOf(db.pickUseCaseValue({ params: { key: ready.key }, body } as never))).toEqual(await errorOf(L.mock.pickUseCaseValue({ params: { key: ready.key }, body } as never)));
  });

  it('getCanvasWrites: an unknown canvas is not found on both', async () => {
    const id = '00000000-0000-4000-8000-0000000000ff';
    expect(await errorOf(db.getCanvasWrites({ params: { id } } as never))).toEqual(await errorOf(L.mock.getCanvasWrites({ params: { id } } as never)));
  });
});
