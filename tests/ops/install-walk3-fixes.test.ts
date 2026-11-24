/**
 * Walk 3 (ON-31, ON-32): install.mjs refuses unknown options and valued options with no value (before it touches
 * anything), offers ops:rollback only when there is an earlier release, and a missing --from-dir says so.
 * Temp folders only; the spawned install.mjs exits during option parsing.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _ir from '../../scripts/ops/lib/install-release.mjs';

const { installRelease } = _ir as any;
const INSTALL = join(__dirname, '..', '..', 'scripts', 'ops', 'install.mjs');

let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), 'cc-walk3-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run = (...args: string[]) => {
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, CC_STATE_DIR: join(home, 'state'), CC_LAUNCHCTL: '/usr/bin/false' } as unknown as NodeJS.ProcessEnv, timeout: 20_000 });
};

describe('ON-32: install.mjs refuses what it does not know', () => {
  it('an unknown option: one line, exit 1', () => {
    const r = run('--definitely-not-a-flag');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown option --definitely-not-a-flag (the options are');
    expect(r.stdout).not.toContain('starting');
  });
  it('a typo of --reinstall is refused', () => {
    expect(run('x.tgz', '--reinstal').stderr).toContain('unknown option --reinstal');
  });
  it('a valued option with no value: one line, exit 1', () => {
    const r = run('--keep');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--keep needs a value');
    expect(run('--from-dir', '--yes').stderr).toContain('--from-dir needs a value');
  });
});

describe('ON-32: a missing --from-dir is a wrong path, not a damaged download', () => {
  it('says there is no folder', async () => {
    const said: string[] = [];
    const missing = join(tmp, 'nope');
    const r = await installRelease({ say: (m: string) => said.push(m) }, { releasesDir: join(tmp, 'releases'), fromDir: missing });
    expect(r.status).toBe('failed');
    const text = said.join('\n');
    expect(text).toContain(`there is no folder ${missing}`);
    expect(text).not.toContain('damaged or edited');
  });
});

describe('ON-31: the rollback hint needs an earlier release', () => {
  it('is gated on a different previous version and rollbackTarget', () => {
    const src = readFileSync(INSTALL, 'utf8');
    expect(src).toMatch(/r\.previous !== r\.version && rollbackTarget\(deps\.releasesDir\)/);
    expect(src).toMatch(/canRollBack \? ` \(was v\$\{r\.previous\}; \$\{npmInCurrent\('ops:rollback'\)\} goes back\)`/);
  });
});
