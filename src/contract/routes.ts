/**
 * The typed route table: the single source of truth for the HTTP API under /api/v1.
 *
 * - The key is the DataSource method name (src/server/datasource/types.ts) and the client call name
 *   (src/client/api.ts: `api('patchItem', {params, body})`).
 * - `topic` is the TanStack Query key prefix for reads, and what LiveEvents invalidate.
 * - `stream` routes answer with SSE; `response` is then the schema of each event.
 * - app/api/v1/**\/route.ts files are generated from this table: `npm run gen:routes`.
 */
import { z } from 'zod';
import { AgentRun, AgentsPayload, LaunchResult, ToolRun, ToolsPayload } from './agents';
import { BriefHighlight, BriefsPayload, Brief, WatchSubscription, WatchesPayload } from './briefs';
import { CalendarEventDetail, CalendarPayload } from './calendar';
import { CanvasReview, EditCanvasRowRequest, RemoveCanvasRowsRequest } from './canvas-review';
import { ChatMemoryPayload, ChatMemoryQuery, ChatPlanAnswerRequest, ChatPlanAnswerResult, ChatSseEvent, ChatThread, ChatThreadDetail, ChatThreadsPayload, DeleteChatMemoryResult } from './chat';
import { IsoDateTime } from './common';
import { AddOrg62OppsRequest, AddOrg62OppsResult, ClaimMissedRequest, CreateDcRequestRequest, DcRequest, DcRequestsPayload, DealsPayload, DealsQuery, MissedOpp, MissedPayload, PatchDcRequestRequest, UseCaseSyncPayload, WithdrawDcRequestsRequest, WithdrawDcRequestsResult } from './deals';
import { CheckMissingForecastResult, DraftForecastNotesRequest, DraftForecastNotesResult, ForecastPayload, ForecastRecordDetail, ForecastRecordParams, ForecastRow, PatchForecastRequest, StageForecastRequest, StageForecastResult, SyncForecastResult } from './forecast'; // lane A
import { DevEngineChangeRequest, DevEngineChangeResult, DevFailRequest, DevFailStatus, DevScenarioRequest, ScenarioStatus } from './dev';
import { AuditEntry, LiveEvent, LiveTopic, MutationResultOf } from './envelope';
import { HistoryDay, HistoryDayParams, HistoryMonth, HistoryMonthQuery } from './history';
import { HomePayload, HomeQuery } from './home';
import { DecidePriorityRuleRequest, PriorityPreview, PriorityRule, PriorityRuleParams, RerankAllResult } from './priority';
import { ClearNeedRequest, DecideNeedRequest, DecideNeedRowRequest, DecideNeedRowResult, NeedDecisionsPayload, NeedRowParams, NeedsPayload } from './needs';
import { CanvasWrites, EventUpdateRow, EventUpdatesPayload, FixUseCaseRequest, PatchEventUpdateRequest, PickUseCaseValueRequest, ProposeEventUpdatesRequest, ProposeEventUpdatesResult, RecordLandings, RecordLandingsQuery, UseCaseKeyParams, UseCaseLanding, UseCaseLandingsPayload } from './landings';
import { ClaudeSmokeResult, DoctorPayload, DoctorQuery, EventLogEntry, EventLogPayload, HealthPayload, Job, JobsPayload, ReauthResult, ResolutionCheckPayload, ScanRun, ScansPayload } from './health';
import { DispatchResult, Draft, DraftPreview, DraftSource, OutboxPayload, StageReleaseRequest, StageReleaseResult } from './nba';
import { ClearVdpIdentityRequest, DraftVdpUpdateRequest, DraftVdpUpdateResult, FindVdpAssetsRequest, FindVdpAssetsResult, PushVdpChangesRequest, PushVdpChangesResult, SearchVdpCompaniesQuery, SearchVdpCompaniesResult, SetVdpCandidateRequest, SetVdpIdentityRequest, VdpAssetCandidate, VdpCoveragePayload, VdpDetailPayload, VdpDetailQuery, VdpIdentityResult } from './vdp';
import {
  AccountParams,
  AnswerAgentRequest,
  CalendarQuery,
  CaptureRequest,
  ChatRequest,
  CreateChatThreadRequest,
  CreateWatchRequest,
  DismissRequest,
  DispatchDraftRequest,
  EmptyBody,
  HighlightActionRequest,
  IdParams,
  ItemActionParams,
  ItemActionRequest,
  ItemsQuery,
  LaunchAgentRequest,
  ListQuery,
  PatchActivityRequest,
  PeopleQuery,
  PatchDraftRequest,
  QueueDraftRequest,
  RejectDraftRequest,
  PatchItemRequest,
  PatchSettingsRequest,
  PatchWatchRequest,
  PolicyApplyRequest,
  PolicyPreviewRequest,
  PolicyRevertRequest,
  PreviewDraftRequest,
  RegenerateNbaRequest,
  ScanRequest,
  SearchQuery,
  SectionParams,
  SinceQuery,
  SyncCanvasRequest,
  TimeQuery,
  ActivityLogQuery,
  TimeLedgerQuery,
  ToolRunRequest,
  TriageAcceptRequest,
  TriageMergeRequest,
} from './requests';
import { BudgetSettings, PolicyPreview, PolicyVersionsPayload, PriorityPolicy, RaiseBudgetTodayRequest, RankRow, RetentionRunPayload, RetentionSettings, RunRetentionRequest, Settings } from './settings';
import { ReadIn, ReadInParams, ReadInPayload, RequestReadInRequest } from './readin';
import { CompleteOnboardingRequest, OnboardingCompleteResult, OnboardingSourcesPayload, OnboardingSourcesQuery, OnboardingState, SaveOnboardingStepRequest } from './onboarding';
import { DiagnoseFeedbackRequest, DiagnoseFeedbackResult, FeedbackState, StageFeedbackRequest, StageFeedbackResult } from './feedback'; // lane D
import { CoveredAeLookupRequest, CoveredAeLookupResult, DcSuggestionsPayload, DecideDcSuggestionRequest, DecideDcSuggestionResult, MappingRulesPayload, MappingRuleView, OppRundown, OppRundownQuery, PatchMappingRuleRequest, RefreshDcSuggestionsResult } from './attribution';
import { AddUseCaseCandidateRequest, AddUseCaseCandidateResult, DecideUseCaseCandidateRequest, DecideUseCaseCandidateResult, RefreshUseCaseCandidatesResult, UseCaseCandidatesPayload } from './use-cases';
import { ActivityEntry, ActivityLog, CanvasSyncResult, CheckCanvasOrg62Request, CheckCanvasOrg62Result, DismissSourceRequest, ResolveActivityRequest, DismissSourceResult, MarkTripRequest, OnsiteCorrection, OnsiteDay, OnsiteDayParams, OppOptions, OppOptionsQuery, Org62OppSearch, Org62OppSearchRequest, PickOrg62OppRequest, RemoveDismissRuleRequest, StageLogBatchRequest, StageLogBatchResult, TimeDismissRules, TimeLedger, TimeWeek } from './time';
import {
  AccountDetail,
  EvidencePayload,
  ItemTracePayload,
  HistoryPayload,
  InitiativeDetail,
  ItemsPayload,
  NbaPayload,
  SearchResult,
  SinceDigest,
  TodayPayload,
  TriageItem,
  TriagePayload,
  WorkItemDetail,
} from './views';
import { PeoplePayload, Proposal, WorkItem } from './work';
import { CheckForUpdatesResult, VersionPayload } from './version';
import { GuidePayload, ReadmePayload } from './guide';
import { SpendAuditDetail, SpendAuditDetailQuery, SpendAuditPayload, SpendAuditQuery } from './spend-audit';
import { AnswerSpendHoldRequest, AnswerSpendHoldResult, ChatSpendAnswerRequest, ListSpendHoldsQuery, SpendHoldsPayload } from './spend';

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

export interface RouteDef {
  method: HttpMethod;
  /** Path under /api/v1 with :params, e.g. "/items/:id/actions/:verb". */
  path: string;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  stream?: boolean;
  topic: LiveTopic;
  summary: string;
  /** Dev-only (mock mode). */
  dev?: boolean;
  /**
   * What the in-app Assistant may do with the route (D-58), required on every route (tests/bechat/app-routes.test.ts):
   *   read   a read it may call any time (`read`): a GET, or a POST that only computes or reads (a policy
   *          preview, the Org62 opp search on the assistant's day line)
   *   stage  a change it may stage for the user's Apply (`propose kind calls` → one proposal card, op `route_call`)
   *   deny   never: sends, dispatches, applies the user's proposals, re-auths, launches, scans, raises its own budget,
   *          dry run and credentials, dev routes (D-58, loosened 2026-11-13: a route is denied only when a safety
   *          invariant forces it)
   */
  assistant?: AssistantUse;
  /** The mutation's audit id reverts it (POST /audit/:id/undo), so a staged call's receipt line has a working Undo. */
  undoable?: boolean;
}

