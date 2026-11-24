# D-83: Priority@2: value × urgency, fitted to capacity

- **Status:** Accepted · overdue decay built in phase 0; priority@2 planned, phase 2 (shadow first, switchable back; chunk p2-priority-v2) · as of 2.0 (2026-11-21): built (0033), previewed beside v1 by default (`settings.priority.engine`)
- **Date:** 2026-11-20
- **Source:** H-8. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 07](../reviews/2026-11-20-holistic/07-prioritization.md) D1-D7, PRIO-1/6/7/9/14

## Context
The priority engine dropped `importance`, `dueKind`, `askedAt` and people tier before scoring, overwrote importance on every re-rank, capped deal value at $500k, and let any overdue chore outrank tomorrow's large demo build forever. Dismissals and snoozes changed no score.

## Decision
All seven, shadow first:
1. Overdue decays after one working day.
2. A draft rides on its item's card plus one Respond row.
3. Admin is a quiet batch unless due within 48 h or pay-linked and at risk.
4. The extractor emits a size class.
5. Persona prep rules create prep items for customer meetings.
6. Auto re-rank after scans, with a stable display.
7. NBA is demoted: ranking and "why" come from the engine; NBA skills stay for on-demand drafts.

## Consequences
- Golden days (`tests/evals`) measure "better"; `previewPolicy` shows the diff in shadow.
- `priority_feedback` records picks so the score learns.

## Supersedes
None.
