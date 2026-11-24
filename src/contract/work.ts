/**
 * Work items, initiatives, evidence, proposals, assets and people.
 */
import { z } from 'zod';
import {
  Confidence,
  Effort,
  EntityRef,
  EvidenceRole,
  FieldChange,
  Id,
  IsoDate,
  IsoDateTime,
  PersonRef,
  SourceKind,
  SourceRef,
  Url,
  Version,
  WorkKind,
  WorkState,
} from './common';
import { ReadInState } from './readin';
import { ClosingReason } from './settings';

// ---------------------------------------------------------------------------
// People and assets
// ---------------------------------------------------------------------------

/** `people.tier`: stakeholder importance (D-24 VIP list), an input to priority (lane 07 R2). */
export const StakeholderTier = z.enum(['leader', 'manager', 'ae', 'teammate', 'customer_exec', 'customer', 'partner', 'normal', 'low']);
export type StakeholderTier = z.infer<typeof StakeholderTier>;

export const Person = PersonRef.extend({
  email: z.string().optional(),
  slackHandle: z.string().optional(),
  accountId: Id.nullable().default(null),
  title: z.string().optional(),
  /** Absent = the default tier (`normal`). */
  tier: StakeholderTier.optional(),
});
export type Person = z.infer<typeof Person>;

/**
 * GET /people row (CONTRACT-1): what the composer's @-mentions and recipient pickers need. `slackId` is the
 * Slack user id a mention serializes to (`<@U…>`); null when the person is not on Slack.
 */
export const PersonView = z.object({
  id: Id,
  name: z.string(),
  email: z.string().nullable(),
  slackId: z.string().nullable(),
  role: z.string().nullable(),
  title: z.string().nullable(),
  account: EntityRef.nullable(),
  /** Explicit flag, else an email domain other than mine. */
  isExternal: z.boolean(),
  isManager: z.boolean(),
});
export type PersonView = z.infer<typeof PersonView>;

export const PeoplePayload = z.object({ q: z.string(), people: z.array(PersonView), total: z.number().int() });
export type PeoplePayload = z.infer<typeof PeoplePayload>;

export const AssetKind = z.enum(['slides', 'doc', 'sheet', 'pdf', 'folder', 'demo_org', 'claude_session', 'tool_output', 'canvas', 'link']);
export type AssetKind = z.infer<typeof AssetKind>;

export const Asset = z.object({
  id: Id,
  kind: AssetKind,
  title: z.string(),
  url: Url.optional(),
  source: SourceKind,
  updatedAt: IsoDateTime.optional(),
  updatedBy: z.string().optional(),
  initiativeId: Id.nullable().default(null),
  accountId: Id.nullable().default(null),
  workItemIds: z.array(Id).default([]),
});
export type Asset = z.infer<typeof Asset>;

// ---------------------------------------------------------------------------
// Work item
// ---------------------------------------------------------------------------

/** One contributor to an item's rank, phrased in terms of THIS user's policy (R-UI-16). */
export const RankReason = z.object({
  key: z.string(), // a PolicyWeightKey or `rule:<id>` or `boost`
  label: z.string(), // "Customer-facing", "ACME demo in 3h", "Rule: manager asks within 24h"
  contribution: z.number(),
});
export type RankReason = z.infer<typeof RankReason>;

/** Inputs the priority engine scores. Authored by extractors; the mock reads them deterministically. */
export const RankSignals = z.object({
  customerFacing: z.boolean().default(false),
  fromManager: z.boolean().default(false),
  /** Manual nudge for seeds and tests (positive = higher). */
  boost: z.number().default(0),
});
export type RankSignals = z.infer<typeof RankSignals>;

export const StaleMark = z.object({
  connectorId: Id,
  reason: z.string(), // "Gmail needs re-auth: email after 09:40 may be missing"
  since: IsoDateTime,
});
export type StaleMark = z.infer<typeof StaleMark>;

export const WaitingInfo = z.object({
  on: z.enum(['me', 'others']),
  reason: z.string(), // "Session asked: which org alias?" / "Waiting on Dana for SOW"
  who: PersonRef.optional(),
  since: IsoDateTime,
  runId: Id.optional(), // linked agent run when waiting on me
});
export type WaitingInfo = z.infer<typeof WaitingInfo>;

