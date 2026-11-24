#!/usr/bin/env node
// node scripts/ops/migrate-state.mjs [--quick] [--quiet] [--check]
//
// Command Center's 1.x -> 2.0 rename (D-101): moves ~/Library/Application Support/control-center to .../command-center
// when only the old one exists, and with it the env file's socket path, the database name (control_center ->
// command_center), the LaunchAgents (com.controlcenter.* -> com.commandcenter.*) and the logs. Idempotent: a run that
// stopped half-way is finished by the next one. Both folders present: the new one is used, nothing is merged or deleted.
// Every entry point (setup, install, update, doctor, dev, the LaunchAgents' service wrapper) runs this first; running
// it by hand is always safe. It never blocks a start: a problem is one plain line, exit code 0.
//   --check   say what it would do (the folder, then the database: renamed / already / left alone / moved), change nothing
//   --quick   from a service start: skip the retry of a postponed database rename
//   --quiet   print only when something happens
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { databasePlan, ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { migrationState } from './lib/migrate-state.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);

async function main() {
  const st = migrationState(process.env);
  if (flag('--check')) {
    console.log(`[migrate] ${st.kind}${st.kind === 'migrate' ? `: ${st.p.oldState} would move to ${st.p.newState}` : ''}`);
    if (st.kind !== 'skipped') console.log(`[migrate] database: ${databasePlan(process.env)}`);
    return;
  }
  const r = await ensureStateMigrated({ quick: flag('--quick') });
  if (!flag('--quiet') && ['none', 'skipped'].includes(r.status)) console.log('[migrate] nothing to move');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.log(`[migrate] ${e?.message ?? e}`);
      process.exit(0);
    },
  );
}
