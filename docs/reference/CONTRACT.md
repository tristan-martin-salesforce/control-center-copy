# API contract (W0)

`src/contract/**` (zod) is the single source of truth for the HTTP API. Types come from `z.infer`, the route table is `src/contract/routes.ts`, and the route handlers under `app/api/v1/**` are generated from it (`npm run gen:routes`). The orchestrator owns the contract. If a lane needs a change, it raises a `blocker`.

## Layout

| File | What |
|---|---|
| `common.ts` | Scalars (ids, ISO instants, `IsoDate`) and every enum: WorkKind, WorkState, Confidence, SourceKind, EvidenceRole, NbaVerb, DispatchMode, RunState, ConnectorState, ReauthKind, ActivityStatus, BriefRelevance, SaveModel, Tone, Actor, EntityType. Also EntityRef, SourceRef, PersonRef, FieldChange and Effort |
| `envelope.ts` | ApiError envelope + codes, Receipt, AuditEntry, `MutationResultOf()`, LiveEvent / LiveTopic |
| `work.ts` | WorkItemRecord / WorkItem (with resolved `refs`), Evidence, Proposal, Initiative, Asset, Person, and the R-UI-22 Resolution / Involvement / LoopedBackIn |
| `nba.ts` | Destination (slack · email), TipTap doc, Draft + renditions, NbaCard, DraftPreview, DispatchResult, Outbox |
| `calendar.ts`, `agents.ts`, `time.ts`, `history.ts`, `deals.ts`, `briefs.ts`, `health.ts`, `settings.ts`, `chat.ts` | One per surface. `agents.ts` holds the ToolAdapter **view** (derived from the TOOLS manifest, `src/tools/manifest.ts`) |
| `tools-view.ts` | `toToolView()` / `toToolAdapter()`: TOOLS manifest → ToolAdapter view; `ToolAdapterSeedRow` maps legacy seed manifests onto the same view |
| `views.ts` | Page payloads: TodayPayload (header, spine, NOW, shelves, rail lanes), ItemsPayload, WorkItemDetail, InitiativeDetail, AccountDetail, Triage, SinceDigest, SearchResult |
| `requests.ts` | Path params, queries and every mutation body |
| `dev.ts` | Scenario clock (ScenarioEvent / ScenarioAction / ScenarioStatus) and the dev failure switch |
| `seed.ts` | `Seed`: the full mock store contents plus `scenario?` |
| `routes.ts` | `routes` table (method, path, params/query/body/response schemas, live topic), plus the `RouteInput` / `RouteOutput` / `RouteClientInput` helpers |

## Conventions

- **Naming.** Field names are camelCase; enum values are snake_case. Path verbs are kebab-case (`/items/:id/actions/confirm-done`). Timestamps are ISO instants and calendar days are `YYYY-MM-DD`. The UI formats times in `settings.profile.timezone`, not the browser's timezone.
- **Records vs views.** `WorkItemRecord` is the stored shape (seed and DB). `WorkItem` adds `refs` (initiative, account, opp and meeting chips). Other entities are the same in storage and in views.
- **"Promise" is not a kind.** It's a `commitment` with `isBackground: true` (with `ageDays`). The UI labels it "Promise".
- **Versioning.** Every mutable entity carries `version`, starting at 1: WorkItem, Initiative, NbaCard, Draft, ActivityEntry, WatchSubscription, BriefHighlight, each Settings section, and PriorityPolicy. Mutations send `ifVersion`. A mismatch returns **409 `conflict`**, and `error.details.current` holds the server's entity, so the client can rebase or show "keep yours / take theirs".
- **User-locked fields.** User edits add their fields to `userLockedFields` (work items, drafts, activity rows). An engine write to a locked field never lands. It becomes a `Proposal` (`changes[]` before → after, plus `textDiff` for draft bodies). Applying it uses `POST /proposals/:id/apply`; "Keep mine" uses `/reject`. When new info arrives for a touched draft, the NBA `update` strip has `kind: 'proposal'` and a `proposalId`. For an untouched draft it is `kind: 'revised'`.
- **Mutation results.** Every mutation returns `{entity, auditId, receipt?}`. `auditId` drives the Undo toast and ⌘Z. It's null only for non-undoable markers (seen and read). Multi-entity changes (chat, policy apply, claims, merges) also return a `Receipt`: `changes[]` before → after, each line with its own `auditId`.
- **Undo.** `POST /audit/:id/undo` undoes changes field by field. It restores the `before` values only if the row still matches `after` for those fields; otherwise it returns 409. The undo is itself an audit entry, and undoing it is redo. Engine actions (Closed for you, re-ranks, chat changes) can be undone the same way.
- **Errors.** Every non-2xx response is `{error: {code, message, retryable, details?}}`:

  | Code | Status | Meaning |
  |---|---|---|
  | `conflict` | 409 | Stale `ifVersion` |
  | `validation` | 400 | Invalid input or transition |
  | `not_found` | 404 | No such entity or route |
  | `upstream_unavailable` | 503 | Connector, tool or LLM is down, or the dev failure switch fired |
  | `budget_exceeded` | 429 | Hard spend cap reached |
  | `dry_run` | 423 | Reserved for the real backend |
  | `internal` | 500 | Also returned when a response fails contract validation |

  The client throws `ApiError` with the same fields.
