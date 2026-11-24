/**
 * Scanner contract, shared by:
 *   BE-2a: runtime (scheduler, resume, reconcile, SkillRunner on the Agent SDK, cc tools, traversal skills)
 *   BE-2b: deterministic fetchers (devbar google_workspace_readonly, Claude sessions, Drive digests)
 *   BE-1:  the DB-backed ScannerStore implementation (src/scanner/store-db.ts, over src/db/**)
 *
 * The orchestrator owns this file. If you need to change it, raise a `blocker`.
 * CONTRACT-1 folded in BE-2a's optional extensions (formerly runtime/contract-ext.ts, which now re-exports).
 * Spec: docs/reference/SCANNER.md. Schema: docs/reference/DATA-MODEL.md.
 */
import type { CallMeasurement } from '../db/ledger';
import type { ResolvedPersona } from '../personas/types';

export type ConnectorId =
  | 'slack'
  | 'org62'
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'gemini_notes'
  | 'claude_sessions'
  | 'trainings'
  | 'watch'
  | 'vdp';

/** For example { connector: 'slack', scope: 'dm' } or { connector: 'slack', scope: 'channel:C123' } or { connector: 'drive', scope: 'tracked' }. */
export interface ScopeKey {
  connector: ConnectorId;
  scope: string;
}

export const scopeId = (k: ScopeKey) => `${k.connector}:${k.scope}`;

/** The cursor value is opaque per source (Slack ts, Gmail internalDate/historyId, Drive modifiedTime, SOQL SystemModstamp, jsonl byte offset…). */
export interface Cursor {
  value: string;
  /** Wall-clock time the cursor represents (ISO), used for gap math and resume planning. */
  at: string;
}

export interface TimeWindow {
  from: string; // ISO, inclusive
  to: string; // ISO, exclusive
}

export type ScanTrigger = 'schedule' | 'catch_up' | 'reconcile' | 'manual' | 'chat' | 'file_watch';

export type SourceItemKind =
  | 'message'
  | 'thread'
  | 'email'
  | 'calendar_event'
  | 'file_revision'
  | 'meeting_notes'
  | 'record_snapshot'
  | 'claude_session'
  | 'training_notice'
  | 'manual_note';

export interface PersonRef {
  name?: string;
  email?: string;
  /** Slack user id, Org62 user id, etc. */
  externalId?: string;
  isMe?: boolean;
  isExternal?: boolean;
}

/** One normalized raw observation. Everything a scanner sees is recorded as one of these, idempotently. */
export interface NormalizedSourceItem {
  connector: ConnectorId;
  kind: SourceItemKind;
  /** The id in the source system (Slack `channel:ts`, Gmail message id, Drive `fileId@modifiedTime`…). */
  externalId: string;
  /** Stable idempotency key. The same observation always produces the same key. */
  dedupeKey: string;
  /** Hash of the normalized content; a changed hash with the same dedupeKey means an edit. */
  contentHash: string;
  occurredAt: string; // ISO
  author?: PersonRef;
  participants?: PersonRef[];
  permalink?: string;
  title?: string;
  /** Credential-redacted excerpt, at most 1000 chars. Full bodies go in `payload`, subject to 90-day retention. */
  excerpt?: string;
  redacted?: boolean;
  /** Thread or conversation grouping, e.g. `slack:C123:1730812345.000100`, `gmail-thread:abc`. */
  threadRef?: string;
  /** Referenced files/links (Drive ids, URLs), recorded as references; not fetched unless the skill says so. */
  fileRefs?: string[];
  /** Hints for linking (account names/aliases, opp ids, channel mapping) gathered during fetch. */
  accountHints?: string[];
  oppHints?: string[];
  /** Source-specific payload (jsonb). Never include tokens or cookies. */
  payload?: Record<string, unknown>;
}

export type CoverageKind =
  | 'channel_range'
  | 'thread'
  | 'message'
  | 'mailbox_range'
  | 'email'
  | 'calendar_range'
  | 'file'
  | 'query_window'
  | 'session'
  | 'record';

