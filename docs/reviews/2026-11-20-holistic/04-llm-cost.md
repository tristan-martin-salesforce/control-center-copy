# 04 · LLM cost (LLM-COST reviewer)

Scope: owner's ask #3 (scanning ~$10/day, first scan expensive, cheaper models need a concise tool set and short instructions) and the plumbing half of #5 (estimate, reserve, soft-continue). The Assistant's budget UX belongs to ASSISTANT; closure correctness belongs to SCANNER-QUALITY; the provider abstraction belongs to CONNECTORS-PROVIDERS.

Prices are from the `claude-api` skill (cached 2026-10-06), not from memory:

| Model | Input $/MTok | Output $/MTok | Cache read | Cache write (5 min / 1 h) | Notes |
|---|---|---|---|---|---|
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.01 | 0.125 / 0.20 | **$0.50 / $2.50 above 100K prompt tokens per request**; min cacheable prefix 512 tokens |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 0.20 | 2.50 / 4.00 | 20× Haiku |
| `claude-opus-5-5` | 4.00 | 20.00 | 0.20 | 5.00 / 8.00 | |
| Message Batches | 50% of the above | | | | Messages API only, not through `claude -p` |

`src/llm/models.ts:22-26` holds the same figures, including Haiku's long-prompt tier. They agree with the skill.

## 1. Summary

1. **The model tier isn't the problem any more. Fixed overhead × run count is.** Every background scanner already runs on Haiku 5.5 (`src/llm/models.ts:7`, all `scan-*` frontmatter). The money goes on: a ~42K-token prefix per Agent SDK run (`src/llm/skill-runner.ts:55-60`), re-read on every turn of a 5-30 turn loop; polls every 2 min (inbox) and 10 min (channels) (`src/scanner/runtime/cadence.ts:10-13,51`); and the long-prompt tier. The skill's own note says a quiet Slack traversal costs ~$0.008 (`src/scanner/precheck/slack.ts:3`). At 300-1,000 Slack runs a day that alone is $2.50-8.
2. **Haiku 5.5's >100K tier (5× price) is being hit and nothing guards it.** The tripwire checks only the first call, and its limit for Gmail is ~97K (`skill-runner.ts:59-60,569-579`). Tool results pile up turn after turn and are never shrunk (`skill-runner.ts:481-485`), although the SDK supports `updatedToolOutput` (`sdk.d.ts:2767`). The measured "$0.06 per 25-item window" (`src/scanner/runtime/connectors.ts:283-286`) only adds up at the long-tier rate.
3. **The model is used as a transport.** Slack and Org62 reads go through a model turn, and so does the D5 "no-op pre-check": one LLM relay per search, three for the inbox (`precheck/slack.ts:10-11`, `src/llm/one-call.ts:125-147`). Google reads already use a direct MCP client with zero tokens (`src/connectors/google/client.ts:1-9`). The SDK's control protocol has an `mcp_call` that "invokes an MCP tool … without a model turn" (`sdk.d.ts:4897`), but 0.3.316 has no public method for it. Making Slack and Org62 reads deterministic is the biggest single lever. **That is Decision 1.**
4. **The skills are mostly procedure, and the prompt pays for it every turn.** `_scanner-common` + `scan-slack` come to 31.7K chars (~8.8K tokens), and `scan-org62` comes to 40.8K. About half of it is code-shaped: exact queries, paging, coverage, cursors and recording fields. On top of that, a 60-item open-items pack (`src/llm/skill-loader.ts:128-170`) is re-sent to every run, duplicating `cc_find_candidates`. The target is tool-less, batched classification calls with a ≤1.5K-token skill and strict JSON out.
5. **Budgets are eight independent kill switches, not a plan.** Today there are: per-run caps that fail the run (`skill-runner.ts:580-585,612-614`) and retry with half the items (`scanner-runtime.ts:1119-1122`); a daily hard cap that pauses until midnight (`scanner-runtime.ts:645-650`); read-in $2, triage escalation $1, chat $3 + $0.25 a message (`src/contract/settings.ts:243,248,345`); first scan $25 (`src/contract/onboarding.ts:83`); and per-skill and per-job constants. Only the first scan has an estimate, and that one is a static table (`src/server/onboarding/cost.ts:18-42`). One envelope model replaces all of this: an estimate from `llm_calls` p50/p90, a reservation against that estimate, and a raised hand at the soft line. The pause can be done without killing the session by awaiting in the existing `canUseTool` gate (`skill-runner.ts:487`).

Target, with the assumptions in §4.2: **background scanning ≤ $0.50/day** (from ~$6-8). **All-in ≤ $2-3/day** including user-initiated Sonnet. **A 30-day first scan of $1-3** (from $16.24 measured).

## 2. How it works today