- **Dispatch (the border).** The flow is `POST /drafts/:id/preview`, which returns the exact `payload`, the `rendition` and a `confirmToken` bound to version + mode, then `POST /drafts/:id/dispatch {ifVersion, mode, confirmToken}`. Global dry-run is on by default and makes dispatch render only. The mock never calls any external system, even with dry-run off; in that case it simulates a send and its read-back verification.
- **Live events.** `GET /api/v1/events` is SSE. It sends `event: hello` first, then one `event: live` per `{seq, topic, ids, reason, at, entityType?, scenarioStepId?, notify?}`. Topics equal the first element of TanStack query keys (`queryKey()` in `src/client/api.ts`). `src/client/live.ts` invalidates `[topic]` and exposes `subscribeLive()` for toasts and notifications. `notify.channel` hints which feedback channel to use (UI-SPEC §9).
- **Chat.** `POST /chat` returns an SSE stream of `ChatSseEvent`: one `start` header (`threadId`, `messageId`, `userMessageId`, `model`), then `text-delta`, `tool-start`, `tool-result`, `receipt`, `proposal`, `resource`, then `done` or `error`. Staged changes, such as a policy change, arrive as a `Proposal`; apply them with `POST /proposals/:id/apply`. The model is `ChatRequest.model ?? settings.chat.defaultModel`. `POST /chat/threads` opens a new thread. Every part of a turn is persisted on the assistant `ChatMessage` (see the changelog), so a reload restores it from the server alone.
- **Chat-made changes.** Audited with actor `chat` (never `user`) and undoable like any change. Chat never adds `userLockedFields`; only user edits lock. A chat write to a field the user already locked becomes a `Proposal`.
- **Ranking.** Ranks change only on explicit re-rank (`POST /today/rerank`) or policy apply, so nothing moves under the cursor. `nowStack.rerankReady` counts how many Top-10 positions a re-rank would change.
- **R-UI-22 resolutions.** A closed item records `resolution` and `resolutionDetail {personId?, personName?, relatedItemId?, note?, inferred, evidenceIds?}`, plus my `involvement`. `done` takes an optional `resolution` (default `done_by_me`). The `resolve` verb requires one, and `handed_off` also requires a person; it sets me to watcher (or `involvement`). When someone asks me directly about a handed-off item, `loopedBackIn` is set and the item reopens.

## Mock mode

`CC_DATA=mock` is the default. `db` throws "not implemented (BE-1)".

- **Seed.** The mock loads `CC_SEED_PATH`, then `~/Library/Application Support/command-center/fixtures/seed.json`, then the committed `src/mock/seed.example.json` (regenerate it with `npm run seed:example`). Every date is shifted by whole days so `meta.asOf` falls on today.
- **Clock.** The clock starts at the seed's time of day (`CC_MOCK_NOW=seed`). Set `CC_MOCK_NOW` to `real`, an ISO instant, or `HH:MM` to change that.
- **Scenario.** `GET/POST /api/v1/dev/scenario {action: play|pause|reset|seek, seconds?}` controls it, and `CC_SCENARIO=1` makes it autoplay. Without a seed scenario, the events are derived from the store. It runs the UI-SPEC §15 events plus a +160 s loop-back.
- **Failures.** Add `?fail=1` to any request, or call `POST /api/v1/dev/fail {rate}`, to get `upstream_unavailable`. `POST /api/v1/dev/engine-change` simulates an engine write, so you can test proposals.
- **Chat script.** `src/mock/chat-script.ts` exports `chatScripts` (first match wins). Scripts read and mutate only through `ctx.ops` (`ChatOps` in `src/server/datasource/mock/chat-runtime.ts`), so receipts carry real audit ids.

## Changelog

### CONTRACT-1 (2026-11-05): contract reconciliation

Every change below is additive and backward compatible for stored data: new fields are optional or defaulted, and both the committed example seed and the private fixture still validate. Code-level effects are listed under **Breaking for code**; nothing under `src/components/**` needed a change.

1. **Chat ops (FE-1d blocker 1).** Mock `ChatOps` gained `patchItem`, `resolveItem`, `capture`, `scan`, `policyPreview`, `policyApply` (changes) and `listItems`, `calendarToday`, `settings` (reads). Every chat mutation is audited with actor `chat` (actions `chat.edit`, `chat.resolve`, `chat.capture`, `chat.scan`, `chat.note`, `chat.move`, `policy.apply`), never adds `userLockedFields`, and turns writes to user-locked fields into proposals. `src/mock/chat-script.ts` uses only `ctx.ops`; the stopgap `extraOps` (direct access to the process DataSource) is gone.
2. **`POST /chat/threads` → `createChatThread` (blocker 2).** Body `CreateChatThreadRequest {title?, context[]}` (optional); response `ChatThread`. Not audited, like chat messages. `ChatThread.context?: ContextRef[]` (attached to every turn as `auto` chips). An untitled thread (`"New thread"`) takes its title from its first message.
3. **Model choice (blocker 3).** `ChatModel = 'sonnet' | 'opus'` (common.ts). `ChatRequest.model?`; new settings section `chat {version, defaultModel}` (defaults to `{version: 1, defaultModel: 'sonnet'}` when absent; `PATCH /settings/chat`, save model `instant`). New first SSE event `start {threadId, messageId, userMessageId, model}`. `ChatMessage.model?` records who answered.
4. **Persisted chat detail (blocker 4).** `ChatMessage.status?: 'complete' | 'error' | 'stopped'`. `ChatPart` additions:
   - `tool`: `args?` and `result?` (credential-redacted strings; `args` defaults to the start summary). `tool-start.args?` / `tool-result.result?` on the stream too;
   - `proposal`: `summary?` (the SSE line) and `status?: 'pending' | 'applied' | 'dismissed'` (rejected and superseded read as dismissed), resolved from the proposal on read;
   - new `error` part `{type: 'error', error: ApiErrorBody}`;
   - receipt lines: `ReceiptChange.undoneAt?` and `undoAuditId?` (envelope.ts), filled on read from the audit log. `undoAuditId` is the latest entry in the line's undo/redo chain: undo it to flip the line again.
