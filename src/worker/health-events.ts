/**
 * ask #14: the worker's own Health rows for what went wrong around it (app_events, component `worker`; Health ▸ Errors
 * shows the message and its next step). One open row per fingerprint; a repeat counts on it. Never throws.
 *
 *   DEP.DISK.LOW       a write to the state folder or the database failed: the disk is full (W5)
 *   WORKER.DB_WAITED   the database was not answering at start; the worker waited and started (W6)
 */
import { sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { onStateWriteError } from '@/scanner/runtime/state-write';

import { dbWaitedMessage } from './db-wait';

export const DB_WAITED = 'WORKER.DB_WAITED';
export const DISK_FULL = 'DEP.DISK.LOW';
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', '53100']);

async function workerEvent(db: Db, ownerUserId: string | null, e: { severity: 'info' | 'warn'; code: string; message: string; suggestedAction: string; fingerprint: string; detail?: Record<string, unknown> }): Promise<void> {
  await db
    .execute(sql`
      insert into app_events (owner_user_id, severity, component, code, message, detail, fingerprint)
      values (${ownerUserId}, ${e.severity}, 'worker', ${e.code}, ${e.message.slice(0, 300)}, ${JSON.stringify({ ...e.detail, suggestedAction: e.suggestedAction })}::jsonb, ${e.fingerprint})
      on conflict (fingerprint) where resolved_at is null
      do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), message = excluded.message`)
    .catch(() => undefined);
}

/** The database answered after the worker waited for it at start (an info row: nothing to do). */
export function dbWaitedEvent(db: Db, ownerUserId: string | null, waitedMs: number, code: string | null): Promise<void> {
  return workerEvent(db, ownerUserId, { severity: 'info', code: DB_WAITED, message: dbWaitedMessage(waitedMs), suggestedAction: 'Nothing to do. If it happens at every start, run npm run doctor.', fingerprint: `worker|${DB_WAITED}`, detail: { waitedMs, code } });
}

/** A full disk, said once per 10 minutes at most (each failed write calls it). */
export function diskFullEvent(db: Db, ownerUserId: string | null, what: string): Promise<void> {
  return workerEvent(db, ownerUserId, {
    severity: 'warn',
    code: DISK_FULL,
    message: `The disk is full: Command Center could not save ${what}. Scans retry once there is room; nothing already saved is lost.`,
    suggestedAction: 'Free up a few GB of disk space.',
    fingerprint: `worker|${DISK_FULL}`,
  });
}

/**
 * The worker's listener for failed state writes (src/scanner/runtime/state-write.ts): a full disk becomes the Health
 * row; any other code is only logged. Returns the uninstall.
 */
export function watchStateWrites(db: Db, ownerUserId: () => string | null, log: (msg: string, detail?: Record<string, unknown>) => void, everyMs = 10 * 60_000): () => void {
  let lastAt = Number.NEGATIVE_INFINITY;
  onStateWriteError((e) => {
    log('state write failed', { what: e.what, code: e.code });
    if (!DISK_CODES.has(e.code) || Date.now() - lastAt < everyMs) return;
    lastAt = Date.now();
    void diskFullEvent(db, ownerUserId(), e.what);
  });
  return () => onStateWriteError(null);
}
