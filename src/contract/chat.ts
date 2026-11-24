/**
 * Chat (R-UI-10): threads, messages, and the POST /chat SSE event union.
 *
 * CONTRACT-1: messages persist everything the live stream showed (errors, tool rows with redacted args and
 * results, proposal summaries + status, receipt lines with undo state), so a reload restores the thread
 * from the server alone. Every new field is optional, so older seeds and clients keep working.
 */
import { z } from 'zod';
import { ChatModel, EntityRef, EntityType, EvidenceRole, Id, IsoDateTime, SourceKind, WorkKind } from './common';
import { ApiErrorBody, Receipt } from './envelope';
import { ScanRunStatus } from './health';
import { DraftStatus } from './nba';
import { ActivityPatch, WorkItemPatch } from './requests';
import { PolicyRule, PolicyWeightKey } from './settings';
import { ChatHoldView } from './spend';
import { Proposal, Resolution } from './work';

export const ContextRef = EntityRef.extend({
  /** auto = attached from focus (removable chip); explicit = added with @. */
  via: z.enum(['auto', 'explicit']).default('explicit'),
});
export type ContextRef = z.infer<typeof ContextRef>;

export const ChatResource = z.object({
  kind: EntityType.or(z.enum(['file', 'url'])),
  id: Id,
  label: z.string(),
  href: z.string(),
});
export type ChatResource = z.infer<typeof ChatResource>;

/** Proposal card state as the chat shows it: rejected and superseded both read as "dismissed". */
export const ChatProposalStatus = z.enum(['pending', 'applied', 'dismissed']);
export type ChatProposalStatus = z.infer<typeof ChatProposalStatus>;

// ---------------------------------------------------------------------------
// BE-CHAT (BE-6) additions. All additive: optional fields only, no new part or event types.
// ---------------------------------------------------------------------------

/**
 * One structured change in a chat proposal (`propose kind changes`). Nothing lands until the user clicks
 * Apply (POST /proposals/:id/apply): the whole list then runs in ONE change set with actor `chat` and
 * comes back as a receipt (Undo via its auditId).
 */
const CHAT_EDIT_OPS = [
  /** Move an item to #1 (a rank boost, then a re-rank). */
  z.object({ op: z.literal('pin'), itemId: Id, reason: z.string().max(200).optional() }),
  /** Plain re-rank with the current policy (what POST /today/rerank does). */
  z.object({ op: z.literal('rerank'), reason: z.string().max(200).optional() }),
  z.object({ op: z.literal('snooze'), itemId: Id, until: IsoDateTime }),
  z.object({ op: z.literal('done'), itemId: Id, note: z.string().max(500).optional() }),
  z.object({ op: z.literal('reopen'), itemId: Id, reason: z.string().max(200).optional() }),
  /** R-UI-22 close with a reason; handed_off needs personName. */
  z.object({
    op: z.literal('resolve'),
    itemId: Id,
    resolution: Resolution,
    personName: z.string().max(120).optional(),
    relatedItemId: Id.optional(),
    note: z.string().max(500).optional(),
  }),
  /** Attach a source (a thread, mail, file, URL) to an item as evidence. */
  z.object({
    op: z.literal('link_evidence'),
    itemId: Id,
    role: EvidenceRole.default('context'),
    source: z.object({ kind: SourceKind, label: z.string().min(1).max(200), url: z.string().max(1000).optional(), externalId: z.string().max(300).optional() }),
    summary: z.string().min(1).max(500),
  }),
  z.object({
    op: z.literal('create_item'),
    title: z.string().min(1).max(300),
    kind: WorkKind.optional(),
    purpose: z.string().max(500).optional(),
    due: IsoDateTime.optional(),
    accountId: Id.optional(),
    initiativeId: Id.optional(),
    effortMin: z.number().int().min(1).max(960).optional(),
    /** Create it snoozed until then (e.g. "track the VDP re-auth, remind me at 14:00"). */
    snoozeUntil: IsoDateTime.optional(),
  }),
  /** Field edits. No user locks are added; the user's Apply is the approval. */
  z.object({ op: z.literal('edit_fields'), itemId: Id, patch: WorkItemPatch }),
  /**
   * Time-page rows (activity log entries): the same patch the row editor autosaves, on one or many rows at once
   * ("put these six on the ACME renewal opp", "approve last week's proposed rows"). Logged rows are never edited, and
   * nothing goes to Org62: logging stays the canvas step.
   */
  z.object({
    op: z.literal('edit_activities'),
    entryIds: z.array(Id).min(1),
    patch: ActivityPatch.pick({ oppId: true, taskType: true, meetingType: true, durationH: true, description: true, status: true }),
  }),
  /** Policy weight deltas, each clamped to 0–10: a new policy version and a re-rank. */
  z.object({ op: z.literal('policy_weights'), deltas: z.record(PolicyWeightKey, z.number().min(-10).max(10)), note: z.string().max(200).optional() }),
  /** Add, enable, disable or remove a plain-language policy rule. */
  z.object({
    op: z.literal('policy_rule'),
    action: z.enum(['add', 'enable', 'disable', 'remove']),
    ruleId: Id.optional(),
    rule: PolicyRule.omit({ id: true, enabled: true }).partial({ when: true }).optional(),
  }),
] as const;

