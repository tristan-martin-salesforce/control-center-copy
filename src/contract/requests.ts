/**
 * Request schemas: path params, query strings and mutation bodies.
 * Every mutation of a versioned entity sends `ifVersion`; a mismatch returns 409 `conflict`
 * with `details.current` set to the server's entity.
 */
import { z } from 'zod';
import { ChatModel, DispatchMode, Effort, Id, IsoDate, IsoDateTime, SourceKind, Version, WorkKind } from './common';
import { WatchCadence, WatchTargetKind } from './briefs';
import { Destination, TipTapDoc } from './nba';
import { PolicyRule, PolicyWeights, SettingsSectionKey } from './settings';
import { WorkTab } from './views';
import { NotNowReason, Resolution, ResolutionDetail } from './work';
import { TimeLedgerQuarter } from './time';

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const IdParams = z.object({ id: Id });
export type IdParams = z.infer<typeof IdParams>;

/** Path verbs are kebab-case: /items/:id/actions/confirm-done */
/** `not-done` (LD-1): a likely-done item was not finished after all; it goes back to where it was. */
export const ItemActionVerb = z.enum(['done', 'resolve', 'snooze', 'accept', 'dismiss', 'confirm-done', 'not-done', 'reopen', 'not-now']);
export type ItemActionVerb = z.infer<typeof ItemActionVerb>;
export const ItemActionParams = z.object({ id: Id, verb: ItemActionVerb });

export const AccountParams = z.object({ accountId: Id });
/** Any settings section (SettingsSectionKey is the one list: new sections need no edit here). */
export const SectionParams = z.object({ section: SettingsSectionKey });

export const EmptyBody = z.object({}).strict().default({});

// ---------------------------------------------------------------------------
// Queries (strings on the wire; coerced here)
// ---------------------------------------------------------------------------

export const ItemsQuery = z.object({
  tab: WorkTab.default('all_open'),
  account: Id.optional(),
  opp: Id.optional(),
  initiative: Id.optional(),
  source: SourceKind.optional(),
  kind: WorkKind.optional(),
  q: z.string().optional(),
  /**
   * Paging (post-2.0 Work list scope, additive, as GET /deals): `limit` rows of the tab from `cursor` (the previous
   * page's `nextCursor`). No `limit` = the whole tab, as before. The counts always count every row. The cursor is
   * opaque: on the Closed tab a keyset of the last row shown (closed at, created at, id; P25-6), so a close or a reopen
   * between pages neither repeats nor skips a row; on the other tabs an offset.
   */
  cursor: z.string().max(128).optional(),
  /** A page size, not a cap: paging goes on past it (`nextCursor`); 500 bounds one response (the UI asks for 50). */
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type ItemsQuery = z.infer<typeof ItemsQuery>;

export const CalendarQuery = z.object({ from: IsoDateTime.optional(), to: IsoDateTime.optional() });
export const TimeQuery = z.object({ week: IsoDate.optional() }); // any day in the week; default = this week
/**
 * GET /time/log: every activity row in [from, to] (inclusive local days; open-ended when absent). `status` is a
 * comma list of ActivityLogStatus buckets; `q` matches description, task type, opp and account; `account` is an
 * account name (rows carry names, not ids), `none` the rows with no account; `opp` an opportunity id, `none` the rows
 * with no opportunity (not internal), `internal` the internal-only rows (D-64); `type` a task type, `none` the rows
 * with no type. The Ledger's drill-down is these filters.
 */
export const ActivityLogQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  status: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  account: z.string().max(200).optional(),
  opp: Id.optional(),
  type: z.string().max(200).optional(),
});
export type ActivityLogQuery = z.infer<typeof ActivityLogQuery>;
/** GET /time/ledger: one fiscal quarter ("Q3 FY27") or `all`; absent = the current quarter. */
export const TimeLedgerQuery = z.object({ quarter: TimeLedgerQuarter.optional() });
export type TimeLedgerQuery = z.infer<typeof TimeLedgerQuery>;
export const SearchQuery = z.object({ q: z.string().default(''), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const SinceQuery = z.object({ ts: IsoDateTime.optional() }); // default = the user's last-active time
/**
 * GET /scans (the scan ledger): newest first, `limit` runs from `cursor` (the previous page's `nextCursor`, caps audit
 * F-2, additive). A page size, not a cap: paging reaches the oldest run. The cursor is opaque: a keyset of the last run
 * shown (started at, id), so a scan that starts between pages neither repeats nor skips a row.
 */
export const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().max(128).optional() });
/** GET /people (CONTRACT-1): name/email/Slack id/role/account match; empty q lists everyone (A→Z). */
export const PeopleQuery = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  account: Id.optional(),
  /** Only people with a Slack id (for Slack @-mentions). */
  slack: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
});

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

