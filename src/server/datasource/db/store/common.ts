/**
 * Shared plumbing for the row ↔ contract mappers (store/*.ts).
 *
 * Every mapper pair follows one shape:
 *   load<X>(db, rc)                      rows → contract records (the read side)
 *   write<X>(w, before, after, opts?)    contract record diff → column patch + child rows + ext (the write side)
 * The writer always runs inside the caller's change set (`w.tx`, `w.cs`), so the audit trigger records it
 * and undoChangeSet can revert it.
 */
import { and, eq, getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { ChangeSetContext } from '@/db/changeset';
import type { Db, Tx } from '@/db/client';
import { ConflictError } from '@/db/errors';
import type { PersonRef } from '@/contract';

import { ROW_OVERRIDES_KV, rowOverridesKeepKv, writeRowOverridesMap } from '../canvas-overrides';
import { canon, extKey, putKv } from '../ext';
import { uuidFor } from '../ids';
import { needDecisionKeepsKv, parseNeedKey, writeNeedDecisionRow } from '../needs-decisions';
import { PROMOTED, splitExt, writePromotedColumns } from './sidecar';

/** Read context: ext side-car + lookups every mapper may need. */
export interface ReadCtx {
  db: Db;
  userId: string;
  /** Contract id + name of the user's own person row (owner null ⇒ me). */
  me: { id: string; name: string };
  timezone: string;
  kv: Map<string, unknown>;
  people: Map<string, PersonRef & { accountId: string | null }>;
  now: Date;
}

export function ext<T = Record<string, unknown>>(rc: { kv: Map<string, unknown> }, table: string, id: string): Partial<T> {
  return (rc.kv.get(extKey(table, id)) as Partial<T> | undefined) ?? {};
}

/** Write context: the open change set. */
export interface WriteCtx {
  tx: Tx;
  cs: ChangeSetContext;
  userId: string;
  me: { id: string; name: string };
  now: Date;
  /** Extractor row used for app-written evidence and links (extractor_id is NOT NULL). */
  extractorId: string;
  timezone: string;
  /** Previous kv values (ext / singletons) for no-op detection. */
  kv: Map<string, unknown>;
}

/**
 * Write an entity's whole ext object. D-98: the fields a column now holds (store/sidecar.ts PROMOTED) go to the row's
 * columns and leave the kv; `w.kv` keeps the whole object, so the next write and every reader see it as before.
 */
export async function writeExt(w: WriteCtx, table: string, id: string, value: Record<string, unknown> | null): Promise<void> {
  const key = extKey(table, id);
  const prev = w.kv.get(key);
  const next = value ? compactExt(value) : null;
  const empty = !next || Object.keys(next).length === 0;
  if (canon(prev ?? null) === canon(empty ? null : next)) return;
  if (PROMOTED[table]) {
    const split = splitExt(table, empty ? null : next);
    await writePromotedColumns(w.tx, w.userId, table, id, split.columns);
    await putKv(w.tx, w.userId, key, split.kv);
  } else await putKv(w.tx, w.userId, key, empty ? null : next);
  if (empty) w.kv.delete(key);
  else w.kv.set(key, next);
}

/**
 * Write one kv value. D-98: the families that are tables now (need decisions, canvas row overrides) are routed to their
 * table, and their old kv copy is dropped (kept only in the CC_KV_DUAL_WRITE rollback window).
 */
export async function writeKv(w: WriteCtx, key: string, value: unknown): Promise<void> {
  const prev = w.kv.get(key);
  if (canon(prev ?? null) === canon(value ?? null)) return;
  const need = parseNeedKey(key);
  if (need) {
    await writeNeedDecisionRow(w.tx, w.userId, need.rule, need.subjectId, (value ?? null) as Parameters<typeof writeNeedDecisionRow>[4]);
    await putKv(w.tx, w.userId, key, needDecisionKeepsKv() ? value : null);
  } else if (key === ROW_OVERRIDES_KV) {
    await writeRowOverridesMap(w.tx, w.userId, value);
    await putKv(w.tx, w.userId, key, rowOverridesKeepKv() ? value : null);
  } else await putKv(w.tx, w.userId, key, value);
  if (value === null || value === undefined) w.kv.delete(key);
  else w.kv.set(key, value);
}

function compactExt(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v === false && k !== 'enabled') continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const toDate = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);
export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}
export const isoReq = (v: Date | string): string => iso(v)!;

/**
 * jsonb keeps no key order (it stores keys shortest first), but some records are shown in their key order: tool
 * run inputs, NBA tool inputs, a manifest's form properties. `keyOrder` is what to store beside such a record
 * (undefined below two keys); `inKeyOrder` puts the keys back (keys not in `order` follow, in their read order).
 */
export function keyOrder(v: Record<string, unknown> | null | undefined): string[] | undefined {
  const keys = v ? Object.keys(v) : [];
  return keys.length > 1 ? keys : undefined;
}
export function inKeyOrder<T extends Record<string, unknown> | null | undefined>(v: T, order: string[] | undefined): T {
  if (!v || !order?.length) return v;
  const pos = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const keys = Object.keys(v);
  const sorted = keys
    .map((k, i) => [k, i] as const)
    .sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1])
    .map(([k]) => k);
  if (sorted.every((k, i) => k === keys[i])) return v;
  return Object.fromEntries(sorted.map((k) => [k, v[k]])) as T;
}

/**
 * `created_at` for the ordinal-th row of a batch written in one transaction (a seed): the base instant (the
 * transaction's now() when absent) plus `ordinal` µs. Loaders order by (created_at, id), so rows that would
 * otherwise tie read back in the order they were written, the way the mock lists them. Below 1000 rows the
 * offset stays inside the millisecond, so contract instants (ms precision) are unchanged.
 * No ordinal: the base as is (undefined → the column default).
 */
