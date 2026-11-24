/**
 * The side-car for contract fields the schema has no column for yet ("ext").
 *
 * Every contract field that has a home in DATA-MODEL §3 is written to its column / child table and read
 * back from there. What remains — presentation text (whyDetail, chip labels), ordered id lists that span
 * several run tables, and qualified enum overrides (enums.ts) — is stored here, one JSON object per
 * entity, in `user_settings` under the key `cc.ext/<table>/<row id>`.
 *
 * Why user_settings: it is the schema's jsonb key-value store, it is audited (cc_audit_kv), so ext writes
 * ride the same change set as the row they describe and `undoChangeSet` reverts both together. The
 * field lists per table are documented in docs (BE-1b notes) and raised as a blocker so BE-0 can add
 * real columns; this module then shrinks.
 *
 * Singletons (meta, spend projection, spine slots, mapping questions, app runs) live under `cc.*` keys.
 */
import { and, asc, eq, like, or, sql } from 'drizzle-orm';

import type { DbOrTx, Tx } from '@/db/client';
import { userSettings } from '@/db/schema';

import { overlaySidecar } from './store/sidecar-overlay';

export const EXT_PREFIX = 'cc.ext/';

export const extKey = (table: string, id: string) => `${EXT_PREFIX}${table}/${id}`;

/** Canonical JSON for comparisons (key order independent). */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return x;
  });
}

/** Drop undefined/null/empty values so an ext object only carries what it must. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** All `cc.*` settings rows of a user: ext objects plus singletons. Loaded once per read model. */
export async function loadKv(db: DbOrTx, userId: string): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: userSettings.key, value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.ownerUserId, userId), like(userSettings.key, 'cc.%')))
    .orderBy(asc(userSettings.key)); // app runs and mapping questions are listed in this order (no physical-order reads)
  // D-98: the promoted columns and need_decisions rows, read into the same map (column first, kv fallback)
  return overlaySidecar(db, userId, new Map(rows.map((r) => [r.key, r.value])));
}

/**
 * The read model's base (post-2.0 read profile): the `cc.*` kv map exactly as `loadKv` builds it, and the `settings.*`
 * sections, in ONE read of user_settings (they were two: the kv, then every row of the user for the sections).
 */
export async function loadKvAndSections(db: DbOrTx, userId: string): Promise<{ kv: Map<string, unknown>; sections: Record<string, unknown> }> {
  const rows = await db
    .select({ key: userSettings.key, value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.ownerUserId, userId), or(like(userSettings.key, 'cc.%'), like(userSettings.key, 'settings.%'))))
    .orderBy(asc(userSettings.key)); // the kv keeps loadKv's key order
  const kv = new Map<string, unknown>();
  const sections: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.key.startsWith('cc.')) kv.set(r.key, r.value);
    else if (r.key.startsWith('settings.')) sections[r.key.slice('settings.'.length)] = r.value;
  }
  return { kv: await overlaySidecar(db, userId, kv), sections };
}

/** Upsert (or delete, for null/empty) one kv row inside the caller's change set. No-op when unchanged. */
export async function putKv(tx: Tx, userId: string, key: string, value: unknown, previous?: unknown): Promise<void> {
  const empty = value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0);
  if (previous !== undefined && canon(previous ?? null) === canon(empty ? null : value)) return;
  if (empty) {
    await tx.delete(userSettings).where(and(eq(userSettings.ownerUserId, userId), eq(userSettings.key, key)));
    return;
  }
  await tx
    .insert(userSettings)
    .values({ ownerUserId: userId, key, value: value as object })
    .onConflictDoUpdate({
      target: [userSettings.ownerUserId, userSettings.key],
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
      setWhere: sql`${userSettings.value} is distinct from excluded.value`,
    });
}

export async function putExt(tx: Tx, userId: string, table: string, id: string, value: Record<string, unknown> | null, previous?: Record<string, unknown> | null): Promise<void> {
  await putKv(tx, userId, extKey(table, id), value ? compact(value) : null, previous === undefined ? undefined : previous ? compact(previous) : null);
}
