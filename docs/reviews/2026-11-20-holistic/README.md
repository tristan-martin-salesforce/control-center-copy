# Holistic review, 2026-11-20: synthesis and plan

Eleven read-only reviewers (Opus for judgment lanes, Sonnet for external research), one lane each, briefed from `00-brief.md`. This file is the orchestrator's synthesis: what the lanes agree on, where they disagree, the decisions only Tristan can make, and the build plan. Read the lane reports for evidence (`path:line` on every claim); this file cites them by lane and finding id.

| # | Lane | Report | Model |
|---|---|---|---|
| 01 | UI audit (screenshots in mock mode) | `01-ui-audit.md` | Opus |
| 02 | UI research (what others do) | `02-ui-research.md` | Sonnet |
| 03 | Scanner quality and closure | `03-scanner-quality.md` | Opus |
| 04 | LLM cost and model tiering | `04-llm-cost.md` | Opus |
| 05 | Assistant and spend UX | `05-assistant.md` | Opus |
| 06 | Time, DCs, use cases | `06-time-activity.md` | Opus |
| 07 | Prioritization and Home | `07-prioritization.md` | Opus |
| 08 | Connectors and providers | `08-connectors-providers.md` | Opus |
| 09 | Data model and storage | `09-data-model.md` | Opus |
| 10 | Engineering system | `10-engineering-system.md` | Opus |
| 11 | Packaging and error handling | `11-packaging.md` | Opus |

Constraints on the evidence: no Postgres and no live connectors on this machine. Code was read, unit tests and the mock app were run (about 60 screenshots of every route at 1440 wide, in the scratchpad `shots/` folder, not committed), the ranking engine was run over `sample-data`, and PGlite was tried against the migrations. Anything about live frequencies ("how often does X happen") is reconstructed from the 2026-11-13 audit's numbers or marked unverified in the lane report.

## 1. The verdict in one paragraph

The owner's read is right: the features exist and the plumbing to Org62, VDP and Slack is solid (all 97 edge cases in `docs/EDGE-CASES.md` pass; the Outbox gate, undo, audit and live updates are best-in-class and should not be touched). What fails is everything *before* the plumbing: the app guesses badly and never learns, pays for a model where code would do, and asks the same question in five places. Three engines guess the opportunity and disagree; two engines decide "is this done?" with different rules and neither has the facts; the priority engine drops its best inputs and lets any overdue chore outrank tomorrow's $780k demo build. The `mapping_rules` table that *tenet: Suggest, then learn* depends on is read by nobody. Scanning costs $10/day not because of the model tier (everything is already Haiku) but because a 42K-token prefix is re-read on every turn of a 5-30 turn tool loop that polls every 2 minutes, with Slack and Org62 reads routed through a model turn. The data model is sound but bypassed (business state in a JSON side-car, the whole world loaded per request, a 7.7k-line hand-mirrored mock). Packaging is blocked by five fixable things, one of which is a security hole: the installed web app listens on every network interface.

## 2. Six cross-cutting findings

These are the patterns that showed up in several lanes at once. Fixing a pattern is what makes the per-lane fixes stick.

### F1. Three guessers, zero learners
- Opportunity attribution runs in three places that disagree with each other (06: TA-2; `projections/matching.ts`, `lib/time-suggest.ts` + `opp-options.ts`, `engines/deals/evidence.ts`). The Needs-you tab shows "no account" one row above a suggestion for that account.
- "Is this done?" runs in two places with two correction rules: Settle never auto-closes an item the user has touched in any way (accept, snooze, set account), while the closure machine has no guard and can re-close a reopened item (03: SCN-2, SCN-3). A follow-up after a wrong close is swallowed as context and never reopens (SCN-4); the `reopenOnFollowUp` setting is in the UI and read by nothing.
- Priority drops `importance`, `dueKind`, `askedAt` and people tier before scoring, overwrites importance with a function of rank on every re-rank, caps deal value at $500k, and gives any overdue item the maximum of both urgency terms forever (07: PRIO-1, 6, 9).
- `mapping_rules` (schema since 0001, with `user_correction` and `hit_count`) has no reader and no writer (03: SCN-15; 06: TA-3). Settle's `corrections` input is always empty. Dismissals, snoozes and accepts change no score anywhere (07: PRIO-14).

**Fix pattern:** one engine per question, deterministic rules first, a cheap model only for close calls, every user pick written back as a rule, and a replayable golden-set eval so "better" is measured, not asserted. Lanes 03, 06 and 07 each specify their engine this way and they compose: the attribution engine's candidates feed the resolution check's context pack and the priority engine's "who/deal" terms.

