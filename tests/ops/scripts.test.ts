import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv, secretValues } from '../../scripts/ops/lib/envfile.mjs';
import { RotatingLog } from '../../scripts/ops/lib/logrotate.mjs';
import { backoffDelay, waitForPostgres } from '../../scripts/ops/lib/pgwait.mjs';
import { buildVars, renderAgent, renderTemplate, xmlEscape } from '../../scripts/ops/lib/plist.mjs';
import { dirs, ensureState, parseHours, validateProfile } from '../../scripts/ops/setup.mjs';

const repoRoot = resolve(__dirname, '..', '..');
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-scripts-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = { repo: '/Users/me/Projects/command-center', home: '/Users/me', node: '/opt/homebrew/bin/node', npm: '/opt/homebrew/bin/npm', logDir: '/Users/me/Library/Logs/command-center', stateDir: '/Users/me/Library/Application Support/command-center', envFile: '/Users/me/Library/Application Support/command-center/env', templateDir: join(repoRoot, 'ops', 'launchd') };

describe('launchd plists', () => {
  for (const kind of ['web', 'worker'] as const) {
    it(`${kind}: renders, has the keep-alive keys, and passes plutil -lint`, () => {
      const xml = renderAgent({ kind, ...base });
      expect(xml).toContain(`<string>com.commandcenter.${kind}</string>`);
      for (const k of ['KeepAlive', 'RunAtLoad', 'ThrottleInterval', 'WorkingDirectory', 'StandardOutPath', 'ExitTimeOut']) expect(xml).toContain(`<key>${k}</key>`);
      expect(xml).toContain('<string>/Users/me/Projects/command-center</string>');
      expect(xml).toContain('Library/Logs/command-center');
      expect(xml).not.toMatch(/\{\{|\}\}/);
      const f = join(dir, `${kind}.plist`);
      writeFileSync(f, xml);
      if (process.platform === 'darwin') expect(() => execFileSync('/usr/bin/plutil', ['-lint', f], { stdio: 'pipe' })).not.toThrow();
    });
  }
  it('web runs production next start on 4327; worker runs npm run worker:start (no file watch); env file is an argument, not inlined', () => {
    const web = renderAgent({ kind: 'web', ...base });
    expect(web).toContain('/Users/me/Projects/command-center/node_modules/.bin/next');
    expect(web).toContain('<string>start</string>');
    expect(web).toContain('<string>4327</string>');
    // PKG-1: loopback only (next start's default host is 0.0.0.0, every interface)
    expect(web).toMatch(/<string>start<\/string>\s*<string>-H<\/string>\s*<string>127\.0\.0\.1<\/string>/);
    const worker = renderAgent({ kind: 'worker', ...base });
    // Not `npm run worker` (tsx watch): every merge into the checkout would restart the live worker mid-job (OPS-1).
    expect(worker).toMatch(/<string>run<\/string>\s*<string>worker:start<\/string>/);
    expect(worker).toContain('--env-file');
  });
  it('escapes XML and fails loudly on a missing placeholder', () => {
    expect(xmlEscape('a&b<c>"')).toBe('a&amp;b&lt;c&gt;&quot;');
    expect(buildVars({ kind: 'web', ...base, repo: '/a&b' }).REPO).toBe('/a&amp;b');
    expect(() => renderTemplate('{{NOPE}}', {})).toThrow(/NOPE/);
  });
});

describe('log rotation', () => {
  it('rotates by size, keeps N files, and scrubs secrets', () => {
    const f = join(dir, 'app.log');
    const log = new RotatingLog(f, { maxBytes: 100, keep: 3, scrub: ['hunter2-secret'] });
    for (let i = 0; i < 30; i++) log.write(`line ${i} aaaaaaaaaaaaaaaaaaaa hunter2-secret\n`);
    log.close();
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['app.log', 'app.log.1', 'app.log.2', 'app.log.3']);
    for (const n of files) expect(statSync(join(dir, n)).size).toBeLessThanOrEqual(140);
    expect(files.map((n) => readFileSync(join(dir, n), 'utf8')).join('')).not.toContain('hunter2-secret');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe('waiting for Postgres', () => {
  it('backs off exponentially to a cap', () => {
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 8000, 30000]);
  });
  it('retries until ready, with backoff sleeps, and stops on abort', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const ok = await waitForPostgres({ check: async () => ++calls >= 4, sleep: async (ms: number) => void sleeps.push(ms) });
    expect(ok).toBe(true);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    const ac = new AbortController();
    ac.abort();
    expect(await waitForPostgres({ check: async () => false, signal: ac.signal })).toBe(false);
  });
});

describe('env file + setup helpers', () => {
  it('parses env files and picks out secret-looking values for scrubbing only', () => {
    const e = parseEnv('# c\nDATABASE_URL=postgresql://localhost/x\nexport API_TOKEN="abcdefghij"\nBAD LINE\n');
    expect(e).toEqual({ DATABASE_URL: 'postgresql://localhost/x', API_TOKEN: 'abcdefghij' });
    expect(secretValues(e)).toEqual(['abcdefghij']);
  });
  it('ensureState is idempotent, creates 700 dirs and a 600 env template, and never overwrites', () => {
    const d = dirs({ CC_STATE_DIR: join(dir, 'state'), CC_LOG_DIR: join(dir, 'logs') } as never, dir);
    expect(ensureState(d).length).toBe(4);
    expect(statSync(d.state).mode & 0o777).toBe(0o700);
    expect(statSync(d.envFile).mode & 0o777).toBe(0o600);
    writeFileSync(d.envFile, 'KEEP=me\n');
    expect(ensureState(d)).toEqual([]);
    expect(readFileSync(d.envFile, 'utf8')).toBe('KEEP=me\n');
  });
  it('validates the profile and hours', () => {
    expect(parseHours('9:00-18:30')).toEqual({ start: '09:00', end: '18:30' });
    expect(parseHours('nope')).toBeNull();
    const ok = { name: 'Ada', role_pack: 'se_ic', working_hours: { start: '09:00', end: '18:00' }, slack_user_id: 'U0123ABCD' };
    expect(validateProfile(ok)).toEqual([]);
    expect(validateProfile({ ...ok, role_pack: 'ceo', slack_user_id: 'x' }).length).toBe(2);
  });
});

describe('service wrapper', () => {
  it('runs a command with the env file loaded, logs output (scrubbed) and propagates the exit code', () => {
    const envFile = join(dir, 'env');
    writeFileSync(envFile, 'CC_TEST_VALUE=visible-ok\nMY_API_TOKEN=tok-12345678-secret\n', { mode: 0o600 });
    const r = (() => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(repoRoot, 'scripts/ops/run-service.mjs'), '--name', 'test', '--env-file', envFile, '--log-dir', dir, '--no-wait-pg', '--', process.execPath, '-e', 'console.log(process.env.CC_TEST_VALUE, process.env.MY_API_TOKEN); process.exit(3)'], { stdio: 'pipe' }).toString() };
      } catch (e) {
        return { code: (e as { status: number }).status, out: '' };
      }
    })();
    expect(r.code).toBe(3);
    const log = readFileSync(join(dir, 'test.log'), 'utf8');
    expect(log).toContain('visible-ok');
    expect(log).not.toContain('tok-12345678-secret');
    expect(log).toContain('exited code=3');
    expect(existsSync(join(dir, 'test.log'))).toBe(true);
  });
});
