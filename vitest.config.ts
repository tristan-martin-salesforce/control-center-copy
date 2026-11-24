/**
 * Vitest projects: tests are isolated by what they need, fast by default, honest about the database.
 *
 *   npm test               unit + ui       (no Postgres, parallel)            npm run test:unit | test:ui
 *   npm run test:db        every db* project (Postgres, serial)               npm run test:db:core | worker | datasource | reeval | retention
 *   npm run test:evals     evals           (offline, cassette model)
 *   npm run smoke:crawl    smoke           (a real browser against the mock app; skipped without one)
 *
 * unit      pure and mock-DataSource tests under tests/ and src/ (everything not below); never touches Postgres.
 * ui        the jsdom (DOM) tests, tests/ui/**, the contrast gate and the internal-ids lint (see tests/support/projects.ts).
 * db        tests/db/<module>/**: files that provision their own database with tests/support/pg.ts (`freshDb`). Serial.
 * db-core, db-worker, db-datasource, db-reeval, db-retention
 *           the suites with their own global setup (drop, create, migrate one database; names in tests/support/db-urls.ts).
 * evals     tests/evals/**: scanner recall and closure-precision evals over the golden cases (`*.eval.ts`).
 * smoke     tests/smoke/**: the crawl (scripts/test/crawl.ts).
 *
 * DB projects are serial: a run that selects a db* or smoke project turns `fileParallelism` off (below), and the npm
 * scripts add `--maxWorkers=1` so two projects never run at once. That is the flake policy: a slow Postgres test gets the project's timeout, never a per-test bump that only
 * exists because the machine was loaded. A long timeout in a file needs a comment that says why it is legitimately long.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { applyDbUrlDefaults, suiteDbUrl } from './tests/support/db-urls';
import { domTestFiles } from './tests/support/projects';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Node 25 ships a global `localStorage` (experimental Web Storage, on by default) that shadows jsdom's, so every
 * `@vitest-environment jsdom` test failed with "localStorage.clear is not a function" (ENG-1). Turn it off in the
 * test workers wherever the flag exists (Node 22.4+); older Nodes have no global to shadow.
 */
export const workerExecArgv = process.allowedNodeEnvironmentFlags.has('--experimental-webstorage') ? ['--no-experimental-webstorage'] : [];

applyDbUrlDefaults();

/** A run that selects a db* or smoke project is serial (one shared database per suite): `--project db-core` alone must be safe. */
const serial = process.argv.some((a, i, all) => (a === '--project' ? /^(db|smoke)/.test(all[i + 1] ?? '') : /^--project=(db|smoke)/.test(a)));

const alias = { '@': path.resolve(root, 'src') };
const setupFiles = ['tests/setup/ledger-gaps.ts']; // D0: no booked call without its audit fields or tokens
const poolOptions = { forks: { execArgv: workerExecArgv }, threads: { execArgv: workerExecArgv } };

/** Tests always use the committed placeholder seed, never the private fixture. */
const mockEnv = {
  CC_SEED_PATH: path.resolve(root, 'src/mock/seed.example.json'),
  CC_SCENARIO: '0',
  CC_MOCK_NOW: 'seed',
  // the placeholder seed stays on its own date (Thu 5 Nov): rebased onto today, its weekdays moved, and tests that
  // read "Wednesday" or "due Monday" failed on Mondays (2026-11-16)
  CC_SEED_REBASE: '0',
};

const ui = [...domTestFiles(root), 'tests/ui/**/*.test.ts', 'src/components/kit/__tests__/internal-ids.test.ts'];

