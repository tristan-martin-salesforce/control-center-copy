// Installing a compiled release, and rolling one back, as a whole (PKG-2, D-90). Pure orchestration over injected
// deps (extract, database, agents, backup, migrate, health), working on real folders under `releasesDir`, so the
// state machine is tested on temp dirs (tests/ops/install-release.test.ts) without launchd, tar or Postgres.
//
//   releases/
//     2.0.0/            one extracted, verified build per version (never changed after it is verified)
//     2.0.1/
//     current -> 2.0.1  the one that runs: the LaunchAgents' WorkingDirectory and programs point at this link
//     state.json        { current, history: [{ version, installedAt, previous, backup }] }
//
// install: [sha256 of the artifact against the feed] → extract into releases/.incoming-<ts> → verify every file
//   against the artifact's manifest.json → move to releases/<version> → ensureDatabase → env file → stop the agents
//   → backup → (a 1.x Homebrew database: the verified move into the bundled cluster, D-98) → migrate with the NEW
//   build's migrator → repoint `current` (atomic rename) → write the agents
//   for `current` → start them → wait until /api/v1/version answers the new version → keep the newest `keep`.
//   A failure before the repoint changes nothing that runs (the agents start again on the old build); a failure
//   after it puts `current` back on the previous release and restarts it. The migration runs in one transaction, so
//   a failed one leaves the database as it was; a later failure leaves the database migrated (migrations are
//   additive within a major, docs/RELEASING.md) and names the pre-migration backup.
// rollback: `current` back to the previous installed release, agents rewritten and restarted.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';

import { npmInCurrent } from './paths.mjs';
import { assertSha256, compareVersions, MANIFEST_FILE, parseSemver, readManifest, verifyTree } from './release-manifest.mjs';

export const KEEP_RELEASES = 3;
const CHIP = { arm64: 'Apple silicon', x64: 'Intel' };
export const STATE_FILE = 'state.json';
export const CURRENT = 'current';

const WHY = {
  sha: 'Nothing changed: the file is not the published build (an incomplete or older download). Delete it, download it again from the Drive folder, then run the same command.',
  extract: 'Nothing changed: the build could not be unpacked (an incomplete download, or a full disk). Download it again from the Drive folder and run the same command; if it happens again, tell whoever posted the build.',
  verify: 'Nothing changed: the unpacked build does not match its own file list (a damaged or edited download). Download it again from the Drive folder and run the same command; if it happens again, tell whoever posted the build.',
  node: 'Nothing changed: this Node.js is outside the range the build runs on.',
  arch: "Nothing changed: the build is for the other kind of Mac (its database server wouldn't run here).",
  version: 'Nothing changed: the build does not carry a plain version number (like 2.0.1), so it is not a Command Center build to install. Tell whoever posted it.',
  downgrade: 'Nothing changed: the build is older than the version you run. To go back to the version you ran before, use ops:rollback (the line below has the command); to install this older build anyway, run the same command with --allow-downgrade (the database keeps the newer migrations).',
  database: 'Nothing changed: the build is unpacked, but the database is not ready.',
  env: 'Nothing changed: the settings file in the state folder could not be written.',
  backup: 'The database was not migrated (no backup, no migration); the app runs the version it ran.',
  move: "Your data stays in Homebrew Postgres, untouched, and the app runs the version it ran (the move into Command Center's own database is tried again on the next install).",
  migrate: 'The migration ran in one transaction, so the database is as it was; the app runs the version it ran.',
  repoint: 'The app runs the version it ran.',
  agents: 'The previous release is back in place and running.',
  health: 'The previous release is back in place and running.',
};
/** ON-26: the downgrade refusal when this Mac has no earlier release to roll back to (state.json's history has none). */
const DOWNGRADE_NO_ROLLBACK = 'Nothing changed: the build is older than the version you run. To install this older build anyway, run the same command with --allow-downgrade (the database keeps the newer migrations).';
/** ON-27: the rollback restarted the previous release, but it did not answer either. */
const BACK_NOT_ANSWERING = (v, doctor) => `The previous release (v${v}) is back in place, but it did not answer after the restart: ${doctor} says why.`;
/** What a person reads for each step (the step id stays in the line, for a bug report). */
const STEP = {
  sha: 'Checking the download',
  extract: 'Unpacking the build',
  verify: 'Checking the unpacked build',
  node: 'Checking Node.js',
  arch: 'Checking the kind of Mac',
  version: "Checking the build's version",
  downgrade: "Checking the build's version",
  database: "Starting Command Center's database",
  env: 'Writing the settings file',
  backup: 'Backing up the database',
  move: 'Moving your data into Command Center’s own database',
  migrate: 'Updating the database',
  repoint: 'Switching to the new version',
  agents: 'Writing the background services',
  health: 'Starting Command Center',
};
/** Where to look after a failed first install, as a line a person can paste in any Terminal (ON-15, ON-11). */
const firstLook = (releasesDir) =>
  `${npmInCurrent('doctor', { ...process.env, CC_RELEASES_DIR: releasesDir })} says why, and ~/Library/Logs/command-center/web.log has the details; fix that and run the same install again.`;
