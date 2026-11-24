/** Drafts = the Outbox: recipients, renditions, send attempts, verifications (section 10). */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
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

import { tstz, createdAt, updatedAt, ownerUserId, textArray } from './columns';
import {
  actorKind,
  draftActionType,
  outboundChannel,
  deliveryMode,
  autonomyLevel,
  draftStatus,
  approvalMethod,
  recipientRole,
  renditionFormat,
  sendAttemptStatus,
  verificationMethod,
  verificationStatus,
} from './enums';
import { users } from './core';
import { autonomyPolicies, voiceProfiles } from './settings';
import { sourceItems } from './sources';
import { people } from './entities';
import { workItems } from './work';
import { nextBestActions } from './nba';
import { jobs } from './jobs';
import { llmCalls } from './llm';

export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'set null' }),
    nbaId: uuid('nba_id').references((): AnyPgColumn => nextBestActions.id, { onDelete: 'set null' }),
    actionType: draftActionType('action_type').notNull(),
    channel: outboundChannel('channel').notNull(),
    deliveryMode: deliveryMode('delivery_mode').notNull().default('stage'),
    /** Effective autonomy level when created (from autonomy_policies). */
    autonomyLevel: autonomyLevel('autonomy_level').notNull().default('L1_draft'),
    status: draftStatus('status').notNull().default('drafting'),
    title: text('title'),
    /** Canonical rich document (TipTap/ProseMirror JSON) for message-like drafts. */
    docJson: jsonb('doc_json').$type<Record<string, unknown>>(),
    docVersion: integer('doc_version').notNull().default(1),
    plainText: text('plain_text'),
    /** Structured dry-run payload for non-message actions (VDP patch, Org62 rows, calendar hold). */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /** Hash over doc/payload + renditions + target + recipients. */
    contentHash: text('content_hash').notNull(),
    // Destination
    targetExternalId: text('target_external_id'),
    targetThreadExternalId: text('target_thread_external_id'),
    inReplyToSourceItemId: uuid('in_reply_to_source_item_id').references(() => sourceItems.id, {
      onDelete: 'set null',
    }),
    subject: text('subject'),
    scheduledFor: tstz('scheduled_for'),
    // Approval gate
    approvedAt: tstz('approved_at'),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    approvalMethod: approvalMethod('approval_method'),
    approvedContentHash: text('approved_content_hash'),
    autonomyPolicyId: uuid('autonomy_policy_id').references(() => autonomyPolicies.id, { onDelete: 'set null' }),
    rejectedAt: tstz('rejected_at'),
    rejectReason: text('reject_reason'),
    // Outcome
    sentExternalId: text('sent_external_id'),
    sentAt: tstz('sent_at'),
    stagedAt: tstz('staged_at'),
    handedOffAt: tstz('handed_off_at'),
    handoffUrl: text('handoff_url'),
    /** Where the applied or sent result lives: the canvas, the message permalink, the VDP record (contract `Draft.resultUrl`). */
    resultUrl: text('result_url'),
    verifiedAt: tstz('verified_at'),
    /** Passed to the adapter (client_msg_id etc.) so a retry can never double-send. */
    idempotencyKey: text('idempotency_key').notNull(),
    createdBy: actorKind('created_by').notNull(),
    model: text('model'),
    llmCallId: bigint('llm_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, {
      onDelete: 'set null',
    }),
    voiceProfileId: uuid('voice_profile_id').references(() => voiceProfiles.id, { onDelete: 'set null' }),
    editedByUser: boolean('edited_by_user').notNull().default(false),
    userLockedFields: textArray('user_locked_fields'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('drafts_idempotency_key_uidx').on(t.idempotencyKey),
    index('drafts_owner_status_idx').on(t.ownerUserId, t.status),
    index('drafts_work_item_idx').on(t.workItemId),
    index('drafts_nba_idx').on(t.nbaId),
    index('drafts_scheduled_idx').on(t.scheduledFor).where(sql`${t.status} = 'scheduled'`),
    index('drafts_awaiting_verify_idx')
      .on(t.ownerUserId, t.updatedAt)
      .where(sql`${t.status} IN ('sent', 'staged', 'handed_off', 'unconfirmed')`),
    // 0037 (post-2.0 Home SQL): the logging canvases (Home's, Today's and Log it's DC and use-case holds) without
    // reading every draft's payload
    index('drafts_owner_canvas_idx').on(t.ownerUserId).where(sql`${t.payload} ->> 'action' = 'slack_canvas.create'`),
    check('drafts_content_chk', sql`num_nonnulls(${t.docJson}, ${t.payload}) >= 1`),
    check(
      'drafts_approval_chk',
      sql`${t.status} NOT IN ('approved', 'scheduled', 'sending', 'unconfirmed', 'sent', 'staged', 'handed_off', 'verified', 'verify_failed') OR (${t.approvedAt} IS NOT NULL AND ${t.approvalMethod} IS NOT NULL AND ${t.approvedContentHash} = ${t.contentHash})`,
    ),
    check('drafts_scheduled_chk', sql`${t.status} <> 'scheduled' OR ${t.scheduledFor} IS NOT NULL`),
    check(
      'drafts_autonomy_chk',
      sql`${t.approvalMethod} IS DISTINCT FROM 'autonomy_policy' OR ${t.autonomyPolicyId} IS NOT NULL`,
    ),
  ],
);

