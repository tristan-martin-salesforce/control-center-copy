import { appendFile, cp, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionsFetcher, MemorySessionStateStore, repoOfCwd } from '@/connectors/claude/sessions';
import { deriveStatus, endsWithQuestion } from '@/connectors/claude/status';
import { applyChunk, emptyTranscriptState, findCcTag, turnsOfTranscript } from '@/connectors/claude/transcript';
import { ClaudeSessionWatcher } from '@/connectors/claude/watcher';
import { FIXTURES, signal } from './helpers';

// Fixed "now": fixtures are copied into a temp dir and their mtimes are set relative to it.
const NOW = new Date('2026-03-10T18:00:00.000Z');
const OLD = new Date(NOW.getTime() - 3600_000); // an hour ago: past the 90 s freshness test
const FRESH = new Date(NOW.getTime() - 10_000);

let dir: string;
const proj = () => join(dir, 'projects', '-work-acme');
const WINDOW = { from: '2026-03-10T17:00:00.000Z', to: NOW.toISOString() };

// pid -> procStart string, as `ps -o lstart` would print it. Pids 1001..1009 alive; 1010 (stale registry) is not.
const procs = async () =>
  new Map<number, string>([1001, 1002, 1003, 1006, 1009].map((p) => [p, `Tue Mar 10 08:00:0${p % 10} 2026`] as [number, string]));

async function setMtimes(m: Record<string, Date>) {
  for (const [id, t] of Object.entries(m)) await utimes(join(proj(), `${id}.jsonl`), t, t);
}

async function setup(over: Record<string, Date> = {}, opts: { linked?: string[]; clock?: () => Date } = {}) {
  dir = await mkdtemp(join(tmpdir(), 'cc-claude-'));
  await cp(join(FIXTURES, 'claude'), dir, { recursive: true });
  const all = ['s-busy', 's-waiting-dialog', 's-ask', 's-plan', 's-done', 's-question', 's-courtesy', 's-idle-live', 's-apierr', 's-interrupted', 's-cctag', 's-compact', 's-sidechain', 's-sdk', 's-scheduled', 's-custom-title'];
  await setMtimes({ ...Object.fromEntries(all.map((s) => [s, OLD])), 's-busy': FRESH, ...over });
  const store = new MemorySessionStateStore();
  const f = new ClaudeSessionsFetcher({
    sessionsDir: join(dir, 'sessions'),
    projectsDir: join(dir, 'projects'),
    desktopDir: null,
    stateStore: store,
    clock: opts.clock ?? (() => NOW),
    listProcesses: procs,
    recentDays: 3650,
    ...(opts.linked ? { linkedSessions: async () => new Set(opts.linked) } : {}),
  });
  return { f, store };
}

beforeEach(() => undefined);
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const byId = (items: Array<{ externalId: string; payload?: Record<string, unknown> }>) => Object.fromEntries(items.map((i) => [i.externalId, i.payload!]));

