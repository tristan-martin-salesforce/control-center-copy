/**
 * One handler per connector (brief 09 §7). Each has a read-only `status()` and a confirm-gated `act()`.
 * None of them handle credentials: OAuth/MFA always happens in the user's own terminal or browser.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_VDP_REFRESH_SCRIPT } from '../contract/settings';
import { brewPrefix } from '../ops/brew';
import type { ExecFn } from '../ops/exec';
import { findServer, listMcp, ORG62_SERVER, readVdpInfo, SLACK_SERVER } from '../ops/mcp';
import { reauthLockPath } from '../ops/paths';
import { loginCommand } from './terminal';
import type { ReauthDeps, ReauthHandler, ReauthKind, ReauthResult, ReauthStatus } from './types';

const needsConfirm = (kind: ReauthKind, command?: string): ReauthResult => ({
  kind,
  status: 'needs_confirm',
  message: 'Nothing was done. Re-auth needs an explicit confirmation.',
  command,
});

// ------------------------------------------------------------- Slack / Org62 (claude mcp login)

/**
 * Whether `server` is declared in the user's Claude config: true / false, or null when the file can't be read (then
 * nothing is assumed). Names only; headers and tokens are never read out.
 */
export function serverDeclared(claudeJson: string, server: string): boolean | null {
  try {
    const cfg = JSON.parse(readFileSync(claudeJson, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return Object.keys(cfg.mcpServers ?? {}).some((n) => n.toLowerCase() === server.toLowerCase());
  } catch {
    return null;
  }
}

function mcpLoginHandler(kind: 'slack' | 'org62', server: string, label: string, deps: ReauthDeps): ReauthHandler {
  const command = loginCommand(server);
  // CONN-8: `claude mcp login` only works for a declared server; a missing one needs `claude mcp add` first
  const addCommand = `claude mcp add --transport http ${server} <server URL>`;
  const notDeclared = `${label} isn't set up in Claude Code yet (no "${server}" server). Add it first: ${addCommand} (the URL is in README, Troubleshooting), then sign in.`;
  return {
    kind,
    async status(): Promise<ReauthStatus> {
      const { ok, servers, missing } = await listMcp(deps.exec, deps.claudeBin);
      if (missing) return { kind, state: 'unknown', setupState: 'missing', code: 'DEP.CLAUDE.MISSING', message: `Claude Code isn't installed; ${label} is read through it.` };
      if (!ok) return { kind, state: 'unknown', setupState: 'unknown', message: 'Could not run "claude mcp list".' };
      const s = findServer(servers, server);
      if (!s) return { kind, state: 'auth_needed', setupState: 'missing', code: 'MCP.SERVER_NOT_DECLARED', message: notDeclared };
      if (s.state === 'connected') return { kind, state: 'ok', setupState: 'ok', message: `${label} is connected.` };
      if (s.state === 'needs_auth') return { kind, state: 'auth_needed', setupState: 'signed_out', code: kind === 'slack' ? 'AUTH.SLACK.SIGNED_OUT' : 'AUTH.ORG62.SIGNED_OUT', message: `${label} needs sign-in.` };
      return { kind, state: 'offline', setupState: 'offline', code: 'NET.SERVICE_DOWN', message: `${label} failed to connect (network or service).` };
    },
    describe: () => ({
      command,
      instructions: `Open Terminal and run: ${command}. A browser opens to sign in. Or, in any Claude session: /mcp, pick ${server}, Authenticate.`,
    }),
    async act({ confirm }): Promise<ReauthResult> {
      if (!confirm) return needsConfirm(kind, command);
      if (serverDeclared(deps.claudeJson, server) === false) return { kind, status: 'unavailable', command: addCommand, message: notDeclared };
      const r = await deps.openTerminal(command);
      return r.ok
        ? { kind, status: 'launched', command, message: `Terminal opened with "${command}". Finish the sign-in in the browser; Health re-checks automatically.` }
        : { kind, status: 'failed', command, message: `Could not open Terminal. Run this yourself: ${command}` };
    },
  };
}

export const slackHandler = (deps: ReauthDeps) => mcpLoginHandler('slack', SLACK_SERVER, 'Slack', deps);
export const org62Handler = (deps: ReauthDeps) => mcpLoginHandler('org62', ORG62_SERVER, 'Org62', deps);

// ------------------------------------------------------------- VDP (cookie refresh script)

export const VDP_MIN_LIFETIME_S = 10 * 60;
const MFA_MARKER = /needs MFA/i;

/** O_EXCL lock so two refreshes never race on ~/.claude.json. Stale after 10 minutes. */
export function takeLock(path: string, now: number): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* gone */
        }
      };
    } catch {
      try {
        if (now - statSync(path).mtimeMs > 10 * 60_000) unlinkSync(path);
        else return null;
      } catch {
        /* retry */
      }
    }
  }
  return null;
}

