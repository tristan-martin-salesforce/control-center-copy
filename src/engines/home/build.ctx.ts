// Home build: constants, section titles, the build context (makeCtx) and free time. Split from build.ts (max-lines); build.ts re-exports the public names.
import {
  type CalendarEvent, type Draft, type HomeCard, type HomeEntity, type HomeRow, type HomeSectionId, type HomeSegment,
  type HomeVerb, type Initiative, type NbaCard, type WorkItem, isAdminDraft,
} from '@/contract';
import { handsOnMin } from './estimate';
import {
  addLocalDays, atLocal, dayStart, HOUR_MS, MIN_MS, nextWorkingDay, parseHM, toMs, zoned, type WorkingDay,
} from './time';
import type { HomeInput } from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Time ▸ Week (the quarter log's steps): never bare `/time`, which opens Forecast for an AE (timeViewOf). */
export const TIME_WEEK = '/activity?view=week';
export const HOME_CAPS = { rows: 3, rowsWide: 5, initiatives: 5, initiativesWide: 10, pullForward: 5, aheadDays: 14, looksDone: 1, looksDoneWide: 2 } as const;
/** Promises: undated commitments at least this old (background promises always count). */
export const PROMISE_MIN_AGE_D = 5;
/** Undated commitments in one initiative fold into one Chase row from this many. */
export const FOLD_AT = 3;
/** A promise this old is amber. */
export const PROMISE_RISK_AGE_D = 30;
/** Open blocks shorter than this stay plain track on the ribbon. */
export const OPEN_BLOCK_MIN = 60;
/** Done prep counts as "ready" in the card's prep line for this long. */
export const PREP_DONE_WINDOW_MS = 36 * HOUR_MS;
export const LIVE = new Set(['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'reopened']);
/**
 * LD-1: the work Home ranks, sections and counts. A likely-done item is not open work: it waits for one click
 * (Confirm or Not done) in its own "Looks done: confirm" group, never in Do now, the top slots or the sections.
 * It still counts as a meeting's linked prep (LIVE above).
 */
const WORK_LIVE = new Set([...LIVE].filter((s) => s !== 'likely_done'));
const FINAL_DRAFT = new Set(['sent', 'verified', 'discarded', 'rejected', 'staged']);
export const REPLY_TITLE = /^(reply|answer|respond|confirm|send|email|tell|let)\b/i;
export const SECTION_TITLE: Record<HomeSectionId, string> = {
  reply: 'Respond',
  ahead: 'Think ahead',
  fix: 'Log & fix',
  chase: 'Chase',
  initiatives: 'Initiatives',
};
export const SECTION_EMPTY: Record<HomeSectionId, string> = {
  reply: 'Nothing waiting on your reply.',
  ahead: 'Nothing dated in the next 14 days.',
  fix: 'Nothing missing. Logs and connectors are current.',
  chase: 'Nobody owes you anything.',
  initiatives: 'No active initiatives.',
};
// ---------------------------------------------------------------------------
// Small constructors (contract defaults spelled out)
// ---------------------------------------------------------------------------

export const seg = (text: string, em = false, mark: HomeSegment['mark'] = null): HomeSegment => ({ text, em, mark });
export const verb = (label: string, action: HomeVerb['action'], href: string | null = null, targetId: string | null = null): HomeVerb => ({ label, action, href, targetId });
export const itemHref = (id: string) => `/work/${id}`;
export const workEntity = (w: WorkItem): HomeEntity => ({ kind: 'work_item', id: w.id, label: w.title });
export function row(r: Omit<HomeRow, 'item' | 'progress' | 'heat' | 'dateLabel' | 'resolve'> & Partial<Pick<HomeRow, 'item' | 'progress' | 'heat' | 'dateLabel' | 'resolve'>>): HomeRow {
  return { item: null, progress: null, heat: null, dateLabel: null, resolve: null, ...r };
}
// Whole millions from $10M up keep their zeros ($50M, not "$5M"); below that, two decimals with trailing zeros dropped.
export const usdShort = (n: number) => (n >= 1_000_000 ? `$${n >= 10_000_000 ? Math.round(n / 1_000_000) : (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const fmtH = (n: number) => (Number.isInteger(n) ? String(n) : String(round1(n)));
// ---------------------------------------------------------------------------
// Context: lookups and derived per-item facts
// ---------------------------------------------------------------------------

export interface Ctx {
  input: HomeInput;
  tz: string;
  /** "Now" for every rule: the real now, or the planned day's working-hours start. */
  nowMs: number;
  /** The real clock (the nudge, what counts as today's work when planning). */
  realNowMs: number;
  /** The working day being planned (`day = 'next'`); null on today. */
  plan: WorkingDay | null;
  /** Planning: cards on the day without being due then (today's open work, moved there). */
  carried: Map<string, NonNullable<HomeCard['carried']>>;
  todayStart: number;
  todayEnd: number;
  wStart: number;
  wEnd: number;
  live: WorkItem[];
  byId: Map<string, WorkItem>;
  nbaOf: (w: WorkItem) => NbaCard | null;
  draftOf: (w: WorkItem) => Draft | null;
  eventById: Map<string, CalendarEvent>;
  iniById: Map<string, Initiative>;
  todayEvents: CalendarEvent[];
  heldByMeeting: (w: WorkItem) => CalendarEvent | null;
  blockedBy: (w: WorkItem) => WorkItem | null;
  todayScoped: (w: WorkItem) => boolean;
  handsOn: (w: WorkItem) => number;
  readyDrafts: Draft[];
}
export function isToday(ms: number | null, c: Pick<Ctx, 'todayStart' | 'todayEnd'>) {
  return ms !== null && ms >= c.todayStart && ms < c.todayEnd;
}
export const msOrNull = (iso: string | null | undefined) => (iso ? toMs(iso) : null);
export function makeCtx(raw: HomeInput): Ctx {
  const tz = raw.timezone;
  const realNowMs = toMs(raw.now);
  const plan = raw.day === 'next' ? nextWorkingDay(realNowMs, tz, raw.workingHours) : null;
  const nowMs = plan ? plan.startMs : realNowMs;
  const todayStart = dayStart(nowMs, tz);
  const todayEnd = addLocalDays(nowMs, 1, tz);
  const p = zoned(nowMs, tz);
  const wh = raw.workingHours;
  const sMin = parseHM(wh.start);
  const eMin = parseHM(wh.end);
  const wStart = atLocal(p.y, p.m, p.d, Math.floor(sMin / 60), sMin % 60, tz);
  const wEnd = atLocal(p.y, p.m, p.d, Math.floor(eMin / 60), eMin % 60, tz);

  // Planning: a snooze that wakes by the planned day's end is awake that day (it was moved there).
  const carried = new Map<string, NonNullable<HomeCard['carried']>>();
  const input: HomeInput = plan
    ? {
        ...raw,
        items: raw.items.map((w) => {
          if (w.state !== 'snoozed' || !w.snoozedUntil || toMs(w.snoozedUntil) >= todayEnd) return w;
          carried.set(w.id, 'moved');
          return { ...w, state: w.snoozedFrom && WORK_LIVE.has(w.snoozedFrom) ? w.snoozedFrom : 'open' };
        }),
      }
    : raw;

  const nbaById = new Map(input.nbas.map((n) => [n.id, n]));
  const draftById = new Map(input.drafts.map((d) => [d.id, d]));
  const eventById = new Map(input.events.map((e) => [e.id, e]));
  const iniById = new Map(input.initiatives.map((i) => [i.id, i]));
  const live = input.items.filter((w) => WORK_LIVE.has(w.state));
  const byId = new Map(input.items.map((w) => [w.id, w]));

  const nbaOf = (w: WorkItem) => {
    const n = w.nbaId ? nbaById.get(w.nbaId) : undefined;
    return n && !['dismissed', 'completed'].includes(n.status) ? n : null;
  };
  const draftOf = (w: WorkItem) => {
    const n = nbaOf(w);
    const d = n?.draftId ? draftById.get(n.draftId) : input.drafts.find((x) => x.workItemId === w.id && !FINAL_DRAFT.has(x.status));
    return d && !FINAL_DRAFT.has(d.status) ? d : null;
  };
  const todayEvents = input.events
    .filter((e) => toMs(e.end) > todayStart && toMs(e.start) < todayEnd)
    .sort((a, b) => a.start.localeCompare(b.start));
  const heldByMeeting = (w: WorkItem) =>
    todayEvents.find((e) => e.prep?.workItemId === w.id && e.prep.ready && !['declined', 'cancelled'].includes(e.attendance)) ?? null;

  const waiting = live.filter((w) => w.state === 'waiting_on_others' && w.waiting?.who);
  const blockedBy = (w: WorkItem) => {
    if (w.state === 'waiting_on_others') return null;
    const n = nbaOf(w);
    if (!n || !n.alternatives.some((a) => a.verb === 'wait' || a.verb === 'nudge')) return null;
    const ids = new Set([...w.people.map((x) => x.id), ...(w.counterparty ? [w.counterparty.id] : [])]);
    return waiting.find((x) => x.id !== w.id && ids.has(x.waiting!.who!.id)) ?? null;
  };

  const pinnedIn = (b: Pick<Ctx, 'todayStart' | 'todayEnd'>) =>
    new Set(input.slots.filter((s) => (s.kind === 'work' || s.kind === 'focus') && s.workItemId && isToday(toMs(s.start), b)).map((s) => s.workItemId!));
  const pinned = pinnedIn({ todayStart, todayEnd });
  const scopedIn = (w: WorkItem, b: Pick<Ctx, 'todayStart' | 'todayEnd'>, pins: Set<string>) =>
    WORK_LIVE.has(w.state) && !w.isBackground && w.state !== 'waiting_on_others' && (isToday(msOrNull(w.due), b) || isToday(msOrNull(w.startBy), b) || pins.has(w.id));
  // Planning: today's work still open carries over (today-scoped from today until the planned day starts).
  if (plan) {
    const today = { todayStart: dayStart(realNowMs, tz), todayEnd: todayStart };
    const pins = pinnedIn(today);
    for (const w of live) if (!carried.has(w.id) && !scopedIn(w, { todayStart, todayEnd }, pinned) && scopedIn(w, today, pins)) carried.set(w.id, 'from_today');
  }
  const todayScoped = (w: WorkItem) => scopedIn(w, { todayStart, todayEnd }, pinned) || (carried.has(w.id) && WORK_LIVE.has(w.state) && !w.isBackground && w.state !== 'waiting_on_others');
  const handsOn = (w: WorkItem) => handsOnMin(w);

  // The Outbox's pending-approval order (most recently updated first), so the card's queue and the Outbox agree.
  // D-52: admin items (logging canvases, VDP changes) are applied on Time; the card approves messages
  const readyDrafts = input.drafts.filter((d) => d.status === 'ready' && !isAdminDraft(d)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { input, tz, nowMs, realNowMs, plan, carried, todayStart, todayEnd, wStart, wEnd, live, byId, nbaOf, draftOf, eventById, iniById, todayEvents, heldByMeeting, blockedBy, todayScoped, handsOn, readyDrafts };
}
export const byRank = (a: WorkItem, b: WorkItem) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.due ?? '9').localeCompare(b.due ?? '9') || a.id.localeCompare(b.id);
/** `Q4 FY27` → its local days (the fiscal year starts 1 February: FY27 = Feb 2026 to Jan 2027); null otherwise. */
export function quarterDays(label: string): { start: string; end: string } | null {
  const m = /^Q([1-4])\s+FY(\d{2})$/.exec(label.trim());
  if (!m) return null;
  const fy = 2000 + Number(m[2]);
  const startMonth = 1 + (Number(m[1]) - 1) * 3;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { start: day(new Date(Date.UTC(fy - 1, startMonth, 1))), end: day(new Date(Date.UTC(fy - 1, startMonth + 3, 0))) };
}
/** Only accepted meetings block time (DESIGN-V2 capacity; the priority engine's `isBusy`). */
export const isBusyEvent = (e: CalendarEvent) =>
  !['declined', 'cancelled', 'missed'].includes(e.attendance) && e.myResponse !== 'tentative' && e.myResponse !== 'needs_action' && !e.isAllDay && (e.eventType ?? 'default') === 'default';
// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface Interval {
  s: number;
  e: number;
}
export function freeIntervals(c: Ctx): Interval[] {
  const from = Math.max(c.nowMs, c.wStart);
  if (from >= c.wEnd) return [];
  const busy = c.todayEvents.filter(isBusyEvent).map((e) => ({ s: toMs(e.start), e: toMs(e.end) })).sort((a, b) => a.s - b.s);
  const out: Interval[] = [];
  let cur = from;
  for (const b of busy) {
    if (b.e <= cur || b.s >= c.wEnd) continue;
    if (b.s > cur) out.push({ s: cur, e: Math.min(b.s, c.wEnd) });
    cur = Math.max(cur, b.e);
    if (cur >= c.wEnd) break;
  }
  if (cur < c.wEnd) out.push({ s: cur, e: c.wEnd });
  return out.filter((i) => i.e - i.s >= MIN_MS);
}
/** Today's ranked hands-on work for Do now (the day's totals come from `input.capacity`). */
export function todayItems(c: Ctx): WorkItem[] {
  return c.live.filter((w) => c.todayScoped(w) && !c.heldByMeeting(w)).sort(byRank);
}
