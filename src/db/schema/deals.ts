/** Org62 read-back mirrors and the missed-opportunity scan (section 12; R-UI-14). */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tstz, createdAt, updatedAt, ownerUserId, amount, id15 } from './columns';
import {
  runStatus,
  missedOppTier,
  missedOppVerdict,
  evidenceStrength,
  oppFindingStatus,
} from './enums';
import { scanRuns } from './scanning';
import { sourceItems } from './sources';
import { accounts, opportunities, people } from './entities';
import { workItems } from './work';

export const org62Events = pgTable(
  'org62_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    org62EventId: text('org62_event_id').notNull(),
    recordTypeName: text('record_type_name').notNull(),
    subject: text('subject'),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    /** Raw Duration__c; null = never filled in. */
    durationField: numeric('duration_field', { precision: 4, scale: 2, mode: 'number' }),
    seTaskTypeName: text('se_task_type_name'),
    meetingTypeName: text('meeting_type_name'),
    whatOrg62Id: text('what_org62_id'),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    org62CreatedAt: tstz('org62_created_at'),
    org62ModifiedAt: tstz('org62_modified_at'),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    deletedUpstreamAt: tstz('deleted_upstream_at'),
    org62EventId15: id15('org62_event_id15', 'org62_event_id'),
    whatOrg62Id15: id15('what_org62_id15', 'what_org62_id'),
  },
  (t) => [
    index('org62_events_owner_event_id15_idx').on(t.ownerUserId, t.org62EventId15),
    uniqueIndex('org62_events_owner_event_uidx').on(t.ownerUserId, t.org62EventId),
    index('org62_events_owner_starts_idx').on(t.ownerUserId, t.startsAt),
    /** Natural duplicate check: Subject + Start + Owner. */
    index('org62_events_owner_subject_start_idx').on(t.ownerUserId, t.subject, t.startsAt),
  ],
);

export const dealContributions = pgTable(
  'deal_contributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    org62DcId: text('org62_dc_id').notNull(),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    contributorPersonId: uuid('contributor_person_id').references(() => people.id, { onDelete: 'set null' }),
    contributorOrg62UserId: text('contributor_org62_user_id'),
    isMine: boolean('is_mine').notNull().default(false),
    role: text('role'),
    splitPercent: numeric('split_percent', { precision: 5, scale: 2, mode: 'number' }),
    hasComments: boolean('has_comments').notNull().default(false),
    vdpLink: text('vdp_link'),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    deletedUpstreamAt: tstz('deleted_upstream_at'),
  },
  (t) => [
    uniqueIndex('deal_contributions_owner_dc_uidx').on(t.ownerUserId, t.org62DcId),
    index('deal_contributions_opportunity_idx').on(t.opportunityId),
    index('deal_contributions_mine_idx').on(t.ownerUserId).where(sql`${t.isMine}`),
  ],
);

/**
 * D-67: the Use_Case__c records on my opportunities, as the Org62 read-back reads them (by opp, daily and from
 * Health), and which VDP use case each one is (`vdp_use_case_id`). Read-only state of an external system plus the
 * link, so not audited (like org62_events and vdp_records). A record a complete read of its opp no longer returns is
 * kept and marked `gone_at` (deleted in Org62, or moved off my opps); the app never deletes anything there.
 *
 *   link_origin  `app`: a logging canvas I applied created it (the app may update its Stage__c / Go_Live_Date__c while
 *                I own it); `adopted`: it was there already (never changed by the app).
 *   synced_*     the values the app last wrote there or saw agree on both sides (stage, go-live, name), so a later change
 *                on one side has a direction (Org62 follows VDP, VDP follows Org62, or both changed: the user picks).
 */
