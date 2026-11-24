/**
 * D-70 landings (docs/design/landings.md): where every record lands, and every write that put it there.
 *
 *   use_cases         the app's own use case: one row per use case the app knows, whichever system it came from
 *                     (its VDP use case id and / or its Org62 Use_Case__c id, its account and opportunity). The one id
 *                     record_landings points at for kind `use_case`; it survives an Org62-only use case being added to
 *                     VDP (the identity row gains the VDP id, its landings stay).
 *   record_landings   one row per (owner, record kind, record id, destination): the destination's id once known, the
 *                     state (not_sent · staged · sent · verified · differs · missing) and the values the destination
 *                     held at the last read-back. A new kind or destination is a new value, never a new table.
 *   landing_writes    one row per create / update / delete the app staged (a logging canvas row, a VDP Outbox item, a
 *                     proposed Event update): before, after, reason. History: only its state (and, while it waits for
 *                     a canvas, the canvas it goes on) moves.
 *
 * Not audited (like org62_use_cases and vdp_records): the syncs (src/server/landings/sync.ts) write them from the
 * drafts, the read-backs and the mirror, inside a change set or outside one; nothing here is ever undone by hand.
 */
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id15, ownerUserId, tstz, updatedAt } from './columns';

export const useCases = pgTable(
  'use_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** The VDP use case (vdp-app's id), once VDP has it. */
    vdpUseCaseId: text('vdp_use_case_id'),
    /** The Org62 Use_Case__c (its 15-character id), once Org62 has it. */
    org62UseCaseId: text('org62_use_case_id'),
    vdpSlug: text('vdp_slug'),
    title: text('title').notNull().default(''),
    /** The app's account and opportunity it is attributed to (null until known). */
    accountId: uuid('account_id'),
    opportunityId: uuid('opportunity_id'),
    org62OpportunityId: text('org62_opportunity_id'),
    org62OpportunityId15: id15('org62_opportunity_id15', 'org62_opportunity_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('use_cases_owner_vdp_uidx').on(t.ownerUserId, t.vdpUseCaseId).where(sql`${t.vdpUseCaseId} is not null`),
    uniqueIndex('use_cases_owner_org62_uidx').on(t.ownerUserId, t.org62UseCaseId).where(sql`${t.org62UseCaseId} is not null`),
  ],
);

export const recordLandings = pgTable(
  'record_landings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** activity_event · deal_contribution · use_case · asset (a new kind is a new value). */
    recordKind: text('record_kind').notNull(),
    /** The app's own row (activity_entries.id, deal_contribution_requests.id, use_cases.id, the asset's key). */
    recordId: text('record_id').notNull(),
    /** org62 · vdp (a new system is a new value). */
    destination: text('destination').notNull(),
    externalId: text('external_id'),
    state: text('state').notNull().default('not_sent'),
    /** The destination's values at the last read-back: the fields the (kind, destination) field map compares. */
    remoteValues: jsonb('remote_values').$type<Record<string, string | null>>(),
    verifiedAt: tstz('verified_at'),
    lastReadAt: tstz('last_read_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('record_landings_owner_record_dest_uidx').on(t.ownerUserId, t.recordKind, t.recordId, t.destination),
    index('record_landings_owner_state_idx').on(t.ownerUserId, t.state),
    check('record_landings_state_chk', sql`${t.state} IN ('not_sent', 'staged', 'sent', 'verified', 'differs', 'missing')`),
  ],
);

export const landingWrites = pgTable(
  'landing_writes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    landingId: uuid('landing_id')
      .notNull()
      .references(() => recordLandings.id, { onDelete: 'cascade' }),
    /** The Outbox item or canvas that carries it; null while a proposed or approved write waits for a canvas. */
    draftId: uuid('draft_id'),
    /** The row's key on its canvas (`event:<id>`, `upd:Event:<id>:Duration__c`, `uc:<id>` …): how a sync finds it again. */
    rowKey: text('row_key').notNull(),
    op: text('op').notNull(),
    /** The destination's values when staged (null for a create). */
    before: jsonb('before').$type<Record<string, string | null>>(),
    /** What the write sends (an update: only the changed fields). */
    after: jsonb('after').$type<Record<string, string | null>>().notNull(),
    state: text('state').notNull(),
    /** canvas (a logging canvas row) · vdp (a VDP Outbox item) · proposed (an update the app suggests) · backfill */
    origin: text('origin').notNull().default('canvas'),
    reason: text('reason').notNull().default(''),
    sentAt: tstz('sent_at'),
    verifiedAt: tstz('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('landing_writes_landing_idx').on(t.landingId),
    index('landing_writes_draft_idx').on(t.draftId),
    index('landing_writes_owner_state_idx').on(t.ownerUserId, t.state),
    uniqueIndex('landing_writes_owner_draft_row_uidx').on(t.ownerUserId, t.draftId, t.rowKey).where(sql`${t.draftId} is not null`),
    check('landing_writes_op_chk', sql`${t.op} IN ('create', 'update', 'delete')`),
    check('landing_writes_state_chk', sql`${t.state} IN ('proposed', 'approved', 'dismissed', 'staged', 'sent', 'verified', 'failed', 'removed', 'rejected')`),
  ],
);
