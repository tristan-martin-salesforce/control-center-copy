/**
 * Health "Rescan" in db mode, end to end (invariant 5: the real path runs to terminal success with the result
 * present): DbDataSource.scanConnector → a real manual RuntimeJob on the Postgres queue → the worker's scan handler
 * → the runtime's run ADOPTS the queued placeholder run → ONE scan run, queued → running → succeeded, with items.
 * Before: the job carried `{connectorId, scanRunId, scope}`, the scan handler rejected it (`bad_payload`), and the
 * placeholder stayed queued forever. Placeholder fixtures only (the mock seed and a fake fetcher).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/jobs';
import type { ConnectorId, DeterministicFetcher, FetchResult } from '../../../src/scanner/types';
import { DbScannerStore } from '../../../src/scanner/store-db';
import { DbDataSource } from '../../../src/server/datasource/db';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { createMockDataSource } from '../../../src/server/datasource/mock';
import { WorkerRuntime } from '../../../src/worker/runtime';
import { buildScanning } from '../../../src/worker/scanning';

import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

/** UI source → [runtime connector, scope, item kind] for the fake fetcher. */
const TARGETS: Record<string, [ConnectorId, string, 'email' | 'calendar_event' | 'claude_session']> = {
  gmail: ['gmail', 'inbox', 'email'],
  calendar: ['calendar', 'primary', 'calendar_event'],
  claude: ['claude_sessions', 'all', 'claude_session'],
};

function fakeFetcher(connector: ConnectorId, scope: string, kind: 'email' | 'calendar_event' | 'claude_session'): DeterministicFetcher {
  let n = 0;
  return {
    connector,
    scopes: async () => [scope],
    health: async () => ({ state: 'ok', checkedAt: new Date().toISOString() }),
    async fetch(_s, _c, window): Promise<FetchResult> {
      n += 1;
      const id = `placeholder-${n}`;
      return {
        items: [{ connector, kind, externalId: id, dedupeKey: `${connector}:${id}`, contentHash: `h${n}`, occurredAt: window.from, title: 'PLACEHOLDER subject' }],
        coverage: [{ kind: 'mailbox_range', ref: `${connector}:${scope}`, from: window.from, to: window.to }],
        nextCursor: { value: String(n), at: window.to },
        complete: true,
      };
    },
  };
}

