#!/usr/bin/env node
// npm run update [-- --no-pull] [--no-restart] [--no-backup] [--yes] [--save-local] [--dry] [--help]
//
// Brings this install to the latest version (D-57, README "Updating"; audit 2026-11-13, lane E: E1). The steps and
// what happens when one fails are in scripts/ops/lib/update.mjs; this file wires them to git, npm, launchctl and
// pg_dump:
//   git fetch → (local changes: a rewritten package-lock.json is put back; other changes ask "save to cc-local-<ts>
//   or cancel") → (a MAJOR jump: its changelog, then "migrate now?") → git merge --ff-only → stop both LaunchAgents
//   (com.commandcenter.web, com.commandcenter.worker) → npm ci → npm run build → back up the database →
//   npm run db:migrate → start the agents again → old → new and the changelog in between.
// A failed build, backup or migration leaves the schema as it was, puts the previous build back and starts the app
// again. --yes answers the major-update question; --save-local answers the local-changes one with "save";
// --no-backup skips the backup (not advised).
// Nothing here writes outside this folder, the database, the backups folder (and its copy) and the two agents.
//
// --from <build.tgz> (D-90): a compiled build instead of git: the same steps as scripts/ops/install.mjs (sha256 against
// the release feed next to it, every file against its manifest, backup, migrate with the new build, switch
// releases/current, agents, health; any failure puts the previous release back). --from <Drive folder id> prints the
// Claude Code prompt that downloads it (the app's Drive access reads text, not builds). Inside a compiled release,
// `npm run update` without --from says so (scripts/ops/lib/update-from.mjs).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, constants, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { sectionsBetween } from '../lib/release.mjs';
import { backupCopyDir, configuredDbName, defaultBackupDir, keepBeforeMajor, runBackup } from './lib/backup.mjs';
import { homebrewPostgres } from './lib/ensure-db.mjs';
import { launchctlBin } from './lib/launchctl.mjs';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { readEnvFile } from './lib/envfile.mjs';
import { moveToBundled, realMoveDeps } from './lib/migrate-cluster.mjs';
import { dbEngine, dbNameOf, resolveDatabaseUrl } from './lib/pg.mjs';
import { WEB_LABEL, WORKER_LABEL } from './lib/plist.mjs';
import { servicePort } from './lib/release-wiring.mjs';
import { STATE_FOLDER_NAME } from './lib/paths.mjs';
import { runUpdate } from './lib/update.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const say = (m) => console.log(`[update] ${m}`);
const uid = process.getuid?.() ?? 0;
const agentsDir = process.env.CC_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
const stateDir = process.env.CC_STATE_DIR ?? join(homedir(), 'Library', 'Application Support', STATE_FOLDER_NAME);

const HELP =`npm run update [-- options]

Brings this install to the latest version: fetch, fast-forward, npm ci (the committed lockfile, exactly), build,
back up the database, migrate, restart the two LaunchAgents. A failed step puts the previous build back.

Before it pulls, it looks at what was changed here:
  - only package-lock.json (npm rewrote it): the committed one is put back, and the update goes on;
  - other files, or local commits: it stops and names the count, with two options:
      1. save your changes to a branch cc-local-<date-time> and update (answer yes, or pass --save-local)
      2. cancel: nothing changes

Options:
  --from <file>  install a compiled build (command-center-X.Y.Z-ARCH.tgz) instead of pulling; its sha256 is
                 checked against the manifest.json next to it (docs/INSTALL.md); a build no feed lists is
                 refused unless --unverified (a build you made yourself)
  --from <id>    a Drive folder id: prints the Claude Code prompt that downloads the newest build from it
  --yes          answer yes to the major-version question
  --save-local   answer "save to a branch and update" to the local-changes question
  --dry          say what it would do, change nothing
  --no-pull      update to the code already here
  --no-restart   leave the agents running
  --no-backup    skip the database backup (not advised)
  --keep-homebrew  a 1.x install: keep the data in Homebrew Postgres instead of moving it into Command Center's
                 own database (CC_DB_ENGINE=homebrew in the env file does the same for good)
  --help         this text`;

if (flag('--help') || flag('-h')) {
  console.log(HELP);
  process.exit(0);
}

// D-101: a 1.x state folder moves first, with its database, agents and logs
if (!flag('--dry')) await ensureStateMigrated({ say });

