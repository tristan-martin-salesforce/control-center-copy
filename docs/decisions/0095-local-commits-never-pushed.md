# D-95: Build commits stay local; Tristan pushes

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** Ops. [synthesis §8](../reviews/2026-11-20-holistic/README.md) (the Ops row)

## Context
The holistic build runs many builder agents in parallel worktrees. Hard invariant 1 already says agents never push.

## Decision
- Builders commit continuously on their own branches; the orchestrator integrates them on the local integration branch. Nothing is pushed.
- Tristan pushes to his fork and opens the PR himself.
- Postgres 17 is installed on the build machine for verification only.
- The final commit bumps to 2.0.0 with its CHANGELOG section, without a tag.

## Consequences
- `npm run release` and `npm run update` are never run from a lane.

## Supersedes
None.