/** One DB suite: its own global setup (drop, create, migrate), serial files, its own database in `env`. */
function dbSuite(name: string, dir: string, include: string[], url: string, urlEnv: string, extra: { test?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  return {
    root,
    resolve: { alias },
    test: {
      name,
      setupFiles,
      include,
      globalSetup: [`tests/db/${dir}/global-setup.ts`],
      testTimeout: 30_000,
      hookTimeout: 120_000,
      ...extra.test,
      env: { DATABASE_URL: url, [urlEnv]: url, ...extra.env },
    },
  };
}

export default defineConfig({
  test: {
    poolOptions, // worker flags and file parallelism are root-level options (not per project)
    fileParallelism: !serial,
    projects: [
      {
        root,
        resolve: { alias },
        test: {
          name: 'unit',
          setupFiles,
          environment: 'node',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['node_modules/**', '.claude/**', 'e2e/**', 'tests/db/**', 'tests/evals/**', 'tests/smoke/**', ...ui],
          env: mockEnv,
        },
      },
      {
        root,
        resolve: { alias },
        test: {
          name: 'ui',
          setupFiles,
          environment: 'node', // a DOM file opts in with its `@vitest-environment jsdom` docblock
          include: ui,
          exclude: ['node_modules/**', '.claude/**', 'e2e/**'],
          env: mockEnv,
          // the contrast gate (tests/ui/contrast.test.ts) shells out to scripts/contrast.mjs; the jsdom files are heavier than a pure test
          testTimeout: 15_000,
        },
      },
      {
        // Files that make their own database with tests/support/pg.ts (freshDb): serial, the DB project's timeouts.
        root,
        resolve: { alias },
        test: {
          name: 'db',
          setupFiles,
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          exclude: ['node_modules/**', 'tests/db/core/**', 'tests/db/datasource/**'],
          testTimeout: 60_000,
          hookTimeout: 300_000, // CREATE DATABASE queues on template1 and migrations run from empty
          env: mockEnv,
        },
      },
      dbSuite('db-core', 'core', ['tests/db/core/**/*.test.ts'], suiteDbUrl('core'), 'BE0_DATABASE_URL'),
      dbSuite('db-worker', 'worker', ['tests/db/worker/**/*.spec.ts'], suiteDbUrl('worker'), 'BE1A_DATABASE_URL', {
        env: {
          // Never touch the real state dir (heartbeat, pid file, notify state).
          CC_STATE_DIR: path.join(tmpdir(), `cc-be1a-state-${process.pid}`),
          CC_LIVE: process.env.CC_LIVE ?? '0',
        },
      }),
      dbSuite('db-datasource', 'datasource', ['tests/db/datasource/**/*.test.ts'], suiteDbUrl('datasource'), 'BE1B_DATABASE_URL', {
        test: { testTimeout: 60_000, hookTimeout: 180_000 },
        env: { ...mockEnv, CC_BE1B: '1', CC_VALIDATE_RESPONSES: '1' },
      }),
      // The reevaluate job end to end (also the resolution closure checks, same database and setup). Whole job runs per
      // test, so its timeouts are legitimately long.
      dbSuite('db-reeval', 'reeval', ['tests/db/reeval/**/*.spec.ts'], suiteDbUrl('reeval'), 'BEREEVAL_DATABASE_URL', {
        test: { testTimeout: 180_000, hookTimeout: 600_000 },
        env: { ...mockEnv, CC_STATE_DIR: path.join(tmpdir(), `cc-bereeval-state-${process.pid}`), CC_LIVE: '0', CC_NOTIFY: '0' },
      }),
      dbSuite('db-retention', 'retention', ['tests/db/retention/**/*.pg.ts'], suiteDbUrl('retention'), 'RETENTION_DATABASE_URL', {
        test: { testTimeout: 60_000, hookTimeout: 180_000 },
      }),
      {
        // Scanner recall and closure-precision evals over the golden cases (tests/fixtures/scanner-golden): offline and
        // free (cassette model, in-memory store, no network). The score table prints at the end of the run.
        root,
        resolve: { alias },
        test: {
          name: 'evals',
          environment: 'node',
          setupFiles,
          include: ['tests/evals/**/*.eval.ts'],
          testTimeout: 30_000,
          env: { ...mockEnv, CC_LIVE: '0' },
        },
      },
      {
        // The crawl: starts the mock app and a browser; skips itself when there is no browser.
        root,
        resolve: { alias },
        test: {
          name: 'smoke',
          environment: 'node',
          include: ['tests/smoke/**/*.test.ts'],
          testTimeout: 25 * 60_000, // legitimately long: a cold `next dev` compile of ~45 pages, run inside one test
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
