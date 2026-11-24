# 05: ASSISTANT lane (owner asks #4 and #5)

Reviewer: ASSISTANT. Read-only. Evidence is `path:line` against the working tree at `3533cb6`. Cost figures from `sample-data/` are a **synthetic** copy of the real DB and are labelled as such. Unit tests: `tests/bechat` + `tests/guardrails` 162 passed, 18 skipped; `chat-db.test.ts` fails only because Postgres isn't running on this machine.

## 1. Summary

1. **Its "limits" are mostly budget plumbing.** The default per-message cap is $0.25 on Sonnet (`src/contract/settings.ts:338`). The synthetic sample's average chat message costs $0.23, and 5 of its 14 messages exceed the cap (`sample-data/tables/llm_calls.json`). The worst case is research: D-51 promises $0.50 a run, but the run has to fit inside what's left of the $0.25 message cap (`src/llm/chat/tools.ts:305`). So a research run almost always stops and asks for "Allow more". The Allow more button then re-sends the message from scratch (`src/client/chat/useChatStream.ts:382-390`), so every escalation pays for the same work twice.
2. **Each message is a fresh, stateless `query()`** (`persistSession: false`, `src/llm/chat/runner.ts:331`). The thread is re-sent as text inside the user prompt (`src/llm/chat/prompt.ts:148`). That has three costs:
   - the model forgets the tool results it read in earlier messages;
   - the whole history is re-written to the cache every message (the 2026-11-13 audit found cache writes are 69% of chat cost);
   - a turn can't pause and resume.
3. **The prefix is heavy, the model is expensive, and there's no Haiku.** The model sees 18 tools of about 39k characters (~11k tokens) plus a 24 KB skill (~6k tokens). Two of those tools are route catalogs of about 9k characters each (measured, see §2.3). `ChatModel` is `sonnet | opus` (`src/contract/common.ts:126`). Haiku 5.5 costs 1/20 of Sonnet (`src/llm/models.ts:23-24`). The same token profile would cost about $0.012 a message on Haiku instead of $0.23.
4. **Silent cuts remain despite D-58's "never cut".** Every string in a read is clipped at 2,000 characters, which covers evidence bodies and item notes (`src/server/chat/read.ts:133`, `compact.ts:122`). Calendar search fetches at most 250 events and then filters them (`src/llm/research/tools.ts:142`). Search results are cut at 4,000 characters, and a research run's Gmail thread at 8,000, with no paging (`src/llm/readin/tools.ts:80`). These are the "GDrive / N-character" limits the owner hits.
5. **The fix is a budget contract plus a session model, not more tools.** Each turn should:
   - estimate up front, only when the turn isn't trivial;
   - raise a hand mid-run through the SDK's `canUseTool` / `PreToolUse` hook, which can wait on the user without killing the query;
   - resume through SDK sessions;
   - route between Haiku, Sonnet and Opus;
   - use a ~10-tool surface that includes a read-only `query` over DB views.

   §5 specifies the interface I need from LLM-COST.

## 2. How it works today

### 2.1 The turn loop (`src/llm/chat/runner.ts`)

- **Budget gate before the call.** It reads `host.budget(model)` and computes `capUsd = min(perMessageUsd + allowExtra, dayLeft)` (`runner.ts:160-174`). Chat has its own daily line ($3 by default) and doesn't count against the global hard cap (D-43). `allowExtraUsd` is clamped to $5 (`runner.ts:165`, `src/contract/requests.ts:326`).
- **Prompt.** `systemPrompt = [skill body, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, now + Looking at + context pack JSON + Persona + Live reads]`. `prompt = "## Thread so far" + "## Message"` (`src/llm/chat/prompt.ts:139-151`). History limits: user messages up to 120k characters, assistant messages 8k, 320k characters in total, 400 messages (`prompt.ts:81-91`). Card lines ride along (`prompt.ts:38-71`).
- **One `query()` per message** (`runner.ts:318-345`) with these options:
  - model and effort: `effort: 'low'`;
  - tools: `tools: []` (no built-in tools); the in-process `chat` MCP server; and, in db mode, the scanners' restricted Slack and Org62 servers (`runner.ts:191-195`, `scannerReads` `:89-104`);
  - permissions: `strictMcpConfig`, `allowedTools`, `permissionMode: 'dontAsk'`, `canUseTool`, and a `PreToolUse` hook. Both enforce the exact allowlist and run the SOQL guard (`runner.ts:272-306`). A tool off the allowlist aborts the turn;
  - limits: `maxTurns` (default 30, clamped to 80 at `src/server/chat/outputs.ts:212`) and `maxBudgetUsd = capUsd`;
  - sessions and streaming: `settingSources: ['user']`, `skills: []`, `persistSession: false`, `includePartialMessages: true`.
- **Running cost check.** Each assistant message's `usage` is priced by `estimateCallCostUsd`. If the price plus sub-run spend crosses `capUsd`, `fail()` aborts the query and returns `budget_exceeded` with `details.allowMore` (`runner.ts:226-234`, `:420-423`). Sub-runs (research, Org62 lookup, Find assets) spend inside the same cap through `ctx.spend` and `needMore` (`runner.ts:236-253`).
- **Watchdog.** 180 s by default, which a long tool can extend up to a 420 s hard deadline (`runner.ts:213-221`, `:395-397`).
- **Usage.** Recorded through `host.recordUsage` however the turn ends (`runner.ts:470-492`). It goes into `ChatMessage.usage` (`src/server/chat/turn.ts:166`), but **no SSE event carries cost** (`src/contract/chat.ts:296-311`), and no chat component renders it.

### 2.2 SDK features: used or not (installed `@anthropic-ai/claude-agent-sdk` 0.3.316, `sdk.d.ts`)

