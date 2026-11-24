/**
 * Who you are on Slack and in Org62, for the Sources step (B-079): one read-only lookup each, run only when the
 * source is connected, on the cheapest tier (skills/detect-identity.md, Haiku).
 *
 *   org62  soqlQuery: SELECT Id, Name, Email FROM User WHERE Email = '<your email>' AND IsActive = true LIMIT 2
 *          → found only when exactly one row comes back
 *   slack  slack_search_public_and_private: `from:me`, newest first
 *          → found only when every message has one and the same author id, and the author email (when shown) is yours
 *
 * The same gate as the scanners (src/llm/mcp-config.ts, not widened): the tool must be on the connector's scan
 * allowlist, the run loads only that MCP server (`strictMcpConfig`, `tools: []`), everything else is disallowed,
 * `permissionMode: 'dontAsk'`, and a PreToolUse hook allows the one tool with OUR arguments (`updatedInput`) and
 * aborts on anything else. The id is parsed from the tool's own output (PostToolUse), never from the model's words.
 * Spend comes from the result message (or the per-message estimate) and is returned for the ledger.
 */
import type { DetectionSpend, IdentityDetection, IdentityKind } from '@/contract';
import { connectorLabel } from '@/connectors/registry';
import { parseSlackSearchResults, unwrapSearchOutput } from '@/engines/voice/slack-search-parse';
import type { GatewayConfig } from '@/llm/claude-env';
import { mcpToolName, ORG62_SCAN_TOOLS, restrictedTools, SLACK_SCAN_TOOLS, traversalMcpServers } from '@/llm/mcp-config';
import { SCANNER_MODEL } from '@/llm/models';
import { runOneToolCall } from '@/llm/one-call';
import { loadSkill } from '@/llm/skill-loader';
import type { QueryFn } from '@/llm/skill-runner';

export const IDENTITY_SKILL = 'skills/detect-identity.md';
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** The one tool and the exact arguments of each lookup. */
export function lookupFor(kind: IdentityKind, email: string): { connector: 'slack' | 'org62'; tool: string; args: Record<string, unknown> } {
  if (kind === 'org62') {
    if (!EMAIL.test(email)) throw new Error('config: not a plain email address');
    const q = `SELECT Id, Name, Email FROM User WHERE Email = '${email}' AND IsActive = true LIMIT 2`;
    return { connector: 'org62', tool: 'soqlQuery', args: { q } };
  }
  return { connector: 'slack', tool: 'slack_search_public_and_private', args: { filters: 'from:me', response_format: 'detailed', include_context: false, sort: 'timestamp', sort_dir: 'desc', limit: 5 } };
}

/** The text of an MCP tool result (shared with the Outbox relay). */
export { toolText } from '@/llm/one-call';

type Parsed = Pick<IdentityDetection, 'status' | 'id' | 'name' | 'message'>;

/** Org62: exactly one active User row with this email. */
export function parseOrg62User(raw: string, email: string): Parsed {
  let body: { records?: Array<{ Id?: unknown; Name?: unknown; Email?: unknown }> };
  try {
    const t = raw.trim();
    body = JSON.parse(t.slice(t.indexOf('{'))) as typeof body;
  } catch {
    return { status: 'failed', id: null, name: null, message: 'Org62 answered in a way we could not read.' };
  }
  const rows = (body.records ?? []).filter((r) => typeof r.Id === 'string' && /^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(r.Id) && (typeof r.Email !== 'string' || r.Email.toLowerCase() === email.toLowerCase()));
  if (rows.length === 0) return { status: 'not_found', id: null, name: null, message: 'No active Org62 user has your email.' };
  if (rows.length > 1) return { status: 'ambiguous', id: null, name: null, message: 'More than one Org62 user has your email.' };
  const r = rows[0]!;
  return { status: 'found', id: r.Id as string, name: typeof r.Name === 'string' ? r.Name : null, message: 'Found in Org62.' };
}