/** What was scanned: written to the coverage ledger so misses can be reconciled. */
export interface CoverageObject {
  kind: CoverageKind;
  /** Channel id, thread ref, message id, file id, SOQL object name, session id… */
  ref: string;
  from?: string; // ISO or a source position (ts)
  to?: string;
  meta?: Record<string, unknown>;
}

export interface FetchResult {
  items: NormalizedSourceItem[];
  coverage: CoverageObject[];
  nextCursor: Cursor;
  /** False when the source paged out or a limit was hit. The runtime schedules a continuation. */
  complete: boolean;
  /**
   * Nothing for the skill to interpret (Calendar history before the live range, first scan B-080): the runtime records
   * the items and the coverage and never runs the agent or flags the items unlinked.
   */
  recordOnly?: boolean;
  /**
   * D3: items recorded without the model (a Claude session's busy ↔ idle flip): their live state shows at once, and
   * the skill never sees them. Each one has its reason in `decisions`.
   */
  quietItems?: NormalizedSourceItem[];
  /** D0: why the fetcher kept items from the model (llm_decisions, kind skip). Ids and codes only. */
  decisions?: Array<{ reason: string; subject: string; detail?: Record<string, unknown> }>;
}

export type ReauthKind = 'in_app' | 'terminal_command' | 'refresh_script' | 'instructions';

export interface ConnectorHealthProbe {
  state: 'ok' | 'degraded' | 'auth_required' | 'down' | 'disabled';
  detail?: string;
  /** Error classification per brief 09 §5. */
  errorClass?: 'auth' | 'transient' | 'rate_limited' | 'config' | 'unknown';
  reauth?: { kind: ReauthKind; command?: string; url?: string; instructions?: string };
  checkedAt: string;
}

/** Deterministic sources: code fetches and the Haiku skill agent interprets and links (SCANNER.md §2.1). */
export interface DeterministicFetcher {
  connector: ConnectorId;
  /** Scopes to scan for this user (from settings and the watch list). */
  scopes(ctx: { userId: string }): Promise<string[]>;
  fetch(
    scope: string,
    cursor: Cursor | null,
    window: TimeWindow,
    opts: { signal: AbortSignal; limit?: number },
  ): Promise<FetchResult>;
  /** Cheap listing for reconcile: which objects exist in the window, compared against the coverage ledger. */
  listForReconcile?(scope: string, window: TimeWindow, opts: { signal: AbortSignal }): Promise<CoverageObject[]>;
  health(): Promise<ConnectorHealthProbe>;
  /** E3: when the stored sign-in was issued (ms; no network), or null when unknown. VDP: its gateway cookie. */
  credentialsIssuedAt?(): number | null;
}

// ---------- Store: everything the scanner reads and writes. BE-1 implements it over Postgres change sets. ----------

export type EvidenceRole = 'origin' | 'progress' | 'completion' | 'context' | 'contradiction';
export type Confidence = 'sure' | 'likely' | 'guess';

/** R-UI-22: how a closed item was resolved (same values as the API contract's `Resolution`). */
export type Resolution = 'done_by_me' | 'handed_off' | 'done_by_other' | 'not_needed' | 'duplicate' | 'declined' | 'superseded';

/** R-UI-22: my involvement in an item. */
export type Involvement = 'owner' | 'contributor' | 'watcher' | 'not_involved';

/** R-UI-22 fields carried by digests and candidates. Handed-off items take only context, except a direct ask of me. */
export interface ResolutionFields {
  resolution?: Resolution;
  involvement?: Involvement;
  /** For hand-offs: who owns it now (display name or email). */
  handedOffTo?: string;
}

/** True when new evidence on this item is context only (R-UI-22), unless it is a direct ask of me. */
export function isContextOnly(x: ResolutionFields | undefined): boolean {
  if (!x) return false;
  return x.resolution === 'handed_off' || x.involvement === 'watcher' || x.involvement === 'not_involved';
}

/** Reason prefix that marks a "looped back in" signal (SCANNER.md §4.5). */
export const LOOP_BACK_PREFIX = 'loop_back:';

