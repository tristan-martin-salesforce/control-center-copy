import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  actors,
  applyProposal,
  closeIdleBursts,
  engineUpdate,
  proposalStillCurrent,
  rejectProposal,
  undoChangeSet,
  updateVersioned,
  withChangeSet,
} from '../../../src/db/changeset';
import {
  AlreadyUndoneError,
  ChangeSetClosedError,
  ChangeSetRequiredError,
  ConflictError,
  ConstraintViolationError,
  mapPgError,
  UndoConflictError,
} from '../../../src/db/errors';
import {
  auditEvents,
  changeProposals,
  changeSets,
  userSettings,
  workItems,
  workItemTransitions,
} from '../../../src/db/schema';
import { createExtractor, createUser, createWorkItem, openTestDb, rowImage } from './helpers';

const h = openTestDb();
const db = h.db;
let userId: string;
let extractorId: string;

beforeAll(async () => {
  userId = await createUser(db);
  extractorId = await createExtractor(db);
});
afterAll(() => h.close());

describe('change sets and the audit trigger', () => {
  it('refuses a write to a curated table outside a change set', async () => {
    const attempt = db
      .insert(workItems)
      .values({ ownerUserId: userId, kind: 'task', origin: 'manual', title: 'sneaky' });
    const err = await attempt.then(
      () => null,
      (e: unknown) => mapPgError(e),
    );
    expect(err).toBeInstanceOf(ChangeSetRequiredError);
    expect((err as Error).message).toMatch(/outside a change set/);
    const { n } = (await db.execute<{ n: string }>(sql`select count(*) as n from work_items where title = 'sneaky'`)).rows[0]!;
    expect(Number(n)).toBe(0);
  });

  it('refuses writes into a closed change set', async () => {
    const { changeSetId } = await withChangeSet({ db, userId, actor: 'user', reason: 'noop' }, async () => null);
    const err = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('cc.change_set_id', ${changeSetId}, true),
                                    set_config('cc.actor_kind', 'user', true)`);
        await tx.insert(workItems).values({ ownerUserId: userId, kind: 'task', origin: 'manual', title: 'late' });
      })
      .then(
        () => null,
        (e: unknown) => mapPgError(e),
      );
    expect(err).toBeInstanceOf(ChangeSetClosedError);
  });

  it('writes one coalesced audit row per (change set, row) with before/after images', async () => {
    const item = await createWorkItem(db, userId, { title: 'v0' });
    const { changeSetId } = await withChangeSet({ db, userId, actor: actors.user('rename'), reason: 'rename twice' }, async (tx) => {
      await tx.update(workItems).set({ title: 'v1' }).where(eq(workItems.id, item.id));
      await tx.update(workItems).set({ title: 'v2', purpose: 'For: ACME demo' }).where(eq(workItems.id, item.id));
    });
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.changeSetId, changeSetId));
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a).toMatchObject({ op: 'update', tableName: 'work_items', entityType: 'work_items', entityId: item.id });
    expect(a.coalescedCount).toBe(2);
    expect(a.changedFields).toEqual(['purpose', 'title']);
    expect(a.before).toMatchObject({ title: 'v0', purpose: null });
    expect(a.after).toMatchObject({ title: 'v2', purpose: 'For: ACME demo' });
    expect(a.before).not.toHaveProperty('search_tsv');
    const [cs] = await db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
    expect(cs).toMatchObject({ kind: 'user_edit', actorKind: 'user', actorRef: 'rename', summary: 'rename twice' });
    expect(cs!.closedAt).not.toBeNull();
  });

  it('a no-op update writes no audit row and keeps the change set off the ⌘Z stack', async () => {
    const item = await createWorkItem(db, userId, { title: 'same' });
    const { changeSetId } = await withChangeSet({ db, userId, actor: 'user', reason: 'noop' }, (tx) =>
      tx.update(workItems).set({ title: 'same' }).where(eq(workItems.id, item.id)),
    );
    expect(await db.select().from(auditEvents).where(eq(auditEvents.changeSetId, changeSetId))).toHaveLength(0);
    const [cs] = await db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
    expect(cs!.undoable).toBe(false);
  });

  it('closed change sets keep their audit rows immutable', async () => {
    const item = await createWorkItem(db, userId);
    const [a] = await db.select().from(auditEvents).where(eq(auditEvents.entityId, item.id));
    const err = await db
      .update(auditEvents)
      .set({ coalescedCount: 99 })
      .where(eq(auditEvents.id, a!.id))
      .then(
        () => null,
        (e: unknown) => mapPgError(e),
      );
    expect(err).toBeInstanceOf(ChangeSetClosedError);
  });
});

describe('undo', () => {
  it('audit rows carry inverse payloads and undo restores the exact prior state; redo re-applies', async () => {
    const item = await createWorkItem(db, userId, { title: 'Original', purpose: 'For: QBR' });

    await db.insert(userSettings).values({ ownerUserId: userId, key: 'reopen.window_days', value: 7 }).catch(() => undefined);
    // user_settings is audited too, so the plain insert above must have been refused
    expect(await db.select().from(userSettings).where(eq(userSettings.ownerUserId, userId))).toHaveLength(0);
    await withChangeSet({ db, userId, actor: 'user', reason: 'seed settings' }, (tx) =>
      tx.insert(userSettings).values([
        { ownerUserId: userId, key: 'reopen.window_days', value: 7 },
        { ownerUserId: userId, key: 'close.auto_confidence', value: 0.9 },
      ]),
    );

    const before = await rowImage(db, 'work_items', item.id);
    const sibling = await createWorkItem(db, userId, { title: 'Sibling to delete' });
    const siblingBefore = await rowImage(db, 'work_items', sibling.id);

    // One change set: update the item, insert a new item, delete the sibling, update + delete settings.
    const { result: created, changeSetId } = await withChangeSet({ db, userId, actor: 'user', reason: 'big edit' }, async (tx) => {
      await tx.update(workItems).set({ title: 'Edited', status: 'in_progress', importance: 'high' }).where(eq(workItems.id, item.id));
      const [n] = await tx.insert(workItems).values({ ownerUserId: userId, kind: 'ask', origin: 'chat', title: 'New one' }).returning();
      await tx.delete(workItems).where(eq(workItems.id, sibling.id));
      await tx.update(userSettings).set({ value: 14 }).where(sql`owner_user_id = ${userId} and key = 'reopen.window_days'`);
      await tx.delete(userSettings).where(sql`owner_user_id = ${userId} and key = 'close.auto_confidence'`);
      return n!;
    });

    const audit = await db.select().from(auditEvents).where(eq(auditEvents.changeSetId, changeSetId));
    const byRow = new Map(audit.map((a) => [`${a.tableName}:${a.rowId}`, a]));
    expect(byRow.get(`work_items:${item.id}`)).toMatchObject({ op: 'update', before: { title: 'Original', status: 'open' } });
    expect(byRow.get(`work_items:${created.id}`)).toMatchObject({ op: 'insert', before: null });
    expect(byRow.get(`work_items:${sibling.id}`)).toMatchObject({ op: 'delete', after: null, before: { title: 'Sibling to delete' } });
    expect(byRow.get(`user_settings:${userId}|reopen.window_days`)).toMatchObject({ op: 'update', before: { value: 7 }, after: { value: 14 } });
    expect(byRow.get(`user_settings:${userId}|close.auto_confidence`)).toMatchObject({ op: 'delete', before: { value: 0.9 } });

    const undo = await undoChangeSet(changeSetId, { db });
    expect(undo.result.rows).toBe(audit.length);

    expect(await rowImage(db, 'work_items', item.id)).toEqual(before);
    expect(await rowImage(db, 'work_items', sibling.id)).toEqual(siblingBefore);
    expect(await rowImage(db, 'work_items', created.id)).toBeNull();
    const settings = await db.select().from(userSettings).where(eq(userSettings.ownerUserId, userId));
    expect(Object.fromEntries(settings.map((s) => [s.key, s.value]))).toEqual({
      'reopen.window_days': 7,
      'close.auto_confidence': 0.9,
    });

    const [target] = await db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
    expect(target!.undoneAt).not.toBeNull();
    expect(target!.undoneByChangeSetId).toBe(undo.changeSetId);
    const [u] = await db.select().from(changeSets).where(eq(changeSets.id, undo.changeSetId));
    expect(u).toMatchObject({ kind: 'undo', undoOfChangeSetId: changeSetId });

    await expect(undoChangeSet(changeSetId, { db })).rejects.toBeInstanceOf(AlreadyUndoneError);

    // Redo = undo the undo.
    const redo = await undoChangeSet(undo.changeSetId, { db });
    const [r] = await db.select().from(changeSets).where(eq(changeSets.id, redo.changeSetId));
    expect(r!.kind).toBe('redo');
    expect((await rowImage(db, 'work_items', item.id))!.title).toBe('Edited');
    expect(await rowImage(db, 'work_items', sibling.id)).toBeNull();
    const [again] = await db.select().from(changeSets).where(eq(changeSets.id, changeSetId));
    expect(again!.undoneAt).toBeNull(); // the original is in effect again
  });

  it('undo of an item creation removes it even with an append-only transition log', async () => {
    const { result: id, changeSetId } = await withChangeSet({ db, userId, actor: 'user', reason: 'capture' }, async (tx) => {
      const [wi] = await tx.insert(workItems).values({ ownerUserId: userId, kind: 'task', origin: 'manual', status: 'open', title: 'Captured' }).returning();
      await tx.insert(workItemTransitions).values({ workItemId: wi!.id, toStatus: 'open', actorKind: 'user', changeSetId: sql`current_setting('cc.change_set_id')::uuid` as never });
      return wi!.id;
    });
    // a direct delete of a transition is still refused
    const err = await db.delete(workItemTransitions).where(eq(workItemTransitions.workItemId, id)).then(() => null, (e: unknown) => mapPgError(e));
    expect((err as Error).message).toMatch(/append-only/);
    await undoChangeSet(changeSetId, { db });
    expect(await rowImage(db, 'work_items', id)).toBeNull();
  });

  it('stops with "changed since" when a later change touched the same fields, and undoes nothing', async () => {
    const item = await createWorkItem(db, userId, { title: 'A', purpose: 'p0' });
    const first = await withChangeSet({ db, userId, actor: 'user', reason: 'edit 1' }, (tx) =>
      tx.update(workItems).set({ title: 'B', purpose: 'p1' }).where(eq(workItems.id, item.id)),
    );
    await withChangeSet({ db, userId, actor: 'user', reason: 'edit 2' }, (tx) =>
      tx.update(workItems).set({ title: 'C' }).where(eq(workItems.id, item.id)),
    );
    const err = await undoChangeSet(first.changeSetId, { db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UndoConflictError);
    expect(err).toMatchObject({ reason: 'changed_since', table: 'work_items' });
    expect(await rowImage(db, 'work_items', item.id)).toMatchObject({ title: 'C', purpose: 'p1' });
  });
});

describe('optimistic concurrency', () => {
  it('bumps the version, locks the user-edited field, and throws ConflictError on a stale version', async () => {
    const item = await createWorkItem(db, userId, { title: 'Draft agenda' });
    expect(item.version).toBe(1);
    const { result } = await withChangeSet({ db, userId, actor: 'user', reason: 'rename' }, (_tx, cs) =>
      cs.updateVersioned(workItems, item.id, 1, { title: 'Final agenda' }),
    );
    expect(result.row.version).toBe(2);
    expect(result.row.userLockedFields).toEqual(['title']);

    const stale = await withChangeSet({ db, userId, actor: 'user', reason: 'rename again' }, (tx) =>
      updateVersioned(tx, workItems, item.id, 1, { title: 'Lost update' }),
    ).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale).toMatchObject({ status: 409, expectedVersion: 1, currentVersion: 2 });
    expect((await rowImage(db, 'work_items', item.id))!.title).toBe('Final agenda');
  });

  it('surfaces DB check constraints as typed errors', async () => {
    const item = await createWorkItem(db, userId);
    const err = await withChangeSet({ db, userId, actor: 'user', reason: 'bad done' }, (_tx, cs) =>
      cs.updateVersioned(workItems, item.id, item.version, { status: 'done' }), // done needs done_at + done_by
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConstraintViolationError);
    expect(err).toMatchObject({ kind: 'check', constraint: 'work_items_done_chk' });
  });
});

describe('user-locked fields', () => {
  it('an engine write to a locked field becomes a proposal; unlocked fields still apply', async () => {
    const item = await createWorkItem(db, userId, { title: 'Send pricing deck' });
    await withChangeSet({ db, userId, actor: 'user', reason: 'rename' }, (_tx, cs) =>
      cs.updateVersioned(workItems, item.id, item.version, { title: 'Send pricing deck v2' }),
    );

    const { result: r1 } = await withChangeSet({ db, userId, actor: actors.engine('closure@1'), reason: 'new info from Slack' }, (_tx, cs) =>
      cs.update(workItems, item.id, { title: 'Send pricing deck + SOW', purpose: 'For: ACME renewal' }, { provenance: { extractorId, confidence: 0.8 } }),
    );
    expect(r1.applied).toEqual(['purpose']);
    expect(r1.proposals.map((p) => p.field)).toEqual(['title']);
    expect(r1.row).toMatchObject({ title: 'Send pricing deck v2', purpose: 'For: ACME renewal', version: 3 });
    const [p1] = await db.select().from(changeProposals).where(eq(changeProposals.id, r1.proposals[0]!.proposalId));
    expect(p1).toMatchObject({
      entityType: 'work_items',
      entityId: item.id,
      field: 'title',
      status: 'pending',
      currentValue: 'Send pricing deck v2',
      proposedValue: 'Send pricing deck + SOW',
      reason: 'new info from Slack',
      baseVersion: 3,
      extractorId,
    });

    // A newer engine proposal for the same field supersedes the older one.
    const { result: r2 } = await withChangeSet({ db, userId, actor: 'engine', reason: 'more new info' }, (tx) =>
      engineUpdate(tx, workItems, item.id, { title: 'Send pricing deck + SOW + timeline' }),
    );
    const [old] = await db.select().from(changeProposals).where(eq(changeProposals.id, p1!.id));
    expect(old).toMatchObject({ status: 'superseded', supersededById: r2.proposals[0]!.proposalId });

    // Accepting applies it in an undoable change set; the field stays locked.
    const accepted = await withChangeSet({ db, userId, actor: 'user', reason: 'accept proposal' }, (tx) =>
      applyProposal(tx, r2.proposals[0]!.proposalId),
    );
    const after = await rowImage(db, 'work_items', item.id);
    expect(after).toMatchObject({ title: 'Send pricing deck + SOW + timeline', user_locked_fields: ['title'] });
    const [p2] = await db.select().from(changeProposals).where(eq(changeProposals.id, r2.proposals[0]!.proposalId));
    expect(p2).toMatchObject({ status: 'accepted', decidedBy: 'user', appliedChangeSetId: accepted.changeSetId });

    await undoChangeSet(accepted.changeSetId, { db });
    expect((await rowImage(db, 'work_items', item.id))!.title).toBe('Send pricing deck v2');
    const [p3] = await db.select().from(changeProposals).where(eq(changeProposals.id, r2.proposals[0]!.proposalId));
    expect(p3!.status).toBe('pending');

    await withChangeSet({ db, userId, actor: 'user', reason: 'reject' }, (tx) => rejectProposal(tx, p3!.id));
    const [p4] = await db.select().from(changeProposals).where(eq(changeProposals.id, p3!.id));
    expect(p4!.status).toBe('rejected');
  });

  it('B4: a proposal applies only while its field is still what it was proposed over (base version, or the same value)', async () => {
    const item = await createWorkItem(db, userId, { title: 'Draft the SOW' });
    await withChangeSet({ db, userId, actor: 'user', reason: 'rename' }, (_tx, cs) => cs.updateVersioned(workItems, item.id, item.version, { title: 'Draft the SOW v1' }));
    const { result: r } = await withChangeSet({ db, userId, actor: 'engine', reason: 'new info' }, (tx) => engineUpdate(tx, workItems, item.id, { title: 'Draft the SOW + pricing' }));
    const pid = r.proposals[0]!.proposalId;
    expect(await proposalStillCurrent(db, pid)).toBe(true);
    // another field moved the row on: the title is still the one it was proposed over, so it still applies
    const v = item.version + 1; // the rename; the engine pass only proposed (the title is yours)
    await withChangeSet({ db, userId, actor: 'user', reason: 'purpose' }, (_tx, cs) => cs.updateVersioned(workItems, item.id, v, { purpose: 'For: CUSTOMER_1' }));
    expect(await proposalStillCurrent(db, pid)).toBe(true);
    // the title itself changed since: the old proposal would overwrite newer data
    await withChangeSet({ db, userId, actor: 'user', reason: 'rename again' }, (_tx, cs) => cs.updateVersioned(workItems, item.id, v + 1, { title: 'Draft the SOW v2' }));
    expect(await proposalStillCurrent(db, pid)).toBe(false);
  });

  it('undoing the engine pass that superseded a proposal brings the older one back as pending', async () => {
    const item = await createWorkItem(db, userId, { title: 'Book travel' });
    await withChangeSet({ db, userId, actor: 'user', reason: 'rename' }, (_tx, cs) =>
      cs.updateVersioned(workItems, item.id, item.version, { title: 'Book travel to NYC' }),
    );
    const first = await withChangeSet({ db, userId, actor: 'engine', reason: 'info 1' }, (tx) =>
      engineUpdate(tx, workItems, item.id, { title: 'Book travel to NYC + hotel' }),
    );
    const second = await withChangeSet({ db, userId, actor: 'engine', reason: 'info 2' }, (tx) =>
      engineUpdate(tx, workItems, item.id, { title: 'Book travel to Boston' }),
    );
    expect(second.result.proposals).toHaveLength(1);
    await undoChangeSet(second.changeSetId, { db });
    const rows = await db.select().from(changeProposals).where(eq(changeProposals.entityId, item.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.result.proposals[0]!.proposalId, status: 'pending', supersededById: null });
  });

  it('identical values make no proposal; lockAll freezes the whole row for engines', async () => {
    const item = await createWorkItem(db, userId, { title: 'Frozen' });
    const { result } = await withChangeSet({ db, userId, actor: 'engine', reason: 'freeze check' }, (tx) =>
      engineUpdate(tx, workItems, item.id, { title: 'Frozen', importance: 'high' }, { lockAll: true }),
    );
    expect(result.applied).toEqual([]);
    expect(result.proposals.map((p) => p.field)).toEqual(['importance']);
    expect(result.row.version).toBe(item.version);
  });
});

describe('autosave bursts', () => {
  it('reuses one change set per (editor session, entity) until closed', async () => {
    const item = await createWorkItem(db, userId, { description: '' });
    const opts = {
      db,
      userId,
      actor: 'user' as const,
      kind: 'autosave_burst' as const,
      reason: 'Edited description',
      editorSessionId: 'tab-1',
      entity: { type: 'work_items', id: item.id },
    };
    const a = await withChangeSet(opts, (tx) => tx.update(workItems).set({ description: 'h' }).where(eq(workItems.id, item.id)));
    const b = await withChangeSet(opts, (tx) => tx.update(workItems).set({ description: 'hello' }).where(eq(workItems.id, item.id)));
    expect(b.changeSetId).toBe(a.changeSetId);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.changeSetId, a.changeSetId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ coalescedCount: 2, before: { description: '' }, after: { description: 'hello' } });

    await db.execute(sql`update change_sets set coalesce_until = now() - interval '1 minute' where id = ${a.changeSetId}`);
    expect(await closeIdleBursts(db)).toContain(a.changeSetId);
    const c = await withChangeSet(opts, (tx) => tx.update(workItems).set({ description: 'hello!' }).where(eq(workItems.id, item.id)));
    expect(c.changeSetId).not.toBe(a.changeSetId);
  });
});
