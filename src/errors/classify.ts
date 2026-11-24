/**
 * One classifier for every failure (08 R2, 11 R5): `classify(connector, err)` → a catalog code with its cause, next
 * step and button. Per-source classifiers run first (Slack and Org62 through Claude Code's MCP, Google through devbar,
 * VDP's own HTTP client), then the shared signatures (src/llm/errors.ts) through the alias table. Signature codes and
 * catalog codes only leave here, never message text (*tenet: Local data, privacy-safe logs*).
 */
import { classifyError, errorText, type ErrorClass } from '@/llm/errors';

import { familyOf, toCatalogCode, type SourceFamily } from './aliases';
import { entryOf, type CatalogAction, type CatalogEntry, type RetryPolicy } from './catalog';
import { isParseDrift } from './drift';
import { gatewayConfigured } from './gateway';

export interface ClassifyContext {
  /** Whether a company AI gateway (apiKeyHelper / gateway env) is configured: decides "sign in to devbar" vs "/login". */
  gatewayConfigured?: boolean;
}

export interface Classified {
  code: string;
  /** The shared signature code (src/llm/errors.ts), kept for logs and the rows that still read it. */
  legacy: string;
  /** The scanner's retry class (auth pauses, transient/rate back off, config waits, unknown retries a few times). */
  errorClass: ErrorClass;
  gateway: boolean;
  cause: string;
  nextStep: string;
  action?: CatalogAction;
  retry: RetryPolicy;
}

interface Sig {
  re: RegExp;
  code: string | ((ctx: Required<ClassifyContext>) => string);
}

/** Claude Code itself (every Claude-relayed read, the Assistant, the scanners' model steps). First for every source. */
const CLAUDE_CLI: Sig[] = [
  { re: /claude code executable|spawn \S*claude\S* ENOENT|ENOENT[^\n]*\bclaude\b|claude: command not found|executable_missing/i, code: 'DEP.CLAUDE.MISSING' },
  { re: /unknown option|unrecognized (?:option|argument)|requires? (?:a )?newer version of claude|please (?:update|upgrade) claude(?: code)?|claude code (?:version )?\S* is (?:too old|not supported)|cli_outdated/i, code: 'DEP.CLAUDE.TOO_OLD' },
  { re: /usage limit|limit (?:reached|exceeded)[^\n]*reset|\b(?:5-hour|weekly) limit\b|llm_usage_limit/i, code: 'RATE.LLM.USAGE_LIMIT' },
  { re: /credit balance (?:is )?too low|insufficient (?:credit|funds)|billing (?:issue|error|required)|llm_credit/i, code: 'RATE.LLM.CREDIT' },
  { re: /please run \/login|not logged in|run `?claude`? (?:and )?\/login|llm_signed_out/i, code: 'AUTH.LLM.SIGNED_OUT' },
  { re: /invalid api key|fix external api key|apiKeyHelper|authentication_failed/i, code: (c) => (c.gatewayConfigured ? 'AUTH.LLM.GATEWAY_KEY' : 'AUTH.LLM.SIGNED_OUT') },
  { re: /model_not_found|invalid model|unknown model/i, code: 'AUTH.LLM.MODEL_ACCESS' },
];

/** Slack and Org62: remote MCP servers declared in Claude Code; their OAuth lives in Claude Code's store. */
const CLAUDE_MCP: Sig[] = [
  { re: /is not declared in the user Claude config|MCP server \S+ (?:is )?(?:not declared|not configured|missing)|server_not_declared|No MCP server (?:named|found)/i, code: 'MCP.SERVER_NOT_DECLARED' },
  { re: /\bREQUEST_LIMIT_EXCEEDED\b/, code: 'RATE.ORG62.REQUEST_LIMIT' },
  { re: /\b(MALFORMED_QUERY|INVALID_FIELD|INVALID_TYPE|INVALID_QUERY_FILTER_OPERATOR)\b/, code: 'DATA.SOQL_INVALID' },
];

