/**
 * BE-CHAT (BE-6) types shared by the chat runner, its tools, the turn loop and both DataSources.
 *
 * The runner yields `ChatRunStep`s; the turn loop (src/server/chat/turn.ts) turns them into SSE events and
 * persisted parts. Tools read and stage changes through a `ChatHost`, which each DataSource implements
 * (mock: in-memory store; db: Postgres). The host never sends, posts or writes to an external system:
 * changes are staged as proposals (applied only by the user's Apply), drafts stop in the Outbox, scans
 * are enqueued for the worker, and sessions are deep links the UI opens only on a click.
 */
import type { ResolvedPersona } from '@/personas';
import type { SpendGovernor } from '@/llm/spend';
import type {
  ChatChange,
  ChatHoldView,
  ChatDraftRef,
  ChatMessage,
  ChatModel,
  ChatPlan,
  ChatResource,
  ChatRoute,
  ChatScan,
  ChatSession,
  ChatUsage,
  ContextRef,
  EntityRef,
  FieldChange,
  Proposal,
  Receipt,
  SourceKind,
  StageLogBatchResult,
  DraftVdpUpdateRequest,
  FindVdpAssetsRequest,
  FindVdpAssetsResult,
} from '@/contract';
import type { Org62LookupInput, Org62LookupResult } from '@/server/chat/org62';
import type { ChatReadPage, ChatReadResult, ReadPageArgs, ReadPageInfo } from '@/server/chat/read';
import type { ChatResearchInput, ChatResearchResult } from '@/server/chat/research';
import type { QueryArgs, QueryResult } from '@/server/chat/views';
import type { ChatMemoryStore } from '@/server/datasource/db/chat-memory';
import type { CompleteInput, CompleteResult } from '@/llm/provider/types';

