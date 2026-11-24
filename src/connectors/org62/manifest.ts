/**
 * Org62: hosted MCP `Org62-Sobject-Read`, read through a one-tool Claude relay (decision H-3). Org62 is a domain
 * system as well as a source (opportunities, DCs, events): only its transport lives here.
 */
import { MCP_SERVER_NAME } from '@/llm/errors';
import { ORG62_SCAN_TOOLS } from '@/llm/mcp-config';
import { org62RowToRaw, soqlRecords } from '@/llm/org62-rec';

import { relayDeclaredProbe } from '../runtime/probes';
import type { ConnectorManifest } from '../runtime/types';
import { RELAY_FAILURE_CODES } from '../slack/manifest';

const H = 3_600_000;

export const org62Manifest: ConnectorManifest = {
  id: 'org62',
  label: 'Org62',
  runtime: 'claude_relay',
  server: MCP_SERVER_NAME.org62!,
  scopes: ['opps', 'events', 'dcs', 'book', 'missed_opps'],
  auth: { kind: 'claude_mcp_oauth', check: 'claude_mcp_status', reauthHint: { handler: 'org62', kind: 'terminal_command', hint: `claude mcp login ${MCP_SERVER_NAME.org62}` } },
  readTools: ORG62_SCAN_TOOLS,
  // D-65 (TL-43): `events` catches up a fiscal quarter and more after downtime (ORG62_EVENTS_CATCH_UP_MS)
  windows: { default: 30 * 24 * H, max: 120 * 24 * H },
  cadence: { baseMs: 30 * 60_000 },
  estimate: { usdPerDay: 0.4 },
  healthCheck: () => relayDeclaredProbe('org62'),
  parse: { records: soqlRecords, row: org62RowToRaw },
  failureCodes: [...RELAY_FAILURE_CODES, 'soql_invalid'],
  scan: { mode: 'traversal', skill: 'scan-org62' },
};
