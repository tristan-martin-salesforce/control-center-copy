/**
 * Pure derivations for the context renderers (meeting brief, connector, agent run). No React, no I/O, no
 * clock: `now` is passed in, so tests and server and client agree.
 */
import type { CalendarEvent, Connector, EventAttendee, InviteResponse, Job, ScanRun, ScanRunStatus, WorkItem } from '@/contract';
import { clock, dayLabel, minutesBetween, sameDay } from '@/components/domain/lib/time';

// ── calendar_event ─────────────────────────────────────────────────────────────────────────

export type EventPhase = 'past' | 'now' | 'soon' | 'later' | 'off';

/** Join opens this many minutes before the start. */
export const JOIN_LEAD_MIN = 10;

export function eventPhase(ev: Pick<CalendarEvent, 'start' | 'end' | 'attendance'>, now: string): EventPhase {
  if (ev.attendance === 'declined' || ev.attendance === 'cancelled') return 'off';
  if (ev.attendance === 'in_progress') return 'now';
  const toStart = minutesBetween(now, ev.start);
  const toEnd = minutesBetween(now, ev.end);
  if (toEnd <= 0) return 'past';
  if (toStart <= 0) return 'now';
  if (toStart <= JOIN_LEAD_MIN) return 'soon';
  return 'later';
}

function hmShort(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  return `${Math.round(m / 1440)} days`;
}

/** "Today 13:30–14:30 · in 1h 38m" · "Now, until 14:30 · 45m left" · "Thu 12 Nov 10:00–11:00". */
export function eventWhen(ev: Pick<CalendarEvent, 'start' | 'end' | 'attendance'>, now: string, tz?: string): string {
  const span = `${clock(ev.start, tz)}–${clock(ev.end, tz)}`;
  const day = sameDay(ev.start, now, tz) ? 'Today' : dayLabel(ev.start, tz);
  const phase = eventPhase(ev, now);
  if (phase === 'now') return `Now, until ${clock(ev.end, tz)} · ${hmShort(minutesBetween(now, ev.end))} left`;
  if (phase === 'soon' || phase === 'later') return `${day} ${span} · in ${hmShort(minutesBetween(now, ev.start))}`;
  return `${day} ${span}`;
}

export interface PrepCheck {
  id: string;
  label: string;
  ready: boolean;
  /** The work item to open, if any. */
  itemId: string | null;
  /** Hands-on minutes left (0 when ready). */
  youMin: number;
}

const READY_STATES = new Set<WorkItem['state']>(['done', 'likely_done']);

/**
 * Prep readiness: the event's own prep line plus every work item that serves the meeting (`servesEventId`),
 * the prep item first. Done (or likely done) counts as ready.
 */
export function prepChecks(ev: Pick<CalendarEvent, 'id' | 'prep'>, items: Array<Pick<WorkItem, 'id' | 'title' | 'state' | 'servesEventId'>>, youMinOf: (id: string) => number): PrepCheck[] {
  const serving = items.filter((i) => i.servesEventId === ev.id || i.id === ev.prep?.workItemId);
  const byId = new Map(serving.map((i) => [i.id, i] as const));
  const out: PrepCheck[] = [];
  if (ev.prep) {
    const it = ev.prep.workItemId ? byId.get(ev.prep.workItemId) : undefined;
    const ready = it ? READY_STATES.has(it.state) || ev.prep.ready : ev.prep.ready;
    out.push({ id: it?.id ?? `prep:${ev.id}`, label: it?.title ?? ev.prep.label.replace(/\s*›\s*$/, ''), ready, itemId: it?.id ?? ev.prep.workItemId, youMin: ready || !it ? 0 : youMinOf(it.id) });
  }
  for (const i of serving) {
    if (i.id === ev.prep?.workItemId) continue;
    const ready = READY_STATES.has(i.state);
    out.push({ id: i.id, label: i.title, ready, itemId: i.id, youMin: ready ? 0 : youMinOf(i.id) });
  }
  return out;
}

export type EventPrimaryKind = 'join' | 'prep' | 'takeaways' | 'calendar';

export interface EventPrimary {
  kind: EventPrimaryKind;
  label: string;
  /** join / calendar: the URL · prep / takeaways: the work item. */
  url?: string;
  itemId?: string;
}

/**
 * The ONE action: join when it's on (or starts within 10 min); else do the missing prep; else the missed
 * meeting's takeaways; else join later (the link) or open it in Calendar.
 */
export function eventPrimary(ev: Pick<CalendarEvent, 'start' | 'end' | 'attendance' | 'meetingUrl' | 'takeaways' | 'source'>, checks: PrepCheck[], now: string): EventPrimary | null {
  const phase = eventPhase(ev, now);
  if ((phase === 'now' || phase === 'soon') && ev.meetingUrl) return { kind: 'join', label: 'Join meeting', url: ev.meetingUrl };
  const todo = checks.find((c) => !c.ready && c.itemId);
  if (todo && phase !== 'past' && phase !== 'off') return { kind: 'prep', label: 'Start prep', itemId: todo.itemId! };
  if ((ev.attendance === 'missed' || phase === 'past') && ev.takeaways?.count && ev.takeaways.workItemIds[0]) return { kind: 'takeaways', label: `Review ${ev.takeaways.count} takeaway${ev.takeaways.count === 1 ? '' : 's'}`, itemId: ev.takeaways.workItemIds[0] };
  if (phase === 'later' && ev.meetingUrl) return { kind: 'join', label: 'Join meeting', url: ev.meetingUrl };
  if (ev.source.url) return { kind: 'calendar', label: 'Open in Calendar', url: ev.source.url };
  return null;
}