| Feature | SDK | App |
|---|---|---|
| Per-query model / `setModel()` mid-query | `Options.model`, `Query.setModel` (`sdk.d.ts:2028`, `:2988`) | model per query only; no `setModel` |
| `fallbackModel` | `:1745` | unused |
| `canUseTool` / `PreToolUse` / `PermissionRequest` / `PostToolUse` / `Stop` / `PreCompact` hooks | `HOOK_EVENTS` `:991` | `canUseTool` + `PreToolUse` (allowlist, SOQL); others unused |
| `maxTurns`, `maxBudgetUsd` (hard stop, `error_max_budget_usd`) | `:1988-1993` | both used; budget = message cap |
| `taskBudget` (alpha, model paces itself) | `:2001` | unused |
| Streaming partial messages | `includePartialMessages` `:1923` | used (text deltas only) |
| Streaming input (`prompt: AsyncIterable<SDKUserMessage>`) | `:3346` | unused (string prompt) |
| Sessions: `resume`, `continue`, `forkSession`, `sessionId`, `resumeSessionAt` | `:1654`, `:1770`, `:2148-2162` | unused; `persistSession: false` |
| Subagents `agents` (model, tools, maxTurns per agent) | `AgentDefinition` `:385` | unused; research is a nested `query()` inside a tool |
| MCP passing (sdk in-process + stdio) | `mcpServers` | used (chat server + scanner servers) |
| `settingSources` | `:2339` | `['user']` (for the gateway's apiKeyHelper) |
| Skills (progressive disclosure) | `skills` `:2362` | `skills: []` |
| Structured output `outputFormat` | `:2036` | unused in chat (research validates via its `research_finish` tool) |
| Compaction (`autoCompactWindow`, `compact_boundary`, `PreCompact`) | `:79`, `:3859` | unused; the app trims history itself |
| `interrupt()` | `Query.interrupt` `:2952` | unused (abort only) |
| Result cost / usage: `total_cost_usd`, `modelUsage`, `num_turns`, `permission_denials` | result message | all read (`runner.ts:425-466`) |
| Dynamic prompt boundary | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | used |

### 2.3 What the model sees (measured with `chatToolsFor(undefined)`, `src/llm/chat/server.ts:29`)

18 chat tools, 39,050 characters (≈11k tokens), plus 5 live tools (`skills/chat-assistant.md:9`):

- `chat_app_read`: description 9,107 characters (catalogs of 40 pages and the remaining read routes);
- `chat_app_change`: 8,785 characters (the stage-route catalog);
- `chat_propose_changes`: its schema alone is 6,615 characters (the `ChatEditChange` union);
- the other 15 tools: 160-750 characters each.

The skill (`skills/chat-assistant.md`) is 24,476 characters (≈6k tokens) of domain recipes covering DC claims, VDP, logging, lists and research. The context pack (`src/server/chat/compact.ts:137-170`) holds Top 3, 7 "more today" items, 14 events, the outbox, health and policy; I estimate 2-5k tokens but didn't measure it.

Cache behaviour:

- The tools and the skill sit before the boundary, so they cache.
- Everything after `## Now` changes every message: the minute-stamped time, the pack, the persona, live reads and the history (which lives in the user prompt). The first call of each message therefore writes the whole thread to the cache again.
- In the synthetic sample, a message averages about 28k uncached input tokens, 243k cache reads, about 35k cache writes and 3.7k output tokens.

### 2.4 Read / stage / deny (D-58, `src/contract/routes.ts:112-125`)

- Every route carries an `assistant: read | stage | deny` field: 66 read, 57 stage, 26 deny.
- `chat_app_read` runs any read route (or one of the 40 page aliases in `src/server/chat/read.ts:29-71`) through the route's own zod schemas and the same DataSource method the UI uses. It is paged at 40k characters with `nextOffset` (`read.ts:127`, `:225`).
- `chat_app_change` stages any stage route as a `route_call` change. `guardInput` refuses the `sending` section and `confirm` saves (`src/server/chat/app-routes.ts:115-121`).
- Deny list: send/dispatch, `applyProposal`, re-auth, `scanConnector`, `launchAgent`, `raiseBudgetToday`, dry run, dev routes and onboarding (`routes.ts:153-334`).
- 43 of the 57 stage routes are `undoable`. The 14 that aren't are mostly job queues: `retryJob`, `syncForecast`, `requestReadIn`, `checkMissingForecast`, `cancelAgent`, and so on.

### 2.5 Proposal → card → Apply → receipt

- `previewChanges` validates and renders before → after lines over DataSource reads (`src/server/chat/changes.ts`, `previewRouteCall`). `stageChanges` persists a pending proposal, and the client draws `ChatProposalCard` (`src/components/chat/ChatProposalCard.tsx:1-7`).
- Apply is the user's `POST /proposals/:id/apply` (deny for the Assistant). It runs each call in a change set with actor `chat` (`src/db/changeset.ts:1-16`), continues past errors and lists the failed lines on the receipt (A3). **Undo all** reverts through the audit ids.
- One card holds up to 2,000 calls (`tools.ts:65`). A second card with the same summary in the same message is refused (`tools.ts:131-139`).
- Drafts go to the Outbox (`chat_draft`); VDP changes go to Activity ▸ VDP (`chat_vdp_update`); log canvases stage on Time (`chat_log_batch stage`). These are three other approval surfaces, outside the proposal card.

### 2.6 Model choice

The thread's choice is `sonnet` (`claude-sonnet-5-5`) by default, or `opus` (`runner.ts:44`, `settings.ts:345`). The composer menu offers `['Sonnet', 'Opus']` (`src/components/chat/ChatComposer.tsx:95`). Research runs on Sonnet at effort `medium` (`src/server/chat/research.ts:110,139`, `READIN_MODEL` `src/llm/readin/prompt.ts:16`). The Org62 lookup uses Haiku as an LLM relay to make one deterministic MCP call (`skills/read-lookup.md`, `src/server/onboarding/identity.ts:139-157`).

### 2.7 Audit lane A (2026-11-13): what was done

| Item | Status | Evidence |
|---|---|---|
| A1 reads page, never cut | **Done for rows; not for strings** (2k clip) | `read.ts:127,133,225` |
| A2 any number of calls per card | Done (2,000 sanity bound) | `tools.ts:65` |
| A3 per-call Apply with failed list | Done | `skills/chat-assistant.md:43-44`, receipt `failed` |
| A4 `version` kept, `ifVersion` auto-fill | Done | `compact.ts:33`, `app-routes.ts:268` |
| A5 no per-message counts | Mostly done; one rescan per connector per message remains (it's on the scanners' budget) | `tools.ts:392` |
| A6 history whole, 80 turns, Drive 60k, Gmail paged | Done in the Assistant; **research runs still use 8k thread / 6k file** | `prompt.ts:81-87`, `host.ts:53-54`, `readin/tools.ts:80` |
| A7 route loosening | Done (`getBrief`, `previewPolicy`, `searchOrg62Opps` read; `markItemSeen`, `undoAudit`, `retryJob`, … stage) | `routes.ts` |
| A8 SOQL 2,000 / Contact, OCR | Done (runner header still says "LIMIT ≤ 200", which is stale) | `soql.ts:17-22`, `runner.ts:11-12` |
| A9 one generic read; "available, not active" line | Done | `read.ts:31`, `src/personas/types.ts:29` |

## 3. Findings

**ASSIST-1 (blocker): research can't fit its own budget.** `chat_research` caps a run at `min(researchUsd 0.50, dayLeft, msgLeft)` (`tools.ts:305`). `msgLeft` is what's left of a $0.25 message after the model's own calls, typically under $0.20. D-51 ("$0.50 per run") and D-58 ("sub-runs spend inside the same cap") conflict. The result is the owner's "constantly asks me to raise caps". The same applies to `chat_vdp_find_assets` against the day line (`tools.ts:203-209`) and to every `needMore` (`runner.ts:247-253`).

**ASSIST-2 (blocker): "Allow more" restarts the turn.** The `budget_exceeded` path aborts the SDK query (`runner.ts:228-233`, `:438-440`). The button re-sends the failed text as a new message (`useChatStream.ts:382-390`, `ChatMessages.tsx:75-78`). All reads, tool results and partial work are paid again. Only the 8k-character text and the card lines survive, through history. This is the opposite of "ask to continue without killing the session".

**ASSIST-3 (major): one stateless query per message.** `persistSession: false` (`runner.ts:331`), with history re-rendered as one user-prompt string (`prompt.ts:148`). Consequences:
- Earlier tool results are gone: "now claim the ones you just found" means reading everything again.
- Cache writes are the dominant cost; the 2026-11-13 audit puts them at 69% of chat spend.
- The SDK's `resume`, compaction, `interrupt` and `setModel` can't be used.
- `## Now` is minute-stamped before the pack, so even the persona and live-reads blocks never cache across messages (`prompt.ts:141-147`).

**ASSIST-4 (major): no Haiku, and effort is fixed at `low` on Sonnet.** Most turns are "why is X first", "find the thread" or "snooze this". A Haiku 5.5 turn with today's token profile costs about $0.012 against $0.23 (prices at `src/llm/models.ts:23-25`; that's 20x). The composer can't offer it because the contract enum is `sonnet | opus` (`common.ts:126`).

