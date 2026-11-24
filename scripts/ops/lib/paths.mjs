// Where the ops scripts keep things: the twin of src/ops/paths.ts for plain .mjs (the app can't import from scripts/
// without bundling it, and these scripts run without tsx). Keep the two in step; STATE_FOLDER_NAME is the one
// constant the rename chunk (Command Center, H-10b) changes.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_FOLDER_NAME = 'command-center';
export const APP_PORT = 4327;

/** @param {Record<string, string | undefined>} [env] */
export const stateDir = (env = process.env) => env.CC_STATE_DIR ?? join(env.HOME || homedir(), 'Library', 'Application Support', STATE_FOLDER_NAME);
/** @param {Record<string, string | undefined>} [env] */
export const logDir = (env = process.env) => env.CC_LOG_DIR ?? join(env.HOME || homedir(), 'Library', 'Logs', STATE_FOLDER_NAME);
/** @param {Record<string, string | undefined>} [env] */
export const launchAgentsDir = (env = process.env) => env.CC_LAUNCH_AGENTS_DIR ?? join(env.HOME || homedir(), 'Library', 'LaunchAgents');
/** `<state>/releases`: one folder per installed version, `current` → the one that runs, `state.json` the history. */
export const releasesDir = (env = process.env) => env.CC_RELEASES_DIR ?? join(stateDir(env), 'releases');
export const currentLink = (env = process.env) => join(releasesDir(env), 'current');
export const envFilePath = (env = process.env) => join(stateDir(env), 'env');
export const updateCheckPath = (env = process.env) => join(stateDir(env), 'update-check.json');

// ---- the bundled Postgres 17 cluster (D-98, 12-pglite-spike.md §4): everything under <state>/pg/ ----
/** `<state>/pg`: the cluster's folder (data, socket, engine copies, lock, the move marker). */
export const pgRoot = (env = process.env) => env.CC_PG_DIR ?? join(stateDir(env), 'pg');
/** The data directory (initdb'd once; PG_VERSION says its major). */
export const pgDataDir = (env = process.env) => join(pgRoot(env), 'data');
/**
 * The unix socket folder (`listen_addresses = ''`: no TCP port at all). CC_PG_SOCKET_DIR moves it when the default
 * path is too long for macOS (the socket path may hold at most 103 bytes) or a test needs a short one.
 */
export const pgRunDir = (env = process.env) => env.CC_PG_SOCKET_DIR ?? join(pgRoot(env), 'run');
/** Engine copies (bin, lib, share of @embedded-postgres/darwin-<arch>), one folder per version: the db agent runs these. */
export const pgEngineRoot = (env = process.env) => join(pgRoot(env), 'engine');
/** The lifecycle lock (pid inside): one init / start / stop / move at a time. */
export const pgLockFile = (env = process.env) => join(pgRoot(env), 'cluster.lock');
/** Written when a 1.x Homebrew database was moved in: when, from which database (doctor's 14-day reminder). */
export const pgMovedMarker = (env = process.env) => join(pgRoot(env), 'moved-from-homebrew.json');

/**
 * `npm run <script>` in the installed release, as a person pastes it into any Terminal window (ON-11): the folder is
 * named, home-relative and quoted (Application Support has a space), since no Terminal opens in releases/current.
 * @param {string} script @param {Record<string, string | undefined>} [env]
 */
export function npmInCurrent(script, env = process.env) {
  const cur = currentLink(env);
  const home = env.HOME;
  return `npm --prefix "${home && cur.startsWith(`${home}/`) ? `$HOME${cur.slice(home.length)}` : cur}" run ${script}`;
}
