/**
 * Shared environment for every Agent SDK child process (scanner SkillRunner, NBA `complete.ts`, chat).
 *
 * Problem (brief 09 §3.1, SKILLS-NBA finding): a child `claude` started from inside the Claude desktop
 * app or a Claude terminal inherits host-session variables (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`,
 * `CLAUDE_PID`, the parent's `ANTHROPIC_BASE_URL`, …) that point at the parent's auth channel, and fails
 * with "Invalid API key". Fix:
 *   1. never pass host-session variables to the child;
 *   2. pass the user's own gateway config explicitly: the `env` block of ~/.claude/settings.json and
 *      `settings: { apiKeyHelper }`. The CLI runs the helper itself, so this process never sees the key.
 * Nothing here is hard-coded to one user (tenet: Config over code); values come from the user's settings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { brewPrefix } from '../ops/brew';
import { resolveClaudeBin } from '../ops/claude-bin';

/** The `claude` binary every child process runs; doctor checks the same one (src/ops/claude-bin.ts, PKG-6). */
export function claudeExecutable(source: NodeJS.ProcessEnv = process.env): string {
  return resolveClaudeBin({ env: source });
}

/** Host-session variables a child Claude process must not inherit. */
export const HOST_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_PID',
] as const;

/** Prefixes stripped from an inherited env: host session and parent auth. Gateway env re-adds what is needed. */
const HOST_PREFIXES = ['CLAUDE_CODE_', 'CLAUDECODE', 'ANTHROPIC_', 'CLAUDE_AGENT_SDK_'];

export interface GatewayConfig {
  /** `env` block of the user's Claude settings (gateway base URL, Bedrock flags, CA certs…). Not secret by contract. */
  env: Record<string, string>;
  /** Command the CLI runs to obtain the key. Passed through; never executed or logged here. */
  apiKeyHelper?: string;
}

export function claudeSettingsPath(source: NodeJS.ProcessEnv = process.env): string {
  return source.CC_CLAUDE_SETTINGS ?? path.join(os.homedir(), '.claude', 'settings.json');
}

/** Read the user's gateway config. Missing or unreadable settings → empty config (the CLI then uses its defaults). */
export function claudeGatewayConfig(file = claudeSettingsPath()): GatewayConfig {
  if (!fs.existsSync(file)) return { env: {} };
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { env?: Record<string, unknown>; apiKeyHelper?: unknown };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env ?? {})) if (typeof v === 'string') env[k] = v;
    return { env, ...(typeof s.apiKeyHelper === 'string' ? { apiKeyHelper: s.apiKeyHelper } : {}) };
  } catch {
    return { env: {} };
  }
}

const isHostVar = (k: string) => (HOST_SESSION_VARS as readonly string[]).includes(k) || HOST_PREFIXES.some((p) => k.startsWith(p));

/**
 * Inherit-style child env (drop-in for `complete.ts`): the parent env minus host-session and parent-auth
 * variables, plus the gateway env. Use `scannerEnv()` for the stricter allowlist the scanners use.
 */
export function childEnv(gatewayEnv: Record<string, string>, source: NodeJS.ProcessEnv = process.env, app = 'command-center/0.1'): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (typeof v === 'string' && !isHostVar(k)) env[k] = v;
  return { ...env, ...gatewayEnv, CLAUDE_AGENT_SDK_CLIENT_APP: app };
}

const PASS_THROUGH = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'TZ'] as const;

/**
 * Allowlist env for scanner runs (brief 09 §3.1: `env -i HOME USER PATH …`): only basic process vars,
 * a PATH that finds the pinned CLI and devbar, and the gateway env. Nothing else from the parent.
 */
export function scannerEnv(gatewayEnv: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = source[k];
    if (v) env[k] = v;
  }
  const home = env.HOME ?? os.homedir();
  env.HOME = home;
  env.PATH = [path.join(home, '.local/bin'), path.join(home, '.devbar/bin'), path.join(brewPrefix(), 'bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((p, i, a) => a.indexOf(p) === i)
    .join(':');
  return { ...env, ...gatewayEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'command-center-scanner/1', ...extra };
}

/** Options fragment for `query()`: env + apiKeyHelper. Spread into Options. */
export function gatewayQueryOptions(gw: GatewayConfig = claudeGatewayConfig(), mode: 'scanner' | 'inherit' = 'scanner'): { env: Record<string, string>; settings?: { apiKeyHelper: string } } {
  return {
    env: mode === 'scanner' ? scannerEnv(gw.env) : childEnv(gw.env),
    ...(gw.apiKeyHelper ? { settings: { apiKeyHelper: gw.apiKeyHelper } } : {}),
  };
}

/**
 * COST-8 (review 04 §4.6 #3): scanners and relays load no Claude settings files. With `['user']` a teammate's
 * `~/.claude/settings.json` (hooks, plugins, output style, env) applied to every scan call, so cost and behaviour
 * drifted per machine (tenet: Low upkeep, team-portable). What the runs need from those settings is passed explicitly
 * instead: the gateway `env` block and `apiKeyHelper` (claudeGatewayConfig), and the MCP servers (strictMcpConfig).
 *
 * Fallback: `CC_SCANNER_SETTING_SOURCES=user` (comma-separated: user, project, local) restores the old behaviour if
 * MCP OAuth resolution turns out to need the user settings on some machine. Unknown values are ignored.
 */
export function scannerSettingSources(source: NodeJS.ProcessEnv = process.env): Array<'user' | 'project' | 'local'> {
  const raw = (source.CC_SCANNER_SETTING_SOURCES ?? '').trim();
  if (!raw) return [];
  const ok = new Set(['user', 'project', 'local']);
  return [...new Set(raw.split(',').map((x) => x.trim()).filter((x): x is 'user' | 'project' | 'local' => ok.has(x)))];
}
