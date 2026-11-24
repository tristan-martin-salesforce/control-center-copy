/** R-UI-22: resolution, involvement, hand-off and the looped_back_in reopen. */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, engineUpdate, undoChangeSet, withChangeSet, type ChangeSetContext } from '../../../src/db/changeset';
import { ConstraintViolationError } from '../../../src/db/errors';
import { people, reopenDecisions, workItems, workItemTransitions } from '../../../src/db/schema';
import { createUser, createWorkItem, openTestDb, rowImage } from './helpers';

const h = openTestDb();
const db = h.db;
let userId: string;
let teammate: string;

beforeAll(async () => {
  userId = await createUser(db, 'handoff');
  const { result } = await withChangeSet({ db, userId, actor: 'system', reason: 'seed person' }, (tx) =>
    tx.insert(people).values({ ownerUserId: userId, displayName: 'Teammate Placeholder' }).returning({ id: people.id }),
  );
  teammate = result[0]!.id;
});
afterAll(() => h.close());

const handOff = {
  status: 'done' as const,
  doneAt: new Date(),
  doneBy: 'engine' as const,
  resolution: 'handed_off' as const,
  resolutionPersonId: '',
  ownerPersonId: '',
  involvement: 'watcher' as const,
};

/** done (handed_off) -> open on a direct ask of me, recorded as a reopen decision (looped_back_in). */
async function loopBackIn(cs: ChangeSetContext, itemId: string) {
  const res = await cs.update(workItems, itemId, {
    status: 'open',
    doneAt: null,
    doneBy: null,
    resolution: null,
    involvement: 'contributor',
    reopenedCount: 1,
    lastReopenedAt: new Date(),
  });
  const [t] = await cs.tx
    .insert(workItemTransitions)
    .values({ workItemId: itemId, fromStatus: 'done', toStatus: 'open', actorKind: cs.actor.kind, reason: 'looped_back_in', changeSetId: cs.id })
    .returning({ id: workItemTransitions.id });
  await cs.tx.insert(reopenDecisions).values({
    ownerUserId: cs.userId,
    doneWorkItemId: itemId,
    triggerPersonId: teammate,
    outcome: 'reopened',
    ruleKey: 'looped_back_in',
    explanation: 'Reopened: your teammate asked you directly',
    transitionId: t!.id,
    decidedBy: cs.actor.kind,
    changeSetId: cs.id,
  });
  return res;
}

describe('work item resolution (R-UI-22)', () => {
  it('an inferred hand-off closes the item; a direct ask loops me back in; undo restores the hand-off', async () => {
    const item = await createWorkItem(db, userId, { title: 'Answer ACME security questionnaire' });
    await withChangeSet({ db, userId, actor: actors.engine('closure@1'), reason: 'Teammate took it (Slack)' }, (tx) =>
      engineUpdate(tx, workItems, item.id, { ...handOff, resolutionPersonId: teammate, ownerPersonId: teammate, resolutionInferred: true }),
    );
    const handedOff = await rowImage(db, 'work_items', item.id);
    expect(handedOff).toMatchObject({ status: 'done', resolution: 'handed_off', involvement: 'watcher', owner_person_id: teammate });

    const loop = await withChangeSet({ db, userId, actor: actors.engine('reopen@1'), reason: 'Looped back in' }, (_tx, cs) =>
      loopBackIn(cs, item.id),
    );
    expect(loop.result.proposals).toEqual([]);
    expect(await rowImage(db, 'work_items', item.id)).toMatchObject({ status: 'open', resolution: null, involvement: 'contributor' });
    const [d] = await db.select().from(reopenDecisions).where(eq(reopenDecisions.doneWorkItemId, item.id));
    expect(d).toMatchObject({ ruleKey: 'looped_back_in', triggerPersonId: teammate, outcome: 'reopened' });

    await undoChangeSet(loop.changeSetId, { db });
    expect(await rowImage(db, 'work_items', item.id)).toEqual(handedOff);
    const [d2] = await db.select().from(reopenDecisions).where(eq(reopenDecisions.id, d!.id));
    expect(d2!.undoneAt).not.toBeNull();
    const [t2] = await db.select().from(workItemTransitions).where(eq(workItemTransitions.id, d!.transitionId!));
    expect(t2!.undoneAt).not.toBeNull();
  });

  it('after a user hand-off, the engine loop-back of those locked fields becomes proposals', async () => {
    const item = await createWorkItem(db, userId, { title: 'Review partner SOW' });
    await withChangeSet({ db, userId, actor: 'user', reason: 'Handed off' }, (_tx, cs) =>
      cs.updateVersioned(workItems, item.id, item.version, { ...handOff, doneBy: 'user', resolutionPersonId: teammate, ownerPersonId: teammate }),
    );
    const loop = await withChangeSet({ db, userId, actor: actors.engine('reopen@1'), reason: 'Looped back in' }, (_tx, cs) =>
      cs.update(workItems, item.id, { status: 'open', doneAt: null, doneBy: null, resolution: null, involvement: 'contributor' }),
    );
    expect(loop.result.applied).toEqual([]);
    const pending = await db.execute<{ field: string }>(
      sql`select field from change_proposals where entity_id = ${item.id} and status = 'pending' order by field`,
    );
    expect(pending.rows.map((r) => r.field)).toEqual(['done_at', 'done_by', 'involvement', 'resolution', 'status']);
    expect((await rowImage(db, 'work_items', item.id))!.status).toBe('done');
  });

  it('the database rejects a resolution on a live item and a hand-off where I stay owner', async () => {
    const item = await createWorkItem(db, userId);
    const live = await withChangeSet({ db, userId, actor: 'user', reason: 'bad' }, (_tx, cs) =>
      cs.updateVersioned(workItems, item.id, item.version, { resolution: 'not_needed' }),
    ).catch((e: unknown) => e);
    expect(live).toBeInstanceOf(ConstraintViolationError);
    expect(live).toMatchObject({ constraint: 'work_items_resolution_chk' });

    const owner = await withChangeSet({ db, userId, actor: 'user', reason: 'bad' }, (_tx, cs) =>
      cs.updateVersioned(workItems, item.id, item.version, { ...handOff, resolutionPersonId: teammate, ownerPersonId: teammate, involvement: 'owner' }),
    ).catch((e: unknown) => e);
    expect(owner).toBeInstanceOf(ConstraintViolationError);
    expect(owner).toMatchObject({ constraint: 'work_items_handoff_chk' });
  });
});
