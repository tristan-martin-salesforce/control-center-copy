/**
 * Shared bits of the scan audit CLIs (`npm run scan:trace | scan:explain | scan:report`).
 *
 * Read-only: they only SELECT. They use DATABASE_URL (default postgres://localhost:5432/command_center) and print the
 * database name, never the URL. Output is ids, codes, counts, links and short reasons; `--json` prints the raw result.
 */
import { sql } from 'drizzle-orm';

import { createDb, databaseName, resolveDatabaseUrl, type Db, type DbHandle } from '../../src/db/client';

export function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export const has = (argv: string[], name: string) => argv.includes(name);

export async function open(): Promise<{ handle: DbHandle; db: Db; userId: string; dbName: string }> {
  const url = resolveDatabaseUrl();
  const handle = createDb({ url, max: 2, applicationName: 'command-center-scan-cli' });
  const u = await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`);
  if (!u.rows[0]) {
    await handle.close();
    throw new Error(`no user in ${databaseName(url)} (run npm run db:bootstrap)`);
  }
  return { handle, db: handle.db, userId: u.rows[0].id, dbName: databaseName(url) };
}

/** `24h`, `90m`, `7d`, or an ISO time → a Date in the past. */
export function sinceOf(v: string | undefined, now = new Date()): Date {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/.exec((v ?? '24h').trim());
  if (m) return new Date(now.getTime() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']);
  const t = Date.parse(v ?? '');
  if (!Number.isNaN(t)) return new Date(t);
  throw new Error(`--since: expected 24h / 90m / 7d or an ISO time, got "${v}"`);
}

export const hhmmss = (iso: string | null | undefined) => (iso ? iso.slice(11, 19) : '--:--:--');
export const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/** Compact `k=v` rendering of a payload (strings quoted only when they hold spaces). */
export function kv(p: Record<string, unknown>, skip: string[] = []): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (skip.includes(k) || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    let s: string;
    if (typeof v === 'string') s = /\s/.test(v) ? JSON.stringify(v) : v;
    else if (Array.isArray(v)) s = k.endsWith('Ids') || k === 'ids' || k === 'newIds' ? `[${v.length}]` : JSON.stringify(v);
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

export async function main(fn: (argv: string[]) => Promise<number | void>): Promise<void> {
  try {
    const code = await fn(process.argv.slice(2));
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
