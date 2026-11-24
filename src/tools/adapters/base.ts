/**
 * Shared adapter contract and plumbing (R-UI-13).
 *
 * Invariants enforced here, not left to each adapter:
 *  - HTTP only to loopback hosts (tools are local apps; nothing leaves the machine).
 *  - Tools whose endpoint can call external services require `confirm: true`.
 *  - Errors are classified: not_running | bad_input | failed.
 *  - Every run has a timeout and can be cancelled.
 */
import os from 'node:os';
import path from 'node:path';
import { isLoopbackHost, validateInput, type ToolManifest } from '../manifest';

export type ToolErrorKind = 'not_running' | 'bad_input' | 'failed';

export class ToolError extends Error {
  constructor(
    public readonly kind: ToolErrorKind,
    message: string,
    /** Finer-grained machine code: timeout, cancelled, confirm_required, non_loopback, http_5xx ... */
    public readonly code?: string,
    /** For not_running: the command to show the user (never executed by the adapter). */
    public readonly startCommand?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ProgressEvent {
  pct?: number;
  message: string;
  at: string;
}

export interface ToolLink { url: string; label: string }
export interface ToolArtifact { path: string; label: string; mime?: string }
export interface ToolResult {
  links: ToolLink[];
  artifacts: ToolArtifact[];
  summary: string;
  /** Present only on dry runs: the steps that would have been performed. */
  plan?: string[];
}

export interface HealthResult {
  ok: boolean;
  state: 'up' | 'down' | 'degraded';
  detail: string;
  /** Command string to start the tool when it is down. */
  startCommand?: string;
  checkedAt: string;
}

export interface StartOptions {
  /** Required for tools whose manifest says privacy.requiresConfirm. */
  confirm?: boolean;
  /** Validate and return the plan without any network or process activity. */
  dryRun?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Where CLI tools write outputs. Defaults to ~/Library/Application Support/command-center/tool-runs/<id>-<ts>. */
  runDir?: string;
}

export interface ToolRun {
  events: AsyncIterable<ProgressEvent>;
  done: Promise<ToolResult>;
  cancel(): void;
}

export interface ToolAdapter {
  readonly manifest: ToolManifest;
  health(opts?: { fetch?: typeof fetch; signal?: AbortSignal }): Promise<HealthResult>;
  start(input: Record<string, unknown>, opts?: StartOptions): ToolRun;
}

export const nowIso = () => new Date().toISOString();

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Tiny `{{a.b}}` mustache for urlTemplate / pathTemplate. Unknown keys render as empty. */
export function render(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    let cur: unknown = ctx;
    for (const part of key.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    return cur === undefined || cur === null ? '' : String(cur);
  });
}

export function assertLoopback(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new ToolError('bad_input', `invalid url: ${url}`, 'bad_url'); }
  if (!isLoopbackHost(u.hostname)) throw new ToolError('failed', `refusing non-loopback host ${u.hostname}`, 'non_loopback');
  return u;
}

/** Network errors from fetch mean the port is closed: classify as not_running. */
function isConnectionError(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; code?: string; name?: string; message?: string };
  const code = e?.cause?.code ?? e?.code;
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)) return true;
  return e?.name === 'TypeError' && /fetch failed/i.test(e.message ?? '');
}

export interface HttpCtx { fetch: typeof fetch; signal: AbortSignal; startCommand?: string }

/** fetch with loopback guard, abort support and error classification. */
export async function toolFetch(ctx: HttpCtx, url: string, init: RequestInit = {}): Promise<Response> {
  assertLoopback(url);
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal.aborted) throw abortError(ctx.signal);
    if (isConnectionError(err)) throw new ToolError('not_running', `tool is not running (${new URL(url).host})`, 'econnrefused', ctx.startCommand);
    throw new ToolError('failed', `request failed: ${(err as Error).message}`, 'network');
  }
  if (res.status >= 400) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new ToolError(res.status < 500 ? 'bad_input' : 'failed', `${init.method ?? 'GET'} ${new URL(url).pathname} -> ${res.status}: ${body}`, `http_${res.status}`);
  }
  return res;
}

export function abortError(signal: AbortSignal): ToolError {
  const reason = signal.reason;
  if (reason instanceof ToolError) return reason;
  return new ToolError('failed', 'run cancelled', 'cancelled');
}

// ------------------------------------------------------------ stream readers

async function* chunks(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield dec.decode(value, { stream: true });
    }
    const tail = dec.decode();
    if (tail) yield tail;
  } catch (err) {
    if (signal.aborted) throw abortError(signal);
    throw new ToolError('failed', `stream broke: ${(err as Error).message}`, 'stream');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw abortError(signal);
}

export async function* readNdjson(res: Response, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  let buf = '';
  for await (const c of chunks(res, signal)) {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield parseJson(line);
    }
  }
  if (buf.trim()) yield parseJson(buf.trim());
}

function parseJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { throw new ToolError('failed', `malformed stream line: ${s.slice(0, 80)}`, 'malformed_stream'); }
}

export interface SseEvent { event: string; data: unknown }

export async function* readSse(res: Response, signal: AbortSignal): AsyncGenerator<SseEvent> {
  let buf = '';
  const flush = (block: string): SseEvent | undefined => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return undefined;
    const raw = data.join('\n');
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep raw text */ }
    return { event, data: parsed };
  };
  for await (const c of chunks(res, signal)) {
    buf += c.replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = flush(buf.slice(0, i));
      buf = buf.slice(i + 2);
      if (ev) yield ev;
    }
  }
  if (buf.trim()) { const ev = flush(buf); if (ev) yield ev; }
}

