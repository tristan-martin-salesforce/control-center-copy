/**
 * Local input types for the pure BE-3 engines (priority, closure, re-eval).
 *
 * These mirror docs/reference/DATA-MODEL.md (enum and column names) and docs/archive/2026-build/UI-SPEC.md (UI vocabulary).
 * The orchestrator reconciles them with W0's `src/contract/**`; see docs/reference/ENGINES.md §5 for the
 * name map. No I/O, no DB, no LLM: the data layer builds these from rows and applies the outputs.
 *
 * Conventions: instants are ISO-8601 strings (UTC `Z` or with an offset); durations are minutes
 * unless a name says otherwise; every function is deterministic for the same inputs.
 */
import type { Confidence, EvidenceRole, OpenItemDigest } from '@/scanner/types';

export type { Confidence, EvidenceRole };

// ---------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------

/** `work_item_status` (DATA-MODEL §3 enums). UI-SPEC's "reopened" is a transient label on `open`, not a state. */
export type WorkItemStatus =
  | 'suggested'
  | 'open'
  | 'in_progress'
  | 'waiting_on_others'
  | 'waiting_on_me'
  | 'likely_done'
  | 'done'
  | 'snoozed'
  | 'dismissed'
  | 'merged';

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'suggested',
  'open',
  'in_progress',
  'waiting_on_others',
  'waiting_on_me',
  'likely_done',
  'done',
  'snoozed',
  'dismissed',
  'merged',
];

/** "live" in DATA-MODEL §4.1: an item the engines may move forward. */
export const LIVE_STATUSES: readonly WorkItemStatus[] = [
  'open',
  'in_progress',
  'waiting_on_others',
  'waiting_on_me',
  'likely_done',
];

export const TERMINAL_STATUSES: readonly WorkItemStatus[] = ['done', 'dismissed', 'merged'];

/**
 * Work-item kinds, as in the scanner contract (`ProposeItemInput.kind`) and UI-SPEC §11.
 * "Promise" is not a kind: it is a `commitment` in the background lane (orchestrator decision 6).
 * DATA-MODEL's enum spells two of these differently: `follow_up` ~ `missed_meeting_followup`,
 * and it has no `deliverable` (deliverables are `work_item_deliverables` rows on any kind).
 */
export type WorkItemKind = 'task' | 'commitment' | 'ask' | 'training' | 'follow_up' | 'travel' | 'deliverable';

/** R-UI-22 resolution reasons, exactly as `OpenItemDigest.resolution`. */
export type Resolution = NonNullable<OpenItemDigest['resolution']>;
/** R-UI-22 involvement, exactly as `OpenItemDigest.involvement`. */
export type Involvement = NonNullable<OpenItemDigest['involvement']>;

/** `importance_level`. */
export type ImportanceLevel = 'critical' | 'high' | 'normal' | 'low';

/** `stakeholder_tier`. */
export type StakeholderTier =
  | 'leader'
  | 'manager'
  | 'ae'
  | 'teammate'
  | 'customer_exec'
  | 'customer'
  | 'partner'
  | 'normal'
  | 'low';

/** `closure_kind`: the deterministic closure test an item uses. */
export type ClosureKind =
  | 'manual_only'
  | 'reply_in_thread'
  | 'email_sent'
  | 'claude_session_completed'
  | 'asset_delivered'
  | 'deliverable_judged'
  | 'org62_readback'
  | 'vdp_readback'
  | 'tool_run_succeeded'
  | 'training_completed'
  | 'llm_match';

/** `priority_lane`. Declaration order is display order. */
export type PriorityLane = 'top3' | 'now' | 'next' | 'later' | 'background' | 'hidden';
export const PRIORITY_LANES: readonly PriorityLane[] = ['top3', 'now', 'next', 'later', 'background', 'hidden'];

/** `plan_step_mode`. */
export type PlanStepMode = 'kickoff_background' | 'meeting_prep' | 'focus' | 'quick_win' | 'meeting' | 'buffer';

/** `policy_rule_kind`. */
export type PolicyRuleKind = 'boost' | 'penalty' | 'sla' | 'lane_floor' | 'lane_cap' | 'never_above' | 'exclude';

/** UI-SPEC §12 Agents run states (W0 `RunState`). */
export type RunState = 'queued' | 'running' | 'waiting_on_you' | 'done_review' | 'done' | 'failed' | 'stale';

export interface PersonLite {
  id?: string;
  name: string;
  isMe?: boolean;
  isManager?: boolean;
  isExternal?: boolean;
  tier?: StakeholderTier;
}

