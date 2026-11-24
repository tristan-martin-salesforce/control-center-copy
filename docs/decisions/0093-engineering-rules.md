# D-93: Engineering rules: layers, file length, module tests, two check levels

- **Status:** Accepted · lint built as warnings (chunk p1-docs-reset); test projects planned (chunk p1-test-projects-and-moves) · as of 2.0 (2026-11-21): built: test projects, `check:fast` / `check`, the length lint (errors at 1,000, grandfathered files); the layer lint still warns · as of the post-2.0 chunks (2026-11-21): built: the layer lint is an error and `LAYER_GRANDFATHERED` and `LONG_FILES_GRANDFATHERED` are both empty
- **Date:** 2026-11-20
- **Source:** H-15. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 10](../reviews/2026-11-20-holistic/10-engineering-system.md) D1-D4, R1-R6, R10, ENG-4/5

## Context
Layering is mostly sound but unnamed and unlinted; files reach 4,779 lines; tests are laid out by build lane (50 folders), so nobody can answer "which tests cover Time?"; `check` needs Postgres.

## Decision
- The layer table in [`CONTRIBUTING.md`](../../CONTRIBUTING.md), enforced by `@typescript-eslint/no-restricted-imports` (type-only imports allowed). Warn first, with the current sites grandfathered by path, then error.
- `max-lines`: warn at 600, error at 1,000 (blank lines and comments skipped, tests exempt); the 11 files over 1,000 are exempt from the error until split.
- Vitest projects per module; tests co-located (`src/<module>/**/x.test.ts`) or in `tests/<module>/`, never in a folder named after a lane.
- `check:fast` (typecheck, lint, unit) before a commit; `check` (plus DB, contrast, smoke) before a release.
- Static safety tests in `tests/safety/` pin the invariants.

## Consequences
- Grandfather lists only shrink; `eslint.config.mjs` says "never add one".
- A lane that touches more than two modules splits into chunks ([`AGENTS.md`](../../AGENTS.md)).

## Supersedes
Amends D-30 and D-31 (the build protocol now lives in `AGENTS.md`).