// ---- D-90: a compiled build (or running inside one) ---------------------------------------------------------------
const fromArg = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : null;
if (fromArg || existsSync(join(repo, 'manifest.json'))) {
  const { runFromBuild } = await import('./lib/update-from.mjs');
  process.exit(await runFromBuild({ from: fromArg, argv, say }));
}

const gitOut = (args) => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
/** A command with its output on this terminal. `env` adds the env file's values (migrate: the database the agents use). */
const sh = (cmd, args, env) => spawnSync(cmd, args, { cwd: repo, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env }).status === 0;
const fileEnv = () => readEnvFile(join(stateDir, 'env')) ?? {};

const agents = {
  /** Installed and loaded now (launchctl print exits 0 for a loaded service). */
  running: () =>
    [WEB_LABEL, WORKER_LABEL].filter(
      (l) => existsSync(join(agentsDir, `${l}.plist`)) && spawnSync(launchctlBin(), ['print', `gui/${uid}/${l}`], { stdio: 'ignore' }).status === 0,
    ),
  // bootout stops it for good (KeepAlive would restart a plain kill) and waits for it to exit: the worker drains
  stop: async (l) => spawnSync(launchctlBin(), ['bootout', `gui/${uid}/${l}`], { stdio: 'ignore' }).status === 0,
  start: async (l) => spawnSync(launchctlBin(), ['bootstrap', `gui/${uid}`, join(agentsDir, `${l}.plist`)], { stdio: 'inherit' }).status === 0,
  /** Installed agents whose WorkingDirectory is another checkout (their plist says which). */
  elsewhere: () =>
    [
      ...new Set(
        [WEB_LABEL, WORKER_LABEL]
          .map((l) => join(agentsDir, `${l}.plist`))
          .filter((f) => existsSync(f))
          .map((f) => /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(f, 'utf8'))?.[1]?.replace(/&amp;/g, '&') ?? null)
          .filter((d) => d && resolve(d) !== repo),
      ),
    ],
};

/** Paths changed here, tracked or untracked (ignored files such as node_modules and .next are not changes). */
function changedFiles() {
  const out = gitOut(['status', '--porcelain', '--untracked-files=all']);
  return out ? out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '')) : [];
}

/**
 * "Save my changes to a branch and update": everything changed here (tracked and untracked, local commits included)
 * becomes one commit on `branch`, built through a temporary index so the working tree and the stash are untouched
 * until it exists. Then this branch goes back to where it left the remote, so the fast-forward that follows applies.
 */
function saveLocal(branch) {
  const base = gitOut(['merge-base', 'HEAD', '@{u}']);
  const indexPath = gitOut(['rev-parse', '--git-path', 'cc-save-index']);
  if (!base || !indexPath) return false;
  const index = resolve(repo, indexPath);
  const withIndex = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
  try {
    withIndex(['read-tree', 'HEAD']);
    withIndex(['add', '-A']);
    const tree = withIndex(['write-tree']);
    const head = gitOut(['rev-parse', 'HEAD']);
    const commit = tree === gitOut(['rev-parse', 'HEAD^{tree}']) ? head : withIndex(['commit-tree', tree, '-p', 'HEAD', '-m', `Local changes saved by npm run update (${branch})`]);
    if (!commit || !sh('git', ['branch', branch, commit])) return false;
  } catch {
    return false;
  } finally {
    rmSync(index, { force: true });
  }
  say(`your changes are on ${branch}; resetting this checkout to the last version it shared with the remote`);
  return sh('git', ['reset', '--hard', '--quiet', base]) && sh('git', ['clean', '-fd', '--quiet']);
}

const nextDir = join(repo, '.next');
const snapDir = join(repo, '.next-before-update');