export const draftRecipients = pgTable(
  'draft_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    role: recipientRole('role').notNull(),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    /** Email address, Slack user id, or channel id. */
    address: text('address').notNull(),
    displayName: text('display_name'),
  },
  (t) => [uniqueIndex('draft_recipients_draft_role_address_uidx').on(t.draftId, t.role, t.address)],
);

/** Rendered body per destination format, per doc version (never hand-edited). */
export const draftRenditions = pgTable(
  'draft_renditions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    docVersion: integer('doc_version').notNull(),
    format: renditionFormat('format').notNull(),
    body: text('body').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    contentHash: text('content_hash').notNull(),
    /** True if the conversion dropped something (e.g. a table in Slack mrkdwn). */
    lossy: boolean('lossy').notNull().default(false),
    warnings: textArray('warnings'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('draft_renditions_draft_version_format_uidx').on(t.draftId, t.docVersion, t.format)],
);

export const draftSendAttempts = pgTable(
  'draft_send_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    /** Builders/validators always run dry (invariant 1). */
    dryRun: boolean('dry_run').notNull(),
    renditionId: uuid('rendition_id').references(() => draftRenditions.id, { onDelete: 'set null' }),
    adapter: text('adapter').notNull(),
    jobId: bigint('job_id', { mode: 'number' }).references((): AnyPgColumn => jobs.id, { onDelete: 'set null' }),
    requestHash: text('request_hash').notNull(),
    status: sendAttemptStatus('status').notNull().default('started'),
    externalId: text('external_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [uniqueIndex('draft_send_attempts_draft_attempt_uidx').on(t.draftId, t.attemptNo)],
);

/** Read-back verification: did the thing actually land where we think it did? */
export const draftVerifications = pgTable(
  'draft_verifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    sendAttemptId: bigint('send_attempt_id', { mode: 'number' }).references(() => draftSendAttempts.id, {
      onDelete: 'set null',
    }),
    method: verificationMethod('method').notNull(),
    status: verificationStatus('status').notNull().default('pending'),
    matchedExternalId: text('matched_external_id'),
    matchedSourceItemId: uuid('matched_source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    diffSummary: text('diff_summary'),
    checkedAt: tstz('checked_at'),
    nextCheckAt: tstz('next_check_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('draft_verifications_draft_idx').on(t.draftId, t.createdAt.desc()),
    index('draft_verifications_due_idx').on(t.nextCheckAt).where(sql`${t.status} = 'pending'`),
  ],
);

export type Draft = typeof drafts.$inferSelect;
