# D-94: Docs: living, decisions, reference, archive

- **Status:** Accepted · built (chunk p1-docs-reset)
- **Date:** 2026-11-20
- **Source:** H-15 (docs reset). [synthesis §8](../reviews/2026-11-20-holistic/README.md), F6; [lane 10](../reviews/2026-11-20-holistic/10-engineering-system.md) ENG-10, R14, §4.4

## Context
`ARCHITECTURE.md` said SQLite and "proposed"; `DECISIONS.md` had 75 rows, some over 5,000 characters, amended in place; `docs/ui/*` held 17 build-era specs; `docs/README.md` said 42 decisions.

## Decision
- **Living** docs (`README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/{README,TENETS,ARCHITECTURE,UX,EDGE-CASES,BACKLOG,RELEASING,FEEDBACK-INTAKE}.md`) change in the same commit as the behaviour.
- **Decisions** are ADR-lite files in this folder (Context, Decision, Consequences, Supersedes; at most 30 lines). An amendment is a new ADR that supersedes the old one, never an edit in place. [`docs/DECISIONS.md`](../DECISIONS.md) is the one-line index.
- **Reference** specs live in `docs/reference/`; the **archive** (`docs/archive/`) is read-only history.
- CHANGELOG records what shipped; an ADR records why. A UI tweak gets no ADR.

## Consequences
- D-1..D-75 keep their archived rows; an ADR file is written for one when it is next touched.

## Supersedes
None.
