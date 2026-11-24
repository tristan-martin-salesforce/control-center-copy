/**
 * Calendar deterministic fetcher.
 *
 * `get_events` has no updatedMin/syncToken, so each run snapshots [now - 2 d (or the window start if older), now + 14 d]
 * and diffs by event id + content hash (brief 09 §5.4). Cancellations are events that vanish while still in the future.
 *
 * Derives attendance for ended meetings (attended / missed / uncertain / n/a) and a `notes-poll` hint for meetings
 * that just ended, which the Gemini-notes fetcher (and the runtime scheduler) act on.
 */
import { isNonMeetingTitle } from '@/lib/event-titles';
import type { ConnectorHealthProbe, CoverageObject, Cursor, DeterministicFetcher, FetchResult, NormalizedSourceItem, PersonRef, TimeWindow } from '@/scanner/types';
import { redact, redactExcerpt } from '../redact';
import { decodeCursor, encodeCursor, extractDriveIds, h16, normalizeText, systemClock, throwIfAborted, type Clock } from '../util';
// injected: the connector runtime's text port (src/connectors/runtime: GoogleWorkspaceClient behind direct_mcp)
import type { TextToolPort as GoogleTools } from '../runtime/types';
import type { Me } from './gmail';
import { parseEvents, type ParsedEvent } from './parse';

export type Attendance = 'attended' | 'missed' | 'uncertain' | 'n/a' | 'upcoming';

export interface AttendanceVerdict {
  attendance: Attendance;
  reason: string;
  myResponse?: string;
  overlapWith?: string[];
}

export const NOTES_POLL_MINUTES = 120;

const OOO_TITLE = /\b(ooo|out of office|vacation|pto|holiday|day off)\b/i;

export function isMeetingLike(e: ParsedEvent, me: Me): boolean {
  if (e.allDay) return false;
  const others = e.attendeeEmails.filter((a) => a !== me.email.toLowerCase());
  if (others.length === 0) return false;
  // Blocks, holds, travel and hotel stays are not meetings; a flight is a flight number or "Flight to …", never the
  // bare word (a dinner at "… Flight Club" with guests is a meeting: onsite lane, event-kinds.ts).
  if (isNonMeetingTitle(e.title) && !e.meetingLink) return false;
  return true;
}

function overlapMs(a: ParsedEvent, b: ParsedEvent): number {
  return Math.min(Date.parse(a.end), Date.parse(b.end)) - Math.max(Date.parse(a.start), Date.parse(b.start));
}

/**
 * Attendance heuristic. Google gives responses only (no join data), so:
 *  - declined, or no response and not organizer     -> missed
 *  - overlapping OOO block                            -> missed (ooo)
 *  - accepted but a better-claimed overlapping meeting (I organize it, or it has fewer attendees and I accepted it too) -> uncertain
 *  - tentative                                         -> uncertain
 *  - accepted, no conflicts                            -> attended
 *  - solo / all-day / blocks                           -> n/a
 */
export function classifyAttendance(e: ParsedEvent, all: ParsedEvent[], me: Me, now: Date): AttendanceVerdict {
  const mine = e.attendees.find((a) => a.email === me.email.toLowerCase());
  const myResponse = mine?.response;
  if (!isMeetingLike(e, me)) return { attendance: 'n/a', reason: 'not a meeting with other attendees', myResponse };
  if (Date.parse(e.start) > now.getTime()) return { attendance: 'upcoming', reason: 'has not started', myResponse };
  const oooOverlap = all.find((o) => o.id !== e.id && OOO_TITLE.test(o.title) && overlapMs(e, o) > 0 && (o.allDay || overlapMs(e, o) >= (Date.parse(e.end) - Date.parse(e.start)) / 2));
  if (myResponse === 'declined') return { attendance: 'missed', reason: 'declined', myResponse };
  if (oooOverlap) return { attendance: 'missed', reason: 'ooo', myResponse, overlapWith: [oooOverlap.id] };
  if (!mine || myResponse === 'needsAction') {
    if (mine?.organizer) return { attendance: 'attended', reason: 'organizer', myResponse };
    return { attendance: 'missed', reason: mine ? 'no_response' : 'not_on_attendee_list', myResponse };
  }
  const conflicts = all.filter((o) => {
    if (o.id === e.id || !isMeetingLike(o, me)) return false;
    const om = o.attendees.find((a) => a.email === me.email.toLowerCase());
    if (om?.response !== 'accepted' && !om?.organizer) return false;
    return overlapMs(e, o) >= Math.min(Date.parse(e.end) - Date.parse(e.start), Date.parse(o.end) - Date.parse(o.start)) * 0.5;
  });
  if (myResponse === 'tentative') return { attendance: 'uncertain', reason: 'tentative', myResponse, overlapWith: conflicts.map((c) => c.id) };
  if (conflicts.length) {
    const iOrganize = mine.organizer === true;
    const otherOrganized = conflicts.some((c) => c.attendees.find((a) => a.email === me.email.toLowerCase())?.organizer);
    if (iOrganize && !otherOrganized) return { attendance: 'attended', reason: 'organizer_with_overlap', myResponse, overlapWith: conflicts.map((c) => c.id) };
    return { attendance: 'uncertain', reason: 'overlapping_accepted', myResponse, overlapWith: conflicts.map((c) => c.id) };
  }
  return { attendance: 'attended', reason: 'accepted', myResponse };
}

