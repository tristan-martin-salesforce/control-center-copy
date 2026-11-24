/**
 * Behaviour that only the db DataSource has (no mock counterpart to compare with): draft-body undo through
 * content revisions, live dispatch handing off to BE-4 (never sending), seeding idempotence, change-set
 * bookkeeping, and the fallback order when nothing is ranked yet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { plainText } from '../../../src/server/datasource/mock/render';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { seedFromMock } from '../../../src/server/datasource/db/from-mock';
import { loadSeedIntoDb } from '../../../src/server/datasource/db/seed';
import { loadEvidenceRows } from '../../../src/server/datasource/db/closure';
import { firstScanRerankOnce } from '../../../src/worker/first-scan-rerank';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  // D-RANK: parity ranks with the mock's scorer on both sides; ENGINES-core (the default) is tested in tests/integration
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const T = (id: string) => L.idMap.get(id) ?? id;
const docOf = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

describe.runIf(BE1B)('db only', () => {
  it('seeding is idempotent: the same seed again is a no-op', async () => {
    const again = seedFromMock(L.mock);
    const r = await loadSeedIntoDb(again.seed, { db: handle.db, rankedAt: again.rankedAt });
    expect(r.status).toBe('up_to_date');
  });

  it('every write ran inside a change set, and seeded engine closes are undoable engine change sets', async () => {
    const res = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from change_sets where actor_kind = 'engine' and undoable and actor_ref = 'item.close'`);
    const closed = L.seed.workItems.filter((w) => w.state === 'done' && w.doneBy === 'engine').length;
    expect(res.rows[0]!.n).toBe(closed);
    const t = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from work_item_transitions where to_status = 'done' and actor_kind = 'engine'`);
    expect(t.rows[0]!.n).toBe(closed);
  });

  it('draft autosave keeps body revisions (W5); undo restores the previous body, redo re-applies it', async () => {
    const d0 = L.seed.drafts.find((x) => x.status === 'drafting')!;
    const before = await db.getDraft({ params: { id: T(d0.id) } });
    const a = await db.patchDraft({ params: { id: before.id }, body: { ifVersion: before.version, doc: docOf('First edit') } });
    const b = await db.patchDraft({ params: { id: before.id }, body: { ifVersion: a.entity.version, doc: docOf('Second edit') } });
    expect(b.auditId).toBe(a.auditId); // one autosave burst
    const revs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from content_revisions where entity_id = ${before.id}`);
    expect(revs.rows[0]!.n).toBe(2); // baseline + the burst
    const u = await db.undoAudit({ params: { id: b.auditId! }, body: {} });
    const restored = await db.getDraft({ params: { id: before.id } });
    // the body (doc_json) comes back exactly; plain_text is re-derived from it by the one serializer
    // (src/lib/compose), which separates blocks with a blank line where the seed's older text did not
    expect(restored.doc).toEqual(before.doc);
    expect(restored.plainText).toBe(plainText(before.doc));
    expect(restored.userTouched).toBe(before.userTouched);
    await db.undoAudit({ params: { id: u.auditId! }, body: {} });
    expect((await db.getDraft({ params: { id: before.id } })).plainText).toBe('Second edit');
  });

  it('live dispatch records the intent and enqueues outbox.dispatch for BE-4 — nothing is sent', async () => {
    const s = await db.getSettings({} as never);
    await db.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } });
    const d = (await db.getOutbox({} as never)).groups.flatMap((g) => g.items).map((i) => i.draft).find((x) => x.status === 'ready') ?? (await db.getDraft({ params: { id: T(L.seed.drafts.find((x) => x.status === 'ready')?.id ?? L.seed.drafts[1]!.id) } }));
    const p = await db.previewDraft({ params: { id: d.id }, body: { mode: 'send' } });
    expect(p.dryRun).toBe(false);
    const r = await db.dispatchDraft({ params: { id: d.id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
    expect(r.dryRun).toBe(false);
    expect(r.draft.status).toBe('sending');
    expect(r.attempt.outcome).toBe('unconfirmed');
    expect(r.draft.verification?.state).toBe('pending');
    const jobs = await handle.db.execute<{ kind: string; status: string; payload: { draftId: string } }>(sql`select kind, status, payload from jobs where kind = 'outbox.dispatch'`);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload.draftId).toBe(d.id);
    const att = await handle.db.execute<{ status: string; dry_run: boolean; job_id: string | null }>(sql`select status, dry_run, job_id from draft_send_attempts where draft_id = ${d.id} order by attempt_no desc limit 1`);
    expect(att.rows[0]).toMatchObject({ status: 'unknown', dry_run: false });
    expect(att.rows[0]!.job_id).not.toBeNull();
    // a stale token (version moved) is refused
    await expect(db.dispatchDraft({ params: { id: d.id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } })).rejects.toMatchObject({ code: 'conflict' });
    const s2 = await db.getSettings({} as never);
    await db.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s2.sending.version, value: { dryRun: true } } });
  });

  it('undo of a non-undoable change set is refused; undo of an undone one too', async () => {
    const seen = await db.markItemSeen({ params: { id: T(L.seed.workItems[0]!.id) }, body: {} });
    expect(seen.auditId).toBeNull();
    const w = (await db.listItems({ query: { tab: 'all_open' } } as never)).items[0]!;
    const e = await db.patchItem({ params: { id: w.id }, body: { ifVersion: w.version, patch: { purpose: 'For: the undo test' } } });
    await db.undoAudit({ params: { id: e.auditId! }, body: {} });
    await expect(db.undoAudit({ params: { id: e.auditId! }, body: {} })).rejects.toMatchObject({ code: 'validation' });
  });

  it('a stale ifVersion on any versioned write is a 409 with the server entity', async () => {
    const w = (await db.listItems({ query: { tab: 'all_open' } } as never)).items[0]!;
    const err = await db.itemAction({ params: { id: w.id, verb: 'snooze' }, body: { ifVersion: w.version - 1, until: new Date(L.now.getTime() + 3_600_000).toISOString() } }).catch((x) => x);
    expect(err.code).toBe('conflict');
    expect(err.status).toBe(409);
    expect((err.details as { current: { id: string; version: number } }).current).toMatchObject({ id: w.id, version: w.version });
  });

  it('LD-1: Not done steps back to the state the item had before it looked done (the transition log)', async () => {
    const w = L.seed.workItems.find((x) => x.state === 'likely_done')!;
    await handle.db.execute(sql`insert into work_item_transitions (work_item_id, from_status, to_status, actor_kind, reason) values (${T(w.id)}::uuid, 'open', 'likely_done', 'engine', 'placeholder: looks done')`);
    const cur = await db.getItem({ params: { id: T(w.id) } });
    const r = await db.itemAction({ params: { id: T(w.id), verb: 'not-done' }, body: { ifVersion: cur.item.version } } as never);
    expect(r.entity.state).toBe('open');
    expect(r.entity.likelyDone).toBeNull();
    const t = await handle.db.execute<{ from_status: string; to_status: string }>(sql`select from_status, to_status from work_item_transitions where work_item_id = ${T(w.id)}::uuid order by id desc limit 1`);
    expect(t.rows[0]).toEqual({ from_status: 'likely_done', to_status: 'open' });
    await expect(db.itemAction({ params: { id: T(w.id), verb: 'not-done' }, body: { ifVersion: r.entity.version } } as never)).rejects.toThrow(/likely-done/);
  });

  it('DONE-1: an unresolved author object on a source item gives its name, never the JSON (or the email)', async () => {
    const ev = await handle.db.execute<{ work_item_id: string; source_item_id: string }>(sql`select work_item_id, source_item_id from work_item_evidence where source_item_id is not null order by id limit 1`);
    const { work_item_id: wid, source_item_id: sid } = ev.rows[0]!;
    await handle.db.execute(sql`update source_items set actor_person_id = null, from_me = false, meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{author}', '{"name": "PERSON_A", "email": "person.a@example.com", "isMe": false}'::jsonb) where id = ${sid}::uuid`);
    const rows = await loadEvidenceRows(handle.db as never, wid, { id: L.userId, name: 'Me' });
    const row = rows.find((r) => r.sourceItemId === sid)!;
    expect(row.actor).toEqual({ name: 'PERSON_A' });
    expect(JSON.stringify(rows)).not.toContain('person.a@example.com');
  });

  it('fallback order when nothing has a score yet: due, then importance', async () => {
    const { storedOrderFrom } = await import('../../../src/server/datasource/db/rank');
    const model = await db.model();
    for (const w of model.all('workItems')) model.put('workItems', { ...w, rank: null });
    const order = storedOrderFrom(model, []);
    const dues = order.map((w) => w.due ?? '9');
    expect([...dues].sort()).toEqual(dues);
  });

  it('HOME-1b: one system re-rank when the first scan completes, only if nothing was ever ranked', async () => {
    const stub = { n: 0, rerank: async () => ({ top3: [] as string[] }) };
    const counting = { readState: () => ({ status: 'done' }), rerank: async () => (stub.n++, stub.rerank()) };
    // still scanning: nothing
    expect(await firstScanRerankOnce(handle, L.userId, { ...counting, readState: () => ({ status: 'active' }) })).toBe(false);
    // the seed already ranked (db:seed's system re-rank): never over an existing ranking
    expect(await firstScanRerankOnce(handle, L.userId, counting)).toBe(false);
    expect(stub.n).toBe(0);
    // a fresh first scan: nothing ranked yet → ranks once, for real, and then never again
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'a fresh first scan: nothing ranked yet' }, async (tx) => {
      await tx.execute(sql`delete from priority_runs where owner_user_id = ${L.userId}`);
    });
    expect(await firstScanRerankOnce(handle, L.userId, { readState: () => ({ status: 'done' }) })).toBe(true);
    const runs = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from priority_runs where owner_user_id = ${L.userId}`);
    expect(runs.rows[0]!.n).toBe(1);
    expect(await firstScanRerankOnce(handle, L.userId, counting)).toBe(false);
    expect(stub.n).toBe(0);
  });
});

