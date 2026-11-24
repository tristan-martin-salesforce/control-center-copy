# D-86: One Needs-you queue, Home as a briefing, a seven-item sidebar

- **Status:** Accepted · planned, phase 3 (chunks p3-needs-queue, p3-home-briefing, p3-nav-and-pages) · as of 2.0 (2026-11-21): partly built: the queue, the briefing and Home ▸ Plan; the seven-item sidebar and Triage folding into Needs you are not
- **Date:** 2026-11-20
- **Source:** H-10 (T1-T3, nav, drain mode). [synthesis §8](../reviews/2026-11-20-holistic/README.md), F3 and §3; [lane 01](../reviews/2026-11-20-holistic/01-ui-audit.md) R1-R6, T1-T3; [lane 02](../reviews/2026-11-20-holistic/02-ui-research.md) P1-P13

## Context
The same decision lives in five places: drafts show on Home, Outbox, an Assistant card, the Work panel and Triage. Eleven sidebar destinations carry six counts that sum to about 42. Home and Today both answer "what now".

## Decision
- One server-built **Needs you** queue (`GET /needs`: kind, verb, why, source, group key), one row per fact. Every page filters it and the sidebar counts it once.
- Today folds into Home as a Plan toggle. Home = three do-now cards, the top five grouped Needs-you rows, Respond, Coming builds, Admin.
- Triage stays until the queue lands, then folds into its Confirm filter.
- Sidebar: Home · Needs you · Outbox · Work · Deals · Activity · Assistant, one count. Old chords stay as aliases for a release.
- Drain mode (ReviewQueue) on every queue. Batch approve stays a human click.

## Consequences
- Outbox stays the one approval queue (D-75 holds); Deals is reference, not an inbox.
- Item menus become Done ▾ and Later ▾ (the component kit).

## Supersedes
Amends D-54 (the next-day toggle becomes Home's Plan toggle).
