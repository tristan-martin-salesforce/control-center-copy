/**
 * priority@2 on Postgres (lane 07 R4, R8; migration 0033): the db DataSource with its production ranker.
 *
 * - shadow (the default): a re-rank records both orders on its one priority_runs row, writes priority@1.1 scores only,
 *   and Health reads agreement@3 from it;
 * - v2: the run and the scores are priority@2's (value, urgency, terms on priority_scores);
 * - feedback: a snooze of ranked work writes one priority_feedback row with the terms at the time (ids and numbers);
 * - the nightly pass turns repeated disagreement into one suggested rule; applying it nudges the config (kv), and
 *   Undo reverts the nudge;
 * - the auto re-rank: a capture queues one debounced priority.rerank job; autoRerank keeps the shown Top 3;
 * - GET /priority/preview is priority@2 over today's inputs and writes nothing.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PriorityPreview } from '../../../src/contract';
import { actors, withChangeSet } from '../../../src/db/changeset';
import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { NUDGES_KEY, runFeedbackPass } from '../../../src/server/datasource/db/priority';
import { priorityConfigOf } from '../../../src/server/datasource/db/rank';
import { inputsFingerprint, rerankHook } from '../../../src/jobs/handlers/rerank';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now } });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const rows = async <R extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await handle.db.execute<R>(q)).rows;

describe.runIf(BE1B)('priority@2 on Postgres', () => {
  it('shadow (default): one run per re-rank records both orders; the scores stay priority@1.1', async () => {
    const before = await rows<{ n: number }>(sql`select count(*)::int as n from priority_runs where owner_user_id = ${L.userId}`);
    await db.rerankToday({ body: {} } as never);
    const runs = await rows<{ id: number; engine_version: string; shadow_engine_version: string | null; agreement3: string | null; ranking: { top3: string[]; order: string[] } | null; shadow_ranking: { top3: string[] } | null }>(sql`
      select id, engine_version, shadow_engine_version, agreement3, ranking, shadow_ranking from priority_runs where owner_user_id = ${L.userId} order by id desc`);
    expect(runs.length).toBe(before[0]!.n + 1);
    const run = runs[0]!;
    expect(run).toMatchObject({ engine_version: 'priority@1.1', shadow_engine_version: 'priority@2' });
    expect(run.ranking!.top3).toHaveLength(3);
    expect(run.shadow_ranking!.top3.length).toBeGreaterThan(0);
    expect(Number(run.agreement3)).toBeGreaterThanOrEqual(0);
    const v2Scores = await rows<{ n: number }>(sql`select count(*)::int as n from priority_scores where run_id = ${run.id} and value is not null`);
    expect(v2Scores[0]!.n).toBe(0);

    const h = await db.getHealth({} as never);
    expect(h.priority).toMatchObject({ engine: 'shadow', runs: 1, agreement3: Number(run.agreement3) });
    expect(h.priority!.line).toMatch(/^Ranking: priority@2 in shadow · agrees \d\.\d\d on the Top 3 over 7 days \(1 run\)$/);
  });

  it('the preview is priority@2 over today and writes nothing', async () => {
    const n0 = await rows<{ n: number }>(sql`select count(*)::int as n from priority_runs`);
    const p = PriorityPreview.parse(await db.getPriorityPreview({} as never));
    expect(p.engineVersion).toBe('priority@2');
    expect(p.baselineVersion).toBe('priority@1.1');
    expect(p.rows.length).toBeGreaterThan(0);
    expect(p.top3.length).toBeGreaterThan(0);
    expect((await rows<{ n: number }>(sql`select count(*)::int as n from priority_runs`))[0]!.n).toBe(n0[0]!.n);
  });

  it('a snooze of ranked work writes one feedback row with the terms (ids and numbers only)', async () => {
    const m = await db.model();
    const target = m.all('workItems').find((w) => w.rank !== null && ['open', 'in_progress'].includes(w.state))!;
    await db.itemAction({ params: { id: target.id, verb: 'snooze' }, body: { ifVersion: target.version, until: new Date(L.now.getTime() + 86_400_000).toISOString() } } as never);
    const fb = await rows<{ action: string; from_rank: number | null; engine_version: string; terms: { item: { id: string; terms: Record<string, number> }; neighbours: unknown[] } }>(sql`
      select action, from_rank, engine_version, terms from priority_feedback where owner_user_id = ${L.userId}`);
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ action: 'snooze', from_rank: target.rank, engine_version: 'priority@1.1' });
    expect(fb[0]!.terms.item.id).toBe(target.id);
    expect(JSON.stringify(fb[0]!.terms)).not.toContain(target.title); // never text
    // the state change queued one debounced re-rank
    const jobs = await rows<{ n: number }>(sql`select count(*)::int as n from jobs where owner_user_id = ${L.userId} and kind = 'priority.rerank' and status = 'queued'`);
    expect(jobs[0]!.n).toBe(1);
  });

  it('the nightly pass suggests one rule; applying it nudges the config, Undo reverts it', async () => {
    const m = await db.model();
    const ids = m.all('workItems').filter((w) => w.rank !== null).slice(0, 2).map((w) => w.id);
    // eight "do first" moves where the item had the smaller deal and the higher urgency
    for (let i = 0; i < 8; i++) {
      await handle.db.execute(sql`insert into priority_feedback (owner_user_id, work_item_id, action, from_rank, to_rank, engine_version, terms)
        values (${L.userId}, ${ids[0]!}, 'do_first', 2, 1, 'priority@1.1', ${JSON.stringify({ item: { id: ids[0], rank: 2, terms: { deal: 0.3, urgency: 1 } }, neighbours: [{ id: ids[1], rank: 1, terms: { deal: 0.9, urgency: 0.3 } }] })}::jsonb)`);
    }
    const r = await runFeedbackPass(handle.db, L.userId, L.now);
    expect(r.suggested).toBe('deal:-1');
    expect((await runFeedbackPass(handle.db, L.userId, L.now)).suggested).toBeNull(); // never stacks a second one
    const h = await db.getHealth({} as never);
    expect(h.priority!.suggestion).toMatchObject({ term: 'deal', nudge: { target: 'deal', direction: -1 }, status: 'suggested' });
    expect(h.priority!.suggestion!.text).toContain('The model keeps ranking bigger deals above');

    const dealBefore = priorityConfigOf(await db.model()).weights.deal;
    const res = await db.decidePriorityRule({ params: { id: h.priority!.suggestion!.id }, body: { decision: 'apply' } } as never);
    expect(res.entity.status).toBe('applied');
    const after = await db.model();
    expect(after.ctx.kv.get(NUDGES_KEY)).toEqual([{ target: 'deal', direction: -1 }]);
    expect(priorityConfigOf(after).weights.deal).toBeLessThan(dealBefore);
    expect((await db.getHealth({} as never)).priority).toMatchObject({ suggestion: null, appliedRules: 1 });

    await db.undoAudit({ params: { id: res.auditId! }, body: {} } as never);
    expect(priorityConfigOf(await db.model()).weights.deal).toBe(dealBefore);
  });

  it('v2: the run and the scores are priority@2 (value, urgency, terms)', async () => {
    const s = (await db.model()).settings();
    await db.patchSettings({ params: { section: 'priority' }, body: { ifVersion: s.priority.version, value: { engine: 'v2' } } } as never);
    await db.rerankToday({ body: {} } as never);
    const [run] = await rows<{ id: number; engine_version: string; shadow_ranking: unknown }>(sql`select id, engine_version, shadow_ranking from priority_runs where owner_user_id = ${L.userId} order by id desc limit 1`);
    expect(run).toMatchObject({ engine_version: 'priority@2', shadow_ranking: null });
    const scores = await rows<{ value: string | null; urgency: string | null; terms: Record<string, number> | null }>(sql`select value, urgency, terms from priority_scores where run_id = ${run!.id} and rank is not null limit 5`);
    expect(scores.length).toBeGreaterThan(0);
    for (const x of scores) {
      expect(x.value).not.toBeNull();
      expect(x.urgency).not.toBeNull();
      expect(Object.keys(x.terms ?? {})).toEqual(expect.arrayContaining(['who', 'deal', 'kind', 'importance', 'goal', 'urgency']));
    }
    const today = await db.getToday({} as never);
    expect(today.nowStack.cards.length).toBeGreaterThan(0);
    await db.patchSettings({ params: { section: 'priority' }, body: { ifVersion: s.priority.version + 1, value: { engine: 'shadow' } } } as never);
  });

  it('auto re-rank: keeps the shown Top 3 and records the trigger', async () => {
    const shown = (await db.getToday({} as never)).nowStack.cards.map((c) => c.item.id);
    const r = await db.autoRerank('new_info');
    expect(r.top3).toEqual(shown);
    const [run] = await rows<{ trigger: string }>(sql`select trigger::text from priority_runs where owner_user_id = ${L.userId} order by id desc limit 1`);
    expect(run!.trigger).toBe('new_info');
  });

  it('the fingerprint hook queues one debounced re-rank when inputs change, never for its own rank writes', async () => {
    await handle.db.execute(sql`delete from jobs where kind = 'priority.rerank'`);
    const hook = rerankHook(handle.db, L.userId, () => undefined);
    await hook.run();
    const f0 = await inputsFingerprint(handle.db, L.userId);
    await db.autoRerank('new_info'); // writes ranks and scores only
    expect(await inputsFingerprint(handle.db, L.userId)).toEqual(f0);
    await hook.run();
    expect((await rows<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'priority.rerank'`))[0]!.n).toBe(0);
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.user(), reason: 'test: a due date moves' }, async (tx) => {
      await tx.execute(sql`update work_items set due_at = now() + interval '2 days' where id = (select id from work_items where owner_user_id = ${L.userId} order by id limit 1)`);
    });
    await hook.run();
    await hook.run(); // a second look without change queues nothing more
    expect((await rows<{ n: number; run_at_later: boolean }>(sql`select count(*)::int as n, bool_and(run_at > now() + interval '30 seconds') as run_at_later from jobs where kind = 'priority.rerank' and status = 'queued'`))[0]).toEqual({ n: 1, run_at_later: true });
  });

  it('ops: re-rank all users queues one job per user', async () => {
    const r = await db.rerankAllUsers({ body: {} } as never);
    expect(r.users).toBeGreaterThanOrEqual(1);
    expect(r.enqueued).toBe(r.users);
  });
});
