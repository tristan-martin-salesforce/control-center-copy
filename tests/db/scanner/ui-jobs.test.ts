/**
 * Regression (stress finding W-1): the jobs the app's DB DataSource enqueues for Health "Rescan" / chat `/rescan`
 * (`scan.<source>` with `{connectorId, scanRunId, scope}`) and Health "Re-auth" (`connector.reauth`) must run in the
 * worker. Before the fix the first dead-lettered as bad_payload (leaving the UI's scan_runs row queued forever), the
 * second had no handler, and an auth-paused connector never resumed. Placeholder fixtures only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { enqueueJob } from '../../../src/db/queue';
import { createDefaultRegistry } from '../../../src/jobs';
import { scanJob } from '../../../src/scanner/runtime/jobs';
import { DbScannerStore } from '../../../src/scanner/store-db';
import type { DeterministicFetcher, FetchResult } from '../../../src/scanner/types';
import { WorkerRuntime } from '../../../src/worker/runtime';
import { buildScanning } from '../../../src/worker/scanning';
import { loadProfileIntoDb, PLACEHOLDER_PROFILE } from '../../../scripts/stress/lib/profile';

import { pgAvailable, provisionTestDb, type TestDb } from './helpers/pg';

function fakeGmail(state: { auth: boolean; n: number }): DeterministicFetcher {
  return {
    connector: 'gmail',
    scopes: async () => ['inbox'],
    health: async () => ({ state: 'ok', checkedAt: new Date().toISOString() }),
    async fetch(_scope, _cursor, window): Promise<FetchResult> {
      if (state.auth) throw new Error('google search_gmail_messages failed [auth]: invalid_grant');
      state.n += 1;
      const id = `msg${state.n}`;
      return {
        items: [{ connector: 'gmail', kind: 'email', externalId: id, dedupeKey: `gmail:${id}`, contentHash: `h${state.n}`, occurredAt: window.from, title: 'PLACEHOLDER subject' }],
        coverage: [{ kind: 'mailbox_range', ref: 'gmail:inbox', from: window.from, to: window.to }],
        nextCursor: { value: String(state.n), at: window.to },
        complete: true,
      };
    },
  };
}

describe.skipIf(!pgAvailable())('W-1: UI rescan / re-auth jobs run in the worker', () => {
  let t: TestDb;
  let userId: string;
  const state = { auth: false, n: 0 };
  let runtime: WorkerRuntime<unknown>;
  let scanning: ReturnType<typeof buildScanning>;
  let store: DbScannerStore;

  beforeAll(async () => {
    t = await provisionTestDb('uijobs');
    userId = await loadProfileIntoDb(t.handle.db, PLACEHOLDER_PROFILE);
    store = new DbScannerStore({ db: t.handle.db, userId });
    scanning = buildScanning({ db: t.handle.db, userId, store, clock: { now: () => new Date(), sleep: async () => undefined }, fetchers: [fakeGmail(state)], llm: false });
    runtime = new WorkerRuntime({ db: t.handle.db, userId, workerId: 'w-test', registry: createDefaultRegistry({ scan: scanning.handlerDeps }), services: {}, listenUrl: null, hooks: [scanning.planHook], log: () => undefined });
  });
  afterAll(async () => {
    await runtime?.stop('test done');
    await t?.drop();
  });

  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await runtime.pollOnce();
      await runtime.idle(20_000);
      const q = await t.handle.db.execute<{ n: string }>(sql`select count(*)::text as n from jobs where status in ('queued', 'running') and run_at <= now()`);
      if (q.rows[0]!.n === '0') return;
    }
  };

  async function pauseWithAuthFailure() {
    state.auth = true;
    const now = new Date();
    await scanning.queue.enqueue([scanJob({ connector: 'gmail', scope: 'inbox', window: { from: new Date(now.getTime() - 600_000).toISOString(), to: now.toISOString() }, mode: 'incremental', trigger: 'schedule', runAt: now.toISOString() })]);
    await settle();
    expect(scanning.scanner.status().find((s) => s.connector === 'gmail')?.paused).toBe('auth');
    state.auth = false;
  }

  it('Health Rescan: the UI-shaped scan job runs, resumes the paused connector, and closes the UI run row', async () => {
    await pauseWithAuthFailure();
    const connectorId = await store.connectorId('gmail');
    const scanRunId = await withChangeSet({ db: t.handle.db, userId, actor: actors.user('test'), reason: 'Scan' }, async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        insert into scan_runs (owner_user_id, connector_id, scope, trigger, mode, status, window_start, window_end, started_at)
        values (${userId}, ${connectorId}, 'manual', 'manual', 'incremental', 'queued', now() - interval '1 hour', now(), now()) returning id`);
      return r.rows[0]!.id;
    });
    await enqueueJob(t.handle.db, { ownerUserId: userId, kind: 'scan.gmail', payload: { connectorId, scanRunId: scanRunId.result, scope: 'manual' }, dedupeKey: `scan:${connectorId}:manual` });
    await settle();
    const job = await t.handle.db.execute<{ status: string }>(sql`select status::text from jobs where kind = 'scan.gmail' and payload ? 'connectorId'`);
    expect(job.rows.map((r) => r.status)).toEqual(['succeeded']);
    const ui = await t.handle.db.execute<{ status: string }>(sql`select status::text from scan_runs where id = ${scanRunId.result}`);
    expect(ui.rows[0]!.status).toBe('succeeded');
    expect(scanning.scanner.status().find((s) => s.connector === 'gmail')?.paused).toBeUndefined();
  });

  it('Health Re-auth: connector.reauth has a handler and resumes the paused connector', async () => {
    await pauseWithAuthFailure();
    const connectorId = await store.connectorId('gmail');
    await enqueueJob(t.handle.db, { ownerUserId: userId, kind: 'connector.reauth', payload: { connectorId, kind: 'in_app' }, dedupeKey: `reauth:${connectorId}` });
    await settle();
    const job = await t.handle.db.execute<{ status: string; dead: string | null }>(sql`select status::text, dead_reason as dead from jobs where kind = 'connector.reauth'`);
    expect(job.rows[0]).toMatchObject({ status: 'succeeded', dead: null });
    expect(scanning.scanner.status().find((s) => s.connector === 'gmail')?.paused).toBeUndefined();
    const dead = await t.handle.db.execute<{ n: string }>(sql`select count(*)::text as n from jobs where status = 'dead'`);
    expect(dead.rows[0]!.n).toBe('0');
  });

  it('W-3: worker start closes scan runs a killed worker left running', async () => {
    const { runId } = await store.startRun({ scope: { connector: 'gmail', scope: 'inbox' }, trigger: 'schedule', window: { from: new Date(Date.now() - 600_000).toISOString(), to: new Date().toISOString() } });
    await scanning.dropStalePlans();
    const r = await t.handle.db.execute<{ status: string; err: string | null }>(sql`select status::text, error_message as err from scan_runs where id = ${runId}`);
    expect(r.rows[0]).toMatchObject({ status: 'cancelled', err: 'worker stopped before the run finished' });
  });

  it('RS-1: worker start keeps queued backfill windows behind the cursor and drops the stale ones ahead of it', async () => {
    // A run moves the gmail:inbox cursor to now (as a cold start's head run does).
    const now = Date.now();
    const key = { connector: 'gmail' as const, scope: 'inbox' };
    const { runId } = await store.startRun({ scope: key, trigger: 'schedule', window: { from: new Date(now - 3600_000).toISOString(), to: new Date(now).toISOString() } });
    await store.reportCoverage(runId, [{ kind: 'mailbox_range', ref: 'gmail:inbox', from: new Date(now - 3600_000).toISOString(), to: new Date(now).toISOString() }]);
    await store.finishRun(runId, { cursor: { value: 'x', at: new Date(now).toISOString() }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    const iso = (ms: number) => new Date(ms).toISOString();
    const later = iso(now + 3600_000); // not due yet, so nothing runs them during the test
    const behind = scanJob({ connector: 'gmail', scope: 'inbox', window: { from: iso(now - 30 * 3600_000), to: iso(now - 24 * 3600_000) }, mode: 'backfill', trigger: 'catch_up', runAt: later });
    const ahead = scanJob({ connector: 'gmail', scope: 'inbox', window: { from: iso(now), to: iso(now + 600_000) }, mode: 'incremental', trigger: 'schedule', runAt: later });
    await scanning.queue.enqueue([behind, ahead]);
    await scanning.dropStalePlans();
    const r = await t.handle.db.execute<{ mode: string; status: string }>(sql`
      select payload->>'mode' as mode, status::text from jobs where payload->>'id' in (${behind.id}, ${ahead.id}) order by 1`);
    expect(r.rows).toEqual([
      { mode: 'backfill', status: 'queued' },
      { mode: 'incremental', status: 'cancelled' },
    ]);
  });
});
