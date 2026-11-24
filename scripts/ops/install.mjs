#!/usr/bin/env node
// npm run ops:install -- <build.tgz> [options]     (also: node scripts/ops/install.mjs …, and install.sh)
//
// With no build and no --dry it does what it always did: in a source checkout it (re)writes and loads the two
// LaunchAgents for this checkout (scripts/ops/install-agents.mjs, its options pass through); inside an installed
// release it rewrites them for releases/current and starts them.
//
// Installs a compiled Command Center build (D-90, PKG-2) into the state folder's releases/<version>/, switches the
// `current` link to it, points the LaunchAgents at `current`, migrates the database (after a pg_dump backup) and
// checks the new version answers. Any failure puts the previous release back and starts it again. The steps:
// scripts/ops/lib/install-release.mjs. The database step: scripts/ops/lib/ensure-db.mjs (Command Center's own
// Postgres 17 under the state folder, D-98; a 1.x Homebrew database moves into it after the backup, verified).
//
// Options:
//   --from-dir <dir>   an already unpacked build (install.sh passes the one it unpacked)
//   --sha256 <hex>     the artifact's sha256 from the release feed (checked before it is unpacked)
//   --feed <file>      the release feed (the Drive folder's manifest.json): the sha256 is looked up by file name
//                      (a build no feed lists is refused: SEC-3)
//   --unverified       install a build no feed lists (one you built yourself)
//   --dry            print the plan; change nothing
//   --yes              no questions (install.sh, Claude Code)
//   --no-backup        skip the pre-migration backup (not advised)
//   --no-start         write the agents but don't start them
//   --reinstall        install again even when it is the current version
//   --allow-downgrade  install a build older than the one that runs (refused without it, SEC-12)
//   --keep <n>         releases to keep (default 3)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { ensureDatabase, ensureDatabaseMessage } from './lib/ensure-db.mjs';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { installRelease, KEEP_RELEASES, restartAgents, rollbackTarget, startStopped } from './lib/install-release.mjs';
import { readEnvFile } from './lib/envfile.mjs';
import { migrationState } from './lib/migrate-state.mjs';
import { envFilePath, npmInCurrent } from './lib/paths.mjs';
import { dbEngine } from './lib/pg.mjs';
import { feedRefusal, feedShaFor, MANIFEST_FILE, parseFeed, readManifest } from './lib/release-manifest.mjs';
import { realDeps } from './lib/release-wiring.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
// valued options, ours and install-agents.mjs's (they pass through to it in a source checkout)
const VALUED = new Set(['--from-dir', '--sha256', '--feed', '--keep', '--only', '--port', '--repo', '--out']);
const FLAGS = new Set(['--unverified', '--dry', '--yes', '--no-backup', '--no-start', '--reinstall', '--allow-downgrade', '--no-load', '--help', '-h']);
const say = (m) => console.log(`[install] ${m}`);
// P34-4: an error nobody caught is one plain line (its message and the doctor command), not a stack under
// install.sh's "the lines above say why"
const uncaughtLine = (e, doctor) => `the install stopped on an unexpected error: ${String(e?.message ?? e).split('\n')[0]}. ${doctor} says what is set up and what to run next.`;
const onUncaught = (e) => {
  console.error(`[install] ${uncaughtLine(e, npmInCurrent('doctor'))}`);
  process.exit(1);
};
process.on('uncaughtException', onUncaught);
process.on('unhandledRejection', onUncaught);

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

// ON-32: a typo (--reinstal) or a valued option with no value is refused, as install.sh does: before, it fell through
// to the agents-only path, which restarts the live web and worker and exits 0
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.has(a)) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) {
      console.error(`[install] ${a} needs a value (for example ${a} ${a === '--keep' ? '3' : '<value>'}). Nothing changed.`);
      process.exit(1);
    }
    i++;
  } else if (a.startsWith('-') && !FLAGS.has(a)) {
    console.error(`[install] unknown option ${a} (the options are ${[...VALUED, ...FLAGS].filter((o) => o !== '-h').join(' ')}; --help says what each does). Nothing changed.`);
    process.exit(1);
  }
}

const artifact = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const fromDir = val('--from-dir') ? resolve(val('--from-dir')) : undefined;
const dry = flag('--dry');
if (dry) {
  const m = migrationState(process.env);
  if (m.kind === 'migrate' || m.kind === 'finish') say(`dry run: the 1.x state folder would move to ${m.p.newState} first (node scripts/ops/migrate-state.mjs --check)`);
}
else await ensureStateMigrated({ say }); // D-101: before the first thing that reads or creates the state folder

/** The sha256 the feed has for this artifact's file name (null: not listed, or no feed). */
function feedSha(feedFile, name) {
  try {
    const feed = parseFeed(readFileSync(feedFile, 'utf8'));
    return feed.releases.find((r) => r.artifact === name)?.sha256 ?? null;
  } catch (e) {
    say(`the release feed ${feedFile} could not be read (${e.message})`);
    return null;
  }
}

