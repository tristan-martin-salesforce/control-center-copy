/**
 * Trainings deterministic fetcher (R-UI-2, brief 10 §2). Gmail + Calendar halves only.
 *
 * The Slack half ("Astro's Course Tracker" bot DM, `D0B9WSJTJTS`) needs judgment while traversing Block Kit messages and
 * belongs to BE-2a's runner: see skills/scan-trainings.md "Slack hand-off". This fetcher emits `training_notice` items with
 * parsed due dates, status, level of effort, system and allow-listed links; the skill agent dedupes and links them.
 *
 * Scopes: `gmail` (sender and subject queries) and `calendar` (mandatory sessions in the next 14 days). Cursor per scope.
 */
import type { ConnectorHealthProbe, CoverageObject, Cursor, DeterministicFetcher, FetchResult, NormalizedSourceItem, TimeWindow } from '@/scanner/types';
import { redact, redactExcerpt } from '../redact';
import { decodeCursor, encodeCursor, extractUrls, h16, htmlToText, looksLikeHtml, normalizeText, systemClock, throwIfAborted, type Clock } from '../util';
// injected: the connector runtime's text port (src/connectors/runtime: GoogleWorkspaceClient behind direct_mcp)
import type { TextToolPort as GoogleTools } from '../runtime/types';
import { listEvents } from './calendar';
import type { Me } from './gmail';
import { newTextOf } from './gmail';
import { parseGmailBatch, parseGmailSearch, type GmailMessage } from './parse';

export type TrainingSystem = 'ACT' | 'Trailhead' | 'Forge' | 'Calendar' | 'Cert' | 'Other';
export type TrainingStatus = 'assigned' | 'due_soon' | 'overdue' | 'completed' | 'unknown';
export type DueSource = 'explicit' | 'prose' | 'table' | 'relative' | 'calendar';

export const TRAINING_SENDERS = ['trainer@example.com', 'fieldreadiness@example.com', 'trailheadhelp@example.com', 'enablement@example.com'];

export const TRAINING_QUERIES: Array<{ id: string; q: string }> = [
  { id: 'senders', q: `from:(${TRAINING_SENDERS.join(' OR ')})` },
  { id: 'subjects', q: 'subject:(required OR mandatory OR overdue OR "action required" OR assigned OR compliance OR certification OR "required learning") -subject:"The Daily"' },
];

/** Senders and subjects that match training words but are not trainings (brief 10 §2.2). */
const NOISE = /(employeecomms@|^The Daily\b|\bThe Daily:|g4g|incentive compensation|spiff|open roles|v2mom|pulse\b|feedback)/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIdx = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase());
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Resolves month/day (and optional year) relative to the message date: the occurrence on or after (msg date - 60 d). */
export function resolveMonthDay(month: number, day: number, year: number | undefined, ref: Date): string | undefined {
  if (month < 0 || day < 1 || day > 31) return undefined;
  if (year) return ymd(new Date(Date.UTC(year, month, day)));
  let cand = new Date(Date.UTC(ref.getUTCFullYear(), month, day));
  if (cand.getTime() < ref.getTime() - 60 * 86400_000) cand = new Date(Date.UTC(ref.getUTCFullYear() + 1, month, day));
  return ymd(cand);
}

export interface ParsedDue {
  due?: string;
  dueSource?: DueSource;
  overdue: boolean;
}

const REL_WORDS: Record<string, number> = { today: 0, tomorrow: 1, yesterday: -1, 'in two weeks': 14, 'in 2 weeks': 14, 'in a week': 7, 'in one week': 7, 'next week': 7 };

