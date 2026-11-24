/**
 * The mock DataSource, history domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { I, Res } from '../shared';
import { mockHistorySources } from '../history';
import { composeHistoryDay, composeHistoryMonth } from '@/server/history/compose';

export class MockHistory {
  constructor(private readonly ctx: MockCtx) {}

  async getHistoryMonth({ query }: I<'getHistoryMonth'>): Promise<Res<'getHistoryMonth'>> {
    return composeHistoryMonth(mockHistorySources(this.ctx.store, this.ctx.audit, this.ctx.now()), query.month);
  }

  async getHistoryDay({ params }: I<'getHistoryDay'>): Promise<Res<'getHistoryDay'>> {
    return composeHistoryDay({ ...mockHistorySources(this.ctx.store, this.ctx.audit, this.ctx.now()), onsite: [...this.ctx.ds.time.onsite.values()] }, params.day);
  }
}
