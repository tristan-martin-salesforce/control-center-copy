/**
 * Nightly backup (D-7) through OPS' scripts/ops/lib/backup.mjs: `backupDue()` then `runBackup()`, so a laptop
 * that slept through the night still gets one backup on wake (schedule catch-up = run once). `runBackup` also writes
 * the copy folder when CC_BACKUP_COPY_DIR is set (lane E, E2). The URL decides the kind (D-98): Command Center's own
 * database gets a base backup with the bundled server (the bundle has no pg_dump), any other a `pg_dump -Fc`.
 */
import { databaseName, resolveDatabaseUrl } from '@/db/client';

import type { JobHandler } from '../types';

export interface BackupLib {
  backupDue(dir: string, db?: string, maxAgeMs?: number, now?: number): boolean;
  runBackup(opts: { db?: string; url?: string; dir?: string; keep?: number; now?: Date }): Promise<{ file: string; bytes: number; pruned: string[]; copy?: { file?: string; error?: string } | null }>;
  defaultBackupDir(env?: NodeJS.ProcessEnv): string;
}

/** Loads the OPS library at run time (plain .mjs, kept out of the TypeScript program on purpose). */
export async function loadBackupLib(): Promise<BackupLib> {
  const spec = new URL('../../../scripts/ops/lib/backup.mjs', import.meta.url).href;
  return (await import(/* @vite-ignore */ spec)) as BackupLib;
}

/** The nightly job backs up unless a backup is newer than this. */
export const NIGHTLY_DUE_MS = 20 * 3600_000;

export function backupHandler(deps: { lib?: () => Promise<BackupLib>; dbName?: string; url?: string } = {}): JobHandler {
  return async (ctx) => {
    const lib = await (deps.lib ?? loadBackupLib)();
    const url = deps.url ?? resolveDatabaseUrl();
    const db = deps.dbName ?? databaseName(url);
    const dir = lib.defaultBackupDir();
    // 20 h, not 24: the previous night's backup finished a few minutes after its 02:30 slot, so at 02:30 it was 23 h 5x
    // old and "not due", and backups ran every other night (lane E found it: Nov 9, 11, 13). A backup a few hours
    // old (npm run update's, a manual one) still skips the night's.
    if (!lib.backupDue(dir, db, NIGHTLY_DUE_MS, ctx.clock().getTime())) return { skipped: 'not_due', db };
    const r = await lib.runBackup({ db, url, dir, now: ctx.clock() });
    // lane E (E2): the copy folder (CC_BACKUP_COPY_DIR); a failed copy (a disk not plugged in) never fails the backup
    const copy = r.copy ? (r.copy.error ? { error: r.copy.error } : { copied: true }) : null;
    if (r.copy?.error) ctx.log('backup copy failed', { code: r.copy.error });
    // File name and size only (no paths with user names in job results).
    return { db, file: r.file.split('/').pop(), bytes: r.bytes, pruned: r.pruned.length, ...(copy ? { copy } : {}) };
  };
}
