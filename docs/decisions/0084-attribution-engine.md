# D-84: One attribution engine for time, DCs and use cases

- **Status:** Accepted · planned, phase 2 (chunks p2-attribution-engine, p2-use-case-candidates) · as of 2.0 (2026-11-21): built (0032, 0034)
- **Date:** 2026-11-20
- **Source:** H-9. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 06](../reviews/2026-11-20-holistic/06-time-activity.md) D-T1..T5, TA-2/3/12, R1-R7

## Context
Opportunity attribution runs in three places that disagree (`projections/matching.ts`, `lib/time-suggest.ts` + `opp-options.ts`, `engines/deals/evidence.ts`). `mapping_rules` has had no reader and no writer since migration 0001.

## Decision
- One engine (`src/engines/attribution/`): a ranked top 3 with reasons; rules first, then live Org62 discovery (at most 20 lookups a day, cached 7 days), then a cheap model only for close calls.
- Every accepted pick is written back as a learned rule, listed and removable in Settings.
- `opp_engagement` credits the top candidates, so several opps can earn DC suggestions without splitting hours.
- DC suggestions run daily, including "AEs I cover" (all listed; pre-ticked only with evidence; a pre-tick is not an approval).
- Use cases may go to Org62 before the 100% DC on engaged opps. One weekly Review page.

## Consequences
- *tenet: Hours are human hours* and *Nothing leaves without approval* hold: Apply is still the only send.
- The attribution accept rate is logged, so the engine is measured.

## Supersedes
Amends D-63 and D-67 (use cases may go to Org62 before the 100% DC on engaged opps) and D-71 (one engine makes the suggestion).
