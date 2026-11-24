/** Priority runs, scores, rule hits and day-plan steps (section 8; R-UI-4, R-UI-16). */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, tstz, ownerUserId, scorePart } from './columns';
import {
  priorityTrigger,
  priorityLane,
  planStepMode,
} from './enums';
import { priorityPolicies, priorityPolicyRules } from './settings';
import { calendarEvents } from './calendar';
import { workItems } from './work';

export const priorityRuns = pgTable(
  'priority_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    trigger: priorityTrigger('trigger').notNull(),
    engineVersion: text('engine_version').notNull(),
    /**
     * The user's policy version this run applied (R-UI-16). Cascade (INTEGRATE-1, migration 0006): a
     * policy version row is only ever deleted by undoing the change set that created it, and the rankings
     * computed under it are derived engine output (unaudited, B5) that goes with it.
     */
    policyId: uuid('policy_id')
      .notNull()
      .references(() => priorityPolicies.id, { onDelete: 'cascade' }),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    itemsConsidered: integer('items_considered').notNull().default(0),
    itemsChanged: integer('items_changed').notNull().default(0),
    /** Free focus minutes left today after meetings (calendar-aware). */
    availableFocusMinutes: integer('available_focus_minutes'),
    nextMeetingAt: tstz('next_meeting_at'),
    /**
     * 0033 (priority@2 shadow, lane 07 R8): the run records both rankings. `ranking` is the order shown and stored;
     * in shadow (`settings.priority.engine = shadow`) `shadowRanking` is priority@2's order over the same inputs (it
     * writes no scores and moves no rank) and `agreement3` their Top 3 agreement. Ids and numbers only.
     */
    ranking: jsonb('ranking').$type<PriorityRunRanking>(),
    shadowEngineVersion: text('shadow_engine_version'),
    shadowRanking: jsonb('shadow_ranking').$type<PriorityRunRanking>(),
    agreement3: numeric('agreement3', { precision: 4, scale: 2, mode: 'number' }),
  },
  (t) => [index('priority_runs_owner_finished_idx').on(t.ownerUserId, t.finishedAt.desc())],
);

/** `priority_runs.ranking`: the order a run produced (ids, ranks and scores; never titles or text). */
export interface PriorityRunRanking {
  top3: string[];
  /** The first 20 ranked ids, in order. */
  order: string[];
  /** v2 terms of the first 10 (value, urgency), for Health's disagreements. */
  terms?: Record<string, { value: number; urgency: number }>;
}

/** One row per (run, item) whose inputs changed; components are explicit columns (tenet: Legible). */
export const priorityScores = pgTable(
  'priority_scores',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: bigint('run_id', { mode: 'number' })
      .notNull()
      .references(() => priorityRuns.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    /** Denormalized from the run so a score row explains itself in that policy's terms (cascade: see the run). */
    policyId: uuid('policy_id')
      .notNull()
      .references(() => priorityPolicies.id, { onDelete: 'cascade' }),
    total: numeric('total', { precision: 8, scale: 3, mode: 'number' }).notNull(),
    deadlineProximity: scorePart('deadline_proximity'),
    calendarPressure: scorePart('calendar_pressure'),
    leadTime: scorePart('lead_time'),
    effortFit: scorePart('effort_fit'),
    stakeholderImportance: scorePart('stakeholder_importance'),
    dealValue: scorePart('deal_value'),
    commitmentWeight: scorePart('commitment_weight'),
    staleness: scorePart('staleness'),
    /** DC/logging comp-linked boost, mandatory trainings. */
    obligationBoost: scorePart('obligation_boost'),
    userAdjustment: scorePart('user_adjustment'),
    penalty: scorePart('penalty'),
    lane: priorityLane('lane').notNull(),
    rank: integer('rank'),
    /** deadline - lead time - buffer: the "kick off the long build first" signal. */
    latestStartAt: tstz('latest_start_at'),
    slackMinutes: integer('slack_minutes'),
    inputsHash: text('inputs_hash').notNull(),
    explanation: text('explanation').notNull(),
    computedAt: tstz('computed_at').notNull().defaultNow(),
    /** 0033 (priority@2): V, U and the terms (the component columns stay null for priority@2 rows). */
    value: numeric('value', { precision: 7, scale: 3, mode: 'number' }),
    urgency: numeric('urgency', { precision: 5, scale: 3, mode: 'number' }),
    terms: jsonb('terms').$type<Record<string, number>>(),
  },
  (t) => [
    uniqueIndex('priority_scores_run_item_uidx').on(t.runId, t.workItemId),
    index('priority_scores_item_computed_idx').on(t.workItemId, t.computedAt.desc()),
  ],
);

