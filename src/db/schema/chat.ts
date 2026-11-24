/** Chat threads, messages and tool calls (section 15; R-UI-10). */
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { tstz, createdAt, updatedAt, ownerUserId } from './columns';
import {
  chatScope,
  chatRole,
  toolCallStatus,
} from './enums';
import { accounts, opportunities } from './entities';
import { workItems } from './work';
import { jobs } from './jobs';
import { llmCalls } from './llm';
import { changeSets } from './audit';

export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    title: text('title'),
    scope: chatScope('scope').notNull().default('global'),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    /** Agent SDK session id, for resume. */
    sdkSessionId: text('sdk_session_id'),
    model: text('model'),
    lastMessageAt: tstz('last_message_at'),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chat_threads_owner_last_idx').on(t.ownerUserId, t.lastMessageAt.desc())],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: chatRole('role').notNull(),
    content: text('content'),
    /** SDK content blocks when richer than text. */
    contentBlocks: jsonb('content_blocks').$type<unknown[]>(),
    model: text('model'),
    llmCallId: bigint('llm_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('chat_messages_thread_seq_uidx').on(t.threadId, t.seq)],
);

export const chatToolCalls = pgTable(
  'chat_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    toolUseId: text('tool_use_id').notNull(),
    toolName: text('tool_name').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    /** Redacted and truncated. */
    output: jsonb('output').$type<unknown>(),
    isMutation: boolean('is_mutation').notNull().default(false),
    requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
    status: toolCallStatus('status').notNull().default('proposed'),
    changeSetId: uuid('change_set_id').references(() => changeSets.id, { onDelete: 'set null' }),
    jobId: bigint('job_id', { mode: 'number' }).references(() => jobs.id, { onDelete: 'set null' }),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    errorCode: text('error_code'),
  },
  (t) => [
    uniqueIndex('chat_tool_calls_message_tool_use_uidx').on(t.messageId, t.toolUseId),
    index('chat_tool_calls_change_set_idx').on(t.changeSetId),
  ],
);

/**
 * Assistant v2 (H-6, 0035): the Assistant's memory. A thread's notes (`remember`) and compaction summaries (older turns
 * summarized so a rebuilt session never re-sends the whole thread), and the user's preferences (thread_id null).
 * Pinned rows ride on every turn of their scope and are never compacted away. Text the user or the model wrote,
 * credential-redacted on write; never logged.
 */
export const chatMemory = pgTable(
  'chat_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    threadId: uuid('thread_id').references(() => chatThreads.id, { onDelete: 'cascade' }),
    /** note · preference · summary (check constraint). */
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    /** A summary's last covered message (thread position, 0-based). */
    coversThroughSeq: integer('covers_through_seq'),
    /**
     * SEC-8 (0038): your message the turn that kept a note or preference answered (chat_messages.id). No foreign key on
     * purpose: a deleted message leaves the id, so the source reads as gone (null) instead of falling back to a guess.
     * Null on rows written before 0038 and on summaries; those resolve by time (src/server/chat/memory-source.ts).
     */
    sourceMessageId: uuid('source_message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chat_memory_owner_thread_idx').on(t.ownerUserId, t.threadId), check('chat_memory_kind_chk', sql`${t.kind} IN ('note', 'preference', 'summary')`)],
);
