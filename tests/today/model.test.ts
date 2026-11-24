/**
 * P1 Today model: stable ordering under live updates, Claude deep-link intent, the local
 * plan, snooze presets in the profile timezone, pre-emption labels. Placeholder data only.
 */
import { describe, expect, it } from 'vitest';
import type { NowCard, SpineSlot, WorkItem } from '@/contract';
import {
  applyPlan,
  claudeIntent,
  consumeReentries,
  isActionable,
  isFreshArrival,
  preemptLabel,
  reconcileOrder,
  snoozePresets,
  zonedInstant,
} from '@/components/today/model';

describe('reconcileOrder', () => {
  it('takes the server order on first data and on an explicit re-rank', () => {
    expect(reconcileOrder({ prev: null, server: ['a', 'b', 'c', 'd'], max: 3 }).order).toEqual(['a', 'b', 'c']);
    expect(reconcileOrder({ prev: ['a', 'b', 'c'], server: ['c', 'a', 'b'], max: 3, adopt: true }).order).toEqual(['c', 'a', 'b']);
  });

  it('never reorders what is on screen; the difference feeds the re-rank pill', () => {
    const r = reconcileOrder({ prev: ['a', 'b', 'c'], server: ['c', 'a', 'b'], max: 3 });
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.outOfOrder).toBe(3);
  });

  it('frees a slot the user emptied and fills it from the server order', () => {
    const r = reconcileOrder({ prev: ['a', 'b', 'c'], server: ['a', 'c', 'd'], max: 3, removedByUser: new Set(['b']) });
    expect(r.order).toEqual(['a', 'c', 'd']);
    expect(r.added).toEqual(['d']);
  });

  it('holds the item under the cursor when a live update drops it', () => {
    const r = reconcileOrder({ prev: ['a', 'b', 'c'], server: ['a', 'c', 'x'], max: 3, pinned: 'b' });
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.held).toEqual(['b']);
  });

  it('lets the pinned item go when the user removed it', () => {
    const r = reconcileOrder({ prev: ['a', 'b', 'c'], server: ['a', 'c', 'x'], max: 3, pinned: 'b', removedByUser: new Set(['b']) });
    expect(r.order).toEqual(['a', 'c', 'x']);
  });

  it('puts an undone / rolled-back item back where it was', () => {
    const r = reconcileOrder({ prev: ['a', 'c', 'd'], server: ['a', 'b', 'c'], max: 3, restore: new Map([['b', 1]]) });
    expect(r.order).toEqual(['a', 'b', 'c']);
  });

  it('appends arrivals to uncapped lists', () => {
    const r = reconcileOrder({ prev: ['r1', 'r2'], server: ['r0', 'r1', 'r2'] });
    expect(r.order).toEqual(['r1', 'r2', 'r0']);
    expect(r.added).toEqual(['r0']);
  });
});

describe('consumeReentries', () => {
  it('keeps a restore slot through renders that still show the item (popover close before the patch)', () => {
    const restore = new Map([['b', 1]]);
    const removed = new Set(['b']);
    consumeReentries(['a', 'b', 'c'], ['a', 'b', 'c'], restore, removed);
    expect(restore.get('b')).toBe(1);
    consumeReentries(['a', 'c'], ['a', 'c'], restore, removed);
    expect(restore.get('b')).toBe(1);
    // Rolled back: b re-enters and spends its slot.
    const r = reconcileOrder({ prev: ['a', 'c'], server: ['a', 'b', 'c'], max: 3, restore, removedByUser: removed });
    consumeReentries(['a', 'c'], r.order, restore, removed);
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(restore.has('b')).toBe(false);
    expect(removed.has('b')).toBe(false);
  });
});

describe('claudeIntent', () => {
  const session = (deepLink: string | null) => ({ run: { kind: 'claude_session', deepLink } }) as unknown as Pick<NowCard, 'run'>;
  it('opens an existing session directly', () => {
    expect(claudeIntent(session('claude://code/continue?session=local_abc'), null)).toEqual({ kind: 'open', url: 'claude://code/continue?session=local_abc' });
    expect(claudeIntent({ run: null }, 'claude://code/needs-input')).toEqual({ kind: 'open', url: 'claude://code/needs-input' });
  });
  it('asks the server to build and record a new launch otherwise', () => {
    expect(claudeIntent({ run: null }, 'claude://code/new?folder=%2Ftmp&q=x')).toEqual({ kind: 'launch' });
    expect(claudeIntent(session(null), null)).toEqual({ kind: 'launch' });
  });
});

