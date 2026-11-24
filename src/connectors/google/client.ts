/**
 * Direct MCP client for devbar's `google_workspace_readonly` server (brief 09 §2, §7).
 *
 * - Transport: streamable HTTP at http://localhost:13316/proxy/mcp/server/google_workspace_readonly/mcp (no headers;
 *   devbar's daemon owns auth). No LLM is involved: the worker calls the 36 read tools directly.
 * - One in-flight call at a time (one daemon serves everything; brief 09 §5.9).
 * - Lazy connect, reconnect on connection-level failure, per-call timeout.
 * - **Read-tool allowlist enforced in code.** Anything not listed throws `DisallowedToolError` before a byte is sent.
 * - Never logs or stores tokens; this client never sees any (devbar injects them).
 */
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ConnectorHealthProbe } from '@/scanner/types';
import { reasonOf } from '@/errors/render';
import { Mutex, sleep, throwIfAborted, withTimeout, type Clock, systemClock } from '../util';
import { GATEWAY_DOWN, GATEWAY_DOWN_WORDS, GATEWAY_ERROR, GATEWAY_ERROR_WORDS, htmlPageText } from './gateway';

export { GATEWAY_DOWN, GATEWAY_DOWN_WORDS, GATEWAY_ERROR, GATEWAY_ERROR_WORDS, htmlPageText } from './gateway';

export const GOOGLE_RO_URL = 'http://localhost:13316/proxy/mcp/server/google_workspace_readonly/mcp';

/**
 * Read tools the scanner may call. The server itself only exposes reads (36 tools), but the allowlist is the
 * second lock: a new or renamed tool on the server is refused until someone adds it here on purpose.
 *
 * Deliberately NOT listed even though the server exposes them: `get_drive_file_download_url`,
 * `get_drive_shareable_link`, `check_drive_file_public_access`, `get_drive_file_permissions` (sharing surface,
 * nothing the scanner needs), `get_page_thumbnail`, `debug_table_structure`.
 */
export const GOOGLE_READ_TOOLS: ReadonlySet<string> = new Set([
  // Gmail
  'search_gmail_messages',
  'get_gmail_message_content',
  'get_gmail_messages_content_batch',
  'get_gmail_thread_content',
  'get_gmail_threads_content_batch',
  'list_gmail_labels',
  // Calendar
  'get_events',
  'list_calendars',
  'query_freebusy',
  // Drive
  'search_drive_files',
  'list_drive_items',
  'get_drive_file_content',
  // Docs
  'search_docs',
  'list_docs_in_folder',
  'get_doc_content',
  'get_doc_as_markdown',
  'inspect_doc_structure',
  'list_document_comments',
  // Slides
  'get_presentation',
  'get_page',
  'list_presentation_comments',
  // Sheets
  'list_spreadsheets',
  'get_spreadsheet_info',
  'read_sheet_values',
  'list_spreadsheet_comments',
  // Tasks
  'list_task_lists',
  'get_task_list',
  'list_tasks',
  'get_task',
]);

/** Name fragments that always indicate a write. Belt and braces: checked even if someone adds a tool to the set. */
const WRITE_FRAGMENT = /(^|_)(send|draft|create|update|delete|trash|label|share|manage|modify|insert|batch_update|copy|move|set|forward|reply|import|publish|merge|write|append|clear|format|find_and_replace|respond)(_|$)/;

export class DisallowedToolError extends Error {
  constructor(public readonly tool: string) {
    super(`google client: tool "${tool}" is not on the read-only allowlist`);
    this.name = 'DisallowedToolError';
  }
}

export function assertReadTool(tool: string): void {
  if (!GOOGLE_READ_TOOLS.has(tool) || WRITE_FRAGMENT.test(tool.replace(/^get_|^list_|^search_|^query_|^read_|^inspect_/, ''))) {
    throw new DisallowedToolError(tool);
  }
}

// ---------------------------------------------------------------------------------------------
// Error classification (brief 09 §5/§7)
// ---------------------------------------------------------------------------------------------

export type GoogleErrorClass = NonNullable<ConnectorHealthProbe['errorClass']>;

export interface GoogleErrorInfo {
  errorClass: GoogleErrorClass;
  /** Short, token-free signature for logs/health. */
  signature: string;
  /** The error is about one object (file missing, no access), not the connector. */
  objectScoped?: boolean;
  /** The daemon itself is unreachable. */
  daemonDown?: boolean;
  /** CONN-5: the devbar program is not installed (not the same as its daemon being down). */
  devbarMissing?: boolean;
}

