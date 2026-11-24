import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Afd360EstimatorAdapter } from '@/tools/adapters/afd360-estimator';
import { ToolError, assertLoopback, toolFetch, type ToolRun } from '@/tools/adapters/base';
import { PulseFootprintAdapter } from '@/tools/adapters/pulse-footprint';
import { TalkTrackAdapter } from '@/tools/adapters/talk-track';
import { parseManifest } from '@/tools/manifest';
import { closedPort, collect, json, manifestOnPort, readManifestFile, startMock, type Mock } from './helpers/mock-servers';

const mocks: Mock[] = [];
afterEach(async () => { await Promise.all(mocks.splice(0).map((m) => m.close())); });

async function rejection(run: ToolRun): Promise<ToolError> {
  try { await run.done; } catch (e) { return e as ToolError; }
  throw new Error('expected rejection');
}

// ------------------------------------------------------------------ talk-track

type TTMode = 'ok' | 'stream-error' | 'hang' | 'create-400';
async function talkTrackMock(mode: TTMode = 'ok') {
  const m = await startMock((req, res, _body) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/api/talk-tracks') return json(res, 200, []);
    if (req.method === 'POST' && url === '/api/talk-tracks') return mode === 'create-400' ? json(res, 400, { error: 'name is required' }) : json(res, 201, { id: 'track-1', name: 'x' });
    if (req.method === 'POST' && url === '/api/talk-tracks/track-1/references') return json(res, 201, []);
    if (req.method === 'PUT' && url === '/api/talk-tracks/track-1/meta') return json(res, 200, {});
    if (req.method === 'POST' && url === '/api/talk-tracks/track-1/generate') return json(res, 200, { jobId: 'job-1', status: 'running' });
    if (req.method === 'GET' && url === '/api/talk-tracks/track-1/jobs/job-1/stream') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
      send({ type: 'status', message: 'Building outline…' });
      send({ type: 'outline', outline: [{ title: 'Intro' }, { title: 'Demo' }] });
      send({ type: 'progress', total: 2, done: 0 });
      if (mode === 'hang') return; // keep the stream open
      send({ type: 'tick', phase: 'fill', elapsedMs: 1 });
      send({ type: 'fill-start', index: 0, title: 'Intro' });
      send({ type: 'fill-done', index: 0, title: 'Intro', result: {} });
      if (mode === 'stream-error') { send({ type: 'error', error: 'claude exited 1' }); send({ type: 'terminal' }); return res.end(); }
      send({ type: 'fill-done', index: 1, title: 'Demo', result: {} });
      send({ type: 'result', talkTrack: { segments: [] } });
      send({ type: 'terminal' });
      return res.end();
    }
    json(res, 404, { error: 'nope' });
  });
  mocks.push(m);
  return m;
}

const ttInput = { name: 'Olivewood demo', customer: 'CUSTOMER_1', context: '# Context\nA calendar description.' };

