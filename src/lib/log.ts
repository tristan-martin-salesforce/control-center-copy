/**
 * One structured log line format for the server and the worker (PKG R9): pino JSON lines on stdout, which the service
 * wrapper (scripts/ops/run-service.mjs) already writes to the rotated web.log / worker.log in ~/Library/Logs/
 * command-center (dev: the terminal). Tenet: Local data, privacy-safe logs. Ids, codes, statuses and timings only;
 * `redact` blanks credential-shaped keys (authorization, cookie, token, password, api keys, secrets, OAuth tokens, any
 * headers object, up to three objects down) even when a caller passes one by mistake, and `safeLogText` scrubs
 * token-shaped text from messages and string fields (W0-6). Writes are synchronous, so a line is on disk before a crash handler exits.
 *
 *   const log = logger('worker');
 *   log.info({ jobId, code }, 'job finished');
 */
import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Credential-shaped keys never written (W0-6). pino matches keys case-sensitively and has no recursive wildcard, so
 * each key is listed in the spellings callers use and at the top level and up to three objects down
 * (`token`, `*.token`, `*.*.token`, `*.*.*.token`). Every `headers` object is blanked whole.
 */
export const REDACT_KEYS = [
  'authorization', 'Authorization', 'cookie', 'Cookie', 'set-cookie', 'Set-Cookie', 'token', 'Token', 'password', 'Password',
  'apiKey', 'api_key', 'apikey', 'ApiKey', 'x-api-key', 'X-Api-Key', 'X-API-Key', 'secret', 'Secret', 'clientSecret', 'client_secret',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'idToken', 'id_token', 'headers', 'Headers',
] as const;

const keyPath = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `["${k}"]`);
const DEPTHS = ['', '*', '*.*', '*.*.*'];

export const REDACT_PATHS: string[] = DEPTHS.flatMap((prefix) => REDACT_KEYS.map((k) => (prefix ? `${prefix}${keyPath(k)}` : keyPath(k).replace(/^\./, ''))));

/** Token shapes scrubbed from free text (a log message, a string field): Anthropic / Slack keys, bearer values, `token=`. */
const TEXT_RULES: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bxox[abprsc]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\bxapp-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted]'],
  [/\b((?:access_|refresh_|id_|api_|session_)?(?:token|key|secret|sid)=)[A-Za-z0-9+/_.~%-]{20,}={0,2}/gi, '$1[redacted]'],
  // SEC-1: VDP's Okta gateway cookie and PAT, Google OAuth access tokens, a password in a connection URL
  [/\b(central_proxy_session=)[^;\s"'&]{8,}/g, '$1[redacted]'],
  [/\bvdp_pat_[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1[redacted]@'],
];

/** Free text with token-shaped runs replaced by `[redacted]` (log messages, string fields). Never throws. */
export function safeLogText(text: string): string {
  if (typeof text !== 'string' || text.length < 8) return text;
  let out = text;
  for (const [re, to] of TEXT_RULES) out = out.replace(re, to);
  return out;
}

/** String values of a log object (plain objects, any depth pino hands us) through safeLogText; keys are pino's redact. */
function scrubObject(o: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return o;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(o)) {
    let next: unknown = v;
    if (typeof v === 'string') next = safeLogText(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) next = scrubObject(v as Record<string, unknown>, depth + 1);
    if (next !== v) (out ??= { ...o })[k] = next;
  }
  return out ?? o;
}

export interface LoggerOptions {
  /** Where lines go (tests pass a stream). Default: stdout, synchronously. */
  destination?: DestinationStream;
  level?: string;
}

/** A logger for one component ("worker", "api"); every line carries `component`. */
export function logger(component: string, opts: LoggerOptions = {}): Logger {
  return pino(
    {
      level: opts.level ?? process.env.CC_LOG_LEVEL ?? 'info',
      base: { component },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }), log: (o) => scrubObject(o) },
      hooks: {
        // the message (and any printf-style args) through safeLogText: a token pasted into a message is never written
        logMethod(args, method) {
          method.apply(this, args.map((a) => (typeof a === 'string' ? safeLogText(a) : a)) as Parameters<typeof method>);
        },
      },
    },
    opts.destination ?? pino.destination({ dest: 1, sync: true }),
  );
}

/**
 * The first stack frame, as "fn (src/worker/index.ts:120:7)": paths are cut to the repo (or `node_modules/…`), so
 * neither the user's home folder nor the message (only the frame line is read) reaches a log or an event.
 */
export function topFrame(err: unknown): string | null {
  const stack = typeof (err as { stack?: unknown } | null)?.stack === 'string' ? (err as { stack: string }).stack : '';
  const line = stack.split('\n').find((l) => /^\s+at /.test(l));
  if (!line) return null;
  const frame = line
    .trim()
    .replace(/^at /, '')
    .replace(/file:\/\//g, '')
    .replace(/(\(|^)[^()\s]*?\/((?:src|app|scripts|tests|node_modules)\/)/, '$1$2')
    .replace(/(\(|^)\/(?:Users|home)\/[^/]+\/[^()\s]*\/([^/()\s]+:\d+:\d+)/, '$1…/$2');
  return frame.slice(0, 200);
}

/** The error's class and code only (never its message: it can carry a body, a URL with a token, a customer name). */
export function errorFields(err: unknown): { error: string; code?: string } {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : typeof err;
  const code = typeof e?.code === 'string' || typeof e?.code === 'number' ? String(e.code) : undefined;
  return code ? { error: name, code } : { error: name };
}
