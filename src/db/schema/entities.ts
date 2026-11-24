/** Business entities: accounts, opportunities, people, channels, repos, assets, mapping rules, VDP (section 5). */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tstz, createdAt, updatedAt, ownerUserId, confidence, amount, textArray, id15 } from './columns';
import {
  sourceSystem,
  userVerdict,
  linkMethod,
  aliasKind,
  ruleSource,
  personAffiliation,
  stakeholderTier,
  identitySystem,
  channelKind,
  watchMode,
  repoKind,
  assetKind,
  assetSystem,
  mappingRuleKind,
  assetTrackingTier,
} from './enums';
import { seTaskTypes } from './core';
import { sourceItems } from './sources';
import { assetSnapshots } from './drive';
import { changeSets } from './audit';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    org62AccountId: text('org62_account_id'),
    name: text('name').notNull(),
    /** Sibling/parent orgs (e.g. a payer and its subsidiary). */
    parentAccountId: uuid('parent_account_id').references((): AnyPgColumn => accounts.id, { onDelete: 'set null' }),
    family: text('family'),
    industry: text('industry'),
    isMyBook: boolean('is_my_book').notNull().default(false),
    isWatched: boolean('is_watched').notNull().default(false),
    notes: text('notes'),
    archivedAt: tstz('archived_at'),
    /** 0036 (D-98): business state that lived in the kv side-car (`cc.ext/accounts/<id>`): my DC status, the Org62 link. */
    dcStatus: text('dc_status'),
    org62Url: text('org62_url'),
    org62AccountId15: id15('org62_account_id15', 'org62_account_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('accounts_owner_org62_id15_idx').on(t.ownerUserId, t.org62AccountId15),
    uniqueIndex('accounts_owner_org62_uidx')
      .on(t.ownerUserId, t.org62AccountId)
      .where(sql`${t.org62AccountId} IS NOT NULL`),
    index('accounts_name_trgm_idx').using('gin', sql`lower(name) gin_trgm_ops`),
  ],
);

export const accountAliases = pgTable(
  'account_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: aliasKind('kind').notNull(),
    value: text('value').notNull(),
    /** lower-cased, trimmed; domains without "www." */
    normalizedValue: text('normalized_value').notNull(),
    source: ruleSource('source').notNull(),
    confidence: confidence().notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('account_aliases_account_kind_value_uidx').on(t.accountId, t.kind, t.normalizedValue),
    index('account_aliases_kind_value_idx').on(t.kind, t.normalizedValue),
    index('account_aliases_value_trgm_idx').using('gin', sql`normalized_value gin_trgm_ops`),
  ],
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    org62OpportunityId: text('org62_opportunity_id').notNull(),
    name: text('name').notNull(),
    stage: text('stage'),
    amount: amount('amount'),
    currencyCode: text('currency_code').notNull().default('USD'),
    closeDate: date('close_date', { mode: 'string' }),
    forecastCategory: text('forecast_category'),
    type: text('type'),
    isClosed: boolean('is_closed').notNull().default(false),
    isWon: boolean('is_won').notNull().default(false),
    lastActivityDate: date('last_activity_date', { mode: 'string' }),
    onMyTeam: boolean('on_my_team').notNull().default(false),
    myTeamRole: text('my_team_role'),
    isWatched: boolean('is_watched').notNull().default(false),
    latestSnapshotId: uuid('latest_snapshot_id').references((): AnyPgColumn => opportunitySnapshots.id, {
      onDelete: 'set null',
    }),
    org62ModifiedAt: tstz('org62_modified_at'),
    archivedAt: tstz('archived_at'),
    /**
     * 0036 (D-98): business state that lived in the kv side-car (`cc.ext/opportunities/<id>`): the DC flag (false =
     * unset), the Org62 next step, the products, the opp owner (a people id, no FK: an owner may not be a person row
     * yet) and when the daily book read stopped listing it.
     */
    dcAssigned: boolean('dc_assigned').notNull().default(false),
    nextStep: text('next_step'),
    products: text('products').array(),
    ownerPersonId: uuid('owner_person_id'),
    leftBookAt: tstz('left_book_at'),
    org62OpportunityId15: id15('org62_opportunity_id15', 'org62_opportunity_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('opportunities_owner_org62_id15_idx').on(t.ownerUserId, t.org62OpportunityId15),
    uniqueIndex('opportunities_owner_org62_uidx').on(t.ownerUserId, t.org62OpportunityId),
    index('opportunities_account_idx').on(t.accountId),
    index('opportunities_owner_open_close_idx').on(t.ownerUserId, t.closeDate).where(sql`NOT ${t.isClosed}`),
    index('opportunities_name_trgm_idx').using('gin', sql`lower(name) gin_trgm_ops`),
  ],
);