describe('talk-track adapter (mock NDJSON server)', () => {
  it('health: up on 200', async () => {
    const m = await talkTrackMock();
    const h = await new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).health();
    expect(h).toMatchObject({ ok: true, state: 'up' });
  });

  it('health: down with a start command when nothing listens', async () => {
    const port = await closedPort();
    const h = await new TalkTrackAdapter(manifestOnPort('talk-track', 4320, port)).health();
    expect(h.ok).toBe(false);
    expect(h.state).toBe('down');
    expect(h.startCommand).toBe('cd ~/Projects/talk-track && PORT=4320 npm start');
  });

  it('runs the create -> upload -> generate -> stream sequence and returns links, artifacts, summary', async () => {
    const m = await talkTrackMock();
    const run = new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).start({ ...ttInput, presenterContext: 'Tristan: demo' });
    const [events, result] = await Promise.all([collect(run.events), run.done]);

    expect(result.links).toEqual([{ url: `http://127.0.0.1:${m.port}/#/t/track-1/references`, label: 'Open talk track' }]);
    expect(result.artifacts[0]).toMatchObject({ label: 'talk-track.json', mime: 'application/json' });
    expect(result.artifacts[0]!.path).toBe(path.join(os.homedir(), 'Projects/talk-track/talk-tracks/track-1/talk-track.json'));
    expect(result.summary).toMatch(/2\/2 segments/);

    const pcts = events.filter((e) => e.pct !== undefined).map((e) => e.pct!);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    expect(pcts.at(-1)).toBe(100);
    expect(events.every((e) => typeof e.message === 'string' && !Number.isNaN(Date.parse(e.at)))).toBe(true);

    const paths = m.requests.map((r) => `${r.method} ${r.url}`);
    expect(paths).toEqual([
      'GET /api/talk-tracks', // health preflight
      'POST /api/talk-tracks',
      'POST /api/talk-tracks/track-1/references',
      'PUT /api/talk-tracks/track-1/meta',
      'POST /api/talk-tracks/track-1/generate',
      'GET /api/talk-tracks/track-1/jobs/job-1/stream',
    ]);
    const upload = m.requests[2]!;
    expect(upload.headers['content-type']).toMatch(/^multipart\/form-data/);
    expect(upload.body).toContain('name="files"; filename="command-center-context.md"');
    expect(upload.body).toContain('A calendar description.');
  });

  it('uploads extra reference files and rejects unsupported types before touching the network', async () => {
    const m = await talkTrackMock();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cc-ref-'));
    writeFileSync(path.join(tmp, 'notes.md'), 'extra notes body');
    const ok = await new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).start({ ...ttInput, references: [path.join(tmp, 'notes.md')] }).done;
    expect(ok.summary).toMatch(/generated/);
    expect(m.requests.find((r) => r.url.endsWith('/references'))!.body).toContain('extra notes body');

    const err = await rejection(new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).start({ ...ttInput, references: [path.join(tmp, 'x.exe')] }));
    expect(err).toMatchObject({ kind: 'bad_input', code: 'bad_reference_type' });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('classifies: not_running (with start command), bad_input, failed', async () => {
    const port = await closedPort();
    const down = await rejection(new TalkTrackAdapter(manifestOnPort('talk-track', 4320, port)).start(ttInput));
    expect(down).toMatchObject({ kind: 'not_running', code: 'health_failed' });
    expect(down.startCommand).toContain('npm start');

    const m = await talkTrackMock();
    const a = new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port));
    expect(await rejection(a.start({ name: 'x' }))).toMatchObject({ kind: 'bad_input', code: 'invalid_input' });

    const m400 = await talkTrackMock('create-400');
    expect(await rejection(new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m400.port)).start(ttInput))).toMatchObject({ kind: 'bad_input', code: 'http_400' });

    const mErr = await talkTrackMock('stream-error');
    const failed = await rejection(new TalkTrackAdapter(manifestOnPort('talk-track', 4320, mErr.port)).start(ttInput));
    expect(failed).toMatchObject({ kind: 'failed', code: 'job_failed' });
    expect(failed.message).toContain('claude exited 1');
  });

  it('cancel aborts a hanging stream', async () => {
    const m = await talkTrackMock('hang');
    const run = new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).start(ttInput);
    const seen: string[] = [];
    (async () => { for await (const e of run.events) { seen.push(e.message); if (e.message.startsWith('outline ready')) run.cancel(); } })();
    const err = await rejection(run);
    expect(err).toMatchObject({ kind: 'failed', code: 'cancelled' });
    expect(seen.some((s) => s.startsWith('outline ready'))).toBe(true);
  });

  it('times out', async () => {
    const m = await talkTrackMock('hang');
    const run = new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).start(ttInput, { timeoutMs: 400 });
    expect(await rejection(run)).toMatchObject({ kind: 'failed', code: 'timeout' });
  });

  it('dryRun makes no requests at all', async () => {
    const m = await talkTrackMock();
    const r = await new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).start(ttInput, { dryRun: true }).done;
    expect(m.requests).toEqual([]);
    expect(r.plan!.length).toBeGreaterThan(3);
    expect(r.links).toEqual([]);
  });

  it('external AbortSignal cancels', async () => {
    const m = await talkTrackMock('hang');
    const ac = new AbortController();
    const run = new TalkTrackAdapter(manifestOnPort('talk-track', 4320, m.port)).start(ttInput, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    expect(await rejection(run)).toMatchObject({ code: 'cancelled' });
  });
});

// ------------------------------------------------------------- pulse-footprint

