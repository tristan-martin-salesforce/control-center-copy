/**
 * P3 · Work list logic: URL filters, grouping, stable order under live updates, bulk planning, snooze presets.
 */
import { describe, expect, it } from 'vitest';
import { applyOrder, reconcileOrder } from '@/components/lists/stable-order';
import { dueBucket, groupByDue, groupByInitiative } from '@/components/lists/grouping';
import { activeFilterCount, clearFilters, DEFAULT_FILTERS, itemsQueryOf, parseWorkFilters, serializeWorkFilters } from '@/components/lists/url-filters';
import { bulkTitle, leavesList, planBulk } from '@/components/lists/bulk';
import { addDays, dayDiff, snoozePresets, ymdIn, zonedInstant } from '@/components/lists/time';
import { withInitiative, withoutItems } from '@/components/lists/cache-patches';
import type { ItemsPayload, WorkItem } from '@/contract';

const TZ = 'America/Denver';
const NOW = '2026-11-05T17:00:00.000Z'; // 10:00 in Denver (MST, UTC-7 after the Nov 1 switch)

const item = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, version: 3, title: `Item ${id}`, due: null, refs: { initiative: null, account: null, opp: null, meeting: null }, ...over }) as unknown as WorkItem;

describe('URL-synced Work filters', () => {
  it('omits defaults, so /work stays /work', () => {
    expect(serializeWorkFilters(DEFAULT_FILTERS)).toBe('');
  });

  it('round-trips every filter', () => {
    const f = { tab: 'asked_of_me', q: 'flex credits', account: 'acc_1', initiative: 'ini_2', source: 'slack', kind: 'ask', group: 'due' } as const;
    const qs = serializeWorkFilters(f);
    expect(parseWorkFilters(new URLSearchParams(qs))).toEqual(f);
  });

  it('falls back to defaults for junk values instead of throwing', () => {
    const f = parseWorkFilters(new URLSearchParams('tab=nonsense&source=fax&kind=zzz&group=sideways'));
    expect(f).toEqual(DEFAULT_FILTERS);
  });

  it('builds the GET /items query from filters (empty search and nulls are left out)', () => {
    expect(itemsQueryOf({ ...DEFAULT_FILTERS, q: '  ', account: null })).toEqual({ tab: 'all_open' });
    expect(itemsQueryOf({ ...DEFAULT_FILTERS, tab: 'done', q: ' initech ', source: 'gmail' })).toEqual({ tab: 'done', q: 'initech', source: 'gmail' });
  });

  it('counts only narrowing filters, and Clear keeps tab and grouping', () => {
    const f = { ...DEFAULT_FILTERS, tab: 'promises' as const, group: 'due' as const, q: 'x', kind: 'task' as const };
    expect(activeFilterCount(f)).toBe(2);
    expect(clearFilters(f)).toMatchObject({ tab: 'promises', group: 'due', q: '', kind: null });
    expect(activeFilterCount(clearFilters(f))).toBe(0);
  });
});

describe('grouping', () => {
  it('buckets by due in the profile timezone', () => {
    // 10:00 MST on Thu 5 Nov.
    expect(dueBucket(null, NOW, TZ)).toBe('none');
    expect(dueBucket('2026-11-05T16:00:00Z', NOW, TZ)).toBe('overdue'); // 09:00 today, already past
    expect(dueBucket('2026-11-06T00:00:00Z', NOW, TZ)).toBe('today'); // 17:00 today
    expect(dueBucket('2026-11-06T16:00:00Z', NOW, TZ)).toBe('tomorrow');
    expect(dueBucket('2026-11-09T16:00:00Z', NOW, TZ)).toBe('this_week');
    expect(dueBucket('2026-11-20T16:00:00Z', NOW, TZ)).toBe('later');
  });

  it('a late-evening UTC due is still "today" for a Denver user', () => {
    // 2026-11-06T05:30Z is 22:30 on the 5th in Denver.
    expect(dueBucket('2026-11-06T05:30:00Z', NOW, TZ)).toBe('today');
  });

  it('groups by due in a fixed order and drops empty buckets', () => {
    const groups = groupByDue(
      [item('a', { due: '2026-11-20T16:00:00Z' }), item('b', { due: null }), item('c', { due: '2026-11-05T16:00:00Z' }), item('d', { due: '2026-11-06T00:00:00Z' })],
      NOW,
      TZ,
    );
    expect(groups.map((g) => g.label)).toEqual(['Overdue', 'Today', 'Later', 'No date']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['c']);
  });

  it('groups by initiative in first-appearance (rank) order, "No initiative" last', () => {
    const ini = (id: string, label: string) => ({ type: 'initiative' as const, id, label });
    const groups = groupByInitiative([
      item('a', { refs: { initiative: null } }),
      item('b', { refs: { initiative: ini('i2', 'Beta') } }),
      item('c', { refs: { initiative: ini('i1', 'Alpha') } }),
      item('d', { refs: { initiative: ini('i2', 'Beta') } }),
    ]);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Beta', ['b', 'd']],
      ['Alpha', ['c']],
      ['No initiative', ['a']],
    ]);
    expect(groups[0]!.entityId).toBe('i2');
    expect(groups[2]!.entityId).toBeNull();
  });
});

