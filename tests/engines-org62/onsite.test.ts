/**
 * Onsite days and travel (onsite lane). Placeholder data only: ACME, example.com domains, CITY placeholders.
 *
 * The trip mirrors the shape that broke: an evening flight out, two hotel bookings of one stay, an all-day onsite
 * event and a timed 48 h "Onsite with ACME" block, a 10:00–15:00 session, a customer dinner at a restaurant whose
 * name contains "Flight", an onsite morning of two overlapping sessions, and the flight home entered twice.
 * Profile zone America/Denver (MDT in late October); the trip is in America/New_York (EDT).
 */
import { describe, expect, it } from 'vitest';

import type { CalendarEvidence, EvidenceBundle } from '@/engines/activity/types';
import { crossesMidnight, isFlightTitle, isMarkerEvent } from '@/engines/activity/event-kinds';
import { detectOnsite, groupFlights } from '@/engines/activity/onsite';
import { flightDestination, isPhysicalLocation, placeOf } from '@/engines/activity/places';
import { localDay, toMs } from '@/engines/activity/time';
import { proposeActivity, splitAtMidnight } from '@/engines/activity/propose';
import { CFG, MAPPINGS, OPP_ACME, cal } from '../fixtures/org62/activity';

const TZ = 'America/Denver';
const EMPTY: EvidenceBundle = { calendar: [], claude: [], drive: [], slack: [], git: [] };
/** Mountain (MDT, UTC-6) wall clock on 2026-10-DD → ISO. */
const mt = (dd: string, hm: string) => new Date(Date.parse(`2026-10-${dd}T${hm}:00-06:00`)).toISOString();
const NOW = '2026-11-05T18:00:00Z';
const CITY_ADDR = '100 Example Road Northeast, Atlanta, GA 30305, USA';

const allDay = (id: string, summary: string, from: string, to: string, extra: Partial<CalendarEvidence> = {}): CalendarEvidence =>
  cal({ id, summary, startsAt: mt(from.slice(8), '00:00'), endsAt: mt(to.slice(8), '00:00'), allDay: true, allDayFrom: from, allDayTo: to, organizerSelf: true, attendeeDomains: [], ...extra });

/** The trip, week of Mon 2026-10-26. */
function trip(): CalendarEvidence[] {
  return [
    // Tue: remote morning, evening flight out (Mountain), hotel bookings Tue–Thu (two of them)
    cal({ id: 'tue-call', summary: 'ACME weekly sync', startsAt: mt('27', '13:30'), endsAt: mt('27', '14:00') }),
    cal({ id: 'out', summary: 'Flight to Atlanta (UA 100)', startsAt: mt('27', '17:50'), endsAt: mt('27', '20:50'), organizerSelf: true, attendeeDomains: [], location: 'Denver DEN' }),
    allDay('hotel-1', 'Stay at Example Suites Atlanta', '2026-10-27', '2026-10-30', { location: CITY_ADDR }),
    allDay('hotel-2', 'Stay at EXAMPLE SUITES ATLANTA', '2026-10-27', '2026-10-30'),
    allDay('wl', 'Denver', '2026-10-28', '2026-10-29'),
    // Wed: all-day onsite + a 48 h timed marker + the session + the dinner
    allDay('onsite-allday', 'ACME Onsite', '2026-10-28', '2026-10-30'),
    cal({ id: 'marker', summary: 'Onsite with ACME', startsAt: mt('28', '00:00'), endsAt: mt('30', '00:00'), organizerSelf: true, attendeeDomains: [] }),
    cal({ id: 'session', summary: 'ACME - customer event', startsAt: mt('28', '10:00'), endsAt: mt('28', '15:00'), attendeeDomains: ['acme.example', 'corp.example'] }),
    cal({ id: 'dinner', summary: 'Hosted Dinner - Example Flight Club [In-person]', startsAt: mt('28', '16:00'), endsAt: mt('28', '18:00'), attendeeDomains: ['acme.example', 'corp.example'], location: '200 Example Street NW, Atlanta, GA 30318' }),
    // Thu: two overlapping morning sessions at the customer, then the flight home entered twice
    cal({ id: 'thu-a', summary: 'ACME analytics day', startsAt: mt('29', '06:30'), endsAt: mt('29', '10:30'), attendeeDomains: ['acme.example'], location: `${CITY_ADDR}, Atlanta-Tower-1-C1 (8)` }),
    cal({ id: 'thu-b', summary: 'Analytics day, room 2', startsAt: mt('29', '07:30'), endsAt: mt('29', '10:30'), attendeeDomains: ['acme.example'], location: 'Atlanta-Tower-2-C2 (8) [Google Meet]' }),
    cal({ id: 'home-1', summary: 'Flight to Denver International Airport (UA 200)', startsAt: mt('29', '14:39'), endsAt: mt('29', '18:10'), organizerSelf: true, attendeeDomains: [], location: 'Hartsfield-Jackson Atlanta International Airport ATL' }),
    cal({ id: 'home-2', summary: 'Flight to Denver (UA 200)', startsAt: mt('29', '14:39'), endsAt: mt('29', '18:10'), organizerSelf: true, attendeeDomains: [], location: 'Atlanta ATL' }),
    // Fri: remote
    cal({ id: 'fri-call', summary: 'ACME follow up', startsAt: mt('30', '08:00'), endsAt: mt('30', '08:30') }),
  ];
}

