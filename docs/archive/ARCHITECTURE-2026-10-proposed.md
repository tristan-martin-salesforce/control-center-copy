# Control Center — Architecture

> Status: **proposed** (2026-10-22). Grounded in `docs/research/01–06`. Items marked **[spike]** are unverified and get resolved in Phase 0.

## 1. Shape of the system

```
                         ┌────────────────────────── your Mac ──────────────────────────┐
  Sources                │                                                               │
  Slack ──────┐          │  ┌────────────┐   SourceItems   ┌──────────────┐               │
  Gmail ──────┤ MCP      │  │ Connectors │ ──────────────▶ │  Store       │◀──┐           │
  Calendar ───┤ (direct  │  │ (read-only,│                 │ SQLite + FTS │   │           │
  Drive/Docs ─┤  client) │  │  adapters) │                 └──────┬───────┘   │           │
  Gemini notes┤          │  └────────────┘                        │           │           │
  Org62 ──────┤          │        ▲ scheduler (worker)            ▼           │           │
  VDP ────────┘          │        │                  ┌───────────────────────┐│           │
  Claude sessions ─ files│────────┘                  │ Engines               ││           │
  (+ hooks → local API)  │                           │ • Entity resolver     ││           │
                         │                           │ • Commitment engine   ││           │
                         │                           │ • Time engine         ││           │
                         │                           │ • Priority engine     ││           │
                         │                           │ • Draft engine (LLM)  │┘           │
                         │                           └──────────┬────────────┘            │
                         │                                      ▼                         │
                         │   ┌──────────────── Next.js UI (localhost:4327) ─────────────┐ │
                         │   │ Today · Triage · Deals · Time · Outbox · Goals · Search   │ │
                         │   └──────────────────────────┬───────────────────────────────┘ │
                         │                              ▼ approve                         │
                         │                     ┌──────────────────┐                       │
                         │                     │ Outbox + Gate     │──▶ Slack / Gmail /   │
                         │                     │ (audit log)       │    VDP (direct)      │
                         │                     └────────┬─────────┘                       │
                         │                              └──▶ Handoffs: Org62 links/CSV,   │
                         │                                   Slackbot skill prompts,       │
                         │                                   VDP asset links, travel       │
                         └───────────────────────────────────────────────────────────────┘
```

**Processes:**
- `web`: a Next.js app serving the UI plus a local JSON API on port 4327.
- `worker`: a Node process running the scheduler, connectors and engines.

Both are kept alive by one launchd agent, and both share one SQLite file.

**Stack:** this matches the conventions in your existing repos (`vdp-app`, `claude-usage-metrics`). Next 15, React 19, Tailwind v4, TanStack Query, zod, Drizzle, `better-sqlite3`, Recharts, `@modelcontextprotocol/sdk`, and `@anthropic-ai/claude-agent-sdk`.

## 2. Two ways of touching the outside world

1. **Deterministic connectors (no LLM).** The worker talks MCP directly with `@modelcontextprotocol/sdk`, reusing auth you already have. They are cheap, fast and testable, and they handle all polling.
2. **Agent jobs (LLM).** These run through the Agent SDK `query()` with `settingSources: ['user']`, so they ride your existing gateway, `apiKeyHelper` and MCP config. They handle judgment work: extracting commitments, classifying, ranking explanations, drafting, and matching "is this done?".
   - Structured output is validated with zod.
   - `canUseTool` denies every write tool, so agents can't send anything.

## 3. Connector matrix

