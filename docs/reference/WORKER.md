# Worker: operations and semantics (BE-1a)

`npm run worker` (`src/worker/index.ts`) is the always-on background process: scanning, the job queue, nightly maintenance. It writes only to Postgres and local state files. Every outbound path stops at a draft (CLAUDE.md invariant 1), and connectors call read tools only.

## Process

| Step | What happens |
|---|---|
| Lock | `SingleInstanceLock` (OPS): pid file `<state>/worker.pid` and advisory lock `(4327, 1)` on a dedicated connection. A second worker exits 0. |
| Heartbeat | `HeartbeatWriter` (OPS v1 format): `<state>/worker.heartbeat` has `pid`, `started_at`, `beat_at` (the last loop tick), `active_jobs`, `app_version`, and `state` (`starting` · `idle` · `running` · `catching_up` · `draining` · `stopped`). The beat is driven by the runtime's tick, so a stuck loop shows as stale. Each beat is mirrored to `worker_instances.last_beat_at`. The gap from the previous instance's last beat to this boot is the "Since you left" window. |
| User | `CC_USER_EMAIL` / `CC_ME_EMAIL` (created if missing), else the first active `users` row. With no user, the worker waits. |
| Live events | `getLiveEventBus()` LISTENs and installs the change-set publisher (see below). |
| Scanner | BE-2a `ScannerRuntime` over `DbScannerStore` and the Postgres queue. |
| Resume | Queued plans from a previous instance are dropped, the reaper re-queues expired leases, and the first `planJobs()` is the resume plan. |
| Wake | `WakeDetector` (a clock jump of 60 s or more) runs, in order: heartbeat (own leases first), reaper, re-plan, claim. A gap over 30 min also enqueues a reconcile pass (`unlinked`, `stale_active`). |
| Shutdown | On SIGTERM/SIGINT: stop timers, stop claiming, abort every run (`JobAbort('shutdown')`), wait `drainMs` (10 s), then release whatever is left (back to `queued`, attempt given back). Then the final `stopped` beat, and the lock and pools close. launchd's SIGKILL comes at 20 s. |

Environment (never logged): `DATABASE_URL`, `CC_LIVE` (real fetchers; defaults on only when `NODE_ENV=production`), `CC_SCAN_LLM` (Haiku linking plus Slack/Org62 traversal; same default), `CC_NOTIFY=0`, `CC_WORKER_SOURCES=gmail,calendar,…`, `CC_ME_NAME`, `CC_ME_ALIASES`, `CC_STATE_DIR`, `CC_WORKER_RUN_FOR=<s>`. So `npm run dev` in a lane never scans unless it asks to.

## Jobs

Each queue has one pool. `claimJobs` (BE-0) claims with `FOR UPDATE SKIP LOCKED` plus a dedupe-key advisory lock, so a key never runs twice at once.

