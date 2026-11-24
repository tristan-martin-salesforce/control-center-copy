/**
 * Slack triage pass (STRESS-2): after the traversal, a separate cheap-model pass gives every recorded message that
 * is to me, from me, or in a DM / group DM / thread I'm in exactly one verdict (act | noise | unsure), in small
 * batches grouped by conversation (skills/triage-slack.md). `unsure` goes to the stronger tier for a final verdict.
 *
 * Why: in the SLK-1 A/B, 8 of the 10 Slack items Haiku still missed had been recorded and then left with no outcome
 * at all (indirect asks, group-DM asks, takeaways, my promises in channel thread replies, direct questions). The
 * traversal agent juggles paging, threads, coverage and linking; a focused pass over a short list does not.
 *
 * This module is pure (selection, batching, rendering); the runner (src/llm/skill-runner.ts) runs the passes.
 */
import type { NormalizedSourceItem, ScanContext } from '../types';

export interface TriageConfig {
  /** skills/triage-slack.md */
  skillPath: string;
  model: string;
  /** Stronger tier for `unsure` verdicts; undefined = no escalation (unsure → flagged unlinked). */
  escalateModel?: string;
  /** Messages that need a verdict, per batch. */
  batchSize: number;
  /**
   * Batches per run; unset (the default) = every batch. Caps audit 2026-11-21: the default was 12 and the lines past
   * it got no verdict and no flag, so a busy window's asks vanished. Each batch has its own cost cap and the daily hard
   * cap still applies; a caller that sets this (a stress probe) sees the rest as `dropped`.
   */
  maxBatches?: number;
  maxTurns: number;
  costCapUsdPerBatch: number;
  escalateCostCapUsd: number;
  /**
   * D6: what is left of today's escalation allowance (Settings ▸ Budgets ▸ Slack triage escalation, per day). Unset =
   * no day cap. At 0 the unsure lines are flagged for Triage instead of escalated (llm_decisions: escalation_day_cap).
   */
  escalateLeftUsd?: number;
}

export const DEFAULT_TRIAGE: Omit<TriageConfig, 'model' | 'escalateModel'> = {
  skillPath: 'skills/triage-slack.md',
  batchSize: 10,
  maxTurns: 16,
  costCapUsdPerBatch: 0.03,
  escalateCostCapUsd: 0.25,
};

export interface TriageLine {
  /** `<channelId>:<ts>` (the handlers resolve it to the recorded id). */
  ref: string;
  sourceItemId: string;
  item: NormalizedSourceItem;
  /** Needs a verdict in this batch (else: context, or already handled by the traversal). */
  needs: boolean;
  /** What the traversal already did with it (`proposed:wi_1:ask`, `origin:wi_2`, …). */
  done?: string[];
  /** Escalation: the first pass's reason for `unsure`. */
  unsureWhy?: string;
  /** Who the line is addressed to, read over the whole conversation (explicit, broadcast or a continuation). */
  addr?: LineAddress;
  /** TRI-CTX: a line recorded by an earlier run (any window): context only, never a verdict. */
  earlier?: boolean;
}

/**
 * Who a message is addressed to (TRI-2), read in its conversation:
 *  - `me` / `others`: it opens by addressing them (an @-mention or a greeting with a name), or it continues an exchange
 *    (`via: 'continues'`): an unaddressed reply right after someone addressed its author goes back to that person, and
 *    an unaddressed follow-on keeps its author's last addressee;
 *  - `channel`: @channel, @here or @everyone; `list`: me among three or more @-mentioned people.
 */
export type LineAddress =
  | { to: 'me'; via?: 'continues' }
  | { to: 'others'; names: string[]; via?: 'continues' }
  | { to: 'channel' }
  | { to: 'list'; others: number };

/** A prior verdict on a message (an earlier run's triage, carried forward). */
export interface PriorVerdict {
  v: 'act' | 'noise' | 'unsure';
  why?: string;
}

/** TRI-CTX: how many earlier lines (before the first message needing a verdict) and later replies a chunk keeps. */
export const TRIAGE_CONTEXT = { before: 6, after: 4 } as const;

export interface TriageConversation {
  key: string;
  title: string;
  lines: TriageLine[];
}