/** Org62 opportunity snapshots; a new row only when fields_hash changes. */
export const opportunitySnapshots = pgTable(
  'opportunity_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    capturedAt: tstz('captured_at').notNull(),
    fieldsHash: text('fields_hash').notNull(),
    stage: text('stage'),
    amount: amount('amount'),
    closeDate: date('close_date', { mode: 'string' }),
    forecastCategory: text('forecast_category'),
    isClosed: boolean('is_closed'),
    isWon: boolean('is_won'),
    nextStep: text('next_step'),
    productNames: textArray('product_names'),
    d360LineAmount: amount('d360_line_amount'),
    flexLineAmount: amount('flex_line_amount'),
    /** Remaining Org62 fields not promoted to columns. */
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('opportunity_snapshots_opp_captured_uidx').on(t.opportunityId, t.capturedAt)],
);

export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    displayName: text('display_name').notNull(),
    primaryEmail: text('primary_email'),
    title: text('title'),
    affiliation: personAffiliation('affiliation').notNull().default('unknown'),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** Stakeholder importance input to priority (D-24 VIP list). */
    tier: stakeholderTier('tier').notNull().default('normal'),
    isMe: boolean('is_me').notNull().default(false),
    mergedIntoPersonId: uuid('merged_into_person_id').references((): AnyPgColumn => people.id, {
      onDelete: 'set null',
    }),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('people_owner_me_uidx').on(t.ownerUserId).where(sql`${t.isMe}`),
    index('people_account_idx').on(t.accountId),
    index('people_name_trgm_idx').using('gin', sql`lower(display_name) gin_trgm_ops`),
  ],
);

/** One person, many identities: Slack U…, email, Org62 005…/003…, Google. */
export const personIdentities = pgTable(
  'person_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    system: identitySystem('system').notNull(),
    /** Normalized (emails lower-cased). */
    externalId: text('external_id').notNull(),
    handle: text('handle'),
    isPrimary: boolean('is_primary').notNull().default(false),
    method: linkMethod('method').notNull(),
    confidence: confidence().notNull().default(1),
    verifiedAt: tstz('verified_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('person_identities_owner_system_external_uidx').on(t.ownerUserId, t.system, t.externalId),
    index('person_identities_person_idx').on(t.personId),
  ],
);

export const opportunityTeamMembers = pgTable(
  'opportunity_team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    org62UserId: text('org62_user_id').notNull(),
    teamRole: text('team_role').notNull(),
    isMe: boolean('is_me').notNull().default(false),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    removedAt: tstz('removed_at'),
  },
  (t) => [
    uniqueIndex('opportunity_team_members_opp_user_role_uidx').on(t.opportunityId, t.org62UserId, t.teamRole),
    index('opportunity_team_members_person_idx').on(t.personId),
  ],
);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    system: sourceSystem('system').notNull().default('slack'),
    externalId: text('external_id').notNull(),
    name: text('name'),
    kind: channelKind('kind').notNull(),
    watchMode: watchMode('watch_mode').notNull().default('items'),
    isCustomerChannel: boolean('is_customer_channel').notNull().default(false),
    isMember: boolean('is_member').notNull().default(true),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('channels_owner_system_external_uidx').on(t.ownerUserId, t.system, t.externalId),
    index('channels_owner_watch_idx').on(t.ownerUserId, t.watchMode),
  ],
);

