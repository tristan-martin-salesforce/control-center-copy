/**
 * Done ▾ / Later ▾ (01-ui-audit R6) map onto the existing item verbs without changing the API: each choice is one
 * `itemAction` request the server already accepts (src/server/datasource/*: done, resolve, snooze, not-now).
 */
import { describe, expect, it } from 'vitest';
import { ItemActionRequest } from '@/contract';
import { doneRequest, laterRequest, nextWorkingDayAt9, pickedDayAt9, type DoneChoice, type LaterChoice } from '../item-menus';

const TZ = 'America/Denver';
const FRIDAY_9 = '2026-11-20T16:00:00.000Z'; // Fri 20 Nov 09:00 MST
const WEDNESDAY_9 = '2026-11-18T16:00:00.000Z';

describe('Done ▾', () => {
  it.each<[DoneChoice, unknown]>([
    ['by_me', { verb: 'done', body: {} }],
    ['someone_else', { verb: 'resolve', body: { resolution: 'done_by_other' } }],
    ['not_mine', { verb: 'not-now', body: { reason: 'not_mine' } }],
    ['not_needed', { verb: 'resolve', body: { resolution: 'not_needed' } }],
  ])('%s → the existing verb', (choice, want) => {
    expect(doneRequest(choice)).toEqual(want);
  });

  it('someone else can name who', () => {
    expect(doneRequest('someone_else', { personName: 'Theo Brandt' }).body).toEqual({ resolution: 'done_by_other', detail: { personName: 'Theo Brandt' } });
  });

  it('every body is a valid ItemActionRequest', () => {
    for (const c of ['by_me', 'someone_else', 'not_mine', 'not_needed'] as const) expect(ItemActionRequest.safeParse({ ifVersion: 3, ...doneRequest(c).body }).success).toBe(true);
  });
});

describe('Later ▾', () => {
  it('tomorrow and next week snooze to 09:00 in the profile zone', () => {
    expect(laterRequest('tomorrow', WEDNESDAY_9, TZ)).toEqual({ verb: 'snooze', body: { until: '2026-11-19T16:00:00.000Z' } });
    expect(laterRequest('next_week', WEDNESDAY_9, TZ)).toEqual({ verb: 'snooze', body: { until: '2026-11-23T16:00:00.000Z' } });
  });

  it('not now is not-now · later until the next working day (Friday → Monday)', () => {
    expect(laterRequest('not_now', FRIDAY_9, TZ)).toEqual({ verb: 'not-now', body: { reason: 'later', until: '2026-11-23T16:00:00.000Z' } });
    expect(nextWorkingDayAt9(WEDNESDAY_9, TZ)).toBe('2026-11-19T16:00:00.000Z');
    expect(nextWorkingDayAt9('2026-11-21T18:00:00.000Z', TZ)).toBe('2026-11-23T16:00:00.000Z'); // Saturday
  });

  it('pick a date needs a day after now', () => {
    expect(laterRequest('pick', WEDNESDAY_9, TZ)).toBeNull();
    const at = pickedDayAt9('2026-11-30', WEDNESDAY_9, TZ);
    expect(at).toBe('2026-11-30T16:00:00.000Z');
    expect(laterRequest('pick', WEDNESDAY_9, TZ, at)).toEqual({ verb: 'snooze', body: { until: at } });
    expect(pickedDayAt9('2026-11-01', WEDNESDAY_9, TZ)).toBeNull();
    expect(pickedDayAt9('soon', WEDNESDAY_9, TZ)).toBeNull();
  });

  it('every body is a valid ItemActionRequest', () => {
    for (const c of ['tomorrow', 'next_week', 'not_now'] as LaterChoice[]) expect(ItemActionRequest.safeParse({ ifVersion: 1, ...laterRequest(c, FRIDAY_9, TZ)!.body }).success).toBe(true);
  });
});