/** Effort split: YOUR minutes vs AGENT minutes, never summed (UI-SPEC §1.8). */
export interface Effort {
  youMin: number;
  agentMin: number;
}

// ---------------------------------------------------------------------------
// Priority inputs
// ---------------------------------------------------------------------------

export interface TrainingFacts {
  mandatory: boolean;
  requiredBy?: string | null;
  progressPct?: number;
}

/** One open work item as the priority engine sees it (built from `work_items` + links). */
export interface PriorityItem {
  id: string;
  title: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  /** `due_at` */
  due?: string | null;
  /** `due_kind`: soft and inferred deadlines weigh less than hard ones. */
  dueKind?: 'hard' | 'soft' | 'inferred' | null;
  effort: Effort;
  importance?: ImportanceLevel;
  stakeholders?: PersonLite[];
  accountId?: string | null;
  oppId?: string | null;
  /** Opportunity amount (USD) for `deal_value`. */
  oppAmount?: number | null;
  initiativeId?: string | null;
  /** `deadline_event_id`: the meeting this work must be ready for (W0 `servesEventId`). */
  servesEventId?: string | null;
  createdAt: string;
  /** When the ask/commitment was made, if earlier than createdAt (SLA rules count from here). */
  askedAt?: string | null;
  lastEvidenceAt?: string | null;
  /** Explicit background flag (W0 `isBackground`). The engine also derives it (§ background lane). */
  isBackground?: boolean;
  /** Extractor-authored hints (W0 `RankSignals`). Derived from stakeholders/meeting when absent. */
  customerFacing?: boolean;
  fromManager?: boolean;
  /** Manual nudge in points (W0 `signals.boost`, `priority_scores.user_adjustment`). */
  userAdjustment?: number;
  /** Can run as a Claude session / tool in the background (`backgroundable`). Defaults to agentMin > 0. */
  backgroundable?: boolean;
  /** True once the agent run has been kicked off (a linked session/tool run exists). */
  agentStarted?: boolean;
  training?: TrainingFacts | null;
  /** Source of the origin evidence (Slack, Gmail, …) for rule predicates. */
  source?: string | null;
}

/** A calendar event in today + the next 3 days (`calendar_events` + attendees). */
export interface Meeting {
  id: string;
  title: string;
  start: string;
  end: string;
  /** `attendance`. Past meetings that were missed feed follow-ups; they never act as deadlines. */
  attendance?: 'unknown' | 'attended' | 'missed' | 'partial' | 'not_applicable' | 'upcoming';
  hasExternalAttendees?: boolean;
  isCustomerFacing?: boolean;
  accountId?: string | null;
  oppId?: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  myResponse?: 'accepted' | 'declined' | 'tentative' | 'needs_action' | 'none';
  /** `event_type`. Focus time counts as free for work; OOO and all-day events don't block gaps. */
  eventType?: 'default' | 'out_of_office' | 'focus_time' | 'working_location';
  isAllDay?: boolean;
  /** Items prepping for this meeting (prep links). Merged with items' `servesEventId`. */
  prepItemIds?: string[];
}

/** Working hours (Settings ▸ Profile). Local wall-clock + a fixed UTC offset for the planning horizon. */
export interface WorkingHours {
  /** "09:00" */
  start: string;
  /** "18:00" */
  end: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Minutes east of UTC for the horizon (PT = -480/-420). The data layer computes it from the IANA zone. */
  utcOffsetMinutes: number;
  /**
   * The persona's IANA zone. When set, working windows follow its DST changes day by day (each day's start and end
   * are wall-clock times in the zone), so the late grace day does not shift by an hour across a change (W0-11).
   */
  timeZone?: string;
}

export interface TimeWindow {
  start: string;
  end: string;
}

// ---------------------------------------------------------------------------
// Closure inputs
// ---------------------------------------------------------------------------

export interface ResolutionDetail {
  personId?: string;
  personName?: string;
  relatedItemId?: string;
  note?: string;
  /** True when an engine inferred it from evidence (auto-closures always carry one). */
  inferred: boolean;
  evidenceIds?: string[];
}

