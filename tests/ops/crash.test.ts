import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { errorFields, logger, topFrame } from '@/lib/log';
import { bugEvent, countWorkerStart, crashHandler, crashLoopState, installCrashHandlers } from '@/ops/crash';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-crash-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('log lines (pino, PKG R9)', () => {
  it('JSON lines with the component; credential-shaped keys are redacted, top level and one down', () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
    const log = logger('worker', { destination: sink });
    log.info({ jobId: 7, authorization: 'Bearer abc', token: 't0k', password: 'pw', cookie: 'c=1', req: { headers: { cookie: 'x' }, token: 'deep' }, headers: { a: 1 } }, 'job finished');
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row).toMatchObject({ level: 'info', component: 'worker', msg: 'job finished', jobId: 7, authorization: '[redacted]', token: '[redacted]', password: '[redacted]', cookie: '[redacted]', headers: '[redacted]', req: { headers: '[redacted]', token: '[redacted]' } });
    expect(lines.join('')).not.toMatch(/abc|t0k|"pw"|c=1|deep/);
  });

  it('errors are named by class, code and a repo-relative frame, never their message', () => {
    const err = Object.assign(new Error('customer Acme said no; token=abc'), { code: 'ECONNREFUSED' });
    err.stack = `Error: customer Acme said no\n    at runJob (/Users/someone/Projects/command-center/src/worker/runtime.ts:120:7)\n    at next (node:internal/x:1:1)`;
    expect(errorFields(err)).toEqual({ error: 'Error', code: 'ECONNREFUSED' });
    expect(topFrame(err)).toBe('runJob (src/worker/runtime.ts:120:7)');
    expect(JSON.stringify({ ...errorFields(err), frame: topFrame(err) })).not.toMatch(/Acme|token|someone/);
    expect(topFrame('a string')).toBeNull();
  });
});

describe('worker crash policy (PKG R9)', () => {
  it('an unhandled error writes one BUG.UNHANDLED event, then exits 1; a second error only exits', async () => {
    const events: Array<ReturnType<typeof bugEvent>> = [];
    const exits: number[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const handle = installCrashHandlers({ on: ((ev: string, fn: (e: unknown) => void) => void (handlers[ev] = fn)) as never }, { record: async (ev) => void events.push(ev), log: (m, d) => void logs.push([m, d]), exit: (c) => void exits.push(c) });
    const err = new TypeError('Cannot read properties of undefined (reading "id") of Acme');
    err.stack = 'TypeError: x\n    at plan (/Users/me/cc/src/worker/scanning.ts:40:3)';
    handlers.unhandledRejection!(err);
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual([1]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: 'BUG.UNHANDLED', fingerprint: 'worker|BUG.UNHANDLED|plan (src/worker/scanning.ts:40:3)', detail: { kind: 'unhandledRejection', error: 'TypeError', frame: 'plan (src/worker/scanning.ts:40:3)' } });
    expect(events[0]!.message).toMatch(/background worker stopped on an unexpected error/);
    expect(JSON.stringify(events) + JSON.stringify(logs)).not.toContain('Acme');
    await handle('fatal', new Error('again'));
    expect(exits).toEqual([1, 1]);
    expect(events).toHaveLength(1);
  });

  it('exits even when the event cannot be written (the database is what broke) or hangs', async () => {
    const exits: number[] = [];
    await crashHandler({ record: async () => { throw new Error('db down'); }, log: () => {}, exit: (c) => void exits.push(c) })('uncaughtException', new Error('x'));
    await crashHandler({ record: () => new Promise(() => {}), log: () => {}, exit: (c) => void exits.push(c), flushMs: 10 })('uncaughtException', new Error('y'));
    expect(exits).toEqual([1, 1]);
  });

  it('more than 5 starts in 10 minutes is a crash loop; older starts drop out', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    const min = 60_000;
    expect(crashLoopState([now - 4 * min, now - 3 * min, now - 2 * min, now - min], now)).toMatchObject({ loop: false });
    expect(crashLoopState([now - 9 * min, now - 4 * min, now - 3 * min, now - 2 * min, now - min], now)).toMatchObject({ loop: true });
    expect(crashLoopState([now - 30 * min, now - 20 * min, now - 11 * min, now - 3 * min, now - 2 * min, now - min], now).starts).toHaveLength(4);
    expect(bugEvent('BUG.WORKER_CRASH_LOOP', { starts: 6 })).toMatchObject({ fingerprint: 'worker|BUG.WORKER_CRASH_LOOP', message: expect.stringMatching(/keeps stopping \(6 starts in 10 minutes\)/) });
  });

  it('counts starts in a file in the state folder', () => {
    const f = join(dir, 'state', 'worker-starts.json');
    const t = Date.parse('2026-11-20T10:00:00Z');
    let s = { loop: false, starts: [] as number[] };
    for (let i = 0; i < 6; i++) s = countWorkerStart(f, t + i * 1000);
    expect(s.loop).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toHaveLength(6);
    expect(countWorkerStart(f, t + 60 * 60_000)).toMatchObject({ loop: false, starts: [t + 60 * 60_000] });
  });
});
