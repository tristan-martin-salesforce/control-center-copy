/**
 * Wraps the cc handlers as an in-process MCP server for the Agent SDK (`createSdkMcpServer` + `tool()`).
 * Tool names on the wire are `mcp__cc__<name>`.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@/llm/provider';
import { callCcTool, type CcHandlers, type CcRunState } from './handlers';
import { CC_TOOL_DESCRIPTIONS, CC_TOOL_NAMES, shapes, type CcToolName } from './schemas';

export const CC_SERVER_NAME = 'cc';
export const ccToolFullName = (name: string) => `mcp__${CC_SERVER_NAME}__${name}`;
export const CC_ALLOWED_TOOLS = CC_TOOL_NAMES.map(ccToolFullName);

export function buildCcServer(handlers: CcHandlers, state: CcRunState, names: readonly CcToolName[] = CC_TOOL_NAMES): McpSdkServerConfigWithInstance {
  const tools = names.map((name) =>
    tool(name, CC_TOOL_DESCRIPTIONS[name], shapes[name], async (args: unknown) => {
      const r = await callCcTool(handlers, state, name, args);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }),
  );
  return createSdkMcpServer({ name: CC_SERVER_NAME, version: '1.0.0', tools, alwaysLoad: true, timeout: 30_000 });
}
