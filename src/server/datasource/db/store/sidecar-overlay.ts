/**
 * D-98 (0036): the one dual-read point. `loadKv` (../ext.ts) calls this on every user kv map it loads, so the read
 * model and every WriteCtx see the promoted columns and the need_decisions rows in the kv shape their code expects:
 * the column (row) first, the kv value as the fallback until `kv.backfill` has copied it. Keys already in the map keep
 * their place (the readers that list app runs and mapping questions read them in key order); entries the overlay adds
 * (an entity whose ext now lives only in columns) follow.
 */
import type { DbOrTx } from '@/db/client';

import { overlayNeedDecisions } from '../needs-decisions';
import { overlayPromoted } from './sidecar';

export async function overlaySidecar(db: DbOrTx, userId: string, kv: Map<string, unknown>): Promise<Map<string, unknown>> {
  await overlayPromoted(db, userId, kv);
  await overlayNeedDecisions(db, userId, kv);
  return kv;
}
