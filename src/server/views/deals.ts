/**
 * Deals, read side (R7 step 3): the account rows Deals and the account page list.
 */
import type { AccountRow } from '@/contract';
import { accountDcsOf } from '@/server/deals/dc-requests';
import { isMyOpp, sweptOppIds } from '@/server/datasource/mock/views';

import { isLive } from './refs';
import type { ReadSource } from './source';

/** Every account with my open opps (swept findings excluded), open tasks, pipeline and next close. */
export function accountRows(src: ReadSource): AccountRow[] {
  const swept = sweptOppIds(src.all('missedOpps'));
  return src.all('accounts').map((a) => {
    const opps = src.all('opps').filter((o) => o.accountId === a.id && o.isOpen && isMyOpp(o, swept));
    return {
      ...a,
      myDcs: accountDcsOf(src.all('opps'), a.id),
      openOpps: opps.length,
      openTasks: src.all('workItems').filter((w) => w.accountId === a.id && isLive(w)).length,
      pipelineAmount: opps.reduce((s, o) => s + (o.amount ?? 0), 0),
      nextCloseDate: opps.map((o) => o.closeDate).filter((d): d is string => !!d).sort()[0] ?? null,
    };
  });
}