/** A work item as the closure state machine sees it (`work_items` columns, camelCase). */
export interface ClosureItem {
  id: string;
  version: number;
  kind: WorkItemKind;
  status: WorkItemStatus;
  /** `status_changed_at`: the closed-at fallback for dismissed items. */
  statusChangedAt?: string | null;
  title: string;
  initiativeId?: string | null;
  parentId?: string | null;
  mergedIntoId?: string | null;
  resolution?: Resolution | null;
  resolutionDetail?: ResolutionDetail | null;
  involvement?: Involvement;
  owner?: PersonLite | null;
  doneAt?: string | null;
  doneBy?: 'user' | 'engine' | 'chat' | null;
  dismissedAt?: string | null;
  closureKind?: ClosureKind;
  /** e.g. thread key, email thread id, Drive file id. */
  closureTarget?: string | null;
  /**
   * DATA-MODEL `auto_close_allowed`. Not mapped from the column (it defaults to false and was never honoured, SCN-16):
   * a caller may still pass false to forbid auto-closing one item. Undefined = allowed.
   */
  autoCloseAllowed?: boolean;
  /**
   * R1, the one correction rule both closers share (src/engines/closure/correction.ts): false when the user reopened it
   * after a close, kept it, marked it Not done, or it touches their ask-first lists. A Sure completion then only asks
   * (Likely done · Confirm). Undefined = allowed.
   */
  mayAutoClose?: boolean;
  /** Why `mayAutoClose` is false (`user_reopened`, `user_kept`, `ask_first_person`, …), for the decision's reason. */
  autoCloseBlock?: string | null;
  /** Drive file / asset ids this item delivers (R-UI-15). */
  deliverableRefs?: string[];
  snoozedUntil?: string | null;
  snoozedFromStatus?: WorkItemStatus | null;
  waitingReason?: string | null;
  waitingSince?: string | null;
  /** waiting_on_others: when the nudge is due. */
  nudgeAt?: string | null;
  likelyDoneAt?: string | null;
  /** The live status the item had before `likely_done` (so a contradiction can step back). */
  likelyDoneFromStatus?: WorkItemStatus | null;
  likelyDone?: { reason: string; evidenceId: string | null; proposedResolution?: Resolution } | null;
  reopenedCount?: number;
  lastReopenedAt?: string | null;
  loopedBackIn?: { at: string; byPersonName: string; evidenceId: string | null } | null;
  linkedSessionIds?: string[];
  /** Columns the user edited (`user_locked_fields`). `status` and W0's `state` are aliases. */
  userLockedFields?: string[];
}

/** Per-user closure settings (`user_settings` keys in CLOSURE_SETTING_KEYS). */
export interface ClosureSettings {
  /** `reopen.window_days`: a done item reopens only if it closed at most this many days ago. */
  reopenWindowDays: number;
  /** `close.auto_sure`: Sure completion auto-closes (L4 internal, with Undo). Off = Likely flow. */
  autoCloseSure: boolean;
  /** `snooze.wake_on_new_info`: also wake snoozed items on any new evidence (DATA-MODEL W2 variant). */
  snoozeWakeOnNewInfo: boolean;
  /** `handoff.my_involvement`: my involvement after an inferred hand-off. */
  handoffInvolvement: Extract<Involvement, 'watcher' | 'not_involved'>;
}

export const DEFAULT_CLOSURE_SETTINGS: ClosureSettings = {
  reopenWindowDays: 14,
  autoCloseSure: true,
  snoozeWakeOnNewInfo: false,
  handoffInvolvement: 'watcher',
};

export const CLOSURE_SETTING_KEYS: Record<keyof ClosureSettings, string> = {
  reopenWindowDays: 'reopen.window_days',
  autoCloseSure: 'close.auto_sure',
  snoozeWakeOnNewInfo: 'snooze.wake_on_new_info',
  handoffInvolvement: 'handoff.my_involvement',
};

/** Where a signal came from (W0 `SourceKind`). */
export type SignalSource = 'slack' | 'gmail' | 'calendar' | 'drive' | 'gemini' | 'org62' | 'vdp' | 'claude' | 'manual';

interface SignalBase {
  /** The `work_item_evidence` row (or source item) this signal was saved as. Null for timers. */
  evidenceId: string | null;
  /** When it happened. */
  at: string;
  source?: SignalSource;
  /** Who said or did it. `isMe` matters for completions ("done by me" vs "done by Dana"). */
  actor?: PersonLite;
  /** The scanner's or engine's one-line why. */
  reason?: string;
}

/**
 * Evidence linked by the scanner (`cc_link_evidence`). The scanner emits signals; this engine decides.
 * An `origin` whose reason starts with `loop_back:` is normalized to a `loop_back` signal (SCANNER.md §4.5).
 */
