/**
 * OUTBOX-W on the mock DataSource: closing a to-do withdraws its pending reply drafts (src/outbox/withdraw.ts), so the
 * Outbox count is right the moment it closes. Approved / scheduled / sent drafts and Outbox action drafts are never
 * touched; reopening keeps the withdrawn draft discarded; undo of the close restores it. The db side (same rule, same
 * reason) is tests/db/datasource/withdraw-drafts.test.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type Draft, type RouteKey, type RouteOutput } from '../../src/contract';
import { canvasActionFor } from '../../src/lib/canvas/payload';
import { isWithdrawableDraft, isWithdrawnDraft, WITHDRAWN_DRAFT_PREFIX, withdrawnReason } from '../../src/outbox/withdraw';
import { MockDataSource } from '../../src/server/datasource/mock';
import { renderAll } from '../../src/server/datasource/mock/render';
import { actionDraftFor } from '../../src/server/vdp/coverage';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const slow = { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: slow, autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
  const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
  const r = routes[key].response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

const draft = (id: string) => call('getDraft', { params: { id } });
const item = (id: string) => call('getItem', { params: { id } }).then((r) => r.item);
const outboxCount = async () => (await call('getToday', {})).navCounts.outbox;
const pendingIds = async () => (await call('getOutbox', {})).groups.find((g) => g.group === 'pending_approval')!.items.map((i) => i.draft.id);

describe('withdrawnReason / isWithdrawableDraft (shared by both DataSources)', () => {
  it('names why the to-do closed: the close reason, a dismiss note first, else the status', () => {
    expect(withdrawnReason({ state: 'done', closedReason: '  Replied in Slack\n by you ' })).toBe(`${WITHDRAWN_DRAFT_PREFIX} — Replied in Slack by you`);
    expect(withdrawnReason({ state: 'done', closedReason: null })).toBe(`${WITHDRAWN_DRAFT_PREFIX} — done`);
    expect(withdrawnReason({ state: 'dismissed', closedReason: null, dismissed: { reason: 'other', note: 'Merged into Placeholder task' } })).toBe(`${WITHDRAWN_DRAFT_PREFIX} — Merged into Placeholder task`);
    expect(withdrawnReason({ state: 'dismissed', closedReason: null, dismissed: { reason: 'not_mine' } })).toBe(`${WITHDRAWN_DRAFT_PREFIX} — dismissed (not mine)`);
    const long = withdrawnReason({ state: 'done', closedReason: 'x'.repeat(400) });
    expect(long.length).toBeLessThanOrEqual(WITHDRAWN_DRAFT_PREFIX.length + 3 + 160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('only pending message drafts of a work item are withdrawable', () => {
    const d = seed.drafts.find((x) => x.id === 'dr_nudge_globex')!;
    expect(isWithdrawableDraft(d)).toBe(true);
    for (const status of ['scheduled', 'sending', 'sent', 'staged', 'verified', 'rejected', 'discarded'] as const) expect(isWithdrawableDraft({ ...d, status })).toBe(false);
    expect(isWithdrawableDraft({ ...d, workItemId: null })).toBe(false);
    const action = actionDraftFor(canvasActionFor({ title: 'Placeholder canvas', markdown: '# rows', eventIds: [], hours: 1, updates: 0, updateIds: [], part: 1, parts: 1 }), { id: 'dr_canvas', now: seed.meta.asOf, workItemId: 'w_globex_legal', rendered: () => ({}) });
    expect(isWithdrawableDraft({ ...action, status: 'ready' })).toBe(false);
  });
});

describe('mock: closing a to-do withdraws its pending drafts', () => {
  it('resolve: the ready draft is discarded with the reason, and the Outbox count drops at once', async () => {
    const before = await outboxCount();
    expect(await pendingIds()).toContain('dr_nudge_globex');
    const w = await item('w_globex_legal');
    const d0 = await draft('dr_nudge_globex');
    const r = await call('itemAction', { params: { id: w.id, verb: 'resolve' }, body: { ifVersion: w.version, resolution: 'done_by_other', detail: { personName: 'Sam Placeholder' } } });
    expect(r.entity.state).toBe('done');
    const d = await draft('dr_nudge_globex');
    expect(d.status).toBe('discarded');
    expect(d.version).toBe(d0.version + 1);
    expect(d.rejectedReason).toBe(withdrawnReason({ state: 'done', closedReason: r.entity.closedReason }));
    expect(d.rejectedReason!.startsWith(`${WITHDRAWN_DRAFT_PREFIX} — `)).toBe(true);
    expect(isWithdrawnDraft(d)).toBe(true);
    expect(await outboxCount()).toBe(before - 1);
    expect(await pendingIds()).not.toContain('dr_nudge_globex');
    // one audit entry: the close and the withdrawal together (History shows the draft beside the item)
    expect(r.auditId).toBeTruthy();
    const hist = await call('getItemHistory', { params: { id: w.id } });
    const entry = hist.entries.find((e) => e.id === r.auditId)!;
    expect(entry.related?.some((x) => x.type === 'draft' && x.id === 'dr_nudge_globex')).toBe(true);
  });

  it('dismiss withdraws a failed draft with the dismiss reason; reopening keeps it discarded', async () => {
    const w = await item('w_globex_estimate');
    expect((await draft('dr_failed_globex')).status).toBe('failed');
    const r = await call('itemAction', { params: { id: w.id, verb: 'dismiss' }, body: { ifVersion: w.version, reason: 'not_mine', note: 'Another placeholder owner has it' } });
    const d = await draft('dr_failed_globex');
    expect(d.status).toBe('discarded');
    expect(d.rejectedReason).toBe(`${WITHDRAWN_DRAFT_PREFIX} — Another placeholder owner has it`);
    await call('itemAction', { params: { id: w.id, verb: 'reopen' }, body: { ifVersion: r.entity.version, note: 'Back on it' } });
    expect((await item(w.id)).state).toBe('reopened');
    expect((await draft('dr_failed_globex')).status).toBe('discarded');
  });

  it('undo of the close restores the draft to the Outbox', async () => {
    const before = await outboxCount();
    const w = await item('w_initech_inventory');
    const r = await call('itemAction', { params: { id: w.id, verb: 'done' }, body: { ifVersion: w.version } });
    expect((await draft('dr_chat_initech')).status).toBe('discarded');
    expect(await outboxCount()).toBe(before - 1);
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    const d = await draft('dr_chat_initech');
    expect(d.status).toBe('ready');
    expect(d.rejectedReason).toBeNull();
    expect(await outboxCount()).toBe(before);
  });

  it('a scheduled draft (approved, on its way out) is never touched', async () => {
    const w = await item('w_hooli_plan');
    const d0 = await draft('dr_sched_hooli');
    await call('itemAction', { params: { id: w.id, verb: 'done' }, body: { ifVersion: w.version } });
    const d = await draft('dr_sched_hooli');
    expect(d.status).toBe('scheduled');
    expect(d.version).toBe(d0.version);
    expect(d.rejectedReason).toBeNull();
  });

  it('an Outbox action draft (canvas, no work item; or linked to the item) is never touched', async () => {
    const dest = canvasActionFor({ title: 'Placeholder logging canvas', markdown: '# CUSTOMER_1 rows', eventIds: [], hours: 1, updates: 0, updateIds: [], part: 1, parts: 1 });
    const now = ds.now().toISOString();
    const free: Draft = { ...actionDraftFor(dest, { id: 'dr_canvas_free', now, rendered: (doc) => renderAll(dest, doc) }), status: 'ready' };
    const linked: Draft = { ...actionDraftFor(dest, { id: 'dr_canvas_linked', now, workItemId: 'w_dana_reply', rendered: (doc) => renderAll(dest, doc) }), status: 'ready' };
    ds.store._set('drafts', free);
    ds.store._set('drafts', linked);
    const w = await item('w_dana_reply');
    await call('itemAction', { params: { id: w.id, verb: 'done' }, body: { ifVersion: w.version } });
    expect((await draft('dr_dana')).status).toBe('discarded'); // the item's reply draft (drafting) goes
    for (const id of ['dr_canvas_free', 'dr_canvas_linked']) {
      const d = await draft(id);
      expect(d.status).toBe('ready');
      expect(d.version).toBe(1);
    }
  });

  it('merge (triage) withdraws the merged item’s pending drafts, naming what it merged into', async () => {
    const t = (await call('getTriage', {})).groups.flatMap((g) => g.items).find((i) => i.kind === 'work_item' && i.group !== 'closed_for_you' && i.workItem?.state === 'suggested')!;
    const into = await item('w_globex_legal');
    const src = await item(t.id);
    const dest = { kind: 'slack' as const, target: 'thread' as const, channelId: 'C_PLACEHOLDER', channelName: '#placeholder', threadTs: '1.0' };
    const doc = { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Placeholder reply' }] }] };
    const base = seed.drafts.find((x) => x.id === 'dr_nudge_globex')!;
    ds.store._set('drafts', { ...base, id: 'dr_triage_reply', workItemId: src.id, nbaId: null, destination: dest, doc, plainText: 'Placeholder reply', rendered: renderAll(dest, doc), status: 'ready' });
    await call('mergeTriage', { params: { id: t.id }, body: { intoId: into.id } });
    const d = await draft('dr_triage_reply');
    expect(d.status).toBe('discarded');
    expect(d.rejectedReason).toBe(`${WITHDRAWN_DRAFT_PREFIX} — Merged into ${into.title}`);
  });
});
