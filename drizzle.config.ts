/**
 * drizzle-kit config. Generate + migrate only; never `push` (DATA-MODEL decision 10):
 * push cannot see the custom SQL (triggers, exclusions, the view) and would diff forever.
 *
 *   npx drizzle-kit generate --name <name>            # schema change -> new SQL migration
 *   npx drizzle-kit generate --custom --name <name>   # hand-written SQL migration
 *   npm run db:migrate                                # tsx src/db/migrate.ts (applies in order)
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/command_center',
  },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
