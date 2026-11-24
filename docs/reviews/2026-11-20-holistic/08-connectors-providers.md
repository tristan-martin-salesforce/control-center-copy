# 08 · Connectors and LLM providers (lane CONN)

Reviewer: connectors-providers. Scope: owner's ask #7 (connectors easy to add, LLM provider pluggable), plus the connector half of ask #12 (end-to-end error handling for a non-technical teammate). Read-only review. I made no MCP or external calls. I ran the error classifier locally against synthetic messages (scratch script, nothing committed) and ran `claude mcp --help` to confirm `claude mcp login` exists (Claude Code 2.1.329).

## 1. Summary

1. **There is no single `Connector` interface. The tenet says there is** (*tenet: Connectors are adapters*, `docs/TENETS.md:22`). There are two scanner spec shapes (`TraversalConnectorSpec`, `DeterministicConnectorSpec`, `src/scanner/runtime/connectors.ts:57,119`) and three separate transports (Claude-relayed MCP, a direct MCP SDK client, raw JSON-RPC over `fetch`). A connector's identity, auth, allowlist, health and re-auth are spread over about 12 files. The connector list itself is hard-coded in about 40 enumerations, using **four different ID vocabularies** (`gemini_notes`/`gemini`/`notes`, `claude_sessions`/`claude`).
2. **Adding a connector today touches about 25 files and needs a Postgres enum migration** (`source_system`, `src/db/schema/enums.ts:10`). A manifest-driven registry would get that down to about 5 files plus fixtures (Rec 1–3).
3. **The LLM is wired to Claude in two separate ways.** (a) 21 files import `@anthropic-ai/claude-agent-sdk` directly. (b) Slack and Org62 reads *only work* inside a Claude Code process, because the OAuth tokens live in Claude Code's store and we must not copy them. Real pluggability therefore needs two seams: a **`ModelProvider`** (reasoning) and a **`ConnectorRuntime`** (how a read tool gets called, with the allowlist). Good seams already exist and can be generalized (`Complete`, `SkillRunner`, the cc handlers decoupled from the SDK).
4. **The first-day failures a teammate hits most often have the worst messages.** Each of these reads as "a run failed", which I verified by running the classifier: MCP server not declared, Claude CLI missing, LLM billing or usage limit, Google parser drift. "devbar not installed" is reported as "daemon not listening, restart it". The "Start devbar" button reports success even when devbar doesn't exist. `doctor` has the best diagnostics in the app but is CLI-only.
5. **Compliance:** the VDP connector reads the PAT and Okta cookie out of `~/.claude.json` into the app process and sends them itself (`src/connectors/vdp/http.ts:131-148,218-224`). It never persists or logs them, but this is outside "MCP connections and `claude -p` sessions only". Tristan has to accept or change it (Decision D1). Any "OpenAI reads Slack" design that reuses Claude Code's stored OAuth is copying tokens and is out.

## 2. How it works today

| Layer | Where | Notes |
|---|---|---|
| Connector IDs | `src/scanner/types.ts:13-23` (`ConnectorId`, 10 ids) | DB uses `source_system` (`src/db/schema/enums.ts:10`), contract uses `SourceKind` (`src/contract/common.ts:60`), engines use `SignalSource` (`src/engines/types.ts:299`) |
| Scanner specs | `src/scanner/runtime/connectors.ts` | `slackSpec`, `org62Spec` (traversal: Haiku calls MCP tools in a skill run); `deterministicSpec(fetcher)` with `fetcher.connector === …` special cases (`:249-280`) |
| Fetcher interface | `src/scanner/types.ts:151-166` `DeterministicFetcher` | `scopes`, `fetch(scope,cursor,window)`, `listForReconcile`, `health`, `credentialsIssuedAt`. The closest thing to the tenet's interface, used only by deterministic sources |
| Model run | `src/llm/skill-runner.ts:487-523` | Agent SDK `query()`, `strictMcpConfig`, `tools: []`, `canUseTool` gate, `disallowedTools`, pinned CLI `~/.local/bin/claude` (`src/llm/env.ts:15`) |
| Claude-side MCP | `src/llm/mcp-config.ts:107-133` | Re-declares the server from `~/.claude.json` with non-secret fields (type, url, oauth clientId/callbackPort). The CLI child finds its own stored OAuth |
| Allowlists | `src/llm/mcp-config.ts:19-57` (Slack/Org62), `src/connectors/google/client.ts:29-80` (Google), `src/connectors/vdp/tools.ts` (VDP), `src/outbox/mcp-config.ts:49+` (writes) | Four lists in code. The DB column `connectors.read_tool_allowlist` (`src/db/schema/connectors.ts:39`) is never read |
| Errors → health | `src/llm/errors.ts:21-43` signatures; `classifyMcpStatus` `:60-73`; `reauthFor` `:92-107`; wording `src/scanner/runtime/status-reason.ts:28-51`; Google's own classifier `src/connectors/google/client.ts:101-121`; VDP codes `src/connectors/vdp/http.ts:21-36` | Three classifiers |
| Re-auth | `src/reauth/run.ts:22-30` (`REAUTH_KIND_OF`), `src/reauth/handlers.ts` (Slack/Org62 → Terminal `claude mcp login`, VDP → refresh script with MFA fallback, Google → `devbar …` detached) | Confirm-gated; credentials never pass through |
| Diagnostics | `src/ops/doctor.ts:531-550` (19 checks, CLI `npm run doctor`) | Not imported by any server or UI code (only by tests) |
| Onboarding sources | `src/contract/onboarding.ts:308-341`, `src/server/onboarding/sources.ts` | Read-only `status()` of the re-auth handlers, cached 2 min |
| Outbox (writes) | `src/outbox/transport.ts`, `relay.ts` | Slack canvas and feedback through `runOneToolCall` (a Claude relay); Gmail fails closed; VDP via `connectors/vdp/write.ts` |

### Connector inventory as built (deliverable 1)

