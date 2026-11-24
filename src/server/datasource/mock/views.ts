/**
 * Read models for the mock: pure functions of (store, now). Mutations live in ./index.ts. Today, Triage and the Time
 * week are the shared views (src/server/views/{today,triage,time}.ts); what is here is what only the mock knows.
 */
import type { TodayPayload } from '@/contract';
import { todayCapacity } from '../db/rank';
import { DEFAULT_OBLIGATION_WEIGHT } from '../db/policy-map';
import type { ReadModel } from '../db/model';
import type { MockAuditLog, Store } from './store';
import { fmtHM, hrefFor, isLive, itemRef } from '@/server/views/refs';
import { hydrateItem, nowCardFor, workListView } from '@/server/views/work';
import { healthSummary } from '@/server/views/health';
import { buildOutbox, outboxGroupOf } from '@/server/views/drafts';
import { buildSince } from '@/server/views/universal';
import { windowOrToday } from '@/server/views/calendar';
import { topWithoutLikelyDone } from '@/server/views/today';

export { topWithoutLikelyDone };
// R7 step 3: the read bodies both DataSources share live in src/server/views/ (re-exported for the existing imports)
export { buildOutbox, buildSince, fmtHM, healthSummary, hrefFor, hydrateItem, isLive, itemRef, nowCardFor, outboxGroupOf, windowOrToday };
/** The Work list (views/work.ts), under the name the Assistant's listItems tool imports. */
export { workListView as buildItems };

/**
 * DEALS-1: an opp is mine when I'm on its team, hold a DC on it, or logged time on it this quarter. Deals counts,
 * pipeline, next close and DC gaps are about my opps; every other opp on the account (REC-2 records them all: 1,098
 * changed in one week on big accounts) stays context on the account page.
 */
export const isMyOpp = (o: { id: string; isMine: boolean; dcAssigned: boolean; hoursQtd: number }, swept: ReadonlySet<string> = new Set()) =>
  o.isMine || o.dcAssigned || o.hoursQtd > 0 || swept.has(o.id);
/** DEALS-1: opps the missed-opp sweep found my logged time on (open findings): mine for the DC-gap counts. */
export const sweptOppIds = (missed: Array<{ oppId: string | null; status: string }>) => new Set(missed.filter((x) => x.oppId && x.status !== 'dismissed').map((x) => x.oppId!));

// ---------------------------------------------------------------------------
// Today (the view's mock inputs)
// ---------------------------------------------------------------------------

/**
 * The store through the read-model surface the engine inputs and the interim ranker read (all, get, settings, meta,
 * the policy engine's defaults). No kv: the mock keeps its priority nudges in MockPriority.
 */
export function asReadModel(store: Store): ReadModel {
  return {
    all: (col: string) => store.all(col as never),
    get: (col: string, id: string) => store.get(col as never, id),
    settings: () => store.settings(),
    meta: () => store.meta(),
    extra: { policyRowId: null, policyEngine: { obligation: DEFAULT_OBLIGATION_WEIGHT, top3Size: 3 } },
  } as unknown as ReadModel;
}

/**
 * The engine's capacity over the mock store (DESIGN-V2: today-scoped, hands-on only), computed exactly as
 * the db DataSource computes it. The store is read through the read-model surface the engine inputs use.
 */
export function mockCapacity(store: Store, now: Date): TodayPayload['header']['capacity'] {
  return todayCapacity(asReadModel(store), now);
}

/** Item id → the audit id of its latest engine close not undone (the db's Q6), for Today's rail and Triage's Undo. */
export function closeUndoOf(audit: MockAuditLog): (itemId: string) => string | null {
  const closes = audit.entries.filter((e) => e.action === 'item.close' && !e.undoneAt);
  return (id) => closes.findLast((e) => e.entity.id === id)?.id ?? null;
}
