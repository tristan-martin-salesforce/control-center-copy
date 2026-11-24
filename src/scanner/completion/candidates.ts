/**
 * Deterministic candidate collection for the completion pass (no model). For one open item, which newly arrived
 * source items plausibly say it is done? The rules (docs/reference/SCANNER.md §4.9):
 *
 *   same_thread        the same Slack thread as its origin / progress evidence                       strong
 *   same_dm            the same Slack DM (or group DM) as that evidence                              strong
 *   same_email_thread  the same Gmail thread                                                         strong
 *   to_asker           my message or email to the asker (DM, email, @mention) after the ask         medium
 *   context_thread     a thread the item has only `context` evidence in                              medium
 *   same_channel       my or the asker's message in the same Slack channel                           medium
 *   from_asker         the asker writing in one of the above places or to me directly                medium
 *   same_file          a Drive file the item references (a revision, or a link to it)                medium
 *   same_event         its calendar event changed, or I scheduled one with the asker                 medium
 *   same_account       my message on the item's account that shares two title keywords               weak
 *   ack                the asker's "got it, thanks" right after my line in the item's conversation    medium (R7)
 *   file_revision      a Drive revision of a file the item references                                medium (R7)
 *   meeting_notes      notes of the item's meeting, or notes with the asker naming the item           medium (R7)
 *   session            a Claude session that names the item (or shares its file)                     medium (R7)
 *
 * Slack, Gmail, Calendar, Drive, Gemini notes and Claude sessions are candidates (Org62 has its own read-backs).
 * A pleasantry is dropped unless it is the asker acknowledging my line (R7: before, "got it, thanks" was always
 * dropped, so the check never saw the asker confirm). Everything here is pure: the pass feeds it what the store read.
 */
import { tokenize, toMs } from '../store-memory';
import type { PersonRef } from '../types';
import { STRONG_RELATIONS, type Candidate, type CompletionEvidence, type CompletionItem, type CompletionSource, type Relation } from './types';

