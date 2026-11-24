/**
 * Read-only helpers shared by doctor and the re-auth status checks:
 *  - parse `claude mcp list` (names + connection state only; URLs and headers are dropped)
 *  - inspect the vdp-app-fir entry in ~/.claude.json WITHOUT ever returning the PAT or cookie value
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, type ExecFn } from './exec';

export type McpState = 'connected' | 'needs_auth' | 'failed' | 'unknown';
export interface McpServerStatus {
  name: string;
  state: McpState;
}

export const SLACK_SERVER = 'slack';
export const ORG62_SERVER = 'Org62-Sobject-Read';
export const VDP_SERVER = 'vdp-app-fir';

export function parseMcpList(stdout: string): McpServerStatus[] {
  const out: McpServerStatus[] = [];
  for (const line of stdout.split('\n')) {
    // "name: <url or command> (HTTP) - ✔ Connected"
    const m = /^([^\s:][^:]*?):\s+.*\s-\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const text = m[2] ?? '';
    const state: McpState = /needs auth|authenticat/i.test(text)
      ? 'needs_auth'
      : /fail|✗|error|unreachable/i.test(text)
        ? 'failed'
        : /connected|✔|✓/i.test(text)
          ? 'connected'
          : 'unknown';
    out.push({ name: m[1]!.trim(), state });
  }
  return out;
}

/** `claude mcp list` health-checks each server but does not start any OAuth flow. It can take ~10-40 s. */
export async function listMcp(exec: ExecFn = run, claudeBin = 'claude'): Promise<{ ok: boolean; servers: McpServerStatus[]; missing?: boolean }> {
  const r = await exec(claudeBin, ['mcp', 'list'], { timeoutMs: 90_000 });
  // the CLI itself is not installed (spawn ENOENT): DEP.CLAUDE.MISSING, not "could not list"
  if (r.spawnError === 'ENOENT') return { ok: false, servers: [], missing: true };
  if (r.code !== 0 || r.spawnError) return { ok: false, servers: [] };
  return { ok: true, servers: parseMcpList(r.stdout) };
}

export const findServer = (servers: McpServerStatus[], name: string) =>
  servers.find((s) => s.name.toLowerCase() === name.toLowerCase());

export interface VdpInfo {
  configured: boolean;
  hasPat: boolean;
  hasCookie: boolean;
  /** Seconds until the cookie JWT expires; negative when expired; null when unknown. */
  cookieSecondsLeft: number | null;
}

export function jwtExp(token: string): number | null {
  try {
    const b64 = token.split('.')[1] ?? '';
    const payload = JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export function readVdpInfo(opts: { claudeJson?: string; now?: () => number } = {}): VdpInfo {
  const path = opts.claudeJson ?? join(homedir(), '.claude.json');
  const now = (opts.now ?? Date.now)();
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    const entry = cfg.mcpServers?.[VDP_SERVER];
    if (!entry) return { configured: false, hasPat: false, hasCookie: false, cookieSecondsLeft: null };
    const headers = entry.headers ?? {};
    const hasPat = Boolean(headers.Authorization?.trim());
    let cookieVal: string | undefined;
    for (const part of (headers.Cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === 'central_proxy_session' && v.length) cookieVal = v.join('=');
    }
    const exp = cookieVal ? jwtExp(cookieVal) : null;
    return {
      configured: true,
      hasPat,
      hasCookie: Boolean(cookieVal),
      cookieSecondsLeft: exp === null ? null : Math.floor(exp - now / 1000),
    };
  } catch {
    return { configured: false, hasPat: false, hasCookie: false, cookieSecondsLeft: null };
  }
}
