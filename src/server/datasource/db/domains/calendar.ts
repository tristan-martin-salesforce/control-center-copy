/**
 * The db DataSource, calendar domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import { I, Res, WHOLE } from '../shared';
import type { DbCtx } from '../ctx';
import * as readin from '../readin';
import { calendarEventView, calendarView } from '@/server/views/calendar';

export class DbCalendar {
  constructor(private readonly ctx: DbCtx) {}

  async getCalendar({ query }: I<'getCalendar'>): Promise<Res<'getCalendar'>> {
    return calendarView(await this.ctx.model(WHOLE), query, this.ctx.now());
  }

  async getCalendarEvent({ params }: I<'getCalendarEvent'>): Promise<Res<'getCalendarEvent'>> {
    const readInOf = async (id: string) => (await readin.getReadInDb(this.ctx.db, await this.ctx.userId(), { type: 'calendar_event', id })).readIn;
    return calendarEventView(await this.ctx.model(WHOLE), params.id, readInOf);
  }
}
