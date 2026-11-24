/**
 * D-98 (0036): the kv side-car's business state, promoted to columns. One registry says which ext fields of which table
 * now live in a column; the two kv helpers route through it, so every existing writer and reader keeps its shape.
 *
 *   write   `writeExt(w, table, id, value)` (common.ts) splits the entity's ext object: promoted fields go to their
 *           columns (one fenced UPDATE, audited in the caller's change set), the rest stays in `cc.ext/<table>/<id>`.
 *           A promoted field is also kept in the kv only while a listed reader outside the store still reads it there
 *           (`dual`), or when the owner turned dual-write on for a rollback window (`CC_KV_DUAL_WRITE=1`).
 *   read    `overlayPromoted()` (called by loadKv, ext.ts) puts the column values into the kv map the read model and
 *           every WriteCtx carry, so an entity's ext object reads whole: column first, the kv value as the fallback
 *           while the column is still empty (a row the `kv.backfill` job has not reached). Each fallback is counted
 *           (`kvFallbacks()`; Doctor's DATA.KV.FALLBACK counts what is still pending in the database).
 *
 * Why a registry and not new mappers: the store reads and writes ext objects in ~40 places (DM-1). Routing at the two
 * helpers moves every field in one place and keeps contract parity with the mock; the page-scoped reads chunk
 * (p4-page-scoped-reads) then reads the columns directly and this overlay shrinks with the kv keys in 2.1.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { DbOrTx, Tx } from '@/db/client';

export type PromotedType = 'text' | 'bool' | 'jsonb' | 'text[]' | 'uuid' | 'tstz';

export interface PromotedField {
  /** The ext object's key (the contract-side name). */
  field: string;
  column: string;
  type: PromotedType;
  /** A reader outside the store still reads this field from the kv: keep writing it there until that release. */
  dual?: { until: string; readers: readonly string[] };
}

export const PROMOTED: Readonly<Record<string, readonly PromotedField[]>> = {
  accounts: [
    { field: 'dcStatus', column: 'dc_status', type: 'text' },
    { field: 'org62Url', column: 'org62_url', type: 'text' },
  ],
  opportunities: [
    // TODO(2.1): drop the kv copy once src/projections/run.model.ts (DC-status rollup) and src/jobs/handlers/brief.ts read dc_assigned
    { field: 'dcAssigned', column: 'dc_assigned', type: 'bool', dual: { until: '2.1', readers: ['src/projections/run.model.ts', 'src/jobs/handlers/brief.ts'] } },
    { field: 'nextStep', column: 'next_step', type: 'text' },
    { field: 'products', column: 'products', type: 'text[]' },
    { field: 'ownerId', column: 'owner_person_id', type: 'uuid' },
    { field: 'leftBookAt', column: 'left_book_at', type: 'tstz' },
  ],
  activity_entries: [
    { field: 'logNote', column: 'log_note', type: 'text' },
    { field: 'logNoteBasis', column: 'log_note_basis', type: 'text' },
  ],
  work_items: [
    { field: 'startByUser', column: 'start_by_user', type: 'jsonb' },
    { field: 'dismissed', column: 'dismissed', type: 'jsonb' },
  ],
};

export const PROMOTED_TABLES = Object.keys(PROMOTED);

/** The owner's rollback window: every promoted field is also written to the kv (off by default; docs/DATA-MIGRATIONS.md). */
export const dualWriteAll = (): boolean => process.env.CC_KV_DUAL_WRITE === '1';

