#!/usr/bin/env node
// Nightly backup into ~/Library/Application Support/command-center/backups/, keeping the newest 7 and one a week for
// the 4 weeks before (D-7). Command Center's own database (D-98) gets a base backup (<db>-<stamp>.base.tgz);
// Homebrew Postgres or a DATABASE_URL you set gets pg_dump -Fc (<db>-<stamp>.dump). scripts/ops/lib/backup.mjs.
//   npm run backup [-- --db command_center] [-- --dir <path>] [-- --keep 7] [-- --if-due]
// --if-due: skip when a backup newer than 24 h exists (the worker calls this on schedule and after downtime).
// The copy folder (CC_BACKUP_COPY_DIR in the env file) gets a copy too; a cloud-synced folder is refused (README).
import { backupCopyDir, backupDue, configuredDbName, DEFAULT_KEEP, defaultBackupDir, runBackup } from './lib/backup.mjs';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { resolveDatabaseUrl } from './lib/pg.mjs';

await ensureStateMigrated({ quick: true });

const argv = process.argv.slice(2);
const val = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const db = val('--db', configuredDbName());
const dir = val('--dir', defaultBackupDir());
const keep = Number(val('--keep', String(DEFAULT_KEEP)));

try {
  if (argv.includes('--if-due') && !backupDue(dir, db)) {
    console.log('A backup newer than 24 h exists; nothing to do.');
    process.exit(0);
  }
  const r = await runBackup({ db, dir, keep, url: resolveDatabaseUrl() });
  console.log(`backup written: ${r.file} (${(r.bytes / 1024).toFixed(0)} KB)${r.pruned.length ? `; pruned ${r.pruned.length} old` : ''}`);
  if (r.copy?.file) console.log(`copied to: ${r.copy.file}`);
  else if (r.copy?.error === 'refused_cloud_synced') console.log(`not copied: ${backupCopyDir().refused} (CC_BACKUP_COPY_DIR); use an external disk or another local folder`);
  else if (r.copy?.error) console.log(`copy failed (${r.copy.error}): is ${r.copy.dir} there and writable?`);
} catch (e) {
  console.error(`backup failed: ${String(e.stderr ?? e.message).split('\n')[0]}`);
  process.exit(1);
}
