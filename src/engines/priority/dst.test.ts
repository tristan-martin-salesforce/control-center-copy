/**
 * W0-11 (wave-0 review): the late grace day counts working minutes in the persona's IANA zone, so a DST change
 * between the deadline and now does not shift the grace boundary by an hour. US DST ends Sun 1 Nov 2026 (Denver:
 * MDT −6 → MST −7). Hours 09:00–17:00 Mon–Fri; a hard deadline at Fri 30 Oct 17:00 MDT keeps its grace all Monday.
 */
import { describe, expect, it } from 'vitest';

import type { WorkingHours } from '@/engines/types';

import { workingMinutesBetween, workingWindows } from './time';
import { lateState } from './why';

const TZ = 'America/Denver';
const BASE = { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] };
const MST = -420; // the fixed offset the data layer computes at "now" (Monday, after the change)
const zoned: WorkingHours = { ...BASE, utcOffsetMinutes: MST, timeZone: TZ };
const fixed: WorkingHours = { ...BASE, utcOffsetMinutes: MST };

const DEADLINE = Date.parse('2026-10-30T23:00:00.000Z'); // Fri 17:00 MDT, the end of Friday's working day
const MON_1630 = Date.parse('2026-11-02T23:30:00.000Z'); // Mon 16:30 MST
const MON_1710 = Date.parse('2026-11-03T00:10:00.000Z'); // Mon 17:10 MST

describe('grace day across a DST change (W0-11)', () => {
  it('working windows follow the zone: Friday ends 23:00Z (MDT), Monday starts 16:00Z (MST)', () => {
    const w = workingWindows(zoned, Date.parse('2026-10-30T15:00:00.000Z'), 4);
    expect(w).toEqual([
      { start: '2026-10-30T15:00:00.000Z', end: '2026-10-30T23:00:00.000Z' },
      { start: '2026-11-02T16:00:00.000Z', end: '2026-11-03T00:00:00.000Z' },
    ]);
  });

  it('Monday 16:30 is still in the grace day (450 working minutes since the deadline, not 510)', () => {
    expect(workingMinutesBetween(DEADLINE, MON_1630, zoned)).toBe(450);
    expect(lateState(DEADLINE, MON_1630, 'hard', zoned)!.kind).toBe('grace');
    // the old fixed-offset math counted a phantom hour on Friday and flipped to late an hour early
    expect(workingMinutesBetween(DEADLINE, MON_1630, fixed)).toBe(510);
    expect(lateState(DEADLINE, MON_1630, 'hard', fixed)!.kind).toBe('late');
  });

  it('after Monday 17:00 it is late', () => {
    expect(lateState(DEADLINE, MON_1710, 'hard', zoned)!.kind).toBe('late');
  });

  it('without a DST change the zone and the fixed offset agree; an unknown zone falls back to the offset', () => {
    const now = Date.parse('2026-11-12T20:00:00.000Z');
    const a = workingWindows(zoned, now, 7);
    expect(a).toEqual(workingWindows(fixed, now, 7));
    expect(workingWindows({ ...fixed, timeZone: 'Not/AZone' }, now, 7)).toEqual(a);
  });
});
