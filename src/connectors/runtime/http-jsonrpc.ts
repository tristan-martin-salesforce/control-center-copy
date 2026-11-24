/**
 * `http_jsonrpc`: a direct JSON-RPC `tools/call` over fetch (VDP's vdp-app-fir, decision D1 (a) in 08: the app reads
 * the PAT and cookie from the Claude config per call, in memory only). The transport function is the connector's own
 * (src/connectors/vdp/http.ts `callVdpTool`), so its typed `VdpError`s pass through unchanged. No model: zero cost.
 */
import type { ConnectorId } from '@/scanner/types';

import { codeOf, guardTool, startTrace, traceCall } from './guard';
import { ZERO_USAGE, type ConnectorRuntime, type RuntimeCallOptions, type RuntimeCallResult } from './types';

/** One `tools/call`: the tool's text and its structured value (or null). */
export type JsonRpcCall = (tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number }) => Promise<{ text: string; json: unknown }>;

export interface HttpJsonRpcRuntimeOptions {
  connector: ConnectorId;
  readTools: readonly string[];
  rpc: JsonRpcCall;
}

export function httpJsonRpcRuntime(o: HttpJsonRpcRuntimeOptions): ConnectorRuntime {
  return {
    kind: 'http_jsonrpc',
    connector: o.connector,
    readTools: o.readTools,
    async call(tool: string, args: Record<string, unknown>, opts?: RuntimeCallOptions): Promise<RuntimeCallResult> {
      guardTool(o.connector, o.readTools, tool);
      const done = startTrace(o.connector, 'http_jsonrpc', tool);
      try {
        const r = await o.rpc(tool, args, { ...(opts?.signal ? { signal: opts.signal } : {}), ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
        traceCall(opts, done(true));
        return { text: r.text, json: r.json, usage: { ...ZERO_USAGE }, cost: { usd: 0, estimated: false } };
      } catch (err) {
        traceCall(opts, done(false, { code: codeOf(err) }));
        throw err;
      }
    },
    estimateUsd: () => 0,
  };
}