interface CalCursor {
  /** eventId -> { h: contentHash, s: start ISO } */
  events: Record<string, { h: string; s: string }>;
}

export interface CalendarFetcherOptions {
  google: GoogleTools;
  me: Me;
  clock?: Clock;
  lookbackDays?: number;
  lookaheadDays?: number;
  maxEvents?: number;
}

export async function listEvents(g: GoogleTools, from: Date, to: Date, max: number, signal?: AbortSignal): Promise<ParsedEvent[]> {
  const text = await g.call(
    'get_events',
    { time_min: from.toISOString(), time_max: to.toISOString(), detailed: true, include_attachments: true, max_results: max },
    { signal },
  );
  if (/^No events found/i.test(text.trim())) return [];
  return parseEvents(text);
}

export class CalendarFetcher implements DeterministicFetcher {
  readonly connector = 'calendar' as const;
  private readonly g: GoogleTools;
  private readonly me: Me;
  private readonly clock: Clock;
  private readonly lookback: number;
  private readonly lookahead: number;
  private readonly max: number;

  constructor(opts: CalendarFetcherOptions) {
    this.g = opts.google;
    this.me = opts.me;
    this.clock = opts.clock ?? systemClock;
    this.lookback = opts.lookbackDays ?? 2;
    this.lookahead = opts.lookaheadDays ?? 14;
    this.max = opts.maxEvents ?? 250;
  }

  async scopes(): Promise<string[]> {
    return ['primary'];
  }

  health(): Promise<ConnectorHealthProbe> {
    return this.g.health();
  }

  private range(window: TimeWindow, now: Date): { from: Date; to: Date } {
    const from = new Date(Math.min(now.getTime() - this.lookback * 86400_000, Date.parse(window.from)));
    const to = new Date(now.getTime() + this.lookahead * 86400_000);
    return { from, to };
  }

  async listForReconcile(_scope: string, window: TimeWindow, opts: { signal: AbortSignal }): Promise<CoverageObject[]> {
    const now = this.clock();
    const events = await listEvents(this.g, new Date(Date.parse(window.from)), new Date(Math.min(Date.parse(window.to), now.getTime() + this.lookahead * 86400_000)), this.max, opts.signal);
    // Identity only (no `to`): a scan clamps an event's coverage to its own window, so comparing against the full
    // event end made every in-progress or multi-day event "uncovered" every night (stress finding R-1). The snapshot
    // fetch re-reads changed events on every poll anyway.
    return events.map((e) => ({ kind: 'calendar_range' as const, ref: `event:${e.id}`, from: e.start }));
  }

  /**
   * A window that ends before the live snapshot range (`now - lookbackDays`) is history: a first-scan backfill chunk
   * (B-080). The snapshot fetch ignores windows, so before this fix the first scan never planned Calendar and only the
   * last 2 days of meetings ever reached the Time page.
   */
  isHistory(window: TimeWindow, now: Date = this.clock()): boolean {
    return Date.parse(window.to) <= now.getTime() - this.lookback * 86400_000;
  }

