#!/usr/bin/env node
// Stop and remove the Command Center LaunchAgents: web and worker, then the database server (com.commandcenter.db,
// D-98) once nothing uses it. Logs, state and the database's data are left alone.
//   node scripts/ops/uninstall-agents.mjs [--yes]
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { launchctlBin } from './lib/launchctl.mjs';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { currentLink, npmInCurrent } from './lib/paths.mjs';
import { DB_LABEL, WEB_LABEL, WORKER_LABEL } from './lib/plist.mjs';

await ensureStateMigrated(); // D-101: a 1.x install's agents are the new labels after this

const dir = process.env.CC_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
const labels = [WEB_LABEL, WORKER_LABEL, DB_LABEL]; // the database last: its smart shutdown waits for their sessions
const present = labels.filter((l) => existsSync(join(dir, `${l}.plist`)));

if (present.length === 0) {
  console.log('No Command Center LaunchAgents are installed.');
  process.exit(0);
}

let go = process.argv.includes('--yes');
if (!go && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  go = /^y(es)?$/i.test((await rl.question(`Stop and remove ${present.join(', ')}? [y/N] `)).trim());
  rl.close();
}
if (!go) {
  // Claude Code runs commands without a terminal to answer in: say how to go ahead instead of a bare "Aborted"
  console.log(process.stdin.isTTY ? 'Nothing was removed.' : 'Nothing was removed: there is no terminal to ask in. To go ahead, run it again with --yes (ops:uninstall -- --yes).');
  process.exit(1);
}

for (const l of present) {
  try {
    execFileSync(launchctlBin(), ['bootout', `gui/${process.getuid()}/${l}`], { stdio: 'pipe' });
  } catch {
    /* was not loaded */
  }
  unlinkSync(join(dir, `${l}.plist`));
  console.log(`removed ${l}`);
}
console.log('Command Center is stopped and will not start at login. Your data, backups, settings and logs were kept.');
console.log(existsSync(currentLink()) ? `To start it again: ${npmInCurrent('ops:install')}` : 'To start it again: npm run ops:install (in this folder)');
console.log('To remove it completely, see docs/INSTALL.md "Uninstalling" (deleting the state folder deletes your data).');
