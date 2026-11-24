/**
 * Source kinds live in one place (src/contract/sources.ts, 08 CONN-1). The three vocabularies it maps must agree with
 * their own definitions: the scanner's ConnectorId, the Postgres `source_system` enum (stays an enum for now) and the
 * contract's SourceKind.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { SourceKind } from '@/contract/common';
import { CONNECTOR_IDS, CONNECTOR_SOURCE, connectorOfSystem, kindOfSystem, SOURCE_KINDS, SOURCE_SYSTEMS, sourceKindOf, sourceSystemOf, systemOfKind, type ConnectorKind } from '@/contract/sources';
import { sourceSystem } from '@/db/schema/enums';
import { DEFAULT_BASE_CADENCE_MS } from '@/scanner/runtime/cadence';
import { CONNECTOR_META } from '@/scanner/store-db';
import { sourceFromDb, sourceToDb } from '@/server/datasource/db/enums';
import type { ConnectorId } from '@/scanner/types';

describe('source kinds: one list, three vocabularies', () => {
  it('CONNECTOR_IDS is the scanner ConnectorId (type both ways, and every per-connector table)', () => {
    expectTypeOf<ConnectorKind>().toEqualTypeOf<ConnectorId>();
    expect(Object.keys(DEFAULT_BASE_CADENCE_MS).sort()).toEqual([...CONNECTOR_IDS].sort());
    expect(Object.keys(CONNECTOR_META).sort()).toEqual([...CONNECTOR_IDS].sort());
  });

  it('SOURCE_SYSTEMS is the Postgres source_system enum, in order', () => {
    expect([...SOURCE_SYSTEMS]).toEqual(sourceSystem.enumValues);
  });

  it('SOURCE_KINDS is the contract SourceKind, in order', () => {
    expect([...SOURCE_KINDS]).toEqual(SourceKind.options);
  });

  it("each connector's system matches what the store files it under", () => {
    for (const c of CONNECTOR_IDS) {
      expect(sourceSystemOf(c), c).toBe(CONNECTOR_META[c].kind);
      expect(SOURCE_KINDS).toContain(sourceKindOf(c));
      expect(kindOfSystem(sourceSystemOf(c))).toBe(sourceKindOf(c));
    }
    expect(CONNECTOR_SOURCE.gemini_notes).toEqual({ system: 'gemini_notes', kind: 'gemini' });
    expect(CONNECTOR_SOURCE.claude_sessions).toEqual({ system: 'claude', kind: 'claude' });
  });

  it('the mappings round-trip and the datasource uses them', () => {
    for (const k of SOURCE_KINDS) {
      expect(kindOfSystem(systemOfKind(k))).toBe(k);
      expect(sourceToDb(k)).toBe(systemOfKind(k));
    }
    for (const s of SOURCE_SYSTEMS) expect(sourceFromDb(s)).toBe(kindOfSystem(s));
    expect(kindOfSystem('git')).toBe('manual');
    expect(connectorOfSystem('claude')).toBe('claude_sessions');
    expect(connectorOfSystem('gemini_notes')).toBe('gemini_notes');
    expect(connectorOfSystem('app')).toBeNull();
  });
});
