/**
 * Shared primitives and enums for the Command Center API contract.
 *
 * Conventions (see docs/reference/CONTRACT.md):
 * - ids are opaque strings; timestamps are ISO-8601 instants (UTC `Z` or with an offset);
 *   calendar days are `YYYY-MM-DD`.
 * - enum values are snake_case; field names are camelCase.
 * - every mutable entity carries `version` (int, starts at 1) and mutations send `ifVersion`.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

export const IsoDateTime = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const IsoDate = z.string().date();
export type IsoDate = z.infer<typeof IsoDate>;

export const Version = z.number().int().min(1);
export type Version = z.infer<typeof Version>;

export const Url = z.string().min(1); // http(s), claude://, slack://, mailto: … (not validated as WHATWG URL on purpose)

export const Minutes = z.number().int().min(0);

// ---------------------------------------------------------------------------
// Enums (exact vocabularies from docs/archive/2026-build/UI-SPEC.md)
// ---------------------------------------------------------------------------

/** Work-item kinds (UI-SPEC §11). "Promise" is NOT a kind: it is a `commitment` with `isBackground: true`. */
export const WorkKind = z.enum(['task', 'commitment', 'ask', 'training', 'follow_up', 'travel', 'deliverable']);
export type WorkKind = z.infer<typeof WorkKind>;

/** Work-item states, exactly UI-SPEC §11. */
export const WorkState = z.enum([
  'suggested',
  'open',
  'in_progress',
  'waiting_on_me',
  'waiting_on_others',
  'likely_done',
  'done',
  'reopened',
  'snoozed',
  'dismissed',
]);
export type WorkState = z.infer<typeof WorkState>;

/** Categorical confidence. A word, never a percentage (UI-SPEC §1.4). */
export const Confidence = z.enum(['sure', 'likely', 'guess']);
export type Confidence = z.infer<typeof Confidence>;

/** Where a signal came from (SourceChip, UI-SPEC §5.3). */
export const SourceKind = z.enum(['slack', 'gmail', 'calendar', 'drive', 'gemini', 'org62', 'vdp', 'claude', 'manual']);
export type SourceKind = z.infer<typeof SourceKind>;

/** Evidence roles on the item timeline (UI-SPEC §12 Work item detail). */
export const EvidenceRole = z.enum(['origin', 'progress', 'completion', 'context', 'contradiction']);
export type EvidenceRole = z.infer<typeof EvidenceRole>;

/**
 * The NBA verb decides the card's ONE primary action (UI-SPEC §5.1).
 * send → Send (composer confirm) · start_in_claude → Start in Claude · run_tool → Run tool ·
 * log → Log · review → Review · answer → Answer · confirm_done → Confirm done ·
 * nudge → Nudge (a send to the counterparty) · wait → Wait (no-op alternative) · schedule → Schedule ·
 * review_deliverable → Review (a Drive deliverable judged ready for review; the engine's verb and DB
 * `nba_type` since migration 0004, mapped 1:1).
 */
export const NbaVerb = z.enum(['send', 'start_in_claude', 'run_tool', 'log', 'review', 'answer', 'confirm_done', 'nudge', 'wait', 'schedule', 'review_deliverable']);
export type NbaVerb = z.infer<typeof NbaVerb>;

/** Composer dispatch mode (per message toggle, UI-SPEC §7). */
export const DispatchMode = z.enum(['draft', 'send']);
export type DispatchMode = z.infer<typeof DispatchMode>;

/** Agent / run states, exactly the UI-SPEC §12 Agents table. */
export const RunState = z.enum(['queued', 'running', 'waiting_on_you', 'done_review', 'done', 'failed', 'stale']);
export type RunState = z.infer<typeof RunState>;

/**
 * Connector health (brief 09 §7 + header pulse).
 * ok: silent · catching_up: header pulse only · degraded: retrying (amber, Health page) ·
 * auth_needed: needs you (red + banner when today's data is affected) · error: broken, not auth ·
 * offline: unreachable (e.g. off-network) · paused: user paused it.
 */
export const ConnectorState = z.enum(['ok', 'catching_up', 'degraded', 'auth_needed', 'error', 'offline', 'paused']);
export type ConnectorState = z.infer<typeof ConnectorState>;

/** How a connector is re-authenticated (brief 09 §7). */
export const ReauthKind = z.enum(['in_app', 'terminal_command', 'refresh_script', 'instructions']);
export type ReauthKind = z.infer<typeof ReauthKind>;

