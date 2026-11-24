/**
 * Query logging for the read profile (`npm run db:read-profile`) and the page-read tests (tests/db/reads): every query a
 * pg client sends while a recorder is on, with the tables its SQL names, the rows it returned, their JSON size and
 * its time. It patches the pool's own client class (no network module of its own). Counts and table names only: never parameters or row contents (*Local data, privacy-safe logs*).
 */
import { createHash } from 'node:crypto';

export interface LoggedQuery {
  tables: string[];
  rows: number;
  bytes: number;
  ms: number;
  /** performance.now() when it was sent (the read profile's `--post-model` split). */
  startedAt: number;
  /** A hash of the statement's text and parameters: equal for an identical repeat (the profile's `--dupes`). Never printed. */
  sig: string;
}

export interface QueryLog {
  queries: LoggedQuery[];
  stop(): void;
}

const NOT_TABLES = new Set(['select', 'lateral', 'unnest', 'jsonb_array_elements', 'jsonb_array_elements_text', 'jsonb_each', 'jsonb_to_recordset', 'generate_series', 'json_array_elements', 'values', 'set', 'jsonb_object_keys', 'regexp_matches', 'work_list']); // work_list: reads/work-list.ts's CTE

/** Table names a statement reads or writes (`from` / `join` / `update` / `into` followed by a quoted or bare name). */
export function tablesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:from|join|update|into)\s+(?:only\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    const t = m[1]!.toLowerCase();
    if (!NOT_TABLES.has(t)) out.add(t);
  }
  return [...out].sort();
}

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;
/** A pg Pool: it carries the Client class its connections are made from. */
export interface PoolLike {
  Client?: { prototype: object };
}
let active: LoggedQuery[][] = [];
const installed = new WeakSet<object>();

function sigOf(text: string, values: unknown): string {
  let v = '';
  try {
    v = JSON.stringify(values ?? null);
  } catch {
    v = String(Math.random()); // unserialisable parameters: never counted as a repeat
  }
  return createHash('sha1').update(text).update('\u0000').update(v).digest('hex');
}

function record(text: string, values: unknown, started: number, res: unknown) {
  if (!active.length) return;
  const rows = (res as { rows?: unknown[] } | undefined)?.rows ?? [];
  let bytes = 0;
  try {
    bytes = rows.length ? Buffer.byteLength(JSON.stringify(rows)) : 0;
  } catch {
    bytes = 0;
  }
  const q: LoggedQuery = { tables: tablesOf(text), rows: rows.length, bytes, ms: performance.now() - started, startedAt: started, sig: sigOf(text, values) };
  for (const l of active) l.push(q);
}

function install(pool: PoolLike) {
  const p = pool.Client?.prototype;
  if (!p) throw new Error('query log: this pool exposes no Client class');
  if (installed.has(p)) return;
  installed.add(p);
  const proto = p as unknown as { query: QueryFn };
  const orig = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    if (!active.length) return orig.apply(this, args);
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
    const values = typeof first === 'string' ? (Array.isArray(args[1]) ? args[1] : null) : (first as { values?: unknown } | undefined)?.values;
    const started = performance.now();
    const cbAt = args.findIndex((a, i) => i > 0 && typeof a === 'function');
    if (cbAt >= 0) {
      const cb = args[cbAt] as (err: unknown, res: unknown) => void;
      args[cbAt] = (err: unknown, res: unknown) => {
        if (!err) record(text, values, started, res);
        cb(err, res);
      };
      return orig.apply(this, args);
    }
    const r = orig.apply(this, args);
    if (r && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).then((res) => (record(text, values, started, res), res));
    return r;
  };
}

/** Start recording every query of this pool's clients (nestable); `stop()` ends this recorder. */
export function startQueryLog(pool: PoolLike): QueryLog {
  install(pool);
  const queries: LoggedQuery[] = [];
  active.push(queries);
  return {
    queries,
    stop: () => {
      active = active.filter((l) => l !== queries);
    },
  };
}

export interface QuerySummary {
  queries: number;
  rows: number;
  bytes: number;
  /** Table → rows returned by the statements that name it. */
  tables: Record<string, number>;
}

/** Statements that repeat an earlier one of the same log exactly (text and parameters), with the tables they name. */
export function repeats(qs: readonly LoggedQuery[]): { count: number; tables: Record<string, number> } {
  const seen = new Set<string>();
  const tables: Record<string, number> = {};
  let count = 0;
  for (const q of qs) {
    if (!seen.has(q.sig)) {
      seen.add(q.sig);
      continue;
    }
    count++;
    const k = q.tables.join(',') || '(none)';
    tables[k] = (tables[k] ?? 0) + 1;
  }
  return { count, tables };
}

export function summarize(qs: readonly LoggedQuery[]): QuerySummary {
  const tables: Record<string, number> = {};
  let rows = 0;
  let bytes = 0;
  for (const q of qs) {
    rows += q.rows;
    bytes += q.bytes;
    for (const t of q.tables) tables[t] = (tables[t] ?? 0) + q.rows;
  }
  return { queries: qs.length, rows, bytes, tables: Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))) };
}