/** `~/x` → `<home>/x`; anything else unchanged. */
export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

/** Single-quoted for a shell (Terminal types the command). The settings regex already keeps quotes out. */
const shq = (s: string): string => (/^[A-Za-z0-9._\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The python3 that can run the refresh: it needs Playwright, and the first `python3` on a service's PATH is often a
 * Homebrew one without it. A configured interpreter wins; otherwise the first candidate that imports Playwright.
 */
export const PYTHON_CANDIDATES: string[] = ['/usr/bin/python3', 'python3', join(brewPrefix(), 'bin', 'python3'), '/usr/local/bin/python3'].filter((p, i, a) => a.indexOf(p) === i);
export async function resolvePython(exec: ExecFn, preferred?: string | null): Promise<string | null> {
  if (preferred) return preferred;
  for (const c of PYTHON_CANDIDATES) {
    const r = await exec(c, ['-c', 'import playwright'], { timeoutMs: 15_000 });
    if (!r.spawnError && r.code === 0) return c;
  }
  return null;
}

export interface VdpReauthOptions {
  /** The refresh script (Settings ▸ Sources; `~/` is the home folder). Default: DEFAULT_VDP_REFRESH_SCRIPT. */
  script?: string;
  /** The interpreter; empty or absent = resolvePython. */
  python?: string;
  lockPath?: string;
}

export function vdpHandler(deps: ReauthDeps, opts: VdpReauthOptions = {}): ReauthHandler {
  const script = expandHome(opts.script || DEFAULT_VDP_REFRESH_SCRIPT, deps.home);
  const exists = deps.exists ?? existsSync;
  const commandWith = (py: string, silent: boolean) => `${shq(py)} ${shq(script)}${silent ? ' --no-window' : ''}`;
  const windowCmd = commandWith(opts.python || 'python3', false);
  const silentCmd = commandWith(opts.python || 'python3', true);
  const noScript = (): ReauthResult => ({ kind: 'vdp', status: 'unavailable', command: windowCmd, message: `The VDP refresh script is not at ${script}. Set where it lives in Settings ▸ Sources.` });
  const noPython = (): ReauthResult => ({
    kind: 'vdp',
    status: 'unavailable',
    command: windowCmd,
    message: 'No python3 on this Mac has Playwright. Install it (python3 -m pip install playwright, then python3 -m playwright install chromium) or set the Python to use in Settings ▸ Sources.',
  });
  const info = () => readVdpInfo({ claudeJson: deps.claudeJson, now: deps.now });
  return {
    kind: 'vdp',
    async status(): Promise<ReauthStatus> {
      const v = info();
      if (!v.configured) return { kind: 'vdp', state: 'auth_needed', setupState: 'missing', code: 'AUTH.VDP.NOT_CONFIGURED', message: 'vdp-app-fir is not configured in ~/.claude.json (admin-issued PAT required).' };
      if (!v.hasPat) return { kind: 'vdp', state: 'auth_needed', setupState: 'missing', code: 'AUTH.VDP.NO_PAT', message: 'VDP PAT missing. Ask an admin for one.' };
      if (v.cookieSecondsLeft === null) return { kind: 'vdp', state: 'auth_needed', setupState: 'signed_out', code: 'AUTH.VDP.COOKIE_EXPIRED', message: 'VDP gateway cookie missing or unreadable.' };
      if (v.cookieSecondsLeft < VDP_MIN_LIFETIME_S) {
        return { kind: 'vdp', state: 'auth_needed', setupState: 'expired', code: 'AUTH.VDP.COOKIE_EXPIRED', message: v.cookieSecondsLeft <= 0 ? 'VDP gateway cookie expired.' : 'VDP gateway cookie expires soon.' };
      }
      return { kind: 'vdp', state: 'ok', setupState: 'ok', message: `VDP cookie valid for ${Math.round(v.cookieSecondsLeft / 60)} min.` };
    },
    describe: () => ({
      command: windowCmd,
      instructions: `Run in Terminal: ${windowCmd}. It refreshes silently if your Okta session is live; otherwise a browser window opens for MFA (5 min).`,
    }),
    async act({ confirm, window }): Promise<ReauthResult> {
      if (!confirm) return needsConfirm('vdp', windowCmd);
      if (!exists(script)) return noScript();
      const py = await resolvePython(deps.exec, opts.python);
      if (!py) return noPython();
      if (window) {
        const cmd = commandWith(py, false);
        const r = await deps.openTerminal(cmd);
        return r.ok
          ? { kind: 'vdp', status: 'launched', command: cmd, message: 'Terminal opened. Complete Okta MFA in the browser window that appears.' }
          : { kind: 'vdp', status: 'failed', command: cmd, message: `Could not open Terminal. Run this yourself: ${cmd}` };
      }
      const release = takeLock(opts.lockPath ?? reauthLockPath(), deps.now());
      if (!release) return { kind: 'vdp', status: 'failed', message: 'Another VDP refresh is already running.' };
      try {
        const r = await deps.exec(py, [script, '--no-window'], { timeoutMs: 60_000 });
        if (r.spawnError) return { ...noPython(), command: silentCmd };
        const out = `${r.stdout}\n${r.stderr}`;
        // The script exits 0 even when it skipped for MFA, so stdout and the cookie's exp are the truth.
        if (MFA_MARKER.test(out)) {
          return { kind: 'vdp', status: 'needs_user', command: commandWith(py, false), message: `Okta needs MFA. Click "Re-auth VDP (window)" or run in Terminal: ${commandWith(py, false)}` };
        }
        const v = info();
        if (v.cookieSecondsLeft !== null && v.cookieSecondsLeft >= VDP_MIN_LIFETIME_S) {
          return { kind: 'vdp', status: 'refreshed', message: `VDP cookie refreshed (${Math.round(v.cookieSecondsLeft / 60)} min left).` };
        }
        if (/off.?network|resolve|ENOTFOUND|ERR_NAME/i.test(out)) {
          return { kind: 'vdp', status: 'needs_user', message: 'VDP is unreachable. Connect to the corporate network or Zscaler, then retry.' };
        }
        return { kind: 'vdp', status: 'failed', command: commandWith(py, false), message: 'Refresh ran but the cookie is still not valid. Try the window mode.' };
      } finally {
        release();
      }
    },
  };
}

// ------------------------------------------------------------- Google (devbar)

interface DevbarSpec {
  kind: 'google' | 'devbar_signin' | 'devbar_restart';
  args: string[];
  label: string;
  instructions: string;
}
const DEVBAR: Record<DevbarSpec['kind'], DevbarSpec> = {
  google: {
    kind: 'google',
    args: ['mcpgw', 'connectors', 'connect', 'google-workspace-readonly'],
    label: 'Reconnect Google',
    instructions: 'Opens a browser to reconnect Google Workspace through devbar, then polls until it completes.',
  },
  devbar_signin: { kind: 'devbar_signin', args: ['auth', 'login'], label: 'Sign in to devbar', instructions: 'Opens a browser for devbar SSO.' },
  devbar_restart: { kind: 'devbar_restart', args: ['daemon', 'start'], label: 'Restart devbar', instructions: 'Starts the devbar daemon (no browser).' },
};

/** The JSON devbar printed; `missing` when the program is not installed (spawn ENOENT, CONN-5). */
async function devbarJson(deps: ReauthDeps, args: string[]): Promise<Record<string, unknown> | 'missing' | null> {
  const r = await deps.exec('devbar', args, { timeoutMs: 15_000 });
  if (r.spawnError === 'ENOENT') return 'missing';
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** CONN-5: what devbar is, for a teammate who has never heard of it. */
export const DEVBAR_MISSING_MESSAGE = 'devbar is not installed. Google (Gmail, Calendar, Drive, meeting notes) comes in through it: install devbar from the internal developer portal, then sign in.';

export function devbarHandler(deps: ReauthDeps, kind: DevbarSpec['kind'] = 'google'): ReauthHandler {
  const spec = DEVBAR[kind];
  const command = `devbar ${spec.args.join(' ')}`;
  return {
    kind,
    async status(): Promise<ReauthStatus> {
      const auth = await devbarJson(deps, ['auth', 'status', '--json']);
      if (auth === 'missing') return { kind, state: 'offline', setupState: 'missing', code: 'DEP.DEVBAR.MISSING', message: DEVBAR_MISSING_MESSAGE };
      if (!auth) return { kind, state: 'offline', setupState: 'unknown', message: 'devbar is not responding.' };
      if (auth.authenticated !== true) return { kind, state: 'auth_needed', setupState: 'signed_out', code: 'AUTH.GOOGLE.DEVBAR_SIGNED_OUT', message: 'devbar is signed out. Use "Sign in to devbar".' };
      const gw = await devbarJson(deps, ['mcpgw', 'status', '--json']);
      if (gw === 'missing' || !gw || gw.listener_ok !== true) return { kind, state: 'offline', setupState: 'installed', code: 'DEP.DEVBAR.DAEMON_DOWN', message: 'devbar gateway is not running. Use "Restart devbar".' };
      if (gw.upstream_ok === false || gw.auth_ok === false) return { kind, state: 'auth_needed', setupState: 'signed_out', code: 'AUTH.GOOGLE.CONNECTOR_MISSING', message: 'Google is not connected through devbar. Use "Reconnect Google".' };
      return { kind, state: 'ok', setupState: 'ok', message: 'devbar gateway is up and Google is connected.' };
    },
    describe: () => ({ command, instructions: spec.instructions }),
    async act({ confirm }): Promise<ReauthResult> {
      if (!confirm) return needsConfirm(kind, command);
      // waits for spawn/error: a devbar that is not installed reports that, never "started" (CONN-5)
      const r = await deps.spawnDetached('devbar', spec.args);
      if (r.ok) return { kind, status: 'launched', command, message: `${spec.label}: started. ${spec.instructions}` };
      if (r.error === 'ENOENT') return { kind, status: 'unavailable', command, message: DEVBAR_MISSING_MESSAGE };
      return { kind, status: 'unavailable', command, message: `Could not start devbar. Run this yourself: ${command}` };
    },
  };
}

export function allHandlers(deps: ReauthDeps, opts: { vdp?: VdpReauthOptions } = {}): Record<ReauthKind, ReauthHandler> {
  return {
    slack: slackHandler(deps),
    org62: org62Handler(deps),
    vdp: vdpHandler(deps, opts.vdp),
    google: devbarHandler(deps, 'google'),
    devbar_signin: devbarHandler(deps, 'devbar_signin'),
    devbar_restart: devbarHandler(deps, 'devbar_restart'),
  };
}
