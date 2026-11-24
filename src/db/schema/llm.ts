/** LLM cost ledger and budgets (section 14). */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { tstz, createdAt, updatedAt, ownerUserId, usd } from './columns';
import {
  modelTier,
  llmPurpose,
  llmCallStatus,
  budgetScope,
} from './enums';
import { scanRuns } from './scanning';
import { jobs } from './jobs';
import { chatMessages } from './chat';

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    purpose: llmPurpose('purpose').notNull(),
    model: text('model').notNull(),
    modelTier: modelTier('model_tier').notNull(),
    skillKey: text('skill_key'),
    promptVersion: text('prompt_version'),
    /** Hash of (model, prompt version, inputs): cache key, never the prompt itself. */
    requestHash: text('request_hash').notNull(),
    jobId: bigint('job_id', { mode: 'number' }).references(() => jobs.id, { onDelete: 'set null' }),
    scanRunId: uuid('scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
    chatMessageId: uuid('chat_message_id').references((): AnyPgColumn => chatMessages.id, { onDelete: 'set null' }),
    status: llmCallStatus('status').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: usd('cost_usd').notNull().default(0),
    /** True when the gateway gave no price and cost came from the rate card. */
    costEstimated: boolean('cost_estimated').notNull().default(false),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    /** Local (owner timezone) day the spend counts against. */
    budgetDay: date('budget_day', { mode: 'string' }).notNull(),
    /** Which budget it spends (AUDIT): the daily cap, or the one-time first-scan backfill budget (B-080). */
    budget: text('budget').notNull().default('daily'),
    /**
     * D0 (audit, 2026-11-13): what started the call, in the caller's words (`schedule`, `file_watch`, `manual`, a
     * read-in trigger such as `direct_ask`, a settle pass trigger such as `interval`). Null on rows from before D0.
     */
    trigger: text('trigger'),
    /**
     * Why this model (D0): `default` (the skill's model), `user_asked` (the user asked; the stronger model),
     * `policy:<trigger>` (a per-trigger model choice), `escalation:<why>` (a second pass after an unclear first one),
     * `override` (an env or test override). Null on rows from before D0.
     */
    modelReason: text('model_reason'),
    /** sha256 (first 32 hex) of model + prompt version + prompt + input: identical repeats share it. Never the prompt. */
    contentHash: text('content_hash'),
    /** A short code for what came of the call (`items:2`, `verdict:done`, `ready`, `nothing_new`); never content. */
    outcome: text('outcome'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    /*
     * Measurement (0027, holistic review 04 §4.5, COST-12). All nullable: rows from before 0027, and calls that do
     * not measure a field, leave it null. Ids, counts and hashes only, never content.
     */
    /** Prompt tokens (uncached + cache read + cache write) of the call's first model request. */
    firstPromptTokens: integer('first_prompt_tokens'),
    /** The largest prompt of any one request in the call: what the per-request long-prompt price tier counts. */
    maxPromptTokens: integer('max_prompt_tokens'),
    /** Requests whose prompt passed the model's long-prompt threshold (Haiku 5.5: 100K, priced 5×). */
    longTierRequests: integer('long_tier_requests'),
    /** Model requests in the call (each one re-reads the prompt). */
    turns: integer('turns'),
    /** Tools loaded into the model's context (the SDK init message), and their schema tokens (getContextUsage). */
    toolCount: integer('tool_count'),
    toolSchemaTokens: integer('tool_schema_tokens'),
    /** ledgerHash of everything before the cache boundary (model, tool names, static system prompt): cache identity. */
    prefixHash: text('prefix_hash'),
    /** Items the call was given or read; items rules settled with no model; items it proposed or linked. */
    itemsIn: integer('items_in'),
    itemsDecidedByRules: integer('items_decided_by_rules'),
    itemsOut: integer('items_out'),
    /** A stronger-model escalation: the cheaper call it re-did. */
    escalatedFromCallId: bigint('escalated_from_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, { onDelete: 'set null' }),
    /** D4 on escalations: how many of the escalated items the stronger model gave a different verdict (null: not an escalation). */
    escalationChangedItems: integer('escalation_changed_items'),
  },
  (t) => [
    index('llm_calls_owner_day_idx').on(t.ownerUserId, t.budgetDay),
    index('llm_calls_scan_run_idx').on(t.scanRunId).where(sql`${t.scanRunId} IS NOT NULL`),
    index('llm_calls_purpose_started_idx').on(t.purpose, t.startedAt.desc()),
    index('llm_calls_request_hash_idx').on(t.requestHash),
    index('llm_calls_job_idx').on(t.jobId).where(sql`${t.jobId} IS NOT NULL`),
    check('llm_calls_budget_chk', sql`${t.budget} IN ('daily', 'first_scan')`),
    index('llm_calls_owner_content_idx').on(t.ownerUserId, t.contentHash).where(sql`${t.contentHash} IS NOT NULL`),
  ],
);

/**
 * D0 (audit, 2026-11-13): every decision NOT to call the model, to escalate, or a call the budget refused, with its
 * reason. One row per (day, skill, kind, reason, trigger, subject), counted: a burst of busy ↔ idle flips on one Claude
 * session is one row with a count, so the table stays small and reads by day / skill / reason in one index.
 *
 * Why a table and not trace events: most of these decisions happen outside a scan run (read-ins, settle, a file-watch
 * scan the model never saw), scan_run_events go away with their runs under retention, and this is the audit trail.
 *
 *   kind     skip      the model was not called (reason: evidence_unchanged, status_only, min_interval, precheck_empty …)
 *            escalate  a stronger model was called after the first one (reason: verdict_changed, verdict_same …)
 *            block     a budget refused the call (reason: hard_cap, readin_cap, stronger_day_cap, escalation_day_cap …)
 *   subject  an id only (a work item, a Claude session, a scan scope); never content
 *   detail   ids, counts and codes only (the last occurrence's)
 */
export const llmDecisions = pgTable(
  'llm_decisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    /** Local (owner timezone) day, like llm_calls.budget_day. */
    day: date('day', { mode: 'string' }).notNull(),
    skillKey: text('skill_key').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    trigger: text('trigger').notNull().default(''),
    subject: text('subject').notNull().default(''),
    count: integer('count').notNull().default(1),
    /** skip / block: what the call would have cost (an estimate); escalate: what the extra call cost. */
    usd: usd('usd').notNull().default(0),
    /** escalate: the stronger call this decision is about (the latest one). */
    llmCallId: bigint('llm_call_id', { mode: 'number' }).references(() => llmCalls.id, { onDelete: 'set null' }),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    firstAt: tstz('first_at').notNull().defaultNow(),
    lastAt: tstz('last_at').notNull().defaultNow(),
  },
  (t) => [
    unique('llm_decisions_uq').on(t.ownerUserId, t.day, t.skillKey, t.kind, t.reason, t.trigger, t.subject),
    index('llm_decisions_owner_day_idx').on(t.ownerUserId, t.day),
    check('llm_decisions_kind_chk', sql`${t.kind} IN ('skip', 'escalate', 'block')`),
  ],
);