export type AssistantUse = 'read' | 'stage' | 'deny';

export const RerankResult = z.object({ rankedAt: IsoDateTime, changed: z.number().int(), top: z.array(RankRow) });
export type RerankResult = z.infer<typeof RerankResult>;

const def = <T extends RouteDef>(d: T) => d;

export const routes = {
  // ---- Today ---------------------------------------------------------------
  getToday: def({ method: 'GET', path: '/today', response: TodayPayload, topic: 'today', summary: 'Whole Today payload: header, spine, NOW (top 3), more today, shelves, rail, rank meta', assistant: 'read' }),
  getHome: def({ method: 'GET', path: '/home', query: HomeQuery, response: HomePayload, topic: 'home', summary: 'Home (design v2): masthead, day ribbon, capacity, Do now (≤ 3), verb sections (3 rows, 5 with ?wide=1), 14-day strip, footer', assistant: 'read' }),
  rerankToday: def({ method: 'POST', path: '/today/rerank', body: EmptyBody, response: MutationResultOf(RerankResult), topic: 'today', summary: 'Apply the pending re-rank (`r`, "Re-rank ready · n")', assistant: 'stage', undoable: true }),

  // ---- Work items ----------------------------------------------------------
  listItems: def({ method: 'GET', path: '/items', query: ItemsQuery, response: ItemsPayload, topic: 'items', summary: 'Work list by tab + filters', assistant: 'read' }),
  captureItem: def({ method: 'POST', path: '/items', body: CaptureRequest, response: MutationResultOf(WorkItem), topic: 'items', summary: 'Quick capture; enrichment chips arrive ~3 s later via a live event', assistant: 'stage', undoable: true }),
  getItem: def({ method: 'GET', path: '/items/:id', params: IdParams, response: WorkItemDetail, topic: 'item', summary: 'Work item detail (sheet and page)', assistant: 'read' }),
  patchItem: def({ method: 'PATCH', path: '/items/:id', params: IdParams, body: PatchItemRequest, response: MutationResultOf(WorkItem), topic: 'item', summary: 'Autosave fields; edited fields become user-locked', assistant: 'stage', undoable: true }),
  itemAction: def({ method: 'POST', path: '/items/:id/actions/:verb', params: ItemActionParams, body: ItemActionRequest, response: MutationResultOf(WorkItem), topic: 'item', summary: 'done · snooze · accept · dismiss · confirm-done · reopen · not-now', assistant: 'stage', undoable: true }),
  getItemEvidence: def({ method: 'GET', path: '/items/:id/evidence', params: IdParams, response: EvidencePayload, topic: 'item', summary: 'Evidence timeline with new markers', assistant: 'read' }),
  getResolutionCheck: def({ method: 'GET', path: '/items/:id/resolution-check', params: IdParams, response: ResolutionCheckPayload, topic: 'item', summary: 'Why is this still open: the last resolution check (verdict, rule, gate) and what triggers the next', assistant: 'read' }),
  getItemTrace: def({ method: 'GET', path: '/items/:id/trace', params: IdParams, response: ItemTracePayload, topic: 'item', summary: 'Why is this here: evidence → source → scan run → triage verdict → model cost', assistant: 'read' }),
  getItemHistory: def({ method: 'GET', path: '/items/:id/history', params: IdParams, response: HistoryPayload, topic: 'item', summary: 'Audit log for the item (per-change Undo) + NBA versions', assistant: 'read' }),
  markItemSeen: def({ method: 'POST', path: '/items/:id/seen', params: IdParams, body: EmptyBody, response: MutationResultOf(WorkItem), topic: 'item', summary: 'Clear new-evidence markers', assistant: 'stage' }),
  getInitiative: def({ method: 'GET', path: '/initiatives/:id', params: IdParams, response: InitiativeDetail, topic: 'initiative', summary: 'Initiative page', assistant: 'read' }),

  // ---- NBA and proposals ---------------------------------------------------
  getItemNba: def({ method: 'GET', path: '/items/:id/nba', params: IdParams, response: NbaPayload, topic: 'nba', summary: 'Current NBA + draft + pending proposals for an item', assistant: 'read' }),
  regenerateNba: def({ method: 'POST', path: '/nba/:id/regenerate', params: IdParams, body: RegenerateNbaRequest, response: MutationResultOf(NbaPayload), topic: 'nba', summary: 'Regenerate / Shorter / More formal / Add detail (touched drafts get a proposal)', assistant: 'stage' }),
  applyProposal: def({ method: 'POST', path: '/proposals/:id/apply', params: IdParams, body: EmptyBody, response: MutationResultOf(Proposal), topic: 'item', summary: 'Apply an engine/chat proposal (field stays locked)', assistant: 'deny' }),
  rejectProposal: def({ method: 'POST', path: '/proposals/:id/reject', params: IdParams, body: EmptyBody, response: MutationResultOf(Proposal), topic: 'item', summary: 'Keep mine', assistant: 'stage', undoable: true }),

  // ---- Drafts and Outbox ---------------------------------------------------
  getDraft: def({ method: 'GET', path: '/drafts/:id', params: IdParams, response: Draft, topic: 'draft', summary: 'Composer draft', assistant: 'read' }),
  getDraftSource: def({ method: 'GET', path: '/drafts/:id/source', params: IdParams, response: DraftSource, topic: 'draft', summary: 'The message a draft replies to (author, time, channel, permalink, rich body) and up to 5 earlier thread messages; read-only', assistant: 'read' }),
  patchDraft: def({ method: 'PATCH', path: '/drafts/:id', params: IdParams, body: PatchDraftRequest, response: MutationResultOf(Draft), topic: 'draft', summary: 'Autosave (1 s debounce); sets userTouched', assistant: 'stage', undoable: true }),
  queueDraft: def({ method: 'POST', path: '/drafts/:id/queue', params: IdParams, body: QueueDraftRequest, response: MutationResultOf(Draft), topic: 'draft', summary: 'Add to Outbox: drafting → ready (pending approval); idempotent on ready, 409 otherwise', assistant: 'stage', undoable: true }),
  rejectDraft: def({ method: 'POST', path: '/drafts/:id/reject', params: IdParams, body: RejectDraftRequest, response: MutationResultOf(Draft), topic: 'draft', summary: 'Reject a pending draft: it leaves the Outbox, nothing is sent; idempotent on rejected, 409 once sending or sent; undoable', assistant: 'stage', undoable: true }),
  // 2026-11-13 audit B2: the logging canvas review before Apply (every row, by kind; remove and edit, each undoable)
  getCanvasReview: def({ method: 'GET', path: '/drafts/:id/canvas-review', params: IdParams, response: CanvasReview, topic: 'draft', summary: 'A canvas item’s rows by kind (Events, DCs, VDP use cases, updates), read from the work order it will write', assistant: 'read' }),
  removeCanvasRows: def({ method: 'POST', path: '/drafts/:id/canvas-review/remove', params: IdParams, body: RemoveCanvasRowsRequest, response: MutationResultOf(CanvasReview), topic: 'draft', summary: 'Take rows off a logging canvas before Apply: they go back to waiting (an Event stays approved for the next batch); the work order re-renders; undoable', assistant: 'stage', undoable: true }),
  editCanvasRow: def({ method: 'POST', path: '/drafts/:id/canvas-review/edit', params: IdParams, body: EditCanvasRowRequest, response: MutationResultOf(CanvasReview), topic: 'draft', summary: 'Edit one row of a logging canvas before Apply: kept on its record (activity row, DC request, use-case override), the work order re-renders; undoable', assistant: 'stage', undoable: true }),
  previewDraft: def({ method: 'POST', path: '/drafts/:id/preview', params: IdParams, body: PreviewDraftRequest, response: DraftPreview, topic: 'draft', summary: 'Preview as recipient from the serialized payload; returns confirmToken', assistant: 'deny' }),
  dispatchDraft: def({ method: 'POST', path: '/drafts/:id/dispatch', params: IdParams, body: DispatchDraftRequest, response: DispatchResult, topic: 'draft', summary: 'Draft ↔ Send. Honors dry-run. Mock never calls out', assistant: 'deny' }),
  getOutbox: def({ method: 'GET', path: '/outbox', response: OutboxPayload, topic: 'outbox', summary: 'Pending approval · Scheduled · Sent · Failed', assistant: 'read' }),
  stageRelease: def({ method: 'POST', path: '/outbox/releases', body: StageReleaseRequest, response: MutationResultOf(StageReleaseResult), topic: 'outbox', summary: 'D-90: one built release → its two Outbox items (release.drive_upload hand-off, release.announce Slack draft), pending approval; idempotent per version (a pending item is updated, an applied one kept); nothing is sent', assistant: 'deny' }),

  // ---- Calendar ------------------------------------------------------------
  getCalendar: def({ method: 'GET', path: '/calendar', query: CalendarQuery, response: CalendarPayload, topic: 'calendar', summary: 'Events + spine slots for a window (default today)', assistant: 'read' }),
  getCalendarEvent: def({ method: 'GET', path: '/calendar/events/:id', params: IdParams, response: CalendarEventDetail, topic: 'calendar', summary: 'One meeting (agenda, organizer, answers, attachments) with its prep items, account / opp names and read-in state', assistant: 'read' }),

  // ---- Agents and tools ----------------------------------------------------
  getAgents: def({ method: 'GET', path: '/agents', response: AgentsPayload, topic: 'agents', summary: 'Claude sessions + app runs + tool runs', assistant: 'read' }),
  launchAgent: def({ method: 'POST', path: '/agents/launch', body: LaunchAgentRequest, response: LaunchResult, topic: 'agents', summary: 'Returns the claude://code/new URL and the run record', assistant: 'deny' }),
  answerAgent: def({ method: 'POST', path: '/agents/:id/answer', params: IdParams, body: AnswerAgentRequest, response: MutationResultOf(AgentRun), topic: 'agents', summary: 'Inline answer (app runs only; Claude sessions answer in Claude)', assistant: 'stage' }),
  cancelAgent: def({ method: 'POST', path: '/agents/:id/cancel', params: IdParams, body: EmptyBody, response: MutationResultOf(AgentRun), topic: 'agents', summary: 'Cancel a queued/running app or tool run', assistant: 'stage' }),
  getTools: def({ method: 'GET', path: '/tools', response: ToolsPayload, topic: 'tools', summary: 'ToolAdapter registry with health and recent runs', assistant: 'read' }),
  startToolRun: def({ method: 'POST', path: '/tools/:id/runs', params: IdParams, body: ToolRunRequest, response: MutationResultOf(ToolRun), topic: 'tools', summary: 'Run a tool (explicit Run); progress arrives via live events', assistant: 'deny' }),
  getToolRun: def({ method: 'GET', path: '/tool-runs/:id', params: IdParams, response: ToolRun, topic: 'tool_run', summary: 'One tool run', assistant: 'read' }),

  // ---- Time ----------------------------------------------------------------
  getTime: def({ method: 'GET', path: '/time', query: TimeQuery, response: TimeWeek, topic: 'time', summary: 'Week timeline + activity-log table + quarter + canvas status', assistant: 'read' }),
  getActivityLog: def({ method: 'GET', path: '/time/log', query: ActivityLogQuery, response: ActivityLog, topic: 'time', summary: 'The whole activity log: every row in a range (history included), filtered, with week / month / fiscal-quarter totals', assistant: 'read' }),
  getTimeLedger: def({ method: 'GET', path: '/time/ledger', query: TimeLedgerQuery, response: TimeLedger, topic: 'time', summary: 'Time ▸ Ledger: one fiscal quarter (or every one) as a report: hours in Org62, on their way, suggested and needing input against the target; by account and opportunity, internal, task type, and week (or quarter)', assistant: 'read' }),
  stageLogBatch: def({ method: 'POST', path: '/time/log/batches', body: StageLogBatchRequest, response: MutationResultOf(StageLogBatchResult), topic: 'outbox', summary: 'Log these: approved (and complete proposed) rows → Slackbot work orders → one Outbox canvas item each, sent only on its own Apply', assistant: 'stage', undoable: true }),
  checkCanvasOrg62: def({ method: 'POST', path: '/time/canvases/:id/org62-check', params: IdParams, body: CheckCanvasOrg62Request, response: CheckCanvasOrg62Result, topic: 'time', summary: "A handed-off logging canvas: check Org62 for its rows (read only). reason copied (its Slackbot prompt was just copied: re-checks about 5, 15, 30 and 60 min later) or now (Slackbot's done: check now). Queues the Org62 Events and DCs reads, and the use-case read-back when use cases are on it, deduped; nothing is written anywhere but the app", assistant: 'deny' }),
  patchActivity: def({ method: 'PATCH', path: '/activity/:id', params: IdParams, body: PatchActivityRequest, response: MutationResultOf(ActivityEntry), topic: 'time', summary: 'Autosave one activity row', assistant: 'stage', undoable: true }),
  getOppOptions: def({ method: 'GET', path: '/time/opps', query: OppOptionsQuery, response: OppOptions, topic: 'time', summary: "A row's opportunity picker: every opp, ranked for the row (its account, its evidence and attendees, used recently, then the rest)", assistant: 'read' }),
  searchOrg62Opps: def({ method: 'POST', path: '/time/opps/org62-search', body: Org62OppSearchRequest, response: Org62OppSearch, topic: 'time', summary: 'Search Org62 for an opportunity the app may not have: one live, read-only lookup (the Assistant\'s), hits marked when the app has them', assistant: 'read' }),
  pickOrg62Opp: def({ method: 'POST', path: '/activity/:id/org62-opp', params: IdParams, body: PickOrg62OppRequest, response: MutationResultOf(ActivityEntry), topic: 'time', summary: "Set a row's opp from an Org62 hit: an opp the app lacks (and its account) is read from Org62 and added, then the row's opp and WhatId are set, one undoable change", assistant: 'stage', undoable: true }),
  resolveActivity: def({ method: 'POST', path: '/activity/:id/org62-resolve', params: IdParams, body: ResolveActivityRequest, response: MutationResultOf(ActivityEntry), topic: 'time', summary: 'A row that is not in Org62 after all (its Event deleted there, or its canvas ran without it): Log again (back to approved, on the next canvas) or Leave out (dismissed by you), one undoable change', assistant: 'stage', undoable: true }),
  syncCanvas: def({ method: 'POST', path: '/activity/sync-canvas', body: SyncCanvasRequest, response: CanvasSyncResult, topic: 'time', summary: 'Explicit "Sync to canvas" (mock: dry-run payload only)', assistant: 'deny' }),
  correctOnsiteDay: def({ method: 'POST', path: '/time/onsite/days/:day', params: OnsiteDayParams, body: OnsiteCorrection, response: MutationResultOf(OnsiteDay.nullable()), topic: 'time', summary: 'Onsite day chip: Confirm / Not onsite / Change account / Adjust hours / Clear (a locked override recomputes respect)', assistant: 'stage', undoable: true }),
  markTrip: def({ method: 'POST', path: '/time/onsite/trips', body: MarkTripRequest, response: MutationResultOf(z.array(OnsiteDay)), topic: 'time', summary: 'Mark trip: a date range onsite at one account (a locked override)', assistant: 'stage', undoable: true }),
  // D-70 landings: where every record lands (Org62, VDP) and every write that put it there. Reads run the landing sync
  // first (src/lib/landings/sync.ts); nothing here is ever sent anywhere: writes go out only on a canvas's or item's Apply
  getCanvasWrites: def({ method: 'GET', path: '/time/canvases/:id/writes', params: IdParams, response: CanvasWrites, topic: 'time', summary: "A logging run (one canvas item): every create, update and delete it carries, exactly as sent (an update reads 'Duration 2 h → 3 h'), each one's state (staged, sent, verified, removed before Apply, rejected) and why it was staged", assistant: 'read' }),
  getRecordLandings: def({ method: 'GET', path: '/landings/records', query: RecordLandingsQuery, response: RecordLandings, topic: 'time', summary: 'One record (an activity row, a DC request, a use case, an asset): where it lands (Org62, VDP), its state there (not sent, staged, sent, verified, differs, missing) and every write that put it there, newest first', assistant: 'read' }),
  getEventUpdates: def({ method: 'GET', path: '/time/updates', response: EventUpdatesPayload, topic: 'time', summary: 'Updates to Events already in Org62 that wait for a canvas: proposed (approve or dismiss), approved (on the next canvas), dismissed; each reads "update · Duration 2 h → 3 h" with why', assistant: 'read' }),
  proposeEventUpdates: def({ method: 'POST', path: '/time/updates', body: ProposeEventUpdatesRequest, response: ProposeEventUpdatesResult, topic: 'time', summary: "The re-derive's update candidates ({activityEntryId, org62EventId, field, from, to, reason}): each a proposed write on the row's Org62 landing, never twice the same update; each waits for your approve. Local only", assistant: 'stage' }),
  patchEventUpdate: def({ method: 'PATCH', path: '/time/updates/:id', params: IdParams, body: PatchEventUpdateRequest, response: MutationResultOf(EventUpdateRow), topic: 'time', summary: 'Approve (it goes on the next logging canvas), dismiss, or restore one proposed Event update. Local only', assistant: 'stage' }),
  getUseCaseLandings: def({ method: 'GET', path: '/activity/use-cases', response: UseCaseLandingsPayload, topic: 'deals', summary: 'Every use case with its opportunity, account and assets, and where it landed: Org62 ✓ · VDP —, in neither, one or both; the fields that differ between them (name, product, stage, go-live) with which side changed; what goes on the next canvas; its question for Needs you', assistant: 'read' }),
  pickUseCaseValue: def({ method: 'POST', path: '/activity/use-cases/:key/pick', params: UseCaseKeyParams, body: PickUseCaseValueRequest, response: MutationResultOf(UseCaseLanding), topic: 'deals', summary: "Pick the right value of one field that differs ({field, take: org62 | vdp | null}): the wrong side is corrected, VDP's value as an Org62 UPDATE on the next logging canvas (a record you own), Org62's as a VDP change to push. Nothing is sent here", assistant: 'stage', undoable: true }),
  fixUseCase: def({ method: 'POST', path: '/activity/use-cases/:key/fix', params: UseCaseKeyParams, body: FixUseCaseRequest, response: MutationResultOf(UseCaseLanding), topic: 'deals', summary: "Answer a use case's question before it goes to Org62: the opp it goes on (an Org62 006… id; open, your 100% DC), a name while VDP has none, or leave it out of Org62 (leave false brings it back). Local only", assistant: 'stage', undoable: true }),

  // D-64: "Dismiss all from <source>" (one repo, unmapped Drive docs, one recurring meeting series), remembered
  listTimeDismissRules: def({ method: 'GET', path: '/time/dismiss-rules', response: TimeDismissRules, topic: 'time', summary: 'Settings ▸ Time ▸ Dismissed sources: every remembered "Dismiss all from <source>" rule (repo, unmapped Drive docs, a recurring series) and the rows it sets aside', assistant: 'read' }),
  dismissFromSource: def({ method: 'POST', path: '/time/dismiss-rules', body: DismissSourceRequest, response: MutationResultOf(DismissSourceResult), topic: 'time', summary: "Dismiss all from this row's source: a remembered rule (every live row of it, now and on re-projection, is Dismissed by your rule), one undoable change", assistant: 'stage', undoable: true }),
  removeTimeDismissRule: def({ method: 'POST', path: '/time/dismiss-rules/remove', body: RemoveDismissRuleRequest, response: MutationResultOf(TimeDismissRules), topic: 'time', summary: 'Remove a "Dismiss all from …" rule: its rows come back as proposals (one undoable change)', assistant: 'stage', undoable: true }),

  // ---- Attribution engine (src/engines/attribution; holistic review 2026-11-20 lane 06) ----------------------
  getAttributionRules: def({ method: 'GET', path: '/attribution/rules', response: MappingRulesPayload, topic: 'settings', summary: 'Settings ▸ Time ▸ Learned rules: every rule the attribution engine learned from your corrections (series, channel, domain, contact, word, repo → opp, account or internal), with its hits, misses and last use', assistant: 'read' }),
  patchAttributionRule: def({ method: 'PATCH', path: '/attribution/rules/:id', params: IdParams, body: PatchMappingRuleRequest, response: MutationResultOf(MappingRuleView), topic: 'settings', summary: 'Turn one learned rule off (the engine stops reading it) or back on; one undoable change', assistant: 'stage', undoable: true }),
  deleteAttributionRule: def({ method: 'POST', path: '/attribution/rules/:id/delete', params: IdParams, body: EmptyBody, response: MutationResultOf(MappingRulesPayload), topic: 'settings', summary: 'Remove one learned rule (Undo puts it back); the next correction may learn it again', assistant: 'stage', undoable: true }),
  getDcSuggestions: def({ method: 'GET', path: '/attribution/dc-suggestions', response: DcSuggestionsPayload, topic: 'time', summary: 'The DCs the app suggests claiming this quarter, from what you did (engagement), your teams and the AEs you cover: each with why, its evidence, its share of one engagement (several opps), the default split; nothing is claimed until you Accept', assistant: 'read' }),
  decideDcSuggestion: def({ method: 'POST', path: '/attribution/dc-suggestions/:id', params: IdParams, body: DecideDcSuggestionRequest, response: MutationResultOf(DecideDcSuggestionResult), topic: 'time', summary: 'Accept (a DC request that rides the next logging canvas, sent only on its Apply), Edit (the same with your split, role or comment) or Reject a suggested DC; the decision teaches the engine; one undoable change', assistant: 'stage', undoable: true }),
  refreshDcSuggestions: def({ method: 'POST', path: '/attribution/dc-suggestions/refresh', body: EmptyBody, response: RefreshDcSuggestionsResult, topic: 'time', summary: 'Re-run the DC suggestion batch now (local data only: engagement, teams, covered AEs); the db queues it for the worker', assistant: 'deny' }),
  getOppRundown: def({ method: 'GET', path: '/attribution/rundown', query: OppRundownQuery, response: OppRundown, topic: 'time', summary: "The rundown of opps when unsure: a row's (or an account's) likely opps, ranked, each with what you did on it in the last 4 weeks", assistant: 'read' }),
  lookupCoveredAe: def({ method: 'POST', path: '/attribution/covered-aes/lookup', body: CoveredAeLookupRequest, response: CoveredAeLookupResult, topic: 'settings', summary: 'Settings ▸ Time ▸ AEs I cover: find an AE by name among the app’s people and opp teams, then with one read-only Org62 User read the worker runs where Org62 is live (queued; its hits list on the next ask)', assistant: 'stage' }),
  // ---- Use cases to add (src/engines/use-cases; holistic review 2026-11-20 lane 06 R6) -------------------------
  getUseCaseCandidates: def({ method: 'GET', path: '/use-cases/candidates', response: UseCaseCandidatesPayload, topic: 'time', summary: 'Use cases the app noticed in Gemini notes, meetings, Slack and mail with a customer, waiting for you: each with the problem, products, outcome, its evidence, the opp the attribution engine chose and why (or the top 3 to pick from when unsure), and what Accept would stage; plus the last 30 days of decided ones', assistant: 'read' }),
  decideUseCaseCandidate: def({ method: 'POST', path: '/use-cases/candidates/:id', params: IdParams, body: DecideUseCaseCandidateRequest, response: MutationResultOf(DecideUseCaseCandidateResult), topic: 'time', summary: 'Accept (drafts the VDP create_use_case Outbox item and an Org62 Use_Case__c row for the next logging canvas, both applied by you; nothing is sent), Edit (title, problem, products, outcome, the opp) or Reject with why (not a use case, wrong opp, duplicate, already in Org62); a pick of the opp teaches the attribution engine; one undoable change', assistant: 'stage', undoable: true }),
  addUseCaseCandidate: def({ method: 'POST', path: '/use-cases/candidates', body: AddUseCaseCandidateRequest, response: MutationResultOf(AddUseCaseCandidateResult), topic: 'time', summary: 'Add a use case by hand to the list (deduped against VDP, Org62 and the other candidates: a match adds to that one instead); Accept it to stage it; one undoable change', assistant: 'stage', undoable: true }),
  refreshUseCaseCandidates: def({ method: 'POST', path: '/use-cases/candidates/refresh', body: EmptyBody, response: RefreshUseCaseCandidatesResult, topic: 'time', summary: 'Read the notes, meetings, Slack and mail of the last weeks for use cases now (local data; the db queues use_cases.extract for the worker)', assistant: 'deny' }),

  // lane A: Specialist Forecast (Time ▸ Forecast; persona feature specialistForecast). Never writes to Org62.
  getForecast: def({ method: 'GET', path: '/time/forecast', response: ForecastPayload, topic: 'time', summary: 'Time ▸ Forecast: my Specialist Forecasts (read-only mirror), the weekly notes queue, Deal Role fixes, opps with no record, and the canvases waiting for Apply', assistant: 'read' }),
  getForecastRecord: def({ method: 'GET', path: '/time/forecast/records/:id', params: ForecastRecordParams, response: ForecastRecordDetail, topic: 'time', summary: 'One Specialist Forecast for the details panel: the mirror, its update and what a draft reads', assistant: 'read' }),
  syncForecast: def({ method: 'POST', path: '/time/forecast/sync', body: EmptyBody, response: MutationResultOf(SyncForecastResult), topic: 'time', summary: 'Sync now: queue one read of my Specialist Forecasts and their note history (fixed SOQL, read-only)', assistant: 'stage' }),
  draftForecastNotes: def({ method: 'POST', path: '/time/forecast/drafts', body: DraftForecastNotesRequest, response: MutationResultOf(DraftForecastNotesResult), topic: 'time', summary: "Draft one record's forecast note, or Draft all for the queue: read-only research runs, $0.25 cap each (mock: placeholder drafts)", assistant: 'deny' }),
  patchForecast: def({ method: 'PATCH', path: '/time/forecast/records/:id', params: ForecastRecordParams, body: PatchForecastRequest, response: MutationResultOf(ForecastRow), topic: 'time', summary: "Edit, approve or discard a record's note; approve or drop its Deal Role fix (local only)", assistant: 'stage' }),
  stageForecast: def({ method: 'POST', path: '/time/forecast/stage', body: StageForecastRequest, response: MutationResultOf(StageForecastResult), topic: 'outbox', summary: 'Stage N notes: approved notes and Deal Role fixes → ONE Slackbot canvas of SpecialistForecast__c UPDATE rows (an Outbox item, previewed and sent only on its own Apply)', assistant: 'stage', undoable: true }),
  checkMissingForecast: def({ method: 'POST', path: '/time/forecast/missing/:id/check', params: ForecastRecordParams, body: EmptyBody, response: MutationResultOf(CheckMissingForecastResult), topic: 'time', summary: '"I created it, check now" on an opp with no Specialist Forecast (id = the opportunity): queue one read-only re-read of that opp\'s records for the worker (fixed SOQL), and a full read 30 minutes later', assistant: 'stage' }),
  // end lane A

  // ---- History (B-081) -------------------------------------------------------
  getHistoryMonth: def({ method: 'GET', path: '/history', query: HistoryMonthQuery, response: HistoryMonth, topic: 'time', summary: 'History calendar: one light summary per day of the month grid (finished, hours, meetings, sent, runs, Org62)', assistant: 'read' }),
  getHistoryDay: def({ method: 'GET', path: '/history/:day', params: HistoryDayParams, response: HistoryDay, topic: 'time', summary: 'What was done on one local day, from stored history (transitions, activity, calendar, outbox, runs)', assistant: 'read' }),

  // ---- Deals ---------------------------------------------------------------
  getDeals: def({ method: 'GET', path: '/deals', query: DealsQuery, response: DealsPayload, topic: 'deals', summary: 'Accounts list', assistant: 'read' }),
  getMissed: def({ method: 'GET', path: '/deals/missed', response: MissedPayload, topic: 'deals', summary: 'Missed-opp findings (R-UI-14)', assistant: 'read' }),
  getVdpCoverage: def({ method: 'GET', path: '/deals/vdp', response: VdpCoveragePayload, topic: 'deals', summary: 'VDP coverage: my VDPs from the read-only mirror, with gaps (app fix or handoff)', assistant: 'read' }),
  getVdpDetail: def({ method: 'GET', path: '/deals/vdp/detail', query: VdpDetailQuery, response: VdpDetailPayload, topic: 'deals', summary: 'One VDP (slug) or one engaged account with no VDP (account:<id>): the ordered steps, the assets to add, and everything the mirror read', assistant: 'read' }),
  setVdpCandidate: def({ method: 'POST', path: '/deals/vdp/candidates/:id', params: IdParams, body: SetVdpCandidateRequest, response: MutationResultOf(VdpAssetCandidate), topic: 'deals', summary: 'An asset candidate: confirm it, mark it added in VDP (the next read confirms), or dismiss it', assistant: 'stage' }),
  findVdpAssets: def({ method: 'POST', path: '/deals/vdp/find-assets', body: FindVdpAssetsRequest, response: MutationResultOf(FindVdpAssetsResult), topic: 'deals', summary: 'Find assets: a read-only research run over the account history (one key, or all within a total cap); records candidates, never writes to VDP', assistant: 'deny' }),
  draftVdpUpdate: def({ method: 'POST', path: '/deals/vdp/updates', body: DraftVdpUpdateRequest, response: MutationResultOf(DraftVdpUpdateResult), topic: 'outbox', summary: 'One VDP field change → one Outbox item (pending approval, before → after); nothing is sent', assistant: 'stage' }),
  // D-60: the user's "Push N to VDP" click is the approval of each ticked item; the Assistant never pushes (deny)
  pushVdpChanges: def({ method: 'POST', path: '/deals/vdp/push', body: PushVdpChangesRequest, response: PushVdpChangesResult, topic: 'outbox', summary: 'Push the ticked VDP changes: each item staged and applied on this click (dry run records only), read back after', assistant: 'deny' }),
  // D-69: company identity (Change… on a company node): read-only company search, and your user-locked mapping
  searchVdpCompanies: def({ method: 'GET', path: '/deals/vdp/companies', query: SearchVdpCompaniesQuery, response: SearchVdpCompaniesResult, topic: 'deals', summary: 'Search VDP companies by name (read-only: the mirror, the stored list_companies lookups, and VDP itself when live)', assistant: 'read' }),
  setVdpIdentity: def({ method: 'POST', path: '/deals/vdp/identity', body: SetVdpIdentityRequest, response: MutationResultOf(VdpIdentityResult), topic: 'deals', summary: 'Change… on a VDP company node: pick the VDP company (or one to create with a name you type) and the Org62 accounts in it; a user-locked mapping used by the tree, the linking and the push (local; nothing is sent)', assistant: 'stage', undoable: true }),
  clearVdpIdentity: def({ method: 'POST', path: '/deals/vdp/identity/clear', body: ClearVdpIdentityRequest, response: MutationResultOf(VdpIdentityResult), topic: 'deals', summary: "Reset a VDP company node to the app's own decision (drops your mapping; local)", assistant: 'stage', undoable: true }),
  getAccount: def({ method: 'GET', path: '/deals/:accountId', params: AccountParams, response: AccountDetail, topic: 'deals', summary: 'Account page (with `needs`: its Deals needs rows, the DC gap naming each opp)', assistant: 'read' }),
  listNeedDecisions: def({ method: 'GET', path: '/needs/decisions', response: NeedDecisionsPayload, topic: 'deals', summary: 'Needs rows set aside: Snooze (until) or Not needed (reason, and the facts it comes back on) per {rule, subjectId}: dc_gap per opp, deals_ahead / deals_chase per account, home:<rule> per Home row', assistant: 'read' }),
  decideNeed: def({ method: 'POST', path: '/needs/decisions', body: DecideNeedRequest, response: MutationResultOf(NeedDecisionsPayload), topic: 'deals', summary: 'Set needs rows aside: {rule, subjectIds, kind: snooze (until?, default a week) | not_needed (reason)} from a row\'s `resolve`. A Not needed DC gap comes back when I join the opp team or log 2 h more on it', assistant: 'stage', undoable: true }),
  clearNeedDecision: def({ method: 'POST', path: '/needs/decisions/clear', body: ClearNeedRequest, response: MutationResultOf(NeedDecisionsPayload), topic: 'deals', summary: 'Bring set-aside needs rows back: {rule, subjectIds}', assistant: 'stage', undoable: true }),
  // 01 R1 / D-86: the one Needs-you queue (src/engines/needs). `decideNeedRow` runs a row's verb through the route the
  // page already calls (accept, dismiss, confirm, reject a draft, claim a DC, answer a spend ask, Later): no new
  // mutation, the same audit and Undo. It is deny for the Assistant: a row can answer a spend ask, which is the user's.
  listNeeds: def({ method: 'GET', path: '/needs', response: NeedsPayload, topic: 'home', summary: 'The Needs-you queue: one row per fact (kind, title, why, who/account/opp, verbs with the route each runs, group key, urgency, since, source, estimate), ordered by urgency then age, never capped; `total` is the one count (sidebar, Home, Activity)', assistant: 'read' }),
  decideNeedRow: def({ method: 'POST', path: '/needs/:id/decide', params: NeedRowParams, body: DecideNeedRowRequest, response: MutationResultOf(DecideNeedRowResult), topic: 'home', summary: 'Apply one verb of a Needs-you row through the existing route it names (acceptTriage, dismissTriage, itemAction, rejectDraft, decideDcSuggestion, answerSpendHold, markItemSeen, decideNeed, decideUseCaseCandidate); the envelope carries that route\'s auditId for Undo. Never sends', assistant: 'deny' }),
  listDcRequests: def({ method: 'GET', path: '/deals/dc-requests', response: DcRequestsPayload, topic: 'deals', summary: 'My DCs (split, role, from the Org62 scans) and my DC requests: add or change, requested → on a canvas → confirmed in Org62, with why one cannot be edited', assistant: 'read' }),
  // D-67: VDP use cases → Org62 Use_Case__c, read-only (they ride the next logging canvas; nothing is sent here)
  getUseCaseSync: def({ method: 'GET', path: '/deals/use-cases', response: UseCaseSyncPayload, topic: 'deals', summary: 'My VDP use cases and their Org62 Use_Case__c: what the next logging canvas creates (opp, fields) or updates (Stage / Go-Live), what is on a canvas, what is in Org62 (linked), and why any is skipped', assistant: 'read' }),
  addOrg62Opps: def({ method: 'POST', path: '/deals/org62-opps', body: AddOrg62OppsRequest, response: MutationResultOf(AddOrg62OppsResult), topic: 'deals', summary: "Add opps the app doesn't track (and their accounts) from Org62, one read: {org62Ids (006…)}. The app tracks opps on your teams and the ones you hold a DC on; this brings in others (a teammate's deal to claim a DC on). Tracked ones are left as they are; ids Org62 doesn't return come back as missing. createDcRequest adds an untracked opp by itself; use this for several at once or to add without claiming", assistant: 'stage', undoable: true }),
  createDcRequest: def({ method: 'POST', path: '/deals/dc-requests', body: CreateDcRequestRequest, response: MutationResultOf(DcRequest), topic: 'deals', summary: 'Claim a Deal Contribution: {opp (app id or Org62 006… id), split %, comment, role?}. An Org62 id the app does not track is read from Org62 and added (with its account) in the same change. Refused when I already hold a DC with that split; a different split becomes a change of my DC (kind change, fromSplit). It rides on the next logging canvas with rows; nothing is sent here', assistant: 'stage', undoable: true }),
  patchDcRequest: def({ method: 'PATCH', path: '/deals/dc-requests/:id', params: IdParams, body: PatchDcRequestRequest, response: MutationResultOf(DcRequest), topic: 'deals', summary: 'Edit a DC request still waiting for a canvas: {split?, role?, comment?} (re-checked against my DC on the opp). One already on a canvas is refused, with why', assistant: 'stage', undoable: true }),
  withdrawDcRequest: def({ method: 'POST', path: '/deals/dc-requests/:id/withdraw', params: IdParams, body: EmptyBody, response: MutationResultOf(DcRequest), topic: 'deals', summary: 'Withdraw a DC request still waiting for a canvas (it never goes to Slackbot). One already on a canvas is refused, with why', assistant: 'stage', undoable: true }),
  withdrawDcRequests: def({ method: 'POST', path: '/deals/dc-requests/withdraw', body: WithdrawDcRequestsRequest, response: MutationResultOf(WithdrawDcRequestsResult), topic: 'deals', summary: 'Withdraw several DC requests still waiting for a canvas in ONE change (one Undo): {ids?} (none: every waiting one). One already on a canvas, confirmed or withdrawn is skipped, with why; nothing is sent', assistant: 'stage', undoable: true }),
  claimMissed: def({ method: 'POST', path: '/deals/missed/:id/claim', params: IdParams, body: ClaimMissedRequest, response: MutationResultOf(MissedOpp), topic: 'deals', summary: 'Claim {split?, role?, comment?} → a DC request on the opp (the createDcRequest rules; next logging canvas). A task only when the app does not know the opp', assistant: 'stage', undoable: true }),
  dismissMissed: def({ method: 'POST', path: '/deals/missed/:id/dismiss', params: IdParams, body: DismissRequest, response: MutationResultOf(MissedOpp), topic: 'deals', summary: 'Dismiss with reason', assistant: 'stage', undoable: true }),

  // ---- Briefs and watches --------------------------------------------------
  getBriefs: def({ method: 'GET', path: '/briefs', response: BriefsPayload, topic: 'briefs', summary: 'Watched + My opportunities brief lists', assistant: 'read' }),
  getBrief: def({ method: 'GET', path: '/briefs/:id', params: IdParams, response: Brief, topic: 'briefs', summary: 'One brief with highlights', assistant: 'read' }),
  promoteHighlight: def({ method: 'POST', path: '/briefs/highlights/:id/promote', params: IdParams, body: HighlightActionRequest, response: MutationResultOf(BriefHighlight), topic: 'briefs', summary: 'Promote → Triage', assistant: 'stage', undoable: true }),
  taskFromHighlight: def({ method: 'POST', path: '/briefs/highlights/:id/task', params: IdParams, body: HighlightActionRequest, response: MutationResultOf(BriefHighlight), topic: 'briefs', summary: 'Make task', assistant: 'stage', undoable: true }),
  dismissHighlight: def({ method: 'POST', path: '/briefs/highlights/:id/dismiss', params: IdParams, body: HighlightActionRequest, response: MutationResultOf(BriefHighlight), topic: 'briefs', summary: 'Not relevant (tunes relevance)', assistant: 'stage', undoable: true }),
  listWatches: def({ method: 'GET', path: '/watches', response: WatchesPayload, topic: 'watches', summary: 'Watch subscriptions', assistant: 'read' }),
  createWatch: def({ method: 'POST', path: '/watches', body: CreateWatchRequest, response: MutationResultOf(WatchSubscription), topic: 'watches', summary: 'Add a watch (explicit Save)', assistant: 'stage', undoable: true }),
  patchWatch: def({ method: 'PATCH', path: '/watches/:id', params: IdParams, body: PatchWatchRequest, response: MutationResultOf(WatchSubscription), topic: 'watches', summary: 'Edit a watch (explicit Save)', assistant: 'stage', undoable: true }),

  // ---- Triage --------------------------------------------------------------
  getTriage: def({ method: 'GET', path: '/triage', response: TriagePayload, topic: 'triage', summary: 'Asks & promises · Meeting takeaways · Missed opps · Mappings', assistant: 'read' }),
  acceptTriage: def({ method: 'POST', path: '/triage/:id/accept', params: IdParams, body: TriageAcceptRequest, response: MutationResultOf(TriageItem), topic: 'triage', summary: '`a` accept (mapping: choiceId)', assistant: 'stage', undoable: true }),
  dismissTriage: def({ method: 'POST', path: '/triage/:id/dismiss', params: IdParams, body: DismissRequest, response: MutationResultOf(TriageItem), topic: 'triage', summary: '`n` dismiss with reason', assistant: 'stage', undoable: true }),
  mergeTriage: def({ method: 'POST', path: '/triage/:id/merge', params: IdParams, body: TriageMergeRequest, response: MutationResultOf(TriageItem), topic: 'triage', summary: '`m` merge into an existing item', assistant: 'stage', undoable: true }),

  // ---- Health --------------------------------------------------------------
  getHealth: def({ method: 'GET', path: '/health', response: HealthPayload, topic: 'health', summary: 'Connectors, summary, spend, worker', assistant: 'read' }),
  // priority@2 (lane 07 R8): the shadow preview, the learning rule, and the ops re-rank
  getPriorityPreview: def({ method: 'GET', path: '/priority/preview', response: PriorityPreview, topic: 'today', summary: "Today's \"Preview new ranking\": priority@2's Top 3 and first ten over today's inputs, with the shown ranking's rank per row, agreement@3, capacity, the admin block and Make room. Nothing is written", assistant: 'read' }),
  decidePriorityRule: def({ method: 'POST', path: '/priority/rules/:id/decide', params: PriorityRuleParams, body: DecidePriorityRuleRequest, response: MutationResultOf(PriorityRule), topic: 'health', summary: 'Health ▸ the suggested priority rule: apply (a bounded persona weight nudge; a re-rank follows) or dismiss. Local; undoable', assistant: 'stage', undoable: true }),
  rerankAllUsers: def({ method: 'POST', path: '/admin/priority/rerank-all', body: EmptyBody, response: RerankAllResult, topic: 'health', summary: 'Ops: queue the deterministic re-rank for every user (no model call)', assistant: 'deny' }),
  getSpendAudit: def({ method: 'GET', path: '/spend/audit', query: SpendAuditQuery, response: SpendAuditPayload, topic: 'health', summary: 'Spend & decisions (D0): every model call by day, skill, model and trigger with tokens and cache, and every decision not to call (or to escalate) with its reason', assistant: 'read' }),
  getSpendAuditDetail: def({ method: 'GET', path: '/spend/audit/detail', query: SpendAuditDetailQuery, response: SpendAuditDetail, topic: 'health', summary: "One day (and skill) of Spend & decisions: its calls, paged, and its decisions with their reasons", assistant: 'read' }),
  listSpendHolds: def({ method: 'GET', path: '/spend/holds', query: ListSpendHoldsQuery, response: SpendHoldsPayload, topic: 'health', summary: 'Spend governor receipts: every hold (estimate p50/p90, held, spent, state) since a time, the open asks and the asked / approved / denied counts with the median overrun', assistant: 'read' }),
  answerSpendHold: def({ method: 'POST', path: '/spend/holds/:id/answer', params: IdParams, body: AnswerSpendHoldRequest, response: AnswerSpendHoldResult, topic: 'health', summary: 'Answer a spend ask: Allow $Z more (the run continues or is re-queued with it), Allow for today, or Stop (settled as denied; partial results stay)', assistant: 'deny' }),
  reauthConnector: def({ method: 'POST', path: '/connectors/:id/reauth', params: IdParams, body: EmptyBody, response: ReauthResult, topic: 'health', summary: 'Re-auth affordance (mock: simulated)', assistant: 'deny' }),
  scanConnector: def({ method: 'POST', path: '/connectors/:id/scan', params: IdParams, body: ScanRequest, response: MutationResultOf(ScanRun), topic: 'health', summary: 'Run a scan now (mock: simulated)', assistant: 'deny' }),
  getScans: def({ method: 'GET', path: '/scans', query: ListQuery, response: ScansPayload, topic: 'scans', summary: "Scan ledger, newest first: `limit` runs from `cursor` (the previous page's `nextCursor`; null on the last page) and `total` (every run)", assistant: 'read' }),
  getJobs: def({ method: 'GET', path: '/jobs', response: JobsPayload, topic: 'jobs', summary: 'Jobs incl. dead-letter', assistant: 'read' }),
  retryJob: def({ method: 'POST', path: '/jobs/:id/retry', params: IdParams, body: EmptyBody, response: MutationResultOf(Job), topic: 'jobs', summary: 'Requeue a dead/failed job', assistant: 'stage' }),
  getVersion: def({ method: 'GET', path: '/version', response: VersionPayload, topic: 'health', summary: 'App version (D-57): version, short sha, build time, latest applied migration, persona, the worker\'s version and whether they differ', assistant: 'read' }),
  checkForUpdates: def({ method: 'POST', path: '/version/check-updates', body: EmptyBody, response: CheckForUpdatesResult, topic: 'health', summary: 'Check for updates now (D-90): queue the update check (one read of the release feed in the shared Drive folder through the devbar Drive read path; nothing is downloaded or installed); the mock answers from its last result', assistant: 'deny' }),
  getDoctor: def({ method: 'GET', path: '/doctor', query: DoctorQuery, response: DoctorPayload, topic: 'health', summary: "This Mac's setup checks (11 R6): the worker's last doctor run, or a fresh one; each failing check with its error-catalog code and next step. Answers without the database (DEP.DB.DOWN)", assistant: 'read' }),
  smokeClaude: def({ method: 'POST', path: '/doctor/claude-smoke', body: EmptyBody, response: ClaudeSmokeResult, topic: 'health', summary: 'Check again for Claude: one `claude -p "reply OK"` (about $0.001, shown first); refused without a configured AI gateway; never automatic', assistant: 'deny' }),
  getEventLog: def({ method: 'GET', path: '/events/log', response: EventLogPayload, topic: 'event_log', summary: 'Error/event log', assistant: 'read' }),
  ackEvent: def({ method: 'POST', path: '/events/log/:id/ack', params: IdParams, body: EmptyBody, response: MutationResultOf(EventLogEntry), topic: 'event_log', summary: 'Acknowledge', assistant: 'stage', undoable: true }),

  // ---- Settings and policy -------------------------------------------------
  getSettings: def({ method: 'GET', path: '/settings', response: Settings, topic: 'settings', summary: 'All settings sections', assistant: 'read' }),
  patchSettings: def({ method: 'PATCH', path: '/settings/:section', params: SectionParams, body: PatchSettingsRequest, response: MutationResultOf(Settings), topic: 'settings', summary: 'Save one section (dry-run off needs confirm)', assistant: 'stage', undoable: true }),
  raiseBudgetToday: def({ method: 'POST', path: '/budgets/raise-today', body: RaiseBudgetTodayRequest, response: MutationResultOf(BudgetSettings), topic: 'settings', summary: "Raise today's cap (hard, optionally soft) with a reason; every raise is kept in budgets.raises. Raise only", assistant: 'deny' }),
  // Settings ▸ Data (p4-retention's policy; the horizons live in user_settings key `retention`). Local app data only.
  getRetention: def({ method: 'GET', path: '/retention', response: RetentionSettings, topic: 'settings', summary: 'Data retention horizons (Settings ▸ Data): on/off and the days each kind of local record is kept', assistant: 'read' }),
  patchRetention: def({ method: 'PATCH', path: '/retention', body: RetentionSettings.partial(), response: RetentionSettings, topic: 'settings', summary: 'Change the retention horizons (local app data only)', assistant: 'deny' }),
  runRetention: def({ method: 'POST', path: '/retention/run', body: RunRetentionRequest, response: RetentionRunPayload, topic: 'settings', summary: '"Run retention now": the plan with counts (dry) or the run itself, even when the nightly job is off; waits while a scan runs. Deletes only local app data', assistant: 'deny' }),
  previewPolicy: def({ method: 'POST', path: '/policy/preview', body: PolicyPreviewRequest, response: PolicyPreview, topic: 'policy', summary: 'Before/after Top 10 for proposed weights/rules', assistant: 'read' }),
  applyPolicy: def({ method: 'POST', path: '/policy/apply', body: PolicyApplyRequest, response: MutationResultOf(PriorityPolicy), topic: 'policy', summary: 'Explicit Apply: new policy version + visible re-rank', assistant: 'deny' }),
  revertPolicy: def({ method: 'POST', path: '/policy/revert', body: PolicyRevertRequest, response: MutationResultOf(PriorityPolicy), topic: 'policy', summary: 'Revert to a previous version (as a new version)', assistant: 'stage', undoable: true }),
  getPolicyVersions: def({ method: 'GET', path: '/policy/versions', response: PolicyVersionsPayload, topic: 'policy', summary: 'Policy version history', assistant: 'read' }),

  // ---- Universal --------------------------------------------------------------
  undoAudit: def({ method: 'POST', path: '/audit/:id/undo', params: IdParams, body: EmptyBody, response: MutationResultOf(AuditEntry), topic: 'audit', summary: 'Universal undo (undoing an undo = redo)', assistant: 'stage' }),
  search: def({ method: 'GET', path: '/search', query: SearchQuery, response: SearchResult, topic: 'search', summary: '⌘K search', assistant: 'read' }),
  getSince: def({ method: 'GET', path: '/since', query: SinceQuery, response: SinceDigest, topic: 'since', summary: '"Since you left" digest', assistant: 'read' }),
  getPeople: def({ method: 'GET', path: '/people', query: PeopleQuery, response: PeoplePayload, topic: 'search', summary: 'People for @-mentions and recipients (name, email, Slack id, role, account, isExternal)', assistant: 'read' }),

  // ---- Chat ------------------------------------------------------------------
  listChatThreads: def({ method: 'GET', path: '/chat/threads', response: ChatThreadsPayload, topic: 'chat', summary: 'Chat threads', assistant: 'read' }),
  createChatThread: def({ method: 'POST', path: '/chat/threads', body: CreateChatThreadRequest, response: ChatThread, topic: 'chat', summary: 'New thread (optional title + context); not undoable, like chat messages', assistant: 'deny' }),
  getChatThread: def({ method: 'GET', path: '/chat/threads/:id', params: IdParams, response: ChatThreadDetail, topic: 'chat', summary: 'One thread with messages', assistant: 'read' }),
  chatSpendAnswer: def({ method: 'POST', path: '/chat/spend-answer', body: ChatSpendAnswerRequest, response: AnswerSpendHoldResult, topic: 'chat', summary: "The Assistant card's answer to its turn's spend-ask: approve(usd) lets the waiting turn continue, deny wraps it up from what it has", assistant: 'deny' }),
  chatPlanAnswer: def({ method: 'POST', path: '/chat/plan-answer', body: ChatPlanAnswerRequest, response: ChatPlanAnswerResult, topic: 'chat', summary: "The plan card's answer (Run / Edit / Skip) to the turn waiting on it before a research-class run", assistant: 'deny' }),
  listChatMemory: def({ method: 'GET', path: '/chat/memory', query: ChatMemoryQuery, response: ChatMemoryPayload, topic: 'chat', summary: "The Assistant's memory: a thread's notes and summaries, and the user's preferences (threadId omitted: preferences only; scope=pinned: every pinned entry and preference with its source message)", assistant: 'read' }),
  deleteChatMemory: def({ method: 'POST', path: '/chat/memory/:id/delete', params: IdParams, body: EmptyBody, response: DeleteChatMemoryResult, topic: 'chat', summary: 'Forget one memory entry (a note, a preference or a summary)', assistant: 'deny' }),
  chat: def({ method: 'POST', path: '/chat', body: ChatRequest, response: ChatSseEvent, stream: true, topic: 'chat', summary: 'Send a message; SSE stream of ChatSseEvent', assistant: 'deny' }),

  // ---- Read-ins (BE-READIN) ---------------------------------------------------
  getReadIn: def({ method: 'GET', path: '/readin/:type/:id', params: ReadInParams, response: ReadInPayload, topic: 'readin', summary: 'Read-in for a work item or event (null when none was requested)', assistant: 'read' }),
  requestReadIn: def({ method: 'POST', path: '/readin/:type/:id', params: ReadInParams, body: RequestReadInRequest, response: MutationResultOf(ReadIn), topic: 'readin', summary: '"Read me in" / Regenerate: queue research (read-only tools); supersedes a running one', assistant: 'stage' }),

  // ---- Onboarding (B-079) ------------------------------------------------------
  getOnboarding: def({ method: 'GET', path: '/onboarding', response: OnboardingState, topic: 'onboarding', summary: 'First-launch state: required (every page redirects), step, draft, role packs, cost estimates', assistant: 'read' }),
  saveOnboardingStep: def({ method: 'POST', path: '/onboarding/step', body: SaveOnboardingStepRequest, response: OnboardingState, topic: 'onboarding', summary: 'Save one step of the draft and move (Back, Next, a step in the list); forward needs the step to check out', assistant: 'deny' }),
  getOnboardingSources: def({ method: 'GET', path: '/onboarding/sources', query: OnboardingSourcesQuery, response: OnboardingSourcesPayload, topic: 'onboarding', summary: 'Read-only connector status with the exact re-auth command (never starts auth)', assistant: 'read' }),
  completeOnboarding: def({ method: 'POST', path: '/onboarding/complete', body: CompleteOnboardingRequest, response: OnboardingCompleteResult, topic: 'onboarding', summary: 'Bootstrap the user, save settings and policy, record the first-scan request', assistant: 'deny' }),

  // ---- Feedback (D-56) // lane D -------------------------------------------------
  getFeedback: def({ method: 'GET', path: '/feedback', response: FeedbackState, topic: 'settings', summary: "Report a bug / idea: the channel Send posts to (Settings ▸ Feedback, else config/team.json), dry run, post live, the server build and the reporter's first name", assistant: 'read' }),
  diagnoseFeedback: def({ method: 'POST', path: '/feedback/diagnose', body: DiagnoseFeedbackRequest, response: DiagnoseFeedbackResult, topic: 'outbox', summary: 'One read-only diagnose run (errors, jobs, health, scans, trace, page, code; $0.40 cap on the Assistant line) or the deterministic fallback; names → placeholders before and after; nothing is sent', assistant: 'deny' }),
  stageFeedback: def({ method: 'POST', path: '/feedback/reports', body: StageFeedbackRequest, response: MutationResultOf(StageFeedbackResult), topic: 'outbox', summary: 'The edited report → one Outbox item (feedback.post, ready) + its preview and confirm token; Send is POST /drafts/:id/dispatch (dry run applies; live posts only to the configured channel)', assistant: 'deny' }),

  // ---- Guide (handoff) ----------------------------------------------------------
  getGuide: def({ method: 'GET', path: '/guide', response: GuidePayload, topic: 'settings', summary: 'Getting started: the persona-aware guided path, computed from real state (sources, persona, first scan, first approved draft, first batch, Assistant, feedback) and from which page tours are done, and whether it was dismissed', assistant: 'read' }),

  getReadme: def({ method: 'GET', path: '/guide/readme', response: ReadmePayload, topic: 'settings', summary: 'The repository README as markdown (⌘K ▸ Read the README); read-only', assistant: 'read' }),

  // ---- Live ------------------------------------------------------------------
  events: def({ method: 'GET', path: '/events', response: LiveEvent, stream: true, topic: 'today', summary: 'SSE live invalidation {topic, ids, reason}', assistant: 'deny' }),

  // ---- Dev (mock only) -------------------------------------------------------
  getScenario: def({ method: 'GET', path: '/dev/scenario', response: ScenarioStatus, topic: 'scenario', summary: 'Scenario clock status', dev: true, assistant: 'deny' }),
  controlScenario: def({ method: 'POST', path: '/dev/scenario', body: DevScenarioRequest, response: ScenarioStatus, topic: 'scenario', summary: 'play · pause · reset · seek', dev: true, assistant: 'deny' }),
  getDevFail: def({ method: 'GET', path: '/dev/fail', response: DevFailStatus, topic: 'scenario', summary: 'Current failure rate', dev: true, assistant: 'deny' }),
  setDevFail: def({ method: 'POST', path: '/dev/fail', body: DevFailRequest, response: DevFailStatus, topic: 'scenario', summary: 'Random upstream_unavailable for rollback testing', dev: true, assistant: 'deny' }),
  devEngineChange: def({ method: 'POST', path: '/dev/engine-change', body: DevEngineChangeRequest, response: DevEngineChangeResult, topic: 'scenario', summary: 'Simulate an engine write (locked fields → proposals)', dev: true, assistant: 'deny' }),
} as const;

