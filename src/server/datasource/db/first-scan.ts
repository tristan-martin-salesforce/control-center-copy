/**
 * Health's first-scan progress (AUDIT): the worker's `<CC_STATE_DIR>/first-scan.json`, read server-side and joined with
 * each scope's committed coverage. Read-only; the scanner's first-scan code (src/scanner/runtime/first-scan.ts) owns
 * the file and is not touched.
 *
 * Coverage of a scope = committed ledger ranges inside [its floor, the first scan's start) over that span. Tests never
 * read the real state folder: under vitest the file is read only when CC_STATE_DIR is set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import type { FirstScanProgress } from '@/contract';
import type { DbOrTx } from '@/db/client';
import { stateDir } from '@/ops/paths';
import type { FirstScanSourceProgress } from '@/scanner/runtime/first-scan';

import { firstScanSources } from './scan-cadence';

interface FileState {
  lookbackDays?: number;
  budgetUsd?: number;
  startedAt?: string;
  floorAt?: string;
  floors?: Record<string, string>;
  spentUsd?: number;
  scopes?: Record<string, 'pending' | 'done'>;
  status?: 'active' | 'done' | 'exhausted';
  replans?: Record<string, number>;
  /** FS-LATE: channel scopes that joined after the first scan had finished → when. */
  late?: Record<string, string>;
  doneAt?: string;
  /** FTI first scan: per source read / found / spend (src/scanner/runtime/first-scan.ts noteProgress). */
  sources?: Record<string, FirstScanSourceProgress>;
}

export function readFirstScanFile(env: Record<string, string | undefined> = process.env): FileState | null {
  if (env.VITEST && !env.CC_STATE_DIR) return null;
  try {
    const s = JSON.parse(readFileSync(join(stateDir(env), 'first-scan.json'), 'utf8')) as FileState;
    return s && typeof s.startedAt === 'string' && typeof s.floorAt === 'string' ? s : null;
  } catch {
    return null;
  }
}

const iso = (v: unknown) => new Date(v as string).toISOString();

export async function loadFirstScanProgress(db: DbOrTx, userId: string, file: FileState | null = readFirstScanFile()): Promise<FirstScanProgress | null> {
  if (!file || !file.startedAt || !file.floorAt) return null;
  const startedAt = iso(file.startedAt);
  const scopes: FirstScanProgress['scopes'] = [];
  // One-time spend per scope (BUD-1: the first-scan budget's own ledger rows).
  const spent = new Map<string, number>();
  const sp = await db.execute<{ scope: string; usd: string | number }>(sql`
    select r.scope, sum(c.cost_usd) as usd from llm_calls c join scan_runs r on r.id = c.scan_run_id
     where c.owner_user_id = ${userId} and c.budget = 'first_scan' group by r.scope`);
  for (const r of sp.rows) spent.set(r.scope, Math.round(Number(r.usd) * 1e4) / 1e4);
  for (const [scope, status] of Object.entries(file.scopes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const floorAt = iso(file.floors?.[scope] ?? file.floorAt);
    // FS-LATE: a channel that joined later covers [its floor, when it joined).
    const joinedAt = file.late?.[scope] ? iso(file.late[scope]) : null;
    const scopeStart = joinedAt ?? startedAt;
    const span = Date.parse(scopeStart) - Date.parse(floorAt);
    let coveredPct: number | null = null;
    if (span > 0) {
      const r = await db.execute<{ ms: string | number | null; n: number }>(sql`
        select sum(extract(epoch from (least(upper(x), ${scopeStart}::timestamptz) - greatest(lower(x), ${floorAt}::timestamptz))) * 1000) as ms, count(*)::int as n
          from (select unnest(range_agg(l.covered)) as x from scan_ledger_entries l join scan_runs r on r.id = l.scan_run_id
                 where r.owner_user_id = ${userId} and l.scope = ${scope} and l.outcome = 'complete' and l.covered is not null
                   and l.covered && tstzrange(${floorAt}::timestamptz, ${scopeStart}::timestamptz)) y`);
      const ran = await db.execute<{ n: number }>(sql`select count(*)::int as n from scan_runs where owner_user_id = ${userId} and scope = ${scope}`);
      if ((ran.rows[0]?.n ?? 0) > 0) coveredPct = Math.max(0, Math.min(100, Math.round((Number(r.rows[0]?.ms ?? 0) / span) * 1000) / 10));
    }
    scopes.push({ scope, connector: scope.split(':')[0] ?? scope, status, floorAt, coveredPct, replans: file.replans?.[scope] ?? 0, joinedAt, spentUsd: spent.get(scope) ?? 0 });
  }
  return {
    status: file.status ?? 'active',
    lookbackDays: file.lookbackDays ?? 0,
    startedAt,
    floorAt: iso(file.floorAt),
    budgetUsd: Number(file.budgetUsd ?? 0),
    spentUsd: Math.round(Number(file.spentUsd ?? 0) * 1e4) / 1e4,
    doneAt: file.doneAt ? iso(file.doneAt) : null,
    scopes,
    ...(firstScanSources(file.sources) ? { sources: firstScanSources(file.sources) } : {}),
  };
}
