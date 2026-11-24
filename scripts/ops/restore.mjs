#!/usr/bin/env node
// Restore a backup. Safe by default: nothing live is touched.
//   npm run restore -- [file] [--into control_center_restore] [--replace] [--yes]
//   npm run restore -- --list     every backup, with the ones kept before a major update (backups/pre-<n>.0/, UPG-4)
//   file defaults to the newest backup; a name as --list prints it (pre-2.0/<file>) is found in the backups folder.
//
// A pg_dump backup (<db>-<stamp>.dump: Homebrew Postgres, or your own DATABASE_URL) is restored into a NEW database
// (control_center_restore) you can inspect before swapping. Replacing the live one: stop the agents first
// (npm run ops:uninstall), then npm run restore -- --into command_center --replace --yes
//
// A base backup of Command Center's own database (<db>-<stamp>.base.tgz, D-98) holds the whole cluster:
//   without --replace   it is unpacked under <state>/pg/restore-<stamp>/ and started on its own socket, to look at;
//                       the command prints its URL and the command that stops it
//   --replace           with Command Center stopped (npm run ops:uninstall: web, worker and the database), the live
//                       data folder is kept as <state>/pg/data.before-restore-<stamp> and the backup takes its place;
//                       then npm run ops:install starts everything again
import { createInterface } from 'node:readline/promises';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_DB, defaultBackupDir, isBaseBackup, listBackups, listKeptBackups, runRestore } from './lib/backup.mjs';

await ensureStateMigrated({ quick: true });
const argv = process.argv.slice(2);
const val = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const db = process.env.CC_DB_NAME ?? DEFAULT_DB;
const dir = defaultBackupDir();
// --list: every backup, the ones kept before a major update (pre-<n>.0/, UPG-4, never pruned) included
if (argv.includes('--list')) {
  const rows = [...listBackups(dir, db), ...listKeptBackups(dir)];
  if (!rows.length) console.log('No backup found. Run: npm run backup');
  for (const b of rows) console.log(`${b.name}  ${Math.round(b.bytes / 1024)} KB${b.name.startsWith('pre-') ? '  (kept before a major update)' : ''}`);
  process.exit(0);
}
const positional = argv.find((a, i) => !a.startsWith('--') && !['--into'].includes(argv[i - 1]));
// a name as --list prints it (pre-2.0/<file>, or a file in the backups folder) is found there
const file = positional ? (!existsSync(positional) && existsSync(join(dir, positional)) ? join(dir, positional) : positional) : listBackups(dir, db).at(-1)?.file;
const into = val('--into', `${db}_restore`);
const replace = argv.includes('--replace');

if (!file) {
  console.error('No backup found. Run: npm run backup');
  process.exit(1);
}
const base = isBaseBackup(file);
const live = base ? replace : replace && into === db;
if (live && !argv.includes('--yes')) {
  if (!process.stdin.isTTY) {
    console.error('Refusing to replace the live database without --yes.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const what = base ? `This replaces Command Center's database folder with ${file} (the current one is kept next to it). Command Center must be stopped.` : `This DROPS ${db} and restores ${file}. Agents must be stopped.`;
  const a = await rl.question(`${what} Type "${db}" to continue: `);
  rl.close();
  if (a.trim() !== db) {
    console.log('Aborted.');
    process.exit(1);
  }
}
try {
  const r = await runRestore({ file, into, replace });
  if (base && replace) console.log(`restored ${file} into Command Center's database folder; the previous one is ${r.previous ?? '(none)'}. Start Command Center again: npm run ops:install`);
  else if (base) console.log(`restored ${file} into a copy to look at (Postgres ${r.engine}):\n  DATABASE_URL=${r.url}\n  stop it with: ${r.stop}`);
  else console.log(`restored ${file} into ${into}`);
} catch (e) {
  console.error(`restore failed: ${e.message}`);
  process.exit(1);
}