const WEEK = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const plan = (calendar = trip(), extra: Partial<Parameters<typeof proposeActivity>[0]> = {}) =>
  proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: { ...EMPTY, calendar }, onsiteDays: WEEK, ...extra });
/** The original D-18 (Settings ▸ Time ▸ Overlapping meetings: Count overlapping time once). */
const ONCE = { cfg: { ...CFG, overlaps: 'count_once' as const } };

const counted = (p: ReturnType<typeof plan>) => p.entries.filter((e) => !['excluded', 'dismissed', 'dropped'].includes(e.status));
const dayOf = (iso: string) => localDay(toMs(iso), TZ);
const hoursOn = (p: ReturnType<typeof plan>, day: string) => counted(p).filter((e) => dayOf(e.startsAt) === day).reduce((s, e) => s + e.durationHours, 0);

describe('calendar kinds', () => {
  it('a flight is a flight number or "Flight to …", never the bare word', () => {
    expect(isFlightTitle('Flight to Atlanta (UA 100)')).toBe(true);
    expect(isFlightTitle('DL 2231 DEN → ATL')).toBe(true);
    expect(isFlightTitle('Hosted Dinner - Example Flight Club [In-person]')).toBe(false);
    expect(isFlightTitle('Q4 2026 planning')).toBe(false);
  });

  it('a timed event of 12 h or more, or one across midnight, is a marker (flights and all-day are not)', () => {
    expect(isMarkerEvent({ summary: 'Onsite with ACME', startsAt: mt('28', '00:00'), endsAt: mt('30', '00:00') }, TZ)).toBe(true);
    expect(isMarkerEvent({ summary: 'Conference', startsAt: mt('28', '07:00'), endsAt: mt('28', '19:00') }, TZ)).toBe(true);
    expect(isMarkerEvent({ summary: 'Late call', startsAt: mt('28', '23:00'), endsAt: mt('29', '00:30') }, TZ)).toBe(true);
    expect(isMarkerEvent({ summary: 'Ends at midnight', startsAt: mt('28', '22:00'), endsAt: mt('29', '00:00') }, TZ)).toBe(false);
    expect(isMarkerEvent({ summary: 'Red-eye UA 100', startsAt: mt('28', '23:00'), endsAt: mt('29', '06:00') }, TZ)).toBe(false);
    expect(isMarkerEvent({ summary: 'Customer session', startsAt: mt('28', '10:00'), endsAt: mt('28', '15:00') }, TZ)).toBe(false);
    expect(crossesMidnight(mt('28', '16:00'), mt('28', '18:00'), TZ)).toBe(false);
  });

  it('reads places: addresses, airports, rooms; video links are not physical', () => {
    expect(placeOf(CITY_ADDR)).toMatchObject({ city: 'Atlanta', timezone: 'America/New_York', via: 'address' });
    expect(placeOf('Atlanta ATL')).toMatchObject({ city: 'Atlanta', timezone: 'America/New_York', via: 'airport' });
    expect(placeOf('Atlanta-Tower-2-C2 (8) [Google Meet]')).toMatchObject({ city: 'Atlanta', via: 'room' });
    expect(flightDestination('Flight to Denver International Airport (UA 200)').city).toBe('Denver');
    expect(isPhysicalLocation('Microsoft Teams Meeting')).toBe(false);
    expect(isPhysicalLocation(CITY_ADDR)).toBe(true);
  });

  it('splits at local midnight', () => {
    const parts = splitAtMidnight({ start: toMs(mt('28', '22:00')), end: toMs(mt('29', '02:00')) }, TZ);
    expect(parts.map((p) => [dayOf(new Date(p.start).toISOString()), (p.end - p.start) / 3_600_000])).toEqual([
      ['2026-10-28', 2],
      ['2026-10-29', 2],
    ]);
  });
});

