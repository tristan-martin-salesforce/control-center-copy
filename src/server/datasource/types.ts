/**
 * The DataSource: one method per route in src/contract/routes.ts (same name).
 *
 * Inputs are already parsed by the route handler (defaults applied); outputs are validated against the
 * route's response schema before they leave the server. Throw AppError (src/server/errors.ts) for
 * typed failures: conflict (stale ifVersion), validation, not_found, upstream_unavailable, …
 *
 * Implementations: `mock` (src/server/datasource/mock, in-memory, the default) and `db` (BE-1).
 *
 * R7 step 4: each domain's methods are one interface in types/<domain>.ts (CalendarSource, TimeSource, …); DataSource
 * is all of them. A new route's method goes in its domain's file (CONTRIBUTING.md "Where a DataSource method goes").
 */
import type { RouteKey } from '@/contract';

import type { TodaySource } from './types/today';
import type { WorkSource } from './types/work';
import type { NbaSource } from './types/nba';
import type { DraftsSource } from './types/drafts';
import type { CalendarSource } from './types/calendar';
import type { AgentsSource } from './types/agents';
import type { TimeSource } from './types/time';
import type { CanvasSource } from './types/canvas';
import type { AttributionSource } from './types/attribution';
import type { UseCasesSource } from './types/use-cases';
import type { HistorySource } from './types/history';
import type { DealsSource } from './types/deals';
import type { VdpSource } from './types/vdp';
import type { NeedsSource } from './types/needs';
import type { BriefsSource } from './types/briefs';
import type { TriageSource } from './types/triage';
import type { HealthSource } from './types/health';
import type { SettingsSource } from './types/settings';
import type { UniversalSource } from './types/universal';
import type { ChatSource } from './types/chat';
import type { OnboardingSource } from './types/onboarding';
import type { ForecastSource } from './types/forecast';
import type { FeedbackSource } from './types/feedback';
import type { DevSource } from './types/dev';

export type { TodaySource, WorkSource, NbaSource, DraftsSource, CalendarSource, AgentsSource, TimeSource, CanvasSource, AttributionSource, UseCasesSource, HistorySource, DealsSource, VdpSource, NeedsSource, BriefsSource, TriageSource, HealthSource, SettingsSource, UniversalSource, ChatSource, OnboardingSource, ForecastSource, FeedbackSource, DevSource };

export interface DataSource
  extends TodaySource,
    WorkSource,
    NbaSource,
    DraftsSource,
    CalendarSource,
    AgentsSource,
    TimeSource,
    CanvasSource,
    AttributionSource,
    UseCasesSource,
    HistorySource,
    DealsSource,
    VdpSource,
    NeedsSource,
    BriefsSource,
    TriageSource,
    HealthSource,
    SettingsSource,
    UniversalSource,
    ChatSource,
    OnboardingSource,
    ForecastSource,
    FeedbackSource,
    DevSource {
  readonly kind: 'mock' | 'db';
  /** Current dev failure rate (0 = off); consulted by the route handler for every non-dev request. */
  failRate(): number;
}

// Compile-time guarantee: the interface has exactly one method per route.
type RouteMethods = Omit<DataSource, 'kind' | 'failRate' | 'notePresence'>;
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const DATASOURCE_COVERS_ROUTES: AssertExact<keyof RouteMethods, RouteKey> = true;
