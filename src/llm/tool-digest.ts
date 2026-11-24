/**
 * COST-2 (holistic review 2026-11-20, lane 04 §4.6 item 2): what a read tool returned, made compact for the model's
 * context once the runner has recorded the raw result (REC-1 for Slack, REC-2 / the page observer for Org62).
 *
 * Every later request in an Agent SDK run re-reads every earlier tool result, so raw MCP output (Slack's detailed
 * format, pretty-printed SOQL JSON with a URL per row) is paid on every turn and is what pushes Haiku 5.5 past its
 * 100K long-prompt tier. The PostToolUse hook returns the digest as `updatedToolOutput`; the raw result was already
 * recorded, traced and observed by then (the hook awaits the recorders first).
 *
 *   Slack (search, thread, channel reads): one block per message: its ref (`<channelId>:<ts>`, what the agent cites),
 *     UTC time, channel, thread ref, author, DM participants, the full text and the Files / Reactions lines. Dropped:
 *     permalinks, e-mail addresses, the detailed format's labels. The pagination line is kept verbatim.
 *   Org62 (soqlQuery JSON): the same JSON, compact, without each row's `attributes.url` (the type stays). Lossless for
 *     what the skill reads.
 *
 * A digest is returned only when it parses and is smaller than the raw output; otherwise the raw result stands.
 * Never logs or stores content.
 */
import { parseSlackChannel, parseSlackSearch, parseSlackThread, unwrapToolOutput, type ParsedSlackMessage } from '../connectors/slack/parse';

/** Bare MCP tool name (`mcp__slack__slack_read_thread` → `slack_read_thread`). */
const bare = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');

/** Slack read tools whose results REC-1 records (src/llm/slack-rec.ts SLACK_REC_TOOLS). */
const SLACK_DIGEST_TOOLS = new Set(['slack_search_public_and_private', 'slack_search_public', 'slack_read_thread', 'slack_read_channel']);
/**
 * R6 / SCN-9: the most characters of one message the scanner keeps, shared by the stored excerpt (normalizeItem) and
 * the digest the model reads, so an ask the record keeps is never cut from what the model sees (W0-5). The prompt
 * guard meters the total size.
 */
export const EXCERPT_MAX_CHARS = 4_000;
const MAX_TEXT = EXCERPT_MAX_CHARS;

export interface ToolDigest {
  /** The replacement, in the same wrapper shape as the tool's own output. */
  output: unknown;
  /** Characters of the raw output and of the digest (for the trace and the prompt guard). */
  rawChars: number;
  chars: number;
  kind: 'slack' | 'soql';
  /** Messages / rows in the digest. */
  items: number;
}

/** The text of a tool result, whatever wrapper it arrives in. */
export function toolOutputText(r: unknown): string {
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : typeof b === 'string' ? b : '')).join('\n');
  if (r && typeof r === 'object') {
    const c = (r as { content?: unknown }).content;
    if (Array.isArray(c)) return toolOutputText(c);
    return JSON.stringify(r) ?? '';
  }
  return '';
}

/** `text` in the wrapper `like` came in: a string, content blocks, or `{content: blocks}`. Null for other shapes. */
function wrapLike(like: unknown, text: string): unknown {
  if (typeof like === 'string') return text;
  if (Array.isArray(like)) return [{ type: 'text', text }];
  if (like && typeof like === 'object' && Array.isArray((like as { content?: unknown }).content)) return { ...(like as object), content: [{ type: 'text', text }] };
  return null;
}

const utc = (ts: string) => {
  const s = Number(ts.split('.')[0]);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '';
};

