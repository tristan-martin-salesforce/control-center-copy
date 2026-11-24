// The two manifests of a compiled release (D-90, PKG-2). Pure functions plus file hashing, shared by the release
// build (scripts/release/build.mjs), the installer (scripts/ops/install.mjs) and their tests (tests/release/**).
//
//   manifest.json (inside every artifact, at its root): what this build is and a sha256 + size per file, so the
//     installer can prove the extracted tree is exactly what was built before anything in it runs.
//       { schema, name, version, sha, dirty, channel, arch, node, built_at, migration_head, files: { path: {sha256, size} } }
//
//   the feed (`manifest.json` in the shared Drive folder; built locally as dist/releases/manifest.json): every
//     published version with its artifact's sha256, so an install verifies the file it was handed against it.
//       { schema, name, updated_at, releases: [{ version, channel, artifact, sha256, bytes, arch, node, notes,
//         published_at, migration_head, drive_file_id }] }
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA = 1;
export const FEED_SCHEMA = 1;
export const APP_NAME = 'command-center';
/** The Node majors a release runs on (.nvmrc says 22; 20 is the floor; 25 is what the maintainer's Mac has). */
export const NODE_RANGE = '>=20 <26';
export const CHANNELS = ['stable', 'beta'];

/** "command-center-2.0.0-arm64.tgz" */
export const artifactName = (version, arch) => `${APP_NAME}-${version}-${arch}.tgz`;

/** sha256 (hex) of a file, streamed. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Every regular file under `root` as a sorted, `/`-separated relative path. Symlinks are listed too (their target is
 * hashed as the link text), so a link swapped for another is caught. The root manifest.json itself is left out.
 */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() || st.isSymbolicLink()) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out.filter((p) => p !== MANIFEST_FILE).sort();
}

async function fileEntry(abs) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    return { sha256: createHash('sha256').update(`link:${readlinkSync(abs)}`).digest('hex'), size: 0 };
  }
  return { sha256: await sha256File(abs), size: st.size };
}

/** The artifact's own manifest, hashing every file under `root`. */
export async function buildManifest({ root, version, sha = null, dirty = 0, channel = 'stable', arch = process.arch, node = NODE_RANGE, builtAt = new Date().toISOString(), migrationHead = null }) {
  const files = {};
  for (const rel of listFiles(root)) files[rel] = await fileEntry(join(root, rel));
  return { schema: MANIFEST_SCHEMA, name: APP_NAME, version, sha, dirty, channel, arch, node, built_at: builtAt, migration_head: migrationHead, files };
}

/** Read and shape-check a manifest.json; throws a plain message when it is not one. */
export function readManifest(file) {
  let m;
  try {
    m = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`no readable ${MANIFEST_FILE} at ${file}`);
  }
  if (!m || m.schema !== MANIFEST_SCHEMA || m.name !== APP_NAME || typeof m.version !== 'string' || !m.files || typeof m.files !== 'object') {
    throw new Error(`${file} is not a Command Center release manifest`);
  }
  return m;
}

/**
 * Does the tree at `root` match its manifest? `deep` hashes every file (the installer, before anything runs);
 * otherwise sizes only, plus the sha of `sample` files (doctor, every 15 minutes). Files added since (a runtime cache)
 * are not a mismatch.
 */
export async function verifyTree(root, manifest, { deep = true, sample = [] } = {}) {
  const missing = [];
  const changed = [];
  for (const [rel, want] of Object.entries(manifest.files)) {
    const abs = join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (!st.isSymbolicLink() && st.size !== want.size) {
      changed.push(rel);
      continue;
    }
    if (deep || sample.includes(rel)) {
      const got = await fileEntry(abs);
      if (got.sha256 !== want.sha256) changed.push(rel);
    }
  }
  return { ok: missing.length === 0 && changed.length === 0, missing, changed, checked: Object.keys(manifest.files).length };
}

// ---------------------------------------------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------------------------------------------

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

