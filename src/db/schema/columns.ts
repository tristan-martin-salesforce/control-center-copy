/**
 * Custom column types and column helpers shared by every schema file (DATA-MODEL §3.1).
 * Leaf module: it must not import any table module (see bindUsersId).
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  customType,
  numeric,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Postgres full-text vector. Always GENERATED ALWAYS; never written by app code. */
export const tsvector = customType<{ data: string; default: false }>({
  dataType() {
    return 'tsvector';
  },
});

/** Postgres tstzrange, surfaced as its text form ('[2026-11-01 ..., ...)'). */
export const tstzrange = customType<{ data: string; default: false }>({
  dataType() {
    return 'tstzrange';
  },
});

export const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const createdAt = () => tstz('created_at').notNull().defaultNow();

export const updatedAt = () =>
  tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * users.id, bound by core.ts right after `users` is defined. A static import of core.ts here would
 * pull this leaf module into the cross-domain import cycle, where a domain file could then call a
 * helper before this module has evaluated. FK callbacks run lazily (drizzle-kit, getTableConfig),
 * by which time the barrel (src/db/schema.ts) has loaded core.ts.
 */
let usersId: (() => AnyPgColumn) | undefined;
export function bindUsersId(ref: () => AnyPgColumn): void {
  usersId = ref;
}
export const ownerUserId = () =>
  uuid('owner_user_id')
    .notNull()
    .references(
      (): AnyPgColumn => {
        if (!usersId) throw new Error('src/db/schema/core.ts is not loaded: import tables from src/db/schema');
        return usersId();
      },
      { onDelete: 'cascade' },
    );

/** 0.000–1.000 */
export const confidence = (name = 'confidence') => numeric(name, { precision: 4, scale: 3, mode: 'number' });

export const usd = (name: string) => numeric(name, { precision: 12, scale: 6, mode: 'number' });

export const amount = (name: string) => numeric(name, { precision: 14, scale: 2, mode: 'number' });

export const scorePart = (name: string) =>
  numeric(name, { precision: 7, scale: 3, mode: 'number' }).notNull().default(0);

export const textArray = (name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);

/**
 * 0036 (D-98, DM-6): the 15-character form of an Org62 id column, generated (`left(<source>, 15)`, stored) so every
 * join between an 18-character id and a 15-character one compares these, indexed, instead of `left(x, 15)` by hand.
 * Never written by app code (the undo replay skips generated columns).
 */
export const id15 = (name: string, source: string) => text(name).generatedAlwaysAs(sql.raw(`left("${source}", 15)`));
