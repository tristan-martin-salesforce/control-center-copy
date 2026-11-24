/**
 * D-98 (0036): your edits on logging canvas rows before Apply, one `canvas_row_overrides` row per row key. They were
 * one kv map (`canvas.row_overrides`, src/lib/canvas/overrides.ts); the table is audited, so an edit is still part of
 * its change set and Undo restores it.
 *
 *   write   `writeRowOverridesMap` (routed from the kv write helper: store/common.ts writeKv) turns the whole map the
 *           callers build (`withRowOverride`) into row upserts and deletes, then drops the old kv map (kept only with
 *           CC_KV_DUAL_WRITE=1, the rollback window).
 *   read    `loadRowOverridesTable`: the rows; while the backfill has not copied the old map, its keys with no row are
 *           the fallback (counted).
 */
import { sql } from 'drizzle-orm';

import type { DbOrTx, Tx } from '@/db/client';
import { NO_ROW_OVERRIDES, ROW_OVERRIDES_KV, rowOverridesOf, type RowOverrides } from '@/lib/canvas/overrides';

import { canon } from './ext';
import { countKvFallback, dualWriteAll } from './store/sidecar';

export { ROW_OVERRIDES_KV };

async function tableRows(db: DbOrTx, userId: string): Promise<RowOverrides> {
  const r = await db.execute<{ row_key: string; fields: unknown; edited_at: string }>(sql`
    select row_key, fields, edited_at from canvas_row_overrides where owner_user_id = ${userId}::uuid order by row_key`);
  if (!r.rows.length) return NO_ROW_OVERRIDES;
  return rowOverridesOf(Object.fromEntries(r.rows.map((x) => [x.row_key, { fields: x.fields, at: x.edited_at }] as const)));
}

/** The overrides: the table's rows, plus the old kv map's keys it does not hold yet (the dual-read window). */
export async function loadRowOverridesTable(db: DbOrTx, userId: string): Promise<RowOverrides> {
  const rows = await tableRows(db, userId);
  const kv = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId}::uuid and key = ${ROW_OVERRIDES_KV}`);
  const old = rowOverridesOf(kv.rows[0]?.value);
  const missing = Object.keys(old).filter((k) => !(k in rows));
  if (!missing.length) return rows;
  countKvFallback(missing.length);
  return { ...Object.fromEntries(missing.map((k) => [k, old[k]!] as const)), ...rows };
}

/** Write the whole map as rows inside the caller's change set (a no-op for rows that did not change). */
export async function writeRowOverridesMap(tx: Tx, userId: string, value: unknown): Promise<void> {
  const next = rowOverridesOf(value);
  const cur = await tableRows(tx, userId);
  const gone = Object.keys(cur).filter((k) => !(k in next));
  if (gone.length) await tx.execute(sql`delete from canvas_row_overrides where owner_user_id = ${userId}::uuid and row_key in (${sql.join(gone.map((k) => sql`${k}`), sql`, `)})`);
  for (const [key, o] of Object.entries(next)) {
    const had = cur[key];
    if (had && canon(had) === canon(o)) continue;
    await tx.execute(sql`
      insert into canvas_row_overrides (owner_user_id, row_key, fields, edited_at) values (${userId}::uuid, ${key}, ${JSON.stringify(o.fields)}::jsonb, ${o.at})
      on conflict (owner_user_id, row_key) do update set fields = excluded.fields, edited_at = excluded.edited_at, updated_at = now()`);
  }
}

export const rowOverridesKeepKv = (): boolean => dualWriteAll();
