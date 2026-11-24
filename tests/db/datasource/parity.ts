/**
 * Parity harness: call the same DataSource method on the mock and on the db implementation (same seed,
 * same frozen clock), validate both against the route's response schema, translate the mock's seed ids to
 * db ids, apply the documented normalizations, and diff.
 */
import { routes, type RouteDef, type RouteKey } from '../../../src/contract';
import type { DataSource } from '../../../src/server/datasource/types';
import { translateHrefs } from '../../../src/server/datasource/db/translate';
import { diffPaths, translateIds, type Loaded } from './helpers';
import { normalizeValue, placeholders, translateComposite } from './normalize';

export interface ParityOptions {
  /** Replace instants with a placeholder (values written at request time). */
  times?: boolean;
  /** Extra per-method normalization applied to both sides after the standard ones. */
  shape?: (v: unknown, side: 'mock' | 'db') => unknown;
}

export interface ParityResult {
  key: RouteKey;
  mock: unknown;
  db: unknown;
  raw: { mock: unknown; db: unknown };
  diffs: string[];
}

export function stableIds(L: Loaded): Set<string> {
  return new Set([...L.idMap.values(), L.userId]);
}

export async function both<K extends RouteKey>(L: Loaded, db: DataSource, key: K, input: Record<string, unknown>, opts: ParityOptions = {}): Promise<ParityResult> {
  const def: RouteDef = routes[key];
  const call = async (ds: DataSource, inp: unknown) => {
    const fn = ds[key] as unknown as (i: unknown) => Promise<unknown>;
    const out = await fn.call(ds, inp);
    const r = def.response.safeParse(out);
    if (!r.success) throw new Error(`${ds.kind} ${key} failed contract validation: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    return r.data as unknown;
  };
  const parsedInput = (side: 'mock' | 'db') => {
    const v = side === 'db' ? translateIds(input, L.idMap) : input;
    const out: Record<string, unknown> = {};
    if (def.params) out.params = def.params.parse((v as Record<string, unknown>).params ?? {});
    if (def.query) out.query = def.query.parse((v as Record<string, unknown>).query ?? {});
    if (def.body) out.body = def.body.parse((v as Record<string, unknown>).body);
    return out;
  };
  const m = await call(L.mock, parsedInput('mock'));
  const d = await call(db, parsedInput('db'));
  const stable = stableIds(L);
  const norm = (v: unknown, side: 'mock' | 'db') => {
    let x = normalizeValue(side === 'mock' ? translateComposite(translateHrefs(translateIds(v, L.idMap), L.idMap), L.idMap) : v);
    x = placeholders(x, stable, { times: opts.times });
    return opts.shape ? opts.shape(x, side) : x;
  };
  const nm = norm(m, 'mock');
  const nd = norm(d, 'db');
  return { key, mock: nm, db: nd, raw: { mock: m, db: d }, diffs: diffPaths(nm, nd, '$', [], 60) };
}

/** N5: arrays the contract leaves unordered (or orders with an id tie-break) are compared sorted. */
export function sortAt(path: string[], cmp: (a: Record<string, unknown>, b: Record<string, unknown>) => number) {
  return (v: unknown): unknown => {
    const go = (x: unknown, i: number): unknown => {
      if (!x || typeof x !== 'object') return x;
      const k = path[i]!;
      const o = { ...(x as Record<string, unknown>) };
      if (i === path.length - 1) {
        if (Array.isArray(o[k])) o[k] = [...(o[k] as Record<string, unknown>[])].sort(cmp);
      } else o[k] = go(o[k], i + 1);
      return o;
    };
    return go(v, 0);
  };
}
export const byId = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a.id).localeCompare(String(b.id));
/** The work-list comparator (rank, due, id) — the id tie-break differs between seed ids and uuids. */
export const workOrder = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  ((a.rank as number | null) ?? Number.MAX_SAFE_INTEGER) - ((b.rank as number | null) ?? Number.MAX_SAFE_INTEGER) ||
  String(a.due ?? '9').localeCompare(String(b.due ?? '9')) ||
  String(a.title).localeCompare(String(b.title));

/** Drop keys (any depth) from a value. */
export function dropKeys(v: unknown, keys: string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => dropKeys(x, keys));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)).map(([k, x]) => [k, dropKeys(x, keys)]));
  return v;
}