const SIGS: Array<{ re: RegExp; info: Omit<GoogleErrorInfo, 'signature'>; sig: string }> = [
  // first: a maintenance page can carry any words (a status code, "authentication" in a footer)
  { re: GATEWAY_DOWN, info: { errorClass: 'transient' }, sig: 'gateway_down' },
  // CONN-5: the program itself is missing (spawn ENOENT): installing it is the fix, not restarting a daemon
  { re: /spawn devbar ENOENT|devbar: (?:command )?not found|\[devbar_missing\]/i, info: { errorClass: 'config', devbarMissing: true }, sig: 'devbar_missing' },
  { re: /invalid_grant|does not have a valid token|not authenticated|unauthenticated|authentication (?:is )?required|re-?authenticat|token (?:has )?expired|unauthorized_client|\b401\b|Request had invalid authentication credentials/i, info: { errorClass: 'auth' }, sig: 'auth' },
  // E5: any other failed POST to the gateway is its outage (after the sign-in signature: a sign-in failure stays auth)
  { re: GATEWAY_ERROR, info: { errorClass: 'transient' }, sig: 'gateway_error' },
  { re: /ECONNREFUSED|connect ECONNREFUSED|socket hang up.*13316/i, info: { errorClass: 'transient', daemonDown: true }, sig: 'daemon_down' },
  { re: /rateLimitExceeded|userRateLimitExceeded|quota|\b429\b|too many requests|RESOURCE_EXHAUSTED/i, info: { errorClass: 'rate_limited' }, sig: 'rate_limited' },
  { re: /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timeout|backendError|\b5\d\d\b|service unavailable|internal error|deadline exceeded/i, info: { errorClass: 'transient' }, sig: 'transient' },
  { re: /\b404\b|not ?found|file not found|notFound/i, info: { errorClass: 'unknown', objectScoped: true }, sig: 'not_found' },
  { re: /\b403\b|forbidden|insufficient(?:Permission| permissions)|does not have permission|permission denied|cannot access|no access/i, info: { errorClass: 'unknown', objectScoped: true }, sig: 'no_access' },
  // A 400 from the Google API on one file's read (an uploaded .xlsx opened through the Sheets API, an unsupported
  // document): about that object, not the connector. Before, one such spreadsheet failed every Drive reconcile run,
  // which held the connector and blocked its polls (DRV-2).
  { re: /HttpError 400\b|FAILED_PRECONDITION|not supported for this document/i, info: { errorClass: 'unknown', objectScoped: true }, sig: 'bad_request' },
  { re: /tool .* not found|unknown tool|method not found|invalid (?:params|arguments)|validation error/i, info: { errorClass: 'config' }, sig: 'config' },
];

export function classifyGoogleError(err: unknown): GoogleErrorInfo {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const s of SIGS) if (s.re.test(text)) return { ...s.info, signature: s.sig };
  return { errorClass: 'unknown', signature: 'unknown' };
}

export class GoogleCallError extends Error {
  constructor(
    public readonly tool: string,
    public readonly info: GoogleErrorInfo,
    detail: string,
  ) {
    // Detail is truncated and never includes arguments (which may name customers). An HTML error page is reduced
    // to its text first: its first 300 characters were all markup, so the cause never showed.
    super(`google ${tool} failed [${info.signature}]: ${htmlPageText(detail).slice(0, 300)}`);
    this.name = 'GoogleCallError';
  }
}

// ---------------------------------------------------------------------------------------------
// Re-auth: what the UI should do (brief 09 §7). Google can re-auth fully in-app.
// ---------------------------------------------------------------------------------------------

export type GoogleReauthReason = 'connector_disconnected' | 'devbar_signed_out' | 'daemon_down';

export const DEVBAR_CONNECTOR_ID = 'google-workspace-readonly';

/**
 * Returns the action the UI should offer. The app runs `command` itself (reauth kind `in_app`): none of these
 * commands need a terminal; `connect` opens the browser and polls until the OAuth completes.
 */
export function googleReauthAction(reason: GoogleReauthReason): NonNullable<ConnectorHealthProbe['reauth']> {
  switch (reason) {
    case 'connector_disconnected':
      return {
        kind: 'in_app',
        command: `devbar mcpgw connectors connect ${DEVBAR_CONNECTOR_ID}`,
        instructions: 'Reconnect Google: opens your browser, then this page updates by itself.',
      };
    case 'devbar_signed_out':
      return { kind: 'in_app', command: 'devbar auth login', instructions: 'Sign in to devbar (SSO), then Google reconnects.' };
    case 'daemon_down':
      return { kind: 'in_app', command: 'devbar daemon start', instructions: 'Restart the devbar daemon.' };
  }
}

// ---------------------------------------------------------------------------------------------
// devbar diagnostics (no LLM, no tokens printed). Used only to explain a failure.
// ---------------------------------------------------------------------------------------------