5. **Scanner contract.** `src/scanner/types.ts` now holds BE-2a's extensions: `SkillRunInput.{window, mode, vars, instruction, preReportedCoverage}`, `SkillRunResult.{complete, counts}` (`SkillRunCounts`), `UnlinkedSourceItemDetail` (hints, excerpt, title, threadRef, connector, occurredAt) as the `unlinkedSourceItems` row, the `ReevaluateEnqueuer` reason `{catchingUp?, trigger?}`, plus `Resolution`, `Involvement`, `ResolutionFields` (on `OpenItemDigest` and `Candidate`, with `Candidate.state?`), `BriefHighlightsInput`, `isContextOnly`, `LOOP_BACK_PREFIX`. `runtime/contract-ext.ts` only re-exports them (its `*Ext` names are aliases now).
6. **ToolAdapter is a view of the TOOLS manifest.** `ToolView {id, name, description, icon, launchKind, fields, health, estimatedDuration, requiresConfirm}`; `ToolFormField` = the TOOLS `input.fields[]` schema; `ToolAdapter = ToolView + {enabled, recentRunIds, manifest}`. `manifest` is the **deprecated** pre-CONTRACT-1 shape, kept required so existing readers (the Tools launcher) work unchanged: seeded rows carry their own, and `toToolAdapter(toolsManifest, {health, enabled, recentRunIds})` synthesizes it with `legacyManifestFromTools()`. Seed files keep the legacy row shape (`ToolAdapterSeedRow` maps it, deriving form fields from the JSON schema and `requiresConfirm` from `safety.requiresApproval`; the legacy manifest also accepts optional `icon` and `estimatedDuration`). Build new UI on the view fields.
7. **Rendition names.** `RenditionFormat` is now `slack_mrkdwn | slack_blocks | email_html | plain_text` (the DB names). The compose lib's profile `plain` is `plain_text`; use `toRenditionFormat()` / `fromRenditionFormat()` from `src/lib/compose/profiles.ts` (DB `email_text` → `plain`; `canvas_markdown` → null).
8. **NBA verb `review_deliverable`.** DB migration `0004_nba_type_review_deliverable` runs `ALTER TYPE nba_type ADD VALUE IF NOT EXISTS 'review_deliverable'`; `src/db/schema/enums.ts` matches. **Not yet in the contract `NbaVerb`**: `src/components/domain/vocab.ts` has exhaustive `Record<NbaVerb, string>` maps (`VERB_LABEL`, `VERB_CHIP`), so the enum value and the two map keys must land together (blocker). Until then the wire layer maps the engine's `review_deliverable` to the contract verb `review`.
9. **One serializer.** The mock's draft preview, dispatch payload, confirm token and stored renditions all come from `src/lib/compose` (`serialize` / `payloadFor` / `renderPreview`); `src/server/datasource/mock/render.ts` is a thin adapter. Payloads are the transport fields (`api`, `channel`, `thread_ts`, `to`, `subject`, …) plus the compose payload unchanged (Slack `text` + `blocks?`; email `html` + `text`). Preview and dispatch payloads are byte-identical. Contract additions: `DraftPreview.html?` (the compose `renderPreview` of that payload, allowlist-sanitized; still DOMPurify it) and `Draft.rendered.slack_blocks?` / `plain_text?` (Slack drafts always keep `slack_mrkdwn`). Renditions now use the compose formats, so a Slack draft with lists or code previews and sends as `slack_blocks`.
10. **`GET /people?q` → `getPeople`.** Query `PeopleQuery {q='', limit=20 (1–100), account?, slack?}`; response `PeoplePayload {q, people: PersonView[], total}` with `PersonView {id, name, email, slackId, role, title, account: EntityRef | null, isExternal, isManager}`. `isExternal` is the stored flag, else an email domain other than mine. Live topic `search`.
11. **LIB-compose fix.** `parseSlackMrkdwn` no longer turns "- " lines into a bullet list (Slack shows the hyphen literally), so the preview shows what Slack shows. `•`/`◦`/`▪`/`‣` and `1.` lines still parse as lists, and a real `bulletList` still serializes to "•" lines (mrkdwn) or a `rich_text_list` (blocks). Golden test: `tests/contract/compose-golden.test.ts`.
12. **Capacity v2 (CAPACITY lane).** `TodayHeader.capacity` gained `youMinToday`, `freeMin`, `openMin`, `fits`, `agentMinBackground`, `agentRunsBackground` and `pullForward[] {itemId, title, youMin, due}` (at most 5). Only today-scoped, hands-on minutes count, as described in ENGINES.md §2. The legacy fields keep their names with new meanings: `focusMinLeft = freeMin`, `plannedMin = youMinToday`, `overByMin = youMinToday − freeMin`. UI copy says "overbooked" only when `fits` is false.
13. **Sending channels (BE-OUTBOX).** `SendingSettings.channels?: {slack, gmail} → {mode: 'draft' | 'send'}`, both defaulting to `draft`. Older rows without it still load, and a PATCH that names one channel keeps the other. A dispatch preview with no mode uses the channel's mode; the mode the user confirms is always the one that runs. Dry-run stays the default.
    - A failed dispatch throws `upstream_unavailable` with `retryable: false` and `details.retry: 'reconfirm'`. Retrying means a fresh preview and confirm, so re-posting the old token gets a 409.
    - The live transport is fail-closed in this build, so nothing reaches Slack or Gmail until the user approves a live check.