| Source | Transport | Auth owner | Read path | Allowlist enforced at | Cadence (base) | Cursor / idempotency | Parsing | Failure detection | Re-auth | User-visible error |
|---|---|---|---|---|---|---|---|---|---|---|
| Slack | Hosted MCP (http) loaded into a `claude` child via Agent SDK | Claude Code OAuth (`claude mcp login slack`) | **Model**: Haiku traverses with 4 read tools (`mcp-config.ts:31`); REC-1 records every tool result deterministically (`skill-runner.ts:480-484`, `slack-rec.ts`) | `canUseTool` gate + `disallowedTools` + `assertReadOnly` (`skill-runner.ts:487-508`, `mcp-config.ts:48-57`) | 2 min inbox, ×5 channels (`cadence.ts:11,48-50`) | ts window cursor per scope; dedupe key `channel:ts` | **Text** (markdown-ish, `slack/parse.ts:1-20`); no drift detection | init `mcp_servers[].status` (`skill-runner.ts:547-554`), signature regexes | Terminal `claude mcp login slack` (`handlers.ts:24-48`) | "Slack inbox: needs re-auth" + Re-auth button |
| Org62 | Hosted MCP `Org62-Sobject-Read` via `claude` child | Claude Code OAuth | **Model** writes SOQL (`soqlQuery` only, `mcp-config.ts:34`); REC-2 records rows (`org62-rec.ts`) | Same gate | 30 min, scope multipliers (`cadence.ts:18,47`) | SystemModstamp windows; `book:<date>` cursor | **JSON** (SOQL result) | Same, plus `soql_invalid` (`errors.ts:36`) | Terminal `claude mcp login Org62-Sobject-Read` | "Org62 events: needs re-auth" |
| Gmail / Calendar / Drive / Gemini notes / Trainings | devbar `mcpgw` streamable HTTP at `localhost:13316` (`google/client.ts:21`), our own MCP SDK client | devbar daemon (gateway-managed tokens; app sees none) | **Deterministic** fetch, then a Haiku interpret run over prefetched items (`connectors.ts:248-289`) | `assertReadTool` before send (`google/client.ts:77-81`), plus `unknownServerTools()` | 3/5/10/10 min, trainings daily | JSON-in-string cursors (`util.ts:69-80`); `dedupeKey` + `contentHash` | **Text** parsers with `ParseDrift` (`google/parse.ts:35,85,246,274,317`) | `classifyGoogleError` + `diagnoseDevbar` (`google/client.ts:186-226`) | In-app `devbar mcpgw connectors connect …` / `auth login` / `daemon start` (detached) | "devbar's MCP gateway isn't answering (not your sign-in), retrying" etc. |
| VDP | Raw JSON-RPC `fetch` to `vdp-app-fir` (`vdp/http.ts:205-243`) | **The app**: PAT + Okta cookie read from `~/.claude.json` per call; the user's refresh script rewrites the cookie hourly | **Deterministic** mirror, record-only, 500 items/run (`connectors.ts:267,280`) | `assertVdpTool(tool,'read')` (`vdp/client.ts:59`) | 30 min | current-state scope (`readsCurrentState`) | **JSON** (`structuredContent` or parsed text) | Typed `VdpError` codes (`http.ts:21-36`), JWT `exp` pre-check (`:213`) | Refresh script silent → Terminal window for MFA (`run.ts:36-38`, `handlers.ts:144-177`) | "VDP: needs re-auth", "connect to the corporate network or Zscaler" (re-auth path only) |
| Claude sessions | Local files `~/.claude/sessions`, desktop index, JSONL (`claude/sessions.ts:1-11`) | none | **Deterministic**, file watch + 10 min sweep | n/a (no tools) | 10 min + watcher | byte offsets + last-item hash | JSONL | fs errors | none | "Claude sessions: a run failed" |
| Watch (channel briefs) | Hybrid: plan from fetcher + Slack read tools (`connectors.ts:250-253`) | Claude Code OAuth | Model | Same gate (2 tools) | 60 min | per subscription | text | as Slack | as Slack | as Slack |

## 3. Findings

**CONN-1 (major): the `Connector` interface the tenet promises doesn't exist, and the connector list is enumerated about 40 times.**
Evidence: `ConnectorId` (`src/scanner/types.ts:13`); `source_system` pg enum (`src/db/schema/enums.ts:10`); `SourceKind` (`src/contract/common.ts:60`); `SignalSource` (`src/engines/types.ts:299`); `READIN_SOURCE_KINDS` (`src/llm/readin/types.ts:14`); `SEARCH_SOURCES` with `'notes'` (`src/engines/nba/prompt/enrich.ts:33`); `OnboardingSourceId` + `ONBOARDING_SOURCE_CONNECTORS` (`src/contract/onboarding.ts:308,317`); `REAUTH_KIND_OF` (`src/reauth/run.ts:22`); `MCP_SERVER_NAME` (`src/llm/errors.ts:87`) duplicated as `SLACK_SERVER`/`ORG62_SERVER` (`src/ops/mcp.ts:17-19`); `DEFAULT_BASE_CADENCE_MS` (`src/scanner/runtime/cadence.ts:10`); `SCOPE_LABEL` and `GOOGLE` set (`status-reason.ts:10-24`); `CONNECTOR_LABEL` (`src/components/settings/role.ts:44`); `ALL_CONNECTORS` (`src/personas/types.ts:12`); `SCAN_CONNECTORS` (`src/jobs/index.ts:32`); `FIRST_SCAN_CONNECTORS` (`first-scan.ts:38`); `CANDIDATE_CONNECTORS` (`completion/candidates.ts:23`); `SOURCE_CONNECTOR` (`src/scanner/store-db.ts:2450`); plus about 8 UI label maps (`components/today/rows.ts:100`, `time/path-derive.ts:30`, `time/RowParts.tsx:34`, `app/work/_list/WorkPage.tsx:57`, …). There are also 73 `connector === '<id>'` / `case '<id>':` branches outside `src/connectors` (scanner/completion 12, scanner/runtime 10, lib 7, server/datasource/db 6, projections 6, …).
Why it matters: ask #7 is "easy to add". Today a new source means editing every one of these places, mapping between the vocabularies, and running an `ALTER TYPE … ADD VALUE` migration.

