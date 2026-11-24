/**
 * Old codes → catalog codes (11 R5): the four vocabularies before the catalog (src/llm/errors.ts signatures,
 * src/outbox/errors.ts delivery codes, src/server/errors.ts API codes, the scanner's app_events codes and
 * src/scanner/runtime/status-reason.ts phrases) keep reading. Stored rows are never rewritten: `app_events.code` and
 * `connectors.status_reason` are text, and every reader goes through `toCatalogCode`.
 */
import { CATALOG, isCatalogCode } from './catalog';

/** The source family a connector reads through (auth codes are per family). */
export type SourceFamily = 'slack' | 'org62' | 'google' | 'vdp' | 'local' | 'llm';

const GOOGLE = new Set(['gmail', 'calendar', 'drive', 'gemini_notes', 'gemini', 'notes', 'trainings', 'google']);

export function familyOf(connector: string | null | undefined): SourceFamily | null {
  if (!connector) return null;
  const c = connector.replace(/^scanner\./, '');
  if (c === 'slack' || c === 'watch') return 'slack';
  if (c === 'org62') return 'org62';
  if (GOOGLE.has(c)) return 'google';
  if (c === 'vdp') return 'vdp';
  if (c === 'claude_sessions' || c === 'claude') return 'local';
  if (c === 'llm') return 'llm';
  return null;
}

const authCode = (family: SourceFamily | null, kind: 'signed_out' | 'expired'): string => {
  switch (family) {
    case 'slack':
      return kind === 'signed_out' ? 'AUTH.SLACK.SIGNED_OUT' : 'AUTH.SLACK.EXPIRED';
    case 'org62':
      return kind === 'signed_out' ? 'AUTH.ORG62.SIGNED_OUT' : 'AUTH.ORG62.EXPIRED';
    case 'google':
      return 'AUTH.GOOGLE.EXPIRED';
    case 'vdp':
      return 'AUTH.VDP.COOKIE_EXPIRED';
    default:
      return 'AUTH.LLM.SIGNED_OUT';
  }
};

const rateCode = (family: SourceFamily | null): string => (family === 'org62' ? 'RATE.ORG62.REQUEST_LIMIT' : family === 'google' ? 'RATE.GOOGLE' : family === 'vdp' ? 'RATE.VDP' : 'RATE.SLACK');

/** Connector-independent aliases (the same everywhere). */
const FIXED: Record<string, string> = {
  // src/llm/errors.ts signature codes
  maintenance: 'NET.GATEWAY_DOWN',
  gateway_down: 'NET.GATEWAY_DOWN',
  gateway_error: 'NET.GATEWAY_DOWN',
  gateway_invalid_api_key: 'AUTH.LLM.GATEWAY_KEY',
  disallowed_tool: 'BUG.TOOL_BLOCKED',
  slack_scope: 'DATA.SLACK_SCOPE',
  soql_invalid: 'DATA.SOQL_INVALID',
  model_not_found: 'AUTH.LLM.MODEL_ACCESS',
  executable_missing: 'DEP.CLAUDE.MISSING',
  skill_missing: 'BUG.SKILL_MISSING',
  network: 'NET.OFFLINE',
  overloaded: 'NET.SERVICE_DOWN',
  timeout: 'NET.TIMEOUT',
  mcp_failed: 'NET.SERVICE_DOWN',
  mcp_disabled: 'DEP.MCP.DISABLED',
  unknown: 'BUG.UNKNOWN',
  // google client signatures (src/connectors/google/client.ts)
  daemon_down: 'DEP.DEVBAR.DAEMON_DOWN',
  devbar_missing: 'DEP.DEVBAR.MISSING',
  devbar_signed_out: 'AUTH.GOOGLE.DEVBAR_SIGNED_OUT',
  connector_disconnected: 'AUTH.GOOGLE.CONNECTOR_MISSING',
  not_found: 'DATA.FILE_UNAVAILABLE',
  no_access: 'DATA.FILE_UNAVAILABLE',
  bad_request: 'DATA.FILE_UNAVAILABLE',
  transient: 'NET.SERVICE_DOWN',
  config: 'BUG.UNKNOWN',
  parse_drift: 'DATA.PARSE_DRIFT',
  ParseDrift: 'DATA.PARSE_DRIFT',
  // VDP client codes (src/connectors/vdp/http.ts)
  not_configured: 'AUTH.VDP.NOT_CONFIGURED',
  pat_missing: 'AUTH.VDP.NO_PAT',
  pat_revoked: 'AUTH.VDP.PAT_REVOKED',
  cookie_missing: 'AUTH.VDP.COOKIE_EXPIRED',
  cookie_expired: 'AUTH.VDP.COOKIE_EXPIRED',
  cookie_expiring: 'AUTH.VDP.COOKIE_EXPIRED',
  sso_html: 'AUTH.VDP.COOKIE_EXPIRED',
  server_error: 'NET.SERVICE_DOWN',
  bad_response: 'NET.SERVICE_DOWN',
  rpc_error: 'BUG.UNKNOWN',
  tool_error: 'BUG.UNKNOWN',
  http_error: 'BUG.UNKNOWN',
  vpn_required: 'NET.VPN_REQUIRED',
  needs_mfa: 'AUTH.VDP.MFA',
  // src/outbox/errors.ts delivery codes
  not_sent: 'SEND.NOT_SENT',
  not_confirmed: 'SEND.NOT_CONFIRMED',
  tool_refused: 'SEND.TOOL_REFUSED',
  live_disabled: 'SEND.LIVE_DISABLED',
  channel_not_found: 'SEND.CHANNEL_NOT_FOUND',
  not_in_channel: 'SEND.NOT_IN_CHANNEL',
  is_archived: 'SEND.ARCHIVED',
  attached_draft_exists: 'SEND.DRAFT_EXISTS',
  msg_too_long: 'SEND.TOO_LONG',
  invalid_request: 'SEND.REJECTED',
  failed_to_create_draft: 'SEND.DRAFT_FAILED',
  preflight_failed: 'SEND.PREFLIGHT',
  // src/server/errors.ts API codes
  conflict: 'DATA.CONFLICT',
  validation: 'DATA.INVALID_INPUT',
  upstream_unavailable: 'NET.SERVICE_DOWN',
  budget_exceeded: 'RATE.BUDGET',
  dry_run: 'SEND.DRY_RUN',
  internal: 'BUG.UNHANDLED',
  // app_events codes written before the catalog (worker, scanner store, schema guard, crash policy)
  schema_mismatch: 'DATA.SCHEMA_BEHIND',
  scan_run_failed: 'BUG.UNKNOWN',
  job_dead_lettered: 'BUG.UNKNOWN',
  budget_hard_cap: 'RATE.BUDGET',
  worker_dead: 'DEP.WORKER.DOWN',
};

