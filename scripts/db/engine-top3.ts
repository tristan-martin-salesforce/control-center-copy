/**
 * Print the ENGINES-core Top 3 for the user in DATABASE_URL, computed directly from the read model
 * (rankWork over priorityInputs), next to the stored Top 3 that GET /today serves. Read-only: it writes
 * nothing. Used by the INTEGRATE-1 live check.
 *
 *   DATABASE_URL=postgres://localhost:5432/control_center_be1b_main npx tsx scripts/db/engine-top3.ts
 */
import { createDb, resolveDatabaseUrl } from '../../src/db/client';
import { rankWork } from '../../src/engines/priority';
import { DbDataSource } from '../../src/server/datasource/db';
import { priorityInputs } from '../../src/server/datasource/db/rank';
import { everything } from '../../src/server/datasource/db/reads/scope';

async function main() {
  const handle = createDb({ url: resolveDatabaseUrl(), max: 2, applicationName: 'command-center-engine-top3' });
  const ds = new DbDataSource({ handle });
  try {
    const m = await ds.model(everything('engine top 3 script'));
    const fresh = rankWork(priorityInputs(m, m.settings().policy, ds.now()));
    const stored = m
      .all('workItems')
      .filter((w) => w.rank !== null && w.rank <= 3)
      .sort((a, b) => a.rank! - b.rank!)
      .map((w) => w.id);
    console.log(JSON.stringify({ engineVersion: fresh.engineVersion, policyVersion: fresh.policyVersion, engineTop3: fresh.top3, storedTop3: stored }));
  } finally {
    await ds.dispose();
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(`[engine-top3] failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
