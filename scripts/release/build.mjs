#!/usr/bin/env node
// npm run build:release [-- --channel stable|beta] [--smoke] [--no-next] [--keep-stage] [--allow-no-engine] [--check-engine] [--help]
//
// Builds the compiled, self-contained Command Center (D-90, PKG-2) into dist/command-center-<version>-<arch>.tgz:
//
//   command-center-<version>/
//     server.js, .next/, node_modules/   Next's standalone output: the web server and ONLY the production files it
//                                       needs (no devDependencies, no next CLI), plus .next/static and public/
//     dist/worker/index.mjs              the worker, bundled with esbuild (esbuild.worker.mjs): no tsx at run time
//     dist/db/migrate.mjs, dist/ops/doctor.mjs   the migrator (the installer runs the NEW one) and doctor
//     node_modules/<external>/           the few packages the bundles load at run time, whole (pino, the Agent SDK
//                                       and its peers); never the SDK's 300 MB platform binary: the app runs the
//                                       user's own `claude` CLI (src/ops/claude-bin.ts)
//     skills/, src/db/migrations/, config/, tools-registry/, src/mock/seed.example.json   data read at run time
//     scripts/ops/** (plain .mjs), scripts/lib/release.mjs, ops/launchd/   install, update, rollback, agents
//     package.json                       the release's own (version, engines, scripts that need no tsx)
//     install.sh, docs/INSTALL.md, README.md, CHANGELOG.md
//     manifest.json                      version, sha, channel, arch, node range, built_at, migration head, and the
//                                       sha256 + size of every file above
//
// Licensed fonts (public/fonts) are never shipped: each person's own install provides them (sync-brand-assets).
// The bundled Postgres engine (@embedded-postgres/darwin-<arch>, an optional dependency) is checked before anything is
// built: present, initdb/pg_ctl/postgres in its native/bin, at package.json's pinned version (scripts/release/lib/
// engine.mjs). Without it the build refuses; --allow-no-engine builds without it on purpose and labels the release
// (NO-ENGINE.txt at its root). --check-engine runs only that check.
// --smoke unpacks the artifact into a temp folder and starts it there (scripts/release/smoke.mjs): web (mock data)
// on :4361 and the compiled worker against a throwaway database, then stops both.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleEntries } from '../../esbuild.worker.mjs';
import { artifactName, buildManifest, MANIFEST_FILE, NODE_RANGE, sha256File } from '../ops/lib/release-manifest.mjs';
import { checkEngine, NO_ENGINE_FILE, NO_ENGINE_TEXT } from './lib/engine.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const say = (m) => console.log(`[build:release] ${m}`);
const fail = (m) => {
  console.error(`[build:release] ${m}`);
  process.exit(1);
};

/** Files and folders copied as data, relative to the repo (missing optional ones are skipped). */
export const DATA = ['skills', 'src/db/migrations', 'scripts/ops', 'scripts/lib/release.mjs', 'ops/launchd', 'config', 'tools-registry', 'src/mock/seed.example.json', 'README.md', 'CHANGELOG.md', 'docs/INSTALL.md'];
/** Never in a release: licensed per person, or build-only. */
export const EXCLUDE = [
  /^public\/fonts(\/|$)/,
  /^public\/mockups(\/|$)/,
  /(^|\/)\.DS_Store$/,
  // Next's tracer copies files the server *might* read under the project (the feedback agent's repo reads): the
  // docs (docs/research is private: Org62 ids, customer names), tests, sample data and agent notes never ship;
  // docs/INSTALL.md is the one doc a release carries
  /^docs\/(?!INSTALL\.md$)/,
  /^(tests|sample-data|e2e|fixtures)(\/|$)/,
  /^(CLAUDE|AGENTS|CONTRIBUTING)\.md$/,
  // SEC-2: Next's standalone output copies the checkout's `.env` and `.env.production` next to server.js; a
  // maintainer's env file (secrets, a DATABASE_URL) must never reach a teammate's install. Any `.env*` at any depth.
  /(^|\/)\.env(\.[^/]*)?$/,
  /^node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(\/|$)/,
  /^node_modules\/@img(\/|$)/, // sharp: the app uses no next/image
  /^node_modules\/typescript(\/|$)/,
];
/** The externals' peers they import at run time (the Agent SDK imports the MCP SDK and zod). */
export const EXTERNAL_PEERS = ['@modelcontextprotocol/sdk', 'zod'];
/** What the bundles import at run time (the rest of esbuild's externals are never loaded by them: next, react). */
// D-98: the bundled Postgres 17 server binaries for this Mac's arch (the other arch's optional package isn't installed),
// and pg whole: scripts/ops/lib/pg.mjs talks to the cluster over its socket with it (install, update, backup)
export const RUNTIME_PACKAGES = ['@anthropic-ai/claude-agent-sdk', 'pino', ...EXTERNAL_PEERS, 'pg', '@embedded-postgres/darwin-arm64', '@embedded-postgres/darwin-x64'];