export interface DevbarDiagnosis {
  /** CONN-5: false when the devbar program is not on this Mac (ENOENT); null when unknown. */
  installed?: boolean | null;
  daemonUp: boolean | null;
  devbarAuthenticated: boolean | null;
  connectorState: string | null;
  connectorStatusMessage?: string;
}

export type ExecJson = (args: string[], timeoutMs: number) => Promise<unknown>;

const defaultExecJson: ExecJson = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('devbar', args, { timeout: timeoutMs, maxBuffer: 2_000_000, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });

/** The exec failed because the program is not installed (spawn ENOENT), not because it answered badly. */
export const isMissingProgram = (err: unknown): boolean => {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === 'ENOENT' || (typeof e?.message === 'string' && /\bENOENT\b|command not found/.test(e.message));
};

export async function diagnoseDevbar(exec: ExecJson = defaultExecJson): Promise<DevbarDiagnosis> {
  const d: DevbarDiagnosis = { installed: null, daemonUp: null, devbarAuthenticated: null, connectorState: null };
  try {
    const s = (await exec(['mcpgw', 'status', '--json'], 8000)) as { listener_ok?: boolean; status?: string };
    d.installed = true;
    d.daemonUp = Boolean(s.listener_ok) && s.status === 'running';
  } catch (err) {
    // CONN-5: "not installed" is not "daemon not listening" (the Restart button cannot fix a missing program)
    if (isMissingProgram(err)) {
      d.installed = false;
      return d;
    }
    d.installed = true;
    d.daemonUp = false;
  }
  try {
    const a = (await exec(['auth', 'status', '--json'], 8000)) as { authenticated?: boolean };
    d.devbarAuthenticated = a.authenticated === true;
  } catch {
    d.devbarAuthenticated = null;
  }
  try {
    const c = (await exec(['mcpgw', 'connectors', 'list', '--json'], 8000)) as { providers?: Array<{ name?: string; id?: string; state?: string; statusMessage?: string }> };
    const p = c.providers?.find((x) => /google workspace read ?only/i.test(x.name ?? x.id ?? ''));
    if (p) {
      d.connectorState = p.state ?? null;
      // statusMessage can mention the user name only; no token material is ever in it.
      d.connectorStatusMessage = p.statusMessage?.replace(/User \S+ /, 'User ');
    }
  } catch {
    /* leave null */
  }
  return d;
}

