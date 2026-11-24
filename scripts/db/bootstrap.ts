/**
 * Bootstrap the user of a real (empty) database, so `CC_DATA=db` renders from the first scan on.
 *
 *   npm run db:bootstrap [-- --email you@company.com --name "Ada Lovelace" --role se_ic|se_manager
 *                            --hours 09:00-18:00 --days 1-5 --tz America/Denver --slack-id U0123ABCD
 *                            --org62-id 005XXXXXXXXXXXXXXX --manager "Grace Hopper" --quarter-target 250
 *                            --profile <profile.json>]
 *
 * Inputs, later wins: `profile.json` in the state folder (written by `npm run setup`; `--profile` for another
 * file), CC_USER_EMAIL, then the flags. Without an email anywhere it falls back to `git config user.email`.
 * Uses DATABASE_URL (default postgres://localhost:5432/command_center). Idempotent: it only fills in what is
 * missing and never overwrites a value (see src/server/datasource/db/bootstrap.ts). It writes no mock data.
 * Prints the database name and what it wrote (names only), never the URL or profile values.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeStateDir } from '../../src/lib/state-folder';

import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { DbError, mapPgError } from '../../src/db/errors';
import { bootstrapUser, BootstrapProfile, profileFromSetupFile, type BootstrapProfileInput } from '../../src/server/datasource/db/bootstrap';
import { describeDbError } from '../../src/server/datasource/db/seed';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseDays(s: string): number[] | null {
  const t = s.trim();
  const range = /^([0-6])\s*-\s*([0-6])$/.exec(t);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : null;
  }
  const list = t.split(',').map((x) => Number(x.trim()));
  return list.length && list.every((n) => Number.isInteger(n) && n >= 0 && n <= 6) ? [...new Set(list)].sort() : null;
}

function parseHours(s: string): { start: string; end: string } | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const pad = (n: string) => n.padStart(2, '0');
  return { start: `${pad(m[1]!)}:${m[2]}`, end: `${pad(m[3]!)}:${m[4]}` };
}

function gitEmail(): string | undefined {
  try {
    return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function profileInput(argv: string[], env: NodeJS.ProcessEnv = process.env): { input: Partial<BootstrapProfileInput>; emailFrom: string } {
  const stateDir = env.CC_STATE_DIR ?? homeStateDir();
  const file = arg(argv, '--profile') ?? join(stateDir, 'profile.json');
  let input: Partial<BootstrapProfileInput> = {};
  let emailFrom = 'flag';
  if (existsSync(file)) {
    input = profileFromSetupFile(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
    if (input.email) emailFrom = 'profile.json';
  }
  if (env.CC_USER_EMAIL?.trim()) {
    input.email = env.CC_USER_EMAIL.trim();
    emailFrom = 'CC_USER_EMAIL';
  }
  const flags: Partial<BootstrapProfileInput> = {};
  const set = <K extends keyof BootstrapProfileInput>(k: K, v: BootstrapProfileInput[K] | undefined) => {
    if (v !== undefined) flags[k] = v;
  };
  set('email', arg(argv, '--email'));
  set('name', arg(argv, '--name'));
  set('role', arg(argv, '--role') as BootstrapProfileInput['role']);
  set('timezone', arg(argv, '--tz'));
  set('slackUserId', arg(argv, '--slack-id'));
  set('org62UserId', arg(argv, '--org62-id'));
  set('managerName', arg(argv, '--manager'));
  const target = arg(argv, '--quarter-target');
  if (target !== undefined) set('quarterTargetH', Number(target));
  const hours = arg(argv, '--hours');
  const days = arg(argv, '--days');
  if (hours !== undefined || days !== undefined) {
    const h = hours !== undefined ? parseHours(hours) : (input.workingHours ?? { start: '09:00', end: '18:00' });
    const d = days !== undefined ? parseDays(days) : input.workingHours?.days;
    if (!h) throw new Error('--hours must look like 09:00-18:00');
    if (days !== undefined && !d) throw new Error('--days must look like 1-5 or 1,2,3,4,5 (0 = Sunday)');
    flags.workingHours = { start: h.start, end: h.end, ...(d ? { days: d } : {}) };
  }
  if (flags.email) emailFrom = 'flag';
  input = { ...input, ...flags };
  if (!input.email) {
    input.email = gitEmail();
    emailFrom = 'git config user.email';
  }
  input.timezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { input, emailFrom };
}

/** The Postgres SQLSTATE of an error or its causes. */
function pgCode(e: unknown): string | undefined {
  let c = e as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; c && i < 5; i++, c = c.cause as typeof c) if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) return c.code;
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const { input, emailFrom } = profileInput(argv);
  const parsed = BootstrapProfile.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.') || 'profile'}: ${i.message}`);
    throw new Error(`profile incomplete (${fields.join('; ')}). Run npm run setup, or pass --name/--email/--tz`);
  }
  const url = resolveDatabaseUrl();
  const handle = createDb({ url, max: 2, applicationName: 'command-center-bootstrap' });
  try {
    const res = await bootstrapUser({ db: handle.db, profile: parsed.data });
    console.log(`[bootstrap] ${databaseName(url)}: ${res.status} (email from ${emailFrom})${res.wrote.length ? `; wrote ${res.wrote.join(', ')}` : ''}`);
  } finally {
    await handle.close();
  }
}

if (/bootstrap\.(ts|js|mjs)$/.test(process.argv[1] ?? '')) {
  main().catch((err: unknown) => {
    // a database error prints its code and constraint only: drizzle's message carries the bound values (DB-NOTES)
    const m = mapPgError(err);
    const raw = err instanceof Error ? err.message : String(err);
    const why = m instanceof DbError ? describeDbError(err) : /^Failed query/.test(raw) ? `database error ${pgCode(err) ?? ''}`.trim() : raw;
    console.error(`[bootstrap] failed: ${why}`);
    process.exitCode = 1;
  });
}