async function runningVersion() {
  const port = servicePort(); // the env file's PORT over the shell's, as the web runs (P34-1)
  try {
    const res = await fetch(`http://localhost:${port}/api/v1/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()).version ?? null) : null;
  } catch {
    return null;
  }
}

async function waitForApp() {
  for (let i = 0; i < 30; i++) {
    const port = servicePort(); // the env file's PORT over the shell's, as the web runs (P34-1)
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch {
      /* still starting */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function confirm(q) {
  if (!process.stdin.isTTY) {
    say('not a terminal, so nothing to answer with: run it again with --yes to accept');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`[update] ${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

const result = await runUpdate(
  {
    say,
    version: () => JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version,
    runningVersion,
    git: {
      sha: () => gitOut(['rev-parse', '--short=7', 'HEAD']) ?? '',
      hasUpstream: () => gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) !== null,
      fetch: async () => sh('git', ['fetch', '--quiet']),
      incoming: () => Number(gitOut(['rev-list', '--count', 'HEAD..@{u}']) ?? 0),
      upstreamFile: (p) => gitOut(['show', `@{u}:${p}`]),
      mergeFfOnly: async () => sh('git', ['merge', '--ff-only', '--quiet', '@{u}']),
      localChanges: () => ({ files: changedFiles(), ahead: Number(gitOut(['rev-list', '--count', '@{u}..HEAD']) ?? 0) }),
      discardLock: async () => sh('git', ['checkout', '--', 'package-lock.json']),
      saveLocal: async (branch) => saveLocal(branch),
    },
    changelog: (text, from, to) => sectionsBetween(text, from, to),
    readLocal: (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : null),
    confirm,
    agents,
    install: async () => sh('npm', ['ci', '--no-audit', '--no-fund']),
    build: async () => sh('npm', ['run', 'build']),
    migrate: async () => sh('npm', ['run', 'db:migrate'], fileEnv()),
    // The current build, copied (APFS clones it: instant, no extra space), so a failed step can put it back. The
    // cache is left out: next build keeps it, and it can be large.
    snapshot: async () => {
      if (!existsSync(join(nextDir, 'BUILD_ID'))) return null;
      rmSync(snapDir, { recursive: true, force: true });
      cpSync(nextDir, snapDir, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (src) => !src.startsWith(join(nextDir, 'cache')) });
      return snapDir;
    },
    restore: async (dir) => {
      const cache = join(nextDir, 'cache');
      const keepCache = existsSync(cache) ? `${dir}-cache` : null;
      if (keepCache) renameSync(cache, keepCache);
      rmSync(nextDir, { recursive: true, force: true });
      renameSync(dir, nextDir);
      if (keepCache) renameSync(keepCache, cache);
    },
    drop: async (dir) => rmSync(dir, { recursive: true, force: true }),
    // D-98: a 1.x Homebrew database moves into the bundled cluster (the first `npm run update` from 1.x brings this
    // code; the next one moves the data: the 1.x updater that ran the first one has no such step)
    database: {
      plan: () => {
        if (flag('--keep-homebrew')) return { move: false, message: '--keep-homebrew: the database stays in Homebrew Postgres' };
        const e = dbEngine(process.env, fileEnv());
        if (e.engine !== 'homebrew' || e.keep) return { move: false };
        const h = homebrewPostgres({}, { create: false, db: dbNameOf(e.url) || undefined });
        return h.ok ? { move: true } : { move: false, message: `the database stays where it is for now: ${h.message}` };
      },
      move: async () => moveToBundled(await realMoveDeps({ env: process.env, say, migrator: { cmd: join(repo, 'node_modules', '.bin', 'tsx'), args: ['src/db/migrate.ts'], cwd: repo } })),
    },
    backup: async () => {
      const env = { ...fileEnv(), ...process.env };
      const r = await runBackup({ db: configuredDbName(env), dir: defaultBackupDir(env), url: resolveDatabaseUrl(process.env, fileEnv()) });
      const c = backupCopyDir(env);
      if (r.copy?.error) say(r.copy.error === 'refused_cloud_synced' ? `not copied: ${c.refused}` : `the copy to ${r.copy.dir} failed (${r.copy.error}); the backup itself is fine`);
      return { name: r.file.split('/').pop(), file: r.file, bytes: r.bytes, copied: r.copy?.file ? r.copy.dir : null };
    },
    keepForMajor: async (b, major) => keepBeforeMajor(b.file, defaultBackupDir({ ...fileEnv(), ...process.env }), major),
  },
  { pull: !flag('--no-pull'), restart: !flag('--no-restart'), backup: !flag('--no-backup'), yes: flag('--yes'), dry: flag('--dry'), saveLocal: flag('--save-local') },
);

if (result.status === 'failed') process.exit(1);
if (result.status === 'declined') process.exit(0);
if (result.restarted?.length) {
  const v = await waitForApp();
  if (!v) say(`the app didn't answer yet; check npm run doctor`);
  else if (v.mismatch) say(`the worker still runs v${v.workerVersion}; it restarts within a minute, or run: launchctl kickstart -k gui/${uid}/${WORKER_LABEL}`);
  else say(`running: v${v.version}${v.sha ? ` · ${v.sha}` : ''}${v.workerVersion ? `, worker v${v.workerVersion}` : ''}`);
}
