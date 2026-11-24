import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import { DbScannerStore, splitPayload } from '@/scanner/store-db';

import { createUser, openTestDb, setUserSetting, uid } from './helpers';
import { item, runScannerStoreConformance, type ConformanceHarness, type SeedWorkItemInput } from './store-conformance';

/** DB harness for the shared conformance suite. Seeds run as user change sets (like the app would). */
export async function makeDbHarness(): Promise<ConformanceHarness & { userId: string; store: DbScannerStore }> {
  const h = openTestDb();
  const db = h.db;
  const userId = await createUser(db, 'conf');
  const store = new DbScannerStore({ db, userId });
  const user = <T,>(reason: string, fn: Parameters<typeof withChangeSet<T>>[1]) =>
    withChangeSet({ db, userId, actor: actors.user(), reason }, fn).then((r) => r.result);
  return {
    userId,
    store,
    async seedAccount({ name, aliases }) {
      return user('seed account', async (tx) => {
        const a = await tx.execute<{ id: string }>(sql`insert into accounts (owner_user_id, name, is_my_book) values (${userId}, ${name}, true) returning id`);
        const id = a.rows[0]!.id;
        for (const al of aliases ?? []) {
          await tx.execute(sql`insert into account_aliases (account_id, kind, value, normalized_value, source)
                               values (${id}, 'short_name', ${al}, ${al.toLowerCase()}, 'seed')`);
        }
        return id;
      });
    },
    async seedInitiative({ title, purpose, accountId }) {
      return user('seed initiative', async (tx) =>
        (await tx.execute<{ id: string }>(sql`insert into initiatives (owner_user_id, title, purpose, account_id, created_by)
                                              values (${userId}, ${title}, ${purpose}, ${accountId ?? null}, 'user') returning id`)).rows[0]!.id,
      );
    },
    async seedWorkItem(i: SeedWorkItemInput) {
      return user('seed work item', async (tx) => {
        let cp: string | null = null;
        if (i.counterparty) {
          cp = (await tx.execute<{ id: string }>(sql`insert into people (owner_user_id, display_name, primary_email)
                                                     values (${userId}, ${i.counterparty.name}, ${i.counterparty.email ?? null}) returning id`)).rows[0]!.id;
        }
        const done = i.status === 'done';
        const doneAt = done ? (i.doneAt ?? new Date().toISOString()) : null;
        const res = await tx.execute<{ id: string }>(sql`
          insert into work_items (owner_user_id, kind, origin, status, title, purpose, account_id, initiative_id, counterparty_person_id,
                                  done_at, done_by, resolution, involvement)
          values (${userId}, ${i.kind ?? 'task'}, 'manual', ${i.status ?? 'open'}, ${i.title}, ${i.purpose ?? null}, ${i.accountId ?? null},
                  ${i.initiativeId ?? null}, ${cp}, ${doneAt}::timestamptz, ${done ? 'user' : null},
                  ${i.resolution ?? null}, ${i.involvement ?? 'owner'})
          returning id`);
        return res.rows[0]!.id;
      });
    },
    async workItem(id) {
      const r = await db.execute<{ status: string; title: string }>(sql`select status, title from work_items where id = ${id}`);
      return r.rows[0] ?? null;
    },
    async evidence(workItemId) {
      const r = await db.execute<{ source_item_id: string; role: 'origin' }>(sql`
        select source_item_id, role from work_item_evidence where work_item_id = ${workItemId} order by created_at, role`);
      return r.rows.map((x) => ({ sourceItemId: x.source_item_id, role: x.role }));
    },
    async countSourceItems(dedupeKey) {
      const r = await db.execute<{ n: string }>(sql`select count(*) as n from source_items where owner_user_id = ${userId} and dedupe_key = ${dedupeKey}`);
      return Number(r.rows[0]!.n);
    },
    close: () => h.close(),
  };
}

runScannerStoreConformance('DbScannerStore', makeDbHarness);

