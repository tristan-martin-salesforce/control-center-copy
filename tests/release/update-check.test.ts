/** D-90: the update check (the feed through the Drive read path), GET /version's `update`, and doctor's three checks. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RELEASE_FEED_READ_TOOLS, driveManifest } from '../../src/connectors/google/manifest';
import { GOOGLE_READ_TOOLS } from '../../src/connectors/google/client';
import { directMcpRuntime } from '../../src/connectors/runtime/direct-mcp';
import { feedErrorCode, runUpdateCheck, updateCheckJobDef } from '../../src/jobs/handlers/update-check';
import { checkAgentsCurrent, checkRelease, checkUpdate, type DoctorContext } from '../../src/ops/checks';
import { resolveDistribution, type Distribution } from '../../src/ops/distribution';
import { readUpdateStatus, writeUpdateStatus, type UpdateStatus } from '../../src/ops/release';
import { buildInfo, versionPayload, versionUpdateOf } from '../../src/server/version';
import { buildManifest } from '../../scripts/ops/lib/release-manifest.mjs';
import { renderAgent } from '../../scripts/ops/lib/plist.mjs';

const SHA = 'b'.repeat(64);
const FOLDER = '1AbCdEfGhIjKlMnOpQ';
const feed = (releases: unknown[]) => JSON.stringify({ schema: 1, name: 'command-center', releases });
const row = (version: string, channel = 'stable', extra: Record<string, unknown> = {}) => ({ version, channel, artifact: `command-center-${version}-arm64.tgz`, sha256: SHA, arch: 'arm64', notes: `### Added\n- v${version}`, published_at: '2026-11-21T09:00:00Z', ...extra });

/** A fake devbar Drive client: the search returns the folder's manifest.json row, the read returns `text`. */
function drive(text: string | Error, o: { found?: boolean } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client = {
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (tool === 'search_drive_files') return o.found === false ? 'Found 0 files.' : `- Name: "manifest.json" (ID: feed123, Type: application/json, Size: 900, Created: 2026-11-20T10:00:00Z, Modified: 2026-11-21T09:00:00Z)`;
      if (text instanceof Error) throw text;
      return `File: manifest.json\n\n${text}`;
    },
    health: async () => ({ state: 'ok' as const, checkedAt: new Date().toISOString() }),
  };
  return { calls, runtime: directMcpRuntime({ connector: 'drive', readTools: RELEASE_FEED_READ_TOOLS, client }) };
}

const dist = (o: Partial<Distribution> = {}): Distribution => ({ driveFolderId: FOLDER, announceChannel: '', announceChannelName: '', channel: 'stable', checkForUpdates: true, source: 'team', ...o });
const now = new Date('2026-11-21T10:00:00Z');

describe('runUpdateCheck', () => {
  it('reads the feed with the two allowlisted Drive read tools and finds the newer stable release', async () => {
    const d = drive(feed([row('2.1.0'), row('2.2.0-beta.1', 'beta'), row('2.0.0')]));
    const s = await runUpdateCheck({ runtime: d.runtime, dist: dist(), build: { version: '2.0.0', channel: 'stable' }, arch: 'arm64', now });
    expect(s).toMatchObject({ ok: true, error: null, available: true, current: '2.0.0', channel: 'stable', latest: { version: '2.1.0', sha256: SHA }, folderId: FOLDER, readTools: ['search_drive_files', 'get_drive_file_content'] });
    expect(d.calls.map((c) => c.tool)).toEqual(['search_drive_files', 'get_drive_file_content']);
    expect(d.calls[0]!.args.query).toBe(`'${FOLDER}' in parents and name = 'manifest.json' and trashed = false`);
    expect(d.calls[1]!.args).toEqual({ file_id: 'feed123' });
    // the beta channel sees the beta
    const b = await runUpdateCheck({ runtime: drive(feed([row('2.1.0'), row('2.2.0-beta.1', 'beta')])).runtime, dist: dist({ channel: 'beta' }), build: { version: '2.0.0', channel: 'beta' }, now });
    expect(b.latest?.version).toBe('2.2.0-beta.1');
  });

  it('the tools are read-only and on the Drive allowlist; any other tool is refused before a byte is sent', async () => {
    for (const t of RELEASE_FEED_READ_TOOLS) {
      expect(GOOGLE_READ_TOOLS.has(t)).toBe(true);
      expect(driveManifest.readTools).toContain(t);
    }
    await expect(drive('{}').runtime.call('create_drive_file', {})).rejects.toThrow(/not on its read-only allowlist/);
  });

  it('up to date, no folder, no feed file, an unreadable feed and a sign-in error each say so', async () => {
    expect(await runUpdateCheck({ runtime: drive(feed([row('2.0.0')])).runtime, dist: dist(), build: { version: '2.0.0', channel: 'stable' }, now })).toMatchObject({ ok: true, available: false });
    const none = drive('{}');
    expect(await runUpdateCheck({ runtime: none.runtime, dist: dist({ driveFolderId: '' }), build: { version: '2.0.0', channel: 'stable' }, now })).toMatchObject({ ok: false, error: 'no_folder', readTools: [] });
    expect(none.calls).toEqual([]);
    expect(await runUpdateCheck({ runtime: drive('{}', { found: false }).runtime, dist: dist(), build: { version: '2.0.0', channel: 'stable' }, now })).toMatchObject({ ok: false, error: 'feed_missing' });
    expect(await runUpdateCheck({ runtime: drive('not json').runtime, dist: dist(), build: { version: '2.0.0', channel: 'stable' }, now })).toMatchObject({ ok: false, error: 'feed_invalid' });
    const { GoogleCallError } = await import('../../src/connectors/google/client');
    expect(feedErrorCode(new GoogleCallError('get_drive_file_content', { errorClass: 'auth', signature: 'auth' }, 'x'))).toBe('drive_auth');
  });

  it('the job writes the result file and skips when the check is off (unless asked)', async () => {
    const written: UpdateStatus[] = [];
    const def = updateCheckJobDef({ runtime: () => drive(feed([row('2.1.0')])).runtime, distribution: async () => dist(), build: () => ({ version: '2.0.0', channel: 'stable' }), write: (s) => written.push(s) });
    const ctx = { job: { payload: {} }, clock: () => now, log: () => {} } as never;
    expect(await def.handler(ctx)).toMatchObject({ ok: true, available: true, latest: '2.1.0', current: '2.0.0' });
    expect(written).toHaveLength(1);
    const off = updateCheckJobDef({ runtime: () => drive('{}').runtime, distribution: async () => dist({ checkForUpdates: false }), write: (s) => written.push(s) });
    expect(await off.handler(ctx)).toEqual({ skipped: 'off' });
    expect(def.kind).toBe('update.check');
  });
});

