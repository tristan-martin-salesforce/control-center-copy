/**
 * Filesystem locations for local state, logs and LaunchAgents.
 * Everything honours env overrides so tests never touch the real directories.
 * State lives outside the repo (CLAUDE.md invariant 6).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { STATE_FOLDER_NAME } from '../lib/state-folder';
import { pg17Bin } from './brew';

export const APP_PORT = 4327;
export const WEB_LABEL = 'com.commandcenter.web';
export const WORKER_LABEL = 'com.commandcenter.worker';
export const DB_NAME = 'command_center';
/** Homebrew's Postgres 17 binaries (`<brew prefix>/opt/postgresql@17/bin`; Apple Silicon or Intel). */
export const PG17_BIN: string = pg17Bin();

type Env = Record<string, string | undefined>;

/**
 * The state folder's name under ~/Library/Application Support (and the logs folder's under ~/Library/Logs). ONE
 * constant: the rename chunk (Command Center, H-10b) changes it here and adds the folder migration on update. Its
 * twin for the plain .mjs ops scripts is scripts/ops/lib/paths.mjs `STATE_FOLDER_NAME`; keep the two in step.
 */
export { STATE_FOLDER_NAME };

export function stateDir(env: Env = process.env): string {
  return env.CC_STATE_DIR ?? join(homedir(), 'Library', 'Application Support', STATE_FOLDER_NAME);
}
export function logDir(env: Env = process.env): string {
  return env.CC_LOG_DIR ?? join(homedir(), 'Library', 'Logs', STATE_FOLDER_NAME);
}
export function launchAgentsDir(env: Env = process.env): string {
  return env.CC_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
}
export const envFilePath = (env: Env = process.env) => join(stateDir(env), 'env');
export const heartbeatPath = (env: Env = process.env) => join(stateDir(env), 'worker.heartbeat');
export const workerPidPath = (env: Env = process.env) => join(stateDir(env), 'worker.pid');
export const backupsDir = (env: Env = process.env) => join(stateDir(env), 'backups');
export const profilePath = (env: Env = process.env) => join(stateDir(env), 'profile.json');
export const notifyStatePath = (env: Env = process.env) => join(stateDir(env), 'notify-state.json');
export const reauthLockPath = (env: Env = process.env) => join(stateDir(env), 'reauth.lock');
export const plistPath = (label: string, env: Env = process.env) => join(launchAgentsDir(env), `${label}.plist`);

/**
 * Compiled releases (PKG-2, D-90): `<state>/releases/<version>/` each, `current` a symlink to the one that runs (the
 * LaunchAgents point at it), `state.json` the install history (scripts/ops/lib/install-release.mjs writes both).
 */
export const releasesDir = (env: Env = process.env) => env.CC_RELEASES_DIR ?? join(stateDir(env), 'releases');
export const currentReleaseLink = (env: Env = process.env) => join(releasesDir(env), 'current');
/** The worker's last update check (src/jobs/handlers/update-check.ts): GET /version's `update` reads it. */
export const updateCheckPath = (env: Env = process.env) => join(stateDir(env), 'update-check.json');
