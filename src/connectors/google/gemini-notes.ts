/**
 * Gemini meeting-notes fetcher.
 *
 * For meetings that ended, poll for the "Notes by Gemini" doc for up to 120 minutes (cadence is the runtime's: every 10 min).
 * Found notes are parsed (Summary, Decisions, "Next steps" with assignees) into one `meeting_notes` item per notes doc.
 * R11 (SCN-11): the steps heading is `Next steps`, `Suggested next steps` or `Action items` at levels 1-3, the checkbox
 * is optional (`- [ ] [Name] …` and `- [Name] …`), and a first-name-only assignee is me when no other attendee or
 * assignee shares that first name. Notes with a summary but no parsed step are counted on Health (NOTES_NO_STEPS).
 * Notes docs sit in Drive (not Gmail) and are normally attached to the calendar event; if not, a Drive name search finds them.
 */
import type { ConnectorHealthProbe, CoverageObject, Cursor, DeterministicFetcher, FetchResult, NormalizedSourceItem, PersonRef, TimeWindow } from '@/scanner/types';
import { redact, redactExcerpt } from '../redact';
import { decodeCursor, encodeCursor, h16, normalizeText, systemClock, throwIfAborted, type Clock } from '../util';
import { GoogleCallError } from './client';
// injected: the connector runtime's text port (src/connectors/runtime: GoogleWorkspaceClient behind direct_mcp)
import type { TextToolPort as GoogleTools } from '../runtime/types';
import { classifyAttendance, isMeetingLike, listEvents, NOTES_POLL_MINUTES } from './calendar';
import type { Me } from './gmail';
import { parseDocSections, parseDriveSearch, type ParsedEvent } from './parse';

export interface NextStep {
  assignees: string[];
  title: string;
  description?: string;
  done: boolean;
  isMine: boolean;
  raw: string;
}

export interface ParsedGeminiNotes {
  summary: string;
  decisions: string[];
  nextSteps: NextStep[];
  transcriptUrl?: string;
  hasNotes: boolean;
}

const NAME_SPLIT = /\s*(?:,|&|\band\b|\/)\s*/i;

/** R11: the steps heading (`## Next steps`, `## Suggested next steps`, `# Action items`), any case. */
export const STEPS_HEADING = /^(#{1,3})\s*(suggested\s+)?(next steps|action items)\b/i;
/** Fetch decision reason (and Health app_events code) for notes with a summary but 0 parsed steps (R11). */
export const NOTES_NO_STEPS = 'notes_no_steps';

/** First name of an attendee: their display name, or the local part of their email (`pat.example@…` → pat). */
const firstNameOf = (who: string) => who.trim().toLowerCase().split('@')[0]!.split(/[\s._-]+/)[0] ?? '';

interface NameCtx {
  /** Attendees other than me (emails or names). */
  others: string[];
  /** Every assignee name in the steps. */
  assignees: string[];
}

function isMeName(name: string, me: Me, ctx?: NameCtx): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (me.email && n.includes(me.email.toLowerCase())) return true;
  if (!me.name) return false;
  const mn = me.name.toLowerCase();
  if (n === mn) return true;
  const [first, ...rest] = mn.split(/\s+/);
  const last = rest[rest.length - 1];
  if ((n === first && !last) || (!!last && n.includes(first!) && n.includes(last))) return true;
  // R11: a bare first name is me when I'm in the meeting and nobody else there (or named in the steps) shares it.
  if (!ctx?.others.length || n !== first) return false;
  const clash = ctx.others.some((o) => firstNameOf(o) === first) || ctx.assignees.some((a) => a.trim().toLowerCase() !== n && firstNameOf(a) === first && a.trim().toLowerCase() !== mn);
  return !clash;
}

/**
 * Parses the steps checklist: `- [ ] [Assignee] Title: description`, or without the checkbox `- [Assignee] Title`.
 * `attendees` (emails or names, me included or not) lets a first-name-only assignee match me when it is unique.
 */
