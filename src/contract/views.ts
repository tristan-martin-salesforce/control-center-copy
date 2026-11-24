/**
 * Page payloads composed from the core models: Today, Work lists, item / initiative / account detail,
 * Triage, Since-you-left, Search.
 */
import { z } from 'zod';
import { AgentRun } from './agents';
import { CalendarEvent, SpineSlot } from './calendar';
import { Brief } from './briefs';
import { Confidence, ConnectorState, EntityRef, Id, IsoDateTime, Progress, SourceRef, WorkKind, WorkState } from './common';
import { Account, DealsNeed, MissedOpp, Opportunity } from './deals';
import { AuditEntry } from './envelope';
import { HealthSummary, SpendSummary } from './health';
import { Draft, NbaCard, NbaVersionEntry } from './nba';
import { Asset, Evidence, Initiative, Person, Proposal, WorkItem } from './work';

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export const NowCard = z.object({
  item: WorkItem,
  nba: NbaCard.nullable(),
  draft: Draft.nullable(),
  /** A waiting/running run linked to the item (promoted into NOW when waiting, UI-SPEC §4.3). */
  run: AgentRun.nullable(),
  proposals: z.array(Proposal),
});
export type NowCard = z.infer<typeof NowCard>;

export const ShelfEntry = z.object({
  item: WorkItem,
  /** "fits your 11:30 gap" / "promised 70d ago" */
  hint: z.string(),
  action: z.object({ label: z.string(), verb: z.enum(['kick_off', 'start', 'renegotiate', 'let_go', 'open']) }),
});
export type ShelfEntry = z.infer<typeof ShelfEntry>;

export const RailLaneId = z.enum(['since_you_left', 'waiting_on_you', 'agents', 'waiting_on_others', 'closed_for_you', 'health', 'briefs']);
export type RailLaneId = z.infer<typeof RailLaneId>;

export const RailAction = z.object({
  kind: z.enum(['open_in_claude', 'answer', 'approve', 'nudge', 'undo', 'reauth', 'open', 'review']),
  label: z.string(),
  href: z.string().nullable().default(null),
  auditId: Id.nullable().default(null),
  /** Inline answer chips for app runs. */
  choices: z.array(z.string()).default([]),
});
export type RailAction = z.infer<typeof RailAction>;

export const RailEntry = z.object({
  id: Id,
  ref: EntityRef,
  title: z.string(),
  detail: z.string().nullable(),
  at: IsoDateTime.nullable(),
  tone: z.enum(['ok', 'warn', 'risk', 'brand', 'neutral', 'ai']).default('neutral'),
  action: RailAction.nullable(),
  /** Closed-for-you: the evidence that closed it. */
  evidence: SourceRef.nullable().default(null),
});
export type RailEntry = z.infer<typeof RailEntry>;

/** A status-rail lane: mono eyebrow + count + the first 1–2 entries (more on expand). */
export const RailLane = z.object({
  lane: RailLaneId,
  label: z.string(), // "WAITING ON YOU"
  count: z.number().int(),
  summary: z.string(), // "6 changed · 4 closed · 2 new"
  entries: z.array(RailEntry),
  href: z.string(),
  visible: z.boolean(),
});
export type RailLane = z.infer<typeof RailLane>;

export const TodayHeader = z.object({
  date: IsoDateTime,
  nextMeeting: z.object({ eventId: Id, title: z.string(), start: IsoDateTime, minutesUntil: z.number().int() }).nullable(),
  /**
   * DESIGN-V2 "Capacity and estimates": only today-scoped, hands-on minutes count; agent and Claude-session
   * time runs in the background and never counts. Say "overbooked" only when `fits` is false.
   */
  capacity: z.object({
    /**
     * MIN-22: the working day these numbers count. `next` once today's working hours are over (or today has none):
     * the next working day's hands-on work against its free time, so an evening never reads "Over by".
     */
    day: z.enum(['today', 'next']).default('today'),
    /** That day in words: "today", "tomorrow", "Monday". */
    dayLabel: z.string().default('today'),
    /** Hands-on minutes of today-scoped work still to do (due today, start-by today, pinned or planned for today; plus approvals and re-auths). */
    youMinToday: z.number().int().min(0),
    /** Free minutes outside meetings from now to the end of working hours. */
    freeMin: z.number().int().min(0),
    /** freeMin − youMinToday ("~5h open"). Negative = overbooked by that much. */
    openMin: z.number().int(),
    /** youMinToday ≤ freeMin. */
    fits: z.boolean(),
    /** Agent and Claude-session minutes running in parallel (today's kick-offs + runs in flight). */
    agentMinBackground: z.number().int().min(0),
    agentRunsBackground: z.number().int().min(0),
    /** Up to 5 not-due-today items worth pulling in, in rank order. Empty when the day is full. */
    pullForward: z.array(z.object({ itemId: Id, title: z.string(), youMin: z.number().int().min(0), due: IsoDateTime.nullable() })).max(5),
    /** Legacy: = freeMin. */
    focusMinLeft: z.number().int(),
    /** Legacy: = youMinToday. */
    plannedMin: z.number().int(),
    /** Legacy: = youMinToday − freeMin. Positive = over-planned by this many minutes. */
    overByMin: z.number().int(),
  }),
  nearestDeadline: z.object({ label: z.string(), due: IsoDateTime, progress: Progress.nullable() }).nullable(),
  catchUp: z.object({ sources: z.array(z.object({ connectorId: Id, label: z.string(), pct: z.number().nullable(), done: z.boolean() })) }).nullable(),
});
export type TodayHeader = z.infer<typeof TodayHeader>;