/**
 * D-58 `propose kind calls`: one call of a `stage` route of the app's API (src/contract/routes.ts, `assistant: 'stage'`),
 * params and body checked by the route's own schemas. Apply runs it through the DataSource method the UI calls; each
 * call is its own change set, undone per receipt line (src/server/chat/app-routes.ts).
 */
export const RouteCallChange = z.object({
  op: z.literal('route_call'),
  /** The route key, e.g. "createDcRequest", "patchItem". */
  route: z.string().min(2).max(60),
  params: z.record(z.string(), z.string().max(300)).optional(),
  body: z.unknown().optional(),
  /** What the card line says ("Claim DC on Globex · Renewal FY27"). */
  label: z.string().max(160).optional(),
});
export type RouteCallChange = z.infer<typeof RouteCallChange>;

/** The edit ops `propose kind changes` takes (every op but route_call). */
export const ChatEditChange = z.discriminatedUnion('op', [...CHAT_EDIT_OPS]);
export type ChatEditChange = z.infer<typeof ChatEditChange>;

export const ChatChange = z.discriminatedUnion('op', [...CHAT_EDIT_OPS, RouteCallChange]);
export type ChatChange = z.infer<typeof ChatChange>;
export type ChatChangeOp = ChatChange['op'];

// ---------------------------------------------------------------------------
// Assistant v2 (holistic review 2026-11-20, lane 05 §5; H-6): Auto routing, the plan card, memory. All additive.
// ---------------------------------------------------------------------------

/** What a message may ask for: a model, or `auto` (the router picks the tier per turn). */
export const ChatModelChoice = ChatModel.or(z.literal('auto'));
export type ChatModelChoice = z.infer<typeof ChatModelChoice>;

/** The router's reading of a user turn (src/llm/chat/router.ts), deterministic, before any model call. */
export const ChatIntent = z.enum(['lookup', 'act', 'explain', 'draft', 'research', 'chat']);
export type ChatIntent = z.infer<typeof ChatIntent>;

export const ChatTier = z.enum(['fast', 'balanced', 'strong']);
export type ChatTier = z.infer<typeof ChatTier>;

/** Which tier answered and why (the message header: "Haiku · a lookup"). */
export const ChatRoute = z.object({
  intent: ChatIntent,
  tier: ChatTier,
  model: ChatModel,
  /** One short line: "a lookup", "you chose Sonnet", "Settings: always Opus". */
  why: z.string(),
  /** The user's choice (message or Settings) decided, not the router. */
  override: z.boolean().default(false),
});
export type ChatRoute = z.infer<typeof ChatRoute>;

