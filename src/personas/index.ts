/**
 * The persona registry (D-55) and `personaOf`: the preset with the user's changes applied. Pure; shared by the
 * server (scanners, prompts, Home, the Assistant) and the client (`usePersona`).
 */
import { PersonaFeature, type PersonaId, type PersonaLevel, type PersonaSettings } from '@/contract';
import type { ConnectorId } from '@/scanner/types';
import { priorityConfigOf } from '@/engines/priority/v2/config';
import { AE_PERSONA } from './ae';
import { SE_PERSONA } from './se';
import { ALL_CONNECTORS, ALL_ORG62_SCOPES, type Org62Scope, type PersonaDefinition, type ResolvedPersona, type ResolvedRule } from './types';

export { fillThresholds, roleTitle } from './text';
export * from './gates';
export { renderPersonaBlock } from './prompt';
export { adminOnTime, adminWaitingBySurface, connectorOfRow, connectorRowsFor, draftHasSurface, healthForPersona, setupDepsFor, staleFor } from './surfaces';

export * from './types';
export { AE_PERSONA } from './ae';
export { SE_PERSONA } from './se';

export const PERSONAS: Readonly<Record<PersonaId, PersonaDefinition>> = { se: SE_PERSONA, ae: AE_PERSONA };

export const ALL_FEATURES: readonly PersonaFeature[] = PersonaFeature.options;

/** Sources that belong to a feature: they are active exactly when the feature is (unless switched on their own). */
export const FEATURE_CONNECTORS: Partial<Record<PersonaFeature, ConnectorId[]>> = { vdp: ['vdp'] };

/**
 * Org62 scopes that belong to a feature (lane B): `dcs` reads my Deal Contributions, `missed_opps` sweeps for opps
 * with no DC of mine. They are scanned exactly when the feature is active, so activating it brings the scope back and
 * deactivating it pauses the scope's cursor (nothing is deleted). Other scopes follow the preset.
 */
export const FEATURE_ORG62_SCOPES: Partial<Record<Org62Scope, PersonaFeature>> = { dcs: 'dealContributions', missed_opps: 'missedOpps' };

/** The personas a picker offers (preview ones are labelled, still selectable). */
export function selectablePersonas(): PersonaDefinition[] {
  return [SE_PERSONA, AE_PERSONA];
}

type PersonaInput = { persona?: Partial<PersonaSettings> | null; profile?: { role?: string | null } | null };

function levelOf(def: PersonaDefinition, s: PersonaInput): PersonaLevel {
  const want: PersonaLevel = s.persona?.level ?? (s.profile?.role === 'se_manager' ? 'manager' : 'ic');
  if (def.levels[want]) return want;
  return (Object.keys(def.levels)[0] as PersonaLevel | undefined) ?? 'ic';
}

export function personaOf(s: PersonaInput): ResolvedPersona {
  const id = (s.persona?.id ?? 'se') as PersonaId;
  const def = PERSONAS[id] ?? SE_PERSONA;
  const level = levelOf(def, s);
  const lv = def.levels[level]!;
  const fo = s.persona?.features ?? {};
  const features = Object.fromEntries(ALL_FEATURES.map((f) => [f, fo[f] ?? def.features[f] === true])) as Record<PersonaFeature, boolean>;
  const changedFeatures = ALL_FEATURES.filter((f) => features[f] !== (def.features[f] === true));

  const co = s.persona?.connectors ?? {};
  const owner = new Map<ConnectorId, PersonaFeature>();
  for (const [f, cs] of Object.entries(FEATURE_CONNECTORS) as [PersonaFeature, ConnectorId[]][]) for (const c of cs) owner.set(c, f);
  const connectorActive = (c: ConnectorId) => {
    if (typeof co[c] === 'boolean') return co[c]!;
    const f = owner.get(c);
    return f ? features[f] : def.connectors.includes(c);
  };
  const connectors = ALL_CONNECTORS.filter(connectorActive);

  const thresholds: Record<string, number | string> = {};
  for (const t of def.thresholds) thresholds[t.key] = s.persona?.thresholds?.[t.key] ?? t.default;

  const ro = s.persona?.rules ?? {};
  const rules: ResolvedRule[] = [
    ...def.rules.map((r) => {
      const o = ro[r.id] ?? {};
      const enabled = (o.enabled ?? r.enabled) && (!r.feature || features[r.feature]);
      return { id: r.id, text: o.text ?? r.text, enabled, custom: false, edited: o.text !== undefined || o.enabled !== undefined, ...(r.feature ? { feature: r.feature } : {}) };
    }),
    ...(s.persona?.customRules ?? []).map((r) => ({ id: `custom:${r.id}`, text: r.text, enabled: r.enabled ?? true, custom: true, edited: false })),
  ];

  return {
    id: def.id,
    level,
    label: def.label,
    levelLabel: lv.label,
    preamble: def.preamble,
    status: def.status,
    priorityTemplate: lv.priorityTemplate,
    features,
    changedFeatures,
    connectors,
    availableConnectors: ALL_CONNECTORS.filter((c) => !connectorActive(c)),
    org62Scopes: ALL_ORG62_SCOPES.filter((sc) => {
      const f = FEATURE_ORG62_SCOPES[sc];
      return f ? features[f] : def.org62Scopes.includes(sc);
    }),
    org62Book: def.org62Book,
    gapRules: [...def.gapRules],
    logging: def.logging,
    duties: def.duties.map((d) => ({ ...d, active: !d.feature || features[d.feature] })),
    rules,
    thresholds,
    priority: priorityConfigOf(def.priority),
  };
}
