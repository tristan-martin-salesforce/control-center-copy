/**
 * The release build refuses to ship without the bundled Postgres engine (@embedded-postgres/darwin-<arch>, an optional
 * dependency): a node_modules without it once built a 27.5 MB release with no database while the smoke passed. Fake
 * package trees: present, missing, incomplete, wrong version, and --allow-no-engine; and the smoke's read of an
 * unpacked release (engine there, labelled engine-less, or neither).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as _buildRaw from '../../scripts/release/build.mjs';
import * as _engineRaw from '../../scripts/release/lib/engine.mjs';

type Check = { ok: boolean; package: string; version: string | null; pinned: string | null; missing: string[]; reason: string | null };
type Gate = { ok: boolean; engineless: boolean; check: Check; message: string };
// plain .mjs: its inferred JS types are too narrow for tests
const { engineGate } = _buildRaw as unknown as { engineGate: (o: { root: string; arch?: string; pkg?: unknown; allowNoEngine?: boolean }) => Gate };
const { checkEngine, engineInRelease, NO_ENGINE_FILE, ENGINE_BINS } = _engineRaw as unknown as {
  checkEngine: (o: { root: string; arch?: string; pkg?: unknown }) => Check;
  engineInRelease: (root: string, arch: string) => { state: 'present' | 'labelled' | 'missing'; package: string; version: string | null; missing: string[] };
  NO_ENGINE_FILE: string;
  ENGINE_BINS: string[];
};

const PIN = '17.12.0-beta.19';
const ARCH = 'arm64';
const PKG_NAME = `@embedded-postgres/darwin-${ARCH}`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree({ installed = true, version = PIN, bins = ENGINE_BINS, pin = PIN as string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-engine-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0', optionalDependencies: pin ? { [PKG_NAME]: pin } : {} }));
  if (installed) {
    const dir = join(root, 'node_modules', PKG_NAME);
    mkdirSync(join(dir, 'native', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PKG_NAME, version }));
    for (const b of bins) writeFileSync(join(dir, 'native', 'bin', b), '#!bin\n');
  }
  return root;
}

describe('the release engine check', () => {
  it('passes with the pinned engine present and complete', () => {
    const c = checkEngine({ root: tree(), arch: ARCH });
    expect(c).toMatchObject({ ok: true, package: PKG_NAME, version: PIN, pinned: PIN, missing: [], reason: null });
    const g = engineGate({ root: tree(), arch: ARCH });
    expect(g).toMatchObject({ ok: true, engineless: false });
    expect(g.message).toContain(`${PKG_NAME} ${PIN}`);
  });

  it('refuses when the optional dependency is not installed, naming npm ci and --allow-no-engine', () => {
    const g = engineGate({ root: tree({ installed: false }), arch: ARCH });
    expect(g.ok).toBe(false);
    expect(g.message).toMatch(/^refusing to build: the bundled Postgres engine @embedded-postgres\/darwin-arm64 is not installed/);
    expect(g.message).toContain('npm ci');
    expect(g.message).toContain('--allow-no-engine');
  });

  it('refuses an incomplete engine and names the missing binaries', () => {
    const c = checkEngine({ root: tree({ bins: ['initdb'] }), arch: ARCH });
    expect(c.ok).toBe(false);
    expect(c.missing).toEqual(['native/bin/pg_ctl', 'native/bin/postgres']);
    expect(c.reason).toContain('incomplete');
  });

  it('refuses an empty binary (a half-written install)', () => {
    const root = tree();
    writeFileSync(join(root, 'node_modules', PKG_NAME, 'native', 'bin', 'postgres'), '');
    expect(checkEngine({ root, arch: ARCH }).missing).toEqual(['native/bin/postgres']);
  });

  it('refuses a version other than the pinned one', () => {
    const c = checkEngine({ root: tree({ version: '17.11.0-beta.1' }), arch: ARCH });
    expect(c.ok).toBe(false);
    expect(c.reason).toContain(`is 17.11.0-beta.1, but package.json pins ${PIN}`);
  });

  it('refuses an arch package.json does not pin', () => {
    const c = checkEngine({ root: tree({ pin: null }), arch: ARCH });
    expect(c.ok).toBe(false);
    expect(c.reason).toContain('pins no');
  });

  it('--allow-no-engine lets a deliberate engine-less build through, flagged engineless', () => {
    for (const root of [tree({ installed: false }), tree({ version: '1.0.0' })]) {
      const g = engineGate({ root, arch: ARCH, allowNoEngine: true });
      expect(g).toMatchObject({ ok: true, engineless: true });
      expect(g.message).toContain(NO_ENGINE_FILE);
    }
    // the flag never labels a build that has the engine
    expect(engineGate({ root: tree(), arch: ARCH, allowNoEngine: true }).engineless).toBe(false);
  });

  it('the real checkout pins the engine for both Mac arches', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    for (const a of ['arm64', 'x64']) expect(pkg.optionalDependencies[`@embedded-postgres/darwin-${a}`]).toBe(PIN);
  });
});

describe("the smoke's read of an unpacked release", () => {
  it('present: every binary there, with its version', () => {
    expect(engineInRelease(tree(), ARCH)).toMatchObject({ state: 'present', package: PKG_NAME, version: PIN });
  });

  it('labelled: no engine, but NO-ENGINE.txt at the root', () => {
    const root = tree({ installed: false });
    writeFileSync(join(root, NO_ENGINE_FILE), 'engine-less\n');
    expect(engineInRelease(root, ARCH).state).toBe('labelled');
  });

  it('missing: no engine and no label (the build that must never ship)', () => {
    const r = engineInRelease(tree({ bins: ['initdb', 'pg_ctl'] }), ARCH);
    expect(r).toMatchObject({ state: 'missing', missing: ['native/bin/postgres'] });
  });
});
