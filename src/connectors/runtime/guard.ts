/** Shared pieces of every runtime: the manifest allowlist gate, the trace event, a JSON read of tool text. */
import { assertReadOnly } from '@/llm/mcp-config';
import type { ConnectorId } from '@/scanner/types';

import { RuntimeToolRefused, type RuntimeCallOptions, type RuntimeKind, type RuntimeTraceEvent } from './types';

/**
 * The manifest's read allowlist, checked before anything is sent: the tool must be listed AND not look like a write
 * (the scanners' `assertReadOnly` regex, belt and braces with each transport's own lock).
 */
export function guardTool(connector: ConnectorId, readTools: readonly string[], tool: string): void {
  if (!readTools.includes(tool)) throw new RuntimeToolRefused(connector, tool);
  try {
    assertReadOnly([tool]);
  } catch {
    throw new RuntimeToolRefused(connector, tool);
  }
}

/** The structured value of a tool's text when it is JSON (`{…}` / `[…]`), else null. */
export function jsonOf(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Emit one trace event (ids, status, timing, code); a trace sink that throws never fails the call. */
export function traceCall(opts: RuntimeCallOptions | undefined, e: RuntimeTraceEvent): void {
  try {
    opts?.trace?.(e);
  } catch {
    /* tracing is best effort */
  }
}

export const codeOf = (err: unknown): string => {
  const e = err as { code?: unknown; info?: { signature?: unknown }; name?: unknown };
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.info?.signature === 'string') return e.info.signature;
  return typeof e?.name === 'string' ? e.name : 'error';
};

export const startTrace = (connector: ConnectorId, runtime: RuntimeKind, tool: string) => {
  const t0 = Date.now();
  return (ok: boolean, extra: Partial<RuntimeTraceEvent> = {}): RuntimeTraceEvent => ({ connector, runtime, tool, ok, ms: Date.now() - t0, ...extra });
};
