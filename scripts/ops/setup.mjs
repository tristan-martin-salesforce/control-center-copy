#!/usr/bin/env node
// Idempotent first-run setup for you or a teammate. Safe to re-run: it only fills in what is missing.
//   npm run setup [-- --yes] [-- --start]
// Infra only: prerequisites, state folders, the env file, the database (createdb), migrations and brand assets. Then
// it opens the browser at /onboarding, where you pick your role, your sources and how much history the first scan
// reads (the app must be running: --start, or yes at the prompt, builds it and installs the LaunchAgents first).
//
//   npm run setup -- --headless [--yes] [--name "Ada L" --email ada@company.com --persona se|ae --role se_ic|se_manager
//                    --hours 09:00-18:00 --tz America/New_York --slack-id U0123ABCD --org62-id 005XXXXXXXXXXXXXXX]
// Scripted installs: also asks for the profile (or takes the flags), saves profile.json and bootstraps your user from
// it (npm run db:bootstrap), so the browser onboarding never shows. It writes no mock data.
// It never handles OAuth, passwords or tokens: it prints the exact commands for you to run.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { pg17Bin } from './lib/brew.mjs';
import { readEnvFile } from './lib/envfile.mjs';
import { ensureStateMigrated } from './lib/migrate-state-real.mjs';
import { STATE_FOLDER_NAME } from './lib/paths.mjs';

const PG17 = pg17Bin();
const DB = 'command_center';
export const ROLE_PACKS = ['se_ic', 'se_manager'];
/** D-55 personas (src/personas): Solutions Engineer, Specialist AE. */
export const PERSONAS = ['se', 'ae'];

export function dirs(env = process.env, home = homedir()) {
  const state = env.CC_STATE_DIR ?? join(home, 'Library', 'Application Support', STATE_FOLDER_NAME);
  const logs = env.CC_LOG_DIR ?? join(home, 'Library', 'Logs', STATE_FOLDER_NAME);
  return { state, logs, backups: join(state, 'backups'), envFile: join(state, 'env'), profile: join(state, 'profile.json') };
}

/** ON-23: the PORT a new env file starts with: the shell's when it is a valid port (1-65535), else 4327. */
export function templatePort(env = process.env) {
  const p = String(env.PORT ?? '').trim();
  return /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535 ? Number(p) : 4327;
}

/**
 * The env file a new install starts from. `port`: templatePort (the shell's PORT, else 4327); from then on the file
 * wins over the shell (ON-14). `databaseUrl`: Homebrew's for a source checkout's `npm run setup` (as 1.x),
 * the bundled cluster's socket URL for the installer (D-98, scripts/ops/lib/ensure-db.mjs).
 */
export function envTemplate(databaseUrl = `postgresql://localhost:5432/${DB}`, extra = '', port = templatePort()) {
  return `# Command Center environment. Read by the LaunchAgents (chmod 600; never commit or paste this file).
# Add only what the app needs. Do NOT put Slack/Google/Org62 credentials here: those live in Claude Code / devbar.
DATABASE_URL=${databaseUrl}
${extra}PORT=${port}
# The web serves your Postgres data (mock is for development only)
CC_DATA=db
`;
}
export const ENV_TEMPLATE = envTemplate();

/** Create state dirs (700) and the env template (600) without overwriting anything. Returns what it created. */
export function ensureState(d, template = envTemplate()) {
  const created = [];
  for (const p of [d.state, d.backups, d.logs]) {
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true, mode: 0o700 });
      created.push(p);
    }
    chmodSync(p, 0o700);
  }
  if (!existsSync(d.envFile)) {
    writeFileSync(d.envFile, template, { mode: 0o600 });
    created.push(d.envFile);
  }
  chmodSync(d.envFile, 0o600);
  return created;
}

