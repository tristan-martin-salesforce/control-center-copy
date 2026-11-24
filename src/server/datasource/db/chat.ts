/**
 * Chat in db mode (CONTRACT-1). The turn loop is shared with the mock (src/server/chat/turn.ts): `start`
 * first, then the backend's steps as stream events, then `done` or `error`; the assistant message is
 * persisted exactly once, in a `finally`, with its model, status, usage and every part.
 *
 * BE-6 (BE-CHAT) is `chatRunnerBackend` below: the Agent SDK runner when CC_CHAT_LLM=1, the same runner
 * over the deterministic fake model otherwise (`createDbDataSource` wires it). A `new DbDataSource()`
 * without a `chatBackend` keeps the explicit "not wired" default: the turn fails with
 * `upstream_unavailable` "chat backend not wired (BE-6)", persisted as an `error` part. A backend is any
 * `(ctx) => AsyncIterable<ChatStep>`; it reads and writes only through `ctx.ops` / `ctx.host` (actor
 * `chat`, never a user lock; BE-CHAT changes are proposals the user applies).
 */
import type { ChatModel, ChatRoute, ContextRef } from '@/contract';
import { EntityType as EntityTypeSchema } from '@/contract';
import type { ChatHost, ChatTurnRunner } from '@/llm/chat/types';
import { AppError } from '@/server/errors';

import type { ChatStep } from '../mock/chat-runtime';
import type { DbChatOps } from './chat-ops';

export interface DbChatContext {
  text: string;
  /** Message chips plus the thread's own context (as `auto`). */
  context: ContextRef[];
  threadId: string;
  now: Date;
  model: ChatModel;
  ops: DbChatOps;
  signal: AbortSignal;
  /** BE-CHAT: the turn's ids and the chat host (reads, staged proposals, scans, drafts, sessions, spend). */
  messageId?: string;
  userMessageId?: string;
  host?: ChatHost;
  /** ChatRequest.allowExtraUsd: a one-time approval to spend more on this message. */
  allowExtraUsd?: number;
  /** ChatRequest.continueMessageId: "Allow more" continues that stopped message (ASSIST-2). */
  continueMessageId?: string;
  /** Assistant v2: the router's choice for this turn. */
  route?: ChatRoute;
}

export type DbChatBackend = (ctx: DbChatContext) => AsyncIterable<ChatStep>;

export const CHAT_NOT_WIRED = 'chat backend not wired (BE-6)';

/** The explicit "no backend" default: no model is called; the turn's first step fails with `upstream_unavailable`. */
export const notWiredChatBackend: DbChatBackend = () => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new AppError('upstream_unavailable', CHAT_NOT_WIRED)) }),
});

/** BE-CHAT: a DbChatBackend over a chat runner (needs `ctx.host` and the turn ids, which `chat()` sets). */
export function chatRunnerBackend(runner: ChatTurnRunner): DbChatBackend {
  return (ctx) => {
    if (!ctx.host || !ctx.messageId || !ctx.userMessageId) return notWiredChatBackend(ctx);
    return runner({ threadId: ctx.threadId, messageId: ctx.messageId, userMessageId: ctx.userMessageId, text: ctx.text, context: ctx.context, model: ctx.model, signal: ctx.signal, ...(ctx.allowExtraUsd ? { allowExtraUsd: ctx.allowExtraUsd } : {}), ...(ctx.continueMessageId ? { continueMessageId: ctx.continueMessageId } : {}), ...(ctx.route ? { route: ctx.route } : {}) }, ctx.host);
  };
}

export { chatProposalStatus, redactedText, runTurn } from '@/server/chat/turn';
export type { TurnIds } from '@/server/chat/turn';

/** Chat context chips from a request. Unknown entity types are dropped (the stored message must stay contract-valid). */
export function contextRefs(input: Array<{ type: string; id: string; label: string; via?: 'auto' | 'explicit' }>, via?: 'auto' | 'explicit'): ContextRef[] {
  const out: ContextRef[] = [];
  for (const c of input) {
    const t = EntityTypeSchema.safeParse(c.type);
    if (t.success) out.push({ type: t.data, id: c.id, label: c.label, via: via ?? c.via ?? 'explicit' });
  }
  return out;
}

/** The thread's context as `auto` chips, minus what the message already carries. */
export function mergeThreadContext(message: ContextRef[], thread: ContextRef[] | undefined): ContextRef[] {
  const extra = (thread ?? []).filter((c) => !message.some((u) => u.type === c.type && u.id === c.id)).map((c) => ({ ...c, via: 'auto' as const }));
  return [...message, ...extra];
}
