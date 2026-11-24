import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@/contract';
import { loggingGap, overlapBands, overlapCaption, overlapHours, placeBlocks, readbackState, shiftWeek, subRows, weekDays } from '@/components/time/derive';

const entry = (o: Partial<ActivityEntry>): ActivityEntry =>
  ({ id: 'a', version: 1, date: '2026-11-02', start: '2026-11-02T17:00:00.000Z', end: '2026-11-02T18:00:00.000Z', durationH: 1, taskType: 'Demo', oppId: 'o1', oppName: 'Opp', accountName: 'Acct', meetingType: 'CF', description: 'd', status: 'approved', confidence: 'likely', sources: [], userLockedFields: [], issues: [], updatedAt: '2026-11-02T18:00:00.000Z', ...o }) as ActivityEntry;

describe('time derive', () => {
  it('builds Mon..Fri and shifts weeks', () => {
    expect(weekDays('2026-11-02')).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    expect(shiftWeek('2026-11-02', -1)).toBe('2026-10-26');
  });

  it('places blocks in the profile tz, stacks overlaps, splits agent leverage', () => {
    const lanes = [
      {
        id: 'meetings' as const,
        label: 'm',
        blocks: [
          { id: 'a', start: '2026-11-02T17:00:00.000Z', end: '2026-11-02T18:00:00.000Z', label: 'A', activityId: null, hatched: false },
          { id: 'b', start: '2026-11-02T17:30:00.000Z', end: '2026-11-02T18:30:00.000Z', label: 'B', activityId: null, hatched: false },
        ],
      },
      { id: 'claude' as const, label: 'c', blocks: [{ id: 'c', start: '2026-11-02T17:00:00.000Z', end: '2026-11-02T19:00:00.000Z', label: 'C', activityId: null, hatched: true }] },
    ];
    const placed = placeBlocks(lanes, weekDays('2026-11-02'), 'America/Denver');
    expect(placed.find((b) => b.id === 'a')!.startMin).toBe(10 * 60); // MST, UTC-7, on Nov 2 2026
    expect(placed.find((b) => b.id === 'b')!.sub).toBe(1);
    expect(placed.find((b) => b.id === 'c')!.rowId).toBe('leverage');
    expect(subRows(placed).meetings).toBe(2);
    expect(overlapBands(placed, '2026-11-02')).toEqual([[10 * 60 + 30, 11 * 60]]); // leverage never counts
  });

  it('flags unconfirmed and missing read-back', () => {
    const now = '2026-11-05T18:00:00.000Z';
    expect(readbackState(entry({}), now)).toBe('unconfirmed');
    expect(readbackState(entry({ status: 'verified' }), now)).toBeNull();
    // D-65: a row whose fields differ is in Org62; one deleted there is missing
    expect(readbackState(entry({ status: 'verify_failed' }), now)).toBe('differs');
    expect(readbackState(entry({ status: 'verify_failed', issues: ['Org62 check: Deleted in Org62'] }), now)).toBe('deleted');
    expect(readbackState(entry({ end: '2026-11-05T17:00:00.000Z' }), now)).toBeNull();
  });

  it('summarises the logging gap', () => {
    const week = {
      entries: [entry({ durationH: 1.5 }), entry({ id: 'b', durationH: 2 })],
      org62: { lastReadbackAt: null, verified: 0, pending: 2 },
      canvas: { lastSyncedAt: null, rowsChangedSince: 0, confirmRequired: true, label: 'c' },
    };
    expect(loggingGap(week, '2026-11-05T18:00:00.000Z')).toMatchObject({ show: true, unconfirmedH: 3.5, unconfirmedRows: 2 });
  });

  it('says how much of a day overlaps when accepted meetings and an onsite day both log (D-18 amended)', () => {
    const at = (hm: string) => `2026-11-10T${String(Number(hm.slice(0, 2)) + 7).padStart(2, '0')}:${hm.slice(3)}:00.000Z`; // MST
    const row = (from: string, to: string) => entry({ start: at(from), end: at(to) });
    expect(overlapHours([row('09:00', '10:00'), row('09:30', '10:30')])).toBe(0.5);
    expect(overlapCaption([row('08:00', '17:00'), row('12:30', '13:00')])).toBe('includes 0.5 h of overlapping meetings');
    expect(overlapHours([row('08:00', '17:00'), row('09:00', '10:00'), row('09:30', '10:30')])).toBe(2);
    expect(overlapHours([row('09:00', '10:00'), row('10:00', '11:00')])).toBe(0); // back to back is no overlap
    expect(overlapCaption([row('09:00', '10:00'), row('11:00', '12:00')])).toBeNull();
  });
});