**ASSIST-5 (major): silent string and count cuts under the tools, against D-58's "no silent caps".**
- `cleanForModel` clips every string at 2,000 characters (`read.ts:133,150`): evidence bodies, meeting-note text, descriptions.
- `compactDetail` clips purpose and notes at 2,000 (`compact.ts:122`).
- `toolJson` clips any string at 4,000 (`compact.ts:180`).
- Calendar: `listEvents(..., 250)` returns one page and filters by `words` afterwards (`research/tools.ts:142`, `connectors/google/calendar.ts:96-103`). "Have I met Fabrikam this year?" silently misses everything past the first 250 events. The result is then cut at 6,000 characters (`research/tools.ts:144`).
- Gmail and Drive search results are cut at 4,000 characters, with `max ≤ 10` and no cursor (`readin/tools.ts:80,158-176`, `tools.ts:520,536`).
- Research runs read Gmail threads capped at 8,000 characters with no paging, and Drive at 6,000 a page (`readin/tools.ts:164`, `research.ts:109`).
- Drive paging re-downloads the whole file on every page (`readin/tools.ts:182`).

The full classification is in §3a.

**ASSIST-6 (major): it can only reach the data model through fixed routes.** There is no general query. "Which accounts have hours this quarter but no DC and no meeting in 30 days?" means paging `getDeals`, `time_log` and `calendar` and joining them in the model's head, which is slow, costly and error-prone. The 120-table DB (`sample-data/tables`) is invisible except through the 66 read routes' shapes.

**ASSIST-7 (major): read-only jobs need an Apply card.** `requestReadIn`, `syncForecast`, `checkMissingForecast` and `retryJob` only queue reads, but they are `stage` (`routes.ts`, the 14 non-undoable stage routes). `scanConnector` is `deny`, yet `chat_rescan` does the same thing through a bespoke tool (`tools.ts:385-401`). The classification lacks a fourth class, *run*: read-only work that costs money and needs an estimate, not an approval. There's also no "check if this item is done" job (no route exists for the resolution check).

