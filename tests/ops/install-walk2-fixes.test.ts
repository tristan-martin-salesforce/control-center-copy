/**
 * The second install walk's findings (20-onboarding-dry-run.md §"Walk 2", ON-23..ON-27), each pinned. Fakes and temp
 * folders only: no launchd, tar, Postgres or network.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as _setup from '../../scripts/ops/setup.mjs';
import * as _wiring from '../../scripts/ops/lib/release-wiring.mjs';
import { instanceId as serverInstanceId } from '../../src/server/version';

// plain .mjs: their inferred JS types are too narrow for tests
const { dirs, ensureState, envTemplate, templatePort } = _setup as any;
const { instanceId, instanceRequiredFor, realDeps, waitForVersion } = _wiring as any;

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-walk2-fix-'));
  env = { HOME: join(tmp, 'home'), CC_STATE_DIR: join(tmp, 'state'), CC_LAUNCH_AGENTS_DIR: join(tmp, 'agents'), CC_LOG_DIR: join(tmp, 'logs') };
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

describe('P34-4 and the update prompt (34-post20-review-3.md)', () => {
  it('install.mjs turns an uncaught error into one plain line with the doctor command, exit 1', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'scripts', 'ops', 'install.mjs'), 'utf8');
    const line = /const uncaughtLine = (.*);\n/.exec(src)![1]!;
    const fn = new Function(`return ${line}`)() as (e: unknown, d: string) => string;
    expect(fn(new Error('EACCES: permission denied\n    at foo (x.js:1)'), 'npm run doctor')).toBe('the install stopped on an unexpected error: EACCES: permission denied. npm run doctor says what is set up and what to run next.');
    expect(src).toMatch(/process\.on\('uncaughtException', onUncaught\)/);
    expect(src).toMatch(/process\.on\('unhandledRejection', onUncaught\)/);
    expect(src).toMatch(/process\.exit\(1\);\n\};/);
  });

  it("the Claude update prompt names this install's releases folder under CC_STATE_DIR", async () => {
    const { claudeUpdatePrompt } = (await import('../../scripts/ops/lib/update-from.mjs')) as any;
    const p = claudeUpdatePrompt('1AbCdEfGhIjKlMnOpQ', '2.1.0', { HOME: '/Users/x', CC_STATE_DIR: '/tmp/lane/state' });
    expect(p).toContain('npm --prefix "/tmp/lane/state/releases/current" run update -- --from');
    expect(claudeUpdatePrompt('1Ab', '2.1.0', { HOME: '/Users/x' })).toContain('npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run update');
  });
});

describe('ON-25: install.sh takes --reinstall and passes it to install.mjs', () => {
  const sh = join(__dirname, '..', '..', 'scripts', 'ops', 'install.sh');
  // the option loop alone, run by the Mac's bash 3.2: what each argument sets
  const parse = (...args: string[]) => {
    const src = readFileSync(sh, 'utf8');
    const loop = src.slice(src.indexOf('ARTIFACT=""'), src.indexOf('# ---- 1. Node.js'));
    const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\ndie() { echo "DIE $*"; exit 1; }\n${loop}\necho "D=$DOWNGRADE R=$REINSTALL A=$ARTIFACT"`, 'install.sh', ...args], { encoding: 'utf8' });
    return r.stdout.trim();
  };

  it('parses with bash -n, and --reinstall / --allow-downgrade / the artifact in any order', () => {
    expect(spawnSync('/bin/bash', ['-n', sh]).status).toBe(0);
    expect(parse('x.tgz', '--reinstall')).toBe('D= R=--reinstall A=x.tgz');
    expect(parse('--allow-downgrade', 'x.tgz')).toBe('D=--allow-downgrade R= A=x.tgz');
    expect(parse()).toBe('D= R= A=');
    expect(parse('--nope')).toContain('DIE unknown option --nope (the options are --allow-downgrade and --reinstall)');
    expect(readFileSync(sh, 'utf8')).toContain('${REINSTALL:+"$REINSTALL"}');
  });
});

describe('ON-23: a first install writes the shell PORT into the new env file', () => {
  it('a valid shell PORT is used; anything else is 4327', () => {
    expect(templatePort({ PORT: '4439' })).toBe(4439);
    expect(templatePort({})).toBe(4327);
    for (const bad of ['', 'abc', '0', '70000', '44.1', '-1']) expect(templatePort({ PORT: bad })).toBe(4327);
    expect(envTemplate('postgresql://x/y', '', 4439)).toContain('\nPORT=4439\n');
  });

  it('shell PORT=4439 and no env file: the env step writes PORT=4439, and the poll then asks 4439', async () => {
    const shell = { ...env, PORT: '4439' };
    const deps = realDeps({ env: shell, say: () => {} });
    expect(await deps.ensureEnv()).toBe(true);
    expect(readFileSync(join(env.CC_STATE_DIR, 'env'), 'utf8')).toMatch(/^PORT=4439$/m);
    expect(deps.port()).toBe(4439);
    // the file wins from then on (ON-14): a later shell PORT does not move it
    expect(realDeps({ env: { ...env, PORT: '3000' }, say: () => {} }).port()).toBe(4439);
  });

  it('an existing env file is never rewritten', () => {
    const d = dirs(env);
    ensureState(d, envTemplate(undefined, '', 4327));
    expect(ensureState(d, envTemplate(undefined, '', 4439))).not.toContain(d.envFile);
    expect(readFileSync(d.envFile, 'utf8')).toMatch(/^PORT=4327$/m);
  });
});

describe('ON-23: the health poll proves the answering web is this install', () => {
  const release = () => {
    const rel = join(tmp, 'releases', '2.0.0');
    mkdirSync(rel, { recursive: true });
    symlinkSync(rel, join(tmp, 'current'));
    return rel;
  };

  it('the installer and the web compute the same id for the release folder (through the current link)', () => {
    const rel = release();
    expect(instanceId(join(tmp, 'current'))).toBe(serverInstanceId(rel));
    expect(instanceId(join(tmp, 'current'))).toMatch(/^[0-9a-f]{16}$/);
    expect(instanceId(join(tmp, 'current'))).not.toBe(serverInstanceId(tmp));
  });

  it('another app answering the same version on the port fails the install at once, naming the port and lsof', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version: '2.0.0', instance: 'ffffffffffffffff' }), { status: 200 }));
    const said: string[] = [];
    const ok = await waitForVersion('2.0.0', { port: 4439, instance: instanceId(release()), timeoutMs: 60_000, everyMs: 10, say: (l: string) => said.push(l) });
    expect(ok).toBe(false);
    expect(said.join('\n')).toContain('another app answers on port 4439');
    expect(said.join('\n')).toContain('lsof -i :4439');
  });

  it('our own web (same instance) passes; a build from before `instance` is accepted on its version', async () => {
    const id = instanceId(release());
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version: '2.0.0', instance: id }), { status: 200 }));
    expect(await waitForVersion('2.0.0', { port: 4439, instance: id, timeoutMs: 1000, everyMs: 10, say: () => {} })).toBe(true);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version: '1.9.0' }), { status: 200 }));
    expect(await waitForVersion('1.9.0', { port: 4439, instance: id, timeoutMs: 1000, everyMs: 10, say: () => {} })).toBe(true);
  });

  it('realDeps.health compares with current\'s instance', async () => {
    const shell = { ...env, CC_RELEASES_DIR: join(tmp, 'releases') };
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => (asked.push(u), new Response(JSON.stringify({ version: '2.0.0', instance: 'ffffffffffffffff' }), { status: 200 })));
    const said: string[] = [];
    expect(await realDeps({ env: shell, say: (l: string) => said.push(l) }).health('2.0.0')).toBe(false);
    expect(said.join('\n')).toContain('lsof -i :4327');
  });
});

describe('P35-2: a reply with no `instance` is foreign when the build polled for reports one', () => {
  const noInstance = (version: string) => vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version }), { status: 200 }));

  it('requireInstance: the right version with no instance fails at once, naming the port and lsof', async () => {
    noInstance('2.0.0');
    const said: string[] = [];
    const ok = await waitForVersion('2.0.0', { port: 4439, instance: 'aaaaaaaaaaaaaaaa', requireInstance: true, timeoutMs: 60_000, everyMs: 10, say: (l: string) => said.push(l) });
    expect(ok).toBe(false);
    expect(said.join('\n')).toContain('another app answers on port 4439');
    expect(said.join('\n')).toContain('lsof -i :4439');
  });

  it('without requireInstance (a rollback to a build from before the field) the version alone passes', async () => {
    noInstance('1.9.0');
    expect(await waitForVersion('1.9.0', { port: 4439, instance: 'aaaaaaaaaaaaaaaa', requireInstance: false, timeoutMs: 1000, everyMs: 10, say: () => {} })).toBe(true);
  });

  it('instanceRequiredFor: a first install and a newer build require it; the prior build and an older one do not', () => {
    expect(instanceRequiredFor('2.0.0', null)).toBe(true);
    expect(instanceRequiredFor('2.1.0', '2.0.0')).toBe(true);
    expect(instanceRequiredFor('2.0.0', '2.0.0')).toBe(false);
    expect(instanceRequiredFor('1.9.0', '2.0.0')).toBe(false);
  });

  const releases = (cur?: string) => {
    const R = join(tmp, 'releases');
    for (const v of ['1.9.0', '2.0.0']) {
      mkdirSync(join(R, v), { recursive: true });
      writeFileSync(join(R, v, 'manifest.json'), JSON.stringify({ version: v }));
    }
    if (cur) symlinkSync(join(R, cur), join(R, 'current'));
    return { ...env, CC_RELEASES_DIR: R };
  };

  it('realDeps.health on a fresh install: another app answering the version with no instance fails the install', async () => {
    const shell = releases();
    noInstance('2.0.0');
    const said: string[] = [];
    expect(await realDeps({ env: shell, say: (l: string) => said.push(l) }).health('2.0.0')).toBe(false);
    expect(said.join('\n')).toContain('lsof -i :4327');
  });

  it('realDeps.health on a rollback to an older build: no instance is accepted on its version', async () => {
    const shell = releases('2.0.0');
    noInstance('1.9.0');
    expect(await realDeps({ env: shell, say: () => {} }).health('1.9.0')).toBe(true);
  });

  it('realDeps({ requireInstance: true }) (a build\'s own installer) requires it even for the current build', async () => {
    const shell = releases('2.0.0');
    noInstance('2.0.0');
    expect(await realDeps({ env: shell, say: () => {}, requireInstance: true }).health('2.0.0')).toBe(false);
  });
});
