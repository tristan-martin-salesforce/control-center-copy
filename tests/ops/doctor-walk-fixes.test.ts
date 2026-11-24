/**
 * The install walk's doctor and installer-message findings (20-onboarding-dry-run.md §Walk): ON-15 (the first-install
 * failure's next step is pasteable), ON-16 (the configured port; "web down" is never ✓), ON-19 (every "what to do"
 * line pasteable in a release). Fakes and temp folders only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _ir from '../../scripts/ops/lib/install-release.mjs';
import { checkAgents } from '../../src/ops/checks/agents';
import { checkHeartbeat } from '../../src/ops/checks/heartbeat';
import { checkPortOwner } from '../../src/ops/checks/ports';
import { appPort, type DoctorContext } from '../../src/ops/checks/types';
import type { ExecFn, ExecResult } from '../../src/ops/exec';
import { formatReport, type DoctorReport } from '../../src/ops/doctor';

const { firstInstallWhy } = _ir as any;

let home: string;
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });
const state = () => join(home, 'Library', 'Application Support', 'command-center');
function ctx(over: Partial<DoctorContext> = {}, exec: ExecFn = async () => res()): DoctorContext {
  return {
    env: { HOME: home, CC_STATE_DIR: state(), CC_LAUNCH_AGENTS_DIR: join(home, 'agents') },
    repoRoot: home,
    exec,
    now: () => Date.parse('2026-11-21T15:00:00Z'),
    portOpen: async () => false,
    withDb: async () => null,
    fetchStatus: async () => null,
    freeBytes: () => 50 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
    ...over,
  };
}
const release = () => {
  // a compiled release: the doctor runs in releases/current, which has manifest.json
  const cur = join(state(), 'releases', 'current');
  mkdirSync(cur, { recursive: true });
  writeFileSync(join(cur, 'manifest.json'), '{}');
  return cur;
};
const PASTE = 'npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-doctor-walk-'));
  mkdirSync(state(), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('ON-16: the doctor uses the port the web runs with', () => {
  it("the env file's PORT over the shell's, else 4327", () => {
    expect(appPort(ctx())).toBe(4327);
    expect(appPort(ctx({ env: { HOME: home, CC_STATE_DIR: state(), PORT: '3000' } }))).toBe(3000);
    writeFileSync(join(state(), 'env'), 'PORT=4436\n');
    expect(appPort(ctx({ env: { HOME: home, CC_STATE_DIR: state(), PORT: '3000' } }))).toBe(4436);
  });

  it('LaunchAgents loaded but the web down: a warning on the configured port, never ✓', async () => {
    writeFileSync(join(state(), 'env'), 'PORT=4436\n');
    mkdirSync(join(home, 'agents'));
    for (const l of ['com.commandcenter.web', 'com.commandcenter.worker']) writeFileSync(join(home, 'agents', `${l}.plist`), '<plist/>');
    const asked: number[] = [];
    const down = await checkAgents(ctx({ portOpen: async (p) => (asked.push(p), false) }));
    expect(asked).toEqual([4436]);
    expect(down).toMatchObject({ status: 'warn', detail: expect.stringContaining('web is down on :4436') });
    expect(await checkAgents(ctx({ portOpen: async () => true }))).toMatchObject({ status: 'ok', detail: 'installed and loaded; web :4436 up' });
  });

  it('the port check names and asks the configured port', async () => {
    writeFileSync(join(state(), 'env'), 'PORT=4436\n');
    const args: string[][] = [];
    const r = await checkPortOwner(ctx({}, async (_cmd, a) => (args.push(a), res({ code: 1 }))));
    expect(r.label).toBe('Port 4436');
    expect(args[0]).toContain('-iTCP:4436');
  });
});

describe('ON-19: every next step can be pasted in a release', () => {
  it('a stale heartbeat names the restart command', async () => {
    release();
    const beat = new Date(Date.parse('2026-11-21T15:00:00Z') - 90_000).toISOString();
    writeFileSync(join(state(), 'worker.heartbeat'), JSON.stringify({ v: 1, instance_id: 'x', pid: 1, state: 'idle', started_at: beat, beat_at: beat, seq: 1, active_jobs: 0, app_version: '2.0.0', last_error_code: null }));
    const r = await checkHeartbeat(ctx({ repoRoot: join(state(), 'releases', 'current') }));
    expect(r.status).toBe('warn');
    expect(r.fix).toBe(`wait a minute; if it persists, restart the worker: ${PASTE} ops:install`);
  });

  it('the catalog\'s "what to do" line comes out pasteable with the context (DEP.NODE.UNTESTED)', () => {
    const cur = release();
    const report = { ok: false, checks: [{ id: 'node', label: 'Node.js', status: 'warn', detail: 'v25.4.0', fix: 'brew install node@22', code: 'DEP.NODE.UNTESTED' }], summary: { ok: 0, warn: 1, fail: 0, skip: 0 } } as unknown as DoctorReport;
    expect(formatReport(report)).toContain('what to do: Run: brew install node@22, then npm run ops:install.');
    expect(formatReport(report, { repoRoot: cur, env: { HOME: home, CC_STATE_DIR: state() } })).toContain(`what to do: Run: brew install node@22, then ${PASTE} ops:install.`);
  });
});

describe('ON-15: a failed first install says a doctor command that can be pasted', () => {
  it('names releases/current by its home-relative, quoted path', () => {
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const why = firstInstallWhy(join(state(), 'releases'));
      for (const step of ['backup', 'migrate', 'repoint', 'agents', 'health']) expect(why[step]).toContain(`${PASTE} doctor says why`);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
