/**
 * The last read twins (docs/reviews/2026-11-20-holistic/19-read-twins.md): Today, Triage, the Time week and the Work
 * lists are one body each (src/server/views/{today,triage,time,work}.ts), so the mock now follows the db's rules. Each case is one
 * difference the table resolved, asserted on the mock DataSource (parity-reads holds the db side equal).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ItemsPayload, Seed, TimeWeek, TodayPayload, TriagePayload, type WorkItemRecord } from '@/contract';
import { uuidFor } from '@/server/datasource/db/ids';
import { quarterTotal } from '@/server/datasource/db/quarter';
import { MockDataSource } from '@/server/datasource/mock';
import { WORK_TABS, workListView } from '@/server/views/work';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

const today = async () => TodayPayload.parse(await ds.getToday({} as never));
const triage = async () => TriagePayload.parse(await ds.getTriage({} as never));
const list = async (query: Record<string, string>) => ItemsPayload.parse(await ds.listItems({ query: { tab: 'all_open', ...query } } as never));
const ids = (p: ItemsPayload) => p.items.map((i) => i.id);
const week = async () => TimeWeek.parse(await ds.getTime({ query: {} } as never));

describe('Today: one body (views/today.ts)', () => {
  it('T1: a tentative invite is never "your next meeting" (it shows on the spine, it does not block time)', async () => {
    const first = await today();
    const next = first.header.nextMeeting;
    expect(next).not.toBeNull();
    const ev = ds.store.get('events', next!.eventId)!;
    ds.store._set('events', { ...ev, myResponse: 'tentative' });
    const after = await today();
    expect(after.header.nextMeeting?.eventId).not.toBe(ev.id);
    expect(after.spine.events.some((e) => e.id === ev.id)).toBe(true);
  });

  it("T2: the quarter's logged hours are this fiscal quarter's logged rows (db/quarter.ts), the same as Time's", async () => {
    const t = await today();
    const { timezone, workingHours } = ds.store.settings().profile;
    const q = quarterTotal(ds.store.meta(), ds.store.all('activity'), new Date(t.now), timezone, workingHours.end);
    expect(t.header.nearestDeadline?.progress?.done).toBe(q.loggedH);
    expect(t.header.nearestDeadline?.progress?.done).toBe((await week()).quarter.loggedH);
  });

  it('T3: a likely-done item in the stored Top 3 leaves NOW and leads More today (LD-1, the db rule)', async () => {
    const before = await today();
    const first = before.nowStack.cards[0]!.item;
    ds.store._set('workItems', { ...ds.store.get('workItems', first.id)!, state: 'likely_done' });
    const after = await today();
    expect(after.nowStack.cards.map((c) => c.item.id)).not.toContain(first.id);
    expect(after.nowStack.cards).toHaveLength(3);
    expect(after.moreToday.items[0]?.id).toBe(first.id);
  });

  it('T4: the scanner pulse reads the Slack connector by its source', async () => {
    const t = await today();
    const slack = ds.store.all('connectors').find((c) => c.source === 'slack');
    expect(t.scannerPulse.state).toBe(slack?.state ?? ds.store.all('connectors')[0]?.state ?? 'ok');
  });
});

describe('Triage: one body (views/triage.ts)', () => {
  it("R1: a missed opp the app tracks links its Org62 record in the source (Provenance on everything)", async () => {
    const mo = ds.store.all('missedOpps').find((m) => m.status === 'new')!;
    const opp = ds.store.all('opps').find((o) => o.org62Url)!;
    ds.store._set('missedOpps', { ...mo, oppId: opp.id });
    const row = (await triage()).groups.flatMap((g) => g.items).find((i) => i.id === mo.id);
    expect(row).toBeDefined();
    expect(row!.sources[0]?.url).toBe(opp.org62Url);
  });
});

describe('Time week: one body (views/time.ts)', () => {
  it("W1: the Meetings lane holds the meetings I attend; a tentative or unanswered invite is not logged time", async () => {
    const w0 = await week();
    const block = w0.timeline.find((l) => l.id === 'meetings')!.blocks[0]!;
    const ev = ds.store.get('events', block.id)!;
    ds.store._set('events', { ...ev, myResponse: 'needs_action' });
    expect((await week()).timeline.find((l) => l.id === 'meetings')!.blocks.map((b) => b.id)).not.toContain(ev.id);
  });

  it('W2: a travel or onsite frame (a meetings-lane time block) sits with the meetings', async () => {
    const w0 = await week();
    const meeting = w0.timeline.find((l) => l.id === 'meetings')!.blocks[0]!;
    const focus = ds.store.all('timeBlocks').find((b) => b.lane === 'focus')!;
    // the onsite lane's frames are stored as meetings-lane blocks (the db's projections write them; the seed has none)
    ds.store._set('timeBlocks', { ...focus, id: 'tb_travel_test', lane: 'meetings' as never, start: meeting.start, end: meeting.end, label: 'Travel' });
    const lanes = (await week()).timeline;
    expect(lanes.find((l) => l.id === 'meetings')!.blocks.map((b) => b.id)).toContain('tb_travel_test');
    expect(lanes.find((l) => l.id === 'focus')!.blocks.map((b) => b.id)).not.toContain('tb_travel_test');
  });

  it("W3: a meeting's row is found by the meeting's calendar (external) id", async () => {
    const w0 = await week();
    const block = w0.timeline.find((l) => l.id === 'meetings')!.blocks.find((b) => b.activityId)!;
    expect(block).toBeDefined();
    const ev = ds.store.get('events', block.id)!;
    const row = ds.store.get('activity', block.activityId!)!;
    // the row points at the calendar id; the meeting's app id is a different one
    ds.store._set('events', { ...ev, source: { ...ev.source, externalId: 'cal_ext_1' } });
    ds.store._set('activity', { ...row, sources: row.sources.map((s) => (s.externalId === ev.id ? { ...s, externalId: 'cal_ext_1' } : s)) });
    expect((await week()).timeline.find((l) => l.id === 'meetings')!.blocks.find((b) => b.id === ev.id)?.activityId).toBe(row.id);
  });
});

describe('Work lists: one body (views/work.ts)', () => {
  it('WL-2: an account, opp or initiative filter finds the row by the id given or by its database key', async () => {
    const w = ds.store.all('workItems').find((i) => i.state === 'open' && i.accountId && i.oppId && i.initiativeId)!;
    for (const k of ['account', 'opp', 'initiative'] as const) {
      const v = k === 'account' ? w.accountId! : k === 'opp' ? w.oppId! : w.initiativeId!;
      const byId = await list({ [k]: v });
      expect(ids(byId)).toContain(w.id);
      expect(ids(await list({ [k]: uuidFor(v) }))).toEqual(ids(byId));
    }
  });

  it("WL-3: the store's candidates only narrow; every filter still applies, and null means filter in memory", () => {
    const q = { tab: 'all_open' as const, account: ds.store.all('accounts')[0]!.id };
    const plain = workListView(ds.store, q);
    expect(plain.items.length).toBeGreaterThan(1);
    const every = new Set(ds.store.all('workItems').map((i) => i.id));
    expect(workListView(ds.store, q, { candidates: every })).toEqual(plain);
    const drop = plain.items[0]!.id;
    const less = workListView(ds.store, q, { candidates: new Set([...every].filter((i) => i !== drop)) });
    expect(less.items.map((i) => i.id)).toEqual(plain.items.slice(1).map((i) => i.id));
    expect(less.counts.all_open).toBe(plain.counts.all_open! - 1);
  });

  it("WL-4: closed items with the same close time list oldest-created first (the db loader's order, now explicit)", async () => {
    const done = ds.store.all('workItems').filter((i) => i.state === 'done').slice(0, 2);
    expect(done).toHaveLength(2);
    const at = '2026-01-01T00:00:00.000Z';
    const [a, b] = done as [WorkItemRecord, WorkItemRecord];
    ds.store._set('workItems', { ...a, doneAt: at, createdAt: '2025-06-02T00:00:00.000Z' });
    ds.store._set('workItems', { ...b, doneAt: at, createdAt: '2025-06-01T00:00:00.000Z' });
    const rows = ids(await list({ tab: 'done' })).filter((i) => i === a.id || i === b.id);
    expect(rows).toEqual([b.id, a.id]);
  });

  it('every tab is counted over the same filters, and the total is the rows shown', async () => {
    const all = await list({});
    const ask = await list({ kind: 'ask' });
    expect(Object.keys(ask.counts).sort()).toEqual([...WORK_TABS].sort());
    expect(ask.counts.said_by_me).toBe(0);
    expect(ask.counts.asked_of_me).toBe(all.counts.asked_of_me);
    expect(ask.total).toBe(ask.items.length);
  });

  it('the parity shapes are not empty: every filter at once still finds its item', async () => {
    const w = ds.store.all('workItems').find((x) => x.state === 'open' && !!x.accountId && !!x.initiativeId && x.sources.length > 0)!;
    const r = await list({ account: w.accountId!, initiative: w.initiativeId!, source: w.sources[0]!.kind, kind: w.kind, q: w.title.slice(0, 5) });
    expect(ids(r)).toContain(w.id);
    expect(ids(await list({ initiative: ds.store.all('initiatives')[0]!.id })).length).toBeGreaterThan(0);
    expect(ids(await list({ q: 'ACME' })).length).toBeGreaterThan(0);
  });
});
