# Wave 1/2 review (Fable, 2026-11-20)

Range reviewed: `b049fe6..3c9381d` (122 commits, 766 files). Chunks: docs-reset, retention, connector-runtime, error-catalog-doctor, spend-governor, resolution-check, attribution-engine, health-setup, priority-v2, fetch-then-interpret, compiled-build-distribution, nav-and-pages, use-case-candidates, assistant-v2. Read-only review: no code changed.

## Verdict

**No blockers.** Every hard invariant held on inspection and under the safety suites; the binding decisions in README §8 are respected where their chunks have landed. Nine findings should be fixed before wave 3/4 integrates on top of them; the rest can wait for the release pass.

What was checked and passed:

- `npm run typecheck` clean; `npm run lint` 0 errors (30 warnings, all max-lines on files that were already over).
- `tests/safety tests/ops tests/bechat tests/scanner tests/engines`: 84 files, 975 tests, all green. `npm run test:evals`: 180 passed, 1 skipped; FTI A/B recall 15/15, precision 15/15, $/item 0.15× agentic (gate ≤ 0.20).
- Journal 0027 → 0029…0035 strictly increasing `when`, idx 26…33 contiguous (gaps 18, 19, 21, 28 explained); every snapshot's `prevId` chains to the one before; `drizzle-kit check` fine; a `generate --name probe` produced nothing (no artifacts left).
- Read-tool allowlist unchanged: `SLACK_SCAN_TOOLS` (4 reads), `ORG62_SCAN_TOOLS` (`soqlQuery`), `GOOGLE_READ_TOOLS` identical at `b049fe6` and HEAD; the update check's `get_drive_file_content` was already on it. Slack and Org62 reads go only through `claude_relay` (one-call `runOneReadLookup`); no SDK, no devbar gateway for them, no app-held token (`settingSources: []` in the relay options).
- SOQL: chat `search`/`fetch` refuse free SOQL (`FREE_SOQL` test in `src/llm/chat/tools.ts:150,201`); every SELECT comes from `src/server/chat/org62.ts` builders with escaped LIKE literals and id-regex-bound `WHERE Id`; attribution discovery binds ids through `/^[a-zA-Z0-9]{15}(…)?$/` (`src/engines/attribution/discover.ts:16`). The Slack/Org62 MCP servers are no longer loaded into chat turns at all.
- Nothing leaves: `releaseHandoffAdapter.toolCall` always throws; `release --publish` writes `dist/releases/outbox-<v>.json` and prints the Slack draft (dry run on); the update check reads the feed only; use-case Accept stages the VDP item and the canvas row through the existing adapters; the Outbox Review drain runs each row through `useOutboxSend` (preview → single-use confirm token → undo window); no `git push`, no `launchctl` in the new scripts' live paths; no autopilot file touched.
- Compiled build: `scripts/release/build.mjs` excludes `docs/` (except INSTALL.md), `tests`, `sample-data`, `e2e`, `fixtures`; `docs/research` therefore never ships. No credential-like text logged in the diff.
- Resolution check defaults to `shadow` (`src/contract/settings.ts:549`); an item reopened twice is ask-only (`src/engines/resolution/outcome.ts:85,129`). A wrong-opp rejection with the right opp picked is an `edit` correction, without one it decays the rules (`src/engines/use-cases/stage.ts:78-84`). priority@2 shadow stores both orders on one `priority_runs` row.
- Test honesty: the 132 removed `expect`s are the v1 Assistant's (18 tools, history caps, `maxTurns 30`, `costCapUsd`) replaced by v2 tests, the migration counts, and golden `knownGap` flips that now assert the fixed behaviour. No `.skip` added to a previously passing test; `describe.skipIf(!BE1B)` is the existing Postgres gate pattern.

## Findings

Severity: **fix-before-next-wave** (F) · **later** (L). None is a blocker.

**W12-1 (F) · The scanner's daily hard cap still pauses silently instead of raising a hand.** `src/scanner/runtime/scanner-runtime.ts:303-311`: when `todayUsd >= hardCapUsd` a traversal scope is set `paused: 'budget'`, Health goes Degraded with "resumes tomorrow", and nothing else happens. Jobs got the H-5 treatment (`src/llm/spend/day-gate.ts` records one `SPEND.DAY_BUDGET` event); chat gets "Allow more". Scans at the day cap offer no Allow-for-today. Fix: route the cap hit through the governor (`hold()` → `ok:false, reason: 'day_budget'` → one `SPEND.DAY_BUDGET` event with the same fingerprint, and a needs-you row whose verb is "Allow for today" → `raiseToday`). Owner: integrator (small) or p3-home-briefing with the needs row.