/**
 * E4 (audit 2026-11-13, lane E): `llm_calls` past the audit horizon (400 days), rolled up per local day. The retention
 * job inserts a day's totals and deletes the same calls in one transaction, so nothing is ever deleted unrolled, and a
 * re-run adds to the day instead of counting twice. A call something still points at (a draft, a chat message, an
 * evidence row, a decision) is never rolled up: it stays whole, so a day's total is its rollup plus any such calls.
 * Per call it keeps what the Spend view groups by (purpose, model, skill, budget, trigger, model reason, status); it
 * drops the per-call detail (ids, hashes, outcome codes).
 */
export const llmCallDays = pgTable(
  'llm_call_days',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    /** The local day the calls counted against (llm_calls.budget_day). */
    day: date('day', { mode: 'string' }).notNull(),
    purpose: llmPurpose('purpose').notNull(),
    model: text('model').notNull(),
    modelTier: modelTier('model_tier').notNull(),
    /** '' for calls without one (llm_calls.skill_key, trigger and model_reason are nullable). */
    skillKey: text('skill_key').notNull().default(''),
    budget: text('budget').notNull().default('daily'),
    trigger: text('trigger').notNull().default(''),
    modelReason: text('model_reason').notNull().default(''),
    status: llmCallStatus('status').notNull(),
    calls: integer('calls').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: usd('cost_usd').notNull().default(0),
    /** Calls whose cost came from the rate card (llm_calls.cost_estimated). */
    estimatedCalls: integer('estimated_calls').notNull().default(0),
    latencyMsTotal: bigint('latency_ms_total', { mode: 'number' }).notNull().default(0),
    firstAt: tstz('first_at').notNull(),
    lastAt: tstz('last_at').notNull(),
    rolledUpAt: tstz('rolled_up_at').notNull().defaultNow(),
  },
  (t) => [
    unique('llm_call_days_uq').on(t.ownerUserId, t.day, t.purpose, t.model, t.modelTier, t.skillKey, t.budget, t.trigger, t.modelReason, t.status),
    index('llm_call_days_owner_day_idx').on(t.ownerUserId, t.day),
  ],
);

