#!/usr/bin/env node
// launchd service wrapper for the web and worker agents.
//   node run-service.mjs --name web|worker --env-file <path> --log-dir <dir> [--no-wait-pg] -- <command> [args...]
// Does: load env file (values never logged) -> wait for Postgres with backoff -> run the command with its
// output going to a size-rotated log (secrets scrubbed) -> forward SIGTERM/SIGINT -> exit with the child's code
// so launchd's KeepAlive + ThrottleInterval handle restarts.
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile, secretValues } from './lib/envfile.mjs';
import { RotatingLog } from './lib/logrotate.mjs';
import { resolveDatabaseUrl } from './lib/pg.mjs';
import { migrationNeeded, migrationPaths } from './lib/migrate-state.mjs';
import { readyCheckFor, waitForPostgres } from './lib/pgwait.mjs';

function parseArgs(argv) {
  const i = argv.indexOf('--');
  const head = i >= 0 ? argv.slice(0, i) : argv;
  const cmd = i >= 0 ? argv.slice(i + 1) : [];
  const opt = {};
  for (let k = 0; k < head.length; k++) {
    if (head[k] === '--no-wait-pg') opt.noWaitPg = true;
    else if (head[k].startsWith('--')) opt[head[k].slice(2)] = head[++k];
  }
  return { opt, cmd };
}

const { opt, cmd } = parseArgs(process.argv.slice(2));
if (!opt.name || !opt['log-dir'] || cmd.length === 0) {
  console.error('usage: run-service.mjs --name <web|worker> --env-file <path> --log-dir <dir> -- <command...>');
  process.exit(64);
}

// D-101: a 1.x install's agents start here on the new code with the old folder still in place. The folder move
// stops them, so it runs in its own process (own session: launchd's bootout of this job does not reach it) and this
// start ends; the move starts the agents again under the new labels. An agent already under the new label waits for a
// move that is still finishing.
if (migrationNeeded(process.env)) {
  const p = migrationPaths(process.env);
  const old = String(opt['env-file'] ?? '').startsWith(p.oldState);
  let out = 'ignore';
  try {
    out = openSync(join(opt['log-dir'], 'migrate.log'), 'a');
  } catch {
    /* the log folder may not exist yet */
  }
  spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'migrate-state.mjs'), '--quick'], { detached: true, stdio: ['ignore', out, out] }).unref();
  if (old) process.exit(0);
  for (let i = 0; i < 90 && migrationNeeded(process.env); i++) await new Promise((res) => setTimeout(res, 2000));
}

// W34-1: an orphan under an old label (the 1.x updater started it after the move) has an env file in the vanished old
// folder; it stops itself instead of waiting for a database that is not there. The move boots the old label out.
if (opt['env-file'] && !existsSync(opt['env-file']) && String(opt['env-file']).startsWith(migrationPaths(process.env).oldState) && !existsSync(migrationPaths(process.env).oldState)) {
  console.error(`[run-service:${opt.name}] the old folder no longer exists (Command Center moved to ${migrationPaths(process.env).newState}); this old-label service stops`);
  process.exit(0);
}

const fileEnv = (opt['env-file'] && readEnvFile(opt['env-file'])) || {};
const log = new RotatingLog(join(opt['log-dir'], `${opt.name}.log`), {
  maxBytes: Number(process.env.CC_LOG_MAX_BYTES) || 10 * 1024 * 1024,
  keep: Number(process.env.CC_LOG_KEEP) || 5,
  scrub: secretValues(fileEnv),
});
const say = (m) => log.write(`${new Date().toISOString()} [run-service:${opt.name}] ${m}\n`);

say(`starting (env file ${opt['env-file'] ? (Object.keys(fileEnv).length ? `loaded, ${Object.keys(fileEnv).length} keys` : 'missing or empty') : 'not set'})`);

const abort = new AbortController();
let child = null;
let stopping = false;
const onSignal = (sig) => {
  stopping = true;
  abort.abort();
  say(`${sig} received`);
  if (child) child.kill(sig);
  else process.exit(0);
};
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

if (!opt.noWaitPg) {
  // the database the child will use (its env: the env file over the plist's), the bundled socket when none is set
  const url = resolveDatabaseUrl({ ...process.env, ...fileEnv }, fileEnv);
  const ready = await waitForPostgres({ check: readyCheckFor(url), log: say, signal: abort.signal });
  if (!ready) process.exit(0);
  say('postgres ready');
}

// CC_SUPERVISED: the worker counts its starts only under launchd (crash-loop detection, src/ops/crash.ts)
child = spawn(cmd[0], cmd.slice(1), { env: { ...process.env, ...fileEnv, CC_SUPERVISED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => log.write(d));
child.stderr.on('data', (d) => log.write(d));
child.on('error', (e) => {
  say(`failed to start command: ${e.code ?? e.name}`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  say(`exited code=${code} signal=${signal ?? 'none'}`);
  log.close();
  // A deliberate stop (launchctl bootout) exits 0 so it is not counted as a crash.
  process.exit(stopping ? 0 : (code ?? 1));
});