  /**
   * History: list exactly the window and emit every event in it, oldest first, tagged `history`. Nothing to interpret
   * (`recordOnly`): past meetings feed the calendar projection (Time, History) and the completion pass's `same_event`
   * candidates, and a skill pass over weeks-old meetings could only propose stale prep asks and catch-ups. No
   * cancellation detection (that needs the live snapshot), and the cursor value is handed back unchanged so a history
   * run that ever becomes the cursor never makes the next live poll re-emit everything.
   */
  private async fetchHistory(cursor: Cursor | null, window: TimeWindow, now: Date, signal: AbortSignal): Promise<FetchResult> {
    const from = new Date(Date.parse(window.from));
    const to = new Date(Date.parse(window.to));
    const events = (await listEvents(this.g, from, to, this.max, signal)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const truncated = events.length >= this.max;
    // A full page may have cut events off the end (Google lists by start): claim only up to the last start listed and
    // let the continuation re-list the rest (same dedupe keys, so the overlap is free).
    const reach = truncated ? Math.max(from.getTime() + 1000, Date.parse(events[events.length - 1]!.start)) : to.getTime();
    const items: NormalizedSourceItem[] = [];
    const coverage: CoverageObject[] = [{ kind: 'calendar_range', ref: 'primary', from: from.toISOString(), to: new Date(reach).toISOString(), meta: { count: events.length, truncated, history: true } }];
    for (const e of events) {
      const item = this.toItem(e, classifyAttendance(e, events, this.me, now), Date.parse(e.end) <= now.getTime(), now);
      (item.payload as { hints: string[] }).hints.push('history');
      items.push(item);
      coverage.push({ kind: 'calendar_range', ref: `event:${e.id}`, from: e.start, to: e.end });
    }
    const value = cursor?.value ?? encodeCursor<CalCursor>({ events: {} }, now.toISOString()).value;
    return { items, coverage, nextCursor: { value, at: new Date(reach).toISOString() }, complete: !truncated, recordOnly: true };
  }

  async fetch(_scope: string, cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal; limit?: number }): Promise<FetchResult> {
    throwIfAborted(opts.signal);
    const now = this.clock();
    if (this.isHistory(window, now)) return this.fetchHistory(cursor, window, now, opts.signal);
    const prev = decodeCursor<CalCursor>(cursor, { events: {} });
    const { from, to } = this.range(window, now);
    const events = await listEvents(this.g, from, to, this.max, opts.signal);
    const items: NormalizedSourceItem[] = [];
    const coverage: CoverageObject[] = [
      { kind: 'calendar_range', ref: 'primary', from: from.toISOString(), to: to.toISOString(), meta: { count: events.length, truncated: events.length >= this.max } },
    ];
    const next: CalCursor = { events: {} };

    // At most `limit` changed events per run, nearest to now first (just ended, starting soon). The rest stay
    // "changed" (their previous hash is kept) and are emitted by the next polls. Before, the first run of a scope
    // handed every event in the 16-day range to ONE agent run (130+ events ≈ 200K tokens): it hit the cost cap, the
    // runtime split the window, and since this snapshot ignores the window the split repeated down to 10 minutes,
    // ≈ $0.10 a run — about $4 in five minutes in the stress run, the whole daily budget in production (CAL-1).
    const limit = Math.max(1, opts.limit ?? Number.POSITIVE_INFINITY);
    const built = events.map((e) => {
      const verdict = classifyAttendance(e, events, this.me, now);
      const item = this.toItem(e, verdict, Date.parse(e.end) <= now.getTime(), now);
      coverage.push({ kind: 'calendar_range', ref: `event:${e.id}`, from: e.start, to: e.end });
      return { e, item, changed: prev.events[e.id]?.h !== item.contentHash };
    });
    const nearNow = (e: ParsedEvent) => Math.min(Math.abs(Date.parse(e.start) - now.getTime()), Math.abs(Date.parse(e.end) - now.getTime()));
    const emit = new Set(
      built
        .filter((b) => b.changed)
        .sort((a, b) => nearNow(a.e) - nearNow(b.e))
        .slice(0, limit)
        .map((b) => b.e.id),
    );
    // Cursor entries keep the listing order (stable cursor values); deferred events keep their previous hash.
    for (const b of built) {
      if (!b.changed || emit.has(b.e.id)) next.events[b.e.id] = { h: b.item.contentHash, s: b.e.start };
      else if (prev.events[b.e.id]) next.events[b.e.id] = prev.events[b.e.id]!;
      if (b.changed && emit.has(b.e.id)) items.push(b.item);
    }
    const deferred = built.filter((b) => b.changed).length > emit.size;

    // Cancellations: vanished from the window while still in the future (or inside the queried range).
    const present = new Set(events.map((e) => e.id));
    for (const [id, st] of Object.entries(prev.events)) {
      if (present.has(id)) continue;
      const s = Date.parse(st.s);
      if (s >= from.getTime() && s <= to.getTime() && s > now.getTime()) {
        items.push({
          connector: 'calendar',
          kind: 'calendar_event',
          externalId: id,
          dedupeKey: `cal:${id}:cancelled`,
          contentHash: h16('cancelled', id),
          occurredAt: now.toISOString(),
          title: '(cancelled event)',
          threadRef: `calendar:${id}`,
          payload: { eventId: id, status: 'cancelled', start: st.s },
        });
      } else if (s < from.getTime()) {
        /* aged out of the window: forget silently */
      } else if (s > to.getTime()) {
        next.events[id] = st; // not yet in range; keep
      }
    }

    // Coverage reaches `to`; the cursor represents "now".
    return { items, coverage, nextCursor: encodeCursor(next, now.toISOString()), complete: events.length < this.max && !deferred };
  }

