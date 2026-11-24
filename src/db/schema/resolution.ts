/**
 * The resolution check's ledger (holistic review 2026-11-20, lane 03 §4.1/§4.2, R4/R9): one row per "is this item
 * done?" decision, whichever rung decided it (rules D1–D6, the cheap model, the narrow escalation) and whether it acted
 * (`live`) or only recorded (`shadow`). It answers "why is this still open?" (the item panel, `scan:explain --item`) and
 * the shadow comparison on Health.
 *
 * Privacy (*tenet: Local data, privacy-safe logs*): ids, codes, numbers and a digest only, never message text. The pack
 * itself is rebuilt from the source rows when someone asks (scan:explain), so its digest says whether it changed since.
 * Not audited (like scan_run_events): the check writes it; nothing here is undone by hand.
 */
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, bigserial, boolean, check, index, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { ownerUserId, tstz } from './columns';
import { llmCalls } from './llm';
import { sourceItems } from './sources';
import { workItems } from './work';

export const closureChecks = pgTable(
  'closure_checks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references((): AnyPgColumn => workItems.id, { onDelete: 'cascade' }),
    at: tstz('at').notNull().defaultNow(),
    /** What started it: conversation_line, drive_revision, drive_share, notes, session, quiet, sweep, evidence, manual. */
    trigger: text('trigger').notNull(),
    /** `shadow`: recorded only (the legacy closers acted); `live`: its outcome was applied. */
    mode: text('mode').notNull(),
    /** Item status when checked. */
    statusBefore: text('status_before').notNull(),
    packDigest: text('pack_digest').notNull(),
    packTokens: integer('pack_tokens').notNull().default(0),
    packLines: integer('pack_lines').notNull().default(0),
    /** Every rule that fired (D1…D6), and the one that decided (null: a model decided, or nothing did). */
    rulesFired: text('rules_fired').array().notNull().default(sql`'{}'::text[]`),
    ruleHit: text('rule_hit'),
    /** rule | model | escalation | skip | failed */
    decidedBy: text('decided_by').notNull(),
    verdict: text('verdict'),
    basis: text('basis'),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
    /** The line the decision cites: its pack alias and its source item (null: a read-back, a session, nothing). */
    citeAlias: text('cite_alias'),
    citeSourceItemId: uuid('cite_source_item_id').references((): AnyPgColumn => sourceItems.id, { onDelete: 'set null' }),
    escalated: boolean('escalated').notNull().default(false),
    /** uncertain | invalid_cite | hint_conflict (why it went to the stronger model), or why it did not (gated:…). */
    escalationReason: text('escalation_reason'),
    escalationChanged: boolean('escalation_changed'),
    outcome: text('outcome').notNull(),
    /** What kept it from closing: user_reopened, ask_first_person, below_threshold, open_loop, upcoming_meeting … */
    blockedBy: text('blocked_by'),
    model: text('model'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    llmCallId: bigint('llm_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, { onDelete: 'set null' }),
    durationMs: integer('duration_ms').notNull().default(0),
    engineVersion: text('engine_version').notNull(),
  },
  (t) => [
    index('closure_checks_item_at_idx').on(t.ownerUserId, t.workItemId, t.at.desc()),
    index('closure_checks_owner_at_idx').on(t.ownerUserId, t.at.desc()),
    check('closure_checks_outcome_chk', sql`${t.outcome} IN ('closed', 'likely', 'asked', 'left', 'reopened')`),
    check('closure_checks_mode_chk', sql`${t.mode} IN ('shadow', 'live')`),
    check('closure_checks_decided_by_chk', sql`${t.decidedBy} IN ('rule', 'model', 'escalation', 'skip', 'failed')`),
  ],
);

export type ClosureCheckRow = typeof closureChecks.$inferSelect;
export type NewClosureCheckRow = typeof closureChecks.$inferInsert;
