/**
 * D-90 (W12-7): `publish` puts the two release items in the running app's Outbox, and nothing else.
 *
 *   publish --dry          prints the plan and makes no request to the app (no draft created)
 *   publish (the build)    writes dist/releases/ and creates exactly two Outbox drafts through POST /outbox/releases,
 *                          in dry run; a second run of the same version updates them, never a second pair
 *   app not running        the file stays the hand-over and the output says `npm run release:outbox -- <file>`;
 *                          that script then creates the same two drafts
 * The "app" is a local HTTP server on a random port over the mock DataSource (placeholders; nothing leaves). The scripts
 * run as child processes without blocking this one (the server answers from here).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, Seed } from '../../src/contract';
import { MockDataSource } from '../../src/server/datasource/mock';
import { stageInApp } from '../../scripts/release/outbox';
import { artifactName } from '../../scripts/ops/lib/release-manifest.mjs';

const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const seed = Seed.parse(JSON.parse(readFileSync(join(ROOT, 'src/mock/seed.example.json'), 'utf8')));
const VERSION = '9.8.7';

let ds: MockDataSource;
let server: Server;
let port: number;
let tmp: string;
const requests: string[] = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-publish-'));
  ds = new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 5 }, autoplay: false, clockMode: 'seed' });
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      void (async () => {
        try {
          if (req.method !== 'POST' || req.url !== '/api/v1/outbox/releases') throw new Error('not found');
          const out = await ds.stageRelease({ body: routes.stageRelease.body!.parse(JSON.parse(raw)) } as never);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'validation', message: (e as Error).message } }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  // a "built" release in a temp dist/ (publish --skip-build reuses it)
  const dist = join(tmp, 'dist');
  mkdirSync(dist, { recursive: true });
  const name = artifactName(VERSION, process.arch) as string;
  const bytes = Buffer.from('not really a build');
  writeFileSync(join(dist, name), bytes);
  writeFileSync(join(dist, name.replace(/\.tgz$/, '.build.json')), JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, version: VERSION, channel: 'stable', arch: process.arch, sha: null, migrationHead: null }));
});

afterAll(async () => {
  ds?.dispose();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

const env = (o: Record<string, string> = {}) => ({ ...process.env, CC_RELEASE_DIST: join(tmp, 'dist'), CC_TEAM_CONFIG: join(tmp, 'none.json'), CC_DISTRIBUTION_FOLDER_ID: '1AbCdEfGhIjKlMnOpQ', CC_DISTRIBUTION_CHANNEL: 'C0ANNOUNCE01', CC_APP_PORT: String(port), ...o });
/** A script run that leaves this process free to answer the fake app. */
function run(args: string[], e: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(TSX, args, { cwd: ROOT, env: e });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const publish = (args: string[], o?: Record<string, string>) => run([join(ROOT, 'scripts/release/publish.ts'), '--version', VERSION, ...args], env(o));
const importFile = (args: string[]) => run([join(ROOT, 'scripts/release/outbox.ts'), ...args], env());
const releaseItems = async () => (await ds.getOutbox({} as never)).groups.flatMap((g) => g.items).filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action.startsWith('release.'));

describe('publish → the Outbox', () => {
  it('publish --dry prints the plan and creates nothing', async () => {
    const r = await publish(['--dry']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('dry run: nothing is built, written, staged, uploaded or posted');
    expect(r.stdout).toContain(`then two Outbox drafts in the running app`);
    expect(requests).toEqual([]);
  }, 120_000);

  it('publish creates exactly two drafts (dry run on); a second publish of the version updates, never duplicates', async () => {
    const r = await publish(['--skip-build']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('in the Outbox (Approve there; dry run on');
    expect(r.stdout).toMatch(/1\. release\.drive_upload .*: created/);
    expect(r.stdout).toMatch(/2\. release\.announce .*: created/);
    let items = await releaseItems();
    expect(items.map((i) => [i.draft.destination.kind === 'action' && i.draft.destination.action, i.group]).sort()).toEqual([
      ['release.announce', 'pending_approval'],
      ['release.drive_upload', 'pending_approval'],
    ]);
    for (const i of items) expect((await ds.previewDraft({ params: { id: i.draft.id }, body: { mode: 'send' } } as never)).dryRun).toBe(true);
    const again = await publish(['--skip-build']);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/release\.announce .*: already there, unchanged/);
    items = await releaseItems();
    expect(items).toHaveLength(2);
    expect(requests.filter((x) => x === 'POST /api/v1/outbox/releases')).toHaveLength(2);
    // the staged file carries the request too (release:outbox reads it)
    const staged = JSON.parse(readFileSync(join(tmp, 'dist', 'releases', `outbox-${VERSION}.json`), 'utf8')) as { input: { version: string } };
    expect(staged.input.version).toBe(VERSION);
  }, 180_000);

  it('app not running: the file is kept and the output says how to import it; release:outbox creates the drafts', async () => {
    const down = await publish(['--skip-build'], { CC_APP_PORT: '1' });
    expect(down.status, down.stderr).toBe(0);
    expect(down.stdout).toContain('not in the Outbox yet (nothing answered on http://127.0.0.1:1');
    expect(down.stdout).toMatch(/npm run release:outbox -- .*outbox-9\.8\.7\.json/);
    const file = join(tmp, 'dist', 'releases', `outbox-${VERSION}.json`);
    const imp = await importFile([file]);
    expect(imp.status, imp.stderr).toBe(0);
    expect(imp.stdout).toContain(`v${VERSION}: the two items are in the Outbox`);
    expect(await releaseItems()).toHaveLength(2);
    const off = await importFile([file, '--port', '1']);
    expect(off.status).toBe(1);
    expect(off.stderr).toContain('nothing staged');
  }, 180_000);

  it('stageInApp: down when nothing answers, refused on an error answer', async () => {
    const input = { version: VERSION, channel: 'stable' as const, artifactPath: '/a', feedPath: '/b', installShPath: '/c', artifactName: 'a.tgz', sha256: 'e'.repeat(64), bytes: 1, notes: '', folderId: '', announceChannel: '' };
    expect(await stageInApp(input, 1)).toMatchObject({ ok: false, reason: 'down' });
    expect(await stageInApp({ ...input, sha256: 'not-a-sha' }, port)).toMatchObject({ ok: false, reason: 'refused', message: expect.stringContaining('400') });
  });
});
