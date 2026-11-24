/** Raw source items, refs, entity links, extractors and extraction candidates (section 4). */
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
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tsvector, tstz, createdAt, updatedAt, ownerUserId, confidence, textArray } from './columns';
import {
  sourceSystem,
  sourceItemKind,
  bodyFormat,
  actorKind,
  userVerdict,
  linkMethod,
  modelTier,
  refKind,
  entityLinkRole,
  extractorKind,
  candidateDecision,
  workItemKind,
} from './enums';
import { connectors } from './connectors';
import { scanRuns } from './scanning';
import { accounts, opportunities, people, channels, repos, assets, mappingRules } from './entities';
import { calendarEvents } from './calendar';
import { workItems } from './work';
import { llmCalls } from './llm';

export const sourceItems = pgTable(
  'source_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'set null' }),
    source: sourceSystem('source').notNull(),
    kind: sourceItemKind('kind').notNull(),
    /** Provider id (Slack ts, Gmail id, Drive fileId, Org62 Id, session UUID, sha). */
    externalId: text('external_id').notNull(),
    /** Thread ts / Gmail threadId / Drive fileId / recurringEventId / Org62 record id. */
    externalParentId: text('external_parent_id'),
    /** Channel id / label / calendar id / repo path. */
    externalContainerId: text('external_container_id'),
    /** Canonical natural key; see "Idempotency" for the per-kind recipe. */
    dedupeKey: text('dedupe_key').notNull(),
    /** sha256 of the canonical (redacted) content; unchanged hash = no-op re-ingest. */
    contentHash: text('content_hash').notNull(),
    revision: integer('revision').notNull().default(1),
    occurredAt: tstz('occurred_at').notNull(),
    sourceUpdatedAt: tstz('source_updated_at'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    contentChangedAt: tstz('content_changed_at'),
    firstScanRunId: uuid('first_scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
    lastScanRunId: uuid('last_scan_run_id').references(() => scanRuns.id, { onDelete: 'set null' }),
    actorPersonId: uuid('actor_person_id').references((): AnyPgColumn => people.id, { onDelete: 'set null' }),
    /** Raw author id (Slack U…, email) kept until the resolver maps it. */
    actorExternalId: text('actor_external_id'),
    fromMe: boolean('from_me').notNull().default(false),
    addressedToMe: boolean('addressed_to_me').notNull().default(false),
    channelId: uuid('channel_id').references((): AnyPgColumn => channels.id, { onDelete: 'set null' }),
    assetId: uuid('asset_id').references((): AnyPgColumn => assets.id, { onDelete: 'set null' }),
    repoId: uuid('repo_id').references((): AnyPgColumn => repos.id, { onDelete: 'set null' }),
    title: text('title'),
    /** Deep link back to the source (tenet: Provenance on everything). */
    url: text('url'),
    /** Redacted body. Nulled by the retention sweeper at body_expires_at. */
    body: text('body'),
    bodyFormat: bodyFormat('body_format').notNull().default('plain'),
    bodyExpiresAt: tstz('body_expires_at'),
    bodyPurgedAt: tstz('body_purged_at'),
    redacted: boolean('redacted').notNull().default(false),
    redactionCount: integer('redaction_count').notNull().default(0),
    redactionKinds: textArray('redaction_kinds'),
    /** Source-specific structured payload; zod schema per kind; never message text. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    deletedUpstreamAt: tstz('deleted_upstream_at'),
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('source_items_owner_dedupe_key_uidx').on(t.ownerUserId, t.dedupeKey),
    index('source_items_owner_source_external_idx').on(t.ownerUserId, t.source, t.externalId),
    index('source_items_thread_idx').on(t.ownerUserId, t.source, t.externalParentId, t.occurredAt),
    index('source_items_my_thread_replies_idx')
      .on(t.ownerUserId, t.externalParentId, t.occurredAt)
      .where(sql`${t.fromMe}`),
    index('source_items_inbound_to_me_idx')
      .on(t.ownerUserId, t.occurredAt.desc())
      .where(sql`${t.addressedToMe} AND NOT ${t.fromMe}`),
    index('source_items_owner_kind_occurred_idx').on(t.ownerUserId, t.kind, t.occurredAt.desc()),
    // 0039 (post-2.0 read profile): every page with connectors counts today's items per connector by first_seen_at;
    // without it that count read every source item of the user (a year of them) on each page load
    index('source_items_owner_first_seen_idx').on(t.ownerUserId, t.firstSeenAt),
    index('source_items_body_expiry_idx').on(t.bodyExpiresAt).where(sql`${t.body} IS NOT NULL`),
    index('source_items_search_tsv_idx').using('gin', t.searchTsv),
    index('source_items_actor_idx').on(t.actorPersonId),
    index('source_items_asset_idx').on(t.assetId),
    index('source_items_channel_idx').on(t.channelId, t.occurredAt.desc()),
    check('source_items_redaction_chk', sql`${t.redacted} = (${t.redactionCount} > 0)`),
  ],
);

/** Raw references found in an item (Drive links, Org62 ids, @mentions) for deterministic linking. */
export const sourceItemRefs = pgTable(
  'source_item_refs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sourceItemId: uuid('source_item_id')
      .notNull()
      .references(() => sourceItems.id, { onDelete: 'cascade' }),
    kind: refKind('kind').notNull(),
    value: text('value').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('source_item_refs_item_kind_value_uidx').on(t.sourceItemId, t.kind, t.value),
    index('source_item_refs_kind_value_idx').on(t.kind, t.value),
  ],
);

/** Registry of everything that creates links/candidates: parsers, rules, LLM prompts, user, chat. */
export const extractors = pgTable(
  'extractors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    version: text('version').notNull(),
    kind: extractorKind('kind').notNull(),
    modelTier: modelTier('model_tier').notNull().default('none'),
    model: text('model'),
    skillKey: text('skill_key'),
    promptHash: text('prompt_hash'),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('extractors_key_version_uidx').on(t.key, t.version)],
);

/** Resolver output: source item -> business entity (exclusive arc, one target per row). */
export const sourceItemLinks = pgTable(
  'source_item_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceItemId: uuid('source_item_id')
      .notNull()
      .references(() => sourceItems.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references((): AnyPgColumn => opportunities.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references((): AnyPgColumn => people.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references((): AnyPgColumn => assets.id, { onDelete: 'cascade' }),
    calendarEventId: uuid('calendar_event_id').references((): AnyPgColumn => calendarEvents.id, {
      onDelete: 'cascade',
    }),
    role: entityLinkRole('role').notNull().default('about'),
    method: linkMethod('method').notNull(),
    confidence: confidence().notNull(),
    extractorId: uuid('extractor_id').references(() => extractors.id, { onDelete: 'set null' }),
    mappingRuleId: uuid('mapping_rule_id').references((): AnyPgColumn => mappingRules.id, { onDelete: 'set null' }),
    userVerdict: userVerdict('user_verdict'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'source_item_links_one_target_chk',
      sql`num_nonnulls(${t.accountId}, ${t.opportunityId}, ${t.personId}, ${t.assetId}, ${t.calendarEventId}) = 1`,
    ),
    unique('source_item_links_target_uq')
      .on(t.sourceItemId, t.role, t.accountId, t.opportunityId, t.personId, t.assetId, t.calendarEventId)
      .nullsNotDistinct(),
    index('source_item_links_account_idx').on(t.accountId).where(sql`${t.accountId} IS NOT NULL`),
    index('source_item_links_opportunity_idx').on(t.opportunityId).where(sql`${t.opportunityId} IS NOT NULL`),
    index('source_item_links_person_idx').on(t.personId).where(sql`${t.personId} IS NOT NULL`),
    index('source_item_links_asset_idx').on(t.assetId).where(sql`${t.assetId} IS NOT NULL`),
    index('source_item_links_event_idx').on(t.calendarEventId).where(sql`${t.calendarEventId} IS NOT NULL`),
    index('source_item_links_unconfirmed_idx')
      .on(t.confidence)
      .where(sql`${t.userVerdict} IS NULL AND ${t.method} = 'llm'`),
  ],
);

/** Commitment-engine output before merge: one extracted ask/promise/next step per row. */
export const extractionCandidates = pgTable(
  'extraction_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    sourceItemId: uuid('source_item_id')
      .notNull()
      .references(() => sourceItems.id, { onDelete: 'cascade' }),
    extractorId: uuid('extractor_id')
      .notNull()
      .references(() => extractors.id, { onDelete: 'restrict' }),
    /** Position within the source (e.g. 3rd Gemini next step). */
    ordinal: smallint('ordinal').notNull().default(0),
    proposedKind: workItemKind('proposed_kind').notNull(),
    proposedTitle: text('proposed_title').notNull(),
    proposedDueAt: tstz('proposed_due_at'),
    dueText: text('due_text'),
    assigneeText: text('assignee_text'),
    assignedToMe: boolean('assigned_to_me').notNull().default(false),
    sharedAssignment: boolean('shared_assignment').notNull().default(false),
    counterpartyPersonId: uuid('counterparty_person_id').references((): AnyPgColumn => people.id, {
      onDelete: 'set null',
    }),
    confidence: confidence().notNull(),
    decision: candidateDecision('decision').notNull().default('pending'),
    workItemId: uuid('work_item_id').references((): AnyPgColumn => workItems.id, { onDelete: 'set null' }),
    mergeScore: confidence('merge_score'),
    mergeRationale: text('merge_rationale'),
    llmCallId: bigint('llm_call_id', { mode: 'number' }).references((): AnyPgColumn => llmCalls.id, {
      onDelete: 'set null',
    }),
    decidedAt: tstz('decided_at'),
    decidedBy: actorKind('decided_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('extraction_candidates_item_extractor_ordinal_uidx').on(t.sourceItemId, t.extractorId, t.ordinal),
    index('extraction_candidates_open_idx')
      .on(t.ownerUserId, t.decision, t.createdAt)
      .where(sql`${t.decision} IN ('pending', 'needs_triage')`),
    index('extraction_candidates_work_item_idx').on(t.workItemId),
  ],
);

export type SourceItem = typeof sourceItems.$inferSelect;
export type NewSourceItem = typeof sourceItems.$inferInsert;
