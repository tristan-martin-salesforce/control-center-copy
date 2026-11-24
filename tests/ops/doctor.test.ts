import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The data checks are a lazy import in runDoctor (drizzle and the job handlers): load them with the file, so the first
// full report never pays for transforming that module graph inside its test timeout.
import '../../src/ops/checks/data';
import { formatReport, runDoctor, summarizeMcp, type DoctorContext } from '../../src/ops/doctor';
import type { ExecFn, ExecResult } from '../../src/ops/exec';
import { HeartbeatWriter } from '../../src/ops/heartbeat';
import { parseMcpList } from '../../src/ops/mcp';

// No process is spawned by this file: every check's commands go through the fake `exec` below, and src/ops/paths.ts
// resolves the Homebrew prefix at import (`brew --prefix`, a real child process) unless HOMEBREW_PREFIX is set.
// (vi.hoisted runs before the imports above.)
const brewEnv = vi.hoisted(() => {
  const before = process.env.HOMEBREW_PREFIX;
  process.env.HOMEBREW_PREFIX ??= '/opt/homebrew';
  return before;
});
afterAll(() => {
  if (brewEnv === undefined) delete process.env.HOMEBREW_PREFIX;
  else process.env.HOMEBREW_PREFIX = brewEnv;
});

let dir: string;
const NOW = Date.parse('2026-11-05T15:00:00Z');
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });
const SECRET = 'pat-super-secret-123456';

function ctx(over: Partial<DoctorContext> = {}, exec?: ExecFn): DoctorContext {
  const fake: ExecFn = exec ?? (async (cmd, args) => {
    if (cmd === 'claude' && args[0] === '--version') return res({ stdout: '2.1.318 (Claude Code)\n' });
    if (cmd === 'claude') return res({ stdout: 'slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected\nOrg62-Sobject-Read: https://x (HTTP) - ✔ Connected\n' });
    if (cmd === 'devbar' && args[0] === 'auth') return res({ stdout: '{"authenticated":true,"email":"a@b.c"}' });
    if (cmd === 'devbar') return res({ stdout: '{"listener_ok":true,"upstream_ok":true,"port":13316}' });
    if (cmd.endsWith('pg_isready')) return res();
    return res({ code: 1 });
  });
  return {
    env: { HOME: dir, CC_STATE_DIR: join(dir, 'state'), CC_LAUNCH_AGENTS_DIR: join(dir, 'agents') },
    repoRoot: dir,
    exec: fake,
    now: () => NOW,
    portOpen: async () => true,
    withDb: async (_db, fn) => fn(async (sql) => (sql.includes('pg_database') ? [{ x: 1 }] : [])),
    fetchStatus: async () => 405,
    freeBytes: () => 50 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-doctor-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'env'), `X_TOKEN=${SECRET}\n`, { mode: 0o600 });
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ mcpServers: { 'vdp-app-fir': { headers: { Authorization: `Bearer ${SECRET}`, Cookie: `central_proxy_session=h.${Buffer.from(JSON.stringify({ exp: NOW / 1000 + 3600 })).toString('base64url')}.s` } } } }),
  );
  // the VDP cookie refresh script at its default place (lane E: doctor warns without it)
  mkdirSync(join(dir, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'scripts', 'refresh_vdp_fir_cookie.py'), '# placeholder\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('doctor', () => {
  it('produces a JSON report with the expected checks and no secrets', async () => {
    new HeartbeatWriter({ path: join(dir, 'state', 'worker.heartbeat'), now: () => NOW - 10_000 }).beat();
    const r = await runDoctor(ctx());
    const ids = r.checks.map((c) => c.id);
    for (const id of ['node', 'postgres', 'database', 'migrations', 'assets', 'claude', 'mcp', 'devbar', 'vdp', 'ports', 'disk', 'state', 'agents', 'agent-node', 'heartbeat', 'backups', 'budget']) expect(ids).toContain(id);
    const text = JSON.stringify(r) + formatReport(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('a@b.c'); // devbar email is not echoed either
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by.vdp).toMatchObject({ status: 'ok', data: { pat: 'present', cookie_seconds_left: 3600 } });
    expect(by.heartbeat?.status).toBe('ok');
    expect(by.mcp?.status).toBe('ok');
    expect(by.agents?.status).toBe('warn'); // not installed in the temp LaunchAgents dir
  });

  it('flags a dead worker, a signed-out devbar and low disk with fix hints', async () => {
    new HeartbeatWriter({ path: join(dir, 'state', 'worker.heartbeat'), now: () => NOW - 3600_000 }).beat();
    const exec: ExecFn = async (cmd, args) => (cmd === 'devbar' && args[0] === 'auth' ? res({ stdout: '{"authenticated":false}' }) : res());
    const r = await runDoctor(ctx({ freeBytes: () => 1 * 1024 ** 3 }, exec), { only: ['heartbeat', 'devbar', 'disk'] });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by.heartbeat).toMatchObject({ status: 'fail' });
    expect(by.devbar).toMatchObject({ status: 'fail', fix: 'devbar auth login' });
    expect(by.disk?.status).toBe('fail');
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toMatch(/✗ .*\n\s+fix:/);
  });

  it('missing database and wrong env-file mode are reported', async () => {
    chmodSync(join(dir, 'state', 'env'), 0o644);
    const c = ctx({ withDb: async (_d, fn) => fn(async () => []) });
    const r = await runDoctor(c, { only: ['database', 'state'] });
    expect(r.checks.find((x) => x.id === 'database')?.status).toBe('fail');
    expect(r.checks.find((x) => x.id === 'state')?.fix).toContain('chmod 600');
  });

  it('supports --skip and survives a crashing check', async () => {
    const r = await runDoctor(ctx({ withDb: async () => { throw new Error('boom'); } }), { skip: ['mcp', 'devbar', 'claude'] });
    expect(r.checks.map((c) => c.id)).not.toContain('mcp');
    expect(r.checks.find((c) => c.id === 'database')?.status).toBe('warn');
  });

  it('mcp summary names only the two servers and the fix is the login command', () => {
    const r = summarizeMcp(parseMcpList('slack: https://u (HTTP) - ! Needs authentication\nmcp-adaptor: /bin/x  - ✔ Connected'));
    expect(r.status).toBe('fail'); // Org62 not configured
    expect(r.fix).toContain('claude mcp login slack');
    expect(JSON.stringify(r)).not.toContain('mcp-adaptor');
  });
});

