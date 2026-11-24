/**
 * Gmail deterministic fetcher (SCANNER.md §2.1, brief 09 §5.4).
 *
 * Scopes: `inbox` (everything received) and `sent`. Cursor per scope = JSON { lastEpoch, seen{id:epoch} }.
 * `internalDate` / `historyId` are not exposed by the bridge, so: search by epoch `after:`/`before:` with an overlap,
 * dedupe by message id (seen set, 7 days) and by dedupeKey downstream.
 *
 * Output items: kind `email`, one per message. Bodies are fetched (batch tool) so the skill can extract asks.
 * Replied-by-me is derived from the thread (inbox scope) so "I replied" is a completion signal the skill can link.
 */
import type { ConnectorHealthProbe, CoverageObject, Cursor, DeterministicFetcher, FetchResult, NormalizedSourceItem, PersonRef, TimeWindow } from '@/scanner/types';
import { redact, redactExcerpt } from '../redact';
import { encodeCursor, decodeCursor, extractDriveIds, extractUrls, h16, htmlToText, looksLikeHtml, normalizeText, parseAddress, splitAddressList, systemClock, throwIfAborted, truncate, type Clock } from '../util';
// injected: the connector runtime's text port (src/connectors/runtime: GoogleWorkspaceClient behind direct_mcp)
import type { TextToolPort as GoogleTools } from '../runtime/types';
import { parseGmailBatch, parseGmailSearch, parseGmailThread, splitThreadBatch, type GmailMessage } from './parse';

export interface Me {
  email: string;
  name?: string;
  /** Other addresses that are "me" (send-as, old domains). */
  aliases?: string[];
}

export interface GmailFetcherOptions {
  google: GoogleTools;
  me: Me;
  clock?: Clock;
  /** Seconds of overlap subtracted from `after:` (late indexing). */
  overlapSec?: number;
  searchPageSize?: number;
  maxListPages?: number;
  batchSize?: number;
  /** Threads looked up per run; unset = every chosen message's thread (caps audit 2026-11-21: was 20 of up to 40). */
  maxThreadLookups?: number;
  maxBodyChars?: number;
  /** Extra sender patterns to flag as bulk. */
  noiseSenders?: RegExp[];
}

interface GmailCursorState {
  lastEpoch: number;
  seen: Record<string, number>;
}

const SEEN_TTL_SEC = 7 * 86400;
const BULK_SENDER = /(no-?reply|do-?not-?reply|notifications?@|newsletter|employeecomms@|mailer-daemon|marketing|bounce|@.*\.(?:concursolutions|amazonses)\.com)/i;
const CAL_NOTICE_SUBJECT = /^(?:invitation|updated invitation|canceled event|cancell?ed|accepted|declined|tentatively accepted|proposed new time)\b/i;
/** R15 (SCN-12): Google Docs/Sheets/Slides notification senders (comments, action items, shares). */
const DOCS_SENDER = /(?:comments-noreply|drive-shares(?:-dm)?-noreply|docs-noreply)@(?:docs\.)?google\.com/i;
const DOCS_ACTION_ITEM = /\bassigned (?:you )?an action item\b|\baction item assigned to you\b|\bassigned to you\b/i;
const DOCS_MENTION = /\bmentioned you\b|\b(?:added|tagged) you (?:in|to) a comment\b|\breplied to (?:your|a) comment\b/i;

/**
 * R15 (SCN-12): a Google Docs "assigned you an action item" or comment-mention mail is an ask of me about that doc, not
 * bulk mail (before, its no-reply sender put it in skip rule 4.1). Returns the kind and the doc it is about.
 */
export function docsAskOf(from: string, subject: string, body: string): { kind: 'action_item' | 'mention'; fileId: string | null } | null {
  if (!DOCS_SENDER.test(from)) return null;
  const text = `${subject}\n${body}`;
  const kind = DOCS_ACTION_ITEM.test(text) ? 'action_item' : DOCS_MENTION.test(text) ? 'mention' : null;
  if (!kind) return null;
  return { kind, fileId: extractDriveIds(body)[0] ?? null };
}

