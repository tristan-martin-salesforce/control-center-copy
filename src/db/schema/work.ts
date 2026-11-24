/** Work items, transitions, evidence, links, initiatives, change proposals, reopen decisions (section 7; R-UI-20). */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tsvector, tstz, createdAt, updatedAt, ownerUserId, confidence, textArray } from './columns';
import {
  actorKind,
  userVerdict,
  linkMethod,
  workItemKind,
  workItemOrigin,
  workItemStatus,
  workItemResolution,
  workItemInvolvement,
  dueKind,
  effortSource,
  importanceLevel,
  closureKind,
  evidenceRole,
  workItemLinkRole,
  workItemRelationKind,
  trainingProvider,
  travelStepStatus,
  initiativeStatus,
  initiativeLinkRole,
  proposalStatus,
  reopenOutcome,
  priorityLane,
} from './enums';
import { sourceItems, extractors } from './sources';
import { accounts, opportunities, people, channels, repos, assets } from './entities';
import { assetSnapshots, assetSnapshotDiffs, deliverableJudgments } from './drive';
import { calendarEvents } from './calendar';
import { priorityScores } from './priority';
import { nextBestActions } from './nba';
import { claudeSessions } from './sessions';
import { llmCalls } from './llm';
import { changeSets } from './audit';
import { toolRuns } from './tools';

