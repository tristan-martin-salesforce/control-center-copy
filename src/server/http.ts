/**
 * Thin route-handler factory: parse with zod → call the DataSource → JSON or SSE → error envelope.
 * Every app/api/v1/**\/route.ts is generated from the route table and calls `handle(<routeKey>)`.
 */
import { allows, personaOf, ROUTE_GATES } from '@/personas';
import { z } from 'zod';
import { routes, type LiveHello, type RouteDef, type RouteKey } from '@/contract';
import { getDataSource, type DataSource } from './datasource';
import { AppError, appErrorFrom, clientErrorBody, internalLogFields } from './errors';
import { errorFields, logger, topFrame } from '@/lib/log';
import type { Logger } from 'pino';

/** API log lines (pino JSON, PKG R9): codes, routes and schema paths, never a body. Created on first use. */
let api: Logger | null = null;
const apiLog = (): Logger => (api ??= logger('api'));
/** A contract failure, by path and zod code (the schema's words, not the data). */
const issueFields = (issues: z.ZodIssue[]) => issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), code: i.code }));

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const VALIDATE_RESPONSES = process.env.CC_VALIDATE_RESPONSES !== '0';
const HEARTBEAT_MS = 15_000;

function parsePart(schema: z.ZodTypeAny, value: unknown, part: 'params' | 'query' | 'body') {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError('validation', `Invalid ${part}: ${r.error.issues.map((i) => `${i.path.join('.') || part} ${i.message}`).join('; ')}`, {
      part,
      issues: r.error.issues,
    });
  }
  return r.data;
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('validation', 'Body is not valid JSON');
  }
}

export function errorResponse(err: unknown): Response {
  // a database that is down reads as DEP.DB.DOWN in the catalog's words, not the raw ECONNREFUSED (PKG-5)
  const appErr = appErrorFrom(err);
  if (appErr.code === 'internal') logInternal(err);
  return Response.json({ error: clientErrorBody(err) }, { status: appErr.status, headers: { 'cache-control': 'no-store' } });
}

/** An `internal` error's message goes to the server log only (P25-7); the client gets the catalog's words. */
function logInternal(err: unknown): void {
  apiLog().error({ ...errorFields(err), ...internalLogFields(err), frame: topFrame(err) }, 'internal error');
}

function shouldFail(url: URL, def: RouteDef, ds: DataSource): boolean {
  if (def.dev) return false;
  if (url.searchParams.get('fail') === '1') return true;
  if (def.stream) return false;
  const rate = ds.failRate();
  return rate > 0 && Math.random() < rate;
}

function queryObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== 'fail') out[k] = v;
  });
  return out;
}

/** A stream's error frame body: the same envelope the JSON path answers with (SEC-13: never `String(err)`; P25-7). */
export const streamErrorBody = (err: unknown) => {
  if (appErrorFrom(err).code === 'internal') logInternal(err);
  return clientErrorBody(err);
};

const encoder = new TextEncoder();
function sseFrame(event: string, data: unknown, id?: number): Uint8Array {
  return encoder.encode(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseResponse(
  source: AsyncIterable<unknown>,
  opts: {
    eventName: (ev: unknown) => string;
    id?: (ev: unknown) => number | undefined;
    hello?: unknown;
    signal: AbortSignal;
    validate?: z.ZodTypeAny;
    /** Heartbeats as a named `ping` event the client can see (its watchdog reopens a silent stream), not a comment. */
    pingEvent?: boolean;
  },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(opts.pingEvent ? sseFrame('ping', { at: Date.now() }) : encoder.encode(`: ping ${Date.now()}\n\n`));
      }, HEARTBEAT_MS);
      opts.signal.addEventListener('abort', close);
      if (opts.hello !== undefined) controller.enqueue(sseFrame('hello', opts.hello));
      try {
        for await (const ev of source) {
          if (closed) break;
          if (opts.validate && VALIDATE_RESPONSES) {
            const r = opts.validate.safeParse(ev);
            if (!r.success) apiLog().error({ issues: issueFields(r.error.issues) }, 'stream event failed contract validation');
          }
          controller.enqueue(sseFrame(opts.eventName(ev), ev, opts.id?.(ev)));
        }
      } catch (err) {
        if (!closed) {
          controller.enqueue(sseFrame('error', { type: 'error', error: streamErrorBody(err) }));
        }
      } finally {
        close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** Build the Next.js route handler for one route key. */
export function handle<K extends RouteKey>(key: K) {
  const def: RouteDef = routes[key];
  return async function handler(req: Request, ctx: RouteContext): Promise<Response> {
    try {
      const url = new URL(req.url);
      const ds = getDataSource();
      if (shouldFail(url, def, ds)) {
        throw new AppError('upstream_unavailable', 'Simulated upstream failure (dev failure switch)', { simulated: true });
      }
      if (def.dev && ds.kind !== 'mock') throw new AppError('not_found', 'Dev routes exist only in mock mode');

      // MIN-27: the browser's "when the user last left" (ms); the data source moves its since-you-left start to it
      const away = Number(req.headers.get('x-cc-away-since'));
      if (Number.isFinite(away) && away > 0 && ds.notePresence) await ds.notePresence(away).catch((err) => apiLog().warn(errorFields(err), 'notePresence failed'));

      const input: Record<string, unknown> = {};
      if (def.params) input.params = parsePart(def.params, (await ctx?.params) ?? {}, 'params');
      if (def.query) input.query = parsePart(def.query, queryObject(url), 'query');
      if (def.body) input.body = parsePart(def.body, await readJson(req), 'body');

      const method = ds[key] as unknown as (i: unknown) => unknown;

      // D-55: a change on a feature the persona has not activated (ROUTE_GATES: VDP, missed opps) is refused; its
      // reads stay answerable (they return what the mirror holds), but no daily surface calls them.
      const gate = ROUTE_GATES[key];
      if (gate && def.method !== 'GET' && !allows(personaOf(await ds.getSettings({} as never)), gate)) {
        throw new AppError('validation', `${gate.feature ?? gate.connector} is not in your role's preconfiguration: activate it in Settings ▸ Role & rules`, { inactive: gate });
      }

      if (def.stream) {
        const source = method.call(ds, { ...input, signal: req.signal }) as AsyncIterable<unknown>;
        if (key === 'events') {
          const hello: LiveHello = { at: new Date().toISOString(), seq: 0, dataSource: ds.kind };
          return sseResponse(source, { eventName: () => 'live', id: (ev) => (ev as { seq: number }).seq, hello, signal: req.signal, validate: def.response, pingEvent: true });
        }
        return sseResponse(source, { eventName: (ev) => (ev as { type: string }).type, signal: req.signal, validate: def.response });
      }

      const out = await (method.call(ds, input) as Promise<unknown>);
      let body = out;
      if (VALIDATE_RESPONSES) {
        const r = def.response.safeParse(out);
        if (!r.success) {
          apiLog().error({ route: key, issues: issueFields(r.error.issues) }, 'response failed contract validation');
          throw new AppError('internal', `${key}: response failed contract validation`, { issues: r.error.issues.slice(0, 10) }, false);
        }
        body = r.data;
      }
      return Response.json(body, { headers: { 'cache-control': 'no-store' } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