export const channelAccountMaps = pgTable(
  'channel_account_maps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    method: linkMethod('method').notNull(),
    confidence: confidence().notNull(),
    mappingRuleId: uuid('mapping_rule_id').references((): AnyPgColumn => mappingRules.id, { onDelete: 'set null' }),
    userVerdict: userVerdict('user_verdict'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('channel_account_maps_channel_account_uidx').on(t.channelId, t.accountId),
    index('channel_account_maps_account_idx').on(t.accountId),
  ],
);

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    remoteUrl: text('remote_url'),
    kind: repoKind('kind').notNull().default('unknown'),
    defaultAccountId: uuid('default_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    ignored: boolean('ignored').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('repos_owner_path_uidx').on(t.ownerUserId, t.path)],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    system: assetSystem('system').notNull(),
    externalId: text('external_id').notNull(),
    kind: assetKind('kind').notNull(),
    title: text('title'),
    url: text('url'),
    mimeType: text('mime_type'),
    ownerPersonId: uuid('owner_person_id').references(() => people.id, { onDelete: 'set null' }),
    iOwn: boolean('i_own').notNull().default(false),
    lastModifiedAt: tstz('last_modified_at'),
    lastModifyingPersonId: uuid('last_modifying_person_id').references(() => people.id, { onDelete: 'set null' }),
    lastModifiedByMeAt: tstz('last_modified_by_me_at'),
    /** Drive headRevisionId / version when the API exposes them (often null via MCP). */
    headRevisionId: text('head_revision_id'),
    driveVersion: bigint('drive_version', { mode: 'number' }),
    /** inventory = daily; watched = 5-min sampling while an open deliverable targets it (R-UI-15). */
    trackingTier: assetTrackingTier('tracking_tier').notNull().default('inventory'),
    watchedUntil: tstz('watched_until'),
    latestSnapshotId: uuid('latest_snapshot_id').references((): AnyPgColumn => assetSnapshots.id, {
      onDelete: 'set null',
    }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    mappingMethod: linkMethod('mapping_method'),
    mappingConfidence: confidence('mapping_confidence'),
    mappingLocked: boolean('mapping_locked').notNull().default(false),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('assets_owner_system_external_uidx').on(t.ownerUserId, t.system, t.externalId),
    index('assets_owner_my_edits_idx').on(t.ownerUserId, t.lastModifiedByMeAt.desc()),
    index('assets_watched_idx').on(t.ownerUserId, t.watchedUntil).where(sql`${t.trackingTier} = 'watched'`),
    index('assets_account_idx').on(t.accountId),
    index('assets_opportunity_idx').on(t.opportunityId),
    index('assets_title_trgm_idx').using('gin', sql`lower(coalesce(title, '')) gin_trgm_ops`),
  ],
);

/** Learned + seeded mapping rules (tenet: Suggest, then learn). */
export const mappingRules = pgTable(
  'mapping_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    kind: mappingRuleKind('kind').notNull(),
    pattern: text('pattern').notNull(),
    isRegex: boolean('is_regex').notNull().default(false),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'cascade' }),
    seTaskTypeId: uuid('se_task_type_id').references(() => seTaskTypes.id, { onDelete: 'cascade' }),
    targetValue: text('target_value'),
    /** Lower wins. User corrections default ahead of seeds. */
    priority: integer('priority').notNull().default(100),
    source: ruleSource('source').notNull(),
    createdFromChangeSetId: uuid('created_from_change_set_id').references((): AnyPgColumn => changeSets.id, {
      onDelete: 'set null',
    }),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: tstz('last_hit_at'),
    /** 0032 (attribution engine): corrections that disagreed with it; a rule decays and is replaced once they reach hit_count. */
    missCount: integer('miss_count').notNull().default(0),
    lastMissAt: tstz('last_miss_at'),
    enabled: boolean('enabled').notNull().default(true),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mapping_rules_owner_kind_pattern_uidx').on(t.ownerUserId, t.kind, t.pattern),
    index('mapping_rules_owner_kind_priority_idx').on(t.ownerUserId, t.kind, t.priority).where(sql`${t.enabled}`),
    check(
      'mapping_rules_target_chk',
      sql`${t.kind} IN ('ignore_sender', 'ignore_channel') OR num_nonnulls(${t.accountId}, ${t.opportunityId}, ${t.personId}, ${t.seTaskTypeId}, ${t.targetValue}) >= 1`,
    ),
  ],
);

/**
 * VDP coverage per opp (read-only mirror of vdp-app-fir, written by the `scan.vdp` job through
 * src/server/datasource/db/store/vdp.ts). `detail` holds the whole normalized VDP (header, owners, every use-case
 * field, stakeholders, assets): the current state, replaced on each read, so it is not a 90-day body.
 */
