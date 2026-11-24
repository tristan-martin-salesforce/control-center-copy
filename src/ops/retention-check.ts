/**
 * Doctor check `db:size`: how big the app database is, the five biggest tables, and how fast it grows. A warning over
 * 2 GB, with the next step "Run retention now" (npm run db:retention; POST /api/v1/retention/run). Read-only.
 * (src/ops/checks/ does not exist on this base, so the check lives beside doctor.ts and has the same shape.)
 */
import { DB_WARN_BYTES } from '../db/retention/policy';
import type { CheckResult, DoctorContext } from './checks/types';
import { DB_NAME } from './paths';

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;
const mb = (b: number) => `${(b / 1024 ** 2).toFixed(0)} MB`;
const human = (b: number) => (b >= 1024 ** 3 ? gb(b) : mb(b));

export interface DbSizeTable {
  table: string;
  bytes: number;
  /** Net rows added per day since the stats began (inserts less deletes), times bytes per row; null when unknown. */
  growthBytesPerDay: number | null;
}

export const checkDbSize = async (c: DoctorContext): Promise<CheckResult> => {
  const label = 'Database size';
  const db = c.appDb ?? DB_NAME;
  const rows = await c.withDb(db, async (q) => {
    const total = await q('select pg_database_size(current_database())::text as bytes');
    const top = await q(`
      select c.relname as t, pg_total_relation_size(c.oid)::text as bytes, greatest(c.reltuples, 1)::float8 as rows,
             coalesce(s.n_tup_ins, 0)::float8 as ins, coalesce(s.n_tup_del, 0)::float8 as del
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        left join pg_stat_user_tables s on s.relid = c.oid
       where c.relkind = 'r' order by pg_total_relation_size(c.oid) desc limit 5`);
    const age = await q(`select extract(epoch from now() - coalesce((select stats_reset from pg_stat_database where datname = current_database()), pg_postmaster_start_time()))::float8 as secs`);
    return { total: Number(total[0]?.bytes ?? 0), top, days: Number(age[0]?.secs ?? 0) / 86_400 };
  });
  if (!rows) return { id: 'db:size', label, status: 'skip', detail: 'could not read the database size', fix: 'start Postgres first' };
  const tables: DbSizeTable[] = rows.top.map((r) => {
    const bytes = Number(r.bytes);
    const net = Number(r.ins) - Number(r.del);
    return { table: String(r.t), bytes, growthBytesPerDay: rows.days >= 0.5 ? Math.round((net / rows.days) * (bytes / Number(r.rows))) : null };
  });
  const growing = tables.filter((t) => t.growthBytesPerDay !== null);
  const growth = growing.length ? growing.reduce((a, t) => a + (t.growthBytesPerDay ?? 0), 0) : null;
  const detail = `${human(rows.total)}; top: ${tables.map((t) => `${t.table} ${human(t.bytes)}`).join(', ')}${growth !== null ? `; the top 5 grow about ${mb(Math.max(growth, 0))}/day` : ''}`;
  const data = { bytes: rows.total, top: tables, growthBytesPerDay: growth };
  if (rows.total > DB_WARN_BYTES) {
    return { id: 'db:size', label, status: 'warn', detail: `${gb(rows.total)} is over ${gb(DB_WARN_BYTES)}; ${detail}`, fix: 'Run retention now: npm run db:retention (or POST /api/v1/retention/run), then let the next vacuum return the space', data };
  }
  return { id: 'db:size', label, status: 'ok', detail, data };
};
