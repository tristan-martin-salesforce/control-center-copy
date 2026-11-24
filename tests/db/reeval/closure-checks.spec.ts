/**
 * The resolution check on Postgres: closure_checks rows and read models, the trigger dedupe, the W0-2 filter in the
 * legacy Settle selection, the handler in shadow (records only) and live (applies), and the escalation data gate.
 * Placeholder seed and text only; the model is scripted (no network).
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '@/db/changeset';
import type { Db, DbHandle } from '@/db/client';
import { insertLlmCall } from '@/db/ledger';
import { sourceItems, workItemEvidence, workItems } from '@/db/schema';
import { RESOLUTION_ENGINE_VERSION, type CheckRecord } from '@/engines/resolution/types';
import { selectSettleItems } from '@/engines/settle/select-db';
import { resolutionCheckHandler } from '@/jobs/handlers/resolution-check';
import type { JobContext } from '@/jobs/types';
import { enqueueResolutionCheck, enqueueResolutionTriggers, selectSweepItems } from '@/scanner/resolution/triggers-db';
import { ensureExtractor } from '@/server/datasource/db/seed';
import { closureCheckHistory, getResolutionCheckPayload, loadResolutionForCheck, recordClosureCheck, resolutionEscalationStats, resolutionShadowComparison, resolutionYield } from '@/server/datasource/db/resolution';

import { loadExampleSeed, openTestDb } from './helpers';
import { scripted } from '../../resolution/fixtures';

let handle: DbHandle;
let db: Db;
let userId: string;
const MIN = 60_000;

async function setClosing(v: Record<string, unknown>) {
  await withChangeSet({ db, userId, actor: actors.user('test.settings'), reason: 'closing settings' }, (tx) =>
    tx.execute(sql`insert into user_settings (owner_user_id, key, value) values (${userId}, 'settings.closing', ${JSON.stringify({ version: 1, ...v })}::jsonb)
                   on conflict (owner_user_id, key) do update set value = excluded.value`),
  );
}

/** A Slack line in a DM (meta as the scanner stores it). */
async function slackLine(o: { at: Date; text: string; fromMe?: boolean; author?: string; channel?: string; toMe?: boolean; runId?: string }) {
  const ext = randomUUID();
  const [si] = await db
    .insert(sourceItems)
    .values({
      ownerUserId: userId,
      source: 'slack',
      kind: 'slack_message',
      externalId: ext,
      externalParentId: `slack:${o.channel ?? 'D0RES0001'}:${ext}`,
      dedupeKey: `test:${ext}`,
      contentHash: ext,
      occurredAt: o.at,
      fromMe: o.fromMe ?? false,
      addressedToMe: o.toMe ?? true,
      body: o.text,
      meta: { channelId: o.channel ?? 'D0RES0001', channelType: 'im', ts: `${Math.floor(o.at.getTime() / 1000)}.000100`, ...(o.fromMe ? {} : { author: { name: o.author ?? 'PERSON_R', externalId: `U0${(o.author ?? 'PERSON_R').replace(/\W/g, '')}` } }) },
      ...(o.runId ? { firstScanRunId: o.runId } : {}),
    })
    .returning({ id: sourceItems.id });
  return si!.id;
}

async function makeAsk(title: string, askAt: Date, o: { status?: 'open' | 'done'; doneBy?: 'engine' | 'user'; doneAt?: Date; channel?: string } = {}) {
  const channel = o.channel ?? `D0${randomUUID().slice(0, 8).toUpperCase()}`;
  const origin = await slackLine({ at: askAt, text: `Can you send me ${title.toLowerCase()}?`, channel });
  const extractorId = await ensureExtractor(db);
  const { result } = await withChangeSet({ db, userId, actor: actors.user('test.item'), reason: 'test item' }, async (tx) => {
    const [w] = await tx
      .insert(workItems)
      .values({ ownerUserId: userId, kind: 'ask', origin: 'manual', status: o.status ?? 'open', title, statusChangedAt: o.doneAt ?? askAt, doneAt: o.doneAt ?? null, doneBy: o.doneBy ?? null, resolution: o.status === 'done' ? 'done_by_me' : null, involvement: 'owner', createdAt: askAt })
      .returning({ id: workItems.id });
    await tx.insert(workItemEvidence).values({ workItemId: w!.id, sourceItemId: origin, role: 'origin', confidence: 0.95, extractorId, rationale: 'test: the ask', createdBy: 'connector' });
    return w!.id;
  });
  return { id: result, origin, channel };
}

