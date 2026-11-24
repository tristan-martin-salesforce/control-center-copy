/**
 * PKG-2 / D-90: installing a compiled release and rolling back as a whole, on real temp folders with fakes for tar,
 * the database, launchd, pg_dump, the migrator and the version route.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _m7492Raw from '../../scripts/ops/lib/install-release.mjs';
// plain .mjs: its inferred JS types are too narrow for tests
const _m7492: any = _m7492Raw;
const {
  currentVersion,
  installedVersions,
  installRelease,
  isInstallableVersion,
  nodeSatisfies,
  prune,
  readState,
  repoint,
  rollbackRelease,
  rollbackTarget,
} = _m7492;
import * as _m7716Raw from '../../scripts/ops/lib/release-manifest.mjs';
// plain .mjs: its inferred JS types are too narrow for tests
const _m7716: any = _m7716Raw;
const { buildManifest, sha256File } = _m7716;

let tmp: string;
let R: string;
let builds: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-install-'));
  R = join(tmp, 'releases');
  builds = join(tmp, 'builds');
  mkdirSync(builds);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** An unpacked build folder `builds/<v>/command-center-<v>/` with a valid manifest; returns the "artifact" (its parent). */
async function makeBuild(version: string, o: { node?: string; corrupt?: boolean } = {}): Promise<string> {
  const art = join(builds, version);
  const root = join(art, `command-center-${version}`);
  mkdirSync(join(root, 'dist', 'worker'), { recursive: true });
  writeFileSync(join(root, 'server.js'), `// v${version}\n`);
  writeFileSync(join(root, 'dist', 'worker', 'index.mjs'), `export const v = '${version}';\n`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  const m = await buildManifest({ root, version, channel: 'stable', arch: 'arm64', node: o.node ?? '>=20 <26' });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(m));
  if (o.corrupt) writeFileSync(join(root, 'server.js'), '// edited after the build\n');
  return art;
}

interface Fake {
  log: string[];
  calls: string[];
  running: Set<string>;
  fail: Partial<Record<'db' | 'env' | 'backup' | 'migrate' | 'render' | 'health', boolean>>;
  healthFor: (v: string) => boolean;
}

function fakeDeps(f: Fake) {
  return {
    say: (m: string) => f.log.push(m),
    nodeVersion: 'v22.11.0',
    now: () => new Date('2026-11-20T10:00:00Z'),
    extract: async (artifact: string, into: string) => {
      f.calls.push('extract');
      if (!existsSync(artifact) || !statSync(artifact).isDirectory()) return false;
      cpSync(artifact, into, { recursive: true, verbatimSymlinks: true });
      return true;
    },
    ensureDatabase: async () => (f.calls.push('db'), f.fail.db ? { ok: false, message: 'Postgres 17 is not installed.', command: 'brew install postgresql@17 && brew services start postgresql@17' } : { ok: true, message: 'Postgres 17 is running' }),
    ensureEnv: async () => (f.calls.push('env'), !f.fail.env),
    agents: {
      running: () => [...f.running],
      stop: async (k: string) => (f.calls.push(`stop:${k}`), f.running.delete(k), true),
      start: async (k: string) => (f.calls.push(`start:${k}`), f.running.add(k), true),
      render: async () => (f.calls.push(`render:${currentVersion(R)}`), !f.fail.render),
    },
    backup: async () => {
      f.calls.push('backup');
      if (f.fail.backup) throw new Error('pg_dump failed');
      return { name: 'command_center-20261120-1000.dump' };
    },
    migrate: async (dir: string) => (f.calls.push(`migrate:${dir.split('/').pop()}`), !f.fail.migrate),
    health: async (v: string) => (f.calls.push(`health:${v}`), f.healthFor(v)),
  };
}

const fake = (over: Partial<Fake> = {}): Fake => ({ log: [], calls: [], running: new Set(), fail: {}, healthFor: () => true, ...over });

