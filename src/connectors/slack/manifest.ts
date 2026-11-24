/** Slack: hosted MCP, read through a one-tool Claude relay (decision H-3). Scans traverse with the scan-slack skill today. */
import { MCP_SERVER_NAME } from '@/llm/errors';
import { SLACK_SCAN_TOOLS } from '@/llm/mcp-config';

import { relayDeclaredProbe } from '../runtime/probes';
import type { ConnectorManifest } from '../runtime/types';

import { parseSlackChannel, parseSlackSearch, parseSlackThread } from './parse';

const H = 3_600_000;

/** The relay and scan failures a Slack read can report (src/llm/errors.ts signatures + the relay's own codes). */
export const RELAY_FAILURE_CODES = ['needs_auth', 'invalid_auth', 'http_401', 'sso_redirect', 'gateway_invalid_api_key', 'rate_limited', 'network', 'overloaded', 'timeout', 'maintenance', 'gateway_error', 'executable_missing', 'disallowed_tool', 'config', 'cost_cap', 'no_result', 'unknown'] as const;

export const slackManifest: ConnectorManifest = {
  id: 'slack',
  label: 'Slack',
  runtime: 'claude_relay',
  server: MCP_SERVER_NAME.slack!,
  scopes: ['inbox', 'channel:<id>'],
  auth: { kind: 'claude_mcp_oauth', check: 'claude_mcp_status', reauthHint: { handler: 'slack', kind: 'terminal_command', hint: `claude mcp login ${MCP_SERVER_NAME.slack}` } },
  readTools: SLACK_SCAN_TOOLS,
  windows: { default: 24 * H, max: 14 * 24 * H },
  cadence: { baseMs: 2 * 60_000 },
  estimate: { usdPerDay: 4 },
  healthCheck: () => relayDeclaredProbe('slack'),
  parse: { search: parseSlackSearch, thread: parseSlackThread, channel: parseSlackChannel },
  failureCodes: [...RELAY_FAILURE_CODES, 'slack_scope'],
  scan: { mode: 'traversal', skill: 'scan-slack' },
};
