// The real side of the bundled cluster's lifecycle (D-98): the com.commandcenter.db LaunchAgent through launchctl,
// or pg_ctl when CC_PG_NO_AGENT=1 (a source checkout run by hand, CI). Tests never load this file's launchctl path:
// they inject their own start/stop (tests/ops/pg-cluster.e2e.test.ts uses pg_ctl on a scratch state folder).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { launchctlBin } from './launchctl.mjs';
import { launchAgentsDir, logDir } from './paths.mjs';
import { clusterPaths, dataMajor, initCluster, installEngine, readPostmasterPid, startCluster, stopCluster, waitReady, withClusterLock } from './pg.mjs';
import { DB_LABEL, renderDbAgent } from './plist.mjs';

const uid = () => process.getuid?.() ?? 0;

/** com.commandcenter.db through launchctl: write (and lint) its plist, load, unload, ask. */
export function dbAgent({ env = /** @type {Record<string, string | undefined>} */ (process.env) } = {}) {
  const file = join(launchAgentsDir(env), `${DB_LABEL}.plist`);
  const lc = (args) => spawnSync(launchctlBin(env), args, { stdio: 'ignore' }).status === 0;
  return {
    file,
    installed: () => existsSync(file),
    loaded: () => lc(['print', `gui/${uid()}/${DB_LABEL}`]),
    /** Writes the plist for this engine; true when it changed. */
    render: (bin) => {
      const p = clusterPaths(env);
      const xml = renderDbAgent({ bin, dataDir: p.data, logDir: logDir(env), home: env.HOME || homedir() });
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (before === xml) return false;
      mkdirSync(launchAgentsDir(env), { recursive: true });
      mkdirSync(logDir(env), { recursive: true, mode: 0o700 });
      writeFileSync(file, xml, { mode: 0o644 });
      execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'pipe' });
      return true;
    },
    start: () => lc(['bootstrap', `gui/${uid()}`, file]),
    stop: () => lc(['bootout', `gui/${uid()}/${DB_LABEL}`]),
  };
}

/** Use the LaunchAgent (the default) or pg_ctl (CC_PG_NO_AGENT=1). */
export const agentManaged = (env = /** @type {Record<string, string | undefined>} */ (process.env)) => env.CC_PG_NO_AGENT !== '1';

/**
 * Make the cluster run on `engine` and answer on its socket: the agent (rewritten when its engine changed, so a
 * minor upgrade restarts it on the new binaries) or pg_ctl. A pg_ctl-started server on the same data folder is
 * stopped first, so launchd never fights it for postmaster.pid.
 */
export async function ensureRunning(engine, { env = /** @type {Record<string, string | undefined>} */ (process.env) } = {}) {
  if (!agentManaged(env)) return startCluster({ env, bin: engine.bin });
  const p = clusterPaths(env);
  const a = dbAgent({ env });
  const loaded = a.loaded();
  const pm = readPostmasterPid(p.data);
  if (pm?.alive && !loaded) stopCluster({ env, bin: engine.bin });
  const changed = a.render(engine.bin);
  if (changed && loaded) a.stop();
  if (changed || !a.loaded()) a.start();
  return (await waitReady(p.socket, { timeoutMs: 90_000 })) ? { ok: true, state: 'ok', message: 'com.commandcenter.db is running' } : { ok: false, state: 'not_ready', message: `com.commandcenter.db did not answer within 90 s (see ${join(logDir(env), 'db.log')})`, command: `launchctl kickstart -k gui/$UID/${DB_LABEL}` };
}

/** Stop the cluster (the agent, or pg_ctl). */
export function stopRunning(engine, { env = /** @type {Record<string, string | undefined>} */ (process.env), unload = false } = {}) {
  if (!agentManaged(env)) return stopCluster({ env, bin: engine?.bin });
  const a = dbAgent({ env });
  if (a.loaded()) a.stop();
  // leave nothing that starts an unused cluster at login (a move that did not switch)
  if (unload) rmSync(a.file, { force: true });
  return { ok: true, state: 'stopped' };
}

/**
 * The real `prepare` for ensure-db / migrate-cluster: engine copy → initdb (once) → running and answering, all under
 * the cluster lock.
 */
export function realPrepare({ env = /** @type {Record<string, string | undefined>} */ (process.env) } = {}) {
  return () =>
    withClusterLock(env, async () => {
      const engine = installEngine({ env });
      if (!engine.ok) return engine;
      const have = dataMajor(clusterPaths(env).data);
      if (have && have !== engine.major) return { ok: false, state: 'major_mismatch', message: `the database folder is Postgres ${have}, the bundled server is ${engine.major}: nothing was started (a major upgrade needs a dump and a verified restore, docs/RELEASING.md)` };
      const init = initCluster({ env, bin: engine.bin });
      if (!init.ok) return init;
      const run = await ensureRunning(engine, { env });
      return run.ok ? { ok: true, engine, created: init.created, message: init.message } : run;
    });
}
