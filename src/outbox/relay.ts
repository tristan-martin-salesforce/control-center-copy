/**
 * The live relay for the logging canvas (D-47): Slack's hosted MCP is OAuth through Claude, so a canvas call runs as
 * ONE relayed tool call (src/llm/one-call.ts) with only the Slack server loaded and only that tool allowed. It is
 * reached only through the Outbox gateway (allowlist + the user's single-use confirm proof), after Apply on that
 * item, with global dry-run off. It carries `slack_create_canvas` and `slack_read_canvas` and nothing else: a message
 * send can never go through it.
 */
import type { McpServerConfig } from '@/llm/provider';

import { SLACK_ALL_TOOLS } from '@/llm/mcp-config';
import { runOneToolCall, type OneCallInput } from '@/llm/one-call';
import { loadSkill } from '@/llm/skill-loader';

import { relayFailure, ToolCallError } from './errors';
import type { OutboxTransport } from './gateway';
import { OUTBOX_SERVER, OUTBOX_TOOLS, outboxToolName, resolveOutboxServer } from './mcp-config';
import type { ToolCall, ToolResult } from './types';

export const RELAY_SKILL = 'skills/outbox-relay.md';
/** The only tools the canvas relay may call. */
export const CANVAS_RELAY_TOOLS: ReadonlySet<string> = new Set([OUTBOX_TOOLS.slack_canvas.write.send, ...OUTBOX_TOOLS.slack_canvas.read]);

export interface CanvasRelayOptions {
  /** Tests: a fake one-call runner. */
  run?: (c: OneCallInput) => ReturnType<typeof runOneToolCall>;
  /** Tests: the server declaration (default: ~/.claude.json, non-secret fields only). */
  server?: () => Record<string, unknown>;
}

export function slackCanvasRelay(o: CanvasRelayOptions = {}): OutboxTransport {
  return {
    async callTool(call: ToolCall): Promise<ToolResult> {
      const server = OUTBOX_SERVER.slack_canvas;
      if (call.server !== server || !CANVAS_RELAY_TOOLS.has(call.tool)) throw new ToolCallError(call.tool, `the canvas relay carries ${[...CANVAS_RELAY_TOOLS].join(' and ')} only`);
      const full = outboxToolName(server, call.tool);
      let servers: Record<string, unknown>;
      try {
        servers = o.server ? o.server() : { [server]: resolveOutboxServer('slack_canvas') as unknown as McpServerConfig };
      } catch {
        throw new ToolCallError(call.tool, 'Slack is not set up in Claude Code (no slack MCP server in ~/.claude.json)');
      }
      const r = await (o.run ?? runOneToolCall)({
        servers,
        fullTool: full,
        args: call.args,
        allowedTools: [full],
        disallowedTools: SLACK_ALL_TOOLS.filter((t) => t !== call.tool).map((t) => outboxToolName(server, t)),
        skill: loadSkill(RELAY_SKILL),
        timeoutMs: 90_000,
      });
      if (r.text === null) throw relayFailure(call.tool, r);
      return { text: r.text };
    },
  };
}