/** Which policy rules fired for a score, with the user-facing explanation. */
export const priorityScoreRuleHits = pgTable(
  'priority_score_rule_hits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    scoreId: bigint('score_id', { mode: 'number' })
      .notNull()
      .references(() => priorityScores.id, { onDelete: 'cascade' }),
    /** Cascade with the rule's policy version (see priority_runs.policy_id). */
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => priorityPolicyRules.id, { onDelete: 'cascade' }),
    effect: numeric('effect', { precision: 7, scale: 3, mode: 'number' }),
    explanation: text('explanation').notNull(),
  },
  (t) => [uniqueIndex('priority_score_rule_hits_score_rule_uidx').on(t.scoreId, t.ruleId)],
);

export const priorityPlanSteps = pgTable(
  'priority_plan_steps',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: bigint('run_id', { mode: 'number' })
      .notNull()
      .references(() => priorityRuns.id, { onDelete: 'cascade' }),
    ordinal: smallint('ordinal').notNull(),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'cascade' }),
    calendarEventId: uuid('calendar_event_id').references(() => calendarEvents.id, { onDelete: 'cascade' }),
    mode: planStepMode('mode').notNull(),
    plannedStartAt: tstz('planned_start_at'),
    plannedEndAt: tstz('planned_end_at'),
    reason: text('reason').notNull(),
  },
  (t) => [
    uniqueIndex('priority_plan_steps_run_ordinal_uidx').on(t.runId, t.ordinal),
    check('priority_plan_steps_target_chk', sql`num_nonnulls(${t.workItemId}, ${t.calendarEventId}) >= 1`),
  ],
);

/**
 * 0033 (lane 07 R8, PRIO-14; *Suggest, then learn*): every manual reorder, snooze, "not today", pin and "do first",
 * append-only. `terms` holds the ranking's terms at the time for the item and its neighbours (numbers and ids only,
 * never text: *Local data, privacy-safe logs*). The nightly `priority.feedback` job reads it.
 */
export const priorityFeedback = pgTable(
  'priority_feedback',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    fromRank: integer('from_rank'),
    toRank: integer('to_rank'),
    engineVersion: text('engine_version').notNull(),
    runId: bigint('run_id', { mode: 'number' }).references(() => priorityRuns.id, { onDelete: 'set null' }),
    terms: jsonb('terms').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('priority_feedback_owner_created_idx').on(t.ownerUserId, t.createdAt.desc()),
    check('priority_feedback_action_chk', sql`${t.action} in ('reorder', 'snooze', 'not_today', 'pin', 'do_first')`),
  ],
);

/**
 * 0033: learning rules, `mapping_rules`-style: a bounded nudge of one persona priority weight the nightly job suggests
 * from `priority_feedback`; the user applies or dismisses it in Health (one click). Applied rules feed priority@2's
 * config (`applyNudges`); nothing changes before the click.
 */
export const priorityRules = pgTable(
  'priority_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** "deal:-1": the same finding never stacks a second suggestion. */
    ruleKey: text('rule_key').notNull(),
    term: text('term').notNull(),
    target: text('target').notNull(),
    direction: smallint('direction').notNull(),
    text: text('text').notNull(),
    status: text('status').notNull().default('suggested'),
    pairs: integer('pairs').notNull().default(0),
    createdAt: createdAt(),
    decidedAt: tstz('decided_at'),
  },
  (t) => [
    index('priority_rules_owner_status_idx').on(t.ownerUserId, t.status),
    uniqueIndex('priority_rules_owner_key_suggested_uidx').on(t.ownerUserId, t.ruleKey).where(sql`${t.status} = 'suggested'`),
    check('priority_rules_status_chk', sql`${t.status} in ('suggested', 'applied', 'dismissed')`),
    check('priority_rules_direction_chk', sql`${t.direction} in (-1, 1)`),
    check('priority_rules_target_chk', sql`${t.target} in ('who', 'deal', 'kind', 'importance', 'goal', 'urgencyFloor')`),
  ],
);