  toItem(e: ParsedEvent, v: AttendanceVerdict, ended: boolean, now: Date): NormalizedSourceItem {
    const meEmail = this.me.email.toLowerCase();
    const myDomain = meEmail.split('@')[1];
    const participants: PersonRef[] = e.attendees.map((a) => ({
      email: a.email,
      isMe: a.email === meEmail,
      isExternal: a.email.split('@')[1] !== myDomain,
    }));
    const organizer: PersonRef | undefined = e.organizerEmail ? { email: e.organizerEmail, name: e.organizerRaw?.replace(/<.*$/, '').trim() || undefined, isMe: e.organizerEmail === meEmail } : undefined;
    const fileIds = [...new Set([...e.attachments.map((a) => a.fileId).filter((x): x is string => !!x), ...extractDriveIds(e.description)])];
    const geminiAttachment = e.attachments.find((a) => /notes by gemini/i.test(a.title));
    const endedMs = now.getTime() - Date.parse(e.end);
    const justEnded = ended && endedMs <= NOTES_POLL_MINUTES * 60_000;
    const hasConferencing = !!e.meetingLink;
    const hints: string[] = [];
    if (justEnded && isMeetingLike(e, this.me) && (hasConferencing || geminiAttachment)) hints.push('notes-poll');
    if (ended && v.attendance === 'missed') hints.push('missed-meeting');
    const descR = redact(e.description);
    const ex = redactExcerpt(normalizeText([e.title, descR.text].filter(Boolean).join(' - ')));
    const external = participants.some((p) => p.isExternal);
    // Hash covers what a human would call "the event changed". Time-dependent hints are excluded on purpose.
    const contentHash = h16(e.title, e.start, e.end, e.location, e.meetingLink, e.attendees.map((a) => `${a.email}:${a.response}`).sort().join(','), e.attachments.map((a) => a.fileId ?? a.title).sort().join(','), normalizeText(e.description), ended ? v.attendance : 'pending', ended ? 'ended' : 'open');
    return {
      connector: 'calendar',
      kind: 'calendar_event',
      externalId: e.id,
      dedupeKey: `cal:${e.id}`,
      contentHash,
      occurredAt: e.start,
      author: organizer,
      participants,
      permalink: e.link,
      title: redact(e.title).text,
      excerpt: ex.text,
      redacted: descR.redacted || ex.redacted,
      threadRef: `calendar:${e.id}`,
      fileRefs: fileIds.length ? fileIds : undefined,
      payload: {
        eventId: e.id,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        location: e.location,
        meetingLink: e.meetingLink,
        conferencing: hasConferencing ? 'meet' : undefined,
        organizerEmail: e.organizerEmail,
        iAmOrganizer: e.organizerEmail === meEmail,
        attendeeCount: e.attendees.length || e.attendeeEmails.length,
        external,
        // Big meetings list hundreds of attendees: keep me, the organizer and the first 15 (counts are in attendeeCount).
        responses: e.attendees
          .filter((a, i) => i < 15 || a.email === meEmail || a.organizer)
          .map((a) => ({ email: a.email, response: a.response, optional: a.optional, organizer: a.organizer })),
        myResponse: v.myResponse,
        attachments: e.attachments.map((a) => ({ title: redact(a.title).text, fileId: a.fileId, mimeType: a.mimeType })),
        geminiNotesDocId: geminiAttachment?.fileId,
        description: descR.text.slice(0, 2000),
        ended,
        minutesSinceEnd: ended ? Math.round(endedMs / 60_000) : undefined,
        attendance: v.attendance,
        attendanceReason: v.reason,
        overlapWith: v.overlapWith,
        hints,
      },
    };
  }
}
