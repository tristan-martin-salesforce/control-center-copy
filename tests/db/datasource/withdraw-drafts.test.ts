/**
 * OUTBOX-W on Postgres: closing a to-do withdraws its pending reply drafts (src/server/datasource/db/store/withdraw.ts).
 *
 * Parity first (the same closes on the mock and on db: same drafts withdrawn, same reason, same Outbox and nav count),
 * then what only db has: an approved draft stays approved, action drafts (canvas, VDP; linked to the item or not) are
 * never touched, the change set records it (audit rows, History, Undo), the worker-start sweep clears drafts left from
 * before the rule (done and merged items) idempotently, and a read-in that finishes after its to-do closed saves no draft.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { DbHandle } from '../../../src/db/client';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { emptyReadIn } from '../../../src/llm/readin/state';
import { canvasActionFor } from '../../../src/lib/canvas/payload';
import { WITHDRAWN_DRAFT_PREFIX } from '../../../src/outbox/withdraw';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { commitReadIn } from '../../../src/server/datasource/db/readin';
import type { WriteCtx } from '../../../src/server/datasource/db/store/common';
import { insertDraft } from '../../../src/server/datasource/db/store/nba';
import { withdrawClosedItemDrafts } from '../../../src/server/datasource/db/store/withdraw';
import { renderAll } from '../../../src/server/datasource/mock/render';
import { actionDraftFor } from '../../../src/server/vdp/coverage';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';
import { both } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const T = (id: string) => L.idMap.get(id) ?? id;
const expectSame = (diffs: string[]) => expect(diffs, diffs.join('\n')).toEqual([]);
const ver = async (seedId: string) => (await L.mock.getItem({ params: { id: seedId } })).item.version;
const row = async (draftId: string) =>
  (await handle.db.execute<{ status: string; reject_reason: string | null; version: number }>(sql`select status::text as status, reject_reason, version from drafts where id = ${draftId}::uuid`)).rows[0]!;
const navOutbox = (v: unknown) => (v as { navCounts: { outbox: number } }).navCounts.outbox;

/** Audited writes need a change set; db-only setup goes through one too. */
const exec = (q: ReturnType<typeof sql>) => withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'test setup' }, async (tx) => tx.execute(q));

describe.runIf(BE1B)('OUTBOX-W: closing a to-do withdraws its pending drafts (mock ↔ db)', () => {
  it('resolve: the ready draft is discarded with the reason on both sides; the Outbox and its count drop at once', async () => {
    const before = await both(L, db, 'getToday', {}, { shape: navOutbox });
    expectSame(before.diffs);
    const r = await both(L, db, 'itemAction', { params: { id: 'w_globex_legal', verb: 'resolve' }, body: { ifVersion: await ver('w_globex_legal'), resolution: 'done_by_other', detail: { personName: 'Sam Placeholder' } } }, { times: true });
    expectSame(r.diffs);
    const d = await both(L, db, 'getDraft', { params: { id: 'dr_nudge_globex' } }, { times: true });
    expectSame(d.diffs);
    const draft = d.raw.db as { status: string; rejectedReason: string | null };
    expect(draft.status).toBe('discarded');
    expect(draft.rejectedReason!.startsWith(`${WITHDRAWN_DRAFT_PREFIX} — `)).toBe(true);
    expectSame((await both(L, db, 'getOutbox', {}, { times: true })).diffs);
    const after = await both(L, db, 'getToday', {}, { shape: navOutbox });
    expectSame(after.diffs);
    expect(after.db).toBe((before.db as number) - 1);

    // recorded in the close's own change set: the draft's audit row sits beside the item's (History, Undo)
    const auditId = (r.raw.db as { auditId: string }).auditId;
    const audit = await handle.db.execute<{ entity_type: string }>(sql`select distinct entity_type from audit_events where change_set_id = ${auditId}::uuid and entity_id = ${T('dr_nudge_globex')}`);
    expect(audit.rows.map((x) => x.entity_type)).toEqual(['drafts']);
    const hist = await db.getItemHistory({ params: { id: T('w_globex_legal') } });
    expect(hist.entries.find((e) => e.id === auditId)?.related?.some((x) => x.type === 'draft' && x.id === T('dr_nudge_globex'))).toBe(true);
  });

  it('dismiss withdraws a failed draft with the dismiss note; reopen keeps it discarded (both sides)', async () => {
    expectSame((await both(L, db, 'itemAction', { params: { id: 'w_globex_estimate', verb: 'dismiss' }, body: { ifVersion: await ver('w_globex_estimate'), reason: 'not_mine', note: 'Another placeholder owner has it' } }, { times: true })).diffs);
    const d = await both(L, db, 'getDraft', { params: { id: 'dr_failed_globex' } }, { times: true });
    expectSame(d.diffs);
    expect((d.raw.db as { rejectedReason: string }).rejectedReason).toBe(`${WITHDRAWN_DRAFT_PREFIX} — Another placeholder owner has it`);
    expectSame((await both(L, db, 'itemAction', { params: { id: 'w_globex_estimate', verb: 'reopen' }, body: { ifVersion: await ver('w_globex_estimate'), note: 'Back on it' } }, { times: true })).diffs);
    const again = await both(L, db, 'getDraft', { params: { id: 'dr_failed_globex' } }, { times: true });
    expectSame(again.diffs);
    expect((again.raw.db as { status: string }).status).toBe('discarded');
  });

  it('a scheduled draft is never touched (both sides)', async () => {
    expectSame((await both(L, db, 'itemAction', { params: { id: 'w_hooli_plan', verb: 'done' }, body: { ifVersion: await ver('w_hooli_plan') } }, { times: true })).diffs);
    const d = await both(L, db, 'getDraft', { params: { id: 'dr_sched_hooli' } }, { times: true });
    expectSame(d.diffs);
    expect((d.raw.db as { status: string }).status).toBe('scheduled');
  });
});