/** Removes quoted history and signatures, leaving what the sender newly wrote. */
export function newTextOf(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^On .{5,200}(wrote|écrit|escribió):?\s*$/.test(l) || (/^On .{5,120}$/.test(l) && /wrote:\s*$/.test(lines[i + 1] ?? ''))) break;
    if (/^_{8,}\s*$/.test(l) && /^From:/.test(lines[i + 1] ?? '')) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l)) break;
    if (/^From:\s.+/.test(l) && /^(Sent|Date):/.test(lines[i + 1] ?? '') && out.length > 0) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class GmailFetcher implements DeterministicFetcher {
  readonly connector = 'gmail' as const;
  private readonly g: GoogleTools;
  private readonly me: Me;
  private readonly clock: Clock;
  private readonly o: Required<Omit<GmailFetcherOptions, 'google' | 'me' | 'clock' | 'noiseSenders'>> & { noiseSenders: RegExp[] };

  constructor(opts: GmailFetcherOptions) {
    this.g = opts.google;
    this.me = opts.me;
    this.clock = opts.clock ?? systemClock;
    this.o = {
      overlapSec: opts.overlapSec ?? 600,
      searchPageSize: opts.searchPageSize ?? 50,
      maxListPages: opts.maxListPages ?? 6,
      batchSize: opts.batchSize ?? 10,
      maxThreadLookups: opts.maxThreadLookups ?? Number.POSITIVE_INFINITY,
      maxBodyChars: opts.maxBodyChars ?? 12_000,
      noiseSenders: opts.noiseSenders ?? [],
    };
  }

  async scopes(): Promise<string[]> {
    return ['inbox', 'sent'];
  }

  health(): Promise<ConnectorHealthProbe> {
    return this.g.health();
  }

  /** Reconcile listing: every message id in the window, as `email` coverage refs (matches what fetch() records). */
  async listForReconcile(scope: string, window: TimeWindow, opts: { signal: AbortSignal }): Promise<CoverageObject[]> {
    const q = this.query(scope, Math.floor(Date.parse(window.from) / 1000), Math.ceil(Date.parse(window.to) / 1000));
    const { hits } = await this.list(q, opts.signal);
    return hits.map((h) => ({ kind: 'email' as const, ref: h.id, meta: { threadId: h.threadId, scope } }));
  }

  private isMe(addr: string | undefined): boolean {
    if (!addr) return false;
    const a = addr.toLowerCase();
    return a === this.me.email.toLowerCase() || (this.me.aliases ?? []).some((x) => x.toLowerCase() === a);
  }

  private person(raw: string): PersonRef {
    const p = parseAddress(raw);
    const isMe = this.isMe(p.email);
    const domain = p.email?.split('@')[1];
    const myDomain = this.me.email.split('@')[1];
    return { name: p.name, email: p.email, isMe, isExternal: domain ? domain !== myDomain && !domain.endsWith('.' + myDomain) : undefined };
  }

  private query(scope: string, fromEpoch: number, toEpoch: number, extra = ''): string {
    const base =
      scope === 'sent'
        ? 'in:sent'
        : 'in:anywhere -in:sent -in:drafts -in:spam -in:trash -category:promotions -category:social';
    return `${base} after:${fromEpoch} before:${toEpoch}${extra ? ' ' + extra : ''}`;
  }

  /** Lists every message id for the query (cheap: no bodies). Oldest first. */
  private async list(query: string, signal: AbortSignal): Promise<{ hits: Array<{ id: string; threadId?: string; webLink?: string }>; truncated: boolean }> {
    const all: Array<{ id: string; threadId?: string; webLink?: string }> = [];
    let token: string | undefined;
    let pages = 0;
    for (;;) {
      throwIfAborted(signal);
      const text = await this.g.call('search_gmail_messages', { query, page_size: this.o.searchPageSize, ...(token ? { page_token: token } : {}) }, { signal });
      const page = parseGmailSearch(text);
      all.push(...page.hits);
      pages++;
      token = page.nextPageToken;
      if (!token || page.hits.length === 0) return { hits: all.reverse(), truncated: false };
      if (pages >= this.o.maxListPages) return { hits: all.reverse(), truncated: true };
    }
  }

  async fetch(scope: string, cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal; limit?: number }): Promise<FetchResult> {
    if (scope !== 'inbox' && scope !== 'sent') throw new Error(`gmail: unknown scope ${scope}`);
    const now = this.clock();
    const prev = decodeCursor<GmailCursorState>(cursor, { lastEpoch: 0, seen: {} });
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const fromEpoch = Math.floor(Date.parse(window.from) / 1000) - this.o.overlapSec;
    const toEpoch = Math.min(Math.ceil(Date.parse(window.to) / 1000), nowEpoch + 60);
    const limit = opts.limit ?? 40;

    const q = this.query(scope, fromEpoch, toEpoch);
    const { hits, truncated: listTruncated } = await this.list(q, opts.signal);
    const attachIds = new Set((await this.list(this.query(scope, fromEpoch, toEpoch, 'has:attachment'), opts.signal)).hits.map((h) => h.id));

    const unseen = hits.filter((h) => prev.seen[h.id] === undefined);
    const chosen = unseen.slice(0, limit);
    const overLimit = unseen.length > chosen.length;

    // Bodies in batches.
    const messages = new Map<string, GmailMessage>();
    for (let i = 0; i < chosen.length; i += this.o.batchSize) {
      throwIfAborted(opts.signal);
      const ids = chosen.slice(i, i + this.o.batchSize).map((h) => h.id);
      const text = await this.g.call('get_gmail_messages_content_batch', { message_ids: ids, format: 'full' }, { signal: opts.signal });
      for (const m of parseGmailBatch(text)) messages.set(m.id, m);
    }

    // Thread context for inbox scope: did I reply after this message?
    const threadInfo = new Map<string, { messages: Array<{ from: string; dateIso?: string }> }>();
    if (scope === 'inbox') {
      const tids = [...new Set(chosen.map((h) => h.threadId).filter((x): x is string => !!x))].slice(0, this.o.maxThreadLookups);
      for (let i = 0; i < tids.length; i += 5) {
        throwIfAborted(opts.signal);
        const text = await this.g.call('get_gmail_threads_content_batch', { thread_ids: tids.slice(i, i + 5) }, { signal: opts.signal });
        for (const chunk of splitThreadBatch(text)) {
          const t = parseGmailThread(chunk);
          if (t.threadId) threadInfo.set(t.threadId, { messages: t.messages });
        }
      }
    }

    const items: NormalizedSourceItem[] = [];
    const coverage: CoverageObject[] = [
      { kind: 'mailbox_range', ref: `gmail:${scope}`, from: window.from, to: window.to, meta: { query: q, listed: hits.length, fetched: chosen.length, listTruncated } },
    ];
    let maxEpoch = prev.lastEpoch;
    // Progress inside THIS window (an incomplete run resumes from here). prev.lastEpoch may come from a later window
    // (a cold-start head run, the live cursor during a reconcile re-scan): using it skipped the rest of a past
    // window while its coverage was claimed (stress finding G-1).
    let windowMaxEpoch = 0;
    const seen = { ...prev.seen };

    for (const h of chosen) {
      const m = messages.get(h.id);
      if (!m) {
        // Listed but the batch did not return it: leave it unseen so the next run retries; do not claim coverage.
        continue;
      }
      const item = this.toItem(scope, h, m, attachIds.has(h.id), threadInfo.get(h.threadId ?? ''));
      items.push(item);
      const ep = m.dateIso ? Math.floor(Date.parse(m.dateIso) / 1000) : nowEpoch;
      maxEpoch = Math.max(maxEpoch, ep);
      windowMaxEpoch = Math.max(windowMaxEpoch, ep);
      seen[h.id] = ep;
      coverage.push({ kind: 'email', ref: h.id, from: m.dateIso, to: m.dateIso, meta: { threadId: h.threadId, scope } });
    }

    const missing = chosen.filter((h) => !messages.has(h.id));
    const complete = !overLimit && !listTruncated && missing.length === 0;

    // Prune the seen set.
    for (const [id, ep] of Object.entries(seen)) if (ep < nowEpoch - SEEN_TTL_SEC) delete seen[id];

    const atMs = complete ? Math.min(Date.parse(window.to), now.getTime()) : Math.min(Math.max(Date.parse(window.from), windowMaxEpoch * 1000), Date.parse(window.to));
    const next: GmailCursorState = { lastEpoch: maxEpoch, seen };
    return { items, coverage, nextCursor: encodeCursor(next, new Date(atMs).toISOString()), complete };
  }

  private toItem(scope: string, hit: { id: string; threadId?: string; webLink?: string }, m: GmailMessage, hasAttachment: boolean, thread?: { messages: Array<{ from: string; dateIso?: string }> }): NormalizedSourceItem {
    const rawBody = looksLikeHtml(m.body) ? htmlToText(m.body) : m.body;
    const fresh = newTextOf(rawBody);
    const fromP = this.person(m.from);
    const toList = splitAddressList(m.to).map((a) => this.person(a));
    const ccList = splitAddressList(m.cc).map((a) => this.person(a));
    const toMe = toList.some((p) => p.isMe);
    const ccMe = ccList.some((p) => p.isMe);
    const direction = scope === 'sent' ? 'sent' : 'received';

    let repliedByMe: boolean | undefined;
    let threadSize: number | undefined;
    let lastFromMe: boolean | undefined;
    if (thread) {
      threadSize = thread.messages.length;
      const t0 = m.dateIso ? Date.parse(m.dateIso) : 0;
      repliedByMe = thread.messages.some((x) => this.isMe(parseAddress(x.from).email) && (x.dateIso ? Date.parse(x.dateIso) > t0 : false));
      const last = thread.messages[thread.messages.length - 1];
      lastFromMe = last ? this.isMe(parseAddress(last.from).email) : undefined;
    }

    const fileRefs = extractDriveIds(rawBody);
    const urls = extractUrls(fresh).slice(0, 15);
    const docsAsk = scope === 'inbox' ? docsAskOf(m.from, m.subject, rawBody) : null;
    const bulk = !docsAsk && (BULK_SENDER.test(m.from) || this.o.noiseSenders.some((r) => r.test(m.from)));
    const full = redact(truncate(rawBody, this.o.maxBodyChars));
    const freshR = redact(truncate(fresh, this.o.maxBodyChars));
    const ex = redactExcerpt(normalizeText(fresh).slice(0, 1200));
    const subjectR = redact(m.subject);
    const mentionsAttachment = /\b(attached|attaching|attachment|see attached|enclosed)\b/i.test(fresh) || /\[cid:/.test(rawBody);

    const contentHash = h16(m.subject, m.from, m.to, m.cc, normalizeText(rawBody));
    return {
      connector: 'gmail',
      kind: 'email',
      externalId: hit.id,
      dedupeKey: `gmail:${hit.id}`,
      contentHash,
      occurredAt: m.dateIso ?? this.clock().toISOString(),
      author: fromP,
      participants: [...toList, ...ccList],
      permalink: hit.webLink ?? m.webLink,
      title: subjectR.text,
      excerpt: ex.text,
      redacted: full.redacted || freshR.redacted || subjectR.redacted || ex.redacted,
      threadRef: hit.threadId ? `gmail-thread:${hit.threadId}` : undefined,
      fileRefs: fileRefs.length ? fileRefs : undefined,
      payload: {
        direction,
        scope,
        subject: subjectR.text,
        from: m.from,
        to: m.to,
        cc: m.cc,
        // R15: a Docs action item / comment mention is addressed to me, whatever the To line says.
        toMe: toMe || !!docsAsk,
        ccMe,
        ...(docsAsk ? { docsAsk: { kind: docsAsk.kind, ...(docsAsk.fileId ? { fileRef: docsAsk.fileId } : {}) } } : {}),
        replyTo: m.inReplyTo,
        messageIdHeader: m.messageIdHeader,
        snippet: ex.text.slice(0, 200),
        bodyNew: freshR.text,
        bodyFull: full.text,
        urls,
        hasAttachment,
        mentionsAttachment,
        bulk,
        calendarNotice: CAL_NOTICE_SUBJECT.test(m.subject),
        repliedByMe,
        threadSize,
        lastMessageFromMe: lastFromMe,
      },
    };
  }
}
