/**
 * Doctor check `data:kv-fallback` (D-98, DATA.KV.FALLBACK): how many rows the app still reads from the kv side-car
 * because the 0036 backfill has not copied them into their columns and tables yet, per family, and whether the
 * `kv.backfill` job finished. Zero is the condition for the later migration that drops the kv keys
 * (docs/DATA-MIGRATIONS.md "Drop step"). Read-only: it runs the backfill's own "pending" queries. Counts only.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import { BACKFILL_FAMILIES, KV_BACKFILL_NAME } from '../../jobs/handlers/kv-backfill';
import type { DbOrTx } from '../../db/client';
import { appDb } from './database';
import { bad, npmRun, ok, type Check, type CheckResult, type DoctorContext } from './types';

export const KV_FALLBACK_COUNTER = 'DATA.KV.FALLBACK';

const dialect = new PgDialect();

export const checkKvFallback: Check = async (c) => {
  const id = 'data:kv-fallback';
  const label = 'Data migration (kv side-car → columns)';
  const res = await c.withDb(appDb(c), async (q) => {
    const has = await q(`select to_regclass('public.data_backfills') is not null as ok`);
    if (!has[0]?.ok) return null;
    // the backfill's own pending queries, run through this check's read-only connection
    const db = { execute: async (s: SQL) => {
      const x = dialect.sqlToQuery(s);
      return { rows: await q(x.sql, x.params as unknown[]) };
    } } as unknown as DbOrTx;
    const users = await q('select id::text as id from users order by created_at');
    const pending: Record<string, number> = {};
    for (const u of users) for (const f of BACKFILL_FAMILIES) pending[f.id] = (pending[f.id] ?? 0) + (await f.pending(db, String(u.id)));
    const runs = await q(`select state, count(*)::int as n from data_backfills where name = $1 group by state`, [KV_BACKFILL_NAME]);
    return { users: users.length, pending, states: Object.fromEntries(runs.map((r) => [String(r.state), Number(r.n)])) };
  });
  if (res === undefined || res === null) return bad('skip', id, label, 'no data_backfills table (the database is before 0036) or no connection', npmRun(c, 'db:migrate'));
  const total = Object.values(res.pending).reduce((a, n) => a + n, 0);
  const open = Object.entries(res.pending).filter(([, n]) => n > 0);
  const done = res.states.done ?? 0;
  const data = { counter: KV_FALLBACK_COUNTER, fallback: total, pending: res.pending, backfill: res.states, users: res.users };
  if (!total) return ok(id, label, `nothing read from the kv side-car any more${done ? `; backfill done for ${done} user(s)` : ''}`, data);
  const what = open.map(([f, n]) => `${f} ${n}`).join(', ');
  return bad('warn', id, label, `${total} row(s) still read from the kv side-car (${KV_FALLBACK_COUNTER}): ${what}`, 'Let the worker finish its kv.backfill job, or run: npm run db:backfill', data);
};

export const READ_SCOPES_FIX = 'report it; CC_READ_SCOPES=off if a page looks wrong';

/**
 * `data:read-scopes` (W34-4): page reads that fell back to the whole read model (BUG.READ_SCOPE_MISS) since the web
 * process started. The counter lives in the web process, so only the web's doctor service can answer; the CLI and the
 * worker skip. Counts and scope labels only.
 */
export const readScopesResult = (scopeMisses: DoctorContext['scopeMisses']): CheckResult => {
  const id = 'data:read-scopes';
  const label = 'Page reads (scope misses)';
  if (!scopeMisses) return bad('skip', id, label, 'counted in the web process; see Health ▸ Setup or GET /api/v1/doctor');
  const m = scopeMisses();
  const data = { since: m.since, total: m.total, scopes: m.scopes };
  if (!m.total) return ok(id, label, `no page read fell back to the whole model since ${m.since}`, data);
  const names = Object.entries(m.scopes).map(([k, n]) => `${k} x${n}`).join(', ');
  return bad('warn', id, label, `${m.total} reads fell back to the whole model since ${m.since} (scopes: ${names})`, READ_SCOPES_FIX, data, { state: 'installed' });
};

export const checkReadScopes: Check = async (c) => readScopesResult(c.scopeMisses);
