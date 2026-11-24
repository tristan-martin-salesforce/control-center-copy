/**
 * The attribution engine's tables (holistic review 2026-11-20 lane 06 R2-R5; src/engines/attribution). Migration 0032.
 *
 *   opp_engagement        per (owner, opportunity, ISO week): what I did on it (meetings, customer meetings, Slack
 *                         lines, mail threads, docs, sessions, notes, hours logged, credit, last touch, counts per source,
 *                         the last few evidence links). Derived: the nightly `attribution.opp_engagement` job rebuilds it
 *                         from activity_entries and the engine's alternates; a fast path upserts a row's week when the row
 *                         changes. Hours count only on the opp a row is logged to (tenet: Hours are human hours). Not
 *                         audited (like landings): nothing here is ever undone by hand.
 *   dc_suggestions        one per (owner, opportunity, fiscal quarter): a DC the app suggests claiming, with its group
 *                         (one engagement, several opps), evidence share, default split, reasons, evidence links, the
 *                         covered AE and its state (new · accepted · edited · rejected · closed · stale · resolved).
 *                         Audited: Accept / Edit / Reject are change sets (Undo restores the suggestion), and Accept drafts
 *                         a deal_contribution_requests row in the same change set (it rides the next logging canvas).
 *   attribution_outcomes  one per decision on something the engine suggested (a row's opp, a DC): what was shown (basis,
 *                         top reason, confidence, target) and what the user chose (accept · edit · reject). The accept-rate
 *                         log that tunes the weights (TA-12). Append-only, not audited.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, ownerUserId, tstz, updatedAt } from './columns';
import { opportunities } from './entities';

export const oppEngagement = pgTable(
  'opp_engagement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    /** Monday of the ISO week (local). */
    weekStart: date('week_start').notNull(),
    meetings: numeric('meetings', { precision: 8, scale: 2 }).notNull().default('0'),
    externalMeetings: numeric('external_meetings', { precision: 8, scale: 2 }).notNull().default('0'),
    slackLines: numeric('slack_lines', { precision: 10, scale: 2 }).notNull().default('0'),
    mailThreads: numeric('mail_threads', { precision: 8, scale: 2 }).notNull().default('0'),
    docsTouched: numeric('docs_touched', { precision: 8, scale: 2 }).notNull().default('0'),
    sessions: numeric('sessions', { precision: 8, scale: 2 }).notNull().default('0'),
    notes: numeric('notes', { precision: 8, scale: 2 }).notNull().default('0'),
    hoursLogged: numeric('hours_logged', { precision: 8, scale: 2 }).notNull().default('0'),
    credit: numeric('credit', { precision: 10, scale: 2 }).notNull().default('0'),
    lastTouchAt: tstz('last_touch_at'),
    sourceCounts: jsonb('source_counts').$type<Record<string, number>>().notNull().default({}),
    refs: jsonb('refs').$type<Array<{ label: string; url: string | null; at: string }>>().notNull().default([]),
    computedAt: tstz('computed_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('opp_engagement_owner_opp_week_uidx').on(t.ownerUserId, t.opportunityId, t.weekStart), index('opp_engagement_owner_week_idx').on(t.ownerUserId, t.weekStart)],
);

export const dcSuggestions = pgTable(
  'dc_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    /** The fiscal quarter it was suggested for ("FY27 Q4"). */
    quarter: text('quarter').notNull(),
    /** One engagement, several opps: `<quarter>|<account id>`. */
    groupKey: text('group_key').notNull(),
    state: text('state').notNull().default('new'),
    sharePercent: integer('share_percent').notNull().default(100),
    /** The default DC split; null: another architect holds a DC on it (agree the split first). */
    splitPercent: integer('split_percent'),
    preTicked: boolean('pre_ticked').notNull().default(false),
    reasons: jsonb('reasons').$type<Array<{ code: string; text: string }>>().notNull().default([]),
    evidence: jsonb('evidence').$type<Array<{ label: string; url: string | null; at: string }>>().notNull().default([]),
    coveredAe: text('covered_ae'),
    /** Hours and team at the decision: a rejected one comes back on a material change. */
    baseline: jsonb('baseline').$type<{ hours: number; onTeam: boolean } | null>(),
    /** The DC request Accept drafted (deal_contribution_requests.id). */
    dcRequestId: uuid('dc_request_id'),
    decidedAt: tstz('decided_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('dc_suggestions_owner_opp_quarter_uidx').on(t.ownerUserId, t.opportunityId, t.quarter),
    index('dc_suggestions_owner_state_idx').on(t.ownerUserId, t.state),
    check('dc_suggestions_state_chk', sql`${t.state} IN ('new', 'accepted', 'edited', 'rejected', 'closed', 'stale', 'resolved')`),
  ],
);

export const attributionOutcomes = pgTable(
  'attribution_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** activity_entry · dc_suggestion · canvas_row · use_case. */
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    outcome: text('outcome').notNull(),
    /** What was shown: rules · ai · engine; the strongest reason's code; its confidence; the target (opp or account id, or 'internal'). */
    basis: text('basis'),
    topReason: text('top_reason'),
    shownConfidence: numeric('shown_confidence', { precision: 4, scale: 3 }),
    shownTarget: text('shown_target'),
    chosenTarget: text('chosen_target'),
    /** The learned rules the decision wrote or changed (ids). */
    ruleIds: jsonb('rule_ids').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index('attribution_outcomes_owner_created_idx').on(t.ownerUserId, t.createdAt), check('attribution_outcomes_outcome_chk', sql`${t.outcome} IN ('accept', 'edit', 'reject')`)],
);
