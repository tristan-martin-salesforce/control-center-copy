/**
 * use_case_candidates (migration 0034; holistic review 2026-11-20 lane 06 R6, src/engines/use-cases): the use cases
 * the app noticed in Gemini notes, meetings, Slack bursts and mail threads with a customer, one row per use case:
 * its source and evidence (source item ids and the sentence), the opp and account `attribute()` chose with confidence
 * and why (or the rundown's top 3 when unsure), the use case's words (title, problem, products, outcome, track, stage
 * hint), its status (suggested · edited · accepted · staged_org62 · staged_vdp · landed · rejected, with why), the
 * Org62 use case id and VDP use case id once landed, the VDP Outbox item Accept drafted, and the dedupe key
 * (opp · product · problem key). A row that matched a use case that exists (`matched_kind`) is that use case's
 * evidence ledger (status landed) and is never listed as one to add.
 *
 * Audited (like dc_suggestions): Accept / Edit / Reject are change sets, so Undo restores the candidate together with
 * the VDP Outbox item and the learned rules written in the same change set.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { UcAttribution, UcEvidence } from '@/engines/use-cases';
import type { Reason, Signal } from '@/engines/attribution/types';

import { createdAt, ownerUserId, tstz, updatedAt } from './columns';
import { accounts, opportunities } from './entities';

export const useCaseCandidates = pgTable(
  'use_case_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** gemini_note · meeting · slack_burst · mail_thread · manual */
    source: text('source').notNull(),
    /** The source's key (a source item id, a Slack or mail thread ref). */
    sourceKey: text('source_key').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    why: jsonb('why').$type<Reason[]>().notNull().default([]),
    needsPick: boolean('needs_pick').notNull().default(false),
    alternates: jsonb('alternates').$type<UcAttribution['alternates']>().notNull().default([]),
    title: text('title').notNull(),
    problem: text('problem').notNull().default(''),
    products: jsonb('products').$type<string[]>().notNull().default([]),
    outcome: text('outcome').notNull().default(''),
    track: text('track'),
    stageHint: text('stage_hint'),
    status: text('status').notNull().default('suggested'),
    rejectReason: text('reject_reason'),
    /** rules (the deterministic extractor) · ai (the model confirmed and worded it). */
    basis: text('basis').notNull().default('rules'),
    dedupeKey: text('dedupe_key').notNull(),
    problemKey: text('problem_key').notNull().default(''),
    evidence: jsonb('evidence').$type<UcEvidence[]>().notNull().default([]),
    /** The signal the opp was attributed from (what a correction teaches the attribution engine). */
    signal: jsonb('signal').$type<Signal | null>(),
    /** It matched a use case that exists: use_case · org62 · vdp (then this row is that use case's evidence). */
    matchedKind: text('matched_kind'),
    useCaseId: uuid('use_case_id'),
    org62UseCaseId: text('org62_use_case_id'),
    vdpUseCaseId: text('vdp_use_case_id'),
    vdpSlug: text('vdp_slug'),
    /** The VDP create_use_case Outbox item Accept drafted (drafts.id). */
    vdpDraftId: uuid('vdp_draft_id'),
    decidedAt: tstz('decided_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('use_case_candidates_owner_dedupe_uidx').on(t.ownerUserId, t.dedupeKey),
    index('use_case_candidates_owner_status_idx').on(t.ownerUserId, t.status),
    index('use_case_candidates_title_trgm_idx').using('gin', sql`lower(${t.title}) gin_trgm_ops`),
    check('use_case_candidates_status_chk', sql`${t.status} IN ('suggested', 'accepted', 'edited', 'rejected', 'staged_org62', 'staged_vdp', 'landed')`),
    check('use_case_candidates_source_chk', sql`${t.source} IN ('gemini_note', 'meeting', 'slack_burst', 'mail_thread', 'manual')`),
    check('use_case_candidates_reject_reason_chk', sql`${t.rejectReason} IS NULL OR ${t.rejectReason} IN ('not_use_case', 'wrong_opp', 'duplicate', 'already_in_org62')`),
    check('use_case_candidates_track_chk', sql`${t.track} IS NULL OR ${t.track} IN ('d360', 'agentforce')`),
  ],
);
