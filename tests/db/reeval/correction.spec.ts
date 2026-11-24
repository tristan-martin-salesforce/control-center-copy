/**
 * R1 + R2 (holistic review 2026-11-20, lane 03) on the real path: the one correction rule both closers read
 * (src/engines/closure/correction-db.ts), the re-evaluation that honours it, a follow-up that reopens a close for you,
 * and Settle's selection and reopen of engine-closed items. Placeholder data only.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, undoChangeSet, withChangeSet } from '@/db/changeset';
import { loadCorrectionFacts } from '@/engines/closure/correction-db';
import { selectSettleItems } from '@/engines/settle/select-db';
import { DbDataSource } from '@/server/datasource/db';
import { reevaluateWorkItem } from '@/server/datasource/db/closure';

import { ago, linkEvidence, loadExampleSeed, makeItem, openTestDb, rows } from './helpers';

const h = openTestDb(6);
const db = h.db;
let userId: string;
let ds: DbDataSource;

beforeAll(async () => {
  userId = await loadExampleSeed(db);
  ds = new DbDataSource({ handle: h, userId });
});
afterAll(async () => {
  await ds.dispose();
  await h.close();
});

const status = async (id: string) => (await rows<{ status: string; done_by: string | null }>(db, sql`select status::text as status, done_by::text as done_by from work_items where id = ${id}`))[0]!;

/** A transition row as a user verb (or the engine) writes it. */
const transition = (id: string, from: string | null, to: string, actor: 'user' | 'engine') =>
  withChangeSet({ db, userId, actor: actor === 'user' ? actors.user('test.verb') : actors.engine('test'), reason: 'test transition', entity: { type: 'work_item', id } }, (tx) =>
    tx.execute(sql`
      insert into work_item_transitions (work_item_id, from_status, to_status, actor_kind, actor_ref, reason, change_set_id)
      values (${id}, ${from}::work_item_status, ${to}::work_item_status, ${actor}, 'test', 'test', nullif(current_setting('cc.change_set_id', true), '')::uuid)`),
  );

/** Close it for me (the engine), `daysAgo` days ago. */
const closeForMe = (id: string, daysAgo: number) =>
  withChangeSet({ db, userId, actor: actors.engine('test'), reason: 'test close', entity: { type: 'work_item', id } }, (tx) =>
    tx.execute(sql`update work_items set status = 'done', done_at = ${ago(daysAgo).toISOString()}::timestamptz, done_by = 'engine', resolution = 'done_by_me', status_changed_at = ${ago(daysAgo).toISOString()}::timestamptz where id = ${id}`),
  );

const sureDone = { role: 'completion' as const, confidence: 0.95, reason: 'said done in Slack: sent the deck in the thread', fromMe: true };

describe('R1: one correction rule', () => {
  it('a reopened item is never re-closed by the re-evaluation: a Sure completion only asks (likely_done)', async () => {
    const id = await makeItem(db, userId);
    await transition(id, 'done', 'open', 'user'); // the user reopened it after a close
    expect((await loadCorrectionFacts(db, userId, [id])).get(id)).toMatchObject({ userReopened: true, userKept: false });
    const ev = await linkEvidence(db, userId, id, sureDone);
    await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: ev.jobId, generation: ev.generation } });
    expect((await status(id)).status).toBe('likely_done');
  });

  it('an item accepted from Triage may still close for you (an accept is not a correction)', async () => {
    const id = await makeItem(db, userId);
    await transition(id, null, 'suggested', 'engine');
    await transition(id, 'suggested', 'open', 'user'); // Accept
    expect((await loadCorrectionFacts(db, userId, [id])).get(id)).toMatchObject({ userReopened: false, userKept: false });
    const ev = await linkEvidence(db, userId, id, sureDone);
    await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: ev.jobId, generation: ev.generation } });
    expect(await status(id)).toMatchObject({ status: 'done', done_by: 'engine' });
  });

  it('Keep on Still needed? is a correction: kept items only ask', async () => {
    const id = await makeItem(db, userId);
    await transition(id, 'open', 'suggested', 'engine'); // moved to Still needed?
    await transition(id, 'suggested', 'open', 'user'); // Keep
    expect((await loadCorrectionFacts(db, userId, [id])).get(id)).toMatchObject({ userKept: true });
    const ev = await linkEvidence(db, userId, id, sureDone);
    await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: ev.jobId, generation: ev.generation } });
    expect((await status(id)).status).toBe('likely_done');
  });
});

