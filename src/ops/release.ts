/**
 * The app's side of compiled releases (D-90, PKG-2): the release feed (the shared Drive folder's `manifest.json`),
 * the update check's result file (`update-check.json` in the state folder: GET /version's `update` and doctor read
 * it), the installed release's own manifest, and the sha256 check of a downloaded build.
 *
 * Twin of scripts/ops/lib/release-manifest.mjs (the installer runs without tsx, so it can't import this file); the
 * feed format and the version order are tested against each other (tests/release/twins.test.ts).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import { currentReleaseLink, releasesDir, updateCheckPath } from './paths';

type Env = Record<string, string | undefined>;

export const RELEASE_CHANNELS = ['stable', 'beta'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const FeedRelease = z.object({
  version: z.string(),
  channel: z.enum(RELEASE_CHANNELS),
  artifact: z.string(),
  sha256: Hex64,
  bytes: z.number().int().nonnegative().optional(),
  arch: z.string().optional(),
  node: z.string().optional(),
  sha: z.string().nullable().optional(),
  migration_head: z.string().nullable().optional(),
  notes: z.string().default(''),
  published_at: z.string().optional(),
  drive_file_id: z.string().nullable().optional(),
});
export type FeedRelease = z.infer<typeof FeedRelease>;

export const ReleaseFeed = z.object({ schema: z.literal(1), name: z.literal('command-center'), updated_at: z.string().optional(), releases: z.array(z.unknown()) });

/** The feed from a tool's text (header lines around the JSON are cut off); rows that don't parse are dropped. */
export function parseReleaseFeed(text: string): { releases: FeedRelease[] } {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('the release feed holds no JSON');
  const j = ReleaseFeed.parse(JSON.parse(text.slice(a, b + 1)));
  const releases = j.releases.flatMap((r) => {
    const p = FeedRelease.safeParse(r);
    return p.success && parseSemver(p.data.version) ? [p.data] : [];
  });
  return { releases };
}

// --------------------------------------------------------------------------------------------- versions

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 or 1 by semver precedence ("2.0.0-beta.2" < "2.0.0"). */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The newest release this install takes (stable: stable only; beta: both; a dev build reads as stable). */
export function compareWithFeed(feed: { releases: FeedRelease[] }, current: string, channel: string, arch: string | null = null): { latest: FeedRelease | null; available: boolean } {
  const beta = channel === 'beta';
  const latest =
    [...feed.releases]
      .filter((r) => (beta || r.channel === 'stable') && (!arch || !r.arch || r.arch === arch))
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
  return { latest, available: !!latest && compareVersions(latest.version, current) > 0 };
}

// --------------------------------------------------------------------------------------------- the check's result