/** A job context over a real job row (not queued) (llm_calls.job_id references it; the handler never claims itself). */
async function ctxFor(payload: Record<string, unknown>, now = new Date()): Promise<JobContext> {
  const ac = new AbortController();
  const id = (await db.execute<{ id: string }>(sql`insert into jobs (owner_user_id, queue, kind, payload, status) values (${userId}, 'settle', 'resolution.check', ${JSON.stringify(payload)}::jsonb, 'succeeded') returning id`)).rows[0]!.id;
  return { job: { id: Number(id), payload } as never, signal: ac.signal, db, userId, clock: () => now, log: () => undefined, heartbeat: async () => undefined, enqueue: async () => ({ id: 0, inserted: false }), services: undefined };
}

beforeAll(async () => {
  handle = openTestDb();
  db = handle.db;
  userId = await loadExampleSeed(db);
});
afterAll(async () => {
  await handle?.close();
});

const rec = (workItemId: string, o: Partial<CheckRecord> = {}): CheckRecord => ({ workItemId, at: new Date().toISOString(), trigger: 'conversation_line', mode: 'shadow', statusBefore: 'open', packDigest: '0123456789abcdef', packTokens: 300, packLines: 3, rulesFired: [], ruleHit: null, decidedBy: 'model', verdict: 'not_done', basis: 'none', confidence: 0.2, citeAlias: null, citeSourceItemId: null, escalated: false, escalationReason: null, escalationChanged: null, outcome: 'left', blockedBy: null, model: 'claude-haiku-5-5', costUsd: 0.0003, inputTokens: 900, outputTokens: 40, cacheReadTokens: 2000, durationMs: 12, engineVersion: RESOLUTION_ENGINE_VERSION, ...o });

describe('closure_checks: rows and read models', () => {
  it('records a check and reads it back newest first, in plain words for the panel', async () => {
    const { id } = await makeAsk('the ACME pricing deck', new Date(Date.now() - 2 * 3600_000));
    await recordClosureCheck(db, userId, rec(id, { at: new Date(Date.now() - 30 * MIN).toISOString() }));
    await recordClosureCheck(db, userId, rec(id, { decidedBy: 'rule', ruleHit: 'D1', verdict: 'done', outcome: 'closed', mode: 'live' }));
    const h = await closureCheckHistory(db, userId, id);
    expect(h.map((x) => x.outcome)).toEqual(['closed', 'left']);
    const p = await getResolutionCheckPayload(db, userId, id, new Date());
    expect(p.mode).toBe('shadow');
    expect(p.last).toMatchObject({ outcome: 'closed', decidedBy: 'rule', ruleHit: 'D1' });
    expect(p.last!.why).toBe('Rule D1: your reply after the ask carries what was asked; closed it for you.');
    expect(p.history).toHaveLength(1);
    expect(p.nextCheck).toMatch(/nightly sweep/);
  });

  it('rejects an outcome outside the vocabulary', async () => {
    const { id } = await makeAsk('the security doc', new Date(Date.now() - 3600_000));
    await expect(recordClosureCheck(db, userId, rec(id, { outcome: 'archived' as never }))).rejects.toThrow();
  });

  it('the shadow comparison over the week and the yield line', async () => {
    const closedA = await makeAsk('the sizing sheet', new Date(Date.now() - 3 * 86_400_000), { status: 'done', doneBy: 'engine', doneAt: new Date(Date.now() - 2 * 86_400_000) });
    const closedB = await makeAsk('the SOW draft', new Date(Date.now() - 3 * 86_400_000), { status: 'done', doneBy: 'engine', doneAt: new Date(Date.now() - 2 * 86_400_000) });
    const open = await makeAsk('the roadmap slide', new Date(Date.now() - 3 * 86_400_000));
    await recordClosureCheck(db, userId, rec(closedA.id, { outcome: 'closed' }));
    await recordClosureCheck(db, userId, rec(closedB.id, { outcome: 'likely' }));
    await recordClosureCheck(db, userId, rec(open.id, { outcome: 'closed' }));
    const s = await resolutionShadowComparison(db, userId, new Date());
    expect(s.legacyCloses).toBeGreaterThanOrEqual(2);
    expect(s.wouldCloseMore).toBeGreaterThanOrEqual(1);
    expect(s.line).toMatch(/^Resolution check agreed on \d+% of \d+ closes this week/);
    const y = await resolutionYield(db, userId, new Date(Date.now() - 86_400_000).toISOString());
    expect(y.checks).toBeGreaterThanOrEqual(5);
    expect(y.perCheckUsd).toBeGreaterThan(0);
  });
});

