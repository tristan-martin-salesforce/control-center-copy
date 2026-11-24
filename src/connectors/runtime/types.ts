/**
 * ConnectorRuntime: HOW a source's read tool gets called (08-connectors-providers §4, R7; decision H-3). One seam,
 * four transports:
 *
 *   claude_relay  a minimal Claude run that calls exactly ONE MCP tool and returns its raw output (Slack, Org62: their
 *                 OAuth lives in Claude Code's store, so reads go through `claude`; src/llm/one-call.ts)
 *   direct_mcp    our own MCP client; the gateway owns auth and the app sees no token (Google via devbar mcpgw)
 *   http_jsonrpc  direct JSON-RPC over fetch (VDP's vdp-app-fir)
 *   local_files   files on this machine (Claude sessions)
 *
 * Every runtime owns the read-only allowlist of its connector's manifest: a tool not on `readTools` is refused before
 * anything is sent (*tenet: Read-only ingest*, CLAUDE.md invariant 2). Transport errors keep their own typed classes
 * (GoogleCallError, VdpError …) so the error catalog still classifies them; the relay, which has no exception of its
 * own, throws `RuntimeCallError` with the cost it already spent.
 *
 * Logging and traces carry ids, statuses, timings and codes only (*tenet: Local data, privacy-safe logs*).
 */
import type { ConnectorHealthProbe, ConnectorId, ReauthKind } from '@/scanner/types';

export type RuntimeKind = 'claude_relay' | 'direct_mcp' | 'http_jsonrpc' | 'local_files';

/** Token use of one runtime call. All zero for transports without a model (direct_mcp, http_jsonrpc, local_files). */
export interface RuntimeUsage {
  /** Uncached input; cache reads and writes are their own fields (D0). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Model requests the call made (0 without a model). */
  turns: number;
  /** Prompt tokens of the first request: the fixed prefix a relay pays per call (`llm_calls.first_prompt_tokens`). */
  prefixTokens: number;
  model?: string;
}

export const ZERO_USAGE: Readonly<RuntimeUsage> = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, prefixTokens: 0 });

/** One trace event per call: ids, status, timing and the error code; never arguments or results. */
export interface RuntimeTraceEvent {
  connector: ConnectorId;
  runtime: RuntimeKind;
  tool: string;
  ok: boolean;
  ms: number;
  code?: string;
  usd?: number;
  turns?: number;
}
export type RuntimeTrace = (e: RuntimeTraceEvent) => void;

export interface RuntimeCallOptions {
  /** The most this call may spend (claude_relay: the run's `maxBudgetUsd` cap). Ignored by transports without a model. */
  budget?: { usd: number };
  timeoutMs?: number;
  trace?: RuntimeTrace;
  signal?: AbortSignal;
}

export interface RuntimeCallResult {
  /** The tool's text output (always set on success; JSON tools carry the parsed value in `json` too). */
  text: string;
  /** Structured result when the tool sends one or its text is JSON; else null. */
  json: unknown;
  usage: RuntimeUsage;
  cost: { usd: number; estimated: boolean };
}

export interface ConnectorRuntime {
  readonly kind: RuntimeKind;
  readonly connector: ConnectorId;
  /** The read tools this runtime may call (its manifest's `readTools`). */
  readonly readTools: readonly string[];
  call(tool: string, args: Record<string, unknown>, opts?: RuntimeCallOptions): Promise<RuntimeCallResult>;
  /**
   * What one call of `tool` is expected to cost (USD) before it is made, so the spend governor can hold first. A
   * transport without a model returns 0; the relay returns the p90 of its recent calls (cap when it has none).
   */
  estimateUsd(tool: string): number;
  health?(): Promise<ConnectorHealthProbe>;
  close?(): Promise<void>;
}

/** A tool outside the manifest's read allowlist. Thrown before a byte is sent. */
export class RuntimeToolRefused extends Error {
  override name = 'RuntimeToolRefused';
  constructor(
    readonly connector: ConnectorId,
    readonly tool: string,
  ) {
    super(`${connector} runtime: tool "${tool}" is not on its read-only allowlist`);
  }
}

