/**
 * Watch briefs (scan-watch): a hybrid. The plan comes from the watch subscriptions (src/connectors/watch.ts); the
 * agent then reads the watched Slack channels and threads through Slack's server with two read tools.
 */
import { MCP_SERVER_NAME } from '@/llm/errors';

import { relayDeclaredProbe } from '../runtime/probes';
import type { ConnectorManifest } from '../runtime/types';
import { RELAY_FAILURE_CODES } from '../slack/manifest';
import { expandWatchScopes, planWatch } from '../watch';

const MIN = 60_000;
const H = 60 * MIN;

/** The two Slack reads a watch brief may make. */
export const WATCH_SLACK_TOOLS = ['slack_read_channel', 'slack_read_thread'] as const;

export const watchManifest: ConnectorManifest = {
  id: 'watch',
  label: 'Watch briefs',
  runtime: 'claude_relay',
  server: MCP_SERVER_NAME.slack!,
  scopes: ['slack:channel:<id>', 'opp:<id>', 'account:<id>'],
  auth: { kind: 'claude_mcp_oauth', check: 'claude_mcp_status', reauthHint: { handler: null, kind: 'terminal_command', hint: `Signs in with Slack: claude mcp login ${MCP_SERVER_NAME.slack}` } },
  readTools: WATCH_SLACK_TOOLS,
  windows: { default: 24 * H, max: 14 * 24 * H },
  cadence: { baseMs: 60 * MIN },
  estimate: { usdPerDay: 0.2 },
  healthCheck: () => relayDeclaredProbe('slack'),
  parse: { scopes: expandWatchScopes, plan: planWatch },
  failureCodes: [...RELAY_FAILURE_CODES, 'slack_scope'],
  scan: { mode: 'deterministic', skill: 'scan-watch', chunkMs: 12 * H, maxItemsPerRun: 25, hybrid: { via: 'slack', tools: WATCH_SLACK_TOOLS } },
};