14. **Read-ins (BE-READIN, R-UI-23).** New `src/contract/readin.ts`.
    - Routes: `GET /readin/:type/:id` → `getReadIn` and `POST /readin/:type/:id` → `requestReadIn` (on demand). The live topic is `readin`.
    - Types: `ReadInState = queued | researching | ready | stale | failed` and `ReadInEntityType = work_item | calendar_event`.
    - `WorkItemRecord.readInState?` is filled on list and detail payloads.
    - New setting `budgets.readinUsdPerDay`, default 2. Automatic runs stop at it; on-demand runs may pass it but never the hard cap.
    - The suggested reply is an ordinary `drafts` row (status `ready`, created by the engine) and is never dispatched by the read-in.
    - Storage is `user_settings` keys `readin/<type>/<id>`, with no migration. The retention scrub deletes them after 90 days without a refresh.
15. **Chat changes (BE-CHAT).** `ChatChange` is a zod union on `op`: `pin`, `rerank`, `snooze {until}`, `done`, `reopen`, `resolve {resolution, personName?}`, `link_evidence`, `create_item {…, snoozeUntil?}`, `edit_fields {patch}`, `policy_weights {deltas}`, `policy_rule`.
    - The proposal part gains `changes?: ChatChange[]`.
    - Chat proposals apply through the existing `POST /proposals/:id/apply` (and `/reject`). Every change runs in one change set with actor `chat`, which returns `receipt` and `auditId`.
    - Chat proposals are stored apart from item proposals, so they never show on item cards.
16. **Chat cards (BE-CHAT).** The `resource` part and SSE event gain `card?`: `{kind: 'draft', draft: ChatDraftRef}` or `{kind: 'session', session: ChatSession}`.
    - The `claude://` link lives only in `card.session.url` and `AgentRun.deepLink`.
    - New shared types: `ChatScan`, `ChatDraftRef`, `ChatSession`, `ChatUsage`.
17. **Chat message fields (BE-CHAT).** `ChatMessage.usage?` (model, tokens, cost, turns) and `ChatMessage.summary?` (the morning brief's one-line summary, filled on read).
18. **Tool progress (BE-CHAT).** The tool part gains `progress?: {done, total}`, plus a new SSE event `tool-progress {id, done, total}`. A chat-started scan is a `<source>.scan` tool row that is refreshed from the job and scan-run tables on reload.
19. **`queueDraft` (BE-CHAT).** `POST /drafts/:id/queue` takes `{ifVersion}` and returns `MutationResultOf(Draft)`. It moves `drafting` → `ready`, audited and undoable.
    - It is idempotent on `ready`, returning `auditId: null`. Any other status gets a 409 with `details.current`.
    - Chat drafts start as `drafting`, and "Add to Outbox" queues them.
**Breaking for code (not data):**
- `ChatSseEvent` has a new member (`start`). Exhaustive switches must handle it; `src/client/chat/turn.ts` does.
- `ToolAdapter` gained required view fields. Code that builds rows by hand (the DB DataSource) should use `toToolAdapter()`. `manifest` is still there but deprecated.
- `RenditionFormat`, `SettingsSectionKey`, `Draft.rendered` and the `ChatPart` union gained values or keys. Exhaustive `Record<…>` maps over them need the new keys. None exist in `src/components/**` today.
- The mock's draft payloads changed shape for Slack lists (`blocks`) and email HTML (the compose serializer's inline-styled HTML).
- The `DataSource` interface has two new methods (`createChatThread`, `getPeople`), and custom `ChatOps` implementations must add the new ops. `ChatScriptContext.model` is optional.

### B-081 History (2026-11-06)

Additive: two read routes, no stored data changes, no migration.

