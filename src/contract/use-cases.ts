/**
 * Use cases to add (src/engines/use-cases; holistic review 2026-11-20 lane 06 R6, H-9): use cases the app noticed in
 * Gemini notes, meetings, Slack and mail with a customer, staged for you instead of typed twice.
 *   GET  /use-cases/candidates          the ones waiting on you (with why, evidence, the opp or the rundown to pick from)
 *   POST /use-cases/candidates/:id      accept (drafts the VDP item and the Org62 canvas row) · edit · reject (why)
 *   POST /use-cases/candidates          add one by hand (deduped like the rest)
 *   POST /use-cases/candidates/refresh  read the sources again now (the db queues it for the worker)
 * Nothing here sends anything: Accept drafts two Outbox items, each applied by you (tenet: Nothing leaves without
 * approval).
 */
import { z } from 'zod';

import { RundownOpp } from './attribution';
import { Id, IsoDateTime } from './common';

export const UseCaseCandidateSource = z.enum(['gemini_note', 'meeting', 'slack_burst', 'mail_thread', 'manual']);
export type UseCaseCandidateSource = z.infer<typeof UseCaseCandidateSource>;

export const UseCaseCandidateStatus = z.enum(['suggested', 'accepted', 'edited', 'rejected', 'staged_org62', 'staged_vdp', 'landed']);
export type UseCaseCandidateStatus = z.infer<typeof UseCaseCandidateStatus>;

export const UseCaseRejectReason = z.enum(['not_use_case', 'wrong_opp', 'duplicate', 'already_in_org62']);
export type UseCaseRejectReason = z.infer<typeof UseCaseRejectReason>;

export const UseCaseEvidence = z.object({
  sourceItemId: z.string().nullable(),
  kind: UseCaseCandidateSource,
  /** The note's meeting, the channel, the subject. */
  label: z.string(),
  url: z.string().nullable(),
  at: IsoDateTime,
  /** The sentence it came from. */
  quote: z.string().nullable(),
});
export type UseCaseEvidence = z.infer<typeof UseCaseEvidence>;

/** Where each half stands: VDP (the Outbox item, then the mirror) and Org62 (the canvas row, then the read-back). */
export const UseCaseHalf = z.enum(['none', 'staged', 'on_canvas', 'sent', 'landed', 'not_needed']);
export type UseCaseHalf = z.infer<typeof UseCaseHalf>;

export const UseCaseCandidate = z.object({
  id: Id,
  source: UseCaseCandidateSource,
  title: z.string(),
  problem: z.string(),
  products: z.array(z.string()),
  outcome: z.string(),
  track: z.enum(['d360', 'agentforce']).nullable(),
  /** The VDP execution phase it sounds like (Discovery · Build · Live). */
  stageHint: z.string().nullable(),
  status: UseCaseCandidateStatus,
  rejectReason: UseCaseRejectReason.nullable(),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  oppId: Id.nullable(),
  oppName: z.string().nullable(),
  /** The engine's confidence in the opp (0–1). */
  confidence: z.number().min(0).max(1),
  /** Why that opp, in words (the attribution engine's reasons). */
  why: z.array(z.string()),
  /** The engine is unsure of the opp: pick one of `alternates` (the rundown's top 3). */
  needsPick: z.boolean(),
  alternates: z.array(RundownOpp),
  /** rules: the deterministic extractor; ai: the model confirmed and worded it. */
  basis: z.enum(['rules', 'ai']),
  evidence: z.array(UseCaseEvidence),
  vdpSlug: z.string().nullable(),
  vdpDraftId: Id.nullable(),
  org62UseCaseId: z.string().nullable(),
  vdpUseCaseId: z.string().nullable(),
  org62: UseCaseHalf,
  vdp: UseCaseHalf,
  /** What Accept stages, in words ("VDP item + Org62 row on your next canvas"), or why it can't. */
  sends: z.string().nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type UseCaseCandidate = z.infer<typeof UseCaseCandidate>;

const N = z.number().int().min(0);

export const UseCaseCandidatesPayload = z.object({
  /** The persona has VDP use cases (the feature gate); off: the list is empty. */
  enabled: z.boolean(),
  /** Waiting on you (suggested, edited), newest evidence first. */
  candidates: z.array(UseCaseCandidate),
  /** Decided in the last 30 days (accepted, staged, landed, rejected). */
  decided: z.array(UseCaseCandidate),
  counts: z.object({ toAdd: N, needsPick: N, staged: N, landed: N }),
  /** When the sources were last read for use cases (null: never). */
  generatedAt: IsoDateTime.nullable(),
});
export type UseCaseCandidatesPayload = z.infer<typeof UseCaseCandidatesPayload>;

const Products = z.array(z.string().trim().min(2).max(60)).max(6);

export const DecideUseCaseCandidateRequest = z
  .object({
    decision: z.enum(['accept', 'edit', 'reject']),
    /** The opp it goes on (the picker's choice); a pick of another opp teaches the engine. */
    oppId: Id.nullable().optional(),
    title: z.string().trim().min(3).max(120).optional(),
    problem: z.string().max(2000).optional(),
    products: Products.optional(),
    outcome: z.string().max(1000).optional(),
    track: z.enum(['d360', 'agentforce']).nullable().optional(),
    /** Reject: why (a wrong opp with `oppId` moves it there instead). */
    reason: UseCaseRejectReason.optional(),
  })
  .refine((b) => b.decision !== 'reject' || !!b.reason, { message: 'say why it is rejected', path: ['reason'] });
export type DecideUseCaseCandidateRequest = z.infer<typeof DecideUseCaseCandidateRequest>;

export const DecideUseCaseCandidateResult = z.object({
  candidate: UseCaseCandidate,
  /** The VDP Outbox item Accept drafted (null: none). */
  vdpDraftId: Id.nullable(),
  /** Accept put an Org62 row on the next logging canvas. */
  org62Staged: z.boolean(),
});
export type DecideUseCaseCandidateResult = z.infer<typeof DecideUseCaseCandidateResult>;

export const AddUseCaseCandidateRequest = z.object({
  title: z.string().trim().min(3).max(120),
  problem: z.string().max(2000).optional(),
  products: Products.optional(),
  outcome: z.string().max(1000).optional(),
  oppId: Id.nullable().optional(),
  accountId: Id.nullable().optional(),
  track: z.enum(['d360', 'agentforce']).nullable().optional(),
});
export type AddUseCaseCandidateRequest = z.infer<typeof AddUseCaseCandidateRequest>;

export const AddUseCaseCandidateResult = z.object({
  candidate: UseCaseCandidate,
  /** It matched one that exists: its evidence was added there instead (where: candidate · use_case · org62 · vdp). */
  matched: z.enum(['candidate', 'use_case', 'org62', 'vdp']).nullable(),
});
export type AddUseCaseCandidateResult = z.infer<typeof AddUseCaseCandidateResult>;

export const RefreshUseCaseCandidatesResult = z.object({ queued: z.boolean(), candidates: N, note: z.string().nullable() });
export type RefreshUseCaseCandidatesResult = z.infer<typeof RefreshUseCaseCandidatesResult>;
