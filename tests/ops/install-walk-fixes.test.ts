/**
 * The install walk's findings (20-onboarding-dry-run.md §"Walk (2026-11-21, from the built tarball)", ON-13..ON-22),
 * each pinned. Fakes and temp folders only: no launchd, tar, Postgres or network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as _ir from '../../scripts/ops/lib/install-release.mjs';
import * as _paths from '../../scripts/ops/lib/paths.mjs';
import * as _wiring from '../../scripts/ops/lib/release-wiring.mjs';

// plain .mjs: their inferred JS types are too narrow for tests
const { effectiveEnv, instanceId, realDeps, servicePort } = _wiring as any;
const { restartAgents } = _ir as any;
const { currentLink } = _paths as any;

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-walk-fix-'));
  env = { HOME: join(tmp, 'home'), CC_STATE_DIR: join(tmp, 'state'), CC_LAUNCH_AGENTS_DIR: join(tmp, 'agents'), CC_LOG_DIR: join(tmp, 'logs') };
  mkdirSync(env.CC_STATE_DIR, { recursive: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});
const writeEnvFile = (body: string) => writeFileSync(join(env.CC_STATE_DIR, 'env'), body, { mode: 0o600 });

describe('ON-14: the env file wins over the shell, as at run time (run-service.mjs)', () => {
  it('shell PORT=3000, env file PORT=4327: the installer uses 4327', () => {
    writeEnvFile('PORT=4327\n');
    expect(servicePort({ ...env, PORT: '3000' })).toBe(4327);
    expect(effectiveEnv({ ...env, PORT: '3000' }).PORT).toBe('4327');
    expect(realDeps({ env: { ...env, PORT: '3000' }, say: () => {} }).port()).toBe(4327);
  });

  it('no PORT in the env file: the shell PORT is used; neither: 4327', () => {
    writeEnvFile('CC_DATA=db\n');
    expect(servicePort({ ...env, PORT: '4436' })).toBe(4436);
    expect(servicePort(env)).toBe(4327);
    expect(servicePort(env, null)).toBe(4327);
  });

  it('the health poll asks the port the env file names, read when it runs (the file appears mid-install)', async () => {
    const deps = realDeps({ env: { ...env, PORT: '3000' }, say: () => {} });
    writeEnvFile('PORT=4436\n'); // written by the env step, after realDeps was built
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      // this install's own web: a fresh install requires `instance` (P35-2)
      return new Response(JSON.stringify({ version: '2.0.1', instance: instanceId(currentLink(env)) }), { status: 200 });
    });
    expect(await deps.health('2.0.1')).toBe(true);
    expect(asked[0]).toBe('http://127.0.0.1:4436/api/v1/version');
  });
});

describe('ON-22: ops:install says "started" only once the new version answers', () => {
  const fakeDeps = (healthy: boolean, renders = true) => {
    const calls: string[] = [];
    return {
      calls,
      agents: {
        running: () => ['web'],
        stop: async (k: string) => calls.push(`stop ${k}`),
        render: async () => (calls.push('render'), renders),
        start: async (k: string) => calls.push(`start ${k}`),
      },
      health: async (v: string) => (calls.push(`health ${v}`), healthy),
    };
  };

  it('stops what runs, writes, starts both, then waits for the version', async () => {
    const d = fakeDeps(true);
    expect(await restartAgents(d, '2.0.1')).toEqual({ status: 'started' });
    expect(d.calls).toEqual(['stop web', 'render', 'start web', 'start worker', 'health 2.0.1']);
  });

  it('no answer: failed at health; agents not written: failed at agents and nothing started', async () => {
    expect(await restartAgents(fakeDeps(false), '2.0.1')).toEqual({ status: 'failed', failedAt: 'health' });
    const d = fakeDeps(true, false);
    expect(await restartAgents(d, '2.0.1')).toEqual({ status: 'failed', failedAt: 'agents' });
    expect(d.calls).toEqual(['stop web', 'render']);
  });
});

describe('P34-1: every port reader lets the env file win (update.mjs, setup.mjs, install.mjs)', () => {
  const read = (f: string) => readFileSync(join(__dirname, '..', '..', 'scripts', 'ops', f), 'utf8');

  it('update.mjs and install.mjs read the port through servicePort / deps.port, never the shell alone', () => {
    expect(read('update.mjs')).not.toMatch(/Number\(process\.env\.PORT/);
    expect(read('update.mjs').match(/servicePort\(\)/g)?.length).toBe(2);
    expect(read('install.mjs')).not.toMatch(/readEnvFile\(envFilePath\(\)\)\?\.PORT/);
  });

  it('setup.mjs onboardingUrl: the file over the shell, as servicePort', async () => {
    const { onboardingUrl } = (await import('../../scripts/ops/setup.mjs')) as any;
    writeEnvFile('PORT=4436\n');
    expect(onboardingUrl({ PORT: '4436' }, { ...env, PORT: '3000' })).toBe(`http://localhost:${servicePort({ ...env, PORT: '3000' })}/onboarding`);
    expect(onboardingUrl({}, { PORT: '3000' })).toBe('http://localhost:3000/onboarding');
  });
});
