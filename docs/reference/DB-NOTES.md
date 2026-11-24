# DB notes (BE-0)

How to use the data layer that implements `docs/reference/DATA-MODEL.md` §3–§6 on Postgres 17 + Drizzle 0.45. The schema is the contract; this page explains how to use it and where the code differs from the doc.

## Layout

| Path | What it is |
|---|---|
| `src/db/schema.ts` | Barrel that drizzle-kit reads. **Import tables from here** (or from `src/db`), not from the domain files |
| `src/db/schema/<domain>.ts` | 24 files: `enums`, `columns` (custom types, helpers), `core`, `settings`, `connectors`, `scanning`, `sources`, `entities`, `drive`, `calendar`, `work`, `priority`, `nba`, `drafts`, `sessions`, `activity`, `deals`, `jobs`, `llm`, `chat`, `audit`, `health`, `tools`, `briefs`. They follow the §0 table groups |
| `src/db/migrations/` | `0000_extensions` (custom), `0001_init` (generated), `0002_extras` (custom: triggers, exclusions, guards, view), `0003_work_item_resolution` (generated, R-UI-22) |
| `src/db/client.ts` | `createDb()`, `getDb()`, `closeDb()`, and the `Db` / `Tx` types |
| `src/db/changeset.ts` | `withChangeSet`, `actors`, `updateVersioned`, `engineUpdate`, `userUpdate`, `applyProposal`, `rejectProposal`, `undoChangeSet`, `closeIdleBursts` |
| `src/db/queue.ts` | `enqueueJob`, `claimJobs`, `recordNewInfo` (W2) |
| `src/db/scan.ts` | `commitScanPage`: coverage ledger + cursor advance |
| `src/db/queries.ts` | §6 Q1–Q16 and W1–W7 verbatim, plus `runStatement()` and `statementSql()` |
| `src/db/errors.ts` | Typed errors and `mapPgError()` |

Commands for `package.json` (W0 owns it):
- `"db:generate": "drizzle-kit generate"`
- `"db:migrate": "tsx src/db/migrate.ts"`
- `"test:be0": "npm run test:db:core"` (the `db-core` vitest project, `tests/db/core`; `vitest.config.ts`)

The tests drop and recreate `control_center_be0` with the v17 binaries on every run.

## Writing through change sets

Every write to one of the 48 audited tables must run inside `withChangeSet`. Otherwise the `cc_audit` trigger raises, and you get `ChangeSetRequiredError`. The change set id it returns is the Undo target for the toast, ⌘Z and history.

```ts
const { result, changeSetId } = await withChangeSet(
  { userId, actor: actors.user(), reason: 'Rename task' },   // reason = change_sets.summary
  (tx, cs) => cs.updateVersioned(workItems, id, ifVersion, { title }),
);
await undoChangeSet(changeSetId);                              // redo = undoChangeSet(undoId)
```

- **Actors.** `actors.user()`, `.chat(toolCallId)`, `.engine('closure@1')`, `.scanner('slack')`, `.system('retention')`, `.autonomyPolicy(id)`. Each defaults the change-set kind: `user_edit`, `chat_tool_call`, `engine_pass`, `connector_sync`, `system`. The scanner actor is kind `connector` with ref `scanner:<connector>`, as SCANNER.md §3 requires.
- **`cs.updateVersioned(table, id, ifVersion, patch)` / `cs.update(table, id, patch, opts)` choose behaviour by actor:**
  - **User and chat:** an OCC write (`ConflictError` with `currentVersion` → 409) that adds the touched columns to `user_locked_fields`. Pass `lock: false` for bookkeeping writes such as `seen_by_user_at`. A user edit of `account_id`/`opportunity_id` sets `mapping_locked`.
  - **Engine, connector and system:** unlocked fields apply. Locked fields become `change_proposals`, one pending per (entity, field); a newer proposal supersedes the older. Identical values make no proposal. `lockAll: true` freezes the whole row, for example an approved activity entry. `generation: n` fences on `reeval_generation` (`StaleGenerationError`, W3). The result is `{ row, applied, proposals }`.
