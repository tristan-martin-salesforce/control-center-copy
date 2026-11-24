/**
 * Seed → Postgres → read model: every collection reads back as the mock holds it (after id translation).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../../../src/db/client';
import { loadModel, type CollectionName } from '../../../src/server/datasource/db/model';
import { translateHrefs } from '../../../src/server/datasource/db/translate';
import { diffPaths, loadBoth, openTestDb, translateIds, type Loaded } from './helpers';
import { BE1B } from './helpers';
import { normalizeRecord } from './normalize';

const COLLECTIONS: CollectionName[] = [
  'people',
  'accounts',
  'opps',
  'missedOpps',
  'initiatives',
  'workItems',
  'evidence',
  'nbas',
  'drafts',
  'proposals',
  'assets',
  'events',
  'slots',
  'agentRuns',
  'toolAdapters',
  'toolRuns',
  'activity',
  'timeBlocks',
  'briefs',
  'watches',
  'connectors',
  'scanRuns',
  'jobs',
  'eventLog',
  'chatThreads',
  'mappings',
  'policyVersions',
];

let handle: DbHandle;
let L: Loaded;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle);
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await handle?.close();
});

describe.runIf(BE1B)('round trip: mock store ↔ Postgres read model', () => {
  it('loads without skipping rows', async () => {
    const model = await loadModel(handle.db, L.userId, L.now);
    expect(model.all('workItems').length).toBe(L.mock.store.all('workItems').length);
  });

  for (const col of COLLECTIONS) {
    it(`${col} read back equal`, async () => {
      const model = await loadModel(handle.db, L.userId, L.now);
      const mockCol = col === 'slots' ? L.mock.store.all('slots') : (L.mock.store.all(col as never) as unknown[]);
      const want = translateHrefs(translateIds(mockCol, L.idMap), L.idMap).map((r) => normalizeRecord(col, r));
      const got = (model.all(col) as unknown[]).map((r) => normalizeRecord(col, r));
      const key = (r: unknown) => JSON.stringify((r as { id?: string; thread?: { id: string }; manifest?: { id: string }; version?: number }).id ?? (r as { thread?: { id: string } }).thread?.id ?? (r as { manifest?: { id: string } }).manifest?.id ?? (r as { version?: number }).version);
      want.sort((a, b) => key(a).localeCompare(key(b)));
      got.sort((a, b) => key(a).localeCompare(key(b)));
      const d = diffPaths(want, got);
      expect(d, d.join('\n')).toEqual([]);
    });
  }

  it('settings, meta and spend read back equal', async () => {
    const model = await loadModel(handle.db, L.userId, L.now);
    const s = translateIds(L.mock.store.settings(), L.idMap);
    const d = diffPaths(normalizeRecord('settings', s), normalizeRecord('settings', model.settings()));
    expect(d, d.join('\n')).toEqual([]);
    expect(model.spend()).toEqual(L.mock.store.spend());
    const { rankedAt, policyRankVersion, ...meta } = L.mock.store.meta();
    expect({ ...model.meta(), seedHash: undefined }).toMatchObject({ ...translateIds(meta, L.idMap), rankedAt, policyRankVersion });
  });
});
