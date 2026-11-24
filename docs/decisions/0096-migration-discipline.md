# D-96: Migration discipline

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** [synthesis §6](../reviews/2026-11-20-holistic/README.md); [lane 09](../reviews/2026-11-20-holistic/09-data-model.md) §3.6

## Context
Phases 1-4 change the schema while the app is in daily use, and teammates update on their own schedule.

## Decision
- Additive first. A backfill is a job (or an idempotent statement), never a destructive step inside the migration.
- Contract fields dual-write for one release (e.g. `suggestion` = `suggestions[0]`).
- No destructive change inside a minor; a major gets a dump before migrate and a verified restore path.
- Never edit a shipped migration.
- The worker refuses to claim jobs when its bundled migrations and the database disagree (exists).
- `PROJECTIONS_VERSION` bumps when a projection must be recomputed.

## Consequences
- Semver (D-57) maps onto this: an additive migration is a minor, a manual step is a major.

## Supersedes
None.