export function orderedAt(ordinal: number | undefined, base?: Date | string | null): Date | undefined {
  if (ordinal === undefined) return base ? new Date(base) : undefined;
  const at = base ? sql`${new Date(base).toISOString()}::timestamptz` : sql`now()`;
  return sql`${at} + make_interval(secs => ${ordinal}::float8 / 1000000)` as unknown as Date;
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDay(at: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  return parts; // en-CA formats as YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Diff-based row writes
// ---------------------------------------------------------------------------

const norm = (v: unknown): string => {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'number') return JSON.stringify(v);
  return canon(v ?? null);
};
export const same = (a: unknown, b: unknown) => norm(a) === norm(b);

/** Properties of `next` whose value differs from `prev` (both are drizzle insert objects). */
export function diffProps<T extends Record<string, unknown>>(prev: T, next: T, skip: string[] = []): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next)) {
    if (skip.includes(k)) continue;
    if (!same(prev[k], next[k])) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

export type Cols = Record<string, AnyPgColumn>;

/**
 * Update one row from a column patch.
 * - `bump`: go through the change-set helper (OCC on `ifVersion`, version + 1, user locks / engine
 *   proposals). When the patch is empty but the contract record still changed (ext-only fields), the
 *   version is bumped with a fenced raw update so contract versions stay in step with the mock.
 * - no `bump`: a raw audited update (bookkeeping: seen markers, rank caches) that leaves version alone.
 */
export async function updateRow<T extends PgTable & { id: AnyPgColumn }>(
  w: WriteCtx,
  table: T,
  id: string,
  patch: Record<string, unknown>,
  opts: { bump: boolean; ifVersion?: number; lock?: string[] | false; extChanged?: boolean; stampUpdatedAt?: boolean },
): Promise<{ proposals: { field: string; proposalId: string }[] }> {
  const cols = getTableColumns(table) as Cols;
  const name = getTableName(table);
  const entries = Object.entries(patch).filter(([k]) => k !== 'id' && k !== 'version' && k !== 'updatedAt' && k !== 'createdAt' && k !== 'ownerUserId' && k !== 'userLockedFields');
  const clean = Object.fromEntries(entries);
  let proposals: { field: string; proposalId: string }[] = [];
  if (opts.bump) {
    const lock = opts.lock === undefined ? false : opts.lock;
    if (Object.keys(clean).length) {
      const r = await w.cs.update(table, id, clean as never, {
        ifVersion: cols.version ? opts.ifVersion : undefined,
        lock: lock === false ? false : lock,
      });
      proposals = r.proposals;
      // the helper locks only applied columns; pseudo columns (ext-backed fields) are added here
      if (Array.isArray(lock) && cols.userLockedFields) {
        const extra = lock.filter((l) => !r.applied.includes(l));
        if (extra.length) await addLocks(w, table, id, extra);
      }
    } else if (opts.extChanged && cols.version) {
      const where: SQL[] = [eq(cols.id!, id)];
      if (opts.ifVersion !== undefined) where.push(eq(cols.version, opts.ifVersion));
      const set: Record<string, unknown> = { version: sql`${cols.version} + 1` };
      const res = await w.tx
        .update(table as PgTable)
        .set(set as never)
        .where(and(...where))
        .returning({ v: cols.version });
      if (!res.length && opts.ifVersion !== undefined) {
        const cur = await w.tx.execute<{ version: number }>(sql`select version from ${sql.identifier(name)} where id = ${id}`);
        throw new ConflictError(name, id, opts.ifVersion, cur.rows[0]?.version ?? -1);
      }
      if (Array.isArray(opts.lock) && opts.lock.length && cols.userLockedFields) await addLocks(w, table, id, opts.lock);
    }
  } else if (Object.keys(clean).length) {
    await w.tx
      .update(table as PgTable)
      .set(clean as never)
      .where(eq(cols.id!, id));
  }
  if (opts.stampUpdatedAt !== false && cols.updatedAt) {
    // Logical-clock timestamp (the helper's $onUpdate stamps wall-clock time). updated_at is
    // bookkeeping: the audit trigger ignores it and undo never compares it.
    await w.tx
      .update(table as PgTable)
      .set({ updatedAt: w.now } as never)
      .where(eq(cols.id!, id));
  }
  return { proposals };
}

async function addLocks(w: WriteCtx, table: PgTable, id: string, fields: string[]) {
  const cols = getTableColumns(table) as Cols;
  await w.tx
    .update(table)
    .set({
      userLockedFields: sql`array(select distinct f from unnest(${cols.userLockedFields} || array[${sql.join(
        fields.map((f) => sql`${f}`),
        sql`, `,
      )}]::text[]) as f order by f)`,
    } as never)
    .where(eq(cols.id!, id));
}

// ---------------------------------------------------------------------------
// People references
// ---------------------------------------------------------------------------

export const personUuid = (ref: { id: string } | null | undefined): string | null => (ref ? uuidFor(ref.id) : null);

/** Resolve a stored person id to a contract PersonRef ({id, name, role?, ...} from the people table). */
export function personRef(rc: ReadCtx, id: string | null | undefined): PersonRef | null {
  if (!id) return null;
  if (id === rc.me.id) return { id: rc.me.id, name: rc.me.name };
  const p = rc.people.get(id);
  if (!p) return { id, name: 'Unknown person' };
  const { accountId: _a, ...ref } = p;
  return ref;
}
