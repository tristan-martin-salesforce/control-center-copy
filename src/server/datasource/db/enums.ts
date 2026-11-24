/**
 * Contract enums ↔ Postgres enums (src/contract/common.ts ↔ src/db/schema/enums.ts).
 *
 * Most map 1:1. Where the database vocabulary is coarser (one db value stands for several contract
 * values) the writer also stores a *qualified override* in the side-car (see ext.ts): the contract value
 * plus the db value it was written against. The reader applies the override only while the column still
 * holds that db value, so a later write by the worker / engines (which only know the db vocabulary) is
 * never shadowed by a stale override.
 */
import type {
  ActivityExcludedReason,
  ActivityStatus,
  AgentRun,
  Asset,
  CalendarEvent,
  Confidence,
  Connector,
  DispatchMode,
  DraftStatus,
  Job,
  NbaStatus,
  NbaVerb,
  RunState,
  ScanRun,
  SourceKind,
  ToolRunStatus,
  WatchSubscription,
  WorkKind,
  WorkState,
} from '@/contract';
import { kindOfSystem, systemOfKind } from '@/contract/sources';

type Db<T extends string> = T;

/** A contract value stored against the db value it maps to (applied only while the column still matches). */
export interface Override<C extends string = string, D extends string = string> {
  value: C;
  when: D;
}

export function applyOverride<C extends string, D extends string>(dbValue: D, mapped: C, o: Override<C, D> | undefined | null): C {
  return o && o.when === dbValue ? o.value : mapped;
}

/** Store an override only when the reverse map would not reproduce the contract value. */
export function overrideIfLossy<C extends string, D extends string>(contract: C, dbValue: D, reverse: (d: D) => C): Override<C, D> | null {
  return reverse(dbValue) === contract ? null : { value: contract, when: dbValue };
}

// ---------------------------------------------------------------------------
// Confidence: the contract word ↔ numeric(4,3)
// ---------------------------------------------------------------------------

