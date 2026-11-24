/**
 * BE-REEVAL helpers: the example seed loaded into the lane database, items created in the states a test needs,
 * evidence linked the way the scanner links it (source item + work_item_evidence + W2 recordNewInfo, actor
 * scanner:slack), and a WorkerRuntime that runs only the `engine` queue with the real reevaluate handler.
 * Placeholder people and text only.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import { createDb, type Db, type DbHandle } from '@/db/client';
import { recordNewInfo } from '@/db/queue';
import { people, sourceItems, workItemEvidence, workItems } from '@/db/schema';
import { reevaluateHandler, type ReevaluateHandlerDeps } from '@/jobs/handlers/reevaluate';
import { JobRegistry } from '@/jobs/registry';
import { seedFromMock } from '@/server/datasource/db/from-mock';
import { ensureExtractor, loadSeedIntoDb } from '@/server/datasource/db/seed';
import { createMockDataSource } from '@/server/datasource/mock';
import { WorkerRuntime } from '@/worker/runtime';

import { BEREEVAL_DATABASE_URL } from './db-url';

export const TEST_URL = BEREEVAL_DATABASE_URL;

export function openTestDb(max = 8): DbHandle {
  if (!/\/control_center_bereeval(_[a-z0-9]+)?(\?|$)/.test(TEST_URL)) throw new Error('BE-REEVAL tests must use control_center_bereeval*');
  return createDb({ url: TEST_URL, max, applicationName: 'bereeval-test' });
}

/** The committed placeholder seed (src/mock/seed.example.json), as the mock serves it. Returns the user id. */
export async function loadExampleSeed(db: Db): Promise<string> {
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  const { seed, rankedAt } = seedFromMock(mock);
  mock.dispose();
  const res = await loadSeedIntoDb(seed, { db, rankedAt, reset: process.env.BEREEVAL_REUSE_DB !== '1' });
  return res.userId;
}

export const DAY = 86_400_000;
export const ago = (days: number) => new Date(Date.now() - days * DAY);

export interface ItemSpec {
  title?: string;
  kind?: 'task' | 'ask' | 'commitment';
  status?: 'open' | 'in_progress' | 'done' | 'likely_done';
  doneDaysAgo?: number;
  resolution?: 'done_by_me' | 'handed_off';
  resolutionPersonId?: string;
  ownerPersonId?: string;
  involvement?: 'owner' | 'watcher' | 'not_involved';
  locked?: string[];
  initiativeId?: string | null;
}

/** A work item in a known state (a user change set, so the audit trigger is satisfied). */
export async function makeItem(db: Db, userId: string, s: ItemSpec = {}): Promise<string> {
  const done = s.status === 'done';
  const closedAt = done ? ago(s.doneDaysAgo ?? 1) : new Date(Date.now() - 60_000);
  const { result } = await withChangeSet({ db, userId, actor: actors.user('test.item'), reason: 'test item' }, (tx) =>
    tx
      .insert(workItems)
      .values({
        ownerUserId: userId,
        kind: s.kind ?? 'task',
        origin: 'manual',
        status: s.status ?? 'open',
        statusChangedAt: closedAt,
        title: s.title ?? `Send PLACEHOLDER_ACCOUNT the pilot deck ${randomUUID().slice(0, 6)}`,
        initiativeId: s.initiativeId ?? null,
        doneAt: done ? closedAt : null,
        doneBy: done ? 'user' : null,
        resolution: done ? (s.resolution ?? 'done_by_me') : null,
        resolutionPersonId: s.resolutionPersonId ?? null,
        ownerPersonId: s.ownerPersonId ?? null,
        involvement: s.involvement ?? 'owner',
        userLockedFields: s.locked ?? [],
        createdAt: new Date(closedAt.getTime() - DAY),
      })
      .returning({ id: workItems.id }),
  );
  return result[0]!.id;
}

export async function makePerson(db: Db, userId: string, name: string): Promise<string> {
  const { result } = await withChangeSet({ db, userId, actor: actors.user('test.person'), reason: 'test person' }, (tx) =>
    tx.insert(people).values({ ownerUserId: userId, displayName: name, affiliation: 'internal' }).returning({ id: people.id }),
  );
  return result[0]!.id;
}

export interface EvidenceSpec {
  role: 'origin' | 'progress' | 'completion' | 'context' | 'contradiction';
  confidence: number;
  reason: string;
  fromMe?: boolean;
  actorPersonId?: string;
  source?: 'slack' | 'gmail' | 'drive';
  /** Skip the W2 bump (context links don't bump). */
  noBump?: boolean;
}

