/**
 * PROJECT integration database: control_center_projections_<CC_TEST_DB_SUFFIX>, created once and reused (CREATE
 * DATABASE serializes on template1 while other lanes create theirs), migrated, emptied, then bootstrapped with a
 * placeholder profile like a real install (no seed). Refuses any other database name.
 */
import { sql } from 'drizzle-orm';

import { freshDb } from '../../support/pg';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { bootstrapUser } from '../../../src/server/datasource/db/bootstrap';

const SUFFIX = (process.env.CC_TEST_DB_SUFFIX ?? 'main').replace(/[^a-z0-9]/g, '');
export const PROJECTIONS_TEST_URL = `postgres://localhost:5432/control_center_projections_${SUFFIX}`;

export const PROFILE = {
  email: 'ada@corp.example',
  name: 'Ada Example',
  role: 'se_ic' as const,
  timezone: 'America/Denver',
  workingHours: { start: '07:30', end: '17:30', days: [1, 2, 3, 4, 5] },
  slackUserId: 'U0PLACE001',
  org62UserId: '005XX0000000001AAA',
};

export async function freshProjectionsDb(now: Date): Promise<{ handle: DbHandle; userId: string }> {
  const u = new URL(PROJECTIONS_TEST_URL);
  const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^control_center_projections_[a-z0-9]+$/.test(name)) throw new Error(`projection tests only run against control_center_projections_*, not "${name}"`);
  await freshDb(name, { reuse: true });
  await runMigrations({ url: PROJECTIONS_TEST_URL, log: () => {} });
  const handle = createDb({ url: PROJECTIONS_TEST_URL, max: 4, applicationName: 'projections-test' });
  const res = await handle.db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = res.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await handle.db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  const r = await bootstrapUser({ db: handle.db, profile: PROFILE, now });
  return { handle, userId: r.userId };
}
