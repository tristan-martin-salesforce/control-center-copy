/**
 * Applies src/db/migrations in journal order (0000_extensions -> 0001_init -> 0002_extras -> ...).
 * Used by `npm run db:migrate` (`tsx src/db/migrate.ts`). Never `drizzle-kit push` (decision 10).
 *
 * Drizzle's migrator runs every pending migration in one transaction and records them in
 * drizzle.__drizzle_migrations, so a failed run leaves the database unchanged.
 *
 * Afterwards it checks what was applied against the journal (src/db/migration-state.ts, audit lane E): drizzle skips
 * a migration whose journal time is older than the last one applied, without a word. That fails the run here, so
 * nobody starts a worker on a schema that misses a migration. A database newer than this checkout is a warning.
 */
import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb, databaseName, resolveDatabaseUrl } from './client';
import { compareSchema, describeSchema, readAppliedMigrations, readJournal, type SchemaState } from './migration-state';

export interface MigrateOptions {
  url?: string;
  migrationsFolder?: string;
  log?: (line: string) => void;
}

export function defaultMigrationsFolder(): string {
  return process.env.CC_MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'src/db/migrations');
}

export class MigrationSkippedError extends Error {
  override name = 'MigrationSkippedError';
  constructor(readonly schema: SchemaState) {
    const d = describeSchema(schema);
    super(`${d.text}. ${d.fix ?? ''}`.trim());
  }
}

export async function runMigrations(opts: MigrateOptions = {}): Promise<SchemaState> {
  const url = resolveDatabaseUrl(opts.url);
  const log = opts.log ?? ((line: string) => console.log(line));
  const folder = opts.migrationsFolder ?? defaultMigrationsFolder();
  const handle = createDb({ url, max: 1, applicationName: 'command-center-migrate' });
  try {
    await migrate(handle.db, { migrationsFolder: folder });
    const state = compareSchema(readJournal(folder), await readAppliedMigrations(handle.db));
    if (state.state === 'skipped') throw new MigrationSkippedError(state);
    if (state.state === 'ahead') log(`[db:migrate] warning: ${describeSchema(state).text}`);
    else log(`[db:migrate] ${databaseName(url)} is up to date`);
    return state;
  } finally {
    await handle.close();
  }
}

const invokedDirectly = /(^|[\\/])migrate\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  runMigrations().catch((err: unknown) => {
    console.error(`[db:migrate] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