### F2. The model is used as a transport
- Every background scanner is already on Haiku (04: `models.ts:7`). Cost is prefix × turns × runs: ~42K tokens of skill + tool schemas + a 60-item open-items pack, re-read each of 5-30 turns, 150-1,100 runs a day (04: COST-1, 4, 5).
- Slack and Org62 reads, and even the "anything new?" pre-check, each cost a model turn (04: COST-3). Google reads are already a zero-token direct client. The SDK has an `mcp_call` control request that calls a tool with no model turn, but the installed 0.3.316 exposes no public method for it.
- Haiku's 5× long-prompt tier (>100K) is hit and unguarded: tool results accumulate and are never shrunk (04: COST-2).
- About half of the 31-41K characters of skill prose is procedure (exact queries, paging, cursors, recording fields) that code should own (04: COST-4; 08 agrees: fetch-then-interpret is also what makes the interpret step provider-neutral).
- Budgets are eight independent kill switches; a run that hits its cap fails and retries at half size; the daily cap pauses until midnight; the Assistant's research must fit inside what's left of a $0.25 message and "Allow more" re-sends the message from scratch, paying twice (04: COST-7; 05: AST-1, 2).

**Fix pattern:** fetch deterministically → rules → batched tool-less Haiku classification with strict JSON → code applies; one cached prefix; signal-driven cadence; one spend governor (estimate from `llm_calls` p50/p90, hold p90, raise a hand in the existing `canUseTool` gate so the session stays alive). Target: background scanning ≤ $0.50/day, all-in $1.50-2.80/day, first scan $1-3 (from $16 measured). The same `ConnectorRuntime` seam is what a second LLM provider would need (08).

### F3. The same decision lives in five places
- Drafts: Home "Reply & approve", Outbox, an Assistant card, the Work item panel, Triage. Logging approvals: Activity ▸ Log it, Activity ▸ Needs you, Home ▸ Log & fix (02: UIR-1). Home's "Approve N" is a link to `/outbox` (`engines/home/build.ts:1422`), and a ready Outbox card is spliced in as Home card #2 regardless of rank (07: PRIO-7).
- DC truth lives in three tables and five engines derive "DC gaps" from them, so Deals, Home and the account page disagree (09: DM-1/2). A use case has four representations (09: DM-3).
- Nav carries eleven nouns plus six Activity tabs plus internal vocabulary (canvas, landing, Stage/Apply, Slackbot hand-off) a teammate cannot predict (02: UIR-3).

- The UI audit's screenshots (01) confirm it from the other side: Home itself is capped and fairly calm; the noise is the app around it. Eleven sidebar destinations with six live counts summing to ~42; Home and Today both answer "what now"; one draft can appear three times on Home under three different verbs (`build.ts:638-640, 706-722, 1422`); VDP re-auth shows in seven places; Activity has 2 × 5-6 tabs whose counts disagree (sidebar 7, Org62 1, VDP 6) and a title that changes between Activity, Time and VDP; internal words reach the screen (canvas, Slackbot, CF/CR, `Use_Case__c`, "(D-63)"); 45 bespoke `*Row` components and three styling systems; the sidebar says "Command Center".

**Fix pattern:** one server-built **Needs you** queue (kind, verb, why, source, group key) that Home slices, the sidebar counts once, and every page filters (01: R1); drafts in one queue with one verb, Review (01: R2); a drain mode for each queue (one card at a time, `a`/`e`/`s`/`x`, progress, all-clear; 02: P1-P3); Home as a briefing: three do-now cards from the engine's day plan plus the top five grouped Needs-you rows, Today folded in as a Plan toggle (01: R3; 07: R3); Activity as three tabs, To log · History · VDP, in plain words (01: R4); a seven-item sidebar with one count (01: R5); two item menus, Done ▾ and Later ▾ (01: R6); one view per fact (DC coverage, needs decisions) feeding every surface (09 §7); a small component kit (`ActionRow`, `QueueSection`, `PageHeader`, `DetailPanel`) with Tailwind-only for new code and lint against `D-\d+`/`__c` in JSX strings (01: R10).

### F4. Two of everything
- Two DataSources, 4,779 + 4,166 lines, near-twins section by section; the parity suite that keeps them honest needs Postgres and is excluded from `npm test` (10: ENG-1, 2). The production db path imports from `mock/`.
- Two closers (F1), three attribution engines (F1), three error classifiers with overlapping codes (11: PKG-7), eight spellings of source names and a Postgres enum that needs `ALTER TYPE` for every new connector (08: CONN-1), 199 hand-rolled 15/18-character Org62 id normalizations in 28 files (09: DM-5), 22 copy-pasted Postgres test setups (10: R3).
- Business state (`dcAssigned`, `dcStatus`, `nextStep`, needs decisions, canvas picks) in a JSON side-car under `user_settings` keys, joined in SQL with string-built keys (09: DM-4); 3,819 rows at the last audit.

