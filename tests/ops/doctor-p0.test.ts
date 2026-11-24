import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeBinCandidates, findClaudeBin, resolveClaudeBin } from '../../src/ops/claude-bin';
import { checkPortOwner, nodeCheck, parseLsofListeners, runDoctor, type DoctorContext } from '../../src/ops/doctor';
import type { ExecFn, ExecResult } from '../../src/ops/exec';
import { defaultClaudeExecutable } from '../../src/llm/env';
import { renderAgent } from '../../scripts/ops/lib/plist.mjs';

let home: string;
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });

function ctx(exec: ExecFn, over: Partial<DoctorContext> = {}): DoctorContext {
  return {
    env: { HOME: home, CC_STATE_DIR: join(home, 'state'), CC_LAUNCH_AGENTS_DIR: join(home, 'agents') },
    repoRoot: home,
    exec,
    now: () => Date.parse('2026-11-20T15:00:00Z'),
    portOpen: async () => false,
    withDb: async () => null,
    fetchStatus: async () => null,
    freeBytes: () => 50 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
    ...over,
  };
}

beforeEach(() => void (home = mkdtempSync(join(tmpdir(), 'cc-doctor-p0-'))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('doctor: Node version (PKG-3)', () => {
  it('runs on 20+, warns from 25 ("tested on 22"), fails below 20', () => {
    expect(nodeCheck('22.11.0')).toMatchObject({ status: 'ok', detail: 'v22.11.0' });
    expect(nodeCheck('20.18.0').status).toBe('ok');
    expect(nodeCheck('25.4.0')).toMatchObject({ status: 'warn', detail: 'v25.4.0 (tested on 22; a newer Node can break things)', fix: 'brew install node@22, then npm run ops:install' });
    expect(nodeCheck('18.20.0')).toMatchObject({ status: 'fail', fix: 'brew install node@22' });
  });
});

describe('doctor: the claude binary the runners use (PKG-6)', () => {
  const exe = (...paths: string[]) => (p: string) => paths.includes(p);
  it('CC_CLAUDE_BIN → ~/.local/bin → Homebrew → PATH; none found answers ~/.local/bin/claude', () => {
    const env = { HOME: '/Users/me', PATH: '/usr/bin:/opt/tools/bin' };
    expect(findClaudeBin({ env: { ...env, CC_CLAUDE_BIN: '/x/claude' }, executable: exe() })).toEqual({ path: '/x/claude', found: false, source: 'env' });
    expect(resolveClaudeBin({ env, executable: exe('/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude') })).toBe('/Users/me/.local/bin/claude');
    expect(resolveClaudeBin({ env, executable: exe('/opt/homebrew/bin/claude', '/opt/tools/bin/claude') })).toBe('/opt/homebrew/bin/claude');
    expect(resolveClaudeBin({ env, executable: exe('/opt/tools/bin/claude') })).toBe('/opt/tools/bin/claude');
    expect(findClaudeBin({ env, executable: exe() })).toEqual({ path: '/Users/me/.local/bin/claude', found: false, source: 'default' });
    expect(claudeBinCandidates({ env })).toEqual(['/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude', '/opt/tools/bin/claude']);
  });
  it('the runners take the same answer (CC_CLAUDE_BIN still wins)', () => {
    expect(defaultClaudeExecutable({ CC_CLAUDE_BIN: '/pinned/claude' } as unknown as NodeJS.ProcessEnv)).toBe('/pinned/claude');
  });
  it('doctor names the path it checked when the CLI is missing', async () => {
    const r = await runDoctor(ctx(async () => res({ code: 127 }), { claudeBin: join(home, '.local', 'bin', 'claude') }), { only: ['claude'] });
    expect(r.checks[0]).toMatchObject({ status: 'fail', detail: 'not found (looked for ~/.local/bin/claude)' });
  });
});

describe('doctor: developer-only checks (CC_DEV_CHECKS)', () => {
  it('sibling apps and PORTS.md are skipped unless CC_DEV_CHECKS=1', async () => {
    const off = await runDoctor(ctx(async () => res({ code: 1 }), { portOpen: async () => true }), { only: ['ports', 'port-registry'] });
    expect(off.checks.map((c) => [c.id, c.status, c.detail])).toEqual([
      ['ports', 'skip', 'developer check (set CC_DEV_CHECKS=1 to run it)'],
      ['port-registry', 'skip', 'developer check (set CC_DEV_CHECKS=1 to run it)'],
    ]);
    const c = ctx(async () => res({ code: 1 }), { portOpen: async () => true });
    c.env.CC_DEV_CHECKS = '1';
    const on = await runDoctor(c, { only: ['ports'] });
    expect(on.checks[0]!.detail).toMatch(/talk-track :4320 up/);
  });
});

describe('doctor: who holds port 4327', () => {
  const LSOF_OURS = 'p4242\ncnode\nn127.0.0.1:4327\n';
  const fake = (lsof: string, opts: { agentPid?: number; ppid?: Record<number, number> } = {}): ExecFn =>
    async (cmd, args) => {
      if (cmd === 'lsof') return lsof ? res({ stdout: lsof }) : res({ code: 1 });
      if (cmd === 'launchctl') return opts.agentPid ? res({ stdout: `gui/501/com.commandcenter.web = {\n\tstate = running\n\tpid = ${opts.agentPid}\n}` }) : res({ code: 113 });
      if (cmd === 'ps') return res({ stdout: `${opts.ppid?.[Number(args.at(-1))] ?? 1}\n` });
      return res({ code: 1 });
    };
  const installWeb = (hostFlag = true) => {
    mkdirSync(join(home, 'agents'), { recursive: true });
    let xml = renderAgent({ kind: 'web', repo: '/r', home, node: '/n/node', npm: '/n/npm', logDir: '/l', stateDir: '/s', envFile: '/s/env', templateDir: join(__dirname, '..', '..', 'ops', 'launchd') });
    if (!hostFlag) xml = xml.replace(/\s*<string>-H<\/string>\s*<string>127\.0\.0\.1<\/string>/, '');
    writeFileSync(join(home, 'agents', 'com.commandcenter.web.plist'), xml);
  };

  it('parses lsof -F output', () => {
    expect(parseLsofListeners('p1\ncnode\nn*:4327\nn[::1]:4327\np2\ncpython\nn127.0.0.1:4327\n')).toEqual([
      { pid: 1, command: 'node', names: ['*:4327', '[::1]:4327'] },
      { pid: 2, command: 'python', names: ['127.0.0.1:4327'] },
    ]);
  });

  it('the web agent (through its wrapper) on loopback: ok', async () => {
    installWeb();
    const r = await checkPortOwner(ctx(fake(LSOF_OURS, { agentPid: 4000, ppid: { 4242: 4000 } })));
    expect(r).toMatchObject({ status: 'ok', detail: 'the web agent (pid 4242) on 127.0.0.1:4327' });
  });

  it('the web agent on every interface: warn; a plist from before the loopback fix: fail (UPG-3); both re-install', async () => {
    installWeb();
    const wide = await checkPortOwner(ctx(fake('p4242\ncnode\nn*:4327\n', { agentPid: 4242 })));
    expect(wide).toMatchObject({ status: 'warn', fix: 'npm run ops:install -- --yes  (writes the web agent again with -H 127.0.0.1)' });
    installWeb(false);
    const old = await checkPortOwner(ctx(fake('', {})));
    expect(old).toMatchObject({ status: 'fail', detail: 'free; the installed web agent would listen on every interface', fix: 'npm run ops:install -- --yes  (writes the web agent again with -H 127.0.0.1)' });
    const running = await checkPortOwner(ctx(fake('p4242\ncnode\nn*:4327\n', { agentPid: 4242 })));
    expect(running).toMatchObject({ status: 'fail', code: 'DEP.PORT.EXPOSED' });
  });

  it('another process: "used by <process>", a warning when the web agent is installed', async () => {
    const dev = await checkPortOwner(ctx(fake('p777\ncpython3\nn127.0.0.1:4327\n')));
    expect(dev).toMatchObject({ status: 'ok', detail: 'used by python3 (pid 777); no web agent installed (a dev server?)' });
    installWeb();
    const clash = await checkPortOwner(ctx(fake('p777\ncpython3\nn127.0.0.1:4327\n', { agentPid: 4000 })));
    expect(clash).toMatchObject({ status: 'warn', detail: 'used by python3 (pid 777), not the web agent', fix: 'stop that process (kill 777); launchd then starts the web agent' });
  });

  it('nothing listening: skip', async () => {
    expect(await checkPortOwner(ctx(fake('')))).toMatchObject({ status: 'skip', detail: 'free (nothing is listening)' });
  });
});