export function probeFromDiagnosis(d: DevbarDiagnosis, now: Date): ConnectorHealthProbe {
  const checkedAt = now.toISOString();
  // the details are the error catalog's phrases (DEP.DEVBAR.*, AUTH.GOOGLE.*), so Health reads them back as codes
  if (d.installed === false) {
    return { state: 'down', errorClass: 'config', detail: reasonOf('DEP.DEVBAR.MISSING'), reauth: { kind: 'instructions', instructions: 'Install devbar from the internal developer portal, then run devbar auth login (README ▸ Troubleshooting: Google (devbar)).' }, checkedAt };
  }
  if (d.daemonUp === false) {
    return { state: 'down', errorClass: 'transient', detail: reasonOf('DEP.DEVBAR.DAEMON_DOWN'), reauth: googleReauthAction('daemon_down'), checkedAt };
  }
  if (d.devbarAuthenticated === false) {
    return { state: 'auth_required', errorClass: 'auth', detail: reasonOf('AUTH.GOOGLE.DEVBAR_SIGNED_OUT'), reauth: googleReauthAction('devbar_signed_out'), checkedAt };
  }
  if (d.connectorState && d.connectorState !== 'connected') {
    return { state: 'auth_required', errorClass: 'auth', detail: reasonOf('AUTH.GOOGLE.CONNECTOR_MISSING'), reauth: googleReauthAction('connector_disconnected'), checkedAt };
  }
  return { state: 'degraded', errorClass: 'unknown', detail: 'Google call failed but devbar looks healthy', checkedAt };
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

/** The narrow interface fetchers depend on, so tests can swap in a fixture-backed fake. */
export interface GoogleTools {
  /** Calls one allowlisted read tool and returns its text payload. Throws GoogleCallError / DisallowedToolError. */
  call(tool: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
  health(): Promise<ConnectorHealthProbe>;
}

export interface GoogleClientOptions {
  url?: string;
  /** Per-call timeout. Drive/Slides reads took up to 6.3 s in brief 09. */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Retries for transient failures (connection reset, 5xx). Auth/config errors never retry. */
  maxRetries?: number;
  clock?: Clock;
  exec?: ExecJson;
  /** Test seam. */
  clientFactory?: () => { client: Pick<Client, 'connect' | 'callTool' | 'close' | 'listTools'>; };
}

export class GoogleWorkspaceClient implements GoogleTools {
  private client: Pick<Client, 'connect' | 'callTool' | 'close' | 'listTools'> | null = null;
  private connecting: Promise<void> | null = null;
  private readonly mutex = new Mutex();
  private readonly o: Required<Pick<GoogleClientOptions, 'url' | 'timeoutMs' | 'connectTimeoutMs' | 'maxRetries'>> & GoogleClientOptions;

  constructor(opts: GoogleClientOptions = {}) {
    this.o = { url: GOOGLE_RO_URL, timeoutMs: 30_000, connectTimeoutMs: 8_000, maxRetries: 2, ...opts };
  }

  private newClient() {
    if (this.o.clientFactory) return this.o.clientFactory().client;
    const c = new Client({ name: 'command-center-scanner', version: '0.1.0' });
    // The transport is attached in connect().
    return c;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const c = this.newClient();
        const transport = new StreamableHTTPClientTransport(new URL(this.o.url));
        await withTimeout(c.connect(transport), this.o.connectTimeoutMs, 'google mcp connect');
        this.client = c;
      })().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  private async dropClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    try {
      await c?.close();
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    await this.dropClient();
  }

  async call(tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
    assertReadTool(tool); // throws before anything is sent
    return this.mutex.run(async () => {
      let attempt = 0;
      for (;;) {
        throwIfAborted(opts.signal);
        try {
          await this.ensureConnected();
          const res = await withTimeout(
            this.client!.callTool({ name: tool, arguments: args }, undefined, { signal: opts.signal }),
            opts.timeoutMs ?? this.o.timeoutMs,
            `google ${tool}`,
          );
          const text = ((res.content as Array<{ type: string; text?: string }> | undefined) ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
          if (res.isError) throw new GoogleCallError(tool, classifyGoogleError(text), text);
          return text;
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') throw err;
          if (err instanceof DisallowedToolError) throw err;
          const wrapped = err instanceof GoogleCallError ? err : new GoogleCallError(tool, classifyGoogleError(err), err instanceof Error ? err.message : String(err));
          const retryable = (wrapped.info.errorClass === 'transient' || wrapped.info.errorClass === 'rate_limited') && !wrapped.info.daemonDown;
          if (!(err instanceof GoogleCallError)) await this.dropClient(); // connection-level failure: reconnect next time
          if (!retryable || attempt >= this.o.maxRetries) throw wrapped;
          attempt++;
          await sleep(500 * 2 ** attempt, opts.signal);
        }
      }
    });
  }

  /** Verifies the daemon, the allowlist against the live tool list, and one cheap authenticated read. */
  async health(): Promise<ConnectorHealthProbe> {
    const clock = this.o.clock ?? systemClock;
    try {
      const text = await this.call('list_calendars', {}, { timeoutMs: 15_000 });
      if (!text) return { state: 'degraded', errorClass: 'unknown', detail: 'empty response from list_calendars', checkedAt: clock().toISOString() };
      return { state: 'ok', checkedAt: clock().toISOString() };
    } catch (err) {
      const info = err instanceof GoogleCallError ? err.info : classifyGoogleError(err);
      const detail = `${info.signature}`;
      // the gateway's outage, not devbar or your sign-in: say so, and offer no re-auth
      if (info.signature === 'gateway_down' || info.signature === 'gateway_error') return { state: 'degraded', errorClass: 'transient', detail: info.signature === 'gateway_down' ? GATEWAY_DOWN_WORDS : GATEWAY_ERROR_WORDS, checkedAt: clock().toISOString() };
      if (info.errorClass === 'auth' || info.daemonDown || info.devbarMissing || info.errorClass === 'transient') {
        const diag = await diagnoseDevbar(this.o.exec);
        const probe = probeFromDiagnosis(diag, clock());
        if (probe.state !== 'degraded') return probe;
        return { state: info.errorClass === 'auth' ? 'auth_required' : 'degraded', errorClass: info.errorClass, detail, reauth: info.errorClass === 'auth' ? googleReauthAction('connector_disconnected') : undefined, checkedAt: clock().toISOString() };
      }
      return { state: 'degraded', errorClass: info.errorClass, detail, checkedAt: clock().toISOString() };
    }
  }

  /** Lists server tools and returns any the allowlist does not know (logged as "disallowed new tool"; brief 09 §5.10). */
  async unknownServerTools(): Promise<string[]> {
    await this.ensureConnected();
    const res = await this.client!.listTools();
    return res.tools.map((t) => t.name).filter((n) => !GOOGLE_READ_TOOLS.has(n));
  }
}
