/**
 * PKG R9 on Postgres: a worker bug becomes one app_events row Health ▸ Needs you shows (owned by the app's user),
 * and a repeat bumps its count instead of adding a row. Own database: control_center_crash_<CC_TEST_DB_SUFFIX>.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dropDb, freshDb, pgAvailable, testDbSuffix } from '../../support/pg';
import { createDb, type DbHandle } from '../../../src/db/client';
import { runMigrations } from '../../../src/db/migrate';
import { bugEvent } from '../../../src/ops/crash';
import { recordWorkerBug } from '../../../src/worker/index';


const NAME = `control_center_crash_${testDbSuffix}`;
let handle: DbHandle;

beforeAll(async () => {
  if (!pgAvailable) return;
  const url = await freshDb(NAME);
  await runMigrations({ url, log: () => {} });
  handle = createDb({ url, max: 2, applicationName: 'crash-test' });
  await handle.db.execute(sql`insert into users (email, display_name, timezone) values ('ada@corp.example', 'Ada Example', 'America/Denver')`);
});

afterAll(async () => {
  if (!pgAvailable) return;
  await handle?.close();
  await dropDb(NAME);
});

describe.skipIf(!pgAvailable)('worker bugs reach Health (db)', () => {
  it('BUG.UNHANDLED: one critical row for the user, deduplicated by frame; a crash loop is its own row', async () => {
    const ev = bugEvent('BUG.UNHANDLED', { kind: 'uncaughtException', error: 'TypeError', frame: 'plan (src/worker/scanning.ts:40:3)' });
    await recordWorkerBug(handle.db, ev, 'ada@corp.example');
    await recordWorkerBug(handle.db, ev, 'ada@corp.example');
    await recordWorkerBug(handle.db, bugEvent('BUG.WORKER_CRASH_LOOP', { starts: 6 }), undefined);
    const rows = (
      await handle.db.execute<{ code: string; severity: string; error_class: string; occurrence_count: number; owner: string | null; message: string }>(sql`
        select e.code, e.severity, e.error_class, e.occurrence_count, u.email as owner, e.message
          from app_events e left join users u on u.id = e.owner_user_id where e.component = 'worker' order by e.id`)
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({ code: 'BUG.UNHANDLED', severity: 'critical', error_class: 'bug', occurrence_count: 2, owner: 'ada@corp.example' }),
      expect.objectContaining({ code: 'BUG.WORKER_CRASH_LOOP', occurrence_count: 1, owner: 'ada@corp.example' }),
    ]);
    expect(rows[1]!.message).toMatch(/keeps stopping/);
  });
});