export const CANDIDATE_CONNECTORS = new Set(['slack', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions']);

const lower = (s: string) => s.trim().toLowerCase();

/** Identity keys of a person: Slack/Org62 id, email, display name (lower-cased). */
export function personKeys(p: PersonRef | undefined): string[] {
  if (!p || p.isMe) return [];
  return [p.externalId, p.email, p.name].filter((x): x is string => !!x && !!x.trim()).map(lower);
}

/** Slack channel id from `C123:1730812345.000100` or `slack:C123:1730812345.000100`. */
export function slackChannel(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const m = /^(?:slack:)?([A-Z0-9]{6,}):\d{9,11}(?:\.\d+)?$/.exec(ref);
  return m?.[1];
}

const isDmChannel = (ch: string) => /^D[A-Z0-9]+$/.test(ch);

/** `drive:ID`, a Docs/Drive URL or a bare id → the Drive id; other URLs → lower-cased without the query. */
export function normFileRef(ref: string): string {
  const r = ref.trim();
  const drive = /^drive:(.+)$/.exec(r);
  if (drive) return drive[1]!;
  const url = /docs\.google\.com\/(?:[a-z]+\/)*d\/([A-Za-z0-9_-]{15,})|drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]{15,})/.exec(r);
  if (url) return (url[1] ?? url[2])!;
  if (/^https?:\/\//i.test(r)) return r.toLowerCase().replace(/[?#].*$/, '');
  return r;
}

/** Drive file id of a revision's external id (`<fileId>@<modifiedTime>`). */
const driveFileOf = (s: { connector: string; externalId: string }) => (s.connector === 'drive' ? s.externalId.replace(/@.*$/, '') : undefined);

/** What the rules need to know about one item, derived once. */
export interface ItemFacts {
  /** When it was asked (or promised): the earliest origin evidence, else the earliest evidence, else creation. */
  askAt: number;
  askAtIso: string;
  /** The asker / whom I promised: identity keys. */
  counterpartKeys: Set<string>;
  /** Display names, for the prompt. */
  counterpartNames: string[];
  strongThreads: Set<string>;
  contextThreads: Set<string>;
  dmChannels: Set<string>;
  channels: Set<string>;
  emailThreads: Set<string>;
  fileRefs: Set<string>;
  eventRefs: Set<string>;
  accounts: Set<string>;
  keywords: Set<string>;
  originIds: Set<string>;
  completionIds: Set<string>;
  /** The origin evidence, oldest first (the prompt quotes the ask). */
  origins: CompletionEvidence[];
}

export function itemFacts(item: CompletionItem): ItemFacts {
  const ev = [...item.evidence].sort((a, b) => (toMs(a.occurredAt) ?? 0) - (toMs(b.occurredAt) ?? 0));
  const live = ev.filter((e) => e.role !== 'context');
  const origins = ev.filter((e) => e.role === 'origin');
  const first = (xs: CompletionEvidence[]) => xs.map((e) => toMs(e.occurredAt)).find((t): t is number => t != null);
  const askAt = first(origins) ?? first(live) ?? toMs(item.createdAt) ?? 0;

  const counterpartKeys = new Set<string>();
  const counterpartNames: string[] = [];
  const addPerson = (p: PersonRef | undefined) => {
    const keys = personKeys(p);
    if (!keys.length) return;
    if (!keys.some((k) => counterpartKeys.has(k)) && p?.name) counterpartNames.push(p.name);
    for (const k of keys) counterpartKeys.add(k);
  };
  addPerson(item.counterparty);
  for (const e of live) if (!e.fromMe) addPerson(e.author);
  // A DM or a small group DM / email: everyone else in it is who I owe (my own promise has no other author).
  for (const e of origins) if ((e.participants?.length ?? 0) <= 8) for (const p of e.participants ?? []) addPerson(p);

  const strongThreads = new Set(live.map((e) => e.threadRef).filter((t): t is string => !!t));
  const contextThreads = new Set(ev.filter((e) => e.role === 'context').map((e) => e.threadRef).filter((t): t is string => !!t && !strongThreads.has(t)));
  const dmChannels = new Set<string>();
  const channels = new Set<string>();
  for (const e of live) {
    if (e.connector !== 'slack') continue;
    const ch = slackChannel(e.externalId) ?? slackChannel(e.threadRef);
    if (!ch) continue;
    const small = (e.participants?.length ?? 0) > 0 && (e.participants?.length ?? 0) <= 8;
    if (isDmChannel(ch) || small) dmChannels.add(ch);
    else channels.add(ch);
  }
  const emailThreads = new Set(live.filter((e) => e.connector === 'gmail' && e.threadRef).map((e) => e.threadRef!));
  const fileRefs = new Set([...item.fileRefs, ...live.flatMap((e) => e.fileRefs)].map(normFileRef));
  for (const e of live) {
    const f = driveFileOf(e);
    if (f) fileRefs.add(f);
  }
  const eventRefs = new Set(ev.filter((e) => e.connector === 'calendar').flatMap((e) => [e.externalId, e.threadRef].filter((x): x is string => !!x)));
  const accounts = new Set([...(item.accountId ? [item.accountId] : []), ...item.accountNames, ...live.flatMap((e) => e.accountHints)].map(lower));
  return {
    askAt,
    askAtIso: new Date(askAt).toISOString(),
    counterpartKeys,
    counterpartNames,
    strongThreads,
    contextThreads,
    dmChannels,
    channels,
    emailThreads,
    fileRefs,
    eventRefs,
    accounts,
    keywords: new Set([...tokenize(item.title), ...tokenize(item.purpose)]),
    originIds: new Set(origins.map((e) => e.sourceItemId)),
    completionIds: new Set(ev.filter((e) => e.role === 'completion').map((e) => e.sourceItemId)),
    origins,
  };
}

/** Slack user ids mentioned in a message (`<@U123>`), lower-cased. */
const mentions = (text: string | undefined) => new Set([...(text ?? '').matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!.toLowerCase()));

/** How a source item relates to the item (empty = not a candidate). */
export function relationsOf(f: ItemFacts, s: CompletionSource): Relation[] {
  const out = new Set<Relation>();
  const ch = s.connector === 'slack' ? (slackChannel(s.externalId) ?? slackChannel(s.threadRef)) : undefined;
  const authorKeys = personKeys(s.author);
  const byAsker = !s.fromMe && authorKeys.some((k) => f.counterpartKeys.has(k));
  const participants = s.participants ?? [];
  const toMeDirectly = participants.some((p) => p.isMe) && participants.length <= 8;
  const toAsker =
    s.fromMe &&
    ((participants.length <= 8 && participants.some((p) => personKeys(p).some((k) => f.counterpartKeys.has(k)))) || [...mentions(s.text)].some((m) => f.counterpartKeys.has(m)));

  if (s.threadRef && f.strongThreads.has(s.threadRef)) out.add(s.connector === 'gmail' ? 'same_email_thread' : 'same_thread');
  else if (s.threadRef && f.contextThreads.has(s.threadRef)) out.add('context_thread');
  if (s.connector === 'gmail' && s.threadRef && f.emailThreads.has(s.threadRef)) out.add('same_email_thread');
  if (ch && f.dmChannels.has(ch)) out.add('same_dm');
  if (ch && f.channels.has(ch) && (s.fromMe || byAsker)) out.add('same_channel');
  if (toAsker) out.add('to_asker');
  if (byAsker && (out.size > 0 || toMeDirectly)) out.add('from_asker');

  const files = new Set(s.fileRefs.map(normFileRef));
  const df = driveFileOf(s);
  if (df) files.add(df);
  const sameFile = [...files].some((x) => f.fileRefs.has(x));
  if (sameFile) out.add('same_file');
  if (sameFile && df && f.fileRefs.has(df)) out.add('file_revision');

  const keywordHits = () => tokenize(`${s.title ?? ''} ${s.text ?? ''}`).filter((k) => f.keywords.has(k)).length;
  if (s.connector === 'gemini_notes') {
    // R7: the notes of the item's own meeting, or a meeting with the asker whose notes name the item.
    const sameEvent = (!!s.threadRef && f.eventRefs.has(s.threadRef)) || f.eventRefs.has(s.externalId);
    const withAsker = participants.some((p) => personKeys(p).some((k) => f.counterpartKeys.has(k)));
    if (sameEvent || (withAsker && keywordHits() >= 2)) out.add('meeting_notes');
    for (const r of ['from_asker', 'to_asker', 'same_thread', 'context_thread'] as const) out.delete(r);
  }
  if (s.connector === 'claude_sessions') {
    // R7: a session working on the item (its title and last line name it, or it touches the item's file).
    if (sameFile || keywordHits() >= 2) out.add('session');
    for (const r of ['from_asker', 'to_asker', 'same_thread', 'context_thread', 'same_account'] as const) out.delete(r);
  }

  if (s.connector === 'calendar') {
    const sameEvent = f.eventRefs.has(s.externalId) || (!!s.threadRef && f.eventRefs.has(s.threadRef));
    const scheduledWithAsker = s.fromMe && participants.some((p) => personKeys(p).some((k) => f.counterpartKeys.has(k)));
    if (sameEvent || scheduledWithAsker) out.add('same_event');
    // A calendar invite is not "a message to the asker" (the event is the relation).
    out.delete('to_asker');
  }

  if (!out.size && s.fromMe && s.accountHints.some((a) => f.accounts.has(lower(a)))) {
    const kw = tokenize(`${s.title ?? ''} ${s.text ?? ''}`);
    if (kw.filter((k) => f.keywords.has(k)).length >= 2) out.add('same_account');
  }
  return [...out];
}

export interface CollectOptions {
  /** Only sources that arrived after this time (ms) count: the item's last check. */
  seenAfter: number;
  /** …and at or before this time (the pass's `through`). */
  seenUntil: number;
  maxPerItem?: number;
}

/**
 * RES-1: a message that settles an ask or a decision ("I'll go ahead and cancel the prep", "no need", "invite sent",
 * "all set", or the asker getting it elsewhere: "PERSON has something, I'll follow up with her"). It ranks first among the candidates: a group DM's closing chatter ("Thanks all, have a good weekend")
 * used to take the last of the six slots ahead of the asker's decision, which was then never judged.
 */
export const RESOLUTION_RE = /\b(cancel(?:l?ed|l?ing|s)?|no need|not needed|never ?mind|nvm|all set|we'?re (?:good|set)|i'?m good|sorted|resolved|handled|taken care of|invite sent|sent (?:the |an )?invite|booked|went ahead|go ahead and|no longer needed|not necessary|we'?ll skip|skip (?:it|the)|(?:has|have|had) (?:something|one|it|that)|i'?ll (?:follow up|check|ask|get it) (?:with|from) (?:her|him|them)|get (?:it|that|one) from|got (?:it|that|one) from)\b/i;
/** Pleasantries alone are never a completion: they only crowd the slots. */
const PLEASANTRY_RE = /^(?:(?:thanks?|thank you|ty|thx|great|awesome|fantastic|perfect|cool|nice|sounds good|ok(?:ay)?|got it|see (?:you|ya)|have (?:a|an) (?:good|great|amazing|nice) (?:one|day|weekend|night|evening)|bye|cheers|all|everyone|team|folks|!|\.|,)\s*)+$/i;

export function isPleasantry(text: string | undefined): boolean {
  const t = (text ?? '').replace(/<@[^>]+>/g, ' ').replace(/:[a-z0-9_+-]+:/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 80 && PLEASANTRY_RE.test(t);
}

/**
 * The candidates for one item, strongest first (at most `maxPerItem`), returned oldest first so the prompt
 * reads as a timeline. A source counts only when it happened after the ask (Calendar: arrived after it).
 */
/** The conversation a Slack/Gmail line belongs to (thread, else DM channel), for "after my line" checks. */
function conversationOf(x: { connector: string; externalId: string; threadRef?: string }): string | undefined {
  if (x.connector === 'gmail') return x.threadRef ? `g:${x.threadRef}` : undefined;
  if (x.connector !== 'slack') return undefined;
  const ch = slackChannel(x.externalId) ?? slackChannel(x.threadRef);
  if (ch && isDmChannel(ch)) return `d:${ch}`;
  return x.threadRef ? `t:${x.threadRef}` : undefined;
}

export function collectCandidates(item: CompletionItem, sources: CompletionSource[], o: CollectOptions, facts = itemFacts(item)): Candidate[] {
  const out: Candidate[] = [];
  // R7: when did I last write in each conversation after the ask (my evidence lines and anything the store read)?
  const mine = new Map<string, number[]>();
  for (const x of [...item.evidence.filter((e) => e.fromMe), ...sources.filter((s) => s.fromMe)]) {
    const conv = conversationOf(x);
    const at = toMs(x.occurredAt);
    if (!conv || at == null || at <= facts.askAt) continue;
    mine.set(conv, [...(mine.get(conv) ?? []), at]);
  }
  const followsMine = (s: CompletionSource) => {
    const conv = conversationOf(s);
    const at = toMs(s.occurredAt);
    return !!conv && at != null && (mine.get(conv) ?? []).some((t) => t < at);
  };
  for (const s of sources) {
    if (!CANDIDATE_CONNECTORS.has(s.connector)) continue;
    if (facts.originIds.has(s.sourceItemId) || facts.completionIds.has(s.sourceItemId)) continue;
    const seen = toMs(s.seenAt);
    if (seen == null || seen <= o.seenAfter || seen > o.seenUntil) continue;
    const at = s.connector === 'calendar' ? seen : toMs(s.occurredAt);
    if (at == null || at <= facts.askAt) continue;
    const relations = relationsOf(facts, s);
    if (!relations.length) continue;
    if ((s.connector === 'slack' || s.connector === 'gmail') && isPleasantry(s.text)) {
      // R7: the asker's "got it, thanks" after my line is their acknowledgement: kept, tagged `ack`. Other Slack chatter
      // goes (it only crowds the slots).
      if (!s.fromMe && relations.includes('from_asker') && followsMine(s)) relations.push('ack');
      else if (s.connector === 'slack') continue;
    }
    out.push({ source: s, relations, strong: relations.some((r) => STRONG_RELATIONS.has(r)) });
  }
  const resolves = (c: Candidate) => !c.source.fromMe && c.relations.includes('from_asker') && RESOLUTION_RE.test(c.source.text ?? '');
  const weight = (c: Candidate) => (c.strong ? 100 : 0) + (resolves(c) ? 50 : 0) + (c.source.fromMe ? 10 : 0) + c.relations.length;
  return out
    .sort((a, b) => weight(b) - weight(a) || (toMs(b.source.occurredAt) ?? 0) - (toMs(a.source.occurredAt) ?? 0))
    .slice(0, o.maxPerItem ?? 6)
    .sort((a, b) => (toMs(a.source.occurredAt) ?? 0) - (toMs(b.source.occurredAt) ?? 0));
}