const keepInKv = (f: PromotedField) => !!f.dual || dualWriteAll();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An ext value as the column holds it (null = empty: no value, false, an empty list, or one the column can't hold). */
export function toColumn(f: PromotedField, v: unknown): unknown {
  if (v === undefined || v === null) return f.type === 'bool' ? false : null;
  switch (f.type) {
    case 'bool':
      return v === true;
    case 'text':
      return typeof v === 'string' ? v : String(v);
    case 'text[]':
      return Array.isArray(v) && v.length ? v.map(String) : null;
    case 'uuid':
      return typeof v === 'string' && UUID.test(v) ? v : null;
    case 'tstz': {
      const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
    }
    case 'jsonb':
      return v;
  }
}

/** A column value as the ext object holds it; undefined = empty (the field is absent from the object). */
export function fromColumn(f: PromotedField, raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  switch (f.type) {
    case 'bool':
      return raw === true ? true : undefined;
    case 'text[]':
      return Array.isArray(raw) && raw.length ? raw : undefined;
    case 'tstz':
      return new Date(raw as string | Date).toISOString();
    default:
      return raw;
  }
}

/** Would the column hold this value (i.e. the kv copy is not needed to read it back)? */
const fits = (f: PromotedField, v: unknown) => fromColumn(f, toColumn(f, v)) !== undefined;

function param(f: PromotedField, v: unknown): SQL {
  const c = toColumn(f, v);
  switch (f.type) {
    case 'bool':
      return sql`${c}::boolean`;
    case 'text':
      return sql`${c}::text`;
    case 'text[]':
      // drizzle spreads a JS array into a row of params: pass it as json and unpack it in SQL
      return c === null ? sql`null::text[]` : sql`array(select jsonb_array_elements_text(${JSON.stringify(c)}::jsonb))`;
    case 'uuid':
      return sql`${c}::uuid`;
    case 'tstz':
      return sql`${c}::timestamptz`;
    case 'jsonb':
      return c === null ? sql`null::jsonb` : sql`${JSON.stringify(c)}::jsonb`;
  }
}

/**
 * Split an entity's whole ext object: what its columns get (every promoted field: absent = empty) and what stays in
 * the kv. A value the column can't hold (a malformed uuid) stays in the kv rather than being lost.
 */
export function splitExt(table: string, value: Record<string, unknown> | null): { columns: Map<PromotedField, unknown>; kv: Record<string, unknown> | null } {
  const fields = PROMOTED[table] ?? [];
  const columns = new Map<PromotedField, unknown>();
  if (!value) {
    for (const f of fields) columns.set(f, null);
    return { columns, kv: null };
  }
  const kv: Record<string, unknown> = { ...value };
  for (const f of fields) {
    const v = value[f.field];
    columns.set(f, v ?? null);
    if (v !== undefined && fits(f, v) && !keepInKv(f)) delete kv[f.field];
  }
  return { columns, kv: Object.keys(kv).length ? kv : null };
}

/** Write the promoted columns of one row inside the caller's change set; a no-op when they already hold these values. */
export async function writePromotedColumns(tx: Tx, userId: string, table: string, id: string, columns: Map<PromotedField, unknown>): Promise<void> {
  if (!columns.size) return;
  const sets: SQL[] = [];
  const differs: SQL[] = [];
  for (const [f, v] of columns) {
    const p = param(f, v);
    sets.push(sql`${sql.identifier(f.column)} = ${p}`);
    differs.push(sql`${sql.identifier(f.column)} is distinct from ${p}`);
  }
  await tx.execute(sql`update ${sql.identifier(table)} set ${sql.join(sets, sql`, `)}
    where owner_user_id = ${userId}::uuid and id::text = ${id} and (${sql.join(differs, sql` or `)})`);
}

// ---------------------------------------------------------------------------
// Read side: the overlay, and the fallback counter
// ---------------------------------------------------------------------------

let fallbacks = 0;
/** Reads that fell back to the kv since the process started (an empty column, a kv value). */
export const kvFallbacks = (): number => fallbacks;
export const countKvFallback = (n = 1): void => {
  fallbacks += n;
};

const nonEmpty = (f: PromotedField): SQL => (f.type === 'bool' ? sql`${sql.identifier(f.column)}` : sql`${sql.identifier(f.column)} is not null`);

/**
 * Put the promoted column values into a user's kv map (`cc.ext/<table>/<id>`): the column wins; a kv value stays as
 * the fallback where the column is still empty. Entities whose ext now lives only in columns get their entry back.
 */
export async function overlayPromoted(db: DbOrTx, userId: string, kv: Map<string, unknown>): Promise<void> {
  for (const table of PROMOTED_TABLES) {
    const fields = PROMOTED[table]!;
    const prefix = `cc.ext/${table}/`;
    // one after another: inside a transaction one client runs one query at a time
    const r = await db.execute<Record<string, unknown> & { id: string }>(sql`
      select id::text as id, ${sql.join(
        fields.map((f) => sql`${sql.identifier(f.column)}`),
        sql`, `,
      )} from ${sql.identifier(table)}
       where owner_user_id = ${userId}::uuid and (${sql.join(fields.map(nonEmpty), sql` or `)})`);
    const filled = new Map<string, Set<string>>();
    for (const row of r.rows) {
      const key = prefix + row.id;
      const cur = (kv.get(key) as Record<string, unknown> | undefined) ?? {};
      const next: Record<string, unknown> = { ...cur };
      const got = new Set<string>();
      for (const f of fields) {
        const v = fromColumn(f, row[f.column]);
        if (v === undefined) continue;
        next[f.field] = v;
        got.add(f.field);
      }
      filled.set(row.id, got);
      kv.set(key, next);
    }
    for (const [key, v] of kv) {
      if (!key.startsWith(prefix) || !v || typeof v !== 'object') continue;
      const got = filled.get(key.slice(prefix.length));
      for (const f of fields) if (f.field in (v as Record<string, unknown>) && !got?.has(f.field) && fits(f, (v as Record<string, unknown>)[f.field])) countKvFallback();
    }
  }
}
