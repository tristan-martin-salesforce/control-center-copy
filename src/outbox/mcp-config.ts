/**
 * The Outbox's OWN MCP config: the write path, kept apart from the scanners (*tenet: Read-only ingest*,
 * CLAUDE.md invariant 2). Only `src/outbox/**` may import this file; a guard test enforces it, and that the
 * scanner allowlists in `src/llm/mcp-config.ts` stay free of write tools. Nothing here is shared with them.
 *
 * The allowlist is tiny and explicit: per channel, one draft tool, one send tool, and the read tools that
 * read-back verification needs. Everything else on those servers is refused before a byte is sent
 * (default deny), so a new or renamed upstream tool never becomes callable by accident.
 *
 * Server declarations are resolved from the user's Claude config with non-secret fields only (type, url,
 * oauth clientId / callbackPort; stdio command, args and an env allowlist). Tokens, cookies and headers are
 * never copied (invariant 3).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DispatchMode } from '@/contract';

import type { OutboxChannel } from './types';

/** Server names as declared in `~/.claude.json` (research 09 §2). */
export const OUTBOX_SERVER: Record<OutboxChannel, string> = {
  /** Slack's hosted MCP (http, OAuth through Claude). */
  slack: 'slack',
  /** devbar's mcp-adaptor (stdio); the read-only devbar bridge the scanners use has no Gmail write tools. */
  gmail: 'mcp-adaptor',
  /** vdp-app-fir (http, PAT + Okta cookie headers): called through src/connectors/vdp/write.ts, never Claude's MCP. */
  vdp: 'vdp-app-fir',
  /** Slack's hosted MCP again, for the logging canvas only (D-47): the relay carries only the canvas tools. */
  slack_canvas: 'slack',
  /**
   * Slack's hosted MCP again, for the feedback report only (D-56): ONE message to the configured team channel. The live
   * relay (src/outbox/transport.ts) carries it only for this channel, only to that channel id, only with a spent confirm.
   */
  feedback: 'slack',
  /**
   * Slack's hosted MCP again, for a release announcement only (D-90, W12-7): ONE message to the configured announcement
   * channel, carried by the release relay only for this channel, only to that id, only with a spent confirm. The
   * `release.drive_upload` hand-off shares the channel but never makes a call (its adapter refuses every one).
   */
  release: 'slack',
};

export interface ChannelTools {
  /** mode → the one write tool that mode may call. */
  write: Record<DispatchMode, string>;
  /**
   * Channels whose payload names its own write (VDP: one item = one op): the write tools an item may pick. The
   * gateway still checks the adapter's call against this list, and the confirm proof binds the exact payload.
   */
  ops?: readonly string[];
  /** Read tools for read-back verification only. */
  read: readonly string[];
}

export const OUTBOX_TOOLS: Readonly<Record<OutboxChannel, ChannelTools>> = Object.freeze({
  slack: Object.freeze({
    write: Object.freeze({ draft: 'slack_send_message_draft', send: 'slack_send_message' }),
    read: Object.freeze(['slack_read_thread']),
  }),
  gmail: Object.freeze({
    write: Object.freeze({ draft: 'draft_gmail_message', send: 'send_gmail_message' }),
    read: Object.freeze(['get_gmail_message_content', 'search_gmail_messages']),
  }),
  // VDP has no drafts: the adapter refuses `draft`, and Apply (`send`) makes the item's one op. D-59 adds create_vdp
  // and, once VDP's server lists them, create_company, add_vdp_asset, set_vdp_owners and generate_use_case. Never
  // delete_*, any other generate_* or stakeholder writes (src/connectors/vdp/tools.ts refuses them again below).
  vdp: Object.freeze({
    write: Object.freeze({ draft: 'update_use_case', send: 'update_use_case' }),
    ops: Object.freeze(['update_use_case', 'create_use_case', 'update_vdp_header', 'create_vdp', 'create_company', 'add_vdp_asset', 'set_vdp_owners', 'generate_use_case']),
    read: Object.freeze(['get_use_case', 'get_vdp', 'get_vdp_assets', 'list_companies']),
  }),
  // A logging batch: Apply creates one new private canvas (both modes). Never slack_update_canvas, never a message.
  slack_canvas: Object.freeze({
    write: Object.freeze({ draft: 'slack_create_canvas', send: 'slack_create_canvas' }),
    read: Object.freeze(['slack_read_canvas']),
  }),
  // A feedback report: Send posts one top-level message (both modes; a report has no Slack draft). No new tool: this
  // is the message channel's own send, kept apart so the live relay can tell a report from any other Slack post.
  feedback: Object.freeze({
    write: Object.freeze({ draft: 'slack_send_message', send: 'slack_send_message' }),
    read: Object.freeze(['slack_read_thread']),
  }),
  // A release announcement (D-90): the same one top-level message as a feedback report, to the announcement channel. No
  // new tool (the allowlist is unchanged); kept apart so the live relay can tell an announcement from any other post.
  release: Object.freeze({
    write: Object.freeze({ draft: 'slack_send_message', send: 'slack_send_message' }),
    read: Object.freeze(['slack_read_thread']),
  }),
});

export const outboxToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

