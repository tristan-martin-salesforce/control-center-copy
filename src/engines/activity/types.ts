/**
 * Activity engine types. Names mirror docs/reference/DATA-MODEL.md (activity_entries, time_blocks,
 * org62_events, canvas_lines). Differences are listed in the lane report ("type names to reconcile"):
 * task type and meeting type are carried by NAME (not FK id), `ref` is the short line key.
 */
import type { EngagedParams } from './engaged';
import type { OnsiteConfig } from './onsite';

export type ActivityStatus =
  | 'upcoming'
  | 'needs_input'
  | 'proposed'
  | 'approved'
  | 'synced_to_canvas'
  | 'logged'
  | 'verified'
  | 'verify_failed'
  | 'excluded'
  | 'dismissed'
  | 'dropped';

export type ExcludedReason = 'neither_type' | 'overlap' | 'ooo' | 'placeholder' | 'cap_trimmed' | 'duplicate';

/** Rejected before it becomes an entry (never persisted as a row). `before_go_live` is a proposed extension. */
export type RejectReason = ExcludedReason | 'before_go_live' | 'not_accepted' | 'not_attended' | 'below_minimum' | 'personal';

export type ActivityOrigin =
  | 'calendar'
  | 'evidence'
  | 'build_estimate'
  | 'manual'
  | 'chat'
  | 'legacy_recreate'
  | 'duration_backfill';

export type Org62Operation = 'create' | 'update' | 'delete';
export type WhatKind = 'opportunity' | 'account' | 'dsr' | 'strategic_initiative' | 'none';
export type Confidence = 'High' | 'Medium' | 'Low' | 'Estimate';

export type TimeBlockSource =
  | 'calendar'
  | 'claude_hands_on'
  | 'claude_background'
  | 'doc_edit'
  | 'slack_burst'
  | 'git'
  | 'manual'
  | 'estimate'
  | 'travel'
  | 'onsite';
export type AttentionKind = 'meeting' | 'focused' | 'background' | 'ambient';

/** D-18: meeting 30 > onsite frame 25 > focused 20 > Slack and email 10. Travel ranks with meetings, after them. */
export const PRECEDENCE = { meeting: 30, onsite: 25, focused: 20, slack: 10, background: 0 } as const;

/**
 * D-18 as amended 2026-11-11 (Settings ▸ Time ▸ Overlapping meetings, `time.overlaps`):
 *  - `log_all_accepted` (default, every persona): an accepted meeting always logs, overlapping meetings both log (each
 *    flagged), and an onsite day logs in full with the meetings during it. Engaged solo time (focused work, Slack,
 *    Claude prompts) still yields to them: a meeting and solo work at the same moment count once. No caps (2026-11-14).
 *  - `count_once`: the original D-18: meetings win, the loser of a double-booking is excluded as `overlap`, and the
 *    onsite frame fills only the gaps between sessions.
 * In both, a row that will not log (excluded, dismissed) never makes another row lose an overlap.
 */
export type OverlapMode = 'log_all_accepted' | 'count_once';
export const DEFAULT_OVERLAP_MODE: OverlapMode = 'log_all_accepted';
export const overlapModeOf = (cfg: Pick<ActivityConfig, 'overlaps'>): OverlapMode => cfg.overlaps ?? DEFAULT_OVERLAP_MODE;

// ---------------------------------------------------------------- evidence inputs

export type SelfResponse = 'accepted' | 'tentative' | 'declined' | 'needsAction';

export interface CalendarEvidence {
  id: string; // e.g. cal|<calendarId>|<eventId>
  summary: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  /** `marker`: a timed block of 12 h+ or across midnight (never a meeting); `hotel`: a stay; see event-kinds.ts. */
  kind?: 'default' | 'flight' | 'ooo' | 'focus' | 'hotel' | 'marker' | 'working_location';
  selfResponse: SelfResponse;
  organizerSelf?: boolean;
  recurring?: boolean;
  /** Attendee email domains (never full addresses). */
  attendeeDomains: string[];
  /** false when Gemini notes / the roster show he was not there. Default true. */
  attended?: boolean;
  hasGeminiNotes?: boolean;
  hasRecording?: boolean;
  deleted?: boolean;
  /** Where it is (street address, room, airport), as the calendar says. */
  location?: string | null;
  /** All-day events: the first local date and the day after the last (the calendar's exclusive end). */
  allDayFrom?: string;
  allDayTo?: string;
  /** The account the projection's resolver (or the user's mapping) gave this event; the engine's own match otherwise. */
  accountKey?: string | null;
  /** The opp (Org62 id) the resolver picked for this event. */
  oppWhatId?: string | null;
  /** The recurring series (calendar recurring event id): a learned series rule maps every instance (src/engines/attribution). */
  seriesId?: string | null;
}