/** The release's own package.json: no devDependencies, and scripts that run the compiled entries. */
export function releasePackageJson(pkg) {
  return {
    name: 'command-center',
    version: pkg.version,
    private: true,
    description: pkg.description,
    type: 'module',
    engines: { node: NODE_RANGE },
    scripts: {
      start: 'node scripts/ops/start-web.mjs',
      worker: 'node dist/worker/index.mjs',
      'worker:start': 'node dist/worker/index.mjs',
      doctor: 'node dist/ops/doctor.mjs',
      'db:migrate': 'node dist/db/migrate.mjs',
      update: 'node scripts/ops/update.mjs',
      'ops:install': 'node scripts/ops/install.mjs',
      'ops:rollback': 'node scripts/ops/rollback.mjs',
      'ops:uninstall': 'node scripts/ops/uninstall-agents.mjs',
      backup: 'node scripts/ops/backup.mjs',
      restore: 'node scripts/ops/restore.mjs',
    },
  };
}

/** A package's folder as node resolves it from `fromDir` (walking up node_modules), or null. */
export function resolvePackageDir(name, fromDir, stopAt) {
  let d = fromDir;
  for (;;) {
    const cand = join(d, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return cand;
    if (d === stopAt || dirname(d) === d) return null;
    d = dirname(d);
  }
}

/** Every package folder `names` need at run time (dependencies, installed optional and peer dependencies). */
export function dependencyClosure(names, root, skip = (n) => /^@anthropic-ai\/claude-agent-sdk-/.test(n)) {
  const out = new Set();
  const queue = names.map((n) => ({ n, from: root }));
  while (queue.length) {
    const { n, from } = queue.shift();
    if (skip(n)) continue;
    const dir = resolvePackageDir(n, from, root);
    if (!dir || out.has(dir)) continue;
    out.add(dir);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) queue.push({ n: dep, from: dir });
  }
  return [...out];
}

const copy = (from, to) => cpSync(from, to, { recursive: true, dereference: true, filter: (src) => !/(^|\/)\.DS_Store$/.test(src) });

function migrationHead() {
  const j = JSON.parse(readFileSync(join(ROOT, 'src', 'db', 'migrations', 'meta', '_journal.json'), 'utf8'));
  return [...j.entries].sort((a, b) => a.idx - b.idx).at(-1)?.tag ?? null;
}

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

function dirBytes(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    n += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return n;
}

/**
 * The engine gate, before anything is built: the check's result when the engine is there; a failure (the plain fix
 * in `message`) when it is not, unless `allowNoEngine`, which returns { ok: true, engineless: true }.
 * @param {{ root: string, arch?: string, pkg?: any, allowNoEngine?: boolean }} opts
 */
export function engineGate({ root, arch = process.arch, pkg, allowNoEngine = false }) {
  const c = checkEngine({ root, arch, pkg });
  if (c.ok) return { ok: true, engineless: false, check: c, message: `engine: ${c.package} ${c.version} (initdb, pg_ctl, postgres)` };
  if (allowNoEngine) return { ok: true, engineless: true, check: c, message: `engine: NONE (--allow-no-engine; the release is labelled ${NO_ENGINE_FILE}): ${c.reason}` };
  return { ok: false, engineless: false, check: c, message: `refusing to build: ${c.reason}` };
}

/**
 * ON-21: a `node_modules` that is a symlink (a worktree borrowing the main checkout's) makes Next's file trace follow it
 * and copy far more than the server needs: 302 MB and 60k files against 137 MB and 14k from the main checkout. The
 * build refuses, naming the fix. Returns the refusal, or null when `root/node_modules` is a real folder (or missing:
 * the engine gate says so).
 * @param {string} root
 */