describe('distribution settings', () => {
  it('settings, then config/team.json, then the environment; malformed ids read as empty', () => {
    expect(resolveDistribution({ driveFolderId: FOLDER, announceChannel: 'C0123456789' }, {}, {})).toMatchObject({ driveFolderId: FOLDER, announceChannel: 'C0123456789', source: 'settings', channel: 'stable' });
    expect(resolveDistribution({}, { driveFolderId: FOLDER, announceChannel: 'C0123456789', announceChannelName: '#cc' }, {})).toMatchObject({ source: 'team', announceChannelName: '#cc' });
    expect(resolveDistribution(null, {}, { CC_DISTRIBUTION_FOLDER_ID: FOLDER })).toMatchObject({ source: 'env', driveFolderId: FOLDER });
    expect(resolveDistribution({ driveFolderId: 'https://evil' }, { driveFolderId: 'x' }, {})).toMatchObject({ source: 'none', driveFolderId: '' });
  });
});

describe('GET /version update', () => {
  const status = (latest: string | null, o: Partial<UpdateStatus> = {}): UpdateStatus => ({ checkedAt: '2026-11-21T10:00:00.000Z', ok: true, error: null, current: '2.0.0', channel: 'stable', available: !!latest, latest: latest ? (row(latest) as UpdateStatus['latest']) : null, folderId: FOLDER, readTools: [], ...o });

  it('offers a newer version with its notes and the Claude Code prompt; never the version already running', () => {
    const u = versionUpdateOf(status('2.1.0'), '2.0.0')!;
    expect(u).toMatchObject({ available: true, version: '2.1.0', notes: '### Added\n- v2.1.0', channel: 'stable', publishedAt: '2026-11-21T09:00:00.000Z', checkedAt: '2026-11-21T10:00:00.000Z', error: null });
    expect(u.prompt).toContain(`https://drive.google.com/drive/folders/${FOLDER}`);
    expect(u.prompt).toContain('run update -- --from ~/Downloads/command-center-update/<that .tgz>');
    expect(u.prompt).toContain('for v2.1.0');
    // a check written before this build was installed doesn't offer this build
    expect(versionUpdateOf(status('2.1.0'), '2.1.0')).toMatchObject({ available: false });
    expect(versionUpdateOf(status(null, { ok: false, error: 'drive_auth' }), '2.0.0')).toMatchObject({ available: false, version: null, error: 'drive_auth' });
    expect(versionUpdateOf(null, '2.0.0')).toBeNull();
  });

  it('the payload carries it when given (db), and leaves it out in mock mode and before the first check', () => {
    const base = { build: buildInfo({ CC_APP_VERSION: '2.0.0' }), migration: null, persona: { id: 'se' as const, level: 'ic' as const, label: 'SE' }, workerVersion: null, release: null };
    expect(versionPayload({ ...base, dataSource: 'db', update: versionUpdateOf(status('2.1.0'), '2.0.0') }).update?.available).toBe(true);
    expect('update' in versionPayload({ ...base, dataSource: 'mock' })).toBe(false);
    expect('update' in versionPayload({ ...base, dataSource: 'db', update: null })).toBe(false);
  });
});