/** @param {string} releasesDir */
export const firstInstallWhy = (releasesDir) => ({
  backup: `This is the first install, so nothing was running before and nothing else changed. ${firstLook(releasesDir)}`,
  migrate: `This is the first install, so nothing was running before and nothing else changed. ${firstLook(releasesDir)}`,
  repoint: `This is the first install, so nothing was running before. ${firstLook(releasesDir)}`,
  agents: `This is the first install, so there is no earlier version to go back to: Command Center is not running. ${firstLook(releasesDir)}`,
  health: `This is the first install, so there is no earlier version to go back to: Command Center is stopped. ${firstLook(releasesDir)}`,
});

// ---------------------------------------------------------------------------------------------------------------
// the releases folder
// ---------------------------------------------------------------------------------------------------------------

export function readState(releasesDir) {
  try {
    const s = JSON.parse(readFileSync(join(releasesDir, STATE_FILE), 'utf8'));
    return { current: s.current ?? null, history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { current: null, history: [] };
  }
}

export function writeState(releasesDir, state) {
  const tmp = join(releasesDir, `.${STATE_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(releasesDir, STATE_FILE));
}

/** The version `current` points at, or null (no link, or a link to nothing). */
export function currentVersion(releasesDir) {
  const link = join(releasesDir, CURRENT);
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    const target = readlinkSync(link);
    const v = basename(target);
    return existsSync(join(releasesDir, v, MANIFEST_FILE)) ? v : null;
  } catch {
    return null;
  }
}

/** Point `current` at releases/<version> atomically: a new link under a temp name, renamed over the old one. */
export function repoint(releasesDir, version) {
  const tmp = join(releasesDir, `.${CURRENT}.${process.pid}.${Date.now()}`);
  rmSync(tmp, { force: true });
  symlinkSync(version, tmp); // relative: the folder can move with the state folder (the rename chunk)
  renameSync(tmp, join(releasesDir, CURRENT));
}

/** Installed release folders (versions), newest first. */
export function installedVersions(releasesDir) {
  if (!existsSync(releasesDir)) return [];
  return readdirSync(releasesDir)
    .filter((n) => !n.startsWith('.') && n !== CURRENT && n !== STATE_FILE && existsSync(join(releasesDir, n, MANIFEST_FILE)))
    .sort((a, b) => compareVersions(b, a));
}

/**
 * Keep the newest `keep` releases by install order (current always stays). Returns the versions removed.
 */
export function prune(releasesDir, state, keep = KEEP_RELEASES) {
  const order = [...new Set([state.current, ...[...state.history].reverse().map((h) => h.version)].filter(Boolean))];
  const installed = installedVersions(releasesDir);
  // folders not in the history (installed by hand) rank after it, newest version first
  const ranked = [...order.filter((v) => installed.includes(v)), ...installed.filter((v) => !order.includes(v))];
  const drop = ranked.slice(Math.max(keep, 1)).filter((v) => v !== state.current);
  for (const v of drop) rmSync(join(releasesDir, v), { recursive: true, force: true });
  return drop;
}

/** rename, or copy + remove when the two are on different volumes (install.sh unpacks into the system temp folder). */
export function moveDir(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** The folder inside an extraction that holds manifest.json (the artifact wraps it in command-center-<v>/). */
export function releaseRootIn(dir) {
  if (existsSync(join(dir, MANIFEST_FILE))) return dir;
  const subs = readdirSync(dir).filter((n) => !n.startsWith('.'));
  if (subs.length === 1 && existsSync(join(dir, subs[0], MANIFEST_FILE))) return join(dir, subs[0]);
  return null;
}

/**
 * A version that may become a folder name under releases/ (SEC-12): plain semver, and nothing a path could use
 * (`parseSemver` alone accepts any build metadata after `+`, slashes included).
 */
export function isInstallableVersion(v) {
  return typeof v === 'string' && !!parseSemver(v) && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v) && !v.includes('..');
}

/** Does `nodeVersion` ("v22.11.0") satisfy a range like ">=20 <26"? Only >= / < / <= / > on majors are read. */
export function nodeSatisfies(nodeVersion, range) {
  const major = Number(/^v?(\d+)/.exec(String(nodeVersion))?.[1] ?? NaN);
  if (!Number.isFinite(major)) return false;
  for (const part of String(range ?? '').split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<)?v?(\d+)/.exec(part);
    if (!m) continue;
    const n = Number(m[2]);
    const op = m[1] ?? '>=';
    if ((op === '>=' && !(major >= n)) || (op === '>' && !(major > n)) || (op === '<' && !(major < n)) || (op === '<=' && !(major <= n))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------------------------

/**
 * deps:
 *   say(msg)
 *   extract(artifact, intoDir) → Promise<boolean>         (tar -xzf; not called with fromDir)
 *   ensureDatabase() → { ok, message, command? }          (scripts/ops/lib/ensure-db.mjs)
 *   ensureEnv() → Promise<boolean>                        (the chmod-600 env file; never overwritten)
 *   agents: { running() → labels, stop(label), start(label), render() → Promise<boolean> }  (render writes both
 *           plists for releases/current; start bootstraps one)
 *   backup() → Promise<{ name }>                          (throws on failure)
 *   moveDatabase(releaseDir) → Promise<{ ok }>            (only when ensureDatabase answered `move`: the 1.x Homebrew
 *                                                         data into the bundled cluster, verified; migrate-cluster.mjs)
 *   migrate(releaseDir) → Promise<boolean>               (the new build's dist/db/migrate.mjs)
 *   health(version) → Promise<boolean>                    (the app answers that version on /api/v1/version)
 *   nodeVersion: process.version
 *   now() → Date
 * opts: { releasesDir, artifact?, fromDir?, sha256?, dry = false, keep = 3, backup = true, start = true, reinstall = false,
 *         allowDowngrade = false }
 * Returns { status: 'installed' | 'up_to_date' | 'planned' | 'failed' | 'rolled_back', failedAt?, version, previous, removed? }.
 */
export async function installRelease(deps, opts) {
  const o = { dry: false, keep: KEEP_RELEASES, backup: true, start: true, reinstall: false, allowDowngrade: false, ...opts };
  const say = deps.say;
  const R = o.releasesDir;
  // the version that last finished installing (state.json), not merely the one `current` points at: a first install
  // that failed after the switch leaves `current` on a version that never ran (ON-7)
  const recorded = readState(R).current;
  const previous = recorded && existsSync(join(R, recorded, MANIFEST_FILE)) ? recorded : recorded ? currentVersion(R) : null;
  const fail = async (step, version = null, extra = {}) => {
    // a first install has no earlier version to put back: say what is true instead (ON-6)
    const first = firstInstallWhy(R);
    const why = extra.why ?? (!previous && first[step] ? first[step] : WHY[step]);
    delete extra.why;
    say(`${STEP[step] ?? step} did not work (step: ${step}). ${why}`);
    return { status: extra.rolledBack ? 'rolled_back' : 'failed', failedAt: step, version, previous, ...extra };
  };
  say(`current release: ${previous ?? 'none (first install from a build)'}`);

  // 1. the artifact is the published one (before anything in it is unpacked or run)
  if (o.artifact && o.sha256) {
    if (o.dry) say(`would check the sha256 of ${basename(o.artifact)} against the release feed`);
    else {
      try {
        await assertSha256(o.artifact, o.sha256);
        say('sha256 matches the release feed');
      } catch (e) {
        say(e.message);
        return fail('sha');
      }
    }
  } else if (o.artifact) say('no release feed sha256 to compare with: checking every file against the manifest inside the build instead');

  // 2. unpack into a staging folder (or take an already unpacked one)
  if (!o.dry) mkdirSync(R, { recursive: true, mode: 0o700 });
  let incoming = null;
  let root = o.fromDir ?? null;
  if (o.artifact) {
    if (o.dry) say(`would unpack ${basename(o.artifact)} into ${join(R, '.incoming-…')}`);
    else {
      incoming = join(R, `.incoming-${deps.now().getTime()}`);
      mkdirSync(incoming, { recursive: true });
      if (!(await deps.extract(o.artifact, incoming).catch(() => false))) {
        rmSync(incoming, { recursive: true, force: true });
        return fail('extract');
      }
      root = releaseRootIn(incoming);
      if (!root) {
        rmSync(incoming, { recursive: true, force: true });
        say(`no ${MANIFEST_FILE} in the unpacked build`);
        return fail('extract');
      }
    }
  }
  const cleanup = () => incoming && rmSync(incoming, { recursive: true, force: true });

  // 3. every file is the one that was built
  let manifest = null;
  if (o.dry && o.artifact && !root && deps.peekManifest) {
    // a dry run never unpacks: read the build's manifest.json straight out of the archive
    manifest = await deps.peekManifest(o.artifact).catch(() => null);
    if (manifest) say(`would verify ${Object.keys(manifest.files).length} files against the manifest of v${manifest.version} (${manifest.channel}, ${manifest.arch})`);
  }
  if (root) {
    // ON-32: a missing --from-dir is a wrong path, not a damaged download
    if (o.fromDir && !existsSync(o.fromDir)) return fail('verify', null, { why: `Nothing changed: there is no folder ${o.fromDir}. Check the path (or unpack the build again), then run the same command.` });
    try {
      manifest = readManifest(join(root, MANIFEST_FILE));
    } catch (e) {
      cleanup();
      say(e.message);
      return fail('verify');
    }
    if (o.dry) say(`would verify ${Object.keys(manifest.files).length} files against the manifest of v${manifest.version}`);
    else {
      const v = await verifyTree(root, manifest, { deep: true });
      if (!v.ok) {
        cleanup();
        say(`${v.missing.length} missing, ${v.changed.length} changed (first: ${[...v.missing, ...v.changed][0]})`);
        return fail('verify', manifest.version);
      }
      say(`verified ${v.checked} files of v${manifest.version} (${manifest.channel}, ${manifest.arch}, built ${manifest.built_at})`);
    }
    if (!nodeSatisfies(deps.nodeVersion, manifest.node)) {
      cleanup();
      say(`this Node.js is ${deps.nodeVersion}; v${manifest.version} runs on ${manifest.node}. Install Node 22: brew install node@22`);
      return fail('node', manifest.version);
    }
    if (deps.arch && manifest.arch && manifest.arch !== deps.arch) {
      cleanup();
      say(`this build is for ${CHIP[manifest.arch] ?? manifest.arch} Macs and this Mac has ${CHIP[deps.arch] ?? deps.arch}: download command-center-${manifest.version}-${deps.arch}.tgz from the same folder`);
      return fail('arch', manifest.version);
    }
  }
  if (manifest && !root && !nodeSatisfies(deps.nodeVersion, manifest.node)) say(`note: this Node.js is ${deps.nodeVersion}; v${manifest.version} runs on ${manifest.node}`);
  const version = manifest?.version ?? o.version ?? null;
  if (!version) {
    say('nothing to install: pass a build (.tgz) or --from-dir <unpacked build>');
    return { status: 'failed', failedAt: 'extract', version: null, previous };
  }
  // SEC-12: the version becomes a folder name (releases/<version>), so it must be a plain version, nothing else
  if (!isInstallableVersion(version)) {
    cleanup();
    say(`the build says its version is ${JSON.stringify(String(version)).slice(0, 80)}`);
    return fail('version', null);
  }
  // an older build than the one that runs is refused unless asked for: a stale download in ~/Downloads would
  // otherwise quietly put a teammate back a version (with the newer migrations still in the database)
  if (previous && isInstallableVersion(previous) && compareVersions(version, previous) < 0 && !o.allowDowngrade) {
    cleanup();
    say(`this build is v${version} and you run v${previous}, which is newer`);
    // ON-26: ops:rollback is offered only when state.json names an earlier release that is still on this Mac
    const back = [...readState(R).history].reverse().map((h) => h.previous).find((v) => v && v !== previous && v !== version && existsSync(join(R, v, MANIFEST_FILE))) ?? null;
    return fail('downgrade', version, { rollbackTo: back, ...(back ? {} : { why: DOWNGRADE_NO_ROLLBACK }) });
  }
  if (previous && compareVersions(version, previous) < 0) say(`installing v${version} over the newer v${previous} (--allow-downgrade)`);
  // `current` can point at a version whose install never finished (a first install that failed after the switch):
  // only one recorded in state.json as installed is up to date; anything else installs again (ON-7)
  if (previous === version && !o.reinstall && currentVersion(R) === version) {
    cleanup();
    say(`v${version} is already the current release (run the same command with --reinstall to install it again)`);
    return { status: 'up_to_date', version, previous };
  }

  // 4. the build gets its own folder
  const target = join(R, version);
  if (o.dry) say(`would install it as ${target}`);
  else if (root !== target) {
    const parked = existsSync(target) ? `${target}.old-${deps.now().getTime()}` : null;
    if (parked) renameSync(target, parked);
    try {
      // an unpacked build we were handed (install.sh's temp folder) is the one this installer runs from: copy it, so
      // the modules it loads later (the database step's, pg) are still where Node looks for them (ON-2); our own
      // staging folder moves
      if (incoming) moveDir(root, target);
      else cpSync(root, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    } catch (e) {
      rmSync(target, { recursive: true, force: true });
      if (parked) renameSync(parked, target);
      cleanup();
      say(`could not move the build into place (${e.code ?? e.message})`);
      return fail('extract', version);
    }
    if (parked) rmSync(parked, { recursive: true, force: true });
    cleanup();
  }

  // 5. the database (scripts/ops/lib/ensure-db.mjs: the bundled cluster, or `move` for a 1.x Homebrew install)
  const db = await deps.ensureDatabase();
  say(db.message);
  if (!db.ok) {
    if (db.command) say(`run this in Terminal, then install again:\n    ${db.command}`);
    if (!o.dry) return fail('database', version);
  }
  if (o.dry) say('would make sure the env file exists (chmod 600; never overwritten)');
  else if (!(await deps.ensureEnv())) return fail('env', version);

  if (o.dry) {
    if (db.move) say("would move the data from Homebrew Postgres into Command Center's own database after the backup: precheck, dump, restore, verify every table, then switch (the Homebrew copy is kept)");
    say(`would stop the LaunchAgents, back up the database${o.backup ? '' : ' (skipped: --no-backup)'}, migrate with v${version}'s migrator, point current at ${version}, write the agents for current and start them, wait for v${version} on /api/v1/version, and keep the newest ${o.keep} releases`);
    return { status: 'planned', version, previous };
  }

  // 6. stop what runs, back up, migrate with the new build
  const running = deps.agents.running();
  for (const l of running) await deps.agents.stop(l);
  if (running.length) say(`stopped ${running.join(', ')}`);
  // whatever ran before (a previous release, or a source checkout's agents) starts again on its own code
  const restartOld = async () => {
    for (const l of running) await deps.agents.start(l);
  };
  let backupName = null;
  if (o.backup) {
    try {
      backupName = (await deps.backup())?.name ?? null;
      say(`backed up the database${backupName ? `: ${backupName}` : ''}`);
    } catch (e) {
      say(`backup: ${e.message}`);
      await restartOld();
      return fail('backup', version);
    }
  } else say('backup skipped (--no-backup)');
  // D-98: a 1.x install moves from Homebrew into the bundled cluster here, verified; a failure switches nothing
  if (db.move) {
    const m = await deps.moveDatabase(target).catch((e) => ({ ok: false, message: e?.message ?? String(e) }));
    if (!m?.ok) {
      await restartOld();
      return fail('move', version);
    }
  }
  if (!(await deps.migrate(target))) {
    await restartOld();
    return fail('migrate', version);
  }

  // 7. switch, write the agents for `current`, start, and see the new version answer
  const rollbackTo = async (step) => {
    if (previous) {
      repoint(R, previous);
      await deps.agents.render();
      for (const l of await deps.agents.running()) await deps.agents.stop(l);
      await deps.agents.start('web');
      await deps.agents.start('worker');
      say(`current points at ${previous} again${backupName ? `; the database stays migrated (additive), the backup from before is ${backupName}` : ''}`);
      // ON-27: "running" only once the previous release answers again
      const up = await deps.health(previous);
      return fail(step, version, { rolledBack: true, previousRunning: up, ...(up ? {} : { why: BACK_NOT_ANSWERING(previous, npmInCurrent('doctor', { ...process.env, CC_RELEASES_DIR: R })) }) });
    }
    for (const l of await deps.agents.running()) await deps.agents.stop(l);
    return fail(step, version);
  };
  try {
    repoint(R, version);
  } catch (e) {
    say(`could not switch current (${e.code ?? e.message})`);
    await restartOld();
    return fail('repoint', version);
  }
  if (!(await deps.agents.render())) return rollbackTo('agents');
  if (o.start) {
    await deps.agents.start('web');
    await deps.agents.start('worker');
    say(`started; waiting for v${version} to answer (up to a minute and a half)…`);
    if (!(await deps.health(version))) return rollbackTo('health');
    say(`v${version} is running`);
  } else say('agents written, not started (--no-start)');

  const state = readState(R);
  state.current = version;
  state.history.push({ version, installedAt: deps.now().toISOString(), previous, backup: backupName });
  state.history = state.history.slice(-20);
  writeState(R, state);
  const removed = prune(R, state, o.keep);
  if (removed.length) say(`removed old releases: ${removed.join(', ')} (keeping ${o.keep})`);
  return { status: 'installed', version, previous, removed };
}

/**
 * The same version again (ON-7): it is installed, but is it running? Start the agents that are stopped and wait for
 * the version to answer. deps: { say, agents: { running, render, start }, health(version) }.
 * Returns { status: 'running' | 'started' | 'failed', failedAt?: 'agents' | 'health', started: labels }.
 */
export async function startStopped(deps, version) {
  const stopped = ['web', 'worker'].filter((k) => !deps.agents.running().includes(k));
  if (!stopped.length) return { status: 'running', started: [] };
  deps.say(`starting ${stopped.join(' and ')} (installed, not running)`);
  if (!(await deps.agents.render())) return { status: 'failed', failedAt: 'agents', started: [] };
  for (const k of stopped) await deps.agents.start(k);
  if (!(await deps.health(version))) return { status: 'failed', failedAt: 'health', started: stopped };
  deps.say(`v${version} is running`);
  return { status: 'started', started: stopped };
}

/**
 * `ops:install` inside a release: rewrite both agents for `current`, (re)start them and wait for `version` to answer,
 * so "started" is said only once it is true (ON-22). deps: { agents: { running, stop, render, start }, health(version) }.
 * Returns { status: 'started' | 'failed', failedAt?: 'agents' | 'health' }.
 */
export async function restartAgents(deps, version) {
  for (const k of deps.agents.running()) await deps.agents.stop(k);
  if (!(await deps.agents.render())) return { status: 'failed', failedAt: 'agents' };
  await deps.agents.start('web');
  await deps.agents.start('worker');
  if (!(await deps.health(version))) return { status: 'failed', failedAt: 'health' };
  return { status: 'started' };
}

// ---------------------------------------------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------------------------------------------

/** The release to go back to: the newest history entry that is not current and still installed, else any older one. */
export function rollbackTarget(releasesDir, state = readState(releasesDir)) {
  const cur = currentVersion(releasesDir);
  const installed = installedVersions(releasesDir);
  const fromHistory = [...state.history].reverse().map((h) => h.previous).find((v) => v && v !== cur && installed.includes(v));
  return fromHistory ?? installed.find((v) => v !== cur && (!cur || compareVersions(v, cur) < 0)) ?? null;
}

/**
 * deps: { say, agents: { running, stop, start, render }, health(version), now() }
 * opts: { releasesDir, to?, dry = false }
 */
export async function rollbackRelease(deps, opts) {
  const R = opts.releasesDir;
  const say = deps.say;
  const cur = currentVersion(R);
  const state = readState(R);
  const to = opts.to ?? rollbackTarget(R, state);
  if (!to || !existsSync(join(R, to, MANIFEST_FILE))) {
    say(`no earlier release to go back to (installed: ${installedVersions(R).join(', ') || 'none'})`);
    return { status: 'failed', failedAt: 'target', from: cur, to: to ?? null };
  }
  if (to === cur) {
    say(`v${to} is already current`);
    return { status: 'up_to_date', from: cur, to };
  }
  if (opts.dry) {
    say(`would stop the agents, point current at ${to} (now ${cur ?? 'none'}), write the agents for current and start them`);
    return { status: 'planned', from: cur, to };
  }
  for (const l of deps.agents.running()) await deps.agents.stop(l);
  repoint(R, to);
  if (!(await deps.agents.render())) {
    say('could not write the LaunchAgents');
    return { status: 'failed', failedAt: 'agents', from: cur, to };
  }
  await deps.agents.start('web');
  await deps.agents.start('worker');
  const ok = await deps.health(to);
  state.current = to;
  state.history.push({ version: to, installedAt: deps.now().toISOString(), previous: cur, backup: null, rollback: true });
  state.history = state.history.slice(-20);
  writeState(R, state);
  const migrated = state.history.filter((h) => h.version === cur).at(-1)?.backup;
  say(`current: v${cur ?? '?'} → v${to}${ok ? ', running' : " (it hasn't answered yet: npm run doctor)"}`);
  if (migrated) say(`the database keeps v${cur}'s migrations (additive); the backup taken before them is ${migrated} (npm run restore)`);
  return { status: ok ? 'rolled_back' : 'failed', failedAt: ok ? undefined : 'health', from: cur, to };
}