/** Activity-log entry status (UI-SPEC §12 Time + data-model §4.4). */
export const ActivityStatus = z.enum([
  'upcoming',
  'needs_input',
  'proposed',
  'approved',
  'synced_to_canvas',
  'logged',
  'verified',
  'verify_failed',
  'dismissed',
]);
export type ActivityStatus = z.infer<typeof ActivityStatus>;

/** Brief highlight relevance word (UI-SPEC §12 Briefs). */
export const BriefRelevance = z.enum(['high', 'medium', 'low']);
export type BriefRelevance = z.infer<typeof BriefRelevance>;

/** Save model per surface (UI-SPEC §8). Exposed so settings sections can declare theirs. */
export const SaveModel = z.enum(['autosave', 'instant', 'explicit_save', 'explicit_apply', 'explicit_send']);
export type SaveModel = z.infer<typeof SaveModel>;

/** StatePill / badge tones (UI-SPEC §5.3). */
export const Tone = z.enum(['ok', 'warn', 'risk', 'brand', 'neutral', 'ai']);
export type Tone = z.infer<typeof Tone>;

/**
 * Chat model choice (CONTRACT-1): per request (`ChatRequest.model`) or the `settings.chat.defaultModel`. Assistant v2
 * (H-6, 2026-11-20): `haiku` joins (the Auto router's fast tier); `auto` is a request choice, not a model
 * (`ChatModelChoice` in ./chat.ts).
 */
export const ChatModel = z.enum(['sonnet', 'opus', 'haiku']);
export type ChatModel = z.infer<typeof ChatModel>;

/** Who made a change. Every change is attributable and undoable (R-UI-18). */
export const Actor = z.enum(['user', 'engine', 'chat', 'connector', 'system', 'scenario']);
export type Actor = z.infer<typeof Actor>;

/** Entity types that appear in refs, audit entries, proposals and search. */
export const EntityType = z.enum([
  'work_item',
  'initiative',
  'nba',
  'draft',
  'proposal',
  'calendar_event',
  'agent_run',
  'tool_run',
  'tool_adapter',
  'activity_entry',
  'account',
  'opportunity',
  'missed_opp',
  'brief',
  'brief_highlight',
  'watch',
  'connector',
  'job',
  'event_log',
  'settings',
  'policy',
  'chat_thread',
  'person',
  'asset',
  'triage_mapping',
  /** A VDP (id = its slug) or an engaged account with no VDP yet (id = `account:<accountId>`): Time ▸ VDP details. */
  'vdp',
  /** A mirrored Specialist Forecast (id = its app row id): Time ▸ Forecast details. */
  'specialist_forecast',
  /** D-56: the "Report a bug / idea" panel (id = one report on this page; reports themselves live in the Outbox). */
  'feedback',
]);
export type EntityType = z.infer<typeof EntityType>;

export const AutonomyLevel = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

// ---------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------

/** A lightweight link to any entity (EntityChip, receipts, digests). */
export const EntityRef = z.object({
  type: EntityType,
  id: Id,
  label: z.string(),
  href: z.string().optional(),
});
export type EntityRef = z.infer<typeof EntityRef>;

/** A source chip: where a fact came from, and how to open it (`o`). */
export const SourceRef = z.object({
  kind: SourceKind,
  label: z.string(), // "#acme-ext · thread", "Gmail · Dana Reyes", "Deck 'ACME Phase 2'"
  url: Url.optional(),
  externalId: z.string().optional(),
  at: IsoDateTime.optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const PersonRef = z.object({
  id: Id,
  name: z.string(),
  role: z.string().optional(), // "AE", "Manager", "Customer · Director of Data"
  isManager: z.boolean().optional(),
  isExternal: z.boolean().optional(),
});
export type PersonRef = z.infer<typeof PersonRef>;

/** One field changing. Used by proposals (diff), receipts and audit entries. */
export const FieldChange = z.object({
  field: z.string(),
  label: z.string().optional(), // human label ("Due", "Draft body")
  before: z.unknown(),
  after: z.unknown(),
});
export type FieldChange = z.infer<typeof FieldChange>;

/** Effort split: YOUR minutes vs AGENT minutes, never summed (UI-SPEC §1.8). */
export const Effort = z.object({
  youMin: Minutes,
  agentMin: Minutes,
});
export type Effort = z.infer<typeof Effort>;

export const Progress = z.object({
  done: z.number(),
  total: z.number(),
  label: z.string().optional(),
});
export type Progress = z.infer<typeof Progress>;