describe('local plan', () => {
  const s = (id: string, kind: SpineSlot['kind'], start: string, end: string, workItemId: string | null = null): SpineSlot => ({ id, kind, start: `2026-11-05T${start}:00.000Z`, end: `2026-11-05T${end}:00.000Z`, label: id, workItemId });
  const slots = [s('w1', 'work', '16:00', '16:30', 'item1'), s('g1', 'gap', '18:00', '19:00'), s('g2', 'gap', '20:00', '20:20')];

  it('moves a work slot into a gap and trims the gap (never the calendar)', () => {
    const out = applyPlan(slots, { moves: { w1: '2026-11-05T18:00:00.000Z' }, fits: {} });
    const w1 = out.find((x) => x.id === 'w1')!;
    expect(w1.start).toBe('2026-11-05T18:00:00.000Z');
    expect(w1.end).toBe('2026-11-05T18:30:00.000Z');
    const g1 = out.find((x) => x.id === 'g1')!;
    expect(g1.start).toBe('2026-11-05T18:30:00.000Z');
    expect(g1.label).toBe('30m gap');
  });

  it('slots a fit-in and removes a gap it fills completely', () => {
    const out = applyPlan(slots, { moves: {}, fits: { t1: { start: '2026-11-05T20:00:00.000Z', end: '2026-11-05T20:20:00.000Z', label: '▶ Training', gapId: 'g2' } } });
    expect(out.some((x) => x.id === 'g2')).toBe(false);
    expect(out.find((x) => x.id === 'fit:t1')?.workItemId).toBe('t1');
  });
});

describe('snooze presets (profile timezone)', () => {
  it('computes wall-clock 09:00 in the zone, across the DST change', () => {
    expect(zonedInstant(2026, 11, 6, 9, 0, 'America/Denver').toISOString()).toBe('2026-11-06T16:00:00.000Z'); // MST
    expect(zonedInstant(2026, 10, 30, 9, 0, 'America/Denver').toISOString()).toBe('2026-10-30T15:00:00.000Z'); // MDT
  });

  it('later today · tomorrow 09:00 · next Monday 09:00', () => {
    const p = snoozePresets('2026-11-05T15:20:00.000Z', 'America/Denver'); // Thu 08:20 MT
    expect(p.map((x) => x.id)).toEqual(['later', 'tomorrow', 'next_week']);
    expect(p[0]!.until).toBe('2026-11-05T18:30:00.000Z');
    expect(p[1]!.until).toBe('2026-11-06T16:00:00.000Z');
    expect(p[2]!.until).toBe('2026-11-09T16:00:00.000Z');
  });
});

const item = (over: Partial<WorkItem>): WorkItem =>
  ({
    id: 'w1',
    state: 'open',
    isBackground: false,
    rank: 1,
    startBy: null,
    due: null,
    createdAt: '2026-11-04T10:00:00.000Z',
    reopened: null,
    loopedBackIn: null,
    ...over,
  }) as WorkItem;

describe('labels and arrivals', () => {
  it('actionable states match the ranker (suggested / done / background stay out)', () => {
    expect(isActionable(item({ state: 'reopened' }))).toBe(true);
    expect(isActionable(item({ state: 'done' }))).toBe(false);
    expect(isActionable(item({ state: 'suggested' }))).toBe(false);
    expect(isActionable(item({ isBackground: true }))).toBe(false);
  });

  it('fresh arrivals: created, reopened or looped back in after the page opened', () => {
    const since = '2026-11-05T15:00:00.000Z';
    expect(isFreshArrival(item({}), since)).toBe(false);
    expect(isFreshArrival(item({ reopened: { reason: 'x', at: '2026-11-05T15:02:00.000Z' } }), since)).toBe(true);
    expect(isFreshArrival(item({ loopedBackIn: { at: '2026-11-05T15:01:00.000Z', byPersonName: 'Dana', evidenceId: null } }), since)).toBe(true);
  });

  it('pre-emption: late unless started now; promotion of a waiting run', () => {
    const now = '2026-11-05T15:20:00.000Z';
    const card = (it: WorkItem, run: NowCard['run'] = null) => ({ item: it, nba: null, draft: null, run, proposals: [] }) as NowCard;
    expect(preemptLabel(card(item({ startBy: '2026-11-05T15:23:00.000Z', due: '2026-11-05T17:00:00.000Z' })), now)?.kind).toBe('preempt');
    expect(preemptLabel(card(item({ startBy: '2026-11-05T16:00:00.000Z' })), now)).toBeNull();
    expect(preemptLabel(card(item({ startBy: '2026-11-05T15:00:00.000Z', due: '2026-11-05T15:10:00.000Z' })), now)).toBeNull();
    const run = { state: 'waiting_on_you', kind: 'claude_session' } as NowCard['run'];
    expect(preemptLabel(card(item({ state: 'waiting_on_me', rank: 6 }), run), now)?.kind).toBe('promoted');
    expect(preemptLabel(card(item({ state: 'waiting_on_me', rank: 1 }), run), now)).toBeNull();
  });
});
