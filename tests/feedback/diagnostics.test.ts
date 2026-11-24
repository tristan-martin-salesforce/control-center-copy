/**
 * PKG-8 / 11 R8: the feedback post's Diagnostics block: codes, states and a log tail, every line through safeLogText
 * and the feedback Scrubber, capped per line and in total; the post the user edits carries it (mock DataSource).
 * Placeholders only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compactLogLine, connectorCode, diagnosticsBlock, DIAGNOSTICS_MAX_CHARS, eventCodes, LOG_LINE_CAP, tailLines, type DiagnosticsInput } from '../../src/server/feedback/diagnostics';
import { formatFeedbackMessage } from '../../src/server/feedback/format';
import { Scrubber, type ScrubTerms } from '../../src/server/feedback/scrub';

const TERMS: ScrubTerms = {
  accounts: [{ id: 'acc-1', names: ['Globex Corporation'], ids: ['001000000000001AAA'] }],
  people: [{ id: 'p-1', names: ['Dana Reyes'], ids: ['U0DANA12345'], emails: ['dana.reyes@globex.example'] }],
  opps: [],
};

const input = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  version: '1.4.0',
  sha: 'abcdef1234567',
  dirty: 2,
  channel: 'stable',
  os: 'darwin 25.0.0',
  node: 'v22.11.0',
  claudeCli: '2.1.329 (Claude Code)',
  workerVersion: '1.3.9',
  mismatch: true,
  migration: '0042_placeholder',
  migrationPending: false,
  connectors: [
    { id: 'slack', state: 'auth_needed', code: 'AUTH.SLACK.EXPIRED' },
    { id: 'gmail', state: 'ok', code: null },
  ],
  events: [
    { code: 'NET.GATEWAY_DOWN', count: 12 },
    { code: 'AUTH.SLACK.EXPIRED', count: 3 },
  ],
  doctor: '14 ok, 1 warnings, 0 failed, 3 skipped · DEP.DEVBAR.MISSING',
  logs: { worker: [], web: [] },
  ...over,
});

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-diag-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the Diagnostics block', () => {
  it('carries version, build, worker mismatch, the top code, connector codes, open event codes and the doctor summary', () => {
    const b = diagnosticsBlock(input(), new Scrubber(TERMS));
    expect(b.startsWith('*Diagnostics*\n```\n')).toBe(true);
    expect(b.endsWith('\n```')).toBe(true);
    expect(b).toContain('version 1.4.0 · sha abcdef1 · modified (2 files) · channel stable');
    expect(b).toContain('claude 2.1.329 (Claude Code)');
    expect(b).toContain('worker 1.3.9 (MISMATCH: restart both)');
    expect(b).toContain('top code: NET.GATEWAY_DOWN');
    expect(b).toContain('slack=auth_needed AUTH.SLACK.EXPIRED, gmail=ok');
    expect(b).toContain('NET.GATEWAY_DOWN×12, AUTH.SLACK.EXPIRED×3');
    expect(b).toContain('doctor: 14 ok');
  });

  it('scrubs credentials, names, emails and ids from the log tail, caps each line, never closes the fence early', () => {
    const worker = [
      JSON.stringify({ level: 'warn', time: '2026-11-20T10:42:07.000Z', component: 'worker', msg: 'scanner run_fail', connector: 'slack', code: 'AUTH.SLACK.EXPIRED' }),
      'Cookie: central_proxy_session=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTM5MDAwMDB9.c2lnbmF0dXJlLXBsYWNlaG9sZGVy',
      'Authorization: Bearer sk-ant-api03-placeholderplaceholderplaceholder',
      'reply drafted for Dana Reyes <dana.reyes@globex.example> about Globex Corporation (001000000000001AAA) ``` done',
      `long ${'x'.repeat(400)}`,
    ];
    const b = diagnosticsBlock(input({ logs: { worker, web: ['GET /api/v1/today 200 12ms'] } }), new Scrubber(TERMS));
    expect(b).toContain('10:42:07 warn worker: scanner run_fail code=AUTH.SLACK.EXPIRED connector=slack');
    expect(b).not.toMatch(/eyJhbGciOiJIUzI1NiJ9|sk-ant-api03|Dana Reyes|dana\.reyes@|Globex Corporation|001000000000001AAA/);
    expect(b.match(/```/g)).toHaveLength(2);
    for (const l of b.split('\n')) expect(l.length).toBeLessThanOrEqual(Math.max(LOG_LINE_CAP, 600));
    expect(b).toContain('--- worker.log (last 5) ---');
    expect(b).toContain('--- web.log (last 1) ---');
  });

  it('drops the oldest log lines first to stay under the cap, so the post fits one Slack message', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(120)}`);
    const b = diagnosticsBlock(input({ logs: { worker: many, web: many } }), new Scrubber(TERMS));
    expect(b.length).toBeLessThanOrEqual(DIAGNOSTICS_MAX_CHARS);
    expect(b).toContain('line 49');
    expect(b).not.toContain('line 0 ');
  });

  it('goes after the report and before the reporter line (the user still sees and edits the whole text)', () => {
    const report = { title: 'Slack inbox stale', kind: 'bug' as const, summary: 's', steps: [], expected: '', actual: '', diagnosis: { cause: '', files: [], confidence: 'low' as const }, context: { version: '1.4.0', sha: null, persona: null, page: '/home', entityKind: null } };
    const m = formatFeedbackMessage(report as never, 'Sam Placeholder', null, diagnosticsBlock(input(), new Scrubber(TERMS)));
    expect(m).toMatch(/\*Diagnostics\*[\s\S]*```\n\n_Reported by Sam_$/);
  });
});

describe('inputs', () => {
  it('reads codes off connectors and events through the alias table', () => {
    expect(connectorCode({ id: 'org62', state: 'auth_needed', lastError: { class: 'auth', message: 'Org62 events: needs re-auth', at: '2026-11-20T10:00:00Z', count: 1 }, impact: null })).toBe('AUTH.ORG62.EXPIRED');
    expect(connectorCode({ id: 'vdp', state: 'degraded', lastError: { class: 'transient', message: 'VDP plans: needs the corporate network: turn on Zscaler, retrying', at: '2026-11-20T10:00:00Z', count: 1 }, impact: null })).toBe('NET.VPN_REQUIRED');
    expect(connectorCode({ id: 'gmail', state: 'ok', lastError: null, impact: null })).toBeNull();
    const ev = (code: string, source: string, count: number) => ({ id: code, at: '2026-11-20T10:00:00Z', level: 'error' as const, source, code, message: '', count, lastSeenAt: '2026-11-20T10:00:00Z', suggestedAction: null, acknowledged: false, acknowledgedAt: null });
    expect(eventCodes({ entries: [ev('scan_run_failed', 'scanner.slack', 2), ev('BUG.UNHANDLED', 'worker', 1), ev('job_dead_lettered', 'worker', 3)] })).toEqual([
      { code: 'BUG.UNKNOWN', count: 5 },
      { code: 'BUG.UNHANDLED', count: 1 },
    ]);
  });

  it('tails a log file and compacts pino lines', () => {
    const f = join(dir, 'worker.log');
    writeFileSync(f, Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n') + '\n');
    expect(tailLines(f)).toHaveLength(50);
    expect(tailLines(f).at(-1)).toBe('l79');
    expect(tailLines(join(dir, 'missing.log'))).toEqual([]);
    expect(compactLogLine('plain line')).toBe('plain line');
  });
});