export const vdpRecords = pgTable(
  'vdp_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    vdpSlug: text('vdp_slug').notNull(),
    /** The VDP's id in vdp-app (the write tools take it). */
    vdpId: text('vdp_id'),
    companyName: text('company_name'),
    /** Org62 ids as VDP stores them (15 or 18 chars); `accountId`/`opportunityId` are the local rows they match. */
    salesforceAccountId: text('salesforce_account_id'),
    salesforceOpportunityId: text('salesforce_opportunity_id'),
    salesforceAccountId15: id15('salesforce_account_id15', 'salesforce_account_id'),
    salesforceOpportunityId15: id15('salesforce_opportunity_id15', 'salesforce_opportunity_id'),
    archived: boolean('archived').notNull().default(false),
    lastActivityAt: tstz('last_activity_at'),
    /** A complete read no longer listed it (gone, or no longer mine). Kept, never deleted. */
    goneAt: tstz('gone_at'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    url: text('url'),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    fiscalYear: smallint('fiscal_year'),
    fiscalQuarter: smallint('fiscal_quarter'),
    hasAe: boolean('has_ae').notNull().default(false),
    hasTa: boolean('has_ta').notNull().default(false),
    useCaseCount: integer('use_case_count').notNull().default(0),
    useCaseWithAiCount: integer('use_case_with_ai_count').notNull().default(0),
    assetCount: integer('asset_count').notNull().default(0),
    dcNoteCached: boolean('dc_note_cached').notNull().default(false),
    missingItems: textArray('missing_items'),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'set null' }),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    /**
     * 0036 (D-98, mirror convention): when this row's child tables (vdp_use_cases, vdp_assets, vdp_members) were last
     * written from a read. Null: written before 0036, so readers fall back to `detail` until the next read or backfill.
     */
    mirroredAt: tstz('mirrored_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('vdp_records_owner_opp_id15_idx').on(t.ownerUserId, t.salesforceOpportunityId15),
    uniqueIndex('vdp_records_owner_slug_uidx').on(t.ownerUserId, t.vdpSlug),
    index('vdp_records_opportunity_idx').on(t.opportunityId),
  ],
);

/**
 * What the VDP server can do, read with the mirror (D-59 feature detection): its tool names and argument names
 * (`tools/list`), the Deliverable types when it has that lookup, and `list_companies` matches for my engaged accounts
 * with no VDP. One row per user, replaced by each read (state of an external system: not audited, like vdp_records).
 * Never a description, a schema or a credential: names and ids only.
 */
export const vdpServer = pgTable('vdp_server', {
  ownerUserId: ownerUserId().primaryKey(),
  /** src/lib/vdp/types.ts VdpServerInfo: {tools, deliverableTypes, companies, readAt}. */
  info: jsonb('info').$type<Record<string, unknown>>().notNull(),
  readAt: tstz('read_at').notNull(),
  updatedAt: updatedAt(),
});

/**
 * Assets that belong on a VDP (Time ▸ VDP details ▸ "Assets to add"), with provenance: found by the deterministic
 * matcher over newly scanned Drive files, Slack links, Gmail links and calendar attachments, by a "Find assets"
 * research run over the account's history, or by the Assistant. Local state only: VDP is never written (adding an
 * asset is a handoff), and the next mirror read closes a candidate once VDP shows it (`in_vdp`).
 *
 * One row per (target, asset): `target_key` is the account id when the VDP is linked to one (so a candidate found
 * before the VDP existed waits for it), else `vdp:<slug>`; `asset_key` is the normalized link (`drive:<fileId>` for
 * Google files). A dismissed or added row is never reset by a later match; a match only adds sources.
 */
export const vdpAssetCandidates = pgTable(
  'vdp_asset_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    targetKey: text('target_key').notNull(),
    /** The VDP it goes on; null while the account has none (adopted when the mirror first links one). */
    vdpSlug: text('vdp_slug'),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    companyName: text('company_name').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    assetKey: text('asset_key').notNull(),
    /** deck · doc · sheet · pdf · recording · demo · canvas · link (contract VdpAssetKind). */
    kind: text('kind').notNull(),
    why: text('why').notNull(),
    confidence: confidence().notNull(),
    /** matcher · backfill · chat */
    origin: text('origin').notNull(),
    /** unsure · suggested · added · in_vdp · dismissed */
    status: text('status').notNull().default('suggested'),
    /** [{source, label, url, at}] where it was shared (newest first, at most 8). */
    sources: jsonb('sources').$type<Array<Record<string, unknown>>>().notNull().default([]),
    sourceItemIds: textArray('source_item_ids'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    statusAt: tstz('status_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vdp_asset_candidates_owner_target_asset_uidx').on(t.ownerUserId, t.targetKey, t.assetKey),
    index('vdp_asset_candidates_owner_slug_idx').on(t.ownerUserId, t.vdpSlug),
    index('vdp_asset_candidates_account_idx').on(t.accountId),
    check('vdp_asset_candidates_status_chk', sql`${t.status} IN ('unsure', 'suggested', 'added', 'in_vdp', 'dismissed')`),
    check('vdp_asset_candidates_origin_chk', sql`${t.origin} IN ('matcher', 'backfill', 'chat')`),
  ],
);
