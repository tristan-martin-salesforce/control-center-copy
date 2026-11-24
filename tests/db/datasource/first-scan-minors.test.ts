/**
 * First-scan ramp fixes on the db DataSource (placeholder seed only):
 *   MIN-27  since-you-left starts when the user last left (`x-cc-away-since` → `notePresence`), never back
 *   MIN-28  Health ▸ Jobs: the latest finished jobs (plus each kind's newest) with full counts
 *   DEEP-1  the backfill: open work already over 30 days old when first seen waits in Triage ("Still needed?")
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actors, withChangeSet } from '../../../src/db/changeset';
import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { JOBS_FINISHED_LIMIT } from '../../../src/server/datasource/db/store/health';
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

const lastActive = async () =>
  (await handle.db.execute<{ at: string }>(sql`select value->>'lastActiveAt' as at from user_settings where owner_user_id = ${L.userId} and key = 'cc.meta'`)).rows[0]!.at;

describe.skipIf(!BE1B)('MIN-27: since-you-left starts when you last left', () => {
  it('moves the server start forward to the browser’s away-since, never back and never past now', async () => {
    const before = Date.parse(await lastActive());
    const away = L.now.getTime() - 3 * 3_600_000;
    expect(away).toBeGreaterThan(before);
    await db.notePresence(away);
    expect(Date.parse(await lastActive())).toBe(away);
    const since = await db.getSince({ query: {} });
    expect(Date.parse(since.since)).toBe(away);
    expect(since.awayMinutes).toBe(180);
    const home = await db.getHome({ query: { wide: false } });
    expect(home.masthead.since).toMatchObject({ show: true });

    await db.notePresence(away - 3_600_000); // an older tab: ignored
    expect(Date.parse(await lastActive())).toBe(away);
    await db.notePresence(L.now.getTime() + 3_600_000); // ahead of this clock: ignored
    expect(Date.parse(await lastActive())).toBe(away);
    // the move is the user's own presence: never listed as news
    expect((await db.getSince({ query: { ts: new Date(away - 60_000).toISOString() } })).entries.some((e) => /since-you-left/i.test(e.title))).toBe(false);
  });
});

describe.skipIf(!BE1B)('MIN-28: Health ▸ Jobs lists the latest finished jobs', () => {
  it('keeps live and dead jobs whole, the latest succeeded ones, each kind’s newest, and full counts', async () => {
    const t0 = L.now.getTime() - 86_400_000;
    const n = JOBS_FINISHED_LIMIT + 15;
    await handle.db.execute(sql`
      insert into jobs (owner_user_id, queue, kind, status, run_at, started_at, finished_at)
      select ${L.userId}, 'scan.slack', 'scan.slack', 'succeeded', t0 + g * interval '1 minute', t0 + g * interval '1 minute', t0 + g * interval '1 minute' + interval '1 second'
        from generate_series(1, ${n}) g, (select ${new Date(t0).toISOString()}::timestamptz as t0) x`);
    // an old success of another kind (the connector panel reads its source's last job) and a dead job
    await handle.db.execute(sql`
      insert into jobs (owner_user_id, queue, kind, status, run_at, finished_at, dead_at)
      values (${L.userId}, 'scan.gmail', 'scan.gmail', 'succeeded', ${new Date(t0 - 3_600_000).toISOString()}::timestamptz, ${new Date(t0 - 3_600_000).toISOString()}::timestamptz, null),
             (${L.userId}, 'scan.drive', 'scan.drive', 'dead', ${new Date(t0 - 7_200_000).toISOString()}::timestamptz, ${new Date(t0 - 7_200_000).toISOString()}::timestamptz, ${new Date(t0 - 7_200_000).toISOString()}::timestamptz)`);
    const all = await handle.db.execute<{ status: string; n: number }>(sql`select status::text, count(*)::int as n from jobs where owner_user_id = ${L.userId} group by 1`);
    const total = Object.fromEntries(all.rows.map((r) => [r.status, r.n]));
    const r = await db.getJobs({});
    const succeeded = r.jobs.filter((j) => j.status === 'succeeded');
    expect(r.counts.succeeded).toBe(total.succeeded);
    expect(r.counts.dead).toBe(total.dead);
    expect(succeeded.length).toBeLessThan(r.counts.succeeded ?? 0);
    expect(succeeded.length).toBeLessThanOrEqual(JOBS_FINISHED_LIMIT + new Set(succeeded.map((j) => j.type)).size);
    expect(succeeded.some((j) => j.type === 'scan.gmail')).toBe(true);
    expect(r.jobs.filter((j) => j.status === 'dead')).toHaveLength(total.dead ?? 0);
    // newest first, and the newest slack runs are the ones kept
    expect(r.jobs.map((j) => j.runAt)).toEqual([...r.jobs.map((j) => j.runAt)].sort((a, b) => b.localeCompare(a)));
    expect(succeeded.filter((j) => j.type === 'scan.slack')[0]!.runAt).toBe(new Date(t0 + n * 60_000).toISOString());
  });
});

describe.skipIf(!BE1B)('DEEP-1: the Still needed? backfill', () => {
  it('moves untouched open work that was over 30 days old when first seen to Triage, in one undoable change set', async () => {
    // two open, untouched items whose origin message becomes 45 days older than their first sighting
    const picked = (
      await handle.db.execute<{ id: string }>(sql`
        select wi.id from work_items wi
         where wi.owner_user_id = ${L.userId} and wi.status = 'open'
           and exists (select 1 from work_item_evidence e where e.work_item_id = wi.id and e.role = 'origin' and e.source_item_id is not null)
           and not exists (select 1 from work_item_transitions t where t.work_item_id = wi.id and t.actor_kind = 'user')
           and not exists (select 1 from change_sets c where c.actor_kind = 'user' and c.entity_type in ('work_item', 'work_items') and c.entity_id = wi.id::text)
         order by wi.id limit 2`)
    ).rows.map((r) => r.id);
    expect(picked).toHaveLength(2);
    await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('test.deep1'), reason: 'test: age two asks' }, async (tx) => {
      await tx.execute(sql`update work_items set due_at = null where id = any(${`{${picked.join(',')}}`}::uuid[])`);
      await tx.execute(sql`
        update source_items s set occurred_at = wi.created_at - interval '45 days'
          from work_item_evidence e join work_items wi on wi.id = e.work_item_id
         where e.source_item_id = s.id and e.role = 'origin' and wi.id = any(${`{${picked.join(',')}}`}::uuid[])`);
    });

    const dry = await db.stillNeededBackfill({ apply: false });
    expect(dry.candidates).toBeGreaterThanOrEqual(2);
    expect(dry.moved).toBe(0);
    const run = await db.stillNeededBackfill({ apply: true });
    expect(run.moved).toBe(dry.candidates);
    expect(run.auditId).toBeTruthy();

    const triage = await db.getTriage({});
    const group = triage.groups.find((g) => g.group === 'still_needed')!;
    expect(group.label).toBe('Still needed?');
    for (const id of picked) {
      const row = group.items.find((i) => i.id === id)!;
      expect(row.why).toMatch(/^Asked \d{4}-\d{2}-\d{2}, 45 days before it was first seen: still needed\?$/);
    }
    // every suggestion is listed and counted (Q9's LIMIT 100 no longer caps Triage)
    const suggested = (await handle.db.execute<{ n: number }>(sql`select count(*)::int as n from work_items where owner_user_id = ${L.userId} and status = 'suggested'`)).rows[0]!.n;
    // (SETTLE-1: Closed for you rows are done work, not suggestions)
    expect(triage.groups.flatMap((g) => g.items).filter((i) => i.kind === 'work_item' && i.group !== 'looks_done' && i.group !== 'closed_for_you')).toHaveLength(suggested);
    const today = await db.getToday({} as never);
    const todayIds = new Set([...today.nowStack.cards.map((c) => c.item.id), ...today.moreToday.items.map((w) => w.id), ...today.shelves.fitIns.map((e) => e.item.id)]);
    for (const id of picked) expect(todayIds.has(id)).toBe(false);
    expect((await db.stillNeededBackfill({ apply: false })).candidates).toBe(0); // idempotent

    // Keep is accept (open again); Close resolves it as not needed
    const [keep, close] = picked as [string, string];
    await db.acceptTriage({ params: { id: keep }, body: {} });
    const item = await db.getItem({ params: { id: close } });
    await db.itemAction({ params: { id: close, verb: 'resolve' }, body: { ifVersion: item.item.version, resolution: 'not_needed' } });
    const after = await db.getTriage({});
    expect(after.groups.find((g) => g.group === 'still_needed')!.items.map((i) => i.id)).not.toContain(keep);
    expect((await db.getItem({ params: { id: keep } })).item.state).toBe('open');
    expect((await db.getItem({ params: { id: close } })).item).toMatchObject({ state: 'done', resolution: 'not_needed' });
  });
});
