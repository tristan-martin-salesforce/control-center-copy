# D-102: To log as three lanes (Fix · Ready · Sending), one count, History owns the past

- **Status:** Accepted · built (2026-11-23: C1–C11, F1–F7, G1–G4; chunks C1–C9 in [the Activity-at-scale review](../reviews/2026-11-23-activity-ux/01-activity-at-scale.md) §7) · amends [D-86](0086-needs-queue-home-nav.md), [D-87](0087-activity-model.md), D-64, D-72
- **Date:** 2026-11-23
- **Source:** owner brief and [review 01](../reviews/2026-11-23-activity-ux/01-activity-at-scale.md) AX-1..AX-11

## Context
The owner's brief: on Activity a person does three things: fix or approve the time and its attribution (and look the opportunity up in Org62 when the app is wrong); see what is approved and waiting to be logged; follow one or more batches to completion and see what was logged. Measured with a seed of 144 activity rows (a normal quarter for a seller who is behind), To log put nothing actionable above the fold (Needs you ran ~6,000 px, Ready to log began ~7,000 px down), six surfaces showed six different counts, a batch's progress was in three places, "failed" had three looks, and there were two Histories. The owner's criteria: easy at a glance, scale to dozens of items per surface, no duplicated information, use the width when the assistant is closed, one obvious way to dive deeper.

## Decision
- **Three lanes, one per job, each with one count and one button.** *Fix or approve* (rows that cannot log yet, grouped by the app's suggestion so a whole group is one Accept; the internal rows are a group here, accepted as internal, never counted as needs-you: D-64's counting rule stands, its placement changes). *Ready to log* (by day, ticks on the lane, "Log N · h" stages one batch for the user's Apply; D-47 unchanged). *Sending* (one line per batch with four steps, Staged · Applied · Sent · Checked x of y; rows not found in Org62 sit on their batch with Log again / Leave out, D-65; batch-level failures live here and only here; the lane header carries the failure count).
- **One count.** A single pure function derives every number the header sentence, the tab badge, the lane headers, the sidebar and Home's time row show. Needs-you = fix rows + sending failures.
- **Width.** Two columns when the assistant sidebar and the details panel are closed and the main area is wide enough (lane 1 left; lanes 2 and 3 stacked right); one column with lane pills otherwise. A kit frame (`LanePage`), not per-page CSS, so VDP, Inbox and Work adopt it next.
- **Scale rules.** One-line rows; 8 per group then Show more; at most four groups open; pickers only on the row being edited; group and range ticking; bulk verbs per lane; the row chevron (and Enter) opens the details panel and is the only dive-deeper affordance.
- **What leaves To log.** The "Needs you here" queue slice (the page *is* that slice; amends D-86: a page whose content is the queue's slice does not mount it; Home and other pages keep it). The quarter tracking card becomes one header sentence; the card, the charts and finished batches live on History only. DCs to claim and use cases become counts on one "Also waiting" line linking to their own places (DCs to Deals; the use-case question cards to the VDP tab); amends D-87/D-72's placement.
- **History owns the past.** Finished batches, a Batches filter, every row with its Org62 record, corrections. A row handed to a batch shows "in batch <date>" quietly, linking to lane 3, instead of its own in-flight state. The sidebar page `/history` (the day journal) is renamed **Journal** in the nav so there is one History; its "Time logged" totals link to Activity ▸ History instead of repeating them.
- **Review** (`?review=1`) stays, as lane 2 at full width.

## Consequences
- Plain-words and keyboard rules of D-87 and docs/UX.md apply unchanged; `tests/ui/time-plain-words.test.ts` gains the new copy.
- D-86's "Needs you here on every page" is now "on every page whose work is not the slice itself".
- The scale seed (`CC_SEED_SCALE`) is the standing way to judge any dense page; a page that fails the three-second or above-the-fold test at scale 7 is a bug.

## Supersedes
Amends D-86, D-87, D-64 and D-72 as above. Does not change the number of pages.