function qualified(kind: 'write' | 'read'): ReadonlySet<string> {
  const out = new Set<string>();
  for (const ch of Object.keys(OUTBOX_TOOLS) as OutboxChannel[]) {
    const t = OUTBOX_TOOLS[ch];
    const names = kind === 'write' ? [...Object.values(t.write), ...(t.ops ?? [])] : t.read;
    for (const n of names) out.add(outboxToolName(OUTBOX_SERVER[ch], n));
  }
  return out;
}

/** Fully qualified (`mcp__<server>__<tool>`) write tools: two per message channel, plus VDP's ops (D-46, D-59). */
export const OUTBOX_WRITE_TOOLS: ReadonlySet<string> = qualified('write');
/** Fully qualified read-back tools. */
export const OUTBOX_READ_TOOLS: ReadonlySet<string> = qualified('read');
/** Everything the outbox may ever call. */
export const OUTBOX_ALLOWLIST: ReadonlySet<string> = new Set([...OUTBOX_WRITE_TOOLS, ...OUTBOX_READ_TOOLS]);

export class OutboxToolRefusedError extends Error {
  override name = 'OutboxToolRefusedError';
  constructor(
    readonly tool: string,
    reason: string,
  ) {
    super(`outbox: refusing ${tool}: ${reason}`);
  }
}

/** Throws unless `server/tool` is on the outbox allowlist for that kind of call. */
export function assertOutboxTool(server: string, tool: string, kind: 'write' | 'read'): void {
  const name = outboxToolName(server, tool);
  const set = kind === 'write' ? OUTBOX_WRITE_TOOLS : OUTBOX_READ_TOOLS;
  if (!set.has(name)) throw new OutboxToolRefusedError(name, `not on the outbox ${kind} allowlist`);
}

/** The write tool for a channel + confirmed mode. */
export function writeToolFor(channel: OutboxChannel, mode: DispatchMode): { server: string; tool: string } {
  return { server: OUTBOX_SERVER[channel], tool: OUTBOX_TOOLS[channel].write[mode] };
}

/** Every write tool a confirmed item of this channel + mode may call: the mode's tool, or one of the channel's ops. */
export function writeToolsFor(channel: OutboxChannel, mode: DispatchMode): { server: string; tools: readonly string[] } {
  const t = OUTBOX_TOOLS[channel];
  return { server: OUTBOX_SERVER[channel], tools: t.ops ?? [t.write[mode]] };
}

/** Agent-style restriction (if a run ever needs it): allow exactly these, deny everything else by default. */
export function outboxAllowedTools(channel: OutboxChannel, mode: DispatchMode): string[] {
  const server = OUTBOX_SERVER[channel];
  return [...writeToolsFor(channel, mode).tools.map((t) => outboxToolName(server, t)), ...OUTBOX_TOOLS[channel].read.map((t) => outboxToolName(server, t))];
}

// ---------------------------------------------------------------------------
// Server declarations (non-secret fields only)
// ---------------------------------------------------------------------------

export interface OutboxHttpDecl {
  type: 'http';
  url: string;
  oauth?: { clientId?: string; callbackPort?: number };
}
export interface OutboxStdioDecl {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}
export type OutboxServerDecl = OutboxHttpDecl | OutboxStdioDecl;

/** Env keys that are configuration, never credentials. Anything else in the declaration is dropped. */
const STDIO_ENV_ALLOW = new Set(['GW_PROFILE', 'MCP_ADAPTOR_ENV']);

export function outboxClaudeConfigPath(): string {
  return process.env.CC_CLAUDE_JSON ?? path.join(os.homedir(), '.claude.json');
}

/** Resolve one outbox server declaration. Errors name the server, never any config value. */
export function resolveOutboxServer(channel: OutboxChannel, configPath = outboxClaudeConfigPath()): OutboxServerDecl {
  const name = OUTBOX_SERVER[channel];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`config: cannot read Claude config for outbox MCP server ${name}`);
  }
  const decl = ((raw as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})[name] as Record<string, unknown> | undefined;
  if (!decl) throw new Error(`config: outbox MCP server ${name} is not declared in the user Claude config`);
  if (decl.type === 'http' && typeof decl.url === 'string') {
    const out: OutboxHttpDecl = { type: 'http', url: decl.url };
    const o = decl.oauth as { clientId?: unknown; callbackPort?: unknown } | undefined;
    if (o && typeof o === 'object') {
      out.oauth = {};
      if (typeof o.clientId === 'string') out.oauth.clientId = o.clientId;
      if (typeof o.callbackPort === 'number') out.oauth.callbackPort = o.callbackPort;
    }
    return out;
  }
  if ((decl.type === 'stdio' || decl.type === undefined) && typeof decl.command === 'string') {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries((decl.env as Record<string, unknown> | undefined) ?? {})) if (STDIO_ENV_ALLOW.has(k) && typeof v === 'string') env[k] = v;
    const args = Array.isArray(decl.args) ? decl.args.filter((a): a is string => typeof a === 'string') : [];
    return { type: 'stdio', command: decl.command, args, env };
  }
  throw new Error(`config: outbox MCP server ${name} has an unsupported declaration`);
}
