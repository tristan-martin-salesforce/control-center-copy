/** Calendar. */
import type { In, Out } from './route';

export interface CalendarSource {
  getCalendar(i: In<'getCalendar'>): Out<'getCalendar'>;
  /** One meeting with its prep items, account / opp names and read-in state (the hover card, the meeting panel). */
  getCalendarEvent(i: In<'getCalendarEvent'>): Out<'getCalendarEvent'>;
}