- **Applying or rejecting proposals.** Use `applyProposal(tx, id)` or `rejectProposal(tx, id)` inside a change set. When applied, the field stays locked.
- **Raw writes.** Drizzle writes inside `tx` are fine. The trigger audits them and they are undoable. Use the helpers when you need OCC, locks or fencing.
- **Autosave.** Use `kind: 'autosave_burst'` with `editorSessionId` + `entity`. That reuses one change set per (session, entity) for 30 s after its last write. `closeIdleBursts()` (W6) closes idle ones and belongs on a worker timer.
- **Don't nest `withChangeSet`** (it opens its own transaction). Pass `tx`/`cs` down instead.
- **Logging errors.** Log `DbError.code`, never `err.message` from the driver: Drizzle's error text includes bound parameters, which can contain source text.

## How BE-1, BE-2 and BE-3 use this

- **BE-1 (DataSource, worker runtime, API):**
  - Each mutation route runs inside `withChangeSet(actors.user())` and returns `changeSetId` as `auditId`. `POST /audit/:id/undo` calls `undoChangeSet`.
  - Map `DbError.status` to HTTP: 409 conflict / undo conflict, 404, 422. `UndoConflictError` means "changed since: review", and nothing was undone.
  - The worker builds on `claimJobs`: lease heartbeat, complete/fail with backoff, `dead`, the reaper, and schedules.
  - Two more pieces belong to the worker: LISTEN on `cc_job_cancel` (abort the job) and `cc_change` (SSE fan-out).
  - Use `Q.Q1`…`Q.Q16` for the home payload.
- **BE-2 (scanner and `cc` tools):**
  - Each `cc_*` tool write runs in `withChangeSet({ actor: actors.scanner(connector) })`.
  - Ingest uses W1 (`runStatement(client, 'W1', …)`, idempotent on `(owner, dedupe_key)`).
  - `cc_finish` commits through `commitScanPage(tx, …)` in the same transaction as the page's items.
  - It refuses a cursor that moves backwards (`CursorError` with reason `regression`) or past a hole in the complete ledger (reason `coverage_gap`). Rollback leaves the cursor unmoved.
- **BE-3 (engines):**
  - When new info is saved, call `recordNewInfo(tx, itemId)` (W2) in the same change set. It bumps the generation, cancels the running re-eval and coalesces the next one.
  - A re-eval job writes with `engineUpdate(tx, table, id, patch, { generation: job.generation, ifVersion })`. It stops on `StaleGenerationError`.
  - Backward moves (reopen, `looped_back_in`) write a `work_item_transitions` row and a `reopen_decisions` row in the same change set. Undo stamps both as undone.

## Naming

Tables, indexes and columns follow DATA-MODEL §0:
- tables: plural snake_case;
- indexes: `_idx`, unique indexes `_uidx`, unique constraints `_uq`, checks `_chk`, exclusions `_excl`.

**Foreign keys** keep drizzle's `<table>_<col>_<reftable>_<refcol>_fk`, except where that name exceeds 63 characters (decision 10). Those 14 use `foreignKey({ name: '<table>_<column>_fk' })`. A test checks that every snapshot name exists verbatim in Postgres and fits in 63 characters.

**New migrations:**
- schema changes: `drizzle-kit generate --name <what>`;
- hand-written SQL: `drizzle-kit generate --custom --name <what>`, separating statements with `--> statement-breakpoint`.

Never use `push`.

## Deviations from DATA-MODEL.md, and findings

