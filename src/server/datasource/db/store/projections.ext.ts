// The ext merge, mapping patch and result types every projection writer uses. Split from projections.ts (max-lines); projections.ts re-exports the public names.
import { extKey } from '../ext';
import { same, writeExt, type WriteCtx } from './common';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Merge `patch` into a row's ext object: `undefined` keeps a key, `null` removes it, other keys survive. */
export async function mergeExt(w: WriteCtx, table: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const key = extKey(table, id);
  const before = w.kv.get(key);
  const next: Record<string, unknown> = { ...((before as Record<string, unknown> | undefined) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  await writeExt(w, table, id, next);
  // writeExt leaves the cached value alone when nothing changed
  return w.kv.get(key) !== before;
}
export const MAPPING_PROPS = ['accountId', 'opportunityId', 'mappingMethod', 'mappingConfidence'];
/** Properties of `next` whose value differs from `cur`; mapping columns are skipped when the user locked them. */
export function patchOf(cur: Record<string, unknown>, next: Record<string, unknown>, skip: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (!skip.includes(k) && !same(cur[k], v)) out[k] = v;
  return out;
}
export interface Mapping {
  accountId: string | null;
  opportunityId: string | null;
  mappingMethod: 'rule' | 'connector' | null;
  mappingConfidence: number | null;
}
export interface Upserted {
  id: string;
  /** Something was inserted or changed (row or ext). */
  written: boolean;
}