**Fix pattern:** strangler splits behind unchanged interfaces (DataSource by domain in ~8 small parity-guarded steps; shared read views so only writes stay twins; then retire the mock onto PGlite seeded from the example seed), one connector manifest and registry, one error catalog, generated `org62_id15` columns, side-car → columns in a major release with a backfill job.

### F5. Packaging is five fixable things away
- **Security (fix now):** `next start -p 4327` with no `-H` binds 0.0.0.0; no Host/Origin check (11: PKG-1).
- A failed update rolls back only `.next`; the worker runs TypeScript source via `tsx` on the new code; the user is told to `git reset` by hand (PKG-2). `npm install` instead of `npm ci`, Node unpinned (`brew install node` gives 25, which breaks 48 jsdom tests here), lockfile drift makes the next `--ff-only` update fail (PKG-3; 10: ENG-0).
- Doctor is terminal-only and barely checks Claude Code (looks for `claude` on PATH while the runners use `~/.local/bin/claude`); Health never shows Postgres, CLI, disk or backups; a DB-down renders a raw ECONNREFUSED toast (PKG-5/6). "devbar not installed" reads as "daemon not listening, restart it", and the Restart button reports success when devbar does not exist (08: CONN-5). Claude CLI missing, MCP server not declared, LLM billing and parser drift all render as "a run failed" and retry forever (08: catalogue).
- The feedback post carries no machine diagnostics, so reports from several users cannot be grouped (PKG-8). Version shows the sha but no dirty flag, so a teammate's local fixes look like a clean install (PKG-4).
- Gatekeeper: since macOS 15 an unsigned downloaded bundle takes four clicks into System Settings and gets no auto-update; `git clone` + local build is, by accident, the only quarantine-free path. Tauri adds complexity for no gain (the payload is a Node server anyway); Homebrew casks are deprecated unsigned (11: §4).

**Fix pattern:** loopback + Host/Origin guard today; `npm ci`, Node pin, compiled worker, staged build with full rollback; one error catalog (stable codes → user text + next step + action) used by Health, toasts, doctor and the feedback post; doctor as a service rendered in Health ▸ Setup and onboarding with a state machine per dependency (missing / installed / signed-out / expired / ok) and Run buttons; diagnostics block + redacted log tail in every feedback post; `release --publish` (Tristan runs it) with stable/beta channels and an in-app Update banner. Keep localhost + LaunchAgents + a one-line bootstrap installer now; a signed Electron menubar shell only if IT can sign or push via Jamf.

### F6. The docs describe a build, not a product
`ARCHITECTURE.md` says SQLite and "proposed"; `DECISIONS.md` has 75 rows, some over 5,000 characters, amended in place (D-67 three times, then partly overridden by D-72); `docs/ui/*` are build-era specs; `docs/README.md` says 42 decisions. A teammate (or a builder agent) cannot predict what the time engine will do from D-59..D-72 (06: TA-7; 10: ENG-10). Lane 06 shows the whole time/DC/use-case behaviour fits in 10 rules; lane 10 proposes living docs + ADR-lite decisions (≤ 30 lines each, amendments supersede, never edit in place) + reference + archive.

## 3. Where the lanes disagree, and the call

