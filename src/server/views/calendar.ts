/**
 * Calendar, read side (R7 step 3): a window of meetings and slots, and one meeting with its prep.
 */
import { endOfDay, startOfDay } from 'date-fns';

import type { RouteInput, RouteOutput } from '@/contract';
import { eventDetail, type EventDetailInput } from '@/server/calendar/detail';
import { notFound } from '@/server/errors';

import type { ReadSource } from './source';

/** The asked-for window, else today (local midnight to the last millisecond of the day). */
export function windowOrToday(now: Date, from?: string, to?: string): { from: Date; to: Date } {
  return { from: from ? new Date(from) : startOfDay(now), to: to ? new Date(to) : endOfDay(now) };
}

/** GET /calendar. */
export function calendarView(src: ReadSource, query: RouteInput<'getCalendar'>['query'], now: Date): RouteOutput<'getCalendar'> {
  const { from, to } = windowOrToday(now, query.from, query.to);
  const within = (s: string) => Date.parse(s) >= from.getTime() && Date.parse(s) <= to.getTime();
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    events: src.all('events').filter((e) => within(e.start)).sort((a, b) => a.start.localeCompare(b.start)),
    slots: src.all('slots').filter((s) => within(s.start)).sort((a, b) => a.start.localeCompare(b.start)),
  };
}

/** GET /calendar/:id. `readInOf` is the store's read-in for the meeting (read only once the meeting exists). */
export async function calendarEventView(src: ReadSource, id: string, readInOf: (eventId: string) => Promise<EventDetailInput['readIn']>): Promise<RouteOutput<'getCalendarEvent'>> {
  const ev = src.get('events', id);
  if (!ev) throw notFound('Event', id);
  const readIn = await readInOf(ev.id);
  return eventDetail(ev, {
    items: src.all('workItems'),
    account: ev.accountId ? src.get('accounts', ev.accountId) : null,
    opp: ev.oppId ? src.get('opps', ev.oppId) : null,
    readIn,
  });
}
