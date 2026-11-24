# D-103: Coverage as data, event-driven DC checks, Opportunity-or-Account targets

- **Status:** Accepted 2026-11-23 (the owner delegated the call and reviews after). **Built** 2026-11-23 (chunks DC1–DC4): (a) coverage as data, with the Specialist Forecast reads and each DC suggestion's context; (c) Opportunity-or-Account targets, except "DCs on all N" (B-127), with B-117 still open (the Account WhatId is the settled target, swappable in `accountTargetWhat`); (d) dismissal memory with the call override. **Proposed**: (b) event-driven re-evaluation (`engine_events`, the template check and the comment drafter; today the nightly batch and the time → DC ripple re-run the rule), (e) backfill mode and (f) `rule_version` stamping with its snapshot test (B-119; the engine CHANGELOG itself exists), until the owner supplies the DC template and answers B-117 · amends [D-84](0084-attribution-engine.md) and rule 9 of [`EDGE-CASES.md`](../EDGE-CASES.md) (AT-09, AT-13)
- **Date:** 2026-11-23
- **Source:** owner brief; [review 03](../reviews/2026-11-23-activity-ux/03-dc-engine-flex.md) (5 exist · 16 partial · 9 gap)

## Context
- **Covered AEs.** "AEs I cover" is a Settings field, but the DC rule and the scorer match a covered AE only as the opp *owner* (`dc.ts:108`). A deal of theirs I never touched is never suggested (AT-09). Specialist Forecasts of my AEs are never read.
- **Dismissals.** Three paths keep three memories, and none of them reopens on a call.
- **Account-level time.** It exists only as a flagged fallback, and nobody can pick an account on purpose.
- **Re-checks.** No DC template exists, and nothing re-checks a DC when the template or the work changes.
- **Engine history.** No record says why the engine's rules changed.

## Decision
- **(a) Coverage is data.** Each `CoveredAe` gains `kind` (ae, ooo, sme), an optional window and scope, and a `creditShare` (100, 50 or 25), all back-compatible. One matcher, `coverageOf(opp, day)`, matches a person as owner, opp team member or Specialist Forecast owner. A kind-`ae` match is a reason on its own: suggested, unticked. `creditShare` is the default split. Rows learned from Slack or Calendar arrive as proposals only.
- **(b) Re-evaluation is event-driven.** The events are template_changed, time_logged, sfr_seen, dc_seen, call_seen and coverage_changed, recorded in `engine_events`. A fingerprint check and the deterministic rules run first. A model call happens only to draft a DC comment that fails the template or misses new work, and it lands as an Outbox-gated canvas row. The nightly batch stays as a 0-token safety net, and no periodic LLM rescan is built. The DC template is team-pack data with a version.
- **(c) The target is an Opportunity or an Account.** An account with no open opp is a settled target. Every attribution carries a factual groundwork sentence. Org62 search returns accounts too. "DCs on all N" is one confirm on the row, with hours on one opp.
- **(d) One dismissal memory.** A dismissed DC suggestion, gap or finding returns on 2 h more logged, on joining the team, or once on a call on that account after the dismissal.
- **(e) Backfill mode.** It searches Drive and Slack for use cases per account. The VDP asset scan is optional and off by default. The cost is estimated (p50/p90) before the run, and the run pauses at the hold (D-80).
- **(f) Engine decision log.** `docs/engines/CHANGELOG.md` records each rule or weight change. `rule_version` is stamped on suggestions, outcomes and events, so the UI's "why" cites the version and the event trail.

## Consequences
- **Tenets hold:** *Nothing leaves without approval* (drafts and canvas rows only), *Suggest, then learn* (a pick is never overridden), *Config over code* (coverage and template are data), *Provenance on everything* (events and rule versions).
- **Rule changes:** rule 9 and AT-09/AT-13 change in `EDGE-CASES.md` before code (D-85).
- **Open question:** does post-sale time log to the Account WhatId, or by another mechanism? (B-117)

## Supersedes
None. It would amend D-84 (covered AEs' deals no longer need a touch to be suggested).
