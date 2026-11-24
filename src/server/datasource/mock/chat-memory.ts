/** Assistant v2 memory and sessions in mock mode: the db's `chat_memory` / `sdk_session_id` in memory (parity). */
import type { ChatMemoryEntry } from '@/contract';
import { redactText } from '@/llm/redact';
import type { ChatMemoryStore } from '../db/chat-memory';

export class MockChatMemory implements ChatMemoryStore {
  private entries: ChatMemoryEntry[] = [];
  private sessions = new Map<string, string>();
  /** SEC-8: entry id → the user message it came from (the db's chat_memory.source_message_id). */
  private sources = new Map<string, string>();
  private seq = 0;
  constructor(private readonly now: () => Date) {}

  reset() {
    this.entries = [];
    this.sessions.clear();
    this.sources.clear();
  }
  /** SEC-8: the stored source message id (null: none recorded, as a row written before 0038). */
  sourceMessageIdOf(id: string): string | null {
    return this.sources.get(id) ?? null;
  }
  async list(threadId?: string | null) {
    return this.entries.filter((e) => e.threadId === null || (threadId != null && e.threadId === threadId));
  }
  async add(e: Parameters<ChatMemoryStore['add']>[0]) {
    const entry: ChatMemoryEntry = { id: `mem_${++this.seq}`, threadId: e.threadId, kind: e.kind, text: redactText(e.text), pinned: e.pinned ?? false, coversThroughSeq: e.coversThroughSeq ?? null, createdAt: this.now().toISOString() };
    this.entries.push(entry);
    if (e.sourceMessageId) this.sources.set(entry.id, e.sourceMessageId);
    return entry;
  }
  async remove(id: string) {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.sources.delete(id);
    return this.entries.length < n;
  }
  async sessionOf(threadId: string) {
    return this.sessions.get(threadId) ?? null;
  }
  async setSession(threadId: string, sessionId: string | null) {
    if (sessionId) this.sessions.set(threadId, sessionId);
    else this.sessions.delete(threadId);
  }
}