export const TodayPayload = z.object({
  now: IsoDateTime,
  header: TodayHeader,
  spine: z.object({
    events: z.array(CalendarEvent),
    slots: z.array(SpineSlot),
    later: z.object({ fitIns: z.number().int(), promises: z.number().int() }),
  }),
  nowStack: z.object({
    rankedAt: IsoDateTime,
    /** "Re-rank ready · n" pill: how many positions would change. 0 hides the pill. */
    rerankReady: z.number().int(),
    cards: z.array(NowCard).max(3),
  }),
  moreToday: z.object({ count: z.number().int(), items: z.array(WorkItem) }),
  triageCount: z.number().int(),
  shelves: z.object({ fitIns: z.array(ShelfEntry), promises: z.array(ShelfEntry) }),
  rail: z.array(RailLane),
  rankMeta: z.object({ policyVersion: z.number().int(), policyName: z.string(), rankedAt: IsoDateTime }),
  health: HealthSummary,
  spend: SpendSummary.pick({ today: true, state: true }),
  dryRun: z.boolean(),
  /** Nav counts where you must act: Triage n · Agents n waiting · Outbox n · Briefs badge. */
  navCounts: z.object({
    triage: z.number().int(),
    agentsWaiting: z.number().int(),
    /** Messages waiting for approval or failed (admin items are not counted here). */
    outbox: z.number().int(),
    briefsUnread: z.number().int(),
    /** Admin items (logging canvases, VDP changes) waiting for Apply or failed: shown on Time (D-52). */
    adminWaiting: z.number().int().default(0),
    /** VDPs (and opps not in VDP yet) that need you: Time's quiet count while nothing waits for Apply (D-59). */
    vdpOpen: z.number().int().default(0),
    /**
     * D-60: `adminWaiting` by the tab that holds each item (logging canvases on Log it, forecast canvases on Forecast,
     * VDP changes on VDP ▸ Changes), so every badge lands where its items are.
     */
    adminBySurface: z.object({ log: z.number().int(), forecast: z.number().int(), vdp: z.number().int() }).default({ log: 0, forecast: 0, vdp: 0 }),
    /**
     * 2026-11-13 audit C2: DC requests (approved, not on a canvas yet) and VDP use cases (creates, Stage / Go-Live
     * fixes) waiting for a logging canvas (src/lib/waiting-work.ts). Quiet: they count on Time ▸ Log it and in the
     * sidebar's Time badge, never as approvals.
     */
    waitingForCanvas: z.object({ dcs: z.number().int().min(0), useCases: z.number().int().min(0) }).default({ dcs: 0, useCases: 0 }),
    /** 2026-11-13 audit C8: Assistant proposal cards staged and not applied or discarded yet (a quiet Assistant badge). */
    assistantPending: z.number().int().min(0).default(0),
    /**
     * C10: Activity ▸ To log's one count (what needs you: fix rows plus sending failures), the To log tab's badge
     * (src/engines/activity/to-log-count.ts, the rule lanesOf reads), so the sidebar never says 1 while the tab says 38.
     */
    toLog: z.number().int().min(0).default(0),
  }),
  scannerPulse: z.object({ label: z.string(), state: ConnectorState }),
});
export type TodayPayload = z.infer<typeof TodayPayload>;

// ---------------------------------------------------------------------------
// Work lists and detail
// ---------------------------------------------------------------------------

export const WorkTab = z.enum(['all_open', 'said_by_me', 'asked_of_me', 'promises', 'trainings', 'snoozed', 'done']);
export type WorkTab = z.infer<typeof WorkTab>;

