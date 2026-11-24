/**
 * The mock DataSource, calendar domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import { I, Res } from '../shared';
import type { MockCtx } from '../ctx';
import { calendarEventView, calendarView } from '@/server/views/calendar';

export class MockCalendar {
  constructor(private readonly ctx: MockCtx) {}

  async getCalendar({ query }: I<'getCalendar'>): Promise<Res<'getCalendar'>> {
    return calendarView(this.ctx.store, query, this.ctx.now());
  }

  async getCalendarEvent({ params }: I<'getCalendarEvent'>): Promise<Res<'getCalendarEvent'>> {
    return calendarEventView(this.ctx.store, params.id, async (id) => (await this.ctx.ds.readins!.get({ type: 'calendar_event', id })).readIn);
  }
}
