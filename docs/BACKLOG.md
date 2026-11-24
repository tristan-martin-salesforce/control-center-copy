# Command Center — Idea Backlog

Every idea gets logged here, whether yours ("T") or proposed during planning ("P"). Phase means the planned home ("—" means unscheduled). Status: `planned` · `idea` · `blocked` · `done`.

| ID | Idea | From | Phase | Status | Notes |
|---|---|---|---|---|---|
| B-001 | Unified to-do from Slack, email and calendar, always current | T | P1 | planned | Commitment engine origins 1–5 |
| B-002 | Auto-close a task when I reply to the Slack message or email | T | P1 | planned | Reply-after-ask closure test |
| B-003 | Drafts and ideas so I never start from scratch | T | P4 | planned | Draft engine + voice profile |
| B-004 | Submit to VDP via MCP | T | P3 | planned | 19 MCP tools; writes gated |
| B-005 | Attach Drive presentations to VDP | T | P3 | planned | Asset handoff now; upstream asset MCP tool later |
| B-006 | Log hours against my opportunities | T | P2 | planned | Org62 Solutions Events |
| B-007 | Time spent in calendar meetings | T | P2 | planned | |
| B-008 | Track what I say I'll do vs what I did, with timelines | T | P4/P5 | planned | Said-by-me extraction + ledger |
| B-009 | Time spent in Slides/Docs from edit history | T | P1/P6 | planned | No revision API via MCP. **Forward sampling starts in P1** (history is lost until then); allocation in P6. Past history needs the Drive Activity API (D-19) |
| B-010 | Prioritization across small daily items and big timelines | T | P1/P5 | planned | Priority v1, then goal-aware v2 |
| B-011 | Summarize what I did in each Claude session, per activity | T | P1/P6 | planned | `ai-title` + `away_summary` + files touched |
| B-012 | Up-to-date canvas of Org62 writes I need to do | T | P2 | planned | Handoff cards; optional Slack canvas mirror (B-040) |
| B-013 | Travel booking as an open item, marked done | T | P2 | planned | Created from: a calendar event in another city, an onsite/offsite invite (e.g. Atlanta Nov 2–4), or manually. Checklist: Org62 Travel Approval → Concur with approval # → expenses. Detection via Concur/approval mail in P6 |
| B-014 | Detect travel approvals going through | T | P6 | idea | Gmail Concur/approval notifications |
| B-015 | WYSIWYG Slack and email replies inside the app | T | P4 | planned | TipTap + mrkdwn round-trip |
| B-016 | Meeting notes that arrive later become tasks, correlated with Slack | T | P1 | planned | Notes typically arrive in under 15 min, worst case about 77; poll to 120 min. Only ~30% of meetings have notes. Cross-source merge links them to the Slack thread |
| B-017 | Team-wide: everyone runs their own copy | T | P7 | planned | Team pack + setup doctor |
| B-018 | Easy external path when permissions block us (Org62, VDP gaps) | T | P2/P3 | planned | Handoff adapters + read-back |
| B-019 | **Q3 catch-up kit:** draft Solutions Events, Duration backfill, DC/VDP gaps by 10/30 | P | Now | planned | Deadline Fri 10/30 12 PT |
| B-020 | Flag Org62 logging hygiene (missing `Duration__c`, legacy record type, no task type) | P | P2 | planned | Found in research |
| B-021 | Deal hygiene flags (e.g. a close date in 2030, stale next steps) | P | P3 | idea | Read-only nudges to you, not to the AE |
| B-022 | Meeting prep brief 10 min before customer calls | P | P5 | planned | Opp + VDP + last notes + open asks |
| B-023 | Post-meeting capture: notes → tasks + VDP update draft + follow-up email draft + activity draft | P | P2–P4 | planned | One "after" card per meeting |
| B-024 | Waiting-on-others tracker + nudge drafts | P | P5 | planned | Asks I made that weren't answered |
| B-025 | Weekly status update draft for my manager / standup | P | P5 | idea | Pairs with `slack:standup` skill |
| B-026 | Quarter-end countdown + EOQ ritual (activities, DCs, expenses by 10/31) | P | P2 | planned | Team-pack deadlines |
| B-027 | Concur expense reminder after travel | P | P6 | idea | |
| B-028 | Suggest calendar focus blocks for big deliverables | P | P5 | idea | Calendar write via Outbox |
| B-029 | "Start Claude session with context" button on any task | P | P6 | planned | Context pack → desktop session / SDK job |
| B-030 | `/cc` skill: add task / log session / what's next from any Claude session | P | P6 | planned | |
| B-031 | SessionStart hook injects today's Top 3 + this account's open tasks | P | P6 | planned | Needs your OK to edit settings.json |
| B-032 | Asset library of my decks, demos and repos; post new ones to the team's asset-repository channel | P | P3 | idea | Post via Outbox |
| B-033 | Learn mappings from corrections (domain/channel/repo → account) | P | P5 | planned | `rule` table; P1 uses static rules |
| B-034 | Global search across everything (`⌘K`) | P | P5 | planned | SQLite FTS5 |
| B-035 | Account memory pages (everything about ACME in one place) | P | P3 | planned | Deals view |
| B-036 | "Catch me up" mode after OOO (generalizes your after-action artifact) | P | P5 | idea | Date-range digest + capacity re-plan |
| B-037 | Channel digests for noisy channels instead of item-level ingest | P | P1 | idea | Reuse `slack:channel-digest` approach |
| B-038 | Calendar conflict / decline suggestions | P | P5 | idea | |
| B-039 | Voice-profile tuning ("sound like me") | P | P4 | planned | From sent Slack (you rarely send email) |
| B-040 | Mobile glance via a Slack canvas mirror of Today + Outbox | P | — | idea | Read-only mirror, updated hourly |
| B-041 | Retire Cowork 7am inbox triage once parity is reached | P | P5 | idea | Avoid duplicate briefs |
| B-042 | Credential redaction at ingest + nudge to rotate passwords found in DMs | P | P1 | planned | Research found plaintext passwords |
| B-043 | Upstream vdp-app: asset add/update/delete MCP tools, readiness/status tool, **`generate_use_case`**, owner tools, Drive file IDs | P | P3 | planned | You're a contributor; coordinate with the vdp-app owner |
| B-044 | Org62 direct writes once connector `dispatch` (write) is enabled | P | — | blocked | Ask for enablement (D-9) |
| B-045 | Browser active-tab sampling for time (opt-in) | P | P6 | idea | Privacy decision D-20 |
| B-046 | devbar `events.db` cross-check for Claude/Cursor activity | P | P6 | idea | Schema is devbar-internal |
| B-047 | Git commit time signal | P | P6 | planned | |
| B-048 | Peer-relative view (my hours mix vs team mix) | P | — | idea | Sensitive; personal-only, opt-in |
| B-049 | Certifications / enablement deadlines (e.g. Peer Cert decks) as goals | P | P5 | idea | |
| B-050 | Quick capture from anywhere (menubar / global hotkey / Slack DM to self) | P | — | idea | Menubar app is decision D-3 |
| B-051 | Granola notes ingestion | P | — | idea | Only via Slack paste today |
| B-052 | Google Tasks sync for phone reminders | P | — | idea | Tasks unused today |
| B-053 | Customer-facing vs related hours classifier using canvas <task-type-canvas-id> rules | P | P2 | planned | External attendee ⇒ CF |
| B-054 | Weekly Friday logging ritual (5 min) | P | P2 | planned | Matches the VDP owner's Friday skill run |
| B-055 | Use-case CSV export → hand to AE, with tracking until the AE uploads | P | P3 | done | Superseded by D-67: the SE (OwnerId = me) owns the Org62 Use Case records and creates them from the logging canvas; no CSV, no hand-off to the AE |
| B-056 | Cross-source task merge (one commitment from Slack + notes + email) | P | P1 | planned | Keeps Today calm |
| B-057 | Raise Claude transcript retention (`cleanupPeriodDays`) so history stops being deleted | P | Now | planned | D-36 |
| B-058 | `nba.generate` treats a missing work item as a no-op (an Undo can remove a sibling while its NBA job is queued) | P | BE-4 | done | From BE-REEVAL |
| B-059 | `work_items.auto_close_allowed` defaults false and nothing sets it; reeval ignores it. Decide: drop it, or default true | P | — | idea | ENGINES says undefined = allowed |
| B-060 | Seeded `scan.*` fixture jobs dead-letter with `bad_payload` when a worker runs on a seeded database | P | — | planned | Scanner handler; after the stress branch merges |
| B-061 | Outbox page opens `/outbox?draft=<id>` (read-in "Open draft" links there) | P | Wave 2 | done | P-LISTS |
| B-062 | Put `reopen_decisions` under the audit trigger so Redo restores the decision log too | P | — | idea | BE-REEVAL proposal; changes how `undone_at` is used |
| B-063 | Slack traversal records only part of what it reads (REC-1): record from the tool result, not the agent | P | — | planned | Stress session finding; runner design change |
| B-064 | Detail renderers for `calendar_event` (meeting brief + read-in), `connector` and `agent_run` | P | Wave 2 | done | P-CONTEXT-B |
| B-065 | A route that stores an accepted day plan (Today's added and deferred slots are local resume state today) | P | — | idea | From P-TODAY |
| B-066 | Thresholds settings section in the contract (today they're saved on this Mac only) | P | — | planned | From P-SETTINGS |
| B-067 | Delete route for watches (you can pause one but not remove it) | P | — | planned | From P-SETTINGS |
| B-068 | Chat respects the global hard cap, not only its own daily budget | P | — | won't do | D-43: chat keeps its own budget only (2026-11-06) |
| B-069 | Optimistic `patchEntity` silently skips entities with no `version` (MissedOpp did; Deals now patches the sweep payload itself). Audit other versionless kinds | P | — | done | From P-CONTEXT-A |
| B-070 | Single-opportunity and single-event read routes, so the opportunity, highlight and meeting panels render when opened cold from a restored URL | P | — | idea | Panels show "Not loaded here" or read getCalendar ±30 days today |
| B-071 | Per-run hands-on estimate in the contract (Agents uses state defaults: 3 m answer, 15 m review, 2 m click) | P | — | idea | From P-CONTEXT-B |
| B-072 | Outbox Reject: the contract has no reject route, so the button stays disabled | P | — | planned | From P-LISTS |
| B-073 | Briefs reading pane says "Pick a brief" while the list is still loading; Health's connector panel isn't restored from the URL | P | — | done | Orchestrator smoke after wave 2 |
| B-074 | Retire v1 rows in `src/client/keyboard/shortcuts.ts` (Today is `g y`, Assistant `g c`; the cheat sheet already uses the shell's list) | P | — | done | From V2-SHELL |
| B-075 | DB-UI blockers: dev toolbar 404s on `CC_DATA=db`, `next build` fails on `/deals/missed` (no Suspense), connector panel misses its scan job in db mode (uuid ids), composer drops text typed before the thread list lands | P | — | done | From DB-UI; fixed on main 471ebe1 |
| B-076 | `npm run check` never runs `next build`, so a build-only failure (B-075's Suspense) passes the check. Add a build step, or a separate `check:build` | P | — | planned | From DB-UI |
| B-077 | Account page lists an account's tasks in load order (creation order on db, seed order on mock); sort them explicitly | P | — | planned | From DB-UI |
| B-078 | Databases seeded before b47a23c read in a stable order but not the mock's; tool runs and NBAs written before it keep jsonb key order. Reseed scratch DBs with `--reset`; the real DB only rewrites as records change | P | — | idea | From DB-UI; never `--reset` the real DB without asking |
| B-079 | First-launch onboarding for a new user: role pack, priority weights, working hours, sources, and how much history to pull in with an estimated cost, so an empty app on day one isn't confusing | P | After go-live | done | Tristan 2026-11-06; reuses the bootstrap (WIRE). Built 2026-11-06: `/onboarding` (5 steps), db gate, CLI users skip it. "Start first scan" records the choice; wiring it to B-080 is the remaining step (`src/server/onboarding/first-scan.ts`) |
| B-080 | First-run history lookback setting, default 30 days (today: 24 h for Slack, Gmail, Drive, Gemini notes; 30 d Org62; resume planner caps backfill at 14 d), plus a one-time backfill budget so a long backfill isn't stretched over weeks by the daily cap | P | Go-live | planned | STRESS-2 part 2. Tristan: 30 days is the default; older known items are injected by hand |
| B-081 | History tab: a calendar of past days; click a day to see what was done: items finished, time logged (by account and CF/CR), meetings held, messages and drafts sent, agent runs, Org62 activity logged. Built from stored history (transitions, activity, time blocks, calendar, outbox, runs); no stored view snapshot | P | After the first scan | built | Tristan 2026-11-06. Built on `claude/history-tab-c35394`: /history (`g i`), GET /history + /history/:day |
| B-082 | Daily snapshot of the view as seen (Top 3, plan, morning brief) | P | — | won't do | Tristan 2026-11-06: history should show what was done, not the view as it looked |
| B-083 | Today day spine: gap labels overlap each other on a real day | P | — | planned | From WIRE live run |
| B-084 | Scanner writes error classes `config` and `unknown` the contract lacks, and doesn't save `probe.reauth` into `connectors.config` (read side maps both today) | P | — | planned | From WIRE; sent to STRESS-2 |
| B-085 | Under heavy machine load `/api/v1/home` took up to 36 s and `/today` up to 91 s while requests queued (1–2 s otherwise); profile the composed reads on a real-size DB | P | — | idea | From WIRE live run |
| B-086 | Org62 continuation runs can skip a page (a bulk-logged week stored 156 of 207 events): add a row-count check in the cc tools so a page read but not fully recorded is retried | P | — | planned | From ORG62; REC-1-shaped |
| B-087 | Deals still lists accounts whose opps all left the book (opps are marked "left", accounts aren't filtered) | P | — | planned | From ORG62 |
| B-088 | Completion pass spend is recorded as `scan_extract`: `ScannerStore.recordSpend` has no purpose argument, so a per-purpose budget can't cap `done_match` on its own (the global cap and a per-pass cap still apply) | P | — | planned | From DONE-CHECK; contract |
| B-089 | Completion runs reuse the cited source's connector on scope `<connector>:completion:check`: pseudo-scope cursor, `last_success_at`/`consecutive_failures` reset on finish, `scan_runs.skill_key` shows the scanning skill. Give the pass its own run kind | P | — | planned | From DONE-CHECK; contract |
| B-090 | Done-detection recall is 0–3 of 8 finished items per test day (precision 100%): the scanner never proposed some finished items and never recorded some completion messages. Re-score after REC-1 (STRESS-2) lands | P | First scan | planned | From DONE-CHECK |
| B-091 | Slack no-LLM pre-check before a channel traversal: one read-only call per channel (is anything newer than the cursor?) decides whether the agent runs at all, so a quiet channel costs no model turn. Slack is most of the steady-state spend ($0.34–0.86/day, `npm run scan:report`) | P | — | done | From COST-1 (lane G) · Done (lane D, audit 2026-11-13, D5): `src/scanner/precheck/slack.ts`, the inbox and channels before every scheduled poll; only a positive "No results found." skips the traversal; each skip is an `llm_decisions` row (`precheck_empty`) |
| B-092 | Health ▸ Spend: break today's spend down by model and by skill, like `scan:report` does now (`scanReport().spend.byModel` / `bySkill`, SPEND-1) | P | — | done | From COST-1 · Done (lane D, D0): Health ▸ Spend ▸ Spend & decisions, by day, skill, model and trigger, with cache tokens, decisions and CSV |
| B-093 | Token counts from callers that know them: `ScannerStore.recordSpend` (src/scanner/types.ts) takes no tokens, so the completion pass and the reconciler book theirs without. The DB store now accepts `inputTokens`/`outputTokens`; widen the interface and pass them | P | — | done | From COST-1; contract, with B-088 · Done (lane D, D0): the interface takes tokens, cache tokens and per-model usage; the completion pass and briefs pass theirs |
| B-094 | Claude-sessions scans run once per session hook event: in one day with many parallel sessions, 3142 hook-triggered `claude_sessions` runs cost $6.03, the top scanner line (Slack's scheduled runs: $2.46). Coalesce hook triggers per session (a debounce, or one run per window) | P | — | done | From COST-1 live `scan:report` (Nov 11) · Done (COST-2, 1.0.0): file-watch scans run at most once per 5 min (`CC_CLAUDE_WATCH_MIN_S`); changes in between join the queued scan |
| B-095 | Applied chat proposal cards show two receipts (one from the card, one from the change set). Repro: Assistant ▸ any staged change ▸ Apply. Existed before lane F | P | — | idea | Found by lane F, 1.0.0 crawl |
| B-096 | A chat proposal card's left column wraps "2 changes from chat" onto several lines at 1440 with the panel open. Repro: stage 2 changes, Apply, look at the receipt column | P | — | idea | Lane F |
| B-097 | Users who saved Assistant settings before 1.0.0 keep 12 steps per message (the new default is 30). Needs a settings read that lifts the old stored default, not a data patch | P | — | idea | Lane F |
| B-098 | React "two children with the same key" console errors on some full page loads (not on in-app navigation). Repro: hard-reload Time ▸ Forecast or Home and watch the console; the 1.0.0 crawl's in-frame hook didn't catch them | P | — | idea | Lane A |
| B-099 | `skills/outbox-relay.md` header lists only the canvas tools though the feedback post reuses the relay | P | — | idea | Lane D |
| B-100 | Specialist AE, unverified live: a real `forecast.sync` on an AE's own records, a real model note draft, Slackbot executing UPDATE rows on `SpecialistForecast__c`, whether Sales Events accept `Duration__c` / `Meeting_Type__c` in the AE work order, and the one-opp read behind "I created it, check now" (`sfrRecordsForOppSoql`: the record SOQL plus `Opportunity__c = <id>`). Do the first AE canvas supervised | P | — | idea | Lanes A, B |
| B-101 | `npm run mcp`: the Assistant's read and stage tools over stdio for Claude Code / Desktop (staging only) | P | — | idea | Lane F, optional, not built |
| B-102 | `npm run crawl` can't drive headless Chrome on a Mac where the endpoint agent intercepts it (Playwright's bundled browser isn't installed, system Chrome hangs). The 1.0.0 crawl ran in the preview browser with an in-frame crawler instead. Install the bundled browser once (`npx playwright install chromium`) on machines that run it | P | — | idea | 1.0.0 release |
| B-103 | Account, person and search watches get no brief yet; only channel watches do (the 1.0.0 fix wired channel briefs) | P | — | idea | Brief fix |
| B-104 | Git history holds real names and one real id in 121 paths / 68 commits (`npm run scan:private`): the first push to a remote must be a fresh-history snapshot (README ▸ Sharing) | P | — | planned | Lane E |
| B-105 | Time tour for an AE opens on Forecast, so its "Onsite days" step is skipped every time and Week (where an AE's Sales Events are logged) is never toured. Repro: AE ▸ Getting started ▸ Tour Time: Time views → This week's forecast notes, no Onsite or Week step | P | — | idea | AE pass |
| B-106 | Health's event log (and the Assistant's `event_log` read) still lists errors of sources the persona has not activated (VDP `auth_needed` for an AE). The feedback diagnosis skips them since the AE pass; decide whether the log hides them too (D-55). Repro: mock, AE ▸ GET /api/v1/events/log shows `vdp auth_needed` | P | — | idea | AE pass |
| B-107 | Time ▸ Week's activity log keeps the Task type column for an AE (since the AE pass its rows read "Not needed", never amber); hide the column for a persona whose Events carry no task type. Repro: AE ▸ Time ▸ Week | P | — | idea | AE pass |
| B-108 | Mock only: the placeholder seed's needs-input row says "Needs an opp (WhatId) and a task type" for an AE too (seed text; the live engine writes no task-type issue). Repro: mock, AE ▸ Home ▸ Log & fix ▸ "Resolve 1 needs-input row" | P | — | idea | AE pass |
| B-109 | Mock only: "No Specialist Forecast" rows have no Org62 link (the placeholder opps carry no `org62Url`), so the handoff reads as text. Repro: mock, AE ▸ Time ▸ Forecast ▸ No Specialist Forecast | P | — | idea | AE pass |
| B-110 | A dry-run Apply of a forecast canvas leaves it under "Waiting for your Apply" with no sign on Time ▸ Forecast that it rendered (only the panel's "Dry run: payload rendered" until it closes). Show "Dry run rendered" on the waiting row, as the Assistant's card does. Repro: dry run on, Stage 1 note, Apply, close the panel | P | — | idea | AE pass |
| B-111 | Deals pipeline: no ACV on the mirrored opp. `scan-org62` reads `Amount` only (no ACV or product-line field on the Opportunity rows), so an SE's summary and chart sum `Opportunity.Amount` at 100% and say so. Read the org's ACV field (and the D360 line amount the sweep already has) if the pipe should be ACV, and add the optional "weighted by my DC split" toggle (the rows carry `dcSplit`) | P | — | idea | Deals summary lane (src/server/deals/pipeline.ts) |
| B-112 | Deals pipeline for an AE: `forecast.sync` reads this and next fiscal quarter only, so the AE's chart has nothing for the 2 quarters after next, and last quarter's wins show only for records read before the quarter ended (kept with `goneAt`). Widen the fixed read-only SOQL to the previous quarter plus the next 3 if the AE wants the whole view | P | — | idea | Deals summary lane; the chart notes it |
| B-113 | Next step on opps only the daily book read has seen: the book query (scan-org62 B1) selects no `NextStep`, so an opp unchanged since the first scan's window has an unknown next step. Deals marks those (`Opportunity.nextStepRead` false) and never flags them for a missing one; add `Opportunity.NextStep` to the B1 / B1o book queries so every open opp's next step is read | P | — | idea | Deals summary lane |
| B-114 | Compliance "remove me": an open opp where I'm on the team or hold a DC, with no covered AE on it, no evidence in two quarters and no manager-requested marker, is suggested for removal as a draft handoff (never a write). From the app's early broad reach | T | — | idea | Low priority (owner); [review 03](reviews/2026-11-23-activity-ux/03-dc-engine-flex.md) §5, D-103 |
| B-115 | DC comment UPDATE row on the logging canvas (Slackbot updates `Deal_Contribution__c.Comments__c`); verify live as B-100 did for SFR updates | P | — | idea | Needed by D-103 (b) / chunk 6 |
| B-116 | Coverage learned from Slack and Calendar: "OOO", "cover for", "jump on a call", "SME" patterns on stored items propose a coverage row (kind ooo or sme, window, share) for Accept | P | — | idea | D-103 (a); manual Settings rows first |
| B-117 | Account-level time: confirm with SE Ops whether post-sale time (no open opp) logs as a Solutions Event on the Account WhatId (`001…`, what the code does) or by another mechanism (`what_kind` reserves `dsr`, `strategic_initiative`) | T | — | idea | Review 03 J-2 |
| B-118 | One dismissal memory for the missed-opp sweep, DC gaps and DC suggestions; a dismissed missed-opp finding never returns today | P | — | done 2026-11-23 | D-103 (d), chunk 3 (`src/engines/attribution/resurface.ts`) |
| B-119 | Engine versions everywhere (ENGINES.md rule 9), size S, 0 tokens: stamp `attribution@1`, `dc@N`, `home@1` and the Assistant router's version on outputs beside their constants; a constants snapshot test fails when a weight or threshold changes without a version bump and a `docs/engines/CHANGELOG.md` line | P | — | idea | [Audit 04](reviews/2026-11-23-activity-ux/04-engines-audit.md); D-103 (f) generalised. 1 of 8 by value per token |
| B-120 | Channel briefs check their inputs fingerprint before the model call, not after (`brief.ts:361`): an unchanged channel costs 0 tokens; the 07:30 slot stays as the trigger. Size S | P | — | idea | Audit 04, rule 2. 2 of 8 |
| B-121 | Scanner interpret skips a unit whose content hash equals the last verified run (`src/scanner/interpret/runner.ts:87,94` records it, nothing reads it), for every fetch-then-interpret source, not only Slack's precheck. Size M | P | — | idea | Audit 04, rule 2. 3 of 8 |
| B-122 | Coverage feeds "who matters": `coverageOf()` / covered-AE rows become a people-tier input for priority (`src/engines/priority/inputs.ts:101-102`) and the inbox read-in's triage, so a covered AE's ask ranks like a known stakeholder's. Size S, 0 tokens. After D-103 chunk 1 | P | — | idea | Audit 04, D-103 carry-over 1. 4 of 8 |
| B-123 | One governor hold per job for the spenders that skip it: `resolution.check` (day gate only, `resolution-check.ts:247`), `vdp.identity` (`vdp-identity.ts:3-5`), voice synthesis (`src/engines/voice/synthesize.ts:10`) and Settle's own allowance. Size S | P | — | idea | Audit 04, rule 7 (D-80). 5 of 8 |
| B-124 | One resurface rule (D-103 d's `resurfaced(baseline, now)`) for use-case rejects (`src/engines/use-cases/plan.ts:90-91`) and VDP autopilot failures, each engine declaring the facts that bring an item back. Size S, 0 tokens. After D-103 chunk 3 | P | — | idea | Audit 04, rule 6. 6 of 8 |
| B-125 | Facts as data: `READIN_MODEL` becomes a tier (`src/llm/readin/prompt.ts:16`); the priority starter policy loses its person label (`policy.ts:285`); the resolution windows (`triggers.ts:21-24`), `STRONG_ASSET_AT` (`vdp/autopilot.ts:33`) and `CONFIDENCE_FLOOR` (`interpret/schema.ts:85`) become persona or Settings thresholds with today's defaults. Size S | P | — | idea | Audit 04, rule 1. 7 of 8 |
| B-126 | A shared `engine_events` bus and the why fold's event trail for every engine (not only DCs): VDP autopilot's 30-min poll (`vdp-autopilot.ts:2-3`) and the nightly attribution rebuild become events plus a 0-token safety net. Size M. Waits on D-103 (e) being accepted | P | — | idea | Audit 04, D-103 carry-overs 2-3. 8 of 8 |
| B-127 | "DCs on all N" from the rundown (D-103 (c) item 5): when a row's top candidates are N opps of one account, one confirm on the rundown keeps the hours on the chosen opp and creates N approved DC requests (one change set, Undo as one) for the next logging canvas. Size S. Not built in DC4 | P | — | idea | [Review 03](reviews/2026-11-23-activity-ux/03-dc-engine-flex.md) §c item 5, chunk 4; review 05 G4 |
| B-128 | The kit's one-column relayout workaround: `useRelayoutOnSwitch` in `src/components/kit/LanePage.tsx` hides and shows each lane body on a panel switch so rows reappear (R3-1, G1). Find the root cause, likely the `display: contents` columns with the `@container/lane` query not re-evaluating when the column count flips, and fix it in CSS so the hook can go. Size S | P | — | idea | Review 05 R3-1, G1 (6eeace7) |
