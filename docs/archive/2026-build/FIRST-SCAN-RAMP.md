# First-scan ramp (staged first scans on a fresh database)

**Status:** running, 2026-11-06. Stage 1 (1 day) passed on attempt 9; stage 2 (2 days) passed; stage 3 (7 days) passed; stage 4 (14 days) passed; the full stage (30 days, Slack and Gmail inbox 90) passed its scan, with GEM-2 found after and fixed. Final report: section 6. Owner: the first-scan session. Placeholders only: no names, accounts, ids or message text.
Real-data details for each entry live in the private stress folder
(`~/Library/Application Support/control-center/stress/first-scan-ramp-private.md`, mode 600), never in git.

## 1. Method

Each stage proves the first scan from scratch, as a new user would run it, on the real path (the live database, the
production worker, the real connectors with read tools only):

1. Stop the worker. Drop, create and migrate `control_center`, then `npm run db:bootstrap` from `profile.json`. Only the
   bootstrap rows remain (user, me, identities, settings, policy, `cc.meta`). The fetchers' local caches
   (`first-scan.json`, Drive digests, Claude-session offsets, notification state) are moved aside, never deleted.
2. Set `CC_FIRST_SCAN_LOOKBACK_DAYS` (and, for the full stage, `CC_FIRST_SCAN_SCOPE_DAYS`) in the env file, then start
   the worker with `npm run ops:install -- --yes --only worker`.
3. Watch it to the end of the first scan, then verify:
   - no coverage holes in any scope, from its floor to its cursor;
   - no failed runs (cancellations from a shutdown are fine) and no dead jobs;
   - items by source and kind, and sane projections (meetings, deals, time blocks, sessions);
   - about 15 items read against their evidence;
   - what done detection closed or marked likely done, and whether that was right;
   - cost per source and wall time;
   - Health: every source Live, with plain reasons;
   - the pages render (Home, Today, Triage, Work, Deals, Time, History, Health).