export interface OpenItemDigest extends ResolutionFields {
  workItemId: string;
  initiativeId?: string;
  kind: string;
  title: string;
  purpose?: string;
  state: string;
  people: string[];
  accounts: string[];
  keywords: string[];
  threadRefs: string[];
  fileRefs: string[];
  lastEvidenceAt?: string;
  /** R-UI-15 deliverable expectations, used by the Drive judge. */
  expected?: { fileId?: string; changes?: string[] };
}

export interface ScanContext {
  scope: ScopeKey;
  cursor: Cursor | null;
  /** Gaps in coverage for this scope, from the ledger. */
  gaps: TimeWindow[];
  me: { userId: string; name: string; email?: string; slackId?: string; org62UserId?: string };
  watchList: Array<{ kind: string; ref: string; label: string }>;
  aliases: { accounts: Array<{ accountId: string; names: string[] }>; channels: Array<{ channelId: string; accountId?: string; label?: string }> };
  openItems: OpenItemDigest[];
  initiatives: Array<{ initiativeId: string; title: string; purpose?: string; accounts: string[]; keywords: string[] }>;
  skillVersion: string;
  /** Settings ▸ Scanning (SCAN-SET). Absent: the defaults (`DEFAULT_SCANNING_PREFS`). */
  scanning?: ScanningPrefs;
  /**
   * D-55: the user's resolved persona, read fresh with every context (a switch applies to the next run, no restart).
   * It decides the Org62 scopes and book, and the prompts' Persona block. Absent: the SE persona (as before personas).
   */
  persona?: ResolvedPersona;
}

/** Settings ▸ Scanning, as the scanner reads it (the contract's `ScanningSettings` without its version). */
export interface ScanningPrefs {
  /** An ask to a whole channel (@channel, @here) or a list of people: Ask me (suggested), Treat as mine, or Ignore. */
  channelAsks: 'ask' | 'mine' | 'ignore';
  /** "Catch up: <meeting>" items from the notes of a meeting I missed. */
  meetingCatchUps: boolean;
  /** "Get up to speed on <opp>" items when I am added to an opp team. */
  oppTeamCatchUps: boolean;
  /** "Where does this belong?" questions: only for my asks and commitments, for anything unlinked, or never. */
  mappingQuestions: 'mine' | 'all' | 'never';
}

export const DEFAULT_SCANNING_PREFS: ScanningPrefs = { channelAsks: 'ask', meetingCatchUps: false, oppTeamCatchUps: false, mappingQuestions: 'mine' };

/** A stored `settings.scanning` value (any shape) as ScanningPrefs: unknown or missing fields take the defaults. */
export function scanningPrefsOf(v: unknown): ScanningPrefs {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const pick = <T extends string>(x: unknown, ok: readonly T[], d: T): T => (typeof x === 'string' && (ok as readonly string[]).includes(x) ? (x as T) : d);
  const d = DEFAULT_SCANNING_PREFS;
  return {
    channelAsks: pick(o.channelAsks, ['ask', 'mine', 'ignore'] as const, d.channelAsks),
    meetingCatchUps: typeof o.meetingCatchUps === 'boolean' ? o.meetingCatchUps : d.meetingCatchUps,
    oppTeamCatchUps: typeof o.oppTeamCatchUps === 'boolean' ? o.oppTeamCatchUps : d.oppTeamCatchUps,
    mappingQuestions: pick(o.mappingQuestions, ['mine', 'all', 'never'] as const, d.mappingQuestions),
  };
}

/** TRI-CTX: one recorded message of a conversation, read back for triage context (any window). */
export interface ConversationLine {
  sourceItemId: string;
  item: NormalizedSourceItem;
}

export interface Candidate extends ResolutionFields {
  workItemId?: string;
  initiativeId?: string;
  title: string;
  score: number; // 0..1
  why: string;
  /** The candidate item's state, when it is a work item. */
  state?: string;
}