export const EnrichmentChip = z.object({
  id: Id,
  kind: z.enum(['claude_session', 'asset', 'slack_thread', 'email_thread', 'opportunity', 'account', 'person', 'meeting']),
  label: z.string(), // "Claude session 'Demo gap notes' (Nov 4)"
  reason: z.string(), // one-line match reason
  ref: EntityRef.optional(),
  url: Url.optional(),
  status: z.enum(['suggested', 'accepted', 'rejected']).default('suggested'),
});
export type EnrichmentChip = z.infer<typeof EnrichmentChip>;

export const Enrichment = z.object({
  status: z.enum(['idle', 'enriching', 'done']),
  startedAt: IsoDateTime.nullable().default(null),
  chips: z.array(EnrichmentChip).default([]),
});
export type Enrichment = z.infer<typeof Enrichment>;

/** Drive-backed deliverable state (R-UI-15). */
export const DeliverableInfo = z.object({
  assetId: Id.optional(),
  fileName: z.string(),
  mimeKind: z.enum(['slides', 'doc', 'sheet', 'pdf']),
  url: Url.optional(),
  lastEditedAt: IsoDateTime.nullable(),
  lastEditedBy: z.string().nullable(),
  changedSinceCreated: z.boolean(),
  diffSummary: z.string().nullable(),
  judgment: z
    .object({
      verdict: z.enum(['not_started', 'in_progress', 'partial', 'complete', 'regressed', 'unclear']),
      summary: z.string(), // "3 of 4 requested updates made; pricing slide still old"
      requested: z.number().int(),
      made: z.number().int(),
    })
    .nullable(),
});
export type DeliverableInfo = z.infer<typeof DeliverableInfo>;

export const TrainingInfo = z.object({
  course: z.string(),
  provider: z.string(), // "Trailhead", "Field Readiness"
  minutes: z.number().int(),
  dueDate: IsoDate.nullable(),
  overdue: z.boolean(),
  url: Url.optional(),
});
export type TrainingInfo = z.infer<typeof TrainingInfo>;

export const NotNowReason = z.enum(['done_elsewhere', 'not_mine', 'later', 'wrong_account', 'other']);
export type NotNowReason = z.infer<typeof NotNowReason>;

/** How a closed item was resolved (R-UI-22). Null while the item is open. */
export const Resolution = z.enum(['done_by_me', 'handed_off', 'done_by_other', 'not_needed', 'duplicate', 'declined', 'superseded']);
export type Resolution = z.infer<typeof Resolution>;

/** My involvement in the item. A hand-off makes the teammate the owner and me a watcher (or not involved). */
export const Involvement = z.enum(['owner', 'contributor', 'watcher', 'not_involved']);
export type Involvement = z.infer<typeof Involvement>;

export const ResolutionDetail = z.object({
  /** handed_off → the new owner; done_by_other → who did it. */
  personId: Id.optional(),
  personName: z.string().optional(),
  /** duplicate / superseded → the surviving item. */
  relatedItemId: Id.optional(),
  note: z.string().optional(),
  /** True when an engine inferred the reason from evidence (auto-closures always carry one). */
  inferred: z.boolean(),
  evidenceIds: z.array(Id).optional(),
  /** SETTLE-1: why the app closed it for you: the reason class, the check's confidence and the message that settled it. */
  settle: z.object({ reason: ClosingReason, confidence: z.number().min(0).max(1), sourceUrl: z.string().optional(), check: z.string() }).optional(),
});
export type ResolutionDetail = z.infer<typeof ResolutionDetail>;

/** Set when a direct ask of me re-involves me on a handed-off item ("Looped back in: Dana asked you directly"). */
export const LoopedBackIn = z.object({
  at: IsoDateTime,
  byPersonName: z.string(),
  evidenceId: Id.nullable(),
});
export type LoopedBackIn = z.infer<typeof LoopedBackIn>;