describe('installRelease', () => {
  it('first install: verify, database, env, backup, migrate with the new build, switch, agents, health, history', async () => {
    const f = fake();
    const art = await makeBuild('2.0.0');
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: art });
    expect(r).toMatchObject({ status: 'installed', version: '2.0.0', previous: null });
    expect(currentVersion(R)).toBe('2.0.0');
    expect(readlinkSync(join(R, 'current'))).toBe('2.0.0'); // relative: the folder can move with the state folder
    expect(f.calls).toEqual(['extract', 'db', 'env', 'backup', 'migrate:2.0.0', 'render:2.0.0', 'start:web', 'start:worker', 'health:2.0.0']);
    expect(readState(R)).toMatchObject({ current: '2.0.0', history: [{ version: '2.0.0', previous: null, backup: 'command_center-20261120-1000.dump' }] });
    expect(readdir(R)).toEqual(['2.0.0', 'current', 'state.json']); // the staging folder is gone
  });

  it('checks the artifact sha256 against the feed before unpacking; a mismatch changes nothing', async () => {
    const f = fake();
    const file = join(tmp, 'a.tgz');
    writeFileSync(file, 'not the build');
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: file, sha256: 'a'.repeat(64) });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'sha' });
    expect(f.calls).toEqual([]);
    expect(existsSync(R)).toBe(false);
    const ok = await installRelease(fakeDeps(f), { releasesDir: R, artifact: file, sha256: await sha256File(file) });
    expect(ok.failedAt).toBe('extract'); // the sha matched; it is just not a folder the fake can unpack
  });

  it('a build whose files do not match its manifest is refused, and the staging folder removed', async () => {
    const f = fake();
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0', { corrupt: true }) });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'verify' });
    expect(f.log.join('\n')).toMatch(/0 missing, 1 changed \(first: server\.js\)/);
    expect(installedVersions(R)).toEqual([]);
    expect(readdir(R)).toEqual([]);
  });

  it('refuses a Node outside the build range before anything is moved', async () => {
    const f = fake();
    const d = { ...fakeDeps(f), nodeVersion: 'v18.20.0' };
    expect((await installRelease(d, { releasesDir: R, artifact: await makeBuild('2.0.0') })).failedAt).toBe('node');
    expect(nodeSatisfies('v22.1.0', '>=20 <26')).toBe(true);
    expect(nodeSatisfies('v25.4.0', '>=20 <26')).toBe(true);
    expect(nodeSatisfies('v26.0.0', '>=20 <26')).toBe(false);
    expect(nodeSatisfies('v19.9.0', '>=20 <26')).toBe(false);
  });

  it('database not ready: stops with the exact brew command, nothing running is touched', async () => {
    const f = fake({ fail: { db: true }, running: new Set(['web', 'worker']) });
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'database' });
    expect(f.log.join('\n')).toContain('brew install postgresql@17 && brew services start postgresql@17');
    expect(f.calls.filter((c) => c.startsWith('stop'))).toEqual([]);
    expect(currentVersion(R)).toBeNull();
  });

  it('upgrade: a failed migration leaves current on the old release and starts it again', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    f.calls.length = 0;
    f.fail.migrate = true;
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'migrate', previous: '2.0.0' });
    expect(currentVersion(R)).toBe('2.0.0');
    expect(f.calls).toEqual(['extract', 'db', 'env', 'stop:web', 'stop:worker', 'backup', 'migrate:2.0.1', 'start:web', 'start:worker']);
    expect(installedVersions(R)).toEqual(['2.0.1', '2.0.0']); // unpacked and verified, kept for the next try
  });

  it('a failed backup migrates nothing and restarts the old release', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    f.calls.length = 0;
    f.fail.backup = true;
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    expect(r.failedAt).toBe('backup');
    expect(f.calls).not.toContain('migrate:2.0.1');
    expect(f.calls.slice(-2)).toEqual(['start:web', 'start:worker']);
    expect(currentVersion(R)).toBe('2.0.0');
  });

  it('the new version never answers: current goes back to the previous release, agents rewritten and restarted', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    f.calls.length = 0;
    f.healthFor = (v) => v !== '2.0.1';
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    expect(r).toMatchObject({ status: 'rolled_back', failedAt: 'health', version: '2.0.1', previous: '2.0.0' });
    expect(currentVersion(R)).toBe('2.0.0');
    expect(f.calls).toEqual(['extract', 'db', 'env', 'stop:web', 'stop:worker', 'backup', 'migrate:2.0.1', 'render:2.0.1', 'start:web', 'start:worker', 'health:2.0.1', 'render:2.0.0', 'stop:web', 'stop:worker', 'start:web', 'start:worker', 'health:2.0.0']);
    expect(f.log.join('\n')).toMatch(/current points at 2\.0\.0 again; the database stays migrated \(additive\), the backup from before is command_center-20261120-1000\.dump/);
    expect(readState(R).current).toBe('2.0.0');
  });

  it('the same version again is up to date (no restart); --reinstall installs it again', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    f.calls.length = 0;
    expect((await installRelease(fakeDeps(f), { releasesDir: R, artifact: join(builds, '2.0.0') })).status).toBe('up_to_date');
    expect(f.calls).toEqual(['extract']);
    // ON-25: the hint names an option install.sh, ops:install and update --from all take
    expect(f.log.join('\n')).toContain('v2.0.0 is already the current release (run the same command with --reinstall to install it again)');
    expect((await installRelease(fakeDeps(f), { releasesDir: R, artifact: join(builds, '2.0.0'), reinstall: true })).status).toBe('installed');
  });

  it('keeps the newest three releases, never the current one', async () => {
    const f = fake();
    for (const v of ['2.0.0', '2.0.1', '2.0.2', '2.1.0']) await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild(v) });
    expect(installedVersions(R)).toEqual(['2.1.0', '2.0.2', '2.0.1']);
    expect(currentVersion(R)).toBe('2.1.0');
    // a rollback target stays the previous one, and prune never removes current even when it is old
    repoint(R, '2.0.1');
    const s = readState(R);
    s.current = '2.0.1';
    expect(prune(R, s, 1)).toEqual(['2.1.0', '2.0.2']);
    expect(installedVersions(R)).toEqual(['2.0.1']);
  });

  it('--dry prints the plan and changes nothing (no folder, no agents, no database writes)', async () => {
    const f = fake({ running: new Set(['web', 'worker']) });
    const r = await installRelease(fakeDeps(f), { releasesDir: R, fromDir: join(await makeBuild('2.0.0'), 'command-center-2.0.0'), dry: true });
    expect(r.status).toBe('planned');
    expect(existsSync(R)).toBe(false);
    expect(f.calls).toEqual(['db']); // the read-only probe (the real one runs with { dry: true }: no createdb)
    expect(f.log.join('\n')).toMatch(/would verify 3 files.*\n.*would install it as/);
  });
});

