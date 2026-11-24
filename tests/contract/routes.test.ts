/**
 * Route smoke tests: call the generated Next.js handlers directly (no server).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ApiErrorEnvelope, LiveEvent, TodayPayload, WorkItemDetail } from '@/contract';
import { parseSse } from '@/client/api';
import { getDataSource, resetDataSourceForTests } from '@/server/datasource';
import * as today from '../../app/api/v1/today/route';
import * as item from '../../app/api/v1/items/[id]/route';
import * as action from '../../app/api/v1/items/[id]/actions/[verb]/route';
import * as health from '../../app/api/v1/health/route';
import * as chat from '../../app/api/v1/chat/route';
import * as events from '../../app/api/v1/events/route';
import * as devFail from '../../app/api/v1/dev/fail/route';
import * as unknown from '../../app/api/v1/[...unknown]/route';

const base = 'http://localhost/api/v1';
const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

afterEach(() => resetDataSourceForTests());

describe('API routes', () => {
  it('GET /today returns a contract-valid payload', async () => {
    const res = await today.GET(new Request(`${base}/today`), ctx());
    expect(res.status).toBe(200);
    expect(TodayPayload.safeParse(await res.json()).success).toBe(true);
  });

  it('GET /items/:id 404s with the error envelope', async () => {
    const res = await item.GET(new Request(`${base}/items/nope`), ctx({ id: 'nope' }));
    expect(res.status).toBe(404);
    const body = ApiErrorEnvelope.parse(await res.json());
    expect(body.error.code).toBe('not_found');
  });

  it('PATCH /items/:id → 200, then the same ifVersion → 409 conflict', async () => {
    const ok = await item.PATCH(new Request(`${base}/items/w_dana_reply`, json('PATCH', { ifVersion: 1, patch: { notes: 'x' } })), ctx({ id: 'w_dana_reply' }));
    expect(ok.status).toBe(200);
    const stale = await item.PATCH(new Request(`${base}/items/w_dana_reply`, json('PATCH', { ifVersion: 1, patch: { notes: 'y' } })), ctx({ id: 'w_dana_reply' }));
    expect(stale.status).toBe(409);
    const body = ApiErrorEnvelope.parse(await stale.json());
    expect(body.error).toMatchObject({ code: 'conflict', retryable: true });
    expect((body.error.details as { current: { version: number } }).current.version).toBe(2);
  });

  it('invalid bodies → 400 validation', async () => {
    const res = await action.POST(new Request(`${base}/items/w_dana_reply/actions/snooze`, json('POST', { ifVersion: 'one' })), ctx({ id: 'w_dana_reply', verb: 'snooze' }));
    expect(res.status).toBe(400);
    expect(ApiErrorEnvelope.parse(await res.json()).error.code).toBe('validation');
    const badVerb = await action.POST(new Request(`${base}/items/w_dana_reply/actions/explode`, json('POST', { ifVersion: 1 })), ctx({ id: 'w_dana_reply', verb: 'explode' }));
    expect(badVerb.status).toBe(400);
  });

  it('POST /items/:id/actions/done returns the entity and an auditId', async () => {
    const res = await action.POST(new Request(`${base}/items/w_dana_reply/actions/done`, json('POST', { ifVersion: 1 })), ctx({ id: 'w_dana_reply', verb: 'done' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.entity.state).toBe('done');
    expect(body.auditId).toMatch(/^aud_/);
  });

  it('?fail=1 and the dev failure switch return upstream_unavailable', async () => {
    const res = await health.GET(new Request(`${base}/health?fail=1`), ctx());
    expect(res.status).toBe(503);
    expect(ApiErrorEnvelope.parse(await res.json()).error).toMatchObject({ code: 'upstream_unavailable', retryable: true });
    await devFail.POST(new Request(`${base}/dev/fail`, json('POST', { rate: 1 })), ctx());
    expect((await health.GET(new Request(`${base}/health`), ctx())).status).toBe(503);
    await devFail.POST(new Request(`${base}/dev/fail`, json('POST', { rate: 0 })), ctx());
    expect((await health.GET(new Request(`${base}/health`), ctx())).status).toBe(200);
  });

  it('unknown /api/v1 paths → 404 envelope', async () => {
    const res = await unknown.GET(new Request(`${base}/nope/at/all`));
    expect(res.status).toBe(404);
    expect(ApiErrorEnvelope.parse(await res.json()).error.code).toBe('not_found');
  });

  it('POST /chat streams SSE ending in done', async () => {
    const res = await chat.POST(new Request(`${base}/chat`, json('POST', { text: 'find the ACME deck' })), ctx());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const types: string[] = [];
    for await (const ev of parseSse<{ type: string }>(res.body!)) types.push(ev.type);
    expect(types).toContain('resource');
    expect(types.at(-1)).toBe('done');
  });

  it('GET /events sends hello, then live events for mutations', async () => {
    const ac = new AbortController();
    const res = await events.GET(new Request(`${base}/events`, { signal: ac.signal }), ctx());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: hello');
    // mutate → live event
    await item.PATCH(new Request(`${base}/items/w_dana_reply`, json('PATCH', { ifVersion: 1, patch: { notes: 'live' } })), ctx({ id: 'w_dana_reply' }));
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('event: live');
    const data = JSON.parse(chunk.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
    expect(LiveEvent.parse(data).ids).toContain('w_dana_reply');
    ac.abort();
    reader.releaseLock();
  });

  it('shares one DataSource across route modules', async () => {
    await item.PATCH(new Request(`${base}/items/w_dana_reply`, json('PATCH', { ifVersion: 1, patch: { notes: 'shared' } })), ctx({ id: 'w_dana_reply' }));
    const res = await item.GET(new Request(`${base}/items/w_dana_reply`), ctx({ id: 'w_dana_reply' }));
    expect(WorkItemDetail.parse(await res.json()).item.notes).toBe('shared');
    expect(getDataSource().kind).toBe('mock');
  });
});
