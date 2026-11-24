/** D-90: `npm run update -- --from <build.tgz | Drive folder id>` and `npm run update` inside a compiled release. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _m6360Raw from '../../scripts/ops/lib/update-from.mjs';
// plain .mjs: its inferred JS types are too narrow for tests
const _m6360: any = _m6360Raw;
const { claudeUpdatePrompt, expectedSha, runFromBuild } = _m6360;
import { sha256File } from '../../scripts/ops/lib/release-manifest.mjs';

let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), 'cc-upd-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = () => ({ CC_STATE_DIR: join(tmp, 'state'), HOME: tmp });

describe('update --from', () => {
  it('inside a compiled release without --from: says how to update, changes nothing', async () => {
    const log: string[] = [];
    expect(await runFromBuild({ from: null, say: (m: string) => log.push(m), env: env() })).toBe(1);
    expect(log.join('\n')).toContain('run update -- --from <command-center-X.Y.Z-ARCH.tgz>');
  });

  it('a Drive folder id prints the Claude Code prompt (the app reads text, not builds)', async () => {
    const log: string[] = [];
    const out: string[] = [];
    const orig = console.log;
    console.log = (m: string) => out.push(m);
    try {
      expect(await runFromBuild({ from: '1AbCdEfGhIjKlMnOpQ', say: (m: string) => log.push(m), env: env() })).toBe(2);
    } finally {
      console.log = orig;
    }
    expect(out.join('\n')).toContain('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ');
    expect(claudeUpdatePrompt('1AbCdEfGhIjKlMnOpQ', '2.1.0')).toMatch(/check the \.tgz sha256 .* run update -- --from/);
  });

  it('takes the expected sha256 from the feed next to the file, and the installer refuses a mismatch', async () => {
    const file = join(tmp, 'command-center-2.1.0-arm64.tgz');
    writeFileSync(file, 'build bytes');
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ schema: 1, name: 'command-center', releases: [{ version: '2.1.0', channel: 'stable', artifact: 'command-center-2.1.0-arm64.tgz', sha256: 'd'.repeat(64) }] }));
    expect(expectedSha(file, env())).toEqual({ sha256: 'd'.repeat(64), source: join(tmp, 'manifest.json') });
    const calls: string[] = [];
    const deps = { say: () => {}, releasesDir: join(tmp, 'releases'), nodeVersion: 'v22.0.0', now: () => new Date(), extract: async () => (calls.push('extract'), false) };
    expect(await runFromBuild({ from: file, say: () => {}, env: env(), deps })).toBe(1);
    expect(calls).toEqual([]); // refused before unpacking
    // the right sha passes the check (then this fake can't unpack it)
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ schema: 1, name: 'command-center', releases: [{ version: '2.1.0', channel: 'stable', artifact: 'command-center-2.1.0-arm64.tgz', sha256: await sha256File(file) }] }));
    expect(await runFromBuild({ from: file, say: () => {}, env: env(), deps })).toBe(1);
    expect(calls).toEqual(['extract']);
  });

  it('SEC-3: a build no feed lists is refused before it is unpacked, unless --unverified', async () => {
    const file = join(tmp, 'command-center-2.1.0-arm64.tgz');
    writeFileSync(file, 'build bytes');
    const calls: string[] = [];
    const log: string[] = [];
    const deps = { say: () => {}, releasesDir: join(tmp, 'releases'), nodeVersion: 'v22.0.0', now: () => new Date(), extract: async () => (calls.push('extract'), false) };
    expect(await runFromBuild({ from: file, say: (m: string) => log.push(m), env: env(), deps })).toBe(1);
    expect(calls).toEqual([]);
    expect(log.join('\n')).toMatch(/no manifest\.json next to .*\. Download manifest\.json .*Nothing changed/);
    // a feed that does not list this file is no feed for it
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ schema: 1, name: 'command-center', releases: [{ version: '2.0.0', channel: 'stable', artifact: 'command-center-2.0.0-arm64.tgz', sha256: 'e'.repeat(64) }] }));
    expect(await runFromBuild({ from: file, say: () => {}, env: env(), deps })).toBe(1);
    expect(calls).toEqual([]);
    // your own build: --unverified goes on to unpack it (this fake can't)
    expect(await runFromBuild({ from: file, argv: ['--unverified'], say: () => {}, env: env(), deps })).toBe(1);
    expect(calls).toEqual(['extract']);
  });
});
