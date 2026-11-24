import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import { RETENTION_MARKER, runRetentionScrub, SCRUBBED, scrubImage } from '@/jobs';
import { DbScannerStore } from '@/scanner/store-db';

import { createUser, openTestDb, uid } from './helpers';
import { item } from './store-conformance';

const h = openTestDb(4);
const db = h.db;
let userId: string;
const DAY = 86_400_000;

beforeAll(async () => {
  userId = await createUser(db, 'retention');
});
afterAll(() => h.close());

/** Move an audit row into the past (same mechanism the scrub uses: delete + re-insert under cc.retention). */
async function backdateAudit(rowId: string, days: number) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('cc.retention', 'on', true)`);
    const r = await tx.execute<{ id: string }>(sql`select id from audit_events where row_id = ${rowId}`);
    for (const a of r.rows) {
      const shift = sql`make_interval(days => ${days})`;
      await tx.execute(sql`create temp table if not exists _a (like audit_events) on commit drop`);
      await tx.execute(sql`insert into _a select * from audit_events where id = ${a.id}`);
      await tx.execute(sql`delete from audit_events where id = ${a.id}`);
      await tx.execute(sql`update _a set created_at = created_at - ${shift}, updated_at = updated_at - ${shift}`);
      await tx.execute(sql`insert into audit_events select * from _a`);
      await tx.execute(sql`truncate _a`);
    }
  });
}

describe('retention scrub (90 days)', () => {
  it('purges expired source bodies (never resurrected) and leaves recent ones', async () => {
    const store = new DbScannerStore({ db, userId });
    const { runId } = await store.startRun({ scope: { connector: 'gmail', scope: `inbox-${uid()}` }, trigger: 'schedule', window: { from: '2026-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' } });
    const old = item({ connector: 'gmail', externalId: `old-${uid()}`, occurredAt: new Date(Date.now() - 100 * DAY).toISOString(), excerpt: 'old body text', payload: { bodyFull: 'old body text', hasAttachment: false } });
    const fresh = item({ connector: 'gmail', externalId: `new-${uid()}`, occurredAt: new Date(Date.now() - 5 * DAY).toISOString(), excerpt: 'fresh body text' });
    const [o, f] = await store.recordSourceItems(runId, [old, fresh]);
    const r = await runRetentionScrub(db, userId);
    expect(r.bodiesPurged).toBe(1);
    const rows = await db.execute<{ id: string; body: string | null; body_purged_at: string | null; title: string | null; content_hash: string }>(sql`
      select id, body, body_purged_at, title, content_hash from source_items where id in (${o!.sourceItemId}, ${f!.sourceItemId})`);
    const byId = Object.fromEntries(rows.rows.map((x) => [x.id, x]));
    expect(byId[o!.sourceItemId]).toMatchObject({ body: null });
    expect(byId[o!.sourceItemId]!.body_purged_at).not.toBeNull();
    expect(byId[o!.sourceItemId]!.content_hash).toBe(old.contentHash); // hashes, titles and links are kept
    expect(byId[f!.sourceItemId]!.body).toContain('fresh body text');
    await store.recordSourceItems(runId, [{ ...old, contentHash: 'h-edited' }]);
    expect((await db.execute<{ body: string | null }>(sql`select body from source_items where id = ${o!.sourceItemId}`)).rows[0]!.body).toBeNull();
    expect((await runRetentionScrub(db, userId)).bodiesPurged).toBe(0); // idempotent
    await store.failRun(runId, { error: 'test end' });
  });

  it('scrubs source-derived text in audit images older than 90 days, keeping structure, ids and titles', async () => {
    const mk = async (title: string, description: string) => {
      const { result } = await withChangeSet({ db, userId, actor: actors.user(), reason: 'capture' }, (tx) =>
        tx.execute<{ id: string }>(sql`insert into work_items (owner_user_id, kind, origin, status, title, description, purpose)
                                       values (${userId}, 'task', 'manual', 'open', ${title}, ${description}, 'For: the ACME workshop') returning id`),
      );
      return result.rows[0]!.id;
    };
    const oldId = await mk('Old task', 'Customer said: please send the pricing sheet with the discount');
    const newId = await mk('New task', 'Recent description that must stay');
    await backdateAudit(oldId, 120);
    const r = await runRetentionScrub(db, userId);
    expect(r.auditRowsScrubbed).toBeGreaterThanOrEqual(1);
    const img = async (rowId: string) =>
      (await db.execute<{ after: Record<string, unknown>; changed: string[] }>(sql`select after, changed_fields as changed from audit_events where row_id = ${rowId}`)).rows[0]!;
    const a = await img(oldId);
    expect(a.after).toMatchObject({ id: oldId, title: 'Old task', description: SCRUBBED, purpose: SCRUBBED, status: 'open', [RETENTION_MARKER]: 'scrubbed' });
    const b = await img(newId);
    expect(b.after.description).toBe('Recent description that must stay');
    expect(b.after[RETENTION_MARKER]).toBeUndefined();
    // the live row is untouched (work items are kept forever)
    expect((await db.execute<{ description: string }>(sql`select description from work_items where id = ${oldId}`)).rows[0]!.description).toMatch(/pricing sheet/);
    // a second pass finds nothing left to scrub
    const again = await runRetentionScrub(db, userId);
    expect(again.auditRowsScrubbed).toBe(0);
  });

  it('scrubs superseded content revisions but keeps the latest', async () => {
    const entity = '00000000-0000-4000-8000-' + uid().padEnd(12, '0').slice(0, 12);
    const insert = (rev: number, text: string, closedDaysAgo: number) =>
      db.execute(sql`
        insert into content_revisions (owner_user_id, entity_type, entity_id, field, revision, text, content_hash, actor_kind, closed_at, started_at, last_saved_at)
        values (${userId}, 'drafts', ${entity}, 'plain_text', ${rev}, ${text}, ${`h${rev}`}, 'user',
                now() - make_interval(days => ${closedDaysAgo}), now() - make_interval(days => ${closedDaysAgo}), now() - make_interval(days => ${closedDaysAgo}))`);
    await insert(1, 'first draft quoting the customer', 120);
    await insert(2, 'second draft', 100);
    const r = await runRetentionScrub(db, userId);
    expect(r.revisionsScrubbed).toBe(1);
    const rows = await db.execute<{ revision: number; text: string }>(sql`select revision, text from content_revisions where entity_id = ${entity} order by revision`);
    expect(rows.rows).toEqual([
      { revision: 1, text: SCRUBBED },
      { revision: 2, text: 'second draft' },
    ]);
  });

  it('deletes read-ins not refreshed for 90 days and leaves no source text in the audit log', async () => {
    const put = (key: string, tldr: string) =>
      withChangeSet({ db, userId, actor: actors.engine('readin@1'), reason: 'read-in' }, (tx) =>
        tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, ${key}, ${JSON.stringify({ readIn: { tldr, state: 'ready' } })}::jsonb)
                       on conflict (owner_user_id, key) do update set value = excluded.value, updated_at = now()`),
      );
    const oldKey = `readin/work_item/old-${uid()}`;
    const newKey = `readin/work_item/new-${uid()}`;
    await put(oldKey, 'Dana asked for the pricing sheet with the discount');
    await put(newKey, 'Recent read-in that must stay');
    // backdate the old one (an audited write, like any other)
    await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'backdate' }, (tx) =>
      tx.execute(sql`update user_settings set updated_at = now() - make_interval(days => 120) where owner_user_id = ${userId} and key = ${oldKey}`),
    );
    const r = await runRetentionScrub(db, userId);
    expect(r.readInsPurged).toBe(1);
    const keys = (await db.execute<{ key: string }>(sql`select key from user_settings where owner_user_id = ${userId} and key like 'readin/%'`)).rows.map((x) => x.key);
    expect(keys).toContain(newKey);
    expect(keys).not.toContain(oldKey);
    const del = await db.execute<{ before: Record<string, unknown> }>(sql`select before from audit_events where table_name = 'user_settings' and op = 'delete' and row_id like ${'%|' + oldKey}`);
    expect(del.rows).toHaveLength(1);
    expect(JSON.stringify(del.rows[0]!.before)).not.toMatch(/pricing sheet/);
    expect(del.rows[0]!.before).toMatchObject({ key: oldKey, [RETENTION_MARKER]: 'scrubbed' });
    expect((await runRetentionScrub(db, userId)).readInsPurged).toBe(0);
  });

  it('scrubImage deep-scrubs the value of read-in rows only', () => {
    const readIn = scrubImage({ key: 'readin/work_item/x', value: { readIn: { tldr: 'Dana asked for the pricing sheet', state: 'ready' } } });
    expect(readIn).toMatchObject({ key: 'readin/work_item/x', value: { readIn: { tldr: SCRUBBED, state: 'ready' } } });
    const setting = scrubImage({ key: 'cc.settings.display', value: { theme: 'dark', note: 'two words' } });
    expect(setting).toMatchObject({ value: { theme: 'dark', note: 'two words' } });
  });

  it('scrubImage keeps ids, enums, timestamps and short tokens; replaces prose and long text', () => {
    const out = scrubImage({ id: 'x', status: 'open', title: 'Keep me', rationale: 'because they asked', meta: { url: 'https://x.example/a', note: 'two words' }, other: 'y'.repeat(300), n: 3 });
    expect(out).toEqual({ id: 'x', status: 'open', title: 'Keep me', rationale: SCRUBBED, meta: { url: 'https://x.example/a', note: SCRUBBED }, other: SCRUBBED, n: 3, [RETENTION_MARKER]: 'scrubbed' });
  });
});