**ASSIST-8 (major): research is a nested `query()` blocking a tool for up to 170 s** (`research.ts:30,135-152`, `server.ts:19`):
- It has its own prompt (`skills/research-question.md`), runs on Sonnet at `medium`, has 16 turns, is capped at 12 findings, and has no plan step.
- The parent sees a 12-step progress bar, not the sub-steps (`tools.ts:311-322`).
- SDK `agents` (subagents with their own model, tools and maxTurns) would give the same isolation, Haiku workers, cost inside one `total_cost_usd`, and visibility through task messages.

**ASSIST-9 (major): the user can't see spend while it climbs.** There's no usage SSE event (`contract/chat.ts:296-311`), and `ChatMessage.usage` is persisted but never rendered (no chat component reads it). The first spend signal is the failure. This goes against *Legible* ("what an agent did, and what it will do next").

**ASSIST-10 (minor): the Org62 lookup uses an LLM relay** (`identity.ts:139-157`, about $0.03 and several seconds per lookup through `skills/read-lookup.md`) to make one MCP call with arguments the app already built. The Google reads already use a direct client (`GoogleTools.call`, `readin/tools.ts:141`). An in-process MCP client for the same allowlisted Slack and Org62 tools would cost $0 and be deterministic. This needs Tristan to confirm it fits "MCP connections only" (Decision 6).

**ASSIST-11 (minor): skill bloat.** Over half of the 24 KB skill is domain playbooks: DC claims (`chat-assistant.md:45-60`), VDP (`:90-105`) and logging (`:86-88`). They load on every turn and duplicate tool descriptions. Some of it is already enforced in code: a same-split DC claim is refused at preview (`chat-assistant.md:46`). This prefix is exactly what makes a Haiku turn unreliable.

**ASSIST-12 (minor): stale or inconsistent text.**
- The runner header says "LIMIT ≤ 200" (`runner.ts:11-12`); the guard allows 2,000.
- `raiseBudgetToday` is deny, but `patchSettings` on the `budgets` / `chat` sections is stageable (`app-routes.ts:115-121`). That's fine, because the user applies it, but the deny wording "raises its own budget" overstates it.
- The UI truncates a tool row's result to 1,500 characters (`tools.ts:604`). That's display-only and fine.

### 3a. Every cap, classified (*ext* = external real limit, *budget* = user budget, *safety* = safety invariant, *arb* = arbitrary)

| Cap | Where | Class | Action |
|---|---|---|---|
| Per-message $0.25 / $0.60, day $3, research $0.50, ≤ $5 "Allow more" | `settings.ts:336-345`, `runner.ts:165,250` | budget | Replace with ask/hard thresholds (§5); remove the $5 clamp |
| `maxBudgetUsd = capUsd` | `runner.ts:333` | budget | Set to the **hard** ceiling only |
| `maxTurns` 30, clamped to 80 | `outputs.ts:212` | arb (loop guard) | Keep as a runaway guard at 200; cost bounds the turn |
| Turn watchdog 180 s, hard 420 s | `runner.ts:213-221` | arb | No-progress watchdog (no token or tool for 90 s), plus a time "raise hand" |
| Research 170 s, tool timeout 200 s | `research.ts:30`, `server.ts:19` | arb | Subagent; no tool timeout |
| Research maxTurns 16, ≤12 findings, ≤16 searched, answer ≤1,500 | `research.ts:111`, `research/tools.ts:31-49` | arb | Plan-driven; findings unbounded and paged |
| Research question ≤400, hint ≤600, names ≤6 | `tools.ts:294-297`, `research.ts:113-118` | arb | Relax (4k / 4k / 20) |
| Read page 40k characters | `read.ts:127` | ext (SDK MCP output ~25k tokens; `MAX_MCP_OUTPUT_TOKENS` is tunable) | Keep; it's a page size, not a cut |
| String clip 2,000 (reads), 2,000 (item purpose/notes), 4,000 (toolJson), 600 (pack) | `read.ts:133`, `compact.ts:122,169,180` | arb | Remove; page long fields (`field`, `offset`) |
| `TOOL_JSON_MAX` 64k → stub | `compact.ts:173` | ext (MCP output) | Keep; page instead of stub |
| Search results 4,000 characters, Gmail/Drive `max ≤ 10`, no cursor | `readin/tools.ts:80`, `tools.ts:520,536` | arb (`page_size` is ext) | Return a cursor; no character cut |
| Gmail thread 8,000 (research), Drive 6,000 a page (research) | `readin/tools.ts:80,164` | arb | Same 60k paging as chat |
| Calendar 250 events per call, then filter; 6,000 characters | `research/tools.ts:142,144` | arb (bug) | Page `get_events` until the range is exhausted; filter server-side words where supported |
| Calendar ≤ 366 days per call | `research/tools.ts:105` | arb (chunking) | Chunk internally |
| Ledger 4,000 characters, ≤12 hits | `readin/tools.ts:80,117` | arb | Paging |
| `chat_search_sources` ≤20, `hits.slice(limit*2)` | `tools.ts:152`, `host.ts:92` | arb | Cursor |
| Org62 lookup ≤25 rows, ≤100 ids | `org62.ts:19,65,103` | arb (2,000 is ext) | 2,000 like the SOQL guard |
| SOQL LIMIT/IN ≤2,000, ≤100k characters, SELECT only, object allowlist | `soql.ts:17-19,85-118` | ext + safety | Keep |
| History: user 120k, assistant 8k, total 320k characters, 400 messages | `prompt.ts:81-91` | arb (context) | Replace with SDK session + compaction |
| Card ≤2,000 calls; echo 100 lines | `tools.ts:65,68` | safety bound / arb | Keep (sane); echo is fine |
| One card per summary per message | `tools.ts:131-139` | arb guard | Keep (it prevents split lists) |
| One rescan per connector per message | `tools.ts:392` | budget (scanner) | Keep, priced through `run_job` estimate |
| Draft body ≤6,000; session prompt ≤8,000; VDP value ≤4,000 | `tools.ts:413,427,168` | arb (Slack allows 40k; VDP limits unknown) | Raise to the destination's real limit |
| Find assets `capUsd ≤ 50` | `tools.ts:195` | budget | Fold into estimate/ask |
| Tool row result 1,500 (UI) | `tools.ts:604` | display | Keep |
| Allowlist, `sending` section refused, deny routes, redaction | `runner.ts:276-306`, `app-routes.ts:115-121` | safety | Keep |

