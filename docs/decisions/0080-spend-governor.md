# D-80: One spend governor: estimate, raise a hand, continue

- **Status:** Accepted · planned, phase 1 (chunk p1-spend-governor) · as of 2.0 (2026-11-21): built (`src/llm/spend`, `spend_holds` 0030) · as of the post-2.0 chunks (2026-11-21): every per-feature cap replaced: background jobs run under the start gate's hold and ask past it (`job-spend.ts`, `spend-pause.ts`), relay jobs book every lookup into one hold, the old caps are only the runaway guard's floor (caps audit F-4)
- **Date:** 2026-11-20
- **Source:** H-5. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 04](../reviews/2026-11-20-holistic/04-llm-cost.md) D3, COST-7; [lane 05](../reviews/2026-11-20-holistic/05-assistant.md) §6, AST-1/2

## Context
Spend is controlled by eight independent kill switches. A run that hits its cap fails and retries at half size; the daily cap pauses everything until midnight; the Assistant's research must fit inside what is left of a $0.25 message, and "Allow more" re-sent the message and paid twice.

## Decision
- One envelope model in `src/llm/spend/governor.ts`: estimate a run from `llm_calls` history (p50/p90) and hold the p90. When a run would exceed its hold, raise a hand in the existing `canUseTool` gate, so the session stays alive and continues after the user says yes.
- A user-set daily ceiling stays as the runaway guard.
- It replaces every per-feature cap. It plugs into the skill runner, the scanner runtime, the chat runner, Settle and relay-guard; holds live in an additive `spend_holds` table.

## Consequences
- No run is killed mid-way for a budget it could have asked about.
- The first scan gets a history-based estimate before it starts.

## Supersedes
D-5 (soft daily cap, alert at 80%). Amends D-43 (chat's own daily budget becomes part of the one envelope, under the daily ceiling).