- `GET /history?month=YYYY-MM` → `getHistoryMonth` → `HistoryMonth`: one `HistoryDaySummary` per day of the Monday–Sunday grid around the month (finished, your hours, meetings held, sent, dry runs, agent runs, Org62 logged, arrived, `active`), month totals, `prevMonth` / `nextMonth` (null in the future). Default: this month in `settings.profile.timezone`.
- `GET /history/:day` → `getHistoryDay` → `HistoryDay`: what was done on one local day: `finished` (closes not undone, with who closed them; a close the item was later reopened from is `reopenedSince`), `time` (human hours from the activity log by account and CF/CR; focus / Drive / Slack blocks not in the log are signals, never counted; `agentMin` is the background lane), `meetings`, `sent` (dispatch attempts; `dry_run` says so), `runs`, `org62`, `arrived`.
- Live topic `time` (activity edits refresh it); the History page also refetches on item, draft, Outbox, agent and calendar events.
- Sources: both DataSources share `src/server/history/compose.ts`. db reads closes from `work_item_transitions` (to `done`, `undone_at` null) and Org62 stamps from `activity_entries.synced_to_canvas_at / logged_at / verified_at`; the mock from its records and audit trail. Parity: `tests/db/datasource/history.test.ts`.

### B-079 (2026-11-06): first-launch onboarding

Additive. New `src/contract/onboarding.ts`; new live topic `onboarding`; the `DataSource` gains four methods.

| Route | Method | What |
|---|---|---|
| `GET /onboarding` → `getOnboarding` | `OnboardingState` | `required` (db: no active user, or one the bootstrap never finished; never in mock), `status`, `reason` (`no_user` · `incomplete_user` · `onboarded` · `cli` · `mock`), the resumable `step` / `reached` / `draft`, `issues` per step, both role packs' starter policy, cost estimates |
| `POST /onboarding/step` → `saveOnboardingStep` | `OnboardingState` | Body `{step, value, goTo?, restart?}` (a union on `step`). Merges the step into the draft and moves to `goTo`. Back always works; forward needs every earlier step to pass, else 400 `validation` with `details {step, issues}`. Refused (400) once set up. `restart` is mock-only |
| `GET /onboarding/sources?refresh` → `getOnboardingSources` | `OnboardingSourcesPayload` | Read-only: the re-auth handlers' `status()` + `describe()` (never `act()`), one probe at a time, kept 2 min. Mock: the seed's connectors (`simulated: true`). `CC_SOURCES_PROBE=off` runs nothing |
| `POST /onboarding/complete` → `completeOnboarding` | `OnboardingCompleteResult` | db: `bootstrapUser()` (what `npm run setup` runs), then the Settings writers (profile; the edited policy as v2 "Set during onboarding"), then `startFirstScan()` and the `user_settings` row `onboarding {status: complete, completedAt, by: web, firstScan}`. Idempotent once done. Mock: patches the mock's profile and policy |

- **Draft storage.** db: `<CC_STATE_DIR>/onboarding.json` (0600, tagged with the database), deleted on completion. Mock: memory.
- **Who is onboarded.** A user with `user_settings.onboarding` complete, or a fully bootstrapped user without it (CLI). The gate (`src/components/onboarding/OnboardingGate.tsx`, in the root layout) sends every page to `/onboarding` while `required`.
- **First scan.** The worker applies the chosen lookback and budget (B-080, `src/worker/first-scan-config.ts`); the first-scan banner and `catching_up` connectors show its progress.
- **Steps (personas, 2026-11-11).** Six: `role` (persona and level, D-55) · `you` (name, email, hours, time zone, Slack and Org62 ids) · `priorities` (the persona level's starter policy, editable) · `sources` (the persona's active sources plus the "Available" group, read-only status with each re-auth command) · `history` · `review`. `npm run setup` does infra only and opens `/onboarding`; `npm run setup -- --headless` still takes the profile in the terminal and bootstraps the user, so the browser onboarding never shows.

### Onsite lane (2026-11-09): onsite days and travel

Additive. Stored data: migration `0009_onsite_location` adds `calendar_events.location` and the `time_block_source` value `onsite`; `PROJECTIONS_VERSION` 2 re-projects every event once (all-day events move to local midnight).

| Route | Method | What |
|---|---|---|
| `POST /time/onsite/days/:day` → `correctOnsiteDay` | `MutationResultOf(OnsiteDay \| null)` | Body `OnsiteCorrection {action: confirm · not_onsite · change_account · adjust_hours · clear, accountId?, oppId?, start?, end?}`. A locked override (`user_settings` `cc.onsite.overrides`, audited, undoable); the week recomputes right away. Change account moves the whole trip; Clear drops the day's correction and a marked trip over it |
| `POST /time/onsite/trips` → `markTrip` | `MutationResultOf(OnsiteDay[])` | Body `MarkTripRequest {from, to, accountId, oppId?, city?, timezone?}` (≤ 30 days): these days were onsite at one account |

