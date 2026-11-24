# Decisions

One line per decision. **Why** lives in the linked file: D-76 onwards are ADR-lite files in [`decisions/`](decisions/) (Context, Decision, Consequences, Supersedes; at most 30 lines each). D-1..D-75 were decided in one table between 2026-10-22 and 2026-11-16; that table is kept verbatim in [`archive/decisions-2026-10..11.md`](archive/decisions-2026-10..11.md), and a row gets its own ADR file when it is next touched.

Rules: a new decision is a new file with the next number, plus a row here. An amendment is a new ADR that supersedes or amends the old one; nothing is edited in place. CHANGELOG says what shipped; an ADR says why ([D-94](decisions/0094-docs-tiers-and-adrs.md)). The time, DC and use-case decisions are summarized by the ten rules in [`EDGE-CASES.md`](EDGE-CASES.md) ([D-85](decisions/0085-time-rules.md)).

Status: **accepted** · **accepted, built** / **partly built** · **planned** (accepted, not built yet) · **amended by** (still holds, with a change) · **superseded by** (no longer holds).

## From the holistic review (2026-11-20)

| ID | Title | Status | Date | Link |
|---|---|---|---|---|
| D-76 | Loopback-only web bind with a Host/Origin guard | accepted, built | 2026-11-20 | [0076-loopback-bind.md](decisions/0076-loopback-bind.md) |
| D-77 | PGlite as the app database (2.0), bundled Postgres 17 as the fallback | amended by [D-98](decisions/0098-bundled-postgres.md) (the fallback was taken; PGlite for tests and mock not built) · supersedes D-4 | 2026-11-20 | [0077-pglite-app-database.md](decisions/0077-pglite-app-database.md) |
| D-78 | Slack and Org62 reads go through Claude Code MCP only | accepted, built · supersedes D-37 | 2026-11-20 | [0078-slack-org62-reads-via-claude-code-mcp.md](decisions/0078-slack-org62-reads-via-claude-code-mcp.md) |
| D-79 | A ModelProvider seam now, an OpenAI adapter on demand | accepted, built (the seam; the OpenAI adapter is a stub) | 2026-11-20 | [0079-model-provider-seam.md](decisions/0079-model-provider-seam.md) |
| D-80 | One spend governor: estimate, raise a hand, continue | accepted, built (every paid scan, Assistant turn and background job, relay jobs on one hold each; caps audit F-4) · supersedes D-5 | 2026-11-20 | [0080-spend-governor.md](decisions/0080-spend-governor.md) |
| D-81 | Assistant: Auto model routing and one persisted session per thread | accepted, built · amended 2026-11-21 (router inputs, in the file) | 2026-11-20 | [0081-assistant-auto-routing-sessions.md](decisions/0081-assistant-auto-routing-sessions.md) |
| D-82 | One resolution check decides "is this done?" | accepted, built (watch only by default) · supersedes D-44 | 2026-11-20 | [0082-one-resolution-check.md](decisions/0082-one-resolution-check.md) |
| D-83 | Priority@2: value × urgency, fitted to capacity | accepted, built (previewed beside v1 by default) | 2026-11-20 | [0083-priority-v2.md](decisions/0083-priority-v2.md) |
| D-84 | One attribution engine for time, DCs and use cases | accepted, built | 2026-11-20 | [0084-attribution-engine.md](decisions/0084-attribution-engine.md) |
| D-85 | Time, DCs and use cases: the ten rules are the spec | accepted | 2026-11-20 | [0085-time-rules.md](decisions/0085-time-rules.md) |
| D-86 | One Needs-you queue, Home as a briefing, a seven-item sidebar | accepted, partly built (the queue, the briefing and Plan; the sidebar is still two groups and Triage has not folded in; sidebar History is Journal (D-102)) | 2026-11-20 | [0086-needs-you-queue-and-nav.md](decisions/0086-needs-you-queue-and-nav.md) |
| D-87 | Activity = To log · History · VDP | accepted, built · supersedes D-52, D-72 | 2026-11-20 | [0087-activity-model.md](decisions/0087-activity-model.md) |
| D-88 | UI conventions; the product is named Command Center | accepted, built (the rename by [D-101](decisions/0101-rename-command-center.md); the Tailwind rule is a lint warning) · supersedes D-32 | 2026-11-20 | [0088-ui-conventions-command-center.md](decisions/0088-ui-conventions-command-center.md) |
| D-89 | A localhost app, no desktop shell | accepted | 2026-11-20 | [0089-localhost-app-no-shell.md](decisions/0089-localhost-app-no-shell.md) |
| D-90 | Releases ship as a compiled build in a shared Drive folder | accepted, built · supersedes D-29 | 2026-11-20 | [0090-drive-distribution.md](decisions/0090-drive-distribution.md) |
| D-91 | The installer fetches the VDP cookie script, pinned and hash-checked | planned (not built as of 2.0; Re-auth VDP and docs/INSTALL.md cover it) | 2026-11-20 | [0091-vdp-cookie-script-pinned.md](decisions/0091-vdp-cookie-script-pinned.md) |
| D-92 | Data model 2.0: business state in columns | accepted, partly built (columns by [D-99](decisions/0099-sidecar-to-columns.md), page-scoped reads, retention; the kv keys drop in 2.1) | 2026-11-20 | [0092-data-model-2.md](decisions/0092-data-model-2.md) |
| D-93 | Engineering rules: layers, file length, module tests, two check levels | accepted, built (test projects, both check levels, the length lint and the layer lint as errors; both grandfather lists empty since the post-2.0 splits) | 2026-11-20 | [0093-engineering-rules.md](decisions/0093-engineering-rules.md) |
| D-94 | Docs: living, decisions, reference, archive | accepted, built | 2026-11-20 | [0094-docs-tiers-and-adrs.md](decisions/0094-docs-tiers-and-adrs.md) |
| D-95 | Build commits stay local; Tristan pushes | accepted | 2026-11-20 | [0095-local-commits-never-pushed.md](decisions/0095-local-commits-never-pushed.md) |
| D-96 | Migration discipline | accepted | 2026-11-20 | [0096-migration-discipline.md](decisions/0096-migration-discipline.md) |
| D-97 | No Batch API, no API embeddings; RAG deferred | accepted | 2026-11-20 | [0097-no-batch-api-no-api-embeddings.md](decisions/0097-no-batch-api-no-api-embeddings.md) |
| D-98 | Bundled Postgres 17 as the app database; the 1.x move is verified or nothing switches | accepted, built · amends D-77 | 2026-11-20 | [0098-bundled-postgres.md](decisions/0098-bundled-postgres.md) |
| D-99 | The kv side-car becomes columns and tables (0036) | accepted, built | 2026-11-20 | [0099-sidecar-to-columns.md](decisions/0099-sidecar-to-columns.md) |
| D-100 | The Assistant's `act` applies at once only on the item the turn names | accepted, built (the same own-words test gates `remember` and `run reauth` since SEC-8/9) · amends D-58 | 2026-11-20 | [0100-assistant-act-allow.md](decisions/0100-assistant-act-allow.md) |
| D-101 | Command Center everywhere: package, state folder, LaunchAgents and database renamed, with a boring folder migration | accepted, built · builds D-88 | 2026-11-21 | [0101-rename-command-center.md](decisions/0101-rename-command-center.md) |
| D-102 | To log as three lanes (Fix · Ready · Sending), one count, History owns the past | accepted, built (C1–C11, F1–F7, G1–G4) | 2026-11-23 | [0102](decisions/0102-activity-lanes.md) |
| D-103 | Coverage as data, event-driven DC checks, Opportunity-or-Account targets | accepted; built: coverage, SFR context, dismissal memory, account targets (except "DCs on all N", B-127; B-117 open); events, drafter, backfill and version stamps proposed · amends D-84 | 2026-11-23 | [0103](decisions/0103-coverage-and-event-driven-dc.md) |

