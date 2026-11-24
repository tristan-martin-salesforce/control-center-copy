/** Time blocks, activity entries, canvas sync and DC requests (section 12; R-UI-6). */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tstz, createdAt, updatedAt, ownerUserId, confidence, textArray, id15 } from './columns';
import {
  linkMethod,
  runStatus,
  approvalMethod,
  timeBlockSource,
  attentionKind,
  activityOrigin,
  org62Operation,
  whatKind,
  activityStatus,
  excludedReason,
  canvasPurpose,
  canvasSyncStatus,
  canvasSection,
  dcRequestStatus,
} from './enums';
import { seTaskTypes, org62PicklistValues, fiscalPeriods } from './core';
import { sourceItems } from './sources';
import { accounts, opportunities, repos, assets } from './entities';
import { calendarEvents } from './calendar';
import { drafts } from './drafts';
import { claudeSessionSegments } from './sessions';
import { org62Events, dealContributions, missedOppFindings } from './deals';
import { changeSets } from './audit';

export const timeBlocks = pgTable(
  'time_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    source: timeBlockSource('source').notNull(),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    localDay: date('local_day', { mode: 'string' }).notNull(),
    attention: attentionKind('attention').notNull(),
    /** Tenet: Hours are human hours. Agent/background time is never true. */
    countsAsHumanHours: boolean('counts_as_human_hours').notNull(),
    /** meeting 30 > focused 20 > slack burst 10 (D-18). */
    precedence: smallint('precedence').notNull(),
    /** Lower-precedence overlap: shown, never counted. */
    isOverlay: boolean('is_overlay').notNull().default(false),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    calendarEventId: uuid('calendar_event_id').references(() => calendarEvents.id, { onDelete: 'set null' }),
    claudeSessionSegmentId: uuid('claude_session_segment_id'),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    mappingMethod: linkMethod('mapping_method'),
    mappingConfidence: confidence('mapping_confidence'),
    /** e.g. cal|<calendarId>|<eventId>|<start>, claude|<session>|<segment>. */
    dedupeKey: text('dedupe_key').notNull(),
    engineVersion: text('engine_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'time_blocks_claude_session_segment_id_fk',
      columns: [t.claudeSessionSegmentId],
      foreignColumns: [claudeSessionSegments.id],
    }).onDelete('set null'),
    uniqueIndex('time_blocks_owner_dedupe_uidx').on(t.ownerUserId, t.dedupeKey),
    index('time_blocks_owner_starts_idx').on(t.ownerUserId, t.startsAt),
    index('time_blocks_owner_day_idx').on(t.ownerUserId, t.localDay),
    check('time_blocks_range_chk', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'time_blocks_human_hours_chk',
      sql`NOT ${t.countsAsHumanHours} OR (${t.source} <> 'claude_background' AND ${t.attention} <> 'background' AND NOT ${t.isOverlay})`,
    ),
  ],
);