export interface Org62LookupUsage {
  model: string;
  /** Uncached input only (D1); cache reads and writes are their own fields. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  status: 'ok' | 'error' | 'timeout';
  errorCode?: string;
  latencyMs: number;
}

/** What the runner (or a scripted backend) emits for one turn. A superset of the mock's ChatStep. */
export type ChatRunStep =
  | { type: 'text'; text: string }
  /** `id` pairs a start with its result (parallel tool calls); `args` is persisted credential-redacted. */
  | { type: 'tool-start'; id?: string; name: string; summary: string; args?: unknown }
  | { type: 'tool-result'; id?: string; summary: string; ok?: boolean; result?: unknown; costUsd?: number; held?: boolean }
  /** Assistant v2: the plan card (new, or answered). */
  | { type: 'plan'; plan: ChatPlan }
  | { type: 'receipt'; receipt: Receipt }
  | { type: 'proposal'; proposal: Proposal; summary: string; changes?: ChatChange[] }
  | { type: 'resource'; resource: ChatResource }
  /** A running tool's progress (chat-started scans); `id` is the tool-start's. */
  | { type: 'tool-progress'; id: string; done: number; total: number }
  | { type: 'draft'; draft: ChatDraftRef }
  | { type: 'session'; session: ChatSession }
  /** Tokens and cost of the turn (stored on the assistant message; the ledger row is the host's job). */
  | { type: 'usage'; usage: ChatUsage }
  /** The turn's spend so far (model calls + sub-runs), sent as it climbs (SSE `usage-delta`; ASSIST-9). */
  | { type: 'usage-delta'; spentUsd: number; model: string; subRunUsd?: number; hold?: ChatHoldView }
  /** Spend governor: the answer passed its hold and waits at its next step for the user (SSE `spend-ask`). */
  | { type: 'spend-ask'; holdId: string; question: string; spentUsd: number; heldUsd: number; moreUsd: number }
  | { type: 'error'; code: 'validation' | 'upstream_unavailable' | 'internal' | 'budget_exceeded'; message: string; retryable?: boolean; details?: ChatErrorDetails };

/** One item as the tools show it to the model (compact, no bodies). */
export interface ChatItemHit {
  id: string;
  title: string;
  kind: string;
  state: string;
  rank: number | null;
  due: string | null;
  startBy: string | null;
  snoozedUntil: string | null;
  account: string | null;
  why: string;
  topReasons: string[];
  locked: string[];
  /** The item's version (a patchItem's ifVersion). */
  version?: number;
}

/** A source found in the ledger or through a read-only connector lookup. */
export interface ChatSourceHit {
  source: SourceKind | 'ledger';
  kind: string;
  title: string;
  excerpt: string;
  url: string | null;
  externalId: string | null;
  at: string | null;
  /** Work item the source is evidence for, when known. */
  workItemId: string | null;
  workItemTitle: string | null;
}

export type ChatSourceName = 'ledger' | 'gmail' | 'drive';

/** D-58: the live Google reads the Assistant calls directly (the research run's handlers, src/llm/research/tools.ts). */
export type ChatGoogleTool = 'gmail_search' | 'gmail_thread' | 'drive_search' | 'drive_read' | 'calendar_events';

export interface ChatBudget {
  /** Spent on chat today (owner timezone day). */
  chatTodayUsd: number;
  /** Chat's own daily line. */
  chatDailyUsd: number;
  /** All LLM spend today vs the hard cap (settings.budgets). */
  totalTodayUsd: number;
  hardCapUsd: number;
  /** Cap for one message (one turn). */
  perMessageUsd: number;
  maxTurns: number;
  /**
   * Cap for one run research run (settings.chat.researchUsd, D-51: $0.50): its own line per run, checked against the
   * assistant's day line only, never against what is left of this message's cap (ASSIST-1, 2026-11-20).
   */
  researchUsd?: number;
}

export interface ChatUsageRecord {
  threadId: string;
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** True when cost came from the rate card (no result message: aborted / capped). */
  estimated: boolean;
  status: 'ok' | 'error' | 'timeout' | 'budget_blocked';
  errorCode?: string;
  latencyMs: number;
  /** A sub-call a tool made for this message (e.g. `read-lookup@1` for the Org62 lookup); default the chat skill. */
  skill?: string;
}

export interface StageInput {
  threadId: string;
  messageId: string;
  changes: ChatChange[];
  lines: FieldChange[];
  entity: EntityRef;
  reason: string;
}

export interface DraftInput {
  channel: 'slack' | 'email';
  to: string;
  threadRef?: string;
  subject?: string;
  intent: string;
  body?: string;
  workItemId?: string;
  threadId: string;
}

export interface SessionInput {
  repo: string;
  prompt: string;
  title?: string;
  workItemId?: string;
  threadId: string;
}

/** A preview of a change list: the display lines, the entity the card names, and what can't apply. */
export interface ChangePreview {
  lines: FieldChange[];
  entity: EntityRef;
  errors: string[];
  /** Normalized changes (ids resolved, deltas clamped). */
  changes: ChatChange[];
}

/** Everything the chat tools may do. Implemented per DataSource; never sends anything outside the app. */
export interface ChatHost {
  readonly kind: 'mock' | 'db';
  now(): Date;
  timezone(): Promise<string>;

