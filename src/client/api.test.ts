import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './api';

const respond = (body: string, init: ResponseInit) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, init));

afterEach(() => vi.restoreAllMocks());

describe('the API client never surfaces a JSON parse error (PKG R9)', () => {
  it('an HTML error page reads upstream_unavailable in plain words', async () => {
    respond('<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const err = (await api('getVersion').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'upstream_unavailable', status: 502, retryable: true });
    expect(err.message).toBe("Command Center didn't answer as expected (HTTP 502). It may be restarting; try again in a moment.");
  });

  it('a 200 that is a page (a sign-in page in front of the app) is the same, not SyntaxError', async () => {
    respond('<html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const err = (await api('getVersion').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe('ApiError');
    expect(err.message).not.toMatch(/Unexpected token|SyntaxError|</);
  });

  it('the host guard\'s plain 403 is upstream_unavailable too; a JSON error envelope keeps its code', async () => {
    respond('Forbidden: Command Center only answers on http://localhost:4327.\n', { status: 403 });
    expect(await api('getVersion').catch((e: ApiError) => e.code)).toBe('upstream_unavailable');
    respond(JSON.stringify({ error: { code: 'not_found', message: 'No such item', retryable: false } }), { status: 404, headers: { 'content-type': 'application/json' } });
    expect(await api('getVersion').catch((e: ApiError) => [e.code, e.message])).toEqual(['not_found', 'No such item']);
  });
});
