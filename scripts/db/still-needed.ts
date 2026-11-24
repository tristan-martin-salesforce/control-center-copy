/**
 * DEEP-1 backfill, no rescan: open work that was already over 30 days old when first seen moves to Triage's
 * "Still needed?" group (one click to keep or close). Only items you never touched; work due after it was first
 * seen stays open. One change set (actor system), undoable as a whole.
 *
 *   npx tsx scripts/db/still-needed.ts            # count only
 *   npx tsx scripts/db/still-needed.ts --apply    # move them
 *
 * Uses DATABASE_URL (default postgres://localhost:5432/command_center) and prints the database name and counts
 * only, never titles or the URL.
 */
import { sql } from 'drizzle-orm';

import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { DbDataSource } from '../../src/server/datasource/db';

const apply = process.argv.includes('--apply');
const url = resolveDatabaseUrl();
const handle = createDb({ url, max: 2, applicationName: 'command-center-still-needed' });
let code = 0;
try {
  const u = await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`);
  if (!u.rows[0]) throw new Error(`no user in ${databaseName(url)}`);
  const ds = new DbDataSource({ handle, userId: u.rows[0].id });
  try {
    const r = await ds.stillNeededBackfill({ apply });
    console.log(JSON.stringify({ db: databaseName(url), apply, ...r }));
  } finally {
    await ds.dispose();
  }
} catch (err) {
  console.error(`still-needed: ${(err as Error).message}`);
  code = 1;
} finally {
  await handle.close();
}
process.exit(code);
