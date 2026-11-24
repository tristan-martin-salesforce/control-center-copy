/**
 * Slack fetched by code (FTI): the queries of skills/scan-slack.md §2 and the thread rules of §3, each one MCP tool call
 * through the `claude_relay` runtime, paged by code, every result recorded by REC-1 (SlackAutoRecorder: the same parse,
 * normalization, dedupe keys and content hashes as when the agent reads it). No model reads the results here.
 *
 *   inbox          S1 DMs to me · S2 @mentions · S3 my messages · S4 my messages with a file (only when S3 found any:
 *                  S4 is a subset of S3, so an empty S3 vouches for it)
 *   channel:<id>   C1 `in:#<name>`, or C1′ read_channel when the channel has no usable name
 *   thread:<c>:<ts> T1 read_thread (targeted)
 *   threads        §3: a reply addressed to me or by me whose parent this run has not read, my completion words in a
 *                  thread, and (head/backfill) the threads of open items quiet since before the window; ≤ 5 a run (10 in
 *                  backfill)
 * Coverage refs and kinds, the 2-minute overlap and the cursor are the skill's (§8), so the ledger cannot tell the two
 * paths apart.
 */
import { RuntimeCallError } from '@/connectors/runtime/types';
import { unwrapToolOutput } from '@/connectors/slack/parse';
import { ledgerHash } from '@/db/ledger';
import { SCANNER_MODEL } from '@/llm/models';
import { SlackAutoRecorder } from '@/llm/slack-rec';

import type { CoverageObject } from '../types';
import { COMPLETION_CUE } from '../interpret/rules';
import { relayErrorClass, ScopeFetchError, type FetchCall, type FetchRequest, type ScopeFetchResult } from './types';

export const SLACK_SEARCH = 'slack_search_public_and_private';
export const SLACK_THREAD = 'slack_read_thread';
export const SLACK_CHANNEL = 'slack_read_channel';

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const isoOfTs = (ts: string) => new Date(Math.round(Number(ts) * 1000)).toISOString();
const ALL_TYPES = 'public_channel,private_channel,mpim,im';

export interface SlackQuery {
  /** Coverage ref (and the trace's query name). */
  ref: string;
  kind: CoverageObject['kind'];
  tool: string;
  args: Record<string, unknown>;
  /** Extra coverage refs this query vouches for. */
  covers?: string[];
}

/** The scope's fixed queries for the window (scan-slack §2 verbatim), or null when it needs the agent (no Slack id). */
export function slackQueries(scope: string, window: { from: string; to: string }, vars: Record<string, unknown>, me: string | undefined): SlackQuery[] | null {
  const base = { sort: 'timestamp', sort_dir: 'asc', limit: 20, include_context: false, response_format: 'detailed', after: String(unix(window.from) - 120), before: String(unix(window.to)) };
  if (scope === 'inbox') {
    if (!me) return null;
    return [
      { ref: 'search:dm', kind: 'query_window', tool: SLACK_SEARCH, args: { ...base, filters: `-from:<@${me}>`, channel_types: 'im,mpim' } },
      { ref: 'search:mentions', kind: 'query_window', tool: SLACK_SEARCH, args: { ...base, keywords: [`<@${me}>`], channel_types: 'public_channel,private_channel' } },
      { ref: 'search:mine', kind: 'query_window', tool: SLACK_SEARCH, args: { ...base, filters: `from:<@${me}>`, channel_types: ALL_TYPES } },
      { ref: 'search:mine:files', kind: 'query_window', tool: SLACK_SEARCH, args: { ...base, filters: `from:<@${me}> has:file`, channel_types: ALL_TYPES } },
    ];
  }
  if (scope.startsWith('channel:')) {
    const id = scope.slice('channel:'.length);
    const label = String(vars['channel.label'] ?? '').trim();
    if (label) return [{ ref: `search:channel:${id}`, kind: 'channel_range', tool: SLACK_SEARCH, args: { ...base, filters: `in:#${label}`, channel_types: 'public_channel,private_channel' } }];
    return [{ ref: `search:channel:${id}`, kind: 'channel_range', tool: SLACK_CHANNEL, args: { channel_id: id, oldest: String(unix(window.from) - 120), latest: String(unix(window.to)), limit: 100, response_format: 'detailed' } }];
  }
  if (scope.startsWith('thread:')) {
    const [, channel, ts] = scope.split(':');
    if (!channel || !ts) return null;
    return [{ ref: `slack:${channel}:${ts}`, kind: 'thread', tool: SLACK_THREAD, args: { channel_id: channel, message_ts: ts, limit: 100, response_format: 'detailed' } }];
  }
  return null;
}