/** Link evidence the way DbScannerStore.linkEvidence does: save first, then W2 (generation + re-eval job). */
export async function linkEvidence(db: Db, userId: string, workItemId: string, e: EvidenceSpec) {
  const extractorId = await ensureExtractor(db);
  const { result } = await withChangeSet({ db, userId, actor: actors.scanner(e.source ?? 'slack'), reason: `link evidence (${e.role})` }, async (tx) => {
    const ext = randomUUID();
    const [si] = await tx
      .insert(sourceItems)
      .values({
        ownerUserId: userId,
        source: e.source ?? 'slack',
        kind: e.source === 'gmail' ? 'email_message' : e.source === 'drive' ? 'drive_file_revision' : 'slack_message',
        externalId: ext,
        dedupeKey: `test:${ext}`,
        contentHash: ext,
        occurredAt: new Date(),
        fromMe: e.fromMe ?? false,
        actorPersonId: e.actorPersonId ?? null,
        title: 'PLACEHOLDER message',
      })
      .returning({ id: sourceItems.id });
    const [ev] = await tx
      .insert(workItemEvidence)
      .values({ workItemId, sourceItemId: si!.id, role: e.role, confidence: e.confidence, extractorId, rationale: e.reason, createdBy: 'connector' })
      .returning({ id: workItemEvidence.id });
    const w2 = e.noBump ? null : await recordNewInfo(tx, workItemId, { debounceSeconds: 0 });
    return { evidenceId: ev!.id, sourceItemId: si!.id, jobId: w2?.jobId ?? null, generation: w2?.generation ?? null };
  });
  return result;
}

export function reevalWorker(db: Db, userId: string, deps: ReevaluateHandlerDeps = {}, listen = true) {
  const registry = new JobRegistry();
  registry.register({ kind: 'reevaluate', queue: 'engine', wired: true, description: 'reevaluate (BE-REEVAL)', handler: reevaluateHandler({ supersededWaitMs: 2000, ...deps }) });
  return new WorkerRuntime({
    db,
    userId,
    workerId: `bereeval:${randomUUID().slice(0, 8)}`,
    registry,
    services: {},
    pools: [{ name: 'engine', queues: ['engine'], concurrency: 1 }],
    listenUrl: listen ? TEST_URL : null,
    log: () => {},
    leaseSeconds: 60,
    drainMs: 500,
  });
}

/** Claim and run every visible engine job, then wait for them. */
export async function drain(w: WorkerRuntime) {
  for (let i = 0; i < 10; i++) {
    const n = await w.pollOnce();
    await w.idle(30_000);
    if (!n) return;
  }
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 30_000, stepMs = 25): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Every row a closure decision can touch, per table, for an exact before/after comparison. Leaves out only the
 * bookkeeping undo itself bumps (version, updated_at) and the jobs queue (unaudited; follow-ups stay queued).
 */
export async function snapshot(db: Db, userId: string): Promise<Record<string, unknown>> {
  const q = (from: ReturnType<typeof sql>, order: string) =>
    db.execute<{ j: unknown }>(sql`select coalesce(jsonb_agg(to_jsonb(t) - '{version,updated_at}'::text[] order by ${sql.raw(order)}), '[]'::jsonb) as j from ${from}`).then((r) => r.rows[0]!.j);
  const mine = sql`(select id from work_items where owner_user_id = ${userId})`;
  return {
    work_items: await q(sql`work_items t where t.owner_user_id = ${userId}`, 't.id'),
    work_item_evidence: await q(sql`work_item_evidence t where t.work_item_id in ${mine}`, 't.id'),
    work_item_links: await q(sql`work_item_links t where t.work_item_id in ${mine}`, 't.id'),
    work_item_relations: await q(sql`work_item_relations t where t.from_work_item_id in ${mine}`, 't.id'),
    work_item_transitions: await q(sql`work_item_transitions t where t.work_item_id in ${mine}`, 't.id'),
    reopen_decisions: await q(sql`reopen_decisions t where t.owner_user_id = ${userId}`, 't.id'),
    change_proposals: await q(sql`change_proposals t where t.owner_user_id = ${userId}`, 't.id'),
    user_settings: await q(sql`user_settings t where t.owner_user_id = ${userId}`, 't.key'),
  };
}

export async function rows<T extends Record<string, unknown>>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute<T>(q)).rows as T[];
}