// ----------------------------------------------------------------- run plumbing

export interface RunCtx {
  emit(message: string, pct?: number): void;
  signal: AbortSignal;
  fetch: typeof fetch;
  runDir?: string;
}

/** Wrap an async body into a ToolRun with buffered events, timeout and cancel. */
export function createRun(body: (ctx: RunCtx) => Promise<ToolResult>, opts: StartOptions, defaultTimeoutMs: number): ToolRun {
  const ac = new AbortController();
  const buffer: ProgressEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };

  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const timer = setTimeout(() => ac.abort(new ToolError('failed', `timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout')), timeoutMs);
  const ext = opts.signal;
  const onExt = () => ac.abort(new ToolError('failed', 'run cancelled', 'cancelled'));
  if (ext) { if (ext.aborted) onExt(); else ext.addEventListener('abort', onExt, { once: true }); }

  const emit = (message: string, pct?: number) => {
    const ev: ProgressEvent = { message, at: nowIso() };
    if (pct !== undefined) ev.pct = Math.max(0, Math.min(100, Math.round(pct)));
    buffer.push(ev);
    notify();
  };

  const done = (async () => {
    try {
      return await body({ emit, signal: ac.signal, fetch: opts.fetch ?? fetch, runDir: opts.runDir });
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (ac.signal.aborted) throw abortError(ac.signal);
      throw new ToolError('failed', (err as Error).message, 'unexpected');
    } finally {
      clearTimeout(timer);
      ext?.removeEventListener('abort', onExt);
      finished = true;
      notify();
    }
  })();
  done.catch(() => {}); // callers that only iterate events must not trigger unhandled rejections

  async function* events(): AsyncGenerator<ProgressEvent> {
    let i = 0;
    for (;;) {
      while (i < buffer.length) yield buffer[i++]!;
      if (finished) return;
      await new Promise<void>((r) => { wake = r; if (i < buffer.length || finished) r(); });
    }
  }

  return { events: events(), done, cancel: () => ac.abort(new ToolError('failed', 'run cancelled', 'cancelled')) };
}

// -------------------------------------------------------------- base adapter

export abstract class BaseAdapter implements ToolAdapter {
  constructor(public readonly manifest: ToolManifest) {}

  protected get startCommand(): string | undefined {
    const l = this.manifest.lifecycle;
    if (!l) return undefined;
    const env = Object.entries(l.env).map(([k, v]) => `${k}=${v}`).join(' ');
    return `cd ${l.cwd} && ${env ? env + ' ' : ''}${l.startCommand}`;
  }

  /** Steps that would run, for dry runs. */
  protected abstract plan(input: Record<string, unknown>): string[];
  protected abstract execute(input: Record<string, unknown>, ctx: RunCtx): Promise<ToolResult>;

  async health(opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<HealthResult> {
    const h = this.manifest.health;
    const checkedAt = nowIso();
    if (h.type !== 'http') return { ok: true, state: 'up', detail: `no http health check (${h.type})`, checkedAt };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), h.timeoutMs);
    opts.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      assertLoopback(h.url);
      const res = await (opts.fetch ?? fetch)(h.url, { method: 'GET', signal: ac.signal });
      await res.body?.cancel().catch(() => {});
      if (res.status === h.expectStatus) return { ok: true, state: 'up', detail: `GET ${new URL(h.url).pathname} -> ${res.status}`, checkedAt };
      return { ok: false, state: 'degraded', detail: `GET ${new URL(h.url).pathname} -> ${res.status} (expected ${h.expectStatus})`, startCommand: this.startCommand, checkedAt };
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, state: 'down', detail: err.message, checkedAt };
      return { ok: false, state: 'down', detail: ac.signal.aborted ? `timed out after ${h.timeoutMs}ms` : 'not running', startCommand: this.startCommand, checkedAt };
    } finally {
      clearTimeout(t);
    }
  }

  start(rawInput: Record<string, unknown>, opts: StartOptions = {}): ToolRun {
    const m = this.manifest;
    const defaultTimeout = m.estimatedDuration.maxSec * 2 * 1000;
    return createRun(async (ctx) => {
      const v = validateInput(m, rawInput);
      if (!v.ok) throw new ToolError('bad_input', v.errors.join('; '), 'invalid_input');
      if (m.privacy.requiresConfirm && opts.confirm !== true) {
        throw new ToolError('bad_input', `${m.name} can call external services; pass confirm: true after the user approves`, 'confirm_required');
      }
      if (opts.dryRun) {
        const plan = this.plan(v.value);
        ctx.emit('dry run: nothing executed', 100);
        return { links: [], artifacts: [], summary: `Dry run of ${m.name}: ${plan.length} step(s), nothing executed.`, plan };
      }
      ctx.emit(`checking ${m.name} health`);
      const h = await this.health({ fetch: ctx.fetch, signal: ctx.signal });
      if (h.state === 'down') throw new ToolError('not_running', `${m.name} is not running (${h.detail})`, 'health_failed', this.startCommand);
      if (!h.ok) throw new ToolError('failed', `${m.name} is unhealthy (${h.detail})`, 'health_degraded');
      return this.execute(v.value, ctx);
    }, opts, defaultTimeout);
  }
}