/**
 * E4: `llm_decisions` past the audit horizon, per day without the subject (the per-item id): how many decisions of a
 * kind and reason a skill made that day (`decisions` rows, `count` occurrences) and their dollars. Same rules as
 * llm_call_days: rolled up and deleted in one transaction, never deleted unrolled.
 */
export const llmDecisionDays = pgTable(
  'llm_decision_days',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    day: date('day', { mode: 'string' }).notNull(),
    skillKey: text('skill_key').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    trigger: text('trigger').notNull().default(''),
    /** llm_decisions rows rolled into this one (one per subject). */
    decisions: integer('decisions').notNull().default(0),
    /** Sum of their `count`. */
    count: integer('count').notNull().default(0),
    usd: usd('usd').notNull().default(0),
    firstAt: tstz('first_at').notNull(),
    lastAt: tstz('last_at').notNull(),
    rolledUpAt: tstz('rolled_up_at').notNull().defaultNow(),
  },
  (t) => [
    unique('llm_decision_days_uq').on(t.ownerUserId, t.day, t.skillKey, t.kind, t.reason, t.trigger),
    index('llm_decision_days_owner_day_idx').on(t.ownerUserId, t.day),
    check('llm_decision_days_kind_chk', sql`${t.kind} IN ('skip', 'escalate', 'block')`),
  ],
);

export const llmBudgets = pgTable(
  'llm_budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    scope: budgetScope('scope').notNull(),
    /** null for 'total'; an llm_purpose or model_tier value otherwise. */
    scopeValue: text('scope_value'),
    dailyLimitUsd: numeric('daily_limit_usd', { precision: 10, scale: 2, mode: 'number' }).notNull(),
    alertAtPct: smallint('alert_at_pct').notNull().default(80),
    /** true = block new non-interactive calls at the limit; false = alert only. */
    hardStop: boolean('hard_stop').notNull().default(false),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('llm_budgets_owner_scope_uq').on(t.ownerUserId, t.scope, t.scopeValue).nullsNotDistinct(),
    check('llm_budgets_scope_value_chk', sql`(${t.scope} = 'total') = (${t.scopeValue} IS NULL)`),
  ],
);

/** Atomic per-day rollup: reserve before a call, settle after. */
export const llmBudgetDays = pgTable(
  'llm_budget_days',
  {
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => llmBudgets.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    reservedUsd: usd('reserved_usd').notNull().default(0),
    spentUsd: usd('spent_usd').notNull().default(0),
    callCount: integer('call_count').notNull().default(0),
    alertedAt: tstz('alerted_at'),
    blockedAt: tstz('blocked_at'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.budgetId, t.day] })],
);

export type LlmCall = typeof llmCalls.$inferSelect;
export type LlmDecision = typeof llmDecisions.$inferSelect;