/** Fields a user edit locks; engines must then propose (ProposalDiff) instead of writing. */
export const WorkItemLockableField = z.enum(['title', 'purpose', 'due', 'startBy', 'effort', 'notes', 'initiativeId', 'accountId', 'oppId', 'state', 'kind']);
export type WorkItemLockableField = z.infer<typeof WorkItemLockableField>;

/** The stored record (seed and DB row shape). Views add `refs` (see WorkItem). */
export const WorkItemRecord = z.object({
  id: Id,
  version: Version,
  kind: WorkKind,
  state: WorkState,
  title: z.string().min(1), // verb-first
  /** "For: ACME demo Thu 14:00" — what the task is for (UI-SPEC §1.13). */
  purpose: z.string().nullable(),
  initiativeId: Id.nullable(),
  accountId: Id.nullable(),
  oppId: Id.nullable(),
  /** The meeting this item serves (drives meeting proximity and lead time). */
  servesEventId: Id.nullable().default(null),
  confidence: Confidence,
  /** ONE line (UI-SPEC §1.3). */
  why: z.string(),
  /** Full reasoning shown on hover or `?`. */
  whyDetail: z.string().nullable().default(null),
  sources: z.array(SourceRef),
  effort: Effort,
  startBy: IsoDateTime.nullable(),
  due: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Days since the item (or the promise) was created. */
  ageDays: z.number().int().min(0),
  /** A commitment that is old and low priority: the UI labels it "Promise" (shelf + Work ▸ Promises). */
  isBackground: z.boolean().default(false),
  /** 1-based position among ranked actionable items; null when not ranked (suggested, done, background…). */
  rank: z.number().int().min(1).nullable(),
  rankReasons: z.array(RankReason),
  score: z.number().nullable().default(null),
  /**
   * Derived view field (lane 07 R2): high for ranks 1-5, medium for 6-15, low below, medium while unranked. It is
   * never stored; `importance` holds the extractor's judgment and no re-rank writes it.
   */
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  /**
   * `work_items.importance`: the extractor's (or your) judgment, an input to priority. Never a function of rank.
   * Absent = normal (additive: older records and seeds carry none).
   */
  importance: z.enum(['critical', 'high', 'normal', 'low']).optional(),
  /** `work_items.due_kind`: hard, soft or inferred. Absent = hard (or no due date). Soft and inferred dates decay at once when passed. */
  dueKind: z.enum(['hard', 'soft', 'inferred']).optional(),
  signals: RankSignals.default({ customerFacing: false, fromManager: false, boost: 0 }),
  stale: StaleMark.nullable().default(null),
  userLockedFields: z.array(WorkItemLockableField).default([]),
  newEvidenceCount: z.number().int().min(0).default(0),
  /** True while the backend re-evaluates (card shows the shimmer on the why line, never blanks). */
  reevaluating: z.boolean().default(false),
  seenAt: IsoDateTime.nullable().default(null),
  nbaId: Id.nullable().default(null),
  owner: PersonRef.nullable().default(null),
  people: z.array(PersonRef).default([]),
  waiting: WaitingInfo.nullable().default(null),
  snoozedUntil: IsoDateTime.nullable().default(null),
  /** State to return to when the snooze wakes. */
  snoozedFrom: WorkState.nullable().default(null),
  doneAt: IsoDateTime.nullable().default(null),
  doneBy: z.enum(['user', 'engine', 'chat']).nullable().default(null),
  /** "Done because Dana replied in thread" — evidence summary for Closed-for-you. */
  closedReason: z.string().nullable().default(null),
  /** R-UI-22: how it was resolved ("Done by you", "Handed off → Kim", …). Null while open. */
  resolution: Resolution.nullable().default(null),
  resolutionDetail: ResolutionDetail.nullable().default(null),
  /** R-UI-22: my involvement now. Handed-off items take new info as context only, except a direct ask of me. */
  involvement: Involvement.default('owner'),
  loopedBackIn: LoopedBackIn.nullable().default(null),
  likelyDone: z.object({ reason: z.string(), evidenceId: Id.nullable() }).nullable().default(null),
  reopened: z.object({ reason: z.string(), at: IsoDateTime, from: SourceRef.optional() }).nullable().default(null),
  dismissed: z.object({ reason: NotNowReason, note: z.string().optional(), at: IsoDateTime }).nullable().default(null),
  notes: z.string().default(''),
  enrichment: Enrichment.nullable().default(null),
  deliverable: DeliverableInfo.nullable().default(null),
  training: TrainingInfo.nullable().default(null),
  /** Agent run linked to this item (Claude session, app run, tool run). */
  runIds: z.array(Id).default([]),
  assetIds: z.array(Id).default([]),
  /** Who asked / who it was promised to — shown as "asked 2h ago" / "promised 34d ago". */
  counterparty: PersonRef.nullable().default(null),
  /** BE-READIN: state of this item's read-in (absent = none), so rows can show "✦ Read-in ready" cheaply. */
  readInState: ReadInState.optional(),
});
export type WorkItemRecord = z.infer<typeof WorkItemRecord>;

