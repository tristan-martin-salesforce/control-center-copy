/**
 * VDP: vdp-app-fir over direct JSON-RPC (`http_jsonrpc`; decision D1 (a) in 08: the PAT and Okta cookie are read from
 * the Claude config per call, in memory only, never stored or logged). VDP is a domain system as well as a source
 * (use cases, assets, DC notes): only the read mirror's transport lives here; writes are the Outbox's (write.ts).
 */
import type { ConnectorManifest } from '../runtime/types';

import { VDP_REFRESH_COMMAND, VdpClient } from './client';
import { parseGetUseCase, parseGetVdp, parseSearchResult } from './parse';
import { VDP_READ_TOOLS, VDP_SERVER_NAME } from './tools';

const MIN = 60_000;
const H = 60 * MIN;

/** `VdpErrorCode` (src/connectors/vdp/http.ts). */
export const VDP_FAILURE_CODES = ['not_configured', 'pat_missing', 'cookie_missing', 'cookie_expired', 'sso_redirect', 'sso_html', 'http_401', 'rate_limited', 'server_error', 'http_error', 'network', 'timeout', 'bad_response', 'rpc_error', 'tool_error'] as const;

export const vdpManifest: ConnectorManifest = {
  id: 'vdp',
  label: 'VDP',
  runtime: 'http_jsonrpc',
  server: VDP_SERVER_NAME,
  scopes: ['mine'],
  auth: { kind: 'pat_cookie', check: 'cookie_exp', reauthHint: { handler: 'vdp', kind: 'refresh_script', hint: VDP_REFRESH_COMMAND } },
  readTools: VDP_READ_TOOLS,
  // current state: a new scope starts 30 min back; history windows make no call
  windows: { default: 30 * MIN, max: 14 * 24 * H },
  cadence: { baseMs: 30 * MIN },
  // record-only: no skill agent run
  estimate: { usdPerDay: 0 },
  // the config alone (configured, PAT present, cookie lifetime): no network, never a value
  healthCheck: async () => new VdpClient().health(),
  parse: { search: parseSearchResult, vdp: parseGetVdp, useCase: parseGetUseCase },
  failureCodes: VDP_FAILURE_CODES,
  scan: { mode: 'deterministic', skill: 'scan-vdp', chunkMs: 31 * 24 * H, firstScanChunkMs: 31 * 24 * H, maxItemsPerRun: 500, readsCurrentState: true, persistAuthPause: true },
};