export interface ProposeItemInput {
  kind: 'task' | 'commitment' | 'ask' | 'training' | 'follow_up' | 'travel' | 'deliverable';
  title: string;
  purpose?: string;
  due?: string;
  effort?: { youMin?: number; agentMin?: number };
  initiativeId?: string;
  accountId?: string;
  oppId?: string;
  /** Deliverable expectations (R-UI-15): target file plus requested changes. */
  expected?: { fileId?: string; changes?: string[] };
  evidence: Array<{ sourceItemId: string; role: EvidenceRole; reason: string }>;
  confidence: Confidence;
}

/** R-UI-21 brief output (`ScannerStore.recordBriefHighlights`, the `cc_record_brief_highlights` tool). */
export interface BriefHighlightsInput {
  subscription: { kind: 'channel' | 'opp' | 'account' | 'person' | 'search'; ref: string };
  period: TimeWindow;
  summary: string;
  highlights: Array<{ title: string; relevance: 'high' | 'medium' | 'low'; reasons: string[]; sourceItemIds: string[]; suggestedAction: 'promote' | 'task' | 'ignore' }>;
}

/** One `unlinkedSourceItems` row. Relinking needs the gist, so stores SHOULD fill the optional fields. */
export interface UnlinkedSourceItemDetail {
  sourceItemId: string;
  attempts: number;
  reason: string;
  hints?: string[];
  connector?: ConnectorId;
  excerpt?: string;
  title?: string;
  threadRef?: string;
  occurredAt?: string;
  /** MAP-1: the message is mine (a commitment) or addressed to me (an ask). Stores SHOULD fill these. */
  fromMe?: boolean;
  toMe?: boolean;
}

export interface ScanRunStats {
  fetched: number;
  new: number;
  changed: number;
  linked: number;
  proposed: number;
  unlinked: number;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
}

export interface ScannerStore {
  getContext(scope: ScopeKey, opts?: { maxOpenItems?: number }): Promise<ScanContext>;
  /** D-55: the resolved persona alone (the runtime reloads it on every plan pass). Absent: the SE persona. */
  persona?(): Promise<ResolvedPersona>;

  startRun(input: {
    scope: ScopeKey;
    trigger: ScanTrigger;
    window: TimeWindow;
    model?: string;
    skillVersion?: string;
    /** The queue row running this scan (`scan_runs.job_id`). The DB store adopts a queued UI placeholder run of this job. */
    jobId?: number | string;
  }): Promise<{ runId: string }>;

  recordSourceItems(runId: string, items: NormalizedSourceItem[]): Promise<Array<{ sourceItemId: string; dedupeKey: string; isNew: boolean; changed: boolean }>>;
  findCandidates(q: { text?: string; people?: string[]; accounts?: string[]; threadRefs?: string[]; fileRefs?: string[]; limit?: number }): Promise<Candidate[]>;
  linkEvidence(runId: string, input: { workItemId: string; sourceItemId: string; role: EvidenceRole; confidence: Confidence; reason: string }): Promise<{ evidenceId: string; touchedWorkItemId: string }>;
  proposeItem(runId: string, input: ProposeItemInput): Promise<{ workItemId: string; landedAs: 'open' | 'suggested' }>;
  proposeInitiative(runId: string, input: { title: string; purpose: string; accountId?: string; oppId?: string; workItemIds: string[] }): Promise<{ initiativeId: string }>;
  flagUnlinked(runId: string, input: { sourceItemId: string; reason: string; hints?: string[] }): Promise<void>;
  reportCoverage(runId: string, objects: CoverageObject[]): Promise<void>;
  /** R-UI-21: watch/opp brief output from scan-watch (and BE-5's brief jobs). */
  recordBriefHighlights(runId: string, input: BriefHighlightsInput): Promise<{ briefId: string }>;

  /** Atomic: validate that coverage spans up to the cursor, then advance the cursor, write stats and close the run. */
  finishRun(runId: string, input: { cursor: Cursor; summary?: string; stats: ScanRunStats }): Promise<{ touchedWorkItemIds: string[] }>;
  failRun(runId: string, input: { error: string; errorClass?: ConnectorHealthProbe['errorClass']; stats?: Partial<ScanRunStats> }): Promise<void>;

