import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '../../../src/db/changeset';
import { createDb, type Db, type DbHandle } from '../../../src/db/client';
import { connectors, extractors, users, workItems } from '../../../src/db/schema';

export const TEST_URL = process.env.BE0_DATABASE_URL ?? 'postgres://localhost:5432/control_center_be0';

export function openTestDb(max = 5): DbHandle {
  if (!/\/control_center_be0(_[a-z0-9]+)?(\?|$)/.test(TEST_URL)) throw new Error('tests must use control_center_be0');
  return createDb({ url: TEST_URL, max, applicationName: 'be0-test' });
}

/** users is not audited, so it can be written directly. Placeholder identities only. */
export async function createUser(db: Db, label = 'se'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${label}-${randomUUID()}@example.com`, displayName: label.toUpperCase() })
    .returning({ id: users.id });
  return u!.id;
}

export async function createExtractor(db: Db, key = 'test.extractor'): Promise<string> {
  const [e] = await db
    .insert(extractors)
    .values({ key: `${key}.${randomUUID().slice(0, 8)}`, version: '1', kind: 'rule' })
    .returning({ id: extractors.id });
  return e!.id;
}

export async function createConnector(db: Db, userId: string, kind: 'slack' | 'gmail' | 'drive' = 'slack') {
  const { result } = await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'seed connector' }, (tx) =>
    tx
      .insert(connectors)
      .values({ ownerUserId: userId, kind, name: `${kind}-${randomUUID().slice(0, 6)}`, transport: 'mcp_http' })
      .returning({ id: connectors.id }),
  );
  return result[0]!.id;
}

export async function createWorkItem(
  db: Db,
  userId: string,
  values: Partial<typeof workItems.$inferInsert> = {},
): Promise<typeof workItems.$inferSelect> {
  const { result } = await withChangeSet({ db, userId, actor: actors.user(), reason: 'capture task' }, (tx) =>
    tx
      .insert(workItems)
      .values({ ownerUserId: userId, kind: 'task', origin: 'manual', status: 'open', title: 'Prepare demo deck', ...values })
      .returning(),
  );
  return result[0]!;
}

/** Full row image minus bookkeeping, for exact-state comparisons. */
export async function rowImage(db: Db, table: string, id: string): Promise<Record<string, unknown> | null> {
  const res = await db.execute<{ img: Record<string, unknown> }>(
    sql`select to_jsonb(t) - '{updated_at,version,search_tsv}'::text[] as img from ${sql.identifier(table)} t where id = ${id}`,
  );
  return res.rows[0]?.img ?? null;
}