describe('session status matrix (brief 10 §1.5)', () => {
  it('derives the right status for every case', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    const p = byId(r.items);
    const st = (id: string) => `${p[id]!.status}${p[id]!.waitingFor ? ':' + p[id]!.waitingFor : ''}`;

    expect(st('s-busy')).toBe('busy'); // registry busy
    expect(st('s-waiting-dialog')).toBe('waiting:dialog open'); // registry waiting, waitingFor surfaced
    expect(st('s-ask')).toBe('waiting:input needed'); // unanswered AskUserQuestion beats registry idle
    expect(st('s-plan')).toBe('waiting:plan approval'); // ExitPlanMode
    expect(st('s-done')).toBe('done'); // assistant ended, no process
    expect(st('s-question')).toBe('waiting:question'); // final message asks the user (soft)
    expect(p['s-question']).toMatchObject({ statusSoft: true, statusConfidence: 'medium' });
    expect(st('s-courtesy')).toBe('done'); // courtesy closer is not a question
    expect(st('s-idle-live')).toBe('idle'); // live process idle
    expect(st('s-apierr')).toBe('errored');
    expect(p['s-apierr']).toMatchObject({ errorKind: 'api_error', resumable: true });
    expect(st('s-interrupted')).toBe('errored'); // pending tool call, process gone, stale file
    expect(p['s-interrupted']).toMatchObject({ errorKind: 'interrupted', resumable: true });
  });

  it('a pending tool call on a fresh unregistered transcript is busy, not interrupted (90 s rule)', async () => {
    const { f } = await setup({ 's-interrupted': FRESH });
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(byId(r.items)['s-interrupted']).toMatchObject({ status: 'busy', statusConfidence: 'medium' });
  });

  it('question detection: courtesy closers do not block, real decisions do (and stay SOFT)', () => {
    expect(endsWithQuestion('All done. Let me know if you need anything else.')).toBe(false);
    expect(endsWithQuestion('Done. Feel free to ask if anything is unclear.')).toBe(false);
    expect(endsWithQuestion('I found two options. Let me know which option you prefer.')).toBe(true);
    expect(endsWithQuestion('Should I deploy to prod?')).toBe(true);
    expect(endsWithQuestion('All done. Want me to also open a PR? Let me know if you need anything.')).toBe(true);
    const t = emptyTranscriptState();
    t.lastConv = 'assistant';
    t.lastAssistantText = 'Should I deploy to prod?';
    expect(deriveStatus({ t, mtimeMs: 0, nowMs: 1e12 })).toMatchObject({ status: 'waiting', soft: true });
  });

  it('a stale registry file (pid not running) is ignored; the .key files are never read', async () => {
    const { f } = await setup();
    const regs = await f.readRegistry(await procs());
    expect(regs.map((r) => r.pid).sort()).toEqual([1001, 1002, 1003, 1006, 1009, 1010]);
    expect(regs.find((r) => r.pid === 1010)!.alive).toBe(false);
    expect(regs.find((r) => r.pid === 1001)!.alive).toBe(true);
  });

  it('pid reuse: a live pid with a different start time is not the same process', async () => {
    const { f } = await setup();
    const reused = new Map<number, string>([[1001, 'Wed Jan  1 00:00:00 2025']]);
    expect((await f.readRegistry(reused)).find((r) => r.pid === 1001)!.alive).toBe(false);
  });

  it('background agents are an overlay: waiting AND 1 background agent running', async () => {
    const { f } = await setup();
    const sub = join(proj(), 's-ask', 'subagents', 'agent-1.jsonl');
    await utimes(sub, FRESH, FRESH);
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(byId(r.items)['s-ask']).toMatchObject({ status: 'waiting', backgroundAgents: 1, backgroundAgentLabels: ['Researching ACME_CORP API limits'] });
  });

  it('compaction resets pending tool calls and the compact summary is not the first prompt', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    const p = byId(r.items)['s-compact']!;
    expect(p.status).toBe('done');
    expect(p.compactions).toBe(1);
    expect(p.firstPrompt).toBe('Original task prompt');
  });

  it('sidechain records are ignored for status and activity', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(byId(r.items)['s-sidechain']).toMatchObject({ status: 'done', summary: 'Delegated. Done.' });
  });

  it('scheduled runs are marked so the UI never alerts on them as "waiting on me"', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(byId(r.items)['s-scheduled']).toMatchObject({ scheduled: true, status: 'done' });
  });

  it('title priority: custom-title beats ai-title', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(r.items.find((i) => i.externalId === 's-custom-title')!.title).toBe('My Named Session');
  });

  it('registry name is used when there is no custom title', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(r.items.find((i) => i.externalId === 's-busy')!.title).toBe('Demo org build');
  });

  it('excludes SDK sessions (the scanner itself) and configured cwds', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(r.items.map((i) => i.externalId)).not.toContain('s-sdk');
    const g = new ClaudeSessionsFetcher({ sessionsDir: join(dir, 'sessions'), projectsDir: join(dir, 'projects'), desktopDir: null, stateStore: new MemorySessionStateStore(), clock: () => NOW, listProcesses: procs, recentDays: 3650, excludeCwdPrefixes: ['/work/acme'] });
    expect((await g.fetch('all', null, WINDOW, { signal })).items).toHaveLength(0);
  });
});

