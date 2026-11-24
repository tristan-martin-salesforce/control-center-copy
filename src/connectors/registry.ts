/**
 * The connector registry (08 R1): one manifest per source, one line each. Adding a connector is one folder
 * (`src/connectors/<id>/`: manifest, fetcher or relay calls, parse + fixtures) and one line below; docs/CONNECTORS.md
 * walks through it. The scanner's dispatch (src/scanner/runtime/connectors.ts) and the worker read their per-source
 * behaviour from here instead of branching on the id.
 *
 * Source ids are the canonical `CONNECTOR_IDS` (src/contract/sources.ts); tests/connectors/registry.test.ts checks
 * that every id has exactly one manifest, every manifest's tools are on the read allowlist, and the values match the
 * tables they replace (cadence, re-auth, labels).
 */
import type { ConnectorId } from '@/scanner/types';
import { CONNECTOR_IDS } from '@/contract/sources';

import { claudeSessionsManifest } from './claude/manifest';
import { calendarManifest, driveManifest, geminiNotesManifest, gmailManifest, trainingsManifest } from './google/manifest';
import { org62Manifest } from './org62/manifest';
import type { ConnectorManifest } from './runtime/types';
import { slackManifest } from './slack/manifest';
import { vdpManifest } from './vdp/manifest';
import { watchManifest } from './watch/manifest';

export type { ConnectorManifest } from './runtime/types';

export const MANIFESTS: readonly ConnectorManifest[] = Object.freeze([
  slackManifest,
  org62Manifest,
  gmailManifest,
  calendarManifest,
  driveManifest,
  geminiNotesManifest,
  claudeSessionsManifest,
  trainingsManifest,
  watchManifest,
  vdpManifest,
]);

const BY_ID: ReadonlyMap<ConnectorId, ConnectorManifest> = new Map(MANIFESTS.map((m) => [m.id, m]));

export const isConnectorId = (x: string): x is ConnectorId => (CONNECTOR_IDS as readonly string[]).includes(x);

/** The manifest of a connector. Throws for an id the registry does not know (a missing line is a bug, not a default). */
export function manifestOf(id: ConnectorId): ConnectorManifest {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`connector registry: no manifest for "${id}"`);
  return m;
}

export const connectorLabel = (id: ConnectorId): string => BY_ID.get(id)?.label ?? id;

/** The skill file a connector's scan runs (`skills/<skill>.md`). */
export const scanSkillPath = (id: ConnectorId): string => `skills/${manifestOf(id).scan.skill}.md`;
