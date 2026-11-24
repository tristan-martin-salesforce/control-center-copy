/** The Assistant (chat). */
import type { In, Out, Stream, WithSignal } from './route';

export interface ChatSource {
  listChatThreads(i: In<'listChatThreads'>): Out<'listChatThreads'>;
  /** New empty thread (optional title + context). Not audited, like chat messages. */
  createChatThread(i: In<'createChatThread'>): Out<'createChatThread'>;
  getChatThread(i: In<'getChatThread'>): Out<'getChatThread'>;
  /**
   * One turn. Yields `start` first (ids + model = body.model ?? settings.chat.defaultModel), then the
   * script's events, then `done` or `error`. Persists the user and assistant messages with every part
   * (see ChatMessage). Chat-made changes are audited with actor `chat` and never add userLockedFields.
   */
  chat(i: WithSignal<In<'chat'>>): Stream<'chat'>;
  /** Assistant v2: the plan card's answer (Run / Edit / Skip) to the turn waiting on it. */
  chatPlanAnswer(i: In<'chatPlanAnswer'>): Out<'chatPlanAnswer'>;
  /** Assistant v2: the Assistant's memory (a thread's notes and summaries, the user's preferences). */
  listChatMemory(i: In<'listChatMemory'>): Out<'listChatMemory'>;
  deleteChatMemory(i: In<'deleteChatMemory'>): Out<'deleteChatMemory'>;
}
