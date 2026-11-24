/**
 * The worker's crash policy (PKG R9): errors reach the user instead of a log nobody reads.
 *   - An uncaught exception or unhandled rejection writes one `app_events` row (worker | BUG.UNHANDLED, severity
 *     critical, the redacted top stack frame), flushes, and exits 1; launchd's KeepAlive starts it again.
 *   - Under the LaunchAgent (CC_SUPERVISED=1, set by scripts/ops/run-service.mjs), every start is counted in the state
 *     folder. More than 5 starts in 10 minutes is a crash loop: one BUG.WORKER_CRASH_LOOP event, then the worker waits
 *     5 minutes before it starts its work (the process stays up, so launchd stops restarting it every 15 s).
 * Health ▸ Needs you shows both (the event's owner is the app's user). Ids, codes and frames only, never a message.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { errorFields, topFrame } from '@/lib/log';
import { stateDir } from './paths';

export const CRASH_LOOP = { windowMs: 10 * 60_000, maxStarts: 5, backoffMs: 5 * 60_000 } as const;
export type WorkerBugCode = 'BUG.UNHANDLED' | 'BUG.WORKER_CRASH_LOOP';

export const workerStartsPath = (env: Record<string, string | undefined> = process.env) => join(stateDir(env), 'worker-starts.json');

/** Pure: the starts kept (this one included) and whether they make a crash loop. */
export function crashLoopState(previous: number[], now: number, o: { windowMs: number; maxStarts: number } = CRASH_LOOP): { starts: number[]; loop: boolean } {
  const starts = [...previous.filter((t) => Number.isFinite(t) && t <= now && now - t < o.windowMs), now].slice(-50);
  return { starts, loop: starts.length > o.maxStarts };
}

/** The counted starts in the state folder ([] when there is no file or it is unreadable). */
export function readWorkerStarts(file: string = workerStartsPath()): number[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return []; // first start, or unreadable: start counting again
  }
}

function writeStarts(file: string, starts: number[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(starts));
  } catch {
    /* counting is best effort */
  }
}

/** Count this start in the state folder; returns the recent starts and whether they make a crash loop. */
export function countWorkerStart(file: string = workerStartsPath(), now = Date.now()): { starts: number[]; loop: boolean } {
  const s = crashLoopState(readWorkerStarts(file), now);
  writeStarts(file, s.starts);
  return s;
}

/**
 * ON-30: a clean shutdown (SIGTERM or SIGINT: our own bootout, kickstart or an install) takes its own start back out,
 * so only unclean exits count toward a crash loop. Six installs in ten minutes are not a crash loop.
 */
export function forgetWorkerStart(start: number, file: string = workerStartsPath()): void {
  const starts = readWorkerStarts(file);
  const i = starts.lastIndexOf(start);
  if (i < 0) return;
  starts.splice(i, 1);
  writeStarts(file, starts);
}

/** What the event says, in the user's words. */
export function bugEventText(code: WorkerBugCode, detail: { starts?: number } = {}): string {
  return code === 'BUG.WORKER_CRASH_LOOP'
    ? `The background worker keeps stopping (${detail.starts ?? 'several'} starts in 10 minutes), so it waits 5 minutes before trying again. Report this from the Feedback button.`
    : 'The background worker stopped on an unexpected error and started again. If this keeps happening, report it from the Feedback button.';
}

/** The row's fields: an unhandled error is fingerprinted by its frame, so two different bugs are two rows. */
export function bugEvent(code: WorkerBugCode, detail: Record<string, unknown>): { code: WorkerBugCode; message: string; detail: Record<string, unknown>; fingerprint: string } {
  const frame = typeof detail.frame === 'string' ? detail.frame : '';
  return { code, message: bugEventText(code, detail as { starts?: number }), detail, fingerprint: code === 'BUG.UNHANDLED' && frame ? `worker|${code}|${frame.slice(0, 160)}` : `worker|${code}` };
}

export interface CrashHandlerDeps {
  /** Write the app_events row (best effort; it may fail when the database is what broke). */
  record: (event: ReturnType<typeof bugEvent>) => Promise<void>;
  log: (msg: string, detail: Record<string, unknown>) => void;
  exit: (code: number) => void;
  /** How long the row may take before the process exits anyway. */
  flushMs?: number;
}

/** The handler both process events call; it runs once (a second error while recording only exits). */
export function crashHandler(deps: CrashHandlerDeps): (kind: 'uncaughtException' | 'unhandledRejection' | 'fatal', err: unknown) => Promise<void> {
  let handling = false;
  return async (kind, err) => {
    if (handling) return deps.exit(1);
    handling = true;
    const detail = { kind, ...errorFields(err), frame: topFrame(err) };
    deps.log('unhandled error: exiting', { code: 'BUG.UNHANDLED', ...detail });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([deps.record(bugEvent('BUG.UNHANDLED', detail)).catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, deps.flushMs ?? 3000)))]);
    if (timer) clearTimeout(timer);
    deps.exit(1);
  };
}

/** Install the handler on this process; returns it for errors caught elsewhere (main's own rejection). */
export function installCrashHandlers(proc: Pick<NodeJS.Process, 'on'>, deps: CrashHandlerDeps): ReturnType<typeof crashHandler> {
  const handle = crashHandler(deps);
  proc.on('uncaughtException', (err) => void handle('uncaughtException', err));
  proc.on('unhandledRejection', (reason) => void handle('unhandledRejection', reason));
  return handle;
}
