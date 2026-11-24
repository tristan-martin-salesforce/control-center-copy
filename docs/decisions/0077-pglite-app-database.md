# D-77: PGlite as the app database (2.0), bundled Postgres 17 as the fallback

- **Status:** Accepted · planned, 2.0 (gated by the p4-pglite-spike verdict) · as of 2.0 (2026-11-21): amended by D-98: the spike said no, bundled Postgres 17 shipped; PGlite for tests and mock not built
- **Date:** 2026-11-20
- **Source:** H-2 (deviation from the recommendation). [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 09](../reviews/2026-11-20-holistic/09-data-model.md) D1/D2; [lane 10](../reviews/2026-11-20-holistic/10-engineering-system.md) Decision 1; [lane 11](../reviews/2026-11-20-holistic/11-packaging.md)

## Context
Users run Homebrew Postgres 17 today, which a teammate must install and keep running ("no standing up a custom DB"). The mock DataSource (about 7.7k lines) is a second implementation that drifts unless the Postgres parity suite runs. Lane 09 recommended bundling Postgres 17; Tristan chose PGlite.

## Decision
- PGlite (embedded Postgres) becomes the app database, hosted by the worker; the web and tool servers connect to it.
- Condition: a spike first proves one shared PGlite connection holds under the worker's `SKIP LOCKED` job queue and live NOTIFY across web, worker and tool servers. If it fails, bundled Postgres 17 (an app-managed cluster) is the fallback.
- PGlite for mock and tests either way. The mock DataSource is retired: `CC_DATA=mock` becomes the db DataSource on PGlite seeded from `seed.example.json`. Shared read views come first (lane 10 R7 step 3), retirement second.
- Existing Postgres users migrate on `npm run update`: dump, import, verify (row counts and digests), switch. This is the 2.0 major.

## Consequences
- Zero SQL changes is the goal: triggers, NOTIFY, audit and undo stay.
- The DB test harness becomes one helper with a `CC_TEST_PG=pglite` switch.
- The old database is kept after the switch until the user removes it.

## Supersedes
D-4 (SQLite; already superseded in practice by Postgres).
