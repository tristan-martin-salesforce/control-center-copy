/**
 * What a calendar event is, from its title and shape: a flight, a hotel stay, an onsite marker, a customer dinner,
 * or a long "marker" block that is never a meeting. Pure; shared by the Calendar fetcher (attendance), the calendar
 * projection and the activity engine so all three agree. The title tests live in `src/lib/event-titles.ts` (so the
 * connector need not import an engine) and are re-exported here under the same names.
 */
import { isFlightTitle, isOnsiteTitle } from '@/lib/event-titles';
export { flightNumber, isDinnerTitle, isFlightTitle, isHomeWord, isHotelTitle, isNonMeetingTitle, isOnsiteTitle } from '@/lib/event-titles';
import { HOUR, localDay, toMs } from './time';

/** Hours an event spans. */
export const spanHours = (startsAt: string, endsAt: string): number => (toMs(endsAt) - toMs(startsAt)) / HOUR;

/** A timed event that ends on a later local day than it starts (an end at exactly midnight stays on its day). */
export function crossesMidnight(startsAt: string, endsAt: string, tz: string): boolean {
  const s = toMs(startsAt);
  const e = toMs(endsAt);
  if (e <= s) return false;
  return localDay(s, tz) !== localDay(e - 1, tz);
}

export const MARKER_MIN_H = 12;
export const ONSITE_MARKER_MIN_H = 8;

/**
 * A marker, never a meeting: a timed event of 12 h or more, or one that crosses local midnight, or an onsite-titled
 * block of 8 h or more. Markers say something about the day (an onsite, a trip); they never become a meeting row.
 * Flights are travel (a red-eye crosses midnight and is still a flight) and all-day events are not timed.
 */
export function isMarkerEvent(ev: { summary: string; startsAt: string; endsAt: string; allDay?: boolean }, tz: string): boolean {
  if (ev.allDay || isFlightTitle(ev.summary)) return false;
  const h = spanHours(ev.startsAt, ev.endsAt);
  if (h >= MARKER_MIN_H) return true;
  if (isOnsiteTitle(ev.summary) && h >= ONSITE_MARKER_MIN_H) return true;
  return crossesMidnight(ev.startsAt, ev.endsAt, tz);
}