export function parseNextSteps(markdown: string, me: Me, opts: { attendees?: string[] } = {}): NextStep[] {
  // Prefer the "Full notes" copy (it comes last); fall back to the Quick notes copy.
  const lines = markdown.split('\n');
  const idxs: number[] = [];
  lines.forEach((l, i) => {
    if (STEPS_HEADING.test(l.trim())) idxs.push(i);
  });
  if (!idxs.length) return [];
  const start = idxs[idxs.length - 1]!;
  const parsed: Array<{ m: RegExpMatchArray; l: string }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#{1,6}\s/.test(l)) break;
    const m = l.match(/^\s*[-*]\s*(?:\[( |x|X)\]\s*)?(?:\[([^\]]+)\]\s*)?(.*)$/);
    if (!m || !m[3]!.trim()) continue;
    parsed.push({ m, l });
  }
  const split = (s: string | undefined) =>
    (s ?? '')
      .split(NAME_SPLIT)
      .map((x) => x.trim())
      .filter(Boolean);
  const meEmail = me.email?.toLowerCase();
  const ctx: NameCtx = {
    others: (opts.attendees ?? []).filter((a) => a.trim().toLowerCase() !== meEmail),
    assignees: parsed.flatMap(({ m }) => split(m[2])),
  };
  return parsed.map(({ m, l }) => {
    const body = m[3]!.replace(/\*\*/g, '').trim();
    const colon = body.indexOf(': ');
    const title = colon > 0 ? body.slice(0, colon).trim() : body;
    const description = colon > 0 ? body.slice(colon + 2).trim() : undefined;
    const assignees = split(m[2]);
    return {
      assignees,
      title,
      description,
      done: (m[1] ?? ' ').toLowerCase() === 'x',
      isMine: assignees.some((a) => isMeName(a, me, ctx)),
      raw: l.trim(),
    };
  });
}

