# Scanner spec (binding for BE-1, BE-2 and BE-3)

**Status:** v1, 2026-11-05. The orchestrator owns this file. It implements R-BE-2…4 as the owner described them. Where it differs from research brief 09, **this file wins**. Brief 09 is still the reference for measured costs, tool names, auth and the restricted-MCP technique: `~/Projects/command-center/docs/research/09-headless-sources-spike.md`.

## 1. What the owner asked for

The scanner is mostly **Haiku**, driven by **very prescriptive skills**. Each skill says exactly how to traverse its app, find new information, and **record it against the right thing in the database**.

The scanner:
- knows **when it last scanned and what it scanned**, so it can resume, notice misses, and fix things that weren't connected;
- runs **as part of the app** (the worker), not as a scheduled Claude task;
- is often up, and **when it restarts, it picks up where it left off**.

Smarter work (NBA, drafts) uses a higher tier.

## 2. Shape

```
worker (always-on Node process, part of the app)
 └─ Scheduler ── due? ──► ScanJob(connector, scope)   (Postgres job queue, one active job per connector)
                           │
                           ├─ 1. Context pack (deterministic): cursor, coverage gaps, watch list,
                           │     account/channel alias map, compact digest of OPEN items + initiatives
                           │
                           ├─ 2. Fetch (fetch then interpret, the default: code reads every source, §11)
                           │     • traversal sources (Slack, Org62): the Haiku agent calls the source's READ tools itself (`CC_SCAN_MODE=agentic`)
                           │     • deterministic sources (Gmail/Calendar/Drive via devbar google_workspace_readonly,
                           │       Claude sessions via local files): code fetches; the agent gets normalized items
                           │
                           ├─ 3. Haiku scanner agent (Agent SDK, skill = skills/scan-<source>.md)
                           │     tools = that source's read tools (traversal sources only) + in-process `cc` tools
                           │     records everything through `cc` tools (validated, audited, idempotent)
                           │
                           ├─ 4. Commit: coverage + cursor advance in ONE transaction (only on success)
                           │
                           └─ 5. Fan-out: each touched work item → enqueue reevaluate(item) (BE-3; generation/cancel)
```

### 2.1 Why the fetch is hybrid

Slack and Org62 need **judgment while traversing**:
- which threads to open;
- whether to follow a link to a Drive file or email;
- when a thread reply is a completion signal;
- which opp changed in a way that matters.

So the Haiku agent drives those tools, as the owner described. The Google sources and Claude sessions have no OAuth hop through Claude. Listing "changed since the cursor" there is mechanical, so code fetches them, which is cheaper and exact. The **same skill-driven Haiku agent** still does the reading, extraction and linking for every source. No source bypasses the agent's judgment about what the information means and where it belongs.

## 3. The `cc` tools: how the agent writes to the database

These are in-process MCP tools (`createSdkMcpServer`) in `src/llm/cc-tools/`.
- Every input is **zod-validated**.
- Every write runs inside a **change set** (DATA-MODEL §3.3) with actor `scanner:<connector>`, so it's audited and undoable.
- Every write is **idempotent**, keyed by the source's dedupe key.

The agent never writes SQL and never sees other users' data.

| Tool | Purpose |
|---|---|
| `cc_get_context()` | Cursor, coverage gaps, watch list, alias maps, and a compact digest of open work items and initiatives (id, title, purpose, people, accounts, keywords, last evidence). Cached per run |
| `cc_record_source_items(items[])` | Upsert normalized raw items (source, external id, dedupe key, content hash, timestamps, author, permalink, redacted excerpt, raw payload ref). Returns `{id, isNew, changed}` |
| `cc_find_candidates({text, people, accounts, files, threadRefs})` | Ranked candidate work items and initiatives to link to (FTS + alias + thread/file joins) |
| `cc_link_evidence({workItemId, sourceItemId, role, confidence, reason})` | Role is one of `origin`, `progress`, `completion`, `context`, `contradiction`. **The scanner emits signals. It never sets item state.** BE-3's closure and state machine turn signals into transitions |
| `cc_propose_item({kind, title, purpose, due?, effort?, initiativeId?, accountId?, oppId?, evidence[], confidence})` | A new ask, commitment, follow-up, training or deliverable. `sure` lands open, `likely` lands open with a "new" badge, and `guess` goes to Triage (as `suggested`) |
| `cc_propose_initiative({...})` | Only when nothing matches and three or more items cluster |
| `cc_flag_unlinked({sourceItemId, reason, hints})` | Relevant but no confident home. Feeds reconcile (§6) and Triage mapping questions |
| `cc_report_coverage({windows[], objects[], notes})` | **What was scanned**: channel/thread ids with ts ranges, message ids, file ids with modifiedTime, SOQL windows. Written to the scan ledger |
| `cc_finish({cursor, summary, stats})` | Proposes the new cursor. **The worker commits cursor + coverage atomically after validating** that coverage spans up to the cursor |

Budget and safety guards:
- `maxTurns` per run;
- per-run cost cap;
- read-only tool allowlist;
- the run aborts on any attempt to call a non-allowlisted tool.

## 4. Skills: prescriptive and versioned

Each skill is a markdown file at `skills/scan-<source>.md` with a `version` in its frontmatter. The version is stored on every scan run and evidence row, so improved skills can trigger re-linking. Every skill **must** spell out:

1. **Scope:** exactly which objects to look at, for example Slack:
   - DMs and group DMs;
   - @mentions;
   - threads the owner is in;
   - his own messages;
   - channels on the watch list;
   - customer channels mapped to his accounts.
