/**
 * VDP client: allowlists (reads only; deletes and generation never callable), credential handling (headers only,
 * never in an error or a result), auth-error classification (lapsed cookie → Health "needs re-auth").
 */
import { describe, expect, it } from 'vitest';

import { redact } from '../../src/connectors/redact';
import { VdpAuthError, VdpClient, VdpError } from '../../src/connectors/vdp/client';
import { callVdpTool, parseRpcBody, scrub } from '../../src/connectors/vdp/http';
import { assertVdpTool, VDP_READ_TOOLS, VDP_WRITE_TOOLS, VdpToolRefusedError } from '../../src/connectors/vdp/tools';
import { vdpWriteTransport } from '../../src/connectors/vdp/write';
import { classifyError, probeFromClassification } from '../../src/llm/errors';
import { classifyDeliveryError } from '../../src/outbox/errors';
import { claudeJson, cookieOf, fakeVdp, NOW, PAT_VALUE } from './helpers';

const html = (status = 200, extra: Record<string, string> = {}) =>
  (async () => new Response('<html><body>Sign in</body></html>', { status, headers: { 'content-type': 'text/html; charset=UTF-8', ...extra } })) as unknown as typeof fetch;

describe('allowlists', () => {
  // D-59 widened the write list (create_vdp, and the pending tools once VDP lists them) and lets ONE generation through:
  // a use case's own Generate. Deletes, the DC-note generation and stakeholder writes stay refused.
  it('reads pass; deletes, the DC-note generation and stakeholder writes never do; D-59 writes are writes only', () => {
    for (const t of VDP_READ_TOOLS) expect(() => assertVdpTool(t, 'read')).not.toThrow();
    for (const t of VDP_WRITE_TOOLS) expect(() => assertVdpTool(t, 'write')).not.toThrow();
    expect([...VDP_WRITE_TOOLS]).toEqual(expect.arrayContaining(['create_vdp', 'create_company', 'add_vdp_asset', 'set_vdp_owners', 'generate_use_case']));
    for (const t of ['delete_use_case', 'delete_stakeholder', 'delete_vdp', 'generate_deal_contribution_notes', 'generate_use_cases', 'generate_x']) {
      expect(() => assertVdpTool(t, 'read')).toThrow(/never callable/);
      expect(() => assertVdpTool(t, 'write')).toThrow(/never callable/);
    }
    expect(() => assertVdpTool('create_vdp', 'read')).toThrow(/read allowlist/);
    expect(() => assertVdpTool('generate_use_case', 'read')).toThrow(/read allowlist/);
    for (const t of ['create_stakeholder', 'update_stakeholder', 'some_new_tool']) {
      expect(() => assertVdpTool(t, 'read')).toThrow(VdpToolRefusedError);
      expect(() => assertVdpTool(t, 'write')).toThrow(VdpToolRefusedError);
    }
    // a write is never a read and a read is never a write
    expect(() => assertVdpTool('update_use_case', 'read')).toThrow(/not on the VDP read allowlist/);
    expect(() => assertVdpTool('get_vdp', 'write')).toThrow(/not on the VDP write allowlist/);
    expect(() => (VDP_READ_TOOLS as unknown as string[]).push('delete_use_case')).toThrow();
  });

  it('the read client refuses a delete or a write before any request', async () => {
    const vdp = fakeVdp({});
    const client = new VdpClient({ claudeJson: claudeJson(), fetch: vdp.fetch, now: () => NOW });
    await expect(client.call('delete_use_case' as never, { id: 'x' })).rejects.toThrow(VdpToolRefusedError);
    await expect(client.call('generate_deal_contribution_notes' as never, { vdp_id: 'x' })).rejects.toThrow(/never callable/);
    await expect(client.call('update_use_case' as never, { id: 'x' })).rejects.toThrow(/read allowlist/);
    expect(vdp.calls).toEqual([]);
  });

  it('the Outbox write transport takes the three writes and read-back reads only, on vdp-app-fir only', async () => {
    const vdp = fakeVdp({ update_use_case: (a) => ({ use_case: a }), get_use_case: () => ({ use_case: null }) });
    const t = vdpWriteTransport({ claudeJson: claudeJson(), fetch: vdp.fetch, now: () => NOW });
    await expect(t.callTool({ server: 'vdp-app-fir', tool: 'update_use_case', args: { id: 'u1', persona: 'x' } })).resolves.toMatchObject({ text: expect.stringContaining('persona') });
    await expect(t.callTool({ server: 'vdp-app-fir', tool: 'get_use_case', args: { id: 'u1' } })).resolves.toBeTruthy();
    await expect(t.callTool({ server: 'vdp-app-fir', tool: 'delete_use_case', args: { id: 'u1' } })).rejects.toThrow(VdpToolRefusedError);
    await expect(t.callTool({ server: 'vdp-app-fir', tool: 'generate_deal_contribution_notes', args: {} })).rejects.toThrow(VdpToolRefusedError);
    await expect(t.callTool({ server: 'vdp-app-fir', tool: 'search_vdps', args: {} })).rejects.toThrow(/not a VDP Outbox/);
    await expect(t.callTool({ server: 'slack', tool: 'update_use_case', args: {} })).rejects.toThrow(/only serves vdp-app-fir/);
    expect(vdp.calls.map((c) => c.tool)).toEqual(['update_use_case', 'get_use_case']);
  });
});

