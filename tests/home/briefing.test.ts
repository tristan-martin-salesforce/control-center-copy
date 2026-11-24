/**
 * Home as the briefing (phase 3; docs/UX.md "Home"): the pure pieces around Do now, over the placeholder world and
 * small fakes. Respond chips (drafts and replies; nothing sends from Home), Coming builds (ETA), the Admin row
 * (priority@2's batch vs priority@1.1's rule list), Overbooked → what to move, closed for you just now, the empty-day
 * line, and the third Do-now slot as the drafts card.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HomePayload, type AgentRun, type Draft, type HomeDayRef, type HomeRow, type MakeRoom, type WorkItem } from '@/contract';
import { buildHome } from '@/engines/home/build';
import type { HomeInput } from '@/engines/home/types';
import { adminOf, buildsOf, closedNowOf, moveItOf, respondOf, watchingOf } from '@/engines/home/briefing';
import { DEFAULT_PRIORITY_CONFIG } from '@/engines/priority/v2/config';
import { personaOf } from '@/personas';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { homeInputFromStore } from '@/server/datasource/mock/home';

let ds: MockDataSource;
beforeAll(() => {
  ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
});
afterAll(() => ds.dispose());

const inputOf = (): HomeInput => homeInputFromStore(ds, false);
const NOW = Date.parse('2026-11-05T16:00:00.000Z');
const TZ = 'America/Denver';

const draftLike = (input: HomeInput, over: Partial<Draft>): Draft => ({ ...input.drafts.find((d) => d.destination.kind === 'email')!, ...over }) as Draft;
const itemLike = (input: HomeInput, over: Partial<WorkItem>): WorkItem => ({ ...input.items.find((w) => w.state === 'open')!, ...over }) as WorkItem;

describe('Respond: drafts and replies as chips', () => {
  it('failed first (Retry), then ready (Send); drafts still being written and admin payloads stay out; a draft on a card is not a chip', () => {
    const input = inputOf();
    const drafts = [
      draftLike(input, { id: 'd_ready_old', status: 'ready', updatedAt: '2026-11-05T10:00:00.000Z', workItemId: null }),
      draftLike(input, { id: 'd_ready_new', status: 'ready', updatedAt: '2026-11-05T15:00:00.000Z', workItemId: null }),
      draftLike(input, { id: 'd_failed', status: 'failed', updatedAt: '2026-11-05T09:00:00.000Z', workItemId: null }),
      draftLike(input, { id: 'd_drafting', status: 'drafting', workItemId: null }),
      draftLike(input, { id: 'd_sent', status: 'sent', workItemId: null }),
      draftLike(input, { id: 'd_on_card', status: 'ready', workItemId: null }),
    ];
    const r = respondOf(drafts, [], new Set(['d_on_card']));
    expect(r.chips.map((c) => [c.id, c.state, c.verb])).toEqual([
      ['d_failed', 'failed', 'Retry'],
      ['d_ready_new', 'ready', 'Send'],
      ['d_ready_old', 'ready', 'Send'],
    ]);
    expect(r.ready).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.review).toEqual({ label: 'Review 4', href: '/outbox' });
    // every chip opens the Outbox row: approving keeps the Outbox's own preview, confirm and undo window
    for (const c of r.chips) expect(c.href).toBe(`/outbox?draft=${c.id}`);
  });

  it('a reply the app can draft is a "Draft" chip that opens the item; every other reply keeps its verb word; one that already has a draft is not repeated', () => {
    const input = inputOf();
    const row = (id: string, action: HomeRow['verb']['action']): HomeRow => ({
      id,
      kind: 'item',
      title: `Answer ${id}`,
      why: 'Asked yesterday',
      state: null,
      stateLabel: null,
      due: null,
      youMin: 5,
      verb: { label: 'Draft reply', action, href: `/work/${id}`, targetId: id },
      href: `/work/${id}`,
      entity: { kind: 'work_item', id },
      item: { id, version: 1 },
      progress: null,
      heat: null,
      dateLabel: null,
      resolve: null,
    });
    const drafts = [draftLike(input, { id: 'd_x', status: 'ready', workItemId: 'w_has_draft' })];
    const r = respondOf(drafts, [row('w_reply', 'draft'), row('w_has_draft', 'draft'), row('w_open', 'open')], new Set());
    expect(r.chips.map((c) => [c.id, c.verb])).toEqual([['d_x', 'Send'], ['w_reply', 'Draft'], ['w_open', 'Open']]);
    expect(r.chips[1]).toMatchObject({ kind: 'reply', state: 'can_draft', verb: 'Draft', href: '/work/w_reply', entity: { kind: 'work_item', id: 'w_reply' } });
  });

  it('HM-03 all drafts failed: every chip is Retry and nothing is Send', () => {
    const input = inputOf();
    const r = respondOf([draftLike(input, { id: 'a', status: 'failed' }), draftLike(input, { id: 'b', status: 'verify_failed' })], [], new Set());
    expect(r.ready).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.chips.every((c) => c.verb === 'Retry' && c.state === 'failed')).toBe(true);
  });
});

describe('Coming builds', () => {
  const run = (over: Partial<AgentRun>): AgentRun => ({ id: 'r', kind: 'claude_session', title: 'Build', workItemId: null, state: 'running', startedAt: null, updatedAt: '2026-11-05T15:00:00.000Z', finishedAt: null, lastEvent: '', waiting: null, deepLink: null, sessionId: null, cwd: null, bgAgents: 0, toolRunId: null, progress: null, resultUrl: null, error: null, costUsd: null, scheduled: false, ...over }) as AgentRun;

  it('in flight only, waiting on you first; the ETA from progress (elapsed ÷ share done)', () => {
    const b = buildsOf(
      [
        run({ id: 'run_build', state: 'running', startedAt: new Date(NOW - 30 * 60_000).toISOString(), progress: { done: 1, total: 3, label: 'Loading' } }),
        run({ id: 'run_wait', state: 'waiting_on_you' }),
        run({ id: 'run_queued', state: 'queued' }),
        run({ id: 'run_done', state: 'done' }),
        run({ id: 'run_auto', state: 'running', scheduled: true }),
      ],
      new Map(),
      NOW,
      TZ,
    );
    expect(b.map((x) => x.id)).toEqual(['run_wait', 'run_build', 'run_queued']);
    expect(b[0]!.etaLabel).toBe('Needs your answer');
    // started 30 min ago, a third done: 90 min in all, so 60 min from now (16:00Z = 09:00 MT → 10:00)
    expect(b[1]!.eta).toBe(new Date(NOW + 60 * 60_000).toISOString());
    expect(b[1]!.etaLabel).toBe('ETA 10:00');
    expect(b[1]!.progressLabel).toBe('1 of 3 · Loading');
    expect(b[2]!.etaLabel).toBe('Queued');
  });

  it('collapsed when none: the mock world after its runs finish has no rows', () => {
    expect(buildsOf([run({ state: 'done' }), run({ state: 'failed' })], new Map(), NOW, TZ)).toEqual([]);
  });
});

describe('Admin: one quiet row', () => {
  const se = personaOf({}).priority;
  const free = [{ s: NOW, e: NOW + 4 * 3_600_000 }];
  const o = (engine: 'v1' | 'shadow' | 'v2') => ({ engine, config: se, nowMs: NOW, todayEndMs: NOW + 6 * 3_600_000, tz: TZ, todayFree: free, href: '/work?tab=all_open' });

  it('priority@2 shown: the batch ("Admin: 3 items · ~… · next due …"), promoted when one is due within the window', () => {
    const input = inputOf();
    const items = [
      itemLike(input, { id: 'a1', kind: 'task', title: 'Update the VDP for Acme', due: new Date(NOW + 20 * 3_600_000).toISOString() }),
      itemLike(input, { id: 'a2', kind: 'task', title: 'Submit expenses for the onsite', due: null }),
      itemLike(input, { id: 'a3', kind: 'training', title: 'Security awareness', due: new Date(NOW + 9 * 86_400_000).toISOString() }),
      itemLike(input, { id: 'x', kind: 'task', title: 'Build the Acme demo', due: null }),
    ];
    const a = adminOf(items.map((item) => ({ item, youMin: 10 })), o('v2'))!;
    expect(a.mode).toBe('batch');
    expect(a.count).toBe(3);
    expect(a.label).toMatch(/^Admin: 3 items · ~/);
    expect(a.label).toMatch(/next due/);
    expect(a.promoted).toBe(true);
    expect(a.rows.map((r) => r.id).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('priority@1.1 shown (v1 or shadow): the persona’s rules list the items, no batch math', () => {
    const input = inputOf();
    const items = [itemLike(input, { id: 'a1', kind: 'task', title: 'Update the VDP for Acme' }), itemLike(input, { id: 'a3', kind: 'training', title: 'Security awareness' })];
    for (const engine of ['v1', 'shadow'] as const) {
      const a = adminOf(items.map((item) => ({ item, youMin: 10 })), o(engine))!;
      expect(a.mode).toBe('rule');
      expect(a.label).toBe('Admin: 2 items · VDP, trainings');
      expect(a.promoted).toBe(false);
    }
  });

  it('null when nothing is admin; without a persona the default rules (trainings) apply', () => {
    const input = inputOf();
    expect(adminOf([{ item: itemLike(input, { kind: 'task', title: 'Build the demo' }), youMin: 5 }], o('v2'))).toBeNull();
    expect(adminOf([{ item: itemLike(input, { kind: 'training', title: 'Course' }), youMin: 5 }], { ...o('v1'), config: undefined })?.count).toBe(1);
    expect(DEFAULT_PRIORITY_CONFIG.admin.classes.map((c) => c.id)).toEqual(['training']);
  });

  it('with priority@2 shown, admin never takes a Do-now slot and is listed once (the row)', () => {
    const input = inputOf();
    const vdp = itemLike(input, { id: 'w_admin_vdp', kind: 'task', title: 'Update the VDP for Initech', state: 'open', due: input.now, rank: 1, isBackground: false });
    const h = buildHome({ ...input, items: [vdp, ...input.items], priorityEngine: 'v2' });
    expect(h.doNow.cards.some((c) => c.id === vdp.id)).toBe(false);
    expect(h.admin?.mode).toBe('batch');
    expect(h.admin?.rows.some((r) => r.id === vdp.id)).toBe(true);
    for (const s of h.sections) expect(s.rows.some((r) => r.item?.id === vdp.id || r.id === vdp.id), s.id).toBe(false);
  });
});

describe('Overbooked → what to move', () => {
  const to: HomeDayRef = { date: '2026-11-09', label: 'Monday', short: 'Mon 11/9', startsAt: '2026-11-09T15:00:00.000Z' };
  const room = (rows: MakeRoom['rows'], over = 45): MakeRoom => ({ overByMin: over, label: `Overbooked by ${over} min`, rows, freesMin: rows.reduce((s, r) => s + r.youMin, 0) });

  it('names the first row and the day; "Move it" carries the item and version', () => {
    const input = inputOf();
    const w = itemLike(input, { id: 'w_deck', title: 'Umbrella deck', version: 7 });
    const m = moveItOf(room([{ itemId: 'w_deck', title: 'Umbrella deck', youMin: 60, value: 10, needBy: null, reason: 'lowest value · undated' }]), new Map([[w.id, w]]), to)!;
    expect(m.sentence).toBe('Move “Umbrella deck” to Monday to fit.');
    expect(m.item).toEqual({ id: 'w_deck', version: 7 });
    expect(m.covers).toBe(true);
    expect(m.to).toEqual(to);
  });

  it('says how much it frees when one move is not enough', () => {
    const input = inputOf();
    const w = itemLike(input, { id: 'w_deck', title: 'Umbrella deck' });
    const m = moveItOf(room([{ itemId: 'w_deck', title: 'Umbrella deck', youMin: 30, value: 10, needBy: null, reason: '' }], 90), new Map([[w.id, w]]), { ...to, label: 'Tomorrow' })!;
    expect(m.sentence).toBe('Move “Umbrella deck” to tomorrow to fit (frees about 30m of 1h 30m).');
    expect(m.covers).toBe(false);
  });

  it('HM-02 overbooked with nothing movable: no button, a sentence that says what to do instead', () => {
    const m = moveItOf(room([]), new Map(), to)!;
    expect(m.item).toBeNull();
    expect(m.label).toBe('Overbooked by 45 min');
    expect(m.sentence).toMatch(/^Nothing here can move/);
  });

  it('null when the day fits; on the mock world an overbooked day names makeRoom’s first row', () => {
    expect(moveItOf(null, new Map(), to)).toBeNull();
    const input = inputOf();
    const over = buildHome({ ...input, capacity: { ...input.capacity, day: 'today', fits: false, youMinToday: 600, freeMin: 120, openMin: -480 } });
    expect(over.moveIt).not.toBeNull();
    if (over.makeRoom!.rows.length) expect(over.moveIt!.item?.id).toBe(over.makeRoom!.rows[0]!.itemId);
    expect(over.moveIt!.to).toEqual(over.moveTo);
  });
});

describe('closed for you just now, and the empty day', () => {
  it('closedNowOf: engine closes in the last few hours, newest first, with the badge', () => {
    const input = inputOf();
    const closed = (id: string, minsAgo: number, by: 'engine' | 'user' = 'engine') => itemLike(input, { id, state: 'done', doneBy: by, doneAt: new Date(NOW - minsAgo * 60_000).toISOString(), resolution: 'done_by_me', closedReason: 'You sent the deck' });
    const out = closedNowOf([closed('old', 600), closed('a', 30), closed('b', 5), closed('mine', 5, 'user')], NOW);
    expect(out.map((c) => c.id)).toEqual(['b', 'a']);
    expect(out[0]).toMatchObject({ badge: 'Done by you', why: 'You sent the deck' });
  });

  it('watchingOf names the sources being read (the empty-day line)', () => {
    const input = inputOf();
    const names = watchingOf(input.connectors);
    expect(names.length).toBeGreaterThan(0);
    expect(watchingOf(input.connectors.map((c) => ({ ...c, state: 'auth_needed' as const })))).toEqual([]);
  });
});

describe('Do now: the third slot is the drafts card', () => {
  it('two ranked items, then "Approve N drafts" → Review (the Outbox); the payload validates', () => {
    const h = HomePayload.parse(buildHome(inputOf()));
    expect(h.doNow.cards.map((c) => c.kind)).toEqual(['item', 'item', 'outbox']);
    expect(h.doNow.cards[2]!.verb).toMatchObject({ action: 'review', href: '/outbox' });
    expect(h.doNow.cards[2]!.title).toMatch(/^Approve \d+ drafts?$/);
  });

  it('no ready draft: three items', () => {
    const input = inputOf();
    const h = buildHome({ ...input, drafts: input.drafts.filter((d) => d.status !== 'ready') });
    expect(h.doNow.cards.every((c) => c.kind === 'item')).toBe(true);
  });
});
