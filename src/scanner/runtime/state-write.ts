/**
 * ask #14 (docs/EDGE-CASES.md "Worker", W5): a write to the state folder (first-scan.json, scan-cadence.json, a
 * fetcher's parse state) or to the database's disk failed because the disk is full. Nothing crashes: the write is
 * skipped (in-memory state goes on) or the run fails as `transient` and retries with backoff, never "stopped" as an
 * unknown error. The worker listens and puts one Health row up (DEP.DISK.LOW); the listener is optional.
 */
type Listener = (e: { what: string; code: string }) => void;

let listener: Listener | null = null;

/** The worker's Health hook (null clears it). */
export function onStateWriteError(l: Listener | null): void {
  listener = l;
}

/** ENOSPC from the file system, or Postgres's disk_full (53100). */
export function isDiskFull(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return code === 'ENOSPC' || code === '53100' || code === 'EDQUOT';
}

/** Say that a write failed (a code only; never the path's contents). Never throws. */
export function stateWriteFailed(what: string, err: unknown): void {
  const e = err as { code?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : 'error';
  try {
    listener?.({ what, code });
  } catch {
    /* a listener never breaks the write's caller */
  }
}

/** The run's failure text when the disk is full (Health's status line reads it). */
export const DISK_FULL_MESSAGE = 'the disk is full: Command Center could not save what it read; it retries once there is room';
