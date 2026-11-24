/**
 * Gates (D-55): whether something has a daily surface for this persona. An inactive feature or source shows up only
 * in Settings ▸ Role & rules (and onboarding) as available to activate: no worker registration, Health row,
 * Assistant tool, read page, Outbox channel, Time tab or NBA verb.
 *
 * `allows(null, …)` is false (the persona is still loading): gated surfaces appear once settings arrive.
 */
import type { PersonaFeature, RouteKey } from '@/contract';
import type { ConnectorId } from '@/scanner/types';
import type { ResolvedPersona } from './types';

export interface Gate {
  feature?: PersonaFeature;
  connector?: ConnectorId;
}

export function featureActive(p: ResolvedPersona | null | undefined, f: PersonaFeature): boolean {
  return !!p && p.features[f] === true;
}

export function connectorActive(p: ResolvedPersona | null | undefined, c: ConnectorId): boolean {
  return !!p && p.connectors.includes(c);
}

export function allows(p: ResolvedPersona | null | undefined, g: Gate | undefined): boolean {
  if (!g) return true;
  if (!p) return false;
  if (g.feature && !featureActive(p, g.feature)) return false;
  if (g.connector && !connectorActive(p, g.connector)) return false;
  return true;
}

/** Sources with a daily surface, in order. */
export function visibleConnectors(p: ResolvedPersona | null | undefined): ConnectorId[] {
  return p ? [...p.connectors] : [];
}

/** Assistant read pages (`chat_app_read` page names) that belong to a feature. */
export const READ_PAGE_GATES: Readonly<Record<string, Gate>> = {
  vdp: { feature: 'vdp' },
  vdp_detail: { feature: 'vdp' },
  missed_opps: { feature: 'missedOpps' },
};

/** API routes that belong to a feature (the Assistant's generic route tools and the UI's gated surfaces read this). */
export const ROUTE_GATES: Readonly<Partial<Record<RouteKey, Gate>>> = {
  getVdpCoverage: { feature: 'vdp' },
  getVdpDetail: { feature: 'vdp' },
  draftVdpUpdate: { feature: 'vdp' },
  findVdpAssets: { feature: 'vdp' },
  setVdpCandidate: { feature: 'vdp' },
  getUseCaseSync: { feature: 'vdp' }, // D-67
  getMissed: { feature: 'missedOpps' },
  claimMissed: { feature: 'missedOpps' },
  dismissMissed: { feature: 'missedOpps' },
  ...Object.fromEntries((['getForecast', 'getForecastRecord', 'syncForecast', 'draftForecastNotes', 'patchForecast', 'stageForecast', 'checkMissingForecast'] as const).map((k) => [k, { feature: 'specialistForecast' } as Gate])), // lane A
  listDcRequests: { feature: 'dealContributions' },
  createDcRequest: { feature: 'dealContributions' },
  patchDcRequest: { feature: 'dealContributions' },
  withdrawDcRequest: { feature: 'dealContributions' },
};