export function parseDue(subject: string, body: string, ref: Date): ParsedDue {
  const overdue = /\b(overdue|past due|was due|way overdue)\b/i.test(subject + ' ' + body.slice(0, 1500));
  const text = `${subject}\n${body}`;
  // Table cell: "Completion Due Date | December 4, 2026" or flat text after the header.
  const tbl = text.match(new RegExp(`Completion Due Date[\\s|:]*${MONTH_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'));
  if (tbl) return { due: resolveMonthDay(monthIdx(tbl[1]!), Number(tbl[2]), Number(tbl[3]), ref), dueSource: 'table', overdue };
  // "by Friday, Oct. 16" / "due Oct 16" / "Due: Oct 16" / "due by Monday, November 4, 2026"
  const prose = text.match(new RegExp(`\\b(?:due(?:\\s+by|\\s+on)?|by|deadline)[:\\s]+(?:(?:Mon|Tues?|Wed(?:nes)?|Thu(?:rs)?|Fri|Sat|Sun)[a-z]*,?\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'));
  if (prose) return { due: resolveMonthDay(monthIdx(prose[1]!), Number(prose[2]), prose[3] ? Number(prose[3]) : undefined, ref), dueSource: 'prose', overdue };
  // "Due Friday, 10/16"
  const num = text.match(/\b(?:due|by|deadline)[:\s]+(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (num) {
    const y = num[3] ? (num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3])) : undefined;
    return { due: resolveMonthDay(Number(num[1]) - 1, Number(num[2]), y, ref), dueSource: 'prose', overdue };
  }
  // Explicit ISO.
  const iso = text.match(/\b(?:due|by|deadline)[:\s]+(\d{4}-\d{2}-\d{2})\b/i);
  if (iso) return { due: iso[1], dueSource: 'explicit', overdue };
  // Relative subject ladder.
  const rel = subject.match(/\bdue\s+(today|tomorrow|yesterday|in two weeks|in 2 weeks|in a week|in one week|next week)\b/i);
  if (rel) return { due: ymd(new Date(ref.getTime() + (REL_WORDS[rel[1]!.toLowerCase()] ?? 0) * 86400_000)), dueSource: 'relative', overdue };
  // "N days left" style
  const left = text.match(/\b(\d{1,3})\s+days?\s+left\b/i);
  if (left) return { due: ymd(new Date(ref.getTime() + Number(left[1]) * 86400_000)), dueSource: 'relative', overdue };
  return { overdue };
}

export function parseLoeMinutes(text: string): number | undefined {
  const m1 = text.match(/\bLOE:?\s*(\d+(?:\.\d+)?)\s*(hrs?|hours?|h|min(?:ute)?s?)\b/i);
  const m2 = text.match(/\|\s*(\d+(?:\.\d+)?)\s*(h|hrs?|hours?)\b/i);
  const m3 = text.match(/\b(\d+)\s*hours?\s*(?:(\d+)\s*min(?:ute)?s?)?/i);
  const m = m1 ?? m2;
  if (m) return Math.round(Number(m[1]) * (/^min/i.test(m[2]!) ? 1 : 60));
  if (m3) return Number(m3[1]) * 60 + Number(m3[2] ?? 0);
  return undefined;
}

const LINK_ALLOW = [/(^|\.)trailhead\.salesforce\.com$/i, /\.my\.trailhead\.com$/i, /^readiness\.my\.site\.com$/i, /^cloudhosting\.internal\.salesforce\.com$/i, /forge/i];
const TRACKING = /(^|\.)click\.(?:mail|e)\.salesforce\.com$|^click\./i;

export function classifyLinks(urls: string[]): { link?: string; linkTracked?: string; links: string[] } {
  const links: string[] = [];
  let tracked: string | undefined;
  for (const u of urls) {
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (TRACKING.test(host)) tracked ??= u;
    else if (LINK_ALLOW.some((r) => r.test(host))) links.push(u);
  }
  return { link: links[0], linkTracked: tracked, links: links.slice(0, 5) };
}

export function detectSystem(m: { from: string; subject: string; body: string }): TrainingSystem {
  const t = `${m.from}\n${m.subject}\n${m.body.slice(0, 3000)}`;
  if (/trailheadhelp@|credential|certification|maintenance/i.test(t)) return 'Cert';
  if (/readiness\.my\.site\.com\/act|astro'?s course tracker|\bACT\b|compliance training/i.test(t)) return 'ACT';
  if (/forge/i.test(t)) return 'Forge';
  if (/trailhead/i.test(t)) return 'Trailhead';
  return 'Other';
}

export interface CertRow {
  certification: string;
  status: string;
  nextBadge?: string;
  due: string;
}

/** The maintenance email's table arrives as flat text; rows end at a date. */
export function parseCertTable(text: string, ref: Date): CertRow[] {
  const i = text.search(/Completion Due Date/i);
  if (i < 0) return [];
  const flat = text.slice(i + 'Completion Due Date'.length).replace(/\s+/g, ' ');
  const rows: CertRow[] = [];
  const re = new RegExp(`(.+?)\\s+(\\d+\\s+Maintenance(?:s)?\\s+Behind|Up to date|Current|Expired|Due)\\s+(.+?)\\s+${MONTH_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'gi');
  let last = 0;
  for (const m of flat.matchAll(re)) {
    const name = m[1]!.slice(last === 0 ? 0 : 0).replace(/^[\s|]+/, '').trim();
    const due = resolveMonthDay(monthIdx(m[4]!), Number(m[5]), Number(m[6]), ref);
    if (!due || name.length > 120) continue;
    rows.push({ certification: name, status: m[2]!, nextBadge: m[3]!.trim(), due });
    last = (m.index ?? 0) + m[0].length;
  }
  return rows;
}

const COMPLETION = /\b(you(?:'|’)ve earned|congratulations|you have completed|has been completed|badge earned|completion confirmed)\b/i;

export function buildTrainingStatus(due: string | undefined, overdue: boolean, completed: boolean, ref: Date): TrainingStatus {
  if (completed) return 'completed';
  if (overdue) return 'overdue';
  if (due) {
    const days = (Date.parse(due + 'T23:59:59Z') - ref.getTime()) / 86400_000;
    if (days < 0) return 'overdue';
    if (days <= 7) return 'due_soon';
    return 'assigned';
  }
  return 'unknown';
}

export interface TrainingsFetcherOptions {
  google: GoogleTools;
  me: Me;
  clock?: Clock;
  queries?: typeof TRAINING_QUERIES;
  overlapSec?: number;
  maxMessages?: number;
  /** Training lookback for a first run (days). Certs/compliance are long-lived. */
  initialLookbackDays?: number;
  calendarTitleRe?: RegExp;
}

interface TrCursor {
  seen: Record<string, number>;
  lastEpoch: number;
}

export class TrainingsFetcher implements DeterministicFetcher {
  readonly connector = 'trainings' as const;
  private readonly g: GoogleTools;
  private readonly me: Me;
  private readonly clock: Clock;
  private readonly queries: typeof TRAINING_QUERIES;
  private readonly overlap: number;
  private readonly maxMessages: number;
  private readonly lookbackDays: number;
  private readonly calRe: RegExp;

  constructor(o: TrainingsFetcherOptions) {
    this.g = o.google;
    this.me = o.me;
    this.clock = o.clock ?? systemClock;
    this.queries = o.queries ?? TRAINING_QUERIES;
    this.overlap = o.overlapSec ?? 3600;
    this.maxMessages = o.maxMessages ?? 40;
    this.lookbackDays = o.initialLookbackDays ?? 120;
    this.calRe = o.calendarTitleRe ?? /\b(mandatory|required|training|certification|compliance)\b/i;
  }

  async scopes(): Promise<string[]> {
    return ['gmail', 'calendar'];
  }

  health(): Promise<ConnectorHealthProbe> {
    return this.g.health();
  }

  async listForReconcile(scope: string, window: TimeWindow, opts: { signal: AbortSignal }): Promise<CoverageObject[]> {
    if (scope === 'calendar') {
      const evs = await listEvents(this.g, new Date(window.from), new Date(window.to), 250, opts.signal);
      return evs.filter((e) => this.calRe.test(e.title)).map((e) => ({ kind: 'calendar_range' as const, ref: `event:${e.id}` }));
    }
    const out = new Map<string, CoverageObject>();
    for (const q of this.queries) {
      const text = await this.g.call('search_gmail_messages', { query: `${q.q} after:${Math.floor(Date.parse(window.from) / 1000)} before:${Math.ceil(Date.parse(window.to) / 1000)}`, page_size: 50 }, { signal: opts.signal });
      for (const h of parseGmailSearch(text).hits) out.set(h.id, { kind: 'email', ref: h.id });
    }
    return [...out.values()];
  }

  async fetch(scope: string, cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal; limit?: number }): Promise<FetchResult> {
    return scope === 'calendar' ? this.fetchCalendar(cursor, window, opts) : this.fetchGmail(cursor, window, opts);
  }

  private async fetchGmail(cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal; limit?: number }): Promise<FetchResult> {
    const now = this.clock();
    const prev = decodeCursor<TrCursor>(cursor, { seen: {}, lastEpoch: 0 });
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const baseFrom = cursor ? Date.parse(window.from) : Math.min(Date.parse(window.from), now.getTime() - this.lookbackDays * 86400_000);
    const fromEpoch = Math.floor(baseFrom / 1000) - this.overlap;
    const toEpoch = Math.min(Math.ceil(Date.parse(window.to) / 1000), nowEpoch + 60);
    const ids = new Map<string, { threadId?: string; webLink?: string }>();
    const coverage: CoverageObject[] = [];
    let truncated = false;
    for (const q of this.queries) {
      throwIfAborted(opts.signal);
      const query = `${q.q} after:${fromEpoch} before:${toEpoch}`;
      let token: string | undefined;
      let n = 0;
      for (let pages = 0; pages < 4; pages++) {
        const text = await this.g.call('search_gmail_messages', { query, page_size: 50, ...(token ? { page_token: token } : {}) }, { signal: opts.signal });
        const p = parseGmailSearch(text);
        for (const h of p.hits) ids.set(h.id, { threadId: h.threadId, webLink: h.webLink });
        n += p.hits.length;
        token = p.nextPageToken;
        if (!token) break;
        if (pages === 3) truncated = true;
      }
      coverage.push({ kind: 'query_window', ref: `trainings:gmail:${q.id}`, from: new Date(fromEpoch * 1000).toISOString(), to: window.to, meta: { hits: n } });
    }
    const unseen = [...ids.entries()].filter(([id]) => prev.seen[id] === undefined).slice(0, opts.limit ?? this.maxMessages);
    const overLimit = [...ids.keys()].filter((id) => prev.seen[id] === undefined).length > unseen.length;
    const items: NormalizedSourceItem[] = [];
    const seen = { ...prev.seen };
    let maxEpoch = prev.lastEpoch;
    let windowMaxEpoch = 0; // progress inside this window (stress finding G-1)
    for (let i = 0; i < unseen.length; i += 10) {
      throwIfAborted(opts.signal);
      const batch = unseen.slice(i, i + 10);
      const text = await this.g.call('get_gmail_messages_content_batch', { message_ids: batch.map(([id]) => id), format: 'full' }, { signal: opts.signal });
      const msgs = new Map(parseGmailBatch(text).map((m) => [m.id, m]));
      for (const [id, meta] of batch) {
        const m = msgs.get(id);
        if (!m) continue;
        const ep = m.dateIso ? Math.floor(Date.parse(m.dateIso) / 1000) : nowEpoch;
        seen[id] = ep;
        maxEpoch = Math.max(maxEpoch, ep);
        windowMaxEpoch = Math.max(windowMaxEpoch, ep);
        coverage.push({ kind: 'email', ref: id, from: m.dateIso, to: m.dateIso, meta: { training: true } });
        if (NOISE.test(`${m.from}\n${m.subject}`)) continue;
        items.push(...this.itemsFromMessage(m, meta));
      }
    }
    for (const [id, ep] of Object.entries(seen)) if (ep < nowEpoch - 14 * 86400) delete seen[id];
    const complete = !overLimit && !truncated;
    const atMs = complete ? Math.min(Date.parse(window.to), now.getTime()) : Math.min(Math.max(Date.parse(window.from), windowMaxEpoch * 1000), Date.parse(window.to));
    return { items, coverage, nextCursor: encodeCursor({ seen, lastEpoch: maxEpoch } satisfies TrCursor, new Date(atMs).toISOString()), complete };
  }

  /** One item per training notice; the certification email yields one item per certification row. */
  itemsFromMessage(m: GmailMessage, meta: { threadId?: string; webLink?: string }): NormalizedSourceItem[] {
    const raw = looksLikeHtml(m.body) ? htmlToText(m.body) : m.body;
    const body = newTextOf(raw);
    const ref = m.dateIso ? new Date(m.dateIso) : this.clock();
    const system = detectSystem({ from: m.from, subject: m.subject, body });
    const completed = COMPLETION.test(`${m.subject}\n${body.slice(0, 1500)}`);
    const mandatory = system === 'ACT' || system === 'Cert' || /\b(mandatory|required|globally required|action required)\b/i.test(`${m.subject}\n${body.slice(0, 2000)}`);
    const urls = classifyLinks(extractUrls(raw));
    const loe = parseLoeMinutes(body);
    const common = { threadRef: meta.threadId ? `gmail-thread:${meta.threadId}` : undefined, permalink: meta.webLink ?? m.webLink };

    const mk = (title: string, due: string | undefined, dueSource: DueSource | undefined, overdue: boolean, extra: Record<string, unknown>, keyPart: string): NormalizedSourceItem => {
      const status = buildTrainingStatus(due, overdue, completed, this.clock());
      const quote = redactExcerpt(normalizeText(body).slice(0, 100), 100);
      const t = redact(title).text;
      return {
        connector: 'trainings',
        kind: 'training_notice',
        externalId: `${m.id}${keyPart}`,
        dedupeKey: `training:gmail:${m.id}${keyPart}`,
        contentHash: h16(t, due, status, system, loe, urls.link),
        occurredAt: m.dateIso ?? ref.toISOString(),
        author: { name: m.from.replace(/<.*$/, '').trim() || undefined, email: m.from.match(/<([^>]+)>/)?.[1]?.toLowerCase() },
        title: t,
        excerpt: quote.text,
        redacted: quote.redacted,
        ...common,
        payload: {
          title: t,
          system,
          link: urls.link,
          linkTracked: urls.linkTracked,
          links: urls.links,
          due,
          dueSource,
          status,
          statusAsOf: this.clock().toISOString(),
          loeMinutes: loe,
          mandatory,
          source: { kind: 'gmail', id: m.id, ts: m.dateIso },
          evidenceQuote: quote.text,
          /** Dedupe key for the work item: later notices for the same key update due/status (brief 10 §2.5). */
          itemKey: `${system}:${normalizeText(t).toLowerCase().replace(/\b(reminder|action required|overdue|assigned|is here|have been assigned)\b/g, '').replace(/\s+/g, ' ').trim()}`,
          loginNote: system === 'Trailhead' || system === 'ACT' ? 'Authenticate in Okta before opening the link.' : undefined,
          ...extra,
        },
      };
    };

    if (system === 'Cert') {
      const rows = parseCertTable(raw, ref);
      if (rows.length) return rows.map((r, i) => mk(r.certification, r.due, 'table', false, { certStatus: r.status, nextBadge: r.nextBadge }, `#cert${i}`));
    }
    const due = parseDue(m.subject, body, ref);
    return [mk(m.subject, due.due, due.dueSource, due.overdue, {}, '')];
  }

  private async fetchCalendar(cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal }): Promise<FetchResult> {
    const now = this.clock();
    const prev = decodeCursor<{ h: Record<string, string> }>(cursor, { h: {} });
    const to = new Date(now.getTime() + 14 * 86400_000);
    const from = new Date(Math.min(now.getTime(), Date.parse(window.from)));
    const events = await listEvents(this.g, from, to, 250, opts.signal);
    const items: NormalizedSourceItem[] = [];
    const next: Record<string, string> = {};
    const coverage: CoverageObject[] = [{ kind: 'calendar_range', ref: 'trainings:calendar', from: from.toISOString(), to: to.toISOString(), meta: { events: events.length } }];
    for (const e of events) {
      if (!this.calRe.test(e.title) || e.allDay) continue;
      const hash = h16(e.title, e.start, e.end, e.meetingLink);
      next[e.id] = hash;
      coverage.push({ kind: 'calendar_range', ref: `event:${e.id}`, from: e.start, to: e.end });
      if (prev.h[e.id] === hash) continue;
      const t = redact(e.title).text;
      items.push({
        connector: 'trainings',
        kind: 'training_notice',
        externalId: `cal:${e.id}`,
        dedupeKey: `training:cal:${e.id}`,
        contentHash: hash,
        occurredAt: e.start,
        title: t,
        excerpt: redactExcerpt(normalizeText(e.description)).text.slice(0, 300),
        permalink: e.link,
        threadRef: `calendar:${e.id}`,
        payload: {
          title: t,
          system: 'Calendar' satisfies TrainingSystem,
          link: e.meetingLink,
          due: e.start.slice(0, 10),
          dueSource: 'calendar' satisfies DueSource,
          status: 'assigned' satisfies TrainingStatus,
          startsAt: e.start,
          loeMinutes: Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60_000),
          mandatory: /\b(mandatory|required)\b/i.test(e.title),
          source: { kind: 'calendar', id: e.id, ts: e.start },
          itemKey: `Calendar:${normalizeText(e.title).toLowerCase()}`,
        },
      });
    }
    return { items, coverage, nextCursor: encodeCursor({ h: next }, now.toISOString()), complete: true };
  }
}
