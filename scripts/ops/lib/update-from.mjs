// `npm run update -- --from <build.tgz | Drive folder id>` (D-90). A compiled build goes through the same steps as
// scripts/ops/install.mjs (scripts/ops/lib/install-release.mjs). A Drive folder id can't be fetched from here: the
// app's Google access is devbar's read-only text path (it reads a file's text, not a 100-200 MB build), so this
// prints the Claude Code prompt that downloads the build with the user's own Drive access, then runs this command.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { installRelease } from './install-release.mjs';
import { feedRefusal, feedShaFor } from './release-manifest.mjs';
import { npmInCurrent, updateCheckPath } from './paths.mjs';
import { realDeps } from './release-wiring.mjs';

const FOLDER_ID = /^[A-Za-z0-9_-]{10,}$/;

/** The Claude Code prompt that downloads and installs the newest build from a Drive folder (docs/INSTALL.md). */
export function claudeUpdatePrompt(folderId, version = null, env = process.env) {
  const v = version ? `v${version}` : 'the newest version';
  return [
    `Update Command Center to ${v}: from the Google Drive folder https://drive.google.com/drive/folders/${folderId}`,
    `download manifest.json and the command-center-…-${process.arch}.tgz it lists for ${v} into ~/Downloads/command-center-update/,`,
    'check the .tgz sha256 (shasum -a 256) equals its row in manifest.json, then run',
    // P34 info: this install's own releases folder (CC_STATE_DIR / CC_RELEASES_DIR), not the default path
    `${npmInCurrent('update', env)} -- --from ~/Downloads/command-center-update/<that .tgz>`,
    'and show me its output. Do not change anything else.',
  ].join(' ');
}

/** The sha256 for `file` from the feed next to it, else from the app's last update check; null when neither lists it. */
export function expectedSha(file, env = process.env) {
  const name = basename(file);
  const near = feedShaFor(file);
  if (near.found) return near.found;
  try {
    const s = JSON.parse(readFileSync(updateCheckPath(env), 'utf8'));
    if (s?.latest?.artifact === name && /^[0-9a-f]{64}$/.test(s.latest.sha256)) return { sha256: s.latest.sha256, source: 'the last update check' };
  } catch {
    /* no check yet */
  }
  return null;
}

/** Returns the process exit code. */
export async function runFromBuild({ from, argv = [], say = console.log, env = process.env, deps = null }) {
  if (!from) {
    say('this is a compiled Command Center build: update it from a build file, not git.');
    say(`  ask Claude Code to update it (docs/INSTALL.md has the prompt), or run: ${npmInCurrent('update', env)} -- --from <command-center-X.Y.Z-ARCH.tgz>`);
    return 1;
  }
  const file = resolve(from);
  if (!existsSync(file)) {
    if (FOLDER_ID.test(from)) {
      say("a Drive folder id: the app's Drive access reads text, not build files, so Claude Code downloads it with your Drive. Paste this into Claude Code:");
      console.log(`\n${claudeUpdatePrompt(from)}\n`);
      return 2;
    }
    say(`there is no file ${from}. Download the build from the Drive folder (or check the name), then run this again. Nothing changed.`);
    return 1;
  }
  const want = expectedSha(file, env);
  if (!want && !argv.includes('--unverified') && !argv.includes('--dry')) {
    // SEC-3: the manifest inside a build vouches only for itself; a build runs only once the feed's sha256 matched
    say(feedRefusal(feedShaFor(file), file));
    say('  (a build you made yourself: add --unverified)');
    return 1;
  }
  if (!want) say(`no release feed lists ${basename(file)}: installing it unverified (--unverified)`);
  else say(`checking ${basename(file)} against ${want.source}`);
  const d = deps ?? realDeps({ env, say, dry: argv.includes('--dry') });
  const r = await installRelease(d, {
    releasesDir: d.releasesDir,
    artifact: file,
    sha256: want?.sha256 ?? null,
    dry: argv.includes('--dry'),
    backup: !argv.includes('--no-backup'),
    start: !argv.includes('--no-restart'),
    reinstall: argv.includes('--reinstall'),
    allowDowngrade: argv.includes('--allow-downgrade'),
  });
  if (r.status === 'installed') say(`v${r.previous ?? '?'} → v${r.version}. Open http://localhost:${d.port?.() ?? 4327}`);
  return r.status === 'installed' || r.status === 'up_to_date' || r.status === 'planned' ? 0 : 1;
}
