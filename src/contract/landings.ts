/**
 * D-70 landings (docs/design/landings.md): where every record lands (Org62, VDP, later others) and every write that put
 * it there. A logging canvas is one draft holding many writes; a use case lands in both systems; an update reads as
 * "update · Duration 2 h → 3 h". A new destination or record kind is a new value plus a field map
 * (src/lib/landings/fields.ts), never a new table.
 */
import { z } from 'zod';

import { Id, IsoDateTime } from './common';
import { UseCaseState } from './deals';

/** What the app keeps a landing for. */
export const RecordKind = z.enum(['activity_event', 'deal_contribution', 'use_case', 'asset']);
export type RecordKind = z.infer<typeof RecordKind>;

/** Where it lands. */
export const LandingDestination = z.enum(['org62', 'vdp']);
export type LandingDestination = z.infer<typeof LandingDestination>;

/**
 * not_sent · staged (on a canvas or Outbox item waiting for Apply) · sent (applied, not yet seen) · verified (read back
 * and matching) · differs (read back, and it disagrees with the app or, for a use case, with the other system) ·
 * missing (sent, never seen; or deleted there).
 */
export const LandingState = z.enum(['not_sent', 'staged', 'sent', 'verified', 'differs', 'missing']);
export type LandingState = z.infer<typeof LandingState>;

/**
 * proposed (an update the app suggests: approve or dismiss) · approved (yours, waiting for the next canvas) · dismissed ·
 * staged · sent · verified · failed · removed (taken off the canvas before Apply, or its batch undone) · rejected.
 */
export const WriteState = z.enum(['proposed', 'approved', 'dismissed', 'staged', 'sent', 'verified', 'failed', 'removed', 'rejected']);
export type WriteState = z.infer<typeof WriteState>;

export const WriteOp = z.enum(['create', 'update', 'delete']);
export type WriteOp = z.infer<typeof WriteOp>;

/** canvas (a logging canvas row) · vdp (a VDP Outbox item) · proposed (an update the app suggested) · backfill (from before D-70). */
export const WriteOrigin = z.enum(['canvas', 'vdp', 'proposed', 'backfill']);
export type WriteOrigin = z.infer<typeof WriteOrigin>;

/** One field a write carries, as its destination names it, with a label and the values before → after (null = empty). */
export const WriteField = z.object({ field: z.string(), label: z.string(), before: z.string().nullable(), after: z.string().nullable() });
export type WriteField = z.infer<typeof WriteField>;

export const LandingWrite = z.object({
  id: Id,
  landingId: Id,
  recordKind: RecordKind,
  recordId: z.string(),
  destination: LandingDestination,
  /** What it writes, in words: the Event's subject, the use case's name, the opp of a DC. */
  label: z.string(),
  draftId: Id.nullable(),
  draftTitle: z.string().nullable(),
  rowKey: z.string(),
  op: WriteOp,
  state: WriteState,
  origin: WriteOrigin,
  reason: z.string(),
  /** The fields as sent (an update: only the changed ones, each before → after). */
  fields: z.array(WriteField),
  /** "create · Duration 2 h" · "update · Duration 2 h → 3 h". */
  summary: z.string(),
  createdAt: IsoDateTime,
  sentAt: IsoDateTime.nullable(),
  verifiedAt: IsoDateTime.nullable(),
});
export type LandingWrite = z.infer<typeof LandingWrite>;

export const Landing = z.object({
  id: Id,
  recordKind: RecordKind,
  recordId: z.string(),
  destination: LandingDestination,
  externalId: z.string().nullable(),
  /** The record in its destination, when the app can link it. */
  url: z.string().nullable(),
  state: LandingState,
  /** The destination's values at the last read-back (the fields the field map compares); null: never read. */
  remoteValues: z.record(z.string(), z.string().nullable()).nullable(),
  verifiedAt: IsoDateTime.nullable(),
  lastReadAt: IsoDateTime.nullable(),
});
export type Landing = z.infer<typeof Landing>;

/** GET /landings/records?kind=&id=: one record's landings, each with its writes (newest first). */
export const RecordLandingsQuery = z.object({ kind: RecordKind, id: z.string().min(1).max(200) });
export type RecordLandingsQuery = z.infer<typeof RecordLandingsQuery>;

export const RecordLandings = z.object({
  recordKind: RecordKind,
  recordId: z.string(),
  landings: z.array(Landing.extend({ writes: z.array(LandingWrite) })),
});
export type RecordLandings = z.infer<typeof RecordLandings>;

