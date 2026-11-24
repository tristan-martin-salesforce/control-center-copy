/** D-90 / PKG-2: the artifact manifest (sha256 + size per file), its verification, and the release feed. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _m7716Raw from '../../scripts/ops/lib/release-manifest.mjs';
// plain .mjs: its inferred JS types are too narrow for tests
const _m7716: any = _m7716Raw;
const {
  artifactName,
  assertSha256,
  buildManifest,
  compareVersions,
  emptyFeed,
  feedEntry,
  latestFor,
  listFiles,
  parseFeed,
  updateFor,
  upsertFeed,
  verifyTree,
} = _m7716;
import { compareVersions as compareTs, compareWithFeed, parseReleaseFeed, verifyArtifact } from '../../src/ops/release';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-manifest-'));
  mkdirSync(join(dir, 'dist', 'worker'), { recursive: true });
  writeFileSync(join(dir, 'server.js'), 'console.log(1)\n');
  writeFileSync(join(dir, 'dist', 'worker', 'index.mjs'), 'export {}\n');
  writeFileSync(join(dir, 'package.json'), '{"version":"2.0.0"}\n');
  symlinkSync('server.js', join(dir, 'alias.js'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('artifact manifest', () => {
  it('hashes every file (sorted, / separated), records the build identity and leaves itself out', async () => {
    writeFileSync(join(dir, 'manifest.json'), '{}');
    const m = await buildManifest({ root: dir, version: '2.0.0', sha: 'abc1234', channel: 'stable', arch: 'arm64', builtAt: '2026-11-20T10:00:00.000Z', migrationHead: '0032_x' });
    expect(Object.keys(m.files)).toEqual(['alias.js', 'dist/worker/index.mjs', 'package.json', 'server.js']);
    expect(m.files['server.js']).toEqual({ sha256: sha('console.log(1)\n'), size: 15 });
    expect(m).toMatchObject({ schema: 1, name: 'command-center', version: '2.0.0', sha: 'abc1234', channel: 'stable', arch: 'arm64', node: '>=20 <26', built_at: '2026-11-20T10:00:00.000Z', migration_head: '0032_x' });
    expect(listFiles(dir)).not.toContain('manifest.json');
  });

  it('verifies a matching tree, and names missing and changed files (same size too, when deep)', async () => {
    const m = await buildManifest({ root: dir, version: '2.0.0' });
    expect((await verifyTree(dir, m)).ok).toBe(true);
    writeFileSync(join(dir, 'server.js'), 'console.log(2)\n'); // same size, other bytes
    rmSync(join(dir, 'package.json'));
    const v = await verifyTree(dir, m);
    expect(v).toMatchObject({ ok: false, missing: ['package.json'], changed: ['server.js'] });
    // sizes only: the same-size edit passes unless the file is sampled
    expect((await verifyTree(dir, m, { deep: false })).changed).toEqual([]);
    expect((await verifyTree(dir, m, { deep: false, sample: ['server.js'] })).changed).toEqual(['server.js']);
  });

  it('a file added after the build (a runtime cache) is not a mismatch; a swapped symlink is', async () => {
    const m = await buildManifest({ root: dir, version: '2.0.0' });
    writeFileSync(join(dir, 'cache.bin'), 'x');
    expect((await verifyTree(dir, m)).ok).toBe(true);
    rmSync(join(dir, 'alias.js'));
    symlinkSync('package.json', join(dir, 'alias.js'));
    expect((await verifyTree(dir, m)).changed).toEqual(['alias.js']);
  });

  it('checks an artifact sha256 before anything is unpacked', async () => {
    const f = join(dir, 'a.tgz');
    writeFileSync(f, 'build');
    await expect(assertSha256(f, sha('build'))).resolves.toBe(sha('build'));
    await expect(assertSha256(f, sha('other'))).rejects.toThrow(/does not match the release feed/);
    await expect(assertSha256(f, 'nope')).rejects.toThrow(/no expected sha256/);
    expect(await verifyArtifact(f, { sha256: sha('build') })).toEqual({ ok: true, got: sha('build') });
    expect(artifactName('2.0.0', 'arm64')).toBe('command-center-2.0.0-arm64.tgz');
  });
});

describe('versions and the feed', () => {
  it('orders by semver, pre-releases before their release, in both twins', () => {
    const order = ['1.3.0', '1.10.0', '2.0.0-beta.1', '2.0.0-beta.2', '2.0.0-beta.10', '2.0.0', '2.0.1'];
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareVersions(order[i], order[i + 1]), `${order[i]} < ${order[i + 1]}`).toBe(-1);
      expect(compareTs(order[i]!, order[i + 1]!)).toBe(-1);
      expect(compareVersions(order[i + 1], order[i])).toBe(1);
    }
    expect(compareVersions('v2.0.0', '2.0.0+abc')).toBe(0);
  });

  it('writes a feed row per artifact, replaces a re-published version, keeps newest first', () => {
    const m = { version: '2.0.0', channel: 'stable', arch: 'arm64', node: '>=20 <26', sha: 'abc1234', migration_head: '0032_x' };
    let feed = upsertFeed(emptyFeed(), feedEntry({ manifest: m, artifact: 'command-center-2.0.0-arm64.tgz', sha256: sha('a'), bytes: 10, notes: '### Added\n- x' }));
    feed = upsertFeed(feed, feedEntry({ manifest: { ...m, version: '2.1.0-beta.1', channel: 'beta' }, artifact: 'command-center-2.1.0-beta.1-arm64.tgz', sha256: sha('b'), bytes: 11 }));
    feed = upsertFeed(feed, feedEntry({ manifest: m, artifact: 'command-center-2.0.0-arm64.tgz', sha256: sha('c'), bytes: 12 }));
    expect(feed.releases.map((r: { version: string }) => r.version)).toEqual(['2.1.0-beta.1', '2.0.0']);
    expect(feed.releases[1].sha256).toBe(sha('c'));
    expect(() => feedEntry({ manifest: m, artifact: 'x', sha256: 'short', bytes: 1 })).toThrow();

    // stable sees stable only; beta sees both
    expect(latestFor(feed, 'stable')?.version).toBe('2.0.0');
    expect(latestFor(feed, 'beta')?.version).toBe('2.1.0-beta.1');
    expect(updateFor(feed, '1.3.0', 'stable')).toMatchObject({ available: true });
    expect(updateFor(feed, '2.0.0', 'stable')).toMatchObject({ available: false });
    expect(updateFor(feed, '2.0.0', 'dev')).toMatchObject({ available: false });
    expect(updateFor(feed, '2.0.0', 'beta')).toMatchObject({ available: true });

    // the app's twin reads the same text the same way (a tool's header lines around it are cut off)
    const text = `File: manifest.json\n\n${JSON.stringify(feed)}\n`;
    expect(parseFeed(text).releases).toHaveLength(2);
    const ts = parseReleaseFeed(text);
    expect(compareWithFeed(ts, '1.3.0', 'stable')).toMatchObject({ available: true, latest: { version: '2.0.0' } });
    expect(compareWithFeed(ts, '2.0.0', 'beta').latest?.version).toBe('2.1.0-beta.1');
    expect(compareWithFeed(ts, '2.0.0', 'stable', 'x64').latest).toBeNull();
  });

  it('refuses text that is not a feed, and drops rows without a valid sha256', () => {
    expect(() => parseFeed('hello')).toThrow(/no JSON/);
    expect(() => parseFeed('{"schema":2}')).toThrow(/not a Command Center release feed/);
    expect(() => parseReleaseFeed('{"name":"x"}')).toThrow();
    const f = { schema: 1, name: 'command-center', releases: [{ version: '2.0.0', channel: 'stable', artifact: 'a', sha256: 'zz' }, { version: '2.0.1', channel: 'stable', artifact: 'b', sha256: sha('b') }] };
    expect(parseFeed(JSON.stringify(f)).releases.map((r: { version: string }) => r.version)).toEqual(['2.0.1']);
    expect(parseReleaseFeed(JSON.stringify(f)).releases.map((r) => r.version)).toEqual(['2.0.1']);
  });
});