## 4. Capability gaps (owner: "it should be able to do anything")

| Capability | Today | Evidence |
|---|---|---|
| (a) Query the data model generally | **Partial**: 66 read routes + 40 pages, paged; no ad-hoc filter or join | `read.ts:29-71`, `app-routes.ts:31-40` |
| (b) Run connectors' read tools live, same allowlist | **Yes (db mode)**: Slack search/thread/channel/unreads and Org62 `soqlQuery` through the scanners' restricted servers; Gmail, Drive, Calendar through the research handlers. With the §3a cuts and no cursors. Mock mode: none | `runner.ts:80-104`, `host.ts:104-116`, `prompt.ts:129-137` |
| (c) Multi-step research with its own sub-steps | **Partial**: one nested Sonnet run per tool call, opaque, capped at about $0.20 in practice | `tools.ts:288-333`, `research.ts:102-165` |
| (d) Stage any change with preview and undo | **Yes, mostly**: 57 stage routes plus item ops, one card, per-call receipt, Undo all on 43 undoable routes. Drafts, VDP and log canvases use separate approval surfaces | §2.4-2.5 |
| (e) Trigger a scan or a resolution check | **Partial**: `chat_rescan` per connector; read-in and forecast checks only as Apply cards; **no per-item "is this done?" check** | `tools.ts:385-401`, `routes.ts:308` |
| (f) Launch a Claude Code session with context | **Partial (by design)**: prepares a `claude://` link the user clicks; no background `claude -p` child | `tools.ts:422-433`, `routes.ts:176` (deny) |

## 5. Target design: "a purpose-built Claude"

### 5.1 Tool set: 11 tools, stable per persona (replacing 18 + 5)