| Piece | Where | What it does for cost |
|---|---|---|
| Traversal runner | `src/llm/skill-runner.ts:358-730` | One Agent SDK `query()` (a `claude` subprocess) per scan step. It sets `systemPrompt: [common+skill, BOUNDARY, context pack+persona]` (`skill-loader.ts:176-178`), `tools: []`, `strictMcpConfig`, the connector's read tools + 10 `cc_*` tools, `effort: 'low'`, `settingSources: ['user']`, `maxTurns`, `maxBudgetUsd`. A running estimate aborts at the cap (`:580-585`). The prefix tripwire runs on the first call only (`:569-579`). |
| Triage / escalation passes | `skill-runner.ts:182-306` | After a Slack traversal: batches of messages that still need a verdict go to `triage-slack` (Haiku); `unsure` ones go to Sonnet within `triageEscalationUsdPerDay` (D6). |
| Relay (one MCP call) | `src/llm/one-call.ts:84-201`, `skills/read-lookup.md` | A model turn that only relays a fixed tool call (pre-check, Org62 lookups, identity, Outbox). `$0.03` cap, 2 turns. |
| Tool-less one-shot | `src/scanner/completion/llm.ts:34-90`, `src/engines/nba/prompt/complete.ts:47-85` | `maxTurns: 1`, no MCP. Completion batches 6 items per call (`completion/pass.ts:76-80`). Settle is one call per item, plus an escalation (`engines/settle/run.ts:96-118`). |
| Deterministic fetchers | `src/connectors/google/*`, `claude/sessions.ts` | Gmail, Calendar, Drive, Gemini and Claude sessions are fetched with no model (direct MCP via devbar). Items are prefetched into the agent's prompt (`skill-runner.ts:396-414`). |
| Cadence | `src/scanner/runtime/cadence.ts` | Base intervals: Slack 2 min, Gmail 3, Calendar 5, Drive/Gemini/Claude 10, Org62 30. Off-hours ×6, quiet backoff ×2…×8, max slowdown 4 h. Slack channels ×5. |
| Budget | `scanner-runtime.ts:642-680`, `store-db.ts:2279-2284` | Before a job: compare today's spend to the hard cap (pause until midnight), then reserve the job's **cap** (worst case) against it (D6). The first scan has its own one-time ledger (`first-scan.ts`). |
| Booking | `src/scanner/runtime/spend.ts`, `src/db/schema/llm.ts:36-78` | One `llm_calls` row per pass. Fields: model, tokens split into uncached/cache read/cache write (D0), trigger, model_reason, content_hash, outcome. `llm_decisions` records skips, blocks and escalations. |
| Reporting | `scripts/scan/report.ts`, `src/engines/spend-audit/aggregate.ts` | $/skill/model, cache hit %, identical repeats, decisions, and settle-escalation changed%. |

### 2.1 Status of the 2026-11-13 audit's lane D

| Item | Status | Evidence |
|---|---|---|
| D0/D1: cache tokens on every call | **Mostly done.** One gap: `agentSdkComplete` folds cache reads and writes into `inputTokens` (NBA, voice) | `usage.ts:2`, `spend.ts`, `nba/prompt/complete.ts:74` |
| D2: automatic read-ins on Haiku, skipped on the same evidence | Done | `jobs/handlers/readin.ts:131,192`, `CHANGELOG.md:125` (Haiku ≈ 1/15 of the cost) |
| D3: Claude sessions without a model on busy↔idle, ≤ 1 call per 5 min per session | Done | `connectors/claude/sessions.ts:87-138,494` |
| D4: does settle's Sonnet escalation change the verdict? | Measured; the policy is not yet decided on that data | `jobs/handlers/settle.ts:120,197`, `report.ts:55` |
| D5: Slack no-op pre-check | Done, **but through LLM relays** (COST-3) | `precheck/slack.ts` |
| D6: reserve before the call; relay guards; first scan $100 → $25 | Done. It reserves the cap, not an estimate | `scanner-runtime.ts:655-670`, `relay-guard.ts`, `onboarding.ts:80-83` |

## 3. Findings

### 3.1 Cost model: where each dollar goes

**Anchors (real data).**
- 2026-11-13 audit, 4.6 days, $71.67: Slack scan 28%, Claude sessions 17%, read-ins 13%, settle 11%, chat 10%, rest 21% (`docs/reviews/2026-11-13-app-audit.md:98-106`).
- The 30-day first scan, measured: $16.24 = scan $12.34 + read-ins $3.90 (`cost.ts:34-37`).
- 14-day first scan: Slack $3.66 of $5.15 scan (`cost.ts:32-33`).
- A quiet Slack traversal ≈ $0.008 (`precheck/slack.ts:3`).

`sample-data/llm_calls.json` is synthetic. Its dollars are calibrated per day ($0.23-$28.71/day, median ~$3.6) and its Haiku rows are priced at the long tier on summed tokens (`sample-data/generators/data/ops-lib.ts:30-37`, ratio 5.0 vs the standard rate on 590 of 594 Haiku rows). Its token columns are not evidence. I use it only for shape. It agrees on shape: Slack 37.5% of $138 / 31 days, then Sonnet drafts + read-ins 19%.

**Today's ~$10/day, my reconstruction.** These are estimates: the post-D2/D3/D5 split is not in any doc, and I had no live DB.

