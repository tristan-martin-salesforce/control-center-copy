/**
 * BE-1b test helpers: a frozen mock, the same data loaded into Postgres, and comparison utilities.
 */
import { createDb, type DbHandle } from '../../../src/db/client';
import type { Seed } from '../../../src/contract';
import { createMockDataSource, type MockDataSource } from '../../../src/server/datasource/mock';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { rebuildEngagement } from '../../../src/server/datasource/db/attribution';
import { saveVdpMirror } from '../../../src/server/datasource/db/store/vdp';
import { saveOrg62UseCaseRead } from '../../../src/server/datasource/db/store/use-cases';
import { mockAccountHierarchy, mockIdentityJudgments, mockIdentityOverrides, mockVdpServer, mockVdpSnapshots } from '../../../src/mock/vdp';
import { eq } from 'drizzle-orm';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { changeSets } from '../../../src/db/schema';
import { putKv } from '../../../src/server/datasource/db/ext';
import { ACCOUNT_HIERARCHY_KV } from '../../../src/lib/accounts/hierarchy';
import { VDP_IDENTITY_JUDGE_KV, VDP_IDENTITY_KV } from '../../../src/engines/vdp/identity';
import { pendingIdentityUnits } from '../../../src/jobs/handlers/vdp-identity';
import { buildIdMap, translateIds, type IdMap } from '../../../src/server/datasource/db/translate';

/**
 * The suite needs its own database (global setup in tests/db/datasource/vitest.config.ts). Under the root vitest
 * config (`npm test`) it is skipped: run it with `npm run test:be1b`.
 */
export const BE1B = process.env.CC_BE1B === '1';

export const TEST_URL = process.env.BE1B_DATABASE_URL ?? 'postgres://localhost:5432/control_center_be1b_test';

export function openTestDb(max = 5): DbHandle {
  if (!/\/control_center_be1b(_[a-z0-9_]+)?(\?|$)/.test(TEST_URL)) throw new Error('BE-1b tests must use control_center_be1b*');
  return createDb({ url: TEST_URL, max, applicationName: 'be1b-test' });
}

/**
 * Timers never fire during a test (enrichment, simulated runs: ~1 day, and kept below setTimeout's 2^31 ms
 * limit so a multiple of them doesn't overflow into "now"); the clock is frozen at the seed's asOf.
 */
export function frozenMock(): MockDataSource {
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
  mock.resetStore();
  return mock;
}

export interface Loaded {
  mock: MockDataSource;
  seed: Seed;
  idMap: IdMap;
  userId: string;
  now: Date;
}

export async function loadBoth(handle: DbHandle, opts: { reset?: boolean } = {}): Promise<Loaded> {
  const mock = frozenMock();
  const { seed, rankedAt } = seedFromMock(mock);
  const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt, reset: opts.reset ?? true });
  // D-59: Today's Time badge and Home ▸ Log & fix read the VDP status, so the db mirrors the mock's placeholder VDPs
  // (and its placeholder server info), as a VDP read would
  const at = mock.now().toISOString();
  const snaps = mockVdpSnapshots(mock.store.all('accounts'), mock.store.all('opps'), mock.store.meta().user, at);
  await saveVdpMirror(handle.db, res.userId, { snapshots: snaps, complete: true, readAt: at, server: mockVdpServer(mock.store.all('accounts'), mock.store.all('opps'), snaps, at) });
  // 2026-11-13 audit C2: the mock's use-case plan has always read Org62 (readAt now), so its creates wait for a canvas;
  // the db records the same complete, empty Org62 use-case read, so Today's badge and Home count the same use cases
  await saveOrg62UseCaseRead(handle.db, res.userId, { rows: [], completeOpps: [], opps: 0, complete: true, at: new Date(at) });
  // D-69: the same company identity inputs: the Org62 hierarchy (by Org62 id), your mapping (db ids), and the judgment
  // the mock carries, made for the db's own units (their hash is theirs), as vdp.identity would cache it
  const idMap = buildIdMap(seed);
  // (one system change set each, dated well before the seed's now, so no "since" or History surface lists it)
  const long = new Date(Date.parse(seed.meta.asOf) - 60 * 86_400_000);
  const kv = (key: string, value: unknown) =>
    withChangeSet({ db: handle.db, userId: res.userId, actor: actors.system('seed'), kind: 'system', reason: 'Seed: placeholder VDP identity', undoable: false }, async (tx, cs) => {
      await putKv(tx, res.userId, key, value);
      await tx.update(changeSets).set({ createdAt: long }).where(eq(changeSets.id, cs.id));
    });
  const accounts = mock.store.all('accounts');
  await kv(ACCOUNT_HIERARCHY_KV, mockAccountHierarchy(accounts, at));
  await kv(VDP_IDENTITY_KV, { overrides: mockIdentityOverrides(accounts.map((a) => ({ ...a, id: idMap.get(a.id) ?? a.id })), at) });
  const { pending } = await pendingIdentityUnits(handle.db, res.userId);
  await kv(VDP_IDENTITY_JUDGE_KV, { units: mockIdentityJudgments(new Map(pending.map((u) => [u.key, u])), at) });
  // the attribution engine's rollup (opp_engagement), as the nightly job writes it: the mock derives the same rollup from
  // its store on every read, so "you worked on it lately" weighs the same on both (DC1: covered-AE rows now reach it)
  await rebuildEngagement(handle.db, res.userId, mock.now());
  return { mock, seed, idMap, userId: res.userId, now: mock.now() };
}

export { translateIds };

/** Paths where two JSON values differ (first `limit`). */
export function diffPaths(a: unknown, b: unknown, path = '$', out: string[] = [], limit = 40): string[] {
  if (out.length >= limit) return out;
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${short(a)} ≠ ${short(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: array vs object`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length: ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out, limit);
    return out;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out, limit);
  return out;
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 120 ? `${s.slice(0, 117)}…` : s;
}
