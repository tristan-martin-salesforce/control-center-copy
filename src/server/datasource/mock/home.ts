/**
 * GET /home for the mock DataSource: gathers the store's entities (items carry BE-READIN's `readInState`)
 * and hands them to the pure engine
 * (src/engines/home). Capacity is the CAPACITY engine's (`mockCapacity`), the same numbers Today shows.
 * Live refresh is client-side: the Home page invalidates the `home` topic whenever an items / outbox /
 * health / today / briefs (…) event arrives, so no extra server fan-out is needed.
 */
import type { HomePayload, RouteInput } from '@/contract';
import { buildHome } from '@/engines/home/build';
import { nextWorkingDay } from '@/engines/home/time';
import type { HomeInput } from '@/engines/home/types';
import { connectorRowsFor, personaOf } from '@/personas';
import { engineOf } from '@/engines/priority/v2/shadow';
import type { MockAuditLog, Store } from './store';
import { buildSince, hydrateItem, mockCapacity } from './views';

export interface HomeSource {
  store: Store;
  audit: MockAuditLog;
  now(): Date;
  /** Lane A: the Specialist Forecast records Home ▸ Log & fix reads. */
  forecast?: { homeInput(): HomeInput['forecast'] };
  /** D-59: the VDP summary Home ▸ Log & fix reads (absent while VDP is not active). */
  vdpHome?(): HomeInput['vdp'];
  /** DC-31: the Deals Log & fix rows Home's DC row counts (absent while deal contributions are not active). */
  dcNeeds?(): HomeInput['dcNeeds'];
  /** 2026-11-13 audit C2: DC requests and VDP use cases waiting for a canvas. */
  waitingForCanvas?(): HomeInput['waitingForCanvas'];
}

/** The engine input from a store (exported for tests and the db DataSource later). */
export function homeInputFromStore(src: HomeSource, wide: boolean, day: 'today' | 'next' = 'today'): HomeInput {
  const s = src.store;
  const now = src.now();
  const settings = s.settings();
  const meta = s.meta();
  const since = buildSince(s, src.audit.entries, meta.lastActiveAt, now);
  const spend = s.spend();
  const timezone = settings.profile.timezone || meta.timezone;
  const items = s.all('workItems').map((w) => hydrateItem(s, w));
  return {
    now: now.toISOString(),
    timezone,
    workingHours: settings.profile.workingHours,
    wide,
    items,
    nbas: s.all('nbas'),
    drafts: s.all('drafts'),
    proposals: s.all('proposals'),
    events: s.all('events'),
    slots: s.all('slots'),
    initiatives: s.all('initiatives'),
    accounts: s.all('accounts'),
    opps: s.all('opps'),
    missedOpps: s.all('missedOpps'),
    activity: s.all('activity'),
    // D-55: Home's footer and Log & fix name only the persona's active sources
    connectors: connectorRowsFor(s.all('connectors'), personaOf(settings)),
    agentRuns: s.all('agentRuns'),
    briefs: s.all('briefs'),
    quarter: meta.quarter,
    canvasLabel: meta.canvas.label,
    since: { changed: since.counts.changed, closed: since.counts.closed, new: since.counts.new, show: since.show },
    spend: { usd: spend.today.usd, softBudgetUsd: spend.today.softBudgetUsd },
    dryRun: settings.sending.dryRun,
    day,
    persona: personaOf(settings),
    // planning the next working day: the CAPACITY engine at that day's working-hours start
    capacity: mockCapacity(s, day === 'next' ? new Date(nextWorkingDay(now.getTime(), timezone, settings.profile.workingHours).startMs) : now),
    closedSince: settings.closing.tellMeWhatClosed ? meta.lastActiveAt : null,
    forecast: src.forecast?.homeInput(), // lane A
    vdp: src.vdpHome?.(), // D-59
    dcNeeds: src.dcNeeds?.(), // DC-31: one count source with Deals
    waitingForCanvas: src.waitingForCanvas?.(), // 2026-11-13 audit C2: never "Nothing missing" while they wait
    decisions: s.all('needDecisions'), // Log & fix rows set aside (Not now / Not needed)
    priorityEngine: engineOf(settings as { priority?: unknown }), // the shown ranking: Home's Admin row
  };
}

export function getHomeMock(src: HomeSource, i: Partial<RouteInput<'getHome'>>): HomePayload {
  return buildHome(homeInputFromStore(src, i.query?.wide ?? false, i.query?.day ?? 'today'));
}