| Bucket | Model | Driver | Est. $/day | Share |
|---|---|---|---|---|
| Slack traversal + triage + escalation | Haiku (+ Sonnet ≤ $1) | 300-1,000 runs × $0.004-0.02, long tier on busy runs | 3.5-5.0 | ~40% |
| Other scanners (Org62, Gmail, Drive, Gemini, Calendar, watch, trainings) | Haiku | 25-item windows with ~25K+ prompts, multi-turn | 0.8-1.5 | ~12% |
| Claude sessions (after D3) | Haiku | ≤ 1 call per 5 min per active session | 0.5-1.0 | ~8% |
| Settle + completion | Haiku (+ Sonnet on ~38% of items, settle) | one call per item (settle), 6 per call (completion) | 0.8-1.2 | ~10% |
| Read-ins | Haiku (auto) / Sonnet (asked) | evidence-hash skip | 0.3-0.8 | ~5% |
| Drafts, NBA, briefs (`brief-opportunity` is Sonnet, daily) | Sonnet | user-facing quality | 1.0-2.0 | ~15% |
| Assistant (chat) | Sonnet | user-driven (ASSISTANT lane) | 0.5-1.5 | ~10% |

**Per-call anatomy of a Slack traversal, first request.** Measured total 41.9K tokens (`skill-runner.ts:56-58`).

| Part | Size | Tokens (approx.) | Cached across runs? |
|---|---|---|---|
| CLI system scaffolding + the in-process `cc` tool schemas (10 tools, 10.3K chars JSON, measured with zod-to-json-schema) + 4 Slack MCP read-tool schemas | (not sent by us) | 13-19K (the residual in `skill-runner.ts:56-58`; `TOOL_OVERHEAD_TOKENS = 24_000` at `:68`) | Yes, while the toolset is the same (tools render first) |
| `_scanner-common.md` | 14.2K chars | ~4.0K | Yes (before the boundary) |
| `scan-slack.md` | 17.5K chars | ~4.9K | Yes |
| Context pack (60 open items, 25 initiatives, aliases, watch list) + persona | ~25-35K chars JSON | ~12-16K | Only within a scope inside 5 min; re-written per scope |
| Run block + step instruction | ~1-2K chars | ~0.5K | No (runId, window) |
| Each later turn: tool results (20 detailed hits per page, up to 3 pages × 4 queries, plus 5 thread reads) | 5-60K chars/turn | grows 2-25K/turn | Written once (1.25×), then read |

Cache share: 77-81% of prompt tokens are cache reads in every scanner skill (sample shape). This matches the D0 report's design, so caching is not the gap. The gaps are size × turns × runs, and the 5× tier.

**Unit costs on Haiku 5.5:**
- a warm 42K turn ≈ $0.0004;
- a cold write of the same ≈ $0.0053;
- 1.5K of output ≈ $0.00075;
- the same turn at 105K: read ≈ $0.0053 and output ×5.

So one cold start costs as much as ~13 warm turns, and one long-tier turn costs as much as ~12 normal ones.

**First scan (30 days ≈ $12.34 scan).** Why it is expensive:
1. Slack inbox history is cut into 2 h chunks (`connectors.ts:146-151`), because Haiku-in-a-loop dropped asks in windows of more than ~9 messages (SLK-1, `docs/ui/STRESS.md:33`). That makes 360 inbox runs for 30 days and +240 for the deep 60 days (`connectors.ts:152-154`), each paying a cold-ish ~40K prefix and 10-40 turns (`maxTurns` 40 for backfill/head, `connectors.ts:183`).
2. Pages beyond 3 per query become continuation runs, each re-paying the prefix.
3. Busy windows cross 100K per turn (COST-2).
4. Cost-cap failures re-run at half size (MIN-25, $2.14 of the 30-day run).
5. Read-ins were on Sonnet then ($3.90); D2 has fixed that.

Without structural change, my estimate for a 30-day first scan today is $8-14.

### 3.2 Findings

**COST-1 (major): Scanner cost is overhead × frequency; the model tier is already the cheapest.**
- Evidence: every `scan-*` skill and `SCANNER_MODEL` is `claude-haiku-5-5` (`models.ts:7`); cadence is `cadence.ts:10-21,51`; the quiet-run cost is `precheck/slack.ts:3`.
- Slack runs a day, inbox: 330 max in work hours at 2 min, ~40 at full quiet backoff.
- Slack runs a day, per channel: 66 max at 10 min, ~8 quiet.
- With 10-15 channels: 150-1,100 runs a day.
- Why it matters: "use lower-tier models" will not move the bill. Haiku 5.5 is already $0.10/MTok. Only fewer runs, fewer turns, smaller prefixes and staying under 100K will.

**COST-2 (major): The long-prompt tier is hit, and only the first request is guarded.**
- Evidence:
  - the tripwire runs once (`skill-runner.ts:569-579`), with limits up to ~97K (`:59-60`);
  - Gmail's first call is already 78.6K (`:60`);
  - nothing caps later turns;
  - `postToolUse` returns `{}` (`:481-485`), so raw MCP results (`response_format: 'detailed'` is forced, `:493`) stay in context;
  - MIN-25's "$0.063 / $0.061 per 25-item window" (`connectors.ts:283-286`) is ~1.2M cached tokens at the long-tier read price, versus ~6M at the standard price, and the first is the only plausible one.
- Why it matters: busy runs and first-scan runs probably cost 3-5× what they would at the same token volume under 100K. (Not verified against a live per-request trace; Rec 1 measures it.)