/** Slack: the one author of your own recent messages (and, where Slack shows it, your email). */
export function parseSlackSelf(raw: string, email: string): Parsed {
  const msgs = parseSlackSearchResults(raw);
  const md = unwrapSearchOutput(raw);
  const froms = [...md.matchAll(/^From:\s*(.*?)\s*(?:<([^>]*)>)?\s*\(ID:\s*([A-Z0-9]+)\)/gm)].map((m) => ({ name: (m[1] ?? '').trim(), email: (m[2] ?? '').trim().toLowerCase(), id: m[3]! }));
  const ids = new Set([...msgs.map((m) => m.authorId).filter(Boolean), ...froms.map((f) => f.id)]);
  if (!msgs.length && !froms.length) return { status: 'not_found', id: null, name: null, message: 'No recent Slack messages from you to read your ID from.' };
  if (ids.size !== 1) return { status: 'ambiguous', id: null, name: null, message: 'Your recent messages show more than one author.' };
  const emails = new Set(froms.map((f) => f.email).filter(Boolean));
  if (emails.size > 1 || (emails.size === 1 && !emails.has(email.toLowerCase()))) return { status: 'ambiguous', id: null, name: null, message: 'The Slack account found uses another email.' };
  const id = [...ids][0] as string;
  if (!/^[UW][A-Z0-9]{6,}$/.test(id)) return { status: 'failed', id: null, name: null, message: 'Slack answered in a way we could not read.' };
  const name = froms.find((f) => f.name)?.name ?? null;
  return { status: 'found', id, name, message: 'Found in Slack.' };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface IdentityDetector {
  readonly mode: 'live' | 'simulated';
  detect(kind: IdentityKind, ctx: { email: string; name?: string | null }): Promise<{ detection: IdentityDetection; spend: DetectionSpend | null }>;
}

export interface LiveDetectorOptions {
  queryFn?: QueryFn;
  gateway?: GatewayConfig;
  /** MCP server declarations (default: the user's ~/.claude.json, non-secret fields only). */
  mcpServersFor?: (connector: 'slack' | 'org62') => Record<string, unknown>;
  timeoutMs?: number;
  now?: () => Date;
  repoRoot?: string;
}

const SCAN_TOOLS = { slack: SLACK_SCAN_TOOLS as readonly string[], org62: ORG62_SCAN_TOOLS as readonly string[] };

export class LiveIdentityDetector implements IdentityDetector {
  readonly mode = 'live' as const;
  constructor(private readonly o: LiveDetectorOptions = {}) {}

  async detect(kind: IdentityKind, ctx: { email: string }): Promise<{ detection: IdentityDetection; spend: DetectionSpend | null }> {
    const now = this.o.now ?? (() => new Date());
    const startedAt = now();
    const done = (p: Parsed, costUsd: number): IdentityDetection => ({ ...p, at: now().toISOString(), costUsd: Math.round(costUsd * 1e6) / 1e6, simulated: false });
    let look: ReturnType<typeof lookupFor>;
    try {
      look = lookupFor(kind, ctx.email);
    } catch {
      return { detection: done({ status: 'failed', id: null, name: null, message: 'Enter your work email in step 1 first.' }, 0), spend: null };
    }
    // the scanners' read-only allowlist, not widened
    if (!SCAN_TOOLS[look.connector].includes(look.tool)) throw new Error(`refusing ${look.tool}: not on the ${look.connector} scan allowlist`);
    const r = await this.run(look);
    const ms = Math.max(0, now().getTime() - startedAt.getTime());
    const spend: DetectionSpend = { kind, model: r.model, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, status: r.code === 'timeout' ? 'timeout' : r.text === null ? 'error' : 'ok', errorCode: r.text === null ? r.code : null, startedAt: startedAt.toISOString(), ms };
    if (r.text === null) return { detection: done({ status: 'failed', id: null, name: null, message: r.message }, r.costUsd), spend: r.costUsd > 0 || r.started ? spend : null };
    const parsed = kind === 'org62' ? parseOrg62User(r.text, ctx.email) : parseSlackSelf(r.text, ctx.email);
    return { detection: done(parsed, r.costUsd), spend };
  }

  private run(look: ReturnType<typeof lookupFor>) {
    return runOneReadLookup(look, this.o);
  }
}

export interface OneLookupResult {
  /** The tool's own output (null when the call did not happen or failed). */
  text: string | null;
  code: string;
  message: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string;
  started: boolean;
}

/**
 * ONE read-only MCP call with OUR arguments, through a minimal Agent SDK run (the model only relays the call): the
 * tool must be on the connector's scan allowlist (src/llm/mcp-config.ts, not widened), only that server loads, a
 * PreToolUse hook swaps in our arguments and stops anything else, and the output is read from the tool result, never
 * from the model's words. Used by the identity check and the chat's Org62 lookup (src/server/chat/org62.ts).
 */
export async function runOneReadLookup(look: { connector: 'slack' | 'org62'; tool: string; args: Record<string, unknown> }, o: LiveDetectorOptions & { skillPath?: string } = {}): Promise<OneLookupResult> {
  if (!SCAN_TOOLS[look.connector].includes(look.tool)) throw new Error(`refusing ${look.tool}: not on the ${look.connector} scan allowlist`);
  const skill = loadSkill(o.skillPath ?? IDENTITY_SKILL, o.repoRoot);
  const model = typeof skill.frontmatter.model === 'string' ? skill.frontmatter.model : SCANNER_MODEL;
  let servers: Record<string, unknown>;
  let gate: ReturnType<typeof restrictedTools>;
  try {
    gate = restrictedTools(look.connector, [look.tool]);
    servers = (o.mcpServersFor ?? traversalMcpServers)(look.connector);
  } catch {
    return { text: null, costUsd: 0, inputTokens: 0, outputTokens: 0, model, started: false, code: 'config', message: `${connectorLabel(look.connector)} is not set up in Claude Code.` };
  }
  return runOneToolCall({ servers, fullTool: mcpToolName(gate.serverName, look.tool), args: look.args, allowedTools: gate.allowedTools, disallowedTools: gate.disallowedTools, skill, ...(o.queryFn ? { queryFn: o.queryFn } : {}), ...(o.gateway ? { gateway: o.gateway } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
}

// ---------------------------------------------------------------------------
// Mock mode: placeholders, no calls
// ---------------------------------------------------------------------------

export const MOCK_IDENTITIES: Record<IdentityKind, string> = { slack: 'U0MOCKME01', org62: '005XX0000000MOCKAA' };

export function simulatedDetector(now: () => Date = () => new Date()): IdentityDetector {
  return {
    mode: 'simulated',
    async detect(kind, ctx) {
      return {
        detection: { status: 'found', id: MOCK_IDENTITIES[kind], name: ctx.name?.trim() || null, message: 'Mock mode: a placeholder id, nothing was looked up.', at: now().toISOString(), costUsd: 0, simulated: true },
        spend: null,
      };
    },
  };
}