describe('the escalation data gate reads llm_calls', () => {
  it('per reason: escalations and how many changed the verdict, over 14 days', async () => {
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 12; i++) {
      await insertLlmCall(db, { ownerUserId: userId, purpose: 'done_match', model: 'claude-sonnet-5-5', skillKey: 'resolve-item', status: 'ok', inputTokens: 900, outputTokens: 40, costUsd: 0.002, budgetDay: day, trigger: 'test', modelReason: 'escalation:uncertain', contentHash: `h${i}`, outcome: 'ok', measure: { itemsIn: 1, escalationChangedItems: i === 0 ? 1 : 0 } });
    }
    const s = await resolutionEscalationStats(db, userId, new Date());
    expect(s.find((x) => x.reason === 'uncertain')).toEqual({ reason: 'uncertain', escalations: 12, changed: 1 });
  });
});

describe('triggers on Postgres', () => {
  it('one queued check per item per 10 minutes', async () => {
    const { id } = await makeAsk('the pilot plan', new Date(Date.now() - 3600_000));
    const now = new Date();
    expect(await enqueueResolutionCheck(db, userId, id, 'conversation_line', now)).toBe(true);
    expect(await enqueueResolutionCheck(db, userId, id, 'drive_revision', new Date(now.getTime() + 60_000))).toBe(false);
    const n = (await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'resolution.check' and payload->>'itemId' = ${id}`)).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('the scan-run hook queues a check for an item whose DM got a new line (not in legacy mode)', async () => {
    const askAt = new Date(Date.now() - 2 * 3600_000);
    const { id, channel } = await makeAsk('the TCO model', askAt);
    const [run] = (await db.execute<{ id: string }>(sql`select id::text as id from scan_runs limit 1`)).rows;
    expect(run, 'the seed has a scan run').toBeDefined();
    await slackLine({ at: new Date(), text: 'any update on the TCO model?', runId: run!.id, channel });
    await setClosing({ resolutionEngine: 'legacy' });
    expect((await enqueueResolutionTriggers(db, userId, run!.id, new Date())).queued).toBe(0);
    await setClosing({ resolutionEngine: 'shadow' });
    const r = await enqueueResolutionTriggers(db, userId, run!.id, new Date());
    expect(r.hits).toBeGreaterThanOrEqual(1);
    const q = (await db.execute<{ t: string }>(sql`select payload->>'trigger' as t from jobs where kind = 'resolution.check' and payload->>'itemId' = ${id}`)).rows;
    expect(q.map((x) => x.t)).toEqual(['conversation_line']);
  });

  it('the nightly sweep selects live items with no check in 7 days', async () => {
    const { id } = await makeAsk('the data sheet', new Date(Date.now() - 86_400_000));
    expect((await selectSweepItems(db, userId, new Date(), 5000)).map((x) => x.id)).toContain(id);
    await recordClosureCheck(db, userId, rec(id));
    expect((await selectSweepItems(db, userId, new Date(), 5000)).map((x) => x.id)).not.toContain(id);
  });
});

describe('W0-2 in the legacy Settle selection', () => {
  it('chatter in a closed item’s DM does not select it; the asker writing to me does', async () => {
    await setClosing({ resolutionEngine: 'shadow' });
    const askAt = new Date(Date.now() - 5 * 3600_000);
    const closed = await makeAsk('the ACME integration diagram', askAt, { status: 'done', doneBy: 'engine', doneAt: new Date(askAt.getTime() + 3600_000) });
    const since = new Date(Date.now() - 60_000).toISOString();
    await slackLine({ at: new Date(), text: 'lunch at noon?', author: 'PERSON_Q', toMe: false, channel: closed.channel });
    let picked = await selectSettleItems(db, userId, since, new Date(Date.now() + 1000));
    expect(picked.map((p) => p.id)).not.toContain(closed.id);
    await slackLine({ at: new Date(Date.now() + 500), text: 'one more thing for you', author: 'PERSON_R', channel: closed.channel });
    picked = await selectSettleItems(db, userId, since, new Date(Date.now() + 2000));
    expect(picked.map((p) => p.id)).toContain(closed.id);
  });

  it('live mode retires Settle’s selection', async () => {
    await setClosing({ resolutionEngine: 'live' });
    expect(await selectSettleItems(db, userId, null, new Date())).toEqual([]);
    await setClosing({ resolutionEngine: 'shadow' });
  });
});

describe('the resolution.check handler', () => {
  it('takes the other queued item checks of the user into the same run (batching)', async () => {
    const queued = (await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'resolution.check' and status = 'queued'`)).rows[0]!.n;
    expect(queued).toBeGreaterThan(0);
    const { model } = scripted(() => ({ verdict: 'not_done', basis: 'none', confidence: 0.2 }));
    const { id } = await makeAsk('the batching probe', new Date(Date.now() - 3600_000));
    const out = (await resolutionCheckHandler({ model })(await ctxFor({ itemId: id, trigger: 'manual' }))) as { checks: number; missing: number };
    // every taken item is checked, or counted missing when it is no longer loadable
    expect(out.checks + out.missing).toBe(1 + Math.min(queued, 7));
    expect(out.checks).toBeGreaterThanOrEqual(2);
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'resolution.check' and status = 'queued'`)).rows[0]!.n).toBe(Math.max(0, queued - 7));
  });

  it('shadow: checks, books the call, records the row, changes nothing', async () => {
    await setClosing({ resolutionEngine: 'shadow' });
    const askAt = new Date(Date.now() - 3 * 3600_000);
    const { id, channel } = await makeAsk('the expected volumes', askAt);
    await slackLine({ at: new Date(askAt.getTime() + 30 * MIN), text: 'Rough volumes: 1.8M members, 420k monthly interactions, 35% about claims.', fromMe: true, channel });
    const loaded = await loadResolutionForCheck(db, userId, id, new Date());
    expect(loaded?.raw.conversation.length).toBeGreaterThanOrEqual(1);
    const { model, calls } = scripted(() => ({ verdict: 'done', basis: 'delivered', cite: 'c1', confidence: 0.9 }));
    const out = await resolutionCheckHandler({ model })(await ctxFor({ itemId: id, trigger: 'conversation_line' }));
    expect(out).toMatchObject({ status: 'ok', mode: 'shadow', checks: 1, calls: 1 });
    expect(calls).toHaveLength(1);
    const [c] = await closureCheckHistory(db, userId, id);
    expect(c).toMatchObject({ mode: 'shadow', decidedBy: 'model', verdict: 'done', outcome: 'closed', trigger: 'conversation_line' });
    expect(c!.llmCallId).not.toBeNull();
    const st = (await db.execute<{ s: string }>(sql`select status::text as s from work_items where id = ${id}::uuid`)).rows[0]!.s;
    expect(st).toBe('open');
    const booked = (await db.execute<{ k: string; items: number }>(sql`select skill_key as k, items_in as items from llm_calls where id = ${c!.llmCallId}`)).rows[0]!;
    expect(booked).toEqual({ k: 'resolve-item', items: 1 });
  });

  it('live: the done goes through the scanner writer as completion evidence (the machine closes it)', async () => {
    await setClosing({ resolutionEngine: 'live' });
    const askAt = new Date(Date.now() - 3 * 3600_000);
    const { id, channel } = await makeAsk('the member counts', askAt);
    const mineId = await slackLine({ at: new Date(askAt.getTime() + 30 * MIN), text: 'Member counts: 1.8M members, of them 1.2M active.', fromMe: true, channel });
    const { model } = scripted(() => ({ verdict: 'done', basis: 'delivered', cite: 'c1', confidence: 0.9 }));
    const out = await resolutionCheckHandler({ model })(await ctxFor({ itemId: id, trigger: 'conversation_line' }));
    expect(out).toMatchObject({ status: 'ok', mode: 'live', applied: { evidence: 1 } });
    const ev = (await db.execute<{ role: string; r: string }>(sql`select role::text as role, rationale as r from work_item_evidence where work_item_id = ${id}::uuid and source_item_id = ${mineId}::uuid`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ role: 'completion' });
    expect(ev[0]!.r).toMatch(/resolution:/);
    const re = (await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'reevaluate' and status = 'queued'`)).rows[0]!.n;
    expect(re).toBeGreaterThan(0);
    await setClosing({ resolutionEngine: 'shadow' });
  });

  it('legacy: does nothing', async () => {
    await setClosing({ resolutionEngine: 'legacy' });
    const { model, calls } = scripted(() => ({ verdict: 'done', confidence: 1 }));
    expect(await resolutionCheckHandler({ model })(await ctxFor({ trigger: 'sweep' }))).toMatchObject({ status: 'disabled' });
    expect(calls).toHaveLength(0);
    await setClosing({ resolutionEngine: 'shadow' });
  });
});