describe('trips and onsite days', () => {
  it('builds one trip from the flights and hotel: city and zone from the hotel, account from the onsite events', () => {
    const r = detectOnsite({ days: WEEK, tz: TZ, cfg: CFG.onsite ?? { enabled: true, hours: { start: '08:00', end: '17:00' }, airportBufferMin: 60, dinnersCustomerFacing: true }, events: trip(), mappings: MAPPINGS });
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]).toMatchObject({ fromDay: '2026-10-27', toDay: '2026-10-29', city: 'Atlanta', timezone: 'America/New_York', accountKey: 'acme', whatId: OPP_ACME });
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-28', '2026-10-29']); // Tue lands at night: not onsite
    const wed = r.days[0]!;
    expect(wed.hoursLabel).toMatch(/^08:00–17:00 EDT/);
    expect(wed.signals.find((s) => s.kind === 'working_location')).toMatchObject({ used: false });
    expect(wed.signals.find((s) => s.kind === 'working_location')!.label).toMatch(/ignored/);
  });

  it('merges duplicate flights: one Travel row, the other listed as a duplicate', () => {
    expect(groupFlights(trip()).map((f) => f.ids.length)).toEqual([1, 2]);
    const p = plan();
    const travel = counted(p).filter((e) => e.seTaskType === 'Travel');
    expect(travel.map((e) => dayOf(e.startsAt))).toEqual(['2026-10-27', '2026-10-29']);
    expect(p.rejected.filter((r) => r.reason === 'duplicate')).toHaveLength(1);
  });

  it('logs travel on the trip account, 2 h before the flight and 1 h after it (2026-11-14), not remote', () => {
    const p = plan();
    const home = counted(p).find((e) => e.seTaskType === 'Travel' && dayOf(e.startsAt) === '2026-10-29')!;
    // the flight 14:39–18:10 MT: from 12:39 to 19:10
    expect(home.startsAt).toBe(new Date(Date.parse(mt('29', '12:39'))).toISOString().replace('.000', ''));
    expect(home.durationHours).toBe(6.5);
    expect(home).toMatchObject({ whatOrg62Id: OPP_ACME, remote: false, customerRelated: true, customerFacing: false });
  });

  // D-18 amended: the onsite day logs in full (08:00–17:00 EDT = 06:00–15:00 MT) and the session inside it logs too.
  it('Wed: the 48 h block is a marker; the frame logs the whole 08:00–17:00 EDT and the session logs too; the dinner is customer-facing', () => {
    const p = plan();
    expect(p.rejected.find((r) => r.dedupeKey.includes('|marker|'))?.reason).toBe('placeholder');
    const wed = counted(p).filter((e) => dayOf(e.startsAt) === '2026-10-28');
    const frame = wed.filter((e) => e.dedupeKey.startsWith('onsite|'));
    expect(frame).toHaveLength(1);
    expect([frame[0]!.startsAt, frame[0]!.endsAt]).toEqual([mt('28', '06:00').replace('.000', ''), mt('28', '15:00').replace('.000', '')]);
    const dinner = wed.find((e) => /Dinner/.test(e.subject))!;
    expect(dinner).toMatchObject({ seTaskType: 'Customer Discovery', customerFacing: true, remote: false, whatOrg62Id: OPP_ACME });
    expect(hoursOn(p, '2026-10-28')).toBe(9 + 5 + 2);
    expect(wed.every((e) => e.remote === false && e.whatOrg62Id === OPP_ACME)).toBe(true);
    // 16 h of real events: no hour caps (2026-11-14), so nothing is flagged, trimmed or dropped
    expect(wed.flatMap((e) => e.flags).some((f) => /cap/.test(f))).toBe(false);
  });

  it('Wed, count once: the frame fills only the gaps around the session', () => {
    const p = plan(trip(), ONCE);
    const frame = counted(p).filter((e) => dayOf(e.startsAt) === '2026-10-28' && e.dedupeKey.startsWith('onsite|'));
    expect(frame.map((e) => [e.startsAt, e.endsAt])).toEqual([[mt('28', '06:00').replace('.000', ''), mt('28', '10:00').replace('.000', '')]]);
    expect(hoursOn(p, '2026-10-28')).toBe(4 + 5 + 2);
  });

  it('Thu: the onsite morning ends at the last session (you flew home); both overlapping sessions log', () => {
    const p = plan();
    const thu = counted(p).filter((e) => dayOf(e.startsAt) === '2026-10-29');
    expect(thu.filter((e) => e.dedupeKey.startsWith('onsite|')).map((e) => e.durationHours)).toEqual([4.5]); // 06:00–10:30 MT
    const b = p.entries.find((e) => e.dedupeKey.includes('|thu-b|'))!;
    expect(b).toMatchObject({ status: 'proposed', excludedReason: null, durationHours: 3 });
    expect(b.flags).toContain("overlaps 'ACME analytics day' 07:30–10:30 (both log)");
    expect(hoursOn(p, '2026-10-29')).toBe(4.5 + 4 + 3 + 6.5);
  });

  it('Thu, count once: the morning fills the gap before the sessions; overlapping sessions count once', () => {
    const p = plan(trip(), ONCE);
    const thu = counted(p).filter((e) => dayOf(e.startsAt) === '2026-10-29');
    expect(thu.filter((e) => e.dedupeKey.startsWith('onsite|')).map((e) => e.durationHours)).toEqual([0.5]); // 06:00–06:30 MT
    expect(p.entries.find((e) => e.dedupeKey.includes('|thu-b|'))).toMatchObject({ status: 'excluded', excludedReason: 'overlap' });
    expect(hoursOn(p, '2026-10-29')).toBe(0.5 + 4 + 6.5);
  });

  it('count once: rows never overlap', () => {
    const rows = counted(plan(trip(), ONCE)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < rows.length; i++) expect(toMs(rows[i]!.startsAt)).toBeGreaterThanOrEqual(toMs(rows[i - 1]!.endsAt));
  });

  it('only real events overlap (meetings, the onsite frame); the wall clock never double counts and never runs overnight', () => {
    const p = plan();
    const rows = counted(p);
    for (const a of rows)
      for (const b of rows)
        if (a !== b && toMs(a.startsAt) < toMs(b.endsAt) && toMs(b.startsAt) < toMs(a.endsAt)) {
          expect([a.origin, b.origin]).toEqual(['calendar', 'calendar']);
          expect([a, b].some((e) => e.seTaskType === 'Travel')).toBe(false); // travel still yields
        }
    const blocks = p.blocks.filter((b) => b.countsAsHumanHours).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < blocks.length; i++) expect(toMs(blocks[i]!.startsAt)).toBeGreaterThanOrEqual(toMs(blocks[i - 1]!.endsAt));
    for (const b of blocks) expect(dayOf(b.startsAt)).toBe(localDay(toMs(b.endsAt) - 1, TZ));
    // the old failure: 30.5 h of counted blocks on the Wednesday
    const wed = blocks.filter((b) => b.localDay === '2026-10-28').reduce((s, b) => s + (toMs(b.endsAt) - toMs(b.startsAt)) / 3_600_000, 0);
    expect(wed).toBe(11);
  });

  it('remote days are unchanged by the trip', () => {
    const p = plan();
    expect(hoursOn(p, '2026-10-30')).toBe(0.5);
    expect(counted(p).find((e) => e.dedupeKey.includes('|fri-call|'))).toMatchObject({ remote: true, tripKey: null });
  });
});

