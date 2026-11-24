#!/usr/bin/env node
// Install (or render) the two LaunchAgents: com.commandcenter.web and com.commandcenter.worker.
//
//   node scripts/ops/install-agents.mjs --out <dir>      render + plutil -lint into <dir> only (touches nothing else)
//   node scripts/ops/install-agents.mjs --yes            write to ~/Library/LaunchAgents and load with launchctl
//   options: --only web|worker   --port 4327   --repo <path>   --no-load (write plists, do not launchctl)
//
// Installing changes persistent configuration, so without --out it asks for confirmation (or needs --yes).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { fileMode } from './lib/envfile.mjs';
import { launchctlBin } from './lib/launchctl.mjs';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { STATE_FOLDER_NAME } from './lib/paths.mjs';
import { renderAgent, WEB_LABEL, WORKER_LABEL } from './lib/plist.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

export function resolveTool(name, candidates) {
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function planInstall({ repo, home = homedir(), env = process.env, port = 4327, node, npm } = {}) {
  const stateDir = env.CC_STATE_DIR ?? join(home, 'Library', 'Application Support', STATE_FOLDER_NAME);
  const logDir = env.CC_LOG_DIR ?? join(home, 'Library', 'Logs', STATE_FOLDER_NAME);
  node ??= resolveTool('node', ['/opt/homebrew/bin/node', '/usr/local/bin/node']) ?? process.execPath;
  npm ??= resolveTool('npm', [join(dirname(node), 'npm'), '/opt/homebrew/bin/npm', '/usr/local/bin/npm']);
  return { repo, home, port, node, npm, stateDir, logDir, envFile: join(stateDir, 'env'), templateDir: join(repo, 'ops', 'launchd') };
}

function lint(file) {
  execFileSync('/usr/bin/plutil', ['-lint', file], { stdio: 'pipe' });
}

async function confirm(q) {
  if (flag('--yes')) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

async function main() {
  const repo = resolve(val('--repo', join(here, '..', '..')));
  const plan = planInstall({ repo, port: Number(val('--port', '4327')) });
  const only = val('--only');
  const kinds = ['web', 'worker'].filter((k) => !only || only === k);
  const outDir = val('--out');

  if (!plan.npm && kinds.includes('worker')) throw new Error('npm not found; install Node via Homebrew first');

  const rendered = kinds.map((kind) => ({ kind, label: kind === 'web' ? WEB_LABEL : WORKER_LABEL, xml: renderAgent({ kind, ...plan }) }));

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const r of rendered) {
      const f = join(outDir, `${r.label}.plist`);
      writeFileSync(f, r.xml);
      lint(f);
      console.log(`rendered and linted ${f}`);
    }
    return;
  }

  // Real install (a 1.x state folder moves first: D-101).
  await ensureStateMigrated();
  const mode = fileMode(plan.envFile);
  if (mode === null) throw new Error(`env file missing: ${plan.envFile}. Run: npm run setup`);
  if (mode & 0o077) {
    chmodSync(plan.envFile, 0o600);
    console.log('tightened env file permissions to 600');
  }
  if (kinds.includes('web') && !existsSync(join(repo, '.next', 'BUILD_ID'))) {
    throw new Error('no production build found (.next/BUILD_ID). Run: npm run build');
  }
  console.log(`Will install ${kinds.join(' + ')} into ~/Library/LaunchAgents:\n  repo: ${repo}\n  node: ${plan.node}\n  logs: ${plan.logDir}`);
  if (!(await confirm('Install and start now?'))) {
    console.log('Aborted. Nothing was installed.');
    process.exit(1);
  }
  const agentsDir = process.env.CC_LAUNCH_AGENTS_DIR ?? join(plan.home, 'Library', 'LaunchAgents');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(plan.logDir, { recursive: true, mode: 0o700 });
  const uid = process.getuid();
  for (const r of rendered) {
    const f = join(agentsDir, `${r.label}.plist`);
    writeFileSync(f, r.xml, { mode: 0o644 });
    lint(f);
    if (flag('--no-load')) {
      console.log(`wrote ${f} (not loaded)`);
      continue;
    }
    // bootout first so a re-install picks up changes; ignore "not loaded".
    try {
      execFileSync(launchctlBin(), ['bootout', `gui/${uid}/${r.label}`], { stdio: 'pipe' });
    } catch {
      /* not loaded */
    }
    execFileSync(launchctlBin(), ['bootstrap', `gui/${uid}`, f], { stdio: 'pipe' });
    console.log(`installed and started ${r.label}`);
  }
  console.log('Done. Check with: npm run doctor');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`install failed: ${e.message}`);
    process.exit(1);
  });
}