const CONF_NUM: Record<Confidence, number> = { sure: 0.95, likely: 0.75, guess: 0.45 };
export const confToNum = (c: Confidence): number => CONF_NUM[c];
export function numToConf(n: number | null | undefined): Confidence {
  if (n === null || n === undefined) return 'likely';
  if (n >= 0.9) return 'sure';
  if (n >= 0.6) return 'likely';
  return 'guess';
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type DbSourceSystem = Db<'slack' | 'gmail' | 'calendar' | 'drive' | 'gemini_notes' | 'org62' | 'vdp' | 'claude' | 'git' | 'manual' | 'chat' | 'tool' | 'app'>;
export type DbSourceItemKind = Db<
  | 'slack_message'
  | 'slack_canvas_snapshot'
  | 'email_message'
  | 'calendar_event'
  | 'drive_file_revision'
  | 'gemini_note'
  | 'meeting_transcript'
  | 'org62_record_snapshot'
  | 'vdp_record_snapshot'
  | 'claude_session'
  | 'git_commit'
  | 'manual_note'
  | 'tool_output'
>;

// the one source-kind mapping (src/contract/sources.ts)
export const sourceToDb = (s: SourceKind): DbSourceSystem => systemOfKind(s);
export const sourceFromDb = (s: DbSourceSystem): SourceKind => kindOfSystem(s);

const SOURCE_ITEM_KIND: Record<SourceKind, DbSourceItemKind> = {
  slack: 'slack_message',
  gmail: 'email_message',
  calendar: 'calendar_event',
  drive: 'drive_file_revision',
  gemini: 'gemini_note',
  org62: 'org62_record_snapshot',
  vdp: 'vdp_record_snapshot',
  claude: 'claude_session',
  // manual_note source items are user-edited content (audited, bodies in content_revisions); a captured
  // reference is a tool_output-style pointer, so seeds and captures use tool_output.
  manual: 'tool_output',
};
export const sourceItemKind = (s: SourceKind): DbSourceItemKind => SOURCE_ITEM_KIND[s];

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

export type DbWorkKind = Db<'task' | 'commitment' | 'ask' | 'training' | 'background_promise' | 'travel' | 'missed_meeting_followup'>;
export type DbWorkStatus = Db<'suggested' | 'open' | 'in_progress' | 'waiting_on_others' | 'waiting_on_me' | 'likely_done' | 'done' | 'snoozed' | 'dismissed' | 'merged'>;

export function kindToDb(k: WorkKind): DbWorkKind {
  if (k === 'follow_up') return 'missed_meeting_followup';
  if (k === 'deliverable') return 'task'; // a Drive-backed task; the contract kind rides in an override
  return k;
}
export function kindFromDb(k: DbWorkKind): WorkKind {
  if (k === 'missed_meeting_followup') return 'follow_up';
  if (k === 'background_promise') return 'commitment'; // decision 6: a lane, not a kind
  return k;
}

/** 'reopened' is db status 'open' with last_reopened_at = status_changed_at (see read/work.ts). */
export function stateToDb(s: WorkState): DbWorkStatus {
  return s === 'reopened' ? 'open' : s;
}
export function stateFromDb(s: DbWorkStatus, reopenedNow: boolean): WorkState {
  if (s === 'merged') return 'dismissed';
  if (s === 'open' && reopenedNow) return 'reopened';
  return s;
}

export type DbImportance = 'critical' | 'high' | 'normal' | 'low';
export const priorityToDb = (p: 'high' | 'medium' | 'low'): DbImportance => (p === 'medium' ? 'normal' : p);
export const priorityFromDb = (i: DbImportance): 'high' | 'medium' | 'low' => (i === 'critical' || i === 'high' ? 'high' : i === 'low' ? 'low' : 'medium');

export type DbOrigin = 'manual' | 'said_by_me' | 'asked_of_me' | 'meeting_next_step' | 'system_rule' | 'chat' | 'missed_opp_scan' | 'reconcile' | 'tool';
export function originFor(kind: WorkKind, firstSource: SourceKind | undefined): DbOrigin {
  if (firstSource === 'manual') return 'manual';
  if (kind === 'ask') return 'asked_of_me';
  if (kind === 'commitment') return 'said_by_me';
  if (kind === 'follow_up') return 'meeting_next_step';
  if (kind === 'training') return 'system_rule';
  if (firstSource === 'org62') return 'missed_opp_scan';
  return 'manual';
}

/** Lane cache on work_items (Q1 reads priority_lane + priority_rank). */
export type DbLane = 'top3' | 'now' | 'next' | 'later' | 'background' | 'hidden';
export function laneFor(rank: number | null, isBackground: boolean): DbLane | null {
  if (isBackground) return 'background';
  if (rank === null) return null;
  if (rank <= 3) return 'top3';
  if (rank <= 15) return 'now';
  if (rank <= 30) return 'next';
  return 'later';
}

// ---------------------------------------------------------------------------
// NBA and drafts
// ---------------------------------------------------------------------------

export type DbNbaType = 'reply' | 'send_email' | 'draft_doc' | 'start_claude_session' | 'run_tool' | 'log_activity' | 'update_vdp' | 'schedule' | 'nudge' | 'confirm_done' | 'review_deliverable';
const VERB_TYPE: Record<NbaVerb, DbNbaType> = {
  send: 'reply',
  start_in_claude: 'start_claude_session',
  run_tool: 'run_tool',
  log: 'log_activity',
  review: 'draft_doc',
  answer: 'start_claude_session',
  confirm_done: 'confirm_done',
  nudge: 'nudge',
  wait: 'nudge',
  schedule: 'schedule',
  review_deliverable: 'review_deliverable',
};
const TYPE_VERB: Record<DbNbaType, NbaVerb> = {
  reply: 'send',
  send_email: 'send',
  draft_doc: 'review',
  start_claude_session: 'start_in_claude',
  run_tool: 'run_tool',
  log_activity: 'log',
  update_vdp: 'log',
  schedule: 'schedule',
  nudge: 'nudge',
  confirm_done: 'confirm_done',
  review_deliverable: 'review_deliverable',
};
export const verbToDb = (v: NbaVerb, emailDraft = false): DbNbaType => (v === 'send' && emailDraft ? 'send_email' : VERB_TYPE[v]);
export const verbFromDb = (t: DbNbaType): NbaVerb => TYPE_VERB[t];

export type DbNbaStatus = NbaStatus | 'superseded';
export const nbaStatusFromDb = (s: DbNbaStatus): NbaStatus => (s === 'superseded' ? 'stale' : s);

export type DbDraftStatus = DraftStatus | 'approved' | 'unconfirmed' | 'handed_off' | 'superseded';
export function draftStatusFromDb(s: DbDraftStatus): DraftStatus {
  switch (s) {
    case 'approved':
      return 'ready';
    case 'unconfirmed':
      return 'sending';
    case 'handed_off':
      return 'sent';
    case 'superseded':
      return 'discarded';
    default:
      return s;
  }
}
/** Statuses that drafts_approval_chk requires an approval for. */
export const APPROVED_DRAFT_STATUSES = new Set<DbDraftStatus>(['approved', 'scheduled', 'sending', 'unconfirmed', 'sent', 'staged', 'handed_off', 'verified', 'verify_failed']);

export const modeToDb = (m: DispatchMode): 'send' | 'stage' => (m === 'send' ? 'send' : 'stage');
export const modeFromDb = (m: 'send' | 'stage' | 'handoff'): DispatchMode => (m === 'send' ? 'send' : 'draft');

// ---------------------------------------------------------------------------
// Agent runs (claude_sessions) and tool runs
// ---------------------------------------------------------------------------

export type DbSessionStatus = 'launching' | 'launch_failed' | 'running' | 'idle' | 'waiting_on_me' | 'completed' | 'errored' | 'abandoned';
const RUN_SESSION: Record<RunState, DbSessionStatus> = {
  queued: 'launching',
  running: 'running',
  waiting_on_you: 'waiting_on_me',
  done_review: 'completed',
  done: 'completed',
  failed: 'errored',
  stale: 'idle',
};
export const runStateToSession = (s: RunState): DbSessionStatus => RUN_SESSION[s];
export function runStateFromSession(s: DbSessionStatus): RunState {
  switch (s) {
    case 'launching':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting_on_me':
      return 'waiting_on_you';
    case 'completed':
      return 'done_review';
    case 'launch_failed':
    case 'errored':
      return 'failed';
    case 'idle':
    case 'abandoned':
      return 'stale';
  }
}

export type DbToolRunStatus = 'queued' | 'running' | 'waiting_on_me' | 'succeeded' | 'failed' | 'cancelled';
export function toolStatusToDb(s: ToolRunStatus): DbToolRunStatus {
  if (s === 'starting') return 'running';
  if (s === 'waiting_user') return 'waiting_on_me';
  return s;
}
export const toolStatusFromDb = (s: DbToolRunStatus): ToolRunStatus => (s === 'waiting_on_me' ? 'waiting_user' : s);

export type DbToolKind = 'http_local' | 'cli' | 'skill' | 'claude_session' | 'mcp';
export function toolKindToDb(k: 'http' | 'cli' | 'claude-session' | 'skill'): DbToolKind {
  return k === 'http' ? 'http_local' : k === 'claude-session' ? 'claude_session' : k;
}

/** Agent-run state for a tool-run mirror row (Agents page), from the tool run status. */
export function runStateForToolRun(s: ToolRunStatus): AgentRun['state'] {
  switch (s) {
    case 'queued':
      return 'queued';
    case 'starting':
    case 'running':
      return 'running';
    case 'waiting_user':
      return 'waiting_on_you';
    case 'succeeded':
      return 'done_review';
    case 'failed':
    case 'cancelled':
      return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type DbConnectorStatus = 'healthy' | 'degraded' | 'stale' | 'auth_required' | 'paused' | 'disabled' | 'error';
const CONN: Record<Connector['state'], DbConnectorStatus> = {
  ok: 'healthy',
  catching_up: 'degraded',
  degraded: 'degraded',
  auth_needed: 'auth_required',
  error: 'error',
  offline: 'stale',
  paused: 'paused',
};
export const connStateToDb = (s: Connector['state']): DbConnectorStatus => CONN[s];
export function connStateFromDb(s: DbConnectorStatus): Connector['state'] {
  switch (s) {
    case 'healthy':
      return 'ok';
    case 'degraded':
      return 'degraded';
    case 'stale':
      return 'offline';
    case 'auth_required':
      return 'auth_needed';
    case 'paused':
    case 'disabled':
      return 'paused';
    case 'error':
      return 'error';
  }
}

export type DbRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export function scanStatusToDb(s: ScanRun['status']): { status: DbRunStatus; errorCode: string | null } {
  switch (s) {
    case 'ok':
      return { status: 'succeeded', errorCode: null };
    case 'auth_failed':
      return { status: 'failed', errorCode: 'auth' };
    case 'transient_failed':
      return { status: 'failed', errorCode: 'transient' };
    case 'budget_exceeded':
      return { status: 'failed', errorCode: 'budget' };
    case 'aborted':
      return { status: 'cancelled', errorCode: null };
    default:
      return { status: s, errorCode: null };
  }
}
export function scanStatusFromDb(s: DbRunStatus, errorCode: string | null): ScanRun['status'] {
  switch (s) {
    case 'succeeded':
      return 'ok';
    case 'failed':
      return errorCode === 'auth' ? 'auth_failed' : errorCode === 'budget' ? 'budget_exceeded' : 'transient_failed';
    case 'cancelled':
      return 'aborted';
    default:
      return s;
  }
}

export type DbScanTrigger = 'schedule' | 'startup_catchup' | 'manual' | 'chat' | 'hook' | 'reconcile';
export type DbScanMode = 'incremental' | 'backfill' | 'reconcile' | 'probe';
export function scanKindToDb(k: ScanRun['kind']): { trigger: DbScanTrigger; mode: DbScanMode } {
  switch (k) {
    case 'poll':
      return { trigger: 'schedule', mode: 'incremental' };
    case 'head':
      return { trigger: 'startup_catchup', mode: 'incremental' };
    case 'backfill':
      return { trigger: 'schedule', mode: 'backfill' };
    case 'reconcile':
      return { trigger: 'reconcile', mode: 'reconcile' };
    case 'manual':
      return { trigger: 'manual', mode: 'incremental' };
  }
}
export function scanKindFromDb(trigger: DbScanTrigger, mode: DbScanMode): ScanRun['kind'] {
  if (mode === 'backfill') return 'backfill';
  if (mode === 'reconcile' || trigger === 'reconcile') return 'reconcile';
  if (trigger === 'manual' || trigger === 'chat') return 'manual';
  if (trigger === 'startup_catchup') return 'head';
  return 'poll';
}

export type DbJobStatus = 'queued' | 'running' | 'succeeded' | 'dead' | 'cancelled';
/** 'retrying' is a queued job that already failed at least once. */
export const jobStatusToDb = (s: Job['status']): DbJobStatus => (s === 'retrying' ? 'queued' : s);
export function jobStatusFromDb(s: DbJobStatus, attempts: number, lastFailedAt: unknown): Job['status'] {
  if (s === 'queued' && attempts > 0 && lastFailedAt) return 'retrying';
  return s;
}

// ---------------------------------------------------------------------------
// Activity, calendar, watches, assets
// ---------------------------------------------------------------------------

export type DbActivityStatus = ActivityStatus | 'excluded' | 'dropped';
export const activityStatusFromDb = (s: DbActivityStatus): ActivityStatus => (s === 'excluded' || s === 'dropped' ? 'dismissed' : s);
export type DbExcludedReason = 'neither_type' | 'overlap' | 'ooo' | 'placeholder' | 'cap_trimmed' | 'duplicate';
/** Why a row reads as `dismissed`: the engine's exclusion reason, `dropped`, or `dismissed` (you). Null for live rows. */
export function excludedReasonFromDb(s: DbActivityStatus, reason: DbExcludedReason | null): ActivityExcludedReason | null {
  if (s === 'excluded') return reason ?? 'neither_type';
  if (s === 'dropped') return 'dropped';
  if (s === 'dismissed') return 'dismissed';
  return null;
}

export type DbAttendance = 'unknown' | 'attended' | 'missed' | 'partial' | 'not_applicable';
export type DbEventStatus = 'confirmed' | 'tentative' | 'cancelled';
export type DbResponse = 'accepted' | 'declined' | 'tentative' | 'needs_action' | 'none';
export function attendanceToDb(a: CalendarEvent['attendance']): { status: DbEventStatus; myResponse: DbResponse; attendance: DbAttendance } {
  switch (a) {
    case 'cancelled':
      return { status: 'cancelled', myResponse: 'none', attendance: 'not_applicable' };
    case 'declined':
      return { status: 'confirmed', myResponse: 'declined', attendance: 'not_applicable' };
    case 'attended':
      return { status: 'confirmed', myResponse: 'accepted', attendance: 'attended' };
    case 'missed':
      return { status: 'confirmed', myResponse: 'accepted', attendance: 'missed' };
    case 'in_progress':
      return { status: 'confirmed', myResponse: 'accepted', attendance: 'partial' };
    case 'upcoming':
      return { status: 'confirmed', myResponse: 'accepted', attendance: 'unknown' };
  }
}
export function attendanceFromDb(status: DbEventStatus, myResponse: DbResponse, attendance: DbAttendance): CalendarEvent['attendance'] {
  if (status === 'cancelled') return 'cancelled';
  if (myResponse === 'declined') return 'declined';
  if (attendance === 'attended') return 'attended';
  if (attendance === 'missed') return 'missed';
  if (attendance === 'partial') return 'in_progress';
  return 'upcoming';
}

export type DbScopeKind = 'channel' | 'opportunity' | 'account' | 'person' | 'initiative' | 'search_query';
export function scopeToDb(k: WatchSubscription['targetKind']): DbScopeKind {
  return k === 'opp' ? 'opportunity' : k === 'search' ? 'search_query' : k;
}
export function scopeFromDb(k: DbScopeKind): WatchSubscription['targetKind'] {
  if (k === 'opportunity') return 'opp';
  if (k === 'search_query') return 'search';
  if (k === 'initiative') return 'account';
  return k;
}
export type DbCadence = 'since_last' | 'daily' | 'weekly' | 'on_demand';
export function cadenceToDb(c: WatchSubscription['cadence']): DbCadence {
  return c === 'daily_0730' ? 'daily' : c === 'since_last_open' ? 'since_last' : 'on_demand';
}
export function cadenceFromDb(c: DbCadence): WatchSubscription['cadence'] {
  return c === 'daily' || c === 'weekly' ? 'daily_0730' : c === 'since_last' ? 'since_last_open' : 'every_4h';
}
export type DbBriefStyle = 'digest' | 'narrative' | 'changes_only';
export const styleToDb = (s: WatchSubscription['style']): DbBriefStyle => (s === 'brief' ? 'digest' : 'narrative');
export const styleFromDb = (s: DbBriefStyle): WatchSubscription['style'] => (s === 'digest' || s === 'changes_only' ? 'brief' : 'detailed');

export type DbAssetKind = 'deck' | 'doc' | 'sheet' | 'pdf' | 'demo_org' | 'repo_artifact' | 'recording' | 'talk_track' | 'estimate' | 'link' | 'other';
const ASSET_KIND: Record<Asset['kind'], DbAssetKind> = {
  slides: 'deck',
  doc: 'doc',
  sheet: 'sheet',
  pdf: 'pdf',
  folder: 'other',
  demo_org: 'demo_org',
  claude_session: 'repo_artifact',
  tool_output: 'other',
  canvas: 'other',
  link: 'link',
};
export const assetKindToDb = (k: Asset['kind']): DbAssetKind => ASSET_KIND[k];
export function assetKindFromDb(k: DbAssetKind): Asset['kind'] {
  switch (k) {
    case 'deck':
      return 'slides';
    case 'repo_artifact':
      return 'claude_session';
    case 'talk_track':
    case 'estimate':
    case 'recording':
    case 'other':
      return 'tool_output';
    default:
      return k;
  }
}
export type DbAssetSystem = 'drive' | 'local_fs' | 'slack_file' | 'vdp' | 'tool';
export function assetSystemToDb(s: SourceKind): DbAssetSystem {
  switch (s) {
    case 'drive':
    case 'gemini':
      return 'drive';
    case 'slack':
      return 'slack_file';
    case 'vdp':
      return 'vdp';
    case 'claude':
      return 'local_fs';
    default:
      return 'tool';
  }
}
export function assetSystemFromDb(s: DbAssetSystem): SourceKind {
  switch (s) {
    case 'drive':
      return 'drive';
    case 'slack_file':
      return 'slack';
    case 'vdp':
      return 'vdp';
    case 'local_fs':
      return 'claude';
    case 'tool':
      return 'manual';
  }
}

export type DbConfigSource = 'role_template' | 'team_pack' | 'user' | 'chat' | 'learned';
export const policyByToDb = (b: 'user' | 'chat' | 'system'): DbConfigSource => (b === 'system' ? 'role_template' : b);
export const policyByFromDb = (s: DbConfigSource): 'user' | 'chat' | 'system' => (s === 'user' || s === 'chat' ? s : 'system');

export type DbFindingStatus = 'new' | 'reviewing' | 'actioned' | 'dismissed' | 'resolved';
export function findingStatusToDb(s: 'new' | 'claimed' | 'dismissed' | 'resolved'): DbFindingStatus {
  return s === 'claimed' ? 'actioned' : s;
}
export function findingStatusFromDb(s: DbFindingStatus): 'new' | 'claimed' | 'dismissed' | 'resolved' {
  return s === 'actioned' ? 'claimed' : s === 'reviewing' ? 'new' : s;
}
