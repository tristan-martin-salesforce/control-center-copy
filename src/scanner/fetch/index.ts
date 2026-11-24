/**
 * Fetch by code, one entry per source (FTI): `fetch(scope, window) → raw[]` whatever the transport.
 *
 *   relayed (Slack, Org62)   fixed queries through the `claude_relay` runtime; REC-1 / REC-2 record the raw rows
 *   deterministic (Gmail, Calendar, Drive, Gemini notes, Claude sessions, trainings, VDP)   the existing
 *                            DeterministicFetcher (direct MCP, local files, JSON-RPC); the runtime records its items
 */
import type { ConnectorId, Cursor, CoverageObject, DeterministicFetcher, NormalizedSourceItem, TimeWindow } from '../types';
import { fetchOrg62Scope, ORG62_FTI_SCOPES } from './org62';
import { fetchSlackScope, slackQueries } from './slack';
import type { FetchRequest, ScopeFetchResult } from './types';

export * from './types';
export { fetchSlackScope, slackQueries, slackCursorOf, threadsToOpen, relayRead, SLACK_SEARCH, SLACK_THREAD, SLACK_CHANNEL, type SlackQuery } from './slack';
export { fetchOrg62Scope, org62Queries, soqlPage, ORG62_FTI_SCOPES, ORG62_TOOL, type SoqlQuery } from './org62';

/** Modes the relayed fetch serves; `relink` and other step instructions stay with the agent. */
const FETCH_MODES = new Set(['incremental', 'head', 'backfill', 'continuation', 'retry', 'manual', 'targeted']);

/** Can code fetch this relayed scope (else the agentic skill traverses it)? */
export function relayedFetchSupported(connector: ConnectorId, scope: string, mode: string, me: { slackId?: string; org62UserId?: string }): boolean {
  if (!FETCH_MODES.has(mode)) return false;
  if (connector === 'slack') return !!slackQueries(scope, { from: new Date(0).toISOString(), to: new Date(1000).toISOString() }, { 'channel.label': 'x' }, me.slackId);
  if (connector === 'org62') return ORG62_FTI_SCOPES.has(scope) && !!me.org62UserId;
  return false;
}

/** The relayed fetch of a connector. */
export function relayedFetch(connector: ConnectorId): ((req: FetchRequest) => Promise<ScopeFetchResult>) | null {
  if (connector === 'slack') return fetchSlackScope;
  if (connector === 'org62') return fetchOrg62Scope;
  return null;
}

/** A deterministic source in the same shape: one call, its raw items, coverage and cursor (nothing recorded yet). */
export async function fetchDeterministic(f: DeterministicFetcher, scope: string, window: TimeWindow, o: { cursor: Cursor | null; signal: AbortSignal; limit?: number }): Promise<{ raw: NormalizedSourceItem[]; coverage: CoverageObject[]; cursor: Cursor; complete: boolean }> {
  const r = await f.fetch(scope, o.cursor, window, { signal: o.signal, ...(o.limit ? { limit: o.limit } : {}) });
  return { raw: [...r.items, ...(r.quietItems ?? [])], coverage: r.coverage, cursor: r.nextCursor, complete: r.complete };
}
