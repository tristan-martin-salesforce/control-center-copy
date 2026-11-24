# 26 · Caps audit: every fixed number that limits what the app does (Fable, 2026-11-21)

Lane `post-caps-audit`, on `tmart2322/control-center-port-polish` from 413032c. The rule (owner, memory "no arbitrary caps"; README §8 asks #4 and #5; H-5 / D-80): **a limit exists only for a real external limit, a user budget or safety; otherwise estimate → warn → pause → continue.** Every number below was classified; every arbitrary one in this lane's files was fixed with a test or is listed with a proposed fix and the reason it was not fixed here.

## Summary

- **1,590 hits** from the brief's sweep (`.slice(0, N)`, `limit:`, `MAX_*`, `max*:`, `cap*`, `take(N)`), plus `.slice(0, CONST)`, "and N more", and SQL `LIMIT` / `limit N` in reads.
- Per class: **a** real external limit or prompt budget 131 · **b** user budget 7 · **c** safety, page or memory bound 148 · **d** arbitrary 79 · **d-rank** deliberate top-N with the full set elsewhere 239 · not a limit: formatting 354, free-text trims 473, dev tooling 151, caller-supplied 8.
- **d, 79:** 42 fixed in 18 commits; 23 in this lane's files kept with a proposal (F-3 to F-12: a governor integration, a cassette re-record or a question to a system owner); 14 in other lanes' files, proposed for the orchestrator (F-1, F-2, F-13).
- **The Assistant has no arbitrary cap left on its own path.** Steps per message (200) are a runaway guard you set in Settings ▸ Budgets, and you are told when it trips. A research run is bounded by the budget you approved on its plan; it was also stopped at 16 turns, and that limit is gone (62f5202). Cost goes through the governor: estimate, hold, ask, then continue on "Allow $X more".
- **The user is told.** Every remaining bound either pages to the end, carries its total ("N more", `…Total`, `…Count`, `sheetsNotRead`), names its source in a comment, or (VDP's 20-opportunity limit) gives the reason on the row.

Classification method: four read-only forks classified the 1,254 slice hits by directory and wrote one TSV row each. I read every array-shaped slice they marked a, c, d or d-rank. I classified the 253 non-slice hits and 83 SQL limits by hand. Appendix A is generated from those rows, so the counts add up.

## Fixed (class d → whole, paged or counted)

Lines as of 413032c.

| file:line | was | now | sha |
|---|---|---|---|
| `src/llm/spend/governor.ts:228` | sweep abandoned stale holds among the newest 500 live ones | every live hold (a missed one kept holding money against the day) | 3581115 |
| `src/server/datasource/{db,mock}/domains/health.ts:114/43` | Health listed 20 open spend asks | every open ask (an unseen ask waits a day, then is abandoned) | 3581115 |
| `src/server/datasource/{db,mock}/domains/health.ts:349-350/55-56` | receipts counted the newest 500 holds of 7 days; 50 asks | every hold and ask of the window ("N runs held" was wrong past 500) | 3581115 |
| `src/server/datasource/db/spend.ts:191`, `src/llm/spend/memory-store.ts:65` | `listHolds` with no `limit` silently returned 200 | no `limit` = every match | 3581115 |
| `src/scanner/runtime/scanner-runtime.plan.ts:246` | closed earlier days' day-cap asks among the newest 20 | all of them | 3581115 |
| `src/jobs/handlers/activity-suggest.ts:45-47` | 15 calls / $0.15 a pass, then waited for a changed row (the backlog past one pass was never asked) | a page; the next page is queued while rows are due (`src/jobs/pass-pages.ts`), daily hard cap checked per call, no progress → no next page | 3e530bf |
| `src/jobs/handlers/activity-notes.ts:48-50` | 12 calls / $0.10 a pass, same | the same pages | 3e530bf |
| `src/scanner/fetch/slack.ts:145, 185` | opened the oldest 5 threads (10 on backfill), dropped the rest; each read cut at 30 replies | every thread found, each paged at 100 under `maxPages` | a155f39 |
| `src/scanner/runtime/connectors.ts:322` | the first 200 Org62 account ids by id (accounts past them lost opp coverage) | every id; the fetch splits into IN clauses of 200 (`ORG62_IN_CHUNK`, named for SOQL's statement size) | ffeb2a3 |
| `src/scanner/triage/slack-triage.ts:37, 267` | 12 batches; lines past them got no verdict and no flag | every batch by default (each has its own cost cap; daily hard cap applies) | 99faf99 |
| `src/server/chat/research.ts:111, 127` | 16 turns ("at most 16 turns" in the prompt) | turns are a runaway guard (200); the approved plan's hold and the watchdog bound the run | 62f5202 |
| `src/scanner/completion/pass.ts:253`, `src/scanner/store-db.ts:258` | the newest 400 open items (db clamp 2,000) were checked | every live item (the model work stays paged by `maxItemsPerPass` with a follow-up) | d45b5c0 |
| `src/scanner/reconcile/reconciler.ts:257` | post-relink re-read of the 500 newest-flagged rows could miss the batch it had just re-flagged | every unlinked row | d45b5c0 |
| `src/connectors/google/gmail.ts:97, 186` | thread lookups for the first 20 of up to 40 messages ("did I reply" unknown for the rest) | every chosen message's thread | 4570189 |
| `src/scanner/drive-digest/diff.ts:21-22`, `fetcher.ts:156` | first 8 added/removed lines with no count; sheet tabs past 8 never read, no word | lists keep 8 and carry `linesAddedTotal` / `linesRemovedTotal`; the tab bound is named (Sheets per-user read quota) and the change says "N more tabs not read" | 98dbc0d |
| `src/scanner/interpret/render.ts:30, 34, 35` | glossary sorted by id and cut at 40 accounts / 40 channels / 25 initiatives | all of them (the glossary is the cached part of the prompt) | 634e636 |
| `src/engines/vdp/assets.ts:384, 385, 410`, `src/server/datasource/db/store/vdp-candidates.ts:112, 123`, `store/vdp-assets.ts:136` | an asset candidate kept 8 sources / 20 source items on a merge; links past 20 in a source never became candidates | every one, deduplicated (*Provenance on everything*) | 5031fbd |
| `src/engines/activity/propose.evidence.ts:77`, `propose.ts:178` | an onsite day's row carried 12 evidence ids | every signal's evidence | 5031fbd |
| `src/engines/use-cases/view.ts:102` | "decided" list: the newest 50 of 30 days, no count | the whole window | b07d9de |
| `src/server/datasource/db/forecast.ts:100`, `mock/forecast.ts:125`, `src/server/forecast/draft.ts:169`, `src/jobs/handlers/forecast-sync.ts:253` | meetings since the notes changed: the newest 12 | all of them | e0a93ab, b64e41e |
| `src/server/chat/compact.ts:151, 152, 155, 159` | context pack cut promises (4), fit-ins (4), calendar (14), applied (5) with no count | rows kept as a per-turn budget; each list carries its whole count | bf307d5 |
| `src/engines/vdp/gaps.ts:409` | opps past VDP's 20 were silently left off a create_vdp, their rows pointing at it | the limit stays (VDP's own); each opp past it says why | c9a8b38 |
| `src/llm/cc-tools/handlers.ts:539` | HIGHLIGHTS fallback kept 12 lines | every line; the watch's own `maxHighlights` (a setting) decides what shows | fdb3f21 |
| `src/server/forecast/soql.ts:18` | 8 pages (200 Specialist Forecast records), then a partial read every sync | pages to the end; 400 pages is a runaway guard, and a page that does not move the cursor stops (safety) | 6c98270 |
| `src/scanner/store-db.base.ts:319, 337`, `store-db.items.ts:29, 67`, `src/worker/scanning.ts:101` | scan context: first 500 accounts, an unordered 500 channels, newest 200 initiatives, open items clamped at 1,000; Drive tracked the newest 500 items' files | all of them; `maxOpenItems: Infinity` = every open item (default 60 stays the scan pack's budget) | b64e41e |

Each fix has a test: `tests/llm/spend/governor.test.ts`, `tests/jobs/pass-pages.test.ts`, `tests/db/datasource/activity-suggest.test.ts`, `tests/scanner/fti-fetch-slack.test.ts`, `tests/scanner/fti-fetch-org62.test.ts`, `tests/scanner/runtime/planner-skills.test.ts`, `tests/scanner/stress/rec1-triage.test.ts`, `tests/chat/chat-research.test.ts`, `tests/completion/completion-pass.test.ts`, `tests/scanner/runtime/store-memory.test.ts`, `tests/connectors/readers/gmail.test.ts`, `tests/connectors/readers/drive.test.ts`, `tests/scanner/fti-classify.test.ts`, `tests/vdp/assets-steps.test.ts`, `tests/engines-org62/overlaps.test.ts`, `tests/use-cases/engine.test.ts`, `tests/forecast/forecast.test.ts`, `tests/chat/context-pack-counts.test.ts`, `tests/vdp/gaps.test.ts`, `tests/scanner/runtime/cc-tools.test.ts`, `tests/db/forecast/forecast-db.test.ts`, `tests/db/worker/store-conformance.ts`. In the common case the behaviour is unchanged (under every old bound the same rows come back).

## Left in this lane's files, with the proposed fix

- **F-3 `src/jobs/handlers/use-cases-extract.ts:40` (12 confirm calls a pass). Done, 7339fb6 (post-worker-followups):** each answer is kept per (source, prompt version, statements) in the job's kv `cc.use_cases.confirm` (no migration), an unusable one as none, a failed call not at all; a pass asks only what is unanswered, a page of 12 at a time, and queues the next page while sources are due (`pass-pages.ts`); past its hold it asks and its continuation carries the hold (before, the pass settled the hold right after asking, which closed the ask). Tests: `tests/jobs/use-cases-cache.test.ts`, `tests/db/worker/job-spend.spec.ts`. The finding as written: The model confirms the first 12 unsure sources, and the next pass re-derives the same unsure set and asks the same first 12 again. There is no answer cache, so the comment "a pass with more unsure sources finishes them on the next one" is not true. Removing the 12 without a cache would re-pay for every unsure source on every pass. Fix: cache confirm answers by content hash (as activity-suggest does in kv), skip answered sources, then use the pass pages (`src/jobs/pass-pages.ts`). It already holds a governor estimate and asks past it.
- **F-4 per-feature cost and turn caps not yet on the governor (D-80 says it replaces every one).** Each run fails at its own cap and never asks. **Done for every row (post-worker-followups):** the shared envelope is `src/llm/spend/job-spend.ts` + `src/jobs/spend-pause.ts` (acbffc7): a job runs under the hold the worker's start gate took for it (or its own, or the one its continuation carries), asks past it, and queues its continuation with `vars.spendHoldId` (Allow runs it through `requeueSpendJob`, Stop cancels it); the old numbers are only the runaway guard's floor, and the user budgets above them stay lines. Generic path through the real worker: `tests/db/worker/job-spend.spec.ts`. **Resolved, post-job-kinds (24a41aa):** the follow-ups note said `LLM_JOB_KINDS` listed `readin.research` and `vdp.assets`, but the real kinds are `readin.generate` and `vdp.assets.find`, so the start gate never held for those jobs and each took its own hold. The table now names them, priced as the handlers price them; the gate's hold is the one kept (the handler finds it by `<kind>:<id>` and takes none), so there is one hold, one ask and one settle per run. The rule (listed exactly when the registry entry says `spends: true`) is pinned by `tests/jobs/job-kinds.test.ts`; the real worker drill for both jobs is `tests/db/worker/job-kinds-spend.spec.ts`. **Resolved, post-relay-holds (b0b4ad5):** the job-kinds note said the four relay jobs (`vdp.specialist_aes`, `accounts.hierarchy`, `org62.readback`, `org62.discover`) were held twice while they ran (the gate's hold plus `relayGuard`'s per lookup) and their hold records reported the spend twice, skewing the overrun median. `relayGuard` now books every lookup into the job's one hold (the gate's, or the one a continuation carries) and opens none of its own; past it the job asks once between lookups ("This lookup has used $X of its $Y estimate…") and its continuation reads on under the same hold (Allow runs it, Stop cancels it). The static table gains job-sized relay rows per skill so a job with no history does not ask on every run. A direct call with no job hold keeps the per-lookup hold. Drill `tests/db/worker/relay-holds.spec.ts` (four kinds), unit `tests/jobs/relay-guard.test.ts`.
  - read-in `READIN_DEFAULTS.maxTurns 14` / `costCapUsd 0.35` (`src/contract/readin.ts:143-144`). **Done, 602ae87:** the governor's hold replaces D6's reservation; past it the agent asks and ends `paused_for_spend`, the job keeps older content and queues its continuation; the SDK budget is 4× the hold but never past the day line left; 14 turns → 200 (a runaway guard). The prompt's "budget: at most 14 turns and $0.35" line is unchanged (guidance; changing it changes the prompt). Test `tests/jobs/readin-spend.test.ts`.
  - the diagnose run `FEEDBACK_MAX_TURNS 14` / `FEEDBACK_CAP_USD` (`src/server/feedback/agent.ts:48`). **Done, 03f7ec7:** it holds its estimate (scope `feedback`); past it, at the next tool call, it asks and waits in the process for the answer (the Assistant's pattern; the watchdog does not count the wait; no answer in a minute or Stop: the app's own reading is the report, with a note). Test `tests/llm/spend/diagnose-spend.test.ts`. The Feedback panel itself shows nothing of the ask yet (components lane): it is in Health ▸ Spend.
  - VDP Find assets `$0.50` per run (`src/jobs/handlers/vdp-assets.ts:106`). **Done, 4d8492d:** the hold goes to its research run (the read-in agent); the `cap_usd` Find assets sets, the research budget per run, the assistant's day line and the hard cap stay lines. Test `tests/jobs/vdp-assets-spend.test.ts`.
  - the brief's `DEFAULT_MAX_CALL_USD 0.1` (`src/jobs/handlers/brief.ts:63`). **Done, f43ccab:** one call's budget is the runaway guard; past the hold it asks before the next watch's call and the watches still due wait in one queued run carrying the hold. Test `tests/db/worker/job-spend.spec.ts`.
  - the completion judge's `maxCallUsd 0.05` (`src/scanner/completion/pass.ts:81`). **Done, acbffc7:** per-call budget = the runaway guard; past the hold with items left the pass asks and the rest waits as the one queued check; its default estimate is its $0.40 page. Test `tests/scanner/completion-spend.test.ts`.
  - the relink's `0.05` / `0.25` (`src/scanner/reconcile/reconciler.ts:223`). **Done, 439548a:** a hold per relink run (defaults = the old caps), handed to the runner; a relink that asks ends paused (attempts stay), the connector's relinks wait while the ask is open, an allowed hold is resumed by the next pass. Test `tests/scanner/relink-spend.test.ts`.
  - FTI `costCapUsd` (`src/scanner/runtime/fti-specs.ts:46`). **Done, 8b1ce80:** the FTI runner never reported to the scan's hold (so it never asked, and `costCapUsd` only floored the runaway guard); every relay read and classifier call now ticks it, and past it the run pauses before its next batch (`paused for spend`, which the runtime keeps queued with the hold); applied batches keep their verdicts. Test `tests/scanner/fti-spend.test.ts`. `fti-specs.ts` itself is unchanged (its numbers are now only the floor; its TODO comment is another lane's file).

  The day budgets above them (read-in $/day, the hard cap) are user budgets and stay. Fix: the scanner's pattern, `SpendGate` in `skill-runner.ts`. Hold the estimate, raise a hand at the next tool call, and queue the continuation with `vars.spendHoldId` so "Allow $X more" re-runs it (`requeueSpendJob`). Make turns a runaway guard, as in 62f5202. This is one chunk of work, not an audit fix.
- **F-6 `src/engines/activity/suggest-prompt.ts:42` (15 candidates).** It is a ranked prompt budget, but open opps are listed before tied closed ones, so an evidenced closed opp can fall past the 15th. Fix: tied first, then the rest by rank. This changes the prompts, so re-run the activity evals.
- **F-8 `src/scanner/resolution/triggers-db.ts:77, 104, 163` (800 / 2,000 / 2,000), `src/projections/work-accounts.ts:26` (2,000).** These are per-pass bounds of heavy queries. Items past them are skipped this pass and are not always reached on a later one: the sort is by `updated_at`, so an untouched old item stays out. Fix: keyset pages (`updated_at, id`) to the end, the same way `forecast-sync` does now.
- **F-10 `src/server/chat/research.ts:118` (20 names).** It mirrors the tool schema `names.max(20)` in `src/llm/chat/tools.ts` (another lane's file), and the model gets a validation error past 20. Fix: lift both.
- **F-11 `src/engines/use-cases/stage.ts:90` (6 products, mirrors `Products.max(6)` in `src/contract/use-cases.ts:95`), `src/engines/vdp/identity-judge.ts:49` (20 aliases), `src/engines/vdp/identity.ts:161` (50 aliases).** It is not known whether Org62 or VDP limit these. Ask the VDP owners, then name the limit in a comment or lift it.
- **F-12 prompt counts set ahead of a token trimmer. Left (not re-recorded), with markers, 3ddc2bd (post-worker-followups):** every cut below keeps exactly what it kept and logs one `BUG.PROMPT_CUT` line (catalogued) with the site and how many rows it dropped, at most once per site every 10 minutes (`src/engines/prompt-cut.ts`; sites `nba.assets`, `nba.siblings`, `resolution.sessions`, `settle.dm_middle`, `settle.elsewhere`, `settle.events`, `settle.siblings`, `settle.load.elsewhere`, `settle.load.events`). The next live run's worker log says whether the trimmer alone would do; then drop the counts and re-record. Test `tests/errors/prompt-cut.test.ts`. The finding as written: `src/engines/nba/prompt/build.ts:104, 110` (12 assets, 10 siblings; `fitToBudget` trims anyway), `src/engines/resolution/pack.ts:134` (2 sessions), and Settle's `context.ts:184-212` / `load-db.ts:244, 282` (Settle is being merged into the resolution check, H-7). Dropping the counts changes the cassette-keyed prompts. Re-recording needs live model calls, which this lane may not make. Fix in the chunk that re-records the cassettes.
- `src/engines/activity/canvas-review.ts:110, 169` (20, 25) has no live caller (tests only). Proposal: delete it.

## Findings in other lanes' files (for the orchestrator)

- **F-1 (Assistant) `src/components/settings/BasicSections.tsx:356`.** The "Steps per message" input is `max={80}` with a fallback of 30, while the setting defaults to 200 and the contract allows up to 400 (`src/contract/settings.ts:364`). The input shows 200 against a max of 80 and can't save a valid value above 80. Fix: `max={400}`, fallback `200`, help "A runaway guard; cost is bounded by the per-message budget". **Fixed (post-caps-ui, e4bba1c):** the input takes every value the setting does (its max is read from the contract, 400), shows the default 200, and the helper says it is a runaway guard and that the Assistant tells you when a message stops there. **Ceiling lifted (post-caps-ui-2, d506d04):** `ChatSettings.maxSteps` is `.int().positive()` (no `.max(400)`), the input has no max, the helper says "any positive number; the Assistant stops and asks when it is reached", and the stop message names Steps per message and Settings ▸ Budgets ▸ Assistant limits.
- **F-2 (P25-11) `src/contract/settings.ts:169` `AUTOPILOT_ASSET_HOSTS_MAX = 50`** (and `src/outbox/settings.ts:36`). This is a bound on a user settings list (b). The Settings row should say "up to 50 sites". `src/contract/requests.ts:51` `limit ≤ 500` on `ItemsQuery` is a page with a cursor (c), so keep it. The scan ledger is the one place where it is not a page: `getScans` (`db/domains/health.ts:303`, mock `:185`) takes a `ListQuery` limit with no cursor, so scans older than the newest 500 can't be reached. Fix: add `cursor` to `ListQuery` (requests.ts). **Fixed (post-caps-ui):** the trusted-sites bound was already removed by 943d654 (P25-11: no count cap), so the Settings row has nothing to add. GET /scans pages by a keyset cursor (536827b): `ListQuery.cursor`, `ScansPayload.nextCursor` and `total` (additive), db and mock through one pager (`scanPage` in `src/server/views/health.ts`), and Health ▸ Ledger has "Show 100 more · N of M runs loaded".
- **F-5 (Assistant) `src/llm/chat/tools.ts`.** `chat_log_batch` passes the newest 10 applied canvases with no total (`src/server/datasource/log-canvases.ts:138`); add `appliedTotal` + `offset`. `vdp_find_assets` holds at most `$50` (`tools.ts:493`), a safety ceiling under the approved plan; it should say so in its comment. The resource chips stop at 4 queued VDPs (`:494`); add a "+N more" chip. **Fixed (post-caps-ui-2, 25ec609):** `applied` is a page of 10 with `appliedTotal` and `appliedNextOffset` (the read takes `appliedOffset`), `VDP_ASSETS_RUN_CEILING_USD` names the $50 safety ceiling, and past four VDPs a "+N more VDPs · Assets to add" chip opens Activity ▸ VDP.
- **F-9** `searchGoogle` (`src/server/datasource/db/chat-be6.shared.ts:87`) clamps to 10 but is unreachable: only the ledger reaches `searchSources`. Delete it. **Fixed (post-caps-ui-2, 4cc373f):** deleted, with its `searchConnectors` wiring in `chat-be6.ts`; live Gmail and Drive search stays on the `search` tool, paged by `page_token`.
- **F-13 components (visual-QA lane), lists cut with no way to the rest:**
  - `chat/ThreadContextPane.tsx:133, 149, 267`: items 6, agents 3, sources 6. Add "Show all N". **Fixed (post-caps-ui-2, fb714c3):** items and sources open up with the cards' Show more control (`useReveal`), the agent line has Show all N.
  - `composer/DraftProposal.tsx:107`: the conflict diff shows 4 spans a side before keep/take. Show all spans. **Fixed (post-caps-ui-2, 75c3dc5):** every span a side; a long list scrolls inside the banner.
  - `deals/panels.tsx:118`: 6 tasks, the title counts all. Add "See all N" to Work filtered by account. **Fixed (post-caps-ui-2, 20293e5):** past six, "See all N in Work" opens `/work?account=<id>`.
  - `detail/tabs/HistoryTab.tsx:38`: 4 changed fields. Add "+N more fields". **Fixed (post-caps-ui-2, a429eff):** four, then "+N more fields" shows the rest.
  - `health/RaiseCap.tsx:118`: 8 raises. Add "Show all N". **Fixed (post-caps-ui-2, 9a569b5):** eight, then "Show all N" (every kept raise).
  - `needs/NeedActionRow.tsx:76`: 3 answer buttons; choices 4-9 are reachable only by key, and past 9 not at all. Render every choice or add a "More…" menu. **Fixed (post-caps-ui, b55ea72):** three buttons, then a "More… (N)" menu that lists every other choice.
  - `settings/TimeSection.tsx:283`: DC products are cut at 30 (contract `.max(30)`). Say "up to 30", or lift the bound. **Fixed (post-caps-ui-2, 38573a3):** the row says "Up to 30" (read from the contract), and past 30 it says how many won't be saved. Lifting the bound is a contract change outside this chunk (a user settings list, class b). **Lifted (post-contract-bounds, 3cda1e7):** no count bound; the row quotes none and keeps every product.
  - `today/AgentPlan.tsx:71`: 8 per group. Add "Show all N". **Fixed (post-caps-ui-2, 2516c1b):** eight per group, then "Show all N" (`SinceGroup`).
  - `today/parts.tsx:126`: the tool-run form renders the first 6 schema fields, so a required 7th is never shown. **This is the most serious one: render every field.** **Fixed (post-caps-ui, 0ef2bce):** every field renders; past seven, the optional ones after the first six fold under "More (N optional)", and a required field is never folded.
  - Low: `detail/nba/NbaSection.tsx:287` (3 alternatives), `domain/NbaCard.parts.tsx:61, 107` (4 reasons, 3 inputs). **Fixed (post-caps-ui-2, a940a27):** the Why popover has "+N more reasons" and the Plan block "+N more inputs". The alternatives need no change: `NbaCard.alternatives` is `.max(3)` in the contract (a ranked candidate list, kept), so the slice hides nothing.

### Fixed after the audit (post-caps-ui, 2026-11-21)

- F-1 Steps per message: e4bba1c. F-13 tool-run form: 0ef2bce. F-13 NeedActionRow choices: b55ea72. F-2 scan ledger cursor: 536827b (the trusted-sites bound was already gone, 943d654).
- `skills/research-question.md` said "turn and cost budget"; the Run block states the cost only, so the skill says the cost budget (87c6c81).
- Agents reads through an `agents` scope (61fc923; 27-read-profile.md).
- Post-caps-ui-2 (2026-11-21): F-1 ceiling lifted (`maxSteps` is `.int().positive()`; the stop message names the setting): d506d04. F-5: 25ec609. F-9: 4cc373f. F-13: thread pane fb714c3, conflict spans 75c3dc5, account tasks 20293e5, History fields a429eff, cap raises 9a569b5, DC products 38573a3, Since you left 2516c1b, NBA card a940a27 (engine fan-out bounds held: 22a3f98).
- Nothing from the "other lanes" list is open. The DC products bound is lifted, the NBA alternatives bound is kept with its reason, and the unused `searchConnectors` seam is gone: see "Contract bounds" below (post-contract-bounds).

## Contract bounds (post-contract-bounds, 2026-11-21)

Every `.max(n)` in `src/contract/**` on an array or a number the user enters or sees (lines as of 8f3ec11). Classes: **external** (a limit outside the app, with its source), **budget** (a user budget or a prompt budget), **safety** (the reason given), **domain** (the value's own range: a percent, a weekday, a confidence, a scale), **page** (a page or batch whose caller pages or reads on), **d-rank** (a ranked preview already classified in Appendix A), **arbitrary** (lifted). Each lift is additive: stored values under the old bound still parse. Tests: `tests/contract/settings-bounds.test.ts`, `tests/contract/request-bounds.test.ts`, `src/components/settings/__tests__/dc-products-bound.dom.test.ts`, `list-editor-focus.dom.test.ts`.

| file:line | old bound | class | action | sha |
|---|---|---|---|---|
| `settings.ts:463` `TimeSettings.dcProducts` | `.max(30)` | arbitrary (matched locally against opp words) | lifted (no max); `TimeSection.tsx` "Up to 30" and the past-30 warning removed; `docs/UX.md` line rewritten | 3cda1e7 |
| `settings.ts:461` `TimeSettings.coveredAes` | `.max(50)` | arbitrary | lifted (no max); the owner reads go 200 ids a query (finding below for the team read) | adae347 |
| `settings.ts:553-554` `askFirstPeople`, `askFirstChannels` | `.max(50)` each | arbitrary (matched locally, `closure/correction.ts`) | lifted; `ClosingSection.tsx` `ListEditor` drops `LIST_MAX = 50` and "50 is the most this list holds" (the same editor had held Trusted sites at 50 although that contract bound went in 943d654) | cd562d9 |
| `settings.ts:563` `oldAskDays` | `.max(365)` | arbitrary (a comparison, no date built) | lifted (whole days ≥ 3); the Old asks input has no max, its error says "Whole days, 3 or more." | d06cbc9 |
| `settings.ts:664-667` retention horizons ×4 | `.max(3650)` | arbitrary | lifted to `RETENTION_DAYS_MAX` = 100,000,000 days, the external bound: the nightly cut-off `now − days` (`db/retention/policy.ts cutoff`) must stay a date Postgres accepts: `cutoff()` clamps at 0001-01-01 (years before AD 1 serialise in a form Postgres rejects, P33-1), so a huge horizon means keep everything | f21a0f5 |
| `canvas-review.ts:142` `useCase.agentTypes` | `.max(30)` | arbitrary (the real bound is Org62's `Use_Case_Agent_Type__c` picklist, 25 values, which `checkedUseCaseFields` enforces) | lifted (`.min(1)`) | 15a0257 |
| `nba.ts:294` `NbaCard.alternatives` | `.max(3)` | d-rank, kept: the card design shows exactly three expanded (two collapsed, `NbaCard.tsx:97`; `NbaSection.tsx:290` three), a fourth would be hidden by both slices, and the engine's prompt asks for 1-3 (`engines/nba/prompt/schema.ts:193`, brief 08 §2.3) | comment says why | ef222bc |
| `persona.ts:50, 67` `customRules` | `.max(50)` | budget (prompt): every enabled rule rides in each scan prompt (`src/personas/prompt.ts`) | kept, comment says why (`role.ts CUSTOM_RULES_MAX` mirrors it, persona lane) | ef222bc |
| `settings.ts:448, 451, 455` airport buffers | 240 legacy, 360 | safety: each buffer becomes Travel proposals split at midnight (`propose.meetings.ts:246`), so an unbounded value proposes days of travel | kept, comment says why | ef222bc |
| `settings.ts:183` `undoWindowSec` | 60 | safety: the send waits on the open composer's timer (`send-flow.ts`); a longer hold is Draft mode | kept, comment says why | ef222bc |
| `settings.ts:148, 214` VDP autopilot `dailyCap` | 500 | safety: a ceiling on a user budget for writes to an external system (D-60) | kept | — |
| `settings.ts:251, 253` budget raise; `:359, 361, 372` Assistant $/day, $/message, research $; `:566` stronger model $/day; `requests.ts:343` `allowExtraUsd` 5; `spend.ts:74, 87` 100; `vdp.ts:227, 229` 50; `onboarding.ts:195` backfill | $ ceilings | safety: a fat-finger ceiling on a user budget; the budget itself is the user's (b) | kept | — |
| `settings.ts:25, 53`, `chat.ts:95` weights and boosts; `:264` `alertPct`; `attribution.ts:67, 69, 98`, `deals.ts:341, 423…458`, `canvas-review.ts:136` split %; `settings.ts:111`, `onboarding.ts:105, 133`, `forecast.ts:210` weekday 0-6; confidences 0-1; `deals.ts:179` tier 0-3; `canvas-review.ts:131` `durationH` ≤ 24; `chat.ts:78` effort ≤ 960 min (a model-proposed op input), `chat.ts:249` a scan's window ≤ 30 days (an output field); `dev.ts:99` rate | ranges | domain | kept | — |
| `requests.ts:54, 87`, `deals.ts:271`, `spend-audit.ts:109` `limit ≤ 500`; `requests.ts:80` search 50, `:91` people 100 | pages | page: cursor or offset, or a typeahead that narrows as you type | kept | — |
| `landings.ts:130`, `canvas-review.ts:117`, `deals.ts:442`, `time.ts:571, 576, 578` 2,000; `deals.ts:398` `org62Ids` 100 | batches | external / page: SOQL `IN` ≤ 2,000 where the ids reach Org62, request size otherwise; "absent = every ready row" covers the rest; the Assistant pages `addOrg62Opps` by `ORG62_OPPS_BY_IDS_MAX` (`app-routes.ts:568`) | kept | — |
| `views.ts:103` pullForward 5, `views.ts:128`, `home.ts:466` cards 3, `nba.ts:391` earlier 5 (with `earlierTotal`), `priority.ts:51, 91, 127` 5/10/3 | output lists | d-rank (Appendix A: `HOME_CAPS.pullForward`, H-10 three do-now cards, Make room, the v2 preview, Health's top disagreements) | kept | — |
| `forecast.ts:48` draft sources 12; `feedback.ts:56, 76, 85` 10/8/12 | output lists | safety / external: model output already bounded tighter (notes ≤ 8 sources), Slack post 6,000 characters | kept | — |
| `use-cases.ts:95` `Products.max(6)`, `vdp.coverage.ts:463` aliases 50 | arrays | external unconfirmed: F-11 (ask the VDP owners) | kept | — |
| string `.max(n)` everywhere | lengths | external where named (Org62 ids 15-18, Name 255, Claude Desktop 14,336), else payload safety (text trims, Appendix A.2) | kept | — |

Also removed (2.): the unused `ChatHostBackend.searchConnectors` seam in `src/server/chat/host.ts` (b4de24e). Nothing implemented it after F-9 (grep over `src`, `tests`, `scripts`, `app`: no other reference); `searchSources` reads the ledger, and a live source asked of it gets "gmail, drive: not searched here (ledger only); search with source gmail or drive for live results" (the `search` tool's own sources). Test in `tests/chat/context-pack-counts.test.ts` (8f3ec11: a new test file pulled `overlap-flags.ts` past its fan-out ratchet).

Findings for other lanes:
- `src/engines/attribution/discover.ts:25` `teamSoql` puts me and every covered AE in one `UserId IN (...)`: past 1,999 covered AEs that is over SOQL's 2,000. Chunk it by `DISCOVER_BATCH` as `oppsSoql` does. **Done (post-soql-chunking, 921fccc):** the real bound is the statement's length, not a count (SOQL statement ≤ 100,000 characters; REST URI ≤ 16,384 bytes when the query goes over `GET`). `teamChunks` packs ids under 90,000 characters and 15,000 url-encoded bytes (about 550 ids a statement; a small team is still one statement, `teamSoql`); `readTeam` reads the chunks in sequence through the one-call read, pages by `Id` past a full page (`DISCOVER_LIMIT` 200) or `done: false` (the one-call path does not follow `nextRecordsUrl`), and merges by opportunity id. Tests: `tests/attribution/discover-chunks.test.ts`. **Job wired (post-soql-chunking, efc3f56):** `src/jobs/handlers/org62-discover.ts` calls `readTeam([...me, ...covered], read, found)` before the opp queries; a `partial` (cap, lookup failed) stops the run as before, and the result gains `teamStatements` and `teamReads`. DB test: 600 covered AEs read in several statements, the last AE's opp lands (`tests/db/attribution/attribution-db.test.ts`).
- `src/components/settings/BasicSections.tsx:163` Reopen window `max={60}` is a UI-only bound (no contract bound; `closureSettingsFrom` accepts up to 365). **Done (post-soql-chunking, 284d196):** no `max`, no 60-day clamp, `min={1}` kept; the helper says what the window does. Test: `src/components/settings/__tests__/reopen-window.dom.test.ts`. **Reload fixed (post-soql-chunking, 5790b08):** `parseThresholds` (`src/components/settings/derive.ts:125`) keeps the floor of 1 and has no ceiling: no contract bound applies (the thresholds are kept on this Mac), so it matches the input rather than `closureSettingsFrom`'s 0–365. A saved 90 survives a reload (`reopen-window.dom.test.ts`).

The open list is clear: DC products lifted, NBA alternatives kept with the card reason, `searchConnectors` removed.

## Kept as external, budget or safety (the named ones, one line each)

- **External:**
  - SOQL `LIMIT` ≤ 2,000, IN ≤ 2,000 and statement ≤ 100K characters (`src/llm/chat/soql.ts:17-19`)
  - Slack 10 files per message (`connectors/slack/parse.ts:197`)
  - Slack canvas 900 KB under 1 MiB (`lib/canvas/payload.ts:31`)
  - Slack post sizes: release 6,000, feedback 6,000, diagnostics 3,200
  - Postgres NOTIFY 8,000 bytes (`MAX_IDS` 50, `server/events/topics.ts:145`)
  - Claude Desktop `/code/new` 14,336 characters (`tools/claude-launch.ts:25`)
  - VDP: 20 Generates per 10 minutes (`connectors/vdp/limiter.ts:14`), 20 opportunities per VDP, 20 owners per role
  - SOQL child-to-parent depth 5 (`lib/accounts/hierarchy.ts:22`)
  - Sheets per-user read quota (`drive-digest` tabs, now counted)
  - API page sizes: Slack search 20, thread and channel 100, Org62 40-100, VDP 50, Gmail 40 a run. All are paged to the end or report `complete=false` and continue.
- **Prompt budgets** (the model is told the count or can read on): the scan pack (60 open items, 25 initiatives), interpret units, the completion judge (6 candidates, 14K characters), read-in context (8-14 per list, `readin_ledger_search` for the rest), brief context (60 accounts, 40 opps, 30 items, 400 messages, 7 days), voice samples (120), VDP known assets (40, deduplicated on store), context pack rows (now with counts).
- **User budgets (b), all in Settings:**
  - Assistant daily $, per-message $ and research $ (Settings ▸ Budgets ▸ Assistant)
  - steps per message 200 (same place)
  - the daily hard and soft caps and the read-in $/day
  - VDP autopilot daily cap 40 (Settings ▸ Sending, D-60)
  - a watch's `maxHighlights`, the policy's `top3Size`, trusted sites (no bound since 943d654, F-2)
  - Org62 discovery ≤ 20 lookups a day (H-9)
- **Safety (c):**
  - job `maxAttempts`, after which a dead job shows in Health
  - HTTP retries; child-process `maxBuffer`
  - the crash-loop guard (5 starts in 10 minutes, told in Health), notifications ≤ 6 an hour
  - redaction depth/string guards and the read cleaner's recursion depth 14
  - runaway guards: Assistant steps 200 (told), research turns 200, triage batch turns 16, the SFR guard of 400 pages plus no-progress
  - payload sanity: a card ≤ 2,000 calls, a talk-track reference ≤ 25 MB
  - the transcript's last 1,000 turns
  - pages that continue: the completion pass (48, follow-up), recall (25 per poll, rotating), the reconcile unlinked page (60, rotating), due schedules (50 a tick)
  - estimate samples, the newest 500 runs of 14 days
  - toasts on screen (3), resume routes (60)
- **d-rank (239), kept:** top-N previews whose full set is one click away (See all, Show all, "+N more", "N more match, type to narrow", Work, Triage, History), ranked candidate lists (attribution top 3/5, three alternates), Home's three do-now cards (H-10) and the 40-id Home order.

## Verify

Run on the lane tip, one heavy command at a time:
- `npm run typecheck`: 0 errors.
- `npm run lint`: 0 errors and 1 warning, the pre-existing `src/components/onboarding/steps.tsx` max-lines (onboarding lane).
- `npm test`: 443 files and 4,666 tests passed, 11 skipped.
- `npm run test:evals`: 8 files, 329 passed.
- `CC_TEST_DB_SUFFIX=postcaps npm run test:db`: 88 files, 985 passed, 6 skipped.

## Appendix A · every hit

Generated from the sweep (`grep` in the brief plus the slice-by-constant, "N more" and SQL sweeps) and the per-row classifications.

| class | hits |
|---|---|
| text | 473 |
| fmt | 354 |
| d-rank | 239 |
| dev | 151 |
| c | 148 |
| a | 131 |
| d | 79 |
| param | 8 |
| b | 7 |

### A.1 Every limit that is not formatting, text trim or dev tooling (a, b, c, d, d-rank)

Lines as of 413032c. "lane" = owned by another lane (proposal only).

| file:line | value | class | note / action |
|---|---|---|---|
| `scripts/dev/load-guard.mjs:44` | const MAX_PAUSE_MS = 10 * 60_000; | c | load guard pause ceiling (dev) |
| `scripts/ops/lib/backup.mjs:171` (lane) | export function backupDue(dir, db = DEFA | c | backup due after a day (ops lane) |
| `scripts/ops/lib/logrotate.mjs:8` (lane) | constructor(path, { maxBytes = 10 * 1024 | c | log file size before rotation (ops lane) |
| `scripts/ops/lib/pg.mjs:411` (lane) | const r = spawnSync(cmd, args, { encodin | c | child-process output memory bound |
| `scripts/ops/lib/pgwait.mjs:35` (lane) | export function backoffDelay(attempt, {  | c | backoff ceiling (ops lane) |
| `scripts/ops/lib/release-wiring.mjs:78` (lane) | const list = spawnSync('/usr/bin/tar', [ | c | child-process output memory bound |
| `scripts/ops/lib/release-wiring.mjs:81` (lane) | const r = spawnSync('/usr/bin/tar', ['-x | c | child-process output memory bound |
| `src/client/intent.ts:35` | 200 | c | ids scan of a write's array args (recursion/memory bound): keep; comment says safety bound |
| `src/client/intent.ts:41` | 200 | c | ids scan of array body fields (memory bound): keep; comment says safety bound |
| `src/client/resume/store.ts:45` | export const MAX_ROUTES = 60; | c | resume memory: 60 routes (browser storage) |
| `src/client/resume/store.ts:76` | MAX_ROUTES=60 | c | LRU of per-route resume state in localStorage: keep; storage bound, comment it |
| `src/client/toast/store.ts:11` | export const MAX_TOASTS = 3; | c | 3 toasts on screen at once (the rest queue) |
| `src/components/agents/AgentsView.tsx:110` (lane) | cap | d-rank | agent run section rows: keep; per-section expand toggle shows all |
| `src/components/agents/AgentsView.tsx:113` (lane) | FINISHED_CAP=8 | d-rank | finished/scheduled runs: keep; "Show all N" toggle at :384 |
| `src/components/agents/ToolsView.tsx:134` (lane) | cap | d-rank | tool adapters list: keep; expand toggle with total |
| `src/components/agents/ToolsView.tsx:181` (lane) | cap | d-rank | recent tool runs: keep; moreRuns toggle |
| `src/components/agents/claude.ts:46` (lane) | 20 | d-rank | prompt preview lines (unused helper): keep; returns hidden count; no caller in src |
| `src/components/chat/AssistantPanel.tsx:71` (lane) | 8 | d-rank | thread switcher list: keep; "All N threads, full page" link :123 |
| `src/components/chat/ChatComposer.tsx:57` (lane) | const defaultSearch = async (q: string,  | d-rank | typeahead: 30 hits, typing narrows |
| `src/components/chat/ChatProposalCard.tsx:59` (lane) | reveal.shown | d-rank | proposal lines paged reveal: keep |
| `src/components/chat/ChatReceiptCard.tsx:59` (lane) | export function ChatReceiptCard({ title, | d-rank | 5 lines with "+N more" (card-parts) |
| `src/components/chat/ChatReceiptCard.tsx:70` (lane) | reveal.shown | d-rank | receipt changes paged reveal (maxLines=5): keep |
| `src/components/chat/ConnectedComposer.tsx:21` (lane) | 3 | d-rank | composer suggestion chips: keep; suggestions, not user data |
| `src/components/chat/ThreadContextPane.tsx:133` (lane) | 6 | d | items this thread touched (header counts all, lists 6): add "Show all N" (fetch rest on expand) |
| `src/components/chat/ThreadContextPane.tsx:149` (lane) | 3 | d | running agent lines in capacity block: show all or "+N more" |
| `src/components/chat/ThreadContextPane.tsx:267` (lane) | 6 | d | sources cited in thread, rest dropped silently: add count + "Show all N" |
| `src/components/chat/ToolRows.tsx:65` (lane) | sum.more | d-rank | N more tools label: keep |
| `src/components/chat/card-parts.tsx:26` (lane) | MORE_STEP | d-rank | Show N more label: keep; paged reveal |
| `src/components/chat/card-parts.tsx:64` (lane) | shown | d-rank | card list paged reveal: keep |
| `src/components/chat/commands.ts:48` (lane) | 5 | d-rank | @mention typeahead hits per group: keep; typing narrows |
| `src/components/chat/commands.ts:72` (lane) | 3 | d-rank | follow-up suggestion chips: keep; generated suggestions, not user data |
| `src/components/chat/thread-model.ts:85` (lane) | 2 | d-rank | tool summary line head: keep; "· N more tools" (ToolRows:65) expands |
| `src/components/composer/Composer.body.tsx:214` (lane) | 7 | d-rank | destination switch suggestions: keep; destination search (destination.ts) finds anyone |
| `src/components/composer/Composer.body.tsx:218` (lane) | 1 | d-rank | collapsed switch shows first candidate: keep; opens to full candidates |
| `src/components/composer/DraftProposal.tsx:107` (lane) | 4 | d | conflict diff: only first 4 differing spans per side: show all spans or "+N more" before keep/take choice |
| `src/components/composer/destination.ts:293` (lane) | 8 | d-rank | destination typeahead results: keep; typing narrows; consider "type to narrow" hint |
| `src/components/deals/DcView.tsx:125` (lane) | page.shown | d-rank | DC request rows, step 50: keep; ShowMore with total |
| `src/components/deals/DealsView.tsx:84` (lane) | cap 3/5 | d-rank | needs group rows: keep; section expand |
| `src/components/deals/DealsView.tsx:296` (lane) | cap | d-rank | keyboard ids follow shown rows: keep |
| `src/components/deals/DealsView.tsx:367` (lane) | 12 | d-rank | command palette entries for deal needs: keep or drop cap; palette only, page lists all |
| `src/components/deals/PageHeader.tsx:30` (lane) | 6 | d-rank | header highlight slots (no caller passes highlights): keep; layout slots |
| `src/components/deals/PipelineList.tsx:60` (lane) | page.shown | d-rank | pipeline rows paged: keep; ShowMore |
| `src/components/deals/panels.tsx:118` (lane) | 6 | d | account panel open tasks (title counts all): add "See all N" link to Work filtered by account |
| `src/components/detail/header/fields.tsx:113` (lane) | export function TextField({ field, value | a | text field length (500, the field's own bound) |
| `src/components/detail/lib/panel-derive.ts:80` (lane) | 6 | d-rank | Why section evidence chips: keep; Evidence tab lists all |
| `src/components/detail/lib/panel-derive.ts:189` (lane) | cap | d-rank | same-initiative siblings: keep; "See all N" link (sections.tsx:153) |
| `src/components/detail/nba/NbaSection.tsx:287` (lane) | 3 | d | NBA alternatives when guess, rest hidden: low: show all alternatives or "+N more" |
| `src/components/detail/panel/sections.tsx:112` (lane) | cap = 3, | d-rank | section preview (3) with Show all |
| `src/components/detail/tabs/HistoryTab.tsx:38` (lane) | 4 | d | audit entry changed fields beyond 4 hidden: show all or "+N more fields" expand |
| `src/components/domain/ActivityRow.tsx:228` (lane) | 2 | d-rank | source chips on activity row: keep; row expand lists all (RowParts:203) |
| `src/components/domain/DaySpine.tsx:281` (lane) | 2 | d-rank | prep items named in event line: keep; summary line, event panel has all |
| `src/components/domain/NbaCard.parts.tsx:61` (lane) | 4 | d | top 4 rank reasons in why breakdown: low: "+N more reasons" expand |
| `src/components/domain/NbaCard.parts.tsx:107` (lane) | 3 | d | tool inputs shown on plan block: low: show all inputs or "+N more" |
| `src/components/domain/NbaCard.tsx:577` (lane) | 4 | d-rank | source chips on NBA card: keep; "+N · why" button opens all |
| `src/components/domain/ResolvePicker.tsx:55` (lane) | 6 | d-rank | person picker results: keep; search box narrows |
| `src/components/domain/SectionColumn.tsx:50` (lane) | export function SectionColumn({ title, c | d-rank | column preview with See all |
| `src/components/domain/SectionColumn.tsx:55` (lane) | const c = CAP.includes(cap as (typeof CA | d-rank | column preview with See all |
| `src/components/domain/SectionColumn.tsx:57` (lane) | cap/capWide | d-rank | section rows: keep; "See all N" link |
| `src/components/domain/Shelves.tsx:198` (lane) | max=2 | d-rank | shelf rows: keep; onOpenAll button with count |
| `src/components/domain/StatusRail.tsx:50` (lane) | peek | d-rank | status rail lane entries: keep; expand toggle |
| `src/components/feedback/client-errors.ts:8` (lane) | const CAP = 400; | c | client error ring buffer (400) |
| `src/components/health/RaiseCap.tsx:118` (lane) | limit=8 | d | cap raise history, older raises hidden: add "Show all N" |
| `src/components/home/Briefing.tsx:131` (lane) | more.n | d-rank | +N more on Work link: keep |
| `src/components/home/DoNow.tsx:173` (lane) | rest | d-rank | extra drafts on a card, "+N more": keep |
| `src/components/home/DoNow.tsx:174` (lane) | rest | d-rank | +N more drafts: keep |
| `src/components/home/model.ts:128` (lane) | 3 | d-rank | Home do-now cards (H-10 three cards): keep; design decision; Work lists all |
| `src/components/kit/ActionRow.tsx:202` (lane) | inlineOverflow | d-rank | inline overflow actions: keep; rest in overflow menu |
| `src/components/kit/QueueSection.tsx:58` (lane) | const { title, sub, items, resetKey, ren | d-rank | queue preview (3) with See all |
| `src/components/kit/QueueSection.tsx:74` (lane) | cap=3 | d-rank | queue rows: keep; expand + seeAll |
| `src/components/lists/paging.ts:35` (lane) | next | d-rank | Show N more label: keep |
| `src/components/needs/NeedActionRow.tsx:47` (lane) | 9 | a | choice hotkeys 1-9 (nine digit keys): keep |
| `src/components/needs/NeedActionRow.tsx:76` (lane) | 3 | d | answer choices: only 3 buttons, 4+ invisible (keys only): render all choices or a "More…" menu. **Fixed b55ea72** |
| `src/components/needs/NeedsQueue.tsx:43` (lane) | export function NeedsQueue({ title = 'Ne | d-rank | queue preview (3) with See all |
| `src/components/onboarding/steps.tsx:207` (lane) | 3 | d-rank | top 3 weights summary in onboarding aside: keep; full weights edited in step |
| `src/components/panels/EventPanel.tsx:148` (lane) | ATTENDEE_CAP | d-rank | attendees list: keep; "Show N more" :297 |
| `src/components/panels/EventPanel.tsx:297` (lane) | ATTENDEE_CAP | d-rank | Show N more attendees: keep |
| `src/components/panels/derive.ts:152` (lane) | max=3 | d-rank | key attendees on hover card: keep; "+N more"; EventPanel lists all |
| `src/components/panels/derive.ts:182` (lane) | n=3 | d-rank | agenda preview lines: keep; returns more flag |
| `src/components/panels/derive.ts:183` (lane) | n | d-rank | agenda more flag: keep |
| `src/components/panels/meeting.tsx:27` (lane) | lines | d-rank | agenda line clamp (optional): keep; caller decides; full in panel |
| `src/components/panels/meeting.tsx:109` (lane) | key | d-rank | +N more guests on hover card: keep |
| `src/components/settings/PolicyEffect.tsx:78` (lane) | n | d-rank | rank compare list top n: keep; preview of top 5/10 |
| `src/components/settings/PolicyEffect.tsx:91` (lane) | n | d-rank | slope lines top n: keep |
| `src/components/settings/PolicyEffect.tsx:92` (lane) | n | d-rank | slope lines top n: keep |
| `src/components/settings/PolicyEffect.tsx:209` (lane) | 3 | d-rank | policy versions: keep; all toggle |
| `src/components/settings/TimeSection.tsx:283` (lane) | 30 | d | DC products input silently drops >30 (contract .max(30)): say "up to 30" or lift contract bound (src/contract/settings.ts:457) |
| `src/components/settings/effects.tsx:176` (lane) | 2 | d-rank | display preview sample rows: keep; preview sample |
| `src/components/shell/CapturePanel.tsx:66` (lane) | 5 | d-rank | recent captures in panel session: keep; saved items live in Work |
| `src/components/shell/CommandPalette.tsx:121` (lane) | const search = useApi('search', { query: | d-rank | palette search: 8 hits, typing narrows |
| `src/components/shell/FirstScanBanner.tsx:55` (lane) | SHOWN | d-rank | first scan sources in banner: keep; "+N more" + tooltip detail |
| `src/components/shell/FirstScanBanner.tsx:62` (lane) | more | d-rank | +N more sources: keep |
| `src/components/shell/StatusPanels.tsx:131` (lane) | SINCE_SHOWN=8 | d-rank | since-you-left entries: keep; "See all N" |
| `src/components/shell/StatusPanels.tsx:232` (lane) | 6 | d-rank | spend by scanner in status panel: keep; "Spend details" link to Health |
| `src/components/time/ForecastParts.tsx:104` (lane) | deferred | d-rank | N more wait toast: keep |
| `src/components/time/HistoryParts.tsx:85` (lane) | 2 | d-rank | source chips on history row: keep; row detail lists all |
| `src/components/time/InternalRows.tsx:94` (lane) | 2 | d-rank | source chips on internal row: keep; row detail lists all |
| `src/components/time/LedgerOverview.tsx:294` (lane) | ACCOUNTS_SHOWN | d-rank | ledger accounts: keep; "Show N more accounts" |
| `src/components/time/LedgerOverview.tsx:335` (lane) | hidden | d-rank | Show N more accounts: keep |
| `src/components/time/NeedsYou.tsx:263` (lane) | page.shown | d-rank | needs-you rows paged: keep; ShowMore |
| `src/components/time/NeedsYou.tsx:314` (lane) | 3 | d-rank | source chips on row: keep; row expand lists all |
| `src/components/time/OppPicker.tsx:186` (lane) | MAX_LISTED | d-rank | Showing 60 of N hint: keep |
| `src/components/time/ReadyToLog.tsx:86` (lane) | page.shown | d-rank | ready-to-log rows paged: keep; ShowMore |
| `src/components/time/ReadyToLog.tsx:237` (lane) | 3 | d-rank | source chips on row: keep; row expand lists all |
| `src/components/time/RowParts.tsx:117` (lane) | 2 | d-rank | alternate opps: keep; rundown toggle lists likely opps |
| `src/components/time/RowParts.tsx:169` (lane) | max | d-rank | issue lines on row (max 1/2): keep; expanded row shows all (RowParts:223) |
| `src/components/time/RowParts.tsx:199` (lane) | n more sources | d-rank | and N more sources label: keep; lists all at :203 |
| `src/components/time/VdpPanel.tsx:304` (lane) | +N more | d-rank | +N more sources: keep |
| `src/components/time/VdpPushRuns.tsx:76` (lane) | SHOWN_PROBLEMS=5 | d-rank | push run problems: keep; all toggle |
| `src/components/time/WeekTimeline.tsx:221` (lane) | 3 | d-rank | evidence labels in hover tooltip: keep; click jumps to row |
| `src/components/time/bulk.ts:32` (lane) | max=8 | d-rank | bulk failure lines: keep; "and N more", rows back in list |
| `src/components/time/bulk.ts:33` (lane) | max | d-rank | and N more failures: keep |
| `src/components/time/derive.ts:570` (lane) | 2 | d-rank | why preview of needs step: keep; Show verb opens all ids |
| `src/components/time/opp-picker-derive.ts:17` (lane) | export const MAX_LISTED = 60; | d-rank | picker lists 60, "N more match, type to narrow" |
| `src/components/time/opp-picker-derive.ts:58` (lane) | MAX_LISTED=60 | d-rank | opp picker list: keep; "N more match, type to narrow" |
| `src/components/time/opp-picker-derive.ts:61` (lane) | MAX_LISTED | d-rank | opp picker list: keep |
| `src/components/time/opp-picker-derive.ts:97` (lane) | MAX_LISTED | d-rank | opp picker matches: keep |
| `src/components/time/review-derive.ts:234` (lane) | 3 | d-rank | changed-rows notice: keep; "and N more"; rows unticked in list |
| `src/components/time/review-derive.ts:235` (lane) | 3 | d-rank | and N more: keep |
| `src/components/time/review-derive.ts:253` (lane) | 2 | d-rank | skipped rows named in notice, count said: keep |
| `src/components/time/review-derive.ts:260` (lane) | 2 | d-rank | skipped rows named in toast body: keep; count said; rows stay in list |
| `src/components/today/AgentPlan.tsx:71` (lane) | 8 | d | since digest per group: header counts all, lists 8: add "Show all N" per group |
| `src/components/today/DayHeader.tsx:82` (lane) | 2 | d-rank | agent labels in capacity sentence: keep; summary sentence |
| `src/components/today/PriorityPreview.tsx:70` (lane) | 3 | d-rank | priority preview top 3: keep; preview |
| `src/components/today/PriorityPreview.tsx:85` (lane) | 2 | d-rank | make-room titles in sentence: keep |
| `src/components/today/TodayPage.tsx:432` (lane) | 3 | a | run-of-day palette hotkeys 1-3: keep |
| `src/components/today/model.ts:55` (lane) | max | d-rank | reconciled order max (caller option): keep |
| `src/components/today/parts.tsx:126` (lane) | 6 | d | tool run form: only first 6 schema fields editable: render all fields (required ones beyond 6 unseen). **Fixed 0ef2bce** |
| `src/components/today/rows.ts:332` (lane) | export function pullRows(input: RowsInpu | d-rank | pull-forward rows (4), Today lists the rest |
| `src/components/today/rows.ts:355` (lane) | 1 | d-rank | one fit-in pulled forward: keep; shelves list all |
| `src/components/today/rows.ts:357` (lane) | cap=4 | d-rank | pull-forward suggestions: keep; suggestions; Work lists all |
| `src/connectors/claude/manifest.ts:46` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/connectors/claude/sessions.ts:179` | execFile('ps', ['-A', '-o', 'pid=,lstart | c | child-process output memory bound |
| `src/connectors/claude/sessions.ts:401` | 5 | c | background-agent labels per session (payload bound): keep |
| `src/connectors/claude/sessions.ts:460` | limit=maxSessionsPerRun(60) | c | sessions read per run; complete=false so next run continues: keep; page, comment that the rest continue |
| `src/connectors/claude/sessions.ts:617` | 15 | c | filesTouched list in payload; full count kept in filesTouchedCount: keep |
| `src/connectors/claude/transcript.ts:51` | export const MAX_TURNS = 1000; | c | last 1,000 turns of one transcript (memory); a longer session counts its newest 1,000 |
| `src/connectors/google/calendar.ts:214` | limit | a | events emitted per fetch page (caller page size): keep; page |
| `src/connectors/google/client.ts:187` | execFile('devbar', args, { timeout: time | c | child-process output memory bound |
| `src/connectors/google/client.ts:287` | this.o = { url: GOOGLE_RO_URL, timeoutMs | c | HTTP retries (2) |
| `src/connectors/google/gmail.ts:171` | limit (40) | a | messages per run; complete=false so next run continues: keep; page |
| `src/connectors/google/gmail.ts:186` | maxThreadLookups=20 | d | fixed 4570189: every chosen thread |
| `src/connectors/google/gmail.ts:256` | 15 | c | URLs extracted per email (payload bound): keep |
| `src/connectors/google/manifest.ts:45` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/connectors/google/manifest.ts:59` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/connectors/google/manifest.ts:73` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/connectors/google/manifest.ts:86` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/connectors/google/manifest.ts:99` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/connectors/google/trainings.ts:111` | 5 | c | extra training links kept (first is used): keep |
| `src/connectors/slack/parse.ts:197` | 10 | a | files per Slack message (Slack allows at most 10 files per message): keep; comment names Slack's 10-file limit |
| `src/connectors/slack/parse.ts:208` | 3 | c | non-Drive URLs kept as file hints per message: keep |
| `src/connectors/slack/parse.ts:210` | 20 | c | fileRefs per message (payload bound): keep |
| `src/connectors/slack/parse.ts:211` | 10 | c | opp id hints per message: keep |
| `src/connectors/slack/parse.ts:212` | 10 | c | account id hints per message: keep |
| `src/connectors/vdp/client.ts:83` | const r = parseSearchResult((await this. | a | VDP search page (50), paged by offset |
| `src/connectors/vdp/client.ts:115` | const r = parseSearchResult((await this. | a | VDP search page (50) for one company |
| `src/connectors/vdp/limiter.ts:14` | export const VDP_MAX_GENERATES_PER_PUSH  | a | VDP: 20 Generates per 10 minutes per user (the push splits) |
| `src/connectors/vdp/manifest.ts:35` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/connectors/vdp/parse.ts:247` | 50 | c | company aliases from VDP lookup: keep |
| `src/connectors/watch/manifest.ts:32` | scan: { mode: 'deterministic', skill: 's | c | items per run: a page (the fetch returns complete=false and the next run continues from the cursor) |
| `src/contract/readin.ts:144` | maxTurns: 14, | d | read-in maxTurns 14 + costCapUsd 0.35 (per run, not on the governor): finding F-4 (per-feature caps). Done 602ae87 |
| `src/contract/settings.ts:378` (lane) | export const DEFAULT_CHAT_SETTINGS: Chat | c | Assistant steps per message (200): a runaway guard; Settings ▸ Budgets ▸ Assistant; the user is told when hit (runner.ts:574). UI clamps it at 80 (BasicSections.tsx:356, visual-QA lane): finding F-1 |
| `src/contract/spend-audit.ts:15` | export const SPEND_AUDIT_MAX_DAYS = 92; | c | Spend audit range at most 92 days (one quarter per query: a read bound, told by the range picker) |
| `src/contract/vdp.coverage.ts:363` | export const DEFAULT_VDP_AUTOPILOT_STATE | b | VDP autopilot daily cap (40): Settings ▸ Sending (D-60), shown on the autopilot line |
| `src/db/retention/policy.ts:213` | daily=BACKUPS_DAILY(7) | c | backups kept (disk retention policy): keep; surface in docs/settings if user wants more |
| `src/engines/activity/canvas-review.ts:110` | 20 | d | no live caller (tests only); proposal: delete the renderer or list every row |
| `src/engines/activity/canvas-review.ts:169` | 25 | d | no live caller (tests only); as above |
| `src/engines/activity/canvas-review.ts:227` | 8 | d-rank | Recently confirmed strip, newest 8 (full in Activity ▸ History): keep; comment "recent strip, full list in History" |
| `src/engines/activity/note.ts:108` | n | d-rank | Note sentence lists n names then "and N more" (count kept): keep |
| `src/engines/activity/propose.evidence.ts:76` | 4 | d-rank | evidence sentence: first 4 signal labels: keep |
| `src/engines/activity/propose.evidence.ts:77` | 12 | d | fixed 5031fbd: every evidence id |
| `src/engines/activity/propose.evidence.ts:192` | 3 | d-rank | evidence sentence names 3 doc titles with total count: keep |
| `src/engines/activity/propose.ts:178` | 12 | d | fixed 5031fbd: every evidence id |
| `src/engines/activity/suggest-prompt.ts:18` | export const SUGGEST_MAX_CANDIDATES = 15 | d-rank | 15 ranked candidates per prompt (prompt budget); open opps come before tied closed ones, so a tied closed opp can fall out: finding F-6 |
| `src/engines/activity/suggest-prompt.ts:42` | SUGGEST_MAX_CANDIDATES=15 | d-rank | ranked prompt budget (15); proposal F-6: put tied closed opps before untied open ones |
| `src/engines/activity/suggest-prompt.ts:52` | 6 | d-rank | prompt: first 6 row sources as evidence: keep; comment prompt-size |
| `src/engines/activity/suggest-prompt.ts:53` | 3 | d-rank | prompt: first 3 issue notes: keep; comment prompt-size |
| `src/engines/attribution/activity.ts:79` | const r = attribute(sig, world, { extra, | d-rank | top 3 attribution candidates (H-9 credit split) |
| `src/engines/attribution/dc.ts:188` | 3 | d-rank | DC suggestion carries 3 evidence refs: keep; comment "sample, totals on row" |
| `src/engines/attribution/discover.ts:46` | return assertReadOnlySoql(`SELECT Id, Na | d-rank | Org62 user search: 10 by name |
| `src/engines/attribution/engagement.ts:99` | REFS_KEPT=5 | d-rank | newest 5 refs kept per opp engagement: keep; comment evidence sample, counts kept |
| `src/engines/attribution/engagement.ts:109` | 3 | d-rank | touch credits top 3 candidate opps (H-9 design): keep; comment cite H-9 |
| `src/engines/attribution/engagement.ts:148` | REFS_KEPT=5 | d-rank | merge keeps newest 5 refs: keep (as above) |
| `src/engines/attribution/row.ts:290` | const attribution = attribute(signal, wo | d-rank | top 5 attribution candidates for a row; the picker lists every opp |
| `src/engines/attribution/rules.ts:174` | 2 | d-rank | learned rule keys from first 2 domains: keep (heuristic, not user list) |
| `src/engines/attribution/rules.ts:176` | 2 | d-rank | learned rule keys from first 2 people: keep (heuristic) |
| `src/engines/attribution/view.ts:37` | 3 | d-rank | explanation text: 3 evidence labels: keep |
| `src/engines/briefs/channel.ts:157` | maxHighlights | b | per-watch user setting maxHighlights: keep (user setting on the watch) |
| `src/engines/briefs/prompt/build.ts:131` | maxOutputTokens: 3000, | a | output token budget of one call (the answer shape) |
| `src/engines/deals/findings.ts:154` | 5 | d-rank | stranded DC: top 5 move-to target opps by similarity: keep; comment |
| `src/engines/deals/needs.ts:120` | 2 | d-rank | why-lines: first 2 evidence strings: keep |
| `src/engines/forecast/canvas.ts:92` | binary search | a | rows that fit one Slack canvas (CANVAS_MAX_BYTES, 1 MiB); rest deferred: keep (already names source) |
| `src/engines/forecast/canvas.ts:95` | lo | a | take/deferred split at Slack canvas size: keep |
| `src/engines/home/briefing.ts:96` | RESPOND_CHIPS=5 | d-rank | Respond row chips (count + Review link to /outbox): keep (briefing, H-10) |
| `src/engines/home/briefing.ts:193` | 3 | d-rank | Admin label names 3 kinds "and more", count shown: keep |
| `src/engines/home/briefing.ts:221` | 10 | d-rank | closed-now in-place tags, newest 10 (full list Triage closed_for_you): keep; comment |
| `src/engines/home/build.cards.ts:52` | 2 | d-rank | prep card: last 2 done steps: keep |
| `src/engines/home/build.cards.ts:153` | 3 | d-rank | draft card shows 3 draft lines; draftIds keeps all: keep |
| `src/engines/home/build.gaps.ts:202` | 3 | d-rank | DC gap names 3 accounts, count + /deals link: keep |
| `src/engines/home/build.gaps.ts:226` | 3 | d-rank | claims gap names 3 accounts, count + link: keep |
| `src/engines/home/build.sections.ts:189` | 1 | d-rank | today line: first time gap only: keep |
| `src/engines/home/build.sections.ts:201` | 2 | d-rank | big-day line names 2 events: keep |
| `src/engines/home/build.sections.ts:202` | 2 | d-rank | big-day line names 2 items: keep |
| `src/engines/home/build.sections.ts:249` | 2 | d-rank | chase names 2, count + /work link: keep |
| `src/engines/home/build.ts:183` | 2 | d-rank | elsewhere note names 2 sections: keep |
| `src/engines/home/build.ts:199` | HOME_CAPS.pullForward=5 | d-rank | capacity: 5 pull-forward suggestions: keep |
| `src/engines/home/build.ts:261` | HOME_CAPS.looksDone | d-rank | Looks-done rows capped, count shown, rest in Triage (LD-1): keep |
| `src/engines/home/persona-gaps.ts:76` | 3 | d-rank | persona gap names 3 accounts with count: keep |
| `src/engines/home/persona-gaps.ts:137` | 3 | d-rank | missing SFR names 3 accounts with count: keep |
| `src/engines/nba/prompt/build.ts:104` | 12 | d | a set count ahead of the prompt's own token trimmer. Proposal F-12: drop the count, let fitToBudget/the pack trimmer decide; changes cassette prompts (re-record live). Marker 3ddc2bd |
| `src/engines/nba/prompt/build.ts:110` | 10 | d | a set count ahead of the prompt's own token trimmer. Proposal F-12: drop the count, let fitToBudget/the pack trimmer decide; changes cassette prompts (re-record live). Marker 3ddc2bd |
| `src/engines/nba/prompt/complete.ts:64` | maxTurns: 1, | a | a single tool-less completion (maxTurns 1) |
| `src/engines/nba/prompt/enrich.ts:147` | maxOutputTokens: 1200, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/enrich.ts:192` | maxOutputTokens: 4000, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:38` | maxOutputTokens: 3000, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:49` | maxOutputTokens: 3500, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:60` | maxOutputTokens: 5000, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:71` | maxOutputTokens: 2500, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:82` | maxOutputTokens: 4000, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:93` | maxOutputTokens: 4000, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:104` | maxOutputTokens: 1500, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:116` | maxOutputTokens: 2000, | a | output token budget of one call (the answer shape) |
| `src/engines/nba/prompt/verbs.ts:128` | maxOutputTokens: 3500, | a | output token budget of one call (the answer shape) |
| `src/engines/priority/preview.ts:74` | limit | d-rank | policy preview top-N rows (param): keep; caller passes limit |
| `src/engines/priority/preview.ts:85` | 2 | d-rank | preview row: 2 non-rule reasons: keep |
| `src/engines/priority/rank.ts:330` | 3 | d-rank | explanation joins top 3 reasons (all reasons kept): keep |
| `src/engines/priority/stability.ts:79` | size | b | Top-N size from policy top3Size (user setting): keep |
| `src/engines/priority/v2/compare.ts:28` | window=10 | d-rank | shadow disagreements among each side's top 10: keep (diagnostic) |
| `src/engines/priority/v2/compare.ts:42` | limit=3 | d-rank | shadow: 3 biggest disagreements: keep (diagnostic) |
| `src/engines/priority/v2/rank.ts:348` | 3 | d-rank | explanation text from top 3 reasons (reasons kept): keep |
| `src/engines/priority/v2/shadow.ts:43` | 10 | d-rank | v2 preview shows top 10 rows: keep (shadow diagnostic); or param |
| `src/engines/priority/v2/shadow.ts:80` | 5 | d-rank | explain: 5 neighbours each side: keep |
| `src/engines/priority/why.ts:112` | max=2 | d-rank | matters line: top 2 value terms: keep |
| `src/engines/resolution/pack.ts:134` | 2 | d | a set count ahead of the prompt's own token trimmer. Proposal F-12: drop the count, let fitToBudget/the pack trimmer decide; changes cassette prompts (re-record live). Marker 3ddc2bd |
| `src/engines/settle/context.ts:184` | middleMax=14 | d | settle prompt counts (Settle merges into the resolution check, H-7). Proposal F-12: a token budget with "N omitted" lines; needs the settle cassettes re-recorded with a live model, which this lane cannot run. Marker 3ddc2bd |
| `src/engines/settle/context.ts:187` | head/tail=8 | d | settle prompt counts (Settle merges into the resolution check, H-7). Proposal F-12: a token budget with "N omitted" lines; needs the settle cassettes re-recorded with a live model, which this lane cannot run. Marker 3ddc2bd |
| `src/engines/settle/context.ts:194` | 14 | d | settle prompt counts (Settle merges into the resolution check, H-7). Proposal F-12: a token budget with "N omitted" lines; needs the settle cassettes re-recorded with a live model, which this lane cannot run. Marker 3ddc2bd |
| `src/engines/settle/context.ts:199` | 8 | d | settle prompt counts (Settle merges into the resolution check, H-7). Proposal F-12: a token budget with "N omitted" lines; needs the settle cassettes re-recorded with a live model, which this lane cannot run. Marker 3ddc2bd |
| `src/engines/settle/context.ts:212` | 8 | d | settle prompt counts (Settle merges into the resolution check, H-7). Proposal F-12: a token budget with "N omitted" lines; needs the settle cassettes re-recorded with a live model, which this lane cannot run. Marker 3ddc2bd |
| `src/engines/settle/load-db.ts:122` | order by si.occurred_at limit 200`), | a | settle context reads (prompt budget; Settle merges into the resolution check, H-7) |
| `src/engines/settle/load-db.ts:133` | order by si.occurred_at limit 200`), | a | settle context (as above) |
| `src/engines/settle/load-db.ts:141` | order by si.occurred_at limit 60`), | a | settle context (as above) |
| `src/engines/settle/load-db.ts:204` | order by si.occurred_at limit 120`), | a | settle context (as above) |
| `src/engines/settle/load-db.ts:217` | order by ts_rank(si.search_tsv, websearc | a | settle context: 30 by rank (as above) |
| `src/engines/settle/load-db.ts:244` | 14 | d | settle prompt counts (Settle merges into the resolution check, H-7). Proposal F-12: a token budget with "N omitted" lines; needs the settle cassettes re-recorded with a live model, which this lane cannot run. Marker 3ddc2bd |
| `src/engines/settle/load-db.ts:271` | order by ce.starts_at limit 60`), | a | settle context: calendar (as above) |
| `src/engines/settle/load-db.ts:282` | 8 | d | settle prompt counts (Settle merges into the resolution check, H-7). Proposal F-12: a token budget with "N omitted" lines; needs the settle cassettes re-recorded with a live model, which this lane cannot run. Marker 3ddc2bd |
| `src/engines/settle/load-db.ts:309` | limit 6`), | a | settle context: siblings (as above) |
| `src/engines/settle/load-db.ts:323` | order by ts_rank(w.search_tsv, websearch | a | settle context: siblings by rank (as above) |
| `src/engines/use-cases/plan.ts:60` | const a = attribute(sig, world, { limit: | d-rank | attribution candidates (6) for a use case; the picker has every opp |
| `src/engines/use-cases/plan.ts:65` | const alternates = unsure ? oppRundown(a | d-rank | 3 alternates when unsure; the picker has every opp |
| `src/engines/use-cases/plan.ts:66` | 4 | d-rank | why reasons: first 4: keep |
| `src/engines/use-cases/stage.ts:90` | 6 | d | mirrors the contract bound Products.max(6) (src/contract/use-cases.ts:95; a request past 6 is refused with a message). Proposal F-11: ask whether Org62/VDP limit products; lift if not |
| `src/engines/use-cases/stage.ts:141` | 3 | d-rank | Org62 description quotes 3 evidence lines: keep |
| `src/engines/use-cases/view.ts:75` | 3 | d-rank | needs-pick alternates: 3 (opp picker has all): keep |
| `src/engines/use-cases/view.ts:102` | 50 | d | fixed b07d9de: the whole 30-day window |
| `src/engines/vdp/assets.ts:384` | 8 | d | fixed 5031fbd: every source |
| `src/engines/vdp/assets.ts:385` | 20 | d | fixed 5031fbd: every source item |
| `src/engines/vdp/assets.ts:410` | max=20 | d | fixed 5031fbd: linksInText default Infinity |
| `src/engines/vdp/autopilot.ts:260` | 20 | d-rank | autopilot "recent" strip: newest 20 ledger entries: keep if full ledger viewable; else add Show all |
| `src/engines/vdp/gaps.ts:234` | VDP_MAX_OWNERS=20 | a | VDP set_vdp_owners keeps ≤20 people: keep; tell user when cut |
| `src/engines/vdp/gaps.ts:409` | VDP_MAX_OPPORTUNITIES=20 | a | kept (VDP limit) + fixed c9a8b38: the opps past 20 say so |
| `src/engines/vdp/gaps.ts:573` | VDP_MAX_OWNERS=20 | a | owners list capped at VDP max 20: keep; tell user when cut |
| `src/engines/vdp/identity-judge.ts:49` | 20 | d | aliases to the judge (20). Proposal F-11: confirm VDP's alias limit, else keep every distinct alias |
| `src/engines/vdp/identity.ts:161` | 50 | d | create_company aliases (50). Proposal F-11 (as above) |
| `src/engines/vdp/identity.ts:278` | 6 | d-rank | near-match alternatives: 6: keep |
| `src/engines/voice/build.ts:205` | 15 | d-rank | voice profile exemplars: 15: keep (profile summary, prompt-size) |
| `src/engines/voice/build.ts:273` | 6 | d-rank | top 6 emoji: keep |
| `src/engines/voice/build.ts:283` | 15 | d-rank | top 15 abbreviations: keep |
| `src/engines/voice/build.ts:291` | 8 | d-rank | top 8 greetings: keep |
| `src/engines/voice/build.ts:304` | 12 | d-rank | top 12 common phrases: keep |
| `src/engines/voice/build.ts:324` | 8 | d-rank | 8 signature phrases in guide text: keep |
| `src/engines/voice/build.ts:333` | 5 | d-rank | 5 abbreviations in a habit line: keep |
| `src/engines/voice/build.ts:338` | 3 | d-rank | 3 emoji examples: keep |
| `src/engines/voice/build.ts:365` | 10 | d-rank | 10 phrases to use: keep |
| `src/engines/voice/build.ts:374` | 20 | d-rank | 20 signatures kept: keep |
| `src/engines/voice/render.ts:28` | 6 | d-rank | prompt: 6 openers: keep |
| `src/engines/voice/render.ts:29` | 10 | d-rank | prompt: 10 phrases: keep |
| `src/engines/voice/render.ts:30` | 10 | d-rank | prompt: 10 common phrases: keep |
| `src/engines/voice/synthesize.ts:39` | export function buildSynthesisUser(profi | a | voice prompt samples 120 sent messages (prompt budget; a style sample, not a list the user reads) |
| `src/engines/voice/synthesize.ts:73` | 20 | d-rank | phrasesToAvoid merged, 20 kept: keep |
| `src/guide/checklist.ts:162` (lane) | 3 | d-rank | broken connectors named, "+N": keep; count said |
| `src/jobs/handlers/activity-notes.ts:48` | const MAX_CALLS = 12; | d | fixed 3e530bf: a page; the next page is queued while notes are due |
| `src/jobs/handlers/activity-notes.ts:70` | const r = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/activity-suggest.ts:45` | const MAX_CALLS = 15; | d | fixed 3e530bf: a page; the next page is queued while rows are due (daily hard cap still checked per call) |
| `src/jobs/handlers/activity-suggest.ts:69` | const r = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/brief.ts:54` | const MAX_PERIOD_MS = 7 * DAY; | a | a first brief covers at most 7 days (prompt budget; the brief says its period) |
| `src/jobs/handlers/brief.ts:55` | const MAX_MESSAGES = 400; | a | newest 400 messages of the period (prompt budget; the prompt keeps the newest that fit) |
| `src/jobs/handlers/brief.ts:60` | const MAX_WAIT_RETRIES = 8; | c | retry count while the channel scan is behind |
| `src/jobs/handlers/brief.ts:63` | const DEFAULT_MAX_CALL_USD = 0.1; | d | per-call $0.10 brief cap: finding F-4. Done f43ccab |
| `src/jobs/handlers/brief.ts:125` | group by a.id, a.name order by a.name li | a | brief prompt: 60 accounts by name (prompt budget) |
| `src/jobs/handlers/brief.ts:132` | order by close_date nulls last, name lim | a | brief prompt: 40 opps by close date (prompt budget) |
| `src/jobs/handlers/brief.ts:135` | order by updated_at desc limit 30`), | a | brief prompt: 30 newest items (prompt budget) |
| `src/jobs/handlers/brief.ts:312` | maxAttempts: 3, | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/completion.ts:48` | maxAttempts: 3, | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/enrich.ts:31` | const MAX_CHIPS = 4; | d-rank | 4 chips on an item (display) |
| `src/jobs/handlers/enrich.ts:52` | await enqueueJob(db, { ownerUserId: user | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/enrich.ts:118` | order by coalesce(last_activity_at, star | a | enrich: 200 newest sessions to match (prompt/candidate budget) |
| `src/jobs/handlers/enrich.ts:130` | order by coalesce(last_modified_at, crea | a | enrich: 200 newest files to match (as above) |
| `src/jobs/handlers/forecast-sync.ts:226` | return (defaultGoogle = new GoogleWorksp | c | HTTP retry count |
| `src/jobs/handlers/forecast-sync.ts:253` | order by starts_at desc limit 12`) | d | fixed b64e41e: every meeting since the notes changed (was 12) |
| `src/jobs/handlers/hygiene.ts:17` | return enqueueJob(db, { ownerUserId: use | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/kv-backfill.ts:376` | return enqueueJob(db, { ownerUserId: use | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/org62-discover.ts:154` | limit 400`); | b | Org62 discovery lookups a day (H-9: ≤ 20/day, cached 7 days); 400 candidates read |
| `src/jobs/handlers/org62-readback.ts:103` | return enqueueJob(db, { ownerUserId: use | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/rerank.ts:32` | return enqueueJob(db, { ownerUserId: use | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/settle.ts:51` | const r = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/use-cases-extract.ts:40` | const MAX_CALLS = 12; | d | confirm 12 unsure sources a pass; the next pass re-asks the same first 12 (no answer cache): finding F-3. Done 7339fb6 |
| `src/jobs/handlers/use-cases-extract.ts:62` | const r = await modelProvider().complete | a | output budget of one confirm call |
| `src/jobs/handlers/use-cases-extract.ts:69` | const r = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/jobs/handlers/vdp-assets.ts:65` | return (defaultGoogle = new GoogleWorksp | c | HTTP retry count |
| `src/jobs/handlers/vdp-assets.ts:106` | const perRunCap = typeof ctx.job.payload | d | per-run $0.50 default when the job has no cap_usd: finding F-4 (per-feature caps). Done 4d8492d |
| `src/lib/accounts/hierarchy.ts:22` | export const HIERARCHY_MAX_LEVELS = 5; | a | SOQL child-to-parent relationship depth (5 levels) |
| `src/lib/canvas/payload.ts:31` | export const CANVAS_MAX_BYTES = 900_000; | a | Slack canvas size (900 KB under the 1 MiB limit); the rest go on the next canvas |
| `src/lib/canvas/preflight.ts:126` | 4 | d-rank | rows left out message names 4, then "and N more": keep |
| `src/lib/compose/source.ts:39` | const MAX_CHARS = 20_000; | a | composer source text (20K chars): prompt budget |
| `src/lib/feedback/payload.ts:22` | export const FEEDBACK_MAX_CHARS = 6000; | a | Slack feedback post size |
| `src/lib/private-scan.ts:209` | const MAX_LINE = 4000; | c | scan line length bound (memory) |
| `src/lib/redact.ts:131` | maxArray | c | redactPayload array bound (caller option; log/payload memory): keep; callers pass Infinity when they need all |
| `src/lib/time-issues.ts:36` | 3 | d-rank | issue text names 3 items: keep |
| `src/lib/time-suggest.ts:135` | 3 | d-rank | 3 suggestions shown; opp picker lists all: keep |
| `src/lib/vdp/payload.ts:34` | export const VDP_MAX_OPPORTUNITIES = 20; | a | VDP keeps 20 opportunity ids on a VDP; fixed c9a8b38: the opps past it say so |
| `src/lib/vdp/payload.ts:125` | export const VDP_MAX_OWNERS = 20; | a | set_vdp_owners takes at most 20 people (VDP) |
| `src/lib/vdp/search-names.ts:78` | max | d-rank | VDP search name variants (query count bound): keep; comment as query budget |
| `src/llm/cc-tools/handlers.ts:539` | 12 | d | fixed fdb3f21: every line (the watch's maxHighlights decides what shows) |
| `src/llm/chat/runner.ts:217` | const r = await summarize({ model: 'fast | a | summary call output budget (4000 tokens): the compaction summary, not a limit on the user |
| `src/llm/chat/soql.ts:17` | export const SOQL_MAX_LIMIT = 2_000; | a | SOQL LIMIT max 2,000 (Salesforce API) |
| `src/llm/chat/soql.ts:18` | export const SOQL_MAX_IN = 2_000; | a | IN list bound 2,000 (SOQL statement size) |
| `src/llm/chat/soql.ts:19` | export const SOQL_MAX_CHARS = 100_000; | a | SOQL statement 100,000 characters (Salesforce limit) |
| `src/llm/chat/soql.ts:117` | SOQL_MAX_LIMIT=2000 | a | LIMIT rewrite on Assistant SOQL (Salesforce/MCP row ceiling): keep; comment names the source |
| `src/llm/chat/tool-kit.ts:56` | export const CARD_MAX_CALLS = 2_000; | c | payload sanity bound of one card (2,000 calls; real use 55): safety, error names it |
| `src/llm/chat/tool-kit.ts:59` | ECHO_LINES=100 | c | lines echoed to the model; card shows all, note says so: keep |
| `src/llm/chat/tools.ts:494` (lane) | 4 | d-rank | resource chips for queued VDPs; full list in tool JSON and each VDP's Assets: keep, or add "+N more" chip (file owned by review-fixes lane) |
| `src/llm/provider/agent-sdk.ts:96` | maxTurns: 1, | a | a single tool-less completion (maxTurns 1), not a cap |
| `src/llm/readin/context.ts:131` | 10 | d-rank | sibling items in packet; reachable via readin_ledger_search: keep; comment |
| `src/llm/readin/context.ts:137` | 8 | d-rank | related items in packet (live first, recent): keep; comment |
| `src/llm/readin/context.ts:147` | 6 | d-rank | prior commitments in packet: keep; comment |
| `src/llm/readin/context.ts:164` | 10 | a | people on the item in the prompt (context budget): keep |
| `src/llm/readin/context.ts:172` | 10 | d-rank | saidBefore lines in packet: keep; comment |
| `src/llm/readin/context.ts:185` | maxEvidence=14 | d-rank | meeting evidence in packet, newest first: keep; comment |
| `src/llm/readin/context.ts:191` | 8 | d-rank | related items for a meeting read-in: keep; comment |
| `src/llm/readin/context.ts:202` | 20 | a | attendees in meeting prompt (context budget): keep |
| `src/llm/readin/map.ts:88` | 20 | c | unreachable: ReadInOutput allows 8 background + 6 history bullets, so at most 14 sources; kept |
| `src/llm/readin/tools.ts:124` | - | a | paged read: 'N more characters: read again with offset' (continues): keep |
| `src/llm/research/tools.ts:114` | const MAX_CAL_DAYS = 1830; | c | calendar search span 5 years (1830 days): bound of one Calendar API query window |
| `src/llm/research/tools.ts:178` | 6 | a | attendee domains per event line (prompt budget): keep |
| `src/llm/research/vdp-assets.ts:221` | 10 | a | company names in the research prompt (context budget): keep |
| `src/llm/research/vdp-assets.ts:223` | 40 | a | prompt budget (40 known assets shown); finds are deduplicated against every known asset when stored (upsertCandidates), so nothing is lost |
| `src/llm/skill-loader.ts:140` | 10 | a | coverage gaps in scan context pack (prompt budget): keep |
| `src/llm/skill-loader.ts:143` | maxInitiatives=25 | d-rank | initiatives in scan pack; initiativesTruncated count told; cc_get_context: keep; comment |
| `src/llm/skill-loader.ts:145` | maxOpenItems=60 | d-rank | open items in scan pack; cc_find_candidates searches all: keep; comment says the tool reaches the rest |
| `src/llm/skill-loader.ts:156` | 6 | a | people per open item in pack (prompt budget): keep |
| `src/llm/skill-loader.ts:157` | 4 | a | accounts per open item in pack: keep |
| `src/llm/skill-loader.ts:158` | 8 | a | keywords per open item in pack: keep |
| `src/llm/skill-loader.ts:159` | 4 | a | threads per open item in pack: keep |
| `src/llm/skill-loader.ts:160` | 4 | a | files per open item in pack: keep |
| `src/llm/skill-loader.ts:229` | 80 | a | fetcher coverage echoed in run header (already reported): keep |
| `src/llm/skill-loader.ts:256` | 12 | a | participants per source item in prompt: keep |
| `src/llm/skill-loader.ts:281` | 8 | a | urls per payload in prompt: keep |
| `src/llm/skill-loader.ts:290` | 50 | c | capStrings array bound with depth 5 (payload/recursion guard): keep |
| `src/llm/skill-runner.shared.ts:128` | 6 | c | trace outcomes per message (log): keep |
| `src/llm/skill-runner.triage.ts:43` | 200 | c | ids in a trace event (log size): keep |
| `src/llm/slack-rec.ts:160` | 10 | c | account hints per message: keep |
| `src/llm/slack-rec.ts:166` | 30 | c | participants per Slack message stored: keep |
| `src/llm/slack-rec.ts:182` | 4 | c | extra metadata lines per message: keep |
| `src/llm/spend/governor.ts:228` | const live = await this.store.listHolds( | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/llm/tool-digest.ts:31` | export const EXCERPT_MAX_CHARS = 4_000; | a | excerpt of a tool result digest (4,000 chars): prompt budget; the raw result is kept |
| `src/mock/chat-script.ts:315` | 4 | d-rank | mock-only demo: movers shown in a scripted reply: keep (mock) |
| `src/mock/chat-script.ts:364` | 2 | d-rank | mock-only demo: linked items: keep (mock) |
| `src/mock/chat-script.ts:403` | 3 | d-rank | mock-only demo: resource chips: keep (mock) |
| `src/mock/chat-script.ts:468` | 2 | d-rank | mock-only demo: asset chips: keep (mock) |
| `src/mock/org62-opps.ts:61` | limit=10 | a | mock Org62 search page size: keep (mock) |
| `src/ops/checks/backups.ts:12` (lane) | export const BACKUP_MAX_AGE_MS = 48 * 36 | c | a backup older than 48 h is flagged (a health threshold) |
| `src/ops/crash.ts:16` (lane) | export const CRASH_LOOP = { windowMs: 10 | c | crash-loop guard: 5 starts in 10 min then back off, told in Health |
| `src/ops/doctor-service.ts:30` (lane) | export const DOCTOR_CACHE_MAX_AGE_MS = 2 | c | doctor cache age (20 min): freshness, the next run refreshes |
| `src/ops/exec.ts:19` (lane) | { timeout: opts.timeoutMs ?? 15_000, env | c | child-process output memory bound |
| `src/ops/notify.ts:142` (lane) | this.o = { maxPerHour: 6, port: APP_PORT | c | at most 6 notifications an hour (no notification storm) |
| `src/outbox/adapters/release-handoff.ts:96` | max=12 | d-rank | release-post bullets; "and N more (CHANGELOG.md)" names the full list: keep; Slack post readability |
| `src/outbox/adapters/release-handoff.ts:154` | export const RELEASE_ANNOUNCE_MAX_CHARS  | a | Slack post size (6,000 chars, under the 40K block/text limits; a bullet list ends "and N more") |
| `src/outbox/adapters/slack.ts:89` | args: threadTs ? { channel_id: channel,  | a | read-back of my own post: the thread page (20) / one message |
| `src/outbox/adapters/vdp.ts:118` | 5 | c | VDP create warnings kept on the item: keep |
| `src/outbox/adapters/vdp.ts:208` | call = name ? { server: SERVER, tool: 'l | d-rank | company lookup: 5 matches by name (typing more narrows) |
| `src/outbox/settings.ts:36` | AUTOPILOT_ASSET_HOSTS_MAX=50 | b | trusted asset sites list bound (P25-11): keep; UI must say "up to 50 sites" (settings contract owned by review-fixes). **Since removed (943d654, no count cap): nothing to say** |
| `src/outbox/withdraw.ts:36` | const MAX_WHY = 160; | a | withdraw reason text (160 chars) in the audit line |
| `src/projections/activity.moves.ts:207` | const MAX_EVIDENCE_SOURCES = 8; | d-rank | 8 linked sources per evidence row; the description carries the counts |
| `src/projections/missed.ts:212` | 3 | d-rank | missed-DC lines: 3 reasons: keep |
| `src/projections/missed.ts:217` | 7 | d-rank | missed-DC: 7 display lines: keep |
| `src/projections/run.helpers.ts:158` | where e.source_item_id = ${sourceItemId} | c | items an evidence row touched (20 newest) |
| `src/projections/work-accounts.ts:26` | limit 2000`); | c | account matching batch (2,000 accountless items a pass, oldest first): finding F-8 |
| `src/scanner/completion/llm.ts:53` | maxTurns: 1, | a | a single tool-less completion (maxTurns 1) |
| `src/scanner/completion/pass.ts:77` | maxItemsPerPass: 48, | c | a page (48 items): the rest stay pending and a follow-up is queued (res.more) |
| `src/scanner/completion/pass.ts:79` | maxCandidatesPerItem: 6, | a | candidates per item in the judge prompt (6, ranked): prompt budget |
| `src/scanner/completion/pass.ts:80` | maxPromptChars: 14_000, | a | prompt size budget (14K chars) |
| `src/scanner/completion/pass.ts:81` | maxCallUsd: 0.05, | d | per-call $0.05: finding F-4. Done acbffc7 |
| `src/scanner/completion/pass.ts:82` | maxPassUsd: 0.4, | c | page $ line: past it the rest stay pending with a follow-up (res.more), not dropped |
| `src/scanner/completion/pass.ts:253` | const items = await store.completionItem | d | fixed d45b5c0: every live item (was newest 400; db clamp 2000) |
| `src/scanner/completion/pass.ts:296` | maxItemsPerPass=48 | c | items per completion pass; rest kept pending, res.more continues: keep; page |
| `src/scanner/completion/prompt.ts:60` | 6 | a | participants per source in prompt: keep |
| `src/scanner/completion/prompt.ts:82` | 3 | a | file refs per source in prompt: keep |
| `src/scanner/completion/prompt.ts:98` | 3 | a | asker names in prompt: keep |
| `src/scanner/drive-digest/diff.ts:7` | const CAP = 600; | c | payload bound of one stored change entry (600 chars), marked with an ellipsis |
| `src/scanner/drive-digest/diff.ts:9` | const MAX_LINES = 8; | c | kept (payload bound of one change entry) + fixed 98dbc0d: linesAddedTotal / linesRemovedTotal when cut |
| `src/scanner/drive-digest/diff.ts:21` | MAX_LINES=8 | d | kept (payload) + fixed 98dbc0d: linesAddedTotal |
| `src/scanner/drive-digest/diff.ts:22` | MAX_LINES=8 | d | kept (payload) + fixed 98dbc0d: linesRemovedTotal |
| `src/scanner/drive-digest/fetcher.ts:156` | maxSheetTabs=8 | d | kept, named for the Sheets per-user read quota + fixed 98dbc0d: sheetsNotRead in the digest and "N more tabs not read" in the summary |
| `src/scanner/fetch/org62.ts:49` | limit: 50, | a | SOQL page, paged by stamp + id |
| `src/scanner/fetch/org62.ts:55` | if (accounts) out.push({ ref: 'soql:Oppo | a | SOQL page, paged by stamp + id |
| `src/scanner/fetch/org62.ts:57` | if (book === 'owner' // book === 'both') | a | SOQL page, paged by stamp + id |
| `src/scanner/fetch/org62.ts:65` | limit: 40, | a | SOQL page, paged by stamp + id |
| `src/scanner/fetch/org62.ts:75` | limit: 100, | a | SOQL page, paged by stamp + id |
| `src/scanner/fetch/slack.ts:46` | const base = { sort: 'timestamp', sort_d | a | Slack search page (20), paged by cursor up to maxPages, then complete=false |
| `src/scanner/fetch/slack.ts:60` | return [{ ref: `search:channel:${id}`, k | a | Slack channel page (100), paged |
| `src/scanner/fetch/slack.ts:65` | return [{ ref: `slack:${channel}:${ts}`, | a | Slack thread page (100), paged |
| `src/scanner/fetch/slack.ts:145` | const args = { channel_id: t.channel, me | d | fixed a155f39: every thread found is opened (was oldest 5/10), each paged at 100 (was cut at 30) |
| `src/scanner/fetch/slack.ts:185` | max (5 / 10 backfill) | d | fixed a155f39: every thread found |
| `src/scanner/interpret/render.ts:28` | 4 | a | alias names per account in glossary: keep |
| `src/scanner/interpret/render.ts:30` | 40 | d | fixed 634e636: every account (cached prefix) |
| `src/scanner/interpret/render.ts:34` | 40 | d | fixed 634e636: every channel |
| `src/scanner/interpret/render.ts:35` | 25 | d | fixed 634e636: every initiative |
| `src/scanner/interpret/render.ts:70` | 4 | a | recipients per line in prompt: keep |
| `src/scanner/interpret/render.ts:101` | 8 / 18 wide | a | conversation context lines per item (prompt budget; wide pass shows more): keep |
| `src/scanner/interpret/render.ts:104` | 3 | a | file refs per item in prompt: keep |
| `src/scanner/interpret/units.ts:40` | 3 | a | recipient names in a prompt line: keep |
| `src/scanner/interpret/units.ts:46` | 3 | a | recipient names in a prompt line: keep |
| `src/scanner/interpret/units.ts:60` | 8 | a | people terms for candidate join query: keep |
| `src/scanner/interpret/units.ts:71` | 10 | a | file refs for candidate join query: keep |
| `src/scanner/interpret/units.ts:82` | 5 | a | account hints for candidate join: keep |
| `src/scanner/interpret/units.ts:84` | 16 | a | distinctive words for candidate join (store scoring falls with long queries): keep; comment explains |
| `src/scanner/interpret/units.ts:85` | for (let i = 0; i < words.length; i += 4 | d-rank | top 5 candidate homes per 4-word probe (ranking) |
| `src/scanner/interpret/units.ts:86` | 6 | a | subject words for candidate join: keep |
| `src/scanner/interpret/units.ts:90` | 5 | d-rank | top-5 candidate homes by score (w1..w5) for the model: keep; ranking |
| `src/scanner/interpret/units.ts:212` | const rows = await store.conversationLin | a | conversation lines around an item (12 before, 6 after): prompt context budget |
| `src/scanner/precheck/slack.ts:33` | const base = { sort: 'timestamp', sort_d | a | precheck: is there anything (one message) |
| `src/scanner/reconcile/reconciler.ts:174` | 50 | c | coverage-gap findings per scope; rescan window covers all missed: keep |
| `src/scanner/reconcile/reconciler.ts:175` | 20 | c | object refs passed as a run var; window covers all: keep |
| `src/scanner/reconcile/reconciler.ts:185` | const items = (await this.d.store.unlink | c | a page per reconcile pass (oldest flag first; re-flagged rows rotate to the end) |
| `src/scanner/reconcile/reconciler.ts:257` | const still = ((await this.d.store.unlin | d | fixed d45b5c0: Infinity (the 500 newest-flagged could miss the batch just re-flagged) |
| `src/scanner/reconcile/reconciler.ts:389` | const fetch = await spec.fetcher.fetch(u | a | skill-upgrade dry run reads one page (50) |
| `src/scanner/resolution/recall.ts:14` | export const RECALL_MAX_THREADS = 25; | c | 25 threads per 30-min poll, rotated by lastRecordedAt (a page) |
| `src/scanner/resolution/triggers-db.ts:49` | maxAttempts: 2, | c | job retry count; a dead job shows in Health |
| `src/scanner/resolution/triggers-db.ts:58` | const r = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/scanner/resolution/triggers-db.ts:77` | order by wi.updated_at desc limit 800`) | c | open items matched against new evidence: 800 newest updated: finding F-8 |
| `src/scanner/resolution/triggers-db.ts:104` | limit 2000`) | c | source items of one run: 2,000: finding F-8 |
| `src/scanner/resolution/triggers-db.ts:163` | order by wi.updated_at desc limit 2000`) | c | open items for the sweep: 2,000 newest updated: finding F-8 |
| `src/scanner/runtime/cadence-state.ts:64` | export function cadenceSeedFrom(snap: Ca | c | a cadence snapshot older than 6 h is not reused |
| `src/scanner/runtime/cadence.ts:68` | maxQuietLevel: 3, | c | quiet-scope backoff levels (3): scheduling, a scan still runs |
| `src/scanner/runtime/cadence.ts:89` | export const MAX_SLOWDOWN_MS = 4 * 60 *  | c | longest quiet slowdown (4 h): scheduling bound |
| `src/scanner/runtime/connectors.ts:322` | 200 | d | fixed ffeb2a3: every id; the fetch splits into IN clauses of 200 (ORG62_IN_CHUNK, SOQL statement size) |
| `src/scanner/runtime/fti-specs.ts:46` | return { maxItemsPerRun: 100, costCapUsd | c | FTI page (100 items) + per-run cost cap $0.02/$0.05 (paged: complete=false continues); cost cap is F-4. Done 8b1ce80 |
| `src/scanner/runtime/scanner-runtime.plan.ts:246` | const live = await gov.store.listHolds({ | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/scanner/runtime/scanner-runtime.shared.ts:117` | 'This window was over the prompt size li | a | retry instruction after a prompt-size overflow (half page sizes) |
| `src/scanner/runtime/scanner-runtime.shared.ts:123` | export const HOLD_MAX_MS = 30 * MIN; | c | first-scan hold waits at most 30 min for the book read |
| `src/scanner/store-db.base.ts:298` | 12 | c | keywords stored per initiative: keep |
| `src/scanner/store-db.base.ts:319` | order by i.updated_at desc limit 200`); | d | fixed b64e41e: every live initiative (was newest 200) |
| `src/scanner/store-db.base.ts:337` | limit 500`); | d | fixed b64e41e: every account (was 500; feeds the glossary and the Org62 IN lists) |
| `src/scanner/store-db.finish.ts:245` | 20 | c | hints merged on a finding: keep |
| `src/scanner/store-db.items.ts:197` | 50 | c | participants stored per source item: keep |
| `src/scanner/store-db.items.ts:256` | 30 | c | file refs stored per source item: keep |
| `src/scanner/store-db.proposals.ts:200` | limit 20`); | c | duplicate-candidate lookup: 20 nearest |
| `src/scanner/store-db.proposals.ts:235` | 30 | c | expected changes stored per proposal: keep |
| `src/scanner/store-db.proposals.ts:286` | 20 | c | hints per unlinked flag: keep |
| `src/scanner/store-db.proposals.ts:300` | 20 | c | merged hints per finding: keep |
| `src/scanner/store-db.proposals.ts:324` | 20 | c | coverage refs in a trace event: keep |
| `src/scanner/store-db.proposals.ts:358` | 10 | c | highlight reasons stored as keywords: keep |
| `src/scanner/store-db.shared.ts:99` | const META_MAX_STRING = 240; | c | stored metadata string bound (240) |
| `src/scanner/store-db.ts:203` | return { capUsd: Number.isFinite(cap) && | b | the user budget's cap (settings.budgets); 1 is the fallback when the row is unreadable |
| `src/scanner/store-memory.runs.ts:326` | 20 | c | merged hints (mock store): keep |
| `src/scanner/store-memory.state.ts:329` | 12 | c | keywords per initiative (mock store): keep |
| `src/scanner/trace/emit.ts:22` | const MAX_STRING = 160; | c | trace string bound (logs) |
| `src/scanner/trace/emit.ts:24` | const MAX_LONG = 300; | c | trace long-string bound (logs) |
| `src/scanner/trace/emit.ts:46` | 500 | c | evict oldest run seq counters past 2000 (memory guard): keep |
| `src/scanner/trace/emit.ts:102` | 40 | c | object keys per trace payload (log size): keep |
| `src/scanner/triage/slack-triage.ts:37` | maxBatches: 12, | d | fixed 99faf99: unset by default, every batch runs (lines past 12 batches got no verdict) |
| `src/scanner/triage/slack-triage.ts:38` | maxTurns: 16, | c | turns per triage batch (16): runaway guard per batch; each batch has its own cost cap |
| `src/scanner/triage/slack-triage.ts:267` | maxBatches=12 | d | fixed 99faf99: every batch by default |
| `src/scanner/triage/slack-triage.ts:300` | 6 | a | participant names in a prompt line: keep |
| `src/scanner/triage/slack-triage.ts:430` | 3 | a | done-ids in a prompt tag: keep |
| `src/scanner/triage/slack-triage.ts:432` | 3 | a | file refs per prompt line: keep |
| `src/scanner/triage/slack-triage.ts:452` | 3 | a | recipient names: keep |
| `src/scanner/triage/slack-triage.ts:458` | 3 | a | recipient names: keep |
| `src/server/chat/compact.ts:30` | 3 | d-rank | top 3 rank reasons per item hit: keep; full reasons via read item |
| `src/server/chat/compact.ts:148` | 7 | a | Assistant context pack: 7 more-today items, moreTodayCount sent: keep; count present, rest via read tool (A1 paging) |
| `src/server/chat/compact.ts:151` | 4 | d-rank | kept (prompt budget) + fixed bf307d5: promisesCount |
| `src/server/chat/compact.ts:152` | 4 | d-rank | kept (prompt budget) + fixed bf307d5: fitInsCount |
| `src/server/chat/compact.ts:155` | 14 | d-rank | kept (prompt budget) + fixed bf307d5: calendarCount |
| `src/server/chat/compact.ts:159` | 5 | d-rank | kept (prompt budget) + fixed bf307d5: appliedCount |
| `src/server/chat/compact.ts:169` | return redactPayload(pack, { maxDepth: 8 | a | context pack redaction depth/string budget (per-turn prompt) |
| `src/server/chat/compact.ts:181` | const s = JSON.stringify(redactPayload(v | a | compaction redaction budget; maxArray Infinity |
| `src/server/chat/compact.ts:184` | const facts = v && typeof v === 'object' | a | compaction facts budget |
| `src/server/chat/read.ts:136` | const MAX_STRING = 2_000; | a | model context: a string in a read page is clipped at 2,000 chars; the field page reads the rest (fieldPage) |
| `src/server/chat/read.ts:137` | const MAX_DEPTH = 14; | c | recursion depth guard (14) for the read cleaner |
| `src/server/chat/read.ts:402` | export async function sinceLastLogged(ge | c | sinceLastLogged walks back at most 26 weeks (loop guard over weekly reads) |
| `src/server/chat/read.ts:720` | opts.limit | param | find_items caller limit, no fixed number: keep |
| `src/server/chat/research.ts:118` | 20 | d | mirrors the research tool schema names.max(20) in src/llm/chat/tools.ts (lane; the model gets a validation error past 20). Proposal F-10 |
| `src/server/datasource/db/attribution.ts:483` | await enqueueJob(w.tx, { ownerUserId: w. | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/attribution.ts:554` | enqueueJob(tx, { ownerUserId: userId, ki | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/attribution.ts:595` | order by p.display_name limit 10`); | d-rank | people search: 10 by name (typing narrows) |
| `src/server/datasource/db/attribution.ts:602` | 15 | d-rank | covered-AE lookup picker hits (SQL limit 10 above): keep as search picker; typing more narrows |
| `src/server/datasource/db/audit.ts:203` | 12 | d-rank | audit entry related refs; full rows in changes: keep; changes list is complete |
| `src/server/datasource/db/chat-be6.reads.ts:177` | google: new GoogleWorkspaceClient({ time | c | HTTP retry count |
| `src/server/datasource/db/chat-be6.shared.ts:90` | const g = new GoogleWorkspaceClient({ ti | c | retries 0 (a chat lookup fails fast) |
| `src/server/datasource/db/chat-be6.shared.ts:98` | n<=10 | c | unreachable: only the ledger reaches searchSources; the live Assistant search pages Gmail/Drive by page_token up to 50 (tools.ts, lane). Proposal F-9: delete searchGoogle. **Deleted 4cc373f** |
| `src/server/datasource/db/chat-be6.shared.ts:109` | n<=10 | c | unreachable (as :98) |
| `src/server/datasource/db/chat-be6.ts:151` | google: async () => new (await import('@ | c | HTTP retry count |
| `src/server/datasource/db/closure.ts:403` | 1 | d-rank | reopened item card carries first source: keep; full sources on the item |
| `src/server/datasource/db/domains/agents.ts:162` | 10 | c | adapter recentRunIds rolling pointer list: keep; runs stay in tool_runs |
| `src/server/datasource/db/domains/chat.ts:256` | n | param | topItems(n) caller-supplied: keep |
| `src/server/datasource/db/domains/drafts.ts:220` | const job = await enqueueJob(w.tx, { own | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/domains/engine.ts:207` | 1 | d-rank | sibling suggestion carries first source: keep; full sources on the item |
| `src/server/datasource/db/domains/health.ts:114` | spendAsks: await this.ctx.spendGovernor( | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/server/datasource/db/domains/health.ts:185` | const r = await enqueueJob(this.ctx.db,  | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/domains/health.ts:213` | await enqueueJob(w.tx, { ownerUserId: w. | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/domains/health.ts:303` | query.limit | param | scan ledger: ListQuery limit<=500 default 100, no offset: add cursor/offset to ListQuery (src/contract/requests.ts, review-fixes lane) |
| `src/server/datasource/db/domains/health.ts:349` | const holds = await gov.store.listHolds( | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/server/datasource/db/domains/health.ts:350` | const open = await gov.store.listHolds({ | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/server/datasource/db/domains/time.ts:130` | await enqueueJob(w.tx, { ownerUserId: w. | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/domains/today.ts:53` | limit 40`); | d-rank | Home list order: 40 ids (DATA-MODEL Q1); Work has the full order |
| `src/server/datasource/db/domains/today.ts:223` | 3 | d-rank | rerank returns top3 ids; full order stored: keep |
| `src/server/datasource/db/domains/today.ts:230` | 3 | d-rank | systemRerank returns top3 ids: keep |
| `src/server/datasource/db/domains/vdp.ts:348` | await enqueueJob(this.ctx.db, { ownerUse | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/events.ts:192` | 50 | a | live event ids; Postgres NOTIFY 8000-byte payload, views refetch by topic: keep; use MAX_IDS and name the NOTIFY limit |
| `src/server/datasource/db/forecast.ts:100` | 12 | d | fixed e0a93ab: every meeting |
| `src/server/datasource/db/forecast.ts:110` | const r = await enqueueJob(this.host.db, | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/forecast.ts:128` | const r = await enqueueJob(this.host.db, | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/forecast.ts:165` | const r = await enqueueJob(this.host.db, | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/forecast.ts:168` | await enqueueJob(this.host.db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/priority.ts:37` | 10 | c | priority run snapshot: v2 terms for top 10: keep; storage bound of shadow-run record |
| `src/server/datasource/db/priority.ts:38` | 20 | c | priority run snapshot: order top 20: keep; storage bound of shadow-run record |
| `src/server/datasource/db/rank.ts:109` | limit=10 | d-rank | toRankRows: rerank/preview diff rows top 10: keep; Work page shows full order |
| `src/server/datasource/db/rank.ts:133` | 3 | d-rank | Now stack top 3 by design: keep |
| `src/server/datasource/db/rank.ts:151` | 10 | d-rank | policy preview: before top 10: keep; preview of a diff |
| `src/server/datasource/db/rank.ts:213` | 5 | d-rank | rank reasons per item 5: keep; full score on item |
| `src/server/datasource/db/readin.ts:252` | maxAttempts: 3, | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/resolution.ts:73` | order by si.occurred_at desc limit 4`) | a | resolution evidence: 4 newest lines (prompt budget) |
| `src/server/datasource/db/resolution.ts:90` | order by si.occurred_at desc limit 20`) | a | Claude sessions for the check: 20 newest, then 2 (prompt budget) |
| `src/server/datasource/db/resolution.ts:93` | 2 | d-rank | resolution evidence: 2 newest matching Claude sessions (SQL limit 20): keep; check prompt evidence |
| `src/server/datasource/db/spend.ts:105` | group by c.scan_run_id order by max(c.st | c | estimate samples: newest 500 runs of the skill in 14 days (a quantile sample) |
| `src/server/datasource/db/spend.ts:113` | order by c.started_at desc limit 500`); | c | estimate samples (as above) |
| `src/server/datasource/db/spend.ts:120` | group by coalesce(c.job_id::text, c.chat | c | estimate samples (as above) |
| `src/server/datasource/db/store/draft-source.ts:32` | const MAX_THREAD = 60; | c | thread read for a draft's source (60 newest messages); earlierTotal counts within them: finding F-7 |
| `src/server/datasource/db/store/vdp-assets.ts:136` | 20 | d | fixed 5031fbd: every link |
| `src/server/datasource/db/store/vdp-candidates.ts:112` | 8 | d | fixed 5031fbd: every source |
| `src/server/datasource/db/store/vdp-candidates.ts:123` | 20 | d | fixed 5031fbd: every source item |
| `src/server/datasource/db/store/vdp-candidates.ts:222` | maxAttempts: 1, | c | job retry count; a dead job shows in Health |
| `src/server/datasource/db/use-cases.ts:485` | enqueueJob(tx, { ownerUserId: userId, ki | c | job retry count; a dead job shows in Health |
| `src/server/datasource/draft-source.ts:70` | const MAX_EARLIER = 5; | d-rank | 5 earlier messages with earlierTotal ("of N") in Replying to |
| `src/server/datasource/log-canvases.ts:138` | 10 | d | proposal F-5: the Assistant's chat_log_batch carries the newest 10 applied canvases with no total; add appliedTotal + offset (the tool lives in tools.ts, lane). **Paged 25ec609** |
| `src/server/datasource/mock/attribution.ts:227` | 10 | d-rank | mock twin AE lookup 10: keep (search picker) |
| `src/server/datasource/mock/chat-be6.ts:227` | limit | param | mock search caller limit: keep |
| `src/server/datasource/mock/chat-be6.ts:243` | const job: Job = { id: id('job'), type:  | c | job retry count; a dead job shows in Health |
| `src/server/datasource/mock/ctx.ts:149` | 12 | d-rank | mock twin audit related 12: keep |
| `src/server/datasource/mock/domains/agents.ts:133` | 10 | c | mock twin: adapter recentRunIds rolling list: keep |
| `src/server/datasource/mock/domains/chat.ts:166` | n | param | mock twin topItems(n): keep |
| `src/server/datasource/mock/domains/health.ts:43` | spendAsks: (await this.ctx.spendGov.stor | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/server/datasource/mock/domains/health.ts:55` | const holds = await this.ctx.spendGov.st | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/server/datasource/mock/domains/health.ts:56` | return spendHoldsPayload(holds, await th | d | fixed 3581115: no limit (every ask listed, every hold counted and swept); listHolds without limit = all (was a silent 200) |
| `src/server/datasource/mock/domains/health.ts:185` | query.limit | param | mock twin scan ledger limit: same as db health.ts:303 |
| `src/server/datasource/mock/domains/settings.ts:125` | 10 | d-rank | mock twin policy preview before 10: keep |
| `src/server/datasource/mock/domains/time.ts:188` | 10 | d-rank | mock Org62 opp search hits 10 (db limit 10 default): keep (search; narrow query) |
| `src/server/datasource/mock/forecast.ts:125` | 12 | d | fixed e0a93ab: every meeting |
| `src/server/datasource/mock/priority.ts:40` | 20 | c | mock twin priority run shown 20: keep |
| `src/server/datasource/mock/rank.ts:81` | 4 | d-rank | mock twin rank reasons 4 (db keeps 5: parity drift): align to db (5) or keep all |
| `src/server/datasource/mock/rank.ts:136` | limit=10 | d-rank | mock twin toRankRows top 10: keep |
| `src/server/datasource/mock/readin.ts:84` | 3 | d-rank | mock read-in: 3 drafts: keep (mock synthetic brief) |
| `src/server/datasource/mock/readin.ts:107` | 2 | d-rank | mock read-in siblings 2: keep (mock brief format) |
| `src/server/datasource/mock/readin.ts:109` | 4 | d-rank | mock read-in history 4: keep (mock brief format) |
| `src/server/datasource/mock/readin.ts:119` | 2 | d-rank | mock read-in contradictions 2: keep (mock brief format) |
| `src/server/datasource/mock/readin.ts:122` | 6/3 | d-rank | mock read-in background 6, questions 3: keep (mock brief format) |
| `src/server/events/pg-bus.ts:168` | MAX_IDS=50 | a | NOTIFY payload ids (8000 bytes): keep |
| `src/server/events/pg-bus.ts:171` | 5 | a | payload >7900 bytes: ids cut to 5 (NOTIFY 8000): keep |
| `src/server/events/pg-bus.ts:243` | MAX_IDS=50 | a | incoming NOTIFY ids: keep |
| `src/server/events/publisher.ts:42` | select entity_type, entity_id, op, table | a | changed rows per change set for one event (NOTIFY bound, MAX_IDS 50 applies anyway) |
| `src/server/events/topics.ts:145` | export const MAX_IDS = 50; | a | Postgres NOTIFY payload 8,000 bytes; views refetch by topic |
| `src/server/events/topics.ts:166` | MAX_IDS=50 | a | event ids per topic (NOTIFY 8000): keep |
| `src/server/feedback/agent.ts:48` | export const FEEDBACK_MAX_TURNS = 14; | d | diagnose run 14 turns + FEEDBACK_CAP_USD: finding F-4 (per-feature caps). Done 03f7ec7 |
| `src/server/feedback/diagnostics.ts:30` | export const DIAGNOSTICS_MAX_CHARS = 320 | a | diagnostics block in the Slack feedback post (3,200 chars) |
| `src/server/feedback/diagnostics.ts:75` | 10 | a | top 10 error codes in diagnostics block (DIAGNOSTICS_MAX_CHARS, Slack post): keep |
| `src/server/feedback/fallback.ts:90` | 8 | d-rank | feedback report files 8: keep (report format, Slack post) |
| `src/server/feedback/fallback.ts:91` | 8 | d-rank | feedback report files 8: keep |
| `src/server/feedback/reads.ts:147` | 15 | d-rank | diagnose agent: newest 15 events: keep or add offset arg to the tool |
| `src/server/feedback/reads.ts:157` | 12 | d-rank | diagnose agent: newest 12 jobs: keep or add offset arg |
| `src/server/feedback/reads.ts:182` | 10 | d-rank | diagnose agent: newest 10 scans: keep or add offset arg |
| `src/server/feedback/service.ts:112` | 8 | d-rank | feedback diagnosis files 8: keep |
| `src/server/feedback/service.ts:148` | 10 | d-rank | diagnose prompt: first 10 distinct error codes as a hint: keep; agent reads full log via tools |
| `src/server/forecast/draft.ts:169` | 12 | d | fixed e0a93ab: every meeting |
| `src/server/forecast/draft.ts:170` | 6 | c | unreachable: the job passes two names (account, opp) |
| `src/server/forecast/soql.ts:18` | export const SFR_MAX_PAGES = 8; | d | fixed 6c98270: pages to the end; 400 pages is a runaway guard + no-progress stop |
| `src/server/forecast/soql.ts:75` | return `SELECT ParentId, MAX(CreatedDate | a | SOQL aggregate |
| `src/server/onboarding/identity.ts:36` | return { connector: 'slack', tool: 'slac | a | identity probe: 5 of my messages |
| `src/server/vdp/find.ts:115` | capUsd (day line) | b | VDP find run plan stops at caller cap or the Assistant day line; says shortfall: keep; note says how to allow more |
| `src/server/vdp/identity.ts:33` | 25 | d-rank | VDP company picker matches 25: keep (search picker) |
| `src/server/vdp/push.ts:62` | VDP_PUSH_KEEP=5 | c | push-run history in settings blob; each run audited: keep |
| `src/server/vdp/specialist-aes.ts:38` | return `SELECT Opportunity__c, ForecastT | a | SOQL IN chunk |
| `src/server/views/agents.ts:19` | 20 | d-rank | GET /tools "recent runs" (20, the UI has an expand toggle); proposal F-5: a cursor if anyone needs older runs |
| `src/server/views/drafts.ts:65` | ADMIN_APPLIED_KEEP=50 | d-rank | Outbox admin applied: newest 50: verify Activity history lists all; else add Load more |
| `src/server/views/today.ts:71` | 12 | d-rank | More today 12 items; count sent, Work page lists all: keep |
| `src/server/views/today.ts:116` | 2 | d-rank | rail Since-you-left 2 entries + count + href: keep |
| `src/server/views/today.ts:167` | 2 | d-rank | rail Agents 2 entries + count: keep |
| `src/server/views/today.ts:190` | 2 | d-rank | rail Waiting 2 entries + count: keep |
| `src/server/views/today.ts:260` | 2 | d-rank | rail Briefs 2 entries + count: keep |
| `src/server/views/today.ts:293` | 2 | d-rank | shelves fit-ins/promises 2, no count: add counts; Work page has the rest |
| `src/server/views/universal.ts:90` | query.limit | param | people search; total returned: keep (SearchQuery max 50) |
| `src/server/views/universal.ts:121` | query.limit | param | universal search; total returned: keep (SearchQuery max 50, contract) |
| `src/tools/adapters/talk-track.ts:17` | const MAX_REF_BYTES = 25 * 1024 * 1024; | c | reference file size bound (25 MB): memory |
| `src/tools/claude-launch.ts:25` | export const MAX_PROMPT_CHARS = 14336; | a | Claude Desktop /code/new reads 14,336 characters |
| `src/tools/claude-launch.ts:193` | MAX_PROMPT_CHARS=14336 | a | Claude Desktop /code/new reads only the first 14336 chars: keep; comment names it |
| `src/ui/ShowMore.tsx:36` | next | d-rank | Show N more label: keep |
| `src/worker/scanning.ts:101` | const ctx = await o.store.getContext({ c | d | fixed b64e41e: Infinity (Drive tracks every open item's files; was the newest 500) |
| `src/worker/schedules.ts:166` | order by next_run_at limit 50`); | c | 50 due schedules a tick (the next tick takes the rest) |
| `src/worker/vdp-autopilot-hook.ts:74` | const q = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/worker/vdp-autopilot-hook.ts:103` | const q = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/worker/vdp-autopilot-hook.ts:131` | const q = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |
| `src/worker/vdp-autopilot-hook.ts:159` | const q = await enqueueJob(db, { ownerUs | c | job retry count; a dead job shows in Health |

### A.2 Formatting slices, free-text trims and dev tooling, by file (kept)

ISO date/time prefixes, id15 and hash prefixes are not limits. Text trims bound a title, a log line, a payload field or a prompt snippet to a length; they never drop an item. Dev rows are scripts that do not run in the app.

| file | fmt | text | dev |
|---|---|---|---|
| `scripts/build-example-seed.ts` |  |  | 4 |
| `scripts/build-example-seed.world.ts` |  |  | 1 |
| `scripts/db/read-profile.ts` |  |  | 3 |
| `scripts/db/seed-from-mock.ts` |  |  | 1 |
| `scripts/dev/load-guard.mjs` |  |  | 1 |
| `scripts/eval/record.ts` |  |  | 1 |
| `scripts/lib/release.mjs` |  |  | 1 |
| `scripts/ops/lib/migrate-cluster.mjs` |  |  | 2 |
| `scripts/ops/lib/release-manifest.mjs` |  |  | 1 |
| `scripts/private/scan.ts` |  |  | 1 |
| `scripts/qa/crawl.mjs` |  |  | 6 |
| `scripts/release/smoke.mjs` |  |  | 1 |
| `scripts/sample-data/lint.ts` |  |  | 1 |
| `scripts/scan/explain.ts` |  |  | 2 |
| `scripts/scan/report.ts` |  |  | 4 |
| `scripts/seed/build-real-seed.ts` |  |  | 4 |
| `scripts/seed/lib.ts` |  |  | 3 |
| `scripts/seed/mappers.ts` |  |  | 2 |
| `scripts/settle/context-check.ts` |  |  | 1 |
| `scripts/settle/score-rescan.ts` |  |  | 1 |
| `scripts/settle/score.ts` |  |  | 2 |
| `scripts/shot.mjs` |  |  | 1 |
| `scripts/stress/answer-key.ts` |  |  | 2 |
| `scripts/stress/completion-probe.ts` |  |  | 1 |
| `scripts/stress/diag-run.ts` |  |  | 1 |
| `scripts/stress/disagreements.ts` |  |  | 1 |
| `scripts/stress/driver/child.ts` |  |  | 1 |
| `scripts/stress/driver/scripted-runner.ts` |  |  | 11 |
| `scripts/stress/driver/world.ts` |  |  | 3 |
| `scripts/stress/invariants.ts` |  |  | 3 |
| `scripts/stress/lib/agent.ts` |  |  | 2 |
| `scripts/stress/lib/db.ts` |  |  | 1 |
| `scripts/stress/lib/exec-calls.ts` |  |  | 2 |
| `scripts/stress/lib/time.ts` |  |  | 1 |
| `scripts/stress/missbank.ts` |  |  | 4 |
| `scripts/stress/probe.ts` |  |  | 7 |
| `scripts/stress/record/google.ts` |  |  | 2 |
| `scripts/stress/record/org62.ts` |  |  | 2 |
| `scripts/stress/record/slack.ts` |  |  | 3 |
| `scripts/stress/replay/google.ts` |  |  | 4 |
| `scripts/stress/replay/slack.ts` |  |  | 3 |
| `scripts/stress/replay/soql.ts` |  |  | 3 |
| `scripts/stress/scenarios/common.ts` |  |  | 2 |
| `scripts/stress/scenarios/live.ts` |  |  | 4 |
| `scripts/stress/scenarios/mechanics.ts` |  |  | 5 |
| `scripts/stress/score.ts` |  |  | 2 |
| `scripts/stress/survey.ts` |  |  | 2 |
| `scripts/test/crawl.ts` |  |  | 3 |
| `scripts/time-rederive.ts` |  |  | 4 |
| `src/client/api.ts` | 1 |  |  |
| `src/client/chat/sse.ts` | 1 |  |  |
| `src/client/chat/useChatStream.ts` |  | 1 |  |
| `src/client/placeholder.tsx` |  | 1 |  |
| `src/client/toast/store.ts` | 1 |  |  |
| `src/components/chat/ChatComposer.tsx` | 3 |  |  |
| `src/components/chat/ChatMessages.tsx` |  | 1 |  |
| `src/components/chat/SpendAskCard.tsx` |  | 2 |  |
| `src/components/chat/commands.ts` | 1 | 1 |  |
| `src/components/chat/markdown.ts` | 1 |  |  |
| `src/components/composer/DraftProposal.tsx` |  | 3 |  |
| `src/components/composer/RecipientPreview.tsx` | 1 |  |  |
| `src/components/deals/missed.ts` | 1 | 1 |  |
| `src/components/detail/panel/bits.tsx` | 1 |  |  |
| `src/components/detail/tabs/HistoryTab.tsx` |  | 1 |  |
| `src/components/detail/tabs/WhyHere.tsx` | 1 |  |  |
| `src/components/domain/AheadStrip.tsx` | 1 |  |  |
| `src/components/feedback/FeedbackPanel.tsx` | 1 |  |  |
| `src/components/feedback/client-errors.ts` |  | 2 |  |
| `src/components/feedback/context.ts` | 1 | 6 |  |
| `src/components/health/FirstScan.tsx` | 1 |  |  |
| `src/components/health/SpendAsks.tsx` |  | 2 |  |
| `src/components/health/SpendAudit.tsx` | 2 | 1 |  |
| `src/components/history/derive.ts` | 2 |  |  |
| `src/components/home/model.ts` |  | 1 |  |
| `src/components/lists/panel.ts` | 1 |  |  |
| `src/components/needs/SetAside.tsx` |  | 1 |  |
| `src/components/needs/useNeeds.ts` | 1 |  |  |
| `src/components/panels/bits.tsx` |  | 1 |  |
| `src/components/settings/AboutSection.tsx` | 1 |  |  |
| `src/components/settings/ClosingSection.tsx` |  | 1 |  |
| `src/components/settings/TimeSection.tsx` | 2 |  |  |
| `src/components/settings/derive.ts` |  | 1 |  |
| `src/components/settings/role.ts` | 1 | 2 |  |
| `src/components/settings/state.tsx` |  | 1 |  |
| `src/components/time/VdpView.tsx` |  | 1 |  |
| `src/components/time/derive.ts` | 4 |  |  |
| `src/components/time/ledger-derive.ts` | 1 |  |  |
| `src/components/time/log-derive.ts` | 3 |  |  |
| `src/components/time/path-derive.ts` | 1 |  |  |
| `src/components/today/TodayPage.tsx` |  | 1 |  |
| `src/connectors/claude/sessions.ts` | 1 | 4 |  |
| `src/connectors/claude/transcript.ts` |  | 3 |  |
| `src/connectors/google/calendar.ts` |  | 1 |  |
| `src/connectors/google/client.ts` |  | 1 |  |
| `src/connectors/google/gemini-notes.ts` | 1 | 1 |  |
| `src/connectors/google/gmail.ts` |  | 2 |  |
| `src/connectors/google/parse.ts` | 2 |  |  |
| `src/connectors/google/trainings.ts` | 2 | 6 |  |
| `src/connectors/org62/ids.ts` | 1 |  |  |
| `src/connectors/util.ts` | 1 |  |  |
| `src/connectors/vdp/client.ts` |  | 2 |  |
| `src/connectors/vdp/parse.ts` | 1 |  |  |
| `src/contract/deals.ts` |  | 2 |  |
| `src/contract/settings.ts` |  | 2 |  |
| `src/contract/vdp.ts` | 1 |  |  |
| `src/db/ledger.ts` | 2 | 2 |  |
| `src/db/queries.ts` | 5 |  | 5 |
| `src/engines/activity/canvas-review.ts` | 6 | 6 |  |
| `src/engines/activity/canvas-workorder.ts` | 2 | 1 |  |
| `src/engines/activity/classify.ts` | 1 |  |  |
| `src/engines/activity/entry.ts` | 1 | 1 |  |
| `src/engines/activity/handoff.ts` | 1 |  |  |
| `src/engines/activity/internal.ts` |  | 1 |  |
| `src/engines/activity/note.ts` |  | 4 |  |
| `src/engines/activity/onsite.ts` | 1 |  |  |
| `src/engines/activity/org62-check.ts` |  | 2 |  |
| `src/engines/activity/readback.ts` | 2 |  |  |
| `src/engines/activity/rederive.ts` |  | 1 |  |
| `src/engines/activity/rollup.ts` | 3 |  |  |
| `src/engines/activity/slackbot.ts` | 1 |  |  |
| `src/engines/activity/suggest-prompt.ts` |  | 1 |  |
| `src/engines/activity/time.ts` | 2 |  |  |
| `src/engines/activity/use-cases.model.ts` | 1 | 1 |  |
| `src/engines/activity/use-cases.plan.ts` |  | 2 |  |
| `src/engines/activity/use-cases.ts` | 2 |  |  |
| `src/engines/attribution/engagement.ts` | 1 |  |  |
| `src/engines/attribution/row.ts` | 2 |  |  |
| `src/engines/attribution/score.ts` | 2 |  |  |
| `src/engines/attribution/view.ts` |  | 1 |  |
| `src/engines/briefs/prompt/build.ts` | 1 |  |  |
| `src/engines/deals/evidence.ts` |  | 2 |  |
| `src/engines/deals/needs.ts` | 1 | 1 |  |
| `src/engines/forecast/canvas.ts` | 1 |  |  |
| `src/engines/forecast/queue.ts` | 1 |  |  |
| `src/engines/forecast/time.ts` | 1 |  |  |
| `src/engines/home/build.ctx.ts` | 1 |  |  |
| `src/engines/home/build.sections.ts` | 2 |  |  |
| `src/engines/home/text.ts` |  | 1 |  |
| `src/engines/nba/prompt/build.ts` | 1 | 2 |  |
| `src/engines/nba/prompt/dates.ts` | 2 |  |  |
| `src/engines/nba/prompt/run.ts` |  | 1 |  |
| `src/engines/needs/providers/spend.ts` |  | 2 |  |
| `src/engines/needs/row.ts` |  | 1 |  |
| `src/engines/needs/types.ts` |  | 1 |  |
| `src/engines/priority/estimate.ts` | 1 |  |  |
| `src/engines/priority/policy.ts` | 2 |  |  |
| `src/engines/priority/rank.ts` | 1 |  |  |
| `src/engines/priority/v2/compare.ts` | 2 |  |  |
| `src/engines/resolution/explain.ts` | 2 |  |  |
| `src/engines/resolution/pack.ts` | 1 | 3 |  |
| `src/engines/resolution/prompt.ts` | 1 |  |  |
| `src/engines/resolution/shadow.ts` |  | 1 |  |
| `src/engines/settle/load-db.ts` |  | 2 |  |
| `src/engines/settle/prompt.ts` | 1 |  |  |
| `src/engines/spend-audit/aggregate.ts` | 3 |  |  |
| `src/engines/still-needed.ts` | 2 |  |  |
| `src/engines/use-cases/confirm.ts` |  | 3 |  |
| `src/engines/use-cases/extract.ts` |  | 7 |  |
| `src/engines/use-cases/plan.ts` |  | 2 |  |
| `src/engines/use-cases/stage.ts` | 1 | 4 |  |
| `src/engines/vdp/assets.ts` |  | 2 |  |
| `src/engines/vdp/gaps.ts` | 1 |  |  |
| `src/engines/vdp/identity-judge.ts` |  | 1 |  |
| `src/engines/vdp/identity.ts` |  | 1 |  |
| `src/engines/vdp/steps.ts` | 2 |  |  |
| `src/engines/voice/build.ts` | 1 | 4 |  |
| `src/engines/voice/cli.ts` |  |  | 1 |
| `src/engines/voice/slack-search-parse.ts` |  | 1 |  |
| `src/engines/voice/synthesize.ts` | 1 |  |  |
| `src/jobs/handlers/account-hierarchy.ts` | 2 |  |  |
| `src/jobs/handlers/doctor.ts` |  | 2 |  |
| `src/jobs/handlers/forecast-sync.ts` |  | 1 |  |
| `src/jobs/handlers/kv-backfill.ts` |  | 1 |  |
| `src/jobs/handlers/org62-discover.ts` | 1 |  |  |
| `src/jobs/handlers/org62-readback.ts` | 1 | 2 |  |
| `src/jobs/handlers/resolution-check.ts` |  | 1 |  |
| `src/jobs/handlers/retention-tables.ts` | 1 |  |  |
| `src/jobs/handlers/vdp-specialist-aes.ts` | 1 |  |  |
| `src/jobs/queue-ops.ts` |  | 4 |  |
| `src/jobs/scan.ts` |  | 4 |  |
| `src/lib/accounts/hierarchy.ts` | 4 | 1 |  |
| `src/lib/actions.ts` |  | 1 |  |
| `src/lib/canvas/overrides.ts` | 1 |  |  |
| `src/lib/canvas/prefill.ts` | 1 |  |  |
| `src/lib/canvas/preflight.ts` | 1 | 2 |  |
| `src/lib/compose/html.ts` | 1 | 1 |  |
| `src/lib/compose/parse-slack.ts` |  | 1 |  |
| `src/lib/compose/source.ts` |  | 2 |  |
| `src/lib/deals-format.ts` | 2 |  |  |
| `src/lib/error-text.ts` |  | 3 |  |
| `src/lib/landings/model.ts` | 1 |  |  |
| `src/lib/landings/sync.ts` | 1 | 1 |  |
| `src/lib/ledger-hash.ts` | 1 |  |  |
| `src/lib/log.ts` |  | 1 |  |
| `src/lib/opp-options.ts` | 1 |  |  |
| `src/lib/pipeline-filter.ts` | 1 |  |  |
| `src/lib/private-scan.ts` | 2 | 1 |  |
| `src/lib/redact.ts` |  | 2 |  |
| `src/lib/time-suggest.ts` |  | 1 |  |
| `src/lib/vdp/company-name.ts` | 1 | 1 |  |
| `src/lib/vdp/payload.ts` | 1 |  |  |
| `src/llm/cc-tools/handlers.ts` | 1 | 6 |  |
| `src/llm/chat/fake.ts` | 2 | 4 | 7 |
| `src/llm/chat/tools.ts` | 1 | 7 |  |
| `src/llm/org62-rec.ts` |  | 3 |  |
| `src/llm/provider/agent-sdk.ts` | 1 |  |  |
| `src/llm/readin/map.ts` |  | 1 |  |
| `src/llm/readin/tools.ts` | 1 | 3 |  |
| `src/llm/research/tools.ts` | 2 | 4 |  |
| `src/llm/research/vdp-assets.ts` | 1 | 8 |  |
| `src/llm/skill-loader.ts` | 3 | 2 |  |
| `src/llm/skill-runner.ts` | 1 | 1 |  |
| `src/llm/slack-rec.ts` |  | 1 |  |
| `src/llm/spend/governor.ts` |  | 2 |  |
| `src/llm/spend/memory-store.ts` | 1 |  |  |
| `src/llm/tool-digest.ts` | 1 | 1 |  |
| `src/mock/chat-script.ts` |  | 1 |  |
| `src/mock/org62-opps.ts` | 3 |  |  |
| `src/mock/vdp.ts` | 4 |  |  |
| `src/ops/checks/budget.ts` | 1 |  |  |
| `src/ops/checks/db-cluster.ts` | 1 |  |  |
| `src/ops/checks/release.ts` |  | 1 |  |
| `src/ops/checks/state.ts` | 1 |  |  |
| `src/ops/crash.ts` |  | 1 |  |
| `src/outbox/adapters/release-handoff.ts` | 1 |  |  |
| `src/outbox/adapters/text.ts` | 1 |  |  |
| `src/outbox/adapters/vdp.ts` | 2 | 1 |  |
| `src/outbox/delivery.ts` | 1 | 1 |  |
| `src/outbox/errors.ts` |  | 2 |  |
| `src/outbox/transport.ts` | 2 |  |  |
| `src/projections/activity.plan.ts` | 1 | 2 |  |
| `src/projections/activity.ts` | 2 |  |  |
| `src/projections/calendar.ts` | 2 |  |  |
| `src/projections/links.ts` | 1 | 2 |  |
| `src/projections/missed.ts` | 1 |  |  |
| `src/projections/run.helpers.ts` | 2 |  |  |
| `src/projections/run.week.ts` | 1 |  |  |
| `src/projections/sessions.ts` |  | 1 |  |
| `src/projections/util.ts` | 1 | 4 |  |
| `src/scanner/completion/pass.ts` |  | 2 |  |
| `src/scanner/completion/prompt.ts` | 1 |  |  |
| `src/scanner/drive-digest/diff.ts` |  | 2 |  |
| `src/scanner/drive-digest/digest.ts` |  | 1 |  |
| `src/scanner/drive-digest/fetcher.ts` | 1 | 1 |  |
| `src/scanner/interpret/apply.ts` |  | 5 |  |
| `src/scanner/interpret/classify.ts` | 1 | 1 |  |
| `src/scanner/interpret/interpret.ts` |  | 2 |  |
| `src/scanner/interpret/org62-rules.ts` |  | 3 |  |
| `src/scanner/interpret/render.ts` | 1 |  |  |
| `src/scanner/interpret/runner.ts` |  | 1 |  |
| `src/scanner/interpret/schema.ts` | 1 |  |  |
| `src/scanner/interpret/units.ts` | 3 |  |  |
| `src/scanner/reconcile/reconciler.ts` | 2 | 6 |  |
| `src/scanner/runtime/scanner-runtime.jobs.ts` | 2 | 2 |  |
| `src/scanner/runtime/scanner-runtime.plan.ts` | 5 | 1 |  |
| `src/scanner/runtime/status-reason.ts` |  | 1 |  |
| `src/scanner/scope-catalog.ts` | 2 |  |  |
| `src/scanner/store-db.base.ts` |  | 2 |  |
| `src/scanner/store-db.finish.ts` |  | 4 |  |
| `src/scanner/store-db.items.ts` |  | 6 |  |
| `src/scanner/store-db.proposals.ts` | 1 | 14 |  |
| `src/scanner/store-db.shared.ts` | 2 | 1 |  |
| `src/scanner/store-memory.rows.ts` |  | 1 |  |
| `src/scanner/store-memory.runs.ts` |  | 4 |  |
| `src/scanner/store-memory.state.ts` | 1 |  |  |
| `src/scanner/store-memory.ts` |  | 1 |  |
| `src/scanner/trace/emit.ts` |  | 1 |  |
| `src/scanner/trace/queries.ts` |  | 5 | 3 |
| `src/scanner/triage/slack-triage.ts` | 1 |  |  |
| `src/server/calendar/detail.ts` |  | 1 |  |
| `src/server/chat/app-routes.ts` | 5 | 2 |  |
| `src/server/chat/changes.ts` | 1 | 1 |  |
| `src/server/chat/host.ts` |  | 2 |  |
| `src/server/chat/org62.ts` | 4 | 2 |  |
| `src/server/chat/outputs.ts` |  | 4 |  |
| `src/server/chat/read.ts` | 1 | 8 |  |
| `src/server/chat/record-type.ts` | 1 |  |  |
| `src/server/chat/research.ts` | 1 | 3 |  |
| `src/server/chat/turn.ts` |  | 1 |  |
| `src/server/chat/views.ts` |  |  | 12 |
| `src/server/datasource/activity-log.ts` | 3 |  |  |
| `src/server/datasource/db/attribution.ts` | 8 | 1 |  |
| `src/server/datasource/db/audit.ts` | 1 |  |  |
| `src/server/datasource/db/bootstrap.ts` | 5 |  |  |
| `src/server/datasource/db/chat-be6.reads.ts` | 2 | 1 |  |
| `src/server/datasource/db/chat-be6.shared.ts` |  | 2 |  |
| `src/server/datasource/db/chat-be6.ts` | 1 | 7 |  |
| `src/server/datasource/db/closure.ts` |  | 2 |  |
| `src/server/datasource/db/ctx.ts` | 1 |  |  |
| `src/server/datasource/db/domains/canvas.ts` | 2 | 4 |  |
| `src/server/datasource/db/domains/deals.ts` | 12 | 4 |  |
| `src/server/datasource/db/domains/drafts.ts` | 1 | 3 |  |
| `src/server/datasource/db/domains/engine.ts` | 1 |  |  |
| `src/server/datasource/db/domains/health.ts` | 3 |  |  |
| `src/server/datasource/db/domains/needs.ts` |  | 1 |  |
| `src/server/datasource/db/domains/settings.ts` | 1 |  |  |
| `src/server/datasource/db/domains/time.ts` | 3 | 1 |  |
| `src/server/datasource/db/domains/universal.ts` | 1 |  |  |
| `src/server/datasource/db/domains/vdp.ts` | 1 | 14 |  |
| `src/server/datasource/db/domains/work.ts` | 1 |  |  |
| `src/server/datasource/db/ids.ts` | 2 |  |  |
| `src/server/datasource/db/index.ts` |  | 1 |  |
| `src/server/datasource/db/needs-decisions.ts` |  | 1 |  |
| `src/server/datasource/db/needs.ts` | 1 |  |  |
| `src/server/datasource/db/onboarding.ts` | 2 |  |  |
| `src/server/datasource/db/priority.ts` | 2 |  |  |
| `src/server/datasource/db/quarter.ts` | 1 |  |  |
| `src/server/datasource/db/readin.ts` |  | 2 |  |
| `src/server/datasource/db/resolution.ts` |  | 1 |  |
| `src/server/datasource/db/seed.ts` | 2 |  |  |
| `src/server/datasource/db/spend.ts` | 1 | 1 |  |
| `src/server/datasource/db/store/agents.ts` |  | 1 |  |
| `src/server/datasource/db/store/dc-requests.ts` | 4 |  |  |
| `src/server/datasource/db/store/entities.ts` | 2 |  |  |
| `src/server/datasource/db/store/log-batch.ts` |  | 3 |  |
| `src/server/datasource/db/store/log-check.ts` | 1 | 1 |  |
| `src/server/datasource/db/store/misc.ts` |  | 2 |  |
| `src/server/datasource/db/store/projections.activity.ts` |  | 2 |  |
| `src/server/datasource/db/store/projections.run.ts` | 2 |  |  |
| `src/server/datasource/db/store/projections.ts` | 1 |  |  |
| `src/server/datasource/db/store/settings.ts` | 2 |  |  |
| `src/server/datasource/db/store/use-cases.ts` | 2 |  |  |
| `src/server/datasource/db/store/vdp-assets.ts` |  | 3 |  |
| `src/server/datasource/db/store/vdp-candidates.ts` |  | 1 |  |
| `src/server/datasource/db/store/withdraw.ts` |  | 1 |  |
| `src/server/datasource/db/store/work.load.ts` | 1 |  |  |
| `src/server/datasource/db/translate.ts` | 1 | 1 |  |
| `src/server/datasource/db/use-cases.ts` | 2 | 5 |  |
| `src/server/datasource/db/vdp-mirror.ts` | 1 |  |  |
| `src/server/datasource/draft-source.ts` | 1 |  |  |
| `src/server/datasource/log-canvases.ts` | 2 |  |  |
| `src/server/datasource/mock/attribution.ts` | 2 | 1 |  |
| `src/server/datasource/mock/chat-be6.ts` | 1 | 3 |  |
| `src/server/datasource/mock/domains/canvas.ts` | 2 | 4 |  |
| `src/server/datasource/mock/domains/chat.ts` |  | 2 |  |
| `src/server/datasource/mock/domains/deals.ts` | 3 | 5 |  |
| `src/server/datasource/mock/domains/feedback.ts` | 1 |  |  |
| `src/server/datasource/mock/domains/needs.ts` |  | 1 |  |
| `src/server/datasource/mock/domains/time.ts` | 3 |  |  |
| `src/server/datasource/mock/domains/vdp.ts` |  | 8 |  |
| `src/server/datasource/mock/forecast.ts` | 1 |  |  |
| `src/server/datasource/mock/index.ts` |  | 1 |  |
| `src/server/datasource/mock/outbox.ts` |  | 3 |  |
| `src/server/datasource/mock/seed-loader.ts` |  | 2 |  |
| `src/server/datasource/mock/use-cases.ts` | 1 | 3 |  |
| `src/server/datasource/time-ledger.ts` | 1 |  |  |
| `src/server/deals/dc-requests.ts` | 7 |  |  |
| `src/server/deals/needs.ts` |  | 1 |  |
| `src/server/deals/scope.ts` | 1 |  |  |
| `src/server/deals/use-cases.ts` | 1 |  |  |
| `src/server/feedback/agent.ts` |  | 2 |  |
| `src/server/feedback/channel.ts` |  | 1 |  |
| `src/server/feedback/diagnostics.ts` | 1 | 1 |  |
| `src/server/feedback/fallback.ts` |  | 9 |  |
| `src/server/feedback/format.ts` | 1 |  |  |
| `src/server/feedback/reads.ts` |  | 6 |  |
| `src/server/feedback/service.ts` | 4 | 2 |  |
| `src/server/forecast/draft.ts` | 1 | 11 |  |
| `src/server/forecast/soql.ts` |  | 1 |  |
| `src/server/forecast/store.ts` | 1 |  |  |
| `src/server/history/compose.ts` | 1 |  |  |
| `src/server/http.ts` |  | 2 |  |
| `src/server/hygiene/sweep.ts` |  | 5 |  |
| `src/server/landings/ops.ts` | 1 |  |  |
| `src/server/onboarding/identity.ts` | 2 |  |  |
| `src/server/time/canvas-preflight.ts` | 2 | 1 |  |
| `src/server/time/canvas-review.ts` | 1 |  |  |
| `src/server/time/relog.ts` |  | 1 |  |
| `src/server/vdp/autopilot.ts` |  | 1 |  |
| `src/server/vdp/coverage.ts` | 4 |  |  |
| `src/server/vdp/push.ts` |  | 7 |  |
| `src/server/vdp/specialist-aes.ts` | 5 |  |  |
| `src/server/views/drafts.ts` |  | 1 |  |
| `src/server/views/today.ts` |  | 1 |  |
| `src/tools/adapters/afd360-estimator.ts` |  | 1 |  |
| `src/tools/adapters/base.ts` | 2 | 2 |  |
| `src/tools/adapters/pulse-footprint.ts` | 1 | 2 |  |
| `src/tools/claude-launch.ts` | 1 | 3 |  |
| `src/tools/repo-resolver.ts` |  | 3 |  |
| `src/ui/PanelBoundary.tsx` |  | 1 |  |
| `src/ui/SideSheet.tsx` | 1 |  |  |
| `src/ui/format.ts` | 2 |  |  |
| `src/worker/index.ts` | 1 | 1 |  |
| `src/worker/scanning.ts` |  | 3 |  |
| `src/worker/schema-guard.ts` |  | 1 |  |
