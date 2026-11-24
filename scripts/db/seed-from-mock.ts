/**
 * Load the mock's seed into Postgres so CC_DATA=db serves exactly what CC_DATA=mock serves.
 *
 *   DATABASE_URL=postgres://localhost:5432/control_center_be1b npx tsx scripts/db/seed-from-mock.ts [--reset]
 *
 * - The seed is the one the mock would load: CC_SEED_PATH, else the private fixture
 *   (~/Library/Application Support/command-center/fixtures/seed.json), else src/mock/seed.example.json,
 *   shifted so its asOf is today and ranked the way the mock ranks it at load.
 * - Everything is written through change sets (actor `system:seed`); seeded engine closes become real,
 *   undoable engine change sets.
 * - Idempotent: the same seed again is a no-op. A different seed (e.g. the next day's shift) needs
 *   --reset, which truncates the app tables of that database — refused for the orchestrator's
 *   integration database `command_center` unless --force.
 * - After a load, ranks once with the production ranker (ENGINES-core) as a system change set, so CC_DATA=db
 *   starts from the engine's Top 3 rather than the mock's load-time ranks. `--mock-rank` keeps the seed's
 *   ranks (what the mock serves, for side-by-side comparison).
 * - Never prints the connection URL (it may carry a password) or seed contents.
 */
import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { DbDataSource } from '../../src/server/datasource/db';
import { seedFromMock } from '../../src/server/datasource/db/from-mock';
import { loadSeedIntoDb } from '../../src/server/datasource/db/seed';
import { createMockDataSource } from '../../src/server/datasource/mock';

async function main() {
  const args = new Set(process.argv.slice(2));
  const reset = args.has('--reset');
  const url = resolveDatabaseUrl();
  const name = databaseName(url);
  if (reset && (name === 'command_center' || name === 'control_center') && !args.has('--force')) {
    throw new Error(`refusing to --reset the integration database ${name} (pass --force if you really mean it)`);
  }
  const mock = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  const { seed, rankedAt } = seedFromMock(mock);
  mock.dispose();
  const handle = createDb({ url, max: 2, applicationName: 'command-center-seed' });
  try {
    const res = await loadSeedIntoDb(seed, { db: handle.db, rankedAt, reset, log: (l) => console.log(l) });
    console.log(`[seed] ${name}: ${res.status} (user ${res.userId}, seed ${res.seedHash.slice(0, 12)}, from ${mock.loaded.path === '(inline)' ? 'inline seed' : mock.loaded.path.split('/').pop()})`);
    if (res.skipped.length) console.log(`[seed] skipped ${res.skipped.length} row(s): ${res.skipped.join('; ')}`);
    if (res.status !== 'up_to_date' && !args.has('--mock-rank')) {
      const ds = new DbDataSource({ handle, userId: res.userId }); // CC_DB_NOW clock, real time by default
      const r = await ds.systemRerank('Ranked with ENGINES-core after seeding');
      await ds.dispose();
      console.log(`[seed] ranked with ENGINES-core (${r.top3.length} in the Top 3)`);
    }
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  const e = err as { code?: string; message?: string };
  console.error(`[seed] failed: ${e.code ? `${e.code}: ` : ''}${e.message ?? String(err)}`);
  process.exitCode = 1;
});