export function parseHours(s) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2)}:${pad(m2)}` };
}

export function validateProfile(p) {
  const errors = [];
  if (!p.name || !String(p.name).trim()) errors.push('name is required');
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.push('email looks wrong');
  if (!ROLE_PACKS.includes(p.role_pack)) errors.push(`role_pack must be one of ${ROLE_PACKS.join(', ')}`);
  if (p.persona !== undefined && !PERSONAS.includes(p.persona)) errors.push(`persona must be one of ${PERSONAS.join(', ')}`);
  if (p.persona === 'ae' && p.role_pack === 'se_manager') errors.push('the Specialist AE persona has no manager level (use role_pack se_ic)');
  if (!p.working_hours) errors.push('working_hours must look like 09:00-18:00');
  if (p.slack_user_id && !/^[UW][A-Z0-9]{6,}$/.test(p.slack_user_id)) errors.push('slack_user_id looks wrong (starts with U or W)');
  if (p.org62_user_id && !/^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(p.org62_user_id)) errors.push('org62_user_id looks wrong (starts with 005, 15 or 18 characters)');
  return errors;
}

/** The database name of a connection URL (never printed whole: it may carry a password). */
export function dbName(url) {
  if (!url) return null;
  let name = null;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null;
  } catch {
    return null;
  }
  if (name && !/^[A-Za-z0-9_]+$/.test(name)) throw new Error('DATABASE_URL names a database setup cannot handle (use letters, digits and _)');
  return name;
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const tool = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
};

/** Where the browser onboarding lives: the env file's PORT over the shell's, as the services run (ON-14, P34-1), else 4327. */
export function onboardingUrl(fileEnv = {}, env = process.env) {
  const port = Number({ ...env, ...(fileEnv ?? {}) }.PORT) || 4327;
  return `http://localhost:${port}/onboarding`;
}

