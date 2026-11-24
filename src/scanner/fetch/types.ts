/**
 * Fetch by code (FTI, review 04 §4.1 #1, decision H-3): every scope has one `fetch(scope, window) → raw[]`.
 *
 *   Slack, Org62   fixed queries per scope, one MCP tool call each through the connector's `claude_relay` runtime
 *                  (the smallest Claude run that calls exactly that tool), paged by code, recorded by REC-1 / REC-2
 *                  from the tool result exactly as the agentic path records them (same source_items rows, same keys
 *                  and hashes)
 *   Google, Drive, Notes, Claude sessions, VDP   their existing `DeterministicFetcher` (direct MCP or local files)
 *
 * A fetch reports what it covered and where its cursor is; it never decides what an item means.
 */
import type { ConnectorRuntime, RuntimeUsage } from '@/connectors/runtime/types';
import type { CcRunState } from '@/llm/cc-tools';

import type { CoverageObject, Cursor, ScanContext, ScannerStore, TimeWindow } from '../types';

/** One relay read the fetch made (booked as a `pass` row: `fetch:relay:<connector>:<tool>`). */
export interface FetchCall {
  tool: string;
  ok: boolean;
  code?: string;
  usd: number;
  usage: RuntimeUsage;
  /** ledgerHash of model + tool + arguments (the relay's own content hash; never the arguments). */
  contentHash: string;
  ms: number;
  /** Rows / messages the result held. */
  rows: number;
}

export interface FetchRequest {
  scope: string;
  window: TimeWindow;
  /** incremental | head | backfill | continuation | retry | targeted | manual */
  mode: string;
  ctx: ScanContext;
  /** Scope values from the spec (channel label, Org62 account ids, persona book…). */
  vars: Record<string, string | number | boolean | undefined>;
  runtime: ConnectorRuntime;
  /** REC-1 / REC-2 write through the run's cc state into the store. */
  store: ScannerStore;
  state: CcRunState;
  signal: AbortSignal;
  /** Pages per query in this run (code owns paging, so this is a time and cost bound, not a model limit). */
  maxPages?: number;
  /** Each relay read as it returns, paid or failed (the FTI runner traces its `pass` row at once, so a kill mid-run can still book it). */
  onCall?: (c: FetchCall) => void | Promise<void>;
}

export interface ScopeFetchResult {
  coverage: CoverageObject[];
  cursor: Cursor;
  /** False: a query paged out; the runtime continues from `cursor.at`. */
  complete: boolean;
  calls: FetchCall[];
  /** Messages / rows the tool results held (before dedupe). */
  read: number;
}

/** A fetch that could not finish (a relay error): the run fails with this class and the runtime retries. */
export class ScopeFetchError extends Error {
  override name = 'ScopeFetchError';
  constructor(
    message: string,
    readonly errorClass: 'auth' | 'transient' | 'rate_limited' | 'config' | 'unknown',
    readonly code: string,
    readonly calls: FetchCall[],
  ) {
    super(message);
  }
}

/** A relay failure code (src/connectors/slack/manifest.ts RELAY_FAILURE_CODES) → its error class. */
export function relayErrorClass(code: string): ScopeFetchError['errorClass'] {
  if (/^(needs_auth|invalid_auth|http_401|sso_redirect|gateway_invalid_api_key)$/.test(code)) return 'auth';
  if (code === 'rate_limited') return 'rate_limited';
  if (/^(network|overloaded|timeout|maintenance|gateway_error|no_result|cost_cap)$/.test(code)) return 'transient';
  if (/^(config|executable_missing|disallowed_tool|soql_invalid)$/.test(code)) return 'config';
  return 'unknown';
}