describe('nothing moves under your cursor', () => {
  it('first data takes the server order', () => {
    expect(reconcileOrder([], ['a', 'b', 'c'])).toEqual({ order: ['a', 'b', 'c'], added: [] });
  });

  it('keeps rows where they are when the server re-ranks, and appends new ones', () => {
    const r = reconcileOrder(['a', 'b', 'c'], ['c', 'x', 'a', 'b']);
    expect(r.order).toEqual(['a', 'b', 'c', 'x']);
    expect(r.added).toEqual(['x']);
  });

  it('drops rows that vanished without disturbing the rest', () => {
    expect(reconcileOrder(['a', 'b', 'c'], ['c', 'a']).order).toEqual(['a', 'c']);
  });

  it('a new tab or filter (initial) resets to the server order', () => {
    expect(reconcileOrder(['a', 'b'], ['b', 'a', 'c'], { initial: true })).toEqual({ order: ['b', 'a', 'c'], added: [] });
  });

  it('applyOrder puts unknown ids last', () => {
    expect(applyOrder([{ id: 'z' }, { id: 'b' }, { id: 'a' }], ['a', 'b']).map((x) => x.id)).toEqual(['a', 'b', 'z']);
  });
});

describe('bulk edit planning (explicit Apply)', () => {
  const items = [item('a'), item('b')];

  it('done sends one request per item with that item\'s own ifVersion', () => {
    const reqs = planBulk({ kind: 'done' }, [item('a', { version: 2 }), item('b', { version: 7 })]);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ route: 'itemAction', id: 'a', input: { params: { id: 'a', verb: 'done' }, body: { ifVersion: 2 } } });
    expect(reqs[1]).toMatchObject({ input: { body: { ifVersion: 7 } } });
  });

  it('snooze carries the wake time; resolve carries the resolution', () => {
    expect(planBulk({ kind: 'snooze', until: '2026-11-06T16:00:00Z' }, items)[0]).toMatchObject({ input: { params: { verb: 'snooze' }, body: { until: '2026-11-06T16:00:00Z' } } });
    expect(planBulk({ kind: 'resolve', resolution: 'not_needed' }, items)[1]).toMatchObject({ input: { params: { verb: 'resolve' }, body: { resolution: 'not_needed' } } });
  });

  it('move patches the initiative (null removes it)', () => {
    expect(planBulk({ kind: 'move', initiative: { id: 'ini_x', label: 'X' } }, items)[0]).toMatchObject({ route: 'patchItem', input: { body: { patch: { initiativeId: 'ini_x' } } } });
    expect(planBulk({ kind: 'move', initiative: null }, items)[0]).toMatchObject({ input: { body: { patch: { initiativeId: null } } } });
  });

  it('says what happened, and which ops take rows out of the list', () => {
    expect(bulkTitle({ kind: 'done' }, 3)).toBe('Marked 3 items done');
    expect(bulkTitle({ kind: 'resolve', resolution: 'declined' }, 1)).toBe('Resolved 1 item');
    expect(bulkTitle({ kind: 'move', initiative: { id: 'i', label: 'Alpha' } }, 2)).toBe('Moved 2 items to Alpha');
    expect(leavesList({ kind: 'done' })).toBe(true);
    expect(leavesList({ kind: 'move', initiative: null })).toBe(false);
  });
});

describe('optimistic list patches', () => {
  const payload = { tab: 'all_open', items: [item('a'), item('b'), item('c')], counts: { all_open: 3, done: 1 }, total: 3 } as unknown as ItemsPayload;

  it('removes items and keeps total and the tab count honest', () => {
    const next = withoutItems(payload, new Set(['a', 'c']));
    expect(next.items.map((i) => i.id)).toEqual(['b']);
    expect(next.total).toBe(1);
    expect(next.counts.all_open).toBe(1);
    expect(payload.items).toHaveLength(3); // never mutates the cached payload (rollback depends on it)
  });

  it('is a no-op (same object) when nothing matches', () => {
    expect(withoutItems(payload, new Set(['zzz']))).toBe(payload);
  });

  it('moves items to an initiative chip', () => {
    const next = withInitiative(payload, new Set(['b']), { id: 'ini_9', label: 'Nine' });
    expect(next.items[1]!.refs.initiative).toMatchObject({ id: 'ini_9', label: 'Nine' });
    expect(next.items[0]!.refs.initiative).toBeNull();
  });
});

describe('time helpers (profile timezone, DST-safe)', () => {
  it('reads the calendar day in the zone, not UTC', () => {
    expect(ymdIn('2026-11-06T05:30:00Z', TZ)).toBe('2026-11-05');
    expect(dayDiff('2026-11-05T17:00:00Z', '2026-11-06T16:00:00Z', TZ)).toBe(1);
  });

  it('finds the instant a wall clock reads in the zone', () => {
    // 09:00 MST on 6 Nov = 16:00Z; 09:00 MDT on 6 Oct = 15:00Z.
    expect(zonedInstant('2026-11-06', 9, 0, TZ).toISOString()).toBe('2026-11-06T16:00:00.000Z');
    expect(zonedInstant('2026-10-06', 9, 0, TZ).toISOString()).toBe('2026-10-06T15:00:00.000Z');
  });

  it('adds days across month ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });

  it('offers later today only while it is ahead, then tomorrow and next Monday', () => {
    const morning = snoozePresets(NOW, TZ); // 10:00 Thu
    expect(morning.map((p) => p.id)).toEqual(['later_today', 'tomorrow', 'next_week']);
    expect(morning[0]!.until).toBe('2026-11-06T00:00:00.000Z'); // 17:00 MST
    expect(morning[2]!.until).toBe('2026-11-09T16:00:00.000Z'); // Mon 9 Nov 09:00
    const evening = snoozePresets('2026-11-06T02:00:00Z', TZ); // 19:00 Thu
    expect(evening.map((p) => p.id)).toEqual(['tomorrow', 'next_week']);
  });

  it('"next week" from a Monday is the following Monday, not today', () => {
    const mon = snoozePresets('2026-11-09T17:00:00Z', TZ);
    expect(mon.find((p) => p.id === 'next_week')!.until).toBe('2026-11-16T16:00:00.000Z');
  });
});