/** One step of the model's own plan (`plan` tool). */
export const ChatPlanStep = z.object({
  /** The tool the step uses (`query`, `search`, `run` …). */
  tool: z.string(),
  /** What it does, in the user's words. */
  what: z.string(),
  /** A `run` step's sub-run kind (research, read_in, vdp_find_assets, org62_lookup). */
  run: z.string().optional(),
  /** The governor's estimate for the step (p90, USD). */
  estUsd: z.number().min(0).optional(),
});
export type ChatPlanStep = z.infer<typeof ChatPlanStep>;

/**
 * The plan card. Shown before a research-class run (a plan with a `run` step waits for Run / Edit / Skip) and, for
 * any other plan, as a line of what the turn will do. The estimate is the spend governor's, from `llm_calls` history.
 */
export const ChatPlan = z.object({
  id: Id,
  steps: z.array(ChatPlanStep).min(1),
  why: z.string().optional(),
  estimate: z.object({ p50: z.number().min(0), p90: z.number().min(0), basis: z.enum(['history', 'default']) }),
  /** waiting: the turn waits for the answer; run / skipped / edited: answered; info: nothing to answer. */
  status: z.enum(['waiting', 'run', 'skipped', 'edited', 'info']),
  /** The user's edit ("Edit": what to change), passed to the model. */
  note: z.string().optional(),
});
export type ChatPlan = z.infer<typeof ChatPlan>;

/** POST /chat/plan-answer: the plan card's answer. `edit` carries the note; the turn re-plans from it. */
export const ChatPlanAnswerRequest = z.object({
  planId: Id,
  answer: z.enum(['run', 'skip', 'edit']),
  note: z.string().max(4000).optional(),
});
export type ChatPlanAnswerRequest = z.infer<typeof ChatPlanAnswerRequest>;
export const ChatPlanAnswerResult = z.object({ delivered: z.boolean() });
export type ChatPlanAnswerResult = z.infer<typeof ChatPlanAnswerResult>;

/**
 * The Assistant's memory (`remember`, `chat_memory`): a thread's notes and compaction summaries, and the user's
 * preferences (threadId null). Pinned entries ride on every turn of their scope and are never compacted away.
 */
export const ChatMemoryKind = z.enum(['note', 'preference', 'summary']);
export type ChatMemoryKind = z.infer<typeof ChatMemoryKind>;
/**
 * SEC-8: the message an entry came from, resolved on read (`scope=pinned`): your message in that thread that the turn
 * which kept it answered (the latest one at or before the entry; for a preference, the latest that asked to keep it).
 */
export const ChatMemorySource = z.object({
  threadId: Id,
  threadTitle: z.string(),
  messageId: Id,
  at: IsoDateTime,
  /** The first words of your message, one line. */
  excerpt: z.string(),
});
export type ChatMemorySource = z.infer<typeof ChatMemorySource>;
export const ChatMemoryEntry = z.object({
  id: Id,
  threadId: Id.nullable(),
  kind: ChatMemoryKind,
  text: z.string(),
  pinned: z.boolean(),
  /** A summary's last covered message (its position in the thread, 0-based); null otherwise. */
  coversThroughSeq: z.number().int().nullable().default(null),
  createdAt: IsoDateTime,
  /** SEC-8, additive: filled with `scope=pinned` (null: the message is gone or was never found); absent otherwise. */
  source: ChatMemorySource.nullable().optional(),
});
export type ChatMemoryEntry = z.infer<typeof ChatMemoryEntry>;
/**
 * threadId: that thread's entries plus your preferences; neither: preferences only. `scope=pinned` (SEC-8, Settings ▸
 * Assistant): everything that rides into other turns on its own, every pinned entry in any thread and every
 * preference, oldest first, each with the message it came from.
 */
export const ChatMemoryQuery = z.object({ threadId: Id.optional(), scope: z.enum(['pinned']).optional() });
export type ChatMemoryQuery = z.infer<typeof ChatMemoryQuery>;
export const ChatMemoryPayload = z.object({ entries: z.array(ChatMemoryEntry) });
export type ChatMemoryPayload = z.infer<typeof ChatMemoryPayload>;
export const DeleteChatMemoryResult = z.object({ deleted: z.boolean() });
export type DeleteChatMemoryResult = z.infer<typeof DeleteChatMemoryResult>;