export const ItemsPayload = z.object({
  tab: WorkTab,
  items: z.array(WorkItem),
  counts: z.record(WorkTab, z.number().int()),
  /** The tab's rows over every page (= counts[tab]; without `limit`, the rows shown). */
  total: z.number().int(),
  /** With `limit`: the cursor of the next page, null on the last (absent without `limit`). */
  nextCursor: z.string().nullable().optional(),
});
export type ItemsPayload = z.infer<typeof ItemsPayload>;

/**
 * Slack user id (U…, W…) → display name, for the `<@U…>` mentions a payload's message texts carry (evidence snippets,
 * the why line), so the UI shows "@Dana Reyes" instead of a raw id. Only the ids those texts mention. Names come from
 * the people directory, then the item's own Slack rows, then the texts themselves (Slack writes most mentions as
 * `<@U…|Dana Reyes>`). An id is absent only when nothing names it; the renderer then shows "@someone", and a mention
 * that carries its own label still shows that label.
 */
export const MentionNames = z.record(z.string(), z.string());
export type MentionNames = z.infer<typeof MentionNames>;

export const WorkItemDetail = z.object({
  item: WorkItem,
  nba: NbaCard.nullable(),
  draft: Draft.nullable(),
  initiative: Initiative.nullable(),
  siblings: z.array(WorkItem),
  proposals: z.array(Proposal),
  runs: z.array(AgentRun),
  assets: z.array(Asset),
  account: Account.nullable(),
  opp: Opportunity.nullable(),
  meeting: CalendarEvent.nullable(),
  evidenceCount: z.number().int(),
  /** Names for the mentions in the why line and its full reasoning (item and NBA). */
  mentions: MentionNames.default({}),
});
export type WorkItemDetail = z.infer<typeof WorkItemDetail>;

export const EvidencePayload = z.object({
  workItemId: Id,
  evidence: z.array(Evidence),
  newCount: z.number().int(),
  /** Names for the mentions in the evidence snippets and summaries. */
  mentions: MentionNames.default({}),
});
export type EvidencePayload = z.infer<typeof EvidencePayload>;

/**
 * "Why is this here?" (AUDIT): each piece of evidence → its source (with the link) → the scan run that made it (time,
 * skill version) → the triage verdict and its reason → the model spend of that run. Ids, codes, links, short reasons.
 */
export const ItemTraceStep = z.object({
  evidenceId: Id,
  role: z.string(), // origin | progress | completion | context | contradiction
  confidence: z.number().nullable(),
  rationale: z.string().nullable(),
  at: IsoDateTime,
  source: SourceRef.nullable(),
  sourceItemId: Id.nullable(),
  run: z
    .object({
      id: Id,
      connector: z.string(),
      scope: z.string().nullable(),
      trigger: z.string(),
      mode: z.string(),
      status: z.string(),
      windowStart: IsoDateTime.nullable(),
      windowEnd: IsoDateTime.nullable(),
      startedAt: IsoDateTime.nullable(),
      finishedAt: IsoDateTime.nullable(),
      skillVersion: z.string().nullable(),
      model: z.string().nullable(),
      costUsd: z.number(),
      /** trace: the run's trace made this evidence · recorded: the run that first recorded the source (older items). */
      via: z.enum(['trace', 'recorded']),
    })
    .nullable(),
  verdict: z
    .object({
      pass: z.string(),
      v: z.string(), // act | noise | unsure | missing
      why: z.string().nullable(),
      escalated: z.boolean(),
      final: z.object({ v: z.string(), why: z.string().nullable() }).nullable(),
    })
    .nullable(),
  spend: z.object({ costUsd: z.number(), calls: z.number().int(), budget: z.string().nullable(), model: z.string().nullable() }).nullable(),
});
export type ItemTraceStep = z.infer<typeof ItemTraceStep>;

export const ItemTracePayload = z.object({
  workItemId: Id,
  steps: z.array(ItemTraceStep),
  createdBy: z.object({ actor: z.string().nullable(), at: IsoDateTime.nullable(), reason: z.string().nullable() }).nullable(),
});
export type ItemTracePayload = z.infer<typeof ItemTracePayload>;

export const HistoryPayload = z.object({ workItemId: Id, entries: z.array(AuditEntry), nbaVersions: z.array(NbaVersionEntry) });
export type HistoryPayload = z.infer<typeof HistoryPayload>;

export const NbaPayload = z.object({ nba: NbaCard.nullable(), draft: Draft.nullable(), proposals: z.array(Proposal) });
export type NbaPayload = z.infer<typeof NbaPayload>;

