# D-79: A ModelProvider seam now, an OpenAI adapter on demand

- **Status:** Accepted · planned, phase 1 (chunk p1-connector-runtime) · as of 2.0 (2026-11-21): built (`src/llm/provider`: the Agent SDK adapter and an OpenAI stub)
- **Date:** 2026-11-20
- **Source:** H-4. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 08](../reviews/2026-11-20-holistic/08-connectors-providers.md) D4, R6; [lane 10](../reviews/2026-11-20-holistic/10-engineering-system.md) §4.2e

## Context
Model calls funnel through `one-call`, `skill-runner` and `claude-env`, but the Agent SDK is imported in several places and one engine (`engines/nba/prompt/complete.ts`) reaches into `@/llm` directly. A teammate on another provider has nothing to plug into.

## Decision
- One `ModelProvider` interface (complete, run with tools, cost), with the Agent SDK adapter as its only implementation.
- Lint: `@anthropic-ai/claude-agent-sdk` may be imported only under `src/llm/providers/**`. Model ids and prices live in one place.
- A Vercel AI SDK (OpenAI) adapter is added only when a real user needs it.
- Reads still go through D-78; the provider only interprets.

## Consequences
- No behaviour change today; the Claude path stays the default.
- Every booked model call keeps its audit fields (`tests/setup/ledger-gaps.ts`).

## Supersedes
None.