describe('[cc:<id>] tag and ids', () => {
  it('findCcTag reads the tag from a prompt', () => {
    expect(findCcTag('[cc:run_123] Build it')).toBe('run_123');
    expect(findCcTag('no tag here')).toBeUndefined();
  });

  it('links an app-launched session by its tag and emits BOTH ids', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    const p = byId(r.items)['s-cctag']!;
    expect(p.sessionId).toBe('s-cctag');
    expect(p.hostSessionId).toBe('local_cctag123');
    expect(p.ccTag).toMatchObject({ id: 'run_123', source: 'first_prompt', matchesSessionId: false, matchesHostSessionId: false });
    expect(p.status).toBe('idle'); // live registry idle after the final assistant message
    expect(p.summary).toContain('Demo org built');
    // sessions without a tag have none
    expect(byId(r.items)['s-done']!.ccTag).toBeUndefined();
  });

  it('records which identifier the tag equals when the launcher reuses a session id as the tag', async () => {
    const { f } = await setup();
    const file = join(proj(), 's-cctag.jsonl');
    const txt = (await import('node:fs')).readFileSync(file, 'utf8').replace('[cc:run_123]', '[cc:local_cctag123]');
    await writeFile(file, txt);
    await utimes(file, OLD, OLD);
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(byId(r.items)['s-cctag']!.ccTag).toMatchObject({ id: 'local_cctag123', matchesHostSessionId: true, matchesSessionId: false });
  });

  it('hostSessionId is absent when there is no host', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(byId(r.items)['s-done']!.hostSessionId).toBeUndefined();
  });
});

describe('cursor = per-file byte offsets', () => {
  it('advances offsets to the end of each file, and a second run emits nothing', async () => {
    const { f } = await setup();
    const r1 = await f.fetch('all', null, WINDOW, { signal });
    const cur = JSON.parse(r1.nextCursor.value) as { files: Record<string, { o: number }> };
    const doneFile = Object.keys(cur.files).find((k) => k.endsWith('s-done.jsonl'))!;
    expect(cur.files[doneFile]!.o).toBeGreaterThan(100);
    const r2 = await f.fetch('all', r1.nextCursor, WINDOW, { signal });
    // live sessions are re-evaluated every run but unchanged ones must not re-emit
    expect(r2.items).toHaveLength(0);
    expect(r2.nextCursor.value).toBe(r1.nextCursor.value);
  });

  it('reads only appended bytes and re-emits when the status changes', async () => {
    const { f } = await setup();
    const r1 = await f.fetch('all', null, WINDOW, { signal });
    const file = join(proj(), 's-done.jsonl');
    const line = JSON.stringify({ type: 'user', isSidechain: false, sessionId: 's-done', cwd: '/work/acme', timestamp: '2026-03-10T17:59:00.000Z', uuid: 'u-x', message: { role: 'user', content: 'Now deploy it' }, origin: { kind: 'human' } }) + '\n';
    await appendFile(file, line);
    await utimes(file, FRESH, FRESH);
    const r2 = await f.fetch('all', r1.nextCursor, WINDOW, { signal });
    // D3: a resumed session with new content, linked to no open item, is recorded without the model
    expect(r2.items).toEqual([]);
    expect(r2.quietItems!.map((i) => i.externalId)).toEqual(['s-done']);
    expect(r2.quietItems![0]!.payload).toMatchObject({ status: 'busy', humanPromptCount: 2 });
    expect(r2.decisions).toEqual([{ reason: 'unlinked_content', subject: 's-done', detail: { status: 'busy' } }]);
    const o1 = (JSON.parse(r1.nextCursor.value).files as Record<string, { o: number }>)[file]!.o;
    const o2 = (JSON.parse(r2.nextCursor.value).files as Record<string, { o: number }>)[file]!.o;
    expect(o2).toBe(o1 + Buffer.byteLength(line));
  });

  it('D3: new content in a session linked to an open item goes to the model; a busy ↔ idle flip never does', async () => {
    let now = NOW;
    const { f } = await setup({}, { linked: ['s-done'], clock: () => now });
    const r1 = await f.fetch('all', null, WINDOW, { signal }); // the model's first look at every session
    const file = join(proj(), 's-done.jsonl');
    await appendFile(file, JSON.stringify({ type: 'user', isSidechain: false, sessionId: 's-done', cwd: '/work/acme', timestamp: '2026-03-10T17:59:00.000Z', uuid: 'u-y', message: { role: 'user', content: 'Now deploy it' }, origin: { kind: 'human' } }) + '\n');
    await utimes(file, FRESH, FRESH);
    // within 5 min of that look: recorded now, the model's look waits
    const r2 = await f.fetch('all', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toEqual([]);
    expect(r2.decisions).toContainEqual(expect.objectContaining({ reason: 'min_interval', subject: 's-done' }));
    // once the interval passed: the waiting change goes to the model, without any new write
    now = new Date(NOW.getTime() + 5 * 60_000);
    const r3 = await f.fetch('all', r2.nextCursor, WINDOW, { signal });
    expect(r3.items.map((i) => i.externalId)).toEqual(['s-done']);
    // nothing new since: nothing for the model
    const r4 = await f.fetch('all', r3.nextCursor, WINDOW, { signal });
    expect(r4.items).toEqual([]);
  });

  it('a partial trailing line is not consumed until it is complete', () => {
    const s = emptyTranscriptState();
    const a = JSON.stringify({ type: 'user', isSidechain: false, timestamp: 't', message: { role: 'user', content: 'hi' }, origin: { kind: 'human' } });
    const buf = Buffer.from(a + '\n{"type":"assistant","mess');
    expect(applyChunk(s, buf)).toBe(a.length + 1);
    expect(s.offset).toBe(a.length + 1);
    expect(s.humanPromptCount).toBe(1);
  });

  it('a truncated or rotated file is re-read from 0 (idempotent)', async () => {
    const { f } = await setup();
    const r1 = await f.fetch('all', null, WINDOW, { signal });
    const file = join(proj(), 's-done.jsonl');
    await truncate(file, 10);
    await writeFile(file, JSON.stringify({ type: 'user', isSidechain: false, sessionId: 's-done', timestamp: '2026-03-10T17:00:00.000Z', message: { role: 'user', content: 'fresh' }, origin: { kind: 'human' } }) + '\n');
    await utimes(file, FRESH, FRESH);
    const r2 = await f.fetch('all', r1.nextCursor, WINDOW, { signal });
    const p = byId([...r2.items, ...(r2.quietItems ?? [])])['s-done']!; // D3: recorded either way
    expect(p).toMatchObject({ humanPromptCount: 1, firstPrompt: 'fresh' });
  });

  it('a killed run (cursor never committed) re-emits the same items', async () => {
    const { f } = await setup();
    const a = await f.fetch('all', null, WINDOW, { signal });
    const b = await f.fetch('all', null, WINDOW, { signal });
    expect(b.items.map((i) => `${i.dedupeKey}|${i.contentHash}`)).toEqual(a.items.map((i) => `${i.dedupeKey}|${i.contentHash}`));
  });

  it('coverage lists the registry and every session fetched', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    expect(r.coverage[0]).toMatchObject({ kind: 'session', ref: 'claude:registry' });
    const refs = r.coverage.filter((c) => c.ref !== 'claude:registry').map((c) => c.ref);
    for (const i of r.items) expect(refs).toContain(i.externalId);
    expect(r.complete).toBe(true);
  });

  it('listForReconcile lists transcripts modified in the window', async () => {
    const { f } = await setup();
    const l = await f.listForReconcile!('all', { from: new Date(NOW.getTime() - 2 * 3600_000).toISOString(), to: NOW.toISOString() }, { signal });
    expect(l.map((c) => c.ref)).toContain('s-done');
    expect(l.every((c) => c.kind === 'session')).toBe(true);
  });
});

