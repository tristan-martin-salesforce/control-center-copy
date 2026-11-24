/** Health probes the manifests share. None of them costs a model call. */
import { traversalMcpServers } from '@/llm/mcp-config';
import type { ConnectorHealthProbe, ConnectorId } from '@/scanner/types';

import type { ConnectorRuntime } from './types';

const at = () => new Date().toISOString();

/**
 * A relayed source (Slack, Org62): is its server declared in the Claude config? A real read costs a model turn, so
 * the sign-in itself is judged by the scan runs' init `mcp_servers[].status` (src/llm/errors.ts classifyMcpStatus).
 */
export async function relayDeclaredProbe(connector: ConnectorId, serversFor: (c: ConnectorId) => Record<string, unknown> = traversalMcpServers): Promise<ConnectorHealthProbe> {
  try {
    serversFor(connector);
    return { state: 'ok', detail: 'declared in Claude Code', checkedAt: at() };
  } catch {
    return { state: 'disabled', errorClass: 'config', detail: 'server_not_declared: not set up in Claude Code', checkedAt: at() };
  }
}

/** The runtime's own probe (direct_mcp: one cheap allowlisted read), or ok when it has none. */
export async function runtimeProbe(rt: ConnectorRuntime): Promise<ConnectorHealthProbe> {
  return rt.health ? rt.health() : { state: 'ok', checkedAt: at() };
}
