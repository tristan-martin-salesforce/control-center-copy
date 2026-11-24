/**
 * INTEGRATE-1 on Postgres: the db DataSource with its production defaults (ENGINES-core ranking, the
 * not-wired chat backend), plus the CONTRACT-1 additions that have no mock counterpart to diff against.
 *
 * - Ranking: GET /today's Top 3 is ENGINES-core's, persisted to priority_scores under the policy version
 *   row; Top 3 stability (rerank) and rerankReady; previewPolicy = the engine's preview; policy weights
 *   through the one mapping (B4).
 * - Closure: engine signals go through applySignal and undo exactly.
 * - B1: training rows live in work_item_training_details; travel rows are writable and undoable.
 * - Chat: threads (context, titling, model choice), start → BE-6 error persisted, chat ops as actor `chat`
 *   (no locks, locked fields → proposals), persisted parts redacted and hydrated on read.
 * - Tools: a TOOLS manifest row is served through toToolAdapter and runs are validated with validateInput.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChatSseEvent, WorkItemRecord } from '../../../src/contract';
import { toToolAdapter } from '../../../src/contract';
import { undoChangeSet, withChangeSet, actors } from '../../../src/db/changeset';
import type { DbHandle } from '../../../src/db/client';
import { workItemTravelDetails } from '../../../src/db/schema';
import { COMPONENT_KEYS } from '../../../src/engines/priority/types';
import { previewPolicy as enginePreview } from '../../../src/engines/priority/preview';
import { rankWork } from '../../../src/engines/priority/rank';
import { parseManifest } from '../../../src/tools/manifest';
import { DbDataSource } from '../../../src/server/datasource/db';
import type { DbChatBackend } from '../../../src/server/datasource/db/chat';
import { toContractCapacity } from '../../../src/server/datasource/db/capacity';
import { priorityInputs } from '../../../src/server/datasource/db/rank';
import { insertToolsManifest } from '../../../src/server/datasource/db/store/agents';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now } }); // production defaults
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const T = (id: string) => L.idMap.get(id) ?? id;
const rows = async <R extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await handle.db.execute<R>(q)).rows;
const collect = async (it: AsyncIterable<ChatSseEvent>) => {
  const out: ChatSseEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const freshTop3 = async () => {
  const m = await db.model();
  return rankWork(priorityInputs(m, m.settings().policy, L.now)).top3;
};

describe.runIf(BE1B)('INTEGRATE-1: ENGINES-core ranking', () => {
  it('GET /today shows the ENGINES-core Top 3 after a re-rank, persisted under the policy version row', async () => {
    const rr = await db.rerankToday({ body: {} } as never);
    expect(rr.auditId).not.toBeNull();
    const today = await db.getToday({} as never);
    const expected = await freshTop3();
    expect(expected).toHaveLength(3);
    expect(today.nowStack.cards.map((c) => c.item.id)).toEqual(expected);
    expect(today.nowStack.rerankReady).toBe(0);
    expect(rr.entity.top.slice(0, 3).map((r) => r.workItemId)).toEqual(expected);

    const m = await db.model();
    const [run] = await rows<{ id: number; engine_version: string; policy_id: string; version: number; available_focus_minutes: number | null }>(sql`
      select r.id, r.engine_version, r.policy_id, p.version, r.available_focus_minutes from priority_runs r join priority_policies p on p.id = r.policy_id
       order by r.id desc limit 1`);
    expect(run).toMatchObject({ engine_version: 'priority@1.1', policy_id: m.extra.policyRowId, version: m.settings().policy.version });
    expect(run!.available_focus_minutes).not.toBeNull();
    const scores = await rows<{ work_item_id: string; lane: string; inputs_hash: string; total: string }>(sql`select work_item_id, lane, inputs_hash, total from priority_scores where run_id = ${run!.id}`);
    for (const id of expected) expect(scores.find((s) => s.work_item_id === id)).toMatchObject({ lane: 'top3' });
    expect(scores.every((s) => s.inputs_hash.length > 0)).toBe(true);
    const top = m.get('workItems', expected[0]!)!;
    expect(top.rankReasons.length).toBeGreaterThan(0);
    for (const r of top.rankReasons) expect(COMPONENT_KEYS.includes(r.key as never) || r.key.startsWith('rule:') || r.key === 'sequencing').toBe(true);
    // the plan (capacity, spine, shelves) is the engine's too
    const eng = rankWork(priorityInputs(m, m.settings().policy, L.now));
    expect(today.header.capacity).toEqual(toContractCapacity(eng.capacity));
    expect(today.shelves.promises.map((p) => p.item.id)).toEqual(eng.background.slice(0, 2).map((b) => b.workItemId));
  });

  it('the Top 3 holds still until an explicit re-rank; rerankReady counts the moves; acting frees a slot', async () => {
    const before = (await db.getToday({} as never)).nowStack.cards.map((c) => c.item.id);
    const m = await db.model();
    const outsider = m.all('workItems').find((w) => w.state === 'open' && !before.includes(w.id) && w.kind !== 'training' && w.rank !== null)!;
    await db.engineUpdateItem(outsider.id, { signals: { ...outsider.signals, boost: 400 } }, 'New info: very urgent');
    expect((await freshTop3())[0]).toBe(outsider.id);
    const held = await db.getToday({} as never);
    expect(held.nowStack.cards.map((c) => c.item.id)).toEqual(before);
    expect(held.nowStack.rerankReady).toBeGreaterThan(0);

    await db.rerankToday({ body: {} } as never);
    const applied = await db.getToday({} as never);
    expect(applied.nowStack.cards[0]!.item.id).toBe(outsider.id);
    expect(applied.nowStack.rerankReady).toBe(0);

    const second = applied.nowStack.cards[1]!.item;
    await db.itemAction({ params: { id: second.id, verb: 'done' }, body: { ifVersion: second.version } } as never);
    const after = (await db.getToday({} as never)).nowStack.cards.map((c) => c.item.id);
    expect(after).not.toContain(second.id);
    expect(after[0]).toBe(outsider.id); // the other positions stay put
    expect(after).toHaveLength(3);
  });

  it('previewPolicy is the engine preview (before/after Top 10) under the mapped policy', async () => {
    const m = await db.model();
    const pol = m.settings().policy;
    const weights = { ...pol.weights, due_urgency: 10, customer_facing: 0 };
    const got = await db.previewPolicy({ body: { weights } } as never);
    const inputs = priorityInputs(m, pol, L.now);
    const want = enginePreview(inputs.policy, priorityInputs(m, { ...pol, weights }, L.now).policy, inputs);
    expect(got.basedOnVersion).toBe(pol.version);
    expect(got.after.map((r) => r.workItemId)).toEqual(want.after.map((r) => r.workItemId));
    expect(got.before.map((r) => r.workItemId)).toEqual(want.before.map((r) => r.workItemId));
    expect(got.changedCount).toBe(want.changedCount);
  });

  it('applyPolicy stores the weights through the one mapping and keeps the engine-only obligation weight', async () => {
    const s = await db.getSettings({} as never);
    const [prev] = await rows<{ o: string }>(sql`select weight_obligation as o from priority_policies where status = 'active'`);
    const weights = { ...s.policy.weights, manager_ask: 4.5, age: 1.25 };
    const r = await db.applyPolicy({ body: { ifVersion: s.policy.version, weights, rules: s.policy.rules, note: 'INTEGRATE-1 mapping' } } as never);
    expect(r.entity.version).toBe(s.policy.version + 1);
    expect(r.entity.weights).toEqual(weights);
    const [row] = await rows<{ c: string; s: string; o: string; v: number }>(sql`select weight_commitment as c, weight_staleness as s, weight_obligation as o, version as v from priority_policies where status = 'active'`);
    expect(Number(row!.c)).toBe(4.5);
    expect(Number(row!.s)).toBe(1.25);
    expect(Number(row!.o)).toBe(Number(prev!.o));
    const [run] = await rows<{ v: number }>(sql`select p.version as v from priority_runs r join priority_policies p on p.id = r.policy_id order by r.id desc limit 1`);
    expect(run!.v).toBe(row!.v);
    // undo the policy apply: the previous version is active again
    const u = await db.undoAudit({ params: { id: r.auditId! }, body: {} } as never);
    expect((await db.getSettings({} as never)).policy.version).toBe(s.policy.version);
    expect((await rows<{ v: number }>(sql`select version as v from priority_policies order by version`)).map((x) => x.v)).toEqual([...Array(s.policy.version).keys()].map((i) => i + 1));
    // redo is refused (409): the rankings computed under the undone version went with it (0006)
    await expect(db.undoAudit({ params: { id: u.auditId! }, body: {} } as never)).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.getSettings({} as never)).policy.version).toBe(s.policy.version);
    // a plain re-rank (same policy version) undoes and redoes exactly
    const m2 = await db.model();
    const any = m2.all('workItems').find((w) => w.state === 'open' && w.rank !== null)!;
    await db.engineUpdateItem(any.id, { signals: { ...any.signals, boost: any.signals.boost + 250 } }, 'New info');
    const rr = await db.rerankToday({ body: {} } as never);
    expect(rr.auditId).not.toBeNull();
    const ru = await db.undoAudit({ params: { id: rr.auditId! }, body: {} } as never);
    await db.undoAudit({ params: { id: ru.auditId! }, body: {} } as never);
    expect((await db.model()).get('workItems', any.id)!.rank).toBe(rr.entity.top.find((t) => t.workItemId === any.id)?.rank ?? (await db.model()).get('workItems', any.id)!.rank);
  });
});

describe.runIf(BE1B)('INTEGRATE-1: closure signals (ENGINES-core applySignal)', () => {
  const evidenceOf = async (itemId: string) => (await db.model()).all('evidence').find((e) => e.workItemId === itemId)?.id ?? null;

  it('a Sure completion closes the item as the engine; undo restores it exactly', async () => {
    const m = await db.model();
    const w = m.all('workItems').find((x) => x.state === 'open' && !x.userLockedFields.includes('state') && x.resolution === null)!;
    const before = await db.getItem({ params: { id: w.id } } as never);
    const r = await db.applyClosureSignal(w.id, { type: 'evidence', role: 'completion', confidence: 'sure', evidenceId: await evidenceOf(w.id), at: L.now.toISOString(), actor: { name: 'Me', isMe: true } });
    expect(r.decision.kind).toBe('transition');
    const done = (await db.model()).get('workItems', w.id)!;
    expect(done).toMatchObject({ state: 'done', doneBy: 'engine', resolution: 'done_by_me' });
    expect(done.resolutionDetail?.inferred).toBe(true);
    const [cs] = await rows<{ actor_kind: string; actor_ref: string }>(sql`select actor_kind, actor_ref from change_sets where id = ${r.auditId}`);
    expect(cs).toEqual({ actor_kind: 'engine', actor_ref: 'closure.evidence' });
    const [tr] = await rows<{ to_status: string; actor_kind: string }>(sql`select to_status, actor_kind from work_item_transitions where change_set_id = ${r.auditId}`);
    expect(tr).toEqual({ to_status: 'done', actor_kind: 'engine' });

    await db.undoAudit({ params: { id: r.auditId! }, body: {} } as never);
    // exact: everything but the bookkeeping (version bumps, updated_at) is back
    const strip = (x: WorkItemRecord) => ({ ...x, version: 0, updatedAt: '' });
    const back = await db.getItem({ params: { id: w.id } } as never);
    expect(strip(back.item)).toEqual(strip(before.item));
    const [undone] = await rows<{ undone: boolean }>(sql`select undone_at is not null as undone from work_item_transitions where change_set_id = ${r.auditId}`);
    expect(undone!.undone).toBe(true);
  });

  it('a user-locked status turns the engine move into a pending proposal; the item does not move', async () => {
    const m = await db.model();
    const w = m.all('workItems').find((x) => x.state === 'open' && x.userLockedFields.length === 0)!;
    // lock the status the way a user edit does (an engine write must then propose)
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.user('test.lock'), reason: 'lock status' }, async (tx) => {
      await tx.execute(sql`update work_items set user_locked_fields = array['status'] where id = ${w.id}`);
    });
    const r = await db.applyClosureSignal(w.id, { type: 'evidence', role: 'completion', confidence: 'sure', evidenceId: await evidenceOf(w.id), at: L.now.toISOString() });
    expect(r.decision.kind).toBe('proposal');
    expect(r.proposalId).not.toBeNull();
    const after = await db.model();
    expect(after.get('workItems', w.id)!.state).toBe('open');
    const p = after.get('proposals', r.proposalId!)!;
    expect(p.status).toBe('pending');
    expect(p.changes.find((c) => c.field === 'state')).toMatchObject({ before: 'open', after: 'done' });
    await db.applyProposal({ params: { id: r.proposalId! }, body: {} } as never);
    expect((await db.model()).get('workItems', w.id)!.state).toBe('done');
  });

  it('a timer wakes a snoozed item back to its previous state', async () => {
    const m = await db.model();
    const w = m.all('workItems').find((x) => x.state === 'snoozed')!;
    const r = await db.applyClosureSignal(w.id, { type: 'timer', evidenceId: null, at: new Date(Date.parse(w.snoozedUntil ?? L.now.toISOString()) + 60_000).toISOString() });
    expect(r.decision.kind).toBe('transition');
    const woke = (await db.model()).get('workItems', w.id)!;
    expect(woke.state).toBe(w.snoozedFrom ?? 'open');
    expect(woke.snoozedUntil).toBeNull();
  });
});

describe.runIf(BE1B)('INTEGRATE-1: B1 detail tables are audited', () => {
  it('training details live in work_item_training_details (no ext copy) and read back as the seed', async () => {
    const trainings = L.seed.workItems.filter((w) => w.training);
    expect(trainings.length).toBeGreaterThan(0);
    const [n] = await rows<{ n: number }>(sql`select count(*)::int as n from work_item_training_details`);
    expect(n!.n).toBe(trainings.length);
    const kv = await db.rawKv();
    for (const t of trainings) expect((kv.get(`cc.ext/work_items/${T(t.id)}`) as { training?: unknown } | undefined)?.training).toBeUndefined();
    const m = await db.model();
    for (const t of trainings) expect(m.get('workItems', T(t.id))!.training).toEqual(t.training);
    const [a] = await rows<{ n: number }>(sql`select count(*)::int as n from audit_events where table_name = 'work_item_training_details'`);
    expect(a!.n).toBe(trainings.length);
  });

  it('a travel detail insert is audited (row key = work_item_id) and undone exactly', async () => {
    const w = (await db.model()).all('workItems').find((x) => x.kind === 'travel') ?? (await db.model()).all('workItems')[0]!;
    const { changeSetId } = await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.user('test.travel'), reason: 'travel detail' }, async (tx) => {
      await tx.insert(workItemTravelDetails).values({ workItemId: w.id, destination: 'Denver' }).onConflictDoNothing();
    });
    const [ae] = await rows<{ row_id: string; entity_id: string }>(sql`select row_id, entity_id from audit_events where change_set_id = ${changeSetId}`);
    expect(ae).toEqual({ row_id: w.id, entity_id: w.id });
    await undoChangeSet(changeSetId, { db: handle.db });
    const [n] = await rows<{ n: number }>(sql`select count(*)::int as n from work_item_travel_details where work_item_id = ${w.id}`);
    expect(n!.n).toBe(0);
  });
});

describe.runIf(BE1B)('INTEGRATE-1: chat (CONTRACT-1) in db mode', () => {
  it('createChatThread keeps its context as auto chips; the first message titles it; the model is body → settings default', async () => {
    const acc = (await db.model()).all('accounts')[0]!;
    const t = await db.createChatThread({ body: { context: [{ type: 'account', id: acc.id, label: acc.name }] } } as never);
    expect(t).toMatchObject({ title: 'New thread', isDefault: false, messageCount: 0, context: [{ type: 'account', id: acc.id, via: 'auto' }] });
    const ev = await collect(db.chat({ body: { threadId: t.id, text: 'Summarize where Acme stands before my 1:1 this afternoon please', context: [], model: 'opus' }, signal: new AbortController().signal } as never));
    expect(ev.map((e) => e.type)).toEqual(['start', 'error']);
    // Assistant v2: Auto routing picks the tier per turn; the request did not name a model
    expect(ev[0]).toMatchObject({ type: 'start', threadId: t.id });
    const routed = (ev[0] as { model: string }).model;
    expect(['haiku', 'sonnet', 'opus']).toContain(routed);
    const d = await db.getChatThread({ params: { id: t.id } } as never);
    expect(d.thread.title).toBe('Summarize where Acme stands before my 1:1 this…');
    expect(d.thread.messageCount).toBe(2);
    expect(d.messages[1]).toMatchObject({ role: 'assistant', model: routed, status: 'error', text: '' });
    const s = await db.getSettings({} as never);
    expect(s.chat).toMatchObject({ version: 1, routing: 'auto' });
    await db.patchSettings({ params: { section: 'chat' }, body: { ifVersion: 1, value: { routing: 'opus' } } } as never);
    const ev2 = await collect(db.chat({ body: { threadId: t.id, text: 'again', context: [] }, signal: new AbortController().signal } as never));
    expect(ev2[0]).toMatchObject({ type: 'start', model: 'opus' });
  });

  it('a backend’s parts persist redacted; receipts and proposals refresh on read; chat ops write as actor chat without locks', async () => {
    const m = await db.model();
    const target = m.all('workItems').find((w) => w.state === 'open' && w.userLockedFields.includes('title')) ?? m.all('workItems').find((w) => w.state === 'open')!;
    if (!target.userLockedFields.includes('title')) await db.patchItem({ params: { id: target.id }, body: { ifVersion: target.version, patch: { title: target.title } } } as never);
    const locksBefore = (await db.model()).get('workItems', target.id)!.userLockedFields;
    // an invented bot token, joined at run time so no token-shaped literal is committed (GitHub push protection)
    const secret = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-');
    const backend: DbChatBackend = async function* (ctx) {
      yield { type: 'tool-start', name: 'cc.edit', summary: 'Editing the item', args: { token: secret, itemId: target.id } };
      const r = await ctx.ops.patchItem(target.id, { title: 'Chat wants this title', notes: 'Chat note' }, 'Tidied');
      yield { type: 'tool-result', summary: 'Edited', ok: true, result: `used ${secret}` };
      yield { type: 'text', text: 'Done.' };
      if (r.receipt) yield { type: 'receipt', receipt: r.receipt };
      for (const p of r.proposals) yield { type: 'proposal', proposal: p, summary: 'Use the new title?' };
    };
    const chatDb = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, chatBackend: backend });
    try {
      const thread = (await chatDb.listChatThreads({} as never)).threads.find((t) => t.isDefault)!;
      const ev = await collect(chatDb.chat({ body: { threadId: thread.id, text: 'tidy it', context: [] }, signal: new AbortController().signal } as never));
      expect(ev.map((e) => e.type)).toEqual(['start', 'tool-start', 'tool-result', 'text-delta', 'receipt', 'proposal', 'done']);
      expect(JSON.stringify(ev)).not.toContain(secret);

      const item = (await chatDb.model()).get('workItems', target.id)!;
      expect(item.notes).toContain('Chat note');
      expect(item.title).toBe(target.title); // user-locked: staged as a proposal instead
      expect(item.userLockedFields).toEqual(locksBefore); // chat adds no locks
      const receipt = ev.find((e) => e.type === 'receipt') as Extract<ChatSseEvent, { type: 'receipt' }>;
      const [cs] = await rows<{ actor_kind: string; actor_ref: string }>(sql`select actor_kind, actor_ref from change_sets where id = ${receipt.receipt.changes[0]!.auditId}`);
      expect(cs).toEqual({ actor_kind: 'chat', actor_ref: 'chat.edit' });

      const read = async () => (await chatDb.getChatThread({ params: { id: thread.id } } as never)).messages.at(-1)!;
      const msg = await read();
      expect(msg).toMatchObject({ role: 'assistant', status: 'complete', model: (ev[0] as Extract<ChatSseEvent, { type: 'start' }>).model, text: 'Done.' });
      expect(JSON.stringify(msg)).not.toContain(secret);
      const tool = msg.parts.find((p) => p.type === 'tool') as Extract<(typeof msg.parts)[number], { type: 'tool' }>;
      expect(tool).toMatchObject({ name: 'cc.edit', ok: true });
      expect(tool.args).toBeTruthy();
      const line = () => (msg2: typeof msg) => (msg2.parts.find((p) => p.type === 'receipt') as Extract<(typeof msg.parts)[number], { type: 'receipt' }>).receipt.changes[0]!;
      expect(line()(msg)).toMatchObject({ undoneAt: null, undoAuditId: null });
      const u = await chatDb.undoAudit({ params: { id: line()(msg).auditId }, body: {} } as never);
      const msgU = await read();
      expect(line()(msgU).undoAuditId).toBe(u.auditId);
      expect(line()(msgU).undoneAt).toBeTruthy();
      const redo = await chatDb.undoAudit({ params: { id: u.auditId! }, body: {} } as never);
      const msgR = await read();
      expect(line()(msgR)).toMatchObject({ undoneAt: null, undoAuditId: redo.auditId });

      const prop = msg.parts.find((p) => p.type === 'proposal') as Extract<(typeof msg.parts)[number], { type: 'proposal' }>;
      expect(prop.status).toBe('pending');
      expect(prop.proposal.actor).toBe('chat');
      await chatDb.rejectProposal({ params: { id: prop.proposal.id }, body: {} } as never);
      const msgP = await read();
      expect((msgP.parts.find((p) => p.type === 'proposal') as typeof prop).status).toBe('dismissed');
    } finally {
      await chatDb.dispose();
    }
  });

  it('chat resolve / capture write as actor chat (doneBy chat, no title lock)', async () => {
    const ops = db.chatOps();
    const m = await db.model();
    const w = m.all('workItems').find((x) => x.state === 'open' && !x.userLockedFields.includes('state'))!;
    const r = await ops.resolveItem(w.id, 'handed_off', { personName: 'Dana Reyes' });
    expect(r.item).toMatchObject({ state: 'done', doneBy: 'chat', resolution: 'handed_off', involvement: 'watcher' });
    const [cs] = await rows<{ actor_kind: string; actor_ref: string }>(sql`select actor_kind, actor_ref from change_sets where id = ${r.receipt!.changes[0]!.auditId}`);
    expect(cs).toEqual({ actor_kind: 'chat', actor_ref: 'chat.resolve' });
    const c = await ops.capture('Send Dana the deck ~10m');
    expect(c.item).toMatchObject({ why: 'Captured from chat', userLockedFields: [], effort: { youMin: 10, agentMin: 0 } });
    expect(c.receipt.actor).toBe('chat');
  });
});

describe.runIf(BE1B)('INTEGRATE-1: tools view, people, one serializer', () => {
  it('a TOOLS manifest row is served through toToolAdapter; runs are validated with validateInput', async () => {
    // a registry manifest the seed does not already carry (the seed has a legacy talk-track row)
    const manifest = parseManifest({ ...JSON.parse(readFileSync(path.resolve(__dirname, '../../../tools-registry/talk-track.json'), 'utf8')), id: 'talk-track-registry' });
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test.tools'), reason: 'register talk-track' }, async (tx, cs) => {
      const me = (await db.model()).ctx.me;
      await insertToolsManifest({ tx, cs, userId: L.userId, me, now: L.now, extractorId: '', timezone: 'UTC', kv: new Map() }, manifest, { enabled: true });
    });
    const tools = await db.getTools({} as never);
    const row = tools.adapters.find((a) => a.id === manifest.id)!;
    const want = toToolAdapter(manifest, { enabled: true });
    expect(row.fields).toEqual(want.fields);
    expect(row).toMatchObject({ name: want.name, launchKind: want.launchKind, requiresConfirm: want.requiresConfirm, estimatedDuration: want.estimatedDuration });
    await expect(db.startToolRun({ params: { id: manifest.id }, body: { inputs: { name: 'x', customer: 'Acme' } } } as never)).rejects.toMatchObject({ code: 'validation' });
    await expect(db.startToolRun({ params: { id: manifest.id }, body: { inputs: { name: 'x', customer: 'Acme', context: 'c', references: 42 } } } as never)).rejects.toMatchObject({ code: 'validation' });
  });

  it('GET /people filters by q, account and Slack id', async () => {
    const m = await db.model();
    const all = await db.getPeople({ query: { q: '', limit: 100 } } as never);
    expect(all.total).toBe(m.all('people').length);
    const slack = await db.getPeople({ query: { q: '', limit: 100, slack: true } } as never);
    expect(slack.people.every((p) => p.slackId)).toBe(true);
    const p0 = m.all('people').find((p) => p.accountId)!;
    const byAcc = await db.getPeople({ query: { q: '', limit: 100, account: p0.accountId } } as never);
    expect(byAcc.people.every((p) => p.account?.id === p0.accountId)).toBe(true);
    const byName = await db.getPeople({ query: { q: p0.name.split(' ')[0]!.slice(0, 3), limit: 5 } } as never);
    expect(byName.people[0]!.name.toLowerCase()).toContain(p0.name.split(' ')[0]!.slice(0, 3).toLowerCase());
  });

  it('preview and dry-run dispatch carry the same compose payload; the preview has sanitized html', async () => {
    const d = (await db.model()).all('drafts').find((x) => x.status === 'ready' || x.status === 'drafting')!;
    const p = await db.previewDraft({ params: { id: d.id }, body: { mode: 'draft' } } as never);
    expect(p.dryRun).toBe(true);
    expect(p.html).toBeTruthy();
    expect(p.html).not.toMatch(/<script/i);
    const r = await db.dispatchDraft({ params: { id: d.id }, body: { ifVersion: p.version, mode: 'draft', confirmToken: p.confirmToken } } as never);
    expect(r.dryRun).toBe(true);
    expect(JSON.stringify(r.payload)).toBe(JSON.stringify(p.payload));
  });
});