4. A **major** issue (a stage's pass criteria, lost or duplicated data, runaway cost, a page wrong at a glance) is fixed
   with a test, merged, and the ramp starts again at 1 day. A **minor** one goes in the list below and the ramp goes on.

Stages: 1 day, 2 days, 7 days, 14 days, then full (30 days, the Slack inbox and Gmail inbox 90). Budget: $100 across all
stages and restarts.

## 2. Stage results

| Stage | Attempt | Result | Wall time | Cost | Notes |
|---|---|---|---|---|---|
| 1 day | 1 | fail | 20 min (stopped) | $1.33 | ORG-2, FS-3 (major); TRAIN-1, STAT-2 fixed on the way |
| 1 day | 2 | fail | 38 min (stopped) | $1.56 | ORG-3 (major): three quiet Org62 `opps` weeks left as holes. Every other scope clean: 0 failed runs, all sources Live. |
| 1 day | 3 | fail | 38 min (stopped) | $1.16 | ORG-3b (major): one 6-row `opps` week still incomplete (an extra paging query without a LIMIT). ORG-3 fixed the other quiet weeks. Everything else clean. |
| 1 day | 4 | fail | 61 min (stopped) | $1.55 | ORG-4 (major, open): the newest Org62 `opps` week stayed a hole. Q2 (opps on my accounts) has 1,098 changed rows that week (134 the week before), and both runs recorded 50 rows and finished incomplete with the cursor at the window start. Every other scope was clean. Two failed runs, both recovered: MIN-13 (a stall) and a cost-cap split. LD-1 was built during this attempt. |
| 1 day | 5 | fail | 7 min (stopped) | $0.52 | Run on the traced AUDIT worker to reproduce ORG-4: the newest `opps` week failed the same way and its trace gave the cause. Stopped right away to ship the fix. |
| 1 day | 6 | fail | 6 min (stopped) | $0.34 | ORG-4's fix worked: both opps queries came back whole (50 rows each). Then ORG-5: the agent recorded none of the 100 rows, reported zero-width coverage and finished incomplete at the window start again. Stopped to build REC-2. |
| 1 day | 7 | fail | 5 min (stopped) | $0.30 | ORG-6 (major, silent): in mode `backfill` the agent applied the unwindowed skip (§3) to `opps`. It made no Org62 query, reported `soql:org62:opps:skipped` over the newest week and finished complete, so 1,148 changed rows would have counted as read. `events` and `dcs` queried normally. REC-2 was not exercised. |
| 1 day | 8 | pass (scan); Deals major | 18 min | $1.19 | Every scope done with 0 holes, 0 failed runs, 0 dead jobs, every source Live. REC-2 on the newest opps week: 150 rows parsed, 150 recorded, cursor on the last row read, then about 10 continuations through the 1,148 changes. Pages render with no scroll at 1920×1000, but **Deals was wrong at a glance** (DEALS-1): it counted every opp on my accounts. DONE-1 fixed between stages. Stage 1 runs once more to check Deals. |
| 1 day | 9 | **pass** | 17 min | $1.04 | Run again after DEALS-1. 11/11 scopes done, 0 holes, 0 failed runs, 0 dead jobs, every source Live. Deals: "51 open opps on 30 accounts · $50M", 2 real DC gaps, close dates ahead, accounts "DC assigned". Every page renders with no scroll and no page errors. "0h this quarter" is real: Org62 has no Events of mine since the fiscal quarter began (Nov 1). |
| 2 days | 1 | **pass** | 23 min | $2.58 | 11/11 scopes done, 0 holes, 0 failed runs, 0 dead jobs, every source Live. 30 items, done and likely done read right (2 closures by the asker, 3 by my delivery). Deals unchanged: 51 open opps on 30 accounts. Read-ins (Sonnet) were $1.63 of the $2.58, all inside their $2/day cap. Fixed between stages: REC-2b (an empty next page ended no query, so a complete run got a needless continuation) and DONE-2 (writer prefixes in done reasons). ORG-7 (Q2 ran before the book's accounts) raised to major and fixed before stage 3. |
| 7 days | 1 | **pass** | 54 min | $4.42 | 11/11 scopes done, 0 holes, 0 failed runs, 0 dead jobs, every source Live, no Health events. ORG-7 held `opps` 4 times ("waiting for org62:book", the job read as skipped and Org62 stayed Live), then its Q2 read every projected account: 1,409 opps, the newest week over 9 continuations. Cost: scan $2.54 (Slack $1.61, Org62 $0.45, Gmail $0.16, Gemini notes $0.14, Claude sessions $0.13, Calendar $0.05) plus read-ins $1.88. 74 items; done reasons read cleanly (DONE-2); 12 in Looks done. Deals unchanged (51 opps). Q4 hours still 0 (no Events since Nov 1). Every page renders with no scroll. Recorded as `FIRST_SCAN_COST.measured[7]`. |
| 14 days | 1 | **pass** (scan); Home major fixed | 114 min | $7.18 | 11/11 scopes done, 0 holes, 0 failed runs, 0 dead jobs, every source Live, no Health events. Cost: scan $5.15 (Slack $3.66, Org62 $0.50, Gemini notes $0.46, Gmail $0.27, Claude sessions $0.20, Calendar $0.07) plus read-ins $2.03. 91 items, 18 in Looks done, none starting "My" (LD-1c live). Deals unchanged; Q4 hours still 0. Recorded as `FIRST_SCAN_COST.measured[14]`. **Home was wrong at a glance** (HOME-1): Do now read "Nothing else needs you now" over 29 open replies. Fixed and checked on this stage's data. HOME-2 also fixed. |
| full (30 d; Slack and Gmail inbox 90 d) | 1 | **pass** (scan) with one major found after (GEM-2) | 470 min | $28.89 raw | 11/11 scopes done, 0 holes, 0 dead jobs. 40 failed runs, all retried: 33 MIN-25 cost-cap splits (Gemini notes 32 at $2.07, Gmail 1 at $0.07), each window recommitted by its retry, and 7 upstream or watchdog blips. BUD-1 held: daily spend $2.28 on Nov 6 and $3.02 on Nov 7, under the $5 soft cap, while $23.60 of first-scan spend stayed off it. HOME-1b ranked once, 34 s after the first scan finished. Cost: Slack $18.59 (30-day part $8.86, 31–90 days $9.47), Gemini notes $3.07 ($1.00 net), Gmail $1.79, Claude sessions $0.86, Org62 $0.54, Calendar $0.13, Drive $0.02, read-ins $3.90 (two days). About 500 items: 81 in Looks done, Reply & approve 152, Triage 102; 51% of open items come from messages older than 30 days (DEEP-1). Deals unchanged (51 opps). Q4 hours still 0. Pages render with no scroll, but take about 4 s to load (PERF-1). **GEM-2**: Gemini notes of meetings before about Oct 24 were never recorded. |

## 3. Major issues fixed during the ramp

| ID | What | Fix |
|---|---|---|
| ORG-2 | A bulk-logged week of Org62 Events (two pages of 50 rows, transcribed by the agent at about 3.6 s a row) hit the runner's 3-minute watchdog on every retry, so the window never finished. | Paged Org62 scopes get an 8-minute watchdog (`timeoutMs` per spec). |
| FS-3 | The first-scan hole check counted time past the cursor (not polled yet) as holes. Slow-polling scopes (Org62, every 30 min) used their re-plan rounds for nothing and stayed pending. | Holes count from the floor to the cursor only. |
| TRAIN-1 | Trainings looks back 120 days on its first run, so a 1-day first scan put a weeks-old IT notice at the top of Do now as overdue. | A training first seen two weeks past its due date, from a notice that old, lands in Triage ("still needed?"). |
| STAT-2 | A watchdog timeout showed as "temporarily unavailable". | "a run took longer than its time limit". |
| ORG-3b | ORG-3's page observer treated a query without a LIMIT (an extra paging query the agent wrote) as paged, so one quiet week still ended incomplete. | Without a LIMIT, the SOQL result's own `done` flag decides. |
| ORG-7 | (was MIN-17, raised to major: a silent coverage gap every new user's first scan races into, and it would undercount the measured onboarding cost.) In stage 2 the newest week's Q2 (opps on my accounts) ran before the book read had projected the accounts. It listed 2 account ids of 37 and returned 24 rows, yet the window counted as covered for every account. | In the first scan, `org62:opps` is **held** (no run, back in a minute, not counted as an attempt) until `org62:book` is done and its accounts are projected. It waits 5 more minutes at most for a user with no accounts, and never past 30 minutes from the first scan's start. Q2's coverage meta now names the account count it read (`accounts: N`), so a trace shows it. |
| HOME-1 | On a 14-day first scan, Home's Do now showed only the Outbox card and "Nothing else needs you now" twice, while Reply & approve held 29 items, several overdue. Nothing ranks work after a scan (ranking runs on Today's re-rank, a chat or policy change, or `db:seed`), so on a fresh database no item had a rank. Home's fill took "the next ranked work" only, while Today falls back to due date and age. | Home's fill takes live work the ranker has not ranked yet after the ranked work, by due date (overdue first), as Today's fallback does. On the stage-4 data Do now shows the Outbox plus the two most overdue items. Test: `tests/home/build.test.ts` HOME-1. |
| BUD-1 | First-scan spend counted as today's **daily** spend everywhere except the scanner's own gate. The store's `budgetStatus`, Health's spend, the read-in and chat gates and the daily roll-up summed every `llm_calls` row of the day. After stage 4, $7.24 read "of $5 today" (soft alert). The full stage ($22–30) would cross the $15 hard cap on its first day: "Spend cap reached", Health's false "Scanners run deterministic-only until tomorrow", the completion pass stopped, chat refused. | Every daily reader counts `budget = 'daily'` only: `budgetStatus` (scanner and completion gates), Health spend (sidebar, header, chart), the read-in and chat gates, and the `llm_budget_days` roll-up (Q15, doctor). The one-time spend stays on Health's First scan card. The runtime no longer subtracts first-scan spend itself (that would now subtract twice). The in-memory store tags each call with its job's budget too. Tests: a $20 first-scan call leaves the daily state, read-in total and roll-up untouched; a $16 daily call still caps, and a daily job then pauses. |
| HOME-1b | Root of HOME-1: nothing ranks or estimates after a first scan (every open item had rank null, no NBA, effort 0/0). | The worker ranks once when the first scan completes, with the deterministic priority engine (no LLM, no cost), only if nothing was ever ranked and there is rankable work (`src/worker/first-scan-rerank.ts`, idempotent: a restart or the user's own ranking means no second run). Estimates still wait for the NBA engine (not wired in this build). |
| GEM-2 | Found after the full stage: Gemini meeting notes before about Oct 24 were never recorded (weeks of Oct 5 and 12: 0 notes; Oct 19: 2; the calendar holds 18–41 meetings a week), yet the Gemini scope reported 0 holes. `GeminiNotesFetcher.fetch` listed meetings from the window's start to **now**, newest first, and stopped at the run's 25-item limit. Every backfill window from weeks ago got the same newest meetings and never its own, while the window counted as read. It also explains MIN-25 on Gemini: each window re-read the same long November notes. Stages 1–4 fit under the limit by luck. | The listing ends at the window's end (or now, if sooner), and so does the window's coverage. A poll's window ends now, so polls are unchanged. Test: `tests/be2b/gemini.test.ts` GEM-2. The other fetchers bound their queries by the window already. **Recovered on this database** (Nov 7): a Gemini-only backfill of Oct 8–25 in 34 twelve-hour windows, all succeeded, $0.18, 0 holes, no failed runs. Notes by meeting week, before → after: Oct 5 0 → 7, Oct 12 0 → 11, Oct 19 2 → 9, against 10, 12 and 21 meetings with a video link (later weeks: 13 of 22, 9 of 12). The trace of a recovered window shows its listing and coverage ending at `window.to`. |
| DEALS-1 | With REC-2 recording every changed opp on my accounts (1,173 in the projection), Deals counted all of them as mine: "696 open opps on 32 accounts · $418M", "85 open opps without your DC" on a big account, and "close date passed 2933d" from years-old open opps I'm not on. | Deals' account counts, pipeline and next close, and the account's DC status (projection), count only my opps: on my team, in my book, holding my DC, my logged hours this quarter, or found by the missed-opp sweep. Every other opp stays context on the account page. On the stage data: 51 open opps on 30 accounts, $50M, close dates ahead. |
| ORG-6 | A backfill `opps` run made no query, reported a made-up `soql:org62:opps:skipped` coverage over its week and finished complete: a silent gap (stage 1 attempt 7). The skip rule for the unwindowed scopes sat next to the windowed ones, and 1.3.0's "the runner records every row for you" read like there was nothing left to do. | The runner never accepts a windowed Org62 run (`opps`, `events`, `dcs`) that made no SOQL query: it stays incomplete at the window start with no coverage, so the hole stays and the runtime retries. scan-org62 1.4.0 says that the windowed scopes always query and page, in every mode, and that the runner only does the recording. |
| ORG-5 | With both opps pages back whole (ORG-4 fixed), the agent still recorded none of the 100 rows: it went straight to coverage (zero width) and finished incomplete at the window start, so the week never moved on. Transcribing every Org62 row by hand was the weak point all along (ORG-2's 3.6 s per Event, MIN-7's 156 of 207). | **REC-2**: the runner records every row of every windowed Org62 page (`opps`, `events`, `dcs`) from the SOQL result itself, before the model sees it, with §4's exact externalId, excerpt and payload keys (`src/llm/org62-rec.ts`; `CC_ORG62_REC=0` turns it off). It also tracks where each query got to. An incomplete finish, or a "complete" one that left a full page behind, resumes from the earliest last row among the full pages, with coverage up to that row, so the window always moves on and nothing past the cursor is claimed. scan-org62 1.3.0 tells the agent the rows are recorded, to cite them by externalId, and to spend its turns on paging and §5. `book` and `missed_opps` still record their own rows. |
| ORG-4 | The newest Org62 `opps` week stayed a hole on every try: both runs recorded 50 rows and finished incomplete with the cursor at the window start, so the re-plan repeated it. The trace (`npm run scan:trace`) showed why: Q2 (opps on my accounts, 1,098 changed rows that week after bulk updates) returned a 2,320-character result with no rows. A 100-row Opportunity page with `NextStep` text is 77,016 characters, over the tool's output cap, so the agent got only the overflow notice. It recorded Q1's 50 rows and reported Q2 at zero width. | scan-org62 1.2.0 pages both opps queries by 50 (about 39K characters a page; Q1's 50-row page was 43K and came back whole). On an overflow notice the agent reruns the query with half the LIMIT (down to 10) and never reports coverage, or moves the cursor, past unread rows. The ORG-3 observer already treats an overflow notice as not read (test added). |
| ORG-3 | On quiet Org62 weeks (0–6 changed rows) the agent finished `complete: false` with its cursor at the window start, as if it had paged out. The store clamped those runs' coverage to nothing (holes), and the stalled-continuation retry stalled the same way, keeping the scope pending. It reproduced on every retry. | The runner watches every SOQL result (PostToolUse). When no query of a windowed scope (`opps`, `events`, `dcs`) returned its LIMIT and none errored, the window was read whole by the skill's own paging rule. The runner restates each reported query's coverage over the window and records the run complete through the window end. A query that hit its LIMIT keeps the agent's incomplete finish. |

## 4. Fixed between stages (small; the ramp did not restart)

| ID | What | Fix |
|---|---|---|
| MIN-8 | Automatic read-ins (Sonnet) ran on every direct ask the backfill found, up to the $2/day cap, on every fresh database. | The direct-ask trigger needs the ask itself (the origin message) inside its 48 h window, not just the work item: a backfilled ask from weeks ago gets a read-in only on request. |
| MIN-9 | Old training notices with no due date stayed open trainings. | Like TRAIN-1: a training with no due date whose newest notice is over 30 days old lands in Triage. |
| RES-1 | "Decide if the prep session is needed" stayed Likely done on my "if it's the same content I'm good", although the asker cancelled the prep in the same group DM. That message was a candidate but lost the last of six slots to "Thanks all, have a great weekend". In a newest-first backfill it was recorded before the ask, so no later pass looked at it again. | The asker's settling message (cancel, no need, invite sent, all set) ranks first, and pleasantries are not candidates. check-completion 1.3.0 adds the basis `resolved`. With the asker's own message (`from_asker`) at ≥ 0.8, `resolved` or `done_by_other` is Sure, reason "Resolved by NAME: …" (Undo as usual). Checked by a dry run on the stage data: that item closes and nothing else changes. |
| RES-1b | "Share a workbook with PERSON_D" stayed in progress after the asker wrote "PERSON_C mentioned she has something so I'll follow up with her" (the same cap loss: later call chatter took the slots). | The settle patterns include the asker getting it elsewhere ("has something", "I'll follow up with her", "get it from"), and check-completion's rule names that case (example 11). The dry run on the stage data closes it: "Resolved by NAME: asker will get the workbook from PERSON_C instead". |
| DLV-1 | "Send PERSON_B the repo folder" stayed Likely done after I answered "here you go" with the zip attached. Search results show no attachments, the recorded message was the 16-character text, and the completion pass never judges a message already linked as a completion. | REC-1 records attachments: file names, types and ids from the `Files:` line of detailed channel and thread reads (the channel parser had kept that line inside the text), and `hasFile` from scan-slack 1.3.3's new S4 search `from:<@me> has:file`. A completion link is Sure when it is my reply in the ask's own DM or thread, after the ask, carrying a file or link of the kind the title asks for, or one sharing a title word (`src/scanner/delivery.ts`, both stores). "here you go" alone stays Likely, and so does an unrelated attachment. The completion pass's candidate text shows attachments. |

| LD-1 | Likely-done items looked like open work. Home's live set counted `likely_done`, and so did the priority engine's lane `now`, so an item the engine thought finished took a Do now card, a section row or a Today Top 3 slot. Its only marker was a violet "Looks done: triage: My reply…" line inside Details, with the writer's prefix showing. | Likely-done work has its own group everywhere: Home's one-line "Looks done: confirm" band under Do now (two items side by side, three when wide, "+N in Triage"), Triage's first group "Looks done: confirm", and Work's first section. Each has a green ✓ "Looks done" badge (ready, never violet), one evidence line (the reason without `done_check:` / `triage:` / attachment prefixes, in the user's words, "· 16 min after the ask" when both times are known), and one click: **Confirm** (`confirm-done`, Undo on the toast) or **Not done**. The new verb `not-done` returns the item to the live state it had before (the last transition into `likely_done`; in_progress when none) and clears the reason. It never takes a Do now card, a section row or a Today Top 3 slot. Home still fits 1920×1000 with no page scroll (the band is 40 px). |
| DONE-1 | A closure by someone else read `Done by {"isMe": false, "name": "PERSON", "email": "…", …}: Resolved by PERSON: …`. That was raw JSON, with an email, in a reason shown on Work and History. | The closure engine's evidence query fell back to `meta ->> 'author'`, whose value is a person object, when the author was not resolved to a person. It now reads `meta -> 'author' ->> 'name'` (and `isMe`); a test checks the reason never holds the JSON or the email. |
| REC-2b | The opp-team query's page 1 was full and page 2 came back empty, yet the recorder still called that query full, so a complete run became incomplete with a needless continuation. It never skipped rows (the run resumes at the earliest point). | A short or empty next page marks the query read through the window end. A re-read of an earlier page does not reopen it. |
| DONE-2 | Done reasons kept the writers' prefixes: "Done by you: triage: my reply …", "Done by you: delivered_with_attachment: link (doc); done_check: …", and "Done by PERSON: Resolved by PERSON: …" (MIN-16). | The closure reason uses LD-1's cleaner (prefixes dropped, attachment named, "your reply"). An asker's own settling message reads once: "Resolved by PERSON: …". |
| ORG-7b | ORG-7's `accounts: N` lived only in the in-memory ledger: the database ledger keeps no coverage meta, so the count never reached `scan:trace`. | The coverage trace event carries `notes` (`soql:Opportunity:accounts:accounts=N`). |
| LD-1c | Looks done evidence read "My DM reply …", "My thread reply …": only a leading "My reply" became "Your reply". | Any leading "My" becomes "Your" ("your" inside a done reason). |
| HOME-2 | With 18 items in Looks done, Home's band showed two side by side at 1920 and cut each evidence line to about 15 characters. | One row with its whole evidence line below the wide container (two at 2,400 px and up). The rest are in Triage's Looks done group ("+17 in Triage"). |
| MIN-20 | Home's headline said "approve 3 drafts" while the Outbox card said "Approve 12 drafts": the sentence counted the three drafts the card lists. | The sentence counts every ready draft. |
| MIN-21 | The headline said "build … by Mon 10/26" for an item 11 days overdue, which read like a deadline still ahead. | A past due date reads ", overdue since Mon 10/26", marked overdue. |
| FS-LATE | A channel watch added after the first scan had finished planned only Slack's own 24 h: `FirstScan.claim` returned nothing once the first scan was done. A teammate adding a watch later, or Tristan adding the two watched channels after the full stage, would get one day of history. | A Slack `channel:` scope with no cursor that appears after the first scan finished joins it. Its floor is the day it was added minus the first scan's lookback, and it spends what is left of the one-time budget (off the daily cap, BUD-1). The first scan reads active again on Health until the channel is done. Thread and other targeted scopes never reopen it. Each of its runs traces `first_scan_reopened` (scope, floor, when it joined), so `scan:trace` shows why it got the lookback. Health's First scan card marks it "added later", counts its coverage from its own join time, and shows each scope's one-time spend. Tests: `tests/stress/first-scan-late.test.ts`, `tests/trace/db.test.ts`. |
| MIN-25 | In the full stage, every busy window of 25 long items, the run's item limit, went over the flat $0.05 per-run cap: Gemini meeting notes estimated about $0.063 (late October) and old Gmail threads about $0.061 (90-day inbox). Each failed once, then retried with 12 items. That added a failed run and about $0.06 per busy window, with no data lost. | Backfill-type runs (head, backfill, continuation, retry) of a deterministic source may spend $0.10, about $0.004 an item. The regular poll keeps $0.05. Lands after the full stage; not a stage blocker. |
| MIN-26 | During the full stage, Health flipped Gemini notes and Gmail to "degraded" (and back) on MIN-25's cost-cap failures, the runtime's normal oversize handling (a smaller retry of the same window, nothing lost). | A planned fewer-items retry or window split neither degrades the connector nor counts as a failure; the retry's success still writes ok (and resets the failure count). A real failure, and a single item over the run budget, still degrade it. Tests: `tests/stress/first-scan-late.test.ts` MIN-26. |
| PERF-1 | On the full stage's database every API took 0.46–2 s (`/home` 2.0 s, `/today` 1.0 s, `/api/v1/since` 1.0 s, the rest about 0.5 s), and pages took over 2.5 s to fill. The profile: each request rebuilt the read model with about 30 queries in a row, including all 7,000 jobs and 5,000 scan runs; `/home` built it twice (once for Today's capacity); and the since-you-left digest loaded 16,000 change sets and 12,000 audit images on every `/home` and `/today`, then dropped nine in ten of them. | Pages read a lean model: its loaders run concurrently; jobs and scan runs load only for the scan ledger, the jobs list, a job retry and a manual scan (reading them otherwise throws), and the ledger and jobs list read their own table. `/home` builds Today and the digest from one model. The digest's scanner-noise rule runs in SQL, and audit rows come back without their images (the title is read in SQL). The digest is identical to before on this database (4 windows compared). Measured over HTTP on a production build against a copy of this database: `/home` 0.23 s, `/today` 0.21 s, `/since` 0.22 s, every other API 0.05–0.16 s, and a page's data lands 0.6–0.8 s after navigation. No cache: nothing goes stale. |
| DEEP-1 | With the Slack and Gmail inboxes at 90 days, half the open work was asks months old (235 of 457 at the end of the full stage), led by items overdue since August. | Tristan's call: an ask whose newest origin message was over 30 days old when first seen lands in Triage under **Still needed?**, out of Today and the overdue counts. One click keeps it (open work) or closes it (resolved as not needed), both with Undo. Work due after it was first seen stays open, and TRAIN-1's and MIN-9's old training notices join the group. An existing database is aged without a rescan: `npx tsx scripts/db/still-needed.ts` counts, `--apply` moves them in one undoable change set, only items never touched by the user. On a copy of this database: 132 items (88 open, 44 in progress) moved; Home's Reply & approve went from 152 to 56, Think ahead from 26 to 14, and Today's list from 253 to 121, while Triage's Still needed? holds 135 (with three old training notices). Triage now lists and counts every suggestion: it read them through Q9, whose `LIMIT 100` hid 53 of the 156. |
| MIN-22 | At 22:42, after working hours (07:30–17:30), Home and Today read "~0m free · Over by ~25m". | Tristan's call: once today's working hours are over (or on a day off), the meter counts the next working day: its hands-on load (due that day, start-by that day, pinned, and the chores still waiting) against its free time, labelled "tomorrow" (or "Monday"). Today's unfinished work is then a pull-forward, never "Over by". Home and the Today header read the same numbers. |
| MIN-27 | Home read "Since you left: 2,323 changed · 411 new" on every visit: the server's start never moved from install. | The browser marks an absence (no input, or the tab hidden, for 30 minutes or more) and sends when it began with every API call (`x-cc-away-since`). The server moves `cc.meta.lastActiveAt` forward to it, never back, so Home, Today and the shell's panel count from the same moment. A tab left open with no input moves nothing; the first input after an absence refetches the digests, and a browser with no history sends nothing. Checked in Chrome on a production build: a return after 3 h sent the header on the first `/home` call and the digest went from 2,465 changed to 274; `/api/v1/since` went from 1 MB to 103 KB. |
| MIN-28 | Health ▸ Jobs listed all 7,032 jobs (a 2.2 MB `/api/v1/jobs`). | Succeeded and cancelled show the latest 50 each (plus each job kind's newest, which the connector panel reads), with the full count in the group header and "Showing the latest 50 of N". Queued, running, retrying and dead stay complete. `/api/v1/jobs`: 2.3 MB to 19.6 KB, 0.023 s. |

## 5. Minor issues (the ramp goes on)

| ID | Severity | What we saw | Likely cause | How to reproduce | How to test a fix |
|---|---|---|---|---|---|
| MIN-1 | medium | An ask addressed to someone else became my item: "@PERSON_B can you share the recording with @ME and @PERSON_C?" | The triage addressee rule marks a message "→ me" when it @-mentions me anywhere; here the ask's addressee is the first @-mention (TRI-2's shape). | A placeholder group-DM message whose first @-mention is another person, asking them, with a trailing @-mention of me. Run `tests/stress/rec1-triage.test.ts`'s triage harness on it. | The miss bank's hard controls (STRESS.md §5.2) plus this case stay noise, and the bank's recall does not drop. |
| MIN-2 | low | IT notices (a device OS update, an MDM check-in) became `training` items. | The Trainings Gmail query matches "action required", and `scan-trainings` types every notice it keeps as a training. | Placeholder mails "Action Required: update your device OS" and "Check in to MDM" through `tests/be2b/trainings.test.ts`'s fetcher, then the skill. | They land as `task` (or are dropped as IT noise by code), and real training notices keep `training`. |
| MIN-3 | medium | "Write the technical POV with PERSON" went Likely done because I shared the meeting notes the POV needs. | The Slack triage pass links `completion` itself (likely), without the completion pass's rule (name the outcome the title needs first; a pointer is not delivery). | A placeholder thread: the ask "write a POV on X", then my reply "here are the notes from the call: <doc link>". Run the triage harness. | The reply links as `progress` (or context), never `completion`; the completion pass still closes a real delivery. |
| MIN-4 | low | Drive's first-run history covers 30 days even when the first scan is 1 day. | `DriveFetcher.editedLookbackDays` (30) is independent of the first-scan lookback. | Any stage below 30 days: count `source_items` with `meta->>'history' = 'true'` by `occurred_at`. | Decide: the history follows the first-scan lookback (pass it to the fetcher), or the 30 days stays as a feature. |
| MIN-5 | low | Items naming a customer with several Org62 entities of equal weight get no account (a three-way tie). | ACC-1 never guesses on a tie, and Org62's account family (`ParentId`, `Ultimate_Parent`) is not read. | `tests/projections/mappers.test.ts` "accounts that claim the same name": three accounts sharing a short name, one open opp each. | With a family read from Org62, a tie inside one family resolves to the parent or the account with the most activity; across families it stays unmatched. |
| MIN-6 | low | Common nicknames that are not derivable from the legal name (a parent-company acronym such as "PHG" for a "Placeholder Health Services, Inc." entity, a state abbreviation such as "of CA") match no account. | ACC-1 derives first words, letters-plus-digits and acronyms only. | `shortNames('PLACEHOLDER Health Services, Inc.')` against a text using the parent-company nickname. | User-confirmed aliases (`account_aliases`, from a Triage mapping question or Settings) make them match. |
| MIN-7 | medium (fixed by REC-2 for `opps`, `events`, `dcs`; `book` and `missed_opps` remain) | Org62 rows are transcribed by the agent: slow (about 3.6 s per Event) and, per STRESS-2, incomplete (one continuation stored 156 of 207). | REC-1's record-from-tool-result exists for Slack only (REC-2 open). | A replayed Org62 Events page of 100 rows (`scripts/stress` Org62 replay); compare recorded rows with returned rows. | Every returned row is recorded from the tool result before the model sees it, and runs no longer approach the watchdog. |
| MIN-11 | low | When an item has more than six candidates, the rest are never judged: the next pass only looks at messages that arrived after its watermark. RES-1 ranks settling messages first, so they no longer lose, but a plain delivery in a busy conversation still can. | `collectCandidates` caps at `max_candidates_per_item` and keeps no record of what it dropped. | A placeholder item with nine strong candidates where the delivery ranks seventh (`tests/completion/completion-candidates.test.ts` style). | The item stays pending with the rest, and the next pass judges them without re-judging the first six. |
| MIN-12 | low | An ask that defers to "PERSON_B and me" ("PERSON_C said he defers to PERSON_B and ME to follow up"), with the other person named first or leading, became an open ask on me. It should be a shared item with PERSON_B as co-owner (D-41), landing in Triage as a suggestion. | The triage and escalation passes have only `act` / `noise`; `cc_propose_item` has no co-owner field, so a shared ask can only land as mine. | A placeholder group-DM message "PERSON_C said he defers to PERSON_B and <@ME> to follow up on the setup steps" through the triage harness (`tests/stress/rec1-triage.test.ts`). | It lands as `suggested` with `coOwners: [PERSON_B]` (needs a `cc_propose_item` co-owner field and the D-41 rows); an ask addressed to me alone still lands open. |
| MIN-13 | low | One Org62 `events` continuation run sat for its whole 8-minute watchdog with 0 tokens (no model turn finished) and failed as transient. The retry a second later read the same week in about 3 minutes, so no data was lost, but the scope waited 8 minutes. | Unknown: a stall before the first model turn (the Org62 MCP connection or the agent start), not slow transcription (MIN-7). The watchdog only knows wall time. | `scan_runs` with `status = 'failed'`, `error_message` like `watchdog:%` and `input_tokens = 0`; it happened once in stage 1 attempt 4. | A no-progress limit (no tool call or model output in about 2 minutes) ends a stalled run early as transient, while a busy one that is still transcribing keeps its 8 minutes. |
| MIN-14 | low | The MIN-13 failure did reach Health's event feed (`connector_degraded` warn, then `connector_healthy` about 3 minutes later), but the events say only "Org62: healthy -> degraded". They carry no `scan_run_id`, scope or plain reason, so the feed cannot link to the run trace or say "a run took longer than its time limit". | The connector status-change writer records the transition, not the run that caused it. | `select code, message, scan_run_id from app_events` after any failed run (stage 1 attempt 4: two rows, both with a null `scan_run_id`). | The degraded event names the scope and the `statusReason` text and links the failed run (`scan_run_id`), so Health's feed opens its trace (`npm run scan:trace -- <runId>`). |
| MIN-15 | low | Deals ▸ Log & fix: a "PLACEHOLDER: DC on some opps only" row carries a **No DC** badge, while the account list says "DC partial" for the same account. | The gap row's badge is "No DC" for both `none` and `partial` (`src/components/deals/needs.ts`, the DC gap rule). | Any account with `dcStatus: 'partial'` and open opps: the Log & fix row and the account row disagree. | A partial account's badge reads "DC partial" (or "Some DC"), a `none` account keeps "No DC", and the tone stays warning. |
| MIN-16 | low (fixed by DONE-2) | A closure by someone else reads "Done by PERSON: Resolved by PERSON: asker will get … instead", with the name twice. | The closure reason is `Done by <person>: ` plus the evidence reason, and RES-1's evidence reason already starts "Resolved by <person>:". | Any `asker_resolved` closure (RES-1 / RES-1b), e.g. the dry-run cases in `tests/completion`. | The reason reads once: "Resolved by PERSON: …" (or "Done by PERSON: …"), never both. |
| MIN-19 | low | Read-ins spent $2.03 in stage 4 against their $2/day cap. | The cap is checked before a call, so the last call can overshoot by its own cost. | Any stage whose read-in total ends near $2 (`llm_calls` with `purpose = 'summarize'`). | The check reserves an estimate of the call's cost (or the cap stops within a cent). |
| MIN-23 | low | A past start-by on a Do now card still reads as a deadline ahead: "Start by 17:20" at 23:00, and "Start by Tue 16:35" on an item overdue since Tue. MIN-21's wording again, in the card's chip. | The card's state label formats `startBy` without checking it has passed. | Home at night with an item whose start-by passed today, or an overdue item with a start-by. | A past start-by reads "Late · start was 17:20" (or the overdue label), never "Start by". |
| MIN-24 | low | "re-evaluating…" stays on a Do now card. | `item.reevaluating` is set by the reevaluate path, and nothing clears it while `nba.generate` is the BE-4 stub. | Any item reevaluated since the first scan: `/api/v1/home` card `now.item.reevaluating` stays true. | The flag clears when the re-evaluation finishes, or is not set while the NBA engine is not wired. |
| MIN-29 | low | A click that changes something takes 0.3–0.5 s on a production build against this database (mark seen 0.31–0.37 s, Outbox Reject 0.46 s), and Reject took about 1.5 s on the live app. | Every mutation reloads the whole read model inside its transaction, one query at a time (a Postgres client runs one query at a time), before it writes. PERF-1 made only the reads concurrent. | `curl -w '%{time_total}' -X POST localhost:4327/api/v1/items/<id>/seen -d '{}'` on any database after a first scan. | A mutation loads only what it touches (or reads the model on the pool before its transaction and rechecks versions inside), and a click lands under 0.2 s. |
| MIN-30 | low | On a day off (a Saturday), Home's day ribbon reads "10:15–17:30 open" with a pull-forward, Today's day pane reads "Open · ~7h 10m from 10:20", and Home's headline says "this afternoon", while the capacity meter (MIN-22) counts Monday. | The ribbon, the day pane and the headline take the working hours without the working days. | Any Saturday or Sunday: `/` and `/today`. | On a day off the ribbon and day pane show the day as off (or the next working day), and the headline speaks of that day, matching the meter. |
| MIN-10 | low | `/triage` and `/work` intermittently log one client-side page error on load: React #418, a hydration mismatch (server HTML text differs from the first client render). The page then renders normally. | Probably text that depends on the clock ("in 24m", ages, "now") rendered on the server a moment before the client, or in a different time zone. | `PORT=4327 SHOW_ERR=1 node scratchpad/pages.mjs x /triage /work` (system Chrome, 1920×1000, under 4 s each); about one load in two (`/triage`), and one in three on `/work`'s first load in stages 3 and 4, shows it. | Clock-dependent text renders after mount (or from the server's `now` on both sides), and 20 loads show no #418. |

## 6. Final report (2026-11-07)

**Result.** Every stage passed its scan criteria on a fresh database: 1 day (attempt 9), 2 days, 7 days, 14 days, and the
full stage (30 days, with the Slack and Gmail inboxes at 90). Each finished with every scope done, 0 holes and 0 dead
jobs. The majors found on the way were fixed with tests before the next stage. One more, GEM-2, was found after the full
stage and is fixed. Ramp spend: about $53 of $100 (attempts 1–9 of stage 1 about $11, stages 2–4 about $12.5, the full
stage $28.89).

**Measured first-scan cost** (one SE's real data; shipped in `FIRST_SCAN_COST.measured`, `src/server/onboarding/cost.ts`):

| Lookback | Measured | Shipped range | Wall time |
|---|---|---|---|
| 7 days | $4.42 (scan $2.54, read-ins $1.88) | $3.50–6 | 54 min |
| 14 days | $7.18 (scan $5.15, read-ins $2.03) | $6–10 | 114 min |
| 30 days | $16.24 net (scan $12.34, read-ins $3.90) | $13–23 | about 4 h for the 30-day part |
| 90-day inbox add-on | +$10.58 (Slack $9.47, Gmail $1.11) | not offered by onboarding | +3.5 h |

Slack dominates: about $0.26–0.30 a day of history in 2-hour chunks and $0.22–0.24 in the deep 6-hour chunks.
Read-ins are capped at $2/day. The 30-day net excludes $2.14 of MIN-25 cost-cap failures (fixed since).

**Majors fixed during the ramp** (section 3): ORG-2, ORG-3, ORG-3b, ORG-4, ORG-5 (REC-2: the runner records every
windowed Org62 row), ORG-6, ORG-7, FS-3, TRAIN-1, DEALS-1, HOME-1 (+1b), BUD-1, GEM-2. **Between stages** (section 4):
MIN-8, MIN-9, RES-1/1b, DLV-1, LD-1 (+b, c), DONE-1/2, REC-2b, ORG-7b, HOME-2, MIN-20/21, FS-LATE, MIN-25/25b. **After the
ramp:** the GEM-2 recovery (section 3), MIN-26, PERF-1, and Tristan's calls on DEEP-1, MIN-22, MIN-27 and MIN-28.

**Decisions for Tristan** (his answers on Nov 7):
1. ~~The two watched channels~~: skipped. FS-LATE ships on its tests.
2. ~~DEEP-1~~: Triage, "Still needed?" (section 4). This database is aged by the backfill once the fix is merged.
3. ~~Recover the Gemini notes GEM-2 missed~~: done on Nov 7 for $0.18 (25 notes recovered, 0 holes; section 3).
4. **Snapshot carry-over** (people, initiatives, watches and VDP statuses from the Nov 5 snapshot): still open.
5. **Policies to confirm**: MIN-8 (automatic read-ins only for asks from the last 48 h) and MIN-4 (Drive's first-run
   history is always 30 days). ~~MIN-22~~: after hours the meter shows tomorrow's load (section 4).
6. ~~PERF-1~~: fixed without a cache. ~~MIN-27~~ and ~~MIN-28~~: built as proposed (section 4).

## 7. Settle round (2026-11-09): judge every item with the whole conversation

**Why.** The full stage's list was mostly noise. Measured against a hand-built answer key, only 16 of the 308 open or
suggested items were still owed. The rest had been answered or delivered (mostly my reply in the same DM, minutes
later), were tied to a moment that had passed, were aimed at someone else, were not asks, or were duplicates. The
scanner judges one window at a time and read the backfill newest first, so the answer was recorded before its ask.
Read-ins had the right context but changed nothing. Tristan's ask: close finished work for him, show it in one place
with links, and make the rules settings.

**Answer key.** Ten reviewer agents read every one of the 444 items: the database evidence plus the live conversation
(read-only Slack, Gmail and Calendar). They recorded one verdict, the deciding message, a confidence, and whether our
own data already held the deciding fact. Results:

| Verdict | Items |
|---|---|
| done by me | 269 |
| duplicate | 28 |
| resolved by someone else | 27 |
| gone quiet | 27 |
| not an ask | 24 |
| not mine | 22 |
| moment passed | 21 |
| still mine | 16 |
| superseded | 6 |
| handed off | 4 |

- 14 items are unsure, and Tristan has their questions.
- 417 of 444 deciding facts were already in our database.
- None of the 136 closed items was closed wrongly.

The key is private (`stress/settle-key/`) and keyed by origin message, so it maps onto a rescan.

**Method (Tristan's).** Run the cheap check on every item and score it against the key. Fix only the wrong items:
either the context missed the deciding fact, or the rule decided badly. Rerun just those, then rerun everything once.

| Round | What changed | Result |
|---|---|---|
| 1 | Skill 1.0.0, context: the conversation around the ask | Bucket accuracy 75.6%. 0 wrong closes at ≥ 0.7, but only 64% of settled items closed. 20 calls timed out under load. |
| 2 (wrong only) | Retrieval by people: the asker, people named in the title (from a directory of Slack names and email senders), DMs with them, my first messages to them, calendar attendees; long DMs keep their topical middle. Skill 1.1.0: answered in substance, asker let it go, plan changed, the meeting it was for happened, declined invites, mass notices. | 87–89.5% |
| 3–4 (wrong only) | Skill 1.2.0 / 1.3.0: the ball in their court, offers nobody took up, promises tied to a past event, invites vs tasks, record-derived tasks; mass-mail and invite-response hints | 91.6%. The last wrong closes were a future meeting and a data-derived task. |
| Final (all 445, one pass) | Skill 1.3.0, then Sonnet on the unclear verdicts (failed, still mine, gone quiet, or under 0.6), plus code guards: an upcoming matching meeting or invite, an open loop (the asker wrote last this week, or chased in the last two weeks with no reply from me), trainings close only on evidence | **90.2%** bucket accuracy, $2.83 for 445 items ($0.72 Haiku, $2.11 Sonnet on 99 items) |

Rerunning only the wrong items flattered rounds 2–4: Haiku's verdicts vary between runs. The final one-pass numbers are
the honest ones.

**Policy simulation on the final pass** (the 294 items that were not done; real policy, every reason set to close):

| Strictness (min confidence) | Right closes | Wrong closes (still owed) | Soft closes (key: gone quiet) | Clicks left | Still-owed items kept |
|---|---|---|---|---|---|
| Cautious (0.7) | 196 | 0 | 6 | 78 | 14 |
| **Balanced (0.5), the default** | **233** | **0** | **15** | **32** | **14** |

Each reason defaults to Close for me, because each measured at least 97% right. The plan's rule was close only at
≥ 97%, otherwise ask. The guards keep "not an ask", "moment passed" and "gone quiet" from closing while a matching
meeting is ahead or the asker wrote last. The 32 clicks left on this database:
- 11 settled items still judged mine (the model's residual);
- 9 held by the guards;
- 5 gone quiet below the bar;
- 2 failed verdicts;
- the rest asks.

The rescan (30 days for every source, oldest first, with the scanner noise fixes) starts from far fewer items.

## 8. The 30-day rescan with Settle (2026-11-09)

**Setup.** Live DB backed up, dropped and re-bootstrapped. 30-day lookback for every source, oldest first, with the
scanner noise fixes (§7's lane 5) and onsite days (lane 6). The first scan ran 10:38–14:25 MT.

**Coverage.** 0 holes and 0 failed or dead jobs at the end; 8/8 sources live.
- 4 Gmail windows hit a provider "backend unavailable" error, and 1 Gmail and 2 Slack windows hit the 3-minute
  watchdog. All were re-run and covered: Gmail on retry, Slack by the end-of-plan hole re-plan (FS-2).
- 35 Drive windows failed before the FS-DRIVE-1 fix (backfill windows behind the feed frontier). All were covered after
  the fix.

**Spend.** $14.51 on the rescan day ($8.41 reading, $1.12 Settle, the rest polls, summaries and checks), plus about $2
of offline Settle dry runs. That is well inside the round's $75.

**What the scanner made.** 140 items, against 444 on the first 30-day scan. 296 of the key's settled items were never
created.

**Found and fixed during the rescan:**

| Problem | Fix |
|---|---|
| 45 asks parked as "unlinked" (38 to me, at least 10 still owed). They waited for the 02:00 reconcile, then became "Where does this belong?" three nights later. R5 step 3 said both "propose" and "flag with no confident home". | R5: no matching item means propose. Flag only when a candidate might be the same deliverable. R9 relink can propose, or mark an item `not actionable:` (recorded only). FS-RELINK: relink as soon as the first scan is done (`6e952bc`). |
| The Settle hook never queued a pass: its dedupe query filtered on a job status the enum doesn't have. | Fixed, plus a scratch-DB test (`6e952bc`). |
| Wrong close on a promise: done_by_you at 0.55 citing "yes I'll get that over tonight". | A done_by_you that cites only a promise to do something is invalid (`9f24623`, narrowed in `fc598d6`). |
| Wrong close on a yes to future work: "Confirm whether I'll run the flow on the 17th" closed on "good to run it". | Skill 1.4.0: a yes to future work is still mine until it happens (`9f24623`). |
| An Undo of a close for you wasn't seen as a reopen (Undo reverts the change set; it writes no user transition). | Settle's facts count a user Undo of an engine change as userReopened (`9f24623`). |
| Wrong close as not_an_ask on a long recap: the request sat past the 1000-char stored excerpt. | `askCutOff` hint, a skill rule, and a policy guard: never close not_an_ask / not_yours on a cut-off ask (`cfa84d0`). |
| A prep task's real meeting (tomorrow, with the customer) shared no title words with it, so it never reached the context. | Events whose external attendee domain matches the account or title words join the context, scored +3 (`cfa84d0`). |
| A VOC I asked follow-up questions about (no answer in 4 days) closed as "gone quiet". The work is still mine; the ball is in their court. | New verdict `waiting_on_them` (skill 1.5.0) and policy action `wait`: the item moves to Chase (waiting on others) with the reason and when I asked, never closes (`c5c746e`). On a rejudge of the 31 live items, 1 other moved. |
| Home showed live items "re-evaluating…" for good. The derived flag was saved on the item by any write while a job waited, and the first Settle pass wrote 54 at once. | The flag is read from the job queue only and never stored (`b0df03a`). |

**Settle on the live DB.** Pass 1 judged 116 items: 90 closed, 7 reopened, 4 asked. Pass 2 judged 10: 5 closed, 2 asked.

**Scored against the answer key.** The key is §7's (mapped by origin message) plus a new read-in of the 29 rescan items
it didn't cover.

| Measure | Target | First pass (code at 14:36) | With this round's fixes |
|---|---|---|---|
| Auto-close precision | ≥ 97% | 103 of 108 known closes right (95.4%); 5 still-owed items closed | Full rerun: 0 wrong of 84 on the old key. With the new key: 2 wrong of 103 (98.1%), then 1 after `cfa84d0` |
| Still-owed items closed | ≤ 2 | 5 (all undone; they're back on the list, the VOC in Chase) | 1 (a prep task judged "moment passed" with the customer meeting visible) |
| Open or in-progress items that are real and live | ≥ 85% (was 26%) | 12 of 15 known (80%); 15 of 18 counting 2 unsure open promises and 1 item new today | the same |
| Clicks after the first scan | < 20 (was ~200) | 16: 13 in Triage + 3 settled items still judged mine | the same |

**Live-list misses** (settled per the key, still open):
1. A workshop that ran: the check saw the meetings but not that they were the workshop.
2. Work marked done in the app on the old DB. Not knowable from source data, so it's an expected click on a real first
   scan.
3. A split that was agreed in a DM.

**Time, Oct 26–30.**
- Oct 28 shows an Onsite chip and 11.25 h: onsite 08:00–17:00 on the account, the customer dinner, and a quarter hour of
  Slack.
- Oct 29 shows 10 h: the onsite morning plus a 5.5 h Travel block for the flight home.
- Oct 27 ends with the 5 h flight out.
- Nothing is overnight, and there are no overlaps (the no-overlap constraint holds).

**Pages checked** on a second production server against the live DB:
- Home: "Closed 5 for you since you left · Review" links to Triage.
- Triage: Closed for you (105) shows each row's reason badge, the plain reason, "N after the ask", Open message (opens
  the Slack permalink) and Undo. Undo restored the item and removed the Settle evidence.
- Time: the onsite chips and the hours above.
- Not checked: History for Oct 28 (the page ignores `?date=` and opens on today).

**Minors, not fixed:**
- History has no deep link to a day: `/history?date=2026-10-28` opens today.
- Home's "Closed N for you since you left" counts since the last visit, so the first visit after a first scan shows the
  last pass, not the whole first scan.
- Slack bodies are stored as 1000-char excerpts (62 hit the cap). Settle now knows when an ask was cut, but the rest of
  the message is still lost.
- About 100 `control_center_*` scratch databases from test runs are still on the local Postgres.
- The repo has no git remote.
