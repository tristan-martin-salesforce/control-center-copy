/**
 * `npm run release -- <bump> --publish` (D-90, H-12), the part after the version bump. scripts/release.mjs runs it
 * (with tsx; the maintainer's checkout has it) in three modes:
 *
 *   --preflight             `npm run scan:private`: any hit, or a scan that can't run, refuses the release before
 *                           anything is bumped (D-90 "the release command refuses on any scan:private hit")
 *   --dry --version X       print the plan: what would be built, the feed row, the two Outbox items; build nothing,
 *                           write nothing, stage nothing
 *   --version X             build the artifact (npm run build:release), write dist/releases/ (the build, the feed
 *                           manifest.json with this row, install.sh) and stage the two items for the maintainer:
 *                             1. release.drive_upload: a handoff (the app's Drive access is read-only; hard
 *                                invariant 2): the files, the folder link and the upload instructions to copy
 *                             2. release.announce: the Slack announcement draft for distribution.announceChannel
 *                           Both are written to dist/releases/outbox-<version>.json and printed, then created as
 *                           two Outbox drafts in the running app (POST /outbox/releases, W12-7; idempotent per
 *                           version: a second run updates them, never a second pair). When the app is not running
 *                           the file stays the hand-over: `npm run release:outbox -- dist/releases/outbox-<v>.json`
 *                           creates them later. Nothing is sent, uploaded or pushed (*Nothing leaves without
 *                           approval*): you Approve each item in the Outbox (the announcement under the dry run).
 *
 * Options: --channel stable|beta · --feed <the Drive folder's current manifest.json> · --skip-build (reuse the
 * artifact in dist/) · --folder <drive folder id> · --announce <channel id> (else settings/config/team.json) ·
 * --no-app (write the file only) · the app's port: CC_APP_PORT (else 4327) · CC_RELEASE_DIST (the dist folder; tests).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDistribution, driveFolderUrl } from '../../src/ops/distribution';
import { releaseHandoffItems, type ReleaseHandoffInput } from '../../src/outbox/adapters/release-handoff';
import { appPortFrom, describeStaged, importHint, stageInApp } from './outbox';
// plain .mjs twins (the installer's own code: the feed this writes is the one it reads)
import { artifactName, emptyFeed, feedEntry, parseFeed, upsertFeed } from '../ops/lib/release-manifest.mjs';
import { renderSection, splitChangelog, today } from '../lib/release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const val = (n: string, d?: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const say = (m: string) => console.log(`[release:publish] ${m}`);
const fail = (m: string): never => {
  console.error(`[release:publish] ${m}`);
  process.exit(1);
};

/** Where the build lands and dist/releases/ is written (CC_RELEASE_DIST: tests point it at a temp folder). */
const DIST = process.env.CC_RELEASE_DIST ? resolve(process.env.CC_RELEASE_DIST) : join(ROOT, 'dist');
const RELEASES_OUT = join(DIST, 'releases');

/** One version's CHANGELOG section ("## [2.1.0] - …" up to the next "## ["), without its heading. */
export function sectionFor(changelog: string, version: string): string {
  const re = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm');
  return re.exec(changelog)?.[1]?.trim() ?? '';
}

function distribution() {
  const d = resolveDistribution({}, undefined, process.env);
  return { ...d, driveFolderId: val('--folder') ?? d.driveFolderId, announceChannel: val('--announce') ?? d.announceChannel };
}