| Tool | Kind | Replaces | Notes |
|---|---|---|---|
| `app_read {route, args, offset, limit, field?}` | read | `chat_app_read` | The catalog moves out of the description: a one-line index of pages, plus `app_describe {route}` returning schema and example on demand. Expect the description to drop from 9k characters to about 1.5k. `field` pages one long string |
| `query {sql, params, offset}` | read | none | A read-only Postgres role over **curated views** (`v_work_items`, `v_evidence`, `v_activities`, `v_opps`, `v_accounts`, `v_dc`, `v_vdp`, `v_source_items`, `v_meetings`). Runs in `SET TRANSACTION READ ONLY` with `statement_timeout`, a single SELECT, and redaction on output. Returns compact CSV with `total`/`nextOffset`. Mock mode: PGlite seeded from `sample-data` (dependency: DATA-MODEL lane) |
| `source_search {source, query, cursor}` | read | `chat_search_sources`, `chat_gmail_search`, `chat_drive_search`, the Slack search MCP | One shape across ledger, Slack, Gmail, Drive, Calendar and Org62 words. A cursor, never a character cut |
| `source_read {source, ref, offset}` | read | `chat_gmail_thread`, `chat_drive_read`, Slack thread/channel | The fetched body is cached per turn (no re-download per page) |
| `org62_soql {q}` | read | `soqlQuery` passthrough | Same guard (`soql.ts`) |
| `explain_item {id}` | read | 5 pages (`item`, `item_trace`, `item_evidence`, `item_history`, `item_nba`) | A deterministic composite |
| `propose {changes[], summary}` | stage | `chat_propose_changes`, `chat_app_change`, `chat_vdp_update`, `chat_log_batch stage`, `chat_draft` | A typed union: `item_op`, `route_call`, `vdp_item`, `log_batch`, `draft`. One card, a preview, and Undo where the route supports it. Drafts still land in the Outbox (*tenet: Draft, don't send*) |
| `run {job, args, estimateOnly?}` | run | `chat_rescan`, `chat_vdp_find_assets`, `requestReadIn`, `syncForecast`, `checkMissingForecast`, `retryJob`, **new `check_resolution {itemIds}`** | Read-only work: no Apply card, priced up front, under the budget ask (§6) |
| `research {question, names, since}` | run | `chat_research` | An SDK subagent (Haiku 5.5 workers; Sonnet when the parent is Sonnet or Opus) with `source_*` + `org62_soql` + `query` |
| `start_session {repo, prompt, workItemId}` | handoff | `chat_start_session` | Unchanged (link, user click) |
| `reauth {connector}` | handoff | `chat_reauth` | Unchanged |

Classification becomes **read / run / stage / deny** on every route (`routes.ts:125`). The *deny* list is unchanged: send, dispatch, apply, credentials, dry run, `sending` settings, launch, raising its own budget, dev. *Run* is new: read-only side effects that cost money. Guardrails stay where they are:
- the exact allowlist through `PreToolUse` + `canUseTool`;
- the SOQL guard;
- `guardInput`;
- route schemas at preview;
- the audit change set at Apply.

Add a `query` guard (one statement, views only, read-only transaction, timeout). It fits *Read-only ingest*: there is no connector write.

### 5.2 The turn

1. **Route the model (deterministic, before the call).** The user sets a default (Auto / Haiku / Sonnet / Opus) and can override per message (composer menu, `/sonnet`). **Auto** routing:
   - Haiku 5.5 for questions, lookups, single edits and tool-only turns;
   - Sonnet 5.5 when the message is list mode (a pasted list over 5 rows, "claim/approve these"), asks for a draft, or the previous Haiku turn ended in a tool error or "I couldn't";
   - Opus only on explicit choice.

   `setModel()` can escalate mid-query without a new session (`sdk.d.ts:2988`), and `fallbackModel: sonnet` covers refusals. Show the model on the message.
2. **Plan step (non-trivial turns only).** The model's first action is a `plan {steps[{tool, what, scope}], needsResearch, rows?}` tool call, required only when the router flags list mode, research, `run` or more than 3 expected reads. The app prices the plan deterministically (§6.2). Below the ask threshold nothing is shown (*Calm, not a firehose*). Above it, a one-line plan card appears with the estimate.
3. **Execute** with streaming text and tool rows, plus a live cost meter (a new `usage-delta` SSE event).
4. **Raise a hand** at the soft threshold, through the hook that waits (§6.3).
5. **End.** A receipt line: model · steps · $ actual vs estimate.

### 5.3 Context and state

- **One SDK session per thread.** Use `persistSession: true` with `sessionId` = the thread's UUID, then `resume` on the next message. Set `CLAUDE_CONFIG_DIR` under `~/Library/Application Support/control-center/` so transcripts stay in app state (CLAUDE.md invariant 6). Earlier tool results stay in context, the history is a cached prefix, and SDK auto-compaction (`autoCompactWindow`) replaces `renderHistory`.
- **Keep the system prompt byte-stable.** Move `Now`, `Looking at` and the context pack into each **user message** as a header block. Persona and live reads go before the boundary (they're stable per persona).
- **Skill diet.** Keep about 6 KB of core rules (hard rules, answering, lists, cards). Move the DC, VDP and logging playbooks into app-scoped SDK skills in the chat cwd (`skills: [...]`), loaded on demand, or into the `propose`/`run` kind descriptions. Facts code already enforces leave the prompt; for example, "already hold this DC" is a preview refusal.
- **Deterministic vs prompt.**
  - Code: allowlist and deny, SOQL and `query` guards, preview, validation and dedupe, model routing, estimate and ask, paging, compaction triggers, DC "already yours" and "same split", time-zone math for `until`, card grouping.
  - Prompt: what to read first, when to research, grading borderline rows, wording drafts and DC comments, explanations.

### 5.4 Compared with D-58

D-58 ("general abilities", amended "no silent caps") is the right direction, and this design keeps its read/stage/deny model, one-card lists and paging. It changes four things:
1. a fourth class, *run*;
2. a general `query` alongside routes;
3. sessions instead of re-rendered history;
4. budget becomes estimate/ask instead of a cap that kills the turn.

It finishes D-58's "no silent caps" for strings and calendar. It amends D-51 (research is a subagent priced by its plan, not a fixed $0.50 inside a $0.25 message). No tenet conflict, except Decision 2 (transcripts on disk), which I flag.

## 6. Spend UX: estimate → warn → run → raise hand → continue

### 6.1 Thresholds (user-set in Settings ▸ Budgets ▸ Assistant; replace `messageUsd`, `researchUsd`, `allowExtraUsd`)

| Threshold | Default | Meaning |
|---|---|---|
| `askAboveUsd` (per message) | $0.50 | Above the estimate: show the plan card and wait for Go. Mid-run: raise a hand once spend passes it |
| `askStepUsd` | $0.50 | After a Continue, ask again at each further step of this size |
| `messageHardUsd` | $5 | The SDK `maxBudgetUsd`. A real stop, with a graceful wrap-up first (§6.4) |
| `dayAskUsd` | $5 | The first message past it asks once ("Assistant today: $5.10, continue for today?") |
| `dayHardUsd` | $20 | No new turns. Can be raised in Settings (D-43 kept: independent of the scanners' global cap) |

Defaults assume Auto routing, where the expected day is under $1. Spend shows live in the message header ("Haiku · 6 steps · $0.04").

### 6.2 The estimate (computed after the plan step, deterministic)

`estimate = Σ steps (prefix_tokens × cache_read_price + new_context_tokens × write_price + expected_output × out_price) + Σ sub-runs (their own estimator)`.

Inputs:
- the exact prompt and history token counts, already known;
- per-tool p50 and p90 result sizes and per-sub-run p50/p90 cost from `llm_calls` history (LLM-COST owns the store);
- `estimateOnly` of `run` jobs. The existing Find assets estimate (`tools.ts:203-209`) is the precedent.

The plan card shows: "Plan: read Deals, 1 SOQL over 55 ids, grade, 1 card · Sonnet · ~$0.18 (up to $0.40)". Buttons: **Go** / **Go on Haiku (~$0.02)** / **Edit**.

### 6.3 The raise-hand mechanics (no session kill)

- The `canUseTool` callback (or the `PreToolUse` hook) runs before **every** tool call and is async (`runner.ts:298`). When `spend + nextStepEstimate > askAt`, it emits SSE `budget-ask {spentUsd, nextUsd, stepsDone, planLeft}` and **awaits** the decision.
- The SDK query stays alive in the meantime: the model is waiting on a tool permission, so tokens stop.
- The card reads: "Spent $0.52 so far (12 of ~18 steps). Continue for ~$0.25 more?" with buttons **Continue** · **Continue, don't ask again this message** · **Wrap up now**.
- **Continue** → `allow`, and `askAt += askStepUsd`.
- **Wrap up** → `deny` with a message: "The user asked you to stop here: answer from what you have and say what's left." The model then answers. It isn't aborted, so the partial work becomes a usable answer and is staged if it was ready.
- The turn runs as a server-side job, detached from the SSE connection: its state lives in `chat_turns {status: running | waiting_budget | done, sessionId, askAt, spent}`. If the panel closes, the ask waits in the thread and in the Inbox badge. If the ask goes unanswered for 15 min, the turn takes the Wrap-up path.
- If the worker restarts mid-turn, the next message (or a **Resume** button) uses SDK `resume` on the thread's session with "Continue where you left off". No work is lost.
- Text-only stretches with no tool call can't be paused this way. They are bounded by output per call, and the next tool boundary catches them.
- Day thresholds are checked before the turn and at each ask.

### 6.4 Hard stop

At `messageHardUsd - margin` (the margin is about one step's estimate), the hook denies the next tool with "Budget reached: finish now". The SDK `maxBudgetUsd = messageHardUsd` stays as the backstop: it ends with `error_max_budget_usd`, the partial result is persisted, and the card offers **Raise limit and resume** (resume, not re-send). A day hard stop refuses new turns, with a link to Settings.

### 6.5 What it replaces

- `allowExtraUsd` and its $5 clamp (`requests.ts:326`, `runner.ts:165`);
- `needMore` (`tools.ts:101`, `runner.ts:247-253`);
- the research `min(...)` cap (`tools.ts:305`);
- "Allow $X more" via re-send (`ChatMessages.tsx:75-78`);
- `perMessageUsd` as the `maxBudgetUsd` value.

Sub-runs (research subagent, `run` jobs) count inside the same live meter: subagent cost arrives in the parent's `total_cost_usd`, and background jobs hold a reservation.

### 6.6 Interface I need from the budget layer (LLM-COST owns the implementation)

```ts
interface AssistantBudget {
  thresholds(userId): { askAboveUsd; askStepUsd; messageHardUsd; dayAskUsd; dayHardUsd; dayAskAcked: boolean };
  dayStatus(userId): { spentUsd; reservedUsd; state: 'ok' | 'ask' | 'hard' };
  price(model, usage: TokenUsage): number;                 // single price table (src/llm/models.ts)
  estimate(spec: { model; promptTokens; cachedTokens; steps: Array<{ tool; scope? }>; subRuns: Array<{ kind; args }> }):
    { p50Usd; p90Usd; basis: 'history' | 'default' };      // p50/p90 per tool/sub-run from llm_calls
  meter(messageId): { add(usd, what, source: 'model' | 'subagent' | 'job'); spent(): number };   // live, incl. sub-runs
  reserve(messageId, usd, what): ReservationId;  commit(id, actualUsd); release(id);           // background runs
  grant(messageId, usd, by: 'user', reason): void;         // audited approval ("Continue for $0.25")
  ackDay(userId, day): void;                                // "continue for today"
}
```

Contract additions:
- SSE `usage-delta {spentUsd, model}`, `budget-ask {...}`, `plan {...}`;
- a `POST /chat/turns/:id/decision {continue | wrap_up | raise}` route (deny for the Assistant);
- `ChatModel` gains `haiku` and `auto`;
- a settings migration from `messageUsd`/`researchUsd`/`dailyUsd` to the new keys. Map `dailyUsd` → `dayHardUsd`, `messageUsd.sonnet` → `askAboveUsd` × 2, and keep the old keys readable for one minor version (D-57 semver).

## 7. Model and context efficiency

- **Prefix caching.** Byte-stable `tools → system`, with dynamic content in the user message (§5.3). This lets cross-message cache reads replace writes. With sessions, the per-message write is only the new delta (about 2-5k tokens) instead of the whole thread (about 35k in the sample). Verify with `cache_read_input_tokens` per message in `llm_calls`.
- **Tool-result paging.** Results stay paged: 40k-character pages, cursors on search, `field` paging for long strings, no clips. Results go out as compact CSV or rows instead of pretty JSON (`query`, list pages): roughly 40% fewer tokens for tables (estimated, not measured).
- **History.** SDK session plus auto-compaction. Also clear old tool results after N messages (`PreCompact`); the API `clear_tool_uses` context edit isn't exposed by the SDK, so compaction is the lever.
- **Haiku.** The default under Auto for Q&A, single edits, reads and research workers. Sonnet for list mode, drafting and multi-entity reasoning. A smaller skill and the `app_describe` index make Haiku viable.
- **Effort.** Haiku/Sonnet `low` for chat, `medium` for research workers.
- **Cost targets per turn:**

  | Turn | Target |
  |---|---|
  | Simple Q&A or one edit (Haiku) | ≤ $0.01 |
  | Lookup with 2-4 reads (Haiku) | ≤ $0.02 |
  | List mode, 50 rows (Sonnet) | ≤ $0.15 |
  | Research (Haiku workers) | ≤ $0.10 |

  A typical day should land at ≤ $0.50, against today's ~$0.23 a message and $3 a day. These targets are estimates from `models.ts` prices and the synthetic token profile; validate them on real `llm_calls`.

## 8. Assistant panel UX (behaviour; UI-AUDIT owns visuals)

- **Message header:** model chip (Auto→Haiku) · live $ · steps. Today none of these show (ASSIST-9).
- **Plan card:** only above `askAboveUsd` or for `run` jobs. One line of steps and the estimate, with Go / cheaper model / Edit.
- **Tool rows:** keep the fold (`src/components/chat/ToolRows.tsx`). Add the per-row source (Slack, DB, Org62) and a paging hint ("page 2 of 5"). Show subagent steps nested under `research`.
- **Raise-hand card:** inline in the stream (§6.3). It's never a red error; the current `InlineError` with "budget_exceeded" (`ChatMessages.tsx:47-80`) becomes a neutral question.
- **Proposals:** keep one card per list, but merge drafts, VDP items and log batches into the same card family (`propose`), each still deep-linking to its approval surface (Outbox, Time). Show "Undo all" availability per line (non-undoable routes marked).
- **Composer:** a model menu (Auto, Haiku, Sonnet, Opus) and `/plan` to force a plan.
- **Waiting state:** a thread with a pending ask shows a badge in the panel header and the nav.

## 9. Recommendations (prioritized)

| # | What | Effort | Depends on | Migration / compat |
|---|---|---|---|---|
| R1 | Stop-gap: research and sub-runs get their own line, not `msgLeft` (`tools.ts:305`). Raise the per-message default to $0.75 Sonnet. Allow-more resumes rather than re-sends (needs R3), or at minimum raise defaults now | S | none | Settings defaults only; the existing user value wins if it's set |
| R2 | Add `haiku` + `auto` to `ChatModel`; deterministic router; `setModel` escalation; `fallbackModel` | S-M | LLM-COST (price table) | Enum widening is additive; the stored `defaultModel` stays valid |
| R3 | SDK session per thread (`persistSession`, `resume`, config dir under App Support); dynamic blocks into the user message; drop `renderHistory` for resumed threads (keep it as the fallback for old threads) | M | none | New nullable `chat_threads.sdk_session_id`; old threads re-seed from rendered history once |
| R4 | Raise-hand via an awaiting `canUseTool`; detached turn job (`chat_turns`); `budget-ask`/`usage-delta` SSE; decision route; hard = `maxBudgetUsd` | M | LLM-COST (`AssistantBudget`), UI-AUDIT | Migration for `chat_turns`; settings key mapping (§6.6); contract additive |
| R5 | Plan step + estimate (router-gated); plan card | M | R4, LLM-COST `estimate` | Additive SSE event |
| R6 | Remove string clips and fix calendar paging (loop `get_events` until done); cursors on search; one Drive fetch per turn; research uses chat page sizes | S | none | None (output shape keeps keys) |
| R7 | `query` tool over read-only views + role; PGlite in mock mode | M-L | DATA-MODEL lane (view set), RAG/DB question #8 | New migration: views + `cc_assistant_ro` role; no table changes |
| R8 | Add the `run` class; move `requestReadIn`, `syncForecast`, `checkMissingForecast`, `retryJob`, scans and Find assets under it; add a `check_resolution` job route | M | SCANNER/RESOLUTION lane (#2) for the job | `AssistantUse` gains `run`; the routes test (`tests/bechat/app-routes.test.ts`) updates |
| R9 | Research as an SDK subagent (`agents.research`, Haiku workers), with sub-steps streamed | M | R4 | Skill `research-question.md` becomes the agent prompt |
| R10 | Tool-set consolidation to about 11 (§5.1); `app_describe` index; skill to about 6 KB plus on-demand playbooks | M | R2 (Haiku needs it) | Tool names change: keep aliases for one minor version for the fake runner and tests (`src/llm/chat/fake.ts`) |
| R11 | Direct MCP client for allowlisted Slack/Org62 reads (drop the Haiku relay) | S-M | Decision 6, CONNECTORS lane | None |

## 10. Decisions for Tristan

1. **Default model.**
   - (a) Auto: Haiku by default with Sonnet escalation (recommended; about 10-20x cheaper per turn).
   - (b) Haiku default, manual escalation.
   - (c) Sonnet default as today.
2. **Conversation state.**
   - (a) SDK sessions persisted under App Support (recommended; it enables resume and raise-hand and cuts cache writes). Full transcripts, including read message bodies, land on local disk. That's consistent with *Local data* but isn't a log; confirm it's acceptable.
   - (b) Keep the app's own history (no transcripts on disk; resume is impossible and costs stay higher).
3. **General data access.**
   - (a) Read-only SQL over curated views (recommended; flexible, guardable).
   - (b) A typed query DSL (safer, much more code, less capable).
   - (c) Routes only (today).
4. **Budget semantics.**
   - (a) Soft ask + high hard stop as in §6.1 (recommended).
   - (b) Soft ask only, no per-message hard stop (only the day hard).
5. **Read-only jobs without Apply** (`run` class priced up front). Recommended: yes. They write nothing external, and the deny list is unchanged.
6. **Direct MCP client for Slack/Org62 reads** instead of an LLM relay. It's still "MCP connections" under the compliance rule. Recommended: yes, if the work machine's MCP servers can be launched by the app with the same `~/.claude.json` config.

## 11. What's fine, don't touch

- The allowlist enforcement in three layers (`PreToolUse`, `canUseTool`, `tool_use` scan, `permission_denials`), `runner.ts:276-306,404,450`.
- The SOQL guard (`soql.ts`): its limits are Org62's own.
- Route classification living on the route table, with a test (`routes.ts:112-125`, `tests/bechat/app-routes.test.ts`).
- Preview through the route's own schemas and the same DataSource methods the UI uses (`app-routes.ts`).
- One card per list, per-call Apply with the failed list, Undo all (A2/A3).
- Read paging with `total`/`nextOffset` (`read.ts:225`).
- Redaction on every tool result.
- `ifVersion` auto-fill.
- The `sending` section and `confirm` guard (`app-routes.ts:115-121`).
- Drafts never sent; launches only as a user-clicked link.
- Find assets' `estimateOnly`: generalize it.
- Usage recording however the turn ends (`runner.ts:470-492`).

## 12. Open questions / not verified

- Real (non-synthetic) chat cost distribution, and how often `budget_exceeded` fires: `llm_calls` with `status = 'budget_blocked'` on the live DB. No Postgres here.
- The context pack's token size (estimated at 2-5k, not measured), and the Slack/Org62 MCP tool schema sizes.
- Whether the gateway or apiKeyHelper path supports `persistSession` with a custom `CLAUDE_CONFIG_DIR` without losing the user's MCP config (`settingSources: ['user']` reads `~/.claude.json`). It needs a spike.
- Whether `canUseTool` can stay pending for minutes without the CLI timing out. The SDK types put no timeout on it; verify it with a fake run.
- Whether Haiku 5.5 handles the D-58 list-mode recipe reliably. That needs an eval (`claude-api build-eval`) over about 30 real messages before Auto ships.
- Google `get_events` paging semantics (a page token, or only `max_results`). If it has no token, chunk the range by month.
