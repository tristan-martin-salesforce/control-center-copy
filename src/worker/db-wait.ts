/**
 * ask #14 (docs/EDGE-CASES.md "Worker", W6): the worker starts while Postgres is not answering (the Mac just booted,
 * the database agent restarts, an update stopped it). Before, the first connect threw, the worker exited 1, launchd
 * started it again every 10 s, and after five starts Health said "The background worker keeps stopping"
 * (BUG.WORKER_CRASH_LOOP), which was not the problem. Now it waits with backoff (2 s, doubling, at most 1 min), the
 * heartbeat says `starting` with the catalog code (DEP.DB.DOWN or DEP.DB.MISSING) so doctor and Health can name it,
 * and it starts as soon as the database answers. Pure apart from the injected probe and sleep.
 */

/** First wait, and the longest, between two connection attempts. */
export const DB_WAIT_BASE_MS = 2_000;
export const DB_WAIT_MAX_MS = 60_000;

/** A connection error → the catalog code that says what to fix (src/errors/catalog.ts). */
export function dbDownCode(err: unknown): 'DEP.DB.DOWN' | 'DEP.DB.MISSING' {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '3D000' ? 'DEP.DB.MISSING' : 'DEP.DB.DOWN';
}

/** The delay before attempt `n + 1` (n ≥ 1). */
export function dbWaitDelayMs(n: number, base = DB_WAIT_BASE_MS, max = DB_WAIT_MAX_MS): number {
  return Math.min(max, base * 2 ** Math.max(0, n - 1));
}

export interface DbWaitOptions {
  /** One connection attempt: resolves when the database answers. */
  probe: () => Promise<void>;
  stopping: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** After each failed attempt: what the heartbeat and the log say. */
  onWait?: (e: { attempt: number; delayMs: number; code: 'DEP.DB.DOWN' | 'DEP.DB.MISSING'; errCode: string }) => void;
  now?: () => number;
}

export interface DbWaitResult {
  ok: boolean;
  attempts: number;
  waitedMs: number;
  /** The last failure's catalog code (null when the first attempt answered). */
  code: 'DEP.DB.DOWN' | 'DEP.DB.MISSING' | null;
}

/** Try until the database answers or the worker is asked to stop. Never throws. */
export async function waitForDatabase(o: DbWaitOptions): Promise<DbWaitResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  let code: DbWaitResult['code'] = null;
  for (let attempt = 1; ; attempt++) {
    if (o.stopping()) return { ok: false, attempts: attempt - 1, waitedMs: now() - t0, code };
    try {
      await o.probe();
      return { ok: true, attempts: attempt, waitedMs: now() - t0, code };
    } catch (err) {
      code = dbDownCode(err);
      const delayMs = dbWaitDelayMs(attempt);
      const errCode = String((err as { code?: unknown } | null)?.code ?? (err as Error)?.name ?? 'error');
      o.onWait?.({ attempt, delayMs, code, errCode });
      // sleep in short steps so a SIGTERM during the wait is answered at once
      for (let left = delayMs; left > 0 && !o.stopping(); left -= 1_000) await sleep(Math.min(1_000, left));
    }
  }
}

/** The Health row's words once the worker got through ("waited 3 min"). */
export function dbWaitedMessage(waitedMs: number): string {
  const min = Math.round(waitedMs / 60_000);
  const span = min >= 1 ? `${min} min` : `${Math.max(1, Math.round(waitedMs / 1000))} s`;
  return `The database was not answering when the background worker started; it waited ${span} and started once it answered. Nothing was lost.`;
}
