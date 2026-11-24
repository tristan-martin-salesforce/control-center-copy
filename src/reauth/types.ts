import type { ExecFn } from '../ops/exec';

export type ReauthKind = 'slack' | 'org62' | 'vdp' | 'google' | 'devbar_signin' | 'devbar_restart';

/** Every handler returns this shape (the Health page renders `message`, and `status` picks the button state). */
export interface ReauthResult {
  kind: ReauthKind;
  status:
    | 'launched' // a terminal / process was started; the user finishes it, then the status check flips
    | 'refreshed' // finished without the user
    | 'needs_user' // cannot finish unattended (MFA, browser step); `message` has the instructions
    | 'needs_confirm' // called without confirm:true; nothing happened
    | 'unavailable' // prerequisite missing (script, devbar, python)
    | 'failed';
  message: string;
  /** The exact command a human can run themselves (fallback text on the Health page). Never contains secrets. */
  command?: string;
}

/**
 * One state machine per dependency (11 R7): missing → installed → signed_out → expired → ok, plus offline (network)
 * and unknown (the probe itself failed; never shown as broken). `installed` means present but not working yet (a
 * daemon down, a server not answering).
 */
export const DEPENDENCY_STATES = ['missing', 'installed', 'signed_out', 'expired', 'ok', 'offline', 'unknown'] as const;
export type DependencyState = (typeof DEPENDENCY_STATES)[number];

/** The old 4-state answer a dependency state maps to (onboarding and Health keep reading `state`). */
export function legacyState(s: DependencyState): ReauthStatus['state'] {
  return s === 'ok' ? 'ok' : s === 'signed_out' || s === 'expired' ? 'auth_needed' : s === 'unknown' ? 'unknown' : s === 'offline' ? 'offline' : s === 'missing' ? 'auth_needed' : 'offline';
}

/** An old status (no `setupState`) as a dependency state: auth_needed is signed_out, or expired when the code says so. */
export function setupStateOf(st: Pick<ReauthStatus, 'state' | 'setupState' | 'code'>): DependencyState {
  if (st.setupState) return st.setupState;
  if (st.state === 'auth_needed') return st.code && /EXPIRED|COOKIE|REVOKED/.test(st.code) ? 'expired' : 'signed_out';
  return st.state;
}

export interface ReauthStatus {
  kind: ReauthKind;
  /** The old answer (onboarding, Health). Additive: `setupState` and `code` say more. */
  state: 'ok' | 'auth_needed' | 'offline' | 'unknown';
  message: string;
  /** 11 R7: where this dependency is in missing → installed → signed_out → expired → ok (plus offline, unknown). */
  setupState?: DependencyState;
  /** The error catalog's code for anything not ok (src/errors/catalog.ts). */
  code?: string;
}

export interface ReauthDeps {
  exec: ExecFn;
  /** Open Terminal.app and type+run a command. Tests inject a recorder; the real one is `openInTerminal`. */
  openTerminal: (command: string) => Promise<{ ok: boolean }>;
  /**
   * Start a long-running helper (browser-polling devbar commands) without waiting for it to finish. It does wait for
   * the process to start (spawn) or fail (error), so a missing program reports failure (CONN-5).
   */
  spawnDetached: (cmd: string, args: string[]) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  /** The claude binary (src/ops/claude-bin.ts); default `claude` on PATH. */
  claudeBin?: string;
  now: () => number;
  home: string;
  /** Path to ~/.claude.json (VDP cookie lives there). */
  claudeJson: string;
  /** Does this file exist? (default: the real file system; tests inject one) */
  exists?: (path: string) => boolean;
}

export interface ReauthHandler {
  kind: ReauthKind;
  /** Read-only. Never triggers auth. */
  status(): Promise<ReauthStatus>;
  /** The command a human would run (no side effects). */
  describe(): { command: string; instructions: string };
  /** Performs the action. Must be called with confirm:true or it does nothing. */
  act(opts: { confirm: boolean; /** VDP only: run without --no-window (opens Chromium for MFA) in Terminal. */ window?: boolean }): Promise<ReauthResult>;
}
