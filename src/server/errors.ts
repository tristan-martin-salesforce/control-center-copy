import { API_ERROR_STATUS, type ApiErrorBody, type ApiErrorCode } from '@/contract';
import { entryOf } from '@/errors/catalog';

const RETRYABLE: Record<ApiErrorCode, boolean> = {
  conflict: true, // refetch, rebase, retry
  validation: false,
  not_found: false,
  upstream_unavailable: true,
  budget_exceeded: false,
  dry_run: false,
  internal: true,
};

/** Typed server error. Route handlers map it to the ApiError envelope. */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ApiErrorCode, message: string, details?: unknown, retryable?: boolean) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.retryable = retryable ?? RETRYABLE[code];
  }

  get status(): number {
    return API_ERROR_STATUS[this.code];
  }

  toBody(): ApiErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

export const notFound = (what: string, id: string) => new AppError('not_found', `${what} ${id} not found`, { id });
export const conflict = (what: string, current: unknown) =>
  new AppError('conflict', `${what} changed elsewhere; refetch and re-apply`, { current });
export const invalid = (message: string, details?: unknown) => new AppError('validation', message, details);

/**
 * Cross-bundle-safe check. In `next dev` each route is its own bundle, so an AppError thrown by the
 * mock store (created by whichever bundle loaded first, kept on globalThis) fails `instanceof`.
 */
export function isAppError(err: unknown): err is AppError {
  if (err instanceof AppError) return true;
  return (
    !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AppError' &&
    typeof (err as { code?: unknown }).code === 'string' && typeof (err as { toBody?: unknown }).toBody === 'function'
  );
}

/** API error code → the error catalog's code (11 R5): toasts render the catalog's words for it (src/errors/render.ts). */
export const API_CATALOG: Readonly<Record<ApiErrorCode, string>> = {
  conflict: 'DATA.CONFLICT',
  validation: 'DATA.INVALID_INPUT',
  not_found: 'DATA.NOT_FOUND',
  upstream_unavailable: 'NET.SERVICE_DOWN',
  budget_exceeded: 'RATE.BUDGET',
  dry_run: 'SEND.DRY_RUN',
  internal: 'BUG.UNHANDLED',
};

/** The local Postgres refused or dropped the connection (the pg client's words; D-98: the bundled cluster's socket is gone). */
const DB_DOWN = /connect ECONNREFUSED (?:127\.0\.0\.1|::1|localhost)?:?5432|ECONNREFUSED[^\n]*5432|connect ENOENT [^\n]*\.s\.PGSQL\.\d+|Connection terminated unexpectedly|the database system is (?:starting up|shutting down)|terminating connection due to administrator command/i;
const DB_MISSING = /database "[^"]+" does not exist/i;

/** DEP.DB.DOWN / DEP.DB.MISSING when `err` says the app database is unreachable; null otherwise. */
export function dbDownCode(err: unknown): 'DEP.DB.DOWN' | 'DEP.DB.MISSING' | null {
  const e = err as { message?: unknown; code?: unknown; errors?: unknown } | null;
  const text = err instanceof Error ? `${err.name}: ${err.message} ${String(e?.code ?? '')}` : String(err ?? '');
  // pg's AggregateError (IPv4 and IPv6 both refused) has an empty message and the codes on its parts
  const parts = Array.isArray(e?.errors) ? (e!.errors as unknown[]).map((x) => `${String((x as { message?: unknown })?.message ?? '')}`).join(' ') : '';
  if (DB_MISSING.test(text)) return 'DEP.DB.MISSING';
  if (DB_DOWN.test(`${text} ${parts}`)) return 'DEP.DB.DOWN';
  return null;
}

/**
 * Any thrown value → the AppError the route answers with. A database that is down (PKG-5: the raw ECONNREFUSED toast)
 * becomes `upstream_unavailable` in the catalog's words, with its code in `details`, never the raw text.
 */
export function appErrorFrom(err: unknown): AppError {
  if (isAppError(err)) return err;
  const db = dbDownCode(err);
  if (db) {
    const e = entryOf(db);
    return new AppError('upstream_unavailable', `${e.userTitle}. ${e.nextStep}`, { code: db }, true);
  }
  return new AppError('internal', err instanceof Error ? err.message : 'Unexpected error', undefined, true);
}

/**
 * P25-7: what a client is told. An `internal` error (a bug: a driver, fs or code message that can name a path or a
 * query) answers with the catalog's fixed words; its own message stays in the server log (`internalLogFields`).
 * Every other code is the app's own words, as before. Both the JSON and the stream path answer with this.
 */
export function clientErrorBody(err: unknown): ApiErrorBody {
  const e = appErrorFrom(err);
  if (e.code !== 'internal') return e.toBody();
  const words = entryOf(API_CATALOG.internal);
  return { code: e.code, message: `${words.userTitle}. ${words.nextStep}`, retryable: e.retryable };
}

/** The server log's fields for an `internal` error: its message (redacted by the logger) is kept here, never sent. */
export function internalLogFields(err: unknown): { message?: string } {
  const m = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return m ? { message: m.slice(0, 500) } : {};
}
