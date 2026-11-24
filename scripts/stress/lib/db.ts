/**
 * Scenario databases. One migrated template (`control_center_stress_tpl`), cloned per scenario
 * (`control_center_stress_<name>`). Refuses any database whose name does not start with
 * `control_center_stress` (never `command_center`, the 1.x `control_center` or the `*_main` test DBs). Every clone gets the
 * simulated-clock schema and `search_path = stress, pg_catalog, public` so `now()` is simulated.
 */
import { execFileSync } from 'node:child_process';

import { sql } from 'drizzle-orm';

import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';

import { CLOCK_SCHEMA_SQL } from './sim-clock';

const PG_BIN = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const HOST = process.env.CC_STRESS_PGHOST ?? 'localhost';
const PORT = process.env.CC_STRESS_PGPORT ?? '5432';
/** `CC_STRESS_TEMPLATE_DB`: a lane's own template (e.g. `control_center_stress_tpl_s2`), so lanes never rebuild each other's. */
export const TEMPLATE_DB = process.env.CC_STRESS_TEMPLATE_DB ?? 'control_center_stress_tpl';

export function assertStressDb(name: string): void {
  if (!/^control_center_stress(_[a-z0-9_]+)?$/.test(name)) throw new Error(`refusing to touch database "${name}" (stress DBs only)`);
}

export const urlOf = (name: string) => `postgres://${HOST}:${PORT}/${name}`;

function pg(bin: string, args: string[]): string {
  return execFileSync(`${PG_BIN}/${bin}`, ['--host', HOST, '--port', PORT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function dbExists(name: string): boolean {
  const out = pg('psql', ['-d', 'postgres', '-Atc', `select 1 from pg_database where datname = '${name}'`]);
  return out.trim() === '1';
}

export function dropDb(name: string): void {
  assertStressDb(name);
  pg('dropdb', ['--if-exists', '--force', name]);
}

/** (Re)build the migrated template. */
export async function buildTemplate(): Promise<void> {
  assertStressDb(TEMPLATE_DB);
  dropDb(TEMPLATE_DB);
  pg('createdb', [TEMPLATE_DB]);
  await runMigrations({ url: urlOf(TEMPLATE_DB), log: () => {} });
  const h = createDb({ url: urlOf(TEMPLATE_DB), max: 1, applicationName: 'stress-template' });
  try {
    await h.db.execute(sql.raw(CLOCK_SCHEMA_SQL));
  } finally {
    await h.close();
  }
}

export const scenarioDbName = (scenario: string) => `control_center_stress_${scenario.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 63);

/** Fresh scenario DB cloned from the template, with the simulated clock wired into `now()`. */
export async function cloneScenarioDb(scenario: string): Promise<{ name: string; url: string }> {
  const name = scenarioDbName(scenario);
  assertStressDb(name);
  if (!dbExists(TEMPLATE_DB)) await buildTemplate();
  dropDb(name);
  pg('createdb', ['-T', TEMPLATE_DB, name]);
  // Database-level settings are not copied by CREATE DATABASE … TEMPLATE.
  pg('psql', ['-d', 'postgres', '-c', `alter database ${name} set search_path = stress, pg_catalog, public`]);
  return { name, url: urlOf(name) };
}

/** A Db whose sessions resolve `now()` to the simulated clock (search path also set per connection). */
export function openStressDb(url: string, app = 'stress'): DbHandle {
  return createDb({ url, max: 6, applicationName: app, pool: { options: '-c TimeZone=UTC -c search_path=stress,pg_catalog,public' } });
}
