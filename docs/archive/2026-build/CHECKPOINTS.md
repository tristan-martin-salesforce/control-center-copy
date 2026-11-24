# UI pivot build log

This is the orchestrator's checkpoint log. Read it top to bottom after any context compaction. The newest entry is at the bottom.

## Standing decisions (2026-11-05)

### Answered by Tristan
- **Mock data:** real context, local only. The fixture lives outside the repo at `~/Library/Application Support/control-center/fixtures/seed.json`. A committed placeholder fallback lives in `src/mock/`.
- **Send:** the composer has a per-message **Draft ↔ Send** toggle. Both modes go through preview, then confirm, then read-back verify. A global dry-run switch defaults to on until he turns it off. Builders never send.
- **Kick-offs:** start on one click (revised 2026-11-05).
  - **Big items** open a **new Claude Code session**, shown in the Claude Desktop Code tab, which is Tristan's interface. Open it via `claude://code/new?folder=<abs repo path>&q=<context-packed prompt ≤14336 chars>`. Tristan manages the session in Claude. The prompt carries a `[cc:<work_item_id>]` tag, so the app links the session deterministically.
  - **Monitoring:** status comes from the live registry `~/.claude/sessions/<pid>.json` (`busy`/`idle`/`waiting` + `waitingFor`), with the transcript at `~/.claude/projects/<cwd-slug>/<id>.jsonl`.
  - **Deep links:** `claude://code/continue?session=<id>` (verify that it accepts ids) and `claude://code/needs-input`.
  - **Small runs** (tool HTTP APIs such as talk-track and pulse-footprint, read-only research) run in-app/headless and return a link.
  - Bypass mode is never used.

- **Cost:** about $1.50 per workday is acceptable (Tristan, 2026-11-05). Defaults:
  - soft budget $5/day, with an alert at 80%;
  - hard cap $15/day (D-5), where scanners degrade to deterministic-only and NBA drafts pause.

  Both are configurable in Settings.

### Orchestrator calls (from recon)
- **Stack:** follow vdp-app:
  - Next 15 / React 19 / Tailwind v4;
  - Drizzle + `pg` on local Postgres 17 (Homebrew, already running on :5432). The DB is `control_center`;
  - zod, pino, recharts;
  - **no Redis**: the job queue is a Postgres table using `SKIP LOCKED`.
- **Look:** VDP Studio tokens, copied verbatim and densified for a full-screen cockpit from 1280 to 2560 px. Light theme.
- **LLM:** Agent SDK (TypeScript). Haiku runs the scanners and classify/link; Sonnet runs NBA, drafts and chat (switchable to Opus). There's a daily budget meter.
- **Port:** 4327 for the web app. The worker has no port.
- **Private data:** `docs/research`, `docs/q3-catchup`, `docs/dc-sweep` and the autopilot config are gitignored. Research outputs sit at absolute paths in the main checkout. Builders in worktrees read them by absolute path.

## Log

### CP-0: 2026-11-05: repo init + research launched
- `git init` (main @ 6c2b810). Requirements are captured in `docs/archive/2026-build/REQUIREMENTS.md`.
- Five research agents launched:
  - 07 VDP design system ✅ done;
  - 08 UX patterns;
  - 09 headless connector spike and costs;
  - 10 local signals inventory;
  - 11 data model draft.
- 10 local signals ✅ done. Key facts:
  - session status comes from `~/.claude/sessions/<pid>.json`;
  - training senders are Field Readiness, CLO compliance and Trailhead, plus the Slack "Astro's Course Tracker" bot, whose payload is empty and still needs checking;
  - talk-track and pulse-footprint have HTTP APIs that stream progress;
  - autopilot: port it to TS later (about 6–7 days) and bridge to the Python CLI until then;
  - the example background promise was made 2026-08-27.
- 08 UX patterns ✅
  - **Pick: wireframe B.** Day spine, Now stack (top 3 NBA cards), status rail, and chat.
  - IA: Today, Triage, Work, Deals, Agents, Time, Outbox. Health is a dot; Settings sits under the user menu; ⌘K is search.
  - The open questions are defaulted: Sure closes automatically and Likely asks to confirm; chat is docked; dragging on the spine only re-plans internally; `e` means edit.
- 09 headless spike ✅
  - Slack and Org62 work via `claude -p` with Haiku and a restricted single-server MCP config. OAuth carries over.
  - Gmail, Calendar and Drive go through **devbar's local `google_workspace_readonly` MCP server, called directly with no LLM** (36 read tools).
  - The UUID claude.ai connectors don't load headless. VDP's cookie expired 10/26.
  - Cost is about $1.50 per workday: scanning about $0.51, NBA drafts on Sonnet about $1.00.
  - Pattern: Haiku makes the tool call, a hook captures the raw result, and deterministic code parses it.
  - Re-auth: Slack and Org62 need `claude mcp login <name>` in Terminal. Google can re-auth in-app. VDP refreshes silently until MFA is required.
  - The Agent SDK isn't installed yet; that happens in wave 0.