export const InitiativeDetail = z.object({
  initiative: Initiative,
  items: z.array(WorkItem),
  assets: z.array(Asset),
  runs: z.array(AgentRun),
  account: Account.nullable(),
  opp: Opportunity.nullable(),
  people: z.array(Person),
});
export type InitiativeDetail = z.infer<typeof InitiativeDetail>;

export const AccountDetail = z.object({
  account: Account,
  opps: z.array(Opportunity),
  initiatives: z.array(Initiative),
  items: z.array(WorkItem),
  assets: z.array(Asset),
  runs: z.array(AgentRun),
  briefs: z.array(Brief),
  missed: z.array(MissedOpp),
  /** This account's Deals needs (the getDeals rows for it, set-aside rows left out): the page's need banner and panel. */
  needs: z.array(DealsNeed).default([]),
});
export type AccountDetail = z.infer<typeof AccountDetail>;

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

/**
 * `looks_done` (LD-1): likely-done work to confirm or reject, next to the suggestions. `still_needed` (DEEP-1): asks
 * already over 30 days old when first seen, to keep (open) or close (not needed) in one click. `closed_for_you`
 * (SETTLE-1): work the engine closed in the last 14 days, newest first, each with its reason, its message and Undo.
 * It is a record, not a guess: never counted in `TriagePayload.count` or a "needs you" badge.
 */
export const TriageGroup = z.enum(['looks_done', 'asks_promises', 'meeting_takeaways', 'missed_opps', 'mappings', 'still_needed', 'closed_for_you']);
export type TriageGroup = z.infer<typeof TriageGroup>;

/** "Is this ACME or Globex?" — answered with inline choice chips. */
export const MappingQuestion = z.object({
  id: Id,
  question: z.string(),
  subject: EntityRef, // what is being mapped (a channel, meeting, file)
  choices: z.array(z.object({ id: Id, label: z.string(), ref: EntityRef.nullable() })).min(2),
  source: SourceRef,
  createdAt: IsoDateTime,
  status: z.enum(['open', 'answered', 'dismissed']),
  answerId: Id.nullable().default(null),
});
export type MappingQuestion = z.infer<typeof MappingQuestion>;

export const TriageItem = z.object({
  /** For work items and missed opps this is the underlying entity id. */
  id: Id,
  group: TriageGroup,
  kind: z.enum(['work_item', 'missed_opp', 'mapping']),
  title: z.string(),
  why: z.string(),
  confidence: Confidence,
  sources: z.array(SourceRef),
  createdAt: IsoDateTime,
  workItem: WorkItem.nullable(),
  missedOpp: MissedOpp.nullable(),
  mapping: MappingQuestion.nullable(),
  /** SETTLE-1 (`closed_for_you`): the change set that closed it, for Undo (POST /audit/:id/undo). Null: Reopen instead. */
  undoAuditId: Id.nullable().optional(),
});
export type TriageItem = z.infer<typeof TriageItem>;

export const TriagePayload = z.object({
  groups: z.array(z.object({ group: TriageGroup, label: z.string(), items: z.array(TriageItem) })),
  /** Guesses to confirm: every group except `closed_for_you`. */
  count: z.number().int(),
});
export type TriagePayload = z.infer<typeof TriagePayload>;

// ---------------------------------------------------------------------------
// Since you left
// ---------------------------------------------------------------------------

export const SinceEntry = z.object({
  at: IsoDateTime,
  kind: z.enum(['closed', 'new', 'changed', 'reopened', 'failed', 'waiting', 'brief']),
  title: z.string(),
  detail: z.string().nullable(),
  ref: EntityRef,
  auditId: Id.nullable(),
});
export type SinceEntry = z.infer<typeof SinceEntry>;

export const SinceDigest = z.object({
  since: IsoDateTime,
  until: IsoDateTime,
  awayMinutes: z.number().int(),
  /** Show the lane/digest only when away ≥ 120 min. */
  show: z.boolean(),
  counts: z.object({ changed: z.number().int(), closed: z.number().int(), new: z.number().int(), reopened: z.number().int() }),
  entries: z.array(SinceEntry),
});
export type SinceDigest = z.infer<typeof SinceDigest>;

// ---------------------------------------------------------------------------
// Search (⌘K)
// ---------------------------------------------------------------------------

export const SearchHit = z.object({
  ref: EntityRef,
  title: z.string(),
  subtitle: z.string().nullable(),
  kind: WorkKind.nullable().default(null),
  state: WorkState.nullable().default(null),
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResult = z.object({ q: z.string(), hits: z.array(SearchHit), total: z.number().int() });
export type SearchResult = z.infer<typeof SearchResult>;