// ── meeting details (hover card, meeting panel) ───────────────────────────────────────────────

/** "1h" · "30m" · "1h 30m": the meeting's length. */
export function durationLabel(start: string, end: string): string {
  return hmShort(minutesBetween(start, end));
}

/** One guest's answer as a word (never a color alone). */
export function responseWord(r: InviteResponse | undefined): string | null {
  switch (r) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentative':
      return 'maybe';
    case 'needs_action':
      return 'no answer';
    default:
      return null;
  }
}

/** My answer: the invite's when it says one, else what attendance implies (declined, otherwise accepted). */
export function myAnswer(ev: Pick<CalendarEvent, 'myResponse' | 'attendance' | 'organizer'>): string {
  if (ev.organizer?.isMe) return 'your meeting';
  const r = ev.myResponse ?? (ev.attendance === 'declined' ? 'declined' : 'accepted');
  if (r === 'needs_action' || r === 'none') return 'you haven’t answered';
  return r === 'tentative' ? 'you said maybe' : `you ${r}`;
}

export interface GuestSummary {
  /** Everyone on the invite but me. */
  count: number;
  external: number;
  /** Up to `max` people worth naming: externals first (the organizer first), then the organizer, then the rest. */
  key: EventAttendee[];
  /** Answers: accepted / maybe / declined / no answer. */
  answers: { accepted: number; tentative: number; declined: number; noAnswer: number };
}

export function guestSummary(ev: Pick<CalendarEvent, 'attendees'>, max = 3): GuestSummary {
  const a = ev.attendees;
  const rank = (p: EventAttendee) => (p.isExternal ? (p.organizer ? 0 : 1) : p.organizer ? 2 : 3);
  const key = a
    .map((p, i) => ({ p, i }))
    .sort((x, y) => rank(x.p) - rank(y.p) || x.i - y.i)
    .slice(0, max)
    .map((x) => x.p);
  return {
    count: a.length,
    external: a.filter((p) => p.isExternal).length,
    key,
    answers: {
      accepted: a.filter((p) => p.response === 'accepted').length,
      tentative: a.filter((p) => p.response === 'tentative').length,
      declined: a.filter((p) => p.response === 'declined').length,
      noAnswer: a.filter((p) => p.response === 'needs_action').length,
    },
  };
}

/**
 * The guests' answers in words, the ones that happened only ("3 accepted · 1 declined · 2 no answer"), or null when no
 * guest's answer is known. The hover card shows it when it names fewer guests than are invited.
 */
export function answersLine(a: GuestSummary['answers']): string | null {
  const parts = [a.accepted ? `${a.accepted} accepted` : null, a.tentative ? `${a.tentative} maybe` : null, a.declined ? `${a.declined} declined` : null, a.noAnswer ? `${a.noAnswer} no answer` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The agenda's first `n` non-empty lines, each clipped (the hover card's preview). */
export function agendaLines(agenda: string | null | undefined, n = 3, clipAt = 140): { lines: string[]; more: boolean } {
  const all = (agenda ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lines = all.slice(0, n).map((l) => (l.length > clipAt ? `${l.slice(0, clipAt - 1).trimEnd()}…` : l));
  return { lines, more: all.length > n || all.slice(0, n).some((l) => l.length > clipAt) };
}

export type TextPart = { text: string } | { text: string; href: string };

const LINK_IN_TEXT = /\b(?:https?:\/\/|mailto:)[^\s<>"'()[\]]+/gi;

/**
 * Plain text → text and link parts (http, https and mailto only; trailing punctuation stays text). The UI renders
 * the parts as text nodes and anchors, so agenda text is never parsed as HTML.
 */
export function linkParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_IN_TEXT)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: url, href: url });
    last = at + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** "Prep 1 of 2 ready · you ~20m" · "Prep ready" · null when nothing serves the meeting. */
export function prepLine(checks: PrepCheck[]): { label: string; ready: boolean } | null {
  if (!checks.length) return null;
  const left = checks.filter((c) => !c.ready);
  if (!left.length) return { label: checks.length === 1 ? 'Prep ready' : `Prep ready (${checks.length})`, ready: true };
  const min = left.reduce((s, c) => s + c.youMin, 0);
  return { label: `Prep ${checks.length - left.length} of ${checks.length} ready${min ? ` · you ~${hmShort(min)}` : ''}`, ready: false };
}

