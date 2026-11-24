/** The newest backup and its copy are under 48 h old (lane E, E2: DEP.BACKUP.STALE). File names and ages only. */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { readEnvFile } from '../envfile';
import { backupsDir, envFilePath } from '../paths';
import { appDb } from './database';
import { bad, ok, tilde, type Check } from './types';

/** A backup older than this is a warning (the worker writes one a night; a Mac asleep for a weekend catches up). */
export const BACKUP_MAX_AGE_MS = 48 * 3600_000;
const BACKUP_FILE = /^[a-z_][a-z0-9_]{0,62}-\d{8}-\d{6}\.(dump|base\.tgz)$/; // D-98: base backups of the bundled cluster too

/** The newest `*.dump` or `*.base.tgz` of the app database in `dir` (the names scripts/ops/lib/backup.mjs writes), or null. */
export function newestBackup(dir: string, db: string): { name: string; mtimeMs: number } | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => BACKUP_FILE.test(f) && f.startsWith(`${db}-`)).sort();
  } catch {
    return null;
  }
  const name = names.at(-1);
  if (!name) return null;
  try {
    return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
  } catch {
    return null;
  }
}

/** Mirrors scripts/ops/lib/backup.mjs cloudSyncedReason: a copy folder a sync client uploads takes data off the Mac. */
export function cloudSynced(dir: string, home: string): string | null {
  const p = resolve(dir);
  const under = (rel: string) => p === join(home, rel) || p.startsWith(`${join(home, rel)}/`);
  if (under('Library/Mobile Documents')) return 'iCloud Drive';
  if (under('Library/CloudStorage')) return 'a cloud-synced folder';
  const top = p.startsWith(`${home}/`) ? (p.slice(home.length + 1).split('/')[0] ?? '') : '';
  if (/^OneDrive\b/.test(top)) return 'OneDrive';
  if (/^(Dropbox|Google Drive|Box|Box Sync|iCloud Drive)$/.test(top)) return top;
  return null;
}

/**
 * Lane E (E2): the newest backup is under 48 h old, and so is its copy when a copy folder is set
 * (CC_BACKUP_COPY_DIR, environment or env file). File names and ages only.
 */
export const checkBackups: Check = async (c) => {
  const label = 'Backups';
  const db = appDb(c);
  const home = c.env.HOME ?? homedir();
  const age = (ms: number) => (ms < 2 * 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 72 * 3600_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86_400_000)} days`);
  const last = newestBackup(backupsDir(c.env), db);
  const rawCopy = c.env.CC_BACKUP_COPY_DIR ?? readEnvFile(envFilePath(c.env))?.CC_BACKUP_COPY_DIR ?? '';
  const copyDir = rawCopy ? resolve(rawCopy.replace(/^~(?=\/|$)/, home)) : null;
  const data: Record<string, unknown> = { last: last?.name ?? null, age_h: last ? Math.round((c.now() - last.mtimeMs) / 360_000) / 10 : null, copy_dir: copyDir ? tilde(copyDir, home) : null };
  if (!last) return bad('warn', 'backups', label, 'no backup yet (the worker writes one each night)', 'npm run backup', data, { code: 'DEP.BACKUP.STALE' });
  const lastAge = c.now() - last.mtimeMs;
  const problems: string[] = [];
  const fixes: string[] = [];
  if (lastAge > BACKUP_MAX_AGE_MS) {
    problems.push(`the newest backup is ${age(lastAge)} old`);
    fixes.push('npm run backup (and check the worker is running: the nightly backup is its job)');
  }
  if (copyDir) {
    const cloud = cloudSynced(copyDir, home);
    const copy = cloud ? null : newestBackup(copyDir, db);
    data.copy_last = copy?.name ?? null;
    if (cloud) {
      problems.push(`the copy folder is ${cloud}, which would take your data off this Mac: nothing is copied there`);
      fixes.push('set CC_BACKUP_COPY_DIR in the env file to an external disk or another local folder');
    } else if (!copy) {
      problems.push(`no copy in ${tilde(copyDir, home)} yet`);
      fixes.push('plug in the disk, then npm run backup');
    } else if (c.now() - copy.mtimeMs > BACKUP_MAX_AGE_MS) {
      problems.push(`the newest copy in ${tilde(copyDir, home)} is ${age(c.now() - copy.mtimeMs)} old`);
      fixes.push('plug in the disk, then npm run backup');
    }
  }
  const detail = `newest ${age(lastAge)} old${copyDir ? `, copied to ${tilde(copyDir, home)}` : ' (no copy folder: CC_BACKUP_COPY_DIR)'}`;
  return problems.length ? bad('warn', 'backups', label, problems.join('; '), [...new Set(fixes)].join('; '), data, { code: 'DEP.BACKUP.STALE' }) : ok('backups', label, detail, data);
};
