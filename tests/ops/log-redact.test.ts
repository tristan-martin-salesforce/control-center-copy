/**
 * W0-6 (wave-0 review): the pino logger never writes a credential, whatever key spelling or depth a caller passes it,
 * and token-shaped text in a message or string field is scrubbed (safeLogText). Fake placeholder values only.
 */
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { logger, REDACT_KEYS, safeLogText } from '@/lib/log';
import { safeLogText as llmSafeLogText } from '@/llm/redact';

const SECRET = 'PLACEHOLDERSECRETVALUE';
// built at run time so no token-shaped literal sits in the repo
const FAKE_SLACK = ['xoxb', '000000000000', 'FAKEFAKEFAKE'].join('-');
const FAKE_ANTHROPIC = ['sk', 'ant', 'api03', 'FAKEFAKEFAKEFAKEFAKE'].join('-');

function capture() {
  const lines: string[] = [];
  const sink = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
  return { log: logger('test', { destination: sink }), lines };
}

/** `{ k: v }` nested `depth` objects down: depth 1 = top level. */
const nest = (k: string, depth: number): Record<string, unknown> => {
  let o: Record<string, unknown> = { [k]: SECRET };
  for (let i = 1; i < depth; i++) o = { [`l${i}`]: o };
  return o;
};
const dig = (o: Record<string, unknown>, depth: number, k: string): unknown => {
  let cur: Record<string, unknown> = o;
  for (let i = depth - 1; i >= 1; i--) cur = cur[`l${i}`] as Record<string, unknown>;
  return cur[k];
};

describe('log redaction (W0-6)', () => {
  const keys = ['apiKey', 'api_key', 'secret', 'access_token', 'refresh_token', 'Authorization', 'authorization', 'Cookie', 'cookie', 'set-cookie', 'x-api-key', 'token', 'password', 'accessToken'];

  it.each(keys.flatMap((k) => [1, 2, 3, 4].map((d) => [k, d] as const)))('%s at depth %i is [redacted]', (k, d) => {
    expect(REDACT_KEYS).toContain(k);
    const { log, lines } = capture();
    log.info(nest(k, d), 'line');
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(dig(row, d, k)).toBe('[redacted]');
    expect(lines[0]).not.toContain(SECRET);
  });

  it('a response headers object nested in a result is blanked whole', () => {
    const { log, lines } = capture();
    log.info({ res: { status: 200, headers: { Authorization: SECRET, 'set-cookie': SECRET } }, jobId: 3 }, 'fetched');
    const row = JSON.parse(lines[0]!) as { res: { status: number; headers: unknown }; jobId: number };
    expect(row.res).toEqual({ status: 200, headers: '[redacted]' });
    expect(row.jobId).toBe(3);
    expect(lines[0]).not.toContain(SECRET);
  });

  it('a message carrying a fake Slack or Anthropic token, a bearer value or token= is scrubbed; ids stay', () => {
    const { log, lines } = capture();
    log.warn(`retry with ${FAKE_SLACK} failed for job 42`);
    log.warn({ note: `header Bearer ${SECRET}abc` }, `key ${FAKE_ANTHROPIC} rejected; url ?token=${'a1B2'.repeat(12)}`);
    const all = lines.join('');
    expect(all).not.toContain(FAKE_SLACK);
    expect(all).not.toContain(FAKE_ANTHROPIC);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('a1B2a1B2');
    const first = JSON.parse(lines[0]!) as { msg: string };
    expect(first.msg).toBe('retry with [redacted] failed for job 42');
    const second = JSON.parse(lines[1]!) as { msg: string; note: string };
    expect(second.note).toBe('header Bearer [redacted]');
    expect(second.msg).toContain('token=[redacted]');
  });

  it('SEC-1: the Okta gateway cookie, a VDP PAT, a Google token and a URL password are scrubbed by both redactors', () => {
    const okta = ['central_proxy_session', 'FAKEokta0session0value0'].join('=');
    const pat = ['vdp', 'pat', 'FAKEFAKEFAKEFAKE1234'].join('_');
    const google = ['ya29', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('.');
    const url = `postgres://cc:${SECRET}@localhost:5432/command_center`;
    const line = `gateway said 302 for ${okta}; pat ${pat}; google ${google}; db ${url}`;
    for (const out of [safeLogText(line), llmSafeLogText(line, 2000)]) {
      for (const s of ['FAKEokta0session0value0', pat, google, SECRET]) expect(out).not.toContain(s);
      expect(out).toContain('central_proxy_session=');
      expect(out).toContain('postgres://cc:');
    }
    const { log, lines } = capture();
    log.warn({ detail: line }, line);
    expect(lines.join('')).not.toMatch(/FAKEokta0session0value0|FAKEFAKEFAKEFAKE1234|ya29\.FAKE|PLACEHOLDERSECRETVALUE/);
  });

  it('safeLogText leaves ordinary text, ids and short values alone', () => {
    const plain = 'job 42 finished in 120 ms for work item 0b9c7f3e-1111-4222-8333-444455556666 (status done)';
    expect(safeLogText(plain)).toBe(plain);
    expect(safeLogText('token=short')).toBe('token=short');
    expect(safeLogText(`x ${FAKE_SLACK}`)).toBe('x [redacted]');
  });
});

describe('one log format (W0-14)', () => {
  it('the chat ledger search logs through pino (class and code), never console', () => {
    const src = readFileSync('src/server/datasource/db/chat-be6.ts', 'utf8');
    expect(src).not.toMatch(/console\.(warn|log|error)\(/);
    expect(src).toContain("ledgerLog().warn({ ...errorFields(err), how }, 'chat ledger search failed')");
  });
});
