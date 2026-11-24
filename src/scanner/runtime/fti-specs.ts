/**
 * What FTI mode changes in the connector specs (review 04 §4.1 #7, COST-6: the first-scan rewrite):
 *
 *   windows    Slack's 2-hour inbox chunks were a workaround for an agent that lost asks in windows of more than ~9
 *              messages (SLK-1). Code now pages and the classifier batches by tokens, so the first scan reads the inbox
 *              a day at a time and channels a week at a time; catch-up backfill uses 6 h / 1 day.
 *   items      a deterministic run hands up to 100 items to the interpreter (batched by tokens), not 25 to an agent.
 *   cost caps  the runtime holds the run's cap against today's hard cap while it runs (D6). An FTI run costs about a
 *              cent at most, so its caps are a few cents, not an agent run's 8-15, and parallel scopes don't starve.
 *              TODO(spend-governor): hold the history-based p90 (estimate()/hold()) instead of a fixed cap.
 *   pre-check  none: an FTI poll is the same three relay searches the pre-check made, and it records what they find.
 */
import { traversalMcpServers } from '../../llm/mcp-config';
import type { ConnectorId } from '../types';
import type { DeterministicConnectorSpec, TraversalConnectorSpec } from './connectors';

const H = 3_600_000;

export function ftiTraversalOverrides(connector: 'slack' | 'org62'): Partial<TraversalConnectorSpec> {
  // The run input names the server for the agentic fallback only; an FTI read resolves it per call through the relay
  // runtime, which reports a missing declaration as its own `config` error (instead of failing before the run starts).
  const mcpServers = () => {
    try {
      return traversalMcpServers(connector);
    } catch {
      return {};
    }
  };
  if (connector === 'slack') {
    return {
      mcpServers,
      chunkMsFor: (scope) => (scope === 'inbox' ? 6 * H : 24 * H),
      firstScanChunkMsFor: (scope) => (scope === 'inbox' ? 24 * H : 7 * 24 * H),
      firstScanDeepChunkMsFor: () => 7 * 24 * H,
      costCapUsd: (_scope, mode) => (mode === 'backfill' || mode === 'head' ? 0.06 : 0.03),
    };
  }
  return { mcpServers, costCapUsd: (scope, mode) => (scope === 'book' || scope === 'missed_opps' ? (mode === 'backfill' ? 0.03 : scope === 'missed_opps' ? 0.25 : 0.15) : mode === 'backfill' || mode === 'head' ? 0.06 : 0.03) };
}

/** The interpreted deterministic sources (the rest keep their agentic skill and its numbers). */
const FTI_DETERMINISTIC = new Set<ConnectorId>(['gmail', 'drive', 'gemini_notes']);

export function ftiDeterministicOverrides(connector: ConnectorId): Partial<DeterministicConnectorSpec> {
  if (!FTI_DETERMINISTIC.has(connector)) return {};
  return { maxItemsPerRun: 100, costCapUsd: (_scope, mode) => (mode === 'incremental' ? 0.02 : 0.05) };
}