**COST-3 (major): Deterministic reads cost a model turn.**
- Evidence:
  - The relay spawns a `claude` CLI with the read tool's schema and a 1K-char skill (`one-call.ts:125-147`).
  - The pre-check issues 1 relay per search: 3 for the inbox, 1 per channel (`precheck/slack.ts:33-48`).
  - Org62's SOQL in the skill is fixed text (`skills/scan-org62.md` §2), yet the model issues it and pages it.
  - Google already proves the direct path: "No LLM is involved: the worker calls the 36 read tools directly" (`google/client.ts:4-5`).
- Why it matters: the pre-check's saving may be close to zero for the inbox (3 relays of ~5-15K tokens each against a ~$0.008 traversal). Every Org62 page costs a turn of the 40.8K-char skill. Not verified: measure the `slack-precheck` skill's $/run in `scan:report`.

**COST-4 (major): Most of the skill text is procedure the runner already enforces, or could.**

| Skill section | Chars (approx.) | Already in code / could be code |
|---|---|---|
| `scan-slack` §2 "Exact tool calls" (S1-S4, C1, C1′, T1, params "verbatim") | ~4.5K | The query args are already built in code for the pre-check (`precheck/slack.ts:33-48`) |
| `scan-slack` §2 Paging, §8 coverage + `cc_finish` cursor | ~2.5K | The runner restates coverage itself for Org62 (`skill-runner.ts:651-697`); same pattern |
| `scan-slack` §4 recording fields | ~1.5K | REC-1 auto-records (`slack-rec.ts`); the skill says "don't call cc_record_source_items" |
| `_scanner-common` R2 placeholders, R3 order, R10 coverage, R11 prefetch header | ~4K | Runner concerns |
| `scan-org62` §2 queries, §3 paging, §4 recording, §9 coverage | ~12K | REC-2 records rows from the SOQL result (`org62-rec.ts`); ORG-3/5/6 fix the agent's paging after the fact (`skill-runner.ts:651-697`) |
| Linking procedure (R5, §6) | ~3K | Deterministic joins: thread ref, file ref, counterpart, account; the model only judges the ambiguous rest |

- Why it matters: the judgment that needs a model (is this an ask of me, a commitment, a completion, which candidate) fits in ~1.5K tokens of rules plus 3-4 examples. Everything else makes Haiku "smart" by instruction, and it is paid every turn.

