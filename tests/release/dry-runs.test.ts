/**
 * D-90: the dry paths print their plans and change nothing: `npm run release -- patch --dry --publish` (no bump, no
 * commit, no tag, no build, nothing staged) and `node scripts/ops/install.mjs --dry` (no releases folder, no agents).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

let tmp: string;
beforeAll(() => void (tmp = mkdtempSync(join(tmpdir(), 'cc-dry-'))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('dry runs', () => {
  it('release patch --dry --publish prints the publish plan and changes nothing', () => {
    const before = { status: git(['status', '--porcelain']), head: git(['rev-parse', 'HEAD']), tags: git(['tag', '--list']), pkg: readFileSync(join(ROOT, 'package.json'), 'utf8'), releases: existsSync(join(ROOT, 'dist', 'releases')) };
    const env = { ...process.env, CC_STATE_DIR: join(tmp, 'state'), CC_TEAM_CONFIG: join(tmp, 'none.json'), CC_DISTRIBUTION_FOLDER_ID: '1AbCdEfGhIjKlMnOpQ', CC_DISTRIBUTION_CHANNEL: 'C0123456789' };
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), 'patch', '--dry', '--publish'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/\[release\] \d+\.\d+\.\d+ → \d+\.\d+\.\d+ \(patch\)/);
    expect(out).toContain('dry run: nothing is built, written, staged, uploaded or posted');
    expect(out).toContain('npm run scan:private');
    expect(out).toMatch(/npm run build:release -- --channel stable {3}→ dist\/command-center-\d+\.\d+\.\d+-\w+\.tgz/);
    expect(out).toContain('release.drive_upload (a handoff');
    expect(out).toContain('folder: https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ');
    expect(out).toContain('release.announce (a Slack draft, dry run on) to C0123456789');
    expect(git(['status', '--porcelain'])).toBe(before.status);
    expect(git(['rev-parse', 'HEAD'])).toBe(before.head);
    expect(git(['tag', '--list'])).toBe(before.tags);
    expect(readFileSync(join(ROOT, 'package.json'), 'utf8')).toBe(before.pkg);
    expect(existsSync(join(ROOT, 'dist', 'releases'))).toBe(before.releases);
  }, 120_000);

  it('install.mjs --dry prints the install plan and creates nothing', () => {
    const state = join(tmp, 'state2');
    const env = { ...process.env, CC_STATE_DIR: state, CC_LAUNCH_AGENTS_DIR: join(tmp, 'agents'), CC_LOG_DIR: join(tmp, 'logs') };
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'ops', 'install.mjs'), '--dry'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/no build given: the plan for installing v\d+\.\d+\.\d+ \(this checkout\)/);
    expect(r.stdout).toContain('would make sure the env file exists');
    expect(r.stdout).toMatch(/would stop the LaunchAgents, back up the database, migrate with v[\d.]+'s migrator, point current at/);
    expect(r.stdout).toContain('dry run: nothing changed');
    expect(existsSync(state)).toBe(false);
    expect(existsSync(join(tmp, 'agents'))).toBe(false);
  }, 60_000);
});