export function parseGeminiNotes(markdown: string, me: Me, opts: { attendees?: string[] } = {}): ParsedGeminiNotes {
  const sections = parseDocSections(markdown, true);
  const find = (h: string) => sections.filter((s) => s.heading.toLowerCase() === h.toLowerCase());
  const summary = (find('Summary')[0]?.text ?? '').replace(/\*\*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  // Decisions content lives in `## Aligned` / `## Needs further discussion` sections between "Decisions" and "Next steps".
  const decisions: string[] = [];
  const di = sections.findIndex((s) => s.heading.toLowerCase() === 'decisions');
  if (di >= 0) {
    for (let i = di + 1; i < sections.length; i++) {
      const h = sections[i]!.heading.toLowerCase();
      if (STEPS_HEADING.test(`## ${h}`) || h === 'details') break;
      for (const l of sections[i]!.text.split('\n')) if (/^\s*[-*]\s+/.test(l)) decisions.push(l.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').trim());
    }
  }
  const transcriptUrl = markdown.match(/\[Transcript\]\((https:\/\/docs\.google\.com\/document\/d\/[^)\s]+)\)/)?.[1];
  const nextSteps = parseNextSteps(markdown, me, opts);
  return { summary, decisions, nextSteps, transcriptUrl, hasNotes: nextSteps.length > 0 || summary.length > 0 };
}

interface GeminiCursor {
  /** eventId -> notes doc id found */
  found: Record<string, { doc: string; h: string }>;
  /** eventId -> number of polls without luck */
  polls: Record<string, number>;
}

export interface GeminiNotesFetcherOptions {
  google: GoogleTools;
  me: Me;
  clock?: Clock;
  pollMinutes?: number;
  maxEvents?: number;
}

/** Gemini names docs "<event title> - YYYY/MM/DD HH:MM TZ - Notes by Gemini". */
export function notesDocMatchesEvent(docName: string, eventTitle: string): boolean {
  const n = normalizeText(docName).toLowerCase();
  const t = normalizeText(eventTitle).toLowerCase();
  if (!/notes by gemini/.test(n)) return false;
  return n.startsWith(t) || t.startsWith(n.replace(/\s*-\s*\d{4}\/\d{2}\/\d{2}.*$/, ''));
}

export class GeminiNotesFetcher implements DeterministicFetcher {
  readonly connector = 'gemini_notes' as const;
  private readonly g: GoogleTools;
  private readonly me: Me;
  private readonly clock: Clock;
  private readonly pollMin: number;
  private readonly maxEvents: number;

  constructor(opts: GeminiNotesFetcherOptions) {
    this.g = opts.google;
    this.me = opts.me;
    this.clock = opts.clock ?? systemClock;
    this.pollMin = opts.pollMinutes ?? NOTES_POLL_MINUTES;
    this.maxEvents = opts.maxEvents ?? 250;
  }

  async scopes(): Promise<string[]> {
    return ['poll'];
  }

  health(): Promise<ConnectorHealthProbe> {
    return this.g.health();
  }

  async listForReconcile(_scope: string, window: TimeWindow, opts: { signal: AbortSignal }): Promise<CoverageObject[]> {
    const now = this.clock();
    const events = await listEvents(this.g, new Date(Date.parse(window.from)), new Date(Math.min(Date.parse(window.to), now.getTime())), this.maxEvents, opts.signal);
    return events
      .filter((e) => Date.parse(e.end) <= now.getTime() && isMeetingLike(e, this.me) && (e.meetingLink || e.attachments.length))
      .map((e) => ({ kind: 'calendar_range' as const, ref: `notes-poll:${e.id}`, from: e.start, to: e.end }));
  }

  async fetch(_scope: string, cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal; limit?: number }): Promise<FetchResult> {
    const now = this.clock();
    const prev = decodeCursor<GeminiCursor>(cursor, { found: {}, polls: {} });
    const next: GeminiCursor = { found: { ...prev.found }, polls: { ...prev.polls } };
    const from = new Date(Math.min(now.getTime() - this.pollMin * 60_000, Date.parse(window.from)));
    // GEM-2: a backfill window reads its own meetings. Before, every window listed from its start to now, newest first,
    // and stopped at the run's limit, so a window from weeks ago got the same 25 newest meetings each time and never
    // its own: on the 30-day first scan, notes of meetings older than about two weeks were never recorded, while the
    // window counted as read. A poll's window ends now, so it is unchanged.
    const to = new Date(Math.min(Date.parse(window.to), now.getTime()));
    const events = await listEvents(this.g, from, to, this.maxEvents, opts.signal);
    const ended = events.filter((e) => Date.parse(e.end) <= now.getTime() && Date.parse(e.start) < to.getTime() && isMeetingLike(e, this.me) && (e.meetingLink || e.attachments.length > 0));

    const items: NormalizedSourceItem[] = [];
    const decisions: NonNullable<FetchResult['decisions']> = [];
    const coverage: CoverageObject[] = [{ kind: 'calendar_range', ref: 'notes-poll', from: from.toISOString(), to: to.toISOString(), meta: { candidates: ended.length } }];

    // One Drive name search covers every candidate.
    let driveDocs: Array<{ id: string; name: string; modified: string }> | null = null;
    const searchDrive = async () => {
      if (driveDocs) return driveDocs;
      const minEnd = Math.min(...ended.map((e) => Date.parse(e.end)));
      const q = `name contains 'Notes by Gemini' and modifiedTime > '${new Date(minEnd - 30 * 60_000).toISOString()}' and trashed = false`;
      const text = await this.g.call('search_drive_files', { query: q, detailed: true, page_size: 50, include_items_from_all_drives: true }, { signal: opts.signal });
      driveDocs = parseDriveSearch(text).files.map((f) => ({ id: f.id, name: f.name, modified: f.modified }));
      return driveDocs;
    };

    // At most `limit` notes per run (newest meetings first); the rest wait for the next poll. Before, a catch-up
    // after a break handed every meeting's notes to one agent run (stress finding CAL-1, same failure as Calendar).
    const limit = Math.max(1, opts.limit ?? Number.POSITIVE_INFINITY);
    let deferred = false;
    ended.sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
    for (const e of ended) {
      if (items.length >= limit) {
        deferred = true;
        break;
      }
      throwIfAborted(opts.signal);
      const verdict = classifyAttendance(e, events, this.me, now);
      let docId = e.attachments.find((a) => /notes by gemini/i.test(a.title))?.fileId;
      if (!docId) {
        const docs = await searchDrive();
        docId = docs.find((d) => notesDocMatchesEvent(d.name, e.title))?.id;
      }
      if (!docId) {
        const stale = (now.getTime() - Date.parse(e.end)) / 60_000 > this.pollMin;
        next.polls[e.id] = (next.polls[e.id] ?? 0) + 1;
        coverage.push({ kind: 'calendar_range', ref: `notes-poll:${e.id}`, from: e.start, to: e.end, meta: { found: false, polls: next.polls[e.id], giveUp: stale } });
        continue;
      }
      let md: string;
      try {
        md = await this.g.call('get_doc_as_markdown', { document_id: docId, include_comments: false }, { signal: opts.signal });
      } catch (err) {
        // One notes doc that is gone or unreadable (404 / 403 / 400) is about that doc: record it and go on. Before, it
        // failed every run of the window, and the backfill retried it over and over (GEM-1).
        if (err instanceof GoogleCallError && err.info.objectScoped) {
          coverage.push({ kind: 'file', ref: docId, meta: { eventId: e.id, found: false, error: err.info.signature } });
          next.found[e.id] = { doc: docId, h: `error:${err.info.signature}` };
          delete next.polls[e.id];
          continue;
        }
        throw err;
      }
      const parsed = parseGeminiNotes(md, this.me, { attendees: e.attendees.map((a) => a.email) });
      coverage.push({ kind: 'file', ref: docId, meta: { eventId: e.id, found: true, nextSteps: parsed.nextSteps.length } });
      if (!parsed.hasNotes) {
        // Doc exists but is not filled yet (Gemini still writing). Poll again next run.
        next.polls[e.id] = (next.polls[e.id] ?? 0) + 1;
        continue;
      }
      // R11: notes with a summary but no step parsed (a heading or line format the parser does not know) are counted
      // on Health, so a silent recall hole shows up. Ids only.
      if (!parsed.nextSteps.length) decisions.push({ reason: NOTES_NO_STEPS, subject: docId, detail: { eventId: e.id } });
      const item = this.toItem(e, docId, parsed, verdict, now);
      if (prev.found[e.id]?.h !== item.contentHash) items.push(item);
      next.found[e.id] = { doc: docId, h: item.contentHash };
      delete next.polls[e.id];
    }

    // Forget bookkeeping for events older than the retention window (7 d).
    const cutoff = now.getTime() - 7 * 86400_000;
    const known = new Map(events.map((e) => [e.id, Date.parse(e.end)]));
    for (const id of Object.keys(next.found)) if ((known.get(id) ?? Infinity) < cutoff) delete next.found[id];
    for (const id of Object.keys(next.polls)) if ((known.get(id) ?? 0) < cutoff && known.has(id)) delete next.polls[id];

    return { items, coverage, nextCursor: encodeCursor(next, now.toISOString()), complete: !deferred, ...(decisions.length ? { decisions } : {}) };
  }

  private toItem(e: ParsedEvent, docId: string, p: ParsedGeminiNotes, v: ReturnType<typeof classifyAttendance>, now: Date): NormalizedSourceItem {
    const meEmail = this.me.email.toLowerCase();
    const participants: PersonRef[] = e.attendees.map((a) => ({ email: a.email, isMe: a.email === meEmail, isExternal: a.email.split('@')[1] !== meEmail.split('@')[1] }));
    const steps = p.nextSteps.map((s) => ({
      assignees: s.assignees,
      title: redact(s.title).text,
      description: s.description ? redact(s.description).text : undefined,
      done: s.done,
      isMine: s.isMine,
    }));
    const summary = redact(p.summary).text.slice(0, 3000);
    const ex = redactExcerpt(normalizeText(summary || steps.map((s) => s.title).join('; ')));
    const missed = v.attendance === 'missed';
    return {
      connector: 'gemini_notes',
      kind: 'meeting_notes',
      externalId: docId,
      dedupeKey: `gemini:${docId}`,
      contentHash: h16(summary, JSON.stringify(steps), p.decisions.join('|')),
      occurredAt: e.end,
      participants,
      permalink: `https://docs.google.com/document/d/${docId}/edit`,
      title: redact(e.title).text,
      excerpt: ex.text,
      redacted: ex.redacted,
      threadRef: `calendar:${e.id}`,
      fileRefs: [docId],
      payload: {
        eventId: e.id,
        eventStart: e.start,
        eventEnd: e.end,
        attendance: v.attendance,
        attendanceReason: v.reason,
        missedMeeting: missed,
        myResponse: v.myResponse,
        summary,
        decisions: p.decisions.map((d) => redact(d).text),
        nextSteps: steps,
        myNextSteps: steps.filter((s) => s.isMine),
        othersNextSteps: steps.filter((s) => !s.isMine),
        transcriptUrl: p.transcriptUrl,
        notesAgeMinutes: Math.round((now.getTime() - Date.parse(e.end)) / 60_000),
      },
    };
  }
}
