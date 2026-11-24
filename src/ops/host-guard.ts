/**
 * The web app answers only this Mac (PKG-1; tenets: Local data, privacy-safe logs; Nothing leaves without approval).
 * The server binds 127.0.0.1 (`-H 127.0.0.1`), and the root `middleware.ts` runs every request through `guardRequest`:
 *   - the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` with the app's port. A page on another site that
 *     re-points its own name at 127.0.0.1 (DNS rebinding) sends its own name as Host, so it is refused;
 *   - a change (POST, PATCH, PUT, DELETE) whose `Origin` is present must come from that same origin, so another site's
 *     page can't make the browser post to the app. Requests without an Origin (curl, the worker, scripts) pass.
 * Pure (no Next, no Node APIs) so it runs in the middleware's edge runtime and in a plain unit test.
 */

export const DEFAULT_APP_PORT = 4327;

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/i;
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface GuardInput {
  method: string;
  /** The raw `Host` header (null when absent). */
  host: string | null;
  /** The raw `Origin` header (null when absent). */
  origin: string | null;
  /** The port the app serves on. */
  port: number;
}

export type GuardResult = { ok: true } | { ok: false; reason: 'host' | 'origin'; message: string };

/** The port the server was started on: PORT (the LaunchAgent and `npm run dev:web` set it), else 4327. */
export function appPort(env: Record<string, string | undefined>): number {
  const n = Number(env.PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_APP_PORT;
}

/** `localhost:4327` → true; another name, no port, another port or extra characters → false. */
export function isLoopbackHost(host: string | null, port: number): boolean {
  const m = host ? LOOPBACK_HOST.exec(host.trim()) : null;
  return !!m && Number(m[2]) === port;
}

/** The Origin is exactly `http://<host>`: the scheme, name and port the request was sent to. */
export function isSameOrigin(origin: string, host: string): boolean {
  if (origin === 'null') return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && u.host.toLowerCase() === host.trim().toLowerCase() && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function guardRequest(i: GuardInput): GuardResult {
  if (!isLoopbackHost(i.host, i.port)) {
    return { ok: false, reason: 'host', message: `Command Center only answers on http://localhost:${i.port}.` };
  }
  if (MUTATING.has(i.method.toUpperCase()) && i.origin !== null && !isSameOrigin(i.origin, i.host!)) {
    return { ok: false, reason: 'origin', message: 'Changes are accepted only from Command Center itself.' };
  }
  return { ok: true };
}
