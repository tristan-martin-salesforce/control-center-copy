/**
 * BE-REEVAL: the `reevaluate` job on the real path (scanner-style evidence → W2 → worker → closure machine →
 * one engine:reeval change set → live events → Undo), against Postgres with the example seed loaded.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LiveEvent } from '@/contract';
import { onChangeSetCommitted, type CommittedChangeSet } from '@/db/changeset';
import { enqueueJob } from '@/db/queue';
import { requestCancel } from '@/jobs';
import { DbDataSource } from '@/server/datasource/db';
import { reevaluateWorkItem } from '@/server/datasource/db/closure';
import { installChangeSetPublisher, PgEventBus, TABLE_TOPICS } from '@/server/events';

import { drain, linkEvidence, loadExampleSeed, makeItem, makePerson, openTestDb, reevalWorker, rows, snapshot, TEST_URL, waitFor } from './helpers';

const h = openTestDb(10);
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
beforeEach(async () => {
  // every test starts from an empty queue
  await db.execute(sql`update jobs set status = 'cancelled', finished_at = now(), lease_expires_at = null where status in ('queued', 'running')`);
});

const item = async (id: string) =>
  (
    await rows<{
      status: string;
      done_at: string | null;
      done_by: string | null;
      resolution: string | null;
      resolution_inferred: boolean;
      resolution_evidence_id: string | null;
      involvement: string;
      owner_person_id: string | null;
      likely_done_at: string | null;
      reopened_count: number;
      version: number;
    }>(db, sql`select status, done_at, done_by, resolution, resolution_inferred, resolution_evidence_id, involvement, owner_person_id, likely_done_at, reopened_count, version from work_items where id = ${id}`)
  )[0]!;
const job = async (id: number) =>
  (await rows<{ status: string; cancel_reason: string | null; result: Record<string, unknown> | null; generation: string | null }>(db, sql`select status, cancel_reason, result, generation from jobs where id = ${id}`))[0]!;
const reevalChangeSets = (itemId: string) =>
  rows<{ id: string; actor_kind: string; actor_ref: string; kind: string; undoable: boolean; summary: string; undone_at: string | null }>(
    db,
    sql`select id, actor_kind, actor_ref, kind, undoable, summary, undone_at from change_sets where actor_ref = 'reeval' and entity_id = ${itemId} order by created_at`,
  );
const transitions = (itemId: string) =>
  rows<{ from_status: string | null; to_status: string; actor_kind: string; actor_ref: string; evidence_id: string | null; change_set_id: string; undone_at: string | null }>(
    db,
    sql`select from_status, to_status, actor_kind, actor_ref, evidence_id, change_set_id, undone_at from work_item_transitions where work_item_id = ${itemId} order by id`,
  );
const nbaJobs = (itemId: string) => rows<{ id: string; status: string; payload: Record<string, unknown> }>(db, sql`select id, status, payload from jobs where kind = 'nba.generate' and payload ->> 'work_item_id' = ${itemId}`);

const SAID_DONE = { role: 'completion' as const, confidence: 0.95, reason: 'said done in Slack: sent the deck in the thread', fromMe: true };

describe('completion signals', () => {
  it('"said done in Slack" (Sure) → closed by engine:reeval, audited, live event, NBA follow-up; Undo restores it and it stays undone', async () => {
    const web = new PgEventBus({ url: TEST_URL, log: () => {} });
    const pub = new PgEventBus({ url: TEST_URL, log: () => {} });
    await Promise.all([web.start(), pub.start()]);
    const uninstall = installChangeSetPublisher({ bus: pub, db });
    const live: LiveEvent[] = [];
    const off = web.subscribe((e) => live.push(e));
    const committed: CommittedChangeSet[] = [];
    const offCommit = onChangeSetCommitted((cs) => committed.push(cs));
    const w = reevalWorker(db, userId);
    try {
      const id = await makeItem(db, userId, { title: 'Send PLACEHOLDER_ACCOUNT the pilot deck' });
      const ev = await linkEvidence(db, userId, id, SAID_DONE);
      const before = await ds.getItem({ params: { id } } as never); // saved first (W2), not yet re-evaluated
      expect(before.item).toMatchObject({ state: 'open', reevaluating: true }); // the queued W2 job lights the flag
      await drain(w);

      const j = await job(ev.jobId!);
      expect(j.status).toBe('succeeded');
      expect(j.result).toMatchObject({ outcome: 'written', transitions: 1, newEvidence: 1, decisions: [{ evidenceId: ev.evidenceId, kind: 'transition', to: 'done' }] });
      expect((j.result!.reeval as { evidenceIds: string[] }).evidenceIds).toContain(ev.evidenceId);

      expect(await item(id)).toMatchObject({ status: 'done', done_by: 'engine', resolution: 'done_by_me', resolution_inferred: true, resolution_evidence_id: ev.evidenceId });
      const [cs, ...more] = await reevalChangeSets(id);
      expect(more).toHaveLength(0);
      expect(cs).toMatchObject({ actor_kind: 'engine', actor_ref: 'reeval', kind: 'engine_pass', undoable: true, undone_at: null });
      expect(cs!.summary).toMatch(/^Done by you: said done in Slack/);
      expect(j.result!.changeSetId).toBe(cs!.id);
      const audit = await rows<{ table_name: string; op: string }>(db, sql`select table_name, op from audit_events where change_set_id = ${cs!.id}`);
      expect(audit).toContainEqual({ table_name: 'work_items', op: 'update' });
      expect(await transitions(id)).toEqual([{ from_status: 'open', to_status: 'done', actor_kind: 'engine', actor_ref: 'reeval', evidence_id: ev.evidenceId, change_set_id: cs!.id, undone_at: null }]);
      // the UI reads it as "Closed for you" with the inferred resolution
      const after = (await ds.getItem({ params: { id } } as never)).item;
      expect(after).toMatchObject({ state: 'done', doneBy: 'engine', resolution: 'done_by_me', resolutionDetail: { inferred: true } });
      // follow-up: the NBA is retired (the stub runs it later)
      const nba = await nbaJobs(id);
      expect(nba).toHaveLength(1);
      expect(nba[0]!.payload).toMatchObject({ trigger: 'reeval', mode: 'retire', change_set_id: cs!.id });
      // live events: the commit hook published the change set (item topics + audit)
      expect(committed.some((c) => c.id === cs!.id && c.actor.kind === 'engine' && c.actor.ref === 'reeval')).toBe(true);
      // a work item's topics: the one table → topic map's (2026-11-13 audit C1), the same the web's bus publishes
      const itemTopics = TABLE_TOPICS.work_items!.topics;
      const got = await waitFor(() => live.filter((e) => e.ids.includes(id)).length >= itemTopics.length && live.filter((e) => e.ids.includes(id)));
      expect(new Set(got.map((e) => e.topic))).toEqual(new Set(itemTopics));
      await waitFor(() => live.some((e) => e.topic === 'audit' && e.ids.includes(cs!.id)));

      // Undo (the "Closed for you · Undo" path): the item is exactly as before and the transition is stamped undone
      await ds.undoAudit({ params: { id: cs!.id }, body: {} } as never);
      const back = (await ds.getItem({ params: { id } } as never)).item;
      // version / updatedAt are bookkeeping; reevaluating follows the live queue (the job ran since `before`)
      const strip = (x: typeof back) => ({ ...x, version: 0, updatedAt: '', reevaluating: false });
      expect(back.reevaluating).toBe(false);
      expect(strip(back)).toEqual(strip(before.item));
      expect((await transitions(id))[0]!.undone_at).not.toBeNull();

      // new info later: the undone completion is not re-applied (the watermark lives outside the change set)
      const ev2 = await linkEvidence(db, userId, id, { role: 'origin', confidence: 0.75, reason: 'PERSON_A followed up in the thread' });
      await drain(w);
      expect((await job(ev2.jobId!)).result).toMatchObject({ outcome: 'evaluated', newEvidence: 1, decisions: [{ evidenceId: ev2.evidenceId, kind: 'none' }] });
      expect((await item(id)).status).toBe('open');
    } finally {
      await w.stop();
      off();
      offCommit();
      uninstall();
      await Promise.all([web.stop(), pub.stop()]);
    }
  });

  it('a likely completion is a "Likely done · Confirm", not a close', async () => {
    const w = reevalWorker(db, userId);
    try {
      const id = await makeItem(db, userId);
      const ev = await linkEvidence(db, userId, id, { role: 'completion', confidence: 0.75, reason: 'you shared a deck link in the thread', fromMe: true });
      await drain(w);
      const it = await item(id);
      expect(it).toMatchObject({ status: 'likely_done', done_at: null, done_by: null, resolution: null });
      expect(it.likely_done_at).not.toBeNull();
      const rec = (await ds.getItem({ params: { id } } as never)).item;
      expect(rec.state).toBe('likely_done');
      expect(rec.likelyDone).toMatchObject({ reason: 'you shared a deck link in the thread', evidenceId: ev.evidenceId });
      expect((await transitions(id)).map((t) => t.to_status)).toEqual(['likely_done']);
      expect((await nbaJobs(id))[0]!.payload).toMatchObject({ mode: 'regenerate' });
    } finally {
      await w.stop();
    }
  });

  it('progress only moves an open item to in progress; several new links are decided in order in one change set', async () => {
    const w = reevalWorker(db, userId);
    try {
      const id = await makeItem(db, userId);
      await linkEvidence(db, userId, id, { role: 'progress', confidence: 0.75, reason: 'you said "on it"', fromMe: true });
      await linkEvidence(db, userId, id, SAID_DONE); // coalesces into the same queued job
      await drain(w);
      expect((await item(id)).status).toBe('done');
      const ts = await transitions(id);
      expect(ts.map((t) => `${t.from_status}→${t.to_status}`)).toEqual(['open→in_progress', 'in_progress→done']);
      expect(new Set(ts.map((t) => t.change_set_id)).size).toBe(1);
      expect(await reevalChangeSets(id)).toHaveLength(1);
    } finally {
      await w.stop();
    }
  });
});

describe('requirements change after done (R-UI-20)', () => {
  const REQ = { role: 'contradiction' as const, confidence: 0.75, reason: 'requirements_change: add a data-residency slide' };

  it('within 14 days the item reopens ("Reopened: new requirement from …")', async () => {
    const w = reevalWorker(db, userId);
    try {
      const sam = await makePerson(db, userId, 'PERSON_SAM');
      const id = await makeItem(db, userId, { status: 'done', doneDaysAgo: 3 });
      const ev = await linkEvidence(db, userId, id, { ...REQ, actorPersonId: sam });
      await drain(w);
      expect(await item(id)).toMatchObject({ status: 'open', done_at: null, resolution: null, reopened_count: 1 });
      const rec = (await ds.getItem({ params: { id } } as never)).item;
      expect(rec.state).toBe('reopened');
      expect(rec.reopened?.reason).toMatch(/^Reopened: new requirement from PERSON_SAM/);
      const [rd] = await rows<{ outcome: string; rule_key: string; transition_id: string | null; trigger_evidence_id: string; trigger_person_id: string | null; decided_by: string }>(
        db,
        sql`select outcome, rule_key, transition_id, trigger_evidence_id, trigger_person_id, decided_by from reopen_decisions where done_work_item_id = ${id}`,
      );
      expect(rd).toMatchObject({ outcome: 'reopened', rule_key: 'same_deliverable_recent', trigger_evidence_id: ev.evidenceId, trigger_person_id: sam, decided_by: 'engine' });
      expect(rd!.transition_id).not.toBeNull();
      expect((await nbaJobs(id))[0]!.payload).toMatchObject({ mode: 'regenerate' });
    } finally {
      await w.stop();
    }
  });

  it('after 14 days a sibling opens under the same initiative and the original stays done', async () => {
    const w = reevalWorker(db, userId);
    try {
      const [ini] = await rows<{ id: string }>(db, sql`select id from initiatives where owner_user_id = ${userId} limit 1`);
      const id = await makeItem(db, userId, { status: 'done', doneDaysAgo: 20, initiativeId: ini!.id });
      const ev = await linkEvidence(db, userId, id, REQ);
      const before = await snapshot(db, userId); // new info saved (W2), not yet re-evaluated
      await drain(w);
      expect((await item(id)).status).toBe('done');
      const res = (await job(ev.jobId!)).result!;
      expect(res).toMatchObject({ outcome: 'written', transitions: 0, decisions: [{ evidenceId: ev.evidenceId, kind: 'sibling', ruleKey: 'outside_window' }] });
      const [sibId] = res.siblingIds as string[];
      const sib = (await ds.getItem({ params: { id: sibId! } } as never)).item;
      expect(sib).toMatchObject({ state: 'open', title: 'Add a data-residency slide', initiativeId: ini!.id, involvement: 'owner', why: 'New task: new requirement from someone' });
      expect(sib.whyDetail).toMatch(/original closed 20d ago/);
      expect((await transitions(sib.id)).map((t) => [t.from_status, t.to_status, t.evidence_id])).toEqual([[null, 'open', ev.evidenceId]]);
      const [rel] = await rows<{ kind: string; created_by: string }>(db, sql`select kind, created_by from work_item_relations where from_work_item_id = ${sib.id} and to_work_item_id = ${id}`);
      expect(rel).toEqual({ kind: 'follow_up_of', created_by: 'engine' });
      const sibEv = await rows<{ role: string; source_item_id: string }>(db, sql`select role, source_item_id from work_item_evidence where work_item_id = ${sib.id}`);
      expect(sibEv).toEqual([{ role: 'origin', source_item_id: ev.sourceItemId }]);
      expect((await nbaJobs(sib.id))[0]!.payload).toMatchObject({ mode: 'regenerate' });
      expect(await nbaJobs(id)).toHaveLength(0); // the done original did not move
      const [cs] = await reevalChangeSets(id);
      expect(cs!.undoable).toBe(true);
      // the decision row (R-UI-20), written in the same change set
      const [rd] = await rows<{ outcome: string; rule_key: string; new_work_item_id: string; trigger_evidence_id: string; transition_id: string | null; change_set_id: string; explanation: string }>(
        db,
        sql`select outcome, rule_key, new_work_item_id, trigger_evidence_id, transition_id, change_set_id, explanation from reopen_decisions where done_work_item_id = ${id}`,
      );
      expect(rd).toMatchObject({ outcome: 'new_sibling', rule_key: 'outside_window', new_work_item_id: sib.id, trigger_evidence_id: ev.evidenceId, transition_id: null, change_set_id: cs!.id });
      expect(rd!.explanation).toMatch(/original closed 20d ago/);

      // Undo ("New task: … · Undo"): no "not restorable"; every row is back to the state before the decision.
      // The sibling's delete cascades to its decision row (0007), so nothing is left for the undo to stamp.
      const undo = await ds.undoAudit({ params: { id: cs!.id }, body: {} } as never);
      expect(await snapshot(db, userId)).toEqual(before);
      expect(await rows(db, sql`select 1 from reopen_decisions where change_set_id = ${cs!.id}`)).toHaveLength(0);
      expect((await reevalChangeSets(id))[0]!.undone_at).not.toBeNull();

      // Redo (undo the undo) brings the sibling, its evidence and relation back. The unaudited decision row and
      // creation transition went with the sibling and stay gone (like the 0006 scores).
      await ds.undoAudit({ params: { id: undo.auditId! }, body: {} } as never);
      expect((await ds.getItem({ params: { id: sib.id } } as never)).item).toMatchObject({ state: 'open', title: 'Add a data-residency slide' });
      expect(await rows(db, sql`select 1 from work_item_relations where from_work_item_id = ${sib.id} and to_work_item_id = ${id}`)).toHaveLength(1);
      expect(await rows(db, sql`select 1 from reopen_decisions where change_set_id = ${cs!.id}`)).toHaveLength(0);
    } finally {
      await w.stop();
    }
  });
});

describe('hand-offs and loop-back (R-UI-22)', () => {
  it('new info on a handed-off item is context only; a direct ask loops me back in (reopen, owner again)', async () => {
    const w = reevalWorker(db, userId);
    try {
      const kim = await makePerson(db, userId, 'PERSON_KIM');
      const dana = await makePerson(db, userId, 'PERSON_DANA');
      const id = await makeItem(db, userId, { status: 'done', doneDaysAgo: 2, resolution: 'handed_off', resolutionPersonId: kim, ownerPersonId: kim, involvement: 'watcher' });
      const ctx = await linkEvidence(db, userId, id, { role: 'completion', confidence: 0.95, reason: 'PERSON_KIM said it shipped', actorPersonId: kim });
      await drain(w);
      expect((await job(ctx.jobId!)).result).toMatchObject({ outcome: 'evaluated', changeSetId: null, decisions: [{ kind: 'none' }] });
      expect(await reevalChangeSets(id)).toHaveLength(0);

      const ask = await linkEvidence(db, userId, id, { role: 'origin', confidence: 0.95, reason: 'loop_back: PERSON_DANA asked you directly in a DM', actorPersonId: dana });
      await drain(w);
      expect(await item(id)).toMatchObject({ status: 'open', involvement: 'owner', owner_person_id: null, resolution: null });
      const rec = (await ds.getItem({ params: { id } } as never)).item;
      expect(rec.state).toBe('reopened');
      expect(rec.loopedBackIn).toMatchObject({ byPersonName: 'PERSON_DANA', evidenceId: ask.evidenceId });
      expect(rec.reopened?.reason).toMatch(/^Looped back in: PERSON_DANA asked you directly/);
      const [rd] = await rows<{ rule_key: string; trigger_person_id: string }>(db, sql`select rule_key, trigger_person_id from reopen_decisions where done_work_item_id = ${id}`);
      expect(rd).toEqual({ rule_key: 'loop_back_recent', trigger_person_id: dana });
    } finally {
      await w.stop();
    }
  });
});

describe('user locks (R-UI-20)', () => {
  it('a user-locked status turns the close into one pending proposal group; Apply closes it with the resolution', async () => {
    const w = reevalWorker(db, userId);
    try {
      const id = await makeItem(db, userId, { locked: ['status'] });
      const v0 = (await item(id)).version;
      const ev = await linkEvidence(db, userId, id, SAID_DONE);
      await drain(w);
      expect(await item(id)).toMatchObject({ status: 'open', done_at: null, version: v0 });
      const res = (await job(ev.jobId!)).result!;
      expect(res).toMatchObject({ outcome: 'written', transitions: 0 });
      const [groupId] = res.proposalIds as string[];
      const props = await rows<{ field: string; current_value: unknown; proposed_value: unknown; status: string; evidence_id: string; reason: string }>(
        db,
        sql`select field, current_value, proposed_value, status, evidence_id, reason from change_proposals where group_id = ${groupId!}`,
      );
      expect(props.find((p) => p.field === 'status')).toMatchObject({ current_value: 'open', proposed_value: 'done', status: 'pending', evidence_id: ev.evidenceId });
      expect(props.map((p) => p.field)).toEqual(expect.arrayContaining(['status', 'done_at', 'done_by', 'resolution']));
      expect(await transitions(id)).toHaveLength(0);
      const p = (await ds.model()).get('proposals', groupId!)!;
      expect(p.changes.find((c) => c.field === 'state')).toMatchObject({ before: 'open', after: 'done' });
      await ds.applyProposal({ params: { id: groupId! }, body: {} } as never);
      expect(await item(id)).toMatchObject({ status: 'done', resolution: 'done_by_me' });
    } finally {
      await w.stop();
    }
  });
});

describe('generation fence and cancel (R-UI-20, W2/W3)', () => {
  it('a job for a stale generation is cancelled without running; the newer one does the work', async () => {
    const w = reevalWorker(db, userId);
    try {
      const id = await makeItem(db, userId);
      const a = await linkEvidence(db, userId, id, { role: 'origin', confidence: 0.75, reason: 'PERSON_A asked about the deck' });
      const b = await linkEvidence(db, userId, id, SAID_DONE);
      expect(b.generation).toBe(a.generation! + 1);
      // a stale twin (enqueued for generation a) next to the queued job for generation b
      await db.execute(sql`update jobs set status = 'cancelled' where id = ${b.jobId}`);
      const stale = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: id }, generation: a.generation! });
      await drain(w);
      expect(await job(stale.id)).toMatchObject({ status: 'cancelled', cancel_reason: `superseded by generation ${b.generation}`, result: null });
      expect((await item(id)).status).toBe('open');
      expect(await reevalChangeSets(id)).toHaveLength(0);

      const fresh = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: id }, generation: b.generation! });
      await drain(w);
      expect((await job(fresh.id)).status).toBe('succeeded');
      expect((await item(id)).status).toBe('done');
    } finally {
      await w.stop();
    }
  });

  it('inside the run, a generation that moved on writes nothing (W3)', async () => {
    const id = await makeItem(db, userId);
    const a = await linkEvidence(db, userId, id, SAID_DONE);
    await linkEvidence(db, userId, id, { role: 'origin', confidence: 0.75, reason: 'PERSON_A replied' });
    const out = await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: a.jobId, generation: a.generation } });
    expect(out).toMatchObject({ outcome: 'stale', current: a.generation! + 1 });
    expect((await item(id)).status).toBe('open');
    expect(await reevalChangeSets(id)).toHaveLength(0);
  });

  it('cancel_requested_at mid-run rolls the whole pass back: no transition, no change set, no follow-up', async () => {
    let cancelled = false;
    const w = reevalWorker(db, userId, {
      onStep: async () => {
        if (cancelled) return;
        cancelled = true;
        // the user (or W2) asks to cancel while the first transition is already written in the transaction
        const [r] = await rows<{ id: string }>(db, sql`select id from jobs where kind = 'reevaluate' and status = 'running' limit 1`);
        await requestCancel(db, r!.id, 'test: cancel mid-run');
      },
    });
    try {
      const id = await makeItem(db, userId);
      await linkEvidence(db, userId, id, { role: 'progress', confidence: 0.75, reason: 'you said "on it"', fromMe: true });
      const ev = await linkEvidence(db, userId, id, SAID_DONE); // one queued job for both links
      await w.start(); // LISTEN cc_job_cancel, then claim
      const j = await waitFor(async () => {
        const x = await job(ev.jobId!);
        return x.status !== 'queued' && x.status !== 'running' && x;
      }, 30_000);
      expect(cancelled).toBe(true);
      expect(j.status).toBe('cancelled');
      expect(j.cancel_reason).toBe('test: cancel mid-run');
      expect(j.result).toBeNull();
      expect(await item(id)).toMatchObject({ status: 'open', done_at: null });
      expect(await transitions(id)).toHaveLength(0);
      expect(await reevalChangeSets(id)).toHaveLength(0);
      expect(await nbaJobs(id)).toHaveLength(0);
      // nothing was marked evaluated: the next run decides both links
      await w.stop();
      const again = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: id }, generation: ev.generation! });
      await drain(reevalWorker(db, userId, {}, false));
      expect((await job(again.id)).result).toMatchObject({ outcome: 'written', newEvidence: 2, transitions: 2 });
    } finally {
      await w.stop();
    }
  });

  it('an abort (timeout, shutdown) between writes rolls back too', async () => {
    const id = await makeItem(db, userId);
    await linkEvidence(db, userId, id, { role: 'progress', confidence: 0.75, reason: 'you said "on it"', fromMe: true });
    const ev = await linkEvidence(db, userId, id, SAID_DONE);
    const ac = new AbortController();
    const out = await reevaluateWorkItem({ db, userId, workItemId: id, job: { id: ev.jobId, generation: ev.generation }, signal: ac.signal, onStep: () => ac.abort() });
    expect(out).toMatchObject({ outcome: 'cancelled', reason: 'aborted mid-run' });
    expect((await item(id)).status).toBe('open');
    expect(await transitions(id)).toHaveLength(0);
    expect((await job(ev.jobId!)).result).toBeNull();
  });

  it('new info while a pass commits: the newer job runs next and decides only the newer evidence', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const w = reevalWorker(db, userId, {
      onStep: async () => {
        if (!first) return;
        first = false;
        await gate;
      },
    });
    try {
      const id = await makeItem(db, userId);
      const a = await linkEvidence(db, userId, id, { role: 'progress', confidence: 0.75, reason: 'you said "on it"', fromMe: true });
      void w.pollOnce();
      await waitFor(async () => (await job(a.jobId!)).status === 'running' && !first);
      const later = linkEvidence(db, userId, id, SAID_DONE); // W2 waits for the running pass's row lock
      await new Promise((r) => setTimeout(r, 300));
      release();
      const b = await later;
      expect(b.generation).toBe(a.generation! + 1);
      await w.idle();
      await drain(w);
      expect((await item(id)).status).toBe('done');
      const rb = (await job(b.jobId!)).result!;
      expect(rb).toMatchObject({ outcome: 'written', newEvidence: 1, decisions: [{ evidenceId: b.evidenceId, to: 'done' }] });
      expect((await transitions(id)).map((t) => t.to_status)).toEqual(['in_progress', 'done']);
    } finally {
      release();
      await w.stop();
    }
  });
});

describe('sibling undo through DbDataSource.applyClosureSignal (0007)', () => {
  it('a sibling decision is undone exactly (no "not restorable")', async () => {
    const id = await makeItem(db, userId, { status: 'done', doneDaysAgo: 30 });
    const ev = await linkEvidence(db, userId, id, { role: 'contradiction', confidence: 0.75, reason: 'requirements_change: add a security review slide', noBump: true });
    const before = await snapshot(db, userId);
    const r = await ds.applyClosureSignal(id, { type: 'requirements_change', confidence: 'likely', evidenceId: ev.evidenceId, at: new Date().toISOString(), summary: 'Add a security review slide' });
    expect(r.decision.kind).toBe('sibling');
    expect(r.siblingId).not.toBeNull();
    const [rd] = await rows<{ outcome: string; new_work_item_id: string; change_set_id: string }>(db, sql`select outcome, new_work_item_id, change_set_id from reopen_decisions where done_work_item_id = ${id}`);
    expect(rd).toEqual({ outcome: 'new_sibling', new_work_item_id: r.siblingId, change_set_id: r.auditId });
    await ds.undoAudit({ params: { id: r.auditId! }, body: {} } as never);
    expect(await snapshot(db, userId)).toEqual(before);
  });
});

describe('Settle "waiting on them" (settleApply wait)', () => {
  it('moves a live item to waiting on others with the reason and when I asked; Undo puts it back', async () => {
    const id = await makeItem(db, userId);
    const since = '2026-11-05T17:00:00.000Z';
    const out = await ds.settleApply([{ itemId: id, expectedState: 'open', action: 'wait', reasonClass: null, reason: 'You asked PERSON_A which payers are affected; no answer yet', verdict: 'waiting_on_them', confidence: 0.75, check: 'settle-item@test', cite: { at: since, fromMe: true } }]);
    expect(out.applied).toEqual({ wait: 1 });
    const it1 = (await ds.getItem({ params: { id } } as never)).item;
    expect(it1).toMatchObject({ state: 'waiting_on_others', waiting: { on: 'others', reason: expect.stringMatching(/which payers/), since } });
    await ds.undoAudit({ params: { id: out.auditIds[id]! }, body: {} } as never);
    expect((await ds.getItem({ params: { id } } as never)).item).toMatchObject({ state: 'open', waiting: null });
  });
});

describe('the "re-evaluating" flag (store/work.ts)', () => {
  const flag = async (id: string) => (await ds.getItem({ params: { id } } as never)).item.reevaluating;
  const later = new Date(Date.now() + 3_600_000);

  it('lights for a queued or running re-eval (work_item_id) and enrich (workItemId) job, not for fixture payloads', async () => {
    const id = await makeItem(db, userId);
    expect(await flag(id)).toBe(false);
    const re = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: id }, runAt: later });
    expect(await flag(id)).toBe(true);
    await db.execute(sql`update jobs set status = 'running', locked_by = 'test', lease_expires_at = now() + interval '1 minute' where id = ${re.id}`);
    expect(await flag(id)).toBe(true);
    await db.execute(sql`update jobs set status = 'succeeded', lease_expires_at = null where id = ${re.id}`);
    expect(await flag(id)).toBe(false);

    const en = await enqueueJob(db, { ownerUserId: userId, kind: 'enrich', payload: { workItemId: id, text: 'PLACEHOLDER' }, runAt: later });
    expect(await flag(id)).toBe(true);
    await db.execute(sql`update jobs set status = 'cancelled' where id = ${en.id}`);
    expect(await flag(id)).toBe(false);

    // seeded contract-shape rows ({entity}) are display fixtures: they never light it (mock ↔ db read parity)
    await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { entity: { id, type: 'work_item', label: 'x' } }, runAt: later });
    expect(await flag(id)).toBe(false);
  });

  it('a write while a job waits does not keep it lit after the job ran (it is never stored on the item)', async () => {
    const id = await makeItem(db, userId);
    const re = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: id }, runAt: later });
    expect(await flag(id)).toBe(true);
    // Any engine or user write in between reads the item with the flag on and saves it back (Settle did, 54 at once).
    await ds.patchItem({ params: { id }, body: { patch: { purpose: 'PLACEHOLDER purpose' } } } as never);
    await db.execute(sql`update jobs set status = 'succeeded' where id = ${re.id}`);
    expect(await flag(id)).toBe(false);
  });

  it('lights while the scanner\'s W2 job waits, and clears once the worker ran it', async () => {
    const w = reevalWorker(db, userId, {}, false);
    try {
      const id = await makeItem(db, userId);
      await linkEvidence(db, userId, id, { role: 'origin', confidence: 0.75, reason: 'PERSON_A asked about the deck' });
      expect(await flag(id)).toBe(true);
      await drain(w);
      expect(await flag(id)).toBe(false);
    } finally {
      await w.stop();
    }
  });
});

describe('payloads', () => {
  it('a job without work_item_id (a seed fixture in the contract Job shape) is skipped, not dead-lettered', async () => {
    const w = reevalWorker(db, userId, {}, false);
    try {
      const id = await makeItem(db, userId);
      const j = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { entity: { id, type: 'work_item', label: 'x' } } });
      const bad = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: 'not-a-uuid' } });
      await drain(w);
      expect(await job(j.id)).toMatchObject({ status: 'succeeded', result: { outcome: 'skipped' } });
      expect((await job(bad.id)).status).toBe('dead');
      expect((await item(id)).status).toBe('open');
    } finally {
      await w.stop();
    }
  });
});

describe('watermark', () => {
  it('a re-run with nothing new writes nothing', async () => {
    const w = reevalWorker(db, userId);
    try {
      const id = await makeItem(db, userId);
      const ev = await linkEvidence(db, userId, id, SAID_DONE);
      await drain(w);
      const again = await enqueueJob(db, { ownerUserId: userId, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: id }, generation: ev.generation! });
      await drain(w);
      expect((await job(again.id)).result).toMatchObject({ outcome: 'nothing_new', newEvidence: 0, changeSetId: null });
      expect(await reevalChangeSets(id)).toHaveLength(1);
    } finally {
      await w.stop();
    }
  });
});