function messageBlock(m: ParsedSlackMessage, me: string | undefined): string {
  const channel = m.channelType === 'im' ? 'DM' : m.channelType === 'mpim' ? 'group DM' : m.channelName ? `#${m.channelName}` : 'channel';
  const who = m.authorName || m.authorId ? `${m.authorName ?? ''}${m.authorId ? ` (${m.authorId})` : ''}`.trim() : 'unknown';
  const head = [`${m.channelId}:${m.ts}`, utc(m.ts), `${channel} (${m.channelId})`, m.threadTs && m.threadTs !== m.ts ? `reply in thread ${m.channelId}:${m.threadTs}` : '', `from ${who}${me && m.authorId === me ? ' [me]' : ''}`]
    .filter(Boolean)
    .join(' · ');
  const lines = [`- ${head}`];
  if (m.participants?.length && (m.channelType === 'im' || m.channelType === 'mpim')) lines.push(`  with: ${m.participants.map((p) => `${p.name ?? ''} (${p.externalId})`.trim()).join(', ')}`);
  const text = m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT)} …(cut)` : m.text;
  for (const l of text.split('\n')) lines.push(`  ${l}`);
  for (const x of m.extra ?? []) lines.push(`  ${x}`);
  return lines.join('\n');
}

/** Slack: the digest of a recorded search / thread / channel read, or null when the output did not parse. */
export function slackDigest(toolName: string, toolInput: unknown, toolResponse: unknown, o: { me?: string } = {}): ToolDigest | null {
  const tool = bare(toolName);
  if (!SLACK_DIGEST_TOOLS.has(tool)) return null;
  const raw = toolOutputText(toolResponse);
  if (!raw) return null;
  const args = (toolInput ?? {}) as Record<string, unknown>;
  let msgs: ParsedSlackMessage[];
  if (tool === 'slack_read_thread') msgs = parseSlackThread(toolResponse, String(args.channel_id ?? ''), args.message_ts ? String(args.message_ts) : undefined).messages;
  else if (tool === 'slack_read_channel') msgs = parseSlackChannel(toolResponse, String(args.channel_id ?? '')).messages;
  else msgs = parseSlackSearch(toolResponse).messages;
  msgs = msgs.filter((m) => m.channelId && m.ts);
  if (!msgs.length) return null;
  const pagination = String(unwrapToolOutput(toolResponse).pagination_info ?? '').trim();
  const text = [
    `[Digest of ${tool}: ${msgs.length} message(s). The app recorded every one; cite each by its ref <channelId>:<ts>.]`,
    ...(pagination ? [`pagination: ${pagination}`] : []),
    ...msgs.map((m) => messageBlock(m, o.me)),
  ].join('\n');
  if (text.length >= raw.length) return null;
  const output = wrapLike(toolResponse, text);
  return output === null ? null : { output, rawChars: raw.length, chars: text.length, kind: 'slack', items: msgs.length };
}

function dropAttributeUrls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropAttributeUrls);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'attributes' && x && typeof x === 'object' && !Array.isArray(x)) {
      const { url: _url, ...rest } = x as Record<string, unknown>;
      out[k] = rest;
    } else out[k] = dropAttributeUrls(x);
  }
  return out;
}

/** Org62: a SOQL result as compact JSON without per-row `attributes.url`, or null when it is not a SOQL result. */
export function soqlDigest(toolName: string, toolResponse: unknown): ToolDigest | null {
  if (bare(toolName) !== 'soqlQuery') return null;
  const raw = toolOutputText(toolResponse);
  const t = raw.trim();
  if (!t.startsWith('{')) return null;
  let j: { records?: unknown };
  try {
    j = JSON.parse(t) as { records?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(j.records)) return null;
  const text = JSON.stringify(dropAttributeUrls(j));
  if (text.length >= raw.length) return null;
  const output = wrapLike(toolResponse, text);
  return output === null ? null : { output, rawChars: raw.length, chars: text.length, kind: 'soql', items: j.records.length };
}

/** The digest for one tool result: Slack only when REC-1 recorded it (`slackRecorded`), SOQL always (lossless). */
export function digestToolOutput(toolName: string, toolInput: unknown, toolResponse: unknown, o: { slackRecorded: boolean; me?: string }): ToolDigest | null {
  try {
    if (o.slackRecorded) {
      const d = slackDigest(toolName, toolInput, toolResponse, { me: o.me });
      if (d) return d;
    }
    return soqlDigest(toolName, toolResponse);
  } catch {
    return null;
  }
}