/** GET /time/canvases/:id/writes: a logging run, its writes exactly as sent (and the ones taken off it). */
export const CanvasWrites = z.object({
  draftId: Id,
  title: z.string(),
  /** The canvas item's own status (drafts), or `gone` when the item no longer exists (its batch was undone). */
  status: z.string(),
  appliedAt: IsoDateTime.nullable(),
  writes: z.array(LandingWrite),
  counts: z.object({ create: z.number().int(), update: z.number().int(), delete: z.number().int(), removed: z.number().int() }),
});
export type CanvasWrites = z.infer<typeof CanvasWrites>;

// ---------------------------------------------------------------------------
// Event updates: the re-derive's candidates, approvable like any row
// ---------------------------------------------------------------------------

/**
 * One update to an Event already in Org62 (another lane's re-derive proposes them): the row, its Org62 Event, the field
 * (Org62's name, e.g. Duration__c; `duration`, `taskType`, `opp` are accepted too), the value there now and the value
 * it should have, and why ("re-derived: hands-on 2 h → 3 h").
 */
export const EventUpdateCandidate = z.object({
  activityEntryId: Id,
  org62EventId: z.string().min(15).max(18),
  field: z.string().min(1).max(80),
  // the re-derive gives Duration__c as numbers (0.25 → 5.25); the canvas writes text: both are accepted
  from: z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(2000)),
  to: z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(2000)),
  reason: z.string().max(500),
});
export type EventUpdateCandidate = z.infer<typeof EventUpdateCandidate>;

export const ProposeEventUpdatesRequest = z.object({ candidates: z.array(EventUpdateCandidate).min(1).max(2000) });
export type ProposeEventUpdatesRequest = z.infer<typeof ProposeEventUpdatesRequest>;

export const ProposeEventUpdatesResult = z.object({
  proposed: z.array(Id),
  /** Left out, each with why (the same update is already on its way, an unknown row, a field no canvas writes). */
  skipped: z.array(z.object({ activityEntryId: z.string(), field: z.string(), why: z.string() })),
});
export type ProposeEventUpdatesResult = z.infer<typeof ProposeEventUpdatesResult>;

/** One proposed or approved Event update, as Log it lists it. */
export const EventUpdateRow = z.object({
  writeId: Id,
  activityEntryId: z.string(),
  org62EventId: z.string(),
  /** The row's subject and day (from Time), when the app still has the row. */
  label: z.string(),
  date: z.string().nullable(),
  field: z.string(),
  fieldLabel: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** "update · Duration 2 h → 3 h" */
  summary: z.string(),
  reason: z.string(),
  state: z.enum(['proposed', 'approved', 'dismissed']),
  createdAt: IsoDateTime,
});
export type EventUpdateRow = z.infer<typeof EventUpdateRow>;

export const EventUpdatesPayload = z.object({ updates: z.array(EventUpdateRow) });
export type EventUpdatesPayload = z.infer<typeof EventUpdatesPayload>;

/** Approve (it goes on the next canvas), dismiss, or bring a dismissed one back as proposed. */
export const PatchEventUpdateRequest = z.object({ action: z.enum(['approve', 'dismiss', 'restore']) });
export type PatchEventUpdateRequest = z.infer<typeof PatchEventUpdateRequest>;

// ---------------------------------------------------------------------------
// Use cases in Org62 and VDP: neither, one or both, and where they differ
// ---------------------------------------------------------------------------

/** The fields compared across the two systems, in shared terms (src/lib/landings/fields.ts maps each side's). */
export const UseCaseField = z.enum(['name', 'product', 'stage', 'goLive']);
export type UseCaseField = z.infer<typeof UseCaseField>;

export const UseCaseDifference = z.object({
  field: UseCaseField,
  label: z.string(),
  /** Each side's value, in its own terms (Org62's Stage__c "U05 - Implementation", VDP's phase "Build"). */
  org62: z.string(),
  vdp: z.string(),
  /** Which side changed since they last agreed (D-67 synced_*): unknown when they never agreed. */
  changed: z.enum(['org62', 'vdp', 'both', 'unknown']),
  /** Your pick of the right value (null: not picked). */
  pick: z.enum(['org62', 'vdp']).nullable(),
  /** What happens next, in words ("Org62 follows on your next canvas", "VDP follows: push it in VDP ▸ Changes"). */
  next: z.string(),
  /** Whether each value can be taken (written to the other side by the app), else why not. */
  take: z.object({ org62: z.string().nullable(), vdp: z.string().nullable() }),
});
export type UseCaseDifference = z.infer<typeof UseCaseDifference>;