| Source | Path (primary) | Auth reuse | Cadence | What we pull | Confidence |
|---|---|---|---|---|---|
| **Slack** | `slack` http MCP, called *by Claude* in a headless `claude -p --allowedTools mcp__slack__<read tools>` job (pattern proven in an earlier local project) or an Agent SDK job. We never extract Claude Code's OAuth token (*invariant: never copy tokens*; SFSS-IAM-002) **[spike S1: cheapest headless read path + cost per poll]** | 5 min for DMs/mentions (deterministic search query, no LLM reasoning, Haiku), 15 min for channels | DMs, @mentions, threads you're in, your sent messages, team and customer channels from a watchlist | High |
| **Gmail** | `mcp-adaptor serve --profile sdb` (stdio, devbar auth, proven by an earlier local inbox tool) | devbar | 10 min | Primary-inbox threads, sent mail, Gemini/Concur notification mails | High |
| **Calendar** | mcp-adaptor | devbar | 15 min, plus ±1 day refresh at 6am | Events, your response status, attendees, attachments (Gemini notes doc) | High |
| **Gemini notes** | Calendar attachment → Drive doc (mcp-adaptor `get_doc_as_markdown`). Fallback: `gemini-notes@google.com` mail | devbar | 10 min after each meeting ends, retried until 120 min | "Next steps" checklist (`- [ ] [Assignee] …`), shared assignees (`[Lee, Tristan]`), summary. Some docs are Transcript-only, so the LLM extracts next steps | High for meetings that have notes: typically under 15 min, worst case about 77 min. **Only ~30% of meetings have notes** (10 of 34) |
| **Drive / Slides / Docs** | mcp-adaptor search and metadata | devbar | 5 min (edit sampling, **starts in P1, because history can't be recovered later**), daily (inventory) | Files you own or edited; `lastModifyingUser` + `modifiedTime` samples for time tracking | Medium (no revision history) |
| **Org62** | `Org62-Sobject-Read` MCP (needs `/mcp` auth) via a headless Claude job. Whether the claude.ai "Salesforce - Beta" connector works in SDK or `-p` jobs is **unverified** **[spike S2]**. Last resort is a manual "refresh opps" from an interactive session | OAuth | Hourly; on demand | Your opp team memberships **plus opp search** (you also log to opps you are not on the team of), opp fields, your Solutions Events (for reconciliation), Deal Contributions; the `Use_Case__c` records on your open opps (D-67, daily read-back, by opp) | Medium |
| **VDP** | `vdp-app-fir` http MCP, called directly with PAT + `central_proxy_session` cookie. Worker runs `refresh_vdp_fir_cookie.py` when the cookie is under 10 min from expiry | PAT + Okta cookie (~1 h; needs Zscaler; headed refresh; Okta MFA every 8–12 h, which **needs you**: a Health banner with a "Re-auth VDP" button) | 30 min (paused when auth lapses) | VDPs (every opp id on each, `salesforceOpportunityIds`), use cases, stakeholders, assets, DC notes; the server's `tools/list` and `list_companies` matches (`vdp_server`, D-59 feature detection); one status per VDP | Medium (`tools/list` verified 200, but auth is fragile). **Note:** `generate_deal_contribution_notes` *writes* on a cache miss, so it is never called. `delete_*` tools are never callable. Writes (D-46, D-59): one Outbox Apply per item: a whole use case, the fiscal period, `add_opportunity_ids`, `create_vdp`; `create_company`, `add_vdp_asset`, `set_vdp_owners`, `generate_use_case` only once VDP lists them; `list_industries` is a read (a new company's industry, only on an exact match). **VDP autopilot (D-60)**, while on: the worker's `vdp.autopilot` applies the items whose values are all known facts (company, VDP, opps, Org62 account id and period, strong http(s) assets, TA = me, Generate once the inputs are in) as Outbox actions under the autonomy policy, within a daily cap, never while dry run is on or the cookie/PAT is stale; judgment fields are deterministic suggestions you approve; a few looks-wrong checks offer their fix as a suggestion |
| **Claude sessions** | Files: `~/.claude/projects/**/*.jsonl`, desktop `claude-code-sessions` index, Cowork sessions. Optional cross-check: `~/.devbar/plugins/ai-analytics/events.db` | Local files | File watch (P1); a SessionEnd hook that POSTs to the local API is added in P6 | Titles, `away_summary` recaps, active time, cwd/branch, files changed, `needs_action` | High (keep a copy: **~30-day retention**) |
| **Git** | `git log --author` across `~/Projects/*` | Local | Hourly | Commit times per repo (time signal) | High |
| **Granola** (optional) | Slack-pasted notes only (local data encrypted) | — | via Slack | Notes | Low |

Connectors are **read-only allowlisted**: the MCP client wrapper refuses any tool not on the connector's read list. mcp-adaptor exposes send, share and trash tools, so this guard matters.

## 4. Data model (SQLite, owner in brackets)

