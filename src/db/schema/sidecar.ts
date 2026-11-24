/**
 * 0036 (D-99, holistic review 09 R1): per-entity state that lived in the `user_settings` kv side-car, as tables.
 *
 *   need_decisions        one row per (owner, rule, subject): a Needs-you row set aside (Snooze / Not needed) with
 *                         its reason, label and the rule's facts at decision time (src/contract/needs.ts NeedDecision).
 *                         Was `cc.need/<rule>/<subjectId>`. Audited: a decision is a change set with Undo.
 *   canvas_row_overrides  one row per (owner, row key): your edits on a logging canvas row before Apply
 *                         (src/lib/canvas/overrides.ts). Was the one kv map `canvas.row_overrides`. Audited.
 *   data_backfills        one row per (owner, backfill): the `kv.backfill` job's progress (cursor, counts, state), so a
 *                         stopped run resumes where it was and Doctor can say whether the dual-read window may close.
 *                         Bookkeeping: not audited.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, ownerUserId, tstz, updatedAt } from './columns';

export const needDecisions = pgTable(
  'need_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    rule: text('rule').notNull(),
    subjectId: text('subject_id').notNull(),
    /** snooze · not_needed (src/contract/needs.ts NeedDecisionKind). */
    kind: text('kind').notNull(),
    until: tstz('until'),
    reason: text('reason'),
    label: text('label'),
    baseline: jsonb('baseline').$type<Record<string, unknown>>().notNull().default({}),
    decidedAt: tstz('decided_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('need_decisions_owner_rule_subject_uidx').on(t.ownerUserId, t.rule, t.subjectId), index('need_decisions_owner_until_idx').on(t.ownerUserId, t.until)],
);

export const canvasRowOverrides = pgTable(
  'canvas_row_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** `uc:<VDP use case id>` · `update:<Object>:<record id 15>:<field>` (src/lib/canvas/overrides.ts). */
    rowKey: text('row_key').notNull(),
    fields: jsonb('fields').$type<Record<string, string | string[]>>().notNull().default({}),
    /** When you made the edit (the review's own ISO instant; empty on a row copied from a map that had none). */
    editedAt: text('edited_at').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('canvas_row_overrides_owner_key_uidx').on(t.ownerUserId, t.rowKey)],
);

export const dataBackfills = pgTable(
  'data_backfills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** The backfill's name: the migration it belongs to (`0036_sidecar_columns`). */
    name: text('name').notNull(),
    state: text('state').notNull().default('pending'),
    /** Where the run is: the family it works on and the last row id it finished. */
    cursor: jsonb('cursor').$type<{ family?: string; after?: string }>().notNull().default({}),
    /** Rows copied per family (counts only). */
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    runs: integer('runs').notNull().default(0),
    lastError: text('last_error'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('data_backfills_owner_name_uidx').on(t.ownerUserId, t.name), check('data_backfills_state_chk', sql`${t.state} IN ('pending', 'running', 'done', 'failed')`)],
);