describe('doctor: lane E checks', () => {
  const journal = (whens: number[]) => {
    mkdirSync(join(dir, 'src', 'db', 'migrations', 'meta'), { recursive: true });
    writeFileSync(join(dir, 'src', 'db', 'migrations', 'meta', '_journal.json'), JSON.stringify({ entries: whens.map((when, idx) => ({ idx, when, tag: `000${idx}_m${idx}` })) }));
  };
  const applied = (whens: number[] | null) =>
    ctx({ withDb: async (_d, fn) => fn(async (sql) => (sql.includes('to_regclass') ? [{ ok: whens !== null }] : sql.includes('__drizzle_migrations') ? (whens ?? []).map((w) => ({ at: String(w) })) : [])) });
  const check = async (c: DoctorContext, id: string) => (await runDoctor(c, { only: [id] })).checks[0]!;

  it('migrations: match, behind, ahead, skipped and never migrated', async () => {
    journal([100, 200, 300]);
    expect(await check(applied([100, 200, 300]), 'migrations')).toMatchObject({ status: 'ok', data: { state: 'match', applied: 3, expected: 3 } });
    expect(await check(applied([100]), 'migrations')).toMatchObject({ status: 'fail', fix: expect.stringContaining('npm run update') });
    expect(await check(applied([100, 200, 300, 400]), 'migrations')).toMatchObject({ status: 'warn', data: { state: 'ahead', unknown: 1 } });
    expect(await check(applied([100, 300]), 'migrations')).toMatchObject({ status: 'fail', data: { state: 'skipped', skipped: ['0001_m1'] } });
    expect(await check(applied(null), 'migrations')).toMatchObject({ status: 'fail', data: { state: 'empty' }, fix: 'npm run db:migrate' });
  });

  it('backups: none, fresh, over 48 h, and the copy folder (stale, missing, cloud-synced)', async () => {
    const backups = join(dir, 'state', 'backups');
    const put = (folder: string, hoursAgo: number) => {
      mkdirSync(folder, { recursive: true });
      const f = join(folder, 'command_center-20261105-020000.dump');
      writeFileSync(f, 'x');
      const t = new Date(NOW - hoursAgo * 3600_000);
      utimesSync(f, t, t);
    };
    expect(await check(ctx(), 'backups')).toMatchObject({ status: 'warn', fix: 'npm run backup' });
    put(backups, 10);
    expect(await check(ctx(), 'backups')).toMatchObject({ status: 'ok', detail: expect.stringContaining('no copy folder') });
    put(backups, 50);
    expect(await check(ctx(), 'backups')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/newest backup is 50 h old/) });
    put(backups, 1);
    const copy = join(dir, 'Volumes-Backup');
    const withCopy = (p: string) => ctx({ env: { HOME: dir, CC_STATE_DIR: join(dir, 'state'), CC_BACKUP_COPY_DIR: p } });
    expect(await check(withCopy(copy), 'backups')).toMatchObject({ status: 'warn', detail: expect.stringContaining('no copy in') });
    put(copy, 60);
    expect(await check(withCopy(copy), 'backups')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/newest copy .* is 60 h old/) });
    put(copy, 1);
    expect(await check(withCopy(copy), 'backups')).toMatchObject({ status: 'ok' });
    // a folder a sync client uploads is refused (tenet: Local data): nothing goes there
    const icloud = join(dir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'cc');
    expect(await check(withCopy(icloud), 'backups')).toMatchObject({ status: 'warn', detail: expect.stringContaining('iCloud Drive') });
    // the env file's setting counts too (npm run doctor from a shell doesn't load it)
    writeFileSync(join(dir, 'state', 'env'), `CC_BACKUP_COPY_DIR=${join(dir, 'OneDrive - Example')}\n`, { mode: 0o600 });
    expect(await check(ctx(), 'backups')).toMatchObject({ status: 'warn', detail: expect.stringContaining('OneDrive') });
  });

  it('agent-node: the Node baked into each plist must exist and be 20+', async () => {
    const agents = join(dir, 'agents');
    mkdirSync(agents, { recursive: true });
    const node = join(dir, 'bin', 'node');
    const npm = join(dir, 'bin', 'npm');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    for (const f of [node, npm]) writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
    const plist = (args: string[]) => `<plist><dict><key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${a}</string>`).join('\n')}\n  </array></dict></plist>`;
    writeFileSync(join(agents, 'com.commandcenter.web.plist'), plist([node, '/repo/scripts/ops/run-service.mjs', '--name', 'web', '--', '/repo/node_modules/.bin/next', 'start']));
    writeFileSync(join(agents, 'com.commandcenter.worker.plist'), plist([node, '/repo/scripts/ops/run-service.mjs', '--name', 'worker', '--', npm, 'run', 'worker:start']));
    const exec = (version: string): ExecFn => async (cmd, args) => (cmd === node && args[0] === '--version' ? res({ stdout: `${version}\n` }) : res({ code: 1 }));
    expect(await check(ctx({}, exec('v24.1.0')), 'agent-node')).toMatchObject({ status: 'ok', detail: 'web v24.1.0, worker v24.1.0' });
    expect(await check(ctx({}, exec('v18.20.0')), 'agent-node')).toMatchObject({ status: 'fail', fix: expect.stringContaining('npm run ops:install') });
    rmSync(npm);
    expect((await check(ctx({}, exec('v24.1.0')), 'agent-node')).detail).toMatch(/worker: npm .* is gone/);
    rmSync(node);
    expect((await check(ctx({}, exec('v24.1.0')), 'agent-node')).detail).toMatch(/web: .*bin\/node is gone/);
    rmSync(agents, { recursive: true });
    expect((await check(ctx(), 'agent-node')).status).toBe('skip');
  });

  it('heartbeat: a worker waiting for the schema is a failure with the fix', async () => {
    const hb = new HeartbeatWriter({ path: join(dir, 'state', 'worker.heartbeat'), now: () => NOW - 5000 });
    hb.state = 'blocked';
    hb.beat();
    expect(await check(ctx(), 'heartbeat')).toMatchObject({ status: 'fail', detail: expect.stringContaining('waiting'), fix: expect.stringContaining('npm run update') });
  });

  it('vdp: no refresh script is a warning that says where it comes from', async () => {
    rmSync(join(dir, '.claude', 'scripts', 'refresh_vdp_fir_cookie.py'));
    const r = await check(ctx(), 'vdp');
    expect(r).toMatchObject({ status: 'warn', data: { refresh_script: 'missing' } });
    expect(r.detail).toMatch(/cookie lasts 1 h/);
    expect(r.fix).toMatch(/README ▸ VDP sign-in/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
