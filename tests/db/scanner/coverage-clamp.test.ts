/**
 * Regression (stress finding C-1): an incomplete run (cursor.at < window.to) must not commit time coverage past its
 * cursor. Before the fix, Slack's S1/S2 query windows ([from, to)) masked S3's paged-out end: the ledger claimed the
 * whole window, coverageGaps() saw no hole, so if the continuation was lost the rest of S3 was never scanned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbScannerStore } from '../../../src/scanner/store-db';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import type { ScannerStore } from '../../../src/scanner/types';
import { loadProfileIntoDb, PLACEHOLDER_PROFILE } from '../../../scripts/stress/lib/profile';

import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

const W = { from: '2026-10-26T06:00:00.000Z', to: '2026-10-26T12:00:00.000Z' };
const PAGED_OUT_AT = '2026-10-26T08:00:00.000Z';

async function incompleteRun(store: ScannerStore, scope: string) {
  const key = { connector: 'slack' as const, scope };
  const { runId } = await store.startRun({ scope: key, trigger: 'catch_up', window: W });
  await store.reportCoverage(runId, [
    { kind: 'query_window', ref: 'search:dm', from: W.from, to: W.to },
    { kind: 'query_window', ref: 'search:mentions', from: W.from, to: W.to },
    { kind: 'query_window', ref: 'search:mine', from: W.from, to: PAGED_OUT_AT },
    { kind: 'thread', ref: 'slack:C0ACME001:1793800000.000100' },
  ]);
  await store.finishRun(runId, { cursor: { value: '1793866800.000000', at: PAGED_OUT_AT }, stats: { fetched: 60, new: 60, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
  return key;
}

async function expectHoleVisible(store: ScannerStore, scope: string) {
  const key = await incompleteRun(store, scope);
  expect((await store.getCursor(key))?.at).toBe(PAGED_OUT_AT);
  // The rest of the window is still a gap, so the next poll (or reconcile) re-scans it even if the continuation is lost.
  expect(await store.coverageGaps(key, W)).toEqual([{ from: PAGED_OUT_AT, to: W.to }]);
}

describe('C-1: incomplete runs never claim time coverage past their cursor', () => {
  it('InMemoryScannerStore', async () => {
    const store = new InMemoryScannerStore({ profile: { me: { userId: 'u1', name: 'ME' }, watchList: [], aliases: { accounts: [], channels: [] } } });
    await expectHoleVisible(store, 'inbox');
  });

  describe.skipIf(!pgAvailable())('DbScannerStore', () => {
    let t: TestDb;
    let store: DbScannerStore;
    beforeAll(async () => {
      t = await provisionTestDb('clamp');
      const userId = await loadProfileIntoDb(t.handle.db, PLACEHOLDER_PROFILE);
      store = new DbScannerStore({ db: t.handle.db, userId, clock: () => new Date('2026-10-26T12:30:00.000Z') });
    });
    afterAll(async () => t?.drop());
    it('keeps the hole after the paged-out query', async () => {
      await expectHoleVisible(store, 'inbox');
    });
  });
});
