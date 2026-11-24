/**
 * The db DataSource, history domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { I, Res } from '../shared';
import { historyDay, historyMonth } from '../history';
import { historyScope } from '../reads/scope';

export class DbHistory {
  constructor(private readonly ctx: DbCtx) {}

  // History (B-081): read model + transitions / activity stamps (db/history.ts)
  async getHistoryMonth({ query }: I<'getHistoryMonth'>): Promise<Res<'getHistoryMonth'>> {
    return this.ctx.read(historyScope({ month: query.month }), (m) => historyMonth(this.ctx.db, m, query.month, this.ctx.now()));
  }

  async getHistoryDay({ params }: I<'getHistoryDay'>): Promise<Res<'getHistoryDay'>> {
    return this.ctx.read(historyScope({ day: params.day }), (m) => historyDay(this.ctx.db, m, params.day, this.ctx.now()));
  }
}