describe('corrections and settings', () => {
  it('Not onsite drops the frame (travel stays); Adjust hours sets it; Change account moves the whole trip', () => {
    const not = plan(trip(), { onsiteOverrides: { days: [{ day: '2026-10-28', onsite: false, at: NOW }], trips: [] } });
    expect(counted(not).some((e) => e.dedupeKey === 'onsite|2026-10-28')).toBe(false);
    expect(not.onsite.find((d) => d.day === '2026-10-28')).toMatchObject({ status: 'not_onsite', locked: true });
    expect(counted(not).filter((e) => e.seTaskType === 'Travel')).toHaveLength(2);

    const hrs = plan(trip(), { onsiteOverrides: { days: [{ day: '2026-10-28', onsite: true, hours: { start: '09:00', end: '12:00' }, at: NOW }], trips: [] } });
    const f = counted(hrs).filter((e) => e.dedupeKey.startsWith('onsite|2026-10-28'));
    expect(f.map((e) => [e.startsAt, e.durationHours])).toEqual([[mt('28', '07:00').replace('.000', ''), 3]]); // 09:00–12:00 EDT

    const moved = plan(trip(), { onsiteOverrides: { days: [{ day: '2026-10-29', onsite: true, accountKey: 'globex', at: NOW }], trips: [] } });
    expect(moved.trips[0]).toMatchObject({ accountKey: 'globex' });
    expect(counted(moved).filter((e) => e.dedupeKey.startsWith('onsite|')).every((e) => e.accountKey === 'globex')).toBe(true);
  });

  it('Mark trip makes a remote stretch onsite at one account', () => {
    const cal1 = [cal({ id: 'mon', summary: 'Kickoff', startsAt: mt('26', '09:00'), endsAt: mt('26', '10:00'), attendeeDomains: ['initech.example'] })];
    const p = plan(cal1, { onsiteOverrides: { days: [], trips: [{ id: 't', from: '2026-10-26', to: '2026-10-26', accountKey: 'initech', at: NOW }] } });
    expect(p.onsite).toHaveLength(1);
    expect(p.onsite[0]).toMatchObject({ day: '2026-10-26', status: 'confirmed', locked: true, accountKey: 'initech' });
    expect(p.onsite[0]!.signals[0]).toMatchObject({ kind: 'correction', used: true });
    expect(hoursOn(p, '2026-10-26')).toBe(9 + 1); // 08:00–17:00 MT: the whole frame + the 1 h kickoff (D-18 amended)
    expect(hoursOn(plan(cal1, { ...ONCE, onsiteOverrides: { days: [], trips: [{ id: 't', from: '2026-10-26', to: '2026-10-26', accountKey: 'initech', at: NOW }] } }), '2026-10-26')).toBe(9); // count once: gaps 8 h + 1 h
  });

  it('dinners can be turned off; detection can be turned off (corrections still apply)', () => {
    const off = plan(trip(), { cfg: { ...CFG, onsite: { enabled: true, hours: { start: '08:00', end: '17:00' }, airportBufferMin: 0, dinnersCustomerFacing: false } } });
    expect(off.entries.find((e) => /Dinner/.test(e.subject))).toMatchObject({ status: 'excluded', excludedReason: 'neither_type' });
    expect(counted(off).find((e) => e.seTaskType === 'Travel' && dayOf(e.startsAt) === '2026-10-29')!.durationHours).toBe(3.5);
    const noDetect = plan(trip(), { cfg: { ...CFG, onsite: { enabled: false, hours: { start: '08:00', end: '17:00' }, airportBufferMin: 60, dinnersCustomerFacing: true } } });
    expect(noDetect.onsite).toHaveLength(0);
    expect(counted(noDetect).some((e) => e.dedupeKey.startsWith('onsite|'))).toBe(false);
  });

  it('a trip with no account is a question, never hours', () => {
    const anon = trip().filter((e) => !['onsite-allday', 'marker', 'session', 'dinner', 'thu-a', 'thu-b'].includes(e.id));
    const p = plan(anon);
    expect(p.onsite.map((d) => [d.day, d.accountKey, d.frame])).toEqual([
      ['2026-10-28', null, null],
      ['2026-10-29', null, null],
    ]);
    expect(counted(p).some((e) => e.dedupeKey.startsWith('onsite|'))).toBe(false);
  });
});
