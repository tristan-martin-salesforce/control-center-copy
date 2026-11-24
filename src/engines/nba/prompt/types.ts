/**
 * Minimal input types for the NBA judgment layer (BE-4).
 *
 * These are defined locally on purpose: the orchestrator reconciles them with W0's contract
 * (`src/contract/**`) and BE-1's schema later. Field names follow docs/reference/DATA-MODEL.md where a
 * column exists, so the mapping is mechanical.
 */

/** NBA verbs. `review_deliverable` is not in DATA-MODEL's `nba_type` enum yet (see NBA_TYPE_FOR_VERB). */
export const NBA_VERBS = [
  'reply',
  'send_email',
  'start_claude_session',
  'run_tool',
  'log_activity',
  'update_vdp',
  'nudge',
  'schedule',
  'review_deliverable',
] as const;
export type NbaVerb = (typeof NBA_VERBS)[number];

export const CONFIDENCE = ['sure', 'likely', 'guess'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export type SourceSystem =
  | 'slack'
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'gemini'
  | 'org62'
  | 'vdp'
  | 'claude'
  | 'manual'
  | 'tool';

export type EvidenceRole = 'origin' | 'progress' | 'completion' | 'context' | 'contradiction';

export interface PersonInput {
  name: string;
  /** "AE", "PM", "manager", "customer architect", ... */
  role?: string;
  isExternal?: boolean;
  isMe?: boolean;
  /** Slack user id, used to render a real mention pill. Never invent one. */
  slackId?: string;
  email?: string;
}

export interface EvidenceEntry {
  /** Source item id. The model cites these in `sources`. */
  id: string;
  source: SourceSystem;
  role: EvidenceRole;
  at: string; // ISO
  author?: PersonInput;
  /** Channel, subject, file title or meeting title. */
  where?: string;
  title?: string;
  /** Credential-redacted excerpt. */
  excerpt: string;
  permalink?: string;
  /** Arrived since the last NBA version (R-UI-20 "new/unread"). */
  isNew?: boolean;
}

export interface ThreadMessage {
  id: string;
  at: string;
  author: PersonInput;
  text: string;
}

export interface DestinationInput {
  channel: 'slack' | 'email';
  /** "#acme-ext", "DM with Dana", or an email address. */
  label: string;
  /** Slack channel id or Gmail thread id when replying. */
  targetId?: string;
  threadRef?: string;
  subject?: string;
  to?: string[];
  cc?: string[];
}

export type WorkItemKind = 'task' | 'commitment' | 'ask' | 'training' | 'follow_up' | 'travel' | 'deliverable';

export interface WorkItemInput {
  id: string;
  kind: WorkItemKind;
  title: string;
  purpose?: string;
  state: string;
  createdAt: string;
  due?: string;
  /** Older, low-priority commitment shown in the Promises shelf (derived lane, not a kind). */
  isBackground?: boolean;
  promisedTo?: PersonInput;
  askedBy?: PersonInput;
  account?: { id: string; name: string };
  opportunity?: { id: string; name: string; stage?: string; closeDate?: string; amount?: number };
  people?: PersonInput[];
  effort?: { youMin?: number; agentMin?: number };
  /** Deliverables (R-UI-15): the file and the requested changes. */
  expected?: { fileId?: string; fileTitle?: string; changes?: string[] };
  tags?: string[];
}

export interface InitiativeSummary {
  id: string;
  title: string;
  purpose?: string;
  summary?: string;
  siblings?: Array<{ id: string; title: string; state: string }>;
  assets?: Array<{ kind: string; label: string; ref: string }>;
}

export interface CalendarEventInput {
  id: string;
  title: string;
  start: string;
  end: string;
  external?: boolean;
  attendees?: number;
  /** This event is what the item serves (prep, follow-up). */
  servesItem?: boolean;
  attended?: boolean | null;
}

export interface CalendarPosition {
  now: string;
  tz: string;
  workingHours?: { start: string; end: string };
  upcoming?: CalendarEventInput[];
  gaps?: Array<{ start: string; end: string; minutes: number }>;
}

export interface PolicyExplanation {
  lane: 'top3' | 'now' | 'next' | 'later' | 'background' | 'hidden' | string;
  rank?: number;
  summary: string;
  rulesHit?: Array<{ key: string; text: string }>;
}

/** Prior user feedback on NBAs for this item ("Not now: wrong account", edits, rejections). */
export interface NbaFeedback {
  at: string;
  kind: 'not_now' | 'rejected' | 'edited' | 'kept_mine';
  reason?: string;
}

// ---------- Verb-specific context ----------

export interface ToolCatalogEntry {
  id: string;
  name: string;
  description: string;
  inputs: Array<{ name: string; required: boolean; description: string }>;
  health?: 'ok' | 'down' | 'unknown';
}

export interface ActivityBlock {
  id: string;
  start: string;
  end: string;
  title: string;
  source: 'calendar' | 'claude' | 'drive' | 'slack' | 'manual';
  externalAttendees?: boolean;
  accountHint?: { id: string; name: string };
  oppHint?: { id: string; name: string; isOpen?: boolean };
  alreadyLogged?: boolean;
}

export interface ActivityContext {
  blocks: ActivityBlock[];
  /** SE Task Types allowed for this team (team pack). Verbatim strings. */
  taxonomy?: Array<{ type: string; counts: 'CF+CR' | 'CR' | 'neither' }>;
  quarter?: { label: string; ccHoursLogged?: number; target?: number; deadline?: string };
}

export interface VdpContext {
  vdpId?: string;
  url?: string;
  accountName: string;
  missingFields?: string[];
  useCases?: Array<{ title: string; priority?: string; hasCurrentDesired?: boolean }>;
  linkage?: { accountId?: string; opportunityId?: string };
  assets?: Array<{ label: string; url: string }>;
  dcStatus?: string;
}

export interface DeliverableContext {
  file: {
    id: string;
    title: string;
    url?: string;
    lastModifiedAt?: string;
    lastModifiedBy?: string;
    modifiedSinceItemCreated?: boolean;
  };
  requestedChanges: string[];
  /** Forward-sampled digest diff, one line per changed slide/section. */
  diffSummary: string[];
}

export interface SessionContext {
  /** Absolute repo path the session should open in, when known. */
  folder?: string;
  repoDescription?: string;
  relatedSessions?: Array<{ id: string; title: string; state: string; lastAt: string }>;
  constraints?: string[];
}

export interface ScheduleContext {
  durationMin?: number;
  attendees?: PersonInput[];
  windowEnd?: string;
}

export interface VerbContext {
  tools?: ToolCatalogEntry[];
  activity?: ActivityContext;
  vdp?: VdpContext;
  deliverable?: DeliverableContext;
  session?: SessionContext;
  schedule?: ScheduleContext;
}

/** The state of the previous NBA version and its draft, for the update rule. */
export interface PreviousNbaInput {
  version: number;
  generatedAt: string;
  /** The previous NBA output (validated JSON). */
  output: unknown;
  draftState?: {
    /** drafts.edited_by_user: once true, engines can only propose (R-UI-20). */
    userTouched: boolean;
    /** The user's current draft text (plain text rendering of doc_json). */
    currentText?: string;
    lockedFields?: string[];
  };
}

export interface NbaUser {
  name: string;
  role: string;
  tz: string;
  slackId?: string;
  email?: string;
  managerName?: string;
}

export interface NbaInput {
  verb: NbaVerb;
  now: string;
  user: NbaUser;
  workItem: WorkItemInput;
  initiative?: InitiativeSummary;
  evidence: EvidenceEntry[];
  destination?: DestinationInput;
  thread?: ThreadMessage[];
  calendar?: CalendarPosition;
  policy?: PolicyExplanation;
  /** Rendered voice block (see src/engines/voice/render.ts). */
  voice?: string;
  previous?: PreviousNbaInput;
  verbContext?: VerbContext;
  feedback?: NbaFeedback[];
  /**
   * D-55: the Persona block (renderPersonaBlock): the user's role, duties and rules, in the dynamic user prompt (the
   * skills stay one cached prefix). Absent: no block (nba-common then reads the user line's role alone).
   */
  persona?: string;
}