- `TimeWeek.onsite: OnsiteDay[]` (default `[]`) and `HistoryDay.onsite: OnsiteDay | null` (default null). `OnsiteDay {day, status: detected · confirmed · not_onsite, accountId, accountName, whatOrg62Id, whatName, city, timezone, frame {start, end} | null, hoursLabel, signals[] {kind, label, used}, trip {from, to} | null, locked}`. A detected day with no account and no frame is a question ("Trip · CITY: onsite?"), never hours.
- Settings section `time` (`TimeSettings {version, detectOnsite, onsiteHours {start, end}, airportBufferMin, dinnersCustomerFacing}`; defaults On, 08:00–17:00 in the trip's zone, 60, On; save model `explicit_save`). `SectionParams.section` is now `SettingsSectionKey` (one list). A save recomputes the recent weeks.
- Time lanes: travel and onsite frame blocks are in the `meetings` lane (they were in `focus`); their overlay pieces are not shown.
- Engine and rules: `docs/ARCHITECTURE.md` is unchanged; the rules live in `src/engines/activity/onsite.ts` (header comment) and `event-kinds.ts`. Mock mode: no detection, corrections kept in memory (no audit).

### Time ▸ Log (2026-11-10): the whole activity log

Additive. No migration: the new fields read columns `activity_entries` already has.

| Route | Method | What |
|---|---|---|
| `GET /time/log` → `getActivityLog` | `ActivityLog` | Query `ActivityLogQuery {from?, to? (local days, inclusive), status? (comma list of ActivityLogStatus), q?, account? (name), opp? (id)}`. Every activity row in range, history included, newest day first (a day's rows in clock order). Topic `time`; the rows are under `entries`, so Details and optimistic row patches find them as they find TimeWeek's |

- `ActivityLog {from, to, entries, total, counts, weeks[], months[], quarters[], facets {accounts[], opps[]}}`. `total` / `weeks` / `months` are `{rows, hours, loggedH}` of the filtered rows (`hours` = live rows, never excluded or upcoming; `loggedH` = logged + verified). `counts` per status bucket ignores the status filter (the chips keep their counts); `facets` ignore the account / opp filters. `quarters` (newest first) are every fiscal quarter with rows plus the current one, whatever the filters: `{label, start, end, loggedH, verifiedH, targetH, due (current only), current, rows}`, with the same rule as `TimeWeek.quarter` (logged / verified rows whose day is in the quarter; the seeded base hours on the current quarter only). FY starts 1 Feb: Q3 FY27 = Aug–Oct 2026.
- `ActivityLogStatus`: `upcoming · needs_input · proposed · approved · handed_off (synced_to_canvas, verify_failed) · logged · verified · excluded (dismissed)`; `activityLogStatus(status)` maps a row.
- `ActivityEntry` gains `fromOrg62` (read from an Org62 Event: db dedupe key `org62|…`; logged by definition, never pending read-back), `excludedReason` (dismissed rows only: the engine's `neither_type · overlap · ooo · placeholder · cap_trimmed · duplicate`, `dropped`, or `dismissed` = you; db `excluded` / `dropped` / `dismissed`), `loggedAt`, `verifiedAt` (the db columns; seed and mock rows: their updatedAt when no stamp is kept). All default (false / null).
- Fixes that change values: `TimeWeek.org62.pending` no longer counts Org62-native rows; the mock's `TimeWeek.quarter.loggedH` counts the current quarter only (as the db did).
- `chat_read` gains page `time_log`.

### Meeting details (2026-11-11): the hover card and the meeting panel

Additive. No migration: the db reads columns and source items it already has.

| Route | Method | What |
|---|---|---|
| `GET /calendar/events/:id` → `getCalendarEvent` | `CalendarEventDetail` | One meeting: `event` (a `CalendarEvent`), `prep` (the live and done work items that serve it: the invite's prep item, then live, then done; `{id, title, state, youMin}`), `account {id, name}`, `opp {id, name, stage}`, `readIn {state, tldr, generatedAt}` (null: none requested). 404 `not_found` for an unknown or hidden event. Topic `calendar` |

- `CalendarEvent` gains `agenda` (the invite's description as plain text, redacted as ingest redacted it, ≤ 2,000 characters; never HTML: render it as text, links may be made clickable; null when there is none or the source body was purged), `organizer` (`EventOrganizer {name, personId, isMe, isExternal}`, null when unknown) and `attachments` (`EventAttachment {title, url, kind: deck · doc · sheet · pdf · other}`). Defaults: null, null, `[]`.
- `CalendarEvent.attendees` items are `EventAttendee` = `PersonRef` plus `response?` (`InviteResponse`: `accepted · declined · tentative · needs_action · none`; absent = not known), `optional?`, `organizer?`. Code reading them as `PersonRef` keeps working.
- `meetingUrl` is the conference link: the invite's conference data; for a scanned invite with none, the db fills it from the first Zoom / Meet / Teams / Webex link in the location or the agenda.
- Sources (db): the agenda from the event's source item body (the one-line excerpt before the description is skipped; HTML turned into text by `agendaText`, `src/server/calendar/detail.ts`), attachments and the organizer's address from its meta, each guest's answer from `calendar_event_attendees` (`response_status`, `is_optional`, `is_organizer`), "my meeting" from `i_am_organizer`. Seeded rows keep these in ext; the agenda of a scanned row is never copied into ext (it stays in the body, 90-day retention). Scanned rows list guests organizer first, then by address. Mock: the seed. Parity: `tests/db/datasource/parity-reads.test.ts`.
- `HomeRibbonBlock.itemId` on a meeting is its prep item; a click on a meeting opens the meeting (the panel links the prep), never the item.

### Time ▸ opportunity picker (2026-11-11): ranked opps, Org62 search, add from Org62

Additive. No migration. Shared ranking: `src/lib/opp-options.ts` (both DataSources and the picker's filter).

| Route | Method | What |
|---|---|---|
| `GET /time/opps` → `getOppOptions` | `OppOptions` | Query `OppOptionsQuery {entryId?}`. Every opp a row can log to, ranked for that row: on its account (`why: account`), the opp its evidence is on (`evidence`: the meeting's opp, its Claude session's task's opp), on an account its evidence names (`related`: the meeting's, its attendees', its Drive file's), logged to in the last 30 days (`recent`, `lastUsed`), then the rest; reasons add up. Within a tier: open, used most recently, mine, nearest close date, A–Z. Closed over a year ago and untied: left out. Topic `time`. Replaces the picker's `getDeals` + one `getAccount` per account |
| `POST /time/opps/org62-search` → `searchOrg62Opps` | `Org62OppSearch` | Body `{q}` (2–80 chars). db: ONE read-only `soqlQuery` through `runOneReadLookup` (the scan allowlist, the Assistant's `chat_org62_lookup` path): open opps with every word (≤ 4) in their or their account's name, newest close date first, matched to the app (`oppId`, `accountId`). Live behind the Assistant's gate (`CC_CHAT_LLM=1`, connectors on) and its day budget; the spend is an `llm_calls` row (purpose chat, skill `read-lookup`, request `time:opp-picker:…`) with the day rollups and Health spend. Otherwise `simulated: true` with a note. Mock: placeholder records (`src/mock/org62-opps.ts`) plus the app's own matches |
| `POST /activity/:id/org62-opp` → `pickOrg62Opp` | `MutationResultOf(ActivityEntry)` | Body `{ifVersion?, org62Id (006…)}`. An opp the app shows is set like a PATCH. Otherwise db re-reads the record by Id from Org62 (read only, never the client's copy) and upserts it the way the Org62 projection does (`upsertOpportunityFromOrg62`, row id `proj:opportunity:<user>:<id>`, `on_my_team` false until a scan says so), with its account when the app lacks it (`upsertAccountFromOrg62`; an account the app has is never re-upserted); then the row's opp, WhatId and `oppId` lock. One undoable change set (Undo removes the added opp and account). A logged / verified row → 400; live lookups off → 503 |

- `OppOption {id, name, accountId, accountName, stage, closeDate, isOpen, isMine, why[], lastUsed}`; `Org62OppHit {org62Id, name, accountName, accountOrg62Id, stage, closeDate, amount, owner, isOpen, oppId, accountId}`.
- Fix (db): a row's WhatId follows its opp. `updateActivity` (PATCH `/activity/:id`, the Assistant's `edit_activities`, the pick) writes `what_kind = 'opportunity'`, `what_org62_id` (the opp's own Org62 id; a placeholder `cc:` key is never a WhatId), `what_name` and the opp's account when the opp changes; clearing the opp clears them. Before, `opportunity_id` changed and the logging batch still wrote the engine's old WhatId (or skipped the row as needing one). The projection never rewrites the row (it carries the `oppId` lock).
- Mock: logging batches write an added opp's own Org62 id (else the placeholder `mockOrg62IdFor`).

### Outbox ▸ the source message (2026-11-11)

Additive, read-only. No migration: the db side reads `source_items` (body, `body_format`, `external_parent_id`, `from_me`, `body_purged_at`, meta author / participants) and `work_item_evidence`.

| Route | Method | What |
|---|---|---|
| `GET /drafts/:id/source` → `getDraftSource` | `DraftSource` | The message a draft answers and up to 5 earlier thread messages. Topic `draft` |

- `DraftSource {draftId, kind: slack · gmail · null (a structured action), relation: reply · source, where, url, message: SourceMessage | null, earlier: SourceMessage[] (≤ 5, oldest first), earlierTotal}`. `reply`: a Slack thread or DM reply, an email reply / reply all / forward; `message` is the latest one from someone else in the destination's thread (else the latest). `source`: a channel post or a new email; `message` is the work item's origin message (never a completion), with its own thread. `url` is the message's permalink, else the thread's newest one, else the item's own source of that kind (same channel), else the archive link from `CC_SLACK_HOST`.
- `SourceMessage {id, author, isMe, at, html, text, body: full · purged · none, url, subject, from, to}` (`subject` / `from` / `to` for email only). `html` is rendered from the stored format by `renderSourceBody` (src/lib/compose/source.ts): Slack bodies are mrkdwn (stored as `plain`): bold, italics, strike, links, mentions by name (`<@U…>` → the directory's or the rows' name, else "@someone"), channels, code, lists, quotes, emoji shortcodes as text; email `html` allowlist-sanitized, `plain` / `markdown` as escaped text with links. DOMPurify it before injecting. Bodies are redacted again (`connectors/redact`). After the 90-day purge, `body: purged` and `text` is the evidence line; the link stays.
- What each side reads: both, the draft's `threadContext` and its work item's evidence (shared builder `src/server/datasource/draft-source.ts`); db also the thread's source items (`slack:<channel>:<threadTs>` / `gmail-thread:<id>`, a Gmail `threadId` naming a message brings its thread, a DM without a thread its latest messages) and the evidence rows' own thread, format, `from_me` and purge state. On the plain seed both answer the same (parity-reads).
- `OutboxItem.source: SourceRef | null` (default null): the row's "Open in Slack" / "Open in Gmail" (`label` = where), from the thread context and evidence (no extra query per row).

### Home ▸ planning the next working day (2026-11-11)

Additive. No migration.

| Route | Change |
|---|---|
| `GET /home` → `getHome` | Query `day` (`today` default · `next`). `next`: Home as the next working day starts (Friday → Monday; `profile.workingHours.days`, empty = every day). "Now" for every rule is that day's working-hours start: its meetings on the ribbon (no now state), its capacity (the CAPACITY engine run at that start, both DataSources), what is due or starts then, plus today's open work carried over (`HomeCard.carried = 'from_today'`) and snoozes that wake by its end (`'moved'`). No Outbox card (Reply & approve keeps "Approve N"), no since-you-left, no Closed for you; the masthead names the day ("Tomorrow turns on the 09:00 …", "Monday …") and `capacity.dayLabel` is "tomorrow" / the weekday |

- `HomePayload` gains `day` (`HomeDay`, default `today`), `nextDay` (`HomeNextDay {date, label: "Tomorrow" | weekday, short: "Fri 11/6", startsAt, nudge}`; `nudge` from an hour before today's working hours end, after them, and on days off; null default) and `moveTo` (`HomeDayRef`: where Home's "Move to …" snooze wakes, the working-day start after the day shown; null default). `HomePayload.now` stays the real clock; the shown day is `masthead.date`.
- `HomeCard.carried`: `from_today · moved · null` (default null).
- UI: `/?day=next`; the Today / next-day toggle on the masthead's date line; "Your day is wrapping up · Plan tomorrow →" when `nextDay.nudge`; Home never switches by itself. `chat_read home {day: next}`.

### Handoff (D-57, 2026-11-11): version, guide, README

Additive. No migration. All three routes are reads (`assistant: 'read'`).

| Route | Method | What |
|---|---|---|
| `GET /version` → `getVersion` | `VersionPayload` | `{version, sha, builtAt, migration, bundledMigration, persona {id, level, label}, workerVersion, mismatch, migrationPending, dataSource}`. The build's values come from `next.config.ts` `env` (`CC_APP_VERSION`, `CC_GIT_SHA`, `CC_BUILT_AT`, mirrored as `NEXT_PUBLIC_CC_VERSION` / `NEXT_PUBLIC_CC_GIT_SHA`); `migration` maps the newest `drizzle.__drizzle_migrations.created_at` to its journal tag; `workerVersion` is the newest `worker_instances.app_version` that beat in the last 5 min; `mismatch` compares the core versions (`v` prefix and `+build` ignored). Mock: no migration, no worker. Topic `health` |
| `GET /guide` → `getGuide` | `GuidePayload` | The Getting started checklist `{items: ChecklistItem[], done, total, dismissed, signals}`, computed from real state in `src/guide/checklist.ts` (both DataSources): active sources live, persona section saved or "Looks right" (`guide.seen['checklist.persona']`), first scan done, a message draft approved or sent (a dry-run attempt counts), a logging or forecast canvas staged, a user message to the Assistant, a `feedback.post` report sent. Persona-aware: the batch step is forecast notes for an AE and is left out without `activityLogging` / `specialistForecast`. Besides these action items, one explore item per page with a tour for the persona (`tour.<page>`, `kind: 'explore'`), done once its tour is (finished, skipped, or every step seen; `signals.toured`). One ordered list (`CHECKLIST_ORDER`); each item carries `page` (where its guidance plays; null: where you are) and `cta` (its button). Topic `settings` |
| `GET /guide/readme` → `getReadme` | `ReadmePayload` | `{markdown, path}`: `README.md` from the app's folder (⌘K ▸ Read the README). 404 when missing |

- Settings: `guide {checklistDismissed, seen: {markId: iso}}` (instant). Coach-mark (tour step) ids live in `src/guide/pages.ts`; a step is recorded on Next / Done, the page's whole set on Skip tour / Esc, and `tour.<page>` when a tour runs to its end (Done). Getting started's buttons ask for guidance with a client event (`src/guide/request.ts`, kept briefly in sessionStorage across a forced reload): a page's whole tour, or an item's tip (`src/guide/items.ts`, anchored on `data-guide` ids), played after the navigation or at once on the same page.
- Settings: `time.logging.workOrderCanvasUrl: string | null` (default null, `https://…`): the Slackbot work-order canvas Time links to, per person (it was hard-coded).

### Time ▸ the Org62 Description note (D-66, 2026-11-12)

Additive, defaulted; both seeds validate.

1. **`ActivityEntry.logNote: string | null`** (default null): the teammate's note the row's Org62 Event Description carries, before its `CC#<id>` key. Drafted by the app (the projection; mock: the seed) until you edit it. **`ActivityEntry.logNoteBasis: 'template' | 'summary' | null`**: how the app drafted it (the row's evidence, or the cheap model over the meeting notes); null once the note is yours.
2. **`ActivityLockableField` gains `logNote`**; **`ActivityPatch.logNote?: string`** (max 1000). `PATCH /activity/:id` with it locks the note (db: the `log_note` pseudo column, the row's side-car), clears `logNoteBasis`; an empty string logs the key alone.
3. **The work order's Description cell** is `<note> · CC#<id>` (the exact key last). Parsing and matching it back (`ParsedEventRow.ref`) is unchanged here (D-65, the round-trip lane, owns it).