describe('W0-3: only an Undo of an engine close / ask / Still needed? move is a correction', () => {
  const engine = (id: string, reason: string, q: ReturnType<typeof sql>) =>
    withChangeSet({ db, userId, actor: actors.engine('test'), reason, entity: { type: 'work_item', id } }, (tx) => tx.execute(q));

  it('an Undo of an engine due-date patch does not block a close for you', async () => {
    const id = await makeItem(db, userId);
    const { changeSetId } = await engine(id, 'test due date', sql`update work_items set due_at = now() + interval '2 days' where id = ${id}`);
    await undoChangeSet(changeSetId, { db, actor: 'user' });
    expect((await loadCorrectionFacts(db, userId, [id])).get(id)).toMatchObject({ userReopened: false, reopenUndoId: null });
    const ev = await linkEvidence(db, userId, id, sureDone);
    await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: ev.jobId, generation: ev.generation } });
    expect(await status(id)).toMatchObject({ status: 'done', done_by: 'engine' });
  });

  it('an Undo of an engine close (no transition row) is a correction, and names the Undo', async () => {
    const id = await makeItem(db, userId);
    const { changeSetId } = await closeForMe(id, 1);
    const undo = await undoChangeSet(changeSetId, { db, actor: 'user' });
    expect((await loadCorrectionFacts(db, userId, [id])).get(id)).toMatchObject({ userReopened: true, reopenUndoId: undo.changeSetId });
    const ev = await linkEvidence(db, userId, id, sureDone);
    await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: ev.jobId, generation: ev.generation } });
    expect((await status(id)).status).toBe('likely_done');
  });

  it('Undo reopen (an undo of that Undo) puts it back to done and is no longer a correction; the panel carries the id only while reopened', async () => {
    const id = await makeItem(db, userId);
    const { changeSetId } = await closeForMe(id, 1);
    const undo = await undoChangeSet(changeSetId, { db, actor: 'user' });
    expect((await status(id)).status).not.toBe('done');
    expect((await ds.getResolutionCheck({ params: { id } })).reopenUndoId).toBe(undo.changeSetId);
    await undoChangeSet(undo.changeSetId, { db, actor: 'user' });
    expect(await status(id)).toMatchObject({ status: 'done', done_by: 'engine' });
    expect((await loadCorrectionFacts(db, userId, [id])).get(id)).toMatchObject({ userReopened: false, reopenUndoId: null });
    expect((await ds.getResolutionCheck({ params: { id } })).reopenUndoId).toBeNull();
  });

  it('an Undo of an engine Looks done ask (a transition to likely_done) is a correction', async () => {
    const id = await makeItem(db, userId);
    const { changeSetId } = await engine(
      id,
      'test ask',
      sql`with u as (update work_items set status = 'likely_done' where id = ${id} returning id)
          insert into work_item_transitions (work_item_id, from_status, to_status, actor_kind, actor_ref, reason, change_set_id)
          select id, 'open', 'likely_done', 'engine', 'test', 'test', nullif(current_setting('cc.change_set_id', true), '')::uuid from u`,
    );
    await undoChangeSet(changeSetId, { db, actor: 'user' });
    expect((await loadCorrectionFacts(db, userId, [id])).get(id)).toMatchObject({ userReopened: true });
  });
});

describe('R2: a follow-up after a close reopens', () => {
  it('a follow_up: contradiction on an item closed for you two days ago reopens it ("PERSON wrote again")', async () => {
    const id = await makeItem(db, userId);
    await closeForMe(id, 2);
    const ev = await linkEvidence(db, userId, id, { role: 'contradiction', confidence: 0.7, reason: "follow_up: PERSON_A wrote again: that link doesn't open" });
    await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: ev.jobId, generation: ev.generation } });
    expect((await status(id)).status).toBe('open'); // `reopened` in the contract
    const t = await rows<{ reason: string }>(db, sql`select reason from work_item_transitions where work_item_id = ${id} and to_status = 'open' and actor_kind = 'engine' order by id desc limit 1`);
    expect(t[0]!.reason).toContain('wrote again');
  });

  it("Settle selects an engine-closed item when the asker writes to me in its conversation (not for chatter, W0-2), and its reopen clears the close", async () => {
    const id = await makeItem(db, userId);
    const ch = `D0R2${randomUUID().slice(0, 6).toUpperCase()}`;
    const origin = await linkEvidence(db, userId, id, { role: 'origin', confidence: 0.9, reason: 'asked in a DM', noBump: true });
    await withChangeSet({ db, userId, actor: actors.scanner('slack'), reason: 'test meta' }, (tx) =>
      tx.execute(sql`update source_items set meta = ${JSON.stringify({ channelId: ch, author: { name: 'PERSON_A', externalId: 'U0PERSONA' } })}::jsonb, occurred_at = ${ago(5).toISOString()}::timestamptz where id = ${origin.sourceItemId}`),
    );
    await closeForMe(id, 2);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const before = await selectSettleItems(db, userId, since, new Date());
    expect(before.map((r) => r.id)).not.toContain(id);
    const line = (author: string, toMe: boolean) =>
      withChangeSet({ db, userId, actor: actors.scanner('slack'), reason: 'test line' }, (tx) =>
        tx.execute(sql`
          insert into source_items (owner_user_id, source, kind, external_id, dedupe_key, content_hash, occurred_at, from_me, addressed_to_me, title, body, meta)
          values (${userId}, 'slack', 'slack_message', ${randomUUID()}, ${`test:${randomUUID()}`}, 'h', now(), false, ${toMe}, 'PLACEHOLDER line', 'see you at noon', ${JSON.stringify({ channelId: ch, author: { name: author, externalId: `U0${author.replace(/[^A-Z0-9]/g, '')}` } })}::jsonb)`),
      );
    // W0-2: someone else chatting in the conversation does not re-judge the close
    await line('PERSON_Z', false);
    expect((await selectSettleItems(db, userId, since, new Date())).map((r) => r.id)).not.toContain(id);
    // the asker writing to me does
    await line('PERSON_A', true);
    expect((await selectSettleItems(db, userId, since, new Date())).find((r) => r.id === id)).toMatchObject({ status: 'done' });
    expect((await selectSettleItems(db, userId, since, new Date(), 600, { reopenOnFollowUp: false })).map((r) => r.id)).not.toContain(id);

    const r = await ds.settleApply([{ itemId: id, expectedState: 'done', action: 'reopen', reasonClass: null, reason: 'still yours', verdict: 'still_yours', confidence: 0.8, check: 'settle-item@test', cite: { byName: 'PERSON_A', fromMe: false } }]);
    expect(r.applied).toEqual({ reopen: 1 });
    const after = (await rows<{ status: string; done_at: string | null; done_by: string | null }>(db, sql`select status::text as status, done_at, done_by::text as done_by from work_items where id = ${id}`))[0]!;
    expect(after).toEqual({ status: 'open', done_at: null, done_by: null });
  });
});