/** Does the app answer at this URL's origin (its onboarding state route)? */
export async function appUp(url, timeoutMs = 3000) {
  try {
    const r = await fetch(new URL('/api/v1/onboarding', url), { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitUp(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await appUp(url)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const yes = flag('--yes');
  const headless = flag('--headless');
  const interactive = process.stdin.isTTY && !flag('--non-interactive');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  await ensureStateMigrated(); // D-101: a 1.x state folder moves before anything creates the new one
  const d = dirs();
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q, def = '') => (rl ? (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def : def);
  const askYes = async (q) => yes || (rl ? /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()) : false);
  const todo = [];

  console.log(`Command Center setup${headless ? ' (headless: profile and bootstrap here, no browser onboarding)' : ''}\n`);

  // 1. Prerequisites (D-42)
  console.log('1. Prerequisites');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const prereq = [
    ['Node 20+', nodeMajor >= 20, `v${process.versions.node}`, 'brew install node'],
    ['Postgres 17 (Homebrew)', existsSync(join(PG17, 'psql')), PG17, 'brew install postgresql@17 && brew services start postgresql@17'],
    ['claude CLI', Boolean(tool('claude', ['--version'])), tool('claude', ['--version']) ?? 'missing', 'install Claude Code'],
    ['devbar', Boolean(tool('devbar', ['--version']) ?? tool('devbar', ['auth', 'status', '--json'])), 'present', 'install devbar (internal) then: devbar auth login'],
  ];
  for (const [label, okay, detail, fix] of prereq) {
    console.log(`   ${okay ? '✓' : '✗'} ${label}${okay ? ` (${detail})` : `: ${fix}`}`);
    if (!okay) todo.push(fix);
  }

  // 2. State directories + env template
  console.log('\n2. State directories');
  const created = ensureState(d);
  console.log(created.length ? created.map((c) => `   created ${c}`).join('\n') : '   already in place');

  // 3. Database (DATABASE_URL's database when set, so a scratch install can be rehearsed; command_center otherwise)
  console.log('\n3. Database');
  const DBNAME = dbName(process.env.DATABASE_URL ?? readEnvFile(d.envFile)?.DATABASE_URL) ?? DB; // a database the rename could not move keeps its 1.x name in the env file
  let dbReady = false;
  if (existsSync(join(PG17, 'psql'))) {
    const ready = tool(join(PG17, 'pg_isready'), ['-h', 'localhost']);
    if (ready === null) {
      console.log('   ✗ Postgres is not accepting connections. Run: brew services start postgresql@17');
      todo.push('brew services start postgresql@17, then re-run npm run setup');
    } else {
      const exists = tool(join(PG17, 'psql'), ['-h', 'localhost', '-d', 'postgres', '-Atc', `SELECT 1 FROM pg_database WHERE datname='${DBNAME}'`]) === '1';
      if (exists) {
        console.log(`   ✓ database ${DBNAME} exists`);
        dbReady = true;
      } else {
        const cmd = `${join(PG17, 'createdb')} ${DBNAME}`;
        console.log(`   database ${DBNAME} is missing. Command: ${cmd}`);
        if (await askYes('   Run it now?')) {
          execFileSync(join(PG17, 'createdb'), ['-h', 'localhost', DBNAME], { stdio: 'inherit' });
          console.log(`   ✓ created ${DBNAME}`);
          dbReady = true;
        } else todo.push(cmd);
      }
    }
  }

  // 4. Migrations
  console.log('\n4. Migrations');
  const pkg = readJson(join(repo, 'package.json'));
  let migrated = false;
  if (!dbReady) console.log('   skipped: the database is not ready');
  else if (pkg.scripts?.['db:migrate']) {
    const r = spawnSync('npm', ['run', 'db:migrate'], { cwd: repo, stdio: 'inherit' });
    migrated = r.status === 0;
    console.log(migrated ? '   ✓ migrations applied' : '   ✗ db:migrate failed (see output above)');
    if (!migrated) todo.push('npm run db:migrate');
  } else console.log('   skipped: no db:migrate script in this checkout yet');

  // 5. Brand assets
  console.log('\n5. Fonts and icons');
  const sync = join(repo, 'scripts', 'sync-brand-assets.mjs');
  if (existsSync(sync)) {
    const r = spawnSync(process.execPath, [sync], { cwd: repo, stdio: 'inherit' });
    console.log(r.status === 0 ? '   ✓ synced' : '   ✗ sync failed (licensed assets must be available locally)');
  } else console.log('   skipped: scripts/sync-brand-assets.mjs not in this checkout yet');

  if (!headless) {
    rl?.close();
    await openOnboarding({ d, repo, pkg, migrated, interactive, todo, askYes });
    if (todo.length) console.log(`\nStill to do:\n${todo.map((t) => `  - ${t}`).join('\n')}`);
    return;
  }

  // 6. Profile (headless only)
  console.log('\n6. Your profile');
  const prev = readJson(d.profile);
  console.log('   Slack member ID: in Slack, open your profile, click the ... menu, then "Copy member ID" (starts with U or W). Optional.');
  console.log('   Org62 user ID: your User Id in Org62 (starts with 005). Optional, but the Org62 scanner needs it.');
  const hoursArg = val('--hours') ?? (prev.working_hours ? `${prev.working_hours.start}-${prev.working_hours.end}` : '09:00-18:00');
  const emailDefault = prev.email ?? process.env.CC_USER_EMAIL ?? tool('git', ['config', 'user.email']) ?? '';
  const persona = val('--persona') ?? (await ask(`   Role (${PERSONAS.join(' = Solutions Engineer | ')} = Specialist AE)`, prev.persona ?? 'se'));
  const profile = {
    name: val('--name') ?? (await ask('   Your name', prev.name ?? '')),
    email: String(val('--email') ?? (await ask('   Work email (the account the Google scanners read)', emailDefault))).trim().toLowerCase(),
    persona,
    role_pack: val('--role') ?? (persona === 'ae' ? 'se_ic' : await ask(`   Level (${ROLE_PACKS.join(' | ')})`, prev.role_pack ?? 'se_ic')),
    working_hours: parseHours(val('--hours') ?? (await ask('   Working hours (HH:MM-HH:MM)', hoursArg))),
    timezone: val('--tz') ?? (await ask('   Time zone', prev.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)),
    slack_user_id: val('--slack-id') ?? (await ask('   Slack member ID (optional)', prev.slack_user_id ?? '')),
    org62_user_id: val('--org62-id') ?? (await ask('   Org62 user ID (optional)', prev.org62_user_id ?? '')),
  };
  // working days are not prompted (Mon to Fri); a hand-edited profile.json keeps its own
  if (profile.working_hours && Array.isArray(prev.working_hours?.days)) profile.working_hours.days = prev.working_hours.days;
  rl?.close();
  const errs = validateProfile(profile);
  if (!profile.email) errs.push('email is required');
  let profileSaved = false;
  if (errs.length) {
    console.log(`   ✗ profile not saved: ${errs.join('; ')}`);
    todo.push('re-run npm run setup -- --headless and fix the profile fields');
  } else {
    writeFileSync(d.profile, JSON.stringify({ ...profile, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    chmodSync(d.profile, 0o600);
    profileSaved = true;
    console.log(`   ✓ saved ${d.profile}`);
  }

  // 7. Your user in the database: idempotent, fills in only what is missing, never overwrites, no mock data
  console.log('\n7. Your user in the database');
  if (!migrated) console.log('   skipped: migrations did not run');
  else if (!profileSaved) console.log('   skipped: the profile is not saved');
  else if (!pkg.scripts?.['db:bootstrap']) console.log('   skipped: no db:bootstrap script in this checkout yet');
  else {
    const r = spawnSync('npm', ['run', '--silent', 'db:bootstrap', '--', '--profile', d.profile], { cwd: repo, stdio: 'inherit' });
    console.log(r.status === 0 ? '   ✓ user, settings, role and starter policy in place' : '   ✗ db:bootstrap failed (see output above)');
    if (r.status !== 0) todo.push('npm run db:bootstrap');
  }

  // 8. Sign-ins: printed, never performed
  console.log('\n8. Sign in to your sources (run these yourself; setup never handles credentials)');
  console.log('   Slack:   claude mcp login slack');
  console.log('   Org62:   claude mcp login Org62-Sobject-Read');
  console.log('   Google:  devbar auth login   then   devbar mcpgw connectors connect google-workspace-readonly');
  if (persona !== 'ae') console.log('   VDP:     needs an admin-issued PAT in your vdp-app-fir MCP entry, then: python3 ~/.claude/scripts/refresh_vdp_fir_cookie.py');
  console.log('   Gemini notes: make sure notes are enabled in Google Meet.');
  console.log('\nNext: npm run doctor   (then npm run build && npm run ops:install to keep it running in the background)');
  if (todo.length) console.log(`\nStill to do:\n${todo.map((t) => `  - ${t}`).join('\n')}`);
}

/**
 * Step 6 (default): the rest happens in the browser. Opens /onboarding when the app answers; otherwise offers to build
 * and start it in the background (the LaunchAgents: web and worker, scanning live), or prints how.
 */
async function openOnboarding({ d, repo, pkg, migrated, interactive, todo, askYes }) {
  console.log('\n6. Onboarding in the browser');
  if (!migrated) {
    console.log('   skipped: migrations did not run (fix the steps above, then re-run npm run setup)');
    return;
  }
  const url = onboardingUrl(readEnvFile(d.envFile) ?? {});
  const open = () => {
    const r = spawnSync('open', [url], { stdio: 'ignore' });
    console.log(r.status === 0 ? `   ✓ opened ${url}` : `   Open ${url} in your browser.`);
  };
  if (await appUp(url)) {
    open();
    return;
  }
  console.log(`   The app is not running at ${new URL(url).origin} yet.`);
  console.log('   To keep it running in the background (web and worker, scanning your sources): npm run build && npm run ops:install');
  const start = process.argv.includes('--start') || (interactive && (await askYes('   Build and start it in the background now?')));
  if (!start) {
    todo.push(`npm run build && npm run ops:install, then open ${url}`);
    return;
  }
  if (!pkg.scripts?.build || !pkg.scripts?.['ops:install']) {
    todo.push(`npm run build && npm run ops:install, then open ${url}`);
    return;
  }
  const b = spawnSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
  if (b.status !== 0) {
    console.log('   ✗ build failed (see output above)');
    todo.push('npm run build');
    return;
  }
  // you said yes (the prompt or --start): ops:install's own confirmation is that answer
  const i = spawnSync('npm', ['run', 'ops:install', '--', '--yes'], { cwd: repo, stdio: 'inherit' });
  if (i.status !== 0) {
    console.log('   ✗ ops:install failed (see output above)');
    todo.push('npm run ops:install');
    return;
  }
  console.log('   waiting for the app to answer…');
  if (await waitUp(url, 90_000)) open();
  else {
    console.log(`   ✗ the app did not answer within 90 s. Check npm run doctor, then open ${url}`);
    todo.push(`npm run doctor, then open ${url}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`setup failed: ${e.message}`);
    process.exit(1);
  });
}
