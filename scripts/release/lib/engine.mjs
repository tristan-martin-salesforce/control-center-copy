// The bundled Postgres engine in a release (D-98): @embedded-postgres/darwin-<arch> is an OPTIONAL dependency, so a
// node_modules installed without it (npm install --omit=optional, a partial install, the other arch) builds a release
// with no database engine, and a teammate's fresh Mac then has no Postgres. The build checks the package before it
// bundles anything and refuses without it; `--allow-no-engine` builds one on purpose, labelled with NO_ENGINE_FILE at
// the release root so the smoke (and anyone unpacking it) can tell the two apart.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ENGINE_PACKAGE } from '../../ops/lib/pg.mjs';

/** The server binaries the cluster needs (scripts/ops/lib/pg.mjs runs initdb, pg_ctl and postgres from native/bin). */
export const ENGINE_BINS = ['initdb', 'pg_ctl', 'postgres'];
/** The label an engine-less release carries at its root. */
export const NO_ENGINE_FILE = 'NO-ENGINE.txt';
export const NO_ENGINE_TEXT =
  'This build was made with --allow-no-engine: it carries no bundled Postgres engine (@embedded-postgres/darwin-<arch>).\nInstalling it on a Mac that has no engine leaves Command Center without a database.\n';

export { ENGINE_PACKAGE };

const FIX = 'run `npm ci` (it installs the optional dependency), or pass --allow-no-engine for a deliberate engine-less build';

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const nonEmptyFile = (p) => {
  try {
    const st = statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
};

const missingBins = (dir) => ENGINE_BINS.filter((b) => !nonEmptyFile(join(dir, 'native', 'bin', b))).map((b) => `native/bin/${b}`);

/**
 * Is the engine package for `arch` installed under `<root>/node_modules`, complete, and at the version package.json
 * pins (its optionalDependencies entry)? Returns { ok, package, dir, version, pinned, missing, reason }.
 * @param {{ root: string, arch?: string, pkg?: any }} opts
 */
export function checkEngine({ root, arch = process.arch, pkg = readJson(join(root, 'package.json')) }) {
  const name = ENGINE_PACKAGE(arch);
  const pinned = String(pkg?.optionalDependencies?.[name] ?? pkg?.dependencies?.[name] ?? '').replace(/^[=v]/, '') || null;
  const dir = join(root, 'node_modules', name);
  const out = { ok: false, package: name, dir, version: null, pinned, missing: /** @type {string[]} */ ([]), reason: /** @type {string | null} */ (null) };
  if (!pinned) {
    out.reason = `package.json pins no ${name} (optionalDependencies), so this arch (${arch}) has no bundled Postgres engine: pass --allow-no-engine for a deliberate engine-less build`;
    return out;
  }
  const own = readJson(join(dir, 'package.json'));
  if (!own) {
    out.reason = `the bundled Postgres engine ${name} is not installed in node_modules, so the release would ship without a database: ${FIX}`;
    return out;
  }
  out.version = own.version ?? null;
  out.missing = missingBins(dir);
  if (out.missing.length) {
    out.reason = `the bundled Postgres engine ${name} is incomplete (missing ${out.missing.join(', ')}): ${FIX}`;
    return out;
  }
  if (out.version !== pinned) {
    out.reason = `the bundled Postgres engine ${name} is ${out.version ?? 'of unknown version'}, but package.json pins ${pinned}: ${FIX}`;
    return out;
  }
  out.ok = true;
  return out;
}

/**
 * What an unpacked release carries: state 'present' (every binary there), 'labelled' (built with --allow-no-engine)
 * or 'missing' (neither: the build that must never ship).
 * @param {string} releaseRoot
 * @param {string} arch
 */
export function engineInRelease(releaseRoot, arch) {
  const name = ENGINE_PACKAGE(arch);
  const dir = join(releaseRoot, 'node_modules', name);
  const missing = missingBins(dir);
  if (!missing.length) return { state: 'present', package: name, version: readJson(join(dir, 'package.json'))?.version ?? null, missing };
  if (existsSync(join(releaseRoot, NO_ENGINE_FILE))) return { state: 'labelled', package: name, version: null, missing };
  return { state: 'missing', package: name, version: null, missing };
}