export function linkedNodeModules(root) {
  try {
    if (!lstatSync(join(root, 'node_modules')).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return `refusing to build: ${join(root, 'node_modules')} is a symlink (a worktree?), and the standalone trace follows it into a release several times too big. Build from the main checkout (its own node_modules: npm ci there), not from a worktree.`;
}

/**
 * ON-28: true when a client chunk under `<staticDir>/chunks` carries the build's sha (BuildWatch compares the inlined
 * NEXT_PUBLIC_CC_GIT_SHA with GET /version's). A stale `.next` once shipped chunks from an older sha, so every first
 * page said "Command Center was updated". With no sha (no git) there is nothing to compare: true.
 */
export function clientShaMatches(staticDir, sha) {
  if (!sha) return true;
  const needle = JSON.stringify(sha);
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.name.endsWith('.js') && readFileSync(p, 'utf8').includes(needle)) return true;
    }
    return false;
  };
  return walk(join(staticDir, 'chunks'));
}

export async function buildRelease({ channel = 'stable', next = true, smoke = false, keepStage = false, allowNoEngine = false } = {}) {
  const t0 = Date.now();
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const arch = process.arch;
  const linked = linkedNodeModules(ROOT);
  if (linked) fail(linked);
  // 0. the bundled database engine (an optional dependency: a node_modules without it once shipped a release with no
  // Postgres while the smoke passed)
  const gate = engineGate({ root: ROOT, arch, pkg, allowNoEngine });
  if (!gate.ok) fail(gate.message);
  say(gate.message);
  const sha = git(['rev-parse', '--short=7', 'HEAD']);
  const dirty = (git(['status', '--porcelain']) ?? '').split('\n').filter((l) => l.trim()).length;
  if (dirty) say(`note: ${dirty} file(s) differ from ${sha}; the build records it as "modified" (a published release is built from a clean tree)`);
  const env = { ...process.env, CC_STANDALONE: '1', CC_CHANNEL: channel, NEXT_TELEMETRY_DISABLED: '1' };

  // 1. the web: Next standalone
  let tNext = 0;
  if (next) {
    const t = Date.now();
    say(`next build (standalone, channel ${channel})…`);
    if (spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-brand-assets.mjs')], { cwd: ROOT, stdio: 'inherit', env }).status !== 0) fail('sync-brand-assets failed');
    rmSync(join(ROOT, '.next'), { recursive: true, force: true }); // ON-28: no stale cache or chunks from an older sha
    if (spawnSync(join(ROOT, 'node_modules', '.bin', 'next'), ['build', '--no-lint'], { cwd: ROOT, stdio: 'inherit', env }).status !== 0) fail('next build failed');
    tNext = Date.now() - t;
  }
  const standalone = join(ROOT, '.next', 'standalone');
  if (!existsSync(join(standalone, 'server.js'))) fail(`no ${relative(ROOT, standalone)}/server.js: next.config.ts must build standalone with CC_STANDALONE=1 (and run without --no-next)`);
  if (!clientShaMatches(join(ROOT, '.next', 'static'), sha)) fail(`no client chunk in .next/static/chunks carries this build's sha ${sha}: the web was built from another commit (run without --no-next)`);

  // 2. assemble the folder
  const stageRoot = join(ROOT, 'dist', 'stage');
  const name = `command-center-${version}`;
  const stage = join(stageRoot, name);
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  copy(standalone, stage);
  copy(join(ROOT, '.next', 'static'), join(stage, '.next', 'static'));
  if (existsSync(join(ROOT, 'public'))) copy(join(ROOT, 'public'), join(stage, 'public'));

  // 3. the worker, the migrator and doctor (esbuild)
  const t1 = Date.now();
  const bundles = await bundleEntries({ root: ROOT, outdir: stage });
  const tBundle = Date.now() - t1;

  // 4. data the app reads at run time, and the ops scripts
  for (const rel of DATA) {
    const from = join(ROOT, rel);
    if (existsSync(from)) copy(from, join(stage, rel));
  }
  copy(join(ROOT, 'scripts', 'ops', 'install.sh'), join(stage, 'install.sh'));
  chmodSync(join(stage, 'install.sh'), 0o755);

  // 5. the bundles' externals, whole, with their dependencies (merged over the traced files Next copied)
  const closure = dependencyClosure(RUNTIME_PACKAGES, ROOT);
  for (const dir of closure) copy(dir, join(stage, relative(ROOT, dir)));

  // 6. the release's own package.json, then everything that must not ship
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(releasePackageJson(pkg), null, 2)}\n`);
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const abs = join(dir, n);
      const rel = relative(stage, abs).split('\\').join('/');
      if (EXCLUDE.some((re) => re.test(rel))) {
        rmSync(abs, { recursive: true, force: true });
        continue;
      }
      if (statSync(abs).isDirectory()) walk(abs);
    }
  };
  walk(stage);
  rmSync(join(stage, '.next', 'cache'), { recursive: true, force: true });
  if (gate.engineless) {
    // a deliberate engine-less build carries none of it (not a wrong version, not a partial copy), and says so
    rmSync(join(stage, 'node_modules', gate.check.package), { recursive: true, force: true });
    writeFileSync(join(stage, NO_ENGINE_FILE), NO_ENGINE_TEXT);
  }

  // 7. the manifest, then the archive (COPYFILE_DISABLE: no AppleDouble ._ files)
  const manifest = await buildManifest({ root: stage, version, sha, dirty, channel, arch, node: NODE_RANGE, migrationHead: migrationHead() });
  writeFileSync(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 1)}\n`);
  const out = join(ROOT, 'dist', artifactName(version, arch));
  rmSync(out, { force: true });
  const t2 = Date.now();
  if (spawnSync('/usr/bin/tar', ['-czf', out, '-C', stageRoot, name], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } }).status !== 0) fail('tar failed');
  const tTar = Date.now() - t2;
  const sha256 = await sha256File(out);
  const bytes = statSync(out).size;
  const unpacked = dirBytes(stage);
  const info = {
    artifact: relative(ROOT, out),
    version,
    channel,
    arch,
    sha,
    dirty,
    sha256,
    bytes,
    unpackedBytes: unpacked,
    files: Object.keys(manifest.files).length,
    migrationHead: manifest.migration_head,
    engine: gate.engineless ? { package: gate.check.package, bundled: false, label: NO_ENGINE_FILE } : { package: gate.check.package, bundled: true, version: gate.check.version },
    bundles: bundles.map((b) => ({ file: relative(stage, resolve(ROOT, b.file)), bytes: b.bytes })),
    timingsMs: { next: tNext, bundle: tBundle, tar: tTar, total: Date.now() - t0 },
    builtAt: manifest.built_at,
  };
  writeFileSync(out.replace(/\.tgz$/, '.build.json'), `${JSON.stringify(info, null, 2)}\n`);
  say(`${info.artifact}: ${(bytes / 1024 / 1024).toFixed(1)} MB (${(unpacked / 1024 / 1024).toFixed(0)} MB unpacked, ${info.files} files), sha256 ${sha256}`);
  say(`times: next ${(tNext / 1000).toFixed(0)} s · bundle ${(tBundle / 1000).toFixed(1)} s · tar ${(tTar / 1000).toFixed(1)} s · total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!keepStage) rmSync(stageRoot, { recursive: true, force: true });
  if (smoke) {
    const { smokeArtifact } = await import('./smoke.mjs');
    const r = await smokeArtifact({ artifact: out, say });
    info.smoke = r;
    writeFileSync(out.replace(/\.tgz$/, '.build.json'), `${JSON.stringify(info, null, 2)}\n`);
    if (!r.ok) fail(`smoke failed: ${r.reason}`);
  }
  return info;
}

const HELP = `usage: npm run build:release [-- options]
  --channel stable|beta   the release channel (default: CC_CHANNEL or stable)
  --smoke                 unpack the artifact into a temp folder and start it there (scripts/release/smoke.mjs)
  --no-next               reuse the existing .next/standalone instead of running next build
  --keep-stage            keep dist/stage/ after archiving
  --allow-no-engine       build without the bundled Postgres engine on purpose (the release is labelled ${NO_ENGINE_FILE})
  --check-engine          only check the bundled Postgres engine (${process.arch}) and exit
  --help                  this text`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (flag('--help') || flag('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  if (flag('--check-engine')) {
    const gate = engineGate({ root: ROOT, allowNoEngine: flag('--allow-no-engine') });
    (gate.ok ? say : (m) => console.error(`[build:release] ${m}`))(gate.message);
    process.exit(gate.ok ? 0 : 1);
  }
  const channel = val('--channel', process.env.CC_CHANNEL || 'stable');
  if (!['stable', 'beta'].includes(channel)) fail('--channel must be stable or beta');
  await buildRelease({ channel, next: !flag('--no-next'), smoke: flag('--smoke'), keepStage: flag('--keep-stage'), allowNoEngine: flag('--allow-no-engine') });
}
