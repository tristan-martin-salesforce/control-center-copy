/**
 * Spend governor (holistic review 2026-11-20, 04 §4.3, H-5): one row per hold. Every LLM caller estimates first
 * (p50/p90 from llm_calls), holds p90 (or the user's budget for its unit, e.g. one Assistant message), ticks its actual
 * spend after each request, raises a hand (`asked`) instead of failing when it passes the hold, and settles.
 * Ids, amounts and states only; never content. Additive (0030).
 */
import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, tstz, usd } from './columns';
import { users } from './core';

export const spendHolds = pgTable(
  'spend_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** chat_message | scan_run | settle_pass | relay | research | feedback | job */
    scope: text('scope').notNull(),
    /** What the hold is for: a scan job id, a chat message id, a job kind + id. An id, never content. */
    jobKey: text('job_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    estimateP50: usd('estimate_p50').notNull().default(0),
    estimateP90: usd('estimate_p90').notNull().default(0),
    /** 'history' (at least 10 measured samples in 14 days) | 'default' (the static table, src/llm/spend/defaults.ts). */
    estimateBasis: text('estimate_basis').notNull().default('default'),
    heldUsd: usd('held_usd').notNull().default(0),
    spentUsd: usd('spent_usd').notNull().default(0),
    /** open | asked | approved | denied | settled | abandoned */
    state: text('state').notNull().default('open'),
    askedAt: tstz('asked_at'),
    answeredAt: tstz('answered_at'),
    /** "Allow $Z more": the amount approved. Null on an approved hold means "allow for today" (no more asks today). */
    answerUsd: usd('answer_usd'),
    /** The local day the hold counts against, and which budget (the daily one, or the one-time first scan, B-080). */
    budgetDay: date('budget_day', { mode: 'string' }).notNull(),
    budget: text('budget').notNull().default('daily'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
    /** llm_calls ids (or chat message ids) the hold paid for. */
    callIds: text('call_ids').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    index('spend_holds_user_day_idx').on(t.userId, t.budgetDay),
    index('spend_holds_open_idx').on(t.userId, t.state).where(sql`${t.state} IN ('open', 'asked', 'approved')`),
    index('spend_holds_job_key_idx').on(t.userId, t.jobKey),
    check('spend_holds_scope_chk', sql`${t.scope} IN ('chat_message', 'scan_run', 'settle_pass', 'relay', 'research', 'feedback', 'job')`),
    check('spend_holds_state_chk', sql`${t.state} IN ('open', 'asked', 'approved', 'denied', 'settled', 'abandoned')`),
    check('spend_holds_budget_chk', sql`${t.budget} IN ('daily', 'first_scan')`),
  ],
);