describe('human turns (2026-11-14: the time engine counts engaged time from the prompts)', () => {
  const rec = (type: string, ts: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, isSidechain: false, sessionId: 's-t', timestamp: ts, ...extra });
  const human = (ts: string, text: string) => rec('user', ts, { message: { role: 'user', content: text }, origin: { kind: 'human' } });
  const assistant = (ts: string) => rec('assistant', ts, { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });

  it('every prompt with the end of the turn after it (its last record before the next prompt), timestamps only', () => {
    const text = [
      human('2026-03-10T10:00:00.000Z', 'build the page'),
      assistant('2026-03-10T10:04:00.000Z'),
      rec('user', '2026-03-10T10:05:00.000Z', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
      assistant('2026-03-10T10:12:00.000Z'),
      // a sidechain record never extends the turn
      JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: '2026-03-10T11:00:00.000Z', message: { role: 'assistant', content: 'x' } }),
      human('2026-03-10T10:30:00.000Z', 'now the tests'),
      assistant('2026-03-10T10:31:00.000Z'),
    ].join('\n');
    expect(turnsOfTranscript(text)).toEqual([
      ['2026-03-10T10:00:00.000Z', '2026-03-10T10:12:00.000Z'],
      ['2026-03-10T10:30:00.000Z', '2026-03-10T10:31:00.000Z'],
    ]);
    // the prompt text is never part of a turn
    expect(JSON.stringify(turnsOfTranscript(text))).not.toContain('build the page');
  });

  it('the item carries humanTurns; the model never sees them (not in what it reads)', async () => {
    const { f } = await setup();
    const r = await f.fetch('all', null, WINDOW, { signal });
    const done = byId(r.items)['s-done']!;
    expect(done.humanTurns).toEqual([['2026-03-10T17:00:00.000Z', expect.any(String)]]);
    expect(Date.parse((done.humanTurns as [string, string][])[0]![1])).toBeGreaterThanOrEqual(Date.parse('2026-03-10T17:03:00.000Z'));
  });

  it('a transcript known from before the turns is re-read once and recorded without the model, never a model look', async () => {
    const { f, store } = await setup();
    const r1 = await f.fetch('all', null, WINDOW, { signal });
    // the cursor and the parse state as an older build left them: no turns version, no D3 accounting
    const cur = JSON.parse(r1.nextCursor.value) as { files: Record<string, Record<string, unknown>> };
    for (const v of Object.values(cur.files)) for (const k of ['tv', 'mh', 'ms', 'm', 'p']) delete v[k];
    for (const path of Object.keys(cur.files)) {
      const s = await store.get(path);
      if (!s) continue;
      delete s.turns;
      delete s.turnsV;
      await store.put(path, s);
    }
    const old = { ...r1.nextCursor, value: JSON.stringify(cur) };
    const r2 = await f.fetch('all', old, WINDOW, { signal });
    expect(r2.items.filter((i) => i.externalId !== 's-busy')).toEqual([]); // nothing for the model (s-busy is live)
    const quiet = byId(r2.quietItems ?? []);
    expect(quiet['s-done']).toMatchObject({ humanTurns: [['2026-03-10T17:00:00.000Z', expect.any(String)]] });
    expect(r2.decisions).toContainEqual(expect.objectContaining({ reason: 'turns_backfill', subject: 's-done' }));
    // once re-read, the next run is quiet: nothing more to record
    const r3 = await f.fetch('all', r2.nextCursor, WINDOW, { signal });
    expect([...r3.items, ...(r3.quietItems ?? [])].map((i) => i.externalId).filter((x) => x !== 's-busy')).toEqual([]);
  });
});

