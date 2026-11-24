/**
 * REC-1: record every Slack message the traversal reads, from the tool result itself.
 *
 * Stress finding REC-1: the same replayed busy day, three runs, recorded 61 / 126 / 55 messages. The agent chose
 * what to transcribe, so messages it never recorded could not become evidence for anything (8 of 17 block-A Slack
 * misses were never recorded). The runner now parses each search page / thread read / channel read the agent
 * gets back and records every message in it (dedupe by channel + ts), before the model sees the result. The
 * agent cites them as `<channelId>:<ts>`; its own `cc_record_source_items` for the same message returns the same
 * id. No extra model cost. Redaction and the 4000-character excerpt cap (R6) apply as for agent records (normalizeItem).
 */
import type { NormalizedSourceItem, ScanContext, ScannerStore } from '../scanner/types';
import { parseSlackChannel, parseSlackSearch, parseSlackThread, slackFilesOf, slackHints, type ParsedSlackMessage, type SlackChannelType } from '../connectors/slack/parse';
import { normalizeItem, type CcRunState } from './cc-tools';
import { trace } from '../scanner/trace';
import { isParseDrift } from '../errors/drift';

/** Bare tool names whose results are recorded. */
export const SLACK_REC_TOOLS = new Set(['slack_search_public_and_private', 'slack_search_public', 'slack_read_thread', 'slack_read_channel']);

export const bareToolName = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');

type QueryClass = 'dm' | 'mentions' | 'mine' | 'channel' | 'thread' | 'other';

/** The Slack search arguments that decide what a search returns: the current `filters` string and `keywords` array, and the
 *  older `query` string. */
export interface SlackSearchArgs { query?: unknown; filters?: unknown; keywords?: unknown }

const keywordsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

/** The skill's query classes (scan-slack §2): S1 filters `-from:<@me>` · S2 keywords `<@me>` · S3 filters `from:<@me>` ·
 *  C1 filters `in:#name`. Anything else is `other`, which is never marked as addressed to me. A mention counts only in
 *  `keywords` (or the old `query`): Slack ignores a bare mention in `filters` and returns the whole workspace. */