2. **Exact tool calls:** the tool names, parameters and query strings, with the cursor substituted (e.g. `from:<@me> after:<date>`, and how to page).
3. **Traversal rules:**
   - when to open a thread;
   - when to follow a link to Drive or Gmail (record a reference only, don't fetch, unless the skill says so);
   - depth limits;
   - what to skip (bots, noisy channels, unless watched).
4. **Extraction rules:**
   - what counts as an **ask of me**;
   - what counts as **my commitment**, with phrase patterns ("I'll", "I will", "let me", "on it", "will send", "by EOD");
   - what counts as a **completion signal** (my reply after an ask, "sent", "done", a file shared, a deck link);
   - what counts as a **requirements change** (reopen / new sibling, R-UI-20);
   - meeting takeaways and training notices.
5. **Linking rules:** how to pick the work item or initiative. **Handed-off items (R-UI-22):** if the candidate is resolved as `handed_off`, or my involvement is watcher or not involved, link new evidence as `context` only and propose nothing. **Exception:** a **direct ask of me** (DM, @mention or explicit question to me) gets a `loop_back` signal. Record it with `cc_link_evidence` role `origin` and reason prefix `loop_back:`. BE-3 then reopens the item or opens a sibling labeled "Looped back in". The candidate digest therefore includes `resolution` and `involvement`.
   1. thread/file join;
   2. people + account + keyword match from `cc_find_candidates`;
   3. otherwise propose, or flag unlinked.

   Include confidence wording.
6. **Redaction:** mask credential-like text before it goes into `cc_record_source_items`.
7. **Stop condition and coverage:** report exactly what was covered.
8. **Worked examples:** 3–5 real-shaped examples with placeholders, including a Slack promise later closed by email and a "said done in Slack → completion" case.

The required skills are:
- `scan-slack`
- `scan-org62` (opp changes on my accounts, my Solutions Events, DCs, and the missed-opp candidates for R-UI-14)
- `scan-gmail`
- `scan-calendar` (attendance: attended or missed, and meetings that just ended, which schedules the Gemini-notes poll)
- `scan-gemini-notes`
- `scan-drive` (forward sampling: digest per slide or section, diff, then "were the requested updates made" against each linked deliverable's `expected changes`, R-UI-15)
- `scan-claude-sessions` (registry status plus transcript tail; the `[cc:<id>]` tag links sessions the app launched)
- `scan-trainings`
- `scan-watch` (channel briefs input, R-UI-21)
- `triage-slack` (the Slack triage pass below; not a traversal)

### 4.10 Slack: record from the tool result, then triage (STRESS-2)

- **REC-1, record what the tools return.** For Slack traversal runs the runner (`src/llm/slack-rec.ts`) parses every search page, thread read and channel read the agent gets back. It records each message, deduped by channel and ts, before the model sees the result: a PostToolUse hook, with a stream fallback. Thread and channel reads are forced to the detailed format, because the concise one has no ts. The Run block says `slack.rec = auto`, and scan-slack 1.3.0 then makes no `cc_record_source_items` calls. The agent cites a message as `<channelId>:<ts>` wherever a `sourceItemId` is expected. An agent re-record of a recorded message returns the same id and keeps the verbatim version. Redaction (R6) and the 1000-character excerpt cap still apply. This adds no model cost: the agent no longer transcribes messages.
- **Triage pass.** After a successful Slack traversal, `src/scanner/triage/slack-triage.ts` selects every message recorded in the run that is to me, from me, or in a DM, group DM or thread I'm in. It drops trivial acknowledgements and emoji, and messages the traversal already proposed or linked; those stay as context. The selected messages are grouped by conversation, in time order, into batches of 10 that need a verdict, at most 12 batches per run. Each batch is one Haiku run of `skills/triage-slack.md`. It gets no Slack tools and only these cc tools: `cc_find_candidates`, `cc_link_evidence`, `cc_propose_item`, `cc_flag_unlinked` and `cc_triage_verdicts`. It does no recording, reports no coverage and makes no `cc_finish` call. It gives every listed message one verdict: `act` (proposed or linked), `noise` or `unsure`. The checklist and examples come from the real misses: indirect asks (a pasted error, "a PR you can merge"), group-DM asks, takeaways in group DMs, my promises in channel thread replies, and direct questions. It also lists the noise to leave alone: musings like "maybe we should…" or "it would be cool if…", asks of someone else, and thanks. Since 1.1.0 (TRI-1), each line carries its addressee: `→ me` for a 1:1 DM, an @-mention or my name, and `→ NAME (not me)` when the message opens with someone else's name or @-mention. Group-DM messages count as to me only when they mention me. In a group DM or channel, an ask is mine only if it addresses me. Chat pings, quick logistics, favors and agenda lines are noise. When torn between act and noise, the pass says `unsure`. Version 1.2.0 adds two more noise cases: live meeting chatter (a hand-off during a demo, "what is at 3pm?") and someone's status on their own blocker when they ask nothing of me.
- **Escalation.** `unsure` lines, and lines left with neither a verdict nor an outcome, go to Sonnet in the same conversation batches, with the first pass's reason. The verdict there is final: `act` or `noise`. When escalation is off, those lines are flagged unlinked instead, with reason `triage: unsure: …`. Writes are tagged in their reason (`triage:` / `escalate:`), and the runner returns per-pass stats (`passes`: runs, cost, messages, verdicts, proposed, linked). A triage failure never fails the traversal run.
- **Switches** (all on by default): `CC_SLACK_REC=0`, `CC_SLACK_TRIAGE=0` and `CC_SLACK_ESCALATE=0`. The spec fields are `autoRecord` and `triage`.
- **Context, addressees and carried verdicts (triage-slack 1.3.0, scan-slack 1.4.0).** See §4.11.

### 4.11 First-scan noise fixes (lane 5 of the settle plan)

A 30-day first scan passed every coverage check, but only 26% of its open items were real and live. These rules cut what creates the noise. Placeholder tests: `tests/db/scanner/scanner-noise.test.ts`, `tests/scanner/stress/rec1-triage.test.ts`, `tests/scanner/stress/first-scan.test.ts`.

- **Order (FS-ORDER).** The first scan backfills oldest to newest with no head hour (§5.6), so an ask is recorded before the reply that settles it.
- **Triage sees the conversation (TRI-CTX).** Besides this run's lines, each conversation in a batch gets up to 6 earlier lines (before this run's first one) and up to 4 later replies from `source_items`, whatever run or window recorded them (`conversationLines`). They show as `context (earlier)`, never as `VERDICT`.
- **Addressee continuation (TRI-2).** Who a message is for is read over the conversation, not one message at a time: explicit addressing wins; an unaddressed reply right after someone addressed its author goes back to that person, and an unaddressed follow-on by the same author keeps that author's addressee. So a follow-on in someone else's two-way exchange shows `→ NAME (not me: continues their exchange)`, and a reply right after my message shows `→ me (replies to my message)`. 1:1 DMs are always between me and them.
- **Group asks (TRI-3).** `<!channel>`, `<!here>`, `<!everyone>` and lists (me among three or more @-mentions) show as `→ everyone` or `→ me and N others (a list)`. Settings ▸ Scanning decides what they become (below).
- **Carried verdicts (TRI-NOISE).** Each triage verdict is stored on its message (`source_items.meta.triage`; an edit replaces the meta, so an edited message is judged again). A later run treats a message an earlier run called noise, or one already linked by non-context evidence, as handled (`done: noise:earlier run`, `done: linked:earlier run`).
- **Skill rules.** An ask I clearly answered or delivered in the same thread or DM is not a new item (link my answer as `completion` to an open item, else nothing). My own asks of others are not my items. An unaddressed follow-on in someone else's exchange is theirs (checklist 3, worked example T3). `_scanner-common` 1.1.0: my clear answer in the ask's own thread or DM is `sure`, not `likely`; `cc_flag_unlinked` is for asks and commitments of mine only. Gemini notes 2: no keyword-only "Catch up:" items. Org62 1.5.0 and Calendar 2: "Get up to speed" and missed-meeting catch-ups only when switched on.
- **Enforced in the cc tools (`proposalGate`).** Whatever the model does: an `ask` whose origin is my own message is skipped (NOT-MINE); a group ask lands `guess` (Triage) under "Ask me", is skipped under "Ignore"; "Catch up…" (Gemini notes, Calendar) and "Get up to speed…" (Org62) proposals are skipped while their setting is off. A skipped proposal returns `{w: null, skipped: <why>}`.
- **Due dates (DUE-1).** A bare date (`2026-11-04`) is 17:00 in my timezone, and a date-time without a zone is read there too (`src/scanner/propose-rules.ts`). Before, it was UTC midnight: the evening before, so items were due before they were asked.
- **Due already past when found (PAST-1).** An item whose due date was more than 2 h past when it was first seen lands like DEEP-1, in Triage as "Still needed?", with the reason "Due 2026-10-20, already past when it was found: still needed?". Trainings keep TRAIN-1's rule.
- **Duplicates (DUP-1).** Besides an identical origin, a proposal is the item already there when its origin is in the same conversation (DM or group DM, else thread), from the same person (me for my commitments), and the titles share at least two words covering half of the shorter one (the person's name aside). Open items match at any age; done, dismissed and merged ones only within 14 days, and those get the new evidence as `context` only.
- **Completion pass over suggested items (CMP-SUG).** `completionItems` now includes `suggested`, so an ask already answered can be found settled without a click. The closure engine keeps a suggested item in Triage with the evidence attached; the Settle pass decides what closes.
- **People (PPL-1).** Recording resolves each author to a person: me; a known Slack or email identity; a directory email. A Slack author nobody knows yet gets a person row with the Slack identity, hidden from the directory (`synthetic`, like any referenced person outside it). `source_items.actor_person_id` was empty on every Slack item before.
- **Redaction (RED-1, tenet: Local data, privacy-safe logs).** Both redactors mask password-manager share links (1Password, Bitwarden Send, Keeper, One-Time Secret, Password Pusher, Privnote, LastPass, Dashlane) and login lines ("login: x / secret", "username: x" then "p: y" on the next line). A ref that redaction would change is never stored in `source_item_refs` nor passed on as a file ref. `scripts/db/scrub-credentials.ts` re-redacts existing rows: dry run by default (counts only), `--apply` writes one undoable change set.
- **Settings ▸ Scanning (SCAN-SET).** `settings.scanning`, read on every context and shown to the skills as `{{scan.channelAsks}}`, `{{scan.meetingCatchUps}}` and `{{scan.oppTeamCatchUps}}`:
  - asks to a whole channel or a list: **Ask me** (default, Triage), Treat as mine, Ignore;
  - missed-meeting catch-ups: **off**;
  - "Get up to speed" on opp-team adds: **off**;
  - "Where does this belong?": **only my asks and commitments** (default), anything unlinked, or never (§6).

### 4.9 Completion pass (CMP-1)

The scanning skills almost never emit `completion` (stress finding CMP-1, `docs/archive/2026-build/STRESS.md`: 0–1 correct completion links per run against 10–11 expected, and rewording `scan-slack` did not move it). So completion is judged by a **separate pass, a model check per item**, after the scans. Code: `src/scanner/completion/`, the job `src/jobs/handlers/completion.ts`, the skill `skills/check-completion.md`.

1. **Candidates (deterministic, no model).** For each open item that is mine (open, in progress, waiting, likely done; involvement owner or contributor; not owned by someone else), the source items that **arrived since its last check** (first seen, or edited) and **happened after the ask**:

   | Relation | What | Strength |
   |---|---|---|
   | `same_thread` · `same_dm` · `same_email_thread` | the Slack thread, Slack DM or group DM, or Gmail thread of its non-context evidence | strong |
   | `to_asker` · `from_asker` | my message or email to the asker anywhere; the asker writing in one of those places or to me directly | medium |
   | `same_channel` · `context_thread` | my or the asker's message in the same channel; a thread the item has only context evidence in | medium |
   | `same_file` · `same_event` | a revision of, or a link to, a Drive file it references; its calendar event changing, or an event I scheduled with the asker | medium |
   | `same_account` | my message on its account that shares two title keywords | weak |

   Only Slack, Gmail, Calendar and Drive items are candidates (notes, Org62 and sessions have their own signals), at most 6 per item, strongest first. **Items without candidates cost nothing**: most passes make no call.
2. **Model check.** One tool-less, one-turn call per batch of up to 6 items on the cheapest tier (Haiku 5.5; `check-completion` 1.2.0 runs at medium effort; about 3 K input tokens and $0.0009 a call). Per item it gets the title, kind, purpose, due date, asker, the ask itself, and each candidate's author (me / name), time, relation and text; ids are aliases (`w1`, `s1`), so a reply can only cite a candidate of the same item. It first names the one outcome the **title** needs, then answers `done`, `partial` or `not_done` with the cited candidate, a **basis** (`delivered`, `confirmed`, `done_by_other`, `pointer`, `partial`, `none`), a confidence and a reason of at most 15 words. Promises and offers ("I'll", "I can", "on it") are never done; a message that finishes another ask of the same person is not done for this item.
3. **Gate, then write.** The pass emits signals and never sets item state.

   | Verdict | Evidence |
   |---|---|
   | done, basis `delivered`, the cited message is **mine**, in the item's **own conversation** (strong), confidence ≥ the skill's `sure_min_confidence` (1.2.0: 0.8) | `completion`, **Sure** |
   | done otherwise (basis not `none` / `partial`), confidence ≥ 0.7 | `completion`, Likely |
   | partial, confidence ≥ 0.6 | `progress`, Likely |
   | anything else | nothing |

   One message judged to finish two items (the same person often has several asks in one DM) is never Sure for either. Each skill version carries its own calibration in its frontmatter (`sure_basis`, `sure_min_confidence`, `likely_min_confidence`, `partial_min_confidence`): Haiku 5.5 rarely states more than 0.85, so 1.0.0's bare 0.9 never fired, and the categorical basis is what makes a lower number safe. Evidence is written with `linkEvidence` (`cc_link_evidence` semantics) inside a zero-length run on `<connector>:completion:check` of the cited source (trigger `reconcile`, like reconcile's relink runs; the run and its extractor carry `check-completion@<version>`), with the reason prefix **`done_check:`**. The W2 bump queues `reevaluate`, and the closure machine decides under its usual rules (ENGINES §3): Sure → done ("Closed for you · Undo"), Likely → "Likely done · Confirm", progress → in progress; a Drive source never closes on its own.
4. **Scheduling.** Job `completion.check` on queue `completion` (concurrency 1), one queued job per user (`completion.check:<user>`). It is queued after a scan run that stored new or changed items or touched work items (the scan `afterRun` hook in `src/worker/scanning.ts`; on by default only with LLM linking and the real skill runner), at worker start and on wake (catch-up after downtime). It reads its window when it runs: from the last pass's watermark (`jobs.result.watermark`: `through` = now − 60 s, so a scan still committing is not skipped, plus items left pending) to now. An item never checked looks back to its own ask (at most 14 days). A pass sends at most 48 items and spends at most $0.40; the rest stay pending and a follow-up pass is queued.
5. **Budget and spend.** Before every call the global daily hard cap is checked (`budgetStatus`: `user_settings.budgets`, else the `llm_budgets` total). At the cap nothing is called and the items stay pending for the next budget day. Each call is recorded with `recordSpend` against its completion run. `jobs.result` holds counts, ids and codes; message texts and model reasons never enter logs or job results.

Measured on the stress blocks: `docs/archive/2026-build/STRESS.md` §4.6.

### 4.11 Settle pass (SETTLE-1)

The scanner judges one window at a time, so on a first scan most items arrive already settled: the 30-day scan of
Nov 6 left 308 items open or suggested, of which the answer key (§ FIRST-SCAN-RAMP §7) says 16 were still owed. The
Settle pass judges each item **once, with everything recorded around it**, and closes what is finished.

1. **When.** After the first scan is done (`first-scan.json` status `done`), one pass judges every live or suggested
   item (budget `first_scan`). Afterwards a pass every ten minutes (`settle` hook → `settle.check`, queue `settle`,
   concurrency 1) judges only what changed since the last one: new non-engine evidence, new messages in the item's
   Slack conversation or email thread, a due date that passed. The watermark is the latest succeeded job's
   `result.through`; a pass stopped by its cost cap ($5 first pass, $1 later) keeps the old watermark.
2. **Context pack** (`src/engines/settle/load-db.ts`, `context.ts`; deterministic, no tools, no live reads):
   - the ask (earliest origin), up to six lines before it in the same conversation (who was talking to whom), and
     every line after it in the same thread / DM / email thread, **oldest first**. A long DM keeps its first 20, last
     8, and the middle lines that mention the topic or come from me or the asker;
   - `elsewhere`: up to 14 lines after the ask outside the conversation, scored by topic words, DMs with the people
     involved (the asker, the counterparty, people named in the title, small-group participants; names come from Slack
     authors and participants, emails from email senders and calendar attendees), my first messages to them, and
     nearness to the ask;
   - `events`: up to 8 calendar events from a day before the ask to two days ahead, on the topic or with those people,
     each marked passed or not, with my response;
   - `siblings`: items from the same conversation and items with a similar title within three weeks;
   - hints computed in code (age when first seen, due before first seen, my replies after the ask, the asker's, the
     first reply's delay, mass mail, my invite response).
3. **Model.** `skills/settle-item.md`, one tool-less Haiku call per item (`agentSdkCompletionModel`, the completion
   pass's seam), about $0.0015 an item. Output: one verdict of `duplicate`, `not_an_ask`, `not_yours`, `done_by_you`,
   `resolved_by_other`, `handed_off`, `superseded`, `moment_passed`, `gone_quiet`, `still_yours`; a confidence; one cited
   line; a reason under 20 words in the second person. The parser enforces the citation rules (`done_by_you` cites my
   line after the ask, `resolved_by_other` someone else's, `duplicate` a sibling); a broken rule makes the verdict
   invalid, and the policy never acts on it.
4. **Policy** (`src/engines/settle/policy.ts`, Settings ▸ Closing work, `ClosingSettings`): per reason Close for me / Ask
   me / Leave open, a strictness (minimum confidence), ask-first lists (external commitments, people, channels) and the
   user's own rules (added to the prompt; the skill itself is fixed and versioned). An item the user reopened is never
   closed again; one the user touched is only asked about. Ask = Looks done (done kinds) or Still needed? (the rest); a
   suggestion that is confidently still mine goes back to open work.
5. **Writes** (`DbDataSource.settleApply`): one engine change set per item, so each close has its own Undo. The cited
   message is linked as evidence (`settle: <verdict>: <reason>`, role `completion` for the done kinds, `context`
   otherwise); `resolutionDetail.settle` keeps the reason class, confidence, the message link and the skill version
   for the Auto-closed list. Spend is recorded in `llm_calls` (purpose `done_match`, skill `settle-item`).
6. **Tools.** `scripts/settle/dry-run.ts` (judge, save JSON, write nothing), `scripts/settle/score.ts` (against the
   private answer key: buckets, per-reason precision by threshold, and a policy simulation counting wrong closes and
   the clicks left), `scripts/settle/context-check.ts` (does the pack include the deciding message; no model calls).

### 4.12 Resolution check (H-7: one closer, shadow first)

The completion pass (§4.9) and Settle (§4.11) answer the same question with two rule sets and two packs. The resolution
check (`src/engines/resolution`, job `resolution.check`, queue `settle`) is the one closer that replaces both. It ships
behind `settings.closing.resolutionEngine`:

| Mode | The resolution check | The completion pass and Settle |
|---|---|---|
| `shadow` (1.x default) | runs and records one `closure_checks` row per check; writes nothing else | act as before |
| `live` | applies its outcomes | the completion pass hands its items to the check (no model call); Settle selects nothing (their code stays until the next major) |
| `legacy` | does not run | act as before |

1. **Triggers** (`src/scanner/resolution/triggers.ts`, rules; `triggers-db.ts`, after every scan run commits): a new
   line in the item's conversation (Slack thread or DM, mail thread) or my line to the asker anywhere; a revision or
   share of its file; Gemini notes naming it; a Claude session touching it; new non-engine evidence; the asker gone quiet
   past the item's window (`isQuiet`); and the nightly sweep at 03:40 for items with no check in 7 days. One job per
   item per 10 minutes (an idempotency key per bucket); the job takes up to 7 other queued item checks with it, so items
   sharing a conversation share one model call. A **closed** item (closed for me, inside the reopen window) is checked
   again only for a line from the asker addressed to me, or a line naming the deliverable, once a day; DM chatter never
   re-judges it (wave-0 review W0-2; the legacy Settle selection applies the same filter).
2. **Pack** (`pack.ts`, over Settle's `buildSettleContext`): the ask, the lines before it, every line after it in the
   same conversation (mine included; the asker's acknowledgement after my line tagged `ack`, a chase tagged `chase`),
   my lines to the asker and theirs to me elsewhere plus lines naming the deliverable, the file's revisions and shares,
   notes, sessions, events, siblings, the rules' hints and the last check. Capped at 2,500 tokens: siblings, events,
   lines before the ask, unrelated elsewhere lines and the middle of a long conversation go first; the ask, my lines,
   the asker's lines and the item's own evidence never do (the eval "pack completeness" asserts the deciding line stays
   in at 300 tokens). The pack is never stored: `closure_checks` keeps its digest and size.
3. **Ladder** (`ladder.ts`): rules D1–D6 first (`src/scanner/resolution/rules.ts`; a rule that decides needs no model;
   D6 skips when nothing is new); then one tool-less Haiku call (`skills/resolve-item.md`, the skill body as the cached
   system prefix, nothing but the packs as the prompt, up to 8 items per call when they share a conversation); then the
   stronger model for one item only when the cheap verdict would change state and is unsure (confidence in [0.5, 0.8),
   a broken citation, or it contradicts the hints, such as a done after a chase), and the item is worth it (a deal of
   $50K or more, or an asker tiered leader, manager, AE, customer or customer exec). The escalation is data-gated: over
   the last 14 days, a reason whose escalations changed under 20 % of verdicts (`llm_calls.escalation_changed_items`,
   at least 10 samples) stops escalating.
4. **Outcome** (`outcome.ts`), no new status vocabulary: a done citing a line becomes `completion` evidence that the
   closure machine judges (`applySignal`, R1's `mayAutoClose` inside: closed, or Likely done when corrected or when it
   is a file edit); a partial becomes `progress`; a chase after a close for me becomes a `follow_up:` contradiction (the
   machine reopens it); everything else goes through Settle's policy (`decideSettle`: close, ask, wait or leave).
   Reopen brakes (W0-4), in the machine too: after a follow-up reopen only evidence newer than the reopen can close it;
   after two reopens it is ask-only (`blocked_by: reopened_twice`).
5. **Ledger** (`closure_checks`, migration 0031): item, trigger, mode, status before, pack digest, tokens and lines,
   rules fired and the deciding one, verdict, basis, confidence, cited line, escalation (reason, changed), outcome
   (`closed`, `likely`, `asked`, `left`, `reopened`), what blocked a close, model, cost, tokens, the booked call, duration
   and engine version. Ids, codes and numbers only. Every call is booked in `llm_calls` (skill `resolve-item`, items in;
   an escalation links the cheap call and says whether it changed the verdict).
6. **Recall sweep** (SCN-1, `src/scanner/resolution/recall.ts`): every 30 minutes after a Slack run, up to 25 channel
   threads where I posted or was mentioned in the last 14 days, quiet in the store for 30 minutes, are re-read with the
   allowlisted `slack_read_thread` from the last recorded ts (the one-call read path) and recorded through REC-1, so a
   thread reply to me without a mention becomes an item. DMs need no sweep (S1 returns them).
7. **Seeing it.** Item ▸ "Why is this still open?" (the last checks in plain words, the line cited, what triggers the
   next); Health ▸ the shadow line ("Resolution check agreed on 94% of 212 closes this week; would have closed 7 more,
   reopened 2"); `npm run scan:explain -- --item <id>` (the pack rebuilt now, lines without their text, every check);
   `npm run scan:report -- --yield` (resolution checks, $/check, closed, likely, asked, reopened).
8. **Evals.** `tests/evals/scanner/resolution.eval.ts` runs every golden case with the check live in the harness
   (cassettes in `tests/fixtures/scanner-golden/cassettes/resolution/`, re-keyed offline with
   `npx tsx tests/evals/scanner/record-resolution.ts`), gated like the legacy run plus a median estimated cost per
   model-judged check under $0.005.

## 5. Cursors, ledger and resume

- **Cursor** per `(connector, scope)`. The scope is, for example, `slack:dm`, `slack:mentions`, `slack:channel:<id>`, `gmail:inbox`, `drive:tracked`, `org62:opps`. Semantics per source follow brief 09 §4. The cursor only moves forward, and only in the same transaction as coverage.
- **Scan run** rows record:
  - window `[from, to]`, status, trigger (schedule, catch-up, reconcile, manual or chat `/rescan`);
  - model and skill version;
  - tokens and cost;
  - counts: fetched, new, changed, linked, proposed, unlinked.
- **Coverage ledger** rows record which objects or ranges were scanned per run. "What did we look at on Tuesday between 2 and 4 pm in #acme?" must be answerable with a single query.
- **Resume after downtime** (for example a laptop shut all weekend):
  1. On worker start, compute each scope's gap (now minus cursor).
  2. Run the **newest hour first**, so Monday morning is right quickly.
  3. Backfill older windows in chunks, for example 6 h, oldest to newest, until the gap is closed.
  4. Health shows "catching up: Slack 60%", and the UI holds re-ranks until catch-up settles (UI-SPEC §10).
  5. Interrupted runs are idempotent and simply re-run. At worker start, queued plan jobs from the cursor to now are dropped and re-planned, but queued backfill and continuation windows that lie **behind** the cursor stay queued: on a cold start the cursor is at now after the head run, so the new plan would never see them (stress finding RS-1).
  6. **First scan (B-080).** The worker's first scan covers **30 days** by default. `CC_FIRST_SCAN_LOOKBACK_DAYS` (or the worker flag `--lookback-days`) changes that, and `0` turns it off, leaving the per-connector lookback. Onboarding (B-079) will offer 7, 14, 30 or 90 days, with the estimated costs in `docs/archive/2026-build/STRESS.md`. `CC_FIRST_SCAN_BUDGET_USD` (or `--backfill-budget`, default $25 since 2026-11-13, was $100) caps that backfill's one-time budget. A first scan never shortens a connector's own lookback: Org62 keeps 30 d at a 7-day setting. Older items known by hand are injected separately after go-live. `CC_FIRST_SCAN_CONNECTORS` defaults to Slack, Gmail, Drive, Gemini notes, Org62 and Calendar.
     - **Planning (FS-ORDER).** A scope with no cursor plans from one fixed floor (first plan's `now − lookback`), past the 14-day planner cap. There is no head hour: the backfill runs **oldest → newest** up to the plan's `now`, each gap chunked forward from its start. Re-plans therefore keep the same chunk ids. An ask is recorded before the reply that settles it, so triage and the completion pass see each conversation in the order it happened; before, the backfill ran newest first and my answer was recorded before its ask existed. The cursor trails the backfill. While the first scan runs, the live loop polls only what came after the plan's end (incremental, ahead of the backfill in the queue), and the cursor fast-forwards over those polls once the backfill reaches them (S9). Slack channels backfill in 24 h chunks during the first scan.
     - **Budget.** These jobs carry `budget: 'first_scan'`, and their continuations, retries and splits keep it. They spend the one-time budget instead of the daily cap, and their spend does not count against the daily cap of regular scans.
     - **End of the budget.** It ends for good once every scope planned under it has no first-scan work left (`done`), or once it is spent (`exhausted`). After it is spent, the remaining chunks continue under the daily cap.
     - **Restarts.** State lives in `<CC_STATE_DIR>/first-scan.json` and survives restarts. A restart re-plans only the uncovered chunks (`[floor, low watermark)` plus the holes), with the same ids.
     - **Scope.** A user with history never starts a first scan, and a scope added later joins it only while the first scan is still active.
     - **Deeper per-scope lookback (FS-DEEP).** `CC_FIRST_SCAN_SCOPE_DAYS` (or `--scope-days`), for example `slack:inbox=90,gmail:inbox=90`, gives named scopes their own floor (`startedAt - days`), fixed when the scope is first claimed and kept in `first-scan.json` (`floors`). Everything else keeps the lookback. Past the shared floor the Slack inbox backfills in 6 h chunks (2 h inside it), so 60 extra days are 240 runs. Since STRESS-2's triage pass, every message gets a verdict whatever the window holds. Onboarding can offer it as a choice; the config field is `FirstScanConfig.scopeDays`.
     - **Holes (FS-2).** A scope is done only when its first-scan span (floor to the plan's end) has no holes. A window that failed for good leaves the scope pending, and its holes are re-planned under the first-scan budget after 30 min, 1 h and 2 h; after three rounds the scope is done and the rest is left to reconcile.
     - **Calendar (FS-CAL-1).** The Calendar fetch is a snapshot of `[now - 2 d, now + 14 d]` and ignores windows, so before this the first scan never planned it and the Time page saw only two days of past meetings. Now it backfills in 24 h chunks. A chunk that ends before the live range is **history**: the fetcher lists exactly that window and returns every event, oldest first, tagged `history`, with `recordOnly`. The runtime records the items and the coverage, runs no agent and flags nothing unlinked. Past meetings feed the calendar projection (Time, History) and the completion pass's `same_event` candidates, and a skill pass over weeks-old meetings could only propose stale prep asks and catch-ups. History runs detect no cancellations and hand the live cursor value back unchanged. A full page (250 events) claims coverage only up to its last start, and the continuation lists the rest.
     - **Drive (DRV-1).** Drive samples forward: the first sample of a file is a silent baseline, so the first scan used to store no Drive items at all, and the first feed stopped at 4 pages (200 rows) while a real 30-day feed held over 500, a third of them folders and shortcuts. Now the feed query leaves out folders and shortcuts, the first feed (no feed cursor) reads up to 20 pages, and the first run emits one record-only `file_revision` per Google editor file I last edited in the 30-day lookback (its last edit only: the feed has no revision history), tagged `history`. They feed the assets and the Time page's Drive evidence. Later runs are unchanged.
     - **Drive behind the frontier (FS-DRIVE-1).** The feed reads forward from its frontier (the last feed time − 2 min), and the window clamp cuts each run's coverage at its window end. Oldest first, the first run is the oldest window, so every later backfill window read only the last minutes and failed with a hole the size of its window. Now a window that ended a day or more behind the frontier lists exactly itself (`modifiedTime` bounded both ends, up to 20 pages), records my editor files in it as the same `history` items (a repeat is unchanged), and hands the cursor back unchanged, so the feed state never moves backwards. Any other window that starts behind the frontier (the last backfill window, a late poll) reads the feed from its own start. Test: `first-scan.test.ts` FS-DRIVE-1.
  7. **Catch-up follows its plan** (stress campaign, `docs/archive/2026-build/STRESS.md`). A scope is "catching up" until every job of its plan (head, backfill chunks, their continuations and splits) has finished and the cursor has reached now. On a cold start without a first scan the head run initializes the cursor at now while the lookback backfill still runs behind it, so the cursor alone would report "caught up" after the first hour. A paused backfill, continuation or targeted window (auth or budget pause) is retried later: after 30 min for an auth pause, or at the next budget day. It is never dropped, because on a cold start no later poll would plan it again.
- **Per-object errors (DRV-2, GEM-1).** A Google error about one file (404 not found, 403 no access, 400 an unsupported document) skips that file, which the coverage marks with the error. The run goes on, and the connector is not degraded.
- **Status reasons (STAT-1).** A failed run writes a plain reason to `connectors.status_reason`: the failing scope and the cause, for example "Channel scans: prompt over the size limit" or "Meeting notes: a file couldn't be found" (`src/scanner/runtime/status-reason.ts`). Before, it was the classifier's code, which read "unknown".
- **Work items get their account (ACC-1).** The scan skills propose items without an account, so the projections pass (`src/projections/work-accounts.ts`) gives each item with none the account its title and purpose name, through the same Matcher as calendar events. The Matcher now also knows short names derived from Org62 legal names: a distinctive first word ("Northwind"), letters run into digits ("Contoso42"), and acronyms ("BSP", "HCEC"). When several accounts claim a name, the one with my open opps wins, then an opp word in the text; a tie that remains matches nothing. An account the user set or cleared is never touched. On the first live day this took the matched items from 0 to 15 of 50.
- **Recovery and shutdowns (HEALTH-1, SHUT-1).** A success makes a connector healthy again and clears its reason once none of its other scopes failed in the last 2 h; the first success after a worker start always writes it, because the in-memory state starts empty. The failure count resets on that recovery, not on any success, so a Degraded connector never shows 0 failures. A run the worker stops itself (shutdown drain, cancel, lost lease) is recorded as cancelled, with no health write, and the job runtime requeues it; a job timeout is still a failure. Settings shows the plain reason as the last error's message.
- **Incomplete runs claim nothing past their cursor (S8c).** When `cursor.at` is before `window.to`, the store clamps the run's time ranges (`query_window`, `channel_range`, `mailbox_range`, `calendar_range`) to the cursor before commit. Otherwise one query's full window (Slack S1/S2) masks another query's paged-out end (S3), and if the continuation is lost, the rest of the window disappears from `coverageGaps`.
- **Deterministic runs are bounded.** Each fetcher hands the agent at most `maxItemsPerRun` items; Calendar and Gemini notes (snapshot fetchers) emit the items nearest to now first, and leave the rest for the next polls. Prefetched items are rendered compactly: an email body appears once, as `payload.bodyNew` (≤ 1500 chars). The prefix tripwire is sized from the run itself (TRIP-2): everything the runner sends (common rules and skill at 2 characters per token; context pack, run block and prefetched payload at 1.8), plus 24 K tokens for what it does not send itself (the SDK prompt and the tool schemas). On the first live day, Org62 events sent 75.7 K characters for a 43.0 K-token first call and a Slack channel 68.4 K for 41.9 K, so real prompts have 15–20 K tokens of headroom, and a failed restricted config (every MCP tool loaded) still trips. Before, a flat 40 K base calibrated on stress databases (G-3, TRIP-1) failed every Slack channel, Org62 events, Claude sessions and Calendar run once the real list and today's skills grew the prompt. `tests/db/scanner/regressions.test.ts` (TRIP-2) checks every shipped scan skill against its own limit with a real-sized list. The context pack shows at most 60 open items and 25 initiatives, and never a fetcher cursor longer than 180 characters (CTX-1). A traversal tripwire retries the same window after a backoff instead of splitting time, because the first call holds no fetched data (TRIP-3). A cost-cap or tripwire failure of a deterministic run retries **the same window with half the items**, and never splits time: snapshot fetchers ignore the window, so a time split repeated the same oversized run. The worker commits the fetcher's `nextCursor` itself; when it is longer than 180 characters (fetcher state grows: per-file offsets, seen ids), the agent gets a short stand-in header cursor to echo, because `cc_finish` caps `cursor.value` at 200 characters (stress finding CUR-1). A scope that gives up on a window backs off before the next poll re-plans it: 30 min, doubling per about four failures, capped at 6 h, reset by a success (LOOP-1). A continuation whose cursor did not pass its own window start ends the chain instead of spawning another one over the same window (THR-1).
- **Live cadence while the app is up** (configurable per user; adaptive backoff when nothing changes; budget-aware):

  | Scanner | Cadence |
  |---|---|
  | Slack | 2 min |
  | Gmail | 3 min |
  | Calendar | 5 min |
  | Claude sessions | file watch (near real time) |
  | Drive | 10 min |
  | Gemini notes | every 10 min for 120 min after a meeting ends |
  | Org62 | 30 min |
  | Trainings | daily |
  | Watch briefs | per subscription |

  Off-hours cadence is ×6 slower. Off-hours are outside the user's working hours.

## 6. Finding misses and unconnected items (reconcile)

These jobs run **nightly, on resume, and on demand** (chat `/rescan` and the Health page Rescan):
1. **Coverage gaps.** List source objects in the last 7 days (cheap listing calls) and diff them against the coverage ledger. Only objects inside the scope's scanned span count: after its first scan and before its cursor. Objects older than the initial lookback were never in scope, and objects after the cursor belong to the next poll. All uncovered objects of a scope get **one** targeted scan, whose window spans them. Calendar's listing is identity-only (no `to`), because a scan clamps an event's coverage to its own window, so a multi-day event would otherwise look uncovered every night.
2. **Unlinked items.** Source items flagged unlinked, or with no evidence links but relevant, are re-run through linking with fresh open-item context. On the second failure, escalate once to **Sonnet**. On the third, it becomes a Triage mapping question, but only for an ask of me or a commitment of mine: a Slack message or email addressed to me or from me (MAP-1, Settings ▸ Scanning). Anything else stops being retried (its findings are `ignored`). Before, 34 questions from one first scan held about 4 real items.
3. **Stale-but-active.** Open items with no new evidence while their source thread or file has changed are re-scanned.
4. **Skill upgrades.** When a skill version bumps, re-link the last N days for that source, behind a dry-run diff report on Health.

## 7. Models and cost

- **Haiku** (`claude-haiku-5-5`, low effort) for every scanner run and reconcile step.
- **Sonnet** only for the reconcile escalation (§6.2), the Slack triage escalation of `unsure` verdicts (§4.10) and in BE-3/BE-4 (NBA, drafts).
- One Claude process per connector at a time.
- Each scanner loads **only** its own MCP server plus the `cc` tools. This is the restricted config from brief 09, and it's the biggest cost lever.
- Prompt-cache the skill text and the context pack.
- Measured target: about $0.50/day for scanning (brief 09). Health shows per-scanner spend. Fetch then interpret (§11) is how it gets there: relay reads plus batched, tool-less classifier calls.
- At the hard cap ($15/day), the traversal scanners pause. The deterministic fetches and file watch keep running, with linking deferred. Reconcile's LLM steps (relinks, the Sonnet escalation, skill-upgrade dry runs) defer too, until the next budget day.

## 8. Correctness tests (required before "built")

All tests use fixtures from **recorded tool results with placeholders**. Each test is real-shaped.
- Running the same window twice gives zero new rows (idempotency).
- A killed run mid-way leaves the cursor unmoved, and re-running produces the same final state.
- A weekend gap gives the newest hour first, then a backfill that ends with full coverage and no holes in the ledger.
- "I'll send the deck" in Slack, then an email with the deck attached, links to the same item, as `origin` then `completion`.
- A Drive edit on the linked deck with no Slack message produces a `progress` signal.
- "Done, see deck" in Slack produces a `completion` signal.
- New requirements arriving after done produce a `contradiction` or requirements-change signal, and BE-3 then reopens the item or creates a sibling.
- An unlinked item is retried, then escalated, then becomes a Triage question.
- The stress harness (`scripts/stress/**`, `docs/archive/2026-build/STRESS.md`) replays recorded real days through the production worker, and checks these invariants after every scenario.
- A non-allowlisted tool call aborts the run.
- Over budget, traversal pauses.

## 9. Audit trail: what a run did and why (AUDIT)

Every scan run keeps an ordered, append-only decision trail in `scan_run_events` (`run_id`, `seq`, `ts`, `kind`, a small JSON payload, optional `source_item_id` / `work_item_id`). Code: `src/scanner/trace/`.

| Kind | Written by | Carries |
|---|---|---|
| `plan` | runtime | connector, scope, mode, trigger, window, chunk, budget (daily / first-scan), model, skill version, caps, job id |
| `prefetch` | runtime (deterministic) | items fetched, limit, coverage, record-only, agent or deferred |
| `tool_call` | runner (from the message stream) | tool, server, the query or ids (cc tools: ids only), duration, result size and row count, error head |
| `rec` | REC-1 | per tool result: parsed, recorded, new, duplicates |
| `recorded` | store | source item ids seen (new / changed / unchanged) |
| `prompt` · `tripwire` · `cost_cap` | runner | first-call tokens against the tripwire limit; the estimate or SDK stop against the cap |
| `pass` | runner | traversal / triage / escalate: model, ok, error, cost, tokens, turns, counts, and `m`: the measurement booked on its `llm_calls` row |
| `context` · `prompt_guard` | runner | what the context held at the first request (getContextUsage rows, token counts only); the guard stopping a run before a request past the long-prompt tier |
| `triage_select` · `verdict` | runner | why each message did or did not get a verdict (trivial, handled, skipped, dropped); act / noise / unsure, the short reason, escalated, the final call |
| `proposal` · `link` · `unlinked` · `coverage` | store | work item, evidence ids, role, confidence, the model's short reason |
| `spend` · `commit` · `failed` · `retry` · `outcome` | store, runtime | cost and budget; cursor; failure cause; what the runtime did next (split, fewer items, retry, next poll); the final status |

Rules: ids, counts, codes and short reasons only (strings redacted and clipped to 160 characters, a query to 300); message text stays in `source_items`. The worker writes it in the background (`DbTraceSink`): a trace failure drops events and never fails, slows or changes a run. Retention: 30 days (the nightly retention job). Worker log lines inside a job carry `runId`, `jobId`, `connector` and `scope`; every `llm_calls` row carries its run or job and its budget (`daily` / `first_scan`). A failed run, a tripwire hit or a cost-cap stop opens one `app_events` row per scope and cause (repeats bump its count; the scope's next success resolves it); a scope paused at the daily hard cap opens `budget_hard_cap`.

```bash
npm run scan:trace -- <runId>                 # the ordered trace (or --last [connector] [--failed])
npm run scan:explain -- --url <permalink>     # was it fetched, recorded, triaged (verdict and why), linked? (or --source-item <id>)
npm run scan:report -- --since 24h            # per scope: runs, failures by code, coverage holes, spend by budget, triage
npm run scan:report -- --yield --since 7d     # per skill and source: what the dollars bought (see Measurement below)
```

**Measurement (0027, holistic review 2026-11-20 lane 04 §4.5).** Every `llm_calls` row a runner books can say what its call measured; all columns are nullable and rows from before 0027 stay null. `first_prompt_tokens` and `max_prompt_tokens` are the first and the largest single request's prompt (uncached + cache read + cache write), `long_tier_requests` how many requests passed the model's long-prompt threshold (`longPromptThresholdOf` in `src/llm/models.ts`: Haiku 5.5 above 100K is priced 5×), `turns` the model requests, `tool_count` and `tool_schema_tokens` the tools in context and their schema tokens (`getContextUsage({detail:'summary'})`), `prefix_hash` a hash of everything before the cache boundary (model, tool names, static system prompt: two calls with the same hash can share a cache entry), `items_in` / `items_decided_by_rules` / `items_out` what the call was given, what rules settled without it and what it proposed or linked, and for a triage escalation `escalated_from_call_id` (the cheaper call it re-did) and `escalation_changed_items` (D4: verdicts the stronger model changed). The skill runner fills them from the SDK's per-request usage and puts them on the `pass` trace row; the store books them with the pass. A booked call with `turns > 0` must carry `first_prompt_tokens` (`tests/setup/ledger-gaps.ts`). `scan:report --yield` reads them: per skill and source, $, calls, runs, $/run, % empty runs, cache hit %, % long-tier requests, $/item found and $/item closed (closures attributed through `work_item_transitions` whose reason cites the run or whose evidence the run recorded), the escalation's changed verdicts, and the first scan's $/source/day.

**Staying under the long-prompt tier (COST-2).** Once REC-1 / REC-2 have recorded a read tool's raw result, the runner's PostToolUse hook hands the model a compact digest instead (`updatedToolOutput`, `src/llm/tool-digest.ts`): Slack reads become one block per message (its `<channelId>:<ts>` ref, time, channel, thread, author, full text, files; no permalinks or e-mail addresses; the pagination line verbatim), SOQL results lose each row's `attributes.url`. A per-request guard then estimates the next request (the last prompt + its reply + the tool output since) and, when it would pass the model's threshold, stops the run with `prompt cap` instead of paying the tier: the runtime treats it like a cost cap (a planned window split, or fewer items for a deterministic source; Health is not degraded). `CC_TOOL_DIGEST=0` and `CC_PROMPT_GUARD=0` turn either off. Scanners and relays load no Claude settings files (`settingSources: []`, COST-8); the gateway env and `apiKeyHelper` are passed explicitly, and `CC_SCANNER_SETTING_SOURCES=user` restores the old behaviour if a machine's MCP sign-in needs it.

Health shows the error feed and the first scan's progress per scope (read from `first-scan.json`), and a work item's Details panel answers "Why is this here?": the origin message and its link → the scan run (time, skill version) → the triage verdict and its reason → that run's model cost.

## 10. Evals: recall and closure precision, measured offline

`npm run test:evals` (vitest project `evals`, `tests/evals/vitest.config.ts`, files `tests/evals/**/*.eval.ts`) replays the golden cases in `tests/fixtures/scanner-golden/<case>.json` through the real deterministic path, in memory, in about two seconds: no network, no model, no cost. It is not part of `npm test` yet.

- **Golden cases.** Each case holds `sources[]` (placeholder rows with `source_items` field names; Slack rows are rendered in the recorded MCP search format and parsed by REC-1, so the 1,000-character excerpt cap and the inbox searches S1–S4 apply as in production), `items_expected[]` (kind, title keywords, origin source, the phrase the ask hinges on) and `closures_expected[]` (closed / likely / open, the cite, `settled` or `still_owed`, optionally the D-rule that should decide it). A scripted agent stands in for the traversal model: it proposes an expected item only when the stored text shows the ask (an oracle), so recall measures what the code loses. Cases: the CAST-work storylines wi-002, wi-004, wi-006, wi-008, wi-016, wi-060, and the regressions SCN-1, SCN-4, SCN-9, SCN-11 and SCN-14.
- **`knownGap: "SCN-n"`** marks an expectation today's code fails. It is scored and listed but never fails the run; one that starts passing is listed as `flip`, and the chunk that fixed it removes the mark.
- **Deterministic layer** (`deterministic.eval.ts`): inbox fetch and the excerpt cap, `collectCandidates`, the resolution rules D1–D6 (`src/scanner/resolution/rules.ts`, pure, not wired into closing yet), DUP-1, `decideSettle`, and pack completeness: the deciding line of every expected close or reopen is in the Settle pack built by `buildSettleContext` (the `scripts/settle/context-check.ts` idea, without the private key).
- **Cassette model** (`src/scanner/completion/cassette.ts`): a `CompletionModel` that replays replies keyed by the completion pass's ledger hash, `ledgerHash(model, skill version, system, user)`. A prompt with no entry fails with its hash. Cassettes live in `tests/fixtures/scanner-golden/cassettes/`; the committed ones are hand-written plausible verdicts (`origin: "hand"`).
- **Scores**, printed as a table at the end of the run: item recall on golden asks (gate ≥ 0.9), wrong closes on still-owed items (gate 0), close rate on settled items, clicks left (missed asks, Likely confirms, wrong closes, extra items) and model calls (tracked).

```bash
npm run test:evals                         # the evals and the score table
npm run eval:record                        # offline: re-key hand-written cassettes after a prompt or skill change, list calls with no entry
npm run eval:record -- --show-missing      # offline: also print each missing call's prompt (placeholder data) to hand-write its reply
npm run eval:record -- --live --yes-spend  # COSTS MONEY: record replies from the live model; books every call in llm_calls; refuses in CI or without a gateway
```

## 11. Fetch then interpret (FTI, `CC_SCAN_MODE`)

Holistic review 2026-11-20, lane 04 §4.1–§4.6 and decision H-3: the model stops being the transport. `CC_SCAN_MODE=fti` (the default) reads by code and interprets in small, batched, tool-less model calls; `CC_SCAN_MODE=agentic` runs the skill-agent traversal of §2–§4 as before. The runtime's control flow (planning, cursors, coverage commit, retries, budgets, first scan, reconcile) is the same in both: FTI is a `SkillRunner` (`src/scanner/interpret/runner.ts`) that the worker puts in front of the agentic one (`src/worker/scanning.ts`).

```
fetch by code ─▶ REC-1 / REC-2 record ─▶ rules ─▶ ≤ 5 candidates per item ─▶ batches by tokens ─▶ classify (Haiku, no tools, JSON)
                                                                                                  │ below 0.6: a second, wider call
                                                                                                  ▼
                                                     the cc tool handlers write (same gates, redaction, reasons) ◀── apply
```

**Fetch** (`src/scanner/fetch/`). Every scope has one `fetch(scope, window)`. Slack runs the §2 queries of `skills/scan-slack.md` verbatim: S1 DMs, S2 @mentions, S3 mine, S4 mine with a file (only when S3 found any), C1 / C1′ for channels and T1 for a thread. Each page is one MCP tool call through the `claude_relay` runtime, the smallest Claude run that calls exactly that tool (H-3). Code pages them (5 pages a query live, 20 in backfill) and makes §3's thread reads by rule: a reply to me or by me whose parent this run has not read, my completion words in a thread, and in head or backfill the threads of open items quiet since before the window (≤ 5 a run, 10 in backfill).

Org62 runs the §2 SOQL of `skills/scan-org62.md` verbatim for `opps` (Q1, Q2 when there are accounts, Q3 for an owner book), `events` and `dcs`. Code pages them by keyset (4 pages live, 10 in backfill). A result over the tool's output cap is read again at half the LIMIT (≥ 10); a refused query stops the run with `soql_invalid`; a paged-out run finishes at `<stamp>|<id>`.

Every result goes to REC-1 / REC-2 exactly as when the agent reads it, so the `source_items` rows, keys and hashes are the same (`tests/scanner/fti-fetch-*.test.ts` compare them row for row). Gmail, Drive and Gemini notes keep their deterministic fetchers. Coverage refs, kinds and cursors are the skills' own.

**Rules** (`src/scanner/interpret/rules.ts`, `units.ts`, `org62-rules.ts`). Before any call, rules settle what needs no model:

- Slack uses the triage selection: only messages to me, from me, or in a DM, group DM or thread I'm in, with addressing read over the whole conversation, earlier lines from the store, and earlier verdicts carried forward.
- Bots, joins and acknowledgements.
- My own message with no promise, delivery, file or home (my ask of someone else).
- Bulk and calendar mail.
- Notes with no open step of mine.
- A Drive edit with no candidate deliverable.
- An unchanged item an earlier run already gave a verdict.
- Org62 rows: an Event completes a "log activity" item, a DC completes a "DC" item, a stranded DC proposes a move, closed lost contradicts the opp's items, closed won adds DC context. Only an opp whose next step names my role's work with a date reaches the model.

A message that is not for me but sits in an open item's thread is linked as context. Each settled item becomes an `llm_decisions` skip row (`rule_<reason>`), and the first call of a run books `items_decided_by_rules`.

**Classify** (`src/scanner/interpret/classify.ts`, `skills/classify-items.md`). One system prefix is shared by every source and user: the skill up to the cache boundary, then the Persona block and a glossary (me, accounts, channels, initiatives). There is no open-items pack (COST-5). Instead each item carries its own ≤ 5 deterministic candidates (thread, file, people, account, and short distinctive-word queries, the way R5 asks), aliased `w1`…`w5`. Batches fill by an input token budget (6K live, 16K backfill) and a reply budget (90 tokens a verdict), with a conversation kept together.

The reply is one JSON object, validated per verdict with zod:

- `v` is `ask | commitment | completion | progress | change | fyi | noise`: the brief's four, plus the three a link needs;
- `kind`, `title`, `who`, `deliverable`, `due` and `cite`;
- `conf` (0–1), which code maps to sure (≥ 0.85), likely (≥ 0.6) or guess;
- `link`: a candidate alias, or an earlier ref of the same batch (an ask and my reply in one first-scan chunk);
- `why`.

A verdict below 0.6, a missing ref or an invalid entry gets a second call with more of the conversation. What is still unsure is flagged for Triage (`unsure: …`), never dropped. A failed call fails the run, and the runtime retries it.

**Apply** (`src/scanner/interpret/apply.ts`). Every write goes through `callCcTool`:

- an ask or promise with no home → `cc_propose_item` (kind, title, purpose `"<who> asked: <cite>"`, due, account, opp, `expected` for a deliverable, origin evidence, the confidence word);
- an ask or promise with its candidate → an origin link (a direct ask on a handed-off item → `loop_back:`);
- completion or progress → a link (from Drive with the `drive_judge:` reason, `likely` at most; on a done item, context);
- change → a `requirements_change:` contradiction on a done item, or `requirements_update:` context on an open one;
- fyi with a home → context.

Only the reason prefixes the closure engine reads are used. NOT-MINE, TRI-3 and the catch-up switches apply because the handlers apply them.

**What stays agentic** (the fallback, `fallbackReason`): relink and skill-upgrade passes, Org62 `book` and `missed_opps`, Calendar, Claude sessions, trainings, watch briefs, VDP, and a user with no Slack or Org62 id. Their skills are unchanged, and `CC_SCAN_MODE=agentic` runs everything the old way.

**Booking.** Every relay read and every classifier call is one `pass` trace row (`fetch:relay:<connector>:<tool>`, `classify:classify-items`, `reclassify:classify-items`). The row carries the model, tokens, cost, content hash and measurement (`first_prompt_tokens`, `turns`, `prefix_hash`, `items_in`, `items_out`, and `items_decided_by_rules` on the first call). A classifier call's content hash is `ledgerHash(model, classify-items@version, system, user)`, which is also the cassette key. `recordSpend` books one `llm_calls` row per pass row on the run's budget (daily or first scan). `passSkill` reads the skill key after the first colon, so relay reads land on `relay:<connector>:<tool>` (what the relay's p90 estimate reads) and classifier calls on `classify-items`. `scan:report --yield` adds one line per mode: $, runs, calls, items found and closed, $/item found, and the FTI/agentic ratio. TODO(spend-governor): each call site holds a flat cap until `src/llm/spend/governor.ts` lands (`estimate()` / `hold()` / ask, never kill).

**Signal-driven cadence.** In FTI mode, a run with new or changed items sets its scope's level to −1: half the base interval, never under a minute, so the Slack inbox polls every minute while a conversation is live. Each quiet run doubles the interval, up to ×8 (16 minutes for the inbox). Working hours (Settings ▸ Profile, the hours the persona applies to) multiply off-hours intervals by 6, capped at 4 h. The D5 pre-check is off, because an FTI poll is the same three searches and also records what they find. The worker writes each scope's next check and level to `<CC_STATE_DIR>/scan-cadence.json` once a minute. A restart resumes each scope's backoff, and Health's connectors carry `nextCheckAt` / `nextCheckInMin` ("next check in N min", data only).

**First scan.** Inbox history is read in 24 h chunks, up from 2 h. SLK-1 was an agent losing asks in windows of more than ~9 messages; code now pages, and the classifier batches by tokens. Channels and the deep inbox use 7-day chunks, a deterministic run hands over 100 items, and the classifier uses large batches (16K tokens). Each first-scan run adds to its source's progress in `first-scan.json` (`sources`: read, found, linked, $, runs) and puts the line on the run's `outcome` event ("Slack: 1,240 messages read, 31 asks found, $0.42 so far"). Health's first-scan progress carries `sources[]`. The one-time budget and its exhaustion work as before.

### 11.1 The A/B gate

Both paths run on the same fixtures, offline (no model, no network). The agentic side is the oracle agent: each case's scripted actions, a perfect model, so it measures what code loses. The FTI side is the real pipeline, with the classifier replayed from hand-written cassettes (`tests/fixtures/scanner-golden/cassettes-fti/`, keyed by the classifier's ledger hash). `CC_EVAL_REKEY=1` re-keys them, and `CC_EVAL_DISCOVER=<file>` writes every prompt so a new case's cassette can be written by hand. The $ are estimates from token counts (`src/scanner/interpret/estimate.ts`), with a relay request taken as 8K tokens (see §11.2).

| fixture | path | recall | precision | closures | est. $ | est. $/item found |
|---|---|---|---|---|---|---|
| golden cases (11 cases, `tests/evals/scanner/fti.eval.ts`) | agentic | 12/12 | 12/12 | 11/11 | 0.2295 | 0.01913 |
| | **fti** | **12/12** | **12/12** | **11/11** | **0.0349** | **0.00291 (0.15×)** |
| stress: the Slack corpus, a first scan through the runtime (`tests/scanner/stress/fti-ab.test.ts`) | agentic | 4/4 | 4/4 | - | 0.0589 | 0.01473 |
| | **fti** | **4/4** | **4/4** | - | **0.0083** | **0.00206 (0.14×)** |

The gate is recall ≥ agentic, precision not lower, and $/item ≤ 1/5. Both fixtures pass, so FTI is the default.

What the A/B does not measure is model quality. The cassettes are plausible hand-written verdicts, so the gate proves the pipeline loses nothing (rules, candidates, batching, schema, apply) given the same judgment. The owner's live checks are in §11.4.

### 11.2 Cost

Relay reads are the floor of FTI's cost. A relay request is the read-lookup skill (~0.3K tokens) plus exactly one MCP tool schema. The traversal's measured 13–19K hidden tokens carried 14 schemas, so a relay request is about 2–5K tokens; 8K is the conservative estimate used here, and 15K the high bound (review 04's unmeasured 5–15K). At 15K the golden ratio is 0.23×, because the golden scans are hours apart and every relay prefix is written cold. On a live 1–2 minute cadence the prefix stays cached. The ledger measures the real size: `first_prompt_tokens` of the `relay:*` rows.

First scan, 30 days (`tests/scanner/fti-first-scan-estimate.test.ts` prints the arithmetic per source):

| volume | relay reads | units to the classifier | classifier calls | est. $ |
|---|---|---|---|---|
| sample dataset, last 30 days (783 items) | 280 | 195 | 7 | 0.06 |
| busy SE, review 04 §4.2 (250 Slack messages, 40 emails, 10 Drive edits, 4 notes, 30 Org62 rows a working day) | 483 | 2,972 | 68 | 0.26 |
| busy SE, pessimistic (no rule settles anything; 15K-token relay reads) | 483 | 8,358 | 187 | 0.63 |

The busy SE's Slack line, for example:

- relay reads: 30 days × (S1–S4 + 6 pages + 1 thread) + 12 channels × 5 weeks = 450 reads × ~$0.00015 = $0.07;
- units: 5,250 inbox messages × 40% + 1,260 channel messages × 15% = 2,289;
- classifier: 2,289 units / 45 a call = 51 calls × (2.5K cached + ≤ 11.7K in + ≤ 3.2K out tokens) = $0.14.

The measured agentic first scan cost $16.24 (scan $12.34 + read-ins $3.90). FTI's scan part for its sources is $0.26–0.63. On top come the read-ins (Haiku since D2, about $0.26 of the old $3.90), Calendar's first-scan history (record-only, FS-CAL-1) and the agentic fallback sources: about $1 all in.

Background scanning at this cadence (an inbox at ~40–330 polls a day × 3–4 reads, quiet channels backed off, ~80 classified messages a day) is about $0.05–0.25 a day.

### 11.3 Skill diet

`skills/classify-items.md` (≈ 1.5K tokens; ≈ 2K with the Persona block and glossary) is the whole scanning prefix, shared by every source, with no tool schemas. Before, each source had `_scanner-common` + its scan skill (+ `triage-slack` for Slack): 6.7K–12.8K tokens of skill text on top of ~24K hidden tool and CLI tokens, re-read every turn. FTI's skill text is 0.11× (Slack) to 0.22× (Drive, notes) of that; `tests/scanner/fti-skill-diet.test.ts` prints the table. The scan skills stay for the agentic path.

### 11.4 Knobs and checks

- `CC_SCAN_MODE=agentic|fti` (default `fti`). For harnesses, the worker takes `scanMode`, `relayRuntimes`, `classifier` and `cadenceFile` options.
- Manual checks on the work machine (nothing reads live sources here):
  1. Run one Slack inbox poll and one Org62 `events` poll in FTI mode.
  2. `npm run scan:report -- --yield --since 24h` shows the `relay:*` and `classify-items` rows with `first_prompt_tokens`: the relay request size the estimates assume.
  3. `npm run scan:explain -- --url <permalink>` on a known ask shows it fetched, recorded, given a `classify` verdict and proposed.
  4. One first scan shows its per-source line on Health.