/** A use case's question for Needs you (null: none). */
export const UseCaseQuestion = z.object({
  code: z.enum(['pick_opp', 'no_title', 'no_account', 'waiting_dc', 'pick_value']),
  text: z.string(),
  /** pick_opp: the opportunities it can go on (open, your 100% DC), each with its Org62 id. */
  opps: z.array(z.object({ org62Id: z.string(), name: z.string() })).default([]),
  /**
   * The app suggested this use case (a use-case candidate you accepted, src/engines/use-cases): which one, and for
   * pick_opp the opp it was accepted on when that is one of `opps` (the pre-fill, never applied for you).
   */
  suggested: z.object({ candidateId: z.string(), org62Id: z.string().nullable(), why: z.string() }).nullable().optional(),
});
export type UseCaseQuestion = z.infer<typeof UseCaseQuestion>;

export const UseCaseAssetRow = z.object({
  /** The landing's record id (an asset candidate's id, or `vdpasset:<id>` for one only VDP has). */
  id: z.string(),
  title: z.string(),
  url: z.string(),
  kind: z.string().nullable(),
  /** in VDP · added (waiting for the read) · suggested (not in VDP) */
  state: LandingState,
  words: z.string(),
});
export type UseCaseAssetRow = z.infer<typeof UseCaseAssetRow>;

export const UseCaseLanding = z.object({
  /** The app's use case (use_cases.id). */
  id: Id,
  /** The round trip's key (`uc:<VDP id>` / `rec:<Use_Case__c id>`): decisions, overrides and Log it ticks use it. */
  key: z.string(),
  title: z.string(),
  track: z.string(),
  companyName: z.string(),
  vdpSlug: z.string().nullable(),
  vdpUrl: z.string().nullable(),
  vdpUseCaseId: z.string().nullable(),
  org62UseCaseId: z.string().nullable(),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  oppId: Id.nullable(),
  oppName: z.string().nullable(),
  org62OpportunityId: z.string().nullable(),
  org62: Landing.nullable(),
  vdp: Landing.nullable(),
  /** In which systems it is: both · org62 · vdp · neither. */
  where: z.enum(['both', 'org62', 'vdp', 'neither']),
  /** The D-67 round trip's state and why. */
  state: UseCaseState,
  why: z.string(),
  /** It goes on your next canvas (a create, or a field fix): a row in Log it ▸ Ready to log. */
  ready: z.boolean(),
  /** What a create or fix sends, in words ("new in Org62 on <opp>", "Stage U03 → U05"). */
  sends: z.string().nullable(),
  question: UseCaseQuestion.nullable(),
  differences: z.array(UseCaseDifference),
  assets: z.array(UseCaseAssetRow),
  writes: z.array(LandingWrite),
  canvasDraftId: Id.nullable(),
});
export type UseCaseLanding = z.infer<typeof UseCaseLanding>;

const N = z.number().int().min(0);

export const UseCaseLandingsPayload = z.object({
  /** When Org62's use cases were last read (null: never). */
  readAt: IsoDateTime.nullable(),
  items: z.array(UseCaseLanding),
  counts: z.object({ both: N, org62: N, vdp: N, neither: N, differs: N, ready: N, questions: N }),
});
export type UseCaseLandingsPayload = z.infer<typeof UseCaseLandingsPayload>;

/** Pick the right value of one field: the other side is corrected (an Org62 UPDATE on the next canvas, or a VDP change to push). Null clears the pick. */
export const PickUseCaseValueRequest = z.object({ field: UseCaseField, take: z.enum(['org62', 'vdp']).nullable() });
export type PickUseCaseValueRequest = z.infer<typeof PickUseCaseValueRequest>;

/** Answer a use case's question: the opp it goes on (an Org62 006… id), a name when VDP has none, or leave it out of Org62 (and undo that). */
export const FixUseCaseRequest = z
  .object({
    opportunityId: z.string().min(15).max(18).nullable().optional(),
    name: z.string().trim().min(1).max(255).nullable().optional(),
    leave: z.boolean().optional(),
  })
  .refine((b) => b.opportunityId !== undefined || b.name !== undefined || b.leave !== undefined, { message: 'set the opportunity, the name, or leave' });
export type FixUseCaseRequest = z.infer<typeof FixUseCaseRequest>;

export const UseCaseKeyParams = z.object({ key: z.string().min(3).max(200) });
export type UseCaseKeyParams = z.infer<typeof UseCaseKeyParams>;
