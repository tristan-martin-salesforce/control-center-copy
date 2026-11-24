# Data migrations: how the data changes shape safely

The runbook for any change that moves data, not only DDL (owner ask #13). The rules are [D-96](decisions/0096-migration-discipline.md); the first migration that follows them end to end is 0036, the kv side-car → columns ([D-99](decisions/0099-sidecar-to-columns.md)). The rules in short are in [`../CONTRIBUTING.md`](../CONTRIBUTING.md) "Migrations"; the schema mechanics (drizzle, the journal, the snapshot chain, the migration test) are under "Writing the next one" below. Added after the 2.0.0 release commit (same release): 0037 (Home indexes), 0038 (`chat_memory.source_message_id`) and 0039 (a `source_items` index), all step 1 only.

## The five steps

| Step | Ships in | What it does | 0036 example |
|---|---|---|---|
| 1. Expand | release N (a migration) | Additive only: new tables, nullable columns (or with a default), generated columns, indexes, enum values. No data moves inside the migration, so it is fast and holds no long lock. | `0036_sidecar_columns.sql`: `opportunities.next_step`, `need_decisions`, `vdp_use_cases`, `*_id15` … |
| 2. Backfill | release N (a job) | A registered job copies the old data into the new place: idempotent (copies only where the target is empty, never overwrites), chunked (one change set per 500 rows), resumable (cursor and counts in `data_backfills`). It reports counts. | `kv.backfill` (`src/jobs/handlers/kv-backfill.ts`) |
| 3. Dual read | release N | Readers read the new place first and fall back to the old one while it is empty. Every fallback is counted. Writers write the new place; they keep writing the old one only for a listed reader that still reads it (a TODO naming the release that drops it). | `loadKv` overlays the columns (`store/sidecar.ts`); `dcAssigned` is still written to the kv for `src/projections/run.ts` and `src/jobs/handlers/brief.ts` (TODO 2.1) |
| 4. Verify | between N and N+1 | Doctor says the fallback count is zero and the backfill is done for every user. | `npm run doctor` → `data:kv-fallback` (counter `DATA.KV.FALLBACK`) |
| 5. Contract (drop) | release N+1 at the earliest, its own migration | Remove the old reads, then drop the old data in a migration of its own. Never in the release that added the new place. | 2.1: delete the promoted `cc.ext/*` fields, the `cc.need/*` keys, `canvas.row_overrides`, and `vdp_records.detail` once nothing reads them |

A derived table (anything projections rebuild from `source_items`) needs no backfill job: bump `PROJECTIONS_VERSION` instead.

A column that old rows can live without needs only step 1. `0038_memory_source` (SEC-8) adds the nullable `chat_memory.source_message_id`; new notes and preferences store the message they came from, and rows written before it keep the time-based fallback in `src/server/chat/memory-source.ts` (no backfill: the old rows' message cannot be known after the fact).

An index is step 1 alone too. `0039_read_profile_indexes` (post-2.0 read profile, `docs/reviews/2026-11-20-holistic/27-read-profile.md`) adds `source_items (owner_user_id, first_seen_at)` for the per-connector count of today's items every page with connectors reads.

## How `npm run update` runs a backfill

`npm run update` stops the agents, installs, builds, backs up, migrates (step 1) and starts the agents again. The worker queues `kv.backfill` for every user at start (`src/worker/index.ts`); the job returns at once when there is nothing left to copy, so it is safe on every start. The update script may also queue it explicitly with `npm run db:backfill -- --queue` (the hook for `scripts/ops/update.mjs`; it only queues, the worker does the work). Nothing in the update path waits for the backfill: the dual read keeps the app correct while it runs.

By hand:

```
npm run db:backfill -- --dry     # the plan: rows to copy per family, nothing written
npm run db:backfill              # run it now (chunked; safe to stop and run again)
npm run db:backfill -- --queue   # queue the job for the worker
```

Each prints family names and counts only (no values).

## How to verify

1. `npm run db:backfill -- --dry` prints `nothing to copy` for every user.
2. `npm run doctor`: `data:kv-fallback` is ok ("nothing read from the kv side-car any more"); while rows are pending it warns with the count per family.
3. `jobs.result` of the last `kv.backfill` run holds `state: done` and the copied counts; `data_backfills` has one `done` row per user.
4. `npm run scan:report -- --since 24h` after the next scans: no new errors, and VDP reads show one `mirror_reads` row each.
5. The pages read the same as before the update (Deals, Time ▸ To log, VDP): the dual read guarantees it, the be1b parity suite tests it.

## Rollback

- **A failed update needs none.** All pending migrations run in one transaction (`src/db/migrate.ts`): a failure leaves the schema as it was, and `npm run update` puts the previous build back and starts it.
- **The old data stays where the old build reads it.** The backfill never deletes the kv: `cc.ext/*`, `cc.need/*` and `canvas.row_overrides` keep what they held when it copied them, and 0036's DDL is additive (the old build ignores columns and tables it does not know).
- **Going back after a successful update** is a restore: stop the agents, restore the backup `npm run update` took right before migrating (`~/Library/Application Support/command-center/backups/`, `pg_restore --clean`), check out or install the previous build, start it. The old build's worker refuses a database whose journal is ahead of its own (`src/worker/schema-guard.ts`), so a restore, not only a build swap, is the rollback.
- **What a restore loses:** what changed after the update. `CC_KV_DUAL_WRITE=1` (env file) makes the new build also write every promoted field to the kv while it is on, so the kv stays a complete second copy during a trial period or for a hand repair; it does not let the old build's worker run on the newer schema.

## Writing the next one

- One migration per PR, generated (`npm run db:generate -- --name <name>`), with its snapshot and a journal `when` newer than the last entry; add it to `tests/db/core/migrations.test.ts` with the new counts.
- Any data it implies is a backfill family (`BACKFILL_FAMILIES` in `src/jobs/handlers/kv-backfill.ts`), with a `pending` query that Doctor reuses, or its own job with the same three properties (idempotent, chunked, resumable).
- No new `cc.ext/*` keys (D-99): a field the contract needs gets a column or a child table in the same PR.
- Tests: the migration list and counts, the backfill twice (the second run copies nothing), stopped and resumed, and the read with the old data only (the fallback).
