import { describe, expect, it } from 'vitest';

import { appPort, guardRequest, isLoopbackHost, isSameOrigin } from '@/ops/host-guard';

const P = 4327;
const req = (method: string, host: string | null, origin: string | null = null) => guardRequest({ method, host, origin, port: P });

describe('host guard (PKG-1): loopback Host, same-origin changes', () => {
  it('lets the app itself through, on every loopback name', () => {
    for (const h of ['localhost:4327', '127.0.0.1:4327', '[::1]:4327', 'LOCALHOST:4327']) expect(req('GET', h)).toEqual({ ok: true });
    expect(req('POST', 'localhost:4327', 'http://localhost:4327')).toEqual({ ok: true });
    expect(req('DELETE', '127.0.0.1:4327', 'http://127.0.0.1:4327')).toEqual({ ok: true });
  });

  it('refuses a foreign Host (DNS rebinding), a missing Host, another port and smuggled names', () => {
    for (const h of ['evil.example:4327', 'evil.example', 'localhost', 'localhost:4328', '192.168.1.20:4327', '0.0.0.0:4327', 'localhost.evil.example:4327', 'evil@localhost:4327', 'localhost:4327/x', '']) {
      const r = req('GET', h);
      expect(r.ok, h).toBe(false);
      expect(r.ok === false && r.reason).toBe('host');
    }
    expect(req('GET', null).ok).toBe(false);
  });

  it('refuses a change from another origin, a null origin or https, but not a read', () => {
    for (const o of ['http://evil.example', 'http://localhost:4328', 'https://localhost:4327', 'null', 'not a url', 'http://127.0.0.1:4327']) {
      const r = req('POST', 'localhost:4327', o);
      expect(r.ok, o).toBe(false);
      expect(r.ok === false && r.reason).toBe('origin');
    }
    for (const m of ['PATCH', 'PUT', 'DELETE', 'post']) expect(req(m, 'localhost:4327', 'http://evil.example').ok).toBe(false);
    // a cross-site GET can't read the response (CORS), and a request with no Origin is curl, the worker or a script
    expect(req('GET', 'localhost:4327', 'http://evil.example').ok).toBe(true);
    expect(req('POST', 'localhost:4327', null).ok).toBe(true);
  });

  it('reads the port from PORT, else 4327', () => {
    expect(appPort({})).toBe(4327);
    expect(appPort({ PORT: '4346' })).toBe(4346);
    expect(appPort({ PORT: 'x' })).toBe(4327);
    expect(isLoopbackHost('localhost:4346', 4346)).toBe(true);
    expect(isSameOrigin('http://LOCALHOST:4346', 'localhost:4346')).toBe(true);
  });

  it('the root middleware answers 403 with a short body', async () => {
    const { middleware } = await import('../../middleware');
    const { NextRequest } = await import('next/server');
    const bad = middleware(new NextRequest('http://localhost:4327/api/v1/version', { headers: { host: 'evil.example:4327' } }));
    expect(bad.status).toBe(403);
    expect(await bad.text()).toMatch(/^Forbidden: /);
    const post = middleware(new NextRequest('http://localhost:4327/api/v1/items', { method: 'POST', headers: { host: 'localhost:4327', origin: 'http://evil.example' } }));
    expect(post.status).toBe(403);
    const good = middleware(new NextRequest('http://localhost:4327/api/v1/version', { headers: { host: 'localhost:4327' } }));
    expect(good.status).toBe(200);
  });
});
