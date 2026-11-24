/**
 * SEC-8: the message a memory entry came from (Settings ▸ Assistant lists every pinned entry and preference with it).
 * Exact since 0038: `remember` stores the id of the user message its turn answers (`chat_memory.source_message_id`), and
 * the source is that message (null when it is gone, never a guess).
 *
 * Fallback, only for rows written before 0038 (no stored id): `remember` runs inside the turn that answers your latest
 * message, so the source is your latest message at or before the entry (in its thread, for a thread note). A
 * preference is kept only when your words asked for it (`preferenceInUserWords`, the same test the write passed), so
 * the latest message that passes it wins over a later one that doesn't. Two threads written within the clock slack can
 * show the wrong source there. Pure; db and mock feed it the same rows.
 */
import type { ChatMemoryEntry, ChatMemorySource } from '@/contract';
import { preferenceInUserWords } from '@/llm/chat/user-said';

export interface MemorySourceMessage {
  id: string;
  threadId: string;
  threadTitle: string;
  at: string;
  text: string;
}

/** Clock slack between the entry's write and its message's timestamp (db rows use the database clock). */
const SLACK_MS = 5_000;
const EXCERPT = 160;

export function excerptOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= EXCERPT ? one : `${one.slice(0, EXCERPT - 1).replace(/\s+\S*$/, '')}…`;
}

/** `messages`: your (role user) messages, any order. Null when none fits. */
export function memorySource(e: Pick<ChatMemoryEntry, 'threadId' | 'kind' | 'text' | 'createdAt'> & { sourceMessageId?: string | null }, messages: readonly MemorySourceMessage[]): ChatMemorySource | null {
  if (e.sourceMessageId) return sourceOf(messages.find((x) => x.id === e.sourceMessageId));
  const until = Date.parse(e.createdAt) + SLACK_MS;
  const before = messages.filter((m) => (!e.threadId || m.threadId === e.threadId) && Date.parse(m.at) <= until).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  const m = (e.kind === 'preference' ? before.find((x) => preferenceInUserWords({ text: x.text }, e.text)) : undefined) ?? before[0];
  return sourceOf(m);
}

const sourceOf = (m: MemorySourceMessage | undefined): ChatMemorySource | null => (m ? { threadId: m.threadId, threadTitle: m.threadTitle, messageId: m.id, at: m.at, excerpt: excerptOf(m.text) } : null);
