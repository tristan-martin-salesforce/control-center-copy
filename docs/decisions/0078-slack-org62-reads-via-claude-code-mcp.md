# D-78: Slack and Org62 reads go through Claude Code MCP only

- **Status:** Accepted · planned, phases 1-2 (ConnectorRuntime, fetch-then-interpret) · as of 2.0 (2026-11-21): built (ConnectorRuntime `claude_relay`; fetch-then-interpret is the default scan mode)
- **Date:** 2026-11-20
- **Source:** H-3 (deviation: no devbar gateway). [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 04](../reviews/2026-11-20-holistic/04-llm-cost.md) D1, COST-3; [lane 08](../reviews/2026-11-20-holistic/08-connectors-providers.md) D1/D2

## Context
Scanning costs about $10/day mostly because Slack and Org62 reads, and even the "anything new?" pre-check, each cost a model turn inside a 5-30 turn tool loop with a 42K-token prefix. The cheaper paths (a Slack app token, an Org62 API client, a devbar gateway) need an app-owned token store or a company-managed service we do not control.

## Decision
- Slack and Org62 are read only through the MCP servers configured in Claude Code. No Slack SDK, no Org62 API, no devbar gateway, no app-owned OAuth tokens, ever.
- Each read is the smallest possible Claude run that calls the one MCP tool (the one-call pattern, `src/llm/one-call.ts`): the `claude_relay` runtime of a `ConnectorRuntime`.
- Interpretation runs afterwards in batches, with no tools, on Haiku, against one cached prefix (fetch-then-interpret).
- Switch to the SDK's zero-token `mcp_call` as soon as an SDK version exposes it.
- VDP's direct HTTP client stays (`src/connectors/vdp/http.ts`) and is documented as such.

## Consequences
- *tenet: Read-only ingest* and hard invariant 2 hold: the allowlist is unchanged.
- Target: background scanning at or under $0.50/day.
- The same runtime seam is what a second LLM provider needs (D-79).

## Supersedes
D-37 (Slack read path; the personal Slack app fallback is withdrawn).