| Entity | Purpose | Key fields |
|---|---|---|
| `source_item` [connectors] | Normalized raw signal | `source`, `external_id` (unique with source), `kind` (message, thread, email, event, doc, note, session, commit), `ts`, `actor`, `text` (redacted, TTL), `url` (deep link), `meta` JSON, `content_hash` |
| `person` [resolver] | People across systems | Slack ID, email, Org62 user ID, role tags (manager, leader, AE, customer) |
| `account`, `opportunity` [resolver; Org62 is canonical] | Deal entities | Org62 IDs, stage, amount, close date, my team role; `aliases` (names, domains, Slack channels, repo paths) |
| `link` [resolver] | Many-to-many: item ↔ account/opp/person/goal | `confidence`, `method` (rule, llm, user), `confirmed` |
| `task` [commitment engine + user] | The to-do | `title`, `kind` (reply, deliver, log, vdp, travel, review, ask-owed-to-me), `origin` (said-by-me, asked-of-me, meeting-next-step, system-rule, manual), `due`, `status` (suggested → open → done / dismissed / snoozed), `done_evidence`, `priority_score` + `why` JSON, `effort_est`, `goal_id` |
| `goal` / `milestone` [user + system] | Longer timelines | Quarterly targets (e.g. 250 CC hours, DC per engaged opp), deal milestones, personal deliverables; `target`, `progress_query` |
| `time_block` [time engine] | Evidence of time | `start`, `end`, `source` (calendar, claude, doc-edit, slack-burst, git, manual), `attention` (focused, meeting, background), `overlaps` |
| `activity` [time engine + user] | Allocated human time | Merged blocks → `opp_id` / `account_id`, `se_task_type`, `customer_facing`, `hours`, `status` (draft → approved → handed-off → logged/verified), `org62_event_id` |
| `outbox_action` [outbox] | Anything leaving | `type` (slack.send, slack.draft, gmail.draft, gmail.send, vdp.*, org62.event, org62.dc, handoff.*), `payload` JSON, `preview`, `status` (draft → approved → executing → done / failed / handed-off → verified), `autonomy_level` |
| `audit` [outbox] | Append-only | Action ID, actor, decision, timestamp, payload hash, result |
| `rule` [learning] | Learned mappings | e.g. `domain acme.example → account X`, `channel C… → opp Y`, `"Peer Cert" → Personal Development` |
| `sync_cursor` [connectors] | Incremental sync | Per source and scope |

**Location:** `~/Library/Application Support/control-center/cc.db`, which is outside the repo. A nightly backup keeps the last 7 days. Message bodies have a TTL of 90 days by default; metadata, tasks and activities are kept indefinitely. FTS5 indexes titles and redacted text for search.

## 5. Engines

**Entity resolver.**
- Org62 opps and accounts are the spine.
- It maps items to them using: attendee/email domains, meeting-title account tokens (the strongest signal), customer-channel naming (`ZC:<id>:<Account>`, `acct-`, `oppty-`), repo/path/branch tokens for Claude sessions (`client-demos/bms-kam` → BMS), VDP Org62 IDs, and Drive titles.
- Ambiguous matches go to an LLM with the candidate list. Low confidence produces a *Triage* question rather than a guess.

**Commitment engine** produces tasks from five origins:
1. **Asked of me.** DMs and mentions without a reply from me, and emails in Primary that need action. This is a deterministic first pass, then Haiku decides whether the message really asks for something.
2. **Said by me.** My outgoing Slack and email messages are scanned for promises ("I'll send the deck Friday"). Sonnet extracts what, to whom, the due date and the thread link.
3. **Meeting next steps.** Gemini "Next steps" checklist items assigned to me, from meetings I accepted. This is parsed, not guessed.
4. **System rules.** Team-pack rules generate tasks, e.g. "Q3 activities due 10/30 12 PT", "every engaged opp needs a VDP + DC", "Friday logging", "Concur expenses by 10/31", "travel approval before booking".
5. **Manual / quick-capture.** In-app, from a Claude session via the `/cc` skill, or from Slack.

**Cross-source merge.** One commitment often shows up three times: a Gemini next step, the Slack thread about it, and an email. New candidate tasks are clustered against open tasks using the same account/opp, the same people, ±3 days, and an embedding/LLM similarity check. A match **attaches as extra evidence** to the existing task instead of creating a new one, and the task shows all its sources. This is what keeps Today calm.

**Done detection.** Each task stores a *closure test*:
- Reply tasks close when I post in that thread, DM or email thread after the ask.
- Deliver tasks get an LLM match against my later messages, sent files and Drive edits. The match is shown as "likely done because…" and closes with one click, or automatically when confidence is high (with undo).
- Log tasks close when Org62 read-back shows the event.
- VDP tasks close when a VDP read shows the field present. Each VDP has one status (Done, N open, Waiting for VDP to refresh, Past; src/engines/vdp/status.ts): an item applied or marked added after the last read waits for the next one, and only the current and next fiscal period and VDPs with an open opp are checked (D-59).