export interface ClaudeEvidence {
  sessionId: string;
  /** Repo or project key used by the repo mapping (e.g. folder name). */
  repoKey: string;
  /** The session's title (its words decide an internal row's type). */
  title?: string;
  /** The account the session is mapped to (the resolver over repo, cwd, branch and title; the user's mapping). */
  accountKey?: string | null;
  /** Human prompt timestamps: each is an own action (engaged.ts). */
  promptTimes?: string[];
  /** Human prompts with the end of Claude's turn after each (its last record before the next prompt): the run counts in part. */
  turns?: { at: string; runEndsAt: string }[];
  /** Already-derived human segments (claude_session_segments with attention = hands_on). */
  humanSegments?: { startsAt: string; endsAt: string }[];
  /** Agent/background time: shown as leverage, NEVER counted (D-17). */
  backgroundSegments?: { startsAt: string; endsAt: string }[];
}

export interface DriveEvidence {
  fileId: string;
  title: string;
  /** Last edit time (Drive has no per-user edit history). */
  editedAt: string;
  /** Present when a real edit session is known. */
  sessionStart?: string;
  sessionEnd?: string;
}

export interface SlackBurstEvidence {
  id: string;
  channelId: string;
  startsAt: string;
  endsAt: string;
  messageCount?: number;
}

export interface GitCommitEvidence {
  sha: string;
  repoKey: string;
  at: string;
}

/** A Slack message I sent: one own action. */
export interface SlackMessageEvidence {
  /** `<channelId>|<at>` (the projections' message key). */
  id: string;
  channelId: string;
  channelName?: string | null;
  at: string;
}

/** An email I sent: one own action. */
export interface EmailSentEvidence {
  id: string;
  subject?: string | null;
  /** Recipient email domains (never addresses): an external one can name the account. */
  domains?: string[];
  at: string;
}

export interface EvidenceBundle {
  calendar: CalendarEvidence[];
  claude: ClaudeEvidence[];
  drive: DriveEvidence[];
  /** Slack bursts (legacy: each burst is one span action). Ignored for counting when `slackMessages` is given. */
  slack: SlackBurstEvidence[];
  git: GitCommitEvidence[];
  /** The Slack messages I sent, one action each (engaged.ts). */
  slackMessages?: SlackMessageEvidence[];
  /** The emails I sent. */
  emails?: EmailSentEvidence[];
}

import type { LearnedMappings } from '@/engines/attribution/activity';

// ---------------------------------------------------------------- mappings and config

export interface AccountMapping {
  key: string;
  /** Regex source, matched case-insensitively against the lower-cased text. */
  match: string;
  domains?: string[];
  /** Opp id (006…) or account id (001…). Empty = needs input. */
  whatId: string;
  whatType: 'Opportunity' | 'Account';
  whatName: string;
  candidates?: string;
  /** On the opp team? false adds a "confirm" flag. */
  team?: boolean;
  /**
   * D-103 (c): open opportunities on the account. 0 with an Account WhatId is a settled target (no "pick the
   * opportunity" flag); absent: not known (the flag stays, as before).
   */
  openOpps?: number;
}

export interface MappingOverride {
  match: string; // regex source
  date?: string; // local date prefix
  type?: string;
  reason?: string;
  conf?: Confidence;
  accountKey?: string;
  whatId?: string;
  whatType?: 'Opportunity' | 'Account';
  whatName?: string;
  meetingType?: string;
  flag?: string;
  skip?: string;
}

export interface ActivityMappings {
  accounts: AccountMapping[];
  /** repoKey -> accountKey (repo/project mapping). */
  repos: Record<string, string>;
  /** Slack channelId -> accountKey. */
  channels: Record<string, string>;
  /** repoKey -> Neither type (demo orgs, tooling): logged as that type with no WhatId. */
  neitherRepos: Record<string, string>;
  internalDomains: string[];
  partnerDomains: string[];
  ignoreDomains: string[];
  overrides: MappingOverride[];
  /**
   * Learned rules (mapping_rules) and the opps they name, read first by the attribution engine (src/engines/attribution,
   * tenet: Suggest, then learn). Absent: none (the account patterns, the channel map and the domains decide, as before).
   */
  learned?: LearnedMappings;
}

