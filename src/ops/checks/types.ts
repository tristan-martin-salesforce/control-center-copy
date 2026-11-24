/**
 * What every doctor check shares (11 R6): the context (every side effect injectable, so checks are pure given it),
 * the result shape, and the helpers. One file per check under src/ops/checks/; the CLI (`npm run doctor`), the
 * read route (GET /api/v1/doctor) and the worker's 15-minute job run the same ones (src/ops/doctor.ts).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecFn } from '../exec';
import { readEnvFile } from '../envfile';
import { APP_PORT, currentReleaseLink, envFilePath } from '../paths';
import type { DependencyState } from '../../reauth/types';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Shown when status is not ok. */
  fix?: string;
  /** The error catalog's code when not ok (src/errors/catalog.ts): Health, the worker's events and the feedback block use it. */
  code?: string;
  /** Where the dependency this check probes is (missing → installed → signed_out → expired → ok, offline, unknown). */
  state?: DependencyState;
  data?: Record<string, unknown>;
}

export interface DoctorContext {
  env: Record<string, string | undefined>;
  repoRoot: string;
  exec: ExecFn;
  now: () => number;
  /** Probe a TCP port on localhost. Injectable for tests. */
  portOpen: (port: number) => Promise<boolean>;
  /** Run `fn` against a Postgres database, or null when `pg` is unavailable / connection refused. Read-only use only. */
  withDb: <T>(database: string, fn: (q: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>) => Promise<T>) => Promise<T | null>;
  fetchStatus: (url: string) => Promise<number | null>;
  freeBytes: (path: string) => number | null;
  uid: number;
  claudeBin: string;
  /** The app database: DATABASE_URL's database (env or env file) when set, else command_center. */
  appDb?: string;
  /** pg_isready on a unix socket (the bundled cluster, D-98; src/ops/pg-cluster.ts pingSocket). Injectable for tests. */
  pingSocket?: (socket: string) => Promise<'ready' | 'starting' | 'down'>;
  /** Owner uid and permission bits of a path, or null when it is missing. Injectable for tests. */
  /** The web process's read-scope miss count (W34-4); absent in the CLI and the worker, which cannot see it. */
  scopeMisses?: () => { since: string; total: number; scopes: Record<string, number> };
  statPath?: (path: string) => { uid: number; mode: number } | null;
}

export type Check = (c: DoctorContext) => Promise<CheckResult>;

export const ok = (id: string, label: string, detail: string, data?: CheckResult['data'], extra: Pick<CheckResult, 'state'> = {}): CheckResult => ({ id, label, status: 'ok', detail, data, state: extra.state ?? 'ok' });

export const bad = (status: 'warn' | 'fail' | 'skip', id: string, label: string, detail: string, fix?: string, data?: CheckResult['data'], extra: Pick<CheckResult, 'code' | 'state'> = {}): CheckResult => ({
  id,
  label,
  status,
  detail,
  fix,
  data,
  ...(extra.code ? { code: extra.code } : {}),
  ...(extra.state ? { state: extra.state } : {}),
});

/** `~/x` for a path under the home folder (doctor never prints the user name in a path). */
export const tilde = (p: string, home?: string): string => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** "2.1.329 (Claude Code)" / "devbar 0.31.2" / "v22.11.0" → [2, 1, 329]; null when it holds no version. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** a < b for dotted versions. */
export function versionBelow(have: string, min: string): boolean {
  const a = parseVersion(have);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
}

/** Is the app running from a compiled release (D-90: a manifest.json at its root) rather than a source checkout? */
/** The port the web runs with: the env file's PORT over the shell's (run-service.mjs), else 4327 (ON-16). */
export function appPort(c: Pick<DoctorContext, 'env'>): number {
  const p = Number(readEnvFile(envFilePath(c.env))?.PORT ?? c.env.PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : APP_PORT;
}

export const isCompiledRelease = (c: Pick<DoctorContext, 'repoRoot'>): boolean => existsSync(join(c.repoRoot, 'manifest.json'));

/**
 * `npm run <script>` as a person can paste it into any Terminal window (ON-11). In a source checkout it is the plain
 * command (they run it in the checkout). In a compiled release the folder is named, home-relative and quoted (the
 * state folder's path has a space), because nobody's Terminal opens in releases/current.
 */
export function npmRun(c: Pick<DoctorContext, 'repoRoot' | 'env'>, script: string): string {
  if (!isCompiledRelease(c)) return `npm run ${script}`;
  const home = c.env.HOME;
  const cur = currentReleaseLink(c.env);
  const where = home && cur.startsWith(`${home}/`) ? `$HOME${cur.slice(home.length)}` : cur;
  return `npm --prefix "${where}" run ${script}`;
}
