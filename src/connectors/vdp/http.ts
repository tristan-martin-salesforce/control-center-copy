/**
 * The VDP MCP JSON-RPC core (internal). One `tools/call` per request against the stateless Streamable HTTP endpoint
 * (`POST <url>`, JSON or SSE answer). Claude Code's own MCP attachment is not used: `resolveServerDecl` deliberately
 * drops headers, and VDP needs two of them.
 *
 * Credentials: the PAT (`Authorization`) and the Okta gateway cookie (`Cookie: central_proxy_session=…`) are read
 * from `~/.claude.json` at call time, used only as request headers, and never stored, logged or returned. Every
 * error message is redacted, and any literal header value is scrubbed from it too (CLAUDE.md invariant 3). The
 * refresh script rewrites the cookie in place about hourly, so reading per call picks up a refresh at once.
 *
 * A lapsed cookie answers 302 → the Okta host, or 200 text/html: both become a `VdpAuthError` (Health: re-auth VDP).
 * Only `./client.ts` (reads) and `./write.ts` (Outbox writes) may import this file (guard test).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { redact } from '../redact';
import { assertVdpTool, VDP_SERVER_NAME, type VdpToolKind } from './tools';

export type VdpErrorCode =
  | 'not_configured'
  | 'pat_missing'
  | 'cookie_missing'
  | 'cookie_expired'
  | 'sso_redirect'
  | 'sso_html'
  | 'http_401'
  /** CONN-11: refused while the gateway cookie is fresh, so the PAT itself was revoked (AUTH.VDP.PAT_REVOKED). */
  | 'pat_revoked'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'network'
  | 'timeout'
  | 'bad_response'
  | 'rpc_error'
  | 'tool_error';

