# D-87: Activity = To log · History · VDP

- **Status:** Accepted · planned, phase 3 (chunk p3-activity-review) · as of 2.0 (2026-11-21): built
- **Date:** 2026-11-20
- **Source:** H-10 T4. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 01](../reviews/2026-11-20-holistic/01-ui-audit.md) R4, T4; [lane 06](../reviews/2026-11-20-holistic/06-time-activity.md) R8

## Context
Activity has two rows of five or six tabs whose counts disagree (sidebar 7, Org62 1, VDP 6), a title that changes between Activity, Time and VDP, and internal words on screen (canvas, Slackbot, CF/CR, `Use_Case__c`).

## Decision
- Three tabs: **To log** (Log it and Needs you merged, inline Accept, one "Log N" button), **History** (Weeks and Ledger), **VDP** (Changes; My VDPs is a filter). Forecast only for the AE.
- Use cases are a row kind. Plain words: batch, Send to Org62 via Slackbot, checked in Org62.
- Old `?view=` URLs redirect.
- Admin items (logging canvases, VDP changes) are still reviewed and applied on Activity, behind the same Outbox gate.

## Consequences
- The Outbox engine, preview, confirm, dry run and audit are unchanged (*tenet: Nothing leaves without approval*).

## Supersedes
D-52 (admin items reviewed on Time) and D-72 (Activity with Org62 / VDP tabs).
