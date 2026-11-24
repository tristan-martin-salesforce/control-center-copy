/**
 * P-LISTS (design v2) pure logic: Work's verb sections, the 3 / 5 section cap, the Outbox sections
 * (sending split out of the contract's groups), and the URL default (verb sections, so /work stays /work).
 */
import { describe, expect, it } from 'vitest';
import { focusSection, groupByFocus, shownCount } from './grouping';
import { outboxSection } from './outbox';
import { departures, reconcileOrder } from './stable-order';
import { DEFAULT_FILTERS, parseWorkFilters, serializeWorkFilters } from './url-filters';

const NOW = '2026-11-05T15:00:00Z'; // 08:00 in America/Denver
const TZ = 'America/Denver';
const item = (id: string, over: Partial<{ state: string; startBy: string | null; due: string | null }> = {}) => ({ id, state: 'open', startBy: null, due: null, ...over });

describe('Work verb sections', () => {
  it('puts late and today-scoped work in Do now (start-by first, else due)', () => {
    expect(focusSection(item('a', { due: '2026-11-05T13:00:00Z' }), NOW, TZ)).toBe('do_now'); // overdue
    expect(focusSection(item('b', { due: '2026-11-06T00:00:00Z' }), NOW, TZ)).toBe('do_now'); // 17:00 today
    expect(focusSection(item('c', { startBy: '2026-11-05T20:00:00Z', due: '2026-11-09T00:00:00Z' }), NOW, TZ)).toBe('do_now');
  });

  it('sends waiting-on-others to Chase whatever the date, and undated work to Fit in', () => {
    expect(focusSection(item('a', { state: 'waiting_on_others', due: '2026-11-05T13:00:00Z' }), NOW, TZ)).toBe('chase');
    expect(focusSection(item('b'), NOW, TZ)).toBe('fit_in');
  });

  it('orders sections Do now → Do this week → Chase → Think ahead → Fit in and drops empty ones', () => {
    const groups = groupByFocus(
      [item('fit'), item('later', { due: '2026-12-01T17:00:00Z' }), item('week', { due: '2026-11-08T17:00:00Z' }), item('now', { due: '2026-11-05T18:00:00Z' }), item('now2', { due: '2026-11-05T19:00:00Z' })],
      NOW,
      TZ,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Due today', ['now', 'now2']],
      ['Do this week', ['week']],
      ['Think ahead', ['later']],
      ['Fit in', ['fit']],
    ]);
  });
});

describe('a row that comes back returns to its place (Undo, rollback)', () => {
  it('records where a departed row sat, and reinserts it there instead of appending it as new', () => {
    const left = departures(['a', 'b', 'c', 'd'], ['a', 'c', 'd']);
    expect([...left]).toEqual([['b', 'c']]);
    expect(reconcileOrder(['a', 'c', 'd', 'x'], ['d', 'b', 'x', 'c', 'a'], { returning: left })).toEqual({ order: ['a', 'b', 'c', 'd', 'x'], added: [] });
  });

  it('a departed last row comes back last; genuinely new rows are still appended and reported', () => {
    const left = departures(['a', 'b'], ['a']);
    expect(left.get('b')).toBeNull();
    expect(reconcileOrder(['a'], ['a', 'n', 'b'], { returning: left })).toEqual({ order: ['a', 'b', 'n'], added: ['n'] });
  });
});

describe('section caps (DESIGN-V2 principle 2)', () => {
  it('shows 3, 5 at 2,400 px, everything when expanded', () => {
    expect(shownCount(10, {})).toBe(3);
    expect(shownCount(10, { wide: true })).toBe(5);
    expect(shownCount(10, { expanded: true })).toBe(10);
    expect(shownCount(2, {})).toBe(2);
  });
});

describe('Outbox sections', () => {
  it('splits sending out of the groups; failed is Retry; scheduled is Going out later', () => {
    expect(outboxSection({ group: 'pending_approval', draft: { status: 'ready' } })).toBe('approve');
    expect(outboxSection({ group: 'sent', draft: { status: 'sending' } })).toBe('sending');
    expect(outboxSection({ group: 'pending_approval', draft: { status: 'sending' } })).toBe('sending');
    expect(outboxSection({ group: 'failed', draft: { status: 'failed' } })).toBe('retry');
    expect(outboxSection({ group: 'scheduled', draft: { status: 'scheduled' } })).toBe('later');
    expect(outboxSection({ group: 'sent', draft: { status: 'verified' } })).toBe('sent');
  });
});

describe('Work URL default', () => {
  it('defaults to the verb sections, and ?group=initiative round-trips', () => {
    expect(DEFAULT_FILTERS.group).toBe('due');
    expect(parseWorkFilters(new URLSearchParams('')).group).toBe('due');
    const f = { ...DEFAULT_FILTERS, group: 'initiative' as const };
    expect(serializeWorkFilters(f)).toBe('group=initiative');
    expect(parseWorkFilters(new URLSearchParams('group=initiative'))).toEqual(f);
  });
});