/** A manual scan started from chat (`run rescan`), read from the job and scan-run tables (the tool row shows it). */
export const ChatScan = z.object({
  /** Stable id of the card: the queued job's id (the scan run appears once the worker starts it). */
  id: Id,
  /** The scan run (Health ledger row), once it exists. */
  scanRunId: Id.nullable().default(null),
  connectorId: Id,
  /** Connector label: "Slack". */
  connector: z.string(),
  source: SourceKind.nullable().default(null),
  windowHours: z.number().min(1).max(24 * 30),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  status: ScanRunStatus,
  /** True once the run reached a terminal status (anything but queued / running). */
  done: z.boolean(),
  jobId: Id.nullable().default(null),
  itemsSeen: z.number().int().default(0),
  itemsNew: z.number().int().default(0),
  itemsChanged: z.number().int().default(0),
  summary: z.string(),
  updatedAt: IsoDateTime,
  href: z.string(),
});
export type ChatScan = z.infer<typeof ChatScan>;

/** An Outbox draft created from chat (`chat_draft`). Never sent: it waits in Outbox for approval. */
export const ChatDraftRef = z.object({
  draftId: Id,
  channel: z.enum(['slack', 'email', 'action']),
  /** "#acme-ext", "@Dana Reyes" or "dana@acme.example". */
  to: z.string(),
  subject: z.string().nullable().default(null),
  threadRef: z.string().nullable().default(null),
  workItemId: Id.nullable().default(null),
  status: DraftStatus,
  /** First lines of the body. */
  preview: z.string(),
  href: z.string(),
});
export type ChatDraftRef = z.infer<typeof ChatDraftRef>;

/**
 * A Claude Code session prepared from chat (`chat_start_session`). `url` is a `claude://code/new?…` deep
 * link whose prompt ends in `[cc:<id>]`. The server never opens it; the UI opens it only on an explicit click.
 */
export const ChatSession = z.object({
  /** The tracked session record (an agent run, kind claude_session). */
  id: Id,
  repo: z.string(),
  folder: z.string(),
  title: z.string(),
  prompt: z.string(),
  url: z.string(),
  workItemId: Id.nullable().default(null),
  /** prepared = link ready, not opened yet; the Claude-session watcher takes over once it starts. */
  state: z.enum(['prepared', 'opened']).default('prepared'),
  createdAt: IsoDateTime,
});
export type ChatSession = z.infer<typeof ChatSession>;

/** Tokens and cost of one assistant turn (also recorded in the LLM ledger, purpose `chat`). */
export const ChatUsage = z.object({
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  turns: z.number().int(),
  /** Of `costUsd`: what sub-runs (research, Org62 lookups) cost on their own line (ASSIST-1). Additive. */
  subRunUsd: z.number().optional(),
  /**
   * A turn that continued a message stopped at its cost limit ("Allow more", ASSIST-2): what that stopped message
   * cost, so the receipt shows both (`costUsd` is this turn only). Additive.
   */
  continuedFromUsd: z.number().optional(),
  /** Assistant v2: the tier that answered and the tool calls the turn made (the receipt: "Haiku · 3 steps · $0.004"). */
  tier: ChatTier.optional(),
  steps: z.number().int().optional(),
  /** Assistant v2: the turn resumed the thread's SDK session (else it was rebuilt from the stored, compacted history). */
  resumed: z.boolean().optional(),
  /** W12-8: this turn summarised this many older turns of the thread (compaction; its cost is in `subRunUsd`). Additive. */
  summarizedTurns: z.number().int().min(1).optional(),
});
export type ChatUsage = z.infer<typeof ChatUsage>;