describe('doctor: release, agents-current, update', () => {
  let tmp: string;
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cc-doc-'));
    env = { HOME: tmp, CC_STATE_DIR: join(tmp, 'state'), CC_LAUNCH_AGENTS_DIR: join(tmp, 'agents'), CC_LOG_DIR: join(tmp, 'logs') };
    mkdirSync(join(tmp, 'state', 'releases'), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const ctx = (o: Partial<DoctorContext> = {}) => ({ env, repoRoot: tmp, now: () => now.getTime(), ...o }) as DoctorContext;

  async function installFake(version: string) {
    const dir = join(tmp, 'state', 'releases', version);
    mkdirSync(join(dir, 'dist', 'worker'), { recursive: true });
    writeFileSync(join(dir, 'server.js'), '1');
    writeFileSync(join(dir, 'dist', 'worker', 'index.mjs'), '2');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(await buildManifest({ root: dir, version, channel: 'stable', arch: 'arm64' })));
    symlinkSync(version, join(tmp, 'state', 'releases', 'current'));
    return dir;
  }

  it('a source checkout skips all three', async () => {
    expect((await checkRelease(ctx())).status).toBe('skip');
    expect((await checkAgentsCurrent(ctx())).status).toBe('skip');
    expect((await checkUpdate(ctx())).status).toBe('skip');
  });

  it('release: ok when the files match; a changed entry point is DATA.RELEASE.CORRUPT', async () => {
    const dir = await installFake('2.0.0');
    expect(await checkRelease(ctx())).toMatchObject({ status: 'ok', data: { version: '2.0.0', channel: 'stable', arch: 'arm64' } });
    writeFileSync(join(dir, 'server.js'), '9'); // same size: caught by the entry point's sha256
    expect(await checkRelease(ctx())).toMatchObject({ status: 'fail', code: 'DATA.RELEASE.CORRUPT' });
    rmSync(join(dir, 'manifest.json'));
    expect(await checkRelease(ctx())).toMatchObject({ status: 'fail', code: 'DATA.RELEASE.CORRUPT' });
  });

  it('agents-current: ok when both plists run releases/current, DEP.RELEASE.NOT_CURRENT when one runs a checkout', async () => {
    await installFake('2.0.0');
    const current = join(tmp, 'state', 'releases', 'current');
    mkdirSync(env.CC_LAUNCH_AGENTS_DIR!, { recursive: true });
    const plan = { home: tmp, node: '/opt/homebrew/bin/node', npm: '/opt/homebrew/bin/npm', logDir: join(tmp, 'logs'), stateDir: env.CC_STATE_DIR!, envFile: join(env.CC_STATE_DIR!, 'env'), templateDir: join(process.cwd(), 'ops', 'launchd') };
    for (const kind of ['web', 'worker'] as const) writeFileSync(join(env.CC_LAUNCH_AGENTS_DIR!, `com.commandcenter.${kind}.plist`), renderAgent({ kind, repo: current, release: true, ...plan }));
    expect((await checkAgentsCurrent(ctx())).status).toBe('ok');
    writeFileSync(join(env.CC_LAUNCH_AGENTS_DIR!, 'com.commandcenter.worker.plist'), renderAgent({ kind: 'worker', repo: '/Users/x/command-center', ...plan }));
    expect(await checkAgentsCurrent(ctx())).toMatchObject({ status: 'warn', code: 'DEP.RELEASE.NOT_CURRENT' });
  });

  it('update: up to date, available (still ok), failed and stale (DEP.UPDATE.CHECK_FAILED)', async () => {
    writeFileSync(join(tmp, 'package.json'), '{"version":"2.0.0"}');
    const file = join(env.CC_STATE_DIR!, 'update-check.json');
    const s = (o: Partial<UpdateStatus>): UpdateStatus => ({ checkedAt: '2026-11-21T09:00:00.000Z', ok: true, error: null, current: '2.0.0', channel: 'stable', available: false, latest: row('2.0.0') as UpdateStatus['latest'], folderId: FOLDER, readTools: [], ...o });
    writeUpdateStatus(s({}), file);
    expect(readUpdateStatus(file)?.current).toBe('2.0.0');
    expect(await checkUpdate(ctx())).toMatchObject({ status: 'ok', detail: expect.stringContaining('up to date (v2.0.0)') });
    writeUpdateStatus(s({ latest: row('2.1.0') as UpdateStatus['latest'], available: true }), file);
    expect(await checkUpdate(ctx())).toMatchObject({ status: 'ok', data: { available: true, latest: '2.1.0' } });
    writeUpdateStatus(s({ ok: false, error: 'no_folder', latest: null }), file);
    expect(await checkUpdate(ctx())).toMatchObject({ status: 'warn', code: 'DEP.UPDATE.CHECK_FAILED', fix: expect.stringContaining('distributionDriveFolderId') });
    writeUpdateStatus(s({ checkedAt: '2026-11-10T09:00:00.000Z' }), file);
    expect(await checkUpdate(ctx())).toMatchObject({ status: 'warn', detail: expect.stringContaining('11 days ago') });
  });
});