**Time engine.**
- **Collect blocks:**
  - calendar events I accepted;
  - Claude-session active spans (message gaps under 10 min, overlaps de-duplicated, agent time kept separate);
  - doc-edit sessions (5-minute samples where I'm `lastModifyingUser`, clustered with a 15-min gap);
  - Slack bursts;
  - git commits;
  - manual blocks.
- **Merge on a single timeline.** Precedence is meeting > focused Claude/doc work > Slack burst. Lower-precedence blocks show as overlay, not hours, so nothing is double-counted.
- **Allocate** each merged span to an opp/account and an SE Task Type using rules, then an LLM with the canvas `<task-type-canvas-id>` task-type definitions. External attendee ⇒ customer-facing.
- **Emit draft Org62 Solutions Events:**
  - Record type `012XX0000000000AAA` (placeholder), `SE_Task_Type__c`, `WhatId` = opp (fallback to the account), `Duration__c` = hours rounded to 0.25.
  - Meeting Type is required for Workshop/POC.
  - De-duplicate on Subject + Start + Owner.
- **Track quarter-to-date** CF/CR/CC hours against the target (about 250 per quarter).

**Priority engine.**
- Score = urgency (due date, deadline proximity, age of the ask) × importance (who's asking: leader, manager, customer, AE; deal size and stage; external-facing) × commitment weight (I promised it > asked of me > suggested) + goal contribution (**DCs and activity logging get a compensation-linked boost**, since DCs are tied to pay) − effort penalty for "Now".
- Daily, it picks **Top 3** plus a **Now / Next / Later** list. Each item shows its *why*.
- Big goals reserve capacity: a weekly plan allocates focus hours to milestones and can suggest calendar holds, which go through the Outbox.

**Draft engine.**
- Reply drafts use a **voice profile** learned from your sent Slack messages, since you rarely send email.
- Other drafts: follow-up emails from meeting notes; VDP use-case drafts from notes, decks and Slack; DC note regeneration via VDP; weekly status for your manager; meeting-prep briefs.
- Drafts always carry their sources.

## 6. Outbox, approval gate, autonomy ladder

| Level | Meaning | Default for |
|---|---|---|
| L0 Suggest | Shown in the app only | Inferred tasks with low confidence, mappings |
| L1 Draft | Draft exists in the app | Replies, emails, VDP edits, Org62 events |
| L2 Stage | Pushed to the destination *as a draft* (Slack `send_message_draft`, Gmail draft) | Slack and email replies, once you opt in |
| L3 One-click | Executes on approve | Slack send, VDP MCP writes |
| L4 Auto | Executes without a click, audited, undoable where the op allows | Internal, reversible actions: closing tasks, refreshing caches, marking items read **(opt-in)**; and **VDP autopilot** (D-60, opt-in in Settings ▸ Sending): only VDP fills with known values, each an Outbox action approved by the user's autonomy policy (`approval_method = autonomy_policy`), re-checked by the Outbox before the write, read back, within a daily cap |

**Delivery runs once (2026-11-13 audit B3).** An Apply is one queued job with one attempt; the lease reaper never requeues an `outbox.*` job (it goes dead, "needs review", and the worker resolves its item without writing). The attempt is marked `started` (committed) right before the write; a run that finds that mark with no outcome never writes again and ends as `outcome_unknown` ("may have been created: check before you Apply again"), as does a canvas create that got no answer (the relay's timeout). A logging canvas is reviewed row by row before Apply (B2: remove, edit, undo), and one batch is one canvas up to Slack's 1 MiB (B1).

**Handoff adapters** cover destinations the app can't write to. Each produces one *Handoff card* with a deep link, a copy-ready payload, and a "mark done" button that triggers read-back verification:
- **Org62 Solutions Events**, two forms:
  - a pre-filled Lightning `New Event` link per row, verified by a read-back query;
  - a Data Loader / `sf data import bulk` CSV for batches.
  - Target state is direct writes once the connector's write `dispatch` is enabled.
- **Deal Contribution:** a ready prompt plus data for the **"DC Comment Upload"** Slackbot skill (role "AI + Data Architect", 100% split, VDP link in comments).
- **Activity batches:** a ready prompt for the **"Activity Logging in Org62 for SEs"** / "Agentic Solutions Activity Tracking" Slackbot skill, as an alternative to the CSV.
- **Use cases in VDP and Org62 `Use_Case__c` (D-67):** a round trip. VDP → Org62: rows on the same logging canvas (a USE CASES table plus Stage / Go-Live fixes in UPDATE), owned by me, on 100%-DC opps (D-63). Org62 → VDP: `create_use_case` / `update_use_case` items in the VDP tree. Matched by link, else opp + title, read back daily (`org62_use_cases`); drift is judged against the last agreed value, both values shown, never overwritten silently; nothing is deleted; every new use case is checked against both systems first.
- **VDP asset links:** a deep link to the VDP asset section plus the Drive URL on the clipboard, until VDP's server lists `add_vdp_asset`; then each candidate is its own Apply (D-59 feature detection).
- **Travel:** a checklist (Org62 Travel Approval, then Concur booking with the approval number). Completion is inferred from Concur and approval emails.

## 7. Claude integration

- **Ingest:** transcripts are copied incrementally, keeping title, recap, active time, cwd, branch, files touched, cost and `needs_action`. Each becomes a `source_item` and `time_block`s.
- **Retention:** Claude Code deletes transcripts after `cleanupPeriodDays`, which defaults to 30 and isn't set on your machine. Raise it now (D-36); the app keeps its own copy once P1 runs.
- **Hooks** (P6, installed by you; they edit `~/.claude/settings.json`; the event types and payloads are already confirmed in research 05 §7). Each hook call carries the per-install token in a header:
  - `SessionEnd`/`Stop` → `curl -m 2 localhost:4327/api/hooks/claude`, which never blocks Claude;
  - `SessionStart` → inject today's Top 3 plus the open tasks for this repo's account;
  - `UserPromptSubmit` → an attention ping for the time engine.
- **`/cc` skill**, usable from any Claude session: "add task", "log this session to <opp>", "what's next".
- **Launch from the app:** a "Start Claude session" button on a task builds a context pack (sources, VDP, notes) and opens a Claude desktop session or runs an Agent SDK job.

## 8. Security and privacy

- **No new secrets stored.** Credentials are reused from devbar, the Keychain and `~/.claude.json`. The app reads but never copies tokens, and logs never include them.
- **Redaction at ingest:** credential-like patterns (password:, tokens, keys) are masked. This matters: research found plaintext passwords in DMs.
- **Loopback only, with a Host/Origin guard** (PKG-1). The web binds `127.0.0.1` (`-H 127.0.0.1` in the LaunchAgent, `dev:web` and `start`). The root `middleware.ts` runs every request through `guardRequest` (`src/ops/host-guard.ts`): the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` on the app's port, which refuses DNS rebinding (the attacker's page sends its own name), and a POST/PATCH/PUT/DELETE that carries an `Origin` must be same-origin, which refuses cross-site posts from a page open in the browser. Requests without an Origin (curl, scripts, the worker) pass. Anything else gets a short 403. `npm run doctor` (port-owner) warns when the web agent still listens on every interface.
- **Agent jobs** get a tool allowlist. Write tools are denied by default and only the Outbox executor can call them.
- **Research docs contain Org62 IDs and customer names.** Keep `docs/research/` out of any shared or public repo, or redact it before sharing.

## 9. Multi-user ("everyone has their own")

- **Identity is auto-discovered:** Slack `get_me`, Org62 running user, Google profile. The `cc.config.yaml` file holds watch-lists, manager and leaders, autonomy levels, and quiet hours.
- **Team pack** (versioned directory, e.g. `team-packs/<team>/`):
  - deadlines and fiscal calendar;
  - SE Task Type list and definitions;
  - CF/CR rules;
  - the VDP checklist (from the VDP owner) and the logging rules (from SE Ops);
  - Slackbot skill names;
  - targets.

  When leaders change guidance, one PR updates everyone.
- **Distribution:** a repo plus `npm run setup`, which runs a doctor (checks MCPs, devbar, cookie script, Org62 auth), installs launchd, and offers the hooks. A Claude Code plugin for the `/cc` skill and hooks comes later.

## 10. Risks

| Risk | Mitigation |
|---|---|
| MCP auth isn't reusable headlessly (Slack OAuth, Org62 OAuth) | Spike S1/S2. Primary path is headless `claude -p` / Agent SDK jobs that load the same user MCP config; never extract tokens. Watch the cost per poll |
| The 1 h VDP cookie lapses | Worker auto-refresh plus a health banner |
| mcp-adaptor returns text, not JSON | Parsers are contract-tested against recorded fixtures |
| Wrong hours or embarrassing sends | Outbox gate, dry-run validators, read-back verification, *tenet: Hours are human hours* |
| Too many items / duplicates across sources | Cross-source merge. Priority engine caps the first screen. Triage is a separate, batchable queue |
| Rate limits under parallel build/validation (VDP 60 calls/min, a single devbar socket) | One shared client per source with a token bucket; validators run serially against live sources |
| Upstream schema drift (devbar `events.db`, Claude JSONL) | Treat as optional or versioned parsers with health checks |
| Org62 security policy (JWT requirement for integrations) | Stay personal-tool scoped. Writes go through sanctioned paths (Slackbot, UI, Data Loader) |
