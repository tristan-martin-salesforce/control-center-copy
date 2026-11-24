/**
 * The Settle context pack, pure over raw rows (load-db.ts reads them; tests build them by hand): the ask, the lines
 * just before it, everything after it in the same conversation oldest first, my later messages elsewhere, calendar
 * events around the topic, and sibling items. Each line gets a short alias the model cites.
 */
import { cutHead } from '@/engines/prompt-cut';
import { redactText } from '@/lib/redact';

import type { SettleContext, SettleHints, SettleLine } from './types';

/** Source items keep at most this much text (store-db `excerpt`): a message this long was cut. */
export const SOURCE_EXCERPT_MAX = 1000;

export interface RawSource {
  id: string;
  source: string;
  kind: string;
  externalId: string;
  parent: string | null;
  url: string | null;
  at: string;
  fromMe: boolean;
  addressedToMe: boolean | null;
  title: string | null;
  text: string | null;
  author: string | null;
  channelId: string | null;
  channelType: string | null;
  channelName: string | null;
  threadTs: string | null;
  ts: string | null;
  repliedByMe?: boolean | null;
  lastFromMe?: boolean | null;
  /** Slack: the other people in the conversation (names). */
  participants?: string[];
  /** Gmail: a mass / bulk mail. */
  bulk?: boolean;
  /** The stored body hit the source excerpt limit (SOURCE_EXCERPT_MAX): the message was longer. */
  cut?: boolean;
  /** Calendar: my response and the invite size. */
  myResponse?: string;
  attendeeCount?: number;
  /** Evidence role, when the row is this item's evidence. */
  role?: string | null;
}

export interface RawEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string | null;
  myResponse: string | null;
  attendance: string | null;
  allDay: boolean;
  /** An external attendee domain that matches the item's account or title words (e.g. the customer's). */
  withDomain?: string;
}

export interface RawSibling {
  id: string;
  title: string;
  status: string;
  resolution: string | null;
  createdAt: string;
  sameConversation: boolean;
}

export interface RawItem {
  id: string;
  kind: string;
  status: string;
  title: string;
  purpose: string | null;
  description: string | null;
  dueAt: string | null;
  createdAt: string;
  counterparty: string | null;
  account: string | null;
}

export interface SettleRaw {
  item: RawItem;
  evidence: RawSource[];
  conversation: RawSource[];
  elsewhere: RawSource[];
  events: RawEvent[];
  siblings: RawSibling[];
  /** Salient title words: a long conversation keeps its middle lines that mention them. */
  keywords?: string[];
}

export interface BuildOptions {
  now: Date;
  timezone: string;
  me: string;
  corrections?: string[];
  rules?: string | null;
  /** Lines kept after the ask before the middle is dropped (first `head` + last `tail`). */
  afterHead?: number;
  afterTail?: number;
  /** Middle lines kept when they mention the topic. */
  afterMiddle?: number;
}

