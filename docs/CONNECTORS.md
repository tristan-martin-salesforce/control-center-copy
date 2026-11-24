# Connectors

How Command Center reads a source, and how to add one. Background: `docs/reviews/2026-11-20-holistic/08-connectors-providers.md` (R1, R6, R7) and decisions H-3 (Slack and Org62 reads stay MCP through Claude Code) and H-4 (a model provider seam, an OpenAI adapter only when someone needs one).

## The pieces

| Piece | Where | What it owns |
|---|---|---|
| Source kinds | `src/contract/sources.ts` | The connector ids, the `source_system` enum values and the contract `SourceKind`, and the one mapping between them. A test fails when any of them drifts. |
| Manifest | `src/connectors/<id>/manifest.ts` | What the source is: id, label, runtime, read tools, auth, windows, cadence, cost estimate, health probe, parsers, failure codes, how the scanner drives it. |
| Registry | `src/connectors/registry.ts` | One line per manifest. The scanner (`src/scanner/runtime/connectors.ts`) and the worker look values up here instead of branching on the id. |
| Runtime | `src/connectors/runtime/` | How a read tool gets called. Four kinds, one `call(tool, args, {budget, timeoutMs, trace}) → {text, json, usage, cost}`. |
| Fetcher | `src/connectors/<id>/…` | Scopes, cursors and windows, calling only the runtime it is given. |
| Parser | `src/connectors/<id>/parse.ts` | Raw tool output to rows. Pure, tested on recorded fixtures (`tests/fixtures/**`). |

The four runtimes:

| Runtime | Used by | Auth | Cost per read |
|---|---|---|---|
| `claude_relay` | Slack, Org62, watch briefs | Claude Code's own MCP OAuth (the app never sees a token) | One small Claude run: the `read-lookup` skill as system prompt, no settings files, exactly one tool. Each call is booked in `llm_calls` (prefix tokens, turns, cost), and `estimateUsd(tool)` gives the p90 of recent calls so the spend governor can hold before calling. |
| `direct_mcp` | Gmail, Calendar, Drive, Gemini notes, Trainings | devbar's gateway | None (no model) |
| `http_jsonrpc` | VDP | PAT + Okta cookie read from the Claude config per call, in memory only | None |
| `local_files` | Claude sessions | None | None. Reads only under its configured folders. |

**Fetch then interpret.** Scans now read through these runtimes by code (`CC_SCAN_MODE=fti`, the default; docs/reference/SCANNER.md §11). Slack and Org62 run their skills' fixed queries as one `claude_relay` call per page (`src/scanner/fetch/`), paged by code and recorded by REC-1 / REC-2 into the same rows as before; Gmail, Drive and Gemini notes keep their deterministic fetchers. A tool-less classifier (`modelProvider().complete()`, `skills/classify-items.md`) then interprets what was recorded in batches, so a new connector needs a fetch and, if a model reads its items, a short section in that one skill, not a traversal skill of its own. Each relay read is booked as a `pass` row of its scan run under `relay:<connector>:<tool>`, which is the history `estimateUsd(tool)` reads.

## The read-only rule

*Tenet: Read-only ingest*, CLAUDE.md invariant 2. A manifest lists only read tools, and each one must already be on a read allowlist:

- Slack and Org62: `SLACK_SCAN_TOOLS` / `ORG62_ALL_TOOLS` in `src/llm/mcp-config.ts`.
- Google: `GOOGLE_READ_TOOLS` in `src/connectors/google/client.ts`.
- VDP: `VDP_READ_TOOLS` in `src/connectors/vdp/tools.ts`.
- A new server: add its read list next to these, on purpose, in its own reviewed change.

Every runtime refuses a tool that is not on its manifest's `readTools`, or that looks like a write (`assertReadOnly`), before anything is sent. `tests/connectors/registry.test.ts` fails when a manifest names a tool that is not on a read allowlist, or names an Outbox or VDP write tool. `tests/safety/mcp-tools.test.ts` checks that no connector file names a write tool at all. Writes never go through a connector: they are Outbox actions the user Applies.

**Org62 discovery** (`org62.discover`, `src/jobs/handlers/org62-discover.ts`) runs fixed SELECTs through the one-call read path (`soqlQuery`, already on `ORG62_ALL_TOOLS`), each booked against `DISCOVER_DAILY_LOOKUPS` (20 a day): the team read, the open-opp reads by account and by covered AE, and (D-103 (b)) one Specialist Forecast read, `SpecialistForecast__c` where `OwnerId IN (<covered AE ids>)`, `ForecastType__c` in the four Data & AI types and the opp open (`sfrDiscoverSoql`; ids validated and bound, no free text, ≤ 200 ids per statement). A user with 6 covered AEs pays one more read per run: one a day on the daily cadence. Same tool, same cap, no new allowlist entry.

Never widen an allowlist to make a connector work, and never pass a token from Claude Code's store to the app or to another provider.

## Adding a connector

You need one folder and one registry line. If the source kind is new, you also need one entry in `src/contract/sources.ts` and, until the enum becomes text (decision D3 in 08), an additive `ALTER TYPE source_system ADD VALUE` migration.

