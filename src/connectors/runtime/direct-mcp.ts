/**
 * `direct_mcp`: our own MCP client calls the gateway, which owns auth (Google through devbar's mcpgw; the app sees no
 * token). No model is involved, so usage and cost are zero. The client's own errors (GoogleCallError,
 * DisallowedToolError) pass through unchanged, so fetchers and the error catalog classify them as before.
 */
import type { ConnectorId } from '@/scanner/types';

import { codeOf, guardTool, jsonOf, startTrace, traceCall } from './guard';
import { ZERO_USAGE, type ConnectorRuntime, type RuntimeCallOptions, type RuntimeCallResult, type TextToolPort } from './types';

export interface DirectMcpRuntimeOptions {
  connector: ConnectorId;
  readTools: readonly string[];
  /** The MCP client (src/connectors/google/client.ts `GoogleWorkspaceClient`, or a fixture fake in tests). */
  client: TextToolPort & { close?(): Promise<void> };
}

export function directMcpRuntime(o: DirectMcpRuntimeOptions): ConnectorRuntime {
  return {
    kind: 'direct_mcp',
    connector: o.connector,
    readTools: o.readTools,
    async call(tool: string, args: Record<string, unknown>, opts?: RuntimeCallOptions): Promise<RuntimeCallResult> {
      guardTool(o.connector, o.readTools, tool);
      const done = startTrace(o.connector, 'direct_mcp', tool);
      try {
        const text = await o.client.call(tool, args, { ...(opts?.signal ? { signal: opts.signal } : {}), ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
        traceCall(opts, done(true));
        return { text, json: jsonOf(text), usage: { ...ZERO_USAGE }, cost: { usd: 0, estimated: false } };
      } catch (err) {
        traceCall(opts, done(false, { code: codeOf(err) }));
        throw err;
      }
    },
    estimateUsd: () => 0,
    health: () => o.client.health(),
    close: async () => {
      await o.client.close?.();
    },
  };
}

/**
 * The text port a fetcher reads through, over a runtime: `call` returns the tool's text, `health` the runtime's
 * probe. This is what the Google fetchers get injected (`GoogleTools` has the same shape).
 */
export function textPort(rt: ConnectorRuntime): TextToolPort {
  return {
    call: async (tool, args, opts) => (await rt.call(tool, args, { ...(opts?.signal ? { signal: opts.signal } : {}), ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })).text,
    health: () => (rt.health ? rt.health() : Promise.resolve({ state: 'ok', checkedAt: new Date().toISOString() })),
  };
}