function preflight(): void {
  say('npm run scan:private (paths and counts only)…');
  const r = spawnSync('npm', ['run', '--silent', 'scan:private'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail('scan:private found private material, or could not run: nothing was bumped, built or staged');
  say('scan:private: clean');
}

function readFeedFile(file: string | undefined) {
  if (!file || !existsSync(file)) return null;
  return parseFeed(readFileSync(file, 'utf8'));
}

async function main() {
  if (flag('--preflight')) return preflight();
  const version = val('--version') ?? fail('--version is required');
  const channel = (val('--channel', 'stable') === 'beta' ? 'beta' : 'stable') as 'stable' | 'beta';
  const dist = distribution();
  const name = artifactName(version, process.arch);
  const artifact = join(DIST, name);
  const feedOut = join(RELEASES_OUT, 'manifest.json');
  const changelog = existsSync(join(ROOT, 'CHANGELOG.md')) ? readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8') : '';

  if (flag('--dry')) {
    const notes = sectionFor(changelog, version) || renderSection({ version, date: today(), unreleased: splitChangelog(changelog).unreleased, subjects: [] }).split('\n').slice(1).join('\n').trim();
    const sample: ReleaseHandoffInput = { version, channel, artifactPath: join(RELEASES_OUT, name), feedPath: feedOut, installShPath: join(RELEASES_OUT, 'install.sh'), artifactName: name, sha256: '<sha256 after the build>', bytes: 0, notes, folderId: dist.driveFolderId, announceChannel: dist.announceChannel, announceChannelName: dist.announceChannelName };
    const [upload, announce] = releaseHandoffItems(sample);
    console.log(
      [
        '',
        `[release:publish] plan for v${version} (${channel}), dry run: nothing is built, written, staged, uploaded or posted`,
        '  1. npm run scan:private                  refuse on any hit (runs before the bump)',
        `  2. npm run build:release -- --channel ${channel}   → dist/${name} (+ .build.json: size, sha256, timings)`,
        `  3. dist/releases/                        ${name}, manifest.json (the feed: this row added to ${val('--feed') ? `--feed ${val('--feed')}` : existsSync(feedOut) ? 'the existing dist/releases/manifest.json' : 'a new feed'}), install.sh`,
        `  4. stage two items for you to apply      dist/releases/outbox-${version}.json, then two Outbox drafts in the running app`,
        `     (POST /outbox/releases on port ${appPortFrom(argv)}; app not running → ${importHint(`dist/releases/outbox-${version}.json`)} later)`,
        `     a. release.drive_upload (a handoff: the app's Drive access is read-only)`,
        `        folder: ${upload.folderUrl ?? '<not set: distribution.driveFolderId / config/team.json distributionDriveFolderId / --folder>'}`,
        ...upload.files.map((f) => `        - ${f.name}`),
        `     b. release.announce (a Slack draft, dry run on) to ${announce.channel ?? '<not set: distribution.announceChannel / --announce>'}`,
        ...announce.text.split('\n').map((l) => `        | ${l}`),
        '',
      ].join('\n'),
    );
    return;
  }

  // build (or reuse) the artifact
  if (!flag('--skip-build')) {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release', 'build.mjs'), '--channel', channel], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) fail('build:release failed: nothing was staged (the version commit and tag stay; fix and run with --skip-build=false again)');
  }
  const infoFile = artifact.replace(/\.tgz$/, '.build.json');
  if (!existsSync(artifact) || !existsSync(infoFile)) fail(`no ${name} in dist/ (run npm run build:release first)`);
  const info = JSON.parse(readFileSync(infoFile, 'utf8')) as { sha256: string; bytes: number; version: string; channel: string; arch: string; sha: string | null; migrationHead: string | null };
  if (info.version !== version) fail(`dist/${name} is v${info.version}, not v${version}`);

  // the feed and the upload folder
  mkdirSync(RELEASES_OUT, { recursive: true });
  const notes = sectionFor(changelog, version);
  const feed = readFeedFile(val('--feed')) ?? readFeedFile(feedOut) ?? emptyFeed();
  const manifest = { version, channel: info.channel, arch: info.arch, node: '>=20 <26', sha: info.sha, migration_head: info.migrationHead };
  const next = upsertFeed(feed, feedEntry({ manifest, artifact: name, sha256: info.sha256, bytes: info.bytes, notes }));
  writeFileSync(feedOut, `${JSON.stringify(next, null, 2)}\n`);
  const upload = join(RELEASES_OUT, name);
  rmSync(upload, { force: true });
  try {
    linkSync(artifact, upload); // the same file, not a second copy
  } catch {
    copyFileSync(artifact, upload);
  }
  copyFileSync(join(ROOT, 'scripts', 'ops', 'install.sh'), join(RELEASES_OUT, 'install.sh'));
  say(`dist/releases/: ${name}, manifest.json (${next.releases.length} release(s)), install.sh`);

  // the two items, staged for the maintainer (never sent from here)
  const input: ReleaseHandoffInput = { version, channel, artifactPath: join(RELEASES_OUT, name), feedPath: feedOut, installShPath: join(RELEASES_OUT, 'install.sh'), artifactName: name, sha256: info.sha256, bytes: info.bytes, notes, folderId: dist.driveFolderId, announceChannel: dist.announceChannel, announceChannelName: dist.announceChannelName };
  const items = releaseHandoffItems(input);
  const staged = join(RELEASES_OUT, `outbox-${version}.json`);
  writeFileSync(staged, `${JSON.stringify({ stagedAt: new Date().toISOString(), version, input, items }, null, 2)}\n`);
  say(`staged two items (nothing sent): ${staged}`);
  // W12-7: the two items as Outbox drafts in the running app (you Approve them there); else the file is the hand-over
  const rel = relative(process.cwd(), staged) || staged;
  const inApp = flag('--no-app') ? null : await stageInApp(input, appPortFrom(argv));
  if (inApp?.ok) {
    say(`in the Outbox (Approve there; ${inApp.result.dryRun ? 'dry run on: Approve renders the post, nothing is sent' : 'live send: Approve shows the post and asks you to confirm'}):`);
    for (const l of describeStaged(inApp.result)) console.log(l);
  } else {
    say(`not in the Outbox yet${inApp ? ` (${inApp.message})` : ' (--no-app)'}: start the app, then ${importHint(rel)}`);
  }
  console.log(`\n--- 1. Upload to Drive (Copy upload instructions) ---\n${items[0].copyText}\n`);
  console.log(`--- 2. Announcement draft for ${items[1].channel ?? '<no channel set>'} (send it from the Outbox or paste it yourself) ---\n${items[1].text}\n`);
  if (dist.driveFolderId) say(`folder: ${driveFolderUrl(dist.driveFolderId)}`);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