export class VdpError extends Error {
  override name = 'VdpError';
  constructor(
    readonly code: VdpErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * The gateway or the app refused the credentials. The message reads "requires re-auth", which the scanner's error
 * classifier maps to `auth` (Health: "VDP: needs re-auth", the refresh-script re-auth button).
 */
export class VdpAuthError extends VdpError {
  override name = 'VdpAuthError';
  constructor(code: VdpErrorCode, detail: string) {
    super(code, `VDP requires re-auth (${code}): ${detail}`, false);
  }
}

export interface VdpHttpOptions {
  /** Path of the Claude config holding the vdp-app-fir entry. Default `CC_CLAUDE_JSON` or `~/.claude.json`. */
  claudeJson?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30 s (Heroku's router limit). */
  timeoutMs?: number;
  now?: () => number;
}

export interface VdpToolResult {
  /** The tool's text content (JSON for most VDP tools, markdown for list tools). */
  text: string;
  /** `structuredContent` when the tool sends one, else the text parsed as JSON, else null. */
  json: unknown;
}

interface Creds {
  url: string;
  authorization: string;
  cookie: string;
  /** Literal secret values, scrubbed from every error message. */
  secrets: string[];
}

export const claudeJsonPath = (o: Pick<VdpHttpOptions, 'claudeJson'> = {}) => o.claudeJson ?? process.env.CC_CLAUDE_JSON ?? join(homedir(), '.claude.json');

/** Seconds since epoch the JWT expires, or null. Never returns any part of the token. */
export function jwtExpSeconds(token: string): number | null {
  try {
    const b64 = token.split('.')[1] ?? '';
    const payload = JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * When the JWT was issued (seconds since epoch): its `iat`, else `exp` less the gateway's one-hour lifetime; null when
 * unreadable. Never returns any part of the token.
 */
export function jwtIssuedAtSeconds(token: string, lifetimeS = 3600): number | null {
  try {
    const b64 = token.split('.')[1] ?? '';
    const p = JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { iat?: unknown; exp?: unknown };
    if (typeof p.iat === 'number') return p.iat;
    return typeof p.exp === 'number' ? p.exp - lifetimeS : null;
  } catch {
    return null;
  }
}

/** E3: when the stored gateway cookie was issued (ms), from the Claude config alone (no network); null when unknown. */
export function vdpCookieIssuedAtMs(o: VdpHttpOptions = {}): number | null {
  try {
    const v = cookieValue(readCreds(o).cookie);
    const iat = v ? jwtIssuedAtSeconds(v) : null;
    return iat === null ? null : iat * 1000;
  } catch {
    return null;
  }
}

export function cookieValue(cookieHeader: string, name = 'central_proxy_session'): string | null {
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name && v.length) return v.join('=');
  }
  return null;
}

/** Read the vdp-app-fir entry. Errors name what is missing, never a value. */
function readCreds(o: VdpHttpOptions): Creds {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(claudeJsonPath(o), 'utf8'));
  } catch {
    throw new VdpError('not_configured', `VDP is not configured: cannot read the Claude config for ${VDP_SERVER_NAME}`, false);
  }
  const entry = ((raw as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})[VDP_SERVER_NAME] as { url?: unknown; headers?: Record<string, unknown> } | undefined;
  if (!entry || typeof entry.url !== 'string') throw new VdpError('not_configured', `VDP is not configured: no ${VDP_SERVER_NAME} entry with a url in the Claude config`, false);
  const headers = entry.headers ?? {};
  const authorization = typeof headers.Authorization === 'string' ? headers.Authorization.trim() : '';
  const cookie = typeof headers.Cookie === 'string' ? headers.Cookie.trim() : '';
  if (!authorization) throw new VdpAuthError('pat_missing', 'the VDP PAT is missing (an admin issues it)');
  if (!cookie) throw new VdpAuthError('cookie_missing', 'the Okta gateway cookie is missing');
  const session = cookieValue(cookie);
  const secrets = [authorization, authorization.replace(/^Bearer\s+/i, ''), cookie, ...(session ? [session] : [])].filter((s) => s.length >= 8);
  return { url: entry.url, authorization, cookie, secrets };
}

/** Redact credential-like text, scrub the literal header values, cap the length. */
export function scrub(text: string, secrets: string[] = [], max = 300): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join('[REDACTED]');
  t = redact(t).text;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Gateway cookie state without its value: seconds left (negative when expired), or null when absent/unreadable. */
export function vdpCookieSecondsLeft(o: VdpHttpOptions = {}): { configured: boolean; hasPat: boolean; secondsLeft: number | null } {
  try {
    const c = readCreds(o);
    const v = cookieValue(c.cookie);
    const exp = v ? jwtExpSeconds(v) : null;
    return { configured: true, hasPat: true, secondsLeft: exp === null ? null : Math.floor(exp - (o.now ?? Date.now)() / 1000) };
  } catch (e) {
    if (e instanceof VdpAuthError && e.code === 'pat_missing') return { configured: true, hasPat: false, secondsLeft: null };
    if (e instanceof VdpAuthError) return { configured: true, hasPat: true, secondsLeft: null };
    return { configured: false, hasPat: false, secondsLeft: null };
  }
}

let rpcId = 0;

interface RpcMessage {
  id?: unknown;
  result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
  error?: { code?: number; message?: string };
}

/** The JSON-RPC message for `id` from a JSON or an SSE (`data:` lines) body. */
export function parseRpcBody(body: string, contentType: string, id: number): RpcMessage | null {
  const pick = (m: unknown): RpcMessage | null => {
    if (Array.isArray(m)) return (m.map(pick).find(Boolean) as RpcMessage | undefined) ?? null;
    const x = m as RpcMessage | null;
    return x && typeof x === 'object' && (x.id === id || x.id === String(id)) && ('result' in x || 'error' in x) ? x : null;
  };
  if (/text\/event-stream/i.test(contentType)) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const hit = pick(JSON.parse(data));
        if (hit) return hit;
      } catch {
        /* not JSON: skip the event */
      }
    }
    return null;
  }
  try {
    return pick(JSON.parse(body));
  } catch {
    return null;
  }
}

