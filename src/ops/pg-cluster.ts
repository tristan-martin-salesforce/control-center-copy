/**
 * The bundled Postgres 17 cluster as doctor sees it (D-98): where it lives, which database this install runs on, and
 * a pg_isready-style probe on its socket (the bundle ships the server only). Twin of the read-only parts of
 * scripts/ops/lib/pg.mjs (the app can't import from scripts/ without bundling it); tests/ops/pg-url.test.ts keeps
 * the two in step.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { stateDir } from './paths';

type Env = Record<string, string | undefined>;

export const PG_MAJOR = 17;
export const DB_LABEL = 'com.commandcenter.db';
export const SOCKET_PATH_MAX = 103;

export const pgRoot = (env: Env = process.env): string => env.CC_PG_DIR ?? join(stateDir(env), 'pg');
export const pgDataDir = (env: Env = process.env): string => join(pgRoot(env), 'data');
export const pgRunDir = (env: Env = process.env): string => env.CC_PG_SOCKET_DIR ?? join(pgRoot(env), 'run');
export const pgEngineRoot = (env: Env = process.env): string => join(pgRoot(env), 'engine');
export const pgMovedMarker = (env: Env = process.env): string => join(pgRoot(env), 'moved-from-homebrew.json');
export const socketFile = (runDir: string, port = 5432): string => join(runDir, `.s.PGSQL.${port}`);

/** The socket folder a URL points at (`?host=/dir` or `postgres://%2Fdir/db`), or null for TCP. */
export function socketDirOf(url: string): string | null {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('host');
    if (q?.startsWith('/')) return q;
    const h = decodeURIComponent(u.hostname);
    return h.startsWith('/') ? h : null;
  } catch {
    return null;
  }
}

export const isBundledUrl = (url: string | undefined, env: Env = process.env): boolean => {
  const d = url ? socketDirOf(url) : null;
  return !!d && resolve(d) === resolve(pgRunDir(env));
};

export function dbNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/** The 1.x default `npm run setup` wrote: Homebrew on this Mac (localhost:5432 or /tmp), command_center, no password. */
export function isV1DefaultUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol) || u.password) return false;
    const sock = socketDirOf(url);
    const local = sock ? resolve(sock) === '/tmp' : ['localhost', '127.0.0.1', '[::1]', ''].includes(u.hostname);
    return local && (u.port === '' || u.port === '5432') && ['command_center', 'control_center'].includes(dbNameOf(url));
  } catch {
    return false;
  }
}

export type DbEngine = { engine: 'bundled' | 'homebrew' | 'user'; source: 'env' | 'file' | 'default'; url?: string; keep?: boolean };

/** Which database this install runs on (twin of pg.mjs dbEngine): bundled, homebrew (the 1.x default) or user (yours). */
export function dbEngine(env: Env, fileEnv: Record<string, string>): DbEngine {
  if (env.DATABASE_URL) return { engine: isBundledUrl(env.DATABASE_URL, env) ? 'bundled' : 'user', source: 'env', url: env.DATABASE_URL };
  const f = fileEnv.DATABASE_URL;
  if (f) {
    if (isBundledUrl(f, env)) return { engine: 'bundled', source: 'file', url: f };
    if (isV1DefaultUrl(f)) return { engine: 'homebrew', source: 'file', url: f, keep: fileEnv.CC_DB_ENGINE === 'homebrew' };
    return { engine: 'user', source: 'file', url: f };
  }
  return { engine: 'bundled', source: 'default' };
}

export function dataMajor(dataDir: string): number | null {
  try {
    return Number(readFileSync(join(dataDir, 'PG_VERSION'), 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

/** The newest finished engine copy (`<state>/pg/engine/<version>-<arch>/.complete`), or null. */
export function installedEngine(env: Env = process.env): { dir: string; version: string; major: number | null } | null {
  const root = pgEngineRoot(env);
  if (!existsSync(root)) return null;
  const name = readdirSync(root)
    .filter((n) => !n.startsWith('.') && existsSync(join(root, n, '.complete')))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .at(-1);
  if (!name) return null;
  const version = name.replace(/-(arm64|x64)$/, '');
  return { dir: join(root, name), version, major: Number(version.split('.')[0]) || null };
}

export interface MovedMarker {
  movedAt: string;
  database: string;
  keepDays: number;
}

export function readMovedMarker(env: Env = process.env): MovedMarker | null {
  try {
    const m = JSON.parse(readFileSync(pgMovedMarker(env), 'utf8')) as Partial<MovedMarker>;
    return typeof m.movedAt === 'string' ? { movedAt: m.movedAt, database: m.database ?? 'control_center', keepDays: m.keepDays ?? 14 } : null;
  } catch {
    return null;
  }
}

export type PingResult = 'ready' | 'starting' | 'down';

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? '';
  }
}

/**
 * pg_isready on a unix socket without pg_isready: a startup packet, then the first answer. An authentication request
 * or any error but 57P03 ("starting up") means the server accepts connections. Twin of pg.mjs pgPing.
 */
export function pingSocket(sock: string, { user = osUser(), timeoutMs = 3000 }: { user?: string; timeoutMs?: number } = {}): Promise<PingResult> {
  return new Promise((done) => {
    let settled = false;
    const s = net.createConnection({ path: sock });
    const finish = (r: PingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (r === 'ready' && !s.destroyed) {
        s.end(Buffer.from([0x58, 0, 0, 0, 4])); // Terminate: no "broken pipe" in the server log
        setTimeout(() => s.destroy(), 200).unref();
      } else s.destroy();
      done(r);
    };
    const timer = setTimeout(() => finish('down'), timeoutMs);
    s.on('error', () => finish('down'));
    s.on('connect', () => {
      const params = Buffer.from(`user\0${user}\0database\0postgres\0\0`);
      const head = Buffer.alloc(8);
      head.writeInt32BE(8 + params.length, 0);
      head.writeInt32BE(196608, 4);
      s.write(Buffer.concat([head, params]));
    });
    let buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      if (settled) return;
      buf = Buffer.concat([buf, d]);
      if (buf[0] !== 0x45) return finish('ready');
      if (buf.length < 5) return;
      const len = buf.readInt32BE(1);
      if (buf.length < len + 1) return;
      const code = buf.subarray(5, len + 1).toString('utf8').split('\0').find((f) => f.startsWith('C'))?.slice(1);
      finish(code === '57P03' ? 'starting' : 'ready');
    });
  });
}