**CONN-2 (major): source-specific transport and auth details leak into core.** These strings appear outside `src/connectors`: `devbar`, `mcpgw`, `Org62-Sobject-Read`, `vdp-app-fir`, `13316`, `refresh_vdp_fir`, `google-workspace-readonly`. The counts by file: `src/reauth/handlers.ts` 24, `src/ops/doctor.ts` 15, `src/server/onboarding/sources.ts` 6, `src/server/datasource/db/store/health.ts` 6, `src/llm/errors.ts` 5, `src/ops/mcp.ts` 4, `src/outbox/mcp-config.ts` 3, plus about 20 files with 1–2 each. Twenty files import a specific connector module directly (`src/worker` 11, `scanner/drive-digest` 4, `llm/research` 3, `jobs/handlers` 3, …).
Broad mentions of `slack|gmail|org62|vdp` (non-test, non-migration .ts/.tsx) number in the thousands: `server` 2,849 lines in 109 files, `engines` 1,689/80, `components` 1,537/138, `contract` 846/27, `lib` 729/34, `projections` 540/11. Most of these are legitimate **domain** references (Org62 opportunity, VDP use case), not connector leakage. **Org62 and VDP are domain systems as well as sources**, and the refactor should not try to make them generic.

**CONN-3 (major): the same failure is classified three ways and worded in a fourth place.** `src/llm/errors.ts:21-43`, `src/connectors/google/client.ts:101-121`, `src/connectors/vdp/http.ts` error codes, and the wording in `status-reason.ts:28-51`. The VDP network error text names Zscaler (`http.ts:226-228`), but classification reduces it to `transient/network`, and Health then says "VDP plans: temporarily unavailable, retrying" (verified). The useful next step is lost.

**CONN-4 (major): common day-one failures surface as "a run failed" and are retried forever.** I verified these with the classifier:
- MCP server not declared in `~/.claude.json` (`mcp-config.ts:116` throws `config: …`, which matches no signature).
- Unreadable Claude config.
- `spawn …claude ENOENT`: classified `config/executable_missing`, but the wording is still "a run failed".
- `assistant error billing_error`, "credit balance too low", "usage limit reached" (`skill-runner.ts:568-572` maps unknown codes to `unknown`).
`unknown` is retryable (`errors.ts:140-142`), so a missing server or an exhausted plan keeps retrying with backoff and never says what to do. `reauthFor` only produces a next step for `auth`.

**CONN-5 (major): "devbar missing" is misreported in the running app.**
- `diagnoseDevbar` catches the exec failure and sets `daemonUp=false` (`google/client.ts:189-194`). Health then says "devbar daemon is not listening on :13316" and offers `devbar daemon start` (`:216-218`).
- The re-auth status merges the cases into "devbar is not installed or not responding" (`reauth/handlers.ts:217`).
- `spawnDetached` returns `ok:true` before the async `ENOENT` (`reauth/terminal.ts:38-46`), so "Restart devbar: started" shows for a binary that doesn't exist (`handlers.ts:227-229`).
- Only `doctor` gets it right ("devbar not installed", `doctor.ts:169`).
- Nothing explains *what devbar is* or where to get it. README:21-27 and OPS.md:178 assume it's installed, and nothing checks for an outdated devbar.

**CONN-6 (major): the LLM-gateway auth hint assumes devbar.** Any `invalid api key`/`apiKeyHelper` failure tells the user to run `devbar auth login` (`errors.ts:25,94-96`). Tristan's port to a personal machine is exactly the case where the LLM credential is a Claude subscription or API key. Doctor checks only `claude --version` (`doctor.ts:124-127`). It has no check that Claude can actually answer (auth, plan, model access) and no minimum CLI version, even though the Agent SDK `^0.3.316` is tied to CLI behavior (`package.json:59`, `src/llm/env.ts:14-16`).

**CONN-7 (major): `doctor` isn't reachable from the UI.** `runDoctor` is imported only by tests (`grep` result). Health shows connector probes but nothing for Postgres, migrations, LaunchAgents, Node path, ports or devbar install. A non-technical teammate never sees the best diagnostics in the app.

**CONN-8 (minor/major): "MCP server not installed" has no next step.** README and OPS.md tell the user to `claude mcp login slack` (`README.md:19-20`, `OPS.md:182-185`). `login` only works for a server that is already declared. No `claude mcp add …` command (URL, transport) appears anywhere in docs or code (`grep "claude mcp add"`: no hits). The re-auth handler sees the server is missing (`handlers.ts:32`) and still offers `claude mcp login`.

**CONN-9 (major): parser drift detection is half done.** Google parsers throw `ParseDrift` (`google/parse.ts:35,85,246,274,317`). It's classified `unknown` (verified), shown as "a run failed", and retried. The header comment's promise that "health can warn" (`parse.ts:3`) has no consumer: `ParseDrift` isn't referenced anywhere outside `parse.ts`. The Slack text parser has no drift detection at all (`slack/parse.ts`). A Slack MCP format change would silently drop recall (REC-1 records nothing, and the run still "succeeds"). Ask #2 ("still misses things") is directly exposed to this.

**CONN-10 (minor): rate-limit and serialization guards are per process.** The VDP limiter is "every VDP call this process makes" (`vdp/limiter.ts:2-4`, 55/min), but web (chat lookups, `server/datasource/db/index.ts:2772,2980`) and worker are separate processes. The devbar bridge "allows one in-flight call" (`util.ts:57`), but each `GoogleWorkspaceClient` has its own `Mutex` (`google/client.ts:236`), and it's instantiated in at least 6 places (`worker/index.ts:145`, `chat-be6.ts:538,741`, `jobs/handlers/{readin,forecast-sync,vdp-assets}.ts`).