| Kind | Queue (concurrency) | Handler |
|---|---|---|
| `scan.<connector>` | `scan.<connector>` (1 each) | `ScannerRuntime.executeJob(payload)`. Then it enqueues `followUps`, and for `retryAt` it enqueues the same job as `<dedupeKey>#retry` |
| `scan.reconcile` | `scan.reconcile` (1) | reconcile passes (coverage gaps, unlinked, stale, skill upgrades) |
| `scan.<connector>` from Health **Rescan** | `scan.<connector>` | The DB DataSource (`scanInternal`) inserts a queued placeholder `scan_runs` row and enqueues a real manual RuntimeJob (trigger `manual`, or `chat` for the chat-ops scan) in the same transaction, linked by `scan_runs.job_id`. The job's first run adopts the placeholder (`DbScannerStore.startRun`), so Health shows one run going queued → running → done; a job that starts no run (no scanner, budget pause) closes it as cancelled. A connector that needs re-auth gets an immediate `auth_failed` run and no job. Jobs of the old `{connectorId, scanRunId, scope}` shape still queued in a database are drained by a legacy path. Before the stress campaign the old shape dead-lettered as `bad_payload` |
| `connector.reauth` | `maintenance` (also drains `default`) | Health **Re-auth**: resumes the connector, then probes its primary scope. While the probe still fails on auth, the job fails as `transient`, and the queue retries with backoff until the re-auth completes (or dead-letters). Before, there was no handler |
| `reevaluate` | `engine` (2) | `reevaluateHandler()` (BE-REEVAL): the closure machine and the re-eval planner run over the evidence since the last pass, written as one undoable `engine:reeval` change set, then an `nba.generate` follow-up. Fenced on the generation (before start, by the worker) and on `cancel_requested_at` (inside the run) |
| `outbox.dispatch` | `outbox` (1) | `outboxJobDef()` (BE-OUTBOX): delivers a confirmed draft. The live transport is fail-closed in this build, so a non-dry-run attempt ends as an Outbox error |
| `nba.generate` | `nba` (1) | stub (BE-4) |
| `brief.generate` | `brief` (1) | `briefJobDef()` (BE-5 channel briefs, src/jobs/handlers/brief.ts): the 07:30 schedule (`run_once`, so a laptop asleep at 07:30 briefs on wake) and its own follow-ups enqueue it. For each enabled channel watch that is due by its cadence, it reads the messages scan-slack stored for the channel since the last brief (up to the channel scan's cursor), makes one tool-less Haiku call (brief-channel + brief-relevance) under the global hard cap, and writes the brief through the DataSource's `insertBrief`. A quiet period writes a read "no new messages" brief with no call; a channel whose scan is behind is retried every 15 min (8 times at most). Opportunity, account, person and search watches are not briefed yet |
| `activity.sync` · `missed_opps.sweep` | `maintenance` (1, also drains `default`) | stubs (BE-5) |
| `retention.scrub` · `backup.nightly` | `maintenance` | implemented |

Stubs log `<kind>: not yet wired (<owner>)` and succeed. Owners plug in with `registry.wire(kind, handler)`.

**State machine** (`src/jobs/queue-ops.ts`, DATA-MODEL §4.5). Every transition is fenced on `status = 'running' AND locked_by = me`.

- **Leases.** A claim is narrowed at once to a 90 s lease. A 15 s heartbeat extends it, and the job's `timeout_seconds` aborts it in-process.
- **Reaper.** Every 30 s, plus at start and on wake, expired leases go back to `queued`. They go to `cancelled` instead if a cancel was requested or a twin is queued, and to `dead` on the final attempt.
- **Retry.** Applies to `transient`, `rate_limited` and `unknown`. The delay is `min(max, base·2^(n−1))`, doubled when rate limited, with equal jitter (`d/2 + rand·d/2`); base 30 s, max 1 h.
- **Dead-letter.** Happens for `validation`, `bug`, `not_found`, `auth` or `budget`, or once attempts run out. It writes a `job_dead_lettered` notification (skipped for auth, which already has the connector's re-auth notification), an `app_events` row, and an OS notification if the work item is in the Top 3.
- **Health "Retry".** `retryDeadJob(id)`.
- **Requeue collision.** A requeue that would collide with an already-queued job of the same dedupe key cancels the requeue instead.

**Cancel and re-eval (R-UI-20).** W2 (`recordNewInfo`) sets `cancel_requested_at` on the running `reeval:work_item:<id>` job. The trigger NOTIFYs `cc_job_cancel`, and the worker aborts that job's `AbortController` with reason `cancel`. The heartbeat poll is the fallback. The new job (`supersedes_running`) can start at once. Before any job that carries `generation` and `payload.work_item_id` starts, the worker compares it with `work_items.reeval_generation`, and a stale job is cancelled (`superseded by generation N`) without running. Writes are fenced again by W3.

## Scanning (SCANNER.md §5)

`ScannerRuntime.planJobs(now)` runs every 15 s. It handles cadence (×6 off-hours, with work hours taken from `user_settings.profile`), quiet backoff, the auth pause, the budget pause for traversal at the hard cap, and the nightly reconcile. On the first call it also builds the resume plan: the **head** (the newest hour) at priority 80, then **backfill** chunks oldest to newest at priority 40.

`PgRuntimeJobQueue` maps each RuntimeJob to one `jobs` row (`payload` = the job). It coalesces a queued key like `InMemoryJobQueue` does: the earliest `run_at`, the highest priority, and a widened `window.to`. Claim order (priority desc, `run_at`, id) makes the head run first and the backfill run oldest first. The cursor fast-forwards when the last chunk meets the head (store rule S9).

- **Linking seam.** Deterministic scans hand `prefetched` items to the SkillRunner, which is `AgentSdkSkillRunner` when `CC_SCAN_LLM=1`. With the LLM off, `DeferredSkillRunner` records items and coverage and flags new or changed items as `deferred:`, so reconcile links them later. That costs no LLM money.
- **Window alignment** (`windowAligned()`, every fetcher). Snapshot fetchers (Calendar, Drive, Gemini, Claude sessions, trainings' calendar scope) put `cursor.at = now`; it is clamped to the window end so backfill windows pass S8(b). Per-object ranges that end before the window (each Claude transcript reports its first → last turn) become points, and ranges past the window end (Calendar claims now → now + 14 d) are clamped to `window.to`, so a scope always has a gap after its cursor and keeps being polled. Both were found in the live check: without them the Claude cursor never initialized and Calendar was never re-polled.
- **Claude sessions.** `ClaudeSessionWatcher` (fs.watch with a 5 s debounce, plus a sweep) enqueues an incremental `claude_sessions` job with trigger `file_watch`, which coalesces with the 10 min poll. Sessions that flip to `waiting` raise `waiting_on_you`, once per transition (OPS Notifier). A connector going to `auth_required`/`error` raises `connector_broken`, which resolves once the connector is healthy again.

## DbScannerStore (`src/scanner/store-db.ts`)

It mirrors `InMemoryScannerStore` rules S1–S18. `tests/db/worker/store-conformance.ts` runs the same 25 scenarios against both stores. Every write is a `withChangeSet(actors.scanner(<connector>))`.

- **Source items.** They are upserted on (owner, dedupeKey) with W1 semantics.
  - Message text goes to `body`: redacted again, expiring at `occurredAt + 90 d`, and never resurrected once purged.
  - `meta` holds structure only: text keys and long strings are moved out.
  - `threadRef` is stored in `external_parent_id`; `fileRefs` become `source_item_refs`.
- **Coverage.**
  - **Staging.** Coverage is staged in memory per run.
  - **finishRun** is one transaction: it checks the window and a 1 s hole tolerance, writes ledger rows (the raw `from`/`to` go into `start_token`/`end_token`), closes the run with its proposed cursor (`scan_runs.cursor_after`), advances the cursor by S9 and returns the S10 touched set.
  - **failRun** writes the staged coverage with outcome `error`.
  - **Pending set.** The S10 set is durable in `scan_cursors.cursor_json.pending`, so touches from a killed run are never lost.
- **Linking.** `linkEvidence` writes evidence and, for non-context roles, applies the W2 bump: generation, new badge, and a coalesced, cancel-running re-eval. It never changes status.
- **Proposals.** `proposeItem` idempotency (S4) and `proposeInitiative` idempotency (S5) are keyed on the proposing change set: `editor_session_id = 'propose:<hash>'` and the entity. Open proposals queue a `reevaluate`.
- **Unlinked.** `flagUnlinked` keeps one `reconcile_findings` row per (source item, run), with JSON detail `{reason, hints, counts}`. Attempts are derived as in S6.
- **Health.** `recordHealth` updates `connectors` and `connector_health_checks`, opens or resolves a persistent notification, writes an `app_events` row on each transition, and pauses or resumes the connector's `job_schedules` on `auth_required` (D-39).
- **Spend.** `recordSpend` writes `llm_calls`; when `costUsd ≤ 0` it only reads. Caps come from `user_settings.budgets` (`softUsd`, `hardUsd`, `alertPct`), then `llm_budgets` total, then defaults of $5 soft and $15 hard.

## Live events (`src/server/events`)

- **`PgEventBus`** implements the `EventBus` port over LISTEN/NOTIFY.
  - Channel `cc_live` carries small `{topic, ids ≤ 50, reason, at, entityType?, cs?}` payloads; each process keeps its own `seq` and a 200-event replay buffer.
  - **Commit hook.** `installChangeSetPublisher` uses the commit hook, `onChangeSetCommitted`: a small, backward-compatible export added to `src/db/changeset.ts` that runs after commit and never on rollback. It maps the committed change set's audit rows to topics, one event per topic plus `audit`.
  - **Change sets with no audited rows** (scanner ingest) produce a throttled `scans` or `jobs` event instead.
  - **Fallback.** The audit trigger's per-row `cc_change` is buffered for 150 ms per change set and published only when no `cc_live` message for that change set arrives. So writers in a process without the publisher still reach open views.
  - **Unaudited tables (2026-11-14, migration 0026_live_notify).** Jobs, scan runs, tool runs, app events and worker instances notify `cc_change` from their own trigger on their transitions (an insert, a status change, a resolve), and the read mirrors (VDP records, Specialist Forecasts, Org62 use cases, landings) once per statement, under a `tx:<txid>` change set (no `audit` topic). The worker also publishes `health` when its catch-up progress moves a 5 % step.
- **The web app's bus** (`src/server/datasource/db/events.ts`) LISTENs `cc_change` and `cc_live`: it delivers what the worker publishes itself (dropping a change set it already turned into events from `cc_change`), reconnects its LISTEN client after a drop and then tells every open view to refetch, and while a view is open checks the worker's heartbeat every 30 s, publishing `health` when it flips (alive ⇄ gone).
- **SSE for `CC_DATA=db`.**
  - **Via the DataSource.** `events(i) { return dbLiveEvents(i); }` is an AsyncIterable. The existing route adds `hello` and a named `ping` heartbeat every 15 s (the client reopens a stream that goes silent: src/client/live.ts).
  - **Direct route.** `liveEventsResponse(req)` returns a complete SSE `Response` with `hello`, `live` frames, `id: seq` and `Last-Event-ID` replay.

## Nightly maintenance (`job_schedules`, catch-up `run_once`)

The times are in the user's time zone, DST-safe.

| Time | Job | Notes |
|---|---|---|
| 02:30 | `backup.nightly` | Runs `backupDue()` then `runBackup()` from `scripts/ops/lib/backup.mjs`, keeping 7 |
| 03:15 | `retention.scrub` | See below |
| 06:00, 07:00, 17:30 | stubs | Their rows exist but stay disabled (`paused_reason = 'not_wired'`) until a handler is wired |

The retention scrub does these things:

1. **W7.** It nulls expired bodies and drops text keys from `meta`. It also nulls expired Drive section text, except the baseline snapshot of an open deliverable (OQ-9).
2. **Audit images.** In images older than 90 days, source-derived prose is replaced with `"[scrubbed]"`. Keys, ids, enums, timestamps, short tokens and titles are kept, and a `_retention` marker is added.
3. **Content revisions.** Superseded closed revisions older than 90 days are scrubbed.
4. **Read-ins** not refreshed for 90 days are deleted, and the **scan trace** (`scan_run_events`) after 30 days.
5. **Table retention** (lane E, E4; `src/jobs/handlers/retention-tables.ts`, `RETENTION_HORIZONS`):

| Table | Horizon | Kept regardless |
|---|---|---|
| `jobs` | succeeded / cancelled 30 d, dead 90 d, with an idempotency key (Outbox, VDP push) 400 d; never queued or running | the newest of each kind and status |
| `scan_ledger_entries` | `complete` rows compacted after 30 d (other outcomes deleted then) | the same coverage answers, see below |
| `scan_runs` | 90 d, never queued or running | the newest of each scope |
| `connector_health_checks` | 30 d | the newest of each connector |
| `llm_calls`, `llm_decisions` | 400 d (the audit trail; never less, whatever the options), then rolled up per local day into `llm_call_days` / `llm_decision_days` and deleted in the same transaction | — |

- **Nothing pointed at is deleted.** Every foreign key into the table is read from the catalog at run time, so a key added later counts too. A draft keeps its model call, a source item the scan run that first saw it, a schedule its last job, an Outbox attempt its job, and a model call its scan run. Two links are allowed to go null, because the row holding them describes itself: a model call's or scan run's `job_id`, and a job's parent / superseded-by link.
- **The ledger is compacted, never lost.** The scanner reads coverage from `scan_ledger_entries`: gaps, the low watermark, the cursor's reach, and which objects were read up to where. Deleting a run cascades to its rows. So first, per scope and object, the old `complete` rows merge into the same union (overlapping or touching ranges, as `range_agg`). Each object keeps its furthest position, and the scope keeps its earliest start. They then move to the scope's newest old run, which stays because it has ledger rows. A second pass changes nothing. `tests/db/worker/retention-tables.spec.ts` checks that gaps, span, low watermark, union and uncovered objects are identical before and after.
- **The LLM rollups.** Totals per (day, purpose, model, tier, skill, budget, trigger, model reason, status) and per (day, skill, kind, reason, trigger) for decisions. A re-run adds to the day. A call something points at stays whole, so a day's total is its rollup plus any such calls. The Spend view reads 7 to 90 days, so it never needs the rollups.
- Each step runs on its own: one that fails is named in the job's result (`errors`), and the next night retries it.

`audit_events` is append-only, and its guard only lets a DELETE through under `cc.retention = on`. So a scrub deletes the row and re-inserts it with the same id in one transaction.

**BE-0 follow-up:** allow UPDATE under `cc.retention` so the scrub can be a plain update.

## First scan (B-080)

The first-scan lookback and its one-time backfill budget come from the environment or the worker command line. Both are read by `ScannerRuntime` (`src/scanner/runtime/first-scan.ts`):

| Setting | Env | Flag | Default |
|---|---|---|---|
| History to scan on the first run, in days (`0` = off: per-connector lookback, 24 h; Org62 30 d) | `CC_FIRST_SCAN_LOOKBACK_DAYS` | `--lookback-days=30` | 30 (the worker; library callers and tests: off) |
| One-time backfill budget ceiling (USD) | `CC_FIRST_SCAN_BUDGET_USD` | `--backfill-budget=25` | 25 (was 100 until 2026-11-13) |
| Connectors | `CC_FIRST_SCAN_CONNECTORS` | | slack, gmail, drive, gemini_notes, org62, calendar |
| Deeper scopes | `CC_FIRST_SCAN_SCOPE_DAYS` | `--scope-days` | none (e.g. `slack:inbox=90,gmail:inbox=90`) |

Its state is in `<CC_STATE_DIR>/first-scan.json` (0600): spend in total and per day, scope status (pending or done), and `active`, `done` or `exhausted`. First-scan spend is still written to `llm_calls` and `llm_budget_days`, so the Budget screen shows it. The runtime subtracts it before comparing today's spend with the daily hard cap. Until B-079 exposes it, the Budget screen can show "capped" on the first-scan day while regular scans keep running.

## Spend: holds, skips and the audit trail (lane D, 2026-11-13)

- **Holds (D6).** Each scan, read-in, Settle call and Org62 relay lookup holds its own cost cap in `llm_budget_days.reserved_usd` before it calls the model and gives it back once its spend is booked (`src/db/ledger.ts` `reserveBudget`). The check and the hold are one UPDATE, so parallel jobs can't both pass with the last dollar. A refused hold is a `block` decision (`hard_cap_reserve`).
- **Slack pre-check (D5).** `CC_SLACK_PRECHECK` (default on in production, off elsewhere; `0` turns it off): before a scheduled incremental Slack poll, one relay search per query (inbox S1–S3, a channel's `in:#name`) over the window. Only Slack's own "No results found." on every one skips the traversal.
- **Claude sessions (D3).** The fetcher records busy ↔ idle flips without the model (`quietItems`). The model sees a session when it is new, starts waiting, finishes or fails, or gets new content while linked to an open item, at most once per 5 min per session.
- **The trail.** `llm_calls` (with trigger, model reason, outcome, cache tokens, content hash) and `llm_decisions` are the audit trail: kept at least 400 days, then rolled up into daily totals by the retention job (lane E, see "Nightly maintenance").

## Known limits and follow-ups

- Claims filter by queue, not by owner (one user per worker today). A shared database needs `owner_user_id` in the claim.
- Resolved (stress campaign): incomplete runs clamp their time ranges to the cursor (store rule S8c). Worker start closes the `scan_runs` a killed worker left `running` (W-3) and keeps queued backfill windows behind the cursor instead of cancelling them as re-planned (RS-1).
- Catch-up progress ("catching up: Slack 60%") is computed in the runtime (`catchUpProgress()`) and the heartbeat says `catching_up`. Neither is written to the `connectors` row or the UI's connector extension, so the DataSource cannot show per-connector progress yet (open: needs a small DataSource/contract change).
- An auth-paused connector stays paused until Health **Re-auth** or **Rescan** (by design; `connector.reauth` now retries its probe until the re-auth completes). For VDP the pause also survives a restart (lane E, E3: `persistAuthPause`). At startup its scope starts paused while `connectors.status` says `auth_required`, unless the stored cookie was issued after the last refusal. Other connectors start unpaused after a restart, as before.
- **Schema guard** (lane E, E1; `src/worker/schema-guard.ts`): before anything else, the worker compares its bundled migrations with the database's (`src/db/migration-state.ts`). On any mismatch (behind, ahead, a migration drizzle skipped, nothing applied), it waits instead of exiting, so KeepAlive can't crash-loop it. Its heartbeat is `blocked`, it logs why once, and it opens one Health event (`worker|schema_mismatch`), which Health ▸ Needs you shows as "The background worker is waiting for the database". It checks every 30 s. While running, a 60 s check holds claims and every hook except the heartbeat (`WorkerRuntime.hold`) until they match again.
- `finishRun`'s `summary` has no column and is not stored. `scan_runs.mode` is derived from the trigger (the store API carries no mode).
- With LLM linking off, every new or changed item gets a `deferred:` unlinked finding and its own small change set (about one per item).
- Aborting in-flight scans at shutdown records them as failed runs; the runtime marks the connector `degraded` until its next success.
