/**
 * The request-level helpers of the page-scoped reads (reads/scope.ts), plus the per-request read memo at the end:
 *
 *   SharedReads   one read model shared by the reads of ONE composed request (GET /needs runs ten page reads: each
 *                 used to load its own model). Request-scoped by construction (AsyncLocalStorage): it ends with the
 *                 request, is never used by a write (writers load their own model inside their transaction) and
 *                 never outlives a decision, so a re-read after any write sees it (cache honesty: there is no
 *                 cross-request read-model cache to invalidate).
 *   readScoped    load a page's scope and render; on a ScopeMissError (the page read a collection its scope left
 *                 out) throw in tests, and at runtime log `BUG.READ_SCOPE_MISS` (ids-free: route scope + collection)
 *                 and render once more from every collection, so a missed scope costs time, never a broken page.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '@/lib/log';

import type { ReadModel } from '../model';
import { planOf, ScopeMissError, scopeLabel, scopeStrict, type ReadScope } from './scope';

const log = logger('reads');

/** Scope misses since this process started, per scope label (W34-4). Ids-free: a label and a count, never a row. */
const misses = { since: new Date().toISOString(), byScope: new Map<string, number>() };

export interface ScopeMissSnapshot {
  since: string;
  total: number;
  scopes: Record<string, number>;
}

/** The web process's scope-miss count (the doctor service reads it; the worker has its own, always 0). */
export function scopeMissSnapshot(): ScopeMissSnapshot {
  const scopes = Object.fromEntries([...misses.byScope].sort(([a], [b]) => a.localeCompare(b)));
  return { since: misses.since, total: [...misses.byScope.values()].reduce((a, n) => a + n, 0), scopes };
}

/** Tests only: forget the counts. */
export function resetScopeMisses(now = new Date()): void {
  misses.byScope.clear();
  misses.since = now.toISOString();
}

interface Session {
  scope: ReadScope;
  model: Promise<ReadModel> | null;
}

export class SharedReads {
  private readonly als = new AsyncLocalStorage<Session>();

  /** Run `fn` with one model of `scope` (loaded on first use) shared by every covered read inside it. */
  run<T>(scope: ReadScope, fn: () => Promise<T>): Promise<T> {
    return this.als.run({ scope, model: null }, fn);
  }

  /** The shared model when a session is open and its scope covers `scope` (every collection, no row window). */
  covering(scope: ReadScope, load: (scope: ReadScope) => Promise<ReadModel>): Promise<ReadModel> | null {
    const s = this.als.getStore();
    if (!s || !covers(s.scope, scope)) return null;
    s.model ??= load(s.scope).catch((e: unknown) => {
      s.model = null;
      throw e;
    });
    return s.model;
  }
}

/** Whether a model of `outer` serves a read of `inner`: same or more collections, and no row window narrower. */
export function covers(outer: ReadScope, inner: ReadScope): boolean {
  if (outer.kind === 'all' || outer.kind === 'needs') return true; // every collection, every row
  if (outer.kind !== inner.kind) return false;
  return JSON.stringify(outer) === JSON.stringify(inner);
}

/** Load `scope`, render; a scope miss throws in tests and retries once with every collection otherwise (logged). */
export async function readScoped<T>(scope: ReadScope, load: (scope: ReadScope) => Promise<ReadModel>, render: (m: ReadModel) => Promise<T> | T, strict = scopeStrict()): Promise<T> {
  try {
    return await render(await load(scope));
  } catch (e) {
    if (!(e instanceof ScopeMissError) || strict) throw e;
    const label = scopeLabel(scope);
    misses.byScope.set(label, (misses.byScope.get(label) ?? 0) + 1);
    log.warn({ code: 'BUG.READ_SCOPE_MISS', scope: scopeLabel(scope), missing: e.missing }, 'read model: a page read outside its scope; rendered from every collection');
    return render(await load({ kind: 'all', why: `scope miss: ${scopeLabel(scope)}`, widenedFrom: scope }));
  }
}

/** The collections a scope names (null = every one), for tests and the profile. */
export const scopeCollections = (scope: ReadScope) => planOf(scope).collections;

/**
 * Per-request read memo (post-2.0 Home SQL): inside `withReadMemo`, `readMemo(db, key, load)` runs `load` once per
 * (db handle, key) and hands every later caller the same promise. Home and Today open it around their render, so the
 * helpers they share (the VDP mirror, my opps and accounts, the use-case plan's inputs, DC requests) read once per
 * request instead of up to four times. Request-scoped (AsyncLocalStorage), opened only by pure reads, keyed by the
 * handle (a transaction is another handle, never served from the pool's memo), and a failed load is forgotten. There
 * is no cross-request cache. Callers must not mutate what a memoized loader returns.
 */
const memoAls = new AsyncLocalStorage<WeakMap<object, Map<string, Promise<unknown>>>>();

export function withReadMemo<T>(fn: () => Promise<T>): Promise<T> {
  return memoAls.getStore() ? fn() : memoAls.run(new WeakMap(), fn);
}

export function readMemo<T>(db: object, key: string, load: () => Promise<T>): Promise<T> {
  const s = memoAls.getStore();
  if (!s) return load();
  let byKey = s.get(db);
  if (!byKey) s.set(db, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit as Promise<T>;
  const p = load();
  byKey.set(key, p);
  p.catch(() => byKey.delete(key));
  return p;
}
