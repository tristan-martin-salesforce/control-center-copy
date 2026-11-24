/**
 * ON-21: the release build refuses a `node_modules` that is a symlink (a worktree's borrowed one balloons the traced
 * copy to 302 MB / 60k files), naming the fix. ON-2 (asked for by the walk, ON-13): the installer's lazy import of
 * db-agent.mjs resolves inside the unpacked tree it runs from, after the build is installed. Fake trees only.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _build from '../../scripts/release/build.mjs';
import * as _ir from '../../scripts/ops/lib/install-release.mjs';
import * as _rm from '../../scripts/ops/lib/release-manifest.mjs';

const { linkedNodeModules } = _build as any;
const { installRelease } = _ir as any;
const { buildManifest } = _rm as any;

let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), 'cc-build-link-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('ON-21: build:release refuses a symlinked node_modules', () => {
  it('a real folder, or none: no refusal', () => {
    const repo = join(tmp, 'main');
    mkdirSync(repo);
    expect(linkedNodeModules(repo)).toBeNull();
    mkdirSync(join(repo, 'node_modules'));
    expect(linkedNodeModules(repo)).toBeNull();
  });

  it('a worktree whose node_modules links to the main checkout: refused, naming the fix', () => {
    const main = join(tmp, 'main');
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    const wt = join(tmp, 'worktree');
    mkdirSync(wt);
    symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'));
    const why = linkedNodeModules(wt);
    expect(why).toMatch(/^refusing to build: .*node_modules is a symlink/);
    expect(why).toContain('Build from the main checkout');
  });
});

describe('ON-2: the installer still finds db-agent.mjs in the tree it runs from, after the install', () => {
  it("installRelease copies a --from-dir build, and ensure-db's lazy import resolves there at the database step", async () => {
    const repo = resolve(__dirname, '../..');
    const from = join(tmp, 'unpacked', 'command-center-2.0.1');
    mkdirSync(from, { recursive: true });
    // the installer's own tree, as install.sh unpacked it: the real scripts/ops (ensure-db.mjs imports ./db-agent.mjs lazily)
    cpSync(join(repo, 'scripts', 'ops'), join(from, 'scripts', 'ops'), { recursive: true });
    writeFileSync(join(from, 'server.js'), '// v2.0.1\n');
    writeFileSync(join(from, 'manifest.json'), JSON.stringify(await buildManifest({ root: from, version: '2.0.1', channel: 'stable', arch: 'arm64', node: '>=20 <26' })));
    const R = join(tmp, 'releases');
    let imported: string[] = [];
    const r = await installRelease(
      {
        say: () => {},
        nodeVersion: 'v22.11.0',
        arch: 'arm64',
        now: () => new Date('2026-11-21T10:00:00Z'),
        extract: async () => false,
        // what ensure-db.mjs's realBundledDeps does, from the installer's own folder (the one install.sh runs)
        ensureDatabase: async () => {
          const m = await import(pathToFileURL(join(from, 'scripts', 'ops', 'lib', 'db-agent.mjs')).href);
          imported = Object.keys(m);
          return { ok: true, message: 'database ready' };
        },
        ensureEnv: async () => true,
        agents: { running: () => [], stop: async () => true, start: async () => true, render: async () => true },
        backup: async () => ({ name: 'b.dump' }),
        migrate: async () => true,
        health: async () => true,
      },
      { releasesDir: R, fromDir: from },
    );
    expect(r.status).toBe('installed');
    expect(imported).toContain('realPrepare');
    // both trees hold it: the one that runs now and the installed release
    for (const root of [from, join(R, '2.0.1')]) expect(existsSync(join(root, 'scripts', 'ops', 'lib', 'db-agent.mjs')), root).toBe(true);
  });
});
