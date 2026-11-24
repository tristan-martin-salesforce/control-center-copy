# Scanner stress campaign (STRESS-1, STRESS-2)

**Status:** STRESS-1 run on 2026-11-05/06 and STRESS-2 (Slack recall, first-scan budget, §5) on 2026-11-06, against real recorded days (2026-10-08 → 2026-11-05). This file is the **sanitized** summary: counts, rates and check names only, no content, names, accounts or ids. The detailed private report, recordings, answer keys and raw outputs live under `~/Library/Application Support/control-center/stress/` (chmod 700/600) and never enter git.

## 1. Method

1. **Live probes** (read-only, through the worker's own paths): Slack and Org62 through the Agent SDK child with the restricted single-server MCP config and reused OAuth; Google through the devbar client; Claude sessions from local files. All authenticated; no access blocker.
2. **Record once** (read-only, allowlisted tools only), as per-day supersets the replay filters:
   - Slack: the skill's query classes over each whole local day (S1 DMs to me, S2 @mentions, S3 my messages, C1 per channel), every page, plus detailed reads of the threads those messages belong to.
   - Org62: per-object supersets (opp teams, my accounts' opps, my Events, DCs, line items) with every field the skill selects or filters on.
   - Google: message ids per base query, full bodies, inbox threads; one wide Calendar dump; the Drive modifiedTime feed and current content of my files and every Gemini notes doc.
   - Claude sessions: an index of each transcript's line ends and timestamps.
3. **Replay** at the tool-call boundary. Slack and Org62 are in-process MCP servers that keep the real server and tool names, so the production allowlists, guards and skills run unchanged. Google keeps the real client (mutex, retries, classification) over a replay transport. Claude transcripts are grown to the simulated now. Any window or query is answered from the supersets. **Nothing newer than the simulated now is served** (checked on every response). A call the recordings cannot answer is a counted **miss** (a harness gap), never a pass.
4. **Simulated clock.** `stress.now()` shadows `pg_catalog.now()` through the scenario DB's search path, so the job queue's `run_at`, leases, backoff, the reaper and the scanner all see the same simulated time. Time flows at real speed during runs and fast-forwards when idle.
5. **Driver.** The production worker pieces (`DbScannerStore`, `buildLiveFetchers`, `buildScanning`, the job registry, `WorkerRuntime` claims/leases/reaper, the wake handler) over a cloned DB per scenario. The runner is either the real Haiku `AgentSdkSkillRunner` (spend ledgered and capped) or a scripted stand-in that follows the skill procedure through the same `cc` tool handlers (mechanics scenarios, no LLM cost). Kill and restart scenarios use a child-process worker.
6. **Answer key.** An independent Opus 5.5 pass per block of days sees only the rendered raw recordings and the extraction/linking rules copied from the skills, never the scanner's output.
7. **Invariants** (SQL after every scenario): no duplicate source items; the cursor never ahead of coverage; no coverage holes from the first scan to the cursor; cursors monotonic across steps; every job terminal (no orphaned leases, no unexpected dead jobs, no run left `running`); no source item is the origin of two items; evidence references valid; coverage never claims past its run window; head first then backfill oldest → newest; the coverage question is one query; no replay leaks; no non-allowlisted tool ever executed.

## 2. Findings

### 2.1 Bugs (fixed, each with a regression test on placeholder fixtures)

| ID | Severity | Area | Summary | Test |
|---|---|---|---|---|
| CAL-1 | critical | runtime / Calendar / Gemini | Snapshot fetchers ignored the per-run item limit. A first Calendar run handed 130+ events (about 200K tokens) to one Haiku run, which hit the cost cap. The runtime then split the time window, but snapshot fetchers ignore the window, so the split repeated down to 10-minute windows at about $0.10 a run. One stress cold start spent about $5.50; in production this burns the whole daily hard cap. Fix: Calendar and Gemini notes emit at most `limit` items (nearest to now, newest first). A deterministic cost-cap or tripwire failure now retries the same window with half the items (bounded) and never splits time. | `tests/stress/regressions.test.ts` (CAL-1 ×2) |
| CUR-1 | critical | runtime / deterministic skills | Deterministic fetcher cursors grow over time (Claude per-file offsets, Calendar and Drive state, Gmail seen ids). Once one passed `cc_finish`'s 200-character `cursor.value` limit, the agent (told to echo the header cursor unchanged) refused to shorten it and stopped without `cc_finish`. Every run of that scope then failed and its cursor never moved again: in a 3-day run, Claude sessions, Calendar, Gmail inbox and Gemini notes all stalled on day 1. The long cursor also appeared twice in the prompt and tripped Calendar's prefix tripwire. The worker already commits the fetcher's own cursor, so the fix hands the agent a short stand-in when the cursor is long. Found through a new diagnostic: a run that ends without `cc_finish` now records the agent's last reply (redacted). | `regressions.test.ts` (CUR-1) |
| THR-1 | critical | runtime / reconcile | A continuation that made no progress spawned another one over the same window. In a stale-item thread re-read, Haiku kept answering `complete=false` with the cursor at the window start, so one Slack thread was re-read 300+ times in a row in every multi-day run: about $1–2 per run (the largest single cost in the campaign). It also held the Slack connector lock, starving every other Slack scan behind it. Fix: a continuation whose cursor did not pass its window start ends the chain; the scope's next poll or reconcile re-plans the rest. | `regressions.test.ts` (THR-1) |
| S-1 | high | `scan-slack` skill | Channel scopes searched `in:<#ID>`. The Slack MCP search matches **nothing** for the id form (verified live), so every watched and customer channel scope scanned zero messages while recording full coverage. One watched channel held about 600 messages over the 29 recorded days. Fix: `scan-slack` 1.1.0 searches `in:#<name>` (`{{channel.label}}` is now the bare channel name), with a `slack_read_channel` fallback when no name is known. | `tests/stress/replay-slack.test.ts` |
| G-3 | high | prefetch / skill runner | 25 prefetched emails rendered as excerpt + snippet + body + full body (2000 chars each), about 60–85K tokens. The 32K prefix tripwire rejected every busy Gmail catch-up, forever. Fix: compact rendering (one body ≤ 1500 chars), a tripwire budget that includes the prefetched payload, and bounded item halving on a trip. | `regressions.test.ts` (G-3 ×2) |
| W-1 | high | worker / jobs / DataSource | The DB DataSource's Health **Rescan** (and the old chat-ops scan) enqueued `scan.<source>` with `{connectorId, scanRunId, scope}`, which the worker's scan handler dead-lettered as `bad_payload`, leaving its placeholder `scan_runs` row queued forever. `connector.reauth` had no handler at all. So an auth-paused connector could never be resumed from the app. Fix: `scanInternal` enqueues a real manual RuntimeJob linked to the placeholder by `job_id`, and the job's first run adopts the placeholder (one run, queued → running → done). Runs now record their `job_id`, which also lets chat's scan status find its run. Re-auth probes and retries until the re-auth completes. | `ui-jobs.test.ts`, `rescan-db.test.ts` (DataSource → worker → one finished run with items) |
| CONN-1 | high | scanner store / DataSource seed | The app seeds connectors with `name` = their label ("Gmail"); the scanner store looked them up by `name` = the connector id ("gmail"), found nothing and registered a second row of the same kind. In db mode Health's connector never showed scanner state (last success, cursor, failures), and a Health Rescan placeholder on the seeded row could never be adopted by the run. Fix: the kind's primary scanner connector adopts the app-seeded row (Trainings and Watch share a kind and keep their own). Existing duplicate rows are not merged. | `rescan-db.test.ts` (no extra connector row) |
| RS-1 | high | worker start | A cold start sets the cursor at now after its head run, so the lookback backfill lies behind the cursor. Worker start cancelled every queued plan job as "re-planned", but the new plan starts at the cursor, so a restart during the backfill lost those windows until the nightly, budget-gated reconcile (SIGKILL scenario: one hole in each of 3 scopes). Fix: queued backfill and continuation windows behind the cursor stay queued. | `ui-jobs.test.ts` (RS-1) |
| SLK-1 | high | Slack inbox / `scan-slack` | Block A scored Slack recall at about 23–32%. Busy 6 h morning backfill windows held 33–47 inbox messages; Haiku recorded direct DM asks and my own promises and then never triaged them (no item, no link), while runs of about 9 messages triaged fine. Fix: the inbox scope backfills in 2 h chunks (channels keep 6 h; manual rescans unchanged), and `scan-slack` 1.2.0 ends with an explicit triage pass (every DM/mention/own hit gets one outcome; a DM question to me is never noise; my promises are commitments). A/B on the same block: Slack recall about 30% → 55%, commitments 20% → 60%, precision 100% adjudicated, about +22% Slack cost. | `regressions.test.ts` (SLK-1); A/B in §4.2.1 |
| G-1 | high | Gmail / trainings fetchers | An incomplete run's cursor used the scope's latest seen epoch, not this window's progress. A past window with more than 25 unseen messages (a cold-start backfill after the head run, a reconcile re-scan) was truncated, and its coverage was still claimed. Fix: the cursor is this window's progress. | `regressions.test.ts` (G-1) |
| TRIP-1 | medium | skill runner | After CUR-1, Calendar still failed its prefix tripwire by 1–2 K tokens on every run: its fixed prefix (skill, bounded context pack, tool schemas) is about 34 K tokens with a real-sized context pack, over the 32 K base, and event JSON tokenizes at about 2.1 characters per token, not 2. Each trip cost a $0.004–0.006 first call plus a halved retry (16 failed runs in a 2.5 h live slice). Fix: 40 K base plus the payload at 1.8 characters per token; a real blow-up still trips. | `regressions.test.ts` (TRIP-1) |
| B-1 | medium | runtime catch-up | On a cold start, the head run initializes the cursor at now, so catch-up was released after the first hour while the 23-hour lookback backfill still ran ("catching up" and the re-rank hold lied). Fix: catch-up tracks its plan jobs (and their continuations and splits). | `regressions.test.ts` (B-1) |
| B-2 | medium | runtime | Backfill, continuation and targeted windows consumed while auth- or budget-paused were dropped. On a cold start they lie behind the cursor, so no later poll re-plans them (only the nightly 7-day reconcile, itself budget-gated). Fix: paused non-poll windows retry (+30 min for auth, the next budget day for budget). | `regressions.test.ts` (B-2) |
| C-1 | medium | stores (S8c) | An incomplete Slack run (S3 paged out) committed S1/S2's full-window coverage, which masked S3's unscanned tail. If the continuation was lost, the tail vanished from `coverageGaps`. Fix: incomplete runs clamp their time ranges to the cursor (both stores). | `tests/stress/coverage-clamp.test.ts` |
| F-1 | medium | runtime | A deterministic run whose agent stopped before `cc_finish` (seen with 25 emails) was retried unchanged until the scope's failure count abandoned it, leaving a hole behind a cold-start cursor. Fix: bounded item halving. | `regressions.test.ts` (F-1) |
| R-1 | medium | reconcile / Calendar | The listing compared each event's full end with ledger coverage that a scan clamps to its own window. Every multi-day or in-progress event was "uncovered" every night: targeted re-scans and coverage islands days back that then looked like holes. Fix: the Calendar listing is identity-only. | `regressions.test.ts` (R-1) |
| R-2 | medium | reconcile | Objects before a scope's first scan (beyond the initial lookback) or after its cursor (not yet polled) were flagged as missed: about 50 Health findings and jobs per run. Fix: only objects inside [first scan, cursor] count. | `regressions.test.ts` (R-2/R-3) |
| R-3 | medium | reconcile | One targeted job per uncovered object, each falling back to the whole week (up to 50 week-long re-scans, each re-linking the same items). Fix: one targeted job per scope, spanning the missed objects. | `regressions.test.ts` (R-2/R-3) |
| BUD-1 | medium | reconcile / budget | Reconcile's LLM passes (relinks, Sonnet escalation, skill-upgrade dry runs) ignored the daily hard cap. Fix: gated per connector. | `regressions.test.ts` (BUD-1) |
| CAD-1 | medium | runtime cadence | Off-hours ×6 multiplied with quiet backoff (×8) put a scope's next poll up to 2 days out: trainings and the missed-opportunity sweep went unpolled over a weekend. And any planned window over an hour (every off-hours poll) was planned as head + backfill, so connectors reported "catching up" all night. Fix: slow intervals are capped at max(base × scope, 4 h), and a poll the loop scheduled itself stays incremental unless the gap exceeds 1.5× the chosen interval. | `regressions.test.ts` (CAD-1 ×2) |
| LOOP-1 | medium | runtime | A scope that gave up on a window (a single item still over budget, or no automatic retry left) re-planned the same window from its unmoved cursor every 30 minutes, forever, at about $0.01–0.03 a cycle. Fix: back off 30 min, doubling about every 4 failures, capped at 6 h, reset by a success. | `regressions.test.ts` (LOOP-1) |
| W-3 | low | worker | A SIGKILLed worker left its in-flight `scan_runs` rows `running` forever. Fix: worker start closes them (single-instance lock). | `ui-jobs.test.ts` (W-3) |
| RE-1 | low | jobs | The re-evaluation job payload dropped `catchingUp` and `trigger`, so BE-3 could not hold re-ranks during catch-up. | `regressions.test.ts` (RE-1) |
| D-1 | low | jobs | With LLM linking off, each reconcile relink failed a run and bumped the connector's `consecutive_failures`, so healthy connectors looked failing. Now a no-op. | `regressions.test.ts` (D-1) |

### 2.2 Open (not fixed, with reason)

| ID | Severity | Summary | Why open |
|---|---|---|---|
| CU-1 | medium | Catch-up progress ("catching up: Slack 60%") exists only in the runtime and the heartbeat state. Nothing writes it to the `connectors` row or the UI's connector extension, so Health cannot show per-connector progress. | Needs a DataSource / contract decision (outside the scanner globs). |
| WATCH-1 | medium | `scan-watch` (channel briefs, R-UI-21) is not wired into the worker: `buildLiveFetchers` never builds the watch plan fetcher. Watched channels are still scanned for items by `scan-slack`. | Fixed 2026-11-11 for channel watches: `brief.generate` briefs them from what scan-slack stored (src/jobs/handlers/brief.ts, `tests/briefs/brief-generate-db.test.ts`). `scan-watch` stays unwired: a second read of the same channel is not needed. |
| ED-1 | low | Slack edits and deletes after a window was scanned are not detected (traversal sources have no reconcile listing; the `stale_active` thread re-read covers open items only). Late replies are found, because they carry a new ts. | Design: needs a cheap Slack listing or per-thread re-reads. |
| TR-1 | low | A trainings cold start with more notices than the per-run limit keeps the newest ones; the oldest are never processed. | Accepted trade-off (old notices are usually expired). Oldest-first was tried and lost the newest. |
| CMP-1 | high | Completion signals are almost never produced: 0–1 correct `completion` links per run, against 10–11 expected per block, and a promise kept two days later was linked as `progress`. Replaying the after runs through the closure engine auto-closes nothing, while the key has 8 items finished within the blocks. BE-3 (closure) depends on these signals. | **Addressed** by the completion pass ("model check per item", `docs/reference/SCANNER.md` §4.9): deterministic candidates, one cheap model call per batch, a precision gate, signals only. Measured in §4.6. `scan-slack` 1.2.0's explicit instruction had not moved it. |
| REC-1 | medium | The Slack traversal records only part of what it reads (55 / 126 / 61 messages on three runs of one replayed day). | **Fixed in STRESS-2 (§5):** the runner records every message the read tools return; 330–393 per miss-bank run, stable across reps. |
| ORG-1 | low | `scan-org62` pages with `LIMIT 200`. A 200-row Event page with the skill's fields is about 166K characters, which exceeds the CLI's MCP output cap (recording hit it). Windowed scans stay far below 200 rows. | No failure observed in windowed scans; recorded as a risk. |

## 3. What replay cannot time-travel (and how the harness handles it)

| Source | Limit | Handling |
|---|---|---|
| Slack | Messages are recorded per query class. A query shape outside the skill's classes, or a thread that was not recorded, cannot be answered. | Counted as a miss (`H2`), never a pass. Threads are recorded for replies and for my and my-mention top-level messages. |
| Slack | Edits and deletes are only as of recording time. | Scenarios inject edits, deletes and late replies as overlays with their own visibility time. |
| Calendar | Event state (responses, cancellations, attachments) is as of today. | Attachments whose Drive file did not exist yet at the simulated now are removed. |
| Drive | Only the current revision and modifiedTime exist. | A file modified after the simulated now is hidden (its earlier revision is unknown). Gemini notes docs show from creation (content written once). The answer key's Drive and Org62 refs that replay cannot show are excluded from scoring. |
| Drive | Spreadsheet metadata (`get_spreadsheet_info`) was not recorded. | A tracked spreadsheet's scan fails as a replay miss (`H2`, counted, never a pass). A Drive recall miss on such a file is adjudicated as a harness gap, not a scanner miss. |
| Org62 | Field values exist only as of today. | A row whose current SystemModstamp is after the simulated now is hidden. |
| Claude sessions | The live-process registry and desktop index are not replayed. | Transcripts (append-only) are grown to the simulated now: faithful. |
| LLM | Haiku runs live in every LLM scenario, so results vary between runs. | Measured by the variance scenario (same day 3× on 2 days). |

## 4. Results

### 4.1 Scenario matrix and invariants (final code)

Every scenario runs on its own cloned DB. "Checks" counts the invariants of §1.7 plus the scenario's own checks; *info* checks are reported, never failed. The mechanics, cold-start, live-slice and variance rows are from code with every fix in §2.1 that bears on them. The two accuracy runs predate SLK-1 and the THR-1 follow-up, whose effects are measured separately (§4.2.1, footnote ³).

| Scenario | What it does | Runner | Checks pass / fail / info | LLM cost |
|---|---|---|---|---|
| cold-slack | Slack alone, cold start on a busy Thursday 10:00 (head first, then the 24 h lookback oldest → newest) | Haiku | 13 / 0 / 2 | $0.22 |
| cold-org62 | Org62 alone, same cold start | Haiku | 13 / 0 / 2 | $0.06 |
| cold-gmail | Gmail alone, same cold start | Haiku | 13 / 0 / 2 | $0.03 |
| cold-calendar | Calendar alone, same cold start | Haiku | 13 / 0 / 2 | $0.04 |
| cold-gemini_notes | Gemini notes alone, same cold start | Haiku | 13 / 0 / 2 | $0.00 ¹ |
| cold-drive | Drive alone, same cold start | Haiku | 13 / 0 / 2 | $0.00 ¹ |
| cold-trainings | Trainings alone, same cold start | Haiku | 13 / 0 / 2 | $0.01 |
| cold-claude_sessions | Claude sessions alone, same cold start | Haiku | 13 / 0 / 2 | $0.06 |
| fri-mon-gap | All sources: Friday 15:00–18:00, laptop off all weekend, Monday 08:00 resume | scripted | 18 / 0 / 2 | — |
| pto | All sources: a 12.8-day break, then resume (backfill size, lookback caps, items that came due during the break) | scripted | 18 / 0 / 2 | — |
| lid-closed | A Slack traversal is mid-run when the lid closes for 3 h; on wake the lease has expired, the reaper requeues, the late completion is fenced out | scripted | 14 / 0 / 2 | — |
| multiday | All scanners, Friday 07:00 → Tuesday 18:00 at live cadence with off-hours ×6, across the DST change | scripted | 15 / 0 / 2 | — |
| sigkill | Child-process worker, SIGKILL mid-traversal and mid-backfill; cursors unmoved, re-run idempotent, no holes | scripted | 14 / 0 / 2 | — |
| restart-storm | 5 restarts in 10 simulated minutes (3× SIGTERM, 2× SIGKILL) during a catch-up | scripted | 17 / 0 / 2 | — |
| overlap | Claude file watch vs poll, `/rescan` during catch-up, reconcile during catch-up | scripted | 15 / 0 / 2 | — |
| late-arrivals | A reply on an old thread after the cursor passed, an edit and a delete of scanned messages, a mail with an old Date that arrives later | scripted | 14 / 0 / 2 | — |
| faults | Slack 429 / 5xx / timeouts, Google 429 / 5xx / slow / empty pages, then auth expiring mid-catch-up; recovery after re-auth | scripted | 14 / 0 / 2 | — |
| budget | Daily hard cap hit mid-catch-up: traversal pauses, deterministic fetches continue with linking deferred, everything resumes the next budget day | scripted | 16 / 0 / 2 | — |
| allowlist | A step instruction asks for a non-allowlisted tool: it never executes | Haiku | 10 / 0 / 4 ² | $0.04 |
| skill-bump | A day scanned with `scan-slack` 1.0.0, restart with 1.1.0: skill-upgrade reconcile writes a dry-run re-link diff | Haiku | 12 / 0 / 2 | $0.07 |
| closure-e2e | Seeded handed-off and done items get a direct ask and a new requirement: loop-back origin and contradiction, then the closure engine | Haiku | 13 / 0 / 2 | $0.06 |
| live-slice | All scanners, cold start at 07:00, then live cadence to 09:30 (steady-state cost) | Haiku | 12 / 0 / 2 | $0.98 |
| variance | The same day replayed 3× on 2 days, fresh DB each (§4.3) | Haiku | 2 / 0 / 0 + 6 runs' invariants all pass | $0.47 |
| acc-A-after | All scanners over block A, daily catch-up (§4.2) | Haiku | 11 / 0 / 3 | $1.60 |
| acc-B2-after | All scanners over block B2, daily catch-up (§4.2) | Haiku | 10 / 1 / 3 ³ | $2.06 |
| acc-A-slack ×4 | SLK-1 A/B, Slack only, block A (§4.2.1) | Haiku | 11 / 0 / 3 each | $3.53 |
| done-smoke | Slack inbox cold start with the CMP-1 completion pass and the real `reevaluate` job on: the pass sees the open items | Haiku | 12 / 0 / 3 | $0.08 |
| acc-A-done | All scanners over block A with the completion pass + `reevaluate` on (§4.6); resumed after a machine restart | Haiku | 11 / 0 / 3 | $2.05 ⁴ |
| acc-B2-done | Same over block B2 (§4.6); resumed after the restart | Haiku | 10 / 1 / 3 ⁵ | $3.13 ⁴ |

¹ Deterministic sources whose cold-start window held no new items make no LLM call.
² Haiku declined the injected instruction itself, so the abort path was not reached; the tool guard (`H3`, no non-allowlisted tool executed) held either way.
³ A coverage hole behind the cold-start cursor in Org62 events: a backfill continuation that made no progress was dropped (THR-1 follow-up, fixed after this run: one delayed retry, and reconcile looks 30 days back). The stalled window lies before the scored days.
⁴ Includes the first attempt, lost to the column-default clock bug (HARN-1, §4.6) and stopped after about 15 minutes, and the part of the second attempt done before the restart.
⁵ I3 again: one hole in `org62:events`, in the run killed by the machine restart and resumed. Unrelated to the completion pass; not investigated further.

Before the fixes, sigkill failed on orphaned `running` scan runs (W-3) and then on coverage holes after a restart during backfill (RS-1), restart-storm on W-3, cold-calendar on the CAL-1 cost runaway, and cold-gmail on runs ending without `cc_finish` plus a coverage hole (F-1, G-1). Failures in overlap, faults, allowlist, sigkill, restart-storm and closure-e2e that came from the harness itself (clock jumps, scenario ordering, check semantics) were fixed in the harness and are not counted as scanner bugs.

### 4.2 Accuracy against the independent answer key

All eight scanners, live Haiku, the worker opened once a day at 00:15 (a warm-up day, then one catch-up per block day), state carried across days. Block A is a busy Wednesday and Thursday (34 key items, 17 of them cross-source); block B2 is a Monday to Wednesday with a promise made on day 1 and completed on day 3 (20 key items, 9 cross-source). "Before" runs the scanner and skills as they were at the start of the campaign; "after" runs the fixed code. Disagreements were settled by hand: a key item that is not real work for me (a guess-level aside, or a mail that neither names nor addresses me) is a key error; a scanner item the key missed but that is real work counts as correct.

| Run | Key items | Scanner items | Recall (raw → adjudicated) | Precision (raw → adjudicated) | Cross-source linked |
|---|---|---|---|---|---|
| A, before | 33 | 8 | 27.3% → **30.0%** | 100% → 100% | 0 of 17 |
| A, after | 33 | 10 | 42.4% → **46.7%** | 100% → 100% | 5 of 17 (29%) |
| B2, after | 20 | 9 | 50.0% → **57.9%** | 88.9% → 100% | 4 of 9 (44%) |

Recall by source of the key item's origin (raw):

| Source | A before | A after | B2 after |
|---|---|---|---|
| Slack (22 / 22 / 14 items) | 27% | 23% | 50% |
| Gmail (7 / 7 / 3) | 0% | 71% | 0% |
| Calendar (1 / 1 / 0) | 0% | 100% | — |
| Gemini notes, incl. missed meetings (3 / 3 / 3) | 100% | 100% | 100% |
| Trainings (5 / 5 / 0) | 0% | 100% | — |

Recall by kind (raw): asks 8% → 15% (A) and 50% (B2); commitments 60% → 20% (A) and 0% (B2); follow-ups 50% → 75% and 67%; deliverables 67% throughout; trainings 0% → 100%. Precision by connector and kind was 100% everywhere except one Org62 task the key had missed (adjudicated correct).

Evidence roles (scanner vs key, after runs, A + B2): `origin` 25 correct, 2 misassigned, 39 missed; `context` 20 / 2 / 126; `progress` 4 / 4 / 57; **`completion` 0 correct / 1 misassigned / 21 missed**; `contradiction` 0 / 1 / 1. The promise made on day 1 of B2 and completed on day 3 was linked across days, but the completion message came in as `progress`, not `completion`.

What moved, and why:
- Gmail 0% → 71%, Calendar and Trainings 0% → 100% on block A: in the before run the prefix tripwire rejected nearly every run of those scopes (Calendar 53 failures and no successful run; Gmail inbox 47 failures, its cursor stuck at the start of day 1; Trainings 52), and Claude sessions failed on the tripwire and CUR-1 (fixed by G-3, TRIP-1, CUR-1).
- Cross-source linking 0 → 29–44%: the before run had too few items on other sources to link to.
- Slack stayed low on block A (23–27%). Root cause (SLK-1): busy 6 h inbox backfill windows held 33–47 messages, and Haiku recorded direct DM asks and my own promises but never triaged them (no item, no link); 8 of 17 Slack misses were not even recorded (REC-1). Fixed in the runtime (2 h inbox chunks) and in `scan-slack` 1.2.0 (an explicit triage pass); see 4.2.1.
- Completion is the weakest signal: in the closure engine replay (`closure-sim.ts`, what BE-3 would do with these signals), no item would auto-close, while the key has 8 items finished within the blocks. BE-3 will need completion evidence that the scanners mostly do not yet produce.

#### 4.2.1 SLK-1 A/B (Slack only, block A, 2 runs each)

Same block, Slack alone, two fresh runs per arm. "Base" is `scan-slack` 1.1.0 with 6 h inbox backfill chunks; "new" is 1.2.0 (triage pass) with 2 h chunks. Recall is over the 22 key items whose origin is a Slack message.

| Arm | Run | Slack recall | Items proposed | Asks | Commitments | Precision (raw → adjudicated) | Cost |
|---|---|---|---|---|---|---|---|
| base | 1 | 31.8% | 5 | 38% | 20% | 100% → 100% | $0.81 |
| base | 2 | 27.3% | 6 | 31% | 20% | 100% → 100% | $0.77 |
| **new** | 1 | **54.5%** | 17 | 62% | 60% | 94.1% → 100% | $0.97 |
| **new** | 2 | **54.5%** | 14 | 54% | 60% | 92.9% → 100% | $0.97 |

Slack recall roughly doubles (about 30% → 55%), commitments triple, at about 22% more cost. Each new run had one item the key did not have; both were direct asks of me (adjudicated correct). Completion links stayed near zero (0–1 per run): the triage wording asks for them, but it does not produce them reliably, so completion remains open (CMP-1).

Still missed after the fix (new run 1: 10 Slack items, 3 of them key errors): 8 of the 10 were recorded and then not proposed; 2 were never recorded (REC-1). The real misses are indirect asks (a pasted "write access not granted" error, "I'll create a PR you can merge"), an ask to present addressed to a group DM, a meeting takeaway in a group DM, one of my promises in a channel thread reply, and one direct question. In the base runs about half of the misses were never recorded.

### 4.3 Run-to-run variance (live Haiku, final code)

The same day replayed 3 times from a fresh DB (Slack inbox + Gmail, cold start, 24 h lookback), on a busy weekday and on a later weekday. $0.47 for all six runs.

| Day | Items proposed per run | Origin messages in all 3 runs | Pairwise Jaccard (origin messages) | Slack messages recorded per run (same replayed day) |
|---|---|---|---|---|
| Busy weekday | 5 / 1 / 4 | 1 of 8 | 0.29, 0.43, 0.17 | 61 / 126 / 55 |
| Later weekday | 2 / 1 / 3 | 1 of 4 | 0.50, 0.50, 0.25 | — |

By item rather than by origin message, agreement is higher: the one strong commitment on the later day appears in all three runs, and 4 of the 6 distinct items on the busy day appear in two of the three. Two variance sources remain. Haiku's propose-or-not judgement on borderline asks varies (run 2 of the busy day had no failures, recorded the most messages, and proposed one item). And the traversal records only part of what it reads: all three runs made 23–27 Slack calls returning similar volumes, but recorded 55–126 messages (open finding REC-1). Several runs also hit the 280 s run watchdog on this heavily loaded host (load average 130–200 from unrelated processes); the retries recovered and no invariant failed.

### 4.4 Cost (live Haiku 5.5, final code)

| What | Cost |
|---|---|
| Steady state, all scanners at live cadence (work hours) | about **$0.14 per hour** (63 scheduled polls in 1.4 h cost $0.20; Slack about $0.004 a poll) |
| Cold start, all scanners, 24 h lookback | $0.78 one-off |
| Daily catch-up after a day away (all scanners, after fixes; blocks A and B2) | $0.34–0.86 per day (busier days cost more) |
| Same before the fixes (block A, before tree) | $2.15 for the first two catch-ups, then about $1.30 an hour on the third, looping on THR-1, which never finished (stopped after 2.5 h) |
| Slack inbox with the SLK-1 fix | about +22% on Slack |

The cost leaks found (CAL-1, THR-1, LOOP-1, TRIP-1, CUR-1) each turned a bounded run into an unbounded loop or retry cascade. After the fixes no scenario showed a repeating run with no progress.

### 4.5 Campaign spend

$38.61 of the $50 cap, all LLM calls:

| Item | Cost |
|---|---|
| Scanner runs (Haiku) | $31.18 |
| Opus answer keys | $4.44 |
| Sonnet escalations | $1.97 |
| Recording | $1.01 |
| Probes | under $0.01 |

About $10 of the scanner spend went on the bugs themselves: the CAL-1 cold start ($5.6) and THR-1 thread loops ($4.2 across the before run and the first after-fix attempts).

### 4.6 Completion pass (CMP-1)

The completion pass (`docs/reference/SCANNER.md` §4.9) was measured on the same two blocks. `acc-A-done` and `acc-B2-done` replay all eight scanners at live Haiku, with the daily 00:15 catch-up as in §4.2, and with the completion pass and the real `reevaluate` job wired as the production worker wires them. A machine restart killed both runs in their last day. Each resumed on its own DB (`CC_STRESS_RESUME_AT`: a worker restart after a crash, so the reaper ran and stale plans were dropped). The live runs used `check-completion` 1.0.0. The skill was then revised on what they showed and measured over the two finished DBs, without re-running the scanners:
- `completion-replay.ts` runs the pass as a dry run at each moment the scenario's checks ran, seeing only what existed then. It ran twice per version.
- `completion-live-pass.ts` runs one real writing pass plus the `reevaluate` job.

**Scoring.** The key has 8 items finished inside each block. The scanner captured 5 of them in A and 6 in B2; an item that was never proposed cannot be closed. A completion link is **right** when its work item stands for a finished key item and the cited message is one of that item's completion refs, or another message of the same delivery (the same conversation, at or after the key's first completion). Disagreements were settled by hand:
- A message that finishes the item as titled counts as right. This includes a sub-task of a bigger key item, which gets no recall credit.
- An invite with the right people, sent before the message the key chose, counts as right.
- A message that finishes a *different* ask the scanner merged into the same item counts as wrong. So does an offer ("I can give an overview").

| Run | Skill | Completion links | Right | Wrong | Sure (auto-close): right / wrong | Finished key items found (of 8) | Of those the scanner captured |
|---|---|---|---|---|---|---|---|
| A, live | 1.0.0 | 2 | 1 | 1 | 0 / 0 | 2 | 2 of 5 |
| A, replay | 1.0.0 | 2 | 1 | 1 | 0 / 0 | 2 | 2 of 5 |
| A, replay ×2 | 1.2.0 | 2; 0 | 2; 0 | 0; 0 | 0 / 0 | 3; 0 | 3; 0 of 5 |
| A, real pass | 1.2.0 | 2 | 2 | 0 | 0 / 0 | 2 | 2 of 5 |
| B2, live | 1.0.0 | 1 | 1 | 0 | 0 / 0 | 1 | 1 of 6 |
| B2, replay | 1.0.0 | 3 | 2 | 1 | 0 / 0 | 1 | 1 of 6 |
| B2, replay ×2 | 1.2.0 | 4; 2 | 4; 2 | 0; 0 | 1 / 0 each | 1; 1 | 1; 1 of 6 |
| B2, real pass | 1.2.0 | 2 | 2 | 0 | 1 / 0 | 1 | 1 of 6 |

- **1.0.0:** 8 completion links, 5 right and 3 wrong. All were Likely ("Likely done · Confirm"), so nothing closed wrongly, but nothing auto-closed either.
- **1.2.0:** 12 completion links, all right. 3 were Sure, all right: **no wrong auto-close** in six runs.
- **Recall stays low:** 0–3 of 8 finished key items per run.
- **Progress links (partial):** 1–5 per run. They move an open item to in progress and never close anything. Most fall on key items before their completion, or on items outside the key.
- **Real path:** in the 1.0.0 live runs, the pass moved 3 items to likely done (2 right, 1 wrong: the merged item) and auto-closed none. In the 1.2.0 real pass on B2, `reevaluate` closed 1 item as done (right), and it appears in "Closed for you" (statement Q6) with its Undo change set. On A, it moved 1 more item to likely done (right) and 1 to in progress.

**Why 1.0.0 → 1.2.0.**
1. Haiku 5.5's stated confidence tops out around 0.85, so 1.0.0's 0.9 Sure gate never fired.
2. Judging against the first ask let a message that finished another ask of the same person mark a merged item done, twice in A.
3. An offer was taken as done in B2.

1.2.0 makes four changes:
- it first names the one outcome the title needs;
- it answers a categorical basis (`delivered` / `confirmed` / `done_by_other` / `pointer` / `partial` / `none`);
- offers count as promises;
- it runs at medium effort.

The gate's calibration now lives in the skill's frontmatter. Sure needs basis `delivered`, confidence ≥ 0.8, a message by me, and a strong tie.

**What the misses are**, in roughly this order:
1. The scanner never proposed the item: 3 of 8 in A, 2 of 8 in B2.
2. The scanner merged several asks into one item, so the title no longer names the finished one.
3. Haiku judged a terse delivery partial or not done: a message pointing to an attachment the excerpt does not show, or a bare link to a thread. Its verdict also varies between runs on the same input: A gave 2 completions and then 0 in two 1.2.0 replays.
4. The completion message was never recorded (REC-1).

Raising recall needs better items from the scanner more than a different pass.

**Cost.** In the live runs the pass cost $0.029 for A (3 catch-up days, 76 checks, 33 model calls) and $0.024 for B2 (4 days, 95 checks, 27 calls):
- per scan run: $0.0001 (A, 281 runs) and $0.00006 (B2, 405 runs);
- per scan run that stored items: $0.0002–0.0004;
- per day: $0.000–0.018, about $0.008 on average.

Most checks make no call: in A, at least 43 of 76 checks made none. A call costs about $0.0008–0.0009, and 1.2.0 at medium effort costs the same within noise. Next to the daily scanning catch-up ($0.34–0.86 per day, §4.4), the pass adds about 1–2%.

**Spend.** $5.47 of the lane's $10 cap:

| Item | Cost |
|---|---|
| Scanner replays (A $2.05, B2 $3.13), including about $0.85 lost to the restart and to the HARN-1 attempt | $5.18 |
| Completion-pass model calls (the live runs' checks, 8 replays, 2 real passes) | $0.27 |
| Smoke run | $0.08 |
| Probe | under $0.01 |

**Harness finding HARN-1 (fixed).** Migrations bind every `now()` column default to `pg_catalog.now()` when the table is created, out of reach of the search path. So in scenario DBs, `created_at`, `first_seen_at`, `status_changed_at` and every other defaulted timestamp were **real** time, while every query ran in simulated time. The scanner store sets its own times where it compares them; the completion pass was the first reader that orders by arrival, and in replay it saw no open items at all. The clock schema now points every `now()` default at `stress.now()` (`tests/stress/sim-clock.test.ts`).

## 5. STRESS-2: Slack recall, first-scan lookback and go-live fixes

### 5.1 What changed

| ID | Change | Where |
|---|---|---|
| REC-1 | The runner records every Slack message the traversal's searches, thread reads and channel reads return, from the tool result: a PostToolUse hook, plus a stream fallback. It dedupes by channel + ts, before the model sees the result. Thread and channel reads are forced to the detailed format, because the concise one has no ts. Agents cite messages as `<channel>:<ts>` and no longer transcribe them. | `src/llm/slack-rec.ts`, `src/connectors/slack/parse.ts`, scan-slack 1.3.x |
| Triage | After a successful Slack traversal, Haiku gives every message to or from me, or in a DM, group DM or thread I'm in, one verdict: act, noise or unsure. Messages go in batches of 10, grouped by conversation. The checklist and placeholder examples come from the real misses. | `src/scanner/triage/slack-triage.ts`, `skills/triage-slack.md` 1.2.0 |
| Escalation | `unsure` lines, and lines with no verdict, go to Sonnet for a final act or noise. With escalation off, they are flagged unlinked. | same |
| TRI-1 | Triage 1.0.0 lifted recall but proposed asks addressed to someone else. REC-1 had marked every group-DM message "to me". Now a group-DM message is to me only when it @-mentions me. Each line carries its addressee. The skills add an addressee-first rule and noise rules for pings, logistics, favors, agenda lines and live meeting chatter. | slack-rec, triage-slack 1.1.0 → 1.2.0, scan-slack 1.3.1 → 1.3.2 |
| SET-1 | The scanner reads the app's settings keys (`settings.budgets`, `settings.profile`), so Settings edits reach the worker. An `llm_budgets` row lowers the hard cap only when it is a hard stop. Bootstrap writes an alert-only row at the soft budget. | `src/scanner/store-db.ts`, `src/worker/scanning.ts` |
| RS-2 | Health Rescan of Trainings and Watch targets those connectors, not the Gmail or Slack inbox. Watch has no worker spec yet, so its Rescan is cancelled as "no scanner". | `src/server/datasource/db/index.ts` |
| SDK-1 | The `canUseTool` gate enforces the scanner allowlist. Bare `allowedTools` entries and a hook `allow` skipped it (SDK warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). | `src/llm/skill-runner.ts` |
| B-084 | Connector rows carry the contract's error classes (`config` → `bug`, `unknown` → `transient`), and the probe's re-auth affordance in `config.reauth`. | `src/scanner/store-db.ts` |
| B-080 | First-scan lookback setting, default 30 days, with a one-time backfill budget that is a ceiling (default $100). The backfill runs oldest first, with no head hour (FS-ORDER, SCANNER.md §5). | `src/scanner/runtime/first-scan.ts`, the runtime and planner |

Each change has a test on placeholder fixtures: `tests/stress/rec1-triage.test.ts`, `first-scan.test.ts`, `settings-rescan-db.test.ts`, and updated be2a runner tests.

### 5.2 Miss bank (targeted replays, cents per variant)

Built from the recordings and the Opus answer keys for blocks A and B2:
- 38 cases: every Slack-origin key item (10 SLK-1 misses, 6 flaky, 16 hits), the 2 items the key lacked that were ruled real, and 4 **hard controls**. Hard controls are guesses the key wrongly listed, and they must stay noise.
- 190 plain controls: qualifying messages that no key item cites.
- 20 scanner windows: inbox 2 h slots and channel 6 h slots, over 6 days. Each (variant, run, day) gets a fresh DB, and its windows run as backfill jobs through the production runtime.

A case passes when a scanner item has non-context evidence on one of its refs. A control fails when it is evidence of a false item. Item precision counts an item built only on a hard control as a false positive. New items were adjudicated one by one, privately.

Skills 1.1.0 (triage-slack) and 1.3.1 (scan-slack), 3 runs per variant:

| Variant | Case recall (3 runs) | Control precision | Item precision (adjudicated, strict) | Cost per bank run |
|---|---|---|---|---|
| REC-1 alone | 52.9 / 58.8 / 64.7% | 99.5 / 99.5 / 100% | 95.5 / 96.0 / 100% | $0.14 |
| REC-1 + triage | 91.2 / 85.3 / 85.3% | 99.5 / 97.9 / 97.9% | 97.6 / 92.9 / 92.1% | $0.26 |
| **REC-1 + triage + escalation** | **94.1 / 97.1 / 88.2%** | 98.4 / 98.4 / 97.9% | 93.6 / 93.3 / 92.7% | $0.48 |

One run with triage-slack 1.2.0 and scan-slack 1.3.2 (live-meeting chatter and others' status counted as noise): triage gave 88.2% recall at 90.7% precision; triage + escalation gave 91.2% recall at 95.7% precision.

Findings:
- **REC-1 alone does not raise recall.** About 59%, the SLK-1 level. It makes recording complete and stable: 330–393 messages per run, against 55–126 on one day before.
- **The triage pass carries the gain.** All 10 SLK-1 misses pass in most runs. Sonnet escalation adds about 6 points: 4–8 escalated messages per bank run, at about $0.03 each.
- **Precision is not 100%.** There are 1–3 false items per run of about 40. The ones left are mostly the hard controls ("we can loop PERSON in", "maybe we should…", a reshare). A few are live-meeting chatter or someone else's promise.
- **Triage 1.0.0 had a precision bug** (TRI-1): 10 false items in one run. Fixed before the runs above.

**Key correction and new rules (triage-slack 1.3.0, scan-slack 1.4.0; SCANNER.md §4.11).** One block-A key item had an unaddressed group-DM follow-on in two other people's exchange as its origin (worked example T3 taught the same mistake). Its private key entry and bank case now cite the later hand-over message, which names me, as the origin, and the follow-on as context. The new rules have placeholder cases in `tests/stress/rec1-triage.test.ts` (TRI-2 continuation both ways, TRI-3 group asks, TRI-CTX earlier lines, TRI-NOISE carried verdicts) and `tests/stress/scanner-noise.test.ts`. The live bank has not been rerun with them (it spends live Haiku and Sonnet, about $0.5 per run).

### 5.3 Confirmation: Slack-only replays of blocks A and B2

REC-1 + triage + escalation, skills 1.1.0 / 1.3.1, the same daily 00:15 catch-up as SLK-1. **One run per block** (cut from two at Tristan's request): the miss bank already measures run-to-run variance. Recall counts key items whose origin is a Slack message. "Adjudicated" leaves the key's errors out of the denominator, counts as found the items the key lacked that were ruled real, and counts proposed key errors as false positives.

| Block | Run | Slack recall raw | Slack recall adjudicated | Slack precision adjudicated | Items | Cost per Slack day | Invariants |
|---|---|---|---|---|---|---|---|
| A | SLK-1 (scan-slack 1.2.0), 2 runs | 54.5% | 65% | 100% | 14–17 | $0.32 | pass |
| **A** | STRESS-2 | **90.9%** | **100%** | 96.2% (one key error proposed) | 26 | $0.57 | all pass |
| B2 | B2-after (STRESS-1, all sources, 6 h inbox chunks) | 50% | — | — | — | — | pass |
| **B2** | STRESS-2 | **92.9%** | **100%** | 95.2% (someone else's promise) | 21 | $0.40 | all pass |

- Every Slack key item missed was one the key itself had wrong: 2 in A, 1 in B2. New items the key lacked were ruled real: one in A (a direct technical question) and two in B2 (a direct readiness question, and a tagged ask to help prepare a production run).
- **Cost per Slack day.** A: traversal $0.26, triage $0.06, escalation $0.26. B2: $0.25, $0.03 and $0.11. Without escalation it would be about $0.28–0.31. Escalations: 5 per day in A (a busy block) and 1.75 per day in B2.
- **Harness gap.** 26 and 34 thread reads asked for threads the recordings do not hold, and the tool returned an error (a replay miss). The live tool would answer, so recall in live use can only be higher.

### 5.4 Run time

The average Slack run, including the triage and escalation passes, took 46 s (p90 63–101 s) on a loaded machine. Slack runs one job at a time per connector.

### 5.5 First-scan lookback and budget (B-080)

- **Default and setting.** The worker's first scan covers **30 days** by default, changed with `CC_FIRST_SCAN_LOOKBACK_DAYS` or `--lookback-days` (`0` = off). Onboarding (B-079) will offer the choices below.
- **Budget.** A one-time ceiling, `CC_FIRST_SCAN_BUDGET_USD` (default $100). First-scan spend skips the daily cap and does not count against it. The budget ends when every planned scope is done, or when it is spent; the rest then continues under the daily cap.
- **Planning.** The backfill runs oldest first with no head hour (FS-ORDER; it ran newest first before) and lifts the 14-day planner cap, so a 30-day setting plans 30 days of windows (tested).
- **Chunks and lookbacks.** Slack channels use 24 h chunks during the first scan. Org62 keeps its own 30 days at shorter settings.

Estimated cost per choice, from the per-day numbers above, scaled to an average recorded day. Gmail, Gemini notes and Org62 per-day costs come from the STRESS-1 all-source runs, and Org62 is never less than 30 days. Claude sessions are not part of the first scan. Calendar joined it after go-live (FS-CAL-1, SCANNER §5.6): its history is record-only, so it adds listing calls and no model cost.

| First scan | Estimated cost | Slack runs | Slack wall time (one at a time) |
|---|---|---|---|
| 7 days | $3.40–5.00 | 140 | about 2 h |
| 14 days | $6.30–9.10 | 280 | about 3.5 h |
| **30 days (default)** | **$13–19** | 600 | **about 8 h** |
| 90 days | $39–56 | 1,800 | about 23 h |

Every choice fits the $100 ceiling. For a 90-day scan, Slack wall time is the limit, not money; the other connectors run in parallel within the 3 LLM slots.

### 5.6 Open after STRESS-2

| ID | Severity | Summary |
|---|---|---|
| PREC-1 | medium | Slack precision is 92–97% with triage (target 100%). What is left is guess-level asides proposed as items ("we can loop PERSON in", "maybe we should…"), a reshare, someone else's promise in a group DM, and live-meeting chatter. The next lever is making triage propose weak items as `guess`, so they land in the Triage review queue, not on the list; today the pass mostly says `likely`. |
| TRI-2 | low | The addressee rule costs a group ask to everyone ("guys, what's the effort to…") and an ask whose only @-mention is a trailing one to someone else. |
| REC-2 | medium | REC-1 covers Slack only. Org62 pages are still recorded by the agent; the ORG62 lane saw a continuation store 156 of 207 events. The same record-from-tool-result pattern, or a row-count check, applies. |
| CMP-1 | high | The completion pass (§4.6, the DONE-CHECK lane) has 100% completion precision, but recall is 0–3 of 8 finished items per block. REC-1 should help with completion messages that were never recorded. Not measured with REC-1: it needs full all-source replays (about 3 h, about $8–10), skipped at Tristan's call. Best measured on the first real 30-day scan. |
| WATCH-1 | medium | Channel watches are briefed by `brief.generate` since 2026-11-11 (a watch added on 2026-11-09 had produced no brief: the job was a stub and its schedule disabled). scan-watch itself is still not wired, and its Rescan is cancelled instead of misfiring. Opp, account, person and search watches have no brief yet. |
| SOQL-1 | low | The stress SOQL replay cannot answer the ORG62 lane's new `book` / `missed_opps` queries (GROUP BY, sub-selects). The STRESS-2 replays were Slack-only. |

### 5.7 STRESS-2 spend

**$7.77 of the $25 cap.** The miss bank cost $4.30: all variants, the 1.0.0 → 1.2.0 iterations, and the runs lost to the restart. The two confirmation replays cost $3.30, and the stopped second pair $0.16. The gate check cost $0.01.

By model:

| Model | Cost |
|---|---|
| Haiku traversal | $3.83 |
| Haiku triage | $1.68 |
| Sonnet escalation | $2.25 |
