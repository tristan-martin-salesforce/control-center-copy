# D-99: The kv side-car becomes columns and tables (0036)

- **Status:** Accepted, built (2.0; chunk p4-sidecar-to-columns) · implements part of [D-92](0092-data-model-2.md) under [D-96](0096-migration-discipline.md)
- **Date:** 2026-11-20
- **Source:** [lane 09](../reviews/2026-11-20-holistic/09-data-model.md) DM-1, DM-6, DM-8, DM-9; R1, R3, R4, R5. Runbook: [`../DATA-MIGRATIONS.md`](../DATA-MIGRATIONS.md)

## Context
Business state sat in `user_settings` (`cc.ext/<table>/<id>`, `cc.need/*`, `canvas.row_overrides`): unindexed, joined by string-built keys, invisible in the schema. VDP use cases, assets and people existed only as `vdp_records.detail` jsonb. Org62 ids were cut to 15 characters by hand. Slack and Gmail writes had no landing.

## Decision
- **Columns** (0036, additive): `accounts.dc_status, org62_url`; `opportunities.dc_assigned, next_step, products, owner_person_id, left_book_at`; `activity_entries.log_note, log_note_basis`; `work_items.start_by_user, dismissed`. One registry (`store/sidecar.ts` PROMOTED) routes them: `writeExt` writes the columns, `loadKv` overlays them (column first, kv fallback, counted). Store SQL reads the columns with a kv `coalesce`.
- **Tables:** `need_decisions` and `canvas_row_overrides` (audited, Undo as before), routed at `writeKv`; `data_backfills` for the job's progress.
- **Backfill:** `kv.backfill` (idempotent, chunked, resumable; queued at worker start; `npm run db:backfill [-- --dry | --queue]`). It never deletes the kv.
- **Dual write off by default.** Kept only for `dcAssigned` (read from the kv by `src/projections/run.ts` and `src/jobs/handlers/brief.ts`; TODO drop in 2.1), or everything while `CC_KV_DUAL_WRITE=1`.
- **Org62 ids:** generated `*_id15 = left(id, 15)` on opportunities, accounts, org62_events, activity_entries, org62_use_cases, specialist_forecasts, vdp_records, use_cases; `src/connectors/org62/ids.ts` (`sameOrg62Id`, `org62Key`) for TypeScript.
- **Mirror convention:** one `mirror_reads` row per read; mirrored rows carry `mirrored_at`. VDP children: `vdp_use_cases`, `vdp_assets`, `vdp_members`, `vdp_use_case_phases` (stage history). Readers get these; the blob is the fallback for rows mirrored before 0036 and stays one release.
- **Landings for Slack/Gmail:** an Applied item records `record_landings` (kind `message`, destination `slack`/`gmail`) + one `landing_writes` row per attempt in the delivery's change set. Ids, targets, mode only. The D-70 sync reads only Org62/VDP landings.
- **Stays kv** (ephemeral, a singleton, a cursor or a preference, not per-entity state): `cc.meta*`, `cc.spend`, `cc.projections` (watermark), `cc.plan.slots`, `cc.priority.nudges` (a per-user list of accepted nudges), `cc.time.*` (suggestion cache, dismiss rules, canvas checks), `cc.onsite.*`, `cc.chat.*` (UI prefs, plans), `cc.vdp.*` (identity, push runs, autopilot), `cc.org62.account_hierarchy`, `cc.deals/dc-read`, `cc.attribution.*`, `cc.use_cases.extract`, `cc.logging/*`, `cc.ext/{app_runs,mapping_questions,change_sets}`, and the remaining presentation ext fields (labels, ordered id lists, enum overrides).
- **Not yet moved** (writers outside this chunk): `cc.ext/meeting_notes` (activity-notes job), `cc.ext/calendar_events` agenda/takeaways (projections), `cc.ext/work_items.enrichment` (enrich job), `hoursQtd`.

## Consequences
- No new `cc.ext/*` keys. The 2.1 drop migration needs Doctor `data:kv-fallback` at zero and the two dual readers switched.

## Supersedes
None.