const clip = (s: string | null | undefined, n: number) => {
  const t = redactText((s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

function conversationType(ask: RawSource | undefined): SettleHints['conversation'] {
  if (!ask) return 'none';
  if (ask.source === 'gmail') return 'email';
  if (ask.source === 'gemini_notes') return 'notes';
  if (ask.source !== 'slack') return 'none';
  if (ask.threadTs) return 'thread';
  if (ask.channelType === 'im') return 'dm';
  if (ask.channelType === 'mpim') return 'group_dm';
  return 'channel';
}

function whereOf(r: RawSource): string {
  if (r.source === 'gmail') return r.bulk ? 'email (mass mail)' : 'email';
  if (r.source === 'calendar') return `calendar invite${r.attendeeCount ? ` (${r.attendeeCount} invited)` : ''}${r.myResponse ? ` · you ${r.myResponse === 'declined' ? 'declined' : r.myResponse === 'accepted' ? 'accepted' : `answered ${r.myResponse}`}` : ''}`;
  if (r.source === 'gemini_notes') return 'meeting notes';
  if (r.source === 'slack') {
    const place = r.channelType === 'im' ? 'DM' : r.channelType === 'mpim' ? 'group DM' : r.channelName ? `#${r.channelName}` : 'channel';
    return r.threadTs ? `${place} thread` : place;
  }
  return r.source;
}

const textOf = (r: RawSource, n: number) => clip([r.source === 'gmail' && r.title ? `Subject: ${r.title}.` : r.source !== 'slack' ? r.title : null, r.text].filter(Boolean).join(' '), n);

export function buildSettleContext(raw: SettleRaw, o: BuildOptions): SettleContext {
  const nowMs = o.now.getTime();
  const evidence = [...raw.evidence].sort((a, b) => ms(a.at) - ms(b.at));
  const origins = evidence.filter((e) => e.role === 'origin');
  const askRow = origins[0] ?? evidence[0];
  const askMs = askRow ? ms(askRow.at) : ms(raw.item.createdAt);
  const asker = askRow && !askRow.fromMe ? askRow.author : null;
  const line = (id: string, kind: SettleLine['kind'], r: RawSource, n = 420): SettleLine => ({
    id,
    kind,
    at: r.at,
    by: r.fromMe ? 'me' : r.author?.trim() || 'someone',
    fromMe: r.fromMe,
    where: whereOf(r),
    text: textOf(r, n),
    sourceItemId: r.id,
    ...(r.url ? { url: r.url } : {}),
  });

  // The conversation, without the ask itself and without duplicates of evidence rows.
  const seen = new Set<string>(askRow ? [askRow.id] : []);
  const conv = raw.conversation.filter((r) => !seen.has(r.id) && (seen.add(r.id), true)).sort((a, b) => ms(a.at) - ms(b.at));
  const beforeRows = conv.filter((r) => ms(r.at) < askMs).slice(-6);
  const afterAll = conv.filter((r) => ms(r.at) >= askMs);
  // Evidence rows outside the conversation (a later origin, a completion link elsewhere) join `elsewhere`.
  const convIds = new Set(conv.map((r) => r.id));
  const evElsewhere = evidence.filter((r) => r !== askRow && !convIds.has(r.id) && ms(r.at) >= askMs - 86_400_000);
  const head = o.afterHead ?? 20;
  const tail = o.afterTail ?? 8;
  const middleMax = o.afterMiddle ?? 14;
  const kw = new Set((raw.keywords ?? []).map((w) => w.toLowerCase()));
  const mentions = (r: RawSource) => {
    if (!kw.size) return 0;
    const ws = new Set(`${r.title ?? ''} ${r.text ?? ''}`.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/));
    let n = 0;
    for (const w of kw) if (ws.has(w)) n += 1;
    return n;
  };
  let afterRows = afterAll;
  if (afterAll.length > head + tail) {
    // A long DM: keep the start and the end, and from the middle the lines that mention the topic (mine and the
    // asker's first), in time order. The deciding line of a busy DM is usually there.
    const askerKey = asker?.trim().toLowerCase();
    const ranked = afterAll
      .slice(head, afterAll.length - tail)
      .map((r, i) => ({ r, i, s: mentions(r) * 2 + (r.fromMe ? 1 : 0) + (askerKey && r.author?.trim().toLowerCase() === askerKey ? 1 : 0) }))
      .filter((m) => m.s >= 2)
      .sort((a, b) => b.s - a.s || a.i - b.i);
    const middle = cutHead('settle.dm_middle', ranked, middleMax)
      .sort((a, b) => a.i - b.i)
      .map((m) => m.r);
    afterRows = [...afterAll.slice(0, head), ...middle, ...afterAll.slice(-tail)];
  }
  const omittedAfter = afterAll.length - afterRows.length;

  const before = beforeRows.map((r, i) => line(`b${i + 1}`, 'before', r, 300));
  const after = afterRows.map((r, i) => line(`c${i + 1}`, 'after', r));
  const elseSeen = new Set<string>([...convIds, ...(askRow ? [askRow.id] : [])]);
  const elseRows = [...evElsewhere, ...raw.elsewhere].filter((r) => !elseSeen.has(r.id) && (elseSeen.add(r.id), true)).sort((a, b) => ms(a.at) - ms(b.at));
  const elsewhere = cutHead('settle.elsewhere', elseRows, 14).map((r, i) => ({ ...line(`x${i + 1}`, 'elsewhere', r, 300), ...(r.role ? { where: `${whereOf(r)} · linked as ${r.role}` } : {}) }));
  const events = cutHead(
    'settle.events',
    raw.events.slice().sort((a, b) => ms(a.startsAt) - ms(b.startsAt)),
    8,
  ).map(
      (e, i): SettleLine => ({
        id: `e${i + 1}`,
        kind: 'event',
        at: e.startsAt,
        by: 'calendar',
        fromMe: false,
        text: clip(`${e.title}${e.allDay ? ' (all day)' : ''} · ${e.startsAt} → ${e.endsAt}${e.status === 'cancelled' ? ' · cancelled' : ''}${e.myResponse ? ` · my response: ${e.myResponse}` : ''}${e.attendance ? ` · attendance: ${e.attendance}` : ''}${e.withDomain ? ` · with ${e.withDomain}` : ''}`, 240),
        calendarEventId: e.id,
        passed: ms(e.endsAt) <= nowMs,
      }),
    );
  const siblings = cutHead('settle.siblings', raw.siblings, 8).map(
    (s, i): SettleLine => ({
      id: `k${i + 1}`,
      kind: 'sibling',
      at: s.createdAt,
      by: 'app',
      fromMe: false,
      where: s.sameConversation ? 'same conversation' : 'similar title',
      text: clip(`${s.title} · ${s.status}${s.resolution ? ` (${s.resolution})` : ''}`, 200),
      workItemId: s.id,
    }),
  );

  const mine = afterAll.filter((r) => r.fromMe);
  const askerNorm = asker?.trim().toLowerCase();
  const firstSeenMs = ms(raw.item.createdAt);
  const dueMs = ms(raw.item.dueAt);
  const hints: SettleHints = {
    ageDaysWhenSeen: Number.isFinite(askMs) && Number.isFinite(firstSeenMs) ? Math.round(((firstSeenMs - askMs) / 86_400_000) * 10) / 10 : null,
    dueBeforeFirstSeen: Number.isFinite(dueMs) && dueMs <= firstSeenMs,
    duePassed: Number.isFinite(dueMs) && dueMs <= nowMs,
    conversation: conversationType(askRow),
    myRepliesAfterAsk: mine.length,
    askerMessagesAfterAsk: askerNorm ? afterAll.filter((r) => !r.fromMe && r.author?.trim().toLowerCase() === askerNorm).length : 0,
    firstReplyAfterMin: mine[0] && Number.isFinite(askMs) ? Math.round((ms(mine[0].at) - askMs) / 60_000) : null,
    ...(askRow?.source === 'gmail' ? { repliedByMe: !!askRow.repliedByMe, lastMessageFromMe: !!askRow.lastFromMe } : {}),
    omittedAfter,
    ...(askRow?.cut ? { askCutOff: true } : {}),
  };

  return {
    now: o.now.toISOString(),
    timezone: o.timezone,
    me: o.me,
    item: {
      id: raw.item.id,
      kind: raw.item.kind,
      status: raw.item.status,
      title: clip(raw.item.title, 200),
      ...(raw.item.purpose || raw.item.description ? { purpose: clip(raw.item.purpose || raw.item.description, 300) } : {}),
      ...(raw.item.dueAt ? { due: raw.item.dueAt } : {}),
      firstSeen: raw.item.createdAt,
      ...(raw.item.counterparty ? { counterparty: raw.item.counterparty } : {}),
      ...(raw.item.account ? { account: raw.item.account } : {}),
    },
    hints,
    ask: askRow ? line('a1', 'ask', askRow, 700) : null,
    before,
    after,
    elsewhere,
    events,
    siblings,
    corrections: o.corrections ?? [],
    rules: o.rules ?? null,
  };
}

/** Every line of a context, by alias. */
export function linesById(c: SettleContext): Map<string, SettleLine> {
  const m = new Map<string, SettleLine>();
  for (const l of [...(c.ask ? [c.ask] : []), ...c.before, ...c.after, ...c.elsewhere, ...c.events, ...c.siblings]) m.set(l.id, l);
  return m;
}
