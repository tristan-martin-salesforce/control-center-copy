/**
 * The database each DB suite runs against, one per suite, named `control_center_<suite>_<CC_TEST_DB_SUFFIX|main>`.
 * The suite names (be0, be1a, be1b, bereeval, retention) are database-name prefixes only: they stay stable so parallel
 * builders' databases keep working, even though the folders are now module-named (tests/db/core, worker, datasource,
 * reeval, retention). `vitest.config.ts` calls `applyDbUrlDefaults()` so each suite's global setup (which reads
 * `process.env` before any test env is applied) sees the same URL the tests get through `test.env`.
 * No import of ./pg here: that module probes Postgres when loaded, and the config loads for every run.
 */
const suffix = (process.env.CC_TEST_DB_SUFFIX ?? 'main').toLowerCase().replace(/[^a-z0-9]/g, '') || 'main';

export const SUITE_DB = {
  core: { env: 'BE0_DATABASE_URL', prefix: 'be0' },
  worker: { env: 'BE1A_DATABASE_URL', prefix: 'be1a' },
  datasource: { env: 'BE1B_DATABASE_URL', prefix: 'be1b' },
  reeval: { env: 'BEREEVAL_DATABASE_URL', prefix: 'bereeval' },
  retention: { env: 'RETENTION_DATABASE_URL', prefix: 'retention' },
} as const;

export type DbSuite = keyof typeof SUITE_DB;

export function suiteDbUrl(suite: DbSuite): string {
  const { env, prefix } = SUITE_DB[suite];
  return process.env[env] ?? `postgres://localhost:5432/control_center_${prefix}_${suffix}`;
}

/** Pin every suite's URL in `process.env` (an explicit value wins). Safe to call more than once. */
export function applyDbUrlDefaults(): void {
  for (const suite of Object.keys(SUITE_DB) as DbSuite[]) process.env[SUITE_DB[suite].env] = suiteDbUrl(suite);
}