1. **Split layout.** `columns.ts` must stay a leaf module. A domain file calls its helpers at load time, so a static import of `users` there would put it into the import cycle. So `ownerUserId()` resolves `users.id` lazily through `bindUsersId()`, which `core.ts` calls.
2. **Type cycle.** `work_item_deliverables` ⇄ `deliverable_judgments` FKs needed an explicit `(t): PgTableExtraConfigValue[]` annotation once they became `foreignKey()` entries.
3. **`cc_transitions_guard`** now allows a DELETE when it is the FK cascade of its work item being deleted. The case is undoing the creation of an item, which logs a transition. A direct delete still raises. This is in `0002_extras.sql`, marked "BE-0 deviation".
4. **W1** casts `$9::timestamptz + interval '90 days'`. Without the cast, Postgres deduces `$9` as `interval` there and as timestamptz in the VALUES list, and rejects the statement ("inconsistent types").
5. **Claim.** The SKIP LOCKED pick plus a per-dedupe-key `pg_try_advisory_xact_lock`, then a second statement re-checks running keys with a fresh snapshot. That closes the mid-commit race behind "a key never runs twice at once". Exception: a `supersedes_running` job (re-eval) may start while the job it superseded is still winding down after its cancel. That one is fenced by W3.
6. **Undo details that §1.3 leaves open:**
   - It never restores or compares `version`, `updated_at` or `reeval_generation`. Version is bumped instead.
   - The step is chosen from the nullity of `before`/`after`, not from `op`. `cc_audit_kv` coalesces insert→update as `update`.
   - An FK `ON DELETE SET NULL` caused by the undo's own earlier delete doesn't count as "changed since".
   - It stamps `reopen_decisions.undone_at` as well as transitions.
   - Undo/redo chains keep `undone_at` meaning "currently reverted".
   - A change set with no audit rows is closed with `undoable = false`, so ⌘Z skips it.
   - A delete of a draft can't restore `doc_json`/`plain_text`, because those are kept out of the images. Restore them from `content_revisions` (open for BE-4).
7. **Sessions** run with `TimeZone=UTC`, so audit images render identically whichever process wrote them. `withChangeSet` also sets `cc.user_id`, for future RLS.
8. **Unversioned tables.** A proposal against a table without a `version` column (calendar_events, assets, claude_sessions) stores `base_version = 0`.
9. **Index findings** from EXPLAIN on seeded rows. The tests assert each one:
   - **Q1:** the planner uses `work_item_evidence_item_role_idx` rather than `work_item_evidence_target_uq`. The two share the leading `(work_item_id, role)`, so `item_role_idx` is redundant with the uq's prefix.
   - **Q2:** uses the partial `work_items_open_due_idx`.
   - **Q7:** `connectors_owner_unhealthy_idx` can't serve the `status <> 'healthy' OR stale` predicate. The planner uses `connectors_owner_kind_name_uidx` instead.
   - **Q11:** can't use the partial `work_item_deliverables_item_asset_uidx` without `AND d.asset_id IS NOT NULL`. Add that, or an index on `work_item_id`, if deliverables grow.
   - **Q1 natural plan:** with seq scans left on, it uses `work_items_home_lane_rank_idx`.
10. **Not built here (owners):**
    - The nightly retention scrub of audit images (decision 4): worker.
    - Rollback-to-time-T: BE-1, built on `undoChangeSet`.
    - The "approved activity entry is frozen" rule: BE-5 passes `lockAll`.
    - Person merges must repoint `resolution_person_id` / `owner_person_id` first.

## R-UI-22 mapping (migration 0003)

| Requirement | Where |
|---|---|
| `resolution` enum | `work_items.resolution` (`work_item_resolution`). Only while `done`/`dismissed`/`merged` (`work_items_resolution_chk`); a reopen clears it |
| Person for handed_off / done_by_other | `work_items.resolution_person_id` |
| Related item for duplicate / superseded | `work_items.resolution_work_item_id`. A merge sets it alongside `merged_into_id` |
| Note, and inferred with evidence | `resolution_note`, `resolution_inferred`, `resolution_evidence_id` → `work_item_evidence` |
| `involvement` enum, owner person | `work_items.involvement` (default `owner`) and `owner_person_id` (null = me). `handed_off` requires `watcher`/`not_involved` (`work_items_handoff_chk`) |
| Loop-back record: when, who, evidence | A `reopen_decisions` row with `rule_key = 'looped_back_in'` and the new `trigger_person_id`, plus `created_at`, `trigger_source_item_id` / `trigger_evidence_id`, and the `transition_id`. It is a transition `done → open` with reason `looped_back_in`, or `outcome = 'new_sibling'` for the sibling alternative |

The "detail required" rules (handed_off needs a person; duplicate/superseded need an item) are domain-level, not CHECKs. As CHECKs they would make those FKs' `ON DELETE SET NULL` fail.

A user-made hand-off locks `status`/`resolution`/`involvement`. So an engine loop-back on it arrives as proposals ("New info → reopen?"), while an inferred hand-off reopens directly.
