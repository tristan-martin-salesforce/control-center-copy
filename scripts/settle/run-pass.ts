/**
 * Run one real Settle pass (the `settle.check` handler: judge, decide, write) against the database in DATABASE_URL,
 * outside the worker. Writes closes, asks and reopens as engine change sets (each with Undo). For a copy of the
 * live DB or an explicit catch-up; the worker queues its own passes.
 *
 *   DATABASE_URL=postgres://localhost:5432/<db> npx tsx scripts/settle/run-pass.ts [--max-usd 6] [--ids <file>]
 *   --ids: judge exactly these items (one id per line) and apply the policy; the watermark is untouched by a script run.
 *
 * Prints the job result (counts, ids, no text).
 */
import { sql } from 'drizzle-orm';

import { createDb, databaseName, resolveDatabaseUrl } from '../../src/db/client';
import { settleHandler } from '../../src/jobs/handlers/settle';
import type { JobContext } from '../../src/jobs/types';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = resolveDatabaseUrl();
const handle = createDb({ url, max: 6, applicationName: 'command-center-settle-pass' });
let code = 0;
try {
  const u = (await handle.db.execute<{ id: string }>(sql`select id from users where is_active order by created_at limit 1`)).rows[0];
  if (!u) throw new Error(`no user in ${databaseName(url)}`);
  const ac = new AbortController();
  const ctx = {
    job: { id: null } as unknown as JobContext['job'],
    signal: ac.signal,
    db: handle.db,
    userId: u.id,
    clock: () => new Date(),
    log: (m: string) => console.log(m),
    heartbeat: async () => undefined,
    enqueue: async () => ({ inserted: false }) as never,
    services: undefined,
  } as JobContext;
  const idsFile = opt('ids');
  const ids = idsFile ? (await import('node:fs')).readFileSync(idsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : undefined;
  const out = await settleHandler({ handle, maxUsdPerPass: Number(opt('max-usd') ?? 6), concurrency: 6, ids })(ctx);
  console.log(JSON.stringify({ db: databaseName(url), ...out }));
} catch (err) {
  console.error(`settle pass: ${(err as Error).message}`);
  code = 1;
} finally {
  await handle.close();
}
process.exit(code);