- New requirements added: R-UI-15 Drive signal, R-UI-16 per-user policy, R-UI-17 Salesforce brand, R-UI-18 a save model per surface plus undo everywhere, R-UI-19 a feedback matrix and error handling.
- 12 Salesforce brand research launched.
- Postgres DB `control_center` has been created. Use `/opt/homebrew/opt/postgresql@17/bin/psql`, because the `psql` on PATH is v16.
- Ports 4345–4352 are reserved for worktree previews.
- Next: synthesize `docs/archive/2026-build/UI-SPEC.md` and `docs/reference/DATA-MODEL.md`, then run wave 0 (scaffold + contract), then waves 1 and 2 in parallel worktrees.

### CP-1: 2026-11-05: research done, specs written, wave 0 running
- Research done:
  - 08 UX: wireframe B;
  - 09 spike: Slack and Org62 via Haiku `claude -p` with a restricted MCP config; Google via devbar `google_workspace_readonly` direct, no LLM; about $1.50/day;
  - 10 signals;
  - 11 data model: 108 tables, adopted as `docs/reference/DATA-MODEL.md` with 10 orchestrator decisions;
  - 12 Salesforce brand: Salesforce Sans, SLDS 2 tokens, `@salesforce-ux/icons`, Lightning chrome (header 44 + nav 36 + utility bar 32). The brand ramp defaults to Lightning Blue #0176D3, with a Cosmos toggle.
- Specs committed: `UI-SPEC.md` v1, `BUILD-PLAN.md` (waves, ownership, API surface), and requirements R-UI-15…21:
  - Drive signal;
  - per-user policy;
  - Salesforce brand;
  - save model per surface;
  - feedback matrix and errors;
  - async, optimistic and concurrency;
  - watch subscriptions and briefs.
- **W0 foundation running** in a worktree, launched from main@805ed4a. It covers the scaffold, contract, mock DataSource, routes and scenario clock.
- **SEED-raw running.** It writes real raw context to `~/Library/Application Support/control-center/fixtures/raw/`.
- Contract decision sent to W0: background promise = `commitment` with `isBackground`, not a separate kind.
- Next, after W0 lands:
  - merge it;
  - launch wave 1: FE-1, BE-1 (schema from DATA-MODEL.md split by domain), BE-2, and SEED-map (raw → `seed.json` per the contract).

### CP-2: 2026-11-05: parallel lanes widened (Tristan asked for maximum parallelism)
- The binding `docs/reference/SCANNER.md` and the shared `src/scanner/types.ts` are committed (main@e672f01).
- **Running in parallel worktrees:**
  - W0 (scaffold, contract, mock);
  - BE-0 (schema);
  - BE-2a (scanner runtime + Slack/Org62 skills);
  - BE-2b (Google/Drive/Claude-sessions fetchers + skills);
  - LIB-compose (serializers);
  - TOOLS (adapters + Claude launcher);
  - SKILLS-NBA (NBA/draft/brief skills, voice profile, evals).
- SEED-raw is done. Real raw context is in `~/Library/Application Support/control-center/fixtures/raw/` (11 files).
  - Finding: no Solutions Events after 10/23 in Org62, and 21 autopilot rows (about 35 h, 10/26–11/3) are unconfirmed.
- Pre-W0 lanes don't commit package.json, lockfile or tsconfig. At merge, reconcile their `deps_needed` into W0's package.json.
- Next:
  1. When W0 lands, launch FE-1 and SEED-map.
  2. When W0 + BE-0 land, launch BE-1. Its data layer includes the DB `ScannerStore` mirroring BE-2a's in-memory semantics.
  3. Then run wave 2: FE-2…6, BE-3, BE-4 (outbox/send adapters), BE-5, BE-6.
- **TOOLS merged** (main@4357a2d):
  - manifests for talk-track, pulse-footprint, the estimator, and estimate-new (a `claude_session`);
  - loopback-only adapters with a central confirm gate;
  - the Claude launcher (`continue?session=` takes only the desktop `local_…` hostSessionId, and `claude://resume?session=<CLI UUID>` imports a session);
  - the repo resolver.
  - Incident: the agent's recon ran the estimator CLI export, which wrote one file into `~/Projects/afd360-estimates/acme/exports/`. The agent deleted it, and the adapter now always passes `--out`.
  - BE-2b was told to emit `hostSessionId`.
- **LIB-compose merged**:
  - 143 tests;
  - no TipTap or DOM dependency;
  - `payloadFor`, `serialize`, `renderPreview` (derived from the payload) and `lossyForSwitch`;
  - mrkdwn/email parsers.

  Reconcile notes:
  - the profile `plain` vs the enum `plain_text`;
  - **SECURITY follow-up: the lane wrote its own HTML sanitizer. Any rendering of *untrusted* HTML (incoming email bodies, `parseEmailHtml` input) must also pass through DOMPurify (`isomorphic-dompurify`, in W0 deps) before `dangerouslySetInnerHTML`. The custom sanitizer stays as a pre-pass. FE-2 and WIRE must enforce this.**