## Before the review (D-1..D-75, archived)

| ID | Title | Status | Date | Link |
|---|---|---|---|---|
| D-1 | Run the Q3 catch-up kit outside the app | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-2 | Phase order + running P2/P3/P4 in parallel | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-3 | App form | accepted · reaffirmed by [D-89](decisions/0089-localhost-app-no-shell.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-4 | Stack + port | superseded by [D-77](decisions/0077-pglite-app-database.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-5 | LLM access + spend | superseded by [D-80](decisions/0080-spend-governor.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-6 | Repo hosting | amended by [D-90](decisions/0090-drive-distribution.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-7 | Local data retention | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-8 | Authorize Org62-Sobject-Read for background reads | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-9 | Ask for write dispatch on the Salesforce connector | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-10 | Asks of the vdp-app owner (skill canvases, MCP instructions, upstream PRs) | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-11 | Confirm hours reporting and the quarterly target with SE Ops | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-12 | The 10 legacy Sales Engineer Events | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-13 | Confirm the first-line manager | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-14 | Install Claude Code hooks | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-15 | Default autonomy per action type | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-16 | Slack replies | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-17 | What counts as *your* hours | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-18 | Overlaps (multitasking) | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-19 | Drive / Slides time history | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-20 | Opt-in extra signals | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-21 | Slack ingestion scope | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-22 | Notifications | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-23 | Morning brief vs your Cowork 7am inbox-triage task | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-24 | VIP / importance list | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-25 | Gemini "Next steps" assigned to me | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-26 | Auto-closing tasks | amended by [D-82](decisions/0082-one-resolution-check.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-27 | Build for one user first, then pilot with a teammate | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-28 | Team pack (deadlines, task types, VDP + logging rules) maintainer | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-29 | Distribution | superseded by [D-90](decisions/0090-drive-distribution.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-30 | Build protocol: orchestrator, worktree builders, reviewer, validator | amended by [D-93](decisions/0093-engineering-rules.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-31 | Builder models | amended by [D-93](decisions/0093-engineering-rules.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-32 | Name | superseded by [D-88](decisions/0088-ui-conventions-command-center.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-33 | Visual seed | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-34 | Granola | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-35 | Email vs Slack emphasis | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-36 | Raise Claude Code transcript retention | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-37 | Slack read path | superseded by [D-78](decisions/0078-slack-org62-reads-via-claude-code-mcp.md) | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-38 | Org62 batch commit tool | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-39 | What happens when VDP/Org62 auth lapses (cookie, Okta MFA every 8–12 h) | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-40 | `Duration__c` rounding | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-41 | Gemini next steps with shared or unmatched assignees | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-42 | Teammate prerequisites for P7 | accepted | 2026-10-22 | [archive](archive/decisions-2026-10..11.md) |
| D-43 | Chat and the global daily hard cap (B-068) | amended by [D-80](decisions/0080-spend-governor.md) | 2026-11-06 | [archive](archive/decisions-2026-10..11.md) |
| D-44 | How work items get marked done | superseded by [D-82](decisions/0082-one-resolution-check.md) | 2026-11-06 | [archive](archive/decisions-2026-10..11.md) |
| D-45 | Go live on real data | accepted | 2026-11-06 | [archive](archive/decisions-2026-10..11.md) |
| D-46 | VDP writes from the app | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-10 | [archive](archive/decisions-2026-10..11.md) |
| D-47 | Where a logging batch goes | accepted · summarized by [D-85](decisions/0085-time-rules.md) · amended 2026-11-23: one canvas table per object and verb (WO-1) | 2026-11-10 | [archive](archive/decisions-2026-10..11.md) |
| D-48 | When logging runs | accepted | 2026-11-10 | [archive](archive/decisions-2026-10..11.md) |
| D-49 | Who runs the first real canvas and VDP write | accepted | 2026-11-10 | [archive](archive/decisions-2026-10..11.md) |
| D-50 | How the VDP client authenticates | accepted | 2026-11-10 | [archive](archive/decisions-2026-10..11.md) |
| D-51 | The Assistant digging deeper | accepted | 2026-11-10 | [archive](archive/decisions-2026-10..11.md) |
| D-52 | Where admin items are reviewed and applied | superseded by [D-87](decisions/0087-activity-model.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-53 | VDP assets: how candidates are found and what they cost | accepted | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-54 | Planning the next day on Home | amended by [D-86](decisions/0086-needs-you-queue-and-nav.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-55 | Personas: how the app adapts to a role | accepted | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-56 | Feedback: how a bug or idea gets to the team | amended by [D-90](decisions/0090-drive-distribution.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-57 | Versions | accepted | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-58 | The Assistant: one-off tools or general abilities | amended by [D-81](decisions/0081-assistant-auto-routing-sessions.md), [D-100](decisions/0100-assistant-act-allow.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-59 | VDP automation: what the app writes, and how a VDP reads as done | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-60 | VDP autopilot: what the app applies by itself | accepted, built · amended 2026-11-21 (asset host allowlist, SEC-6) · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-11 | [0060-vdp-autopilot.md](decisions/0060-vdp-autopilot.md) |
| D-61 | Needs rows: what counts as a DC gap, and how any row is cleaned up | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-62 | Dead data: what the app cleans up by itself, and how | accepted | 2026-11-11 | [archive](archive/decisions-2026-10..11.md) |
| D-63 | VDP: what is in scope, how the Changes tab reads, and how a push runs | amended by [D-84](decisions/0084-attribution-engine.md) · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-12 | [archive](archive/decisions-2026-10..11.md) |
| D-64 | Work for no customer, and meetings I declined | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-12 | [archive](archive/decisions-2026-10..11.md) |
| D-65 | Time ↔ Org62: how an app row finds its Org62 Event, and what happens when one side changes | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-12 | [archive](archive/decisions-2026-10..11.md) |
| D-66 | The Org62 Description of a logged row | accepted | 2026-11-12 | [archive](archive/decisions-2026-10..11.md) |
| D-67 | VDP use cases into Org62 (Use_Case__c) | amended by [D-84](decisions/0084-attribution-engine.md) · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-12 | [archive](archive/decisions-2026-10..11.md) |
| D-68 | DCs ↔ Org62 round trip: what an Org62 read does to my requests, gaps and book | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-12 | [archive](archive/decisions-2026-10..11.md) |
| D-69 | VDP: which VDP company an engaged account belongs to, and the round trip's guards | accepted | 2026-11-12 | [archive](archive/decisions-2026-10..11.md) |
| D-70 | Where every record lands, and every write that put it there | accepted · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-14 | [archive](archive/decisions-2026-10..11.md) |
| D-71 | Time rows that need an opportunity: who suggests, how verified | amended by [D-84](decisions/0084-attribution-engine.md) · summarized by [D-85](decisions/0085-time-rules.md) | 2026-11-14 | [archive](archive/decisions-2026-10..11.md) |
| D-72 | Activity: one page for Org62 and VDP, one job per tab | superseded by [D-87](decisions/0087-activity-model.md) | 2026-11-14 | [archive](archive/decisions-2026-10..11.md) |
| D-73 | Live updates: how every page applies what the backend pushes | accepted | 2026-11-14 | [archive](archive/decisions-2026-10..11.md) |
| D-74 | A VDP push: how long the click waits, and what happens while one runs | accepted | 2026-11-16 | [archive](archive/decisions-2026-10..11.md) |
| D-75 | Where Activity's writes show (logging and forecast canvases, VDP changes) | accepted | 2026-11-16 | [archive](archive/decisions-2026-10..11.md) |
