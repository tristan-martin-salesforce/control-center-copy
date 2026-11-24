/**
 * SEC-13: a stream's error frame carries the same envelope as the JSON path, never `String(err)`.
 * P25-7: an `internal` error tells the client the catalog's fixed words on both paths; its own message (a driver or
 * fs message can name a path or a query) is kept in the server log only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => [] as Array<{ fields: Record<string, unknown>; msg: string }>);
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  const fake = { error: (fields: Record<string, unknown>, msg: string) => logged.push({ fields, msg }), warn: () => {}, info: () => {}, debug: () => {}, child: () => fake };
  return { ...real, logger: () => fake };
});

import { AppError } from '@/server/errors';
import { errorResponse, streamErrorBody } from '@/server/http';

const FIXED = 'Command Center hit an unexpected error. If it keeps happening, report it (the report carries the details).';

beforeEach(() => {
  logged.length = 0;
});

describe('streamErrorBody (SEC-13)', () => {
  it('an AppError keeps its body', () => {
    expect(streamErrorBody(new AppError('not_found', 'Item x not found', { id: 'x' }))).toMatchObject({ code: 'not_found', message: 'Item x not found', details: { id: 'x' } });
    expect(logged).toEqual([]);
  });

  it('a plain error is internal with the fixed words (no message, no "Error:" prefix, no stack)', () => {
    const b = streamErrorBody(new Error('boom'));
    expect(b).toEqual({ code: 'internal', message: FIXED, retryable: true });
    expect(JSON.stringify(b)).not.toMatch(/Error:|\bat \/|boom/);
  });

  it('a database that is down is the catalog words, not the raw connection text', () => {
    const b = streamErrorBody(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
    expect(b.code).toBe('upstream_unavailable');
    expect(b.message).not.toMatch(/127\.0\.0\.1/);
  });

  it('a thrown non-Error is not stringified into the frame', () => {
    expect(streamErrorBody({ secret: 'x' })).toEqual({ code: 'internal', message: FIXED, retryable: true });
  });
});

describe('internal errors keep their message in the server log only (P25-7)', () => {
  const leaky = () => new Error("ENOENT: no such file or directory, open '/Users/someone/Library/Application Support/command-center/x.json'");

  it('the JSON path answers the fixed words and logs the message', async () => {
    const res = errorResponse(leaky());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'internal', message: FIXED, retryable: true });
    expect(JSON.stringify(body)).not.toMatch(/ENOENT|\/Users\//);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toBe('internal error');
    expect(String(logged[0]!.fields.message)).toMatch(/ENOENT: no such file/);
  });

  it('the stream path answers the same words and logs the message', () => {
    expect(JSON.stringify(streamErrorBody(leaky()))).not.toMatch(/ENOENT|\/Users\//);
    expect(logged.map((l) => [l.msg, /ENOENT/.test(String(l.fields.message))])).toEqual([['internal error', true]]);
  });

  it('an app-thrown internal AppError is also the fixed words to the client', async () => {
    const body = (await errorResponse(new AppError('internal', 'select * from work_items failed')).json()) as { error: { message: string } };
    expect(body.error.message).toBe(FIXED);
    expect(String(logged[0]!.fields.message)).toMatch(/select \* from work_items/);
  });
});
