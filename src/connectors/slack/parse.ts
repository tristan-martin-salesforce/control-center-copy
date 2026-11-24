/**
 * Parse the Slack MCP read tools' text output into messages (REC-1: the runner records every message the
 * traversal reads, deterministically, instead of relying on the agent's `cc_record_source_items` calls).
 *
 * Formats (the real tool, mirrored by the stress replay):
 *  - `slack_search_public_and_private` (detailed): `{"results": "...", "pagination_info": "..."}` whose results are
 *      ### Result 3 of 20
 *      Channel: DM (ID: D0…) | Group DM (ID: C0…) | #channel-name (ID: C0…)
 *      Participants: Name (ID: U…), …        (DMs and group DMs)
 *      From: Name <email> (ID: U…)
 *      Time: 2026-11-05 08:28:56 MST
 *      Message_ts: 1793892536.322889
 *      Permalink: [link](https://…?thread_ts=…&cid=…)
 *      Text: …message, possibly multi-line…
 *      ---
 *  - `slack_read_thread` (detailed): `=== THREAD PARENT MESSAGE ===` / `=== THREAD REPLIES (n total) ===` /
 *    `--- Reply i of n ---` sections of `From: Name <email> (U…)`, `Time: …`, `Message TS: …`, text, extras.
 *    The concise format carries no ts, so the runner asks for the detailed one.
 *  - `slack_read_channel` (detailed): `=== Message from Name <email> (U…) at TIME ===` + `Message TS: …` + text.
 * Nothing here logs or keeps text beyond the returned objects; redaction happens when items are normalized.
 *
 * Drift (08 CONN-9, R5): tool text that carries the format's own markers (a "### Result n of m" block, a thread
 * parent, a "=== Message from" line) but parses to zero messages throws `ParseDrift`: Slack changed its format, and
 * recording nothing while the run "succeeds" would silently drop recall. Text without the markers (no results, an
 * error message) is not drift. The recorder counts it, and the runner fails the run as DATA.PARSE_DRIFT, which pauses
 * the scope with "the format changed; report it".
 */
import { ParseDrift } from '../../errors/drift';

export { ParseDrift } from '../../errors/drift';

export type SlackChannelType = 'im' | 'mpim' | 'channel';

export interface ParsedSlackMessage {
  channelId: string;
  channelType?: SlackChannelType;
  /** Bare channel name for `#name` channels. */
  channelName?: string;
  participants?: Array<{ name?: string; externalId: string }>;
  authorId?: string;
  authorName?: string;
  authorEmail?: string;
  ts: string;
  /** Thread root ts when this message is a reply (from the permalink or the thread read). */
  threadTs?: string;
  permalink?: string;
  text: string;
  /** `Files:` / `Reactions:` lines of detailed thread reads. */
  extra?: string[];
}

/** MCP tool output (string, `[{type:'text',text}]`, `{content:[…]}`) → its JSON body, or `{text}` when not JSON. */
export function unwrapToolOutput(raw: unknown): Record<string, unknown> {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) text = raw.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  else if (raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)) return unwrapToolOutput((raw as { content: unknown[] }).content);
  else if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  else return {};
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return { text };
}

const PERMA_THREAD = /[?&]thread_ts=(\d+\.\d+)/;