export function parseSemver(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 or 1 by semver precedence ("2.0.0-beta.2" < "2.0.0"); an unparsable version sorts lowest. */
export function compareVersions(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
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

// ---------------------------------------------------------------------------------------------------------------
// the feed (the Drive folder's manifest.json)
// ---------------------------------------------------------------------------------------------------------------

export const emptyFeed = (now = new Date()) => ({ schema: FEED_SCHEMA, name: APP_NAME, updated_at: now.toISOString(), releases: [] });

const HEX64 = /^[0-9a-f]{64}$/;

/** A feed from text (it may arrive wrapped in a tool's header lines: the JSON object is cut out first). */
export function parseFeed(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('the release feed holds no JSON');
  let j;
  try {
    j = JSON.parse(s.slice(a, b + 1));
  } catch {
    throw new Error('the release feed is not valid JSON');
  }
  // what is wrong, said plainly (ON-20); install.sh checks the same three things before anything in the build runs
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a Command Center release feed (not a JSON object)');
  const wrong = [
    j.schema !== FEED_SCHEMA && `schema is ${JSON.stringify(j.schema) ?? 'missing'}, not ${FEED_SCHEMA}`,
    j.name !== APP_NAME && `name is ${JSON.stringify(j.name) ?? 'missing'}, not "${APP_NAME}"`,
    !Array.isArray(j.releases) && 'no releases list',
  ].filter(Boolean);
  if (wrong.length) throw new Error(`not a Command Center release feed (${wrong.join('; ')})`);
  const releases = j.releases.filter((r) => r && parseSemver(r.version) && CHANNELS.includes(r.channel) && HEX64.test(String(r.sha256)) && typeof r.artifact === 'string');
  return { ...j, releases };
}

/** One feed row for a built artifact. `notes` is the version's CHANGELOG section. */
export function feedEntry({ manifest, artifact, sha256, bytes, notes = '', publishedAt = new Date().toISOString(), driveFileId = null }) {
  if (!HEX64.test(String(sha256))) throw new Error('feed entry needs the artifact sha256');
  return {
    version: manifest.version,
    channel: manifest.channel,
    artifact,
    sha256,
    bytes,
    arch: manifest.arch,
    node: manifest.node,
    sha: manifest.sha,
    migration_head: manifest.migration_head,
    notes: String(notes).trim(),
    published_at: publishedAt,
    drive_file_id: driveFileId,
  };
}

/** The feed with `entry` in (a re-published version replaces its row), newest first. */
export function upsertFeed(feed, entry, now = new Date()) {
  const rest = feed.releases.filter((r) => !(r.version === entry.version && r.arch === entry.arch));
  return { ...feed, updated_at: now.toISOString(), releases: [entry, ...rest].sort((a, b) => compareVersions(b.version, a.version)) };
}

/** The newest release a `channel` install takes: stable sees stable only, beta sees both. Null when none. */
export function latestFor(feed, channel = 'stable', arch = null) {
  const ok = (r) => (channel === 'beta' ? true : r.channel === 'stable') && (!arch || !r.arch || r.arch === arch);
  return [...feed.releases].filter(ok).sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

/** Is there a newer version than `current` for this channel? (`dev` builds compare like stable.) */
export function updateFor(feed, current, channel = 'stable', arch = null) {
  const latest = latestFor(feed, channel === 'beta' ? 'beta' : 'stable', arch);
  return { latest, available: !!latest && compareVersions(latest.version, current) > 0 };
}

/** Throws unless `file` hashes to `want` (checked before anything in it is extracted or run). */
export async function assertSha256(file, want) {
  if (!HEX64.test(String(want))) throw new Error('no expected sha256 to check the artifact against');
  const got = await sha256File(file);
  if (got !== want) throw new Error(`the artifact's sha256 does not match the release feed (got ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…): not installing it`);
  return got;
}

/** Size of a file in MB, one decimal ("142.3 MB"). */
export const mb = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;

/**
 * The release feeds next to a downloaded build: `manifest.json` (and `releases-manifest.json`), plus the names a
 * browser gives a second download of it ("manifest (1).json"), the plain names first.
 */
export const FEED_FILE_RE = /^(releases-)?manifest( \(\d+\))?\.json$/;
export function feedFilesIn(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => FEED_FILE_RE.test(n));
  } catch {
    return [];
  }
  const rank = (n) => (n === 'manifest.json' ? 0 : n === 'releases-manifest.json' ? 1 : 2);
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true })).map((n) => join(dir, n));
}

/**
 * What the feeds next to `file` say about it (SEC-3): { sha256, source } from the first feed whose row for this file
 * name matches the file's own sha256; else the first row found (the install then stops on the mismatch, naming it);
 * null when no feed lists it. `feeds` is how many feed files were read (0: no manifest.json at all).
 */
export function feedShaFor(file, { hash = () => createHash('sha256').update(readFileSync(file)).digest('hex') } = {}) {
  const name = file.split(sep).pop();
  const feeds = feedFilesIn(join(file, '..'));
  const rows = [];
  const invalid = [];
  for (const f of feeds) {
    try {
      const row = parseFeed(readFileSync(f, 'utf8')).releases.find((r) => r.artifact === name);
      if (row) rows.push({ sha256: row.sha256, source: f });
    } catch (e) {
      // a file named like a feed that is not one (hand-made, truncated): named, with what is wrong (ON-20)
      invalid.push({ file: f, why: e.message });
    }
  }
  if (!rows.length) return { found: null, feeds: feeds.length, ...(invalid.length ? { invalid } : {}) };
  if (rows.length === 1) return { found: rows[0], feeds: feeds.length };
  const got = hash();
  return { found: rows.find((r) => r.sha256 === got) ?? rows[0], feeds: feeds.length };
}

/**
 * The refusal when no feed next to `artifact` lists it (SEC-3), true to what was found (ON-20): no feed, a file that is
 * not a feed (which one, and what is wrong), or a feed that does not list the build.
 * @param {{ feeds: number, invalid?: Array<{ file: string, why: string }> }} f @param {string} artifact
 */
export function feedRefusal(f, artifact) {
  const name = artifact.split(sep).pop();
  const dir = join(artifact, '..');
  if (!f.feeds) return `no manifest.json next to ${name}. Download manifest.json from the same Drive folder into ${dir} (it proves the build is the published one), then run this again. Nothing changed.`;
  const bad = f.invalid?.[0];
  if (bad && f.invalid.length === f.feeds) return `${bad.file.split(sep).pop()} (next to ${name}) can't be used: ${bad.why}. Download manifest.json again from the same Drive folder into ${dir}, then run this again. Nothing changed.`;
  return `the manifest.json next to ${name} does not list it (an older manifest.json?). Download manifest.json again from the same Drive folder into ${dir}, then run this again. Nothing changed.`;
}
