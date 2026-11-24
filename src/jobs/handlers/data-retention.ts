/**
 * `data.retention` (nightly 03:45): the retention policy in src/db/retention (llm text, scan trace, resolved events,
 * orphan source items, jobs, scan runs, priority runs) plus backup thinning (7 daily + 4 weekly). Separate from
 * `retention.scrub` (./retention.ts: the 90-day body / audit-image privacy scrub, which stays as it is).
 * CC_RETENTION_DRY=1 logs the plan and touches nothing. Skips while a scan or settle job is running.
 */
import { unlinkSync } from 'node:fs';

import { databaseName, resolveDatabaseUrl } from '@/db/client';
import { backupsToPrune } from '@/db/retention/policy';
import { formatRetentionPlan, isDryEnv, runDataRetention } from '@/db/retention/run';

import type { JobHandler } from '../types';
import { loadBackupLib, type BackupLib } from './backup';

export const DATA_RETENTION_KIND = 'data.retention';

type BackupFiles = Pick<BackupLib, 'defaultBackupDir'> & { listBackups?: (dir: string, db?: string) => Array<{ file: string; name: string }> };

/** Thin the backup folder to the last 7 daily + 4 weekly. Names only in the result. */
export function thinBackups(lib: BackupFiles, db: string, dry: boolean): string[] {
  if (!lib.listBackups) return [];
  const all = lib.listBackups(lib.defaultBackupDir(), db);
  const doomed = new Set(backupsToPrune(all.map((b) => b.name)));
  const files = all.filter((b) => doomed.has(b.name));
  if (!dry) for (const f of files) unlinkSync(f.file);
  return files.map((f) => f.name);
}

export function dataRetentionHandler(deps: { lib?: () => Promise<BackupLib> } = {}): JobHandler {
  return async (ctx) => {
    const dry = isDryEnv();
    const r = await runDataRetention(ctx.db, ctx.userId, { now: ctx.clock(), dry, signal: ctx.signal, log: ctx.log });
    for (const l of formatRetentionPlan(r)) ctx.log(l);
    if (r.skipped) return { skipped: r.skipped };
    let thinned: string[] = [];
    try {
      const lib = await (deps.lib ?? loadBackupLib)();
      thinned = thinBackups(lib as unknown as BackupFiles, databaseName(resolveDatabaseUrl()), dry);
    } catch (e) {
      ctx.log('backup thinning failed', { code: e instanceof Error ? e.name : 'unknown' });
    }
    return {
      dry,
      tables: Object.fromEntries(r.tables.map((t) => [t.table, t.rows])),
      bytesBefore: r.bytesBefore,
      bytesAfter: r.bytesAfter,
      estimatedReclaimBytes: r.estimatedReclaimBytes,
      backupsThinned: thinned.length,
    };
  };
}
