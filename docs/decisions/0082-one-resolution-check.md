# D-82: One resolution check decides "is this done?"

- **Status:** Accepted · correction rule and reopen built in phase 0; the check planned, phase 2 (shadow first; chunk p2-resolution-check) · as of 2.0 (2026-11-21): built (0031), watch only by default (`settings.closing.resolutionEngine`)
- **Date:** 2026-11-20
- **Source:** H-7. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 03](../reviews/2026-11-20-holistic/03-scanner-quality.md) D1-D5, SCN-2/3/4, R1-R4

## Context
Two engines decide whether an item is done, with two correction rules: Settle never auto-closes an item the user touched in any way, while the closure machine has no guard and can re-close a reopened item. A follow-up after a wrong close was swallowed as context, and `reopenOnFollowUp` was read by nothing.

## Decision
- One resolution check replaces the completion pass and Settle: trigger rules, a context pack builder, a tool-less Haiku verdict, and a narrow Sonnet escalation only where data shows it changes verdicts. Verdicts go to a `closure_checks` table.
- Correction rule B: only "reopened", "Kept" or "Not done" blocks an auto-close.
- A follow-up from the asker within 14 days reopens the item, with Undo.
- Shadow mode for one release, then `completion.check` and Settle retire.

## Consequences
- *tenet: Suggest, then learn* is restored: a correction is never overridden.
- A "Why is this still open?" panel and `scan:explain --item` read the same verdicts.

## Supersedes
D-44 (a model check per item). Amends D-26 (auto-close follows the one check).
