/**
 * Source kinds in ONE place (08 CONN-1: eight spellings of the same list). Three vocabularies exist and stay, each
 * mapped here and nowhere else:
 *
 *   CONNECTOR_IDS   the scanner's connectors (ConnectorId, src/scanner/types.ts; the registry's keys)
 *   SOURCE_SYSTEMS  the Postgres `source_system` enum (src/db/schema/enums.ts; stays an enum for now, decision D3 in 08)
 *   SOURCE_KINDS    the API contract's `SourceKind` (src/contract/common.ts: the chip on a row)
 *
 * tests/connectors/sources.test.ts fails when any of them drifts from this file. Leaf module: imports nothing.
 */

export const CONNECTOR_IDS = ['slack', 'org62', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions', 'trainings', 'watch', 'vdp'] as const;
export type ConnectorKind = (typeof CONNECTOR_IDS)[number];

/** The `source_system` pg enum values, in the enum's order. */
export const SOURCE_SYSTEMS = ['slack', 'gmail', 'calendar', 'drive', 'gemini_notes', 'org62', 'vdp', 'claude', 'git', 'manual', 'chat', 'tool', 'app'] as const;
export type SourceSystemKind = (typeof SOURCE_SYSTEMS)[number];

/** The contract's `SourceKind` values, in its order. */
export const SOURCE_KINDS = ['slack', 'gmail', 'calendar', 'drive', 'gemini', 'org62', 'vdp', 'claude', 'manual'] as const;
export type SourceKindValue = (typeof SOURCE_KINDS)[number];

/**
 * Each connector's source system (what its items are stored as) and contract kind (what the screen shows). Trainings
 * arrive by mail and watch briefs read Slack, so they share their carrier's system.
 */
export const CONNECTOR_SOURCE: Readonly<Record<ConnectorKind, { system: SourceSystemKind; kind: SourceKindValue }>> = Object.freeze({
  slack: { system: 'slack', kind: 'slack' },
  org62: { system: 'org62', kind: 'org62' },
  gmail: { system: 'gmail', kind: 'gmail' },
  calendar: { system: 'calendar', kind: 'calendar' },
  drive: { system: 'drive', kind: 'drive' },
  gemini_notes: { system: 'gemini_notes', kind: 'gemini' },
  claude_sessions: { system: 'claude', kind: 'claude' },
  trainings: { system: 'gmail', kind: 'gmail' },
  watch: { system: 'slack', kind: 'slack' },
  vdp: { system: 'vdp', kind: 'vdp' },
});

export const sourceSystemOf = (c: ConnectorKind): SourceSystemKind => CONNECTOR_SOURCE[c].system;
export const sourceKindOf = (c: ConnectorKind): SourceKindValue => CONNECTOR_SOURCE[c].kind;

/** Contract kind → stored system (`gemini` is stored as `gemini_notes`; the rest are spelled the same). */
export function systemOfKind(k: SourceKindValue): SourceSystemKind {
  return k === 'gemini' ? 'gemini_notes' : k;
}

/** Stored system → contract kind. Systems with no chip of their own (git, chat, tool, app) show as `manual`. */
export function kindOfSystem(s: SourceSystemKind): SourceKindValue {
  if (s === 'gemini_notes') return 'gemini';
  if (s === 'git' || s === 'chat' || s === 'tool' || s === 'app') return 'manual';
  return s;
}

/** Stored system → the connector that reads it (the primary one where two share a system); null for app-made rows. */
export function connectorOfSystem(s: string): ConnectorKind | null {
  if (s === 'claude') return 'claude_sessions';
  return (CONNECTOR_IDS as readonly string[]).includes(s) ? (s as ConnectorKind) : null;
}