export const org62UseCases = pgTable(
  'org62_use_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    org62UseCaseId: text('org62_use_case_id').notNull(),
    org62OpportunityId: text('org62_opportunity_id'),
    org62AccountId: text('org62_account_id'),
    name: text('name'),
    product: text('product'),
    stage: text('stage'),
    goLiveDate: text('go_live_date'),
    ownerOrg62Id: text('owner_org62_id'),
    createdByOrg62Id: text('created_by_org62_id'),
    org62CreatedAt: tstz('org62_created_at'),
    org62ModifiedAt: tstz('org62_modified_at'),
    vdpUseCaseId: text('vdp_use_case_id'),
    linkOrigin: text('link_origin'),
    syncedStage: text('synced_stage'),
    syncedGoLive: text('synced_go_live'),
    syncedName: text('synced_name'),
    linkedAt: tstz('linked_at'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    goneAt: tstz('gone_at'),
    updatedAt: updatedAt(),
    org62UseCaseId15: id15('org62_use_case_id15', 'org62_use_case_id'),
    org62OpportunityId15: id15('org62_opportunity_id15', 'org62_opportunity_id'),
    org62AccountId15: id15('org62_account_id15', 'org62_account_id'),
  },
  (t) => [
    index('org62_use_cases_owner_opp_id15_idx').on(t.ownerUserId, t.org62OpportunityId15),
    uniqueIndex('org62_use_cases_owner_record_uidx').on(t.ownerUserId, t.org62UseCaseId),
    uniqueIndex('org62_use_cases_owner_vdp_uc_uidx').on(t.ownerUserId, t.vdpUseCaseId).where(sql`${t.vdpUseCaseId} is not null`),
    index('org62_use_cases_owner_opp_idx').on(t.ownerUserId, t.org62OpportunityId),
  ],
);

/** D-67: when the read-back last read my opps' use cases (one row per user): creates wait for the first read. */
export const org62UseCaseReads = pgTable('org62_use_case_reads', {
  ownerUserId: ownerUserId().primaryKey(),
  readAt: tstz('read_at').notNull(),
  /** Opps asked about, and whether every batch came back complete. */
  opps: integer('opps').notNull().default(0),
  complete: boolean('complete').notNull().default(false),
  updatedAt: updatedAt(),
});

export const missedOppSweeps = pgTable('missed_opp_sweeps', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: ownerUserId(),
  scanRunId: uuid('scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
  status: runStatus('status').notNull().default('queued'),
  /** Product signals, min amount, closed-won window, account scope (sweep-config). */
  criteria: jsonb('criteria').$type<Record<string, unknown>>().notNull(),
  accountsConsidered: integer('accounts_considered').notNull().default(0),
  oppsConsidered: integer('opps_considered').notNull().default(0),
  findingsNew: integer('findings_new').notNull().default(0),
  findingsChanged: integer('findings_changed').notNull().default(0),
  startedAt: tstz('started_at').notNull().defaultNow(),
  finishedAt: tstz('finished_at'),
});

/** One persistent finding per opp; each sweep refreshes it unless the user locked it. */
export const missedOppFindings = pgTable(
  'missed_opp_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    firstSweepId: uuid('first_sweep_id')
      .notNull()
      .references(() => missedOppSweeps.id, { onDelete: 'restrict' }),
    lastSweepId: uuid('last_sweep_id')
      .notNull()
      .references(() => missedOppSweeps.id, { onDelete: 'restrict' }),
    tier: missedOppTier('tier').notNull(),
    verdict: missedOppVerdict('verdict').notNull(),
    evidenceStrength: evidenceStrength('evidence_strength').notNull().default('none'),
    hasD360Line: boolean('has_d360_line').notNull().default(false),
    d360LineAmount: amount('d360_line_amount'),
    flexLineAmount: amount('flex_line_amount'),
    myOrg62Hours: numeric('my_org62_hours', { precision: 6, scale: 2, mode: 'number' }).notNull().default(0),
    myDcExists: boolean('my_dc_exists').notNull().default(false),
    otherArchitectDcCount: smallint('other_architect_dc_count').notNull().default(0),
    /** My DC sitting on a dead/duplicate opp. */
    strandedDcId: uuid('stranded_dc_id').references(() => dealContributions.id, { onDelete: 'set null' }),
    evidenceSummary: text('evidence_summary'),
    status: oppFindingStatus('status').notNull().default('new'),
    userLocked: boolean('user_locked').notNull().default(false),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'set null' }),
    dismissedReason: text('dismissed_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('missed_opp_findings_owner_opp_uidx').on(t.ownerUserId, t.opportunityId),
    index('missed_opp_findings_owner_status_idx').on(t.ownerUserId, t.status, t.tier),
  ],
);