export interface TriageBatch {
  conversations: TriageConversation[];
  needs: number;
}

export interface TriageSelection {
  batches: TriageBatch[];
  /** Messages that qualified (to / from me, DM, group DM, thread I'm in). */
  qualifying: number;
  /** Qualifying messages that need a verdict (not trivial, not already handled). */
  needing: number;
  trivial: number;
  handled: number;
  /** Needing messages left out by `maxBatches`. */
  dropped: number;
  /**
   * Why each recorded message did or did not get a verdict (the trace: "why wasn't this picked up?"), as source item
   * ids per decision: `trivial` (an acknowledgement or emoji), `handled` (the traversal already proposed or linked it),
   * `skipped` (not to me, from me, or in a DM or thread I'm in), `dropped` (over the batch cap).
   */
  decisions?: { trivial: string[]; handled: string[]; skipped: string[]; dropped: string[] };
}

type P = { channelId?: string; channelName?: string; channelType?: string; ts?: string; threadTs?: string; isReply?: boolean; toMe?: boolean; query?: string };
export interface SelectOptions {
  /** TRI-NOISE: earlier runs' verdicts by sourceItemId. A message an earlier run called noise is context only now. */
  prior?: Map<string, PriorVerdict>;
  /** TRI-CTX: lines of the same conversations from earlier runs (any window), by conversation key. */
  extra?: Map<string, TriageLine[]>;
}
const payloadOf = (it: NormalizedSourceItem) => (it.payload ?? {}) as P;
const tsOf = (it: NormalizedSourceItem) => Number(payloadOf(it).ts ?? it.externalId.split(':').pop()) || Date.parse(it.occurredAt) / 1000;

