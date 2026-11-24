# D-92: Data model 2.0: business state in columns

- **Status:** Accepted · planned, 2.0 (chunks p4-sidecar-to-columns, p4-page-scoped-reads, p4-retention) · as of 2.0 (2026-11-21): partly built (D-99 columns 0036, page-scoped reads, retention); the kv keys and `vdp_records.detail` drop in 2.1
- **Date:** 2026-11-20
- **Source:** H-14. [synthesis §8](../reviews/2026-11-20-holistic/README.md), F4; [lane 09](../reviews/2026-11-20-holistic/09-data-model.md) R1-R8, DM-1..DM-5

## Context
Business state (`dcAssigned`, `dcStatus`, `nextStep`, needs decisions, canvas picks) lives in a JSON side-car under `user_settings` keys, joined with string-built keys. 199 hand-rolled 15/18-character Org62 id normalizations sit in 28 files. Every request loads the whole world.

## Decision
- The kv side-car becomes columns, filled by a backfill job; `need_decisions` and `canvas_row_overrides` tables.
- `org62_id15` generated columns.
- VDP child tables (`vdp_use_cases`, `vdp_assets`, `vdp_members`).
- One inbound mirror convention plus `mirror_reads`; landings for Slack and Gmail writes too.
- Page-scoped reads, `ReadModel` only for Home/Today over open work ± 14 days. A retention table and `doctor db:size`.

## Consequences
- Ships as the 2.0 major, under the migration discipline (D-96).
- Contract fields dual-write for one release.

## Supersedes
None.