**W12-2 (F) · `act` allow-class applies on the router's reading alone.** `src/llm/chat/tools.ts:316`: `userAsked = ctx.route.intent === 'act'`, where the intent is a regex over the whole user turn (`src/llm/chat/router.ts` `ACT`). Inside an `act` turn the model may call `act` on any item id, including one the user did not name (a hallucinated or stale id), and `done`/`not_mine` land immediately. It is local, audited (`host.applyStaged`, actor chat) and the receipt has Undo, so nothing leaves and it is recoverable; but D-58 said a card. Fix: in `classifyAct`, allow only when the target is the one the turn names (the item's title or id appears in the user text, or the item is the message's `context` item); otherwise stage. Keep `rerank` and `settings` as they are (rerank is harmless; settings already stage). Add a tool test for a `done` on an unnamed id → staged. Owner: integrator (chat is unowned now). Record the D-58 change in `docs/DECISIONS.md` either way.

**W12-3 (F) · The FTI A/B gate ignores closures.** `tests/evals/scanner/fti.eval.ts:162-164` asserts recall, precision and $/item; the table shows FTI closures 14/15 vs agentic 15/15 and nothing fails. The miss is the `claude_sessions` case (not an FTI source, so its completion signal never reaches the interpret step in the eval). Fix: assert `closuresPassed >= agentic` and either route non-FTI sources through the agentic closer inside `runFtiCase`, or mark that case's closure as agentic-only in the fixture with a reason. Owner: integrator.

**W12-4 (F) · One source of truth for "what needs me" is still three.** `needsYouCount` (`src/engines/activity/needs-count.ts`), `triageCount`/`outboxCount` (nav-and-pages) and the Health `spendAsks` each count their own rows; use cases add a fourth term. p3-needs-queue is building exactly this; the fix-before item is for the integrator: when it lands, every badge must read the queue (`tests/ui/counts-parity.test.ts` extended to the sidebar total), and the stub `use_case_candidate` provider must be wired to `src/engines/use-cases` (the builder was told). Owner: p3-needs-queue + integrator.

**W12-5 (F) · Settings has no control for two new switches.** `settings.closing.resolutionEngine` (shadow / v1 / v2) and `settings.chat.routing` ("Always Sonnet") are set only by API or the composer menu; Health's Ranking and Resolution lines point the user at Settings that do not show them, and the Preview-new-ranking toggle has no "make this my list" step. Fix: one row each in Settings ▸ Sending (closing) and Settings ▸ Budgets (routing, with the priority engine next to it), plain words. Owner: p3-home-briefing (it touches Home/Today and has the settings page as a dependency) or integrator.

**W12-6 (F) · `priority.rerank` and `attribution.dc_suggest` share 06:45; `priority.feedback` and `resolution.sweep` share 03:40.** `src/worker/schedules.ts:62-68`. Harmless for correctness (the queue serialises), but the first morning re-rank then runs before the DC suggestions and the engagement rollup it should read (02:50 rollup → 06:45 suggest → re-rank). Fix: move `priority.rerank` to 06:55 and `priority.feedback` to 03:50. Owner: integrator.

**W12-7 (F) · Release items never reach the in-app Outbox.** `scripts/release/publish.ts` writes `dist/releases/outbox-<v>.json`; the distribution builder flagged that the `release.drive_upload` handoff and the Slack announcement need an `OutboxAction` and a draft channel (`src/contract/nba.ts`, Outbox UI). Until then the Slack announcement is a file, not a draft the user Approves, so the "Drive + Slack announce" decision is half-built. Fix: add the two actions as ordinary drafts (`dryRun: true`, the handoff with "Copy upload instructions" and no tool call), created by `publish` through the DataSource when the app is running, else written to the file as now. Owner: p4-release-2.0 (with the integrator; it is the last piece of D-90).

**W12-8 (F) · Compaction keeps six turns and summarises the rest through the model: book it and show it.** `src/llm/chat` compaction at 50K tokens is right (no arbitrary cap, the thread continues), but the summary call is a model call per thread; confirm it books an `llm_calls` row with the thread id and that the receipt line says "summarised N turns" so the cost line stays honest (the "no hidden spend" tenet). Owner: integrator (verify; one test if missing).

**W12-9 (F) · Three Postgres test files raised their per-test timeout to 120 s** (`tests/ledger/db.test.ts`, `tests/llm/measure.db.test.ts`, `tests/trace/db.test.ts`, commit fab8f12) to survive the overloaded build machine. Keep it only if `p1-test-projects-and-moves` puts them in the serial DB project; otherwise a 120 s cap hides a real regression. Owner: p1-test-projects-and-moves.

**W12-10 (L) · `src/personas/gates.ts` `TOOL_GATES` lists the v1 `chat_*` tool names** and is unused for chat since v2; the persona gating of VDP views now lives in `src/server/chat/views.ts`. Remove the dead table and point `docs/personas` at the views. Owner: p1-datasource-split or the docs pass in p4-release-2.0.