export const UpdateStatus = z.object({
  checkedAt: z.string(),
  ok: z.boolean(),
  /** The catalog-ish reason the last check could not read the feed ("no_folder", "drive_auth", "feed_invalid", …). */
  error: z.string().nullable().default(null),
  current: z.string(),
  channel: z.string(),
  available: z.boolean(),
  latest: FeedRelease.nullable().default(null),
  /** Where the feed was read from: the Drive folder id (never a token or a link with credentials). */
  folderId: z.string().nullable().default(null),
  /** The read tools used, in order (Provenance: "how did the app learn about 2.1.0?"). */
  readTools: z.array(z.string()).default([]),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export function readUpdateStatus(file = updateCheckPath()): UpdateStatus | null {
  try {
    return UpdateStatus.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function writeUpdateStatus(s: UpdateStatus, file = updateCheckPath()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(UpdateStatus.parse(s), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * What a teammate pastes into Claude Code to update (the Drive read path reads text, not a 100-200 MB binary:
 * `get_drive_file_content` returns the file's text content, so the download is Claude Code's, with the user's own
 * Drive access, in the user's own session; docs/INSTALL.md).
 *
 * Twin of scripts/ops/lib/update-from.mjs `claudeUpdatePrompt` (what `npm run update -- --from <folder id>` prints,
 * the text the install walks validated): same words, same releases folder (CC_RELEASES_DIR, else CC_STATE_DIR, else
 * the default), pinned equal by tests/ops/update-prompt-twins.test.ts. Keep the two in step.
 */
export function updatePrompt(latest: Pick<FeedRelease, 'version'>, folderId: string | null, env: Env = process.env): string {
  const v = `v${latest.version}`;
  const where = folderId ? `the Google Drive folder https://drive.google.com/drive/folders/${folderId}` : 'the Command Center Google Drive folder';
  return [
    `Update Command Center to ${v}: from ${where}`,
    `download manifest.json and the command-center-…-${process.arch}.tgz it lists for ${v} into ~/Downloads/command-center-update/,`,
    'check the .tgz sha256 (shasum -a 256) equals its row in manifest.json, then run',
    `${npmInCurrent('update', env)} -- --from ~/Downloads/command-center-update/<that .tgz>`,
    'and show me its output. Do not change anything else.',
  ].join(' ');
}

/**
 * `npm run <script>` in the installed release as a person pastes it into any Terminal (home-relative and quoted:
 * Application Support has a space). Twin of scripts/ops/lib/paths.mjs `npmInCurrent`.
 */
export function npmInCurrent(script: string, env: Env = process.env): string {
  const cur = currentReleaseLink(env);
  const home = env.HOME;
  return `npm --prefix "${home && cur.startsWith(`${home}/`) ? `$HOME${cur.slice(home.length)}` : cur}" run ${script}`;
}

// --------------------------------------------------------------------------------------------- the installed release

export interface InstalledRelease {
  /** releases/current exists and points at a folder with a manifest. */
  linked: boolean;
  version: string | null;
  channel: string | null;
  arch: string | null;
  builtAt: string | null;
  dir: string | null;
}

interface ReleaseManifestFile {
  version: string;
  channel?: string;
  arch?: string;
  built_at?: string;
  sha?: string | null;
  files: Record<string, { sha256: string; size: number }>;
}

export function readReleaseManifest(dir: string): ReleaseManifestFile | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ReleaseManifestFile & { name?: string };
    return m && m.name === 'command-center' && typeof m.version === 'string' && m.files ? m : null;
  } catch {
    return null;
  }
}

/** The release this process runs from (its working directory holds the manifest), else what `current` points at. */
export function installedRelease(env: Env = process.env, cwd = process.cwd()): InstalledRelease {
  const none: InstalledRelease = { linked: false, version: null, channel: null, arch: null, builtAt: null, dir: null };
  const own = readReleaseManifest(cwd);
  const link = currentReleaseLink(env);
  let linkedDir: string | null = null;
  try {
    if (lstatSync(link).isSymbolicLink()) linkedDir = join(releasesDir(env), basename(readlinkSync(link)));
  } catch {
    linkedDir = null;
  }
  const m = own ?? (linkedDir ? readReleaseManifest(linkedDir) : null);
  if (!m) return { ...none, linked: !!linkedDir && existsSync(linkedDir) };
  return { linked: !!linkedDir && existsSync(join(linkedDir, 'manifest.json')), version: m.version, channel: m.channel ?? null, arch: m.arch ?? null, builtAt: m.built_at ?? null, dir: own ? cwd : linkedDir };
}

/** sha256 (hex) of a file, streamed. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** A downloaded build is the published one: its sha256 equals the feed row's (checked before anything runs). */
export async function verifyArtifact(file: string, row: Pick<FeedRelease, 'sha256'>): Promise<{ ok: boolean; got: string }> {
  const got = await sha256File(file);
  return { ok: got === row.sha256, got };
}

/**
 * Does an installed release folder still match its manifest? Sizes of every file, plus the sha256 of `sample` files
 * (or of every file with `deep`). Files added since (a runtime cache) are not a mismatch.
 */
export async function verifyReleaseTree(dir: string, m: Pick<ReleaseManifestFile, 'files'>, o: { deep?: boolean; sample?: string[] } = {}): Promise<{ ok: boolean; missing: string[]; changed: string[]; checked: number }> {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [rel, want] of Object.entries(m.files)) {
    const abs = join(dir, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.size !== want.size) {
      changed.push(rel);
      continue;
    }
    if (o.deep || o.sample?.includes(rel)) {
      if ((await sha256File(abs)) !== want.sha256) changed.push(rel);
    }
  }
  return { ok: !missing.length && !changed.length, missing, changed, checked: Object.keys(m.files).length };
}

/** The files doctor hashes every run (the entry points and what launchd starts); the rest are checked by size. */
export const RELEASE_SAMPLE_FILES = ['server.js', 'dist/worker/index.mjs', 'dist/db/migrate.mjs', 'dist/ops/doctor.mjs', 'package.json', 'scripts/ops/run-service.mjs', 'scripts/ops/start-web.mjs'];