/** A call that did not return the tool's output (relay: timeout, cost cap, server not declared …). Codes, no bodies. */
export class RuntimeCallError extends Error {
  override name = 'RuntimeCallError';
  constructor(
    readonly connector: ConnectorId,
    readonly tool: string,
    readonly code: string,
    message: string,
    readonly usage: RuntimeUsage = { ...ZERO_USAGE },
    readonly cost: { usd: number; estimated: boolean } = { usd: 0, estimated: false },
    /** False when nothing reached the server (the tool was never called), so a retry cannot double-read. */
    readonly called = true,
  ) {
    super(message);
  }
}

/** The plain text port the Google fetchers read through (the same shape as `GoogleTools`). */
export interface TextToolPort {
  call(tool: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
  health(): Promise<ConnectorHealthProbe>;
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

/** Who holds the credential. The app never holds one except VDP's (decision D1 in 08). */
export type AuthKind = 'claude_mcp_oauth' | 'devbar_gateway' | 'pat_cookie' | 'none';

/**
 * How the sign-in is checked without a read: `claude_mcp_status` (the run's init `mcp_servers[].status`),
 * `devbar_status` (devbar's daemon + connector list), `cookie_exp` (the VDP cookie JWT `exp`, no network), `none`.
 */
export type AuthCheck = 'claude_mcp_status' | 'devbar_status' | 'cookie_exp' | 'none';

export interface ConnectorManifest {
  id: ConnectorId;
  /** What the screen calls it. */
  label: string;
  runtime: RuntimeKind;
  /** The MCP server name as declared in `~/.claude.json` (claude_relay) or the gateway's server (direct_mcp). */
  server?: string;
  /** Scope names (or templates like `channel:<id>`) the connector scans. */
  scopes: readonly string[];
  auth: {
    kind: AuthKind;
    check: AuthCheck;
    /** The re-auth handler kind (src/reauth) and what the user is told; null when nothing can be started. */
    reauthHint: { handler: 'slack' | 'org62' | 'google' | 'vdp' | null; kind: ReauthKind | null; hint: string };
  };
  /** The read tools it may call. Every one is on the read allowlist (tests/connectors/registry.test.ts). */
  readTools: readonly string[];
  /** How far back a scope with no cursor starts (`default`) and the deepest catch-up after downtime (`max`), ms. */
  windows: { default: number; max: number };
  /** Base poll cadence (ms) before backoff and work-hour multipliers (src/scanner/runtime/cadence.ts). */
  cadence: { baseMs: number };
  /** Planning number for Settings and the governor's first estimate; measured spend comes from `llm_calls`. */
  estimate: { usdPerDay: number };
  /** A cheap, read-only probe (one allowlisted read, or the config alone). */
  healthCheck(runtime: ConnectorRuntime): Promise<ConnectorHealthProbe>;
  /** The parsers that turn this source's raw tool output into rows (pure, fixture-tested). */
  parse: Readonly<Record<string, (...args: never[]) => unknown>>;
  /** Error codes this connector can report (the catalog's codes; src/llm/errors.ts, google/client.ts, vdp/http.ts). */
  failureCodes: readonly string[];
  /** How the scanner drives it (registry dispatch in src/scanner/runtime/connectors.ts). */
  scan: {
    /** traversal: the skill agent calls the read tools; deterministic: a fetcher reads and the agent interprets. */
    mode: 'traversal' | 'deterministic';
    /** `skills/<skill>.md`. */
    skill: string;
    /** Deterministic only: backfill chunk (ms). */
    chunkMs?: number;
    /** Deterministic only: first-scan backfill chunk (ms), when it differs from `chunkMs`. */
    firstScanChunkMs?: number;
    /** Deterministic only: items handed to one agent run. */
    maxItemsPerRun?: number;
    /** The source is current state, not a feed: history windows make no call (VDP, like Org62's `book`). */
    readsCurrentState?: boolean;
    /** An auth pause survives a restart until the stored sign-in is refreshed (E3; VDP's hourly cookie). */
    persistAuthPause?: boolean;
    /** Hybrid (scan-watch): the deterministic plan's agent also reads these tools of another connector's server. */
    hybrid?: { via: ConnectorId; tools: readonly string[] };
    /** A file watcher feeds it between sweeps (Claude sessions). */
    watcher?: boolean;
  };
}
