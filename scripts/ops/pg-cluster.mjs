#!/usr/bin/env node
// Command Center's own database (bundled Postgres 17, D-98): one cluster under the state folder.
//
//   node scripts/ops/pg-cluster.mjs status            initialised? its major, the postmaster, the socket, the engine
//   node scripts/ops/pg-cluster.mjs init              copy the engine (once per version), initdb once, write the config
//   node scripts/ops/pg-cluster.mjs start             start it and wait for the socket (the LaunchAgent; CC_PG_NO_AGENT=1: pg_ctl)
//   node scripts/ops/pg-cluster.mjs stop              stop it (bootout the agent, or pg_ctl stop -m fast)
//   node scripts/ops/pg-cluster.mjs ensure            init + start + CREATE DATABASE command_center + the env file (the installer's step)
//   node scripts/ops/pg-cluster.mjs url               the socket URL the app uses (no secrets in it)
//   node scripts/ops/pg-cluster.mjs agent --out <dir> render com.commandcenter.db.plist into <dir> and lint it (touches nothing else)
//   options: --dry (say what it would do)
//
// Everything lives under <state>/pg (CC_STATE_DIR moves the state folder; CC_PG_SOCKET_DIR the socket folder when
// the default path is too long for macOS). The socket is the only way in: no TCP port, nothing on the network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDatabase, ensureDatabaseMessage } from './lib/ensure-db.mjs';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { logDir } from './lib/paths.mjs';
import { bundledDatabaseUrl, clusterPaths, clusterStatus, initCluster, installedEngine, installEngine, withClusterLock } from './lib/pg.mjs';
import { DB_LABEL, renderDbAgent } from './lib/plist.mjs';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--'));
const flag = (n) => argv.includes(n);
const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const say = (m) => console.log(`[pg-cluster] ${m}`);
const env = process.env;

async function main() {
  if (cmd && !flag('--dry')) await ensureStateMigrated({ say });
  switch (cmd) {
    case 'status': {
      const s = await clusterStatus({ env });
      say(`data: ${s.data} (${s.initialised ? `Postgres ${s.major}` : 'not initialised'})`);
      say(`engine: ${s.engine ? `${s.engine.version} (${s.engine.dir})` : 'not installed'}`);
      say(`server: ${s.pid ? `pid ${s.pid}, ${s.status}` : 'not running'} · socket ${s.socket}: ${s.ping}`);
      return s.ping === 'ready' ? 0 : 1;
    }
    case 'url':
      console.log(bundledDatabaseUrl(env));
      return 0;
    case 'init': {
      if (flag('--dry')) return say(`would copy the engine into ${join(clusterPaths(env).root, 'engine')} and initdb ${clusterPaths(env).data}`), 0;
      const r = await withClusterLock(env, async () => {
        const e = installEngine({ env });
        if (!e.ok) return e;
        say(`engine ${e.version}: ${e.installed ? `copied (${Math.round(e.savedBytes / 1048576)} MB of duplicate libraries linked, not copied)` : 'already there'}`);
        return initCluster({ env, bin: e.bin });
      });
      say(r.message);
      return r.ok ? 0 : 1;
    }
    case 'start': {
      const { ensureRunning } = await import('./lib/db-agent.mjs');
      const engine = installedEngine(env);
      if (!engine) return say('no engine yet: run init first'), 1;
      const r = await withClusterLock(env, () => ensureRunning(engine, { env }));
      say(r.message);
      return r.ok ? 0 : 1;
    }
    case 'stop': {
      const { stopRunning } = await import('./lib/db-agent.mjs');
      const r = await withClusterLock(env, async () => stopRunning(installedEngine(env), { env }));
      say(r.message ?? r.state);
      return r.ok ? 0 : 1;
    }
    case 'ensure': {
      const r = await ensureDatabase({ env }, { dry: flag('--dry') });
      say(ensureDatabaseMessage(r));
      if (r.move) say('this install still runs on Homebrew Postgres: npm run update moves it (verified, the Homebrew copy is kept)');
      return r.ok ? 0 : 1;
    }
    case 'agent': {
      const out = val('--out');
      if (!out) return say('agent needs --out <dir> (installing it is the installer\'s job: npm run ops:install)'), 64;
      const engine = installedEngine(env);
      const bin = engine?.bin ?? join(clusterPaths(env).root, 'engine', '<version>', 'bin');
      mkdirSync(out, { recursive: true });
      const f = join(resolve(out), `${DB_LABEL}.plist`);
      writeFileSync(f, renderDbAgent({ bin, dataDir: clusterPaths(env).data, logDir: logDir(env), home: env.HOME || homedir() }));
      execFileSync('/usr/bin/plutil', ['-lint', f], { stdio: 'pipe' });
      say(`rendered and linted ${f}`);
      return 0;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      return cmd ? 64 : 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code ?? 0),
    (e) => {
      console.error(`[pg-cluster] failed: ${e?.message ?? e}`);
      process.exit(1);
    },
  );
}