export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    kind: workItemKind('kind').notNull(),
    origin: workItemOrigin('origin').notNull(),
    status: workItemStatus('status').notNull().default('suggested'),
    statusChangedAt: tstz('status_changed_at').notNull().defaultNow(),
    statusReason: text('status_reason'),
    title: text('title').notNull(),
    /** "For: ACME Headless Phase 2 demo on 11/12": what this task is for (R-UI-20). */
    purpose: text('purpose'),
    description: text('description'),
    initiativeId: uuid('initiative_id').references((): AnyPgColumn => initiatives.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    /** Who asked me / whom I promised / whom I'm waiting on. */
    counterpartyPersonId: uuid('counterparty_person_id').references(() => people.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => workItems.id, { onDelete: 'set null' }),
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => workItems.id, { onDelete: 'set null' }),
    dueAt: tstz('due_at'),
    dueKind: dueKind('due_kind'),
    /** The meeting this work must be ready for (calendar-aware deadline, R-UI-4). */
    deadlineEventId: uuid('deadline_event_id').references(() => calendarEvents.id, { onDelete: 'set null' }),
    /** My hands-on minutes. */
    effortMinutes: integer('effort_minutes'),
    /** Wall-clock minutes incl. background/agent time (the "long build"). */
    leadTimeMinutes: integer('lead_time_minutes'),
    effortSource: effortSource('effort_source').notNull().default('default'),
    /** Can run as a Claude session / tool in the background. */
    backgroundable: boolean('backgroundable').notNull().default(false),
    importance: importanceLevel('importance').notNull().default('normal'),
    confidence: confidence(),
    closureKind: closureKind('closure_kind').notNull().default('manual_only'),
    /** e.g. thread key, email thread id, Org62 subject+start, tool capability. */
    closureTarget: text('closure_target'),
    closureParams: jsonb('closure_params').$type<Record<string, unknown>>(),
    autoCloseAllowed: boolean('auto_close_allowed').notNull().default(false),
    snoozedUntil: tstz('snoozed_until'),
    snoozedFromStatus: workItemStatus('snoozed_from_status'),
    waitingReason: text('waiting_reason'),
    waitingSince: tstz('waiting_since'),
    likelyDoneAt: tstz('likely_done_at'),
    likelyDoneConfidence: confidence('likely_done_confidence'),
    doneAt: tstz('done_at'),
    doneBy: actorKind('done_by'),
    reopenedCount: integer('reopened_count').notNull().default(0),
    lastReopenedAt: tstz('last_reopened_at'),
    // R-UI-22 (BE-0 addition, migration 0003): how it ended, who owns it, and my involvement.
    // A loop-back ("done (handed_off) -> open on a direct ask of me") is a reopen_decisions row
    // with rule_key 'looped_back_in' (+ trigger_person_id); see docs/reference/DB-NOTES.md.
    /** Set only while terminal (done / dismissed / merged); cleared on reopen. */
    resolution: workItemResolution('resolution'),
    /** handed_off: the teammate (required); done_by_other: who did it (when known). */
    resolutionPersonId: uuid('resolution_person_id').references(() => people.id, { onDelete: 'set null' }),
    /** duplicate / superseded: the surviving or replacing item (required). */
    resolutionWorkItemId: uuid('resolution_work_item_id').references((): AnyPgColumn => workItems.id, {
      onDelete: 'set null',
    }),
    resolutionNote: text('resolution_note'),
    /** true when an engine inferred the resolution; cite it in resolution_evidence_id. */
    resolutionInferred: boolean('resolution_inferred').notNull().default(false),
    resolutionEvidenceId: uuid('resolution_evidence_id').references((): AnyPgColumn => workItemEvidence.id, {
      onDelete: 'set null',
    }),
    /** Who owns the work now. Null = me. A hand-off sets the teammate here. */
    ownerPersonId: uuid('owner_person_id').references(() => people.id, { onDelete: 'set null' }),
    /** My involvement. A hand-off sets watcher or not_involved. */
    involvement: workItemInvolvement('involvement').notNull().default('owner'),
    // New-info markers (R-UI-20): "new" badge = last_new_info_at > seen_by_user_at.
    seenByUserAt: tstz('seen_by_user_at'),
    lastNewInfoAt: tstz('last_new_info_at'),
    unseenEvidenceCount: integer('unseen_evidence_count').notNull().default(0),
    /** Bumped in the same txn that saves new info; re-eval jobs fence their writes on it. */
    reevalGeneration: bigint('reeval_generation', { mode: 'number' }).notNull().default(0),
    // Cache of the current priority_scores row (row is the source of truth).
    priorityScore: numeric('priority_score', { precision: 8, scale: 3, mode: 'number' }),
    priorityLane: priorityLane('priority_lane'),
    priorityRank: integer('priority_rank'),
    priorityScoreId: bigint('priority_score_id', { mode: 'number' }).references(
      (): AnyPgColumn => priorityScores.id,
      { onDelete: 'set null' },
    ),
    priorityComputedAt: tstz('priority_computed_at'),
    /** Pointer to the live NBA version. */
    currentNbaId: uuid('current_nba_id').references((): AnyPgColumn => nextBestActions.id, {
      onDelete: 'set null',
    }),
    createdByExtractorId: uuid('created_by_extractor_id').references(() => extractors.id, {
      onDelete: 'set null',
    }),
    /** Columns the user edited; engines never overwrite them (tenet: Suggest, then learn). */
    userLockedFields: textArray('user_locked_fields'),
    /** Optimistic concurrency: UPDATE ... WHERE version = $v. */
    version: integer('version').notNull().default(1),
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))`,
    ),
    /** 0036 (D-98): your start-by override (`{value}`) and the dismissal (reason, note), were `cc.ext/work_items/<id>`. */
    startByUser: jsonb('start_by_user').$type<{ value: string | null }>(),
    dismissed: jsonb('dismissed').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('work_items_owner_status_idx').on(t.ownerUserId, t.status),
    index('work_items_home_lane_rank_idx')
      .on(t.ownerUserId, t.priorityLane, t.priorityRank)
      .where(sql`${t.status} IN ('open', 'in_progress', 'waiting_on_me', 'likely_done')`),
    index('work_items_triage_idx').on(t.ownerUserId, t.createdAt).where(sql`${t.status} = 'suggested'`),
    index('work_items_snooze_wake_idx').on(t.snoozedUntil).where(sql`${t.status} = 'snoozed'`),
    index('work_items_open_due_idx')
      .on(t.ownerUserId, t.dueAt)
      .where(sql`${t.status} NOT IN ('done', 'dismissed', 'merged')`),
    index('work_items_deadline_event_idx').on(t.deadlineEventId).where(sql`${t.deadlineEventId} IS NOT NULL`),
    index('work_items_opportunity_idx').on(t.opportunityId),
    index('work_items_account_idx').on(t.accountId),
    index('work_items_counterparty_idx').on(t.counterpartyPersonId),
    index('work_items_parent_idx').on(t.parentId),
    index('work_items_initiative_idx').on(t.initiativeId, t.status),
    index('work_items_new_info_idx')
      .on(t.ownerUserId, t.lastNewInfoAt.desc())
      .where(sql`${t.lastNewInfoAt} IS NOT NULL AND (${t.seenByUserAt} IS NULL OR ${t.lastNewInfoAt} > ${t.seenByUserAt})`),
    index('work_items_title_trgm_idx').using('gin', sql`lower(title) gin_trgm_ops`),
    index('work_items_search_tsv_idx').using('gin', t.searchTsv),
    check(
      'work_items_snooze_chk',
      sql`${t.status} <> 'snoozed' OR (${t.snoozedUntil} IS NOT NULL AND ${t.snoozedFromStatus} IS NOT NULL AND ${t.snoozedFromStatus} NOT IN ('snoozed', 'done', 'dismissed', 'merged'))`,
    ),
    check('work_items_done_chk', sql`(${t.status} = 'done') = (${t.doneAt} IS NOT NULL AND ${t.doneBy} IS NOT NULL)`),
    check('work_items_merged_chk', sql`(${t.status} = 'merged') = (${t.mergedIntoId} IS NOT NULL)`),
    check('work_items_waiting_on_me_chk', sql`${t.status} <> 'waiting_on_me' OR ${t.waitingReason} IS NOT NULL`),
    check(
      'work_items_no_self_ref_chk',
      sql`${t.parentId} IS DISTINCT FROM ${t.id} AND ${t.mergedIntoId} IS DISTINCT FROM ${t.id}`,
    ),
    // R-UI-22 guards. The "detail required" rules (handed_off needs a person, duplicate/superseded
    // need an item) stay in the domain layer: as CHECKs they would make the FKs' ON DELETE SET NULL
    // fail (person merge, undo of the surviving item).
    check(
      'work_items_resolution_chk',
      sql`(${t.resolution} IS NULL OR ${t.status} IN ('done', 'dismissed', 'merged')) AND ${t.resolutionWorkItemId} IS DISTINCT FROM ${t.id}`,
    ),
    check(
      'work_items_handoff_chk',
      sql`${t.resolution} IS DISTINCT FROM 'handed_off' OR ${t.involvement} IN ('watcher', 'not_involved')`,
    ),
    index('work_items_owner_person_idx').on(t.ownerPersonId).where(sql`${t.ownerPersonId} IS NOT NULL`),
    check(
      'work_items_effort_chk',
      sql`(${t.effortMinutes} IS NULL OR ${t.effortMinutes} >= 0) AND (${t.leadTimeMinutes} IS NULL OR ${t.effortMinutes} IS NULL OR ${t.leadTimeMinutes} >= ${t.effortMinutes})`,
    ),
  ],
);

/** Typed state-machine log; drives undo, "closed for you", and the commitments ledger. */
export const workItemTransitions = pgTable(
  'work_item_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    fromStatus: workItemStatus('from_status'),
    toStatus: workItemStatus('to_status').notNull(),
    actorKind: actorKind('actor_kind').notNull(),
    actorRef: text('actor_ref'),
    reason: text('reason'),
    evidenceId: uuid('evidence_id').references((): AnyPgColumn => workItemEvidence.id, { onDelete: 'set null' }),
    changeSetId: uuid('change_set_id').references((): AnyPgColumn => changeSets.id, { onDelete: 'set null' }),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    undoneAt: tstz('undone_at'),
    undoneByChangeSetId: uuid('undone_by_change_set_id').references((): AnyPgColumn => changeSets.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('work_item_transitions_item_occurred_idx').on(t.workItemId, t.occurredAt.desc()),
    index('work_item_transitions_auto_done_idx')
      .on(t.occurredAt.desc())
      .where(sql`${t.toStatus} = 'done' AND ${t.actorKind} = 'engine'`),
  ],
);

/**
 * Evidence: work_item <-> (source_item | Drive snapshot | Drive diff), many-to-many,
 * with role + confidence + extractor. Exclusive arc: exactly one evidence target.
 */
export const workItemEvidence = pgTable(
  'work_item_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'cascade' }),
    assetSnapshotId: uuid('asset_snapshot_id').references(() => assetSnapshots.id, { onDelete: 'cascade' }),
    assetDiffId: uuid('asset_diff_id').references(() => assetSnapshotDiffs.id, { onDelete: 'cascade' }),
    /** The judge run that produced this evidence, when it came from a deliverable judgment. */
    deliverableJudgmentId: uuid('deliverable_judgment_id'),
    role: evidenceRole('role').notNull(),
    confidence: confidence().notNull(),
    extractorId: uuid('extractor_id')
      .notNull()
      .references(() => extractors.id, { onDelete: 'restrict' }),
    llmCallId: bigint('llm_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, {
      onDelete: 'set null',
    }),
    /** Engine-written "why" (e.g. "likely done because you posted the deck link at 14:02"). */
    rationale: text('rationale'),
    userVerdict: userVerdict('user_verdict'),
    createdBy: actorKind('created_by').notNull().default('engine'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'work_item_evidence_deliverable_judgment_id_fk',
      columns: [t.deliverableJudgmentId],
      foreignColumns: [deliverableJudgments.id],
    }).onDelete('set null'),
    check(
      'work_item_evidence_one_target_chk',
      sql`num_nonnulls(${t.sourceItemId}, ${t.assetSnapshotId}, ${t.assetDiffId}) = 1`,
    ),
    unique('work_item_evidence_target_uq')
      .on(t.workItemId, t.role, t.sourceItemId, t.assetSnapshotId, t.assetDiffId)
      .nullsNotDistinct(),
    index('work_item_evidence_source_item_idx').on(t.sourceItemId).where(sql`${t.sourceItemId} IS NOT NULL`),
    index('work_item_evidence_snapshot_idx').on(t.assetSnapshotId).where(sql`${t.assetSnapshotId} IS NOT NULL`),
    index('work_item_evidence_diff_idx').on(t.assetDiffId).where(sql`${t.assetDiffId} IS NOT NULL`),
    index('work_item_evidence_item_role_idx').on(t.workItemId, t.role),
    check('work_item_evidence_confidence_chk', sql`${t.confidence} BETWEEN 0 AND 1`),
  ],
);

/** Work item -> non-source entities (exclusive arc). Account/opp live on work_items itself. */
export const workItemLinks = pgTable(
  'work_item_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
    claudeSessionId: uuid('claude_session_id').references((): AnyPgColumn => claudeSessions.id, {
      onDelete: 'cascade',
    }),
    calendarEventId: uuid('calendar_event_id').references(() => calendarEvents.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    toolRunId: uuid('tool_run_id').references((): AnyPgColumn => toolRuns.id, { onDelete: 'cascade' }),
    role: workItemLinkRole('role').notNull(),
    confidence: confidence().notNull(),
    extractorId: uuid('extractor_id')
      .notNull()
      .references(() => extractors.id, { onDelete: 'restrict' }),
    userVerdict: userVerdict('user_verdict'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'work_item_links_one_target_chk',
      sql`num_nonnulls(${t.personId}, ${t.assetId}, ${t.claudeSessionId}, ${t.calendarEventId}, ${t.repoId}, ${t.toolRunId}) = 1`,
    ),
    unique('work_item_links_target_uq')
      .on(t.workItemId, t.role, t.personId, t.assetId, t.claudeSessionId, t.calendarEventId, t.repoId, t.toolRunId)
      .nullsNotDistinct(),
    index('work_item_links_claude_session_idx').on(t.claudeSessionId).where(sql`${t.claudeSessionId} IS NOT NULL`),
    index('work_item_links_asset_idx').on(t.assetId).where(sql`${t.assetId} IS NOT NULL`),
    index('work_item_links_event_idx').on(t.calendarEventId).where(sql`${t.calendarEventId} IS NOT NULL`),
    index('work_item_links_tool_run_idx').on(t.toolRunId).where(sql`${t.toolRunId} IS NOT NULL`),
    index('work_item_links_person_idx').on(t.personId).where(sql`${t.personId} IS NOT NULL`),
  ],
);

export const workItemRelations = pgTable(
  'work_item_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromWorkItemId: uuid('from_work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    toWorkItemId: uuid('to_work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    kind: workItemRelationKind('kind').notNull(),
    createdBy: actorKind('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('work_item_relations_from_to_kind_uidx').on(t.fromWorkItemId, t.toWorkItemId, t.kind),
    index('work_item_relations_to_idx').on(t.toWorkItemId),
    check('work_item_relations_no_self_chk', sql`${t.fromWorkItemId} <> ${t.toWorkItemId}`),
  ],
);

/** Initiative / workstream above work items ("ACME Headless Phase 2 demo"). */
export const initiatives = pgTable(
  'initiatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    title: text('title').notNull(),
    /** Why it exists / what "done" means. User-editable. */
    purpose: text('purpose').notNull(),
    /** Regenerated background brief (Haiku/Sonnet) from linked items. */
    backgroundSummary: text('background_summary'),
    summaryGeneratedAt: tstz('summary_generated_at'),
    summaryInputsHash: text('summary_inputs_hash'),
    summaryLlmCallId: bigint('summary_llm_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, {
      onDelete: 'set null',
    }),
    status: initiativeStatus('status').notNull().default('active'),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    /** The milestone the work builds toward (big demo, QBR). */
    targetEventId: uuid('target_event_id').references(() => calendarEvents.id, { onDelete: 'set null' }),
    targetAt: tstz('target_at'),
    createdBy: actorKind('created_by').notNull(),
    confidence: confidence(),
    userLockedFields: textArray('user_locked_fields'),
    version: integer('version').notNull().default(1),
    completedAt: tstz('completed_at'),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('initiatives_owner_status_idx').on(t.ownerUserId, t.status),
    index('initiatives_opportunity_idx').on(t.opportunityId),
    index('initiatives_title_trgm_idx').using('gin', sql`lower(title) gin_trgm_ops`),
  ],
);

/** Initiative -> people / assets / sessions / meetings / channels / extra opps (exclusive arc). */
export const initiativeLinks = pgTable(
  'initiative_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    initiativeId: uuid('initiative_id')
      .notNull()
      .references(() => initiatives.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
    claudeSessionId: uuid('claude_session_id').references((): AnyPgColumn => claudeSessions.id, {
      onDelete: 'cascade',
    }),
    calendarEventId: uuid('calendar_event_id').references(() => calendarEvents.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    role: initiativeLinkRole('role').notNull(),
    method: linkMethod('method').notNull(),
    confidence: confidence().notNull(),
    userVerdict: userVerdict('user_verdict'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'initiative_links_one_target_chk',
      sql`num_nonnulls(${t.personId}, ${t.assetId}, ${t.claudeSessionId}, ${t.calendarEventId}, ${t.channelId}, ${t.opportunityId}, ${t.repoId}) = 1`,
    ),
    unique('initiative_links_target_uq')
      .on(
        t.initiativeId,
        t.role,
        t.personId,
        t.assetId,
        t.claudeSessionId,
        t.calendarEventId,
        t.channelId,
        t.opportunityId,
        t.repoId,
      )
      .nullsNotDistinct(),
    index('initiative_links_asset_idx').on(t.assetId).where(sql`${t.assetId} IS NOT NULL`),
    index('initiative_links_session_idx').on(t.claudeSessionId).where(sql`${t.claudeSessionId} IS NOT NULL`),
  ],
);

/**
 * "New info -> update?": an engine change to a user-locked field becomes a proposal instead of
 * an overwrite (tenet: Suggest, then learn; R-UI-20). One pending proposal per (entity, field).
 */
export const changeProposals = pgTable(
  'change_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** Root table name ('work_items', 'initiatives', 'activity_entries', 'drafts', ...). */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    field: text('field').notNull(),
    /** Groups several field proposals from the same new info into one card. */
    groupId: uuid('group_id').notNull(),
    currentValue: jsonb('current_value'),
    proposedValue: jsonb('proposed_value').notNull(),
    reason: text('reason').notNull(),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    evidenceId: uuid('evidence_id').references(() => workItemEvidence.id, { onDelete: 'set null' }),
    extractorId: uuid('extractor_id').references(() => extractors.id, { onDelete: 'set null' }),
    llmCallId: bigint('llm_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, {
      onDelete: 'set null',
    }),
    confidence: confidence(),
    /** Row version the proposal was computed against; a moved row marks it stale. */
    baseVersion: integer('base_version').notNull(),
    status: proposalStatus('status').notNull().default('pending'),
    decidedAt: tstz('decided_at'),
    decidedBy: actorKind('decided_by'),
    /** The change set that applied an accepted proposal (undoable). */
    appliedChangeSetId: uuid('applied_change_set_id').references((): AnyPgColumn => changeSets.id, {
      onDelete: 'set null',
    }),
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => changeProposals.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('change_proposals_pending_field_uidx')
      .on(t.entityType, t.entityId, t.field)
      .where(sql`${t.status} = 'pending'`),
    index('change_proposals_owner_pending_idx')
      .on(t.ownerUserId, t.createdAt.desc())
      .where(sql`${t.status} = 'pending'`),
    index('change_proposals_group_idx').on(t.groupId),
  ],
);

/** Done item + new requirement: reopen it, or open a sibling? Decision, rule and undo (R-UI-20). */
export const reopenDecisions = pgTable(
  'reopen_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    doneWorkItemId: uuid('done_work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    triggerSourceItemId: uuid('trigger_source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    triggerEvidenceId: uuid('trigger_evidence_id').references(() => workItemEvidence.id, { onDelete: 'set null' }),
    /** R-UI-22 (BE-0 addition): who pulled me back in (the direct ask's author) for 'looped_back_in'. */
    triggerPersonId: uuid('trigger_person_id').references(() => people.id, { onDelete: 'set null' }),
    outcome: reopenOutcome('outcome').notNull(),
    /**
     * 'same_deliverable_recent', 'different_deliverable', 'outside_window', 'user_choice', ...
     * R-UI-22: 'looped_back_in' = a direct ask of me on an item I handed off (reopen or sibling).
     */
    ruleKey: text('rule_key').notNull(),
    /** Shown in the UI: "Reopened: new requirement from Sam (same deck, closed 2 days ago)". */
    explanation: text('explanation').notNull(),
    newWorkItemId: uuid('new_work_item_id').references(() => workItems.id, { onDelete: 'cascade' }), // 0007: the decision goes with its sibling (undo)
    initiativeId: uuid('initiative_id').references(() => initiatives.id, { onDelete: 'set null' }),
    transitionId: bigint('transition_id', { mode: 'number' }).references(() => workItemTransitions.id, {
      onDelete: 'set null',
    }),
    confidence: confidence(),
    decidedBy: actorKind('decided_by').notNull(),
    changeSetId: uuid('change_set_id')
      .notNull()
      .references((): AnyPgColumn => changeSets.id, { onDelete: 'restrict' }),
    undoneAt: tstz('undone_at'),
    undoneByChangeSetId: uuid('undone_by_change_set_id').references((): AnyPgColumn => changeSets.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index('reopen_decisions_done_item_idx').on(t.doneWorkItemId, t.createdAt.desc()),
    check('reopen_decisions_outcome_chk', sql`${t.outcome} <> 'new_sibling' OR ${t.newWorkItemId} IS NOT NULL`),
    check('reopen_decisions_reopen_chk', sql`${t.outcome} <> 'reopened' OR ${t.transitionId} IS NOT NULL`),
  ],
);

export const workItemTrainingDetails = pgTable(
  'work_item_training_details',
  {
    workItemId: uuid('work_item_id')
      .primaryKey()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    provider: trainingProvider('provider').notNull(),
    courseTitle: text('course_title').notNull(),
    courseUrl: text('course_url'),
    externalCourseId: text('external_course_id'),
    mandatory: boolean('mandatory').notNull().default(false),
    requiredBy: tstz('required_by'),
    estimatedMinutes: integer('estimated_minutes'),
    progressPct: smallint('progress_pct').notNull().default(0),
    completedAt: tstz('completed_at'),
    completionSourceItemId: uuid('completion_source_item_id'),
  },
  (t) => [
    foreignKey({
      name: 'work_item_training_details_completion_source_item_id_fk',
      columns: [t.completionSourceItemId],
      foreignColumns: [sourceItems.id],
    }).onDelete('set null'),
    check('work_item_training_details_progress_chk', sql`${t.progressPct} BETWEEN 0 AND 100`),
  ],
);

/** Travel parent item; checklist steps (approval, booking, expenses) are child work items. */
export const workItemTravelDetails = pgTable('work_item_travel_details', {
  workItemId: uuid('work_item_id')
    .primaryKey()
    .references(() => workItems.id, { onDelete: 'cascade' }),
  destination: text('destination').notNull(),
  departsAt: tstz('departs_at'),
  returnsAt: tstz('returns_at'),
  purposeEventId: uuid('purpose_event_id').references(() => calendarEvents.id, { onDelete: 'set null' }),
  approvalStatus: travelStepStatus('approval_status').notNull().default('not_started'),
  approvalRef: text('approval_ref'),
  bookingStatus: travelStepStatus('booking_status').notNull().default('not_started'),
  expenseStatus: travelStepStatus('expense_status').notNull().default('not_started'),
  expenseDueAt: tstz('expense_due_at'),
});

export type WorkItem = typeof workItems.$inferSelect;
export type NewWorkItem = typeof workItems.$inferInsert;
export type WorkItemEvidence = typeof workItemEvidence.$inferSelect;
