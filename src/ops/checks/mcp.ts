/**
 * Slack and Org62 in Claude Code (`claude mcp list`, names and states only): declared and signed in. A server that
 * is not declared needs `claude mcp add` first, not a login (CONN-8: MCP.SERVER_NOT_DECLARED); a signed-out one is
 * AUTH.SLACK.SIGNED_OUT / AUTH.ORG62.SIGNED_OUT. Per-server states and codes are in `data` for Health ▸ Setup.
 */
import { findServer, listMcp, ORG62_SERVER, SLACK_SERVER, type McpServerStatus } from '../mcp';
import type { DependencyState } from '../../reauth/types';
import { bad, ok, type Check, type CheckResult, type CheckStatus } from './types';

export const checkMcp: Check = async (c) => {
  const { ok: listed, servers, missing } = await listMcp(c.exec, c.claudeBin);
  if (missing) return bad('skip', 'mcp', 'MCP servers (Slack, Org62)', 'Claude Code is not installed (see the claude CLI line)', undefined, { servers: { [SLACK_SERVER]: 'missing', [ORG62_SERVER]: 'missing' } }, { code: 'DEP.CLAUDE.MISSING', state: 'missing' });
  if (!listed) return bad('skip', 'mcp', 'MCP servers (Slack, Org62)', 'could not run "claude mcp list"', 'check the claude CLI', undefined, { state: 'unknown' });
  return summarizeMcp(servers);
};

export interface McpServerSetup {
  state: DependencyState;
  code?: string;
}

export function summarizeMcp(servers: McpServerStatus[]): CheckResult {
  const want = [
    { name: SLACK_SERVER, label: 'Slack', login: `claude mcp login ${SLACK_SERVER}`, signedOut: 'AUTH.SLACK.SIGNED_OUT' },
    { name: ORG62_SERVER, label: 'Org62', login: `claude mcp login ${ORG62_SERVER}`, signedOut: 'AUTH.ORG62.SIGNED_OUT' },
  ];
  const parts: string[] = [];
  const fixes: string[] = [];
  const setup: Record<string, McpServerSetup> = {};
  let worst: CheckStatus = 'ok';
  let code: string | undefined;
  for (const w of want) {
    const s = findServer(servers, w.name);
    if (!s) {
      parts.push(`${w.label}: not configured`);
      fixes.push(`add the ${w.name} MCP server in Claude Code (claude mcp add --transport http ${w.name} <server URL>), then ${w.login}`);
      worst = 'fail';
      setup[w.name] = { state: 'missing', code: 'MCP.SERVER_NOT_DECLARED' };
      code ??= 'MCP.SERVER_NOT_DECLARED';
    } else if (s.state === 'connected') {
      parts.push(`${w.label}: connected`);
      setup[w.name] = { state: 'ok' };
    } else if (s.state === 'needs_auth') {
      parts.push(`${w.label}: needs auth`);
      fixes.push(w.login);
      if (worst !== 'fail') worst = 'warn';
      setup[w.name] = { state: 'signed_out', code: w.signedOut };
      code ??= w.signedOut;
    } else {
      parts.push(`${w.label}: ${s.state}`);
      fixes.push(`${w.label}: check network, then retry`);
      if (worst !== 'fail') worst = 'warn';
      setup[w.name] = { state: s.state === 'failed' ? 'offline' : 'unknown', ...(s.state === 'failed' ? { code: 'NET.SERVICE_DOWN' } : {}) };
      if (s.state === 'failed') code ??= 'NET.SERVICE_DOWN';
    }
  }
  const data = { servers: Object.fromEntries(want.map((w) => [w.name, findServer(servers, w.name)?.state ?? 'missing'])), setup };
  return worst === 'ok'
    ? ok('mcp', 'MCP servers (Slack, Org62)', parts.join(', '), data)
    : bad(worst, 'mcp', 'MCP servers (Slack, Org62)', parts.join(', '), fixes.join('; '), data, { code });
}
