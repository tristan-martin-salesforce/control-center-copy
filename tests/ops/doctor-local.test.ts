import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPortRegistry, checkSiblingApps, runDoctor, type DoctorContext } from '../../src/ops/doctor';
import type { ExecResult } from '../../src/ops/exec';

// The ~/Projects-dependent checks are optional: a teammate without PORTS.md or the sibling repos gets `skip`, not a warning.
let home: string;
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });

function ctx(over: Partial<DoctorContext> = {}): DoctorContext {
  return {
    env: { HOME: home, CC_STATE_DIR: join(home, 'state'), CC_LAUNCH_AGENTS_DIR: join(home, 'agents') },
    repoRoot: home,
    exec: async () => res({ code: 1 }),
    now: () => Date.parse('2026-11-05T15:00:00Z'),
    portOpen: async () => false,
    withDb: async () => null,
    fetchStatus: async () => null,
    freeBytes: () => 50 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
    ...over,
  };
}
const projects = () => join(home, 'Projects');
const PORTS_MD = ['| Port | App | Path |', '|------|-----|------|', '| 4320 | talk-track | `~/Projects/talk-track` |', '| 4327 | command-center | `~/Projects/command-center` |'].join('\n');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-doctor-local-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('doctor: port registry (PORTS.md)', () => {
  it('missing file: skip, "not used on this machine"', async () => {
    const r = await checkPortRegistry(ctx());
    expect(r).toMatchObject({ id: 'port-registry', status: 'skip' });
    expect(r.detail).toContain('not used on this machine');
  });

  it('present and claiming the app port: ok; present without it: warn with the fix', async () => {
    mkdirSync(projects(), { recursive: true });
    writeFileSync(join(projects(), 'PORTS.md'), PORTS_MD);
    expect(await checkPortRegistry(ctx())).toMatchObject({ status: 'ok', detail: ':4327 registered in ~/Projects/PORTS.md' });

    const injected = await checkPortRegistry(ctx(), { projects: '/elsewhere', exists: (p) => p === '/elsewhere/PORTS.md', read: () => '| 4320 | talk-track | x |' });
    expect(injected).toMatchObject({ status: 'warn', fix: 'add a command-center row for :4327 to /elsewhere/PORTS.md' });
  });

  it('unreadable file: warn, not a crash', async () => {
    const r = await checkPortRegistry(ctx(), { exists: () => true, read: () => { throw new Error('EACCES'); } });
    expect(r.status).toBe('warn');
  });
});

describe('doctor: sibling apps', () => {
  it('no sibling repos and nothing listening: skip (not warn)', async () => {
    const r = await checkSiblingApps(ctx());
    expect(r).toMatchObject({ id: 'ports', status: 'skip', detail: 'not used on this machine (optional integrations)' });
    expect(r.data).toMatchObject({ not_on_this_machine: ['talk-track', 'pulse-footprint'] });
  });

  it('one repo checked out and down: warn for it only; the absent one is named, not warned about', async () => {
    const r = await checkSiblingApps(ctx(), { projects: '/p', exists: (p) => p === '/p/talk-track' });
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('talk-track :4320 down; pulse-footprint not on this machine (optional integrations)');
    expect(r.fix).toBe('start the app(s) from /p'); // no PORTS.md here, so no pointer to it
  });

  it('a running sibling counts even without its repo folder; PORTS.md is pointed at when present', async () => {
    const up = await checkSiblingApps(ctx({ portOpen: async (port) => port === 4318 }), { exists: () => false });
    expect(up).toMatchObject({ status: 'ok', detail: 'pulse-footprint :4318 up; talk-track not on this machine' });

    mkdirSync(join(projects(), 'talk-track'), { recursive: true });
    mkdirSync(join(projects(), 'greg-playground'), { recursive: true });
    writeFileSync(join(projects(), 'PORTS.md'), PORTS_MD);
    const down = await checkSiblingApps(ctx());
    expect(down).toMatchObject({ status: 'warn', detail: 'talk-track :4320 down, pulse-footprint :4318 down (optional integrations)', fix: 'start the app(s) from ~/Projects (see ~/Projects/PORTS.md)' });
  });

  it('runDoctor on a bare machine reports both as skipped, never failed', async () => {
    const r = await runDoctor(ctx(), { only: ['ports', 'port-registry'] });
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([['ports', 'skip'], ['port-registry', 'skip']]);
    expect(r.ok).toBe(true);
  });
});
