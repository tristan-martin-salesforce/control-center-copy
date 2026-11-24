# D-97: No Batch API, no API embeddings; RAG deferred

- **Status:** Accepted
- **Date:** 2026-11-20
- **Source:** [synthesis §3](../reviews/2026-11-20-holistic/README.md); [lane 04](../reviews/2026-11-20-holistic/04-llm-cost.md); [lane 08](../reviews/2026-11-20-holistic/08-connectors-providers.md); [lane 09](../reviews/2026-11-20-holistic/09-data-model.md) R10

## Context
The Batch API was raised to cut first-scan cost; embeddings and RAG were raised for "which opp" and Assistant search.

## Decision
- No Batch API: a direct Messages API conflicts with "`claude -p` sessions and MCP connections only", and deterministic fetch plus large batches gets the first scan to $1-3 anyway.
- No API embeddings (*tenet: Local data, privacy-safe logs*). Fix keyword search and the id columns first; local-model pgvector only in phase 4, and only if the phase-2 evals show the keyword path falls short.

## Consequences
- Model access stays Claude Code sessions plus the provider seam (D-79).

## Supersedes
None.
