/**
 * Which `claude` binary the app runs (PKG-6): one resolver for the scanners, the Assistant, the feedback agent and
 * doctor, so doctor checks the binary the runners will use. Order: CC_CLAUDE_BIN → ~/.local/bin/claude (the native
 * installer) → /opt/homebrew/bin/claude → the first `claude` on PATH. When none exists it answers
 * ~/.local/bin/claude, so a run fails as `executable_missing` and doctor says where it looked.
 */
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface ClaudeBinDeps {
  env?: Record<string, string | undefined>;
  home?: string;
  /** True when `path` is an executable file. */
  executable?: (path: string) => boolean;
}

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The places looked at, in order (doctor prints them when none has the CLI). */
export function claudeBinCandidates({ env = process.env, home = env.HOME || homedir() }: Pick<ClaudeBinDeps, 'env' | 'home'> = {}): string[] {
  const fromPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'claude'));
  return [join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', ...fromPath].filter((p, i, a) => a.indexOf(p) === i);
}

/** The resolved binary and whether it was found (`CC_CLAUDE_BIN` is taken as given: the user said so). */
export function findClaudeBin(deps: ClaudeBinDeps = {}): { path: string; found: boolean; source: 'env' | 'search' | 'default' } {
  const env = deps.env ?? process.env;
  const home = deps.home ?? (env.HOME || homedir());
  const executable = deps.executable ?? isExecutable;
  const pinned = env.CC_CLAUDE_BIN?.trim();
  if (pinned) return { path: pinned, found: executable(pinned), source: 'env' };
  const hit = claudeBinCandidates({ env, home }).find((p) => executable(p));
  return hit ? { path: hit, found: true, source: 'search' } : { path: join(home, '.local', 'bin', 'claude'), found: false, source: 'default' };
}

/** The `claude` binary to run. */
export function resolveClaudeBin(deps: ClaudeBinDeps = {}): string {
  return findClaudeBin(deps).path;
}