describe('installRelease: a 1.x Homebrew database moves into the bundled cluster (D-98)', () => {
  const moving = (f: Fake, ok: boolean) => ({
    ...fakeDeps(f),
    ensureDatabase: async () => (f.calls.push('db'), { ok: true, state: 'move', move: true, message: 'Your data is in Homebrew Postgres 17.' }),
    moveDatabase: async (dir: string) => (f.calls.push(`move:${dir.split('/').pop()}`), { ok }),
  });

  it('after the backup and before the new build migrates (its migrator checks the copy)', async () => {
    const f = fake({ running: new Set(['web', 'worker']) });
    const r = await installRelease(moving(f, true), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    expect(r.status).toBe('installed');
    expect(f.calls).toEqual(['extract', 'db', 'env', 'stop:web', 'stop:worker', 'backup', 'move:2.0.0', 'migrate:2.0.0', 'render:2.0.0', 'start:web', 'start:worker', 'health:2.0.0']);
  });

  it('a refused or failed move switches nothing: no migration, the old agents start again', async () => {
    const f = fake({ running: new Set(['web', 'worker']) });
    const r = await installRelease(moving(f, false), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'move' });
    expect(f.calls).toEqual(['extract', 'db', 'env', 'stop:web', 'stop:worker', 'backup', 'move:2.0.0', 'start:web', 'start:worker']);
    expect(currentVersion(R)).toBeNull();
    expect(f.log.join('\n')).toMatch(/did not work \(step: move\)\. Your data stays in Homebrew Postgres, untouched/);
  });

  it('--dry says it would move, and moves nothing', async () => {
    const f = fake();
    const r = await installRelease(moving(f, true), { releasesDir: R, fromDir: join(await makeBuild('2.0.0'), 'command-center-2.0.0'), dry: true });
    expect(r.status).toBe('planned');
    expect(f.calls.some((c) => c.startsWith('move'))).toBe(false);
    expect(f.log.join('\n')).toMatch(/would move the data from Homebrew Postgres/);
  });
});