/** View model: record + resolved chips for initiative / account / opp / meeting. */
export const WorkItem = WorkItemRecord.extend({
  refs: z.object({
    initiative: EntityRef.nullable(),
    account: EntityRef.nullable(),
    opp: EntityRef.nullable(),
    meeting: EntityRef.extend({ start: IsoDateTime }).nullable(),
  }),
});
export type WorkItem = z.infer<typeof WorkItem>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const Evidence = z.object({
  id: Id,
  workItemId: Id,
  role: EvidenceRole,
  source: SourceRef,
  at: IsoDateTime,
  summary: z.string(),
  snippet: z.string().nullable().default(null), // redacted, short
  author: z.string().nullable().default(null),
  isNew: z.boolean().default(false),
  confidence: Confidence.nullable().default(null),
});
export type Evidence = z.infer<typeof Evidence>;

// ---------------------------------------------------------------------------
// Proposals (engine → user-locked field, or chat/policy staged changes)
// ---------------------------------------------------------------------------

export const ProposalStatus = z.enum(['pending', 'applied', 'rejected', 'superseded']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const Proposal = z.object({
  id: Id,
  entity: EntityRef,
  /** Field diff: current → proposed. For drafts the doc diff is summarized in `textDiff`. */
  changes: z.array(FieldChange).min(1),
  reason: z.string(), // "New info: Dana added 'include pricing'"
  source: SourceRef.nullable().default(null),
  createdAt: IsoDateTime,
  status: ProposalStatus,
  actor: z.enum(['engine', 'chat', 'connector', 'scenario']),
  /** Entity version the proposal was computed against (conflict check on apply). */
  baseVersion: Version.nullable().default(null),
  /** Optional unified-ish text diff for long text fields (draft body). */
  textDiff: z
    .array(z.object({ op: z.enum(['equal', 'insert', 'delete']), text: z.string() }))
    .nullable()
    .default(null),
  resolvedAt: IsoDateTime.nullable().default(null),
});
export type Proposal = z.infer<typeof Proposal>;

// ---------------------------------------------------------------------------
// Initiative
// ---------------------------------------------------------------------------

export const InitiativeStatus = z.enum(['proposed', 'active', 'paused', 'completed', 'abandoned']);
export type InitiativeStatus = z.infer<typeof InitiativeStatus>;

export const TimelineEntry = z.object({
  at: IsoDateTime,
  label: z.string(),
  source: SourceRef.nullable().default(null),
  ref: EntityRef.nullable().default(null),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const Initiative = z.object({
  id: Id,
  version: Version,
  title: z.string(), // "ACME Headless Phase 2 demo"
  purpose: z.string(),
  summary: z.string(), // background context, prose
  status: InitiativeStatus,
  accountId: Id.nullable(),
  oppId: Id.nullable(),
  targetEventId: Id.nullable().default(null),
  people: z.array(PersonRef).default([]),
  assetIds: z.array(Id).default([]),
  timeline: z.array(TimelineEntry).default([]),
  userLockedFields: z.array(z.enum(['title', 'purpose', 'summary', 'status'])).default([]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Initiative = z.infer<typeof Initiative>;
