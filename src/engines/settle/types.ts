/**
 * The Settle pass (docs/reference/SCANNER.md §4.11): one cheap, tool-less model call per work item with the whole
 * conversation around it, oldest first, plus calendar events and sibling items. It answers "does this still need me?"
 * with one verdict, a cited line and a plain reason. The policy (policy.ts) turns that into close / ask / leave.
 */
import { z } from 'zod';

/** Verdicts in precedence order (the skill picks the first that applies). Same list as the private answer key. */
export const SETTLE_VERDICTS = [
  'duplicate',
  'not_an_ask',
  'not_yours',
  'done_by_you',
  'resolved_by_other',
  'handed_off',
  'superseded',
  'moment_passed',
  'waiting_on_them',
  'gone_quiet',
  'still_yours',
] as const;
export type SettleVerdict = (typeof SETTLE_VERDICTS)[number];

/** Verdicts that say nothing is owed now. */
export const SETTLED: ReadonlySet<SettleVerdict> = new Set(['duplicate', 'not_an_ask', 'not_yours', 'done_by_you', 'resolved_by_other', 'handed_off', 'superseded', 'moment_passed']);

export type LineKind = 'ask' | 'before' | 'after' | 'elsewhere' | 'event' | 'sibling';

/** One line the model sees, with the real ids behind its alias. */
export interface SettleLine {
  id: string;
  kind: LineKind;
  at: string | null;
  by: string;
  fromMe: boolean;
  where?: string;
  text: string;
  sourceItemId?: string;
  url?: string;
  workItemId?: string;
  calendarEventId?: string;
  /** Events: whether it has ended by `now`. */
  passed?: boolean;
}

export interface SettleItemInfo {
  id: string;
  kind: string;
  status: string;
  title: string;
  purpose?: string;
  due?: string;
  firstSeen: string;
  counterparty?: string;
  account?: string;
}

export interface SettleHints {
  ageDaysWhenSeen: number | null;
  dueBeforeFirstSeen: boolean;
  duePassed: boolean;
  conversation: 'thread' | 'dm' | 'group_dm' | 'channel' | 'email' | 'notes' | 'none';
  myRepliesAfterAsk: number;
  askerMessagesAfterAsk: number;
  firstReplyAfterMin: number | null;
  /** Email threads: the provider says I replied / the last message is mine. */
  repliedByMe?: boolean;
  lastMessageFromMe?: boolean;
  /** How many lines after the ask were dropped to fit (the middle of a long DM). */
  omittedAfter: number;
  /** The ask's stored text hit the source excerpt limit: the request may sit past what the check can see. */
  askCutOff?: boolean;
}

export interface SettleContext {
  now: string;
  timezone: string;
  me: string;
  item: SettleItemInfo;
  hints: SettleHints;
  ask: SettleLine | null;
  before: SettleLine[];
  after: SettleLine[];
  elsewhere: SettleLine[];
  events: SettleLine[];
  siblings: SettleLine[];
  corrections: string[];
  rules: string | null;
}

export const SettleReply = z.object({
  verdict: z.enum(SETTLE_VERDICTS),
  confidence: z.coerce.number().min(0).max(1).catch(0),
  cite: z.string().nullish(),
  reason: z.string().nullish(),
  owner: z.enum(['me', 'other', 'shared']).nullish().catch(undefined),
  duplicate_of: z.string().nullish(),
  needs: z.string().nullish(),
});

/** A parsed verdict, mapped back to real ids. `valid` is false when the citation rules were broken. */
export interface SettleResult {
  workItemId: string;
  verdict: SettleVerdict;
  confidence: number;
  reason: string;
  owner?: 'me' | 'other' | 'shared';
  needs?: string;
  cite?: SettleLine;
  duplicateOf?: string;
  valid: boolean;
  invalidWhy?: string;
  /** A matching calendar event is still ahead (the policy never closes `not_an_ask` / `moment_passed` / `gone_quiet` then). */
  upcomingEvent?: boolean;
  /** The asker wrote last, within a week, after my last line (the policy never closes the passive kinds then). */
  openLoop?: boolean;
  /** The ask's text was cut at the stored excerpt limit (the policy never closes `not_an_ask` / `not_yours` then). */
  askCutOff?: boolean;
  /** Set when the cheap model's verdict went to the stronger model; the cheap verdict it replaced. */
  escalatedFrom?: SettleVerdict;
  /** D4: the cheap verdict's confidence, whether the stronger reply was valid, and what the stronger call cost. */
  escalatedFromConfidence?: number;
  strongerValid?: boolean;
  escalationUsd?: number;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  skill: string;
  error?: string;
}
