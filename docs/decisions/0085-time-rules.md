# D-85: Time, DCs and use cases: the ten rules are the spec

- **Status:** Accepted · living spec in `docs/EDGE-CASES.md` ("The rules")
- **Date:** 2026-11-20
- **Source:** Docs reset. [synthesis §8](../reviews/2026-11-20-holistic/README.md), F6; [lane 06](../reviews/2026-11-20-holistic/06-time-activity.md) §5, TA-7

## Context
Nobody could predict what the time engine would do from D-59..D-72: rows up to 5,000 characters, amended in place (D-67 three times, then partly overridden by D-72).

## Decision
- The ten rules at the top of [`docs/EDGE-CASES.md`](../EDGE-CASES.md) are the readable spec for time, DCs and use cases. The edge-case tables below them are the cases.
- The decisions keep their history; their rows stay in the archive.
- A behaviour change changes a rule (and its edge-case rows), and gets a new ADR here when it constrains future code.

## Consequences
- A teammate or builder reads ten rules, not fourteen decisions.
- D-17, D-18, D-46, D-47, D-59, D-60, D-61, D-63, D-64, D-65, D-67, D-68, D-70 and D-71 stay accepted (some amended elsewhere); their index rows point here as the summary.

## Supersedes
None (it summarizes; it supersedes nothing).
