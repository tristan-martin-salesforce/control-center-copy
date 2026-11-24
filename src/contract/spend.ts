/**
 * The spend governor's API (holistic review 2026-11-20, H-5: estimate → raise a hand → continue). Every LLM caller
 * holds an estimate; one that passes it raises a hand (`asked`) and waits for the user instead of failing:
 * Allow $Z more · Allow for today · Stop. Health's needs-you list and the Assistant's card answer through
 * POST /spend/holds/:id/answer (or /chat/spend-answer for the turn that is waiting). Every settled hold is a receipt
 * (GET /spend/holds). Amounts, ids and states only; never content.
 */
import { z } from 'zod';

import { Id, IsoDate, IsoDateTime } from './common';

export const SpendHoldScope = z.enum(['chat_message', 'scan_run', 'settle_pass', 'relay', 'research', 'feedback', 'job']);
export type SpendHoldScope = z.infer<typeof SpendHoldScope>;
export const SpendHoldState = z.enum(['open', 'asked', 'approved', 'denied', 'settled', 'abandoned']);
export type SpendHoldState = z.infer<typeof SpendHoldState>;

export const SpendHold = z.object({
  id: Id,
  scope: SpendHoldScope,
  /** What it was for (a scan job id, a chat message id, `<job kind>:<job id>`): ids only. */
  jobKey: z.string(),
  estimate: z.object({ p50: z.number().min(0), p90: z.number().min(0), basis: z.enum(['history', 'default']), n: z.number().int().min(0) }),
  heldUsd: z.number().min(0),
  spentUsd: z.number().min(0),
  state: SpendHoldState,
  budget: z.enum(['daily', 'first_scan']),
  budgetDay: IsoDate,
  askedAt: IsoDateTime.nullable(),
  answeredAt: IsoDateTime.nullable(),
  /** The last "Allow $Z more"; null on an approved hold means allowed for today. */
  answerUsd: z.number().min(0).nullable(),
  createdAt: IsoDateTime,
  settledAt: IsoDateTime.nullable(),
});
export type SpendHold = z.infer<typeof SpendHold>;

/** An open question (state `asked`): the plain text and the amount "Allow $Z more" offers. */
export const SpendAsk = z.object({
  holdId: Id,
  scope: SpendHoldScope,
  question: z.string(),
  spentUsd: z.number().min(0),
  heldUsd: z.number().min(0),
  moreUsd: z.number().min(0),
  askedAt: IsoDateTime,
});
export type SpendAsk = z.infer<typeof SpendAsk>;

export const ListSpendHoldsQuery = z.object({
  /** Holds created at or after (default: the last 7 days). */
  since: IsoDateTime.optional(),
  state: SpendHoldState.optional(),
});
export type ListSpendHoldsQuery = z.infer<typeof ListSpendHoldsQuery>;

export const SpendHoldsPayload = z.object({
  holds: z.array(SpendHold),
  /** Open questions, oldest first (Health's needs-you rows). */
  asks: z.array(SpendAsk),
  summary: z.object({
    asked: z.number().int().min(0),
    approved: z.number().int().min(0),
    denied: z.number().int().min(0),
    /** Median of (spent − held) / held over settled holds that went past their hold, in %; null when none did. */
    overrunMedianPct: z.number().nullable(),
  }),
});
export type SpendHoldsPayload = z.infer<typeof SpendHoldsPayload>;

/** Allow $Z more (`usd`) · Allow for today · Stop. */
export const SpendAnswerKind = z.enum(['approve', 'today', 'deny']);
export type SpendAnswerKind = z.infer<typeof SpendAnswerKind>;
export const AnswerSpendHoldRequest = z
  .object({ answer: SpendAnswerKind, usd: z.number().positive().max(100).optional() })
  .refine((b) => b.answer !== 'approve' || b.usd !== undefined, { message: 'Say how much more to allow', path: ['usd'] });
export type AnswerSpendHoldRequest = z.infer<typeof AnswerSpendHoldRequest>;

export const AnswerSpendHoldResult = z.object({
  hold: SpendHold,
  /** A run waiting in this process took the answer and continues; false: it is re-queued (or ended, for a chat turn). */
  resumed: z.boolean(),
});
export type AnswerSpendHoldResult = z.infer<typeof AnswerSpendHoldResult>;

/** POST /chat/spend-answer: the Assistant card's answer to its turn's `spend-ask`. */
export const ChatSpendAnswerRequest = z
  .object({ holdId: Id, answer: SpendAnswerKind, usd: z.number().positive().max(100).optional() })
  .refine((b) => b.answer !== 'approve' || b.usd !== undefined, { message: 'Say how much more to allow', path: ['usd'] });
export type ChatSpendAnswerRequest = z.infer<typeof ChatSpendAnswerRequest>;

/** The running hold on `usage-delta` (05 §6: spend shows live against its estimate). */
export const ChatHoldView = z.object({ p50: z.number().min(0), p90: z.number().min(0), spent: z.number().min(0), held: z.number().min(0), state: SpendHoldState });
export type ChatHoldView = z.infer<typeof ChatHoldView>;