export interface EvidenceSignal extends SignalBase {
  type: 'evidence';
  role: EvidenceRole;
  confidence: Confidence;
  /** Completion only: an inferred resolution other than done_by_me/done_by_other ("Kim will take it"). */
  resolution?: Resolution;
  /** handed_off → the new owner; duplicate/superseded → the surviving item. */
  resolutionPerson?: PersonLite;
  relatedItemId?: string;
}

/** New requirements for an item (SCANNER.md §4.4 "requirements change"; R-UI-20 reopen vs sibling). */
export interface RequirementsChangeSignal extends SignalBase {
  type: 'requirements_change';
  confidence: Confidence;
  /** One line: "Add pricing slide". Used as the sibling title when a sibling is created. */
  summary: string;
  /** The deliverable the new requirement touches (Drive file / asset id), if known. */
  deliverableRef?: string;
  /** Scanner verdict; wins over the deliverableRef comparison when set. */
  sameDeliverable?: boolean;
}

/** A direct ask of me (DM, @mention, explicit question) on an item I'm not (or no longer) on. */
export interface LoopBackSignal extends SignalBase {
  type: 'loop_back';
  from: PersonLite;
  summary?: string;
}

/** A linked Claude session / app run changed status (`claude_sessions.status`, tool runs). */
export interface SessionSignal extends SignalBase {
  type: 'session';
  sessionId: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  /** `waiting_on_me_reason` or free text: "Session asked: which org alias?" */
  waitingReason?: string;
  /** Launched by the app (`launched_by_app` / app run) vs a session Tristan started himself. */
  launchedByApp: boolean;
  /** Completion confidence when done (default likely: a finished session is not proof the work is right). */
  confidence?: Confidence;
}

/** A Drive digest judged against the item's requested changes (R-UI-15). */
export interface DriveDigestSignal extends SignalBase {
  type: 'drive_digest';
  fileId: string;
  /** "Were the requested updates made?" yes / partial / unknown (an edit with no judgment). */
  updatesMade: 'yes' | 'partial' | 'unknown';
  editedByMe: boolean;
  editorName?: string;
}

/** A reply in the ask's thread after the ask (`reply_in_thread`, Q12), or a reply to MY ask. */
export interface ReplySignal extends SignalBase {
  type: 'reply';
  /** me = I replied after someone asked me; counterparty = the person I'm waiting on replied. */
  by: 'me' | 'counterparty';
  threadRef?: string;
}

/** An email I sent that the scanner linked to this item (`email_sent`). */
export interface EmailSentSignal extends SignalBase {
  type: 'email_sent';
  confidence: Confidence;
  hasAttachment: boolean;
  attachmentRefs?: string[];
}

/** The clock: snooze wake-ups and nudge-due dates (`work_items_snooze_wake_idx`). */
export interface TimerSignal extends SignalBase {
  type: 'timer';
}

export type Signal =
  | EvidenceSignal
  | RequirementsChangeSignal
  | LoopBackSignal
  | SessionSignal
  | DriveDigestSignal
  | ReplySignal
  | EmailSentSignal
  | TimerSignal;

// ---------------------------------------------------------------------------
// Re-eval inputs
// ---------------------------------------------------------------------------

/** What changed, as recorded when new info was saved (W2). Drives which downstream steps re-run. */
export type ChangeKind =
  | 'evidence_origin'
  | 'evidence_progress'
  | 'evidence_completion'
  | 'evidence_context'
  | 'evidence_contradiction'
  | 'requirements_change'
  | 'loop_back'
  | 'session_status'
  | 'drive_digest'
  | 'reply'
  | 'email_sent'
  | 'timer'
  | 'calendar_changed'
  | 'policy_changed'
  | 'entity_changed'
  | 'user_edit_schedule'
  | 'user_edit_content'
  | 'user_edit_status'
  | 'draft_edited';

export const CHANGE_KINDS: readonly ChangeKind[] = [
  'evidence_origin',
  'evidence_progress',
  'evidence_completion',
  'evidence_context',
  'evidence_contradiction',
  'requirements_change',
  'loop_back',
  'session_status',
  'drive_digest',
  'reply',
  'email_sent',
  'timer',
  'calendar_changed',
  'policy_changed',
  'entity_changed',
  'user_edit_schedule',
  'user_edit_content',
  'user_edit_status',
  'draft_edited',
];

/** One piece of saved new info that needs a re-evaluation. */
export interface ReevalEvent {
  workItemId: string;
  at: string;
  change: ChangeKind;
  /** The item's `reeval_generation` after this event's bump (W2), when known. */
  generation?: number;
  evidenceId?: string;
}
