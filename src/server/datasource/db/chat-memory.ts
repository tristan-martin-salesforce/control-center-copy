/**
 * Assistant v2 memory and sessions in db mode (H-6): `chat_memory` rows (notes, preferences, compaction summaries) and
 * the SDK session a thread resumes (`chat_threads.sdk_session_id`). Text is credential-redacted on write; logs carry
 * ids only. Not audited, like chat messages: the user forgets an entry from the panel (POST /chat/memory/:id/delete).
 */
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { ChatMemoryEntry, ChatMemoryKind } from '@/contract';
import type { Db } from '@/db/client';
import { chatMemory, chatThreads } from '@/db/schema';
import { redactText } from '@/llm/redact';

export interface ChatMemoryStore {
  /** The thread's entries plus the user's preferences (threadId null), oldest first; no thread: preferences only. */
  list(threadId?: string | null): Promise<ChatMemoryEntry[]>;
  /** `sourceMessageId` (SEC-8, 0038): the user message the turn that kept a note or preference answered. */
  add(e: { threadId: string | null; kind: ChatMemoryKind; text: string; pinned?: boolean; coversThroughSeq?: number | null; sourceMessageId?: string | null }): Promise<ChatMemoryEntry>;
  remove(id: string): Promise<boolean>;
  /** The SDK session the thread resumes (null: none yet, or it was dropped). */
  sessionOf(threadId: string): Promise<string | null>;
  setSession(threadId: string, sessionId: string | null): Promise<void>;
}

type Row = typeof chatMemory.$inferSelect;
const entryOf = (r: Row): ChatMemoryEntry => ({ id: r.id, threadId: r.threadId, kind: r.kind as ChatMemoryKind, text: r.text, pinned: r.pinned, coversThroughSeq: r.coversThroughSeq ?? null, createdAt: new Date(r.createdAt).toISOString() });
const isUuid = (s: string | null | undefined): s is string => !!s && /^[0-9a-f-]{36}$/i.test(s);

export function dbChatMemory(db: Db, userId: () => Promise<string>): ChatMemoryStore {
  return {
    async list(threadId) {
      const uid = await userId();
      const scope = isUuid(threadId) ? or(eq(chatMemory.threadId, threadId), isNull(chatMemory.threadId)) : isNull(chatMemory.threadId);
      const rows = await db.select().from(chatMemory).where(and(eq(chatMemory.ownerUserId, uid), scope)).orderBy(asc(chatMemory.createdAt));
      return rows.map(entryOf);
    },
    async add(e) {
      const uid = await userId();
      const [r] = await db
        .insert(chatMemory)
        .values({ ownerUserId: uid, threadId: isUuid(e.threadId) ? e.threadId : null, kind: e.kind, text: redactText(e.text), pinned: e.pinned ?? false, coversThroughSeq: e.coversThroughSeq ?? null, sourceMessageId: isUuid(e.sourceMessageId) ? e.sourceMessageId : null })
        .returning();
      return entryOf(r!);
    },
    async remove(id) {
      if (!isUuid(id)) return false;
      const uid = await userId();
      const r = await db.delete(chatMemory).where(and(eq(chatMemory.id, id), eq(chatMemory.ownerUserId, uid))).returning({ id: chatMemory.id });
      return r.length > 0;
    },
    async sessionOf(threadId) {
      if (!isUuid(threadId)) return null;
      const uid = await userId();
      const r = await db.select({ s: chatThreads.sdkSessionId }).from(chatThreads).where(and(eq(chatThreads.id, threadId), eq(chatThreads.ownerUserId, uid)));
      return r[0]?.s ?? null;
    },
    async setSession(threadId, sessionId) {
      if (!isUuid(threadId)) return;
      const uid = await userId();
      await db.execute(sql`update chat_threads set sdk_session_id = ${sessionId} where id = ${threadId}::uuid and owner_user_id = ${uid}::uuid`);
    },
  };
}