describe('payload hygiene', () => {
  it('redacts credentials in prompts and summaries and keeps only short snippets', async () => {
    const { f } = await setup();
    const file = join(proj(), 's-done.jsonl');
    await appendFile(file, JSON.stringify({ type: 'assistant', isSidechain: false, sessionId: 's-done', timestamp: '2026-03-10T17:30:00.000Z', uuid: 'u-y', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The demo login: admin / pw: Sup3rSecret!9 works.' }] } }) + '\n');
    await utimes(file, OLD, OLD);
    const r = await f.fetch('all', null, WINDOW, { signal });
    const blob = JSON.stringify(r.items.find((i) => i.externalId === 's-done'));
    expect(blob).not.toContain('Sup3rSecret');
    expect(blob).toContain('REDACTED');
  });

  it('repoOfCwd handles worktrees', () => {
    expect(repoOfCwd('/Users/x/Projects/command-center/.claude/worktrees/agent-1')).toBe('command-center');
    expect(repoOfCwd('/work/acme')).toBe('acme');
  });
});

describe('ClaudeSessionWatcher', () => {
  it('debounces bursts into a single change and ignores *.key files', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); // the debounce, on a clock the test steps
    const handlers: Array<(e: string, n: string | null) => void> = [];
    const events: string[] = [];
    const w = new ClaudeSessionWatcher({
      debounceMs: 20,
      sweepMs: 10_000,
      onChange: (r) => events.push(r),
      watchFn: ((_p: string, _o: unknown, cb: (e: string, n: string | null) => void) => {
        handlers.push(cb);
        return { close() {}, on() {} };
      }) as never,
    });
    w.start();
    handlers[0]!('change', '123.abcdef.key'); // ignored
    handlers[0]!('change', '123.json');
    handlers[0]!('change', '124.json');
    handlers[1]!('change', 'proj/abc.jsonl');
    try {
      vi.advanceTimersByTime(19);
      expect(events).toEqual([]); // still inside the debounce window
      vi.advanceTimersByTime(41);
      w.stop();
      expect(events).toEqual(['registry']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to polling when fs.watch is unavailable', () => {
    const w = new ClaudeSessionWatcher({
      onChange: () => undefined,
      watchFn: (() => {
        throw new Error('EMFILE');
      }) as never,
    });
    w.start();
    expect(w.mode).toBe('polling');
    w.stop();
  });
});