export function queryClassOf(search: string | SlackSearchArgs, me: string | undefined): QueryClass {
  const a: SlackSearchArgs = typeof search === 'string' ? { query: search } : search;
  const filters = ` ${String(a.filters ?? '')} ${String(a.query ?? '')} `;
  if (me && filters.includes(` -from:<@${me}> `)) return 'dm';
  if (me && filters.includes(` from:<@${me}> `)) return 'mine';
  if (/\sin:#?[<\w-]/.test(filters)) return 'channel';
  if (me && [...keywordsOf(a.keywords), String(a.query ?? '')].some((k) => k.trim() === `<@${me}>`)) return 'mentions';
  if (/(^|\s)-from:/.test(filters)) return 'dm';
  return 'other';
}

export interface SlackRecStats {
  calls: number;
  parsed: number;
  recorded: number;
  dup: number;
  errors: number;
}

export class SlackAutoRecorder {
  readonly stats: SlackRecStats = { calls: 0, parsed: 0, recorded: 0, dup: 0, errors: 0 };
  /** CONN-9: the parser saw Slack's own markers and read nothing (a format change); the runner fails the run on it. */
  drift: string | null = null;
  /** channelId → what search results said about it (thread reads carry no channel line). */
  private readonly channels = new Map<string, { type?: SlackChannelType; name?: string }>();
  private readonly handled = new Set<string>();

  constructor(
    private readonly store: ScannerStore,
    private readonly state: CcRunState,
    private readonly ctx: ScanContext,
  ) {
    for (const c of ctx.aliases.channels) this.channels.set(c.channelId, { type: 'channel', name: c.label?.replace(/^#/, '') });
  }

  /** Record the messages of one tool result. Idempotent per tool-use id. Never throws (a parse failure only costs REC-1). */
  async onToolResult(toolName: string, toolInput: unknown, toolResponse: unknown, toolUseId?: string): Promise<number> {
    const tool = bareToolName(toolName);
    if (!SLACK_REC_TOOLS.has(tool)) return 0;
    if (toolUseId) {
      if (this.handled.has(toolUseId)) return 0;
      this.handled.add(toolUseId);
    }
    this.stats.calls += 1;
    try {
      const args = (toolInput ?? {}) as Record<string, unknown>;
      const me = this.ctx.me.slackId;
      let msgs: ParsedSlackMessage[];
      let cls: QueryClass;
      // DLV-1: scan-slack's `has:file` search marks the messages that carry an attachment (search results show none).
      const hasFile = /(^|\s)has:file(\s|$)/.test(`${String(args.query ?? '')} ${String(args.filters ?? '')}`);
      if (tool === 'slack_read_thread') {
        msgs = parseSlackThread(toolResponse, String(args.channel_id ?? ''), args.message_ts ? String(args.message_ts) : undefined).messages;
        cls = 'thread';
      } else if (tool === 'slack_read_channel') {
        msgs = parseSlackChannel(toolResponse, String(args.channel_id ?? '')).messages;
        cls = 'channel';
      } else {
        msgs = parseSlackSearch(toolResponse).messages;
        cls = queryClassOf(args, me);
        // A DM search that reached a channel (no channel_types) returns messages that are not to me.
        if (cls === 'dm') msgs = msgs.filter((m) => this.channelTypeOf(m) === 'im' || this.channelTypeOf(m) === 'mpim');
      }
      for (const m of msgs) if (m.channelType || m.channelName) this.channels.set(m.channelId, { type: m.channelType ?? this.channels.get(m.channelId)?.type, name: m.channelName ?? this.channels.get(m.channelId)?.name });
      this.stats.parsed += msgs.length;
      const items: NormalizedSourceItem[] = [];
      const seen = new Set<string>();
      for (const m of msgs) {
        if (!m.channelId || !m.ts) continue;
        const it = normalizeItem(this.state.connector, this.toRaw(m, cls, hasFile));
        if (seen.has(it.dedupeKey) || this.state.recorded.has(it.dedupeKey)) {
          // DLV-1: a later sighting that shows attachments (a detailed read, the has:file search) adds them.
          const prev = this.state.items.get(it.dedupeKey);
          const add = it.payload as { files?: unknown[]; hasFile?: boolean } | undefined;
          const had = prev?.payload as { files?: unknown[]; hasFile?: boolean } | undefined;
          if (prev && !seen.has(it.dedupeKey) && ((add?.files?.length && !had?.files?.length) || (add?.hasFile && !had?.hasFile))) {
            seen.add(it.dedupeKey);
            items.push({ ...prev, payload: { ...prev.payload, ...(add?.files?.length ? { files: add.files } : {}), ...(add?.hasFile ? { hasFile: true } : {}) } });
            continue;
          }
          this.stats.dup += 1;
          continue;
        }
        seen.add(it.dedupeKey);
        items.push(it);
      }
      if (!items.length) {
        trace(this.state.runId, 'rec', { tool, query: cls, parsed: msgs.length, recorded: 0, new: 0, dup: msgs.length });
        return 0;
      }
      const res = await this.store.recordSourceItems(this.state.runId, items);
      res.forEach((r, i) => {
        this.state.recorded.set(r.dedupeKey, r.sourceItemId);
        this.state.items.set(r.dedupeKey, items[i]!);
        this.state.auto.add(r.dedupeKey);
        this.state.counts.recorded += 1;
        if (r.isNew) this.state.counts.new += 1;
        if (r.changed) this.state.counts.changed += 1;
      });
      this.stats.recorded += res.length;
      // REC-1 in the trace: what this tool result held and what was recorded (ids in the store's `recorded` event).
      trace(this.state.runId, 'rec', { tool, query: cls, parsed: msgs.length, recorded: res.length, new: res.filter((r) => r.isNew).length, changed: res.filter((r) => r.changed).length, dup: msgs.length - items.length });
      return res.length;
    } catch (err) {
      this.stats.errors += 1;
      if (isParseDrift(err)) this.drift ??= (err as Error).message.slice(0, 160);
      trace(this.state.runId, 'rec', { tool, error: (err as Error)?.name ?? 'error' });
      return 0;
    }
  }

  private channelTypeOf(m: ParsedSlackMessage): SlackChannelType {
    return m.channelType ?? this.channels.get(m.channelId)?.type ?? (m.channelId.startsWith('D') ? 'im' : 'channel');
  }

  private toRaw(m: ParsedSlackMessage, cls: QueryClass, hasFile = false): Parameters<typeof normalizeItem>[1] {
    const me = this.ctx.me.slackId;
    const known = this.channels.get(m.channelId);
    const channelType: SlackChannelType = this.channelTypeOf(m);
    const channelName = m.channelName ?? known?.name;
    const threadRoot = m.threadTs ?? m.ts;
    const hints = slackHints(m.text);
    const account = this.ctx.aliases.channels.find((c) => c.channelId === m.channelId)?.accountId;
    // A 1:1 DM is to me; a group-DM message only when it @-mentions me (S1 returns every group-DM message not from
    // me, and the triage pass read "→ me" on asks addressed to someone else; stress finding TRI-1).
    const mentionsMe = !!me && m.text.includes(`<@${me}`);
    const toMe = (cls === 'dm' && channelType === 'im') || cls === 'mentions' || mentionsMe;
    const accountHints = [...new Set([...(account ? [account] : []), ...hints.accountHints])].slice(0, 10);
    return {
      kind: 'message',
      externalId: `${m.channelId}:${m.ts}`,
      occurredAt: m.ts,
      author: { name: m.authorName, email: m.authorEmail, externalId: m.authorId, isMe: !!me && m.authorId === me },
      participants: m.participants?.slice(0, 30).map((p) => ({ name: p.name, externalId: p.externalId, isMe: !!me && p.externalId === me })),
      permalink: m.permalink,
      excerpt: m.text,
      threadRef: `slack:${m.channelId}:${threadRoot}`,
      fileRefs: hints.fileRefs.length ? hints.fileRefs : undefined,
      oppHints: hints.oppHints.length ? hints.oppHints : undefined,
      accountHints: accountHints.length ? accountHints : undefined,
      payload: {
        channelId: m.channelId,
        ...(channelName ? { channelName } : {}),
        channelType,
        ts: m.ts,
        ...(m.threadTs ? { threadTs: m.threadTs } : {}),
        isReply: !!m.threadTs && m.threadTs !== m.ts,
        query: cls,
        ...(toMe ? { toMe: true } : {}),
        ...(m.extra?.length ? { extra: m.extra.slice(0, 4) } : {}),
        ...(slackFilesOf(m.extra).length ? { files: slackFilesOf(m.extra).map((f) => ({ name: f.name, ...(f.mimetype ? { mimetype: f.mimetype } : {}), ...(f.id ? { id: f.id } : {}) })) } : {}),
        ...(hasFile ? { hasFile: true } : {}),
        rec: 'auto',
      },
    };
  }
}