**COST-5 (major): The context pack ships 60 open items to every run, and `cc_find_candidates` exists as well.**
- Evidence: `skill-loader.ts:128-170`, `cc-tools/schemas.ts:187`.
- Every run re-sends ~12-16K tokens after the boundary (so it isn't shared across scopes) to help with linking. The same run can then call `cc_find_candidates`, which also costs a turn.
- Why it matters: per-message candidates found deterministically (≤ 5 per message, attached to the message) are smaller and more relevant than a top-60 list. This also bears on ask #8, DB vs RAG: indexed joins beat embeddings here.

**COST-6 (major): The first scan replays the live agentic design over history.**
- Evidence: `connectors.ts:146-154,183-184`, `cost.ts:30-40`, SLK-1.
- Small windows are a quality workaround for in-loop extraction, and they multiply prefix payments.
- The Batch API (50%) is not reachable through `claude -p` (Messages API only; see Decision 2).
- Why it matters: this is the "original scanner is pretty expensive" complaint, and a new teammate meets it on day one.

**COST-7 (major): Budget mechanics kill work and don't estimate.**

| Cap | Where | On breach |
|---|---|---|
| Per-run `costCapUsd` (0.03-0.25 by scope/mode) + SDK `maxBudgetUsd` | `connectors.ts:184,222,286`; `skill-runner.ts:517,580-585,612-614` | Run fails `cost_cap`; retried with half the items (`scanner-runtime.ts:1119-1122`) |
| Daily soft / hard | `settings.ts:237-253`; `scanner-runtime.ts:645-652` | Soft: a log line only. Hard: traversal paused until local midnight |
| Reservation of the run's cap | `scanner-runtime.ts:655-670`; `store-db.ts:2279-2284` | Refused → paused 10 min. The worst case is held, so parallel scopes starve early |
| Read-ins $2/day | `settings.ts:243` | Skipped |
| Triage escalation $1/day | `settings.ts:248`; `skill-runner.ts:248-262` | Unsure → flagged to Triage |
| Settle stronger-model $/day | `jobs/handlers/settle.ts:14,68-72` | Cheap verdict kept |
| Chat $3/day, $0.25/message (Sonnet), research $0.50 | `settings.ts:338-345`; `llm/chat/runner.ts:160-172,227-252` | Message stopped with an "Allow $N more" offer |
| First scan $25 one-time | `onboarding.ts:83`; `first-scan.ts` | Backfill stops |
| Per-skill / per-job constants (`budget_usd_per_run`, `PER_CALL_USD` 0.01, `$0.15 a pass`) | skill frontmatter; `activity-suggest.ts:143`; D-66/D-71 | Call refused |

- Only the first scan shows an estimate, and it is a static per-lookback table (`cost.ts:40`) that is already stale after D2.
- Why it matters: this is ask #5 exactly. Caps fire on the wrong unit (one run), at the wrong time (mid-run), with the wrong action (fail, then retry smaller, which costs more in total).

**COST-8 (minor): Scanners and relays load the user's Claude settings.**
- Evidence: `settingSources: ['user']` (`skill-runner.ts:512`, `one-call.ts:136`), while the completion and NBA paths use `[]` (`completion/llm.ts`, `complete.ts:59`).
- A teammate's `~/.claude/settings.json` (hooks, plugins, output style, env) then applies to every scan call. The 13-19K "hidden" tokens have never been broken down.
- Why it matters: cost and behavior drift per machine (*tenet: Low upkeep, team-portable*). Not verified what is injected: `getContextUsage()` (`sdk.d.ts:3120-3130`) can tell.

**COST-9 (minor): One cache entry per (toolset, skill), with no shared prefix.**
- The render order is tools → system → messages. The 10 `cc` tools plus each connector's MCP tools come first, so the shared `_scanner-common` text only caches within one connector's skill.
- The triage pass loads `_scanner-common` too (`skill-runner.ts:392-393` loads it for any skill path), and its toolset differs (`CC_TRIAGE_TOOL_NAMES`), so its prefix is separate.

**COST-10 (minor): Settle doesn't batch, and its escalation is unproven.**
- One Haiku call per item (`settle/run.ts:77`), then Sonnet on `unclearVerdict` (`:37`): ~38% of items at 20× the price (audit D4).
- Completion batches 6 per call (`completion/pass.ts:76-80`).

**COST-11 (minor): Automatic Sonnet work exists outside the user's asks.**
- `brief-opportunity` (Sonnet, daily via `brief.generate`), `nba-*` Sonnet skills and `draft-*` run on Sonnet. In the sample shape, drafts plus read-ins are 19% of dollars at $0.29-0.97 per call.
- Drafts the user reads deserve Sonnet. Automatic background briefs need a measured case.

**COST-12 (minor): The measurement can't prove savings yet.**
- `llm_calls` (`schema/llm.ts:36-78`) has no first-request prompt size, max per-request prompt (the long tier), turns, tool count or schema tokens, items in/out, or closure attribution.
- `scan:report` has no $/item-found or $/item-closed view.

## 4. Recommendations

### 4.1 Target architecture for cheap scanning

```
signal (file watch, pre-check, schedule) ─▶ deterministic fetch (no model) ─▶ deterministic rules ─▶ batch classify (Haiku, no tools, JSON) ─▶ code applies
                                                    │ zero new / unchanged hash: stop        │ thread/file/person join = link                │ unsure + measured benefit
                                                    ▼                                         ▼                                               ▼
                                                  record coverage + cursor                  record + link (no model)                  escalate (Sonnet, capped)
```

1. **Fetch deterministically.** Google is already done this way. For Slack and Org62, see Decision 1: either the SDK's `mcp_call` (no model turn, still through `claude`, allowlist enforced in our code) or a direct MCP client the way devbar does it for Google. Paging, coverage and cursors are owned by code; the ORG-3/5/6 corrections become the main path.
2. **Pre-filter without a model.** These cases need no call:
   - no new message, or the same content hash;
   - bot, join or emoji-only messages;
   - my message in a thread with no ask;
   - a thread or file match onto an open item, which is a link at fixed confidence;
   - a known noise verdict carried forward (TRI-NOISE).

   Only items left unresolved after these rules reach a model.
3. **Classify in batches, with no tools.** One call per batch of 10-30 messages (or 6-10 docs/emails). Each message carries its conversation lines and ≤ 5 deterministic candidates. The output is strict JSON (SDK `outputFormat: {type:'json_schema'}`, `sdk.d.ts:2036`):

   ```json
   {"verdicts":[{"ref":"…","v":"ask|commitment|completion|context|noise|unsure","candidate":"wi_…|null","conf":0.0,"why":"≤80 chars"}]}
   ```

   The triage pass already proves that Haiku handles 120 messages a run in this shape (`connectors.ts:152-153`). It also removes the reason for SLK-1's 2 h chunks, because the model never has to keep a loop state.
4. **Escalate only with a measured benefit.** Send `unsure` items to Sonnet only while D4/D-style data shows a changed-verdict rate above a threshold (suggested: ≥ 15% changed and ≥ 1 changed close a week). Otherwise send them to Triage.
5. **Share one cached prefix.** The order is a fixed tool list (empty for classify calls), then one `classify-common` rules block (~1K tokens) before the boundary, then the per-connector delta, then the batch. All classifiers share the first breakpoint. Above 512 tokens it caches on Haiku 5.5.
6. **Make cadence signal-driven.**
   - Claude sessions and Drive local: file watch.
   - Slack: the zero-token pre-check, then a traversal only on "found". The interval can then drop to 1-2 min, because an empty poll costs nothing.
   - Org62: `SystemModstamp > cursor` count first.
   - Calendar: diff by hash (already done).

   Polling stays only as the safety net.
7. **First scan.**
   - Fetch every window deterministically, then classify in large batches, ordered as today (FS-ORDER).
   - Add a pre-run estimator (§4.3). It counts items per source with zero-token reads, then multiplies by $/item p90 for each skill.
   - A Batch API path exists only if Decision 2 allows direct API calls.

### 4.2 Proposed per-skill model and budget (target)

Assumptions (busy SE weekday):
- Slack: ~250 new messages a day reach rules, ~80 of them need a model verdict.
- 40 emails, 15 calendar changes, 10 Drive revisions, 4 meeting notes, 6 Claude-session changes, 30 Org62 changed rows.
- 50 open items checked for completion.
- 10 user-asked drafts or read-ins.
- Classify call: 3K cached prefix + 6K uncached batch + 800 out ≈ $0.0011 (≤ 100K always).

| Skill (target name) | Model | Tools | Skill length | Batch | Calls/day | $/call | $/day |
|---|---|---|---|---|---|---|---|
| `classify-slack` (replaces the scan-slack traversal + triage-slack) | Haiku 5.5, effort low | none | ≤ 1.5K tok | 20 msgs | 4-8 | 0.001-0.002 | 0.01-0.02 |
| `classify-email` / `classify-doc` / `classify-notes` | Haiku | none | ≤ 1.5K | 8 items / 2 notes | 8 | 0.001-0.004 | 0.02 |
| `classify-org62` (changed rows only) | Haiku | none | ≤ 1K | 30 rows | 1-3 | 0.001 | <0.01 |
| `classify-claude-session` | Haiku | none | ≤ 1K | 6 sessions | 2-6 | 0.001 | <0.01 |
| `check-completion` + `settle` (merged, batched) | Haiku, effort medium | none | ≤ 2K | 8 items | 7 | 0.002 | 0.02 |
| Escalation (any classifier) | Sonnet 5.5 | none | same prompt | unsure only | ≤ 5 | 0.02 | ≤ 0.25 (cap) |
| Read-in (auto / asked) | Haiku / Sonnet | 2-4 read tools | ≤ 2.5K | 1 | 5 / 5 | 0.004 / 0.06 | 0.32 |
| Drafts, NBA reply | Sonnet | none | ≤ 1K | 1 | 10 | 0.03-0.06 | 0.5 |
| Briefs (auto) | Haiku (Sonnet when asked) | none | ≤ 1.5K | 1 per brief | 3 | 0.003 | 0.01 |
| Relays (Outbox, lookups) | none (`mcp_call`) or Haiku | 1 | 0.3K | — | 20 | 0 / 0.002 | 0-0.04 |
| Assistant | ASSISTANT lane | | | | | | 0.5-1.5 |
| **Background scanning total** | | | | | | | **≈ 0.10-0.35 (cap 0.50)** |
| **All-in** | | | | | | | **≈ 1.5-2.8** |

Even at 10× these call counts, background scanning stays under $1/day. The design target is $/useful item, not $/poll (§4.5).

### 4.3 Budget mechanics: one envelope model

```ts
// src/llm/spend/governor.ts (new); replaces the scattered caps; contract additions under src/contract/spend.ts
type EnvelopeKey = 'day' | 'first_scan' | `job:${string}` | `chat:${string}`;   // chat: one message
interface Envelope { key: EnvelopeKey; softUsd: number; ceilingUsd: number | null; spentUsd: number; heldUsd: number }
interface Estimate { skill: string; mode: string; model: string; calls: number; usd: { p50: number; p90: number }; basis: 'history' | 'prior'; n: number }
interface Hold { id: string; envelopes: EnvelopeKey[]; heldUsd: number; estimate: Estimate;
  // Called from the running per-message estimate. 'ask' raises a hand and waits; never kills on its own.
  check(spentUsd: number): Promise<'continue' | 'ask' | 'stop'>;
  settle(actualUsd: number): Promise<void> }
interface SpendGovernor {
  estimate(plan: Array<{ skill: string; mode: string; model: string; items: number }>): Promise<Estimate[]>;   // p50/p90 from llm_calls (last 14 d, same skill+mode+model), $/item × items
  hold(envs: EnvelopeKey[], est: Estimate): Promise<Hold | { ask: AskToContinue }>;                           // holds p90, not the cap
  ask(a: AskToContinue): Promise<'continue' | 'stop'>;                                                       // notification + Health ▸ Spend card; default after timeout = pause, never kill
}
interface AskToContinue { envelope: EnvelopeKey; spentUsd: number; projectedUsd: number; reason: 'over_estimate' | 'soft_line' | 'ceiling'; resumeToken: string }
```

**Rules.**
- **Estimate before.** Every planned job, first scan and Assistant message gets an estimate (p50/p90 × items). Warn when the p90 would cross the day's soft line, and do it before starting (ask #5).
- **Hold p90, not the cap.** This fixes the starvation in COST-7. A run that goes past its hold calls `check()`.
- **Soft-continue mid-run.** In `skill-runner.ts` and `chat/runner.ts` the per-message estimate already runs (`skill-runner.ts:580-585`). Replace `fail(cost_cap)` with `hold.check()`. On `'ask'`, the next `canUseTool` call awaits `governor.ask()`. The SDK session stays alive, and the watchdog is suspended while waiting. Set `maxBudgetUsd` to the ceiling only (a runaway guard), not to the soft line. Tool-less one-shots pause between calls (job loop), so they need no mid-call pause.
- **One day envelope**, with the read-in, escalation and chat lines as sub-envelopes of it, not separate caps. The first scan is its own envelope with an up-front estimate and a ceiling of 2× p90 by default. The "Raise today's cap" flow becomes "Continue" on the ask card.
- **Where it plugs in:**
  - `scanner-runtime.ts:642-680` (replace the cap check + `reserveSpend`);
  - `skill-runner.ts:580-585,612-614`;
  - `llm/chat/runner.ts:160-252` (ASSISTANT owns the UX);
  - `jobs/handlers/settle.ts:144`, `relay-guard.ts`;
  - `activity-suggest.ts` / `activity-notes.ts` per-call constants;
  - `server/onboarding/cost.ts`: the history estimator replaces the static table.
- **Migration.**
  - `settings.budgets` keeps `softUsd`/`hardUsd` (hard becomes `ceilingUsd`, nullable).
  - The sub-lines map one-to-one.
  - `llm_budget_days` keeps working.
  - A new `spend_holds` table (or kv) holds open holds and pending asks. That migration is additive.

### 4.4 Tool and instruction surface for cheap models

Target per call: ≤ 3K tokens of fixed prefix (rules + schema), 0 tool schemas for classifiers, and ≤ 4 tools for read-ins.

| Tool (agentic paths only: read-in, research, Assistant) | Purpose (one line) | Output |
|---|---|---|
| `find_items(q, people?, accounts?, refs?)` | Open items matching refs/people/text, ≤ 10 | `[{id,title,state,last}]` |
| `read_source(ref, page?)` | One Slack thread / email / doc / SOQL row by ref, paged | `{text, next}` |
| `search_source(connector, query, window)` | One allowlisted search, paged | `{hits:[{ref,at,from,excerpt}], next}` |
| `finish(result)` | The strict JSON result for the skill | schema per skill |

Classifiers get no tools: the code fetches, attaches candidates, applies the JSON, records coverage and moves cursors. The 10 `cc_*` tools (`cc-tools/schemas.ts`) remain only as an internal API for the code, not in the model's context.

Skill length targets:
- classifier ≤ 1.5K tokens: definitions of ask, commitment, completion and noise, the confidence words, 3 examples;
- shared `classify-common` ≤ 1K;
- read-in ≤ 2.5K.

Move to code:
- the COST-4 table;
- `_scanner-common` R6 redaction (it is already done at ingest, `connectors/redact.ts`);
- R8 confidence words mapped to numbers;
- the R9 relink mechanics.

### 4.5 Measurement (do first)

Add to `llm_calls` (additive, nullable; old rows stay null):
- `first_prompt_tokens`, `max_prompt_tokens`, `long_tier_requests` (requests > 100K);
- `turns`, `tool_count`, `tool_schema_tokens` (from `system/init` tools and `getContextUsage({detail:'summary'})`);
- `prefix_hash` (the hash of everything before the boundary: proves cache identity);
- `items_in`, `items_decided_by_rules`, `items_out` (`proposed` / `linked` / `closed`);
- `escalated_from_call_id`.

Add `scan:report --yield --since 7d`. It reports, per skill/connector: $, calls, $/run, % empty runs, cache hit %, % long-tier requests, $/item-found (new proposed + linked), and $/item-closed. Closures are attributed through `work_item` transitions whose reason cites the call's run. It also gives the first-scan $/source/day.

### 4.6 Prioritized list

| # | Recommendation | Effort | Depends on | Compat / migration |
|---|---|---|---|---|
| 1 | Measurement columns + `scan:report --yield`; break down the hidden 13-19K with `getContextUsage` (COST-8, 12) | S | none | Additive columns; null on old rows |
| 2 | Stay under 100K: `postToolUse` → `updatedToolOutput` with a compact digest after REC-1/REC-2 record the raw result; a per-request prompt guard (pause + split the window, not fail) (COST-2) | S | 1 | None |
| 3 | `settingSources: []` for scanners and relays, with the gateway passed explicitly (as `completion/llm.ts` does) (COST-8) | S | 1 (to see the delta) | Verify MCP OAuth still resolves; fall back if not |
| 4 | Zero-token Slack pre-check + Org62 SOQL via `mcp_call` or a direct client (Decision 1) (COST-3) | M | CONNECTORS-PROVIDERS | Keep the relay path behind a flag |
| 5 | Shrink the context pack: drop `openItems` for per-message deterministic candidates (COST-5) | M | SCANNER-QUALITY (recall eval) | `PROJECTIONS`/pack only; no DB change |
| 6 | Batched tool-less classifiers for Slack, then Gmail/Drive/Notes/Org62; retire in-loop extraction; skills ≤ 1.5K (COST-4) | L | 4, 5; SCANNER-QUALITY A/B on block A | Skill versions bump; old skills kept for `CC_SCANNER=agentic` until the A/B passes |
| 7 | Spend governor: estimate, hold p90, soft-continue in `canUseTool`, one envelope model (COST-7) | M | 1 (history), ASSISTANT (ask card) | Settings fields map one-to-one; additive `spend_holds` |
| 8 | Merge settle + completion into one batched call; escalation gated by measured changed-rate (COST-10) | M | SCANNER-QUALITY | `llm_decisions` keeps the D4 trail |
| 9 | First-scan rewrite: deterministic history fetch, large batches, estimate from counts (COST-6) | M | 4, 6, 7 | `first-scan.json` ledger unchanged |
| 10 | Signal-driven cadence: on with item 4; quiet polls cost 0 (COST-1) | S | 4 | `cadence.ts` defaults only |
| 11 | Automatic briefs and NBA on Haiku unless the user asks; drafts stay Sonnet (COST-11) | S | quality spot-check like D2's | Frontmatter only |
| 12 | Close the D1 gap in `agentSdkComplete` (split cache tokens) | S | none | None |

## 5. Decisions for Tristan

1. **How do Slack and Org62 reads happen without a model turn?**
   - (a) The SDK control `mcp_call` (`sdk.d.ts:4897-4920`). It still runs through `claude` and its MCP OAuth, but 0.3.316 has no public `Query` method for it, so it needs a newer SDK or a raw control message.
   - (b) A direct MCP client, like Google via devbar (`google/client.ts`), if devbar proxies Slack and Org62.
   - (c) Keep the LLM relays, but put N fixed calls in one relay session.

   **Recommend (a), then (b), with (c) as the fallback.** On compliance, as I read the brief, MCP connections and `claude -p` are allowed and neither option sends anything new outward. Please confirm that a model-free call through `claude`'s MCP client counts as allowed.
2. **The Batch API for the first scan.** It needs direct Messages API calls, which conflicts with "`claude -p` sessions only" (*a compliance blocker*). **Recommend: no.** With Rec 6 and 9 the first scan is ~$1-3 without it.
3. **What do caps do?**
   - (a) Today: kill and retry.
   - (b) Estimate + soft-continue with a user-set daily ceiling as a runaway guard.
   - (c) No ceiling at all.

   **Recommend (b).** Note that (b) changes the D-5 "soft cap, alert at 80%" defaults.
4. **The escalation policy.** Keep Sonnet escalation only where the D4 data shows it changes outcomes (threshold above), or drop it entirely. **Recommend data-gated.**

No recommendation here conflicts with *Nothing leaves without approval*, *Draft, don't send* or *Read-only ingest*: the classifiers have no tools at all, and `mcp_call` keeps the read allowlist in our code (CLAUDE.md invariant 2).

## 6. What's fine, don't touch

- **D0 booking.** Split cache tokens, trigger, model_reason, content_hash, outcome, `llm_decisions` (`spend.ts`, `schema/llm.ts`).
- **The restricted MCP config.** `strictMcpConfig`, disallowed tools kept out of the prompt, the `canUseTool` gate (`mcp-config.ts`, `skill-runner.ts:487-495`).
- **The static/dynamic system-prompt boundary**, with the persona after it (`skill-loader.ts:176-178`).
- **REC-1/REC-2 auto-recording** from tool results, and the ORG-3/5/6 corrections. These are the seed of the deterministic design.
- **D2's evidence-hash skip and Haiku read-ins. D3's session gating.**
- **Completion batching and the triage batch shape.**
- **`relayStandIn`** (`one-call.ts:52-55`).
- **The long-tier-aware estimator** (`models.ts:36-48`).
- **The reservation idea (D6).** Keep it, but hold an estimate instead of the cap.

## 7. Open questions / not verified

- No live Postgres. The real post-D2/D3/D5 split of the ~$10/day, the share of requests above 100K, and the `slack-precheck` $/run are all unmeasured. Rec 1 answers them.
- What makes up the 13-19K "hidden" tokens per first request (CLI scaffolding vs MCP schemas vs `settingSources: ['user']`). I measured the `cc` schemas only (10.3K chars ≈ 3K tokens).
- Whether `mcp_call` can be sent from 0.3.316 in practice. It is in the control-request union (`sdk.d.ts:5259`) but has no method.
- Whether devbar proxies the Slack and Org62 MCP servers (it does for Google).
- The gateway may be Bedrock (`claude-env.ts:38`, "Bedrock flags"). If so, Bedrock prices apply, and caching and Batch availability differ.
- The quality cost of moving to batched classifiers. It needs SCANNER-QUALITY's block-A recall A/B (SLK-1 baseline: 30% → 55% recall at +22% cost).

### Provider-neutrality flags (for CONNECTORS-PROVIDERS)

| Design element | Anthropic-specific? | On OpenAI |
|---|---|---|
| Stable prefix first, volatile last | No | OpenAI caches long shared prefixes automatically with no write premium; the same layout works |
| Explicit `cache_control`, 5 min/1 h TTL, 1.25×/2× write, 512-token minimum, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | Yes (and Agent SDK) | Ignored; the breakpoint logic must be optional in the provider seam |
| Haiku 5.5's 100K long tier | Yes | Different thresholds; the per-request prompt guard should read a per-model limit table |
| Batch API (50%) | Both vendors have one, both direct-API only | Same compliance question |
| `claude -p` / Agent SDK runner, `mcp_call`, `canUseTool` pause, `updatedToolOutput` | Yes | A tool-less classifier with JSON output is the most portable unit; agentic paths need a provider loop with a pre-tool hook |
| `outputFormat: json_schema` | Both have structured outputs | Map in the seam |
| `effort` levels | Yes | Map to the provider's reasoning setting or drop |