  /** Ledger queries for resume/reconcile. */
  getCursor(scope: ScopeKey): Promise<Cursor | null>;
  coverageGaps(scope: ScopeKey, window: TimeWindow): Promise<TimeWindow[]>;
  /** Earliest and latest committed coverage of a scope (null when none). Optional: the first-scan planner uses it. */
  coverageSpan?(scope: ScopeKey): Promise<{ from: string; to: string } | null>;
  uncoveredObjects(scope: ScopeKey, listed: CoverageObject[]): Promise<CoverageObject[]>;
  unlinkedSourceItems(opts: { connector?: ConnectorId; minAttempts?: number; maxAttempts?: number; limit?: number }): Promise<UnlinkedSourceItemDetail[]>;
  /** MAP-1: stop asking about an unlinked item (no mapping question: not an ask or commitment of mine). Optional. */
  ignoreUnlinked?(sourceItemId: string, note: string): Promise<void>;
  /**
   * TRI-CTX: a conversation's recorded messages from any run or window, oldest first: the last `before.limit` before
   * `before.at` and the first `after.limit` after `after.at`. A DM by `channelId`, a thread by `threadRef`. Optional.
   */
  conversationLines?(q: { channelId?: string; threadRef?: string; before: { at: string; limit: number }; after: { at: string; limit: number } }): Promise<ConversationLine[]>;
  /** TRI-NOISE: persist triage verdicts on their messages, so a later run carries a noise verdict forward. Optional. */
  recordTriageVerdicts?(verdicts: Array<{ sourceItemId: string; v: 'act' | 'noise' | 'unsure'; why?: string }>): Promise<void>;
  /** TRI-NOISE: the latest stored verdict of each message (absent: none). Optional. */
  triageVerdicts?(sourceItemIds: string[]): Promise<Map<string, { v: 'act' | 'noise' | 'unsure'; why?: string }>>;

  recordHealth(connector: ConnectorId, probe: ConnectorHealthProbe): Promise<void>;
  /**
   * E3 (audit 2026-11-13, lane E): when the connector's stored health says it needs re-auth (`connectors.status =
   * auth_required`), the time of its last auth failure; null when it doesn't. The runtime starts such a connector's
   * scopes auth-paused (specs that opt in), so a restart doesn't go back to a sign-in that already failed. Optional.
   */
  authPausedSince?(connector: ConnectorId): Promise<string | null>;
  /**
   * `budget`: which budget the spend counts against (default: the current job's, else daily). `jobId`: the job that ran
   * it (default: the run's job, else the current job). Both only attribute the spend (AUDIT); caps are unchanged.
   */
  recordSpend(input: SpendRead | SpendBooked): Promise<{ todayUsd: number; softCapUsd: number; hardCapUsd: number }>;
  /** D0: record a decision not to call the model (skip), to escalate, or a refused call (block). Never throws. */
  recordDecision?(d: { skill: string; kind: 'skip' | 'escalate' | 'block'; reason: string; trigger?: string | null; subject?: string | null; usd?: number; detail?: Record<string, unknown>; at?: Date; count?: number }): Promise<void>;
  /** D6: today's Slack triage escalation allowance (Settings ▸ Budgets) and what the stronger model spent on it. */
  escalationAllowance?(): Promise<{ capUsd: number; spentUsd: number }>;
  /** D6: hold `usd` against today's hard cap while a call runs; release it once the spend is booked. */
  reserveSpend?(usd: number, o?: { budget?: 'daily' | 'first_scan' }): Promise<{ ok: boolean; heldUsd: number; release(): Promise<void> }>;
}

/** `recordSpend` as a pure read of today's spend vs the caps (no row). */
export interface SpendRead {
  connector: ConnectorId | 'nba' | 'chat' | 'brief';
  model: string;
  costUsd: 0;
  runId?: string;
  budget?: 'daily' | 'first_scan';
  jobId?: number;
}

