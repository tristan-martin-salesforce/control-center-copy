/**
 * The recall sweep (lane 03 SCN-1, R5, decision 4 option B): Slack channel-thread replies to me without an @-mention are
 * never returned by the inbox searches (S1 DMs, S2 mentions, S3/S4 my own messages), so "can you send me the v2?" under
 * my channel message was never recorded, never an item, and never closed anything.
 *
 * Deterministic, in code (no model judgment): every 30 minutes, re-read up to MAX_THREADS channel threads where I posted
 * or was mentioned in the last 14 days and whose newest recorded line is older than the poll window, with
 * `slack_read_thread` from the last recorded ts (allowlisted, read-only). The replies go through REC-1
 * (SlackAutoRecorder) like any search result, so triage, the scanner agent and the resolution check's triggers see them.
 * DMs need no sweep: S1 returns every DM line not from me.
 *
 * Pure selection here; the read is injected (the job passes the connector's existing one-call read path).
 */
export const RECALL_MAX_THREADS = 25;
export const RECALL_LOOKBACK_DAYS = 14;
export const RECALL_POLL_MS = 30 * 60_000;
export const SLACK_THREAD_TOOL = 'mcp__slack__slack_read_thread';

/** One channel thread I am in, as the store knows it. */
export interface ThreadRow {
  channelId: string;
  channelType?: string | null;
  /** The thread root's ts (my top-level message's own ts, or the root of the thread I replied in). */
  threadTs: string;
  /** My newest line in it, or the newest line mentioning me. */
  lastMineAt: string;
  /** The newest line recorded in it, anyone's (its ts, for `oldest`). */
  lastRecordedAt: string;
  lastRecordedTs: string;
}

export interface ThreadToRead {
  channelId: string;
  threadTs: string;
  /** Read only replies after this ts (the newest recorded one). */
  oldest: string;
}

/** Which threads to re-read now: channel threads with my line in the lookback, quiet in the store past the poll window. */
export function threadsToFollow(rows: ThreadRow[], now: Date, o: { max?: number; lookbackDays?: number; pollMs?: number } = {}): ThreadToRead[] {
  const since = now.getTime() - (o.lookbackDays ?? RECALL_LOOKBACK_DAYS) * 86_400_000;
  const poll = o.pollMs ?? RECALL_POLL_MS;
  return rows
    .filter((r) => r.channelType !== 'im' && r.channelType !== 'mpim' && Date.parse(r.lastMineAt) >= since && now.getTime() - Date.parse(r.lastRecordedAt) >= poll)
    .sort((a, b) => Date.parse(b.lastMineAt) - Date.parse(a.lastMineAt))
    .slice(0, o.max ?? RECALL_MAX_THREADS)
    .map((r) => ({ channelId: r.channelId, threadTs: r.threadTs, oldest: r.lastRecordedTs }));
}

/** The arguments of one thread read (the detailed format: REC-1 needs the ts lines). */
export const threadReadArgs = (t: ThreadToRead) => ({ channel_id: t.channelId, message_ts: t.threadTs, oldest: t.oldest, response_format: 'detailed' });

export interface FollowDeps {
  /** One read-only `slack_read_thread` call; the tool's own text, or null when it failed. */
  read: (args: Record<string, unknown>) => Promise<{ text: string | null; costUsd?: number; code?: string }>;
  /** Hand the result to REC-1 (SlackAutoRecorder.onToolResult); returns how many lines it recorded. */
  record: (toolName: string, args: Record<string, unknown>, text: string, toolUseId: string) => Promise<number>;
}

export interface FollowResult {
  read: number;
  recorded: number;
  failed: number;
  costUsd: number;
  errors: string[];
}

export async function followThreads(threads: ThreadToRead[], deps: FollowDeps, signal?: AbortSignal): Promise<FollowResult> {
  const out: FollowResult = { read: 0, recorded: 0, failed: 0, costUsd: 0, errors: [] };
  for (const t of threads) {
    if (signal?.aborted) break;
    const args = threadReadArgs(t);
    const r = await deps.read(args);
    out.costUsd += r.costUsd ?? 0;
    if (r.text == null) {
      out.failed += 1;
      out.errors.push(r.code ?? 'read_failed');
      // auth / config will not fix itself within one sweep
      if (r.code === 'auth' || r.code === 'config') break;
      continue;
    }
    out.read += 1;
    out.recorded += await deps.record(SLACK_THREAD_TOOL, args, r.text, `recall:${t.channelId}:${t.threadTs}:${t.oldest}`);
  }
  return out;
}

/** A detailed `slack_read_thread` result (the format parseSlackThread reads), for fakes and the eval harness. */
export function renderThreadRead(parent: { author: string; email?: string; id: string; ts: string; text: string }, replies: Array<{ author: string; email?: string; id: string; ts: string; text: string; at: string }>, parentAt: string): string {
  const msg = (m: { author: string; email?: string; id: string; ts: string; text: string }, at: string) => [`From: ${m.author} <${m.email ?? ''}> (${m.id})`, `Time: ${at}`, `Message TS: ${m.ts}`, m.text, ''].join('\n');
  return ['=== THREAD PARENT MESSAGE ===', msg(parent, parentAt), `=== THREAD REPLIES (${replies.length} total) ===`, ...replies.flatMap((r, i) => [`--- Reply ${i + 1} of ${replies.length} ---`, msg(r, r.at)])].join('\n');
}