/** Aliases whose catalog code depends on the source (an expired sign-in is AUTH.SLACK.EXPIRED for Slack). */
const BY_FAMILY: Record<string, (f: SourceFamily | null) => string> = {
  needs_auth: (f) => authCode(f, 'signed_out'),
  auth_needed: (f) => authCode(f, 'signed_out'),
  auth_required: (f) => authCode(f, 'signed_out'),
  invalid_auth: (f) => authCode(f, 'expired'),
  http_401: (f) => authCode(f, 'expired'),
  sso_redirect: (f) => authCode(f, 'expired'),
  auth: (f) => (f === 'google' ? 'AUTH.GOOGLE.EXPIRED' : f === null ? 'AUTH.SEND.SIGNED_OUT' : authCode(f, 'expired')),
  rate_limited: (f) => (f === null ? 'RATE.SEND' : rateCode(f)),
};

/**
 * Any code (catalog, or an old one from any of the vocabularies) → a catalog code, or null when it is not an error
 * code at all. `connector` resolves per-source aliases ("invalid_auth" on org62 → AUTH.ORG62.EXPIRED).
 */
export function toCatalogCode(raw: string | null | undefined, connector?: string | null): string | null {
  if (!raw) return null;
  const code = raw.trim();
  if (isCatalogCode(code)) return code;
  const fam = familyOf(connector);
  const by = BY_FAMILY[code];
  if (by) return by(fam);
  if (FIXED[code]) return FIXED[code]!;
  return null;
}

/** Old status-reason phrases (connectors.status_reason) → codes, for rows written before the catalog. */
const LEGACY_PHRASES: Array<[RegExp, (f: SourceFamily | null) => string]> = [
  [/down for maintenance|MCP gateway isn't answering|gateway isn't answering/i, () => 'NET.GATEWAY_DOWN'],
  [/needs re-auth/i, (f) => authCode(f, 'expired')],
  [/rate limited, retrying/i, (f) => rateCode(f)],
  [/temporarily unavailable, retrying/i, () => 'NET.SERVICE_DOWN'],
  [/outside the read-only allowlist was blocked/i, () => 'BUG.TOOL_BLOCKED'],
  [/a file couldn't be (?:found|read)|a file isn't shared with you/i, () => 'DATA.FILE_UNAVAILABLE'],
  [/devbar daemon is not listening/i, () => 'DEP.DEVBAR.DAEMON_DOWN'],
  [/devbar is signed out/i, () => 'AUTH.GOOGLE.DEVBAR_SIGNED_OUT'],
  [/connector is (?!connected)\w+/i, () => 'AUTH.GOOGLE.CONNECTOR_MISSING'],
  [/^a run failed$/i, () => 'BUG.UNKNOWN'],
];

/**
 * A Health status line ("Slack inbox: needs re-auth") → its catalog code. A line the catalog wrote (its `reason`)
 * reads back exactly; an older line through LEGACY_PHRASES; anything else (a run hit its cost cap, a split) is null:
 * those are the runtime's own statuses, not errors.
 */
export function codeFromStatusReason(line: string | null | undefined, connector?: string | null): string | null {
  if (!line) return null;
  const reason = line.replace(/^[^:]{1,60}:\s*/, '').trim();
  const fam = familyOf(connector);
  const exact = REASON_INDEX.get(reason.toLowerCase());
  if (exact) {
    // "needs re-auth" is shared by every source's sign-in codes: the connector decides which
    if (exact.length === 1) return exact[0]!;
    const byFam = exact.find((c) => c === authCode(fam, 'expired')) ?? exact.find((c) => c === authCode(fam, 'signed_out')) ?? exact.find((c) => c === rateCode(fam));
    return byFam ?? exact[0]!;
  }
  for (const [re, fn] of LEGACY_PHRASES) if (re.test(reason)) return fn(fam);
  return null;
}

const REASON_INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const e of Object.values(CATALOG)) {
    const key = (e.reason ?? e.userTitle).toLowerCase();
    m.set(key, [...(m.get(key) ?? []), e.code]);
  }
  return m;
})();
