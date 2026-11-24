import { AppError } from '../errors';
import { createMockDataSource, mockCodeText } from './mock';
import type { DataSource } from './types';

export type { DataSource } from './types';

type Holder = { __ccDataSource?: DataSource; __ccMockCode?: { hash: string; loadedAt: number } };

/**
 * Dev only: which mock code made the singleton. A dev server outlives many edits and merges, and the globalThis
 * singleton outlived them too, so a route added since start-up (getHome) 500'd with "reading 'call'" and changed
 * engines served stale payloads until a restart. A bundle that loaded different mock code (mockCodeText: the facade,
 * its context and every domain) later than the one that built the singleton replaces it (the mock store reloads from
 * the seed); an older bundle never swaps it back, so bundles don't thrash.
 */
const MOCK_CODE = process.env.NODE_ENV === 'development' ? { hash: hashOf(mockCodeText()), loadedAt: Date.now() } : null;

function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

function staleMock(g: Holder): boolean {
  if (!MOCK_CODE) return false;
  const made = g.__ccMockCode;
  if (!made) return true; // made by code from before this stamp existed
  return made.hash !== MOCK_CODE.hash && made.loadedAt < MOCK_CODE.loadedAt;
}

/** db mode: one DataSource per route bundle (its state is Postgres; pool, clock and bus are shared, see db/). */
let bundleDb: DataSource | undefined;

const dataKind = () => (process.env.CC_DATA ?? 'mock').toLowerCase();

/**
 * R7 step 5: the db implementation (db-entry.ts) loads only in db mode. The specifier is computed so that a module
 * graph on the mock (Vite's, and `vitest related`) never reaches pg, drizzle or the jobs; webpackInclude keeps
 * Next's bundle to that one file.
 */
const DB_ENTRY = 'db-entry';
const dbEntry: typeof import('./db-entry') | null =
  dataKind() === 'db' ? await import(/* webpackInclude: /[\\/]db-entry\.ts$/ */ /* @vite-ignore */ `./${DB_ENTRY}`) : null;

/**
 * The process-wide DataSource. CC_DATA=mock (default) | db (Postgres at DATABASE_URL, src/server/datasource/db).
 * Mock: stored on globalThis so every route bundle (and dev HMR) shares one in-memory store and event bus.
 * Db: one instance per route bundle, so the errors it throws are that bundle's AppError class (Next dev
 * gives each route bundle its own module instances, and http.ts maps errors with `instanceof AppError`);
 * the connection pool, clock and LISTEN bus are process-wide.
 */
export function getDataSource(): DataSource {
  const g = globalThis as Holder;
  if (g.__ccDataSource && staleMock(g)) {
    console.warn('[datasource] mock code changed since the store was made; reloading it from the seed');
    (g.__ccDataSource as DataSource & { dispose?: () => void }).dispose?.();
    delete g.__ccDataSource;
  }
  if (g.__ccDataSource) return g.__ccDataSource;
  const kind = dataKind();
  if (kind === 'db') {
    if (!dbEntry) throw new AppError('internal', 'CC_DATA=db was set after the data source module loaded: restart the process', undefined, false);
    bundleDb ??= dbEntry.createDbDataSource({ shared: true });
    return bundleDb;
  }
  if (kind !== 'mock') {
    throw new AppError('internal', `CC_DATA=${kind}: unknown data source (use mock or db)`, undefined, false);
  }
  g.__ccDataSource = createMockDataSource({
    readinDemo: process.env.CC_READIN_DEMO ? process.env.CC_READIN_DEMO !== '0' : process.env.NODE_ENV !== 'test', // BE-READIN demo read-ins
    useCaseDemo: process.env.CC_MOCK_UC_DEMO ? process.env.CC_MOCK_UC_DEMO !== '0' : process.env.NODE_ENV !== 'test', // D-70 placeholder Org62 use cases
  });
  g.__ccMockCode = MOCK_CODE ?? undefined;
  return g.__ccDataSource;
}

/** Tests only: drop the singleton so the next getDataSource() reloads the seed. */
export function resetDataSourceForTests(): void {
  const g = globalThis as Holder;
  const ds = g.__ccDataSource as (DataSource & { dispose?: () => void }) | undefined;
  ds?.dispose?.();
  delete g.__ccDataSource;
  delete g.__ccMockCode;
  bundleDb = undefined;
}