**CONN-11 (minor): revoked VDP PAT vs lapsed cookie.** A 401/403 becomes `http_401` "PAT or gateway cookie refused" (`vdp/http.ts:234`), and the re-auth offered is the cookie refresh script, which can't fix a revoked PAT. When the cookie's `exp` is fresh and the call is still refused, the cause is the PAT: "ask your VDP admin for a new PAT".

**CONN-12 (minor): worker-down copy is for developers.** It says `npm run worker` "from the Command Center folder" (`components/health/NeedsYou.tsx:109`). The app is "Control Center", and an installed user runs LaunchAgents. Doctor gives the right command (`launchctl kickstart …`, `doctor.ts:505`). The port check treats "something is listening on 4327" as "web up" (`doctor.ts:422`), so another app on the port reads as healthy, and no check names the process.

**CONN-13 (minor): skill frontmatter repeats what code decides.** `model:`, `mcp_servers:` and `allowed_tools:` in `skills/scan-*.md` duplicate `SCANNER_MODEL` and `restrictedTools()` in `connectors.ts`. Not verified: whether the loader enforces them, or whether the code values win silently (`skill-loader.ts:22-26` parses them). Two sources of truth make it easy to add a connector wrong.

**CONN-14 (major, provider): Claude coupling inventory.**

| Coupling | Where | Portable? |
|---|---|---|
| Agent SDK `query()` with Claude Code harness options (`strictMcpConfig`, `canUseTool`, hooks, `maxBudgetUsd`, `settingSources`, `pathToClaudeCodeExecutable`) | 21 files import `@anthropic-ai/claude-agent-sdk`: `llm/skill-runner.ts`, `llm/one-call.ts`, `llm/chat/runner.ts`, `llm/readin/*`, `llm/research/*`, `scanner/completion/llm.ts`, `engines/nba/prompt/complete.ts:48`, `server/feedback/agent.ts`, `server/forecast/draft.ts`, `jobs/handlers/{readin,forecast-sync,vdp-assets}.ts`, `outbox/{relay,transport}.ts`, … | No: the whole tool loop |
| Slack/Org62 reads need MCP OAuth held by Claude Code | `mcp-config.ts:1-9,107-133`; `skill-runner.ts:505` | **Hard constraint**: see §4 |
| In-process `cc` MCP server | `llm/cc-tools/server.ts:5,13-21` (`createSdkMcpServer`) | Handlers (`callCcTool`) and zod `shapes` are SDK-free and portable |
| Model ids | `SCANNER_MODEL`/`ESCALATION_MODEL` (`llm/models.ts:7-8`) and literal ids in about 20 files (`jobs/handlers/activity-suggest.ts` 6, `activity-notes.ts` 4, `scanner/reconcile/reconciler.ts` 4, `engines/settle/run.ts`, `engines/vdp/identity-judge.ts`, …) | Easy once centralized |
| Cost | `MODEL_PRICES` with Anthropic cache-write/read tiers (`models.ts:22-26`); `total_cost_usd`/`modelUsage` from the SDK result (`skill-runner.ts:601`); cache-token columns across about 20 job handlers and `db/schema/llm.ts` | Needs a provider-neutral usage record |
| Prompt caching | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and stable-prefix design (`skill-runner.ts:24`, `org62PersonaVars` comment `connectors.ts:238-245`) | Concept portable (OpenAI caches automatic prefixes); savings differ |
| Error vocabulary | `authentication_failed`, `oauth_org_not_allowed`, `overloaded`, `529` (`errors.ts:25,41`, `skill-runner.ts:568`) | Per-provider mapping |
| Env and gateway | `ANTHROPIC_*`/`CLAUDE_CODE_*` stripping, `apiKeyHelper` passthrough (`llm/claude-env.ts`) | Claude-only, keep inside the adapter |
| Skills format | `skills/*.md` frontmatter + Run block rendered by `skill-loader.ts` | Plain prompts: portable |
| Existing seams | `Complete` (`engines/nba/prompt/complete.ts:21-45`), `SkillRunner` (`scanner/types.ts:498`), `QueryFn` test seam (`skill-runner.ts`), `OutboxTransport` (`outbox/gateway.ts`) | Good starting points |

## 4. LLM provider pluggability: analysis

**Key constraint.** For Slack and Org62, the model calls an MCP tool *inside a Claude Code process*. The `claude` child finds its own OAuth token for the server declared under the same name and URL (`mcp-config.ts:4-8`). We may not extract or copy that token. With OpenAI as the reasoning model, the options are:

| Option | How Slack/Org62 get read | Compliance | Cost / effort | Verdict |
|---|---|---|---|---|
| A. Keep Claude as the **connector runtime** | Our code asks for a read; a minimal `claude` run relays exactly one tool call with our arguments (`llm/one-call.ts`, already used by the Outbox relay and onboarding identity lookups). The reasoning model (any provider) never sees MCP | Unchanged: `claude -p` sessions only | One cheap Haiku relay per call; requires Claude Code + some Claude access even for an "OpenAI user" | **Next quarter** |
| B. Gateway-owned auth (like Google today) | If devbar `mcpgw` (or another sanctioned gateway) offers Slack/Org62 connectors, our MCP SDK client calls them directly with no tokens in the app (`google/client.ts:1-9` pattern) | Same posture as Google today | Needs no LLM for reads: cheaper and model-agnostic. Availability unknown | **Investigate first** (Open Q1) |
| C. Our own MCP OAuth client (`@modelcontextprotocol/sdk` `OAuthClientProvider` with `tokens()`/`saveTokens()` passed as the transport `authProvider`; Vercel `createMCPClient({authProvider})`) | User logs in once more, *to our app* | The app would **persist OAuth tokens**. Pointing the provider at Claude Code's keychain entry would be **copying tokens**: forbidden | M per server, plus keychain storage and refresh | **Blocker: needs Tristan** (D2) |
| D. Anthropic Messages API MCP connector (`mcp_servers` + `mcp_toolset`, beta `mcp-client-2025-11-20`) | Anthropic's servers call a public MCP URL with a token *we* pass | Requires handing a token to the request: forbidden; also can't reach `localhost` devbar | n/a | Rejected |