export const CaptureRequest = z.object({
  /** One line, Todoist-style tokens allowed (#account @person ~30m). Enter saves instantly. */
  text: z.string().min(1).max(500),
  accountId: Id.optional(),
  initiativeId: Id.optional(),
  due: IsoDateTime.optional(),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

/** Autosaved fields. Each field written here is added to `userLockedFields`. */
export const WorkItemPatch = z
  .object({
    title: z.string().min(1),
    purpose: z.string().nullable(),
    due: IsoDateTime.nullable(),
    startBy: IsoDateTime.nullable(),
    effort: Effort,
    notes: z.string(),
    initiativeId: Id.nullable(),
    accountId: Id.nullable(),
    oppId: Id.nullable(),
    kind: WorkKind,
  })
  .partial();
export type WorkItemPatch = z.infer<typeof WorkItemPatch>;

export const PatchItemRequest = z.object({ ifVersion: Version, patch: WorkItemPatch });
export type PatchItemRequest = z.infer<typeof PatchItemRequest>;

export const ItemActionRequest = z.object({
  ifVersion: Version,
  /** snooze: wake time (required). */
  until: IsoDateTime.optional(),
  /** not-now / dismiss: reason chip (done elsewhere · not mine · later · wrong account). */
  reason: NotNowReason.optional(),
  note: z.string().optional(),
  /**
   * done: optional (default done_by_me). resolve (⇧D picker): required.
   * handed_off needs detail.personId or detail.personName.
   */
  resolution: Resolution.optional(),
  detail: ResolutionDetail.omit({ inferred: true }).partial().optional(),
  /** handed_off: my involvement afterwards (default watcher). */
  involvement: z.enum(['watcher', 'not_involved', 'contributor']).optional(),
});
export type ItemActionRequest = z.infer<typeof ItemActionRequest>;

// ---------------------------------------------------------------------------
// NBA, proposals, drafts
// ---------------------------------------------------------------------------

export const RegenerateNbaRequest = z.object({
  ifVersion: Version.optional(),
  /** AI rewrite chips: Shorter · More formal · Add detail · Regenerate. */
  instruction: z.enum(['regenerate', 'shorter', 'more_formal', 'add_detail']).default('regenerate'),
});
export type RegenerateNbaRequest = z.infer<typeof RegenerateNbaRequest>;

export const PatchDraftRequest = z.object({
  ifVersion: Version,
  doc: TipTapDoc.optional(),
  destination: Destination.optional(),
  mode: DispatchMode.optional(),
  scheduledFor: IsoDateTime.nullable().optional(),
});
export type PatchDraftRequest = z.infer<typeof PatchDraftRequest>;

/** POST /drafts/:id/queue (BE-CHAT): Add to Outbox, drafting → ready (pending approval). Idempotent on ready; other statuses 409. */
export const QueueDraftRequest = z.object({ ifVersion: Version });
export type QueueDraftRequest = z.infer<typeof QueueDraftRequest>;

/**
 * POST /drafts/:id/reject (CONTRACT-2, REJECT-1): the user turns a pending draft down. drafting/ready/scheduled →
 * rejected: it leaves the Outbox, nothing is sent, the work item stays open. Idempotent on rejected; sent or
 * in-flight drafts 409. Undoable.
 */
export const RejectDraftRequest = z.object({ ifVersion: Version.optional(), reason: z.string().trim().max(300).optional() }).default({});
export type RejectDraftRequest = z.infer<typeof RejectDraftRequest>;

export const PreviewDraftRequest = z.object({ mode: DispatchMode.optional() }).default({});
export type PreviewDraftRequest = z.infer<typeof PreviewDraftRequest>;

export const DispatchDraftRequest = z.object({
  ifVersion: Version,
  mode: DispatchMode,
  /** From POST /drafts/:id/preview; binds the confirm to this exact version + mode. */
  confirmToken: z.string().min(1),
});
export type DispatchDraftRequest = z.infer<typeof DispatchDraftRequest>;

// ---------------------------------------------------------------------------
// Agents and tools
// ---------------------------------------------------------------------------

export const LaunchAgentRequest = z.object({
  workItemId: Id.optional(),
  title: z.string().optional(),
  /** Context-packed prompt; the server appends the [cc:<work_item_id>] tag and caps at 14336 chars. */
  prompt: z.string().max(14336).optional(),
  folder: z.string().optional(),
});
export type LaunchAgentRequest = z.infer<typeof LaunchAgentRequest>;

export const AnswerAgentRequest = z.object({ answer: z.string().min(1) });
export type AnswerAgentRequest = z.infer<typeof AnswerAgentRequest>;

export const ToolRunRequest = z.object({
  inputs: z.record(z.string(), z.unknown()),
  workItemId: Id.optional(),
  nbaId: Id.optional(),
});
export type ToolRunRequest = z.infer<typeof ToolRunRequest>;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export const ActivityPatch = z
  .object({
    date: IsoDate,
    start: IsoDateTime,
    end: IsoDateTime,
    durationH: z.number().multipleOf(0.25).min(0),
    taskType: z.string().nullable(),
    oppId: Id.nullable(),
    /**
     * D-103 (c): what the row logs to. `opp` is `oppId`; `account` logs to the account itself (an account with no open
     * opportunity: a Solutions Event on the Account); `internal` is `internal: true`. `oppId` keeps working.
     */
    target: z.object({ kind: z.enum(['opp', 'account', 'internal']), id: z.string() }),
    meetingType: z.enum(['CF', 'CR']).nullable(),
    description: z.string(),
    status: z.enum(['proposed', 'approved', 'dismissed']),
    /**
     * D-64: true makes the row internal-only work (no opportunity, an internal task type: the patch's when it is one,
     * else what the row says, Asset Creation by default); false takes it back to customer work (a customer type, then
     * an opportunity). Setting an opportunity on an internal row takes it back too.
     */
    internal: z.boolean(),
    /** D-66: the Org62 Description's note (your edit is locked: the app never rewrites it). */
    logNote: z.string().max(1000),
  })
  .partial();
export const PatchActivityRequest = z.object({ ifVersion: Version, patch: ActivityPatch });
export type PatchActivityRequest = z.infer<typeof PatchActivityRequest>;

export const SyncCanvasRequest = z.object({
  /** The first sync each day needs confirm: true (UI-SPEC §8). */
  confirm: z.boolean().default(false),
});
export type SyncCanvasRequest = z.infer<typeof SyncCanvasRequest>;

// ---------------------------------------------------------------------------
// Deals, briefs, watches, triage
// ---------------------------------------------------------------------------

export const DismissRequest = z.object({ reason: z.string().min(1), note: z.string().optional() });
export type DismissRequest = z.infer<typeof DismissRequest>;

export const HighlightActionRequest = z.object({ ifVersion: Version.optional(), reason: z.string().optional() }).default({});
export type HighlightActionRequest = z.infer<typeof HighlightActionRequest>;

export const CreateWatchRequest = z.object({
  targetKind: WatchTargetKind,
  target: z.string().min(1),
  label: z.string().min(1),
  cadence: WatchCadence,
  style: z.enum(['brief', 'detailed']),
});
export type CreateWatchRequest = z.infer<typeof CreateWatchRequest>;

export const PatchWatchRequest = z.object({
  ifVersion: Version,
  patch: CreateWatchRequest.partial().extend({ enabled: z.boolean().optional() }),
});
export type PatchWatchRequest = z.infer<typeof PatchWatchRequest>;

export const TriageAcceptRequest = z.object({
  /** Mapping questions: the chosen answer. */
  choiceId: Id.optional(),
  /** `e` edit then accept. */
  edits: WorkItemPatch.optional(),
}).default({});
export type TriageAcceptRequest = z.infer<typeof TriageAcceptRequest>;

export const TriageMergeRequest = z.object({ intoId: Id });
export type TriageMergeRequest = z.infer<typeof TriageMergeRequest>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const ScanRequest = z.object({ scope: z.string().optional() }).default({});
export type ScanRequest = z.infer<typeof ScanRequest>;

// ---------------------------------------------------------------------------
// Settings and policy
// ---------------------------------------------------------------------------

/** `value` is validated per section against SETTINGS_SECTION_SCHEMAS[section]. */
export const PatchSettingsRequest = z.object({
  ifVersion: Version,
  value: z.record(z.string(), z.unknown()),
  /** Required (true) when turning dry-run off. */
  confirm: z.boolean().optional(),
});
export type PatchSettingsRequest = z.infer<typeof PatchSettingsRequest>;

export const PolicyPreviewRequest = z.object({
  weights: PolicyWeights.optional(),
  rules: z.array(PolicyRule).optional(),
});
export type PolicyPreviewRequest = z.infer<typeof PolicyPreviewRequest>;

export const PolicyApplyRequest = z.object({
  ifVersion: Version,
  weights: PolicyWeights,
  rules: z.array(PolicyRule),
  note: z.string().optional(),
});
export type PolicyApplyRequest = z.infer<typeof PolicyApplyRequest>;

export const PolicyRevertRequest = z.object({ ifVersion: Version, toVersion: Version });
export type PolicyRevertRequest = z.infer<typeof PolicyRevertRequest>;

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const ChatContextInput = z.object({ type: z.string(), id: Id, label: z.string(), via: z.enum(['auto', 'explicit']).optional() });

export const ChatRequest = z.object({
  threadId: Id.optional(), // default: the "Today" thread
  text: z.string().min(1).max(8000),
  context: z.array(ChatContextInput).default([]),
  /**
   * Model for this turn (CONTRACT-1). Default: settings.chat.routing (Assistant v2: `auto` routes each turn to a tier,
   * src/llm/chat/router.ts). The model that answered is echoed in the `start` event.
   */
  model: ChatModel.or(z.literal('auto')).optional(),
  /**
   * A one-time approval to spend this much more on this message (the "Allow more" on a capped message): it raises the
   * per-message cap and may go past the assistant's daily line by the same amount, for this message only.
   */
  allowExtraUsd: z.number().min(0).max(5).optional(),
  /**
   * ASSIST-2 (2026-11-20): "Allow more" continues this assistant message (one stopped at its cost limit) instead of
   * re-running the question: the stopped answer and its tool rows are the context, and the cap is `allowExtraUsd`.
   */
  continueMessageId: Id.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** POST /chat/threads (CONTRACT-1): a new, empty thread. Untitled threads take their title from the first message. */
export const CreateChatThreadRequest = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    /** Context the thread is about (e.g. opened from a work item); attached to every turn as `auto` chips. */
    context: z.array(ChatContextInput).default([]),
  })
  .default({});
export type CreateChatThreadRequest = z.infer<typeof CreateChatThreadRequest>;