/** One JSON-RPC request to the VDP endpoint: the credential, redirect, status and body checks every call shares. */
async function rpc(method: 'tools/call' | 'tools/list', params: Record<string, unknown>, label: string, o: VdpHttpOptions & { signal?: AbortSignal }): Promise<{ msg: RpcMessage; creds: Creds }> {
  const creds = readCreds(o);
  const now = (o.now ?? Date.now)();
  const session = cookieValue(creds.cookie);
  const exp = session ? jwtExpSeconds(session) : null;
  if (exp !== null && exp * 1000 <= now) throw new VdpAuthError('cookie_expired', `the Okta gateway cookie expired ${Math.round((now / 1000 - exp) / 60)} min ago`);
  const id = ++rpcId;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 30_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(creds.url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: creds.authorization, cookie: creds.cookie },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  } catch (err) {
    if (o.signal?.aborted) throw err;
    const e = err as { name?: string; code?: string; cause?: { code?: string } };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new VdpError('timeout', `VDP ${label} timed out`, true);
    const code = e.cause?.code ?? e.code ?? 'fetch failed';
    throw new VdpError('network', scrub(`VDP is unreachable (${code}; corporate network or Zscaler needed)`, creds.secrets), true);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    const host = /^https?:\/\/([^/?#]+)/i.exec(loc)?.[1] ?? 'the sign-in page';
    throw new VdpAuthError('sso_redirect', `the gateway redirected to ${host} (the Okta cookie lapsed)`);
  }
  // CONN-11: a refusal while the cookie still has more than a minute left is the PAT's (revoked, expired): re-auth
  // can't fix it, an admin's new PAT can. Without a readable expiry it stays ambiguous (http_401).
  if (res.status === 401 || res.status === 403) {
    if (exp !== null && exp * 1000 - now > 60_000) throw new VdpAuthError('pat_revoked', `HTTP ${res.status} unauthorized while the gateway cookie is valid (the VDP access token was refused)`);
    throw new VdpAuthError('http_401', `HTTP ${res.status} unauthorized (PAT or gateway cookie refused)`);
  }
  if (res.status === 429) throw new VdpError('rate_limited', `VDP rate limited ${label} (429 too many requests; 60 calls a minute)`, true);
  if (res.status >= 500) throw new VdpError('server_error', `VDP server error on ${label} (HTTP ${res.status})`, true);
  if (/text\/html/i.test(ct)) throw new VdpAuthError('sso_html', 'the gateway answered with an HTML sign-in page (the Okta cookie lapsed)');
  const body = await res.text();
  if (res.status >= 400) throw new VdpError('http_error', scrub(`VDP ${label} failed (HTTP ${res.status}): ${body}`, creds.secrets, 200), false);
  const msg = parseRpcBody(body, ct, id);
  if (!msg) throw new VdpError('bad_response', `VDP ${label}: the response held no JSON-RPC result`, true);
  if (msg.error) throw new VdpError('rpc_error', scrub(`VDP ${label}: JSON-RPC error ${msg.error.code ?? ''} ${msg.error.message ?? ''}`.trim(), creds.secrets, 200), false);
  return { msg, creds };
}

/**
 * One `tools/call`. `kind` names the allowlist the tool must be on; `assertVdpTool` refuses deletes and generation
 * always. Throws `VdpAuthError` for a lapsed gateway session, `VdpError` for everything else (codes, no bodies).
 */
export async function callVdpTool(tool: string, args: Record<string, unknown>, kind: VdpToolKind, o: VdpHttpOptions & { signal?: AbortSignal } = {}): Promise<VdpToolResult> {
  assertVdpTool(tool, kind);
  const { msg, creds } = await rpc('tools/call', { name: tool, arguments: args }, tool, o);
  const text = (msg.result?.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  if (msg.result?.isError) throw new VdpError('tool_error', scrub(`VDP ${tool} returned an error: ${text}`, creds.secrets, 240), false);
  let json: unknown = msg.result?.structuredContent ?? null;
  if (json === null) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { text, json };
}

/**
 * `tools/list` (feature detection, D-59): the raw result pages (`{tools, nextCursor}`), at most `maxPages`. A protocol
 * read that calls no tool; the caller keeps only tool names and argument names (parse.ts `parseToolList`).
 */
export async function listVdpTools(o: VdpHttpOptions & { signal?: AbortSignal; maxPages?: number } = {}): Promise<{ tools: unknown[] }> {
  const tools: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < (o.maxPages ?? 5); page++) {
    const { msg } = await rpc('tools/list', cursor ? { cursor } : {}, 'tools/list', o);
    const r = (msg.result ?? {}) as { tools?: unknown; nextCursor?: unknown };
    if (Array.isArray(r.tools)) tools.push(...r.tools);
    cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
    if (!cursor) break;
  }
  return { tools };
}