/** The read-in's state as a line ("Read-in ready", "Researching…"); null when none was requested. */
export function readInLine(r: { state: string; tldr: string } | null | undefined): { label: string; tldr: string | null } | null {
  if (!r) return null;
  const label = r.state === 'ready' ? 'Read-in ready' : r.state === 'stale' ? 'Read-in out of date' : r.state === 'failed' ? 'Read-in failed' : r.state === 'queued' ? 'Read-in queued' : 'Researching…';
  return { label, tldr: r.tldr.trim() || null };
}

// ── connector ──────────────────────────────────────────────────────────────────────────────

export const BROKEN = new Set<Connector['state']>(['auth_needed', 'error']);
export const ATTENTION = new Set<Connector['state']>(['auth_needed', 'error', 'degraded', 'offline']);

export type ConnectorPrimaryKind = 'reauth' | 'rescan';

/** Re-auth when it's broken and there is something to start; otherwise Rescan (the existing scan route). */
export function connectorPrimary(c: Pick<Connector, 'state' | 'reauth'>): { kind: ConnectorPrimaryKind; label: string } {
  const r = c.reauth;
  if (BROKEN.has(c.state) && r && r.kind !== 'instructions') {
    // a refresh script reads its own words ("Re-auth VDP", the error catalog's), the same as Setup and Activity ▸ VDP
    const label = r.kind === 'terminal_command' ? 'Open Terminal' : r.kind === 'refresh_script' ? r.label || 'Run refresh' : r.label;
    return { kind: 'reauth', label };
  }
  return { kind: 'rescan', label: 'Rescan' };
}

export const SCAN_STATUS: Record<ScanRunStatus, { label: string; tone: 'neutral' | 'brand' | 'ok' | 'warn' | 'risk' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'brand' },
  ok: { label: 'Complete', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  auth_failed: { label: 'Auth failed', tone: 'risk' },
  transient_failed: { label: 'Failed, will retry', tone: 'warn' },
  budget_exceeded: { label: 'Over budget', tone: 'risk' },
  aborted: { label: 'Aborted', tone: 'neutral' },
};

export const GAP_STATUSES = new Set<ScanRunStatus>(['partial', 'auth_failed', 'transient_failed', 'budget_exceeded', 'aborted']);

export interface CoverageRow {
  scope: string;
  /** End of the latest completed window for this scope. */
  through: string | null;
  last: ScanRun;
  gap: string | null;
}

/** One row per scope (latest run wins): how far it reads, and what's missing. Newest first. */
export function coverage(runs: ScanRun[], connectorId: string): CoverageRow[] {
  const mine = runs.filter((r) => r.connectorId === connectorId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const byScope = new Map<string, CoverageRow>();
  for (const r of mine) {
    const row = byScope.get(r.scope);
    if (!row) {
      byScope.set(r.scope, { scope: r.scope, through: r.status === 'ok' || r.status === 'partial' ? r.windowEnd : null, last: r, gap: GAP_STATUSES.has(r.status) ? (r.error ?? SCAN_STATUS[r.status].label) : null });
    } else if (!row.through && (r.status === 'ok' || r.status === 'partial')) {
      row.through = r.windowEnd;
    }
  }
  return [...byScope.values()];
}

/**
 * "Scan ledger" from the connector panel: the Health ledger filtered to this source, with the panel's own
 * params kept (`?panel=details&item=<id>&kind=connector`), since the panel stays open on it (B-073b).
 */
export function ledgerHref(connectorId: string): string {
  const q = new URLSearchParams({ tab: 'ledger', connector: connectorId, panel: 'details', item: connectorId, kind: 'connector' });
  return `/health?${q}`;
}

/**
 * The scan jobs behind a connector, newest first. Jobs are typed `scan.<source>` (slack, gmail, …); a connector's
 * id equals its source in the mock but is a uuid in db mode, so match the source, or the job's connector entity.
 */
export function scanJobs(jobs: Job[], c: Pick<Connector, 'id' | 'source'>): Job[] {
  return jobs.filter((j) => j.type === `scan.${c.source}` || (j.entity?.type === 'connector' && j.entity.id === c.id)).sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.runAt).localeCompare(a.finishedAt ?? a.startedAt ?? a.runAt));
}

/** "Live · through 10:41 · 46 items today" · "Needs re-auth since Mon 26 Oct". */
export function connectorLine(c: Pick<Connector, 'state' | 'cursor' | 'itemsToday' | 'since' | 'catchUpPct' | 'backlog'>, now: string, tz?: string): string {
  const since = sameDay(c.since, now, tz) ? clock(c.since, tz) : dayLabel(c.since, tz);
  switch (c.state) {
    case 'ok':
      return `${c.cursor.label} · ${c.itemsToday} items today`;
    case 'catching_up':
      return `Catching up${c.catchUpPct !== null ? ` · ${c.catchUpPct}%` : ''}${c.backlog ? ` · ${c.backlog} left` : ''}`;
    case 'auth_needed':
      return `Needs re-auth since ${since}`;
    case 'error':
      return `Broken since ${since}`;
    case 'degraded':
      return `Degraded since ${since} · ${c.cursor.label}`;
    case 'offline':
      return `Offline since ${since}`;
    case 'paused':
      return `Paused · ${c.cursor.label}`;
  }
}