/**
 * A rich card riding on a `resource` part / event (BE-CHAT). Clients that don't know `card` still show the
 * resource as a link (draft → the draft, agent_run → the session record); clients that do render the card.
 * Scans are not cards: they are the `<source>.scan` tool row, with `tool-progress` until they finish.
 */
export const ChatCard = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft'), draft: ChatDraftRef }),
  z.object({ kind: z.literal('session'), session: ChatSession }),
]);
export type ChatCard = z.infer<typeof ChatCard>;

/** BE-CHAT: how far a long tool (a chat-started scan) has come; `done` of `total` steps. */
export const ChatToolProgress = z.object({ done: z.number().int().min(0), total: z.number().int().min(1) });
export type ChatToolProgress = z.infer<typeof ChatToolProgress>;

export const ChatPart = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool'),
    id: Id,
    name: z.string(),
    /** Latest human summary (the result once it finished). */
    summary: z.string(),
    /** null = still running (or never reported). */
    ok: z.boolean().nullable(),
    /** What the tool set out to do / its arguments, credential-redacted (the tool-start summary when no structured args). */
    args: z.string().nullable().optional(),
    /** The result summary, credential-redacted. */
    result: z.string().nullable().optional(),
    /** BE-CHAT: the latest `tool-progress` (a chat-started scan: queued 0/3, running 1–2/3, finished 3/3). */
    progress: ChatToolProgress.optional(),
    /** Assistant v2: what the call cost on its own (a live read through a relay, a sub-run), booked with the thread id. */
    costUsd: z.number().min(0).optional(),
    /**
     * A guard held the call for you (SEC-8 `remember`, SEC-9 `run reauth`: the user's message didn't ask for it): `ok`
     * is false but it is not a failure; the row is neutral. Absent on rows written before the flag (the summary's
     * "(say …)" ending is the fallback).
     */
    held: z.boolean().optional(),
  }),
  z.object({ type: z.literal('receipt'), receipt: Receipt }),
  /** Assistant v2: the model's plan card (see ChatPlan), with its final status. */
  z.object({ type: z.literal('plan'), plan: ChatPlan }),
  z.object({
    type: z.literal('proposal'),
    proposal: Proposal,
    /** The SSE `proposal.summary` line ("Shave 5 minutes off the estimate?"). */
    summary: z.string().optional(),
    /** Current card state; servers resolve it from the proposal on read. */
    status: ChatProposalStatus.optional(),
    /** BE-CHAT: the structured changes behind a chat proposal (`proposal.changes` holds the display lines). */
    changes: z.array(ChatChange).optional(),
  }),
  /** BE-CHAT `card`: a chat draft or a prepared Claude session (see ChatCard). */
  z.object({ type: z.literal('resource'), resource: ChatResource, card: ChatCard.optional() }),
  /** The turn ended in an error (the SSE `error` event, persisted). */
  z.object({ type: z.literal('error'), error: ApiErrorBody }),
]);
export type ChatPart = z.infer<typeof ChatPart>;