| Topic | Lane A says | Lane B says | Call |
|---|---|---|---|
| Storage engine | 09: bundle Postgres 17 as an app-managed cluster; PGlite only for mock and tests (single connection; web + worker + tool servers can't share it) | 11: "embedded DB", notes PGlite v0.4 multiplexing | **Bundled Postgres 17 for users, PGlite for mock/tests.** Zero SQL changes, keeps triggers/NOTIFY/undo. Revisit PGlite as the app DB only if v0.4 multiplexing is verified under the worker's `SKIP LOCKED` queue. Major release with dump → restore → verify → switch, old DB kept 14 days |
| Slack/Org62 reads without a model turn | 04: try SDK `mcp_call` first, then a devbar gateway, then batched relays | 08: keep Claude as the `claude_relay` runtime (one-call) next quarter; investigate devbar gateway; own OAuth client is a blocker | **Same thing in different words.** Build `ConnectorRuntime` with `claude_relay` now (works today, one Haiku relay per fetch); try `mcp_call` behind it as soon as an SDK version exposes it (zero tokens); ask devbar about Slack/Org62 connectors. Never an app-owned OAuth store |
| Pre-ticked rows vs D-71 "never applied for you" | 06: pre-tick ≥ 0.75 rows on the Review page; the button is still the approval | 07 (and tenet) | **Pre-tick is fine.** Nothing is approved until the click and nothing leaves until canvas Apply. Keep an "untick all" and show confidence |
| Batch API for first scan | 04 raises it | 04 and 08: direct Messages API conflicts with "`claude -p` sessions only" | **No.** Deterministic fetch + large batches gets the first scan to $1-3 anyway |
| Mock DataSource | 10: share read views now, retire later | 09: retire onto PGlite | **Both, in that order.** Shared views (R7 step 3) are the parity-safe path to retirement |
| Embeddings / RAG | 09: won't move the $10/day; fix keyword search first; local model only, later | 04/05: silent on RAG | **Defer.** Fix the Assistant's broken ledger search (DM-10) and the id columns first; local-model pgvector for "which opp" and Assistant search in phase 4 if the eval shows a gain. API embeddings are out under *Local data* |
| NBA engine | 07: ranking must not depend on it; keep for on-demand drafts | 04: automatic NBA/briefs on Haiku | **Demote NBA.** Ranking and "why" come from the engine; NBA skills stay for on-demand drafts and read-ins, on Haiku unless the user asks |
| File-length lint | brief: "files not too long"; 01 suggests ~400 warn for components | 10: 110 files are over 400 lines; 400/800 would be noise | **600 warn / 1,000 error** repo-wide, grandfather the 11 files over 1,000 until split; components may opt into 400 once the kit lands |
| Nav shape | 02: five nouns (Home / Inbox / Work / Activity / Assistant) | 01 (saw the screens): seven (Home · Needs you · Outbox · Work · Deals · Activity · Assistant), Triage kept until the queue exists | **01's seven.** Outbox stays the one approval queue (D-75 holds); Deals is reference, not an inbox |

## 4. Decisions for Tristan

Each has a recommendation; "go with recs" is a valid answer. Rows marked ⚠ touch a tenet or compliance and need an explicit yes.

| # | Decision | Recommendation | Lane |
|---|---|---|---|
| H-1 ⚠ | Loopback-only web bind + Host/Origin guard, shipped as a patch this week | Yes, 1.3.1 | 11 R1 |
| H-2 | Storage: bundled Postgres 17 (app-managed) for users; PGlite for mock and tests; retire the mock DataSource | Yes; the switch is a major (2.0) | 09 D1/D2, 10 D1 |
| H-3 ⚠ | Slack/Org62 reads via `ConnectorRuntime`: `claude_relay` now, `mcp_call` when the SDK exposes it, devbar gateway if it exists. Confirm a model-free tool call through `claude`'s MCP client counts as "MCP connections and `claude -p`". VDP's direct HTTP client stays and gets documented | Yes to all three; no app-owned OAuth token store ever | 04 D1, 08 D1/D2 |
| H-4 | Second LLM provider: build the `ModelProvider` seam now (Agent SDK adapter only); add a Vercel AI SDK adapter when a real OpenAI user appears. Reads still go through H-3 | Yes | 08 D4 |
| H-5 | Spend: one envelope model (estimate from history → hold p90 → raise a hand → continue), a user-set daily ceiling as runaway guard. Replaces D-5's "soft cap, alert at 80%" and every per-feature cap | Yes | 04 D3, 05 §6 |
| H-6 ⚠ | Assistant: default model **Auto** (Haiku 5.5 first, Sonnet on list mode/drafts/retry, Opus by choice); one SDK session per thread with transcripts persisted under `~/Library/Application Support/control-center/` (full message bodies on disk, in app state) | Yes to both | 05 D1/D2 |
| H-7 | Closure: merge the completion pass and Settle into one resolution check (shadow release first); correction rule = only "reopened / Kept / Not done" blocks auto-close; a follow-up from the asker within 14 days reopens with Undo; Sonnet escalation only where data shows it changes verdicts | Yes to all | 03 D1-5 |
| H-8 | Priority@2: overdue decays after one working day; a draft rides on its item's card plus one Respond row; admin is a quiet batch unless due within 48 h or pay-linked at risk; extractor emits a size class; persona prep rules auto-create prep items for customer meetings; auto re-rank after scans with stable display; NBA demoted | Yes to all seven | 07 D1-7 |
| H-9 | Time: one attribution engine with learned rules and live Org62 discovery (≤ 20 lookups/day, cached 7 days); `opp_engagement` credits top candidates so several opps can earn DC suggestions without splitting hours; DC suggestions daily incl. "AEs I cover" (all listed, pre-ticked only with evidence); use cases may go to Org62 before the 100% DC on engaged opps; one weekly Review page | Yes to all | 06 D-T1..T5 |
| H-10 | UI: one server-built Needs you queue that every page filters (T1); Today folded into Home as a Plan toggle (T2); Triage kept for now, folded into Needs you's Confirm filter after the queue lands (T3); Activity = To log · History · VDP, Forecast only for the AE, which amends D-72 (T4); sidebar = Home · Needs you · Outbox · Work · Deals · Activity · Assistant with one count, old chords as aliases for a release; drain mode on every queue; batch approve stays a human click | Yes to T1-T4 | 01 T1-T4, 02 P1-P13 |
| H-10b | New UI code: Tailwind + tokens only, CSS modules and global CSS frozen and migrated when touched (T5); re-auth is a button with a "Show command" disclosure, never a pasted `python3` line (T7); product name settled before packaging: **Control Center** (the sidebar says Command Center) (T6) | Yes; Control Center | 01 T5-T7 |
| H-11 | App shell: localhost + LaunchAgents + one-line bootstrap installer now; ask IT one question (Developer ID signing or Jamf Self Service?); signed Electron menubar shell only with a yes | Yes; ask IT this week | 11 D-A |
| H-12 | Release channel: `release --publish` (you run it; it runs `scan:private`, pushes `share:main` + tag, creates a GitHub Release); stable/beta channels; in-app Update banner that runs the update with full rollback; feedback posts carry a scrubbed diagnostics block + last 50 redacted log lines | Yes | 11 D-C/D/E |
| H-13 | VDP cookie-refresh script: have the installer fetch it from the VDP repo at a pinned commit with a hash check (ask the VDP owners), or vendor it | Ask, then fetch-pinned | 11 D-B |
| H-14 | Data model 2.0: kv side-car → columns with a backfill job; `org62_id15` generated columns; VDP child tables; one inbound mirror convention; landings for Slack/Gmail writes too | Yes, as the 2.0 major | 09 R1-R5 |
| H-15 | Engineering: layer lint + `max-lines` 600/1,000 (warn → error, grandfather list); vitest projects per module, tests co-located; `check:fast` vs `check`; `CONTRIBUTING.md` + `AGENTS.md` (drafts in 10 Appendix A/B); docs reset to living / ADR-lite / reference / archive | Yes | 10 D1-4 |

## 5. The plan

Five phases. Phases 1-3 overlap in parallel lanes; phase 4 is the 2.0 major. Effort is in agent-days (one Sonnet or Opus builder). Every item names its lane report and recommendation so a builder brief can be written from it.

### Phase 0: this week (patch 1.3.1, then 1.4.0): safety, hygiene, measurement
All S, all safe, no migrations except additive nullable columns.

| Item | From | Why first |
|---|---|---|
| Loopback bind + Host/Origin middleware + test | 11 R1 | security |
| `npm ci`, `.nvmrc` 22, `engines <25`, doctor warns on 25+, exclude `sample-data/**` from typecheck/lint, DB tests `skipIf(!pgAvailable)` via one helper | 11 R2, 10 R1/R3 | `check` is red on HEAD on a fresh Mac |
| Version shows `modified` + channel; feedback carries it | 11 R4 | drift visibility |
| Fix the Assistant's ledger search (queries a non-existent `excerpt` column and swallows the error, so local search likely always returns empty) | 09 R0 | probable live bug |
| Calendar research fetches 250 events then filters (misses events); research and sub-runs get their own budget line; "Allow more" resumes instead of re-sending | 05 AST-2, Q1 | most-hit Assistant limits |
| One correction rule for both closers; wire `reopenOnFollowUp`; DUP-1 writes `contradiction` for a chase after a close | 03 R1, R2 | restores *Suggest, then learn* |
| Gemini "Next steps" heading regex (`suggested next steps`, `action items`); Health counter for notes with 0 parsed steps | 03 R11 | silent recall hole |
| Priority: overdue decay, pass `importance`/`dueKind`/`askedAt`/tier, stop overwriting importance, `from_manager` only when the manager is the asker, card "why" from the formula | 07 R1, R2, R7 | the list is wrong today |
| `llm_calls` measurement columns + `scan:report --yield`; `settingSources: []` for scanners; per-request >100K guard with `updatedToolOutput` digests | 04 #1-3, #12 | prove savings before the redesign |
| Auto-queue Org62 rechecks on canvas Apply; honour or remove `autoAt` | 06 R9 | stuck states |
| Pino with redact paths, worker crash handler + crash-loop detection, `app/global-error.tsx` | 11 R9 | errors reach the user |
| Static safety tests (`tests/safety/`): network only in allowlisted dirs; MCP tool names on the read allowlist; every send/apply route is `deny` for the Assistant | 10 R10 | lock the invariants before refactors |

### Phase 1 (weeks 2-4, 1.4 → 1.5): foundations the intelligence work stands on
| Item | From | Effort |
|---|---|---|
| Spend governor (`src/llm/spend/governor.ts`): estimate, hold, ask, settle; plugs into skill-runner, scanner-runtime, chat runner, settle, relay-guard; `spend_holds` additive | 04 #7, 05 §6 | M |
| `ModelProvider` interface + Agent SDK adapter; lint: `@anthropic-ai/claude-agent-sdk` only under `src/llm/providers/**`; model ids and prices centralized | 08 R6, 10 e | M |
| `ConnectorRuntime` (`claude_relay`, `direct_mcp`, `http_jsonrpc`, `local_files`) + connector manifest/registry generating ids, labels, allowlists, reauth, cadence, onboarding rows; parity test against today's tables | 08 R1, R7, 10 d | L |
| Fetch-then-interpret for the Slack inbox and Org62 fixed scopes (deterministic fetch, REC-1 records, batched tool-less Haiku classify); A/B against the stress fixtures before switching | 04 #4-6, 03 R5 | L |
| Error catalog (`src/errors/catalog.ts`, stable codes, alias table) used by the three classifiers; devbar missing vs down; drift as a health state; `unknown` stops retrying after N | 11 R5, 08 R2, R4, R5 | M |
| Doctor as a service: `src/ops/checks/*`, `GET /api/v1/doctor`, worker runs every 15 min, Health ▸ Setup, DB-down page | 11 R6, 08 R3 | M |
| Vitest projects per module; `check:fast` / `check`; move lane folders to module folders; route drift test; `crawl --mock` smoke | 10 R2, R6, R11, R12 | M |
| DataSource split steps 1-2 (ctx objects, first low-risk domains) and `store-db.ts` split | 10 R7, 4.2a | L (in S steps) |
| Eval harnesses: golden scanner cases + cassette model; golden days for priority; attribution accept-rate log | 03 R10, 07 R9, 06 TA-12 | M |
| `CONTRIBUTING.md`, `AGENTS.md`, layer + max-lines lint as warnings, docs reset (archive build-era specs, ADR index, ARCHITECTURE rewritten as built, the 10-rule time spec replacing D-59..D-72 prose) | 10 R4, R5, R14, R15; 06 §5 | S-M |

### Phase 2 (weeks 4-8, 1.5 → 1.6): the intelligence
| Item | From | Effort |
|---|---|---|
| Resolution check: trigger rules D1-D6, context pack builder, tool-less Haiku, narrow Sonnet escalation, `closure_checks` table, "Why is this still open?" panel, `scan:explain --item`, nightly recall sweep; shadow mode one release, then retire `completion.check` and Settle | 03 R3, R4, R7-R9 | L |
| Attribution engine (`src/engines/attribution/`): ranked top-3 with reasons, learned rules written on every accept and listed in Settings, live Org62 discovery job, `opp_engagement` table, DC suggestion rule + daily "Claim N DCs", Settings ▸ Deals ▸ AEs I cover + `deals.covered_aes` job, `dcProducts` to persona config | 06 R1-R5, R7, R10 | L |
| Use-case candidates: `use_case_candidates` table fed by the existing notes call (wider output), dedupe against both systems, "Add to VDP + Org62" one click, opp rundown card | 06 R6 | L |
| Priority@2 (value × urgency, start-by planned backwards through free time over 10 working days, `awaiting` me/them, reply SLAs by tier, capacity-fitted Top N, admin batch, prep rules), migration 0027 additive, shadow run with `previewPolicy` diff, then on | 07 R3-R6, R8 | L |
| Assistant v2: 11 tools (incl. read-only `query` over curated views, `run` class with `check_resolution`), read/run/stage/deny, Auto model routing, one SDK session per thread, plan card above an estimate threshold, raise-hand card, cost meter, skill cut to ~6 KB with on-demand playbooks | 05 §5-6 | L |
| Cheap scanning for the remaining connectors (Gmail, Drive, Notes, Claude sessions, Org62 changed rows), signal-driven cadence, first-scan rewrite with a history-based estimator | 04 #6, #9, #10 | L |

### Phase 3 (weeks 6-10, 1.6 → 1.7): the surfaces
| Item | From | Effort |
|---|---|---|
| The Needs you queue: `GET /needs` composed from the existing engines (HomeRow, needs/decisions, Activity rows), one row per fact (DC gap, Looks done, unlogged time), kinds + verbs + group keys; pages move over one at a time | 01 R1 | L |
| Drain mode shell (one card, `a`/`e`/`s`/`x`, progress, all-clear) used by Outbox, Needs you, Triage and DC claims; drafts in one queue with one verb, Review | 01 R2, 02 P1, P3, P11 | L |
| Home as briefing: 3 do-now cards from the day plan (Today folded in as the Plan toggle), top 5 grouped Needs-you rows, Respond row, Coming builds, Admin row; drafts marked on cards with a chip only | 01 R3, 07 R3, 02 P2 | M |
| Activity = To log (Log it + Needs you merged, inline Accept, one "Log N" button) · History (Weeks + Ledger) · VDP (Changes, My VDPs a filter); use cases a row kind; plain words (batch, Send to Org62 via Slackbot, checked in Org62); `?view=` redirects | 01 R4, 06 R8 | L |
| Sidebar to 7 items with one count; Done ▾ / Later ▾ item menus; Settings to 5 sections + Advanced with autosave; Getting started = 5 outcomes; consistent empty/loading/error states; one DC coverage view feeding Deals/Home/account; the quick fixes list (counts, brand name, overlaps, `dev:web` syncs icons) | 01 R5, R6, R8, R9, R12; 09 §7 | M |
| Component kit (`ActionRow`, `QueueSection`, `PageHeader`, `DetailPanel` registry), pages under `src/pages/<name>/`, Tailwind-only for new code, lint for no new CSS modules and no `D-\d+`/`__c` in JSX, `/dev/kit` gallery as the spec; migrated one page per PR | 01 R10, R11 | L |
| Connection errors as a product surface: typed per-connector problem (what broke, impact, one button, fallback), Health owns detail, one status line + one Needs-you row elsewhere, never a raw `error.message` | 01 R7, 11 R5 | M |
| Health ▸ Setup + doctor-driven onboarding with Run buttons and a state per dependency; update banner | 11 R7, R10 | M |
| Feedback post diagnostics block + `docs/FEEDBACK-INTAKE.md` | 11 R8, R11 | S |

### Phase 4 (2.0 major): data model and packaging
| Item | From | Effort |
|---|---|---|
| Bundled Postgres 17 app-managed cluster; `npm run update` does dump → restore → verify (row counts + digests) → switch, keeps the brew DB 14 days; doctor checks | 09 R7, 11 | M-L |
| Mock DataSource retired: `CC_DATA=mock` = db DataSource on PGlite seeded from `seed.example.json`; scenario clock and dev routes ported; be0/be1a/be1b run in `npm test` | 09 R6, 10 R9 | L |
| kv side-car → columns + backfill; `need_decisions`, `canvas_row_overrides` tables; `org62_id15` generated columns; `vdp_use_cases`/`vdp_assets`/`vdp_members`; one inbound mirror convention + `mirror_reads`; landings for Slack/Gmail | 09 R1, R3, R4, R5 | L |
| Stop loading the world per request (page-scoped reads; `ReadModel` only for Home/Today over open work ± 14 days) | 09 R2 | L |
| Retention policy for audit, priority scores, superseded NBAs, renditions, resolved app events; `doctor db:size` | 09 R8 | S |
| Compiled worker, staged build + full rollback, `release --publish`, stable/beta channels, bootstrap `install.sh` | 11 R3, R10 | M |
| Local-model embeddings for the opp shortlist and Assistant search, only if the phase-2 evals show the keyword path falls short | 09 R10 | M |
| Signed Electron menubar shell, only after IT's answer | 11 R12 | L |

### What not to touch (every lane agreed)
The route table and generator, `src/db/changeset.ts` and the audit/undo triggers, `tests/setup/ledger-gaps.ts`, the Outbox gateway and adapters' approval flow, personas, `@/ui` primitives, the client data layer and live topics, the live-list merge pattern (D-73), the preview-first DC logic, the SOQL guard and object allowlist, the Org62/VDP round-trip edge-case behaviour (EDGE-CASES all OK). No monorepo, no DI container, no Tauri, no Batch API, no API embeddings.

## 6. How the build runs

Unchanged from `docs/PLAN.md` "How the build runs", with three changes lane 10 recommends: lanes own a *domain file* after the DataSource split (the "one-line additive edit to the shared index" rule goes), a lane that touches more than two modules splits into chunks, and every chunk ships its tests co-located under its own `files:` glob so `npm test -- --project <module>` is its verify command. Builder model: Sonnet for mechanical splits, parity moves, lint, docs and UI components against a spec; Opus for the resolution check, attribution engine, priority@2, spend governor, Assistant v2 and the data-model migrations. Each phase ends with one fresh-eyes Opus review on the diff and the eval harnesses green (golden cases, golden days, parity).

Migration discipline for everything above (09 §3.6): additive first; a backfill job, never a backfill in the migration; dual-write contract fields for one release (`suggestion` = `suggestions[0]`); no destructive change inside a minor; the worker refuses to claim jobs when its bundled migration and the DB disagree (exists); PROJECTIONS_VERSION bumps for re-projections; every major gets a dump before migrate (exists) and a verified restore path.

## 7. What this review cost and what it did not verify

Eleven agents, roughly 2.4M tokens in total, about 15 minutes wall-clock per lane in parallel. Not verified anywhere: live frequencies of the recall and closure failures (no production DB here), the exact breakdown of the 13-19K "hidden" prefix tokens, whether devbar can offer Slack/Org62 connectors, whether `mcp_call` can be sent from this SDK version, Salesforce IT's signing/Jamf policy, whether PGlite v0.4 multiplexing holds under the job queue, and the one failing regression test on HEAD (`tests/stress/regressions.test.ts:299`, THR-1), which no lane root-caused.

## 8. Decisions taken (Tristan, 2026-11-20)

Answers to section 4, with the deviations from the recommendations called out. These are the binding decisions for the build; the docs-reset chunk converts them into ADR files.

| # | Decision | Outcome |
|---|---|---|
| H-1 | Loopback bind + Host/Origin guard | **Yes, patch first.** |
| H-2 | Storage | **PGlite as the app database** (deviation: not bundled Postgres). Condition: a spike first proving one shared PGlite connection holds under the worker's `SKIP LOCKED` job queue and live NOTIFY across web + worker + tool servers; bundled Postgres 17 is the fallback if it fails. PGlite for mock and tests either way; mock DataSource retired. Existing Postgres users migrate with dump → import → verify on `update`, as the 2.0 major. |
| H-3 | Slack/Org62 reads | **MCP through Claude Code only.** No Slack SDK, no Org62 API, no devbar gateway (company-managed, not controllable), no app-owned tokens. Cost is controlled by making each read the smallest possible Claude run that calls the one MCP tool (the "one-call" pattern already in `src/llm/one-call.ts`), batching the interpretation afterwards with no tools, one cached prefix, and switching to the SDK's zero-token `mcp_call` as soon as a version exposes it. |
| H-4 | LLM provider | **Seam now, OpenAI adapter on demand.** |
| H-5 | Spend | **Estimate → raise hand → continue**, daily ceiling as runaway guard. |
| H-6 | Assistant | **Auto routing (Haiku first) + one persisted SDK session per thread**, transcripts under the app's state folder. |
| H-7 | Closure | **All four**: one resolution check, correction rule B, reopen on follow-up, data-gated escalation, shadow first. |
| H-8 | Priority@2 | **All seven**, shadow first, switchable back. |
| H-9 | Time, DCs, use cases | **All**, incl. use cases before the 100% DC on engaged opps. |
| H-10 | UI structure | **All**: Needs-you queue, Today into Home, Triage kept until the queue lands, Activity = To log · History · VDP (amends D-72), 7-item sidebar, drain mode. |
| H-10b | UI conventions | Tailwind-only for new code; button-first re-auth; **product name is Command Center** (deviation), renamed **everywhere** incl. package name and state folder, with a folder migration on update. |
| H-11 | App shell | **Localhost app, no desktop shell** (deviation). Ease of use comes from a one-line install and "ask Claude Code to install Command Center", not from an app bundle. Tauri/Electron/casks out. |
| H-12 | Distribution | **Compiled build in a shared Google Drive folder + a Slack announcement** (deviation: no GitHub Releases, no Heroku). The app checks and fetches updates through the devbar Drive read path it already uses; manifest with version, sha256, changelog; install with full rollback. To verify early: devbar's Drive tool can download a 100-200 MB binary. Feedback still returns via the Slack post with a scrubbed diagnostics block and log tail. Weekly intake doc stands. |
| H-13 | VDP cookie script | Installer fetches it pinned with a hash check (owner to confirm with the VDP team). |
| H-14 | Data model 2.0 | **All** as the 2.0 major. |
| H-15 | Engineering | **All**: warn-then-error lint, module test projects, co-located tests, two check levels, docs reset. |
| Ops | Commits | Continuous local commits on `tmart2322/kraken`, never pushed; Tristan pushes to his fork and opens the PR. Postgres 17 installed locally for verification only. Final commit bumps to 2.0.0 with the CHANGELOG section, no tag. |