describe('credentials stay in the headers', () => {
  it('sends the PAT and cookie as headers, read at call time, and returns no part of them', async () => {
    const file = claudeJson();
    const vdp = fakeVdp({ get_vdp: () => ({ vdp: null }) });
    const r = await callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: file, fetch: vdp.fetch, now: () => NOW });
    expect(vdp.calls[0]!.headers.authorization).toBe(`Bearer ${PAT_VALUE}`);
    expect(vdp.calls[0]!.headers.cookie).toBe(cookieOf(file));
    expect(vdp.calls[0]!.headers.accept).toBe('application/json, text/event-stream');
    expect(JSON.stringify(r)).not.toContain(PAT_VALUE);
    expect(JSON.stringify(vdp.calls[0]!.args)).not.toContain(PAT_VALUE);
  });

  it('redacts errors: an echoed header value or token never reaches the message', async () => {
    const file = claudeJson();
    const cookie = cookieOf(file).split('=')[1]!;
    const echo = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 999999, error: { code: -32000, message: `bad ${PAT_VALUE} ${cookie}` } }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const err = await callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: file, fetch: echo, now: () => NOW }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(VdpError);
    expect((err as Error).message).not.toContain(PAT_VALUE);
    expect((err as Error).message).not.toContain(cookie);
    expect(scrub(`Authorization: Bearer ${PAT_VALUE}`, [])).not.toContain(PAT_VALUE);
    expect(scrub(`central_proxy_session=${cookie}`, [])).not.toContain(cookie);
    // a bare PAT or a session cookie with no header label is still a credential
    expect(redact(`token ${PAT_VALUE} here`).text).toBe('token [REDACTED:vdp_pat] here');
    expect(redact('central_proxy_session=abcdefghijklmnop; Path=/').text).toBe('central_proxy_session=[REDACTED:cookie]; Path=/');
  });

  it('a tool error is surfaced redacted, not as a result', async () => {
    const vdp = fakeVdp({ get_use_case: () => ({}) });
    const bad = (async (u: string, init: RequestInit) => {
      const id = (JSON.parse(String(init.body)) as { id: number }).id;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `No use case. token: ${PAT_VALUE}` }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    void vdp;
    const err = await callVdpTool('get_use_case', { id: 'x' }, 'read', { claudeJson: claudeJson(), fetch: bad, now: () => NOW }).catch((e: VdpError) => e);
    expect(err).toBeInstanceOf(VdpError);
    expect((err as VdpError).code).toBe('tool_error');
    expect((err as Error).message).not.toContain(PAT_VALUE);
  });

  it('reads JSON and SSE answers', async () => {
    const vdp = fakeVdp({ get_vdp: () => ({ vdp: { id: 'v1', slug: 's1' } }) }, { sse: true });
    const r = await callVdpTool('get_vdp', { slug: 's1' }, 'read', { claudeJson: claudeJson(), fetch: vdp.fetch, now: () => NOW });
    expect(r.json).toEqual({ vdp: { id: 'v1', slug: 's1' } });
    expect(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[]}}\n\n', 'text/event-stream', 7)).toMatchObject({ id: 7 });
    expect(parseRpcBody('{"jsonrpc":"2.0","id":8,"result":{}}', 'application/json', 7)).toBeNull();
  });
});