  // ---- reads ----
  /** The compact context pack (today, ranked items, calendar, outbox, health, policy). */
  contextPack(): Promise<Record<string, unknown>>;
  /** D-55: the user's persona; the turn's tool list, read pages, app routes and SOQL objects follow it (absent: every tool, as before personas). */
  persona?(): Promise<ResolvedPersona>;
  searchSources(query: string, opts: { sources: ChatSourceName[]; limit: number; signal?: AbortSignal }): Promise<{ hits: ChatSourceHit[]; notes: string[] }>;
  /** Live, read-only Org62 search (opportunities or accounts), matched to the app's ids (src/server/chat/org62.ts). */
  org62Lookup(input: Org62LookupInput, signal?: AbortSignal): Promise<Org62LookupResult & { usage?: Org62LookupUsage }>;
  /** Deep research for one question across live Slack, Gmail, Calendar, Drive and Org62 (src/server/chat/research.ts). */
  research(input: ChatResearchInput, o: { costCapUsd: number; signal: AbortSignal; onTool?: (fullName: string) => void }): Promise<ChatResearchResult>;
  /**
   * The next logging batch (src/server/datasource/db/store/log-batch.ts): the work orders Slackbot would run, the rows
   * that need input, and the Org62 check. Read only: staging the canvas is an Outbox action.
   */
  logBatch(input: { from?: string; to?: string; includeProposed?: boolean; appliedOffset?: number }): Promise<ChatLogBatch>;
  /** "Find assets": background research runs per VDP (or all, within a total cap) → asset candidates; never writes VDP. */
  findVdpAssets(input: FindVdpAssetsRequest): Promise<FindVdpAssetsResult>;
  /** One VDP field change → one Outbox item (ready; sent to VDP only on its own Apply). */
  draftVdpUpdate(input: DraftVdpUpdateRequest): Promise<{ draftId: string; target: string; changes: Array<{ label: string; before: string | number | null; after: string | number | null }> }>;
  /** Stage that batch: one Outbox canvas item per work order (ready; each sent only on its own Apply). */
  stageLogBatch(input: { from?: string; to?: string; includeProposed?: boolean; dcOnly?: boolean }): Promise<StageLogBatchResult>;
  /**
   * Start a connector's sign-in, exactly as Health ▸ Re-auth does (POST /connectors/:id/reauth): for VDP and Org62 a
   * Terminal and browser window open on this machine for the user's MFA; the worker re-probes and catches up.
   */
  reauth(source: string): Promise<{ found: boolean; label?: string; state?: string; started?: boolean; how?: string }>;
  /** A page of the app (src/server/chat/read.ts): one read-only route, shaped for the model and paged (never cut). */
  read(page: ChatReadPage, args: Record<string, unknown>, paging?: ReadPageArgs): Promise<ChatReadResult>;
  /** D-58: any `read` route of the app's API (src/server/chat/app-routes.ts), checked by its own schemas, paged. */
  appRead(route: string, raw: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }, paging?: ReadPageArgs): Promise<{ route: string; data: unknown; paging: ReadPageInfo | null; more?: Record<string, { shown: number; total: number; nextOffset: number }>; summary: string }>;
  /**
   * D-58: live Gmail, Drive and Calendar reads through the read-only Google client (db + live connectors only; elsewhere
   * a note that they aren't available). Redacted and capped.
   */
  googleRead(tool: ChatGoogleTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; ok: boolean; available: boolean }>;
  /**
   * D-58: the scanners' Slack and Org62 MCP servers load into the turn (db + live connectors only). The mock never
   * calls out, so it says false.
   */
  readonly liveReads: boolean;
  /** Earlier messages of the thread, oldest first (without `excludeIds`). */
  history(threadId: string, excludeIds: string[]): Promise<ChatMessage[]>;

  // ---- Assistant v2 ----
  /** A typed read over the curated views (src/server/chat/views.ts), filtered, sorted and paged. */
  query(args: QueryArgs): Promise<QueryResult>;
  /** Why an item ranks, was closed or kept open, and its evidence; or why a time row was attributed (the engines' own `why`). */
  explain(id: string, what: 'rank' | 'closure' | 'evidence' | 'attribution' | 'all'): Promise<Record<string, unknown>>;
  /**
   * One live read through the connector runtime (Slack through the one-call relay, VDP over its read-only JSON-RPC),
   * read tools only (the manifests' allowlists). Absent: no live connectors here (mock, or connectors off).
   */
  liveRead?(connector: 'slack' | 'vdp', tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; costUsd: number; model?: string; inputTokens?: number; outputTokens?: number; ok: boolean }>;
  /** One Org62 opportunity by id, through the fixed SELECT template (src/server/chat/org62.ts); never free SOQL. */
  org62Record?(id: string): Promise<Org62LookupResult & { usage?: Org62LookupUsage }>;
  /** Memory (`remember`, compaction summaries) and the thread's SDK session id. */
  memory?: ChatMemoryStore;
  /** Run a staged chat card at once (act's allow class: the change set path an Apply takes, actor chat). */
  applyStaged?(proposalId: string): Promise<Receipt | null>;
  /** Start a read-only job (the `run` class): read-in, forecast sync / check, retry. */
  startJob?(route: 'requestReadIn' | 'syncForecast' | 'checkMissingForecast' | 'retryJob', raw: { params?: Record<string, unknown>; body?: unknown }): Promise<unknown>;
  /** A tool-less model call (compaction summaries; fast tier). Absent: the active provider's `complete()`. */
  complete?(input: CompleteInput): Promise<CompleteResult>;

