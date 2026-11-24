/**
 * 0036 (D-98, holistic review 09 R3/R4): the VDP mirror's child tables and the inbound mirror convention.
 *
 * Mirror convention (every external object read into a typed table):
 *   - one `mirror_reads` row per read: source, scope, when, how many rows, a hash over what it saw, complete or not;
 *   - each mirrored row carries `mirrored_at` (the read that last wrote it); a parent the upstream can drop carries
 *     `gone_at` (a complete read no longer listed it: kept, never deleted).
 *
 *   vdp_use_cases        one row per use case on a VDP of mine (was only `vdp_records.detail.useCases[]`)
 *   vdp_assets           one row per asset on a VDP (was `detail.assets[]`)
 *   vdp_members          AEs, TAs, collaborators and the creator, in their order (was `detail.aes/tas/...`)
 *   vdp_use_case_phases  stage history: one row each time a read saw a use case's execution phase change
 *   mirror_reads         one row per read of an external system (VDP today; the Org62 readers adopt it next)
 *
 * State of an external system: not audited (like vdp_records); `scan.vdp` replaces the children of each VDP it read.
 * `vdp_records.detail` stays the raw payload for one release (D-98: dropped in 2.1 once nothing reads it).
 */
import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, index, integer, jsonb, numeric, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, ownerUserId, tstz } from './columns';
import { vdpRecords } from './entities';

const vdpRecordId = () =>
  uuid('vdp_record_id')
    .notNull()
    .references(() => vdpRecords.id, { onDelete: 'cascade' });

export const vdpUseCases = pgTable(
  'vdp_use_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    vdpRecordId: vdpRecordId(),
    /** The use case's id in vdp-app. */
    vdpUseCaseId: text('vdp_use_case_id').notNull(),
    /** Position in the VDP's list as read (reads keep VDP's order). */
    ordinal: smallint('ordinal').notNull(),
    track: text('track').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    title: text('title'),
    priority: text('priority'),
    division: text('division'),
    persona: text('persona'),
    detailsInput: text('details_input'),
    executionPhase: text('execution_phase'),
    executionStartDate: text('execution_start_date'),
    executionTargetDate: text('execution_target_date'),
    executionDurationValue: numeric('execution_duration_value', { mode: 'number' }),
    executionDurationUnit: text('execution_duration_unit'),
    hasAi: boolean('has_ai').notNull().default(false),
    generatedFields: jsonb('generated_fields').$type<Record<string, unknown>>(),
    painThemeId: text('pain_theme_id'),
    sourceLibraryId: text('source_library_id'),
    vdpCreatedAt: text('vdp_created_at'),
    vdpUpdatedAt: text('vdp_updated_at'),
    detailLoaded: boolean('detail_loaded').notNull().default(false),
    mirroredAt: tstz('mirrored_at').notNull(),
  },
  (t) => [uniqueIndex('vdp_use_cases_record_uc_uidx').on(t.vdpRecordId, t.vdpUseCaseId), index('vdp_use_cases_owner_uc_idx').on(t.ownerUserId, t.vdpUseCaseId)],
);

export const vdpAssets = pgTable(
  'vdp_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    vdpRecordId: vdpRecordId(),
    vdpAssetId: text('vdp_asset_id').notNull(),
    ordinal: smallint('ordinal').notNull(),
    title: text('title'),
    url: text('url').notNull(),
    type: text('type'),
    description: text('description'),
    /** The asset's Deliverable; `deliverable_read` false = the read did not carry the field (absent, not untagged). */
    deliverableType: text('deliverable_type'),
    deliverableRead: boolean('deliverable_read').notNull().default(false),
    mirroredAt: tstz('mirrored_at').notNull(),
  },
  (t) => [uniqueIndex('vdp_assets_record_ordinal_uidx').on(t.vdpRecordId, t.ordinal), index('vdp_assets_owner_url_idx').on(t.ownerUserId, t.url)],
);

export const vdpMembers = pgTable(
  'vdp_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    vdpRecordId: vdpRecordId(),
    /** ae · ta · collaborator · creator */
    role: text('role').notNull(),
    ordinal: smallint('ordinal').notNull(),
    email: text('email'),
    name: text('name'),
    placeholder: boolean('placeholder').notNull().default(false),
    mirroredAt: tstz('mirrored_at').notNull(),
  },
  (t) => [
    uniqueIndex('vdp_members_record_role_ordinal_uidx').on(t.vdpRecordId, t.role, t.ordinal),
    index('vdp_members_owner_email_idx').on(t.ownerUserId, sql`lower(${t.email})`),
    check('vdp_members_role_chk', sql`${t.role} IN ('ae', 'ta', 'collaborator', 'creator')`),
  ],
);

export const vdpUseCasePhases = pgTable(
  'vdp_use_case_phases',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    vdpRecordId: vdpRecordId(),
    vdpUseCaseId: text('vdp_use_case_id').notNull(),
    /** The phase the read saw (null: VDP holds none). */
    phase: text('phase'),
    observedAt: tstz('observed_at').notNull(),
  },
  (t) => [index('vdp_use_case_phases_record_uc_idx').on(t.vdpRecordId, t.vdpUseCaseId, t.observedAt)],
);

export const mirrorReads = pgTable(
  'mirror_reads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: ownerUserId(),
    /** vdp · org62 (a new system is a new value). */
    source: text('source').notNull(),
    /** What was read: `my_vdps`, `opp_use_cases`, … */
    scope: text('scope').notNull(),
    readAt: tstz('read_at').notNull(),
    rows: integer('rows').notNull().default(0),
    /** Every row of this scope was read (rows it no longer lists are gone). */
    complete: boolean('complete').notNull().default(false),
    /** sha256 (hex, first 16) over what the read saw, in order: an unchanged read has the same hash. */
    hash: text('hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('mirror_reads_owner_source_scope_idx').on(t.ownerUserId, t.source, t.scope, t.readAt)],
);
