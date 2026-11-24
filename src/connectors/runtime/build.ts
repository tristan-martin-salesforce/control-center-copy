/**
 * The one place a manifest's `runtime` becomes a transport (registry dispatch: the composition root, the worker,
 * calls this instead of picking a client per source).
 */
import { vdpReadRuntime } from '../vdp/client';
import type { VdpHttpOptions } from '../vdp/http';

import { claudeRelayRuntime, type ClaudeRelayRuntimeOptions } from './claude-relay';
import { directMcpRuntime } from './direct-mcp';
import { localFilesRuntime } from './local-files';
import type { ConnectorManifest, ConnectorRuntime, TextToolPort } from './types';

export interface RuntimeDeps {
  /** direct_mcp: the shared MCP client (one per process: devbar serves one call at a time). */
  mcp?: TextToolPort & { close?(): Promise<void> };
  /** http_jsonrpc: VDP's HTTP options (Claude config path, fetch, clock). */
  http?: VdpHttpOptions;
  /** claude_relay: query seam, gateway, ledger, history. */
  relay?: Omit<ClaudeRelayRuntimeOptions, 'connector' | 'readTools'>;
  /** local_files: the folders it may read. */
  roots?: ReadonlyArray<string | null | undefined>;
}

export function buildRuntime(m: ConnectorManifest, deps: RuntimeDeps = {}): ConnectorRuntime {
  switch (m.runtime) {
    case 'direct_mcp':
      if (!deps.mcp) throw new Error(`${m.id}: a direct_mcp runtime needs its MCP client`);
      return directMcpRuntime({ connector: m.id, readTools: m.readTools, client: deps.mcp });
    case 'http_jsonrpc':
      // one http_jsonrpc source today; its transport function is VDP's own
      return vdpReadRuntime(deps.http ?? {});
    case 'local_files':
      return localFilesRuntime({ connector: m.id, roots: deps.roots ?? [], readTools: m.readTools });
    case 'claude_relay':
      // watch briefs read Slack's server (its manifest's two tools)
      return claudeRelayRuntime({ connector: m.id === 'watch' ? 'slack' : m.id, readTools: m.readTools, ...(deps.relay ?? {}) });
  }
}