export const activityEntries = pgTable(
  'activity_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** Natural key (e.g. cal|<calendarId>|<start_utc>, build|<repo>|<day>). */
    dedupeKey: text('dedupe_key').notNull(),
    origin: activityOrigin('origin').notNull(),
    operation: org62Operation('operation').notNull().default('create'),
    /** For update/delete/legacy re-create. */
    targetOrg62EventId: text('target_org62_event_id'),
    subject: text('subject').notNull(),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    /** Duration__c: rounded to 0.25 h (D-40). */
    durationHours: numeric('duration_hours', { precision: 4, scale: 2, mode: 'number' }).notNull(),
    seTaskTypeId: uuid('se_task_type_id').references(() => seTaskTypes.id, { onDelete: 'restrict' }),
    meetingTypeId: uuid('meeting_type_id').references(() => org62PicklistValues.id, { onDelete: 'restrict' }),
    whatKind: whatKind('what_kind').notNull().default('none'),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** The WhatId actually used (frozen at approval). */
    whatOrg62Id: text('what_org62_id'),
    whatName: text('what_name'),
    customerFacing: boolean('customer_facing').notNull().default(false),
    customerRelated: boolean('customer_related').notNull().default(false),
    remote: boolean('remote').notNull().default(true),
    description: text('description'),
    confidence: confidence(),
    reason: text('reason'),
    flags: textArray('flags'),
    status: activityStatus('status').notNull().default('proposed'),
    excludedReason: excludedReason('excluded_reason'),
    approvedAt: tstz('approved_at'),
    approvalMethod: approvalMethod('approval_method'),
    syncedToCanvasAt: tstz('synced_to_canvas_at'),
    org62EventRowId: uuid('org62_event_row_id').references(() => org62Events.id, { onDelete: 'set null' }),
    loggedAt: tstz('logged_at'),
    verifiedAt: tstz('verified_at'),
    verifyIssue: text('verify_issue'),
    fiscalPeriodId: uuid('fiscal_period_id').references(() => fiscalPeriods.id, { onDelete: 'set null' }),
    /** Fields the user edited; engines propose instead of overwriting (R-UI-20). */
    userLockedFields: textArray('user_locked_fields'),
    version: integer('version').notNull().default(1),
    /** 0036 (D-98, D-66): the Org62 Description's note and how the app drafted it (were `cc.ext/activity_entries/<id>`). */
    logNote: text('log_note'),
    logNoteBasis: text('log_note_basis'),
    targetOrg62EventId15: id15('target_org62_event_id15', 'target_org62_event_id'),
    whatOrg62Id15: id15('what_org62_id15', 'what_org62_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('activity_entries_owner_what_id15_idx').on(t.ownerUserId, t.whatOrg62Id15),
    uniqueIndex('activity_entries_owner_dedupe_uidx').on(t.ownerUserId, t.dedupeKey),
    index('activity_entries_owner_status_idx').on(t.ownerUserId, t.status, t.startsAt),
    index('activity_entries_owner_period_idx').on(t.ownerUserId, t.fiscalPeriodId, t.status),
    index('activity_entries_opportunity_idx').on(t.opportunityId),
    check('activity_entries_range_chk', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'activity_entries_duration_chk',
      sql`${t.durationHours} > 0 AND ${t.durationHours} <= 99.99 AND ${t.durationHours} * 4 = trunc(${t.durationHours} * 4)`,
    ),
    check(
      'activity_entries_operation_chk',
      sql`${t.operation} = 'create' OR ${t.targetOrg62EventId} IS NOT NULL`,
    ),
    check(
      'activity_entries_approval_chk',
      sql`${t.status} NOT IN ('approved', 'synced_to_canvas') OR ${t.approvedAt} IS NOT NULL`,
    ),
    check('activity_entries_excluded_chk', sql`(${t.status} = 'excluded') = (${t.excludedReason} IS NOT NULL)`),
    check(
      'activity_entries_ready_chk',
      sql`${t.status} NOT IN ('approved', 'synced_to_canvas') OR ${t.operation} <> 'create' OR ${t.seTaskTypeId} IS NOT NULL`,
    ),
  ],
);

/** Allocation of human time blocks to a log entry (no double counting; see exclusion SQL). */
export const activityEntryTimeBlocks = pgTable(
  'activity_entry_time_blocks',
  {
    activityEntryId: uuid('activity_entry_id').notNull(),
    timeBlockId: uuid('time_block_id')
      .notNull()
      .references(() => timeBlocks.id, { onDelete: 'cascade' }),
    allocatedMinutes: integer('allocated_minutes').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'activity_entry_time_blocks_activity_entry_id_fk',
      columns: [t.activityEntryId],
      foreignColumns: [activityEntries.id],
    }).onDelete('cascade'),
    primaryKey({ columns: [t.activityEntryId, t.timeBlockId] }),
    index('activity_entry_time_blocks_block_idx').on(t.timeBlockId),
    check('activity_entry_time_blocks_minutes_chk', sql`${t.allocatedMinutes} > 0`),
  ],
);

