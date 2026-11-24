/**
 * Registry completeness (p1-connector-runtime, 08 R1): every source kind has exactly one manifest; every manifest's
 * read tools are on the read allowlist and never on a write list (*tenet: Read-only ingest*, CLAUDE.md invariant 2);
 * and the manifest values match the tables they stand for (cadence, re-auth, labels, server names), so moving a
 * caller onto the registry changes no behaviour.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONNECTOR_IDS } from '@/contract/sources';
import { GOOGLE_READ_TOOLS } from '@/connectors/google/client';
import { connectorLabel, isConnectorId, MANIFESTS, manifestOf, scanSkillPath } from '@/connectors/registry';
import { LOCAL_FILE_TOOLS } from '@/connectors/runtime/local-files';
import { VDP_READ_TOOLS, VDP_WRITE_TOOLS } from '@/connectors/vdp/tools';
import { MCP_SERVER_NAME } from '@/llm/errors';
import { assertReadOnly, ORG62_ALL_TOOLS, SLACK_ALL_TOOLS, SLACK_SCAN_TOOLS } from '@/llm/mcp-config';
import { REAUTH_KIND_OF } from '@/reauth/run';
import { DEFAULT_BASE_CADENCE_MS } from '@/scanner/runtime/cadence';
import { CONNECTOR_META } from '@/scanner/store-db';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The read allowlist: what a scanner or a relay may call (the scanner lists; the Outbox's own read-back list stays
 * private to src/outbox, tests/outbox/guard.test.ts, and tests/safety/mcp-tools.test.ts cross-checks it).
 */
const READ = new Set<string>([...SLACK_SCAN_TOOLS, 'slack_read_channel', 'slack_read_thread', ...ORG62_ALL_TOOLS, ...GOOGLE_READ_TOOLS, ...VDP_READ_TOOLS]);
/** Write-capable tools: VDP's ops and every Slack tool that is not a read (the Outbox's Slack and canvas writes among them). */
const WRITE = new Set<string>([...VDP_WRITE_TOOLS, ...SLACK_ALL_TOOLS.filter((t) => !/^slack_(read|search|list|get)_/.test(t))]);

describe('connector registry', () => {
  it('every source kind has exactly one manifest, and nothing else does', () => {
    expect(MANIFESTS.map((m) => m.id).sort()).toEqual([...CONNECTOR_IDS].sort());
    expect(new Set(MANIFESTS.map((m) => m.id)).size).toBe(MANIFESTS.length);
    for (const id of CONNECTOR_IDS) expect(manifestOf(id).id).toBe(id);
    expect(() => manifestOf('nope' as never)).toThrow(/no manifest/);
    expect(isConnectorId('gemini_notes')).toBe(true);
    expect(isConnectorId('gemini')).toBe(false);
  });

  it("every manifest's tools are reads: on the read allowlist, never a write, and pass the write-like guard", () => {
    for (const m of MANIFESTS) {
      expect(m.readTools.length, m.id).toBeGreaterThan(0);
      if (m.runtime === 'local_files') {
        expect([...m.readTools]).toEqual([...LOCAL_FILE_TOOLS]);
        continue;
      }
      for (const t of m.readTools) {
        expect(READ.has(t), `${m.id}: ${t} is not on the read allowlist`).toBe(true);
        expect(WRITE.has(t), `${m.id}: ${t} is a write`).toBe(false);
      }
      expect(() => assertReadOnly(m.readTools)).not.toThrow();
    }
    // the Google family lists subsets of the gateway allowlist; the relay connectors their scan lists
    for (const id of ['gmail', 'calendar', 'drive', 'gemini_notes', 'trainings'] as const) for (const t of manifestOf(id).readTools) expect(GOOGLE_READ_TOOLS.has(t)).toBe(true);
    expect([...manifestOf('slack').readTools]).toEqual([...SLACK_SCAN_TOOLS]);
    expect([...manifestOf('org62').readTools]).toEqual(['soqlQuery']);
    expect([...manifestOf('vdp').readTools]).toEqual([...VDP_READ_TOOLS]);
    expect(WRITE.has('slack_send_message') && WRITE.has('slack_create_canvas') && WRITE.has('update_use_case')).toBe(true);
  });

  it('values match the tables they stand for: cadence, re-auth handler, label, source system, MCP server name', () => {
    for (const m of MANIFESTS) {
      expect(m.cadence.baseMs, m.id).toBe(DEFAULT_BASE_CADENCE_MS[m.id]);
      expect(m.auth.reauthHint.handler ?? undefined, m.id).toBe(REAUTH_KIND_OF[m.id]);
      expect(m.label, m.id).toBe(CONNECTOR_META[m.id].label);
      expect(connectorLabel(m.id)).toBe(m.label);
      if (m.runtime === 'claude_relay' && m.id !== 'watch') expect(m.server).toBe(MCP_SERVER_NAME[m.id]);
      expect(['traversal', 'deterministic']).toContain(m.scan.mode);
      expect(m.scan.mode === 'traversal').toBe(m.id === 'slack' || m.id === 'org62');
    }
  });

  it('every manifest is complete: windows, estimate, health check, parsers, failure codes, a skill that exists', () => {
    for (const m of MANIFESTS) {
      expect(m.windows.default).toBeGreaterThan(0);
      expect(m.windows.max).toBeGreaterThanOrEqual(m.windows.default);
      expect(m.estimate.usdPerDay).toBeGreaterThanOrEqual(0);
      expect(typeof m.healthCheck).toBe('function');
      expect(Object.values(m.parse).every((f) => typeof f === 'function') && Object.keys(m.parse).length > 0, m.id).toBe(true);
      expect(m.failureCodes.length, m.id).toBeGreaterThan(0);
      expect(m.scopes.length, m.id).toBeGreaterThan(0);
      // VDP is record-only: no skill agent runs (the path is still derived the same way)
      if (m.id !== 'vdp') expect(fs.existsSync(path.join(ROOT, scanSkillPath(m.id))), scanSkillPath(m.id)).toBe(true);
    }
  });

  it('adding a connector is one registry line: registry.ts lists each manifest once', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/connectors/registry.ts'), 'utf8');
    const list = src.slice(src.indexOf('Object.freeze(['), src.indexOf(']);'));
    expect(list.match(/Manifest,/g)?.length).toBe(CONNECTOR_IDS.length);
  });
});
