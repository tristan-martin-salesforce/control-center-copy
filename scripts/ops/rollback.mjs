#!/usr/bin/env node
// npm run ops:rollback [-- --to <version>] [--dry] [--yes]
//
// Puts the previous compiled release back (PKG-2): stops both LaunchAgents, points releases/current at the earlier
// version (the newest one kept, of the last 3), writes the agents for it and starts them. The database keeps the
// newer release's migrations (additive within a major, docs/RELEASING.md); the backup taken before them is named,
// for `npm run restore` if you need the data as it was.
import { createInterface } from 'node:readline/promises';

import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { currentVersion, installedVersions, rollbackRelease, rollbackTarget } from './lib/install-release.mjs';
import { realDeps } from './lib/release-wiring.mjs';

await ensureStateMigrated({ say: (m) => console.log('[rollback] ' + m) });
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const say = (m) => console.log(`[rollback] ${m}`);

const deps = realDeps({ say });
const R = deps.releasesDir;
const to = val('--to') ?? rollbackTarget(R);
say(`installed: ${installedVersions(R).join(', ') || 'none'} · current: ${currentVersion(R) ?? 'none'}`);
if (!flag('--yes') && !flag('--dry') && to) {
  if (!process.stdin.isTTY) {
    say('not a terminal: run it again with --yes to go ahead');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`[rollback] Go back to v${to} and restart Command Center? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (a !== 'y' && a !== 'yes') {
    say('nothing changed');
    process.exit(1);
  }
}
const r = await rollbackRelease(deps, { releasesDir: R, to, dry: flag('--dry') });
process.exit(r.status === 'rolled_back' || r.status === 'planned' || r.status === 'up_to_date' ? 0 : 1);