export interface ActivityConfig {
  timezone: string; // e.g. America/Denver
  ownerId: string;
  recordTypeId: string; // Solutions Event
  lightningHost: string;
  workday: { start: string; end: string };
  hoursTarget: number; // 250 per quarter
  /** Memory: live only since mid-September 2026. Estimates before this day are rejected. */
  liveFrom: string;
  /** D-55: the Org62 Event record type (Name) the persona logs with; absent: 'Solutions Event' (the SE's). */
  recordTypeName?: string;
  /** D-55: rows need an SE task type (the SE's Solutions Events); absent: true. */
  taskTypeRequired?: boolean;
  evidence: {
    /** A solo-work row under this many hours (one day, one bucket) is not proposed. */
    minBlockH: number; // 0.25
    /** The engaged-time model's parameters (engaged.ts); absent: its calibrated defaults. */
    engaged?: Partial<EngagedParams>;
  };
  quarters: { name: string; start: string; end: string; deadline: string }[];
  /** Settings ▸ Time (onsite days, airport buffer, dinners). Absent: the defaults (onsite.ts). */
  onsite?: OnsiteConfig;
  /** Settings ▸ Time ▸ Overlapping meetings (D-18 amended). Absent: `log_all_accepted`. */
  overlaps?: OverlapMode;
  /**
   * D-64: work for no customer is proposed as internal-only activity (Related To empty, an internal task type; the
   * persona's, the SE's). Absent / false: as before (it waits for an opp, or is not logged).
   */
  internalActivity?: boolean;
}

export const DEFAULT_EVIDENCE_CONFIG: ActivityConfig['evidence'] = { minBlockH: 0.25 };

// ---------------------------------------------------------------- time blocks

export interface TimeBlock {
  dedupeKey: string;
  source: TimeBlockSource;
  startsAt: string;
  endsAt: string;
  localDay: string;
  attention: AttentionKind;
  countsAsHumanHours: boolean;
  precedence: number;
  /** Lower-precedence overlap: shown, never counted. */
  isOverlay: boolean;
  accountKey: string | null;
  repoKey: string | null;
  /** Evidence ids that produced this block (calendar id, session id, file id, sha, burst id). */
  evidenceIds: string[];
}

// ---------------------------------------------------------------- entries

export interface ActivityEntry {
  dedupeKey: string;
  /** Short line key used in canvases (`#ref`, `CC#ref`). */
  ref?: string;
  origin: ActivityOrigin;
  operation: Org62Operation;
  targetOrg62EventId?: string | null;
  subject: string;
  startsAt: string;
  endsAt: string;
  /** Duration__c, 0.25 h steps (D-40). */
  durationHours: number;
  /** SE_Task_Type__c name. null while undecided. */
  seTaskType: string | null;
  meetingType: string;
  whatKind: WhatKind;
  whatOrg62Id: string | null;
  whatName: string | null;
  accountKey?: string | null;
  customerFacing: boolean;
  customerRelated: boolean;
  /** External attendee domains behind a CF decision. */
  extDomains?: string[];
  /** false when you were there in person (an onsite day, a customer dinner, travel). Default true. */
  remote?: boolean;
  /** The trip this row belongs to (onsite.ts): its account and opp are the trip's, one for the whole trip. */
  tripKey?: string | null;
  /** D-64: internal-only work (no customer, no account, no opp): logs with no WhatId and an internal task type. */
  internal?: boolean;
  /** Extra free text. The Org62 Description (CC# provenance) is built by `buildDescription`. */
  description: string;
  confidence: Confidence;
  reason: string;
  flags: string[];
  /** Evidence ids behind the entry (time block ids / source ids). */
  evidenceIds: string[];
  /** Human-readable evidence summary (rendered as `_..._` in the review canvas). */
  evidence: string;
  status: ActivityStatus;
  excludedReason: ExcludedReason | null;
  approvedAt?: string | null;
  approvalMethod?: 'click' | 'keyboard' | 'chat_confirm' | 'autonomy_policy' | null;
  org62EventId?: string | null;
  /** The user `=>` edits; engines treat these fields as locked. */
  userLockedFields: string[];
}

export interface RejectedProposal {
  dedupeKey: string;
  subject: string;
  startsAt: string;
  hours: number;
  reason: RejectReason;
  note: string;
}

// ---------------------------------------------------------------- Org62 read-back mirror

export interface Org62EventRow {
  org62EventId: string;
  recordTypeName: string; // 'Solutions Event' | 'Sales Engineer Events' | …
  subject: string | null;
  startsAt: string;
  endsAt: string;
  /** Raw Duration__c; null = never filled in. */
  durationField: number | null;
  seTaskTypeName: string | null;
  meetingTypeName?: string | null;
  whatOrg62Id: string | null;
  ownerId?: string | null;
  /** D-65 (TL-23): the app row id its Description carries as `CC#<uuid>` (Slackbot writes it from the canvas row). */
  ccKey?: string | null;
}