/** The two approved private canvases (the team's review canvas and the Slackbot work-order canvas). */
export const canvases = pgTable(
  'canvases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    externalId: text('external_id').notNull(),
    purpose: canvasPurpose('purpose').notNull(),
    title: text('title'),
    url: text('url'),
    /** The explicit user approval that makes rewrites allowed (memory/config note). */
    writeApprovedAt: tstz('write_approved_at'),
    writeApprovalNote: text('write_approval_note'),
    syncStatus: canvasSyncStatus('sync_status').notNull().default('dirty'),
    lastRenderedHash: text('last_rendered_hash'),
    lastWrittenAt: tstz('last_written_at'),
    lastReadAt: tstz('last_read_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('canvases_owner_external_uidx').on(t.ownerUserId, t.externalId)],
);

export const canvasSyncRuns = pgTable(
  'canvas_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canvasId: uuid('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    /** The canvas_rewrite draft that carried the write through the Outbox. */
    draftId: uuid('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
    status: runStatus('status').notNull().default('queued'),
    /** Canvas snapshot read before rewriting (ticks and `=>` marks). */
    marksSourceItemId: uuid('marks_source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    marksApplied: integer('marks_applied').notNull().default(0),
    renderedHash: text('rendered_hash'),
    skippedUnchanged: boolean('skipped_unchanged').notNull().default(false),
    lineCount: integer('line_count').notNull().default(0),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    errorCode: text('error_code'),
  },
  (t) => [index('canvas_sync_runs_canvas_started_idx').on(t.canvasId, t.startedAt.desc())],
);

/** Planned DC adds/updates handed to Slackbot via the work-order canvas. */
export const dealContributionRequests = pgTable(
  'deal_contribution_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    /** `add` (create a DC) or `change` (the split of the DC I hold: an UPDATE row on `deal_contribution_id`). */
    kind: text('kind').notNull().default('add'),
    role: text('role').notNull(),
    splitPercent: numeric('split_percent', { precision: 5, scale: 2, mode: 'number' }).notNull(),
    /** A change: my DC's split when it was requested. */
    fromSplit: numeric('from_split', { precision: 5, scale: 2, mode: 'number' }),
    comment: text('comment'),
    vdpUrl: text('vdp_url'),
    status: dcRequestStatus('status').notNull().default('proposed'),
    approvedAt: tstz('approved_at'),
    approvalMethod: approvalMethod('approval_method'),
    /** A change: the DC it changes. Confirmed (`verified`): the DC the Org62 scan read. */
    dealContributionId: uuid('deal_contribution_id'),
    missedOppFindingId: uuid('missed_opp_finding_id'),
    /**
     * D-68: why the app closed the request by itself (status `dismissed`): `not_created` (handed off, and a complete
     * Org62 read since shows no such DC), `changed_in_org62`, `dc_removed`, `opp_deleted`. Null: it didn't.
     */
    outcome: text('outcome'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'deal_contribution_requests_missed_opp_finding_id_fk',
      columns: [t.missedOppFindingId],
      foreignColumns: [missedOppFindings.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'deal_contribution_requests_deal_contribution_id_fk',
      columns: [t.dealContributionId],
      foreignColumns: [dealContributions.id],
    }).onDelete('set null'),
    // a withdrawn or confirmed request leaves room for the next (one in flight per opp is the shared rule's, in code;
    // the role stays in the key so rows from before that rule never block the migration)
    uniqueIndex('deal_contribution_requests_live_uidx')
      .on(t.ownerUserId, t.opportunityId, t.role)
      .where(sql`${t.status} not in ('dismissed', 'verified')`),
    check('deal_contribution_requests_split_chk', sql`${t.splitPercent} > 0 AND ${t.splitPercent} <= 100`),
    check('deal_contribution_requests_kind_chk', sql`${t.kind} in ('add', 'change')`),
    check('deal_contribution_requests_outcome_chk', sql`${t.outcome} is null or ${t.outcome} in ('not_created', 'changed_in_org62', 'dc_removed', 'opp_deleted')`),
  ],
);

/** Exactly what was rendered on each canvas version, and what marks came back. */
export const canvasLines = pgTable(
  'canvas_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    syncRunId: uuid('sync_run_id')
      .notNull()
      .references(() => canvasSyncRuns.id, { onDelete: 'cascade' }),
    lineKey: text('line_key').notNull(),
    section: canvasSection('section').notNull(),
    activityEntryId: uuid('activity_entry_id').references(() => activityEntries.id, { onDelete: 'set null' }),
    dcRequestId: uuid('dc_request_id').references(() => dealContributionRequests.id, { onDelete: 'set null' }),
    rendered: text('rendered').notNull(),
    checkedOnRead: boolean('checked_on_read'),
    /** `=> skip`, `=> 1.5h`, `=> 006…` read back from the canvas. */
    markText: text('mark_text'),
    markAppliedAt: tstz('mark_applied_at'),
    /** The user_edit change set the mark became (edit history + undo live in audit_events). */
    changeSetId: uuid('change_set_id').references(() => changeSets.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('canvas_lines_run_key_uidx').on(t.syncRunId, t.lineKey),
    index('canvas_lines_activity_idx').on(t.activityEntryId),
    index('canvas_lines_dc_request_idx').on(t.dcRequestId),
  ],
);

export type ActivityEntry = typeof activityEntries.$inferSelect;
export type TimeBlock = typeof timeBlocks.$inferSelect;