describe.skipIf(!pgAvailable())('Health Rescan (db mode) runs to one finished scan run with items', () => {
  let t: TestDb;
  let ds: DbDataSource;
  let runtime: WorkerRuntime<unknown>;
  let target: { connectorId: string; label: string; source: string };

  beforeAll(async () => {
    t = await provisionTestDb('rescan');
    const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
    mock.clock.freeze(new Date(mock.loaded.seed.meta.asOf));
    mock.resetStore();
    const { seed, rankedAt } = seedFromMock(mock);
    mock.dispose();
    const { userId } = await loadSeedIntoDb(seed, { db: t.handle.db, rankedAt, reset: true });
    ds = new DbDataSource({ handle: t.handle, userId, clock: { now: () => new Date() } });
    const conns = (await ds.getHealth({} as never)) as unknown as { connectors: Array<{ id: string; label: string; source: string; state: string }> };
    const c = conns.connectors.find((x) => TARGETS[x.source] && x.state !== 'auth_needed');
    if (!c) throw new Error('the mock seed has no healthy gmail / calendar / claude connector');
    target = { connectorId: c.id, label: c.label, source: c.source };
    const [connector, scope, kind] = TARGETS[c.source]!;
    const store = new DbScannerStore({ db: t.handle.db, userId });
    const scanning = buildScanning({ db: t.handle.db, userId, store, clock: { now: () => new Date(), sleep: async () => undefined }, fetchers: [fakeFetcher(connector, scope, kind)], llm: false });
    runtime = new WorkerRuntime({ db: t.handle.db, userId, workerId: 'w-rescan', registry: createDefaultRegistry({ scan: scanning.handlerDeps }), services: {}, listenUrl: null, hooks: [], log: () => undefined });
  });

  afterAll(async () => {
    await runtime?.stop('test done');
    await ds?.dispose?.();
    await t?.drop();
  });

  it('the UI run goes queued → succeeded with the items, through a real manual RuntimeJob that succeeds', async () => {
    const connectorRows = async () => Number((await t.handle.db.execute<{ n: string }>(sql`select count(*)::text as n from connectors`)).rows[0]!.n);
    const before = await connectorRows();
    const res = await ds.scanConnector({ params: { id: target.connectorId }, body: { scope: 'manual' } } as never);
    const runId = (res as { entity: { id: string; status: string } }).entity.id;
    expect((res as { entity: { status: string } }).entity.status).toBe('queued');
    const [job] = (await t.handle.db.execute<{ id: string; payload: { kind: string; mode: string; trigger: string } }>(sql`
      select j.id::text, j.payload from jobs j join scan_runs r on r.job_id = j.id where r.id = ${runId}`)).rows;
    expect(job?.payload).toMatchObject({ kind: 'scan', mode: 'manual', trigger: 'manual' });

    for (let i = 0; i < 40; i++) {
      await runtime.pollOnce();
      await runtime.idle(20_000);
      const q = await t.handle.db.execute<{ n: string }>(sql`select count(*)::text as n from jobs where status in ('queued', 'running') and kind like 'scan.%'`);
      if (q.rows[0]!.n === '0') break;
    }
    const runs = (await t.handle.db.execute<{ id: string; status: string; items_seen: number; scope: string }>(sql`
      select id, status::text, items_seen, scope from scan_runs where job_id = ${Number(job!.id)} order by created_at`)).rows;
    expect(runs).toHaveLength(1); // the placeholder was adopted, not duplicated
    expect(runs[0]).toMatchObject({ id: runId, status: 'succeeded' });
    expect(runs[0]!.items_seen).toBeGreaterThan(0);
    // The rescan's own job succeeded (the mock seed's empty-payload scan rows dead-letter as bad_payload, correctly).
    const [own] = (await t.handle.db.execute<{ status: string }>(sql`select status::text from jobs where id = ${Number(job!.id)}`)).rows;
    expect(own!.status).toBe('succeeded');
    const src = await t.handle.db.execute<{ n: string }>(sql`select count(*)::text as n from source_items where external_id like 'placeholder-%'`);
    expect(Number(src.rows[0]!.n)).toBeGreaterThan(0);
    // CONN-1: the scanner used the app-seeded connector row (name = its label), it did not register a second one.
    expect(await connectorRows()).toBe(before);
    // The DataSource read model shows the finished run.
    const scans = (await ds.getScans({ query: { limit: 50 } } as never)) as unknown as { runs: Array<{ id: string; status: string; itemsSeen: number }> };
    const shown = scans.runs.find((r) => r.id === runId);
    expect(shown).toMatchObject({ status: 'ok' }); // the UI's name for a succeeded run
    expect(shown!.itemsSeen).toBeGreaterThan(0);
  });

  it('a connector that needs re-auth fails at once (auth_failed), with no job', async () => {
    const conns = (await ds.getHealth({} as never)) as unknown as { connectors: Array<{ id: string; state: string }> };
    const broken = conns.connectors.find((x) => x.state === 'auth_needed');
    if (!broken) return; // the seed has none
    const res = await ds.scanConnector({ params: { id: broken.id }, body: { scope: 'manual' } } as never);
    const run = (res as { entity: { id: string; status: string } }).entity;
    expect(run.status).toBe('auth_failed');
    const j = await t.handle.db.execute<{ job_id: string | null }>(sql`select job_id::text from scan_runs where id = ${run.id}`);
    expect(j.rows[0]!.job_id).toBeNull();
  });
});