describe.runIf(BE1B)('OUTBOX-W: db only', () => {
  it('undo of the close restores the withdrawn draft exactly', async () => {
    const w = await db.getItem({ params: { id: T('w_priya_forecast') } });
    const d0 = await row(T('dr_priya'));
    const r = await db.itemAction({ params: { id: w.item.id, verb: 'done' }, body: { ifVersion: w.item.version } });
    expect((await row(T('dr_priya'))).status).toBe('discarded');
    await db.undoAudit({ params: { id: r.auditId! }, body: {} });
    const d = await row(T('dr_priya'));
    expect(d.status).toBe(d0.status);
    expect(d.reject_reason).toBeNull();
  });

  it('an approved draft (db `approved`, reads as ready) stays approved when its to-do closes', async () => {
    const id = T('dr_chat_initech');
    await exec(sql`update drafts set status = 'approved', approved_at = now(), approval_method = 'click', approved_content_hash = content_hash where id = ${id}::uuid`);
    const v0 = (await row(id)).version;
    const w = await db.getItem({ params: { id: T('w_initech_inventory') } });
    await db.itemAction({ params: { id: w.item.id, verb: 'done' }, body: { ifVersion: w.item.version } });
    const d = await row(id);
    expect(d).toMatchObject({ status: 'approved', reject_reason: null, version: v0 });
  });

  it('Outbox action drafts (canvas with no item; one linked to the item) are never touched', async () => {
    const dest = canvasActionFor({ title: 'Placeholder logging canvas', markdown: '# CUSTOMER_1 rows', eventIds: [], hours: 1, updates: 0, updateIds: [], part: 1, parts: 1 });
    const at = L.now.toISOString();
    const free = { ...actionDraftFor(dest, { id: crypto.randomUUID(), now: at, rendered: (doc) => renderAll(dest, doc) }), status: 'ready' as const };
    const linked = { ...actionDraftFor(dest, { id: crypto.randomUUID(), now: at, workItemId: T('w_dana_reply'), rendered: (doc) => renderAll(dest, doc) }), status: 'ready' as const };
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test'), reason: 'test setup' }, async (tx, cs) => {
      const w: WriteCtx = { tx, cs, userId: L.userId, me: { id: L.userId, name: '' }, now: L.now, extractorId: '', timezone: 'UTC', kv: new Map() };
      await insertDraft(w, free);
      await insertDraft(w, linked);
    });
    const w = await db.getItem({ params: { id: T('w_dana_reply') } });
    await db.itemAction({ params: { id: w.item.id, verb: 'done' }, body: { ifVersion: w.item.version } });
    expect((await row(T('dr_dana'))).status).toBe('discarded'); // the item's own reply draft goes
    for (const d of [free, linked]) expect(await row(d.id)).toMatchObject({ status: 'ready', reject_reason: null, version: 1 });
    // and the sweep leaves them too
    expect(await withdrawClosedItemDrafts(handle.db, L.userId)).toEqual([]);
  });

  it('worker start: the sweep withdraws drafts of items closed before the rule (done, merged), once, in a system change set', async () => {
    // closed behind the DataSource's back, as rows written before the rule look
    await exec(sql`update work_items set status = 'done', done_at = now(), done_by = 'engine', status_reason = 'Replied in Slack by you (placeholder)' where id = ${T('w_acme_onepager')}::uuid`);
    await exec(sql`update work_items set status = 'merged', merged_into_id = ${T('w_globex_legal')}::uuid, status_reason = null where id = ${T('w_nce_capture')}::uuid`);
    const out = await withdrawClosedItemDrafts(handle.db, L.userId, { ref: 'worker.start' });
    expect(out.map((x) => x.id).sort()).toEqual([T('dr_onepager'), T('dr_nce')].sort());
    expect(await row(T('dr_onepager'))).toMatchObject({ status: 'discarded', reject_reason: `${WITHDRAWN_DRAFT_PREFIX} — Replied in Slack by you (placeholder)` });
    expect((await row(T('dr_nce'))).reject_reason).toBe(`${WITHDRAWN_DRAFT_PREFIX} — dismissed`);
    const cs = await handle.db.execute<{ id: string; summary: string; undoable: boolean }>(sql`select id, summary, undoable from change_sets where actor_kind = 'system' and actor_ref = 'worker.start'`);
    expect(cs.rows).toHaveLength(1);
    expect(cs.rows[0]).toMatchObject({ summary: `${WITHDRAWN_DRAFT_PREFIX}: 2 pending drafts withdrawn`, undoable: false });
    const audited = await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where change_set_id = ${cs.rows[0]!.id} and entity_type = 'drafts'`);
    expect(audited.rows[0]!.n).toBe(2);
    // idempotent: nothing left, and no empty change set opened
    expect(await withdrawClosedItemDrafts(handle.db, L.userId, { ref: 'worker.start' })).toEqual([]);
    expect((await handle.db.execute(sql`select 1 from change_sets where actor_ref = 'worker.start'`)).rows).toHaveLength(1);
    // the Outbox and the nav count agree
    const outbox = await db.getOutbox({} as never);
    expect(outbox.groups.flatMap((g) => g.items).some((i) => i.draft.id === T('dr_onepager') || i.draft.id === T('dr_nce'))).toBe(false);
  });

  it('a read-in that finishes after its to-do closed saves no reply draft', async () => {
    const item = T('w_dana_reply'); // closed above
    const n0 = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from drafts where work_item_id = ${item}::uuid`)).rows[0]!.n;
    const entity = { type: 'work_item' as const, id: item };
    const dest = { kind: 'slack' as const, target: 'thread' as const, channelId: 'C_PLACEHOLDER', channelName: '#placeholder', threadTs: '1.0' };
    const doc = { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Placeholder reply' }] }] };
    const readIn = { ...emptyReadIn(entity, L.now.toISOString()), state: 'ready' as const, tldr: 'Placeholder summary' };
    const r = await commitReadIn(handle.db, L.userId, { entity, jobId: null, readIn, outcome: 'ready', reply: { destination: dest, doc, label: '#placeholder', preview: 'Placeholder reply' } });
    expect(r).toMatchObject({ committed: true, draftId: null });
    expect((await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from drafts where work_item_id = ${item}::uuid`)).rows[0]!.n).toBe(n0);
  });
});
