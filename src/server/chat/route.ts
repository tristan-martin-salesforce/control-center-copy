/**
 * One turn's route, read the same way by both DataSources (D-81 as amended): the router's inputs from the thread (the
 * previous assistant turn: a follow-up keeps its tier, a turn after a failed Haiku turn goes to Sonnet) and from the
 * Assistant's day line (what is left today, the same figure the runner refuses a turn on: `chatDailyUsd -
 * chatTodayUsd`), with the per-message lines from Settings.
 */
import type { ChatMessage, ChatModel, ChatModelChoice, ChatRoute } from '@/contract';
import { previousTurnOf, routeTurn } from '@/llm/chat/router';
import type { ChatBudget } from '@/llm/chat/types';

export interface RouteChatTurnInput {
  text: string;
  choice: ChatModelChoice | null;
  setting: ChatModelChoice | null;
  /** The thread's messages before this one, oldest first. */
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'route' | 'text' | 'status' | 'parts'>>;
  /** The chat backend's budget read (the runner's own). Absent or failing: the day line is not checked here. */
  budget?: (model: ChatModel) => Promise<ChatBudget>;
  /** settings.chat.messageUsd. */
  messageUsd?: Partial<Record<ChatModel, number>> | null;
}

/** What is left of the Assistant's day line (never below 0); null when it can't be read. */
export async function chatDayLeftUsd(budget: RouteChatTurnInput['budget']): Promise<number | null> {
  if (!budget) return null;
  try {
    const b = await budget('haiku'); // the day line and today's spend do not depend on the model
    return Math.max(0, Math.round((b.chatDailyUsd - b.chatTodayUsd) * 1e6) / 1e6);
  } catch {
    return null;
  }
}

export async function routeChatTurn(i: RouteChatTurnInput): Promise<ChatRoute> {
  const chosen = (c: ChatModelChoice | null) => !!c && c !== 'auto';
  // a model the user chose wins outright: no budget read needed
  const dayLeftUsd = chosen(i.choice) || chosen(i.setting) ? null : await chatDayLeftUsd(i.budget);
  return routeTurn({ text: i.text, choice: i.choice, setting: i.setting, previous: previousTurnOf(i.messages), ...(dayLeftUsd !== null ? { dayLeftUsd } : {}), messageUsd: i.messageUsd ?? null });
}