let sha256 = val('--sha256') ?? null;
let feedSeen = { feeds: 0 };
if (!sha256 && artifact) {
  if (!existsSync(resolve(artifact))) {
    say(`there is no file ${artifact}. Download the build from the Drive folder (or check the name), then run this again. Nothing changed.`);
    process.exit(1);
  }
  if (val('--feed')) sha256 = feedSha(val('--feed'), basename(artifact));
  else {
    // the feed next to the download (Claude Code or the browser puts both in one folder; "manifest (1).json" too)
    const f = feedShaFor(resolve(artifact));
    sha256 = f.found?.sha256 ?? null;
    feedSeen = f;
  }
}
// SEC-3: a downloaded build runs only once its sha256 matched the release feed (the manifest inside the build vouches
// only for itself). Your own local build: --unverified.
if (artifact && !sha256 && !dry && !flag('--unverified')) {
  say(feedRefusal(feedSeen, resolve(artifact)));
  say('  (installing a build you made yourself: add --unverified)');
  process.exit(1);
}

// --dry with nothing to install: the plan for this checkout's version (what a build of it would do)
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let version;
if (!artifact && !fromDir) {
  const m = existsSync(join(here, MANIFEST_FILE)) ? readManifest(join(here, MANIFEST_FILE)) : null;
  version = m?.version ?? JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;
  if (!dry) {
    // D-98: Command Center's own database first (the web and worker wait for it); a no-op when it already runs, and
    // nothing at all for Homebrew Postgres or a DATABASE_URL you set. A source checkout only when its env file says
    // CC_DB_ENGINE=bundled (it moved): a developer's checkout never gets a cluster it didn't ask for.
    const bundled = dbEngine().engine === 'bundled' && (m || readEnvFile(envFilePath())?.CC_DB_ENGINE === 'bundled');
    if (bundled && !argv.includes('--out')) {
      const db = await ensureDatabase();
      say(ensureDatabaseMessage(db));
      if (!db.ok) process.exit(1);
    }
    if (!m) {
      // a source checkout: the LaunchAgents for this checkout, exactly as before
      const r = spawnSync(process.execPath, [join(here, 'scripts', 'ops', 'install-agents.mjs'), ...argv], { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    const deps = realDeps({ say, requireInstance: true }); // this build's own installer: it reports `instance` (P35-2)
    say(`starting v${m.version}; waiting for it to answer…`);
    const s = await restartAgents(deps, m.version);
    if (s.status === 'failed') {
      say(s.failedAt === 'agents' ? 'the LaunchAgents could not be written (the line above says why); Command Center was not started.' : `Command Center did not answer on http://localhost:${deps.port()} after starting.`);
      say(`  ${npmInCurrent('doctor')} says why; ~/Library/Logs/command-center/web.log has the details.`);
      process.exit(1);
    }
    say(`LaunchAgents written for releases/current (v${m.version}), started and answering on http://localhost:${deps.port()}. Check with: ${npmInCurrent('doctor')}`);
    process.exit(0);
  }
  say(`no build given: the plan for installing v${version} (this ${m ? 'build' : 'checkout'})`);
}

async function confirm(q) {
  if (flag('--yes') || dry) return true;
  if (!process.stdin.isTTY) {
    say('not a terminal: run it again with --yes to go ahead');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`[install] ${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

if (!(await confirm('Install this build, migrate the database (after a backup) and restart Command Center?'))) {
  say('nothing changed');
  process.exit(1);
}

const deps = realDeps({ say, dry });
const r = await installRelease(deps, {
  releasesDir: deps.releasesDir,
  artifact: artifact ? resolve(artifact) : undefined,
  fromDir,
  sha256,
  version,
  dry,
  keep: Number(val('--keep')) || KEEP_RELEASES,
  backup: !flag('--no-backup'),
  start: !flag('--no-start'),
  reinstall: flag('--reinstall'),
  allowDowngrade: flag('--allow-downgrade'),
});
if (r.failedAt === 'downgrade') {
  if (r.rollbackTo) say(`  back to the version you ran before (v${r.rollbackTo}): ${npmInCurrent('ops:rollback')}`);
  say(`  this older build anyway: the same command with --allow-downgrade`);
}
// The same version again (a second paste of the install prompt): it is installed, but is it running? Start what is
// stopped, so "installed and running" is true when install.sh says it (ON-7).
if (r.status === 'up_to_date' && !dry && !flag('--no-start')) {
  const s = await startStopped(deps, r.version);
  if (s.status === 'failed') {
    if (s.failedAt === 'health') say(`v${r.version} did not answer on http://localhost:${deps.port()}. ${npmInCurrent('doctor')} says why; ~/Library/Logs/command-center/web.log has the details.`);
    process.exit(1);
  }
}
// ON-31: the rollback hint only when there is an earlier release for ops:rollback to go back to
const canRollBack = r.status === 'installed' && !dry && r.previous && r.previous !== r.version && rollbackTarget(deps.releasesDir);
if (r.status === 'installed') say(`installed v${r.version}${canRollBack ? ` (was v${r.previous}; ${npmInCurrent('ops:rollback')} goes back)` : r.previous ? ` (was v${r.previous})` : ''}. Open http://localhost:${deps.port()}`);
if (r.status === 'planned') say('dry run: nothing changed');
process.exit(r.status === 'installed' || r.status === 'up_to_date' || r.status === 'planned' ? 0 : 1);
