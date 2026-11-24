/**
 * Postgres pool + Drizzle instance (node-postgres), after vdp-app's lib/db/client.ts.
 *
 * - resolveDatabaseUrl(): DATABASE_URL (environment, then the env file), else the bundled Postgres 17 cluster's
 *   socket (D-98). CLAUDE.md invariant 6: state lives in Postgres, never in the repo.
 * - Pool max 5 for both web and worker (DATA-MODEL §3.3).
 * - Every session runs with TimeZone=UTC, so timestamps inside audit images (to_jsonb) render
 *   identically whichever process wrote them.
 * - Created lazily: importing this module never opens a connection, so typecheck, drizzle-kit and
 *   tests that build their own pool via createDb() don't need a database.
 */
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import { STATE_FOLDER_NAME } from '../lib/state-folder';
import * as schema from './schema';

/** The 1.x default (Homebrew Postgres 17 on :5432). No longer the fallback: resolveDatabaseUrl ends at the bundled socket. */
export const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/command_center';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** The transaction handle drizzle passes to `db.transaction(fn)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: Pool;
  /** Drains the pool. Safe to call more than once. */
  close(): Promise<void>;
}

export interface CreateDbOptions {
  url?: string;
  max?: number;
  applicationName?: string;
  pool?: Omit<PoolConfig, 'connectionString'>;
}

type Env = Record<string, string | undefined>;

const stateDirOf = (env: Env): string => env.CC_STATE_DIR ?? path.join(env.HOME || homedir(), 'Library', 'Application Support', STATE_FOLDER_NAME);

function osUser(env: Env): string {
  try {
    return userInfo().username;
  } catch {
    return env.USER ?? env.LOGNAME ?? '';
  }
}

/**
 * The bundled Postgres 17 cluster's URL (D-98): its unix socket folder as libpq's `host` (percent-encoded: the state
 * folder's path has a space) and this Mac user (peer auth; launchd may not set USER). Twin of
 * scripts/ops/lib/pg.mjs bundledDatabaseUrl.
 */
export function bundledDatabaseUrl(env: Env = process.env, db = 'command_center'): string {
  const runDir = env.CC_PG_SOCKET_DIR ?? path.join(env.CC_PG_DIR ?? path.join(stateDirOf(env), 'pg'), 'run');
  return `postgresql:///${db}?host=${encodeURIComponent(runDir)}&user=${encodeURIComponent(osUser(env))}`;
}

/** DATABASE_URL from the state folder's env file (the one the LaunchAgents load), or undefined. Never logged. */
function envFileDatabaseUrl(env: Env): string | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(stateDirOf(env), 'env'), 'utf8');
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[1]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    found = v; // the last one wins, as the env file loader reads it (src/ops/envfile.ts)
  }
  return found || undefined;
}

/**
 * The database URL, in order (D-98): an explicit `url` → the environment's DATABASE_URL → the env file's
 * DATABASE_URL (written by the installer; a source checkout on Homebrew keeps working through it) → the bundled
 * cluster's socket URL. Twin of scripts/ops/lib/pg.mjs resolveDatabaseUrl.
 */
export function resolveDatabaseUrl(url?: string, env: Env = process.env): string {
  return url || env.DATABASE_URL || envFileDatabaseUrl(env) || bundledDatabaseUrl(env);
}

/** Database name of a connection URL, for logs (never print the URL: it may carry a password). */
export function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || '(default)';
  } catch {
    return '(unparseable url)';
  }
}

export function createDb(opts: CreateDbOptions = {}): DbHandle {
  const pool = new Pool({
    connectionString: resolveDatabaseUrl(opts.url),
    max: opts.max ?? 5,
    application_name: opts.applicationName ?? 'command-center',
    options: '-c TimeZone=UTC',
    ...opts.pool,
  });
  // An idle client erroring (server restart) must not crash the process; the next query reconnects.
  pool.on('error', (err) => {
    console.error(`[db] idle client error: ${err.message}`);
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  let closed: Promise<void> | undefined;
  return {
    db,
    pool,
    close: () => (closed ??= pool.end()),
  };
}

let shared: DbHandle | undefined;

/** The process-wide handle (web or worker). */
export function getDbHandle(): DbHandle {
  return (shared ??= createDb());
}

export function getDb(): Db {
  return getDbHandle().db;
}

/** Graceful shutdown: drain the shared pool. The next getDb() opens a fresh one. */
export async function closeDb(): Promise<void> {
  const handle = shared;
  shared = undefined;
  await handle?.close();
}