function channelOf(line: string | undefined): { channelId?: string; channelType?: SlackChannelType; channelName?: string } {
  const m = /^(.*?)\s*\(ID:\s*([A-Z0-9]+)\)\s*$/.exec((line ?? '').trim());
  if (!m) return {};
  const label = m[1]!.trim();
  const channelId = m[2]!;
  if (/^Group DM$/i.test(label)) return { channelId, channelType: 'mpim' };
  if (/^(DM|Direct Message)$/i.test(label)) return { channelId, channelType: 'im' };
  return { channelId, channelType: channelId.startsWith('D') ? 'im' : 'channel', channelName: label.replace(/^#/, '') || undefined };
}

function participantsOf(line: string | undefined): ParsedSlackMessage['participants'] {
  if (!line) return undefined;
  const out: NonNullable<ParsedSlackMessage['participants']> = [];
  for (const m of line.matchAll(/([^,()]*?)\s*\(ID:\s*([A-Z0-9]+)\)/g)) out.push({ name: m[1]!.trim() || undefined, externalId: m[2]! });
  return out.length ? out : undefined;
}

/** `Name <email> (ID: U…)` or `Name <email> (U…)`. */
function authorOf(from: string | undefined): { authorId?: string; authorName?: string; authorEmail?: string } {
  const m = /^(.*?)\s*(?:<([^>]*)>)?\s*\((?:ID:\s*)?([A-Z0-9]+)\)\s*$/.exec((from ?? '').trim());
  if (!m) return {};
  return { authorId: m[3], authorName: m[1]!.trim() || undefined, authorEmail: m[2] || undefined };
}

export function parseSlackSearch(raw: unknown): { messages: ParsedSlackMessage[]; cursor?: string } {
  const body = unwrapToolOutput(raw);
  const results = String(body.results ?? body.text ?? '');
  const cursor = String(body.pagination_info ?? '').match(/cursor `([^`]+)`/)?.[1];
  const out: ParsedSlackMessage[] = [];
  for (const block of results.split(/^### Result \d+ of \d+\s*$/m).slice(1)) {
    const b = block.replace(/\n\s*---\s*(\n[\s\S]*)?$/, '');
    const line = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(b)?.[1]?.trim();
    const ch = channelOf(line('Channel'));
    const ts = line('Message_ts');
    if (!ch.channelId || !ts || !/^\d+\.\d+$/.test(ts)) continue;
    const permalink = /\((https?:[^)\s]+)\)/.exec(line('Permalink') ?? '')?.[1]?.replace(/\\\//g, '/');
    const textAt = b.search(/^Text:/m);
    const text = textAt >= 0 ? b.slice(textAt + 5).replace(/^[ \t]*\n?/, '').replace(/\s+$/, '') : '';
    out.push({
      ...ch,
      channelId: ch.channelId,
      participants: participantsOf(line('Participants')),
      ...authorOf(line('From')),
      ts,
      permalink,
      threadTs: permalink ? PERMA_THREAD.exec(permalink)?.[1] : undefined,
      text,
    });
  }
  if (!out.length && /^### Result [1-9]\d* of [1-9]\d*\s*$/m.test(results)) throw new ParseDrift('slack.search', 'result blocks present but none parsed');
  return { messages: out, cursor };
}

function parseThreadChunk(chunk: string, channelId: string): ParsedSlackMessage | undefined {
  const lines = chunk.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i]!.startsWith('From: ')) i++;
  if (i >= lines.length) return undefined;
  const ts = lines[i + 2]?.match(/^Message TS: (\d+\.\d+)/)?.[1];
  if (!ts) return undefined;
  const rest = lines.slice(i + 3);
  const extra: string[] = [];
  while (rest.length && (!rest[rest.length - 1]!.trim() || /^(Reactions|Files|Replies): /.test(rest[rest.length - 1]!.trim()))) {
    const l = rest.pop()!.trim();
    if (l) extra.unshift(l);
  }
  return { channelId, ...authorOf(lines[i]!.slice(6)), ts, text: rest.join('\n').trim(), ...(extra.length ? { extra } : {}) };
}

/** Detailed `slack_read_thread` output → parent + replies (replies carry `threadTs` = the parent's ts). */
export function parseSlackThread(raw: unknown, channelId: string, requestedTs?: string): { messages: ParsedSlackMessage[]; cursor?: string } {
  const body = unwrapToolOutput(raw);
  const text = String(body.messages ?? body.results ?? body.text ?? '');
  const cursor = String(body.pagination_info ?? '').match(/cursor: `([^`]+)`/)?.[1];
  const [parentPart = '', repliesPart = ''] = text.split(/^=== THREAD REPLIES.*===\s*$/m);
  const at = parentPart.indexOf('=== THREAD PARENT MESSAGE ===');
  const parent = at >= 0 ? parseThreadChunk(parentPart.slice(at), channelId) : undefined;
  const root = parent?.ts ?? requestedTs;
  const replies = repliesPart
    .split(/^--- Reply \d+ of \d+ ---\s*$/m)
    .slice(1)
    .map((c) => parseThreadChunk(c, channelId))
    .filter((m): m is ParsedSlackMessage => !!m)
    .map((m) => ({ ...m, ...(root && m.ts !== root ? { threadTs: root } : {}) }));
  if (!parent && !replies.length && /=== THREAD PARENT MESSAGE ===|^--- Reply 1 of [1-9]/m.test(text)) throw new ParseDrift('slack.thread', 'thread sections present but none parsed');
  return { messages: [...(parent ? [parent] : []), ...replies], cursor };
}

/** Detailed `slack_read_channel` output → top-level messages. */
export function parseSlackChannel(raw: unknown, channelId: string): { messages: ParsedSlackMessage[] } {
  const body = unwrapToolOutput(raw);
  const text = String(body.messages ?? body.results ?? body.text ?? '');
  const out: ParsedSlackMessage[] = [];
  for (const part of text.split(/^(?==== Message from )/m)) {
    const head = /^=== Message from (.*?) at (.*?) ===\s*$/m.exec(part);
    const ts = /^Message TS: (\d+\.\d+)/m.exec(part)?.[1];
    if (!head || !ts) continue;
    const textAt = part.indexOf('\n', part.indexOf('Message TS:'));
    // The trailing Reactions / Files / Replies lines are not message text (DLV-1: Files names what was attached).
    const lines = (textAt >= 0 ? part.slice(textAt + 1) : '').split('\n');
    const extra: string[] = [];
    while (lines.length && (!lines[lines.length - 1]!.trim() || /^(Reactions|Files|Replies): /.test(lines[lines.length - 1]!.trim()))) {
      const l = lines.pop()!.trim();
      if (l) extra.unshift(l);
    }
    out.push({ channelId, ...authorOf(head[1]), ts, text: lines.join('\n').trim(), ...(extra.length ? { extra } : {}) });
  }
  if (!out.length && /^=== Message from /m.test(text)) throw new ParseDrift('slack.channel', 'message headers present but none parsed');
  return { messages: out };
}

// ------------------------------------------------------------------ hints

/**
 * DLV-1: the `Files:` line of a detailed thread / channel read → names, ids, types, sizes. Names and types only, never
 * contents: `Files: deck.pptx (ID: F0XX, application/vnd…, 1.2 MB), notes.md (ID: F0YY, text/markdown, 3 KB)`.
 */
export function slackFilesOf(extra: string[] | undefined): { name: string; id?: string; mimetype?: string; size?: string }[] {
  const line = (extra ?? []).find((l) => l.startsWith('Files: '));
  if (!line) return [];
  const out: { name: string; id?: string; mimetype?: string; size?: string }[] = [];
  for (const m of line.slice(7).matchAll(/\s*([^,(][^()]*?)\s*\(ID:\s*([A-Z0-9]+)(?:,\s*([^,()]+))?(?:,\s*([^()]+))?\)\s*,?/g)) {
    out.push({ name: m[1]!.trim(), id: m[2], ...(m[3] ? { mimetype: m[3].trim().replace(/\\\//g, '/') } : {}), ...(m[4] ? { size: m[4].trim() } : {}) });
  }
  return out.slice(0, 10);
}

const DRIVE_ID = /(?:docs\.google\.com\/(?:document|presentation|spreadsheets|forms|drawings)\/d\/|drive\.google\.com\/(?:file\/d\/|open\?id=|drive\/folders\/))([A-Za-z0-9_-]{20,})/g;
const URL_RE = /https?:\/\/[^\s<>|)"']+/g;
const OPP_ID = /\b006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g;
const ACCOUNT_ID = /\b001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g;

/** Drive file refs (`drive:<id>`) plus up to 3 other URLs (`url:<url>`), Org62 opp/account ids. */
export function slackHints(text: string): { fileRefs: string[]; oppHints: string[]; accountHints: string[] } {
  const drive = [...new Set([...text.matchAll(DRIVE_ID)].map((m) => `drive:${m[1]}`))];
  const urls = [...new Set((text.match(URL_RE) ?? []).filter((u) => !/docs\.google\.com|drive\.google\.com|\.slack\.com\/archives/.test(u)))].slice(0, 3).map((u) => `url:${u}`);
  return {
    fileRefs: [...drive, ...urls].slice(0, 20),
    oppHints: [...new Set(text.match(OPP_ID) ?? [])].slice(0, 10),
    accountHints: [...new Set(text.match(ACCOUNT_ID) ?? [])].slice(0, 10),
  };
}