/** The next-page cursor a Slack read result names (`cursor \`…\`` or `cursor: \`…\``), if any. */
export function slackCursorOf(text: string): string | undefined {
  const b = unwrapToolOutput(text);
  const info = `${String(b.pagination_info ?? '')} ${typeof b.text === 'string' ? b.text.slice(-400) : ''}`;
  return /cursor:?\s*`([^`]+)`/.exec(info)?.[1];
}

/** Message timestamps of a result, in order (for the paged-out coverage end). */
function messageTs(text: string): string[] {
  const b = unwrapToolOutput(text);
  const s = `${String(b.results ?? '')}\n${String(b.messages ?? '')}\n${typeof b.text === 'string' ? b.text : ''}`;
  return [...s.matchAll(/^(?:Message_ts|Message TS):\s*(\d+\.\d+)\s*$/gm)].map((m) => m[1]!);
}

/** One relay read, with its booking line; a failure stops the fetch with the relay's code and class. */
export async function relayRead(req: FetchRequest, calls: FetchCall[], tool: string, args: Record<string, unknown>, rows: (text: string) => number): Promise<string> {
  const t0 = Date.now();
  try {
    const r = await req.runtime.call(tool, args, { signal: req.signal });
    calls.push({ tool, ok: true, usd: r.cost.usd, usage: r.usage, contentHash: ledgerHash(r.usage.model ?? SCANNER_MODEL, tool, JSON.stringify(args)), ms: Date.now() - t0, rows: rows(r.text) });
    await req.onCall?.(calls.at(-1)!);
    return r.text;
  } catch (err) {
    if (err instanceof RuntimeCallError) {
      calls.push({ tool, ok: false, code: err.code, usd: err.cost.usd, usage: err.usage, contentHash: ledgerHash(err.usage.model ?? SCANNER_MODEL, tool, JSON.stringify(args)), ms: Date.now() - t0, rows: 0 });
      await req.onCall?.(calls.at(-1)!);
      throw new ScopeFetchError(`${req.ctx.scope.connector} read ${tool} failed: ${err.code}`, relayErrorClass(err.code), err.code, calls);
    }
    throw err;
  }
}

export async function fetchSlackScope(req: FetchRequest): Promise<ScopeFetchResult> {
  const me = req.ctx.me.slackId;
  const queries = slackQueries(req.scope, req.window, req.vars, me);
  if (!queries) throw new ScopeFetchError(`slack scope ${req.scope} has no fixed queries`, 'config', 'slack_scope', []);
  const backfill = req.mode === 'backfill' || req.mode === 'head' || req.mode === 'continuation';
  const maxPages = req.maxPages ?? (backfill ? 20 : 5);
  const rec = new SlackAutoRecorder(req.store, req.state, req.ctx);
  const calls: FetchCall[] = [];
  const coverage: CoverageObject[] = [];
  const pagedOut: string[] = [];
  let read = 0;
  let mineFound = 0;
  for (const q of queries) {
    if (req.signal.aborted) throw new ScopeFetchError('aborted', 'transient', 'aborted', calls);
    // S4 is a subset of S3: an empty S3 vouches for it with no call
    if (q.ref === 'search:mine:files' && mineFound === 0) {
      coverage.push({ kind: q.kind, ref: q.ref, from: req.window.from, to: req.window.to, meta: { vouchedBy: 'search:mine' } });
      continue;
    }
    let cursor: string | undefined;
    let lastTs: string | undefined;
    let pages = 0;
    do {
      const args = cursor ? { ...q.args, cursor } : q.args;
      const text = await relayRead(req, calls, q.tool, args, (t) => messageTs(t).length);
      const ts = messageTs(text);
      read += ts.length;
      if (q.ref === 'search:mine') mineFound += ts.length;
      if (ts.length) lastTs = ts[ts.length - 1];
      await rec.onToolResult(q.tool, args, text, `${q.ref}:p${pages + 1}`);
      cursor = slackCursorOf(text);
      pages += 1;
    } while (cursor && pages < maxPages);
    if (q.kind === 'thread') {
      coverage.push({ kind: 'thread', ref: q.ref, from: req.window.from, to: req.window.to });
    } else if (cursor && lastTs) {
      // paged out: covered up to the last message processed; the run finishes incomplete (§2 paging)
      coverage.push({ kind: q.kind, ref: q.ref, from: req.window.from, to: isoOfTs(lastTs) });
      pagedOut.push(lastTs);
    } else coverage.push({ kind: q.kind, ref: q.ref, from: req.window.from, to: req.window.to });
  }
  // §3 thread reads: every thread this run found (caps audit 2026-11-21: was the oldest 5, 10 on backfill, and the
  // rest were never opened), each paged like a thread scope (100 a page, the same `maxPages` time and cost bound)
  const threads = threadsToOpen(req);
  for (const t of threads) {
    if (req.signal.aborted) break;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const args = { channel_id: t.channel, message_ts: t.ts, limit: 100, response_format: 'detailed', ...(cursor ? { cursor } : {}) };
      const text = await relayRead(req, calls, SLACK_THREAD, args, (x) => messageTs(x).length);
      read += messageTs(text).length;
      await rec.onToolResult(SLACK_THREAD, args, text, `thread:${t.channel}:${t.ts}${pages ? `:p${pages + 1}` : ''}`);
      cursor = slackCursorOf(text);
      pages += 1;
    } while (cursor && pages < maxPages);
    coverage.push({ kind: 'thread', ref: `slack:${t.channel}:${t.ts}` });
  }
  const earliest = pagedOut.sort((a, b) => Number(a) - Number(b))[0];
  const cursor = earliest ? { value: earliest, at: isoOfTs(earliest) } : { value: `${unix(req.window.to)}.000000`, at: new Date(req.window.to).toISOString() };
  return { coverage, cursor, complete: !earliest, calls, read };
}

/** §3: which threads to read after the searches, oldest first (all of them unless a caller passes `max`). */
export function threadsToOpen(req: Pick<FetchRequest, 'state' | 'ctx' | 'mode' | 'window' | 'scope'>, max = Number.POSITIVE_INFINITY): Array<{ channel: string; ts: string }> {
  if (req.scope.startsWith('thread:')) return [];
  const out = new Map<string, { channel: string; ts: string; at: number }>();
  const recorded = req.state.recorded;
  for (const it of req.state.items.values()) {
    if (it.connector !== 'slack' || it.kind !== 'message') continue;
    const p = (it.payload ?? {}) as { channelId?: string; ts?: string; threadTs?: string; isReply?: boolean; toMe?: boolean };
    if (!p.channelId || !p.threadTs || !p.isReply) continue;
    const mine = !!it.author?.isMe;
    const why = (p.toMe || mine) && !recorded.has(`slack:${p.channelId}:${p.threadTs}`);
    const delivered = mine && COMPLETION_CUE.test(it.excerpt ?? '');
    if (why || delivered) out.set(`${p.channelId}:${p.threadTs}`, { channel: p.channelId, ts: p.threadTs, at: Number(p.threadTs) });
  }
  if (req.mode === 'head' || req.mode === 'backfill') {
    let n = 0;
    for (const o of req.ctx.openItems) {
      // a sample of 3 stale open items per head/backfill run; the resolution recall (src/scanner/resolution/recall.ts)
      // re-reads every thread of mine in rotation, so this is a head start, not the only read
      if (n >= 3) break;
      if (o.lastEvidenceAt && Date.parse(o.lastEvidenceAt) >= Date.parse(req.window.from)) continue;
      for (const t of o.threadRefs) {
        const m = /^slack:([CDG][A-Z0-9]+):(\d+\.\d+)$/.exec(t);
        if (m && !out.has(`${m[1]}:${m[2]}`)) {
          out.set(`${m[1]}:${m[2]}`, { channel: m[1]!, ts: m[2]!, at: Number(m[2]) });
          n += 1;
          break;
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at).slice(0, max).map(({ channel, ts }) => ({ channel, ts }));
}
