/**
 * `npm run db:backfill [-- --dry | --queue]`: the data half of a migration (docs/DATA-MIGRATIONS.md), for every user in
 * the database. Today one backfill: 0036, the kv side-car → columns (src/jobs/handlers/kv-backfill.ts).
 *   --dry     print the plan (rows to copy per family) and change nothing
 *   --queue   queue the `kv.backfill` job per user instead of running it here (the update path's hook; the worker runs it)
 *   (none)    run it now, in chunks, and print what it copied
 * Uses DATABASE_URL (default postgres://localhost:5432/command_center). Prints family names and counts only.
 */
import { sql } from 'drizzle-orm';

import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { enqueueKvBackfill, formatBackfillReport, runKvBackfill } from '../../src/jobs/handlers/kv-backfill';

async function main() {
  const dry = process.argv.includes('--dry');
  const queue = process.argv.includes('--queue');
  const url = resolveDatabaseUrl();
  const handle = createDb({ url, max: 2, applicationName: 'command-center-backfill' });
  try {
    console.log(`[backfill] ${databaseName(url)}${dry ? ' (dry run)' : queue ? ' (queue)' : ''}`);
    const users = await handle.db.execute<{ id: string }>(sql`select id from users order by created_at`);
    for (const [i, u] of users.rows.entries()) {
      console.log(`  user ${i + 1} of ${users.rows.length}`);
      if (queue) {
        const r = await enqueueKvBackfill(handle.db, u.id, 'update');
        console.log(`    kv.backfill ${r.inserted ? 'queued' : 'already queued'} (job ${r.id})`);
        continue;
      }
      const r = await runKvBackfill(handle.db, u.id, { dry });
      for (const l of formatBackfillReport(r)) console.log(l);
    }
    if (!users.rows.length) console.log('  no users in this database');
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.error(`[backfill] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