/** Google through devbar: missing, daemon down, signed out, connector not connected, the gateway's outage. */
const DEVBAR: Sig[] = [
  { re: /\[devbar_missing\]|devbar(?:: command)? not found|spawn devbar ENOENT|devbar isn't installed|devbar is not installed/i, code: 'DEP.DEVBAR.MISSING' },
  { re: /down for maintenance|under maintenance|\[gateway_down\]|Streamable HTTP error|upstream request failed|\[gateway_error\]/i, code: 'NET.GATEWAY_DOWN' },
  { re: /\[daemon_down\]|ECONNREFUSED[^\n]*13316|devbar daemon is not listening|devbar's background service/i, code: 'DEP.DEVBAR.DAEMON_DOWN' },
  { re: /\[devbar_signed_out\]|devbar is signed out/i, code: 'AUTH.GOOGLE.DEVBAR_SIGNED_OUT' },
  { re: /\[connector_disconnected\]|google-workspace-readonly connector is (?!connected)|Google isn't connected/i, code: 'AUTH.GOOGLE.CONNECTOR_MISSING' },
  { re: /\[auth\]|invalid_grant|does not have a valid token|Request had invalid authentication credentials/i, code: 'AUTH.GOOGLE.EXPIRED' },
  { re: /\[rate_limited\]|rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i, code: 'RATE.GOOGLE' },
  { re: /\[(?:not_found|no_access|bad_request)\]/, code: 'DATA.FILE_UNAVAILABLE' },
];

/** VDP's HTTP client (src/connectors/vdp/http.ts) and its sign-in script (src/reauth/handlers.ts). */
const VDP: Sig[] = [
  { re: /\(pat_revoked\)|pat_revoked/, code: 'AUTH.VDP.PAT_REVOKED' },
  { re: /\(pat_missing\)|PAT missing|the VDP PAT is missing/i, code: 'AUTH.VDP.NO_PAT' },
  { re: /\bnot_configured\b|VDP is not configured/i, code: 'AUTH.VDP.NOT_CONFIGURED' },
  { re: /needs MFA|Okta needs MFA/i, code: 'AUTH.VDP.MFA' },
  { re: /\((?:cookie_expired|cookie_missing|sso_redirect|sso_html|http_401)\)|cookie expired|cookie lapsed/i, code: 'AUTH.VDP.COOKIE_EXPIRED' },
  { re: /corporate network or Zscaler|VDP is unreachable|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|off.?network/i, code: 'NET.VPN_REQUIRED' },
  { re: /refresh script is not at|no refresh script/i, code: 'DEP.VDP.NO_SCRIPT' },
  { re: /has Playwright|No module named ['"]?playwright|import playwright/i, code: 'DEP.PYTHON.NO_PLAYWRIGHT' },
  { re: /\(?429\b|rate limited/i, code: 'RATE.VDP' },
];

/** The Outbox's destinations (Slack, Gmail, VDP, Org62 writes after Apply). Mirrors src/outbox/errors.ts. */
const PER_FAMILY: Partial<Record<SourceFamily, Sig[]>> = {
  slack: CLAUDE_MCP,
  org62: CLAUDE_MCP,
  google: DEVBAR,
  vdp: VDP,
};

/** Catalog class → the scanner's retry class. A few codes override it (below). */
function scannerClass(e: CatalogEntry, legacy: ErrorClass): ErrorClass {
  switch (e.code) {
    case 'DEP.DEVBAR.DAEMON_DOWN':
      return 'transient';
    case 'DATA.FILE_UNAVAILABLE':
      return 'unknown';
    case 'BUG.TOOL_BLOCKED':
    case 'DATA.PARSE_DRIFT':
    case 'AUTH.VDP.NOT_CONFIGURED':
      return 'config';
    case 'BUG.UNKNOWN':
      return legacy === 'unknown' ? 'unknown' : legacy;
  }
  switch (e.class) {
    case 'auth':
      return 'auth';
    case 'network':
      return 'transient';
    case 'rate':
      return 'rate_limited';
    case 'dependency':
    case 'data':
      return 'config';
    default:
      return 'unknown';
  }
}

const pick = (sigs: Sig[], text: string, ctx: Required<ClassifyContext>): string | null => {
  for (const s of sigs) if (s.re.test(text)) return typeof s.code === 'function' ? s.code(ctx) : s.code;
  return null;
};

/** The code for `err` read from `connector` (a scanner connector id, 'llm', or null for app-level errors). */
export function classifyCode(connector: string | null | undefined, err: unknown, ctx: ClassifyContext = {}): { code: string; legacy: ReturnType<typeof classifyError> } {
  const text = errorText(err);
  const legacy = classifyError(err);
  const c: Required<ClassifyContext> = { gatewayConfigured: ctx.gatewayConfigured ?? (legacy.gateway || /invalid api key|authentication_failed/i.test(text) ? gatewayConfigured() : false) };
  if (isParseDrift(err)) return { code: 'DATA.PARSE_DRIFT', legacy };
  const fam = familyOf(connector);
  // the source's own signatures first (a VDP "requires re-auth (pat_revoked)" is not a generic auth error), then
  // Claude Code's (every relayed read runs through it), then the shared table through the aliases
  const own = (fam && PER_FAMILY[fam] ? pick(PER_FAMILY[fam]!, text, c) : null) ?? pick(CLAUDE_CLI, text, c);
  if (own) return { code: own, legacy };
  // the shared signatures name the gateway's key; anything else maps through the alias table for this source
  if (legacy.code === 'gateway_invalid_api_key') return { code: c.gatewayConfigured ? 'AUTH.LLM.GATEWAY_KEY' : 'AUTH.LLM.SIGNED_OUT', legacy };
  return { code: toCatalogCode(legacy.code, connector) ?? 'BUG.UNKNOWN', legacy };
}

/** `classify(connector, err)`: the code, the scanner's retry class and the user-facing cause, next step and button. */
export function classify(connector: string | null | undefined, err: unknown, ctx: ClassifyContext = {}): Classified {
  const { code, legacy } = classifyCode(connector, err, ctx);
  const e = entryOf(code);
  return {
    code: e.code,
    legacy: legacy.code,
    errorClass: scannerClass(e, legacy.errorClass),
    gateway: e.code === 'AUTH.LLM.GATEWAY_KEY',
    cause: e.userText,
    nextStep: e.nextStep,
    ...(e.action ? { action: e.action } : {}),
    retry: e.retry,
  };
}

/** How many times an unrecognised failure is retried before the scope stops and asks for a report (CC_UNKNOWN_MAX_RETRIES). */
export function unknownRetryLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CC_UNKNOWN_MAX_RETRIES);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 5;
}

export type FailureDecision = { kind: 'retry' } | { kind: 'pause'; code: string };

/**
 * After a failed run: keep the scanner's own retry, or pause the scope. A pause_source code (parse drift, a blocked
 * tool, a missing server) pauses at once, except sign-ins (the runtime's auth pause owns those, with its re-probe);
 * BUG.UNKNOWN pauses as BUG.UNKNOWN_STOPPED after `limit` failures in a row. A success resets the count.
 */
export function failureDecision(code: string, consecutiveFailures: number, limit = unknownRetryLimit()): FailureDecision {
  const e = entryOf(code);
  if (e.code === 'BUG.UNKNOWN') return consecutiveFailures >= limit ? { kind: 'pause', code: 'BUG.UNKNOWN_STOPPED' } : { kind: 'retry' };
  if (e.retry === 'pause_source' && e.class !== 'auth' && e.class !== 'rate') return { kind: 'pause', code: e.code };
  return { kind: 'retry' };
}
