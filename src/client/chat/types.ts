/**
 * Chat view models shared by the stream hook (src/client/chat) and the dock UI (src/components/chat).
 * Server shapes come from the contract; these add what only the client knows (streaming, tool args,
 * local errors, optimistic turns).
 */
import type { ApiErrorBody, ChatHoldView, ChatMessage, ChatPlan, ChatResource, ChatRoute, ChatSseEventType, ChatUsage, ContextRef, Proposal, Receipt } from '@/contract';

export interface ChatToolView {
  id: string;
  name: string;
  /** tool-start summary (what it set out to do; shown as "args" when expanded). Null for persisted rows. */
  startSummary: string | null;
  /** Latest human summary (tool-result replaces tool-start). */
  summary: string;
  /** null = still running. */
  ok: boolean | null;
  /** BE-CHAT: the latest tool-progress (chat-started scans), if any. */
  progress?: { done: number; total: number };
  /** Assistant v2: what the call cost on its own (a relay read, a sub-run). */
  costUsd?: number;
  /** A guard held the call for you (the contract's `held`): neutral, not failed. */
  held?: boolean;
}

export interface ChatProposalView {
  proposal: Proposal;
  /** SSE `proposal.summary` ("Shave 5 minutes off the estimate?"); null for persisted parts. */
  summary: string | null;
  /**
   * 2026-11-13 audit C8: an applied card read back after a reload carries its receipt here (the server stores it right
   * after the card), so the thread shows ONE card (the receipt in place), never the card plus a second receipt card.
   */
  receipt?: Receipt;
}

export type ChatTurnStatus = 'connecting' | 'streaming' | 'reconnecting' | 'done' | 'error' | 'stopped';

export interface ChatMessageView {
  id: string;
  threadId: string;
  role: ChatMessage['role'];
  at: string;
  text: string;
  context: ContextRef[];
  isMorningBrief: boolean;
  tools: ChatToolView[];
  receipts: Receipt[];
  proposals: ChatProposalView[];
  resources: ChatResource[];
  /** Live assistant turn: caret on, tools uncollapsed. */
  streaming: boolean;
  /** Live turn status (assistant) — undefined for settled server messages. */
  status?: ChatTurnStatus;
  error: ApiErrorBody | null;
  stopped: boolean;
  /** Optimistic user message not yet confirmed by the server. */
  pending: boolean;
  /** ASSIST-9: the live turn's spend so far (assistant, while it runs). */
  spentUsd?: number;
  spentModel?: string;
  /** ASSIST-9: the settled message's tokens and cost (the receipt line). */
  usage?: ChatUsage;
  /** Spend governor: the live turn passed its hold and waits for an answer (the spend-ask card). */
  spendAsk?: ChatSpendAskView;
  /** Assistant v2: the router's choice (header "Haiku · a lookup") and the plan cards of the turn. */
  route?: ChatRoute;
  plans?: ChatPlan[];
}

/** A `spend-ask` the live turn is waiting on (POST /chat/spend-answer answers it). */
export interface ChatSpendAskView {
  holdId: string;
  question: string;
  spentUsd: number;
  heldUsd: number;
  moreUsd: number;
}

/** One in-flight (or just-finished, not yet reconciled) exchange. */
export interface LiveTurn {
  key: string;
  threadId: string;
  userText: string;
  context: ContextRef[];
  sentAt: string;
  /** Server message ids present when the turn started (anything else belongs to this turn). */
  baseIds: string[];
  status: ChatTurnStatus;
  messageId: string | null;
  userMessageId: string | null;
  text: string;
  tools: ChatToolView[];
  receipts: Receipt[];
  proposals: ChatProposalView[];
  resources: ChatResource[];
  error: ApiErrorBody | null;
  lastEvent: ChatSseEventType | null;
  /** Reconnect attempts used so far (shown as "Reconnecting… 2/3"). */
  attempt: number;
  /** "Allow more" on a capped message: this turn may spend this much more (ChatRequest.allowExtraUsd). */
  allowExtraUsd?: number;
  /** "Allow more" continues this stopped assistant message instead of re-sending the question (ASSIST-2). */
  continueMessageId?: string;
  /** ASSIST-9: the turn's spend so far (the latest `usage-delta`), and the model it is on. */
  spentUsd?: number;
  spentModel?: string;
  /** Spend governor: the message's hold as it runs, and the ask it waits on (null once answered). */
  hold?: ChatHoldView;
  spendAsk?: ChatSpendAskView | null;
  /** Assistant v2: the route from `start`, and the plan cards as they arrive (answered ones replace waiting ones). */
  route?: ChatRoute;
  plans: ChatPlan[];
}

/** What only the live turn knew, kept for the persisted assistant message after reconciliation. */
export interface TurnExtras {
  error: ApiErrorBody | null;
  stopped: boolean;
  toolArgs: Record<string, string>;
  proposalSummaries: Record<string, string>;
}
