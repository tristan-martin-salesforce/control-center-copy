/**
 * The chat tools as an in-process MCP server for the Agent SDK (`createSdkMcpServer` + `tool()`).
 * Wire names are `mcp__chat__<name>`. One server per turn: handlers close over the turn's context.
 *
 * D-55 / Assistant v2: the eleven tools are the same for every persona; what a persona has not activated is left out
 * of their catalogs (the views, read pages and routes listed in the descriptions follow the persona's gates), so each
 * persona has one stable, byte-identical tool prefix from turn to turn (prompt cache).
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@/llm/provider';
import type { ResolvedPersona } from '@/personas';

import { callChatTool, CHAT_SERVER_NAME, CHAT_TOOLS, chatToolFullName, describeTool, type AnyChatToolDef, type ChatToolCtx } from './tools';

/**
 * How long the SDK waits for one chat tool call: a `plan` waits for the user's answer and a `run research` reads for
 * minutes, so the bound is the ask's wait plus the longest run (the turn's no-progress watchdog still applies).
 */
export const CHAT_TOOL_TIMEOUT_MS = 30 * 60_000;

/** A tool as the turn serves it: its description resolved for the persona. */
export type ServedTool = Omit<AnyChatToolDef, 'description'> & { description: string };

/** The tools (with their wire descriptions and shapes) this persona's Assistant gets, in CHAT_TOOLS order. */
export function chatToolsFor(persona?: ResolvedPersona | null): ServedTool[] {
  // D-55 / Assistant v2: the same eleven tools for every persona; the persona shapes the descriptions, not the list
  // (the VDP views, read pages and routes they mention follow READ_PAGE_GATES / ROUTE_GATES in src/server/chat/views.ts).
  return (CHAT_TOOLS as readonly AnyChatToolDef[]).map((t) => ({ ...t, description: describeTool(t, persona) }));
}

/** The allowlist entries (`mcp__chat__<name>`) of the persona's tools. */
export const chatAllowedToolsFor = (persona?: ResolvedPersona | null) => chatToolsFor(persona).map((t) => chatToolFullName(t.name));

export function buildChatMcpServer(ctx: ChatToolCtx, persona?: ResolvedPersona | null): McpSdkServerConfigWithInstance {
  const tools = chatToolsFor(persona).map((t) =>
    tool(t.name, t.description, t.shape, async (args: unknown) => {
      const r = await callChatTool(ctx, t.name, args);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
    }),
  );
  return createSdkMcpServer({ name: CHAT_SERVER_NAME, version: '2.0.0', tools, alwaysLoad: true, timeout: CHAT_TOOL_TIMEOUT_MS });
}
