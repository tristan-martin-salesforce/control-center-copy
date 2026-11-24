/**
 * The first-install walk's fixes the onboarding salvage kept (20-onboarding-dry-run.md, "Gaps"), each pinned: the
 * feed next to a download (`feedShaFor`, "manifest (1).json"), the pasteable npm commands (`npmRun` in doctor,
 * `npmInCurrent` in the scripts), the other-chip refusal, a handed-in build copied not moved (ON-2), a first run with
 * no user yet counting as up (ON-3), and a repeat install starting stopped agents (ON-7). Fakes and temp folders only:
 * no launchd, tar, Postgres or network.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as _ir from '../../scripts/ops/lib/install-release.mjs';
import * as _rm from '../../scripts/ops/lib/release-manifest.mjs';
import * as _paths from '../../scripts/ops/lib/paths.mjs';
import * as _wiring from '../../scripts/ops/lib/release-wiring.mjs';
import { npmRun } from '../../src/ops/checks/types';

// plain .mjs: their inferred JS types are too narrow for tests
const { currentVersion, installRelease, repoint, startStopped, writeState } = _ir as any;
const { buildManifest, emptyFeed, FEED_FILE_RE, feedFilesIn, feedShaFor } = _rm as any;
const { npmInCurrent } = _paths as any;
const { firstRunAnswers, waitForVersion } = _wiring as any;

let tmp: string;
let R: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-kept-'));
  R = join(tmp, 'releases');
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

const HEX = (c: string) => c.repeat(64);
const feed = (rows: Array<{ artifact: string; sha256: string }>) =>
  JSON.stringify({ ...emptyFeed(new Date('2026-11-21T00:00:00Z')), releases: rows.map((r) => ({ version: '2.0.1', channel: 'stable', arch: 'arm64', bytes: 1, notes: '', published_at: '2026-11-21T00:00:00Z', ...r })) });

describe('feedShaFor: the release feed next to a download', () => {
  it('finds manifest.json and the names a second download gets, plain names first', () => {
    for (const n of ['manifest.json', 'manifest (1).json', 'manifest (12).json', 'releases-manifest.json']) expect(FEED_FILE_RE.test(n)).toBe(true);
    for (const n of ['manifest.json.tmp', 'my manifest.json', 'manifest(1).json']) expect(FEED_FILE_RE.test(n)).toBe(false);
    for (const n of ['manifest (2).json', 'manifest (10).json', 'manifest.json', 'releases-manifest.json']) writeFileSync(join(tmp, n), '{}');
    expect(feedFilesIn(tmp).map((f: string) => f.slice(tmp.length + 1))).toEqual(['manifest.json', 'releases-manifest.json', 'manifest (2).json', 'manifest (10).json']);
  });

  it('no feed at all, a feed that does not list the build, and one that does', () => {
    const art = join(tmp, 'command-center-2.0.1-arm64.tgz');
    writeFileSync(art, 'x');
    expect(feedShaFor(art)).toEqual({ found: null, feeds: 0 });
    writeFileSync(join(tmp, 'manifest.json'), feed([{ artifact: 'command-center-2.0.0-arm64.tgz', sha256: HEX('a') }]));
    expect(feedShaFor(art)).toEqual({ found: null, feeds: 1 });
    writeFileSync(join(tmp, 'manifest (1).json'), feed([{ artifact: 'command-center-2.0.1-arm64.tgz', sha256: HEX('b') }]));
    expect(feedShaFor(art)).toEqual({ found: { sha256: HEX('b'), source: join(tmp, 'manifest (1).json') }, feeds: 2 });
  });

  it('two feeds list the build: the row whose sha matches the file wins (an older feed beside a newer one)', () => {
    const art = join(tmp, 'command-center-2.0.1-arm64.tgz');
    writeFileSync(art, 'x');
    writeFileSync(join(tmp, 'manifest.json'), feed([{ artifact: 'command-center-2.0.1-arm64.tgz', sha256: HEX('a') }]));
    writeFileSync(join(tmp, 'manifest (1).json'), feed([{ artifact: 'command-center-2.0.1-arm64.tgz', sha256: HEX('c') }]));
    expect(feedShaFor(art, { hash: () => HEX('c') }).found.source).toBe(join(tmp, 'manifest (1).json'));
    expect(feedShaFor(art, { hash: () => HEX('f') }).found.source).toBe(join(tmp, 'manifest.json')); // none match: the first, so the install names the mismatch
  });
});

describe('pasteable npm commands (ON-11)', () => {
  const env = () => ({ HOME: tmp, CC_STATE_DIR: join(tmp, 'Library', 'Application Support', 'command-center') });

  it('scripts: npmInCurrent names releases/current home-relative and quoted', () => {
    expect(npmInCurrent('doctor', env())).toBe('npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run doctor');
    expect(npmInCurrent('doctor', { CC_STATE_DIR: '/opt/cc' })).toBe('npm --prefix "/opt/cc/releases/current" run doctor');
  });

  it('doctor: npmRun is the plain command in a checkout and the same --prefix form in a compiled release', () => {
    const repoRoot = join(tmp, 'repo');
    mkdirSync(repoRoot);
    expect(npmRun({ repoRoot, env: env() }, 'ops:install')).toBe('npm run ops:install');
    writeFileSync(join(repoRoot, 'manifest.json'), '{}');
    expect(npmRun({ repoRoot, env: env() }, 'ops:install')).toBe(npmInCurrent('ops:install', env()));
  });
});

// ------------------------------------------------------------------------------------------- installRelease fakes

async function makeBuild(version: string, arch = 'arm64'): Promise<string> {
  const root = join(tmp, 'builds', `${version}-${arch}`, `command-center-${version}`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'server.js'), `// v${version}\n`);
  writeFileSync(join(root, 'scripts', 'install.mjs'), '// the installer that runs from this folder\n');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(await buildManifest({ root, version, channel: 'stable', arch, node: '>=20 <26' })));
  return root;
}

function deps(o: { arch?: string; running?: string[]; health?: boolean; render?: boolean } = {}) {
  const log: string[] = [];
  const calls: string[] = [];
  const running = new Set(o.running ?? []);
  return {
    log,
    calls,
    d: {
      say: (m: string) => log.push(m),
      nodeVersion: 'v22.11.0',
      arch: o.arch ?? 'arm64',
      now: () => new Date('2026-11-21T10:00:00Z'),
      extract: async (art: string, into: string) => (cpSync(art, into, { recursive: true }), true),
      ensureDatabase: async () => ({ ok: true, message: 'database ready' }),
      ensureEnv: async () => true,
      agents: {
        running: () => [...running],
        stop: async (k: string) => (calls.push(`stop:${k}`), running.delete(k), true),
        start: async (k: string) => (calls.push(`start:${k}`), running.add(k), true),
        render: async () => (calls.push('render'), o.render ?? true),
      },
      backup: async () => ({ name: 'b.dump' }),
      migrate: async () => true,
      health: async (v: string) => (calls.push(`health:${v}`), o.health ?? true),
    },
  };
}

describe('installRelease: kept walk fixes', () => {
  it('a build for the other chip is refused before anything is moved, naming the right download', async () => {
    const f = deps({ arch: 'x64' });
    const r = await installRelease(f.d, { releasesDir: R, fromDir: await makeBuild('2.0.1', 'arm64') });
    expect(r).toMatchObject({ status: 'failed', failedAt: 'arch', version: '2.0.1' });
    const said = f.log.join('\n');
    expect(said).toContain('this build is for Apple silicon Macs and this Mac has Intel: download command-center-2.0.1-x64.tgz from the same folder');
    expect(said).toContain('Nothing changed: the build is for the other kind of Mac');
    expect(existsSync(join(R, '2.0.1'))).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("ON-2: a handed-in unpacked build is copied, so the installer's own folder stays where Node looks", async () => {
    const f = deps();
    const from = await makeBuild('2.0.1');
    const r = await installRelease(f.d, { releasesDir: R, fromDir: from });
    expect(r.status).toBe('installed');
    expect(existsSync(join(from, 'scripts', 'install.mjs'))).toBe(true); // still there
    expect(statSync(join(R, '2.0.1', 'server.js')).isFile()).toBe(true);
    expect(currentVersion(R)).toBe('2.0.1');
  });

  it('ON-7: up to date only when state.json and current agree; a current that never finished installs again', async () => {
    const f = deps();
    const from = await makeBuild('2.0.1');
    await installRelease(f.d, { releasesDir: R, fromDir: from });
    expect((await installRelease(f.d, { releasesDir: R, fromDir: from })).status).toBe('up_to_date');
    // a first install that failed after the switch: current points at 2.0.1, state.json records nothing
    writeState(R, { current: null, history: [] });
    repoint(R, '2.0.1');
    expect((await installRelease(f.d, { releasesDir: R, fromDir: from })).status).toBe('installed');
  });
});

describe('startStopped: a repeat install starts what is stopped (ON-7)', () => {
  it('both running: nothing to do', async () => {
    const f = deps({ running: ['web', 'worker'] });
    expect(await startStopped(f.d, '2.0.1')).toEqual({ status: 'running', started: [] });
    expect(f.calls).toEqual([]);
  });

  it('the worker stopped: rewrites the agents, starts only it, waits for the version', async () => {
    const f = deps({ running: ['web'] });
    expect(await startStopped(f.d, '2.0.1')).toEqual({ status: 'started', started: ['worker'] });
    expect(f.calls).toEqual(['render', 'start:worker', 'health:2.0.1']);
    expect(f.log).toEqual(['starting worker (installed, not running)', 'v2.0.1 is running']);
  });

  it('the agents cannot be written, or the version never answers: failed, with the step', async () => {
    expect(await startStopped(deps({ render: false }).d, '2.0.1')).toMatchObject({ status: 'failed', failedAt: 'agents' });
    expect(await startStopped(deps({ health: false }).d, '2.0.1')).toMatchObject({ status: 'failed', failedAt: 'health', started: ['web', 'worker'] });
  });
});

describe('ON-3: a first install has no user yet, and that counts as up', () => {
  const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

  it('firstRunAnswers: only "no_user" from Getting started counts', async () => {
    expect(await firstRunAnswers(4399, async () => answer(200, { reason: 'no_user' }))).toBe(true);
    expect(await firstRunAnswers(4399, async () => answer(200, { reason: 'ready' }))).toBe(false);
    expect(await firstRunAnswers(4399, async () => answer(500, {}))).toBe(false);
    expect(await firstRunAnswers(4399, async () => Promise.reject(new Error('ECONNREFUSED')))).toBe(false);
  });

  it('waitForVersion: /version 500 plus onboarding "no_user" is the new release up', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => (seen.push(url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')), url.endsWith('/version') ? answer(500, {}) : answer(200, { reason: 'no_user' })));
    expect(await waitForVersion('2.0.1', { port: 4399, timeoutMs: 1000, everyMs: 1 })).toBe(true);
    expect(seen).toEqual(['/api/v1/version', '/api/v1/onboarding']);
  });

  it('waitForVersion: a 500 with a user (not a first run) is not up', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/version') ? answer(500, {}) : answer(200, { reason: 'ready' })));
    expect(await waitForVersion('2.0.1', { port: 4399, timeoutMs: 30, everyMs: 5 })).toBe(false);
  });
});
