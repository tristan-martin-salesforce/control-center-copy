/**
 * The spend governor's types (holistic review 2026-11-20: 04 §4.3, 05 §6, H-5 "estimate → raise a hand → continue").
 *
 * One envelope model for every LLM caller: estimate → hold → run (tick after every request) → ask when the hold is
 * passed → settle. A limit exists only for a real external limit, a user budget or safety (the daily hard cap, a
 * message's budget); everything else is an estimate that warns, raises a hand and continues. Never kills.
 */

export const SPEND_SCOPES = ['chat_message', 'scan_run', 'settle_pass', 'relay', 'research', 'feedback', 'job'] as const;
export type SpendScope = (typeof SPEND_SCOPES)[number];

export const HOLD_STATES = ['open', 'asked', 'approved', 'denied', 'settled', 'abandoned'] as const;
export type HoldState = (typeof HOLD_STATES)[number];
/** States that still hold money against the day. */
export const LIVE_HOLD_STATES: ReadonlySet<HoldState> = new Set(['open', 'asked', 'approved']);

export type SpendBudget = 'daily' | 'first_scan';

/** What is about to spend: enough to find its history in llm_calls and name its hold. Ids and keys only. */
export interface SpendJob {
  scope: SpendScope;
  /** The scan job id, the chat message id, `settle.check:<jobId>`… */
  jobKey: string;
  /** llm_calls.skill_key to read history from (a connector's skill, `chat-assistant`, `settle-item`…). */
  skill?: string;
  model?: string;
  /** Items the job will handle, when its cost scales with them (history and defaults are then per item). */
  items?: number;
  budget?: SpendBudget;
}

export interface Estimate {
  p50: number;
  p90: number;
  /** history: at least MIN_SAMPLES measured runs in the last 14 days; default: the static table. */
  basis: 'history' | 'default';
  /** Samples it was computed from (0 for the default). */
  n: number;
}

export interface Hold {
  id: string;
  scope: SpendScope;
  jobKey: string;
  estimate: Estimate;
  heldUsd: number;
  spentUsd: number;
  state: HoldState;
  budget: SpendBudget;
  budgetDay: string;
  askedAt: string | null;
  answeredAt: string | null;
  /** The last "Allow $Z more"; null on an approved hold = allowed for today (no more asks). */
  answerUsd: number | null;
  createdAt: string;
  settledAt: string | null;
  callIds: string[];
}

/** The user's answer to an ask (Health, the Assistant card, POST /spend/holds/:id/answer). */
export type SpendAnswer = { kind: 'approve'; usd: number } | { kind: 'today' } | { kind: 'deny' };

/** Today's money against the user's daily budget: booked spend, what live holds still hold, the lines. */
export interface DayStatus {
  day: string;
  spentUsd: number;
  /**
   * What live holds hold (their whole amount: a run's spend is booked when it ends, so nothing counts twice for
   * long), plus other callers' in-flight reservations.
   */
  heldUsd: number;
  softUsd: number;
  hardUsd: number;
}

export interface SpendEvent {
  code: 'SPEND.ASK' | 'SPEND.DAY_BUDGET';
  message: string;
  /** Repeats bump one row (app_events fingerprint). */
  fingerprint: string;
  severity: 'info' | 'warn';
  detail: Record<string, unknown>;
}

/** Persistence for the governor: Postgres (src/server/datasource/db/spend.ts) or memory (tests, mock). */
export interface SpendStore {
  /** Per-run (or per-message) USD of this skill over the last `sinceDays`, newest first; per item when `perItem`. */
  costSamples(q: { scope: SpendScope; skill?: string; model?: string; sinceDays: number; perItem?: boolean }): Promise<number[]>;
  /** Insert a hold; a daily hold also holds `heldUsd` against today's budget (atomic with the day check). */
  insertHold(h: Omit<Hold, 'id' | 'createdAt' | 'settledAt' | 'askedAt' | 'answeredAt' | 'answerUsd' | 'callIds'> & { callIds?: string[] }): Promise<Hold>;
  getHold(id: string): Promise<Hold | null>;
  /** Patch a hold; `addHeldUsd` also moves the day's reservation by that much (a raise). */
  updateHold(id: string, patch: Partial<Pick<Hold, 'spentUsd' | 'state' | 'askedAt' | 'answeredAt' | 'answerUsd' | 'settledAt' | 'callIds'>> & { addHeldUsd?: number }): Promise<Hold | null>;
  /** Newest first. `limit` omitted: every match (a caller that needs one row says so; nothing is cut silently). */
  listHolds(q: { since?: string; states?: HoldState[]; scope?: SpendScope; jobKey?: string; jobKeyPrefix?: string; limit?: number }): Promise<Hold[]>;
  dayStatus(): Promise<DayStatus>;
  /** Today's date in the user's zone (the budget day). */
  today(): Promise<string>;
  recordEvent(e: SpendEvent): Promise<void>;
  resolveEvent(fingerprint: string): Promise<void>;
  /** "Allow for today": raise today's hard cap by `addUsd` (today only, recorded as a raise). */
  raiseToday?(addUsd: number, reason: string): Promise<void>;
  now(): Date;
}