**W12-11 (L) · Naming is split until the rename.** User-facing strings already say "Command Center" (UpdateBanner, install.sh, Settings ▸ About) while the package, the state folder, LaunchAgent labels (`com.controlcenter.*`), `control_center` databases and the test DB prefixes say Control Center. Fine as long as `p4-rename-command-center` is last and renames the plists and the DB name with the folder migration, and `docs/INSTALL.md` is regenerated after it. Owner: p4-rename-command-center.

**W12-12 (L) · `CHANGELOG.md` has no entry for any wave-1/2 chunk.** Owner: p4-release-2.0 (one 2.0.0 section written from `CHUNKS.md`).

**W12-13 (L) · Journal `when` values of 0029–0035 are hand-set and sit a day ahead of the clock.** Harmless (only order matters and 0027 is earlier), but any future `drizzle-kit generate` will produce a `when` *older* than 0035's and the migrator will refuse it as "skipped". Fix in the release pass: a hygiene test that the last journal `when` is not in the future, or renormalise the seven values to real timestamps in 0.0.1-second steps. Owner: p4-release-2.0.

**W12-14 (L) · `scan:private` must run before the push.** `docs/research` is excluded from the build, but tracked files in the review folder name Org62 ids and customers; the integrator's status report should remind Tristan to run `npm run scan:private` before pushing to his fork. Owner: integrator (status report).

## Original asks scorecard (after waves 1–2)

| # | Ask | Status | What landed |
|---|---|---|---|
| 1 | UI quality: drafts list, Needs-you queue | partly | Component kit, 7-item nav, Triage/Outbox drains, Settings 5 sections, Getting started, Today on the kit (p3-component-kit, p3-nav-and-pages). Needs-you as one queue and Home are wave 3 (running). |
| 2 | Scanners miss and auto-close | done (shadow) | Resolution check in shadow by default with Undo and reopen rules; golden evals 180/180; SCN-1/4/9/11/14 flipped from known gaps to fixed. Needs a week of shadow data before the engine is switched on. |
| 3 | Scanning cost ~$10/day → very cheap | done (measured offline) | FTI is the default: 0.15× the agentic cost per item on golden cases; a 30-day first scan estimates $0.26 for a busy SE (pessimistic $0.63) vs $16 measured agentic. Live relay size still to confirm on the work machine. |
| 4 | Assistant usefulness, no arbitrary caps | done | v2: 11 tools, `query` over curated views, Auto routing, persisted sessions, plan card, compaction instead of history caps, per-message holds. W12-2 and W12-8 to tighten. |
| 5 | Spend caps = estimate → warn → raise hand → continue | mostly | Governor with holds, asks, Allow $Z / today / Stop in scans, jobs and chat. One gap: the scanner's day cap (W12-1). |
| 6 | Time logging: auto-attribution, Org62 discovery, DC suggestions, "AEs I cover" | done (engine), partly (UI) | Attribution engine with learned rules, `opp_engagement`, DC suggestions, covered AEs, Org62 discovery job; use-case candidates stage VDP + Org62 together. The Review page of checkboxes is p3-activity-review (running). |
| 7 | Pluggable connectors + LLM provider | done | ConnectorRuntime (claude_relay / direct_mcp / http_jsonrpc / local_files), manifests + registry, ModelProvider as the only SDK importer (lint-enforced). |
| 8 | Data model correctness | partly | Attribution/use-case/priority/chat tables with FKs and checks, journal repaired; the kv side-car → columns move is p4-sidecar-to-columns (not started). |
| 9 | Light structure docs + lint | done | CONTRIBUTING/AGENTS rewritten, layer lint, max-lines warnings, ADR index, ARCHITECTURE as built. |
| 10 | Module-isolated testing | partly | Eval harness with cassettes and the A/B gate; per-module vitest projects and the folder moves are p1-test-projects-and-moves (not started). |
| 11 | Maintainability refactor | partly | Kit, engines, errors catalog, doctor as service; the DataSource strangler split is p1-datasource-split (not started). |
| 12 | Packaged app + updates + Slack feedback intake + compliance | partly | Compiled release with manifest, smoke, staged install and rollback, update check from the shared Drive folder, feedback intake docs; the in-app release drafts (W12-7) and the bundled Postgres installer (running) remain. |
| 13 | Migration path for data changes | done | Additive migrations 0029–0035 with the journal/snapshot discipline, `update.mjs` backs up and migrates, the migrator refuses out-of-order journals (W12-13 to harden). |
| 14 | Out of the box for non-technical users, end-to-end errors | partly | Health ▸ Setup with catalog-driven next steps, doctor every 15 min, error codes everywhere, Getting started outcomes; the Homebrew Postgres prerequisite goes away only with p4-bundled-postgres. |

(The original list had twelve asks; 13 and 14 are the two Tristan added in the same message.)
