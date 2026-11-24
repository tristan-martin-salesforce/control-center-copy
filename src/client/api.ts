/**
 * Tiny typed client over the route table. FE lanes call the API only through this file.
 *
 *   const today = await api('getToday');
 *   await api('patchItem', { params: { id }, body: { ifVersion: item.version, patch: { title } } });
 *   for await (const ev of apiStream('chat', { body: { text } })) { … }
 *
 * Failures throw ApiError (code / status / retryable / details). `queryKey()` gives TanStack keys whose
 * first element is the route's live topic, so src/client/live.ts can invalidate by topic.
 */
import {
  API_BASE,
  ApiErrorEnvelope,
  buildPath,
  routes,
  type ApiErrorCode,
  type JsonRouteKey,
  type RouteClientInput,
  type RouteKey,
  type RouteOutput,
  type StreamRouteKey,
} from '@/contract';
import { stripHtml } from '@/lib/error-text';
import { idsOfInput, noteLocalWrite } from './intent';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, status: number, retryable: boolean, details?: unknown) {
    // 2026-11-13 audit C6: a page (a proxy's sign-in page, a gateway's 502) never shows as markup
    super(stripHtml(message));
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }

  /** 409: the server's current entity, for rebase / "keep yours · take theirs". */
  get current(): unknown {
    return (this.details as { current?: unknown } | undefined)?.current;
  }
}

type AnyInput = { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };

export interface CallOptions {
  signal?: AbortSignal;
  /** Dev: force upstream_unavailable on this request (`?fail=1`). */
  fail?: boolean;
  /** Override the base URL (server components, scripts). Defaults to same-origin. */
  baseUrl?: string;
}

export function urlFor<K extends RouteKey>(key: K, input?: RouteClientInput<K>, opts: CallOptions = {}): string {
  const def = routes[key];
  const i = (input ?? {}) as AnyInput;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(i.query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  if (opts.fail) qs.set('fail', '1');
  const q = qs.toString();
  return `${opts.baseUrl ?? ''}${API_BASE}${buildPath(def.path, i.params)}${q ? `?${q}` : ''}`;
}

/** The body as JSON, or NOT_JSON (an HTML error page, a proxy's sign-in page, a dev server restarting). */
const NOT_JSON = Symbol('not-json');
async function readJsonBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return NOT_JSON;
  }
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/**
 * PKG R9: a response that isn't JSON is the app (or something in front of it) not answering as itself, so it reads
 * "upstream_unavailable" with a plain sentence, never `SyntaxError: Unexpected token '<'`.
 */
export function notJsonError(status: number): ApiError {
  return new ApiError('upstream_unavailable', `Command Center didn't answer as expected${status ? ` (HTTP ${status})` : ''}. It may be restarting; try again in a moment.`, status, true, { notJson: true });
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await readJsonBody(res);
  if (body === NOT_JSON) return notJsonError(res.status);
  const parsed = ApiErrorEnvelope.safeParse(body);
  if (parsed.success) {
    const e = parsed.data.error;
    return new ApiError(e.code, e.message, res.status, e.retryable, e.details);
  }
  return new ApiError(res.status >= 500 ? 'internal' : 'validation', `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, res.status, res.status >= 500);
}

let extraHeaders: () => Record<string, string> = () => ({});
/** Headers sent with every JSON call (MIN-27: the resume store's `x-cc-away-since`). */
export function setRequestHeaders(fn: () => Record<string, string>): void {
  extraHeaders = fn;
}

/** Call a JSON route. Throws ApiError on any non-2xx (and on network failure as upstream_unavailable). */
export async function api<K extends JsonRouteKey>(key: K, input?: RouteClientInput<K>, opts: CallOptions = {}): Promise<RouteOutput<K>> {
  const def = routes[key];
  const i = (input ?? {}) as AnyInput;
  // A write this tab makes: the ids it names leave lists as "mine" (src/client/intent.ts), not "changed elsewhere".
  if (def.method !== 'GET') noteLocalWrite(idsOfInput(i));
  let res: Response;
  try {
    res = await fetch(urlFor(key, input, opts), {
      method: def.method,
      headers: { ...extraHeaders(), ...(def.method === 'GET' ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' }) },
      body: def.method === 'GET' ? undefined : JSON.stringify(i.body ?? {}),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('upstream_unavailable', `Network error: ${(err as Error).message}`, 0, true);
  }
  if (!res.ok) throw await toApiError(res);
  const body = await readJsonBody(res);
  if (body === NOT_JSON) throw notJsonError(res.status);
  return body as RouteOutput<K>;
}

/** Call an SSE route (POST /chat) and iterate its events. */
export async function* apiStream<K extends StreamRouteKey>(key: K, input?: RouteClientInput<K>, opts: CallOptions = {}): AsyncGenerator<RouteOutput<K>> {
  const def = routes[key];
  const i = (input ?? {}) as AnyInput;
  const res = await fetch(urlFor(key, input, opts), {
    method: def.method,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: def.method === 'GET' ? undefined : JSON.stringify(i.body ?? {}),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw await toApiError(res);
  yield* parseSse<RouteOutput<K>>(res.body);
}

/** Minimal SSE parser: yields the JSON `data:` of each event (skips comments / hello). */
export async function* parseSse<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length || event === 'hello') continue;
        yield JSON.parse(data.join('\n')) as T;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** TanStack Query key: [topic, routeKey, input]. Invalidating [topic] refreshes every query of that topic. */
export function queryKey<K extends RouteKey>(key: K, input?: RouteClientInput<K>): readonly [string, K, unknown] {
  return [routes[key].topic, key, input ?? null] as const;
}