describe('DbScannerStore (Postgres specifics)', () => {
  let H: Awaited<ReturnType<typeof makeDbHarness>>;
  const h = openTestDb(2);
  beforeAll(async () => {
    H = await makeDbHarness();
  });
  afterAll(async () => {
    await H.close();
    await h.close();
  });

  it('writes through scanner:<connector> change sets', async () => {
    const scope = { connector: 'gmail' as const, scope: `inbox-${uid()}` };
    const { runId } = await H.store.startRun({ scope, trigger: 'schedule', window: { from: '2026-10-30T09:00:00Z', to: '2026-10-30T10:00:00Z' } });
    const [src] = await H.store.recordSourceItems(runId, [item({ connector: 'gmail', externalId: `cs-${uid()}` })]);
    const { workItemId } = await H.store.proposeItem(runId, { kind: 'ask', title: 'Reply to the security questionnaire', evidence: [{ sourceItemId: src!.sourceItemId, role: 'origin', reason: 'asked' }], confidence: 'sure' });
    const r = await h.db.execute<{ actor_kind: string; actor_ref: string; kind: string }>(sql`
      select cs.actor_kind, cs.actor_ref, cs.kind from audit_events a join change_sets cs on cs.id = a.change_set_id
       where a.table_name = 'work_items' and a.row_id = ${workItemId}`);
    expect(r.rows[0]).toEqual({ actor_kind: 'connector', actor_ref: 'scanner:gmail', kind: 'connector_sync' });
    // The proposal queued a coalesced re-evaluation (engine queue).
    const j = await h.db.execute<{ n: string }>(sql`select count(*) as n from jobs where dedupe_key = ${`reeval:work_item:${workItemId}`} and status = 'queued'`);
    expect(Number(j.rows[0]!.n)).toBe(1);
    await H.store.failRun(runId, { error: 'test end' });
  });

  it('keeps message text in body (redacted, 90-day expiry) and structure in meta; never resurrects a purged body', async () => {
    const scope = { connector: 'gmail' as const, scope: `inbox-${uid()}` };
    const { runId } = await H.store.startRun({ scope, trigger: 'schedule', window: { from: '2026-10-30T09:00:00Z', to: '2026-10-30T10:00:00Z' } });
    const ext = `body-${uid()}`;
    const it0 = item({
      connector: 'gmail',
      externalId: ext,
      title: 'Re: workshop',
      excerpt: 'short excerpt',
      payload: { subject: 'Re: workshop', from: 'AE <ae@example.com>', bodyFull: 'Please send the deck. token=xoxb-123456789012-abcdefabcdef', urls: ['https://example.com/x'], hasAttachment: true },
    });
    const [rec] = await H.store.recordSourceItems(runId, [it0]);
    const row = await h.db.execute<{ body: string; meta: Record<string, unknown>; body_expires_at: string; redacted: boolean }>(sql`
      select body, meta, body_expires_at, redacted from source_items where id = ${rec!.sourceItemId}`);
    const r = row.rows[0]!;
    expect(r.body).toContain('Please send the deck.');
    expect(r.body).not.toContain('xoxb-123456789012');
    expect(r.redacted).toBe(true);
    expect(r.meta).toMatchObject({ subject: 'Re: workshop', hasAttachment: true, connector: 'gmail', itemKind: 'email' });
    expect(JSON.stringify(r.meta)).not.toContain('Please send the deck');
    expect(new Date(r.body_expires_at).toISOString()).toBe(new Date(Date.parse(it0.occurredAt) + 90 * 86400_000).toISOString());
    await h.db.execute(sql`update source_items set body = null, body_purged_at = now() where id = ${rec!.sourceItemId}`);
    await H.store.recordSourceItems(runId, [{ ...it0, contentHash: 'h-new' }]);
    const after = await h.db.execute<{ body: string | null; revision: number }>(sql`select body, revision from source_items where id = ${rec!.sourceItemId}`);
    expect(after.rows[0]).toEqual({ body: null, revision: 2 });
    await H.store.failRun(runId, { error: 'test end' });
  });

  it('splitPayload moves text keys and long strings out of meta', () => {
    const { meta, text } = splitPayload({ status: 'waiting', summary: 'did a thing', nested: { description: 'x', id: 'a' }, long: 'y'.repeat(500), list: [{ text: 'z', n: 1 }] });
    expect(meta).toEqual({ status: 'waiting', nested: { id: 'a' }, list: [{ n: 1 }] });
    expect(text).toEqual(['did a thing', 'x', 'y'.repeat(500), 'z']);
  });

  it('recordHealth updates the connector, opens and resolves a persistent notification, and pauses schedules on auth', async () => {
    const changes: string[] = [];
    const store = new DbScannerStore({ db: h.db, userId: H.userId, onHealthChange: (e) => void changes.push(`${e.from}->${e.to}`) });
    const cid = await store.connectorId('drive');
    await withChangeSet({ db: h.db, userId: H.userId, actor: actors.system('test'), reason: 'seed schedule' }, (tx) =>
      tx.execute(sql`insert into job_schedules (owner_user_id, key, kind, queue, interval_seconds, connector_id, next_run_at)
                     values (${H.userId}, ${`scan:drive:${uid()}`}, 'scan.drive', 'scan.drive', 600, ${cid}, now())`),
    );
    await store.recordHealth('drive', { state: 'auth_required', errorClass: 'auth', detail: 'connector disconnected', reauth: { kind: 'in_app', instructions: 'Reconnect Google' }, checkedAt: new Date().toISOString() });
    const c1 = await h.db.execute<{ status: string; n: string; paused: string }>(sql`
      select c.status, (select count(*) from notifications n where n.connector_id = c.id and n.status = 'open') as n,
             (select count(*) from job_schedules s where s.connector_id = c.id and s.paused_reason = 'auth_required') as paused
        from connectors c where c.id = ${cid}`);
    expect(c1.rows[0]).toEqual({ status: 'auth_required', n: '1', paused: '1' });
    await store.recordHealth('drive', { state: 'ok', checkedAt: new Date().toISOString() });
    const c2 = await h.db.execute<{ status: string; n: string; paused: string }>(sql`
      select c.status, (select count(*) from notifications n where n.connector_id = c.id and n.status = 'open') as n,
             (select count(*) from job_schedules s where s.connector_id = c.id and s.paused_reason = 'auth_required') as paused
        from connectors c where c.id = ${cid}`);
    expect(c2.rows[0]).toEqual({ status: 'healthy', n: '0', paused: '0' });
    expect(changes).toEqual(['healthy->auth_required', 'auth_required->healthy']);
  });

  it('budget caps come from user_settings budgets (soft/hard) and state turns capped at the hard cap', async () => {
    const u = await createUser(h.db, 'budget');
    await setUserSetting(h.db, u, 'budgets', { softUsd: 1, hardUsd: 2, alertPct: 50 });
    const store = new DbScannerStore({ db: h.db, userId: u });
    const a = await store.recordSpend({ connector: 'slack', model: 'claude-haiku-5-5', costUsd: 0.6, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    expect(a).toEqual({ todayUsd: 0.6, softCapUsd: 1, hardCapUsd: 2 });
    expect((await store.budgetStatus()).state).toBe('soft_alert');
    await store.recordSpend({ connector: 'org62', model: 'claude-haiku-5-5', costUsd: 1.5, inputTokens: 1000, outputTokens: 100, trigger: 'test', modelReason: 'default', outcome: 'ok', contentHash: 'test-hash' });
    expect((await store.budgetStatus()).state).toBe('capped');
  });

  it('a run opened by another store instance can still be finished (staged coverage is per process)', async () => {
    const scope = { connector: 'calendar' as const, scope: `primary-${uid()}` };
    const s1 = new DbScannerStore({ db: h.db, userId: H.userId });
    const s2 = new DbScannerStore({ db: h.db, userId: H.userId });
    const { runId } = await s1.startRun({ scope, trigger: 'schedule', window: { from: '2026-10-30T09:00:00Z', to: '2026-10-30T10:00:00Z' } });
    await s1.reportCoverage(runId, [{ kind: 'calendar_range', ref: 'primary', from: '2026-10-30T09:00:00Z', to: '2026-10-30T10:00:00Z' }]);
    await s2.finishRun(runId, { cursor: { value: '{}', at: '2026-10-30T10:00:00Z' }, stats: { fetched: 0, new: 0, changed: 0, linked: 0, proposed: 0, unlinked: 0, costUsd: 0 } });
    expect((await s1.getCursor(scope))?.at).toBe('2026-10-30T10:00:00.000Z');
  });
});