**Libraries for the reasoning side** (`ModelProvider`):
- **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`/`@ai-sdk/openai`): provider-agnostic `generateText`/`streamText` with tools and multi-step loops, structured output, normalized usage. It also has an MCP client (`createMCPClient`, `@ai-sdk/mcp`) with an `authProvider` for HTTP/SSE transports and session resume options ([AI SDK MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools), [createMCPClient reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client), [Vercel Connect + AI SDK](https://vercel.com/docs/connect/frameworks/ai-sdk-and-mcp)). It's the best fit for a second provider. Not verified: how exactly Anthropic cache tokens surface (likely provider metadata). Cost accounting stays in-house either way.
- **OpenAI Agents SDK (JS)**: `MCPServerStreamableHttp`/`MCPServerStdio` with a `toolFilter` (static allow/block via `createMCPToolStaticFilter`, or a callable filter) ([guide](https://openai.github.io/openai-agents-js/guides/mcp)). There's an open report that callable filters can leak filtered tool lists across agents through a module-level cache ([issue #695](https://github.com/openai/openai-agents-js/issues/695)). It's OpenAI-shaped, and it would be a third agent harness next to the Agent SDK. Not recommended.
- **LangChain / LlamaIndex**: too heavy for a local app with one tool loop. Neither solves the auth constraint. Skip.
- **Thin in-house interface over raw SDKs**: recommended as the *interface*. Implement it with the existing Agent SDK adapter first. Add a Vercel AI SDK adapter when someone actually needs OpenAI. The Anthropic API's own Tool Runner (`client.beta.messages.toolRunner` in `@anthropic-ai/sdk`) is a lighter Claude path than the Agent SDK for runs that need no Claude Code harness (from the claude-api reference loaded for this review).
- MCP TS SDK OAuth: the `OAuthClientProvider` contract (`tokens()`, `saveTokens()`, passed as the transport's `authProvider`) ([v2 OAuth guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.html), [provider interface](https://ts.sdk.modelcontextprotocol.io/v2/interfaces/_modelcontextprotocol_client.client_auth.OAuthClientProvider.html)). This is what option C would need.

**Recommended seams:**

```
ModelProvider        // reasoning only; no source knowledge
  complete({system, user, model, maxOutputTokens, budgetUsd, signal}) -> {text, usage}
  runTools({system, user, tools: ToolDef[] /* zod */, maxTurns, budgetUsd, onToolCall}) -> {text, usage, calls}
  structured<T>({schema, ...}) -> {value: T, usage}
  usage: {provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}
ConnectorRuntime     // how a read tool gets called; owns the allowlist and errors
  call(connectorId, tool, args, {signal}) -> {text, json}
  kinds: 'direct_mcp' (MCP SDK; gateway owns auth: Google, future Slack/Org62 if B)
         'claude_relay' (one-call through `claude`; Slack/Org62 today)
         'http_jsonrpc' (VDP), 'local_files' (Claude sessions)