/**
 * `recordSpend` booking a call (D0): its tokens (uncached input, output, cache; per model when the SDK says) and every
 * audit field are required, so a writer that leaves one out does not compile.
 */
export interface SpendBooked {
  connector: ConnectorId | 'nba' | 'chat' | 'brief';
  model: string;
  costUsd: number;
  runId?: string;
  budget?: 'daily' | 'first_scan';
  jobId?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usage?: SkillRunResult['usage'];
  /** The skill (default the connector's). */
  skill?: string;
  /** What started it, why this model, what came of it, and the hash of its prompt + input. */
  trigger: string;
  modelReason: string;
  outcome: string;
  contentHash: string;
  /** 0027: what the call measured (booked on a row no pass trace row covers). */
  measure?: CallMeasurement;
}

// ---------- Skill runner: one Agent SDK call per scan step ----------

export interface SkillRunInput {
  skillPath: string; // skills/scan-slack.md
  model: string; // claude-haiku-5-5 by default
  /** Only this connector's MCP server (restricted config, brief 09). Empty for deterministic sources. */
  mcpServers: Record<string, unknown>;
  /** Exact read-only tool allowlist. A call to anything else aborts the run. */
  allowedTools: string[];
  /** The run's id, so cc tools write into it. */
  runId: string;
  context: ScanContext;
  /** Pre-fetched normalized items for deterministic sources. */
  prefetched?: NormalizedSourceItem[];
  maxTurns: number;
  costCapUsd: number;
  /** The run's watchdog (ms); default the runner's (3 min). ORG-2: paged Org62 scopes need longer. */
  timeoutMs?: number;
  signal: AbortSignal;
  /** The step's time window (the Run block). */
  window?: TimeWindow;
  /** incremental | head | backfill | continuation | reconcile | relink | targeted */
  mode?: string;
  /** Extra Run-block substitutions (channel id, thread ref, opp ids…). */
  vars?: Record<string, string | number | boolean | undefined>;
  /** Free-form step instruction appended to the user prompt (e.g. which unlinked items to relink). */
  instruction?: string;
  /**
   * Deterministic sources: coverage the fetcher already established. The runner stages it on the run (and
   * in the cc state, so `cc_finish` validates against it); the agent does not report it again.
   */
  preReportedCoverage?: CoverageObject[];
}

/** What a run recorded (from the cc tool state), for logs and tests. */
export interface SkillRunCounts {
  recorded: number;
  new: number;
  changed: number;
  linked: number;
  proposed: number;
  unlinked: number;
  coverage: number;
}

export interface SkillRunResult {
  ok: boolean;
  costUsd: number;
  /** Uncached input tokens (D0: cache reads and writes are their own fields). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** D0: per model, from the SDK's modelUsage (a run can use more than one model). */
  usage?: Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>;
  /** D0: ledgerHash of model + skill version + prompt + input (identical calls share it). */
  contentHash?: string;
  turns: number;
  /** Set by the cc_finish tool. */
  proposedCursor?: Cursor;
  summary?: string;
  error?: { message: string; errorClass?: ConnectorHealthProbe['errorClass']; disallowedTool?: string };
  /** From `cc_finish`: false = the window was not finished; the runtime continues from `proposedCursor.at`. */
  complete?: boolean;
  counts?: SkillRunCounts;
  /** 0027: what the run measured (per-request prompt sizes, turns, tools, prefix hash, items); src/db/ledger.ts. */
  measure?: CallMeasurement;
}

export interface SkillRunner {
  run(input: SkillRunInput, store: ScannerStore): Promise<SkillRunResult>;
}

/**
 * Downstream hook: the runtime calls this for every touched work item after finishRun (BE-3 implements it).
 * `catchingUp` lets BE-3 batch quietly while a connector catches up; `trigger` is the scan's trigger.
 * (The named type is `ReevaluateReason` in runtime/scanner-runtime.ts, structurally identical.)
 */
export type ReevaluateEnqueuer = (
  workItemIds: string[],
  reason: { runId: string; connector: ConnectorId; catchingUp?: boolean; trigger?: ScanTrigger },
) => Promise<void>;