export const ChatMessage = z.object({
  id: Id,
  threadId: Id,
  role: z.enum(['user', 'assistant', 'system']),
  at: IsoDateTime,
  /** Markdown, rendered through renderMarkdown. */
  text: z.string(),
  parts: z.array(ChatPart).default([]),
  context: z.array(ContextRef).default([]),
  /** The morning-brief message (first message of the "Today" thread). */
  isMorningBrief: z.boolean().default(false),
  /** Assistant messages: the model that answered. */
  model: ChatModel.optional(),
  /** Assistant v2: the router's choice for this turn (tier and why), shown on the message header. */
  route: ChatRoute.optional(),
  /** Assistant messages: how the turn ended (complete = `done`). Absent on older messages. */
  status: z.enum(['complete', 'error', 'stopped']).optional(),
  /** BE-CHAT: assistant messages answered by a model: tokens and cost of the turn. */
  usage: ChatUsage.optional(),
  /** BE-CHAT: the morning brief's one-line summary (lead sentence + "n priorities."), filled on read. */
  summary: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatThread = z.object({
  id: Id,
  title: z.string(),
  isDefault: z.boolean(), // the "Today" thread
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  messageCount: z.number().int(),
  lastMessagePreview: z.string().nullable(),
  /** Context the thread was opened with (POST /chat/threads); attached to every turn as `auto` chips. */
  context: z.array(ContextRef).optional(),
});
export type ChatThread = z.infer<typeof ChatThread>;

export const ChatThreadDetail = z.object({
  thread: ChatThread,
  messages: z.array(ChatMessage),
});
export type ChatThreadDetail = z.infer<typeof ChatThreadDetail>;

export const ChatThreadsPayload = z.object({ threads: z.array(ChatThread) });
export type ChatThreadsPayload = z.infer<typeof ChatThreadsPayload>;

/**
 * Streamed over SSE as `event: <type>` + `data: <json>`. Order: one `start` (the header), then
 * text-delta / tool-* / receipt / proposal / resource interleave, then exactly one `done` or `error`.
 */
export const ChatSseEvent = z.discriminatedUnion('type', [
  /** Header (CONTRACT-1): ids for the turn and the model answering it (ChatRequest.model ?? settings.chat.defaultModel). */
  z.object({ type: z.literal('start'), threadId: Id, messageId: Id, userMessageId: Id, model: ChatModel, route: ChatRoute.optional() }),
  /** Assistant v2: the plan card (new, or its answered status). A `waiting` plan is answered with POST /chat/plan-answer. */
  z.object({ type: z.literal('plan'), messageId: Id, plan: ChatPlan }),
  z.object({ type: z.literal('text-delta'), messageId: Id, delta: z.string() }),
  z.object({ type: z.literal('tool-start'), id: Id, name: z.string(), summary: z.string(), args: z.string().optional() }),
  /** `held`: a guard held the call for you, not a failure (see ChatPart `tool`.held). */
  z.object({ type: z.literal('tool-result'), id: Id, summary: z.string(), ok: z.boolean(), result: z.string().optional(), costUsd: z.number().min(0).optional(), held: z.boolean().optional() }),
  /** BE-CHAT: a running tool's progress (chat-started scans). Same `id` as its tool-start; the tool-result still ends it. */
  z.object({ type: z.literal('tool-progress'), id: Id, done: z.number().int().min(0), total: z.number().int().min(1) }),
  z.object({ type: z.literal('receipt'), receipt: Receipt }),
  /** A staged change (policy, > 5 edits) — apply with POST /proposals/:id/apply. */
  z.object({ type: z.literal('proposal'), id: Id, proposal: Proposal, summary: z.string() }),
  /** BE-CHAT `card`: see ChatCard. */
  z.object({ type: z.literal('resource'), resource: ChatResource, card: ChatCard.optional() }),
  /**
   * ASSIST-9 (2026-11-20): the turn's spend so far in USD (model calls + sub-runs, estimated from the rate card until
   * the final `usage`), sent as it climbs. Older clients drop it (unknown events are ignored).
   */
  z.object({ type: z.literal('usage-delta'), messageId: Id, spentUsd: z.number().min(0), model: z.string(), subRunUsd: z.number().min(0).optional(), hold: ChatHoldView.optional() }),
  /**
   * Spend governor (H-5): the answer passed its hold and waits at its next step for the user. The card answers through
   * POST /chat/spend-answer (approve $moreUsd · deny); the turn then continues or wraps up from what it has. A turn no
   * longer listening (the stream closed) ends as a budget stop that "Allow more" continues.
   */
  z.object({ type: z.literal('spend-ask'), messageId: Id, holdId: Id, question: z.string(), spentUsd: z.number().min(0), heldUsd: z.number().min(0), moreUsd: z.number().min(0) }),
  z.object({ type: z.literal('done'), threadId: Id, messageId: Id, userMessageId: Id }),
  z.object({ type: z.literal('error'), error: ApiErrorBody }),
]);
export type ChatSseEvent = z.infer<typeof ChatSseEvent>;
export type ChatSseEventType = ChatSseEvent['type'];