export type Routes = typeof routes;
export type RouteKey = keyof Routes;
export const ROUTE_KEYS = Object.keys(routes) as RouteKey[];

type Field<D, F extends string> = D extends Record<F, infer S> ? (S extends z.ZodTypeAny ? S : never) : never;
type Has<D, F extends string> = D extends Record<F, z.ZodTypeAny> ? true : false;

/** Parsed (server-side) input: defaults applied. */
export type RouteInput<K extends RouteKey> = (Has<Routes[K], 'params'> extends true ? { params: z.output<Field<Routes[K], 'params'>> } : unknown) &
  (Has<Routes[K], 'query'> extends true ? { query: z.output<Field<Routes[K], 'query'>> } : unknown) &
  (Has<Routes[K], 'body'> extends true ? { body: z.output<Field<Routes[K], 'body'>> } : unknown);

/** Wire (client-side) input: defaulted fields optional. */
export type RouteClientInput<K extends RouteKey> = (Has<Routes[K], 'params'> extends true ? { params: z.input<Field<Routes[K], 'params'>> } : unknown) &
  (Has<Routes[K], 'query'> extends true ? { query?: z.input<Field<Routes[K], 'query'>> } : unknown) &
  (Has<Routes[K], 'body'> extends true ? { body?: z.input<Field<Routes[K], 'body'>> } : unknown);

/** JSON response (or, for stream routes, one SSE event). */
export type RouteOutput<K extends RouteKey> = z.output<Routes[K]['response']>;

export type StreamRouteKey = { [K in RouteKey]: Routes[K] extends { stream: true } ? K : never }[RouteKey];
export type JsonRouteKey = Exclude<RouteKey, StreamRouteKey>;

/** Fill a path template: buildPath('/items/:id', {id: 'w1'}) → '/items/w1'. */
export function buildPath(template: string, params?: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const v = params?.[name];
    if (v === undefined) throw new Error(`missing path param :${name} for ${template}`);
    return encodeURIComponent(v);
  });
}

export const API_BASE = '/api/v1';