describe('installRelease: the build version (SEC-12)', () => {
  /** A valid build whose manifest then claims `version` (the files still match: their hashes do not include it). */
  async function buildClaiming(version: string): Promise<string> {
    const art = await makeBuild('9.9.9');
    const file = join(art, 'command-center-9.9.9', 'manifest.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version }));
    return art;
  }

  it('only a plain version may become a folder name', () => {
    for (const v of ['2.0.1', 'v2.0.1', '2.0.0-beta.2', '2.0.0+build.7']) expect(isInstallableVersion(v)).toBe(true);
    for (const v of ['../../evil', '2.0.0+../../x', '2.0.0+a/b', 'current', '', '2.0', '2.0.0-..', null, 7]) expect(isInstallableVersion(v)).toBe(false);
  });

  it('a manifest version that is not plain semver is refused before anything is moved', async () => {
    const f = fake();
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await buildClaiming('2.0.0+../../../escape') });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'version' });
    expect(f.calls).toEqual(['extract']);
    expect(readdir(R)).toEqual([]); // the staging folder is gone, nothing outside releases/ was made
    expect(existsSync(join(tmp, 'escape'))).toBe(false);
    expect(f.log.join('\n')).toMatch(/not carry a plain version number/);
  });

  it('an older build than the one that runs is refused, plainly, unless --allow-downgrade', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    f.calls.length = 0;
    const old = await makeBuild('2.0.0');
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: old });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'downgrade', version: '2.0.0', previous: '2.0.1' });
    expect(f.calls).toEqual(['extract']); // no database, no agents stopped
    expect(currentVersion(R)).toBe('2.0.1');
    expect(installedVersions(R)).toEqual(['2.0.1']);
    const said = f.log.join('\n');
    expect(said).toMatch(/this build is v2\.0\.0 and you run v2\.0\.1, which is newer/);
    expect(said).toMatch(/Nothing changed: the build is older than the version you run.*--allow-downgrade/);

    const ok = await installRelease(fakeDeps(f), { releasesDir: R, artifact: old, allowDowngrade: true });
    expect(ok).toMatchObject({ status: 'installed', version: '2.0.0', previous: '2.0.1' });
    expect(currentVersion(R)).toBe('2.0.0');
    expect(f.log.join('\n')).toMatch(/installing v2\.0\.0 over the newer v2\.0\.1 \(--allow-downgrade\)/);
  });

  it('ON-26: the downgrade refusal offers ops:rollback only when state.json has an earlier release still installed', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    const lone = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('1.9.0') });
    expect(lone).toMatchObject({ failedAt: 'downgrade', rollbackTo: null });
    expect(f.log.at(-1)).not.toMatch(/ops:rollback/);
    expect(f.log.at(-1)).toMatch(/--allow-downgrade/);

    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.2') }); // history: 2.0.1 → 2.0.2
    f.log.length = 0;
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: join(builds, '1.9.0') });
    expect(r).toMatchObject({ failedAt: 'downgrade', rollbackTo: '2.0.1' });
    expect(f.log.at(-1)).toMatch(/ops:rollback/);
    expect(readFileSync(join(__dirname, '..', '..', 'scripts', 'ops', 'install.mjs'), 'utf8')).toContain("if (r.rollbackTo) say(`  back to the version you ran before");
  });

  it('ON-27: after a failed health check the rollback says "running" only when the previous release answers', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    f.healthFor = () => false; // neither the new nor the previous release answers
    f.log.length = 0;
    const r = await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    expect(r).toMatchObject({ status: 'rolled_back', failedAt: 'health', previousRunning: false });
    expect(f.calls.at(-1)).toBe('health:2.0.0');
    const last = f.log.at(-1)!;
    expect(last).not.toMatch(/back in place and running/);
    expect(last).toMatch(/The previous release \(v2\.0\.0\) is back in place, but it did not answer after the restart: .*run doctor says why/);

    f.healthFor = (v) => v === '2.0.0';
    const ok = await installRelease(fakeDeps(f), { releasesDir: R, artifact: join(builds, '2.0.1') });
    expect(ok).toMatchObject({ status: 'rolled_back', previousRunning: true });
    expect(f.log.at(-1)).toMatch(/The previous release is back in place and running\./);
  });

  it('a first install and an upgrade are not downgrades; a pre-release is older than its release', async () => {
    const f = fake();
    expect((await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') })).status).toBe('installed');
    expect((await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.1.0') })).status).toBe('installed');
    expect((await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.1.0-beta.1') })).failedAt).toBe('downgrade');
  });
});

describe('rollbackRelease', () => {
  it('goes back to the previous release, rewrites and restarts the agents, and names the pre-migration backup', async () => {
    const f = fake();
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    expect(rollbackTarget(R)).toBe('2.0.0');
    f.calls.length = 0;
    const r = await rollbackRelease(fakeDeps(f), { releasesDir: R });
    expect(r).toMatchObject({ status: 'rolled_back', from: '2.0.1', to: '2.0.0' });
    expect(currentVersion(R)).toBe('2.0.0');
    expect(f.calls).toEqual(['stop:web', 'stop:worker', 'render:2.0.0', 'start:web', 'start:worker', 'health:2.0.0']);
    expect(f.log.join('\n')).toMatch(/the backup taken before them is command_center-20261120-1000\.dump/);
  });

  it('with nothing to go back to it changes nothing; --dry only plans', async () => {
    const f = fake();
    expect((await rollbackRelease(fakeDeps(f), { releasesDir: R })).status).toBe('failed');
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.0') });
    await installRelease(fakeDeps(f), { releasesDir: R, artifact: await makeBuild('2.0.1') });
    f.calls.length = 0;
    expect((await rollbackRelease(fakeDeps(f), { releasesDir: R, dry: true })).status).toBe('planned');
    expect(f.calls).toEqual([]);
    expect(currentVersion(R)).toBe('2.0.1');
  });
});

function readdir(d: string): string[] {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
}