describe('auth errors', () => {
  const expectAuth = async (p: Promise<unknown>, code: string) => {
    const err = (await p.catch((e: unknown) => e)) as VdpAuthError;
    expect(err).toBeInstanceOf(VdpAuthError);
    expect(err.code).toBe(code);
    // the scanner classifies it as auth → Health "VDP: needs re-auth" with the refresh-script button
    const c = classifyError(err);
    expect(c.errorClass).toBe('auth');
    expect(probeFromClassification('vdp', c, new Date(NOW).toISOString())).toMatchObject({ state: 'auth_required', reauth: { kind: 'refresh_script' } });
    // and the Outbox says "re-auth, then retry"
    expect(classifyDeliveryError(err).code).toBe('auth');
  };

  it('302 to the Okta gateway', async () => {
    const redirect = (async () => new Response(null, { status: 302, headers: { location: 'https://auth.example-internal.test/okta?state=PLACEHOLDER' } })) as unknown as typeof fetch;
    await expectAuth(callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson(), fetch: redirect, now: () => NOW }), 'sso_redirect');
  });

  it('200 text/html sign-in page', async () => {
    await expectAuth(callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson(), fetch: html(), now: () => NOW }), 'sso_html');
  });

  it('401: the PAT when the cookie is fresh (CONN-11), ambiguous when it is about to lapse', async () => {
    const r401 = (async () => new Response('{"error":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expectAuth(callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson(), fetch: r401, now: () => NOW }), 'pat_revoked');
    await expectAuth(callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson({ cookieExpSec: NOW / 1000 + 30 }), fetch: r401, now: () => NOW }), 'http_401');
  });

  it('an expired cookie fails before any request; a missing PAT too', async () => {
    const vdp = fakeVdp({});
    await expectAuth(callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson({ cookieExpSec: NOW / 1000 - 60 }), fetch: vdp.fetch, now: () => NOW }), 'cookie_expired');
    await expectAuth(callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson({ pat: null }), fetch: vdp.fetch, now: () => NOW }), 'pat_missing');
    expect(vdp.calls).toEqual([]);
  });

  it('rate limits and server errors are retryable, not auth', async () => {
    const r429 = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    const e429 = (await callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson(), fetch: r429, now: () => NOW }).catch((e: VdpError) => e)) as VdpError;
    expect(e429.retryable).toBe(true);
    expect(classifyError(e429).errorClass).toBe('rate_limited');
    const r503 = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const e503 = (await callVdpTool('get_vdp', { slug: 'x' }, 'read', { claudeJson: claudeJson(), fetch: r503, now: () => NOW }).catch((e: VdpError) => e)) as VdpError;
    expect(classifyError(e503).errorClass).toBe('transient');
  });

  it('health() reads the config only and never returns a value', () => {
    expect(new VdpClient({ claudeJson: claudeJson(), now: () => NOW }).health()).toMatchObject({ state: 'ok' });
    expect(new VdpClient({ claudeJson: claudeJson({ cookieExpSec: NOW / 1000 - 600 }), now: () => NOW }).health()).toMatchObject({ state: 'auth_required', errorClass: 'auth', reauth: { kind: 'refresh_script' } });
    expect(new VdpClient({ claudeJson: claudeJson({ cookieExpSec: NOW / 1000 + 120 }), now: () => NOW }).health()).toMatchObject({ state: 'degraded' });
    expect(new VdpClient({ claudeJson: '/nonexistent/claude.json', now: () => NOW }).health()).toMatchObject({ state: 'disabled' });
    expect(JSON.stringify(new VdpClient({ claudeJson: claudeJson(), now: () => NOW }).health())).not.toContain(PAT_VALUE);
  });
});

describe('rate limit', () => {
  it('keeps under maxPerMinute with a sliding window', async () => {
    let t = NOW;
    const waits: number[] = [];
    const vdp = fakeVdp({ get_vdp: () => ({ vdp: null }) });
    const client = new VdpClient({ claudeJson: claudeJson({ cookieExpSec: NOW / 1000 + 7200 }), fetch: vdp.fetch, now: () => t, maxPerMinute: 2, sleep: async (ms) => void (waits.push(ms), (t += ms)) });
    for (let i = 0; i < 3; i++) await client.getVdp('x');
    expect(vdp.calls).toHaveLength(3);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(60_000);
  });
});
