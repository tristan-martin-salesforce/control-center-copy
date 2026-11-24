import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { actors, withChangeSet } from '@/db/changeset';
import { createDb, type Db, type DbHandle } from '@/db/client';
import { users } from '@/db/schema';

export const TEST_URL = process.env.BE1A_DATABASE_URL ?? 'postgres://localhost:5432/control_center_be1a';

export function openTestDb(max = 6): DbHandle {
  if (!/\/control_center_be1a(_[a-z0-9]+)?(\?|$)/.test(TEST_URL)) throw new Error('BE-1a tests must use control_center_be1a');
  return createDb({ url: TEST_URL, max, applicationName: 'be1a-test' });
}

/** users is not audited, so it can be written directly. Placeholder identities only. */
export async function createUser(db: Db, label = 'se', timezone = 'America/Denver'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${label}-${randomUUID().slice(0, 8)}@example.com`, displayName: `${label.toUpperCase()} Example`, timezone })
    .returning({ id: users.id });
  return u!.id;
}

export async function setUserSetting(db: Db, userId: string, key: string, value: unknown): Promise<void> {
  await withChangeSet({ db, userId, actor: actors.user(), reason: `set ${key}` }, (tx) =>
    tx.execute(sql`
      insert into user_settings (owner_user_id, key, value) values (${userId}, ${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (owner_user_id, key) do update set value = excluded.value`),
  );
}

export const uid = () => randomUUID().slice(0, 8);

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 5000, stepMs = 25): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