```

The cc tools (`callCcTool` + zod `shapes`) become `ToolDef`s that any `ModelProvider` can loop over. The Agent SDK adapter keeps wrapping them with `createSdkMcpServer`.

**What this needs from the scanners (shared with the token-spend lane).** Traversal scans (the model chooses the Slack/Org62 calls) only work with a provider that can host MCP tools under Claude Code's auth. The portable shape is **fetch deterministically, then interpret**, which Gmail already uses. Slack's inbox scan is mostly fixed queries (search from:/to: me in a window, read threads), and REC-1 already records from tool results. Org62's scopes are fixed SOQL templates. Moving them to `ConnectorRuntime` fetches makes the interpret step provider-agnostic, and also likely cheaper (ask #3). A small model then classifies prefetched items instead of driving tools.

**Realistic sequencing:**
- **Next quarter:** `ModelProvider` interface + Agent SDK adapter. Route all 21 SDK imports through it and centralize model ids and prices. Build `ConnectorRuntime` with `claude_relay`, `direct_mcp`, `http_jsonrpc` and `local_files`. Convert the Slack inbox and the Org62 fixed scopes to fetch-then-interpret.
- **Later:** a Vercel AI SDK adapter for OpenAI/Gemini (reasoning only; reads still need option A or B), per-feature provider choice in Settings, and option C only if Tristan approves it.

## 5. Recommendations (prioritized)

1. **Connector manifest + registry (L, ~4 days).** Use one file per source, `src/connectors/<id>/manifest.ts`:
   ```
   { id, label, family /* 'google' */, domain?: 'org62'|'vdp',
     runtime: 'claude_relay'|'direct_mcp'|'http_jsonrpc'|'local_files',
     server?: { name, url?, addCommand?, loginCommand? },
     readTools: string[], auth: { kind: 'claude_mcp_oauth'|'devbar_gateway'|'pat_cookie'|'none', reauth: ReauthSpec },
     health: () => Probe, classify?: (err) => Classification,
     cadence: { baseMs, scopeMultiplier? }, scopes(ctx), skill: 'skills/scan-<id>.md',
     feeds: ProjectionId[], settings?: zod, onboarding: { reads, via? }, personas: PersonaId[] }
   ```
   Generate `ConnectorId`, the label maps, `REAUTH_KIND_OF`, `MCP_SERVER_NAME`, cadence defaults, the onboarding rows and the allowlists from the registry. Keep the existing ids as the canonical ones. Map `SourceKind` (`gemini`, `claude`) and the DB enum through **one** `sourceKindOf(connectorId)` function instead of eight. Migration path: no data change at first, because the registry reproduces today's values exactly (a test asserts parity with the current tables). Later, the enum can become a `text` column with a check constraint generated from the registry, which removes `ALTER TYPE` for new sources. Depends on lane DATA (data model) for the enum decision.
2. **Unified error taxonomy (M).**
   - One `classify(connector, err) → {cls, cause, nextStep, button?}` that composes per-manifest classifiers ahead of the generic signatures.
   - New causes: `server_not_declared`, `cli_missing`, `cli_outdated`, `llm_auth`, `llm_billing`, `parse_drift`, `pat_revoked`, `off_network`.
   - `unknown` stops being retried forever after N attempts.
   - `status-reason.ts` reads `cause` instead of re-parsing messages.
   No contract break: `statusReason` strings change wording only.
3. **Doctor in the UI (M).** Expose `runDoctor` as a read-only endpoint (it already redacts; `doctor.ts:4-8`) and render it on Health ▸ System and in onboarding step "sources". Each failing check shows its `fix` as a copyable command or button. Add checks for: LLM reachable (one cheap `claude -p` "ok" call, user-initiated, cost shown), minimum Claude CLI version, devbar minimum version, port 4327 owned by our process (pid match against the LaunchAgent).
4. **Fix the devbar paths (S).**
   - Separate `ENOENT` from "daemon down" in `diagnoseDevbar` and `devbarHandler.status()`.
   - Make `spawnDetached` wait for `spawn`/`error` before reporting.
   - Add a plain-language "What is devbar and how to get it" page linked from every devbar error.
5. **Drift as a health state (S/M).** Catch `ParseDrift` as `parse_drift`: degrade the connector with "Gmail's format changed; scans paused for this scope; report it" plus the feedback button (D-56 path). Add a Slack drift check: non-empty tool text that parses to zero messages is drift.
6. **`ModelProvider` seam (L).** Generalize `Complete` into the interface in §4. Make `AgentSdkProvider` the one implementation. Move every `query()` import behind it. A lint rule allows `@anthropic-ai/claude-agent-sdk` only in `src/llm/providers/anthropic-agent-sdk/**`. Centralize model ids in `models.ts`, with per-feature model settings read from there. Cost goes into a neutral `usage` record. The existing columns (`cache_read_tokens` etc.) stay, so no migration is needed. Coordinate with lane COST (#3/#5) and lane ASSIST (#4).
7. **`ConnectorRuntime` + fetch-then-interpret for Slack inbox and Org62 (L).** Reuse `runOneToolCall` as the `claude_relay` runtime, with the allowlist from the manifest checked before the relay. Converting the scans is a scanner-lane change (recall must not regress; replay the stress fixtures).
8. **Process-wide limits (S).** Move the VDP limiter and the devbar single-flight into the worker. The web asks the worker through a job, or a Postgres advisory lock serializes devbar calls across processes. Use one shared `GoogleWorkspaceClient` per process.
9. **Teammate copy (S).** Add `claude mcp add` instructions per server (URL from a team config, not hard-coded to Tristan, *tenet: Low upkeep, team-portable*). Fix the worker-down copy to a "Start worker" button that runs `launchctl kickstart` through the existing confirm-gated ops path, and show the right folder name. Add a PAT-revoked message for VDP.
10. **Single source for skill metadata (S).** Code decides the model and tools. Frontmatter keeps only `skill`/`version` and is checked against the manifest in a test.

### How to add a connector after Recs 1, 2, 6 and 7 (deliverable 5)

1. `src/connectors/<id>/manifest.ts`: id, label, runtime, server decl name, `readTools` (passes `assertReadOnly`), auth kind + reauth spec, cadence, scopes, feeds, onboarding copy, personas.
2. `src/connectors/<id>/fetcher.ts` implementing `DeterministicFetcher` (scopes, fetch with cursor, `listForReconcile`, `health`), calling only `runtime.call()`.
3. `src/connectors/<id>/parse.ts` + `__fixtures__/*.txt|json` recorded once, with drift detection (non-empty input with zero items throws `ParseDrift`).
4. `skills/scan-<id>.md`: interpret prefetched items with the shared `_scanner-common.md` and cc tools only.
5. Register in `src/connectors/registry.ts` (one line). Labels, onboarding row, re-auth, health row, cadence and persona toggles appear from the manifest.
6. Projections: add the id to the `feeds` of the projections that consume it (no code change if the `SourceItem` kinds are existing ones; a new kind is a projection-lane change).
7. Tests: parser fixtures, fetcher with a fake runtime (cursor idempotency: re-fetch gives the same `dedupeKey`s), manifest parity test, allowlist test (no write-like tool), classifier cases for its auth/network errors.
8. `npm run doctor` picks up the manifest's health probe. No DB migration if Rec 1's text-column step is done.

**Effort estimates.** Granola: about 2–3 days after the refactor (fetcher, parser and fixtures, skill, mapping to meeting notes, which overlaps Gemini notes), about 5 days today. I did not verify Granola's transport. If it's a remote OAuth MCP, it lands on `claude_relay` (or B). If it's local files or an API, `local_files` or `http_jsonrpc` with the same caveats as VDP (D1). A generic "any MCP server" connector: L (5+ days).
- The user picks a server already declared in Claude Code.
- The app lists tools and shows only reads that pass `assertReadOnly`; the user ticks the ones allowed.
- A generic interpret skill turns results into `SourceItem`s of kind `message`/`file_revision`.
- Health and re-auth come from `claude mcp list`/`login`.
- Risk: recall quality without a source-specific parser, and the read-only guard rests on name heuristics (`WRITE_LIKE`, `mcp-config.ts:48`), so the user's allowlist choice must be explicit and shown.

### Failure-mode catalogue (deliverable 3)

"Heal" means the app can fix it with no human step.

| Failure | Detected today | User sees today | Should see (cause · one next step · button) | Heal? |
|---|---|---|---|---|
| Claude Code not installed | `doctor.ts:124-127`; runtime `errors.ts:38` `executable_missing` | Health: "Slack inbox: a run failed" (verified) | "Claude Code isn't installed; the app reads Slack and Org62 through it." · Install link · [Check again] | No |
| Claude Code out of date | Not detected (version only printed, `doctor.ts:127`) | Odd SDK errors, "a run failed" | "Claude Code 2.x.y is older than this app needs (≥ …)." · `claude update` · [Copy] | Partial (could run `claude update` with confirm) |
| No LLM access / billing / usage limit | `errors.ts:25` (only API-key text); billing codes become `unknown` (verified) | "a run failed", or "Sign in to devbar" | "Claude refused: usage limit / no credit. Scans paused until <reset> or plan change." · [Open Settings ▸ Spend] | No |
| MCP server not declared (Slack/Org62) | `mcp-config.ts:116` throws; re-auth status `handlers.ts:32` | "a run failed"; button runs `claude mcp login` (fails) | "Slack isn't set up in Claude Code." · `claude mcp add --transport http slack <url>` then login · [Open Terminal] | No |
| Not logged in / OAuth expired | `classifyMcpStatus` `errors.ts:64`; `invalid_auth` `:27` | "needs re-auth" + Re-auth (Terminal) | Good; add "a browser opens; come back here" + auto re-probe (exists, `run.ts:2-3`) | No (browser) |
| Keychain MCP tokens wiped by concurrent `claude` processes (reported upstream, [mirror of issue](https://claudeissues.com/issue/93537-macos-concurrent-claude-processes-zero-mcp-oauth-entries-in-shared-keychain-blob); unverified) | Would read as `needs-auth` | Re-auth loops | Same as above, plus count re-auths per day; if frequent, cap concurrent `claude` runs | Mitigate |
| devbar missing | `doctor.ts:169` only | Health: "devbar daemon is not listening … Restart"; "started" on click (CONN-5) | "devbar isn't installed. Google (Gmail, Calendar, Drive, notes) needs it." · how to get it · [Check again] | No |
| devbar outdated | Not detected | Unknown errors | "devbar x.y is too old for the Google bridge." · `devbar update` | Partial |
| devbar signed out | `google/client.ts:219-221`, `handlers.ts:218` | "Sign in to devbar" (in-app, browser) | Good | No (SSO) |
| devbar daemon down | `google/client.ts:216` | "Restart the devbar daemon" (in-app) | Good, once separated from "missing" | **Yes** (auto-start once, then ask) |
| mcpgw Google connector not connected | `google/client.ts:222-224` | "Reconnect Google" (in-app) | Good | No (browser) |
| Gateway outage / "Streamable HTTP error" / maintenance | `gateway.ts:11,31`; `errors.ts:24,32`; `status-reason.ts:37-41` | "devbar's MCP gateway isn't answering (not your sign-in), retrying" | Good. Add "since HH:MM" and suppress notifications until it recovers | Yes (retry) |
| VDP: Zscaler/VPN off | `vdp/http.ts:226-228`; `handlers.ts:170-172` | Health: "VDP plans: temporarily unavailable, retrying" (hint lost, CONN-3) | "VDP is only reachable on the corporate network. Turn on Zscaler." · [Retry] | Yes (retries when back) |
| VDP: Okta cookie expired | JWT pre-check `http.ts:213`; persisted auth pause `connectors.ts:270-278` | "needs re-auth" + Run refresh | Good; run the silent refresh *before* expiry (10 min left, `VDP_COOKIE_MIN_S`) without a click. Not verified whether anything does this today | **Yes** (silent refresh) |
| VDP: Okta MFA lapsed | `handlers.ts:163-165`, `run.ts:38` auto-escalates to window | Terminal + browser for MFA | Good | No (MFA) |
| VDP: PAT missing/revoked | `http.ts:144` (missing); revoked becomes `http_401` (`:234`) | "PAT or cookie refused" + refresh (won't help) | "Your VDP access token was refused. Ask your VDP admin for a new PAT." | No |
| VDP refresh script / Playwright missing | `handlers.ts:120-126,146-148` | Clear message + install command | Good | No |
| Rate limit (Slack/Google/VDP/Org62) | `errors.ts:33`; Google `client.ts:107`; VDP 429 `http.ts:235`; limiter per process (CONN-10) | "rate limited, retrying" | Good; make limits process-wide | Yes |
| Parser schema drift | Google `ParseDrift` (classified unknown); Slack none (CONN-9) | "a run failed" / silent | "Gmail's format changed; this scope is paused. [Send report]" | No (needs a code fix), but stop retrying |
| SOQL invalid (Org62 schema change) | `errors.ts:36` `soql_invalid` → config | Not verified wording ("a run failed" likely) | "Org62 rejected a query field; scope paused. [Send report]" | No |
| Postgres down | `doctor.ts:67` | UI behavior not verified | Full-page "The database isn't running." · `brew services start postgresql@17` · [Start] | Partial (start via brew with confirm) |
| Migrations behind | `doctor.ts:88`; worker blocked state `doctor.ts:502` | Health "waiting" banner | Good; button "Run update" | Partial |
| Worker not running | heartbeat `doctor.ts:490-505`; UI `NeedsYou.tsx:98-110` | "npm run worker … Command Center folder" | "The background worker stopped." · [Start worker] (launchctl kickstart) | **Yes** (LaunchAgent KeepAlive; button) |
| Port 4327 taken | Not detected; `doctor.ts:422` treats an open port as "web up" | Web fails to start; nothing in the UI (the UI can't load) | Doctor/CLI: "Port 4327 is used by <process>." · stop it or set `PORT` | No |

## 6. Compliance note (deliverable 6)

- **Fine today:**
  - Claude-side MCP decls copy only non-secret fields and drop `headers` (`mcp-config.ts:118-125`; Outbox the same, `outbox/mcp-config.ts:10-12`).
  - Child env strips `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_*` (`claude-env.ts:20-35`).
  - `apiKeyHelper` is passed through and never executed or logged (`claude-env.ts:40-41`).
  - devbar's client never sees tokens (`google/client.ts:9`).
  - Re-auth never touches credentials (`reauth/handlers.ts:1-4`).
  - Error text is scrubbed of literal header values (`vdp/http.ts:151-156`).
  - The `connectors.config` column is documented as non-secret (`db/schema/connectors.ts:37`).
- **Needs a decision: VDP.** The app process reads the PAT and session cookie from `~/.claude.json` on every call and sends them as headers (`vdp/http.ts:131-148,218-224`). It also base64-decodes the cookie JWT to read `exp`/`iat` (`:88-110`, `ops/mcp.ts:58-66`). Nothing is persisted or logged, but strictly this is "the app using a token", not "an MCP connection through Claude". README:31 says the app never asks for or stores a token, which is true, but it doesn't say the app *reads and uses* one. See D1.
- **Avoid in any provider work:**
  - Never point an MCP SDK `OAuthClientProvider` at Claude Code's keychain item. Third-party reports say MCP tokens sit in the shared "Claude Code-credentials" keychain blob ([report](https://letsdatascience.com/news/claude-code-keychain-design-exposes-oauth-credentials-268ba827)). Reading it would be token extraction.
  - Never pass a token into an Anthropic `mcp_servers` request.
  - Never write tokens to `vdp_records`, `scan_runs`, traces or the feedback payload (keep the guard tests).
- **Add:** a guard test that only `src/connectors/vdp/http.ts` and `src/ops/mcp.ts` may read `mcpServers.*.headers` (the `http.ts` header says a guard exists for imports; extend it to the `headers` field), plus a `scan:private`-style check for `Bearer `/`central_proxy_session=` in logs and traces.

## 7. Decisions for Tristan

- **D1: VDP transport posture.**
  - (a) Keep direct HTTP, documented as "uses the same MCP entry as Claude Code; values only in memory".
  - (b) Route VDP reads through a `claude` relay (`one-call.ts`), so the CLI sends the headers. This costs a Haiku turn per call: about 500 items/mirror and 55 calls/min. Slower and more expensive.
  - (c) Ask the VDP owners for a gateway-managed (devbar-style) connector.
  **Recommend (a) now plus (c) as the ask.** (b) costs too much for a 30-min mirror. Flagged as a possible conflict with the stated compliance basis.
- **D2: How non-Claude users read Slack/Org62.**
  - (A) Claude remains the connector runtime: Claude Code is required for everyone.
  - (B) Sanctioned gateway connectors.
  - (C) Our own MCP OAuth login with app-stored tokens (**blocker**: conflicts with *never copy/persist tokens* as Tristan framed compliance).
  **Recommend A next quarter, pursue B.**
- **D3: The enum for connector ids.** Keep the pg enum and accept a migration per new source, or move to `text` + a generated check. **Recommend text + check** (a one-time migration). Coordinate with the data-model lane.
- **D4: When to build a second provider adapter.** Recommend building the seam now and an OpenAI adapter only when a named teammate needs it (*tenet: Fast to ship*).

## 8. What's fine, don't touch

- The scanner allowlist gate design: no bare `allowedTools`, the `canUseTool` gate as sole approver, `disallowedTools` keeping schemas out of context, the `assertReadOnly` regex (`skill-runner.ts:487-510`, `mcp-config.ts:46-57`). Also Google's two-lock allowlist (`google/client.ts:23-81`).
- Outbox separation: its own MCP config, guard test, fail-closed transports (`outbox/mcp-config.ts:1-12`, `transport.ts:1-20`).
- Re-auth handlers: confirm-gated, credentials never pass through, VDP MFA auto-escalation, `O_EXCL` refresh lock (`reauth/handlers.ts:60-82,144-177`).
- Gateway-outage handling and its wording (`gateway.ts`, `errors.ts:24,32`).
- `DeterministicFetcher` as the base of the future `Connector` interface. `encodeCursor`/`dedupeKey`/`contentHash` idempotency.
- `Complete` and `SkillRunner` seams, and the SDK-free cc handlers.
- `doctor`'s content and its redaction discipline. It needs a UI, not a rewrite.

## 9. Open questions / not verified

1. Does devbar `mcpgw` (or a sanctioned gateway) offer Slack or Org62 connectors? That decides option B. Check `devbar mcpgw connectors list` on a work machine; devbar isn't installed here.
2. Whether skill frontmatter `allowed_tools`/`model` is enforced or ignored at load (CONN-13).
3. What the web shows when Postgres is down (couldn't run the db mode here).
4. Whether anything refreshes the VDP cookie proactively, before expiry, without a click (I didn't find a scheduler for it, but didn't trace every job).
5. Granola's transport (remote MCP vs local API) and its auth model.
6. The keychain-concurrency token-wipe report and the keychain storage details come from third-party sources, not Anthropic docs.
7. How the Vercel AI SDK surfaces Anthropic cache-token usage (for cost parity); and whether the OpenAI Agents SDK filter-cache issue is fixed.

Sources: [AI SDK MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) · [AI SDK createMCPClient](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client) · [Vercel AI SDK and MCP](https://vercel.com/docs/connect/frameworks/ai-sdk-and-mcp) · [OpenAI Agents JS MCP guide](https://openai.github.io/openai-agents-js/guides/mcp) · [openai-agents-js #695](https://github.com/openai/openai-agents-js/issues/695) · [MCP TS SDK OAuth (v2)](https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.html) · [OAuthClientProvider](https://ts.sdk.modelcontextprotocol.io/v2/interfaces/_modelcontextprotocol_client.client_auth.OAuthClientProvider.html) · [Keychain exposure report](https://letsdatascience.com/news/claude-code-keychain-design-exposes-oauth-credentials-268ba827) · [Concurrent keychain wipe issue mirror](https://claudeissues.com/issue/93537-macos-concurrent-claude-processes-zero-mcp-oauth-entries-in-shared-keychain-blob) · Anthropic Messages API MCP connector and Tool Runner facts from the bundled `claude-api` skill reference.