### CP-3: 2026-11-05: more parallel lanes
- Launched three more lanes, all pure logic or tooling that gets wired in later:
  - **ENGINES-core**: priority/sequencing/fit-ins/rank stability/policy preview, the closure state machine (Sure/Likely, reopen vs sibling, handed-off loop-back, locked fields → proposals), re-eval coalesce/generation. Owns `src/engines/{priority,closure,reeval}/**`.
  - **ENGINES-org62**: the TS port of the autopilot (blocks → Solutions Event rows, caps, CF/CR, canvas renderers + edit parser, read-back, "unconfirmed" gap), plus the missed-opp classifier and narrowing. Owns `src/engines/{activity,deals}/**`.
  - **OPS**: launchd templates (NOT installed; this needs Tristan's OK), doctor, setup, backups, notifications, re-auth actions (gated, never executed in the build), heartbeat/lifecycle helpers.
- Running now: W0, BE-0, BE-2a, BE-2b, SKILLS-NBA, ENGINES-core, ENGINES-org62, OPS. Merged: TOOLS, LIB-compose.
- BE-3/BE-5 in wave 2 shrink to wiring these engines into the data layer and jobs.

### CP-4: 2026-11-05: W0 merged; frontend fan-out
- **W0 merged.** `npm run check` on main covers 247 tests (W0 + TOOLS + compose). Key W0 conventions:
  - the route table key is the DataSource method and the client call name (`api('patchItem', {params, body})`);
  - `queryKey()[0]` is the live topic;
  - after a contract route change, run `npm run gen:routes`;
  - mutations return `{entity, auditId, receipt?}`, and a stale ifVersion gives 409 with `details.current`;
  - the mock clock is `CC_MOCK_NOW`; scenario seek is deterministic;
  - the mock DataSource lives on `globalThis`, so mock code edits need a dev-server restart.
- Contract additions accepted: the `resolve` verb, `POST /today/rerank`, `POST /policy/revert`, `PATCH /watches/:id`, and the dev routes.
- **Reconcile at WIRE:** there are two ToolAdapter manifest schemas. **Decision: TOOLS' `src/tools/manifest.ts` is the source of truth**, and the contract's agents.ts ToolAdapter view derives from it.
- Brand tokens are at `src/styles/brand.css` (the shared visual contract). The default `data-sf-theme="lightning-blue"`.
- **Frontend fan-out launched** (each lane has its own port and a `/dev/kit/<lane>` gallery):
  - FE-1a chrome + primitives + interaction system (4345): `src/ui/**`, shell, keyboard, toasts, autosave/optimistic, ⌘K, SideSheet, dev toolbar.
  - FE-1b domain components (4346): NbaCard, WorkRow, DaySpine/Ribbon, HeaderStrip, StatusRail, shelves, Receipt/Proposal, AgentRunRow, BriefHighlight, ConnectorRow, ActivityRow, ResolvePicker, plus a composed Today mock-up. Uses `_bits` stand-ins with `@/ui` names and props.
  - FE-1c Composer UI (4347): TipTap, destination chip, lossy list, preview = payload + DOMPurify, payload view, Draft↔Send, confirm, 10 s undo, autosave, proposals.
  - FE-1d Chat dock (4348): SSE hook, receipts with undo, proposals, context chips, `@`/`/`, extended chat-script.
  - SEED-map (4349): raw → `seed.json` outside the repo, validated against the Seed schema.
- After they merge:
  1. Swap `_bits` → `@/ui` (mechanical).
  2. Page lanes: Today composition, Work/Triage/Outbox/Briefs, Deals/Agents, Time/Health/Settings, item/initiative detail.
- Running total: 12 lanes in flight: BE-0, BE-2a, BE-2b, SKILLS-NBA, ENGINES-core, ENGINES-org62, OPS, FE-1a, FE-1b, FE-1c, FE-1d, SEED-map.
- **BE-2b merged:** 207 tests, plus a live smoke test (read-only, no LLM).
  - The Google server is devbar HTTP MCP at `localhost:13316/proxy/mcp/server/google_workspace_readonly/mcp`; devbar owns auth; re-auth is in-app via devbar commands.
  - Drive digests baseline silently on first sight.
  - The Claude watcher emits `sessionId` + `hostSessionId` and `ccTag`.
  - Main is now at 454 tests.
- Scanner contract additions:
  - `expected?` on OpenItemDigest;
  - `ScannerStore.recordBriefHighlights` (BE-2a was told to expose it as the `cc_record_brief_highlights` tool);
  - the launched-session link convention `threadRefs: ["cc:<workItemId>"]` (BE-6's launcher must record it).

### CP-5: 2026-11-05: BE-0 merged; data layer split
- **BE-0 merged.**
  - 108 tables, 139 enums, audit trigger on 48 tables, plus helpers: `withChangeSet`, `queue.ts`, `scan.ts`, `queries.ts`. 52 DB tests.
  - The drizzle.config and schema.ts placeholders were resolved to BE-0's versions.
  - `db:migrate` = `tsx src/db/migrate.ts`; `test:db` now runs in `check`; the main vitest config excludes `tests/be0`.
  - `control_center` is migrated (109 tables, including drizzle's).
- **Launched:**
  - **BE-1a** worker runtime + `DbScannerStore` + pg LISTEN/NOTIFY EventBus + deterministic scan handlers + retention scrub (DB `control_center_be1a`);
  - **BE-1b** the Postgres `DbDataSource` for every route + `seed-from-mock` + mock/db parity tests (DB `control_center_be1b`, port 4351).
- In flight: BE-2a, SKILLS-NBA, ENGINES-core, ENGINES-org62, OPS, FE-1a, FE-1b, FE-1c, FE-1d, SEED-map, BE-1a, BE-1b.
- **OPS merged:** 63 tests.
  - Doctor on this Mac: 7 ok, 6 warn, 0 fail. The warnings are fonts not synced on that branch, the VDP cookie expired about 10 days ago, talk-track and pulse are down, there's no env file, LaunchAgents aren't installed, and there's no heartbeat yet.
  - **The LaunchAgents are NOT installed, and that needs Tristan's OK.**
  - BE-1a must wire HeartbeatWriter, Lifecycle, WakeDetector, SingleInstanceLock, `backupDue()`/`runBackup()` and the Notifier (sketch in `docs/reference/OPS.md`).
  - Notes:
    - doctor reads the VDP Authorization and Cookie from `~/.claude.json` **in-process only**, to report presence and expiry; it never prints them;
    - Terminal re-auth runs `claude mcp login <name>` immediately (on an explicit click);
    - devbar shell-outs must close stdin.
  - Main: 517 + 52 tests.
- **ENGINES-org62 merged:** 87 tests.
  - Contents: the TS port of the autopilot, canvas renderers plus a parser that accepts Slack's stored table form, `verifyReadback` with `unconfirmed` + `LoggingGap`, the missed-opp engine, and SOQL builders.
  - **Live finding:** the work-order canvas <work-order-canvas-id> currently holds 23 ADD + 10 legacy-delete rows (36 h), so the Slackbot work order hasn't been executed. This is the 10/26–11/3 "unconfirmed" gap.
  - Assumptions defaulted: CC = CR; the threshold uses opp Amount; `ace` is only a weak signal; two weak evidences make a Claim.
  - Type reconciliation at WIRE: `seTaskType`/`meetingType` by name; `unconfirmed`/`missing` are derived read-back results.
- **SKILLS-NBA merged:** 16 skills, prompt builders and validators, and the voice builder.
  - Live evals: 20/20 for $0.47.
  - The voice profile is saved locally (`~/Library/Application Support/control-center/voice/profile.json`, 0600).
  - Main: 686 + 52 tests.
  - **Agent SDK auth finding:** a child launched from the desktop app must strip the host-session vars and pass the gateway env plus `apiKeyHelper` from `~/.claude/settings.json`. See `src/engines/nba/prompt/complete.ts`. BE-2a was asked to move this into `src/llm/claude-env.ts`.
  - Reconcile at WIRE:
    - the `nba_type` enum lacks `review_deliverable` (mapped to `confirm_done` for now);
    - brief levels: high → `must_read`, medium → `worth_a_look`;
    - `voice_profiles` has no customer-facing guide column;
    - zod: the SDK wants ^4 while we're on 3.25 with overrides. Tests pass on both, so stay on 3.25.
  - Security note to Tristan: a group DM contains a 1Password share link to demo credentials; he should rotate them.
- **SEED-map merged** (code only, in `scripts/seed/`).
  - The real seed is at `~/Library/Application Support/control-center/fixtures/seed.json`, with the private narrative in `overlay.mjs` beside it. I tightened both to 600 and the dirs to 700.
  - Counts: 45 items, 10 initiatives, 67 events, 27 runs, 52 missed opps, 54 activity rows, 5 briefs.
  - Top 3: ACME smoke-test before the 13:30 MT review, Globex Flex back-work by EOD, and the Initech reply to Peter before the 14:30 prep.
  - The scenario's 8 events fire on real items. Timezone: America/Denver.
  - Regenerate with `npm run seed:real`.
- **BE-2a merged:** 73 tests.
  - The live Slack smoke test passed on Haiku: $0.017, 25 turns, 20 source items, 3 work items, 4 unlinked, 8 ledger entries, cursor committed.
  - Shared `src/llm/claude-env.ts`; `complete.ts` now re-exports it.
  - Memory-store semantics S1–S18 are in the header of `src/scanner/store-memory.ts`. BE-1a's DB store must mirror them.
  - Job mapping: `scan.<connector>` jobs call `executeJob(job, signal)`, then `followUps`/`retryAt`.
  - **Cost note:** each Slack inbox run carries a prefix of about 20K tokens, so 2-min Slack is about $1/day (the target was $0.50). Levers are a shorter skill, a slower cadence, or `settingSources: []`. Default for now: keep 2 min with adaptive backoff. Total is about $2/day, within the $5 soft budget.
  - The optional contract extensions in `src/scanner/runtime/contract-ext.ts` get folded into `types.ts` at WIRE.
  - Main: 759 + 52 tests.
- **ENGINES-core merged:** 131 tests, including property tests that found and fixed 3 edge cases. It covers the full state × signal table (14 × 20) and `docs/reference/ENGINES.md`.
  - Decisions:
    - reopen window **14 days** (overrides DATA-MODEL OQ-7's 7);
    - `never_above` beats `lane_floor`;
    - pre-emption applies only to the new Top 3;
    - snooze wakes on timer or direct ask (`snooze.wake_on_new_info` is a setting).
  - Known gap: the horizon uses a fixed UTC offset, so DST is off by 1 h inside the window.
  - Type reconciliation (engine ↔ W0 contract) is in ENGINES.md §5. The engine's WorkItemStatus has `merged`, and "reopened" is a label on `open`.
  - Main: 890 + 52 tests.
- **FE-1d merged.** Chat dock, tab and ask bar; receipts with per-line undo; proposals; context hook; `/` and `@`. Playwright 28/28. I reviewed the kit screenshot and the quality is good.
  - Main: 918 + 52 tests.
  - Exports: `ChatProvider`, `ChatDock`, `ChatTabPanel`, `AskBar`, `setChatContext`/`useChatContext`, `focusChat`, `CHAT_HOTKEY`, `useChatPlacement`.
  - The kit page has its own `kit.css` brand import; delete it once FE-1a's globals.css imports `brand.css`.
- **CONTRACT-1 launched** (port 4352) to close FE-1d's chat blockers:
  - ChatOps recorded as actor `chat` with no user-lock; `POST /chat/threads`; model choice; server-persisted chat parts.
  - It also folds in the scanner contract-ext, the ToolAdapter view derived from `tools/manifest`, the compose `plain` ↔ `plain_text` mapping, and NBA `review_deliverable` (plus a DB enum migration).
- **FE-1b merged.** All the domain components plus `/dev/kit/domain` and the `/dev/kit/domain/today` wireframe-B mock-up. I reviewed the 1440 and 2560 shots and the quality is good.
  - Main: 927 + 52 tests.
  - Props and callbacks are in FE-1b's return (summarized in its kit). Wrap pages in `<DomainClock now tz>`.
  - Previews use LIB-compose `renderPreview` plus DOMPurify.
  - Seed nit: `dr_globex_sow` has userTouched but `update.kind` 'revised'.
  - The ScannerPulse showed "Live · 2552s"; the mock clock formatting needs fixing in page wiring.
- **Next, after FE-1a + FE-1c merge:**
  1. Page lanes P1 Today, P2 item detail/initiative + composer, P3 Work/Triage/Outbox/Briefs, P4 Deals/Agents/Tools, P5 Time/Health/Settings.
  2. A SWAP lane: `_bits` → `@/ui`, shell integration of the chat rail.

### CP-6: 2026-11-05: FE-1a merged; page assembly
- **FE-1a merged.**
  - It brings `@/ui` primitives, the shell (GlobalHeader, NavBar + Tools launcher, UtilityBar, AppFrame with `chatRail` slot, `RailPanel`, `NavStrip`, `useShell`), keyboard (`useKeyBinding`, `useKeyScope`, `useListKeys`), the ⌘K `useCommands`/`useFocusedCommands`, `toast` (with undo), `useOptimisticMutation` (+ `versionOf`), `useAutosave`, the resume hooks, the dev toolbar, and `/dev/kit/primitives`. Playwright 39/39.
  - I fixed its blocker: `isAppError` makes 409s survive cross-bundle in dev.
  - `devIndicators: false`; the placeholder nav is removed; `app/dev/layout.tsx` gating is confirmed.
  - Main: 966 + 52 tests.
- **Launching page lanes:**
  - SWAP (`_bits` → `@/ui`, chat into the shell, pulse fix);
  - P1 Today;
  - P3 Work/Triage/Outbox/Briefs;
  - P4 Deals/Agents/Tools;
  - P5 Time/Health/Settings;
  - P2 (item detail/initiative + composer) starts after FE-1c merges.
- **FE-1c merged.** The composer: `Composer`, `ComposerInline`, `ConfirmSendDialog`, `SendCountdownToast`, and the `SendFlow`/`DraftAutosave` classes. Playwright 37/37, with no non-localhost requests.
  - Main: 998 + 52 tests, after de-flaking two tests under load.
  - Its blockers:
    1. 409 → 500: already fixed via `isAppError`.
    2. The mock's `render.ts` isn't `lib/compose`. Sent to CONTRACT-1: the server must use `payloadFor`/`renderPreview`.
    3. There's no people route with Slack ids. Sent to CONTRACT-1: `GET /people?q`.
  - Also: LIB-compose `parseSlackMrkdwn` turns "- " lines into bullets, but Slack shows literal hyphens. Assigned to CONTRACT-1.
  - The composer `_bits` swap goes to P2.
- **Page lanes running:**
  - SWAP (4345);
  - P1 Today (4346);
  - P3 Work/Triage/Outbox/Briefs (4347);
  - P4 Deals/Agents/Tools (4348);
  - P5 Time/Health/Settings (4349);
  - P2 item detail/initiative + composer swap (4350); it exports `renderItemSheet`. Point P1 and P3 at it after the merge.
- Backend lanes still running: BE-1a, BE-1b, CONTRACT-1.
- The shared brief for page lanes is `docs/archive/2026-build/PAGE-LANE-BRIEF.md`.

### CP-7: 2026-11-05: backend merged; integration
- **SWAP merged.** No more `_bits` in domain and chat; chat is mounted in the shell's built-in Assistant tab and column; the pulse is humanized.
  - Open question for the review: the dock collapse vs the rail `]` collapse. Default: keep them separate.
- **BE-1a merged.** Worker job loop, schedules and catch-up via BE-2a's ScannerRuntime, `DbScannerStore` (conformance 25/25 against both stores), pg LISTEN/NOTIFY live events plus `onChangeSetCommitted`, and retention scrub.
  - The live check covered 183 items over 44 runs, and a restart resumed at the cursors with zero duplicates.
  - Scanning is ON only under `NODE_ENV=production` (`CC_LIVE`, `CC_SCAN_LLM`).
  - It fixed `windowAligned` coverage bugs for claude_sessions and calendar.
- **CONTRACT-1 merged.**
  - Chat ops are recorded as actor `chat` (no lock).
  - New: `POST /chat/threads`, the model choice, persisted chat parts, `GET /people`, the ToolAdapter view from manifest, a single serializer (the mock uses lib/compose), and the "- " fix.
  - `nba_type` `review_deliverable` is a DB migration (0004). The contract NbaVerb doesn't have it yet; it needs vocab.ts maps in the same commit.
- **Disk:** it hit about 1 GB free mid-run. I removed merged worktrees and it's back at about 11 GB.
- **Tests:** they use per-checkout DB names now (`*_main`), so they no longer race other lanes.
- Main: 1053 + 53 + 87 tests, all green.
- **BE-1b done but NOT merged yet.** It was built against the pre-CONTRACT-1 contract. It covers 74 routes (64 equivalent + 10 documented differences) plus `seed-from-mock`. Its blockers:
  - B1: training/travel detail tables have no `id`, so the audit trigger fails;
  - B3: `shot.mjs` is mock-only;
  - B4: policy weight names;
  - B5: jobs, events and scores aren't audited.

  It goes in via INTEGRATE-1.
- **P5 merged** (Time, Health, Settings). Playwright 47/47. Imports were repointed from `domain/_bits/*` to `domain/lib/*`.
- **CONTRACT-2 backlog** (from P5):
  1. a `thresholds` settings section (persists in localStorage for now);
  2. logging-gap fields: `lastOrg62EventAt` and an unconfirmed-hours total;
  3. a work-order canvas URL setting;
  4. readback enum values `unconfirmed`/`missing`;
  5. a git lane in the timeline;
  6. the QTD CF/CR/CC split;
  7. ScanRun `skillVersion` and coverage list;
  8. an opps list route;
  9. Job/EventLogEntry `version`.
- **P4 merged** (Deals + Missed + account pages, Agents, Tools). Playwright 68/68 on the real seed. I fixed the launcher links.
  - Main: 1094 + 53 + 87 tests.
  - **CONTRACT-2 additions:**
    - structured MissedOpp fields: `lockDeadline`, `splitNote`, `stranded`;
    - `Opportunity.dcRole` and `dcSplitPct`;
    - ToolAdapter `estimatedDuration` and a privacy note (CONTRACT-1 may already have added these);
    - a run log endpoint;
    - app-run retry;
    - cancel/start for queued Claude sessions (AgentRunRow label "Start");
    - an account notes patch route.
- **P3 merged** (Work, Triage, Outbox, Briefs).
  - Playwright: Work 34/34, Outbox 26/26, Triage 26/29 and Briefs 27/28. The misses are script or seed-reuse artifacts; edit-then-accept on a clean seed is unproven, so check it in the review.
  - It has its own `ItemSheet` seam (`src/components/lists/ItemSheet.tsx`, `TODO(P2)`).
  - Main: 1139 + 53 + 87 tests.
  - **CONTRACT-2 additions:** `POST /drafts/:id/reject`, and resolving watch channels to ids.
  - Note: P3 wrote its own `useOpenKeys`, because `useListKeys`' window-level Enter cancelled button clicks. **Fix `useListKeys` in FE-1a code** (scope Enter to the list container) at POLISH.
- **P1 Today merged.** It runs on the real seed. Playwright: keyboard 19/19, mutations 19/19, scenario 15/15, sheets 12/12, proposals 8/8, panel states 5/5.
  - I reviewed today-1440 and the quality is high.
  - Top 3: ACME smoke-test (start by 08:35), Globex status (09:05), Peter (Initech, 14:30).
  - Review screenshots are saved in the scratchpad `review/` folder.
  - Main: 1165 + 53 + 87 tests.
- **POLISH list** (from P1 and P3):
  - NbaCard: it cancels every Escape, and `n` on a collapsed card toggles chips that don't render;
  - `useOptimisticMutation` cancels in-flight first fetches, which can leave a skeleton stuck;
  - `useListKeys`: the window-level Enter cancels button clicks;
  - a "Not done yet" verb for likely_done;
  - include reopened/looped-back items in `/today`;
  - a spine re-plan route (CONTRACT-2);
  - the fit-in "150m · 2h30m" duplicate label;
  - the pre-empt flag in the Today payload.

### CP-8: 2026-11-05: mock complete; ready for Tristan's review
- **P2 merged.** ItemDetail (sheet = page), `/work/[id]`, `/initiatives/[id]`, capture enrichment, composer on `@/ui`. Playwright 25/25.
  - Today and list sheets now render `ItemDetail`. I verified it live on :4327: Enter on card #1 opens the full detail, with no console errors.
  - Main: 1193 + 53 + 87 = 1333 tests, all green.
- POLISH additions from P2:
  - **`useOptimisticMutation` 409 rebase uses the cache that the live refetch already replaced, so concurrent edits are silently overwritten.** Fix in `@/client` (P2 worked around it in the detail view).
  - Enrichment chip accept/reject route, initiative write routes (regenerate the summary), and remove the deprecated composer `_bits` once `/dev/kit/composer` moves to `@/ui`.
- The app runs at http://localhost:4327 (preview `control-center`) on the real seed (mock mode).
- Still running: INTEGRATE-1 (the db DataSource on the current contract + ENGINES-core ranking).
- Pending user decisions:
  - mock review feedback;
  - running the Slackbot work order (36 h);
  - installing the LaunchAgents (later);
  - the dock collapse vs `]` (minor).
- After the review:
  1. POLISH + CONTRACT-2 lane(s) for the review feedback and backlogs;
  2. BE-6 (chat backend: Agent SDK + cc tools for chat + session launcher);
  3. BE-4 (outbox send adapters, gated by dry-run);
  4. WIRE (`CC_DATA=db`, worker under launchd, end to end).
- **INTEGRATE-1 merged.**
  - The Postgres DataSource is on the current contract: 67 of 76 routes are equivalent, and 9 differences are documented.
  - ENGINES-core drives `/today`, policy preview and re-rank.
  - Chat threads and messages persist (it streams `start` then a "BE-6 not wired" error).
  - Policy weight-name map; migrations 0005 (audit row key for detail tables) and 0006 (scores cascade with the policy version).
  - `review_deliverable` is in the contract plus vocab; `shot.mjs` works in db mode; `db:seed` re-ranks with the engine.
  - Main: 1202 + 53 + 87 + 129 = **1471 tests**, all green. `control_center` is migrated through 0006.
  - Gaps:
    - undo bumps `version` on `priority_policies`; BE-0 should exempt that column;
    - redoing an undone policy apply gives 409;
    - in db mode the dev toolbar 404s on `/dev/scenario`;
    - `src/engines/nba` still maps `review_deliverable` to `confirm_done`.

### CP-9: 2026-11-05: design v2 review → v2 build wave 1
- **Review of the mock:**
  - Functionally it's right. Visually it's too dense, too literally Lightning, and uses one blue.
  - Tristan wants Salesforce colors and fonts without the platform look, bigger type, real use of the width, dark first, and one Home covering every tab and every day.
- **Research briefs** 13–16 (private): comparable apps, a dark visual system with checked contrast, design skills plus a 50-rule checklist, and VDP takeaways.
- **Mockups** are in `public/mockups/`, git-ignored, on real data.
  - Picks: **Home A** (Morning paper, no page scroll), Today, Settings (three panes), and the Assistant (panel plus full page).
  - Not picked: B (feed plus horizon) and C (lanes).
- **Decisions** are recorded in `docs/archive/2026-build/DESIGN-V2.md`:
  - color is an indicator only, with no per-account hues;
  - one docked right panel shared by Details and the Assistant, and the page condenses around it;
  - quiet actions, loud selection;
  - capacity counts only today-scoped hands-on time (it previously reported a false +8h overbooked);
  - the product name is Command Center. The deep rename (folder, database, state directory) waits until no sessions are running.
- **Build plan:** `docs/archive/2026-build/BUILD-V2.md`, which freezes the right-panel seam at `src/components/shell/panel.tsx`. Test databases now take `CC_TEST_DB_SUFFIX`.
- **Wave 1 lanes running (12):**
  - foundation: V2-TOKENS (4345), V2-SHELL (4346), V2-DOMAIN (4347), V2-DETAIL (4353);
  - pages: P-HOME (4348), P-TODAY (4349), P-SETTINGS (4350), P-CHAT (4352);
  - backend: CAPACITY (4354), BE-CHAT (4355), BE-OUTBOX, BE-REEVAL.
- **Also running:** the scanner stress session (its own branch, port 4351).
- **Next (wave 2, after the foundation merges):** P-LISTS (Triage, Work, Outbox), P-CONTEXT (Deals, Briefs, Agents, Time, Health), then WIRE (db `getHome`, `CC_DATA=db` default, worker full time, end to end).

## CP-10: wave 1 merged except V2-SHELL; wave 2 started (2026-11-06)
- **Merged to main:** CAPACITY, BE-OUTBOX, BE-REEVAL (plus migration 0007), P-CHAT, V2-TOKENS, BE-READIN, P-TODAY, BE-CHAT, P-SETTINGS, V2-DOMAIN, V2-DETAIL and P-HOME. Each one typechecks on main. The lanes' own checks were green, or failed only on load timeouts.
- **Orchestrator fixes:**
  - wired `outbox.dispatch` (its live transport fails closed);
  - `test:bereeval` and `contrast` now run in `check`;
  - toast and timeline fills use on-solid text;
  - `shot` falls back to system Chrome;
  - retention purges read-ins after 90 days;
  - the tool-run test's poll is no longer flaky;
  - db `getHome` has mock/db parity, and Home's gap pick is order-independent;
  - NbaCard has `whyLines`;
  - seed display defaults are comfortable, dark and 16 px;
  - the app has an icon.
- **Still open:**
  - **V2-SHELL:** the sidebar, the docked panel, theme defaults, and registering the `work_item` renderer. Until it lands, `app/layout.tsx` still forces light and compact.
  - **The full `npm run check` on main:** it waits for machine load to drop. The DB suites only time out under load.
  - **The scanner stress branch:** its CUR-1, RS-1 and LOOP-1 fixes are on its own branch, and it is also fixing the db Rescan `bad_payload` bug. Merging it needs Tristan's OK.
  - **Chat and the global hard cap:** whether chat should respect it waits on Tristan (B-068).
- **Wave 2 running:** P-LISTS (4345), P-CONTEXT-A (4347) and P-CONTEXT-B (4348). See BUILD-V2 "Wave 2".
- **Next:**
  - merge V2-SHELL, then tell the wave 2 lanes to merge main;
  - WIRE, after the stress branch merges: migrate the real DB, then an end-to-end loop on real data in a scratch DB;
  - flip `CC_DATA=db` (needs Tristan's OK);
  - the worker under a LaunchAgent (needs Tristan's OK);
  - the deep rename.

## CP-11: V2-SHELL merged; wave 1 complete (2026-11-06)
- **Merged to main:** V2-SHELL, a fast-forward to 2d38135. It brings the sidebar (232 px, or 64 px collapsed), the 64 px topbar and the docked right panel with Details and Assistant. It also brings the dark, comfortable, 16 px defaults with no flash on load, and the generic Details fallback. All 13 wave 1 lanes are now in main, and the V2-SHELL worktree is removed.
- **Full `npm run check` on main is green** (exit 0): 1,449 unit tests, plus the db, be1a, be1b and bereeval suites.
- **Orchestrator fixes:**
  - The read-in DB tests anchor the example seed in the past. Before 09:02 its rebased evidence was in the future, so read-ins looked stale and future-created items counted as new asks.
  - One tab icon: `app/icon.svg` is the "cc" tile.
  - Settings saves only `shortcutsEnabled`; the shell's prefs queue saves scheme, density and text size.
  - ⌘J on the full item page opens the panel's Assistant.
  - Dev only: a mock DataSource made by older code is replaced. The long-running dev server had 500'd on `/` and `/today` (getHome missing, old capacity).
- **Visual check** on the user's dev server (4327), in system Chrome:
  - Home and Today are dark with no page scroll at 1920×1000 and 2560×1300.
  - Details opens from Home with `1` then Enter, and main condenses to 1,168 px at 1920.
  - ⌘J opens the Assistant with the composer focused.
- **Machine:** something external kills headless Chrome after about 10–15 s; a Koi security agent runs on this Mac. Short, one-browser-per-shot runs work. V2-SHELL's orphaned screenshot chain was stopped.
- **Still open:** the scanner stress branch (needs Tristan's OK to merge), and chat versus the global hard cap (B-068).
- **Wave 2 running:** P-LISTS, P-CONTEXT-A and P-CONTEXT-B, each told to `git merge main` and re-verify in the real frame.
- **Next:**
  - wave 2 merges;
  - WIRE;
  - `CC_DATA=db` and the LaunchAgent (both need Tristan's OK);
  - the deep rename.

## CP-12: wave 2 merged; every page on design v2 (2026-11-06)
- **Merged to main:**
  - P-LISTS: Triage, Work and Outbox on `ListFrame`, `ListSection` and `LineRow`, with no page sheets.
  - P-CONTEXT-B: Agents and Health, plus the `calendar_event`, `connector`, `agent_run`, `tool_adapter` and `tool_run` renderers.
  - P-CONTEXT-A: Deals, Missed, the account page, Briefs and Time, plus the account, opportunity, missed-opp, brief-highlight and activity renderers. One `missed_opp` renderer serves both Deals and Triage.
- Every lane worktree is removed. Only the scanner stress branch remains.
- **Full `npm run check` on main is green** at 8699054: 1,476 unit tests plus the db, be1a, be1b and bereeval suites.
- **Smoke on the user's dev server (4327)**, one short-lived system Chrome per shot:
  - Today, Triage, Work, Outbox, Agents, Health, Deals, Missed, Briefs and Time all load with no 4xx/5xx and no page scroll at 1920×1000.
  - Details opens from Work, Health and Deals, and main condenses to 1,168 px.
- **Orchestrator fix:** the backup round-trip test gets 180 s under load.
- **New backlog:** B-069 to B-074 come from the lanes' notes. B-061 and B-064 are done.
- **Still open:**
  - the scanner stress campaign (running; merging it needs Tristan's OK);
  - chat versus the global hard cap (B-068).
- **Next:**
  - WIRE: after the stress branch merges, migrate the real DB, then an end-to-end loop on real data in a scratch DB;
  - `CC_DATA=db` and the LaunchAgent (both need Tristan's OK);
  - the deep rename.
