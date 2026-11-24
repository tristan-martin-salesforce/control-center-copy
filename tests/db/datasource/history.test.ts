/**
 * B-081 History: mock ↔ db on the same seed (placeholder data only), then the db's own history facts.
 *
 * Parity: GET /history for this month and the one before, and GET /history/:day for every day of the seeded
 * week plus a quiet and a future day, validate against the contract and are equivalent after the standard
 * normalizations (parity.ts). The db reads closes from work_item_transitions and Org62 stamps from the
 * activity_entries columns; the mock from its records and audit trail, so this is where the two must agree.
 *
 * db only: a user close logs a transition and shows that day; Undo stamps the transition undone and the close
 * disappears; a close the item is reopened from stays, marked reopened since; a dry-run dispatch is a dry run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HistoryDay, type RouteKey } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { dayKey } from '../../../src/engines/home/time';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { shiftDay } from '../../../src/components/history/derive';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';
import { both } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;
let today: string;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
  today = dayKey(L.now.getTime(), L.seed.settings.profile.timezone);
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const T = (id: string) => L.idMap.get(id) ?? id;

describe.runIf(BE1B)('history parity: mock ↔ db on the same seed', () => {
  const reads: [string, RouteKey, () => Record<string, unknown>][] = [
    ['this month', 'getHistoryMonth', () => ({ query: {} })],
    ['last month', 'getHistoryMonth', () => ({ query: { month: shiftDay(`${today.slice(0, 7)}-01`, -1).slice(0, 7) } })],
    ...[0, 1, 2, 3, 4, 5].map((n): [string, RouteKey, () => Record<string, unknown>] => [`day −${n}`, 'getHistoryDay', () => ({ params: { day: shiftDay(today, -n) } })]),
    ['a quiet day', 'getHistoryDay', () => ({ params: { day: shiftDay(today, -45) } })],
    ['a future day', 'getHistoryDay', () => ({ params: { day: shiftDay(today, 2) } })],
  ];
  for (const [label, key, input] of reads) {
    it(`${key} · ${label}`, async () => {
      const r = await both(L, db, key, input());
      expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    });
  }

  it('the seeded week is not empty on either side (parity of nothing proves nothing)', async () => {
    const m = await db.getHistoryMonth({ query: {} });
    const week = m.days.filter((d) => d.day <= today && d.day >= shiftDay(today, -3));
    expect(week.reduce((s, d) => s + d.finished, 0)).toBeGreaterThanOrEqual(5);
    expect(week.reduce((s, d) => s + d.yourH, 0)).toBeGreaterThan(5);
    expect(week.reduce((s, d) => s + d.agentRuns, 0)).toBeGreaterThan(3);
  });
});

describe.runIf(BE1B)('history on db: transitions, undo, reopen, dry run', () => {
  const day = async () => HistoryDay.parse(await db.getHistoryDay({ params: { day: today } }));
  const ver = async (id: string) => (await db.getItem({ params: { id } })).item.version;

  it('a user close shows today, from its transition; Undo stamps it undone and the close is gone', async () => {
    const id = T('w_dana_reply');
    const before = (await day()).summary.finished;
    const r = await db.itemAction({ params: { id, verb: 'done' }, body: { ifVersion: await ver(id) } });
    const after = await day();
    expect(after.summary.finished).toBe(before + 1);
    expect(after.finished.find((f) => f.itemId === id)).toMatchObject({ by: 'you', label: 'Done by you', reopenedSince: false });
    await db.undoAudit({ params: { id: r.auditId! }, body: {} });
    const undone = await day();
    expect(undone.summary.finished).toBe(before);
    expect(undone.finished.some((f) => f.itemId === id)).toBe(false);
  });

  it('a close the item was reopened from stays, marked reopened since (the transition is not undone)', async () => {
    const id = T('w_globex_sow');
    const r = await db.itemAction({ params: { id, verb: 'done' }, body: { ifVersion: await ver(id) } });
    await db.itemAction({ params: { id, verb: 'reopen' }, body: { ifVersion: r.entity.version, note: 'Not finished' } });
    expect((await day()).finished.find((f) => f.itemId === id)).toMatchObject({ by: 'you', label: 'Done by you', reopenedSince: true });
  });

  it('a dry-run dispatch is counted as a dry run, never as sent', async () => {
    const draft = L.seed.drafts.find((x) => x.status === 'ready')!;
    const id = T(draft.id);
    const before = (await day()).summary;
    const cur = await db.getDraft({ params: { id } });
    const p = await db.previewDraft({ params: { id }, body: { mode: 'send' } });
    await db.dispatchDraft({ params: { id }, body: { ifVersion: cur.version, mode: 'send', confirmToken: p.confirmToken } });
    const d = await day();
    expect(d.summary).toMatchObject({ dryRuns: before.dryRuns + 1, sent: before.sent });
    expect(d.sent.find((s) => s.draftId === id)).toMatchObject({ outcome: 'dry_run', dryRun: true });
  });
});