  // ---- staged changes (nothing lands until the user applies) ----
  previewChanges(changes: ChatChange[], threadId?: string): Promise<ChangePreview>;
  stageChanges(input: StageInput): Promise<Proposal>;

  // ---- in-app side effects (never external) ----
  rescan(connector: string, windowHours: number): Promise<ChatScan>;
  scanStatus(scanId: string): Promise<ChatScan | null>;
  createDraft(input: DraftInput): Promise<ChatDraftRef>;
  prepareSession(input: SessionInput): Promise<ChatSession>;

  // ---- spend ----
  budget(model: ChatModel): Promise<ChatBudget>;
  recordUsage(u: ChatUsageRecord): Promise<void>;
  /**
   * The spend governor (src/llm/spend): each message holds its per-message budget and raises a hand past it instead of
   * stopping (H-5). Absent: an in-memory governor for the turn (asks still reach the card; nothing persists).
   */
  spend?(): SpendGovernor;
}

/** A logging batch preview for the Assistant (counts, canvases, skips, the Org62 check). */
export interface ChatLogBatch {
  available: boolean;
  note?: string;
  mode?: 'on_demand' | 'automatic';
  canvasStyle?: 'per_batch' | 'shared';
  events: number;
  hours: number;
  updates: number;
  approveCount: number;
  canvases: Array<{ part: number; parts: number; title: string; rows: number; hours: number; updates: number; chars: number; preview: string }>;
  skipped: Array<{ id: string; date: string; description: string; why: string }>;
  /** Rows an earlier batch's canvas item still holds in the Outbox (not in this batch until it is Applied or rejected). */
  waiting?: { rows: number; hours: number; draftIds: string[] };
  discrepancies: Array<{ id: string; date: string; description: string; kind: string; detail: string }>;
  recordTypeKnown: boolean;
  ownerKnown: boolean;
  /** Logging canvases already applied, newest first: created in Slack (unless still applying), with the link and the rows' Org62 state. */
  applied?: Array<{ draftId: string; title: string; state: string; created: boolean; url: string | null; appliedAt: string | null; rows: number; hours: number; dcs: number; org62: { logged: number; waiting: number; missing: number } | null }>;
  /** How many canvases are applied in all, and where the next page of `applied` starts (null: this is the last page). */
  appliedTotal?: number;
  appliedNextOffset?: number | null;
}

/** What a capped message offers: re-send it with `allowExtraUsd: usd` (the UI's "Allow $x more"). */
export interface ChatErrorDetails {
  allowMore?: { usd: number; scope: 'message' | 'day' };
  /** The error catalog's code when the API code is too coarse (src/errors/catalog.ts: RATE.CHAT.STEP_LIMIT, P31-1). */
  catalogCode?: string;
}

/** Input of one turn. */
export interface ChatTurnInput {
  threadId: string;
  messageId: string;
  userMessageId: string;
  text: string;
  /** Message chips plus the thread's context (the "Looking at:" chip is the first `auto` one). */
  context: ContextRef[];
  model: ChatModel;
  signal: AbortSignal;
  /** The user's one-time approval to spend this much more on this message (ChatRequest.allowExtraUsd). */
  allowExtraUsd?: number;
  /**
   * "Allow more" on a message stopped at its cost limit (ChatRequest.continueMessageId): continue that answer instead of
   * re-running the question. The stopped message's text and tool rows are the context; this turn's cap is the amount
   * allowed (ASSIST-2, 2026-11-20).
   */
  continueMessageId?: string;
  /** Assistant v2: the router's choice for this turn (src/llm/chat/router.ts); absent: routed from `model` as chosen. */
  route?: ChatRoute;
}

/** A chat backend: one turn → steps. The fake and the Agent SDK runner both have this shape. */
export type ChatTurnRunner = (input: ChatTurnInput, host: ChatHost) => AsyncIterable<ChatRunStep>;