1. `src/connectors/<id>/manifest.ts`: the manifest. Pick the runtime by who holds the credential: Claude Code (`claude_relay`), a gateway (`direct_mcp`), the app reading a local config (`http_jsonrpc`, which needs the owner's sign-off), or nothing (`local_files`).
2. `src/connectors/<id>/parse.ts` and recorded fixtures under `tests/fixtures/scanner/<id>/`. Placeholders only, no real names or ids. A non-empty input that parses to zero items is drift: throw, do not return empty.
3. The fetch. Either a `DeterministicFetcher` that calls only `runtime.call()`, or, for a relayed source, the fixed queries the fetch step makes through the runtime.
4. `skills/scan-<id>.md` if a model interprets the items. Code decides the model and the tools; the skill only describes how to interpret.
5. One line in `src/connectors/registry.ts`, and the id in `CONNECTOR_IDS`. Labels, cadence, re-auth hint, health probe and scan behaviour then come from the manifest.
6. Tests: the parser over its fixtures, the fetcher with a fake runtime (re-fetching gives the same `dedupeKey`s), and the registry tests, which pick the new manifest up on their own.

### Worked example: Jira through MCP (hypothetical)

Say the team's Jira MCP server is declared in Claude Code as `jira`, with OAuth that Claude Code holds. That makes it a relayed source.

1. Add the read list to `src/llm/mcp-config.ts`, reads only, reviewed on its own:

   ```ts
   export const JIRA_ALL_TOOLS = ['jira_search_issues', 'jira_get_issue', 'jira_create_issue', 'jira_add_comment'] as const;
   export const JIRA_SCAN_TOOLS = ['jira_search_issues', 'jira_get_issue'] as const; // never create/comment
   ```

   and add `jira` to `KNOWN_TOOLS` / `SCAN_TOOLS` and `MCP_SERVER_NAME` (`jira: 'jira'`).

2. `src/connectors/jira/manifest.ts`:

   ```ts
   import { MCP_SERVER_NAME } from '@/llm/errors';
   import { JIRA_SCAN_TOOLS } from '@/llm/mcp-config';
   import { relayDeclaredProbe } from '../runtime/probes';
   import type { ConnectorManifest } from '../runtime/types';
   import { RELAY_FAILURE_CODES } from '../slack/manifest';
   import { parseJiraIssue, parseJiraSearch } from './parse';

   const H = 3_600_000;

   export const jiraManifest: ConnectorManifest = {
     id: 'jira',
     label: 'Jira',
     runtime: 'claude_relay',
     server: MCP_SERVER_NAME.jira!,
     scopes: ['assigned', 'mentioned'],
     auth: { kind: 'claude_mcp_oauth', check: 'claude_mcp_status', reauthHint: { handler: null, kind: 'terminal_command', hint: 'claude mcp login jira' } },
     readTools: JIRA_SCAN_TOOLS,
     windows: { default: 7 * 24 * H, max: 30 * 24 * H },
     cadence: { baseMs: 30 * 60_000 },
     estimate: { usdPerDay: 0.1 },
     healthCheck: () => relayDeclaredProbe('jira'),
     parse: { search: parseJiraSearch, issue: parseJiraIssue },
     failureCodes: [...RELAY_FAILURE_CODES],
     scan: { mode: 'deterministic', skill: 'scan-jira', chunkMs: 24 * H, maxItemsPerRun: 25 },
   };
   ```

3. `src/connectors/jira/parse.ts` turns `jira_search_issues` output into rows, with fixtures in `tests/fixtures/scanner/jira/search_assigned.json` (placeholder keys like `PROJ-1`).

4. `src/connectors/jira/fetcher.ts`: a `DeterministicFetcher` whose `fetch` makes the fixed query through the runtime it is given. It never lets a model choose the call:

   ```ts
   const r = await this.runtime.call('jira_search_issues', { jql: `assignee = currentUser() AND updated >= "${from}"` }, { signal, budget: { usd: 0.01 } });
   return parseJiraSearch(r.text);
   ```

   The worker builds it with `buildRuntime(manifestOf('jira'), { relay: { ledger } })`. That books each read, and the spend governor can ask `runtime.estimateUsd('jira_search_issues')` before it runs.

5. Register it: add `jiraManifest,` to `MANIFESTS` in `src/connectors/registry.ts`, `'jira'` to `CONNECTOR_IDS` (and `CONNECTOR_SOURCE`) in `src/contract/sources.ts`, and the cadence default in `src/scanner/runtime/cadence.ts`. `tests/connectors/registry.test.ts` and `sources.test.ts` tell you about anything you missed. Until the enum is text, add `ALTER TYPE source_system ADD VALUE 'jira'` as a new migration with its journal entry.

6. Run `npm test -- tests/connectors` and `tests/safety`. The registry tests check that the manifest is complete and that `jira_search_issues` and `jira_get_issue` are on a read allowlist and are not writes.

## The model provider

Reasoning does not go through connectors. It goes through `src/llm/provider`:

- `modelProvider().complete({ model, system, messages, tools?, maxTokens, cacheBoundary })` handles tool-less prompts: batched classification, drafts. `model` can be a tier (`fast`, `balanced`, `strong`; `src/llm/models.ts`) that each provider maps to its own ids and prices.
- `agentQuery` is the Agent SDK's `query()` running on the active provider. Every agentic runner (skill runner, one-call relay, chat, read-in, research, feedback, forecast) calls it.
- Only `src/llm/provider/**` and `src/llm/claude-env.ts` may import `@anthropic-ai/claude-agent-sdk`. Lint errors on any other import (`tests/llm/provider/sdk-imports.test.ts`).
- `CC_MODEL_PROVIDER=openai` selects `src/llm/provider/openai.ts`. It is a stub that refuses until an adapter is written. Its header documents the shape an adapter must fill in. A non-Claude provider reasons over items that were already fetched. It never reads Slack or Org62 itself: those reads stay `claude_relay`.