/** Emoji codes, mentions, links and punctuation stripped: nothing (or a bare acknowledgement) left = trivial noise. */
export function isTrivial(text: string | undefined): boolean {
  const t = (text ?? '')
    .replace(/:[a-z0-9_+'-]+:/gi, ' ')
    .replace(/<[@#!][^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, ' ')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (t.replace(/[^\p{L}]/gu, '').length < 2) return true;
  const ack = /^(thanks?|thank you|thx|ty|tysm|ok|okay|k|kk|lol|haha+|ha|nice|cool|great|awesome|perfect|np|no worries|no problem|congrats|congratulations|welcome|hi|hello|hey|good morning|morning|gm|bye|cheers|yay|woo+|wow)( (so much|a lot|again|all|everyone|team|guys|man|buddy|for this|for that|for sharing))?( [a-z]+)?$/;
  return ack.test(t) && t.split(' ').length <= 5;
}

const HANDLED = /^(proposed|origin|progress|completion|contradiction):/;

const isDmItem = (it: NormalizedSourceItem) => {
  const t = payloadOf(it).channelType;
  return t === 'im' || t === 'mpim' || (!t && (it.externalId.startsWith('D') || /^(?:slack:)?D/.test(it.threadRef ?? '')));
};

/** The conversation a message belongs to: its DM or group DM, else its thread (a lone channel message is its own). */
export function triageConversationKey(it: NormalizedSourceItem): string {
  return isDmItem(it) ? `dm:${payloadOf(it).channelId ?? it.externalId.split(':')[0]}` : (it.threadRef ?? `msg:${it.externalId}`);
}

/** TRI-CTX: what to read from earlier runs for a conversation (a DM's channel, or a thread), around this run's lines. */
export interface ConversationRef {
  key: string;
  channelId?: string;
  threadRef?: string;
  /** This run's first and last line of the conversation. */
  firstAt: string;
  lastAt: string;
}

/** The conversations of a selection, with the bounds the store reads earlier lines and later replies around. */
export function conversationRefs(sel: TriageSelection): ConversationRef[] {
  const out = new Map<string, ConversationRef>();
  for (const b of sel.batches) {
    for (const c of b.conversations) {
      if (c.key.startsWith('msg:')) continue;
      const own = c.lines.filter((l) => !l.earlier);
      if (!own.length) continue;
      const first = own[0]!.item.occurredAt;
      const last = own[own.length - 1]!.item.occurredAt;
      const prev = out.get(c.key);
      const ref: ConversationRef = c.key.startsWith('dm:') ? { key: c.key, channelId: c.key.slice(3), firstAt: first, lastAt: last } : { key: c.key, threadRef: c.key, firstAt: first, lastAt: last };
      out.set(c.key, prev ? { ...prev, firstAt: prev.firstAt < first ? prev.firstAt : first, lastAt: prev.lastAt > last ? prev.lastAt : last } : ref);
    }
  }
  return [...out.values()];
}

/**
 * Select and batch. `items` are this run's recorded items (dedupeKey → item), `ids` dedupeKey → sourceItemId,
 * `outcomes` sourceItemId → what the traversal did. Only Slack messages are considered. `opts.prior` carries earlier
 * runs' noise verdicts forward; `opts.extra` adds the conversation's lines from earlier runs as context.
 */
export function selectSlackTriage(
  items: Map<string, NormalizedSourceItem>,
  ids: Map<string, string>,
  outcomes: Map<string, string[]>,
  ctx: Pick<ScanContext, 'me'>,
  cfg: Pick<TriageConfig, 'batchSize' | 'maxBatches'>,
  opts: SelectOptions = {},
): TriageSelection {
  const me = ctx.me.slackId;
  const msgs = [...items.entries()].filter(([, it]) => it.kind === 'message' && it.connector === 'slack');
  const mineOrToMe = (it: NormalizedSourceItem) => !!it.author?.isMe || !!payloadOf(it).toMe || (!!me && (it.excerpt ?? '').includes(`<@${me}`));
  const isDm = isDmItem;
  const myThreads = new Set(msgs.filter(([, it]) => mineOrToMe(it) && it.threadRef).map(([, it]) => it.threadRef!));
  const convKey = triageConversationKey;

  const convs = new Map<string, TriageLine[]>();
  const decisions = { trivial: [] as string[], handled: [] as string[], skipped: [] as string[], dropped: [] as string[] };
  let qualifying = 0;
  let trivial = 0;
  let handled = 0;
  for (const [key, it] of msgs) {
    const sid = ids.get(key);
    if (!sid) continue;
    const q = isDm(it) || mineOrToMe(it) || (!!it.threadRef && myThreads.has(it.threadRef));
    // TRI-NOISE: an earlier run's noise verdict, or an earlier link (non-context evidence), carries forward.
    const prior = opts.prior?.get(sid);
    const carried = prior?.v === 'noise' ? `noise:earlier run${prior.why ? ` (${clip(prior.why, 60)})` : ''}` : prior?.v === 'act' && prior.why === 'linked' ? 'linked:earlier run' : undefined;
    const done = carried && !outcomes.get(sid)?.some((d) => HANDLED.test(d)) ? [...(outcomes.get(sid) ?? []), carried] : outcomes.get(sid);
    let needs = false;
    if (q) {
      qualifying += 1;
      if (done?.some((d) => HANDLED.test(d) || d.startsWith('noise:earlier run') || d.startsWith('linked:earlier run'))) {
        handled += 1;
        decisions.handled.push(sid);
      } else if (isTrivial(it.excerpt)) {
        trivial += 1;
        decisions.trivial.push(sid);
      } else needs = true;
    } else decisions.skipped.push(sid);
    const k = convKey(it);
    // Non-qualifying messages only matter as context of a conversation that has qualifying ones.
    const line: TriageLine = { ref: it.externalId, sourceItemId: sid, item: it, needs, ...(done?.length ? { done } : {}) };
    convs.set(k, [...(convs.get(k) ?? []), line]);
  }
  const conversations: TriageConversation[] = [];
  for (const [k, own] of convs) {
    if (!own.some((l) => l.needs)) continue;
    const seen = new Set(own.map((l) => l.sourceItemId));
    const lines = [...own, ...(opts.extra?.get(k) ?? []).filter((l) => !seen.has(l.sourceItemId)).map((l) => ({ ...l, needs: false, earlier: true }))];
    lines.sort((a, b) => tsOf(a.item) - tsOf(b.item));
    addressConversation(lines, ctx.me);
    conversations.push({ key: k, title: titleOf(k, lines, me), lines });
  }
  conversations.sort((a, b) => tsOf(a.lines.find((l) => l.needs)!.item) - tsOf(b.lines.find((l) => l.needs)!.item));

  // Pack: a conversation larger than a batch is cut into chunks; each chunk keeps up to 3 earlier lines as context.
  const chunks: TriageConversation[] = [];
  for (const c of conversations) {
    const flush = (s: number, e: number) => {
      const lines = [...c.lines.slice(Math.max(0, s - 3), s).map((l) => ({ ...l, needs: false })), ...c.lines.slice(s, e)];
      if (lines.some((l) => l.needs)) chunks.push({ key: c.key, title: c.title, lines: trimContext(lines) });
    };
    let start = 0;
    let n = 0;
    c.lines.forEach((l, i) => {
      if (!l.needs) return;
      if (n === cfg.batchSize) {
        flush(start, i);
        start = i;
        n = 0;
      }
      n += 1;
    });
    flush(start, c.lines.length);
  }
  const batches: TriageBatch[] = [];
  for (const ch of chunks) {
    const n = ch.lines.filter((l) => l.needs).length;
    const last = batches[batches.length - 1];
    if (last && last.needs + n <= cfg.batchSize) {
      last.conversations.push(ch);
      last.needs += n;
    } else batches.push({ conversations: [ch], needs: n });
  }
  const needing = batches.reduce((a, b) => a + b.needs, 0);
  const kept = cfg.maxBatches == null ? batches : batches.slice(0, cfg.maxBatches);
  for (const b of batches.slice(kept.length)) for (const c of b.conversations) for (const l of c.lines) if (l.needs) decisions.dropped.push(l.sourceItemId);
  return { batches: kept, qualifying, needing, trivial, handled, dropped: needing - kept.reduce((a, b) => a + b.needs, 0), decisions };
}

/**
 * Keep context lines near the messages that need a verdict: up to TRIAGE_CONTEXT.before lines before the first one (the
 * conversation so far, earlier runs included: who is asking whom), 4 before each later one, the reply right after each,
 * and up to TRIAGE_CONTEXT.after replies after the last one (my answer, recorded by any run).
 */
function trimContext(lines: TriageLine[]): TriageLine[] {
  const keep = new Set<number>();
  const needing = lines.flatMap((l, i) => (l.needs ? [i] : []));
  if (!needing.length) return [];
  needing.forEach((i, n) => {
    keep.add(i);
    for (let j = Math.max(0, i - (n === 0 ? TRIAGE_CONTEXT.before : 4)); j < i; j++) keep.add(j);
    if (i + 1 < lines.length && !lines[i + 1]!.needs) keep.add(i + 1); // the reply right after (my answer, a thanks)
  });
  const last = needing[needing.length - 1]!;
  for (let j = last + 1; j < Math.min(lines.length, last + 1 + TRIAGE_CONTEXT.after); j++) keep.add(j);
  return lines.filter((_, i) => keep.has(i));
}

function titleOf(key: string, lines: TriageLine[], me: string | undefined): string {
  const it = lines[0]!.item;
  const p = payloadOf(it);
  const others = new Map<string, string>();
  for (const l of lines) {
    for (const x of [l.item.author, ...(l.item.participants ?? [])]) {
      if (x?.externalId && x.externalId !== me && !x.isMe) others.set(x.externalId, x.name || x.externalId);
    }
  }
  const who = [...others.values()].slice(0, 6).join(', ');
  if (key.startsWith('dm:')) return `${p.channelType === 'mpim' ? 'Group DM' : 'DM'} ${p.channelId ?? ''}${who ? ` · with ${who}` : ''}`;
  return `${p.channelName ? `#${p.channelName}` : 'Channel'} ${p.channelId ?? ''} · thread ${it.threadRef?.split(':').pop() ?? ''}`;
}

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const hhmm = (it: NormalizedSourceItem) => it.occurredAt.slice(0, 16).replace('T', ' ');

/** Who a message opens by addressing, with Slack ids where it @-mentions them (undefined: nobody in particular). */
function leadAddress(text: string | undefined, me: { slackId?: string; name: string }): { me: boolean; others: Array<{ id?: string; name: string }> } | undefined {
  const t = (text ?? '').trim();
  const greeting = /^(?:hi|hey|hello|good (?:morning|afternoon|evening))[,!]?\s+/i.exec(t);
  const rest = greeting ? t.slice(greeting[0].length) : t;
  const lead = /^(?:\s*<@([A-Z0-9]+)(?:\|([^>]*))?>[\s,:!]*)+/.exec(rest);
  if (lead) {
    const ids = [...lead[0].matchAll(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g)].map((m) => ({ id: m[1]!, name: m[2] || m[1]! }));
    return { me: ids.some((x) => x.id === me.slackId), others: ids.filter((x) => x.id !== me.slackId) };
  }
  if (greeting) {
    const name = /^([A-Z][A-Za-z'-]+)\b/.exec(rest)?.[1];
    if (name) return name.toLowerCase() === me.name.split(/\s+/)[0]!.toLowerCase() ? { me: true, others: [] } : { me: false, others: [{ name }] };
  }
  return undefined;
}

/**
 * Who a message opens by addressing: leading @-mentions (`<@U…|Name>`) or a greeting with a name ("Good morning
 * Jay!", "Hi Ana,"). Returns names other than me, or 'me', or undefined when the message addresses nobody in particular.
 */
export function addresseeOf(text: string | undefined, me: { slackId?: string; name: string }): string[] | 'me' | undefined {
  const a = leadAddress(text, me);
  if (!a) return undefined;
  return a.me ? 'me' : a.others.map((x) => x.name);
}

/**
 * TRI-3: a message to a whole channel (@channel, @here, @everyone) or to a list (me among three or more @-mentioned
 * people) is not addressed to me alone. Undefined when it is neither.
 */
export function broadcastOf(text: string | undefined, me: { slackId?: string }): { to: 'channel' } | { to: 'list'; others: number } | undefined {
  const t = text ?? '';
  if (/<!(?:channel|here|everyone)(?:\|[^>]*)?>|(?:^|\s)@(?:channel|here|everyone)\b/i.test(t)) return { to: 'channel' };
  const ids = new Set([...t.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!));
  if (me.slackId && ids.has(me.slackId) && ids.size >= 3) return { to: 'list', others: ids.size - 1 };
  return undefined;
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Does an addressee name or id mean this author (full name, first name, or Slack id)? */
function names(author: NormalizedSourceItem['author'], who: Array<{ id?: string; name: string }> | string[]): boolean {
  if (!author) return false;
  const full = norm(author.name);
  const first = full.split(/\s+/)[0] ?? '';
  return who.some((w) => {
    const x = typeof w === 'string' ? { name: w } : w;
    if (x.id && author.externalId && x.id === author.externalId) return true;
    const n = norm(x.name);
    return !!n && (n === full || n === first || (!!author.externalId && n === norm(author.externalId)));
  });
}

/**
 * TRI-2 addressee continuation, over a conversation's lines in time order (group DMs and threads; a 1:1 DM is always
 * between me and them). Explicit addressing wins; otherwise an unaddressed message right after someone addressed its
 * author goes back to that person, and an unaddressed follow-on by the same author keeps that author's addressee.
 * Before, each message was read alone, so a follow-on in someone else's two-way exchange looked like an ask of me.
 */
export function addressConversation(lines: TriageLine[], me: { slackId?: string; name: string }): void {
  let prev: { line: TriageLine; who: Array<{ id?: string; name: string }>; toMe: boolean } | undefined;
  for (const l of lines) {
    const it = l.item;
    const p = payloadOf(it);
    const mine = !!it.author?.isMe;
    const text = it.excerpt;
    const b = mine ? undefined : broadcastOf(text, me);
    const lead = leadAddress(text, me);
    let addr: LineAddress | undefined = b ?? (lead ? (lead.me && !mine ? { to: 'me' } : lead.others.length ? { to: 'others', names: lead.others.map((x) => x.name) } : undefined) : undefined);
    let who = lead ? lead.others : [];
    let toMe = !!lead?.me && !mine;
    if (!addr && !b && p.channelType !== 'im' && prev) {
      const pa = prev.line.item.author;
      const sameAuthor = !!pa && !!it.author && (pa.isMe ? mine : !mine && (pa.externalId ?? pa.name) === (it.author.externalId ?? it.author.name));
      if (sameAuthor && (prev.toMe || prev.who.length)) {
        // The same author goes on: same addressee.
        addr = prev.toMe ? { to: 'me', via: 'continues' } : { to: 'others', names: prev.who.map((x) => x.name), via: 'continues' };
        who = prev.who;
        toMe = prev.toMe;
      } else if (!sameAuthor && pa) {
        // A reply right after someone addressed its author goes back to them.
        const addressedMe = mine ? prev.toMe : names(it.author, prev.who);
        if (addressedMe) {
          if (pa.isMe) {
            addr = { to: 'me', via: 'continues' };
            toMe = true;
            who = [];
          } else {
            const n = { ...(pa.externalId ? { id: pa.externalId } : {}), name: pa.name || pa.externalId || 'someone' };
            addr = { to: 'others', names: [n.name], via: 'continues' };
            who = [n];
            toMe = false;
          }
        }
      }
    }
    if (addr) l.addr = addr;
    prev = { line: l, who, toMe };
  }
}

/** The batch as the triage prompt shows it. VERDICT lines need one verdict each; the rest is context. */
export function renderTriageBatch(b: TriageBatch, ctx: Pick<ScanContext, 'me'>, o: { index: number; total: number; escalate?: boolean }): string {
  const me = ctx.me;
  const out = [
    `## Messages (${o.escalate ? 'escalation' : 'triage'} batch ${o.index}/${o.total})`,
    `me = ${me.name}${me.slackId ? ` (${me.slackId})` : ''}. Times are UTC. Cite a message by its [ref].`,
    `Give every VERDICT line exactly one verdict${o.escalate ? ' (act or noise; this is the final call)' : ''}.`,
  ];
  for (const c of b.conversations) {
    out.push('', `### ${c.title}`);
    for (const l of c.lines) {
      const it = l.item;
      const p = payloadOf(it);
      const author = it.author?.isMe ? 'me' : (it.author?.name || it.author?.externalId || 'someone');
      const to = addressTag(l, me);
      const reply = p.isReply ? ' (thread reply)' : '';
      const tag = l.needs ? 'VERDICT' : l.done?.length ? `done: ${l.done.slice(0, 3).join(', ')}` : l.earlier ? 'context (earlier)' : 'context';
      out.push(`- [${l.ref}] ${hhmm(it)} · ${author}${to}${reply} · ${tag}${l.unsureWhy ? ` · first pass unsure: ${clip(l.unsureWhy, 160)}` : ''}`);
      const files = it.fileRefs?.length ? ` [files: ${it.fileRefs.slice(0, 3).join(' ')}]` : '';
      out.push(`  ${clip(it.excerpt, l.needs ? 900 : 300).replace(/\n+/g, '\n  ')}${files}`);
    }
  }
  return out.join('\n');
}

/** The `→` part of a line: who it is addressed to (TRI-2, TRI-3). My own lines show only whom I addressed. */
function addressTag(l: TriageLine, me: { slackId?: string; name: string }): string {
  const it = l.item;
  const a: LineAddress | undefined =
    l.addr ??
    (() => {
      // A line rendered without addressConversation (tests, older callers): read it alone.
      const b = it.author?.isMe ? undefined : broadcastOf(it.excerpt, me);
      if (b) return b;
      const x = addresseeOf(it.excerpt, me);
      return x === 'me' ? { to: 'me' as const } : x ? { to: 'others' as const, names: x } : undefined;
    })();
  const cont = (x: LineAddress) => 'via' in x && x.via === 'continues';
  if (it.author?.isMe) return a?.to === 'others' ? ` → ${a.names.slice(0, 3).join(', ')}${cont(a) ? ' (continues our exchange)' : ''}` : '';
  if (!a) return payloadOf(it).toMe ? ' → me' : '';
  switch (a.to) {
    case 'me':
      return cont(a) ? ' → me (replies to my message)' : ' → me';
    case 'others':
      return ` → ${a.names.slice(0, 3).join(', ')} (not me${cont(a) ? ': continues their exchange' : ''})`;
    case 'channel':
      return ' → everyone (@channel/@here)';
    case 'list':
      return ` → me and ${a.others} others (a list)`;
  }
}
