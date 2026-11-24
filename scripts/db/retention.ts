/**
 * `npm run db:retention [-- --dry]`: run the data retention policy now (src/db/retention/policy.ts), for every user in
 * the database. `--dry` (or CC_RETENTION_DRY=1) prints the plan and changes nothing. Uses DATABASE_URL (default
 * postgres://localhost:5432/command_center). Prints table names and counts only.
 */
import { sql } from 'drizzle-orm';

import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { formatRetentionPlan, isDryEnv, runDataRetention } from '../../src/db/retention/run';

async function main() {
  const dry = process.argv.includes('--dry') || isDryEnv();
  const url = resolveDatabaseUrl();
  const handle = createDb({ url, max: 2, applicationName: 'command-center-retention' });
  try {
    console.log(`[retention] ${databaseName(url)}`);
    const users = await handle.db.execute<{ id: string }>(sql`select id from users order by created_at`);
    for (const u of users.rows) {
      const r = await runDataRetention(handle.db, u.id, { dry, force: true, log: () => {} });
      for (const l of formatRetentionPlan(r)) console.log(l);
    }
    if (!users.rows.length) console.log('  no users in this database');
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.error(`[retention] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