type PMode = 'ok' | 'no-cookie' | 'error-event' | 'bad-request';
async function pulseMock(mode: PMode = 'ok') {
  const m = await startMock((req, res, _body) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/api/orgs') return json(res, 200, { orgs: [] });
    const run = /^\/api\/orgs\/([^/]+)\/run$/.exec(url);
    if (req.method === 'POST' && run) {
      if (mode === 'bad-request') return json(res, 400, { error: 'bad-request', issues: [] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sse('start', { orgId: run[1] });
      sse('progress', { seq: 1, kind: 'info', text: 'connecting', elapsedMs: 5 });
      if (mode === 'error-event') { sse('error', { message: 'engine blew up' }); return res.end(); }
      sse('progress', { seq: 2, kind: 'family-done', family: 'dc_profiles', rows: 120, text: 'dc_profiles: 120 rows', elapsedMs: 50 });
      sse('progress', { seq: 3, kind: 'family-done', family: 'dc_ingest', rows: 30, text: 'dc_ingest: 30 rows', elapsedMs: 80 });
      if (mode === 'no-cookie') {
        sse('done', { status: { ok: false, exitCode: -1, message: 'No Superset session cookie found in Chrome' }, data: null });
      } else {
        sse('done', { status: { ok: true, exitCode: 0 }, data: {} });
      }
      return res.end();
    }
    json(res, 404, {});
  });
  mocks.push(m);
  return m;
}
const pulseAdapter = (port: number) => new PulseFootprintAdapter(manifestOnPort('pulse-footprint', 4318, port));
const ORG18 = '00D000000000062EAA';

describe('pulse-footprint adapter (mock SSE server)', () => {
  it('requires confirm: true and touches nothing without it', async () => {
    const m = await pulseMock();
    const err = await rejection(pulseAdapter(m.port).start({ orgId: ORG18 }));
    expect(err).toMatchObject({ kind: 'bad_input', code: 'confirm_required' });
    expect(m.requests).toEqual([]);
  });

  it('runs with confirm, normalises the org id, streams progress, returns links and artifacts', async () => {
    const m = await pulseMock();
    const run = pulseAdapter(m.port).start({ orgId: ORG18, windowDays: 30, dryRun: true }, { confirm: true });
    const [events, result] = await Promise.all([collect(run.events), run.done]);

    const post = m.requests.find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/api/orgs/00D000000000062/run');
    expect(JSON.parse(post.body)).toEqual({ windowDays: 30, dryRun: true });
    expect(events.map((e) => e.message)).toEqual(expect.arrayContaining(['connecting', 'dc_profiles: 120 rows', 'Pulse run complete']));
    expect(result.links[0]!.label).toMatch(/Open Pulse footprint/);
    expect(result.artifacts).toEqual([]); // tool dry run wrote nothing
    expect(result.summary).toMatch(/dry run/);
  });

  it('non-dry run reports families, rows and a pptx link', async () => {
    const m = await pulseMock();
    const r = await pulseAdapter(m.port).start({ orgId: ORG18 }, { confirm: true }).done;
    expect(r.summary).toMatch(/2 metric families, 150 rows/);
    expect(r.links.map((l) => l.url)).toContain(`http://127.0.0.1:${m.port}/api/orgs/00D000000000062/pptx?download=1`);
    expect(r.artifacts[0]!.path).toMatch(/pulse-reproduction-output\/00D000000000062$/);
  });

  it('failure classes', async () => {
    const down = await rejection(pulseAdapter(await closedPort()).start({ orgId: ORG18 }, { confirm: true }));
    expect(down).toMatchObject({ kind: 'not_running' });
    expect(down.startCommand).toContain('npm run dev');

    const m = await pulseMock();
    expect(await rejection(pulseAdapter(m.port).start({ orgId: 'short' }, { confirm: true }))).toMatchObject({ kind: 'bad_input', code: 'invalid_input' });

    const mc = await pulseMock('no-cookie');
    const cookie = await rejection(pulseAdapter(mc.port).start({ orgId: ORG18 }, { confirm: true }));
    expect(cookie).toMatchObject({ kind: 'failed', code: 'no_superset_session' });
    expect(cookie.message).toMatch(/reopen Pulse Superset in Chrome/i);

    const me = await pulseMock('error-event');
    expect(await rejection(pulseAdapter(me.port).start({ orgId: ORG18 }, { confirm: true }))).toMatchObject({ kind: 'failed', code: 'run_failed' });

    const mb = await pulseMock('bad-request');
    expect(await rejection(pulseAdapter(mb.port).start({ orgId: ORG18 }, { confirm: true }))).toMatchObject({ kind: 'bad_input', code: 'http_400' });
  });

  it('dryRun (adapter level) makes no requests even with confirm', async () => {
    const m = await pulseMock();
    const r = await pulseAdapter(m.port).start({ orgId: ORG18 }, { confirm: true, dryRun: true }).done;
    expect(m.requests).toEqual([]);
    expect(r.plan!.join('\n')).toMatch(/External read: Pulse Superset/);
  });
});

// ------------------------------------------------------------------ estimator

describe('afd360-estimator adapter (fake CLI)', () => {
  let tmp: string;
  let skill: string;
  let estimate: string;
  let runs: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'cc-est-'));
    skill = path.join(tmp, 'skill');
    runs = path.join(tmp, 'runs');
    mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    estimate = path.join(tmp, 'acme', 'estimate.yaml');
    mkdirSync(path.dirname(estimate), { recursive: true });
    writeFileSync(estimate, 'customer: Acme\n');
    // Fake engine: honours --out, fails on format "txt" when FAIL env... use argv markers instead.
    writeFileSync(path.join(skill, 'scripts', 'cli.js'), `
      const a = process.argv.slice(2);
      const out = a[a.indexOf('--out') + 1];
      const fmt = a[a.indexOf('--format') + 1];
      if (!out) { console.error('refusing: no --out'); process.exit(3); }
      if (fmt === 'csv') { console.error('boom: csv not supported'); process.exit(2); }
      if (fmt === 'txt') { setTimeout(() => {}, 60000); return; }
      require('fs').writeFileSync(out, JSON.stringify({ args: a }));
    `);
    chmodSync(path.join(skill, 'scripts', 'cli.js'), 0o644);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const adapter = (overrides: Record<string, unknown> = {}) => {
    const m = structuredClone(readManifestFile('afd360-estimator')) as any;
    m.launch.cwd = skill;
    m.launch.argv = ['node', 'scripts/cli.js', ...m.launch.argv.slice(2)];
    m.health.path = path.join(skill, 'scripts', 'cli.js');
    Object.assign(m, overrides);
    return new Afd360EstimatorAdapter(parseManifest(m), runs);
  };

  it('health reflects the skill file', async () => {
    expect((await adapter().health()).ok).toBe(true);
    const bad = adapter({ health: { type: 'file', path: path.join(tmp, 'missing.py') } });
    expect(await bad.health()).toMatchObject({ ok: false, state: 'down' });
  });

  it('exports into the run dir via --out and never writes next to the estimate', async () => {
    const run = adapter().start({ estimatePath: estimate, format: 'json', model: 'flex' });
    const result = await run.done;
    expect(result.artifacts).toHaveLength(1);
    const file = result.artifacts[0]!.path;
    expect(file.startsWith(runs)).toBe(true);
    const args = JSON.parse(readFileSync(file, 'utf8')).args as string[];
    expect(args).toEqual(['export', estimate, '--format', 'json', '--out', file, '--model', 'flex']);
    expect(existsSync(path.join(path.dirname(estimate), 'exports'))).toBe(false);
    expect((await collect(run.events)).at(-1)!.pct).toBe(100);
  });

  it('classifies nonzero exit as failed with stderr', async () => {
    const err = await rejection(adapter().start({ estimatePath: estimate, format: 'csv' }));
    expect(err).toMatchObject({ kind: 'failed', code: 'nonzero_exit' });
    expect(err.message).toContain('csv not supported');
  });

  it('classifies bad input, missing skill and missing interpreter', async () => {
    expect(await rejection(adapter().start({ estimatePath: path.join(tmp, 'nope.yaml'), format: 'json' }))).toMatchObject({ kind: 'bad_input', code: 'estimate_missing' });
    expect(await rejection(adapter().start({ estimatePath: estimate, format: 'xml' }))).toMatchObject({ kind: 'bad_input', code: 'invalid_input' });
    const noSkill = structuredClone(readManifestFile('afd360-estimator')) as any;
    noSkill.launch.cwd = path.join(tmp, 'absent');
    noSkill.health = { type: 'none' };
    expect(await rejection(new Afd360EstimatorAdapter(parseManifest(noSkill), runs).start({ estimatePath: estimate, format: 'json' }))).toMatchObject({ kind: 'not_running', code: 'skill_missing' });
    const noCmd = structuredClone(readManifestFile('afd360-estimator')) as any;
    noCmd.launch.cwd = skill; noCmd.launch.argv[0] = 'definitely-not-a-command'; noCmd.health = { type: 'none' };
    expect(await rejection(new Afd360EstimatorAdapter(parseManifest(noCmd), runs).start({ estimatePath: estimate, format: 'json' }))).toMatchObject({ kind: 'not_running', code: 'cmd_missing' });
  });

  it('cancel kills the child; timeout is enforced', async () => {
    const run = adapter().start({ estimatePath: estimate, format: 'txt' });
    setTimeout(() => run.cancel(), 300);
    expect(await rejection(run)).toMatchObject({ code: 'cancelled' });
    const slow = adapter().start({ estimatePath: estimate, format: 'txt' }, { timeoutMs: 300 });
    expect(await rejection(slow)).toMatchObject({ code: 'timeout' });
  });

  it('dryRun spawns nothing', async () => {
    const before = existsSync(runs) ? 1 : 0;
    const r = await adapter().start({ estimatePath: estimate, format: 'json' }, { dryRun: true }).done;
    expect(r.plan![0]).toContain('scripts/cli.js export');
    expect(r.plan![0]).toContain('--out <runDir>/estimate.json');
    expect(before).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- safety guards

describe('loopback guard', () => {
  it('refuses non-loopback hosts before any network call', async () => {
    expect(() => assertLoopback('https://example.com/x')).toThrow(/non-loopback|refusing/);
    let called = false;
    const ctx = { fetch: (async () => { called = true; return new Response(''); }) as typeof fetch, signal: new AbortController().signal };
    await expect(toolFetch(ctx, 'https://hooks.slack.com/services/x', { method: 'POST' })).rejects.toMatchObject({ code: 'non_loopback' });
    expect(called).toBe(false);
  });
});
